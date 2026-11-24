/**
 * 赛事 —— 权限、表单校验、报名与名次
 * ============================================================
 * 赛事页要回答的问题，答案全在这里：
 *   1. 我能不能发赛事？（发布权）
 *   2. 我填的这张赛事单子能不能发出去？（表单校验）
 *   3. 我能不能报名 / 取消这一场？（报名判定）
 *   4. 我能不能开始、签到、录入名次？（管理端代签）
 *   5. 这一串名次存不存在自相矛盾？（名次校验）
 *
 * 【为什么单独成模块】
 * 与 match-record.js / announcement.js 同一套路数：这些都是纯判断，
 * 不碰 wx、不碰数据源。放进页面里就只能靠点真机验证，放进 mock.js 又会被
 * 卷进「哪些赛事该列出来」的取数逻辑里。单独拿出来，每一条边界都能用
 * 字面量在 Node 里钉死。
 *
 * 【发布权为什么与审核权共用一套判定】
 * 「谁能管这件事」在本项目里已经出现多处：审核入会、发布公告、管理赛季、
 * 发布赛事。规则一字不差，只是管的事不同，所以判定抽在 permission.js，
 * 这里只声明自己需要的门槛——不另抄一遍，免得两处口径慢慢分叉。
 *
 * 【三四名赛为什么只是一个字段】
 * 两种办赛方式只差「第 4 名有没有人」：并列时两个半决赛负者都记第 3 名，
 * 打三四名时一人 3 一人 4。名次录入与积分结算因此共用一条通路，只在保存
 * 时按下表校验一次名次是否成对，见 validatePlacements。
 * ============================================================
 */

const {
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  MATCH_TYPE_TO_POOL,
  EVENT_STATUS,
  EVENT_STATUS_LABEL,
  EVENT_LEVEL,
  EVENT_LEVEL_LABEL,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  DEFAULT_BRONZE_MODE,
  SEED_MODE,
  SEED_MODE_LABEL,
  SEED_COUNTS,
  DOUBLES_SEED_MODES,
  SIGNUP_STATUS,
  SIGNUP_STATUS_LABEL,
  EVENT_FORMAT,
  EVENT_FORMAT_LABEL,
  DEFAULT_EVENT_FORMAT,
  GROUPED_FORMATS,
  GROUP_COUNT_FORMATS,
  ADVANCE_FORMATS,
  KNOCKOUT_FORMATS,
  DOUBLE_ELIM_FORMATS,
  LADDER_FORMATS,
  DEFAULT_GF_RESET,
  EVENT_PLACEMENT_MODE,
  EVENT_PLACEMENT_MODE_LABEL,
  DEFAULT_PLACEMENT_MODE,
  GROUP_CONFIG,
  DEFAULT_GROUP_COUNT,
  DEFAULT_ADVANCE_PER_GROUP,
  ROLE,
  isRankable,
  ALL_LEG_DISCIPLINES,
  LEG_DISCIPLINE_LABEL,
  GENDER_LABEL,
  COURT_LIMITS,
  courtCountTextOf,
  disciplineMatchType,
  singleGenderOf,
  disciplineLabelOf,
} = require('../utils/constants.js');
const { formatDateTime } = require('../utils/format.js');
const { canManage, isActive, managesCollege } = require('./permission.js');

/** 标题长度下限与上限 */
const TITLE_MIN = 2;
const TITLE_MAX = 30;
/** 说明文字长度上限 */
const DESCRIPTION_MAX = 200;
/** 场地长度上限 */
const LOCATION_MAX = 40;

/** 校验顺序即表单顺序，取「第一条错误」时按它走 */
const FIELD_ORDER = [
  'title',
  'description',
  'matchType',
  'discipline',
  'format',
  'groupCount',
  'advancePerGroup',
  'placementMode',
  'level',
  'bronzeMode',
  'seedMode',
  'seedCount',
  'startTime',
  'location',
  'courtCount',
  'quota',
];

/** 合法的赛事等级集合，用于「必须显式选择」的判定 */
const VALID_LEVELS = Object.values(EVENT_LEVEL);
/** 合法的三四名赛方式集合 */
const VALID_BRONZE_MODES = Object.values(EVENT_BRONZE_MODE);
/** 合法的种子来源集合（单打：手工 / 等级分 / 赛季积分） */
const VALID_SEED_MODES = Object.values(SEED_MODE);
/** 双打合法的种子来源（无赛季积分，见 constants.DOUBLES_SEED_MODES） */
const VALID_DOUBLES_SEED_MODES = DOUBLES_SEED_MODES;
/** 合法的种子数量集合（单打为人数，双打为组数） */
const VALID_SEED_COUNTS = SEED_COUNTS;
/** 合法的赛制集合 */
const VALID_FORMATS = Object.values(EVENT_FORMAT);
/** 合法的排位赛开关集合 */
const VALID_PLACEMENT_MODES = Object.values(EVENT_PLACEMENT_MODE);

/* ============================================================
 * 权限
 * ============================================================ */

/**
 * 有没有发布 / 修改赛事的资格。**仅管理员**。
 *
 * 【为什么门槛是管理员而不是学院负责人】
 * 发布、修改、抽签、开始、结束赛事都会决定整场赛事的走向（谁能报、
 * 跟谁打、算不算成绩），一旦出错就是全场的账要重算。这类「定盘子」
 * 的操作收口到管理员；学院负责人只保留两项临场事务：代签到与录入比分。
 *
 * @param {Object|null} actor
 * @param {Object} [options] 透传给 permission.canManage（如 isMock）
 * @returns {boolean}
 */
