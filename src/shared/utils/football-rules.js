/** 十一人制规则快照。默认参数与可选范围见 docs/足球协会-需求与实施规划.md。
 * 纯模块：预设只用于补齐新表单，已存快照不跟随预设更新。非法值不静默纠正。
 */
const FOOTBALL_FORMAT = 'football11';
const DEFAULT_PRESET_KEY = 'football11-campus-v1';
const STANDARD_PRESET_KEY = 'football11-standard-v1';
const TIE_BREAK = Object.freeze({ DIRECT: 'direct_penalties', EXTRA_TIME: 'extra_time_penalties' });
const RANKING_POLICY = Object.freeze({
  GOAL_DIFFERENCE: 'goal_difference_first_v1', HEAD_TO_HEAD: 'head_to_head_first_v1',
});
const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  Object.values(value).forEach(item => { if (object(item)) freeze(item); });
  return Object.freeze(value);
}

const campus = {
  presetKey: DEFAULT_PRESET_KEY,
  sportFormat: FOOTBALL_FORMAT,
  ruleVersion: 'football11-v1',
  referenceRulesEdition: 'IFAB-2026-27',
  halfMinutes: 40, halfTimeMinutes: 10,
  onFieldMax: 11, minOnField: 7,
  eventRosterMin: 11, eventRosterMax: 22, matchRosterMax: 22,
  substitutions: {
    limit: 5, opportunities: 3, halfTimeCountsAsOpportunity: false, returnAllowed: false,
    extraTimeAdditionalPlayers: 0, extraTimeAdditionalOpportunities: 0,
  },
  knockoutTieBreak: TIE_BREAK.DIRECT, extraTime: null,
  shootoutInitialKicks: 5,
  leaguePoints: { win: 3, draw: 1, loss: 0 },
  rankingPolicy: RANKING_POLICY.GOAL_DIFFERENCE,
  statPolicy: 'football_basic_v1', scoringMode: 'post_match',
};
const RULE_PRESETS = freeze({
  [DEFAULT_PRESET_KEY]: { ...clone(campus), label: '校园常用（2 × 40 分钟）' },
  [STANDARD_PRESET_KEY]: {
    ...clone(campus), presetKey: STANDARD_PRESET_KEY, label: '标准时长（2 × 45 分钟）',
    halfMinutes: 45, halfTimeMinutes: 15,
    knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTime: { halfMinutes: 15 },
  },
});

/** 未知预设返回 null，不能把打错的足球预设悄悄当成默认规则。 */
function presetOf(key = DEFAULT_PRESET_KEY) {
  return own(RULE_PRESETS, key) ? clone(RULE_PRESETS[key]) : null;
}

// 接受表单的十进制整数字符串；拒绝空白、布尔值、null、科学记数法和小数。
function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
function knownKeys(value, keys) {
  return object(value) && Object.keys(value).every(key => keys.includes(key));
}

