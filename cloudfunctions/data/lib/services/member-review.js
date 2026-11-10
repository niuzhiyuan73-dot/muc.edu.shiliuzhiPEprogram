/**
 * 会员审核 —— 权限与状态流转
 * ============================================================
 * 入会申请要回答四个问题，答案全在这里：
 *   1. 我有没有资格审核？（审核权）
 *   2. 我能不能审这一条？（不能审自己的）
 *   3. 我填的理由够不够格把这条申请批掉？（驳回校验）
 *   4. 我手工填的初始等级分合不合法？（见 validateInitialElo）
 *
 * 【为什么「通过」还可以指定初始分】
 * 老队员、外校交流生这类人，水平早有定论，让他从初始分起步再靠前五场
 * 慢慢定级纯属折腾。管理员在通过时可以填一个数值，填了就跳过定级、
 * 直接以该分起步（首次建档冻结 startElo，见 school-rating-service）。
 *
 * 【为什么单独成模块】
 * 与 match-record.js 同一套路数：这三件事都是纯判断，不碰 wx、不碰数据源。
 * 放进页面里就要靠点真机验证，放进 mock.js 又会被卷进「哪些申请该列出来」
 * 的取数逻辑里。单独拿出来，权限的每一条边界都能用字面量在 Node 里钉死。
 *
 * 【为什么注册产生的是申请而不是会员】
 * 实名信息必须有人核对学号与姓名是否对得上，否则谁都能填个假名注册进来
 * 打球。所以 auth.buildAccount 一律产出 PENDING，而把 PENDING 变成 ACTIVE
 * 的权力收在这里——这是防刷分的第一道闸门。
 *
 * 【审核权只看角色，演示数据源也不放宽】
 * 种子里点明了学院负责人与管理员（见 seed.js 的 MEMBER_SEED），本地与云端都是
 * 「role >= ROLE.STAFF（学院负责人）」这一条规则。原先 mock 下放宽为「是会员即可审」，会让
 * 普通会员在自己手机上也看到审核入口，与线上不一致，已收回。
 *
 * 【有一条规则 mock 下也不放宽】
 * 任何人不能审核自己的申请。若连这条也放开，放开的那一瞬就变成了
 * 「注册即可自封正式会员」，前面的闸门等于没装。
 * ============================================================
 */

const { ROLE, ASSOC_ROLE, COLLEGES, USER_STATUS, USER_STATUS_LABEL, GENDER_LABEL, ALL_RATING_POOLS } = require('../utils/constants.js');
const { formatDateTime } = require('../utils/format.js');
const { canManage, isActive } = require('./permission.js');

/** 审核动作 */
const REVIEW_ACTION = {
  APPROVE: 'approve', // 通过
  REJECT: 'reject', // 驳回
};

/**
 * 管理员手工指定的初始等级分取值范围。
 * 下限取 0（不设负分），上限取 3000——远高于任何正常会员的水平，
 * 留出的余量是给「特别强的特长生」这类极端情况，同时挡住手滑多打一位数。
 */
const INITIAL_ELO_MIN = 0;
const INITIAL_ELO_MAX = 3000;

/**
 * 状态标签的文案与样式类。
 *
 * 【驳回为什么借「已禁用」的壳】
 * 驳回和禁用都会让账号无法使用，区别只在动作和理由——驳回是「资料没通过」，
 * 禁用是「违规被封」。为驳回单开一个枚举值，会让所有「判断账号能不能用」
 * 的地方都要改，而 constants.js 规定枚举只增不改，所以靠 action 区分文案即可。
 * 这与 MATCH_STATUS.REVOKED 被撤销/驳回共用是同一先例。
 *
 * @param {number} status 取值见 constants.USER_STATUS
 * @param {string} [action] 取值见 REVIEW_ACTION
 * @returns {{label:string, className:string}}
 */