function canManageEvent(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

/**
 * 能不能点「开始赛事」（报名中 → 进行中）。**仅管理员**。
 *
 * 这里只看资格与状态，不判有没有抽签——按钮要照常显示，让管理员点下去
 * 拿到「请先抽签」的提示；抽签这一条由 startBlockedReason 在写入端把关。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canStartEvent(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  return canManageEvent(actor, options);
}

/**
 * 开始赛事还差什么。返回空串表示可以开始，否则是要展示给管理员的提示。
 *
 * 【为什么必须先抽签】
 * 赛程完全由签表决定，不抽签就没有任何一场比赛可打；先把赛事推到
 * 「进行中」，抽签入口又会随之关闭（只能报名阶段抽签），整场赛事就此卡死。
 * 单打如此，双打亦然——双打同样要抽签把报名者编成队伍并落签位。
 *
 * @param {Object} event
 * @returns {string}
 */
function startBlockedReason(event) {
  if (!event) return '找不到这场赛事';
  if (!event.draw) {
    return '请先抽签，再开始赛事';
  }
  return '';
}

/**
 * 能不能给某位会员代签。**学院负责人 + 管理员**。
 *
 * 【为什么学院负责人就能签、却不给抽签】
 * 签到是赛事当天最高频、最琐碎的临场事务，交给学院负责人分担；它只记录
 * 「人到了没有」，改不了赛程也改不了成绩，风险可控。
 *
 * 【为什么只有管理端能签】
 * 决策 4：不做会员自助签到。签到是赛事当天「人到了没有」的凭证，
 * 若本人能点，报名与签到就都成了自说自话，名次与积分的公信力也就没了。
 *
 * 【学院负责人的签到范围为什么是本学院】
 * 学院负责人的权限以学院为界。传了目标（options.target 或
 * options.targetCollege）时，学院负责人只能签自己学院的人，管理员不受限；
 * 不传目标时只判「有没有签到资格」，供列表页先算一个总开关。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {Object} [options.target] 被签到的会员档案（取其 college）
 * @param {string} [options.targetCollege] 直接给学院名
 * @returns {boolean}
 */
function canCheckIn(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.ONGOING) return false;
  if (!canManage(actor, { ...options, minRole: ROLE.STAFF })) return false;

  const { target = null, targetCollege = '' } = options;
  // 未指定对象：只判资格，供列表页先算一个总开关
  if (!target && !targetCollege) return true;
  const college = targetCollege || (target && target.college) || '';
  // 指定了对象就收口到本学院：管理员通行；学院负责人须同学院；
  // 对象学院缺失时学院负责人被拒（宁严勿松）
  return managesCollege(actor, college);
}

/**
 * 能不能录入名次并结束赛事（进行中 → 已结束）。
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canFinishEvent(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.ONGOING) return false;
  return canManageEvent(actor, options);
}

/**
 * 能不能对这场赛事抽签 / 重抽。
 *
 * 【为什么资格与状态都要判】
 * 抽签会定下整张签表并连带生成比赛，只有管理端能做；且只在「报名中」
 * 阶段（决策：仅管理员、仅开赛前可抽签与重抽）。单打双打都开放抽签，
 * 双打由抽签把报名的个人编成队伍。人数下限（单打 ≥2、双打 ≥4）要数
 * 报名记录，属于数据层，故不在这里判。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canDrawEvent(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  return canManageEvent(actor, options);
}

/**
 * 能不能报名这一场。
 *
 * 【为什么离校的人不能报名】
 * 决策 11：离校后不可报名。报名是「我还会来打」的承诺，离校的人给不了
 * 这个承诺。但注意挡的是「报名」，不是「看」——他的历史成绩仍在个人页
 * 与赛事成绩里。这一条与 isRankable 同一把尺子，别处别再抄一遍。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {Object|null} [options.signup] 该会员在这场比赛里已有的报名记录
 * @returns {boolean}
 */
function canSignUp(event, actor, options = {}) {
  const { signup = null } = options;

  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  // 抽签之后名单就定死了（决策 5）：签表是按当时的人排的，再放人进来
  // 会让签位与人数对不上，只能由管理员在开赛前重抽
  if (event.draw) return false;
  // 离校的人不能报名——但挡的是「报名」，不是「看」，他的旧成绩仍在
  if (!isRankable(actor)) return false;
  // 待审核 / 已禁用 / 未登录同样不行：还没转正的人不能承诺到场
  if (!isActive(actor)) return false;
  // 赛事声明了单性别项目（男单 / 女单 / 男双 / 女双）时，只有相符性别的会员
  // 能报名。混双与「不限」不在此拦——混双的组合约束留给抽签配对。
  const genderLimit = singleGenderOf(event.discipline);
  if (genderLimit && (!actor || actor.gender !== genderLimit)) return false;
  // 已报名或已签到的，报名按钮不该再出现
  if (signup && signup.status !== SIGNUP_STATUS.CANCELED) return false;

  // 名额满了就不放人进来；未设名额（0 / 缺省）视为不限。
  //
  // 【这里不能再加「他已经有一条记录了」的豁免】
  // 上一行已经把「非取消状态」的报名挡掉了，所以走到这里的人只可能是
  // 从没报过名、或者退过赛。退赛的人退掉的是名额，重新报名就是重新占位，
  // 与新人同一条尺子。曾经写成 `&& !signup`（即「有记录就不查名额」），
  // 正好把「退过赛的人」整个豁免出去：满员 → 退赛让位 → 别人补上 → 他再
  // 报一次，有效人数就超出上限，抽签时凭空多出一个人。
  const quota = Number(event.quota) || 0;
  if (quota > 0 && signupCountOf(event, options.signups) >= quota) return false;

  return true;
}

