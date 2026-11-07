/**
 * 学院赛 —— 发布表单、状态文案与展示整形
 * ============================================================
 * 学院赛与个人赛并行，是两套互不干扰的体系（D1）。这个模块只回答
 * 学院赛发布相关的问题：
 *   1. 我能不能发布 / 管理学院赛？（权限）
 *   2. 我填的这张学院赛单子能不能发出去？（表单校验）
 *   3. 列表与详情上该显示成什么样？（文案整形）
 *
 * 【为什么不并进 event.js】
 * 个人赛的模型是「一个赛事一个项目、一张签表、个人名次」；学院赛是
 * 「名单制报名、学院进签表、大场套小场」。两者共用的只有几条长度上限
 * 与权限门槛，把它们混在一起，个人赛那条已经很长的校验链会变得更难读，
 * 也容易在一次「顺手改改」里动到不该动的分支。
 *
 * 【与 event.js 保持一致的地方】
 * 校验顺序、错误文案口径、记录里的占位字段（results / draw 之类先占好，
 * 读的时候不必判 undefined）都与 event.js 对齐，页面照抄即可。
 * 纯判断，不碰 wx、不碰数据源，可在 Node 里完整测试。
 * ============================================================
 */

const {
  EVENT_FORMAT,
  ROLE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_EVENT_STATUS_LABEL,
  DEFAULT_COLLEGE_EVENT_STATUS,
  LEG_DISCIPLINE_LABEL,
  ALL_LEG_DISCIPLINES,
  TIE_ALGO,
  TIE_ALGO_LABEL,
  DEFAULT_TIE_ALGO,
  TIE_NET_MODE,
  TIE_NET_MODE_LABEL,
  DEFAULT_TIE_NET_MODE,
  ROSTER_LIMITS,
  DEFAULT_ALLOW_MULTI_ENTRY,
  COURT_LIMITS,
  courtCountTextOf,
} = require('../utils/constants.js');
const { formatDate, formatPlacement } = require('../utils/format.js');
const { canManage } = require('./permission.js');
const { readAudience } = require('./association-audience.js');

/** 标题长度下限与上限，与个人赛同一口径 */
const TITLE_MIN = 2;
const TITLE_MAX = 30;
/** 说明文字长度上限 */
const DESCRIPTION_MAX = 200;
/** 场地长度上限 */
const LOCATION_MAX = 40;
/** 一场大场的小项个数区间：至少一个，至多二十个 */
const LEG_PLAN_MIN = 1;
const LEG_PLAN_MAX = 20;

/** 校验顺序即表单顺序，取「第一条错误」时按它走 */
const FIELD_ORDER = [
  'title',
  'description',
  'legPlan',
  'allowMultiEntry',
  'rosterMin',
  'rosterMax',
  'tieAlgo',
  'tieNetMode',
  'startTime',
  'location',
  'courtCount',
];

/** 合法的大场胜负算法集合 */
const VALID_TIE_ALGOS = Object.values(TIE_ALGO);
/** 合法的净胜口径集合 */
const VALID_TIE_NET_MODES = Object.values(TIE_NET_MODE);

/* ============================================================
 * 权限
 * ============================================================ */

/**
 * 有没有管理学院赛的资格（发布 / 审核名单 / 抽签 / 开始 / 结束）。**仅管理员**。
 *
 * 【为什么学院负责人不能发布学院赛】
 * 学院负责人是「学院负责人」，管的是本学院的临场事务（提交名单、排阵、录分）。
 * 而发布学院赛要定小项序列、人数上下限、胜负算法——这些是整场赛事的
 * 规则，一旦定错，所有学院都要跟着重来，因此收口到管理员，与个人赛的
 * 发布权同一门槛。名单的提交权则相反，见 college-entry.canSubmitCollegeEntry。
 *
 * @param {Object|null} actor
 * @param {Object} [options] 透传给 permission.canManage（如 isMock）
 * @returns {boolean}
 */