function statusTagOf(status, action) {
  if (status === USER_STATUS.PENDING) return { label: '待审核', className: 'is-pending' };
  if (status === USER_STATUS.DISABLED) {
    return action === REVIEW_ACTION.REJECT
      ? { label: '已驳回', className: 'is-rejected' }
      : { label: '已禁用', className: 'is-disabled' };
  }
  if (status === USER_STATUS.ACTIVE) return { label: '正常', className: 'is-active' };
  return { label: USER_STATUS_LABEL[status] || '未知状态', className: 'is-unknown' };
}

/**
 * 这条申请是不是审核者自己的。
 * @param {Object|null} actor 审核者
 * @param {Object|null} application 被审的申请
 * @returns {boolean}
 */
function isSelf(actor, application) {
  return Boolean(
    actor && application && actor._id && application._id && actor._id === application._id
  );
}

/**
 * 有没有审核资格。**仅管理员**。
 *
 * 【为什么门槛是管理员而不是学院负责人】
 * 审核一条入会申请就是决定「这个人算不算俱乐部的人」，批了之后他能报名、
 * 能上榜、能算积分——一旦批错，账要连同后续成绩一起回滚，属于「定盘子」
 * 的事（与发布赛事、赛季重置同一级别）。
 *
 * 【为什么不像代签到那样收口到本学院】
 * 学院负责人，其权限以学院为界（见 permission.managesCollege）。
 * 可入会审核根本没有这条边界可用：批下来的是「俱乐部会员」这个身份，
 * 拿到手就能报名、上榜、算积分，与申请人填的是哪个学院无关；台账也是一份
 * 全校名单，没有按学院分给谁看的口径。收不出范围，就只能收归管理员。
 *
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canReview(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

/**
 * 能不能审这一条。
 *
 * 「自己审自己」先于其它条件挡住：会长自己注册一个号，也不能自己盖章。
 *
 * @param {Object|null} actor
 * @param {Object|null} application
 * @param {Object} [options]
 * @returns {boolean}
 */
function canReviewApplication(actor, application, options = {}) {
  if (!canReview(actor, options)) return false;
  if (!application) return false;
  if (isSelf(actor, application)) return false;
  // 只有待审核的申请才谈得上处理；已经批过或驳回过的不能再动
  return application.status === USER_STATUS.PENDING;
}

/**
 * 有没有任免学院负责人的资格。**仅管理员**。
 *
 * 学院负责人手里握着「代签本学院」与「代录本学院比赛」两项权限，
 * 等于把一个学院的临场事务交出去。这个决定比审核入会重得多，所以只有
 * 管理员能做，学院负责人不能互相任命、更不能给别的学院安插人手。
 *
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canSetCollegeLeader(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

/**
 * 校验一次任免：能不能把 target 设为 / 撤销为学院负责人。
 *
 * 【为什么被任命者必须有确定的学院】
 * 学院负责人的权限全靠 college 划范围（见 permission.managesCollege）。一个
 * 学院为空的账号当上学院负责人，范围判定永远不成立——他有学院负责人的名分，却什么
 * 都管不了，界面上还会显示一堆点下去被拒的入口。与其如此，不如在任命这
 * 一步就挡住，并要求学院取自 constants.COLLEGES（不能是「其他」这类旧值）。
 *
 * 【为什么不能动管理员】
 * 角色是单向的：学院负责人之上是管理员。若允许把管理员「撤销学院负责人」，等于用一次
 * 任免把会长降级；这不该藏在会员主页的一个按钮里，需要时由云控制台直接改。
 *
 * @param {Object|null} actor 操作者
 * @param {Object|null} target 被任免的会员
 * @param {boolean} makeLeader true 设为学院负责人，false 撤销学院负责人
 * @param {Object} [options] 透传给 permission.canManage
 * @returns {{ok:boolean, message:string, role:number|null}}
 */