/**
 * 能不能取消报名。
 * 只有「报名中」阶段能撤，且确实存在一条有效报名记录。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {Object|null} [options.signup] 该会员已有的报名记录
 * @returns {boolean}
 */
function canCancelSignup(event, actor, options = {}) {
  const { signup = null } = options;

  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  // 与报名同一把锁（决策 5）：抽签后名单冻结，退赛同样不允许
  if (event.draw) return false;
  if (!actor || !actor._id) return false;
  if (!signup || signup.userId !== actor._id) return false;

  return signup.status === SIGNUP_STATUS.SIGNED;
}

/* ============================================================
 * 报名记录
 * ============================================================ */

/** 把报名列表收敛成数组，顺手兼容「传对象」的调用方 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 统计一场赛事里有效报名的人数。
 * 已取消的不算——名额是给要来的人留的。
 *
 * @param {Object} event
 * @param {Array<Object>} [signups] 报名记录
 * @returns {number}
 */
function signupCountOf(event, signups) {
  const list = asArray(signups).length > 0 ? signups : asArray(event && event.signups);
  return list.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).length;
}

/**
 * 在报名列表里找出某位会员的那一条。
 * @param {Array<Object>} signups
 * @param {string} userId
 * @returns {Object|null}
 */
function signupOf(signups, userId) {
  if (!userId) return null;
  return asArray(signups).find((item) => item.userId === userId) || null;
}

/**
 * 组装一条报名记录。
 *
 * 幂等靠自然键：同一人同一赛事永远只有一条记录（见 idempotency.js 的
 * signupNaturalKey）。取消不删除，只把状态置为 CANCELED——「报了多少人、
 * 退了多少人」有据可查，重新报名也能翻回同一条。
 *
 * @param {Object} event
 * @param {Object} actor 报名者
 * @param {Object} [ctx]
 * @param {Date|string|number} [ctx.now=new Date()] 报名时间，注入以便测试固定
 * @returns {{ok:boolean, record:Object|null, message:string}}
 */
function buildSignupRecord(event, actor, ctx = {}) {
  const { now = new Date() } = ctx;

  if (!event || !event._id) {
    return { ok: false, record: null, message: '赛事不存在' };
  }
  if (!actor || !actor._id) {
    return { ok: false, record: null, message: '请先登录' };
  }
  if (event.status !== EVENT_STATUS.SIGNUP) {
    return { ok: false, record: null, message: '报名已经截止了' };
  }
  if (!isRankable(actor)) {
    return { ok: false, record: null, message: '已离校的会员不能报名赛事' };
  }
  if (!isActive(actor)) {
    return { ok: false, record: null, message: '账号尚未通过审核，暂时不能报名' };
  }
  // 单性别项目只收相符性别的报名者，与 canSignUp 同一把尺子
  const genderLimit = singleGenderOf(event.discipline);
  if (genderLimit && actor.gender !== genderLimit) {
    const label = LEG_DISCIPLINE_LABEL[event.discipline] || '';
    return {
      ok: false,
      record: null,
      message: `本赛事为${label}，仅限${GENDER_LABEL[genderLimit]}会员报名`,
    };
  }

  return {
    ok: true,
    record: {
      eventId: event._id,
      userId: actor._id,
      status: SIGNUP_STATUS.SIGNED,
      signTime: now,
      checkInTime: null,
      // 代签时用来追溯「谁签的」，本人报名时就是自己
      actorId: actor._id,
    },
    message: '',
  };
}

/**
 * 生成一条签到的改判。
 *
 * 不改 signTime：报名时间与到场时间是两件事，混在一起就再也分不出
 * 「什么时候报的名」。
 *
 * @param {Object} signup 既有报名记录
 * @param {Object} actor 代签的学院负责人
 * @param {Object} [ctx]
 * @param {Date|string|number} [ctx.now=new Date()]
 * @returns {{ok:boolean, patch:Object|null, message:string}}
 */
function buildCheckInPatch(signup, actor, ctx = {}) {
  const { now = new Date() } = ctx;

  if (!signup) {
    return { ok: false, patch: null, message: '这位会员还没报名' };
  }
  if (signup.status === SIGNUP_STATUS.CANCELED) {
    return { ok: false, patch: null, message: '这位会员已经取消报名了' };
  }
  if (signup.status === SIGNUP_STATUS.CHECKED_IN) {
    return { ok: false, patch: null, message: '这位会员已经签过到了' };
  }

  return {
    ok: true,
    patch: {
      status: SIGNUP_STATUS.CHECKED_IN,
      checkInTime: now,
      actorId: actor ? actor._id : '',
    },
    message: '',
  };
}

/* ============================================================
 * 发布表单
 * ============================================================ */

/**
 * 去掉各项首尾空格、把数字收敛成数字、把日期收敛成 Date。
 *
 * @param {Object} [form]
 * @returns {Object}
 */
