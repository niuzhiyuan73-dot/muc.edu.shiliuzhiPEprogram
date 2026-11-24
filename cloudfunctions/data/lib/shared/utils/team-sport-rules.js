/** 团队运动分派。运动身份来自协会注册表，不能由请求的 presetKey 决定。
 * 足球只支持赛后报告，禁止进入篮球实时计分。
 */
const basketball = require('./basketball-rules.js');
const football = require('./football-rules.js');
const { computeTeamTable } = require('./team-standings.js');
const { computeFootballTable } = require('./football-standings.js');
const { getAssociation, SPORT_TYPE } = require('./associations.js');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function normalizeBasketball(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.sportFormat && input.sportFormat !== basketball.BASKETBALL_FORMAT.FIVE) return null;
  if (own(input, 'presetKey') && !own(basketball.RULE_PRESETS, input.presetKey)) return null;
  // 旧篮球规范化会忽略未知字段，分派入口必须挡住足球配置及拼错的字段。
  const keys = new Set([
    ...Object.keys(basketball.presetOf()), 'presetKey', 'enabled',
  ]);
  if (Object.keys(input).some(key => !keys.has(key))) return null;
  return basketball.normalizeBasketballRules(input);
}

const STRATEGIES = Object.freeze({
  [basketball.BASKETBALL_FORMAT.FIVE]: Object.freeze({
    sportFormat: basketball.BASKETBALL_FORMAT.FIVE,
    defaultPresetKey: basketball.DEFAULT_PRESET_KEY,
    normalizeRules: normalizeBasketball,
    formatRules: basketball.formatBasketballRules,
    defaultRules: () => normalizeBasketball({ presetKey: basketball.DEFAULT_PRESET_KEY }),
    computeTable: computeTeamTable,
    supportsLiveScore: true,
    supportsMatchData: true,
  }),
  [football.FOOTBALL_FORMAT]: Object.freeze({
    sportFormat: football.FOOTBALL_FORMAT,
    defaultPresetKey: football.DEFAULT_PRESET_KEY,
    normalizeRules: football.normalizeFootballRules,
    formatRules: football.formatFootballRules,
    defaultRules: football.defaultRulesFor,
    computeTable: computeFootballTable,
    supportsLiveScore: false,
    supportsMatchData: true,
  }),
});

function teamSportStrategy(sportFormat) {
  return own(STRATEGIES, sportFormat) ? STRATEGIES[sportFormat] : null;
}

/**
 * 旧篮球赛事可缺运动字段，但必须由已登记的篮球协会元数据兜底。
 * 已有显式制式与协会不符时拒绝，不能在篮球协会载入一个足球/三人制快照。
 */
function teamSportStrategyFor(associationId, event = null) {
  let association;
  try { association = getAssociation(associationId); } catch (_error) { return null; }
  if (association.sportType !== SPORT_TYPE.TEAM) return null;
  const format = own(association, 'teamSportFormat') ? association.teamSportFormat
    : (association.basketballRules && association.basketballRules.sportFormat);
  const strategy = teamSportStrategy(format);
  if (!strategy) return null;
  if (event) {
    if (event.association && event.association !== associationId) return null;
    if (event.sportFormat !== undefined && event.sportFormat !== format) return null;
    if (event.rules && event.rules.sportFormat !== undefined && event.rules.sportFormat !== format) return null;
    if (event.rules && own(event.rules, 'presetKey')
      && !strategy.normalizeRules({ presetKey: event.rules.presetKey })) return null;
  }
  return strategy;
}

module.exports = { teamSportStrategy, teamSportStrategyFor };