function validateCollegeLeader(actor, target, makeLeader, options = {}) {
  if (!canSetCollegeLeader(actor, options)) {
    return { ok: false, message: '只有管理员可以任免学院负责人', role: null };
  }
  if (!target) {
    return { ok: false, message: '找不到这位会员', role: null };
  }
  if (isSelf(actor, target)) {
    return { ok: false, message: '不能给自己任免角色', role: null };
  }
  if (Number(target.role || 0) >= ROLE.ADMIN) {
    return { ok: false, message: '不能改变管理员的角色', role: null };
  }
  if (target.status !== USER_STATUS.ACTIVE) {
    return { ok: false, message: '只有状态正常的会员才能设为学院负责人', role: null };
  }
  if (!COLLEGES.includes(target.college)) {
    return { ok: false, message: '该会员没有有效的学院，无法确定管理范围', role: null };
  }

  return { ok: true, message: '', role: makeLeader ? ROLE.STAFF : ROLE.MEMBER };
}

/**
 * 校验一次协会负责人的任免：能不能把 target 设为 / 撤销为「本协会」的协会负责人。
 *
 * 【为什么只认全局管理员】协会负责人握住的是「本协会全部内容」的管理权，
 * 与管理员在本协会内同权。若允许协会负责人互相任命，等于把整个协会交出去
 * 还可以层层转授。所以任免只认**全局管理员**（options.isGlobalAdmin，来自
 * 云端的 ctx.isGlobalAdmin），协会负责人自身不算——与 role-handlers 的
 * setAssociationLeader 一字不差。
 *
 * 【为什么不在这里校验学院】协会负责人没有 college 边界（协会负责人管全协会），
 * 与学院负责人以学院为界不同，故不做 college 判定。
 *
 * @param {Object|null} actor 操作者
 * @param {Object|null} target 被任免的会员
 * @param {boolean} makeLeader true 设为协会负责人，false 撤销
 * @param {Object} [options]
 * @param {boolean} [options.isGlobalAdmin] 操作者是不是全局管理员；缺省取 actor.isGlobalAdmin
 * @returns {{ok:boolean, message:string, role:string|null}} role 为 ASSOC_ROLE.LEADER 或 null（撤销）
 */
function validateAssociationLeader(actor, target, makeLeader, options = {}) {
  const isGlobalAdmin =
    options.isGlobalAdmin !== undefined
      ? Boolean(options.isGlobalAdmin)
      : isGlobalAdminMember(actor);

  if (!isActive(actor) || !isGlobalAdmin) {
    return { ok: false, message: '只有全局管理员可以任免协会负责人', role: null };
  }
  if (!target) {
    return { ok: false, message: '找不到这位会员', role: null };
  }
  if (isSelf(actor, target)) {
    return { ok: false, message: '不能给自己任免角色', role: null };
  }
  // 目标是全局管理员就不动他（撤掉他的协会负责人身份＝给会长降级）。
  // 协会负责人的有效角色也是 ADMIN，但它不是全局管理员，可以撤——见 isGlobalAdminMember。
  if (isGlobalAdminMember(target)) {
    return { ok: false, message: '不能改变管理员的角色', role: null };
  }
  if (target.status !== USER_STATUS.ACTIVE) {
    return { ok: false, message: '只有在册会员才能设为协会负责人', role: null };
  }

  return { ok: true, message: '', role: makeLeader ? ASSOC_ROLE.LEADER : null };
}

/**
 * 某位会员是不是**全局管理员**（账号级身份，不随协会变化）。
 *
 * 【为什么要看 isGlobalAdmin 而不是 role】协会负责人的**有效角色**也是
 * ADMIN（见 context.effectiveRole / mock 的角色补丁），只看 role 会把协会
 * 负责人误当成全局管理员。mock 与云端都在会员记录上带了 isGlobalAdmin
 * （见 mock.patchAccount 与 derive.buildDataset）；改造前的旧记录没有这个
 * 字段，退回按角色判定——那时全局管理员就是 role >= ADMIN。
 *
 * @param {Object|null} member
 * @returns {boolean}
 */
function isGlobalAdminMember(member) {
  if (!member) return false;
  if (member.isGlobalAdmin !== undefined) return Boolean(member.isGlobalAdmin);
  return Number(member.role || 0) >= ROLE.ADMIN;
}

