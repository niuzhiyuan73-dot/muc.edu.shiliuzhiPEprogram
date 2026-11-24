/**
 * 篮球规则快照
 * ============================================================
 * 篮球和四个球拍运动不是同一种东西：球拍运动一场比赛的「赛制」只有分制与
 * 局制两个数，篮球要管的是节数、节长、犯规上限、全队犯规阈值、加时……
 * 这些东西**不能写死在代码里**——院系赛常用 2×20 分钟，校队用 FIBA 的
 * 4×10，写死哪一个都会逼另一群人手改代码。
 *
 * 所以做法是：赛事创建时选一个**规则快照**，整份存进赛事文档；比赛只认
 * 自己那场赛事上的快照。改了默认值不影响历史比赛，历史比赛的判定也不会
 * 因为后来有人调了常量而变。
 *
 * 【口径来源】
 *   - FIBA Official Basketball Rules 2024（4×10、加时 5 分钟、个人 5 犯、
 *     每节全队第 5 犯起罚球、三分线 6.75 m、24 秒）
 *   - 第 27 届 CUBAL 基层赛竞赛规程（同为 4×10；节间 2 分钟、半场 10 分钟）
 *   - 「2×20 分钟」是校园院系赛的常见变体，作为预设提供，不宣称等同官方
 *
 * 【本项目与官方的两处差异，必须显式记着】
 *   1. 报名下限：官方/CUBAL 是「不足 8 人不得参赛」，本项目按**满 5 人即可
 *      比赛、不强制替补**处理（rosterMin = 5）。
 *   2. 因此必须给「场上不足 2 人判负」留字段（minOnCourt），否则 5 人开赛
 *      遇到 5 犯离场就会撞上一个没定义的死局。
 *
 * 本模块是纯函数（不碰 wx、不碰 I/O），列入 tools/sync-cloud-lib.js 的
 * MANIFEST，云端与本地共用同一份判定。
 * ============================================================
 */

/** 篮球的两套制式。3x3 已列入计划但首版不做，这里只留标识。 */
const BASKETBALL_FORMAT = {
  FIVE: 'basketball5',
  THREE: 'basketball3',
};

/** 制式的显示名 */
const BASKETBALL_FORMAT_LABEL = {
  [BASKETBALL_FORMAT.FIVE]: '五人制',
  [BASKETBALL_FORMAT.THREE]: '三人制',
};

/**
 * 全队犯规的统计窗口。
 * FIBA 按「每节」重置；2×20 的院系赛习惯按「每半场」重置。
 * 这个差异会直接影响罚球时机，必须存进快照，不能靠 infer。
 */
const FOUL_WINDOW = {
  PERIOD: 'period',
  HALF: 'half',
};

/**
 * 规则预设。键即 `presetKey`，赛事创建时二选一。
 *
 * 两份预设的差别只在节数/节长与犯规窗口；其余（个人 5 犯、全队第 5 犯、
 * 三分线 6.75、24 秒）都用 FIBA 口径，因为校园赛没有自己的三分线。
 */
const RULE_PRESETS = {
  'fiba-4x10': {
    key: 'fiba-4x10',
    label: 'FIBA 四节（4 × 10 分钟）',
    sportFormat: BASKETBALL_FORMAT.FIVE,
    periods: 4,
    periodMinutes: 10,
    overtimeMinutes: 5,
    personalFoulLimit: 5,
    teamFoulPenalty: 5,
    foulWindow: FOUL_WINDOW.PERIOD,
    threePointLine: 6.75,
    shotClock: 24,
    rosterMin: 5,
    rosterMax: 12,
    minOnCourt: 2,
    allowDraw: false,
    ruleVersion: 'fiba-2024',
  },
  'campus-2x20': {
    key: 'campus-2x20',
    label: '校园上下半场（2 × 20 分钟）',
    sportFormat: BASKETBALL_FORMAT.FIVE,
    periods: 2,
    periodMinutes: 20,
    overtimeMinutes: 5,
    personalFoulLimit: 5,
    teamFoulPenalty: 5,
    // 院系赛习惯按半场重置全队犯规；FIBA 没有这种窗口，属校园约定
    foulWindow: FOUL_WINDOW.HALF,
    threePointLine: 6.75,
    shotClock: 24,
    rosterMin: 5,
    rosterMax: 12,
    minOnCourt: 2,
    allowDraw: false,
    ruleVersion: 'campus-2026',
  },
};