function normalizeDraft(form) {
  const source = form && typeof form === 'object' ? form : {};
  const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
  const int = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : NaN;
  };
  // 开关类字段：未提供取缺省；字符串 'false' / '0' 也算关（表单透传时常见）
  const bool = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'string') return value !== 'false' && value !== '0';
    return Boolean(value);
  };

  return {
    title: text(source.title),
    description: text(source.description),
    // 数字枚举：'' 变成 null，交给校验去说「请选择」，而不是悄悄当成 0
    matchType: int(source.matchType),
    // 赛事项目（男单 / 女单 / 男双 / 女双 / 混双）。留空 = 不限，向后兼容：
    // 历史赛事与老表单没有这个字段，一律当「不限」处理
    discipline: text(source.discipline),
    // 赛制缺省按单败淘汰：历史赛事没有这个字段，表单也允许不选（等价于旧行为）
    format: text(source.format) || DEFAULT_EVENT_FORMAT,
    // 小组参数只有分组赛制用得上，给上缺省值即可，不强制显式选
    groupCount: int(source.groupCount) === null ? DEFAULT_GROUP_COUNT : int(source.groupCount),
    advancePerGroup:
      int(source.advancePerGroup) === null ? DEFAULT_ADVANCE_PER_GROUP : int(source.advancePerGroup),
    placementMode: text(source.placementMode) || DEFAULT_PLACEMENT_MODE,
    // 双败总决赛重赛开关：缺省开启（决策 D3 的标准口径）。表单未提供时按缺省，
    // 老赛事没有这个字段也走缺省，读的时候不必判 undefined
    gfReset: bool(source.gfReset, DEFAULT_GF_RESET),
    level: int(source.level),
    bronzeMode: text(source.bronzeMode),
    // 种子来源与数量单打双打都要：单打算到人，双打算到组（两人一组）。留空
    // 交给校验去说「请选择」，不在这里补默认
    seedMode: text(source.seedMode),
    seedCount: int(source.seedCount),
    location: text(source.location),
    startTime: source.startTime ? new Date(source.startTime) : null,
    // 名额：未填视为不限（0）
    quota: int(source.quota) === null ? 0 : int(source.quota),
    // 可用场地数：必填，不设缺省——未填留 null 交给校验去说「请填写」，
    // 悄悄当成 1 会让管理员以为排好了，实际全挤在一块场地上
    courtCount: int(source.courtCount),
  };
}

/**
 * 校验一张赛事草稿。
 *
 * 【为什么等级与三四名赛方式必须显式选】
 * 决策 13 / 8：两者都直接影响积分怎么算（等级决定倍数，三四名赛决定
 * 有没有第 4 名）。若允许留空再取默认值，一次「忘了选」就会静默改变
 * 全场的分数，而且事后无法从记录里看出当初选过没有。所以缺失即报错，
 * 默认值只由界面预填，落库的必须是用户确认过的。
 * 单打赛事另需显式选择种子来源与数量（决策 2 / 3）——它决定谁在签表里
 * 受保护，同样不许留空取默认。
 *
 * @param {Object} [form] 原始表单，内部会先做 normalize
 * @returns {{ok:boolean, draft:Object, errors:Object<string,string>, firstError:string}}
 */