/**
 * 解析某位会员在**指定协会**的初始等级分。
 *
 * 【新结构优先，旧字段兜底】改造后初始分按协会分开存：`initialEloByAssoc`
 * 是一个「协会 id → 分数」的映射。改造前的老账号只有一个全局的
 * `initialElo`，读到它时按兜底值使用，避免老数据凭空丢掉起评分。
 *
 * @param {Object} member 会员记录
 * @param {string} association 协会 id
 * @returns {number|null} 解析出的初始分；未指定时返回 null（由回放走自动定级）
 */
function resolvedInitialElo(member, association) {
  if (!member) return null;
  const map = member.initialEloByAssoc;
  if (map && association && Number.isFinite(map[association])) return map[association];
  if (Number.isFinite(member.initialElo)) return member.initialElo;
  return null;
}

/**
 * 生成「写入某会员在某协会的初始分」之后的新映射。
 *
 * 【为什么返回新对象而不是就地改】与 rating.js 同一纪律：云函数里并发写
 * 同一份数据会互相踩，所有更新一律产出新对象。value 为 null 表示**清除**
 * 该协会的初始分（回到自动定级），不是写入 0。
 *
 * @param {Object} member 会员记录
 * @param {string} association 协会 id
 * @param {number|null} value 归一化后的初始分，null 表示清除
 * @returns {Object} 新的 initialEloByAssoc 映射
 */
function buildInitialEloByAssoc(member, association, value) {
  const map = { ...((member && member.initialEloByAssoc) || {}) };
  if (value === null || value === undefined) delete map[association];
  else map[association] = value;
  return map;
}

/* 【「改当前分」孤儿链已删除（canEditCurrentElo / validateCurrentEloEdit /
 * buildCurrentEloByAssoc）】它们是协议 1「管理员改当前分」的纯构建器，随旧协议
 * 一起失去调用方；逐场结算改造下，出场后的评级调整属「当前评级调整」——
 * 若产品需要，将来以 §5.3 的 adjustment 记录接续，不复用这条旧链。
 */

/**
 * 校验并归一化「管理员手工指定的初始等级分」。
 *
 * 【为什么要单独一个函数】
 * 这个值由人在输入框里敲出来，可能是空串、可能是「一千五」这样的乱输，
 * 也可能多打一位数。校验规则要在本地数据源与云函数两处一字不差，
 * 所以与审核校验放在一起，两边共用。
 *
 * 【三个空值的含义相同】
 * null / undefined / 纯空白串都表示「不指定」，此时返回 value: null，
 * 由评级建档退回按性别的固定起点（男 1450 / 女 1300）。空值不是错误，所以 ok 为 true。
 *
 * @param {*} value 输入框里的原始值
 * @returns {{ok:boolean, value:number|null, message:string}}
 */
function checkEloNumber(value, label) {
  const isBlank = value === null || value === undefined || String(value).trim() === '';
  if (isBlank) return { ok: true, value: null, message: '' };

  // 布尔值能被 Number 转成 0/1，不是想要的行为，显式挡掉
  const num = typeof value === 'boolean' ? NaN : Number(value);
  if (!Number.isFinite(num)) {
    return { ok: false, value: null, message: `${label}必须是数字` };
  }
  if (!Number.isInteger(num)) {
    return { ok: false, value: null, message: `${label}必须是整数` };
  }
  if (num < INITIAL_ELO_MIN || num > INITIAL_ELO_MAX) {
    return {
      ok: false,
      value: null,
      message: `${label}需在 ${INITIAL_ELO_MIN}–${INITIAL_ELO_MAX} 之间`,
    };
  }
  return { ok: true, value: num, message: '' };
}

function validateInitialElo(value) {
  return checkEloNumber(value, '初始等级分');
}

/**
 * 校验「当前等级分」的数值。与初始分同范围，但不接受空值——当前分是
 * 一个确切的值，没有「不指定」这一说（要清除是另一回事，本期不做）。
 *
 * @param {*} value 输入框里的原始值
 * @returns {{ok:boolean, value:number|null, message:string}}
 */
function validateEloValue(value) {
  const parsed = checkEloNumber(value, '等级分');
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: false, value: null, message: '请输入等级分' };
  return parsed;
}

