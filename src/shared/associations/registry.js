/**
 * 协会注册表（多协会插件的唯一真相源）
 * ============================================================
 * 各内置协会声明拆分为同目录下独立插件文件（pkb / tt / bd / tn / bk / fb），
 * 本模块提供统一查询、主题变量生成与运行时动态插件注册（供契约/扩展测试）。
 */

const { DEFAULT_FORMAT } = require('../utils/match-format.js');
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const {
  SPORT_TYPE,
  CAPABILITY,
  CAPABILITY_TAB,
  RACKET_CAPABILITIES,
  validateAssociationPlugin,
  buildThemeVars,
} = require('./base.js');

const BUILTIN_ASSOCIATIONS = [
  require('./pkb.js'),
  require('./tt.js'),
  require('./bd.js'),
  require('./tn.js'),
  require('./bk.js'),
  require('./fb.js'),
];

const BUILTIN_IDS = new Set(BUILTIN_ASSOCIATIONS.map(a => a.id));
const ASSOCIATIONS = BUILTIN_ASSOCIATIONS.slice();

/** 全部协会（含已停用），返回浅拷贝。 */
function allAssociations() {
  return ASSOCIATIONS.slice();
}

/** 仅启用中的协会。选择页与默认值只认这些。 */
function activeAssociations() {
  return ASSOCIATIONS.filter(a => a.status === ASSOCIATION_STATUS.ACTIVE);
}

/** 按 id 取一个协会；未知 id 抛错。 */
function getAssociation(id) {
  const found = ASSOCIATIONS.find(a => a.id === id);
  if (!found) throw new Error(`未知的协会 id：${id}`);
  return found;
}

/** id 是否登记在册（含已停用）。 */
function isKnownAssociation(id) {
  return ASSOCIATIONS.some(a => a.id === id);
}

/** 兜底默认协会：首个启用中的协会。 */
function defaultAssociationId() {
  const first = activeAssociations()[0];
  return first ? first.id : '';
}

const LEGACY_ASSOCIATION_ID = 'pkb';

function belongsToAssociation(doc, association) {
  if (!doc) return false;
  const owner = doc.association || LEGACY_ASSOCIATION_ID;
  return owner === association;
}

function defaultFormatOf(id) {
  try {
    return { ...getAssociation(id).format.defaultFormat };
  } catch (err) {
    return { ...DEFAULT_FORMAT };
  }
}

function sportTypeOf(id) {
  try {
    return getAssociation(id).sportType === SPORT_TYPE.TEAM ? SPORT_TYPE.TEAM : SPORT_TYPE.RACKET;
  } catch (err) {
    return SPORT_TYPE.RACKET;
  }
}

function isTeamSport(id) {
  return sportTypeOf(id) === SPORT_TYPE.TEAM;
}

/**
 * 某协会的运动标识（如 'pickleball' / 'basketball' / 'football'）。
 * 未知协会返回空串，避免把未知协会静默当成某项运动。
 *
 * @param {string} id
 * @returns {string}
 */
function sportKeyOf(id) {
  try {
    return String(getAssociation(id).sportKey || '');
  } catch (err) {
    return '';
  }
}

function capabilitiesOf(id) {
  try {
    const caps = getAssociation(id).capabilities;
    return Array.isArray(caps) && caps.length ? caps.slice() : RACKET_CAPABILITIES.slice();
  } catch (err) {
    return RACKET_CAPABILITIES.slice();
  }
}

function workbenchTabsOf(id) {
  const caps = capabilitiesOf(id);
  return [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.RANK, CAPABILITY.MATCH, CAPABILITY.EVENTS]
    .filter(tab => caps.includes(tab))
    .map(tab => ({ ...CAPABILITY_TAB[tab] }));
}

function basketballRulesOf(id) {
  try {
    const assoc = getAssociation(id);
    if (assoc.sportType !== SPORT_TYPE.TEAM || !assoc.basketballRules
      || (assoc.teamSportFormat && assoc.teamSportFormat !== 'basketball5')) return null;
    return { ...assoc.basketballRules };
  } catch (err) {
    return null;
  }
}

function themeVarsOf(id) {
  try {
    return buildThemeVars(getAssociation(id).theme);
  } catch (err) {
    return '';
  }
}

/**
 * 动态注册协会插件（供开放扩展与契约测试使用；内置协会 id 不可覆盖）。
 *
 * @param {Object} plugin
 * @returns {Object}
 */
function registerAssociationPlugin(plugin) {
  const check = validateAssociationPlugin(plugin);
  if (!check.ok) throw new Error(check.message);
  if (isKnownAssociation(plugin.id)) {
    throw new Error(`协会插件 id 已存在：${plugin.id}`);
  }
  const cloned = {
    ...plugin,
    theme: { ...plugin.theme },
    capabilities: plugin.capabilities.slice(),
  };
  ASSOCIATIONS.push(cloned);
  return cloned;
}

/**
 * 注销动态注册的协会插件（内置协会不可注销）。
 *
 * @param {string} id
 * @returns {boolean}
 */
function unregisterAssociationPlugin(id) {
  if (BUILTIN_IDS.has(id)) throw new Error(`内置协会不可注销：${id}`);
  const idx = ASSOCIATIONS.findIndex(a => a.id === id);
  if (idx < 0) return false;
  ASSOCIATIONS.splice(idx, 1);
  return true;
}

module.exports = {
  allAssociations,
  activeAssociations,
  getAssociation,
  isKnownAssociation,
  defaultAssociationId,
  defaultFormatOf,
  sportTypeOf,
  isTeamSport,
  sportKeyOf,
  capabilitiesOf,
  workbenchTabsOf,
  basketballRulesOf,
  themeVarsOf,
  buildThemeVars,
  validateAssociationPlugin,
  registerAssociationPlugin,
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
  CAPABILITY_TAB,
  LEGACY_ASSOCIATION_ID,
  belongsToAssociation,
};
