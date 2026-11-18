/**
 * 学院赛名单 —— 提交、审核与替补口径
 * ============================================================
 * 学院赛不采用「个人自己报名」，而由学院负责人提交一份本学院参赛名单
 * （D10）。这个模块回答与名单有关的问题：
 *   1. 谁能替哪个学院提交名单？（权限，学院负责人限本学院）
 *   2. 这份名单能不能提交？（在册、同学院、人数上下限）
 *   3. 管理员能不能通过 / 退回？（审核）
 *   4. 名单里谁还是替补？（名单内未上场者）
 *
 * 【为什么没有「替补栏」】
 * D12 / D28：名单只有一份，替补不计一个单独的字段——本场没上场的成员
 * 自然就是替补，可以直接被换上场。多维护一个「替补名单」，等于多一份
 * 可能与正选脱节的数据；上场与否本来就由排阵决定，从这里反推最准。
 * 因此这里只提供 remainingMemberIds：从名单里减去已上场的人。
 *
 * 【为什么提交后不删记录】
 * 名单的「待审核 / 已通过 / 已退回」是同一份记录的三种状态，多次提交
 * 覆盖同一条（键为「赛事 + 学院」），与报名记录「不删只改」是同一思路：
 * 谁在什么时候交过、管理员为什么退回，都要有据可查。
 *
 * 纯判断，不碰 wx、不碰数据源，可在 Node 里完整测试。
 * ============================================================
 */

const {
  COLLEGES,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  COLLEGE_ENTRY_STATUS_LABEL,
  ROSTER_LIMITS,
} = require('../utils/constants.js');
const { formatDate } = require('../utils/format.js');
const { managesCollege } = require('./permission.js');
const { REVIEW_ACTION } = require('./member-review.js');
const { canManageCollegeEvent } = require('./college-event.js');

/** 审核动作与入会审核共用同一套取值：approve / reject */
const VALID_REVIEW_ACTIONS = Object.values(REVIEW_ACTION);

/* ============================================================
 * 权限
 * ============================================================ */

/**
 * 能不能替某个学院提交名单。**学院负责人（本学院）+ 管理员**。
 *
 * 【为什么学院负责人限本学院，管理员不限】
 * 名单决定「谁能代表这个学院上场」，等于把这个学院的参赛资格交出去。
 * 学院负责人只能管自己那一所；管理员是主办方，可以替任何学院
 * 兜底（例如负责人临时联系不上）。
 *
 * 【为什么名单锁定后一律不可提交】
 * 抽签时名单锁定（D13），之后学院已经进了签表，再改名单会让签表上的
 * 名字对不上。锁定后唯一允许的调整是「换替补」，那是排阵阶段的事，
 * 不走这里。
 *
 * @param {Object} event 学院赛
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {string} [options.college] 目标学院；缺省取 actor.college
 * @returns {boolean}
 */
function canSubmitCollegeEntry(event, actor, options = {}) {
  if (!event || event.status !== COLLEGE_EVENT_STATUS.SIGNUP) return false;
  const college = options.college || (actor && actor.college) || '';
  return managesCollege(actor, college);
}

/**
 * 能不能审核名单。**仅管理员**，与发布学院赛同一门槛。
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canReviewCollegeEntry(actor, options = {}) {
  return canManageCollegeEvent(actor, options);
}

/* ============================================================
 * 提交校验
 * ============================================================ */

/**
 * 校验一次名单提交。
 *
 * @param {Object} payload
 * @param {string} payload.eventId
 * @param {string} payload.college 报名的学院全名
 * @param {Array<string>} payload.memberIds 勾选的队员编号
 * @param {string} [payload.remark]
 * @param {Object} ctx
 * @param {Object|null} ctx.event 学院赛记录
 * @param {Object|null} ctx.actor 提交人
 * @param {Array<Object>} [ctx.members] 全量会员，用于核验队员身份
 * @param {Array<string>} [ctx.colleges] 本次有效的学院名单；缺省取全局 COLLEGES。
 *   学校维度按「每校独立目录」传入（见 school-actor.buildCollegeDirectory），
 *   旧栈不传，行为与从前完全一致。
 * @returns {{ok:boolean, message:string, memberIds:Array<string>, college:string}}
 */