/**
 * 校验一次审核动作。
 *
 * 顺序刻意从「我有没有资格」到「这条单子能不能动」，这样一个没权限的人
 * 看到的是「没有审核权限」，而不是一条莫名其妙的「已经处理过了」。
 *
 * @param {Object|null} actor
 * @param {Object|null} application
 * @param {string} action 取值见 REVIEW_ACTION
 * @param {string} [reason] 驳回理由，通过时可以不填
 * @param {Object} [options] 透传给 permission.canManage（如 minRole），
 *        外加 options.initialElo：管理员为这位新会员手工指定的初始等级分
 * @returns {{ok:boolean, message:string, initialElo:number|null}}
 *         initialElo 是归一化后的数值；未指定或本次是驳回时为 null
 */
function validateReview(actor, application, action, reason, options = {}) {
  if (!canReview(actor, options)) {
    return { ok: false, message: '当前账号没有审核权限', initialElo: null };
  }
  if (!application) return { ok: false, message: '找不到这条入会申请', initialElo: null };
  if (isSelf(actor, application)) {
    return { ok: false, message: '不能审核自己的申请', initialElo: null };
  }
  if (application.status !== USER_STATUS.PENDING) {
    return { ok: false, message: '这条申请已经处理过了', initialElo: null };
  }
  if (action !== REVIEW_ACTION.APPROVE && action !== REVIEW_ACTION.REJECT) {
    return { ok: false, message: '未知的审核操作', initialElo: null };
  }
  // 驳回必须给理由：没有理由的驳回，申请人问起来谁也说不清当初为什么被拒
  if (action === REVIEW_ACTION.REJECT && !String(reason || '').trim()) {
    return { ok: false, message: '请填写驳回理由', initialElo: null };
  }

  // 初始分只在「通过」时有意义；驳回请求里带上它直接忽略，免得混进落库的补丁
  const initialElo =
    action === REVIEW_ACTION.APPROVE ? validateInitialElo(options.initialElo) : { ok: true, value: null };
  if (!initialElo.ok) return { ok: false, message: initialElo.message, initialElo: null };

  return { ok: true, message: '', initialElo: initialElo.value };
}

/**
 * 整形申请列表的一行。
 *
 * 与 match-view.buildRecordRow 同一约定：把权限算进数据里，模板只照着
 * 渲染按钮，不写 `wx:if="{{viewer.role >= 1}}"` 这类业务判断——那种写法
 * Node 跑不了，等于没法测。
 *
 * @param {Object} application 一条账号记录（待审核 / 已驳回 / 已禁用）
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @returns {Object}
 */
function buildApplicationRow(application, ctx = {}) {
  const { actor = null } = ctx;

  const tag = statusTagOf(application.status, application.action);
  const self = isSelf(actor, application);
  const allowed = canReviewApplication(actor, application);

  return {
    applicationId: application._id,
    // 注册时昵称可能没填，退回真实姓名，再退回编号——绝不渲染出 undefined
    nickName: application.nickName || application.realName || application._id,
    avatarUrl: application.avatarUrl || '',
    realName: application.realName || '',
    // 性别参与定级与单打榜过滤，是审核时该一起核对的信息
    genderText: GENDER_LABEL[application.gender] || '',
    studentId: application.studentId || '',
    college: application.college || '',
    appliedAtText: formatDateTime(application.joinDate),
    statusLabel: tag.label,
    statusClass: tag.className,
    action: application.action || '',
    reason: application.reason || '',
    isSelf: self,
    // 自己被自己审时模板据此渲染一句提示，而不是两个按不动的按钮
    canApprove: allowed,
    canReject: allowed,
  };
}

module.exports = {
  REVIEW_ACTION,
  INITIAL_ELO_MIN,
  INITIAL_ELO_MAX,
  validateInitialElo,
  statusTagOf,
  isSelf,
  canReview,
  canReviewApplication,
  canSetCollegeLeader,
  validateCollegeLeader,
  validateAssociationLeader,
  isGlobalAdminMember,
  resolvedInitialElo,
  buildInitialEloByAssoc,
  validateReview,
  buildApplicationRow,
};