/** 缺省字段由选定预设补齐；显式非法值（含未知字段）返回 null。 */
function normalizeFootballRules(input) {
  if (!object(input) || (!input.presetKey && !input.sportFormat)) return null;
  if (own(input, 'presetKey') && (typeof input.presetKey !== 'string' || !input.presetKey)) return null;
  const base = presetOf(input.presetKey || DEFAULT_PRESET_KEY);
  if (!base || !knownKeys(input, Object.keys(base))) return null;
  const source = { ...base, ...input };
  if (source.sportFormat !== FOOTBALL_FORMAT || source.ruleVersion !== campus.ruleVersion
    || source.referenceRulesEdition !== campus.referenceRulesEdition
    || source.statPolicy !== campus.statPolicy || source.scoringMode !== 'post_match') return null;
  const rules = { ...source };
  delete rules.label;
  const ranges = {
    halfMinutes: [1, 45], halfTimeMinutes: [1, 15],
    onFieldMax: [11, 11], minOnField: [7, 7],
    // 每人 3 次资格点读；28 人连同身份/赛事读写仍落在事务安全预算内。
    eventRosterMin: [7, 28], eventRosterMax: [7, 28], matchRosterMax: [7, 26],
    shootoutInitialKicks: [5, 5],
  };
  for (const [key, range] of Object.entries(ranges)) {
    rules[key] = integer(source[key], ...range);
    if (rules[key] === null) return null;
  }
  if (rules.eventRosterMin > rules.eventRosterMax || rules.matchRosterMax > rules.eventRosterMax) return null;
  if (!Object.values(TIE_BREAK).includes(rules.knockoutTieBreak)
    || !Object.values(RANKING_POLICY).includes(rules.rankingPolicy)) return null;

  if (rules.knockoutTieBreak === TIE_BREAK.EXTRA_TIME) {
    const extra = own(input, 'extraTime') ? input.extraTime : (base.extraTime || { halfMinutes: 15 });
    if (!knownKeys(extra, ['halfMinutes'])) return null;
    const halfMinutes = integer(extra.halfMinutes, 1, 15);
    if (halfMinutes === null) return null;
    rules.extraTime = { halfMinutes };
  } else {
    if (own(input, 'extraTime') && input.extraTime !== null) return null;
    rules.extraTime = null;
  }

  if (own(input, 'substitutions') && !knownKeys(input.substitutions, Object.keys(campus.substitutions))) return null;
  const substitutions = { ...base.substitutions, ...(input.substitutions || {}) };
  for (const key of ['halfTimeCountsAsOpportunity', 'returnAllowed']) {
    if (typeof substitutions[key] !== 'boolean') return null;
  }
  if (substitutions.limit !== 'all_named') {
    substitutions.limit = integer(substitutions.limit, 0);
    if (substitutions.limit === null) return null;
  }
  if (substitutions.opportunities !== 'unlimited') {
    substitutions.opportunities = integer(substitutions.opportunities, 0);
    if (substitutions.opportunities === null) return null;
  }
  for (const key of ['extraTimeAdditionalPlayers', 'extraTimeAdditionalOpportunities']) {
    substitutions[key] = integer(substitutions[key], 0, 1);
    if (substitutions[key] === null) return null;
  }
  const extraPlayers = substitutions.extraTimeAdditionalPlayers;
  const extraOpportunities = substitutions.extraTimeAdditionalOpportunities;
  if (extraPlayers !== extraOpportunities) return null;
  if (rules.knockoutTieBreak === TIE_BREAK.DIRECT && extraPlayers !== 0) return null;
  if (extraPlayers && (substitutions.limit === 'all_named' || substitutions.opportunities === 'unlimited')) return null;
  // 可能以 7—10 人开赛，替补容量不能一律减去 11；具体阵容留给单场校验。
  if (!substitutions.returnAllowed && substitutions.limit !== 'all_named'
    && substitutions.limit + extraPlayers > rules.matchRosterMax - rules.minOnField) return null;
  if (substitutions.limit === 0 && (substitutions.opportunities !== 0 || extraPlayers)) return null;
  rules.substitutions = substitutions;

  if (own(input, 'leaguePoints') && !knownKeys(input.leaguePoints, ['win', 'draw', 'loss'])) return null;
  const points = { ...base.leaguePoints, ...(input.leaguePoints || {}) };
  for (const key of ['win', 'draw', 'loss']) {
    points[key] = integer(points[key], campus.leaguePoints[key], campus.leaguePoints[key]);
    if (points[key] === null) return null;
  }
  rules.leaguePoints = points;
  return rules;
}

function defaultRulesFor(sportFormat = FOOTBALL_FORMAT) {
  return sportFormat === FOOTBALL_FORMAT ? normalizeFootballRules({ presetKey: DEFAULT_PRESET_KEY }) : null;
}
const isValidFootballRules = input => normalizeFootballRules(input) !== null;

/** 发布摘要涵盖可选规则；不显示篮球犯规、分节或等级分字段。 */
function formatFootballRules(input, format = null) {
  const r = normalizeFootballRules(input);
  if (!r) return '';
  const s = r.substitutions;
  const parts = [
    `十一人制 · 上下半场各 ${r.halfMinutes} 分钟 · 中场休息 ${r.halfTimeMinutes} 分钟`,
    `赛事名单 ${r.eventRosterMin}–${r.eventRosterMax} 人 · 单场最多 ${r.matchRosterMax} 人`,
    s.limit === 'all_named' ? (s.returnAllowed ? '换人额度不限（仅列名球员）' : '全部列名替补可换入')
      : `换人额度 ${s.limit} ${s.returnAllowed ? '人次' : '人'}`,
    s.opportunities === 'unlimited' ? '换人机会不限' : `比赛中换人机会 ${s.opportunities} 次`,
    s.halfTimeCountsAsOpportunity ? '中场换人占机会' : '中场换人不占机会',
    s.returnAllowed ? '允许换下复入（校园规程）' : '换下不得复入',
    r.extraTime ? `淘汰赛平局先加时 2 × ${r.extraTime.halfMinutes} 分钟再点球` : '淘汰赛平局直接点球',
    s.extraTimeAdditionalPlayers ? '加时额外换 1 人并增加 1 个换人机会' : '加时无额外换人名额',
    '循环赛允许平局 · 胜 3 / 平 1 / 负 0',
    r.rankingPolicy === RANKING_POLICY.HEAD_TO_HEAD ? '同分相互战绩优先' : '同分净胜球优先',
    '点球各 5 次后同轮决胜 · 赛后录分',
  ];
  if (s.returnAllowed || s.limit === 'all_named' || s.limit > 5) parts.push('校园自定义换人规程');
  return parts.filter(part => format !== 'round_robin'
    || (!part.includes('淘汰赛') && !part.includes('加时') && !part.includes('点球各'))).join(' · ');
}

module.exports = {
  FOOTBALL_FORMAT, DEFAULT_PRESET_KEY, STANDARD_PRESET_KEY, TIE_BREAK, RANKING_POLICY,
  RULE_PRESETS, presetOf, defaultRulesFor, normalizeFootballRules, isValidFootballRules, formatFootballRules,
};