function canManageCollegeEvent(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

/* ============================================================
 * 发布表单
 * ============================================================ */

/**
 * 去掉首尾空格、把数字收敛成数字、把日期收敛成 Date。
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
  // 小项序列：表单里是一串项目代码，逐项去空格；非数组一律当没填
  const list = (value) => (Array.isArray(value) ? value.map(text) : []);

  return {
    title: text(source.title),
    description: text(source.description),
    legPlan: list(source.legPlan),
    allowMultiEntry: bool(source.allowMultiEntry, DEFAULT_ALLOW_MULTI_ENTRY),
    // 人数上下限留空即取默认 4–20，不用像等级那样强制显式选：
    // 它只影响报名能否提交，不改变已经产生成绩的口径
    rosterMin: int(source.rosterMin) === null ? ROSTER_LIMITS.DEFAULT_MIN : int(source.rosterMin),
    rosterMax: int(source.rosterMax) === null ? ROSTER_LIMITS.DEFAULT_MAX : int(source.rosterMax),
    tieAlgo: text(source.tieAlgo) || DEFAULT_TIE_ALGO,
    tieNetMode: text(source.tieNetMode) || DEFAULT_TIE_NET_MODE,
    location: text(source.location),
    startTime: source.startTime ? new Date(source.startTime) : null,
    // 可用场地数：必填，不设缺省（与个人赛同一口径）。未填留 null 交给
    // 校验去说「请填写」，不悄悄当成 1
    courtCount: int(source.courtCount),
  };
}

/**
 * 校验一张学院赛草稿。
 *
 * 【小项序列为什么必须显式配置】
 * 大场打哪几项完全由它决定，没有「默认打什么」。留空发出去，抽签后
 * 谁都排不出阵，只能回头改赛事——而那时名单可能已经锁定。
 * 所以这里要求至少一个小项，且每一项都在项目池内。
 *
 * 【人数区间为什么两道校验】
 * 先判单项是否落在硬边界 1–50，再判「最少 ≤ 最多」。只判后者的话，
 * 一份「最少 0、最多 999」的名单也能通过，等于没有约束。
 *
 * @param {Object} [form]
 * @returns {{ok:boolean, draft:Object, errors:Object<string,string>, firstError:string}}
 */
function validateCollegeEvent(form = {}) {
  const draft = normalizeDraft(form);
  const errors = {};

  if (draft.title.length < TITLE_MIN || draft.title.length > TITLE_MAX) {
    errors.title = `赛事名称需为 ${TITLE_MIN}~${TITLE_MAX} 个字`;
  }

  if (draft.description.length > DESCRIPTION_MAX) {
    errors.description = `赛事说明最多 ${DESCRIPTION_MAX} 个字`;
  }

  if (draft.legPlan.length < LEG_PLAN_MIN) {
    errors.legPlan = '请至少安排一个小项';
  } else if (draft.legPlan.length > LEG_PLAN_MAX) {
    errors.legPlan = `一场大场最多 ${LEG_PLAN_MAX} 个小项`;
  } else if (draft.legPlan.some((item) => !ALL_LEG_DISCIPLINES.includes(item))) {
    errors.legPlan = '小项只能从男单 / 女单 / 男双 / 女双 / 混双中选择';
  }

  const minOk =
    Number.isFinite(draft.rosterMin) &&
    draft.rosterMin >= ROSTER_LIMITS.MIN &&
    draft.rosterMin <= ROSTER_LIMITS.MAX;
  if (!minOk) {
    errors.rosterMin = `最少人数需为 ${ROSTER_LIMITS.MIN}~${ROSTER_LIMITS.MAX} 的整数`;
  }
  const maxOk =
    Number.isFinite(draft.rosterMax) &&
    draft.rosterMax >= ROSTER_LIMITS.MIN &&
    draft.rosterMax <= ROSTER_LIMITS.MAX;
  if (!maxOk) {
    errors.rosterMax = `最多人数需为 ${ROSTER_LIMITS.MIN}~${ROSTER_LIMITS.MAX} 的整数`;
  } else if (minOk && draft.rosterMin > draft.rosterMax) {
    errors.rosterMax = '最多人数不能小于最少人数';
  }

  if (!VALID_TIE_ALGOS.includes(draft.tieAlgo)) {
    errors.tieAlgo = '请选择大场胜负算法';
  }
  // 净胜口径只对「打满比净胜」有意义；选「先到 N 场胜」时忽略本项，
  // 不因为没选而拦下整张表单
  if (
    draft.tieAlgo === TIE_ALGO.FULL_POINTS &&
    !VALID_TIE_NET_MODES.includes(draft.tieNetMode)
  ) {
    errors.tieNetMode = '请选择净胜口径';
  }

  if (!draft.startTime || Number.isNaN(draft.startTime.getTime())) {
    errors.startTime = '请选择赛事时间';
  }

  if (draft.location.length > LOCATION_MAX) {
    errors.location = `场地最多 ${LOCATION_MAX} 个字`;
  }

  // 场地数必填：一个大场占一块场地，签表按它给每个大场排场号
  if (
    !Number.isFinite(draft.courtCount) ||
    draft.courtCount < COURT_LIMITS.MIN ||
    draft.courtCount > COURT_LIMITS.MAX
  ) {
    errors.courtCount = `场地数需为 ${COURT_LIMITS.MIN}~${COURT_LIMITS.MAX} 的整数`;
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
 * 由草稿组装一条可落库的学院赛记录。
 *
 * 记录里带 publisherId / publisherName，与个人赛同理：赛事是「谁办的」
 * 必须能追溯。results / seedColleges / currentRound 先占好位置，
 * 读的时候不必判 undefined。
 *
 * @param {Object} form
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 发布者
 * @param {Date} [ctx.now=new Date()]
 * @returns {{ok:boolean, record:Object|null, errors:Object, firstError:string}}
 */
function buildCollegeEventRecord(form, ctx = {}) {
  const { actor = null, now = new Date() } = ctx;
  const validation = validateCollegeEvent(form);

  if (!validation.ok) {
    return { ok: false, record: null, errors: validation.errors, firstError: validation.firstError };
  }

  const { draft } = validation;
  return {
    ok: true,
    record: {
      title: draft.title,
      description: draft.description,
      // 赛制先行只做团体单败（D16）；写死而非让管理员选，避免出现排不出的组合
      format: EVENT_FORMAT.SINGLE_ELIM,
      legPlan: draft.legPlan.slice(),
      allowMultiEntry: draft.allowMultiEntry,
      rosterMin: draft.rosterMin,
      rosterMax: draft.rosterMax,
      tieAlgo: draft.tieAlgo,
      // 「先到 N 场胜」用不上净胜口径，留 null 表明「本场无此概念」
      tieNetMode: draft.tieAlgo === TIE_ALGO.FULL_POINTS ? draft.tieNetMode : null,
      status: DEFAULT_COLLEGE_EVENT_STATUS,
      // 抽签后才有轮次与种子；先占位
      currentRound: 0,
      seedColleges: [],
      // 名次只记给学院：[{ college, placement }]
      results: [],
      location: draft.location,
      startTime: draft.startTime,
      // 可用场地总数：一个大场占一块场地，抽签时按它排场号，再下推到小场
      courtCount: draft.courtCount,
      publishTime: now,
      publisherId: actor ? actor._id : '',
      publisherName: actor ? actor.nickName || actor.realName || actor._id : '',
    },
    errors: {},
    firstError: '',
  };
}

/* ============================================================
 * 学院名次（M5-1）
 * ============================================================ */

/**
 * 能不能给这场学院赛录入名次并结束它。**仅管理员**，且赛事进行中。
 *
 * 与 canFinishEvent（个人赛）同一门槛：名次一落库，赛事就画上句号，
 * 再改要重开赛事。报名中 / 待开赛还没有任何大场结果，录名次无从谈起。
 *
 * @param {Object|null} event
 * @param {Object|null} actor
 * @param {Object} [options] 透传给 permission.canManage（如 isMock）
 * @returns {boolean}
 */
function canFinishCollegeEvent(event, actor, options = {}) {
  if (!event || event.status !== COLLEGE_EVENT_STATUS.ONGOING) return false;
  return canManageCollegeEvent(actor, options);
}

/**
 * 校验学院名次。名次只记给学院，不涉及任何个人（D26）。
 *
 * 【为什么与个人赛的名次校验各写一份】
 * 个人赛的 validatePlacements 校验的是 userId，还要按签表算三轮的并列口径
 * （并列季军 / 打三四名 / 八强倒三角），规则长在「个人名次」这个模型上。
 * 学院赛到名次这步只剩学院与名次两个字段，若硬塞进同一个函数，就要在里头
 * 到处判「这行是学院还是人」，读的人迟早会改错分支。
 *
 * 【为什么只要求「一位冠军」】
 * 与个人赛同一条底线：名次可以有并列（三、四名），但冠军必须是唯一的。
 * 其余学院录不录、录几名，交给管理员判断——没到场的学院可能压根不记。
 *
 * @param {Array<{college:string, placement:number|string}>} results
 * @param {Object} [options]
 * @param {Array<string>} [options.colleges] 可记名次的学院（已通过审核的）
 * @returns {{ok:boolean, results:Array<{college:string, placement:number}>, errors:Object, firstError:string}}
 */
function validateCollegePlacements(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) {
    const message = '请录入学院名次';
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  const allowed = Array.isArray(options.colleges)
    ? new Set(options.colleges.filter(Boolean))
    : null;
  const normalized = [];
  const seen = new Set();

  for (const item of list) {
    const college = String((item && item.college) || '').trim();
    const placement = Number(item && item.placement);

    if (!college || !Number.isInteger(placement) || placement < 1 || seen.has(college)) {
      const message = '名次必须对应到学院：每院只记一次，名次为正整数';
      return { ok: false, results: [], errors: { results: message }, firstError: message };
    }
    if (allowed && !allowed.has(college)) {
      const message = '只能给参赛学院记名次';
      return { ok: false, results: [], errors: { results: message }, firstError: message };
    }

    seen.add(college);
    normalized.push({ college, placement });
  }

  if (normalized.filter((row) => row.placement === 1).length !== 1) {
    const message = '一场学院赛有且只有一位冠军学院';
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  return { ok: true, results: normalized, errors: {}, firstError: '' };
}

/* ============================================================
 * 展示整形
 * ============================================================ */

/**
 * 状态文案。缺省按「报名中」，未知取值给「未知状态」而不是空白。
 * @param {Object|null} event
 * @returns {string}
 */
function statusLabelOf(event) {
  if (!event) return '';
  return COLLEGE_EVENT_STATUS_LABEL[event.status] || '未知状态';
}

/**
 * 大场胜负算法文案。历史记录缺字段时按默认「打满比净胜」。
 * @param {Object|null} event
 * @returns {string}
 */
function tieAlgoLabelOf(event) {
  if (!event) return '';
  return TIE_ALGO_LABEL[event.tieAlgo] || TIE_ALGO_LABEL[DEFAULT_TIE_ALGO];
}

/**
 * 净胜口径文案。「先到 N 场胜」用不上，返回空串，界面据此不显示这一行。
 * @param {Object|null} event
 * @returns {string}
 */
function tieNetModeLabelOf(event) {
  if (!event || event.tieAlgo === TIE_ALGO.FIRST_TO_N) return '';
  return TIE_NET_MODE_LABEL[event.tieNetMode] || TIE_NET_MODE_LABEL[DEFAULT_TIE_NET_MODE];
}

/**
 * 小项序列文案，例如「男单 · 女单 · 男双」。
 * @param {Object|null} event
 * @returns {string}
 */
function legPlanTextOf(event) {
  const plan = event && Array.isArray(event.legPlan) ? event.legPlan : [];
  return plan.map((item) => LEG_DISCIPLINE_LABEL[item] || item).join(' · ');
}

/**
 * 名单人数区间文案，例如「4–20 人」。
 * @param {Object|null} event
 * @returns {string}
 */
function rosterRangeTextOf(event) {
  const min = event && Number.isFinite(Number(event.rosterMin)) ? Number(event.rosterMin) : ROSTER_LIMITS.DEFAULT_MIN;
  const max = event && Number.isFinite(Number(event.rosterMax)) ? Number(event.rosterMax) : ROSTER_LIMITS.DEFAULT_MAX;
  return `${min}–${max} 人`;
}

/**
 * 名次展示行：按名次从高到低排好，并把数字翻成「冠军 / 亚军 / 四强」。
 *
 * 名次文案走 utils/format.formatPlacement 的淘汰赛口径（3 是四强、
 * 5 是八强），与个人赛的奖牌文案各管各的：学院赛不排 5–8 名，用不上
 * 「八强倒三角」那一套。
 *
 * @param {Object|null} event
 * @returns {Array<{college:string, placement:number, placementText:string}>}
 */
function buildCollegeResultRows(event) {
  const results = event && Array.isArray(event.results) ? event.results : [];
  return results
    .slice()
    .sort((a, b) => Number(a.placement) - Number(b.placement))
    .map((row) => ({
      college: row.college || '',
      placement: Number(row.placement),
      placementText: formatPlacement(row.placement),
    }));
}

/**
 * 列表行整形。权限布尔量在这里算好，模板不写业务判断。
 *
 * @param {Object} event
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的人
 * @returns {Object}
 */
function buildCollegeEventRow(event, ctx = {}) {
  const { actor = null } = ctx;
  const source = event || {};
  const status = source.status;

  return {
    eventId: source._id || '',
    title: source.title || '',
    // 置顶标记：管理员把它放在列表最前，与个人赛、公告同一口径
    pinned: Boolean(source.pinned),
    status,
    statusLabel: statusLabelOf(source),
    isSignup: status === COLLEGE_EVENT_STATUS.SIGNUP,
    isReady: status === COLLEGE_EVENT_STATUS.READY,
    isOngoing: status === COLLEGE_EVENT_STATUS.ONGOING,
    isFinished: status === COLLEGE_EVENT_STATUS.FINISHED,
    legPlanText: legPlanTextOf(source),
    legCount: Array.isArray(source.legPlan) ? source.legPlan.length : 0,
    allowMultiEntry: source.allowMultiEntry !== false,
    rosterText: rosterRangeTextOf(source),
    tieAlgoLabel: tieAlgoLabelOf(source),
    tieNetModeLabel: tieNetModeLabelOf(source),
    startTimeText: formatDate(source.startTime),
    location: source.location || '',
    // 可用场地数（如「3 块场地」）。老赛事没有这个字段，显示「未设置」
    courtCount: Number(source.courtCount) || 0,
    courtCountText: courtCountTextOf(source.courtCount),
    publisherName: source.publisherName || '',
    // 小组限制（受众范围，B6）：旧赛事缺字段按「不限」兼容
    audienceMode: readAudience(source).audienceMode,
    audienceGroupIds: readAudience(source).audienceGroupIds,
    // 发布 / 审核 / 抽签 / 开始 / 结束 / 置顶都归管理员，一并用它
    canManage: canManageCollegeEvent(actor),
  };
}

/** 置顶优先，同状态按开赛时间升序；排序不修改输入台账。 */
function sortCollegeEvents(events) {
  const order = [COLLEGE_EVENT_STATUS.SIGNUP, COLLEGE_EVENT_STATUS.READY,
    COLLEGE_EVENT_STATUS.ONGOING, COLLEGE_EVENT_STATUS.FINISHED];
  const priority = row => { const index = order.indexOf(row.status); return index < 0 ? 99 : index; };
  return (Array.isArray(events) ? events : []).slice().sort((a, b) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    priority(a) - priority(b) ||
    (Date.parse(a.startTime) || 0) - (Date.parse(b.startTime) || 0) ||
    (a._id || '') < (b._id || '') ? -1 : (a._id || '') > (b._id || '') ? 1 : 0);
}

module.exports = {
  sortCollegeEvents,
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  LEG_PLAN_MIN,
  LEG_PLAN_MAX,
  FIELD_ORDER,
  VALID_TIE_ALGOS,
  VALID_TIE_NET_MODES,
  canManageCollegeEvent,
  normalizeDraft,
  validateCollegeEvent,
  buildCollegeEventRecord,
  canFinishCollegeEvent,
  validateCollegePlacements,
  statusLabelOf,
  tieAlgoLabelOf,
  tieNetModeLabelOf,
  legPlanTextOf,
  rosterRangeTextOf,
  buildCollegeResultRows,
  buildCollegeEventRow,
};