function validateEvent(form = {}) {
  const draft = normalizeDraft(form);
  const errors = {};

  if (draft.title.length < TITLE_MIN || draft.title.length > TITLE_MAX) {
    errors.title = `赛事名称需为 ${TITLE_MIN}~${TITLE_MAX} 个字`;
  }

  if (!MATCH_TYPE_TO_POOL[draft.matchType]) {
    errors.matchType = '请选择单打或双打';
  }

  // 项目可选（留空 = 不限）；一旦选了就必须是真项目池里的小项，且与单打 /
  // 双打对得上——否则会出现「双打赛事选了男单」这种自相矛盾的记录
  if (draft.discipline && !ALL_LEG_DISCIPLINES.includes(draft.discipline)) {
    errors.discipline = '请选择赛事项目';
  } else if (
    draft.discipline &&
    MATCH_TYPE_TO_POOL[draft.matchType] &&
    disciplineMatchType(draft.discipline) !== draft.matchType
  ) {
    errors.discipline = '赛事项目与单打 / 双打不匹配';
  }

  if (!VALID_FORMATS.includes(draft.format)) {
    errors.format = '请选择赛制';
  }

  // 小组参数只在分组赛制下有约束：组数只对可配置组数的赛制生效，出线人数
  // 对「单组循环赛取前 N」也有意义（见 constants 的 GROUP_COUNT/ADVANCE_FORMATS）
  if (GROUP_COUNT_FORMATS.includes(draft.format) && !GROUP_CONFIG.COUNT_OPTIONS.includes(draft.groupCount)) {
    errors.groupCount = `小组数只能是 ${GROUP_CONFIG.COUNT_OPTIONS.join(' / ')}`;
  }
  if (ADVANCE_FORMATS.includes(draft.format) && !GROUP_CONFIG.ADVANCE_OPTIONS.includes(draft.advancePerGroup)) {
    errors.advancePerGroup = `每组出线人数只能是 ${GROUP_CONFIG.ADVANCE_OPTIONS.join(' / ')}`;
  }
  // 双败淘汰阶段至少要 4 名出线者：组数 × 每组出线人数 不够时提前拦下，
  // 免得赛事发出去、抽签时才发现排不出败者组
  if (draft.format === EVENT_FORMAT.GROUP_DOUBLE_ELIM && !errors.advancePerGroup) {
    const qualifiers = Number(draft.groupCount) * Number(draft.advancePerGroup);
    if (Number.isFinite(qualifiers) && qualifiers > 0 && qualifiers < 4) {
      errors.advancePerGroup = '双败淘汰阶段至少需要 4 名出线者（组数 × 出线人数 ≥ 4）';
    }
  }

  // 倒三角排位只在有淘汰签表的赛制下有意义
  if (
    !VALID_PLACEMENT_MODES.includes(draft.placementMode) ||
    (!KNOCKOUT_FORMATS.includes(draft.format) &&
      draft.placementMode !== EVENT_PLACEMENT_MODE.NONE)
  ) {
    errors.placementMode = '请选择排位赛方式';
  }

  if (!VALID_LEVELS.includes(draft.level)) {
    errors.level = '请选择赛事等级';
  }

  // 三四名赛只对单败淘汰签表有意义：双败的名次由败者组自然排出，
  // 循环赛根本没有淘汰阶段，两类都不该强迫选
  if (KNOCKOUT_FORMATS.includes(draft.format) && !VALID_BRONZE_MODES.includes(draft.bronzeMode)) {
    errors.bronzeMode = '请选择三四名赛方式';
  }

  // 单打双打都要抽签，故种子来源与数量一律必须显式选。双打没有赛季积分，
  // 可选来源收窄为「手工指定 / 按等级分」，并给一句说明为什么不给积分。
  const allowedSeedModes =
    draft.matchType === MATCH_TYPE.DOUBLES ? VALID_DOUBLES_SEED_MODES : VALID_SEED_MODES;
  if (!allowedSeedModes.includes(draft.seedMode)) {
    errors.seedMode =
      draft.matchType === MATCH_TYPE.DOUBLES && draft.seedMode === SEED_MODE.POINTS
        ? '双打没有赛季积分，请选择手工指定或按等级分'
        : '请选择种子来源';
  }
  if (!VALID_SEED_COUNTS.includes(draft.seedCount)) {
    errors.seedCount = '请选择种子数量';
  }

  if (draft.description.length > DESCRIPTION_MAX) {
    errors.description = `赛事说明最多 ${DESCRIPTION_MAX} 个字`;
  }

  if (!draft.startTime || Number.isNaN(draft.startTime.getTime())) {
    errors.startTime = '请选择赛事时间';
  }

  if (draft.location.length > LOCATION_MAX) {
    errors.location = `场地最多 ${LOCATION_MAX} 个字`;
  }

  // 场地数必填。它是唯一一个必填的「新增约束」——名额可以不填（不限），
  // 但没有场地的比赛排不出场号，所以这里不给 0 也不给缺省
  if (
    !Number.isFinite(draft.courtCount) ||
    draft.courtCount < COURT_LIMITS.MIN ||
    draft.courtCount > COURT_LIMITS.MAX
  ) {
    errors.courtCount = `场地数需为 ${COURT_LIMITS.MIN}~${COURT_LIMITS.MAX} 的整数`;
  }

  if (!Number.isFinite(draft.quota) || draft.quota < 0) {
    errors.quota = '名额必须是不小于 0 的整数';
  }

  const firstFailed = FIELD_ORDER.find((field) => errors[field]);

  return {
    ok: !firstFailed,
    draft,
    errors,
    firstError: firstFailed ? errors[firstFailed] : '',
  };
}

/**
 * 由草稿组装一条可落库的赛事记录。
 *
 * 记录里带 publisherId / publisherName：赛事是「谁办的」在管理台账里必须
 * 能追溯，出了问题才知道该找谁核实。这与公告带 publisher、比赛带 recorder 同理。
 *
 * @param {Object} form 赛事表单
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 发布者
 * @param {Date} [ctx.now=new Date()] 发布时间，注入以便测试固定
 * @returns {{ok:boolean, record:Object|null, errors:Object, firstError:string}}
 */
function buildEventRecord(form, ctx = {}) {
  const { actor = null, now = new Date() } = ctx;
  const validation = validateEvent(form);

  if (!validation.ok) {
    return { ok: false, record: null, errors: validation.errors, firstError: validation.firstError };
  }

  const { draft } = validation;
  return {
    ok: true,
    record: {
      title: draft.title,
      description: draft.description,
      matchType: draft.matchType,
      // 赛事项目（男单 / 女单 / 男双 / 女双 / 混双）。null = 不限，与历史
      // 赛事同一口径；报名按项目性别拦人，双打抽签按它配对
      discipline: draft.discipline || null,
      // 池必须跟着记录一起写死：漏了会被按池过滤的查询静默漏掉，
      // 赛事发出去却哪儿都查不到，是最难排查的一类问题
      pool: MATCH_TYPE_TO_POOL[draft.matchType],
      level: draft.level,
      format: draft.format,
      // 循环赛与双败都没有「独立排位赛」的概念（双败名次由败者组自然排出），
      // 统一记 none；小组参数只在对应赛制下有意义，其余留 null 表明「本场无此概念」
      placementMode: KNOCKOUT_FORMATS.includes(draft.format)
        ? draft.placementMode
        : EVENT_PLACEMENT_MODE.NONE,
      groupCount: GROUP_COUNT_FORMATS.includes(draft.format) ? draft.groupCount : null,
      advancePerGroup: ADVANCE_FORMATS.includes(draft.format) ? draft.advancePerGroup : null,
      bronzeMode: KNOCKOUT_FORMATS.includes(draft.format) ? draft.bronzeMode : null,
      // 总决赛重赛只在双败赛制下有概念，其余留 null
      gfReset: DOUBLE_ELIM_FORMATS.includes(draft.format) ? draft.gfReset : null,
      // 种子设置单打双打都要：单打算到人，双打算到组（两人一组的分数之和）
      seedMode: draft.seedMode,
      seedCount: draft.seedCount,
      location: draft.location,
      startTime: draft.startTime,
      quota: draft.quota,
      // 可用场地总数：签表生成时按它给每场比赛排场号（services/court.js）。
      // 发布后没有编辑接口（Q10 的结论），填错了只能重发赛事
      courtCount: draft.courtCount,
      status: EVENT_STATUS.SIGNUP,
      // 名次在赛事结束后才录入，这里先占好位置，读的时候不必判 undefined
      results: [],
      // 签表在抽签后才有；先占位，读的时候不必判 undefined
      draw: null,
      publishTime: now,
      publisherId: actor ? actor._id : '',
      // 昵称逐层兜底：注册资料里昵称可能没填，绝不落库一个空字符串
      publisherName: actor ? actor.nickName || actor.realName || actor._id : '',
    },
    errors: {},
    firstError: '',
  };
}