/** 默认预设：与 CUBAL / 中国篮协一致的那一份 */
const DEFAULT_PRESET_KEY = 'fiba-4x10';

/** 字段的合法区间。超出即判非法，不做静默夹取——静默夹取会让「选了 6 节」
 *  变成「悄悄按 4 节打」，事后没人能查出是哪次配置错的。 */
const LIMITS = {
  periods: [1, 4],
  periodMinutes: [5, 20],
  overtimeMinutes: [1, 10],
  personalFoulLimit: [3, 6],
  teamFoulPenalty: [1, 10],
  shotClock: [12, 30],
  rosterMin: [3, 15],
  rosterMax: [3, 20],
  minOnCourt: [2, 5],
};

/** 预设的深拷贝。取不到时退回默认预设，绝不抛错。 */
function presetOf(key) {
  const preset = RULE_PRESETS[key] || RULE_PRESETS[DEFAULT_PRESET_KEY];
  return { ...preset };
}

/** 某制式的默认规则（目前只有五人制有预设）。 */
function defaultRulesFor(sportFormat = BASKETBALL_FORMAT.FIVE) {
  if (sportFormat === BASKETBALL_FORMAT.THREE) {
    // 3x3 首版不做。这里给一份**独立的、明确未启用**的占位，而不是改几个
    // 五人制的数字——3x3 的加时是「先得 2 分」而非计时，罚则另成一套，
    // 直接继承五人制快照只会让人误以为它已经能用。
    return {
      presetKey: 'fiba-3x3',
      sportFormat: BASKETBALL_FORMAT.THREE,
      periods: 1,
      periodMinutes: 10,
      scoreLimit: 21, // 先到 21 分立即结束
      shotClock: 12,
      rosterMin: 3,
      rosterMax: 4, // 3 人 + 1 替补
      ruleVersion: 'fiba-3x3-2025',
      enabled: false,
    };
  }
  return presetOf(DEFAULT_PRESET_KEY);
}

function isIntegerInRange(value, range) {
  return Number.isInteger(value) && value >= range[0] && value <= range[1];
}

/**
 * 校验并归一化一份规则快照。
 *
 * 入参可以是「只有 presetKey 的半成品」（赛事表单常见），也可以是完整快照
 * （从赛事文档读回来再改）。缺省字段用预设补齐，非法字段**不补**，返回 null。
 *
 * @param {Object} input
 * @returns {Object|null} 合法快照；不合法返回 null
 */
