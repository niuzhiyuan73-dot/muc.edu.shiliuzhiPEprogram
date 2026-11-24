/**
 * 协会插件基座（共享纯模块）
 * ============================================================
 * 收拢运动类型、工作台能力、规则预设构造、主题变量生成与插件契约校验。
 * 严禁裸写 `process.` / `Buffer` / `__dirname` / `fs`。
 */

const { DEFAULT_CONFIG } = require('../utils/elo.js');
const {
  SCORING,
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  DEFAULT_FORMAT,
  TENNIS_SET_GAMES_OPTIONS,
  TENNIS_BEST_OF_OPTIONS,
  TENNIS_TIEBREAK_POINTS,
  DEFAULT_TENNIS_FORMAT,
} = require('../utils/match-format.js');
const { RATED_PAIR_LIMIT, ASSOCIATION_STATUS } = require('../utils/constants.js');
const { defaultRulesFor } = require('../utils/basketball-rules.js');

const SPORT_TYPE = {
  RACKET: 'racket',
  TEAM: 'team',
};

const CAPABILITY = {
  SPACE: 'space',
  TEAMS: 'teams',
  MY_TEAMS: 'myTeams',
  RANK: 'rank',
  MATCH: 'match',
  EVENTS: 'events',
};

const CAPABILITY_TAB = {
  [CAPABILITY.SPACE]: { tab: CAPABILITY.SPACE, label: '协会空间' },
  [CAPABILITY.TEAMS]: { tab: CAPABILITY.TEAMS, label: '组队' },
  [CAPABILITY.MY_TEAMS]: { tab: CAPABILITY.MY_TEAMS, label: '我的球队' },
  [CAPABILITY.RANK]: { tab: CAPABILITY.RANK, label: '排行榜' },
  [CAPABILITY.MATCH]: { tab: CAPABILITY.MATCH, label: '比赛' },
  [CAPABILITY.EVENTS]: { tab: CAPABILITY.EVENTS, label: '赛事' },
};

const RACKET_CAPABILITIES = Object.freeze([
  CAPABILITY.SPACE, CAPABILITY.RANK, CAPABILITY.MATCH, CAPABILITY.EVENTS,
]);
const TEAM_CAPABILITIES = Object.freeze([
  CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.EVENTS,
]);

const VALID_CAPABILITIES = new Set(Object.values(CAPABILITY));
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function baseRules() {
  return {
    sportType: SPORT_TYPE.RACKET,
    capabilities: RACKET_CAPABILITIES.slice(),
    format: {
      scoring: SCORING.POINT,
      gamePointsOptions: GAME_POINTS_OPTIONS.slice(),
      bestOfOptions: BEST_OF_OPTIONS.slice(),
      defaultFormat: { ...DEFAULT_FORMAT },
    },
    elo: { ...DEFAULT_CONFIG },
    ratedPairLimit: RATED_PAIR_LIMIT,
  };
}

function teamRules(presetKey) {
  return {
    sportType: SPORT_TYPE.TEAM,
    teamSportFormat: 'basketball5',
    capabilities: TEAM_CAPABILITIES.slice(),
    basketballRules: defaultRulesFor(presetKey),
  };
}

function tennisRules() {
  const base = baseRules();
  return {
    ...base,
    format: {
      scoring: SCORING.TENNIS,
      setGamesOptions: TENNIS_SET_GAMES_OPTIONS.slice(),
      bestOfOptions: TENNIS_BEST_OF_OPTIONS.slice(),
      tiebreakPoints: TENNIS_TIEBREAK_POINTS,
      defaultFormat: { ...DEFAULT_TENNIS_FORMAT },
    },
  };
}

/**
 * 校验协会插件声明结构是否完整合法。
 *
 * @param {Object} plugin
 * @returns {{ok:boolean, message:string}}
 */
function validateAssociationPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    return { ok: false, message: '协会插件必须为对象' };
  }
  for (const field of ['id', 'name', 'shortName', 'sportName', 'logoGlyph', 'logoIcon', 'sportKey']) {
    if (typeof plugin[field] !== 'string' || !plugin[field].trim()) {
      return { ok: false, message: `协会插件缺少有效字段：${field}` };
    }
  }
  if (plugin.sportType !== SPORT_TYPE.RACKET && plugin.sportType !== SPORT_TYPE.TEAM) {
    return { ok: false, message: `协会插件 ${plugin.id} 的 sportType 非法` };
  }
  if (!Array.isArray(plugin.capabilities) || plugin.capabilities.length === 0
    || plugin.capabilities.some(cap => !VALID_CAPABILITIES.has(cap))) {
    return { ok: false, message: `协会插件 ${plugin.id} 的 capabilities 非法` };
  }
  if (plugin.status !== ASSOCIATION_STATUS.ACTIVE && plugin.status !== ASSOCIATION_STATUS.DISABLED) {
    return { ok: false, message: `协会插件 ${plugin.id} 的 status 非法` };
  }
  const theme = plugin.theme;
  if (!theme || typeof theme !== 'object') {
    return { ok: false, message: `协会插件 ${plugin.id} 缺少 theme` };
  }
  for (const colorKey of ['primary', 'primaryDark', 'primaryLight', 'accent']) {
    if (typeof theme[colorKey] !== 'string' || !HEX_COLOR_RE.test(theme[colorKey])) {
      return { ok: false, message: `协会插件 ${plugin.id} 的 theme.${colorKey} 必须为 #RRGGBB` };
    }
  }
  // 【规则快照契约】声明了运动类型就必须带齐该类型的规则，否则动态注册的插件
  // 会在抽签 / 计分时静默回落到别的运动默认（球拍 11 分制套到团队赛），
  // 这类"能注册但不能用"的插件比拒绝注册更危险。
  if (plugin.sportType === SPORT_TYPE.RACKET) {
    const format = plugin.format;
    if (!format || typeof format !== 'object' || !format.defaultFormat
      || typeof format.defaultFormat !== 'object') {
      return { ok: false, message: `协会插件 ${plugin.id} 缺少 format.defaultFormat（球拍运动必填）` };
    }
    if (!plugin.elo || typeof plugin.elo !== 'object') {
      return { ok: false, message: `协会插件 ${plugin.id} 缺少 elo 锚点（球拍运动必填）` };
    }
    if (!Number.isFinite(plugin.ratedPairLimit) || plugin.ratedPairLimit <= 0) {
      return { ok: false, message: `协会插件 ${plugin.id} 的 ratedPairLimit 非法` };
    }
  } else {
    if (typeof plugin.teamSportFormat !== 'string' || !plugin.teamSportFormat.trim()) {
      return { ok: false, message: `协会插件 ${plugin.id} 缺少 teamSportFormat（团队运动必填）` };
    }
    const hasRuleSnapshot = Object.keys(plugin).some(key => key.endsWith('Rules')
      && plugin[key] && typeof plugin[key] === 'object' && !Array.isArray(plugin[key]));
    if (!hasRuleSnapshot) {
      return { ok: false, message: `协会插件 ${plugin.id} 缺少规则快照（xxxRules，团队运动必填）` };
    }
  }
  return { ok: true, message: '' };
}

/**
 * 由 theme 对象生成页面容器内联 CSS 变量串，供新协会免手改 app.wxss 使用。
 *
 * @param {Object} theme
 * @returns {string}
 */
function buildThemeVars(theme) {
  if (!theme || typeof theme !== 'object') return '';
  const primary = String(theme.primary || '').trim();
  const primaryDark = String(theme.primaryDark || '').trim();
  const primaryLight = String(theme.primaryLight || '').trim();
  const accent = String(theme.accent || '').trim();
  if (!primary || !primaryDark || !primaryLight || !accent) return '';
  return [
    `--color-primary:${primary}`,
    `--color-primary-dark:${primaryDark}`,
    `--color-primary-light:${primaryLight}`,
    `--color-accent:${accent}`,
    `--brand-color:${primary}`,
    `--brand-dark:${primaryDark}`,
    `--brand-soft:${primaryLight}`,
  ].join(';') + ';';
}

module.exports = {
  SPORT_TYPE,
  CAPABILITY,
  CAPABILITY_TAB,
  RACKET_CAPABILITIES,
  TEAM_CAPABILITIES,
  baseRules,
  teamRules,
  tennisRules,
  validateAssociationPlugin,
  buildThemeVars,
};