/* ============================================================
 * 名次录入
 * ============================================================ */

/**
 * 这届的参赛人数打不打得出三四名赛。
 *
 * 三四名赛是「半决赛的两名负者再打一场」，所以要能打出第 4 名，前提是
 * 半决赛两场都真打。签表按 2 的幂补齐，参赛人数 N 与签表规模 size 的关系
 * 决定了半决赛是否满员：
 *   - N = 4（size 4）：首轮即半决赛，两场都是实打实的对阵 → 有两个负者；
 *   - N ≥ 5（size ≥ 8）：首轮过后每一轮都是满员对阵，到半决赛必然两场
 *     都打 → 有两个负者；
 *   - N = 3（size 4）：首轮有一场轮空，只有一个负者，第 4 名无从产生。
 * 归结起来就是「参赛满 4 人」。
 *
 * 人数未知（老数据没有签表、或调用方没传）时不作放宽，维持严格口径。
 *
 * @param {number} entryCount
 * @returns {boolean}
 */
function canPlayBronzeMatch(entryCount) {
  const count = Number(entryCount);
  if (!Number.isFinite(count)) return true;
  return count >= 4;
}

/**
 * 一个名次单位占几个人：单打 1，双打（一队）2。
 *
 * 【为什么名次校验要看它】
 * 双打名次记在每个人头上（两人的名次相同），所以「一位冠军」在双打下
 * 是两位得同一个人数。按 1 去卡，双打赛事永远结不了；按人数放行，又
 * 要知道一位名次该有几个人。调用方给 matchType，或直接给 teamSize。
 *
 * @param {Object} [options]
 * @returns {number}
 */
function teamSizeOf(options = {}) {
  const explicit = Math.floor(Number(options.teamSize));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return options.matchType === MATCH_TYPE.DOUBLES ? 2 : 1;
}

/**
 * 校验并整形成一个赛事的名次表。
 *
 * 【为什么在这里判成对而不是在积分里判】
 * 积分只看单个人的 placement（见 points.js），它无从知道「季军是不是
 * 并列」。若不在录入时挡一道，就会出现「并列模式却有人拿了第 4 名」
 * 这种记录——分数照算，但名次表自相矛盾，事后无法解释。
 *
 * 规则（「位」在双打下指「一组」，即 teamSize 人）：
 *   - 名次必须是正整数，且每人只出现一次；
 *   - 一场赛事有且只有一组冠军，亚军至多一组；
 *   - 循环赛 / 小组赛按「阶梯」口径：名次是积分表 1..N 排出来的，
 *     必然包含第 4 名，不再套用三四名成对规则；
 *   - 淘汰赛并列季军：不出现第 4 名；
 *   - 淘汰赛打三四名：第 3 名与第 4 名成对出现，且各至多一组——
 *     但参赛队伍不足 4 组时打不出三四名赛（见 canPlayBronzeMatch），
 *     此时只可能出现一组季军，不能再要求成对。
 *
 * @param {Array<Object>} results [{ userId, placement }]
 * @param {Object} [options]
 * @param {string} [options.bronzeMode] 取值见 constants.EVENT_BRONZE_MODE
 * @param {string} [options.format] 赛制，取值见 constants.EVENT_FORMAT
 * @param {number} [options.entryCount] 实际参赛队伍数；不传则按「打得出来」处理
 * @param {number} [options.matchType] 项目；据此推出 teamSize（单打 1 / 双打 2）
 * @param {number} [options.teamSize] 直接指定一个名次单位的人数，优先于 matchType
 * @returns {{ok:boolean, results:Array<Object>, errors:Object, firstError:string}}
 */