function validateCollegeEntry(payload = {}, ctx = {}) {
  const { event = null, actor = null, members = [], colleges = null } = ctx;
  const allowedColleges = Array.isArray(colleges) ? colleges : COLLEGES;
  const college = String(payload.college || '').trim();
  const raw = Array.isArray(payload.memberIds) ? payload.memberIds : [];

  if (!event) {
    return { ok: false, message: '找不到这场学院赛', memberIds: [], college };
  }
  if (event.status !== COLLEGE_EVENT_STATUS.SIGNUP) {
    return { ok: false, message: '名单已经锁定，不能再修改', memberIds: [], college };
  }
  if (!canSubmitCollegeEntry(event, actor, { college })) {
    return { ok: false, message: '只能提交本学院的名单', memberIds: [], college };
  }
  if (!allowedColleges.includes(college)) {
    return { ok: false, message: '学院无效，请重新选择', memberIds: [], college };
  }

  // 同一个人勾两次只算一次——界面上的多选框不该产生两份名额
  const memberIds = [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
  if (memberIds.length === 0) {
    return { ok: false, message: '请至少勾选一名队员', memberIds: [], college };
  }

  const min = Number.isFinite(Number(event.rosterMin)) ? Number(event.rosterMin) : 0;
  // 名单人数直接决定提交事务的操作数（每人 2 次资格点读，限组再多 1 次），
  // 所以配置上限与提交上限取同一个常量；老赛事存了更大的 rosterMax 也按它收口。
  // （第二十二轮 P2：32~50 人的名单原先必然失败，且报「查不到的会员」。）
  const configuredMax = Number.isFinite(Number(event.rosterMax)) ? Number(event.rosterMax) : Infinity;
  const max = Math.min(configuredMax, ROSTER_LIMITS.MAX);
  if (memberIds.length < min) {
    return { ok: false, message: `名单至少 ${min} 人，当前 ${memberIds.length} 人`, memberIds: [], college };
  }
  if (memberIds.length > max) {
    return { ok: false, message: `名单最多 ${max} 人，当前 ${memberIds.length} 人`, memberIds: [], college };
  }

  const byId = new Map((members || []).map((item) => [item._id, item]));
  for (const id of memberIds) {
    const member = byId.get(id);
    if (!member) {
      return { ok: false, message: '名单里有查不到的会员，请重新勾选', memberIds: [], college };
    }
    // 与个人赛报名同一口径：只有状态正常的会员能进名单。
    // 离校的人虽在回放名单里，但已经不能代表学院参赛。
    if (member.status !== USER_STATUS.ACTIVE) {
      return { ok: false, message: '名单里有账号不可用的会员，请重新勾选', memberIds: [], college };
    }
    // 从源头杜绝跨院凑人：队员必须与报名学院一致
    if (member.college !== college) {
      return { ok: false, message: '名单里有不属于本学院的会员，请重新勾选', memberIds: [], college };
    }
  }

  return { ok: true, message: '', memberIds, college };
}

/**
 * 由校验结果组装一条可落库的名单记录（不含 _id）。
 *
 * @param {Object} payload 原始提交
 * @param {Object} ctx
 * @param {Object} ctx.event
 * @param {Object} ctx.actor
 * @param {Array<Object>} [ctx.members]
 * @param {Array<string>} [ctx.colleges] 本次有效的学院名单（每校独立目录）
 * @param {Date} [ctx.now=new Date()]
 * @returns {{ok:boolean, record:Object|null, message:string}}
 */
function buildCollegeEntryRecord(payload = {}, ctx = {}) {
  const { event = null, actor = null, members = [], colleges = null, now = new Date() } = ctx;
  const check = validateCollegeEntry(payload, { event, actor, members, colleges });

  if (!check.ok) {
    return { ok: false, record: null, message: check.message };
  }

  return {
    ok: true,
    record: {
      eventId: event._id,
      college: check.college,
      members: check.memberIds,
      status: COLLEGE_ENTRY_STATUS.PENDING,
      remark: String(payload.remark || '').trim(),
      submittedBy: actor ? actor._id : '',
      submittedName: actor ? actor.nickName || actor.realName || actor._id : '',
      submitTime: now,
      // 审核痕迹先占位，未审核时为空，读的时候不必判 undefined
      reviewedBy: '',
      reviewedAt: null,
      reason: '',
    },
    message: '',
  };
}

/* ============================================================
 * 审核
 * ============================================================ */

/**
 * 校验一次名单审核。
 *
 * 【为什么退回必须给理由】
 * 与入会审核同一条硬规则：没有理由的退回，学院只知道「没过」，
 * 不知道该改哪里，只能原样再交一遍。理由留在记录里，也便于事后追溯。
 *
 * @param {Object|null} actor
 * @param {Object|null} entry
 * @param {string} action REVIEW_ACTION.APPROVE / REJECT
 * @param {string} [reason]
 * @returns {{ok:boolean, message:string, status:number|null}}
 */
function validateEntryReview(actor, entry, action, reason) {
  if (!canReviewCollegeEntry(actor)) {
    return { ok: false, message: '只有管理员可以审核名单', status: null };
  }
  if (!entry) {
    return { ok: false, message: '找不到这份名单', status: null };
  }
  // 已通过 / 已退回的不能再动，否则「退回后又被悄悄通过」无从察觉
  if (entry.status !== COLLEGE_ENTRY_STATUS.PENDING) {
    return { ok: false, message: '这份名单已经处理过', status: null };
  }
  if (action === REVIEW_ACTION.APPROVE) {
    return { ok: true, message: '', status: COLLEGE_ENTRY_STATUS.APPROVED };
  }
  if (action === REVIEW_ACTION.REJECT) {
    if (!String(reason || '').trim()) {
      return { ok: false, message: '退回名单必须说明理由', status: null };
    }
    return { ok: true, message: '', status: COLLEGE_ENTRY_STATUS.RETURNED };
  }
  return { ok: false, message: '未知的审核动作', status: null };
}

/* ============================================================
 * 替补口径与展示
 * ============================================================ */

/**
 * 名单里还没上场的人，也就是替补。
 *
 * @param {Object|null} entry 名单记录
 * @param {Array<string>} [usedIds] 本次已排进小项的队员编号
 * @returns {Array<string>} 可被换上场的队员编号（保持名单原顺序）
 */
function remainingMemberIds(entry, usedIds = []) {
  const all = entry && Array.isArray(entry.members) ? entry.members : [];
  const used = new Set((usedIds || []).map((id) => String(id || '')));
  return all.filter((id) => !used.has(String(id)));
}

/**
 * 名单状态整形：状态码、文案与两个便捷布尔量。
 * @param {Object|null} entry
 * @returns {{status:number|null, label:string, pending:boolean, approved:boolean, returned:boolean}}
 */
function entryStateOf(entry) {
  const status = entry ? entry.status : null;
  return {
    status,
    label: entry ? COLLEGE_ENTRY_STATUS_LABEL[status] || '未知状态' : '未提交',
    pending: status === COLLEGE_ENTRY_STATUS.PENDING,
    approved: status === COLLEGE_ENTRY_STATUS.APPROVED,
    returned: status === COLLEGE_ENTRY_STATUS.RETURNED,
  };
}

/**
 * 名单行整形。权限布尔量与文案都在这里算好，模板不写业务判断。
 *
 * @param {Object} entry
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的人
 * @param {Object} [ctx.event] 所属学院赛（判断还能不能改名单）
 * @param {Object} [ctx.members] 编号 → 会员的映射，用于显示姓名
 * @returns {Object}
 */
function buildCollegeEntryRow(entry, ctx = {}) {
  const { actor = null, event = null, members = null } = ctx;
  const source = entry || {};
  const state = entryStateOf(source);
  const ids = Array.isArray(source.members) ? source.members : [];
  const byId = members instanceof Map ? members : new Map();

  return {
    entryId: source._id || '',
    eventId: source.eventId || '',
    college: source.college || '',
    status: state.status,
    statusLabel: state.label,
    isPending: state.pending,
    isApproved: state.approved,
    isReturned: state.returned,
    memberIds: ids.slice(),
    memberCount: ids.length,
    // 逐层兜底，绝不渲染出 undefined
    memberNames: ids.map((id) => {
      const member = byId.get(id);
      if (!member) return id;
      return member.nickName || member.realName || id;
    }),
    remark: source.remark || '',
    reason: source.reason || '',
    submittedName: source.submittedName || '',
    submitTimeText: formatDate(source.submitTime),
    canReview: state.pending && canReviewCollegeEntry(actor),
    // 名单锁定（已抽签）后一律不能再改，所以这里必须结合赛事状态判断
    canEdit: canSubmitCollegeEntry(event, actor, { college: source.college }),
  };
}

module.exports = {
  VALID_REVIEW_ACTIONS,
  canSubmitCollegeEntry,
  canReviewCollegeEntry,
  validateCollegeEntry,
  buildCollegeEntryRecord,
  validateEntryReview,
  remainingMemberIds,
  entryStateOf,
  buildCollegeEntryRow,
};
