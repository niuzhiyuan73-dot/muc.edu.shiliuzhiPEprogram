/**
 * 团队运动 SportAdapter 注册表（共享纯模块）
 */

const { getAssociation, SPORT_TYPE } = require('../utils/associations.js');
const { validateSportAdapter } = require('./contract.js');
const { basketballAdapter } = require('./basketball/adapter.js');
const { footballAdapter } = require('./football/adapter.js');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const ADAPTERS = new Map([
  [basketballAdapter.meta.sportFormat, basketballAdapter],
  [footballAdapter.meta.sportFormat, footballAdapter],
]);
const BUILTIN_FORMATS = new Set(ADAPTERS.keys());

function getSportAdapter(sportFormat) {
  if (typeof sportFormat !== 'string' || !sportFormat) return null;
  return ADAPTERS.get(sportFormat) || null;
}

function getSportAdapterFor(associationId, event = null) {
  let association;
  try { association = getAssociation(associationId); } catch (_error) { return null; }
  if (association.sportType !== SPORT_TYPE.TEAM) return null;
  const format = own(association, 'teamSportFormat') ? association.teamSportFormat
    : (association.basketballRules && association.basketballRules.sportFormat);
  const adapter = getSportAdapter(format);
  if (!adapter) return null;
  if (event) {
    if (event.association && event.association !== associationId) return null;
    if (event.sportFormat !== undefined && event.sportFormat !== format) return null;
    if (event.rules && event.rules.sportFormat !== undefined && event.rules.sportFormat !== format) return null;
    if (event.rules && own(event.rules, 'presetKey')
      && !adapter.rules.normalizeRules({ presetKey: event.rules.presetKey })) return null;
  }
  return adapter;
}

function listSportAdapters() {
  return [...ADAPTERS.values()];
}

function registerSportAdapter(adapter) {
  const check = validateSportAdapter(adapter);
  if (!check.ok) throw new Error(check.message);
  const format = adapter.meta.sportFormat;
  if (ADAPTERS.has(format)) {
    throw new Error(`SportAdapter 已存在：${format}`);
  }
  ADAPTERS.set(format, adapter);
  return adapter;
}

function unregisterSportAdapter(sportFormat) {
  if (BUILTIN_FORMATS.has(sportFormat)) {
    throw new Error(`内置 SportAdapter 不可注销：${sportFormat}`);
  }
  return ADAPTERS.delete(sportFormat);
}

/**
 * 转换为兼容旧 `teamSportStrategy` 的扁平对象（附带完整 `adapter` 引用）。
 */
function toLegacyStrategy(adapter) {
  if (!adapter) return null;
  return Object.freeze({
    sportFormat: adapter.meta.sportFormat,
    defaultPresetKey: adapter.rules.defaultPresetKey,
    normalizeRules: adapter.rules.normalizeRules,
    formatRules: adapter.rules.formatRules,
    defaultRules: adapter.rules.defaultRules,
    computeTable: adapter.standings.computeTable,
    supportsLiveScore: adapter.meta.supportsLiveScore,
    supportsMatchData: adapter.meta.supportsMatchData,
    adapter,
  });
}

module.exports = {
  getSportAdapter,
  getSportAdapterFor,
  listSportAdapters,
  registerSportAdapter,
  unregisterSportAdapter,
  toLegacyStrategy,
};