function validatePlacements(results, options = {}) {
  const bronzeMode = VALID_BRONZE_MODES.includes(options.bronzeMode)
    ? options.bronzeMode
    : DEFAULT_BRONZE_MODE;
  const teamSize = teamSizeOf(options);
  const unit = teamSize > 1 ? `一组（${teamSize} 人）` : '一位';

  const list = asArray(results);
  if (list.length === 0) {
    const message = '请录入参赛者的名次';
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    const userId = item && item.userId ? String(item.userId) : '';
    const placement = Number(item && item.placement);
    if (!userId || !Number.isInteger(placement) || placement < 1 || seen.has(userId)) {
      const message = '名次必须对应到人：每人只记一次，名次为正整数';
      return { ok: false, results: [], errors: { results: message }, firstError: message };
    }
    seen.add(userId);
    normalized.push({ userId, placement });
  }

  const countOf = (place) => normalized.filter((row) => row.placement === place).length;

  // 循环赛 / 小组赛 / 双败都按「阶梯」口径：名次是积分表或败者组 1..N 排出来的，
  // 必然出现第 4 名，也谈不上季军成对。套用淘汰赛的三四名规则会把正常名次表
  // 判成非法，赛事永远结不了。这里只守住「每人一次、正整数、恰有一位冠军」。
  if (LADDER_FORMATS.includes(options.format)) {
    if (countOf(1) !== teamSize) {
      const message = `一场赛事有且只有${unit}冠军`;
      return { ok: false, results: [], errors: { results: message }, firstError: message };
    }
    return { ok: true, results: normalized, errors: {}, firstError: '' };
  }

  // 人数不足 4 人时，这届根本排不出季军赛：只会有并列季军那一位，没有第 4 名。
  // 此时仍按「成对」卡，赛事就永远结不了（名次表无论怎么填都过不了校验）。
  const bronzePlayable = canPlayBronzeMatch(options.entryCount);

  let message = '';
  if (countOf(1) !== teamSize) {
    message = `一场赛事有且只有${unit}冠军`;
  } else if (countOf(2) > teamSize) {
    message = `亚军只能有${unit}`;
  } else if (bronzeMode === EVENT_BRONZE_MODE.TIED && countOf(4) > 0) {
    message = '并列季军模式下不应出现第 4 名';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && countOf(3) > teamSize) {
    message = '打三四名模式下第 3 名只能有一位';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && countOf(4) > teamSize) {
    message = '打三四名模式下第 4 名只能有一位';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && !bronzePlayable && countOf(4) > 0) {
    message = '本场参赛人数不足 4 人，打不出三四名赛，不应出现第 4 名';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && bronzePlayable && countOf(3) !== countOf(4)) {
    message = '打三四名模式下，第 3 名与第 4 名必须成对出现';
  }

  if (message) {
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  return { ok: true, results: normalized, errors: {}, firstError: '' };
}

/* ============================================================
 * 展示整形
 * ============================================================ */

/** 等级文案，缺省按三级（历史 / 种子赛事没有该字段） */
function levelLabelOf(event) {
  const level = event && event.level;
  return EVENT_LEVEL_LABEL[level] || EVENT_LEVEL_LABEL[EVENT_LEVEL.THIRD];
}

/** 三四名赛方式文案，缺省按并列（历史 / 种子赛事正是并列口径） */
function bronzeLabelOf(event) {
  const mode = event && event.bronzeMode;
  return EVENT_BRONZE_MODE_LABEL[mode] || EVENT_BRONZE_MODE_LABEL[DEFAULT_BRONZE_MODE];
}

/** 状态文案，缺省按已结束（种子赛事写死 2） */
function statusLabelOf(event) {
  const status = event && event.status;
  return EVENT_STATUS_LABEL[status] || EVENT_STATUS_LABEL[EVENT_STATUS.FINISHED];
}

/** 赛制，缺省按单败淘汰（历史 / 种子赛事没有该字段，缺省即旧行为） */
function formatOf(event) {
  const value = event && event.format;
  return VALID_FORMATS.includes(value) ? value : DEFAULT_EVENT_FORMAT;
}

/**
 * 会员在这场比赛里的报名状态。
 * @param {Object|null} signup
 * @returns {{status:number|null, label:string, signed:boolean, checkedIn:boolean}}
 */
function signupStateOf(signup) {
  if (!signup) {
    return { status: null, label: '未报名', signed: false, checkedIn: false };
  }
  // 签到了必然报过名，所以 signed 对两者都为真：它说的是「有一条有效报名」，
  // 而不是「恰好停在已报名这一步」。名次录入要的正是前者。
  return {
    status: signup.status,
    label: SIGNUP_STATUS_LABEL[signup.status] || '未报名',
    signed: signup.status === SIGNUP_STATUS.SIGNED || signup.status === SIGNUP_STATUS.CHECKED_IN,
    checkedIn: signup.status === SIGNUP_STATUS.CHECKED_IN,
  };
}

/**
 * 整形赛事列表的一行。
 *
 * 与 announcement.buildAnnouncementRow 同一约定：把权限算进数据里，
 * 模板只照着渲染按钮，不写 `wx:if="{{viewer.role >= 1}}"` 这类业务判断
 * ——那种写法 Node 跑不了，等于没法测。
 *
 * @param {Object} event 一条赛事
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @param {Array<Object>} [ctx.signups] 这场赛事的报名记录
 * @param {Object} [ctx.caps] 服务端算好的操作能力；给了就覆盖按旧 actor 现算的值
 * @returns {Object}
 */
function buildEventRow(event, ctx = {}) {
  const { actor = null, signups = [], caps = null } = ctx;

  const mySignup = signupOf(signups, actor ? actor._id : null);
  const state = signupStateOf(mySignup);
  const count = signupCountOf(event, signups);
  const quota = Number(event && event.quota) || 0;

  const row = {
    id: event._id,
    // 逐层兜底，绝不渲染出 undefined
    title: event.title || '（未命名赛事）',
    description: event.description || '',
    matchTypeLabel: MATCH_TYPE_LABEL[event.matchType] || '',
    // 项目标签（男单 / 女单 / 男双 / 女双 / 混双）；不限时为空串，界面不显示
    discipline: event.discipline || '',
    disciplineLabel: disciplineLabelOf(event.discipline),
    isDoubles: event.matchType === MATCH_TYPE.DOUBLES,
    levelLabel: levelLabelOf(event),
    bronzeLabel: bronzeLabelOf(event),
    // 赛制：老赛事没有这个字段，按单败淘汰展示
    format: formatOf(event),
    formatLabel: EVENT_FORMAT_LABEL[formatOf(event)] || EVENT_FORMAT_LABEL[DEFAULT_EVENT_FORMAT],
    isRoundRobin: formatOf(event) === EVENT_FORMAT.ROUND_ROBIN,
    isGroupKnockout: formatOf(event) === EVENT_FORMAT.GROUP_KNOCKOUT,
    isDoubleElim: formatOf(event) === EVENT_FORMAT.DOUBLE_ELIM,
    isGrouped: GROUPED_FORMATS.includes(formatOf(event)),
    // 倒三角排位赛开关（仅淘汰类赛制有意义）
    isTop8Placement:
      KNOCKOUT_FORMATS.includes(formatOf(event)) &&
      event.placementMode === EVENT_PLACEMENT_MODE.TOP8,
    // 置顶标记：管理员把它放在列表最前，与公告同一口径
    pinned: Boolean(event.pinned),
    status: event.status,
    statusLabel: statusLabelOf(event),
    isSignup: event.status === EVENT_STATUS.SIGNUP,
    isOngoing: event.status === EVENT_STATUS.ONGOING,
    isFinished: event.status === EVENT_STATUS.FINISHED,
    timeText: formatDateTime(event.startTime),
    location: event.location || '',
    // 抽签参数：单打双打都有（双打的种子是「两人一组」，seedCount 指组数）
    seedModeLabel: SEED_MODE_LABEL[event.seedMode] || '',
    seedMode: event.seedMode || '',
    // 手工指定种子的赛事，抽签前必须先在界面上点名排位（决策 9.4）；
    // 别处看这个布尔量，不必自己比对字符串
    isManualSeed: event.seedMode === SEED_MODE.MANUAL,
    seedCount: Number(event.seedCount) || 0,
    // 是否已抽过签（决定入口文案是「抽签」还是「重抽」）
    drawn: Boolean(event.draw),
    drawCount: (event.draw && event.draw.drawCount) || 0,
    signupCount: count,
    quotaText: quota > 0 ? `${count}/${quota} 人` : `${count} 人`,
    // 可用场地数（如「3 块场地」）。老赛事没有这个字段，显示「未设置」
    courtCount: Number(event && event.courtCount) || 0,
    courtCountText: courtCountTextOf(event && event.courtCount),
    mySignupLabel: state.label,
    signedUp: state.signed,
    checkedIn: state.checkedIn,
    // 本人报名 / 退赛；离校者、报名截止后都会自动为 false
    canSignUp: canSignUp(event, actor, { signup: mySignup, signups }),
    canCancelSignup: canCancelSignup(event, actor, { signup: mySignup }),
    // 管理端按钮
    // 置顶/取消置顶与发布同一门槛（仅管理员），列表行据此渲染切换按钮
    canPin: canManageEvent(actor),
    canStart: canStartEvent(event, actor),
    canCheckIn: canCheckIn(event, actor),
    canFinish: canFinishEvent(event, actor),
    // 抽签入口：报名中、有管理权（单打双打都可）。已抽过签后仍为 true，
    // 好让管理员在开赛前重抽；已开赛 / 已有比赛生效由服务端最终把关
    canDraw: canDrawEvent(event, actor),
  };

  // 协议 2：判权在服务端，页面上没有旧角色的 actor 可算。调用方把服务端算好的
  // 能力传进来就覆盖对应字段——构建器本身不判权，只负责展示形状与文案。
  return applyEventCaps(row, caps);
}

/**
 * 可由服务端显式下发的能力键。只覆盖调用方真的给了的键，其余保持按 actor 算出的值。
 * @param {Object} row buildEventRow 的结果
 * @param {Object|null} caps
 * @returns {Object}
 */
function applyEventCaps(row, caps) {
  if (!caps) return row;
  const keys = [
    'canSignUp', 'canCancelSignup', 'canStart', 'canDraw', 'canFinish', 'canCheckIn', 'canPin',
  ];
  const out = { ...row };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(caps, key)) out[key] = Boolean(caps[key]);
  }
  return out;
}