function normalizeBasketballRules(input) {
  if (!input || typeof input !== 'object') return null;
  // 至少要给出「用哪套预设」或「哪种制式」其中之一：两个都不给就无从判断
  // 这是五人制还是三人制，静默补成默认预设等于替用户做了决定。
  if (!input.presetKey && !input.sportFormat) return null;
  const source = { ...presetOf(input.presetKey), ...input };
  const sportFormat = source.sportFormat;

  // 三人制首版不开放：允许读旧数据，但不允许新建（enabled 为 false）
  if (sportFormat === BASKETBALL_FORMAT.THREE && source.enabled !== false) return null;
  if (sportFormat !== BASKETBALL_FORMAT.FIVE && sportFormat !== BASKETBALL_FORMAT.THREE) return null;

  const rules = {
    presetKey: source.presetKey || DEFAULT_PRESET_KEY,
    sportFormat,
    periods: Number(source.periods),
    periodMinutes: Number(source.periodMinutes),
    overtimeMinutes: Number(source.overtimeMinutes),
    personalFoulLimit: Number(source.personalFoulLimit),
    teamFoulPenalty: Number(source.teamFoulPenalty),
    foulWindow: source.foulWindow === FOUL_WINDOW.HALF ? FOUL_WINDOW.HALF : FOUL_WINDOW.PERIOD,
    threePointLine: Number(source.threePointLine),
    shotClock: Number(source.shotClock),
    rosterMin: Number(source.rosterMin),
    rosterMax: Number(source.rosterMax),
    minOnCourt: Number(source.minOnCourt),
    allowDraw: source.allowDraw === true,
    // 3x3 首版不开放：快照里保留 enabled=false，读旧数据时不会因此判非法，
    // 但改一遍再存仍是 false —— 保证 normalize 是幂等的。
    enabled: sportFormat !== BASKETBALL_FORMAT.THREE,
    ruleVersion: String(source.ruleVersion || ''),
  };

  for (const [field, range] of Object.entries(LIMITS)) {
    if (!isIntegerInRange(rules[field], range)) return null;
  }
  if (!Number.isFinite(rules.threePointLine) || rules.threePointLine <= 0) return null;
  if (!rules.ruleVersion) return null;
  if (rules.rosterMin > rules.rosterMax) return null;
  // 报名下限不能低于「场上人数」：凑不齐阵容就谈不上比赛
  if (rules.sportFormat === BASKETBALL_FORMAT.FIVE && rules.rosterMin < 5) return null;
  if (rules.minOnCourt > rules.rosterMin) return null;
  // 加时必须能打完一节的时间尺度，否则「5 分钟加时、3 分钟一节」毫无意义
  if (rules.overtimeMinutes < 1) return null;

  return rules;
}

/** 是否是合法快照（供别处做布尔判断） */
function isValidBasketballRules(input) {
  return normalizeBasketballRules(input) !== null;
}

/**
 * 规则的一行人话，用于赛事详情与列表。
 * @param {Object} input 规则快照
 * @returns {string} 例：'4 节 × 10 分钟 · 个人 5 犯 · 全队第 5 犯起罚球 · 加时 5 分钟'
 */
function formatBasketballRules(input) {
  const rules = normalizeBasketballRules(input);
  if (!rules) return '';
  const unit = rules.foulWindow === FOUL_WINDOW.HALF ? '半场' : '节';
  const parts = [
    `${rules.periods} 节 × ${rules.periodMinutes} 分钟`,
    `个人 ${rules.personalFoulLimit} 犯离场`,
    `全队每${unit}第 ${rules.teamFoulPenalty} 犯起罚球`,
    `加时 ${rules.overtimeMinutes} 分钟`,
  ];
  if (rules.allowDraw) parts.push('允许平局');
  return parts.join(' · ');
}

/**
 * 名单人数够不够开赛。
 *
 * 【为什么单独一个函数】
 * 「满 5 人即可比赛」是本项目的明确决定，与 CUBAL 的「不足 8 人不参赛」
 * 不同。这条规则会被报名审核、开赛、改名单三处用到，写成常量散在页面里
 * 迟早出现「页面放行、接口拒绝」。
 *
 * @param {number} rosterSize 已通过审核的报名人数
 * @param {Object} rules 规则快照
 * @returns {{ok:boolean, need:number}}
 */
function canStartWithRoster(rosterSize, rules) {
  const normalized = normalizeBasketballRules(rules) || defaultRulesFor();
  const count = Number(rosterSize) || 0;
  return { ok: count >= normalized.rosterMin, need: normalized.rosterMin };
}

module.exports = {
  BASKETBALL_FORMAT,
  BASKETBALL_FORMAT_LABEL,
  FOUL_WINDOW,
  RULE_PRESETS,
  DEFAULT_PRESET_KEY,
  LIMITS,
  presetOf,
  defaultRulesFor,
  normalizeBasketballRules,
  isValidBasketballRules,
  formatBasketballRules,
  canStartWithRoster,
};