/**
 * 整形报名名单的一行（用于签到与名次录入）。
 *
 * @param {Object} signup 报名记录
 * @param {Object} [member] 会员档案，取昵称头像
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @returns {Object}
 */
function buildSignupRow(signup, member, ctx = {}) {
  const { actor = null } = ctx;
  const state = signupStateOf(signup);
  const profile = member || {};

  return {
    userId: signup.userId,
    nickName: profile.nickName || signup.userId,
    avatarUrl: profile.avatarUrl || '',
    statusLabel: state.label,
    checkedIn: state.checkedIn,
    isMe: Boolean(actor && actor._id === signup.userId),
  };
}

module.exports = {
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  VALID_LEVELS,
  VALID_BRONZE_MODES,
  VALID_SEED_MODES,
  VALID_SEED_COUNTS,
  VALID_FORMATS,
  VALID_PLACEMENT_MODES,
  canManageEvent,
  canStartEvent,
  startBlockedReason,
  canCheckIn,
  canFinishEvent,
  canDrawEvent,
  canSignUp,
  canCancelSignup,
  signupCountOf,
  signupOf,
  buildSignupRecord,
  buildCheckInPatch,
  normalizeDraft,
  validateEvent,
  buildEventRecord,
  validatePlacements,
  levelLabelOf,
  bronzeLabelOf,
  statusLabelOf,
  signupStateOf,
  buildEventRow,
  buildSignupRow,
};
