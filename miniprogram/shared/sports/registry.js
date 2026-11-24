/**
 * 团队运动 SportAdapter 注册表（共享纯模块）
 */

const { getAssociation, SPORT_TYPE } = require('../utils/associations.js');
const {
  registerAssociationPlugin,
  unregisterAssociationPlugin,
} = require('../associations/registry.js');
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
  // sportKey 不一致时按"无适配器"处理（拒绝而非错配）。联合注册入口
  // registerAssociationWithAdapter 已在写入时校验双方 sportKey，正常路径
  // 不会到这里；若有人绕过它用旧的两步 API 注册且 key 不一致，适配器会
  // 静默失效——这是刻意的保守降级，宁可拒绝也不要串用别的运动规则。
  if (!adapter || adapter.meta.sportKey !== association.sportKey) return null;
  if (event) {
    if (event.association && event.association !== associationId) return null;
    if (event.sportFormat !== undefined && event.sportFormat !== format) return null;
    if (event.rules && event.rules.sportFormat !== undefined && event.rules.sportFormat !== format) return null;
    if (event.rules && own(event.rules, 'presetKey')) {
      try {
        if (!adapter.rules.normalizeRules({ presetKey: event.rules.presetKey })) return null;
      } catch (_error) {
        // 规则归一化抛错说明这条赛事的规则不可用；读路径应安全退回“无适配器”，
        // 而不是把整个详情/列表打成 500。
        return null;
      }
    }
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
 * 一次注册协会插件与其 SportAdapter；任一步失败都回滚，避免留下
 * 「协会已启用、适配器不存在」的半套状态。团队协会的 sportFormat 必须与
 * 协会声明的 teamSportFormat 一致，双方的 sportKey 也必须一致。
 *
 * @param {Object} plugin 协会插件
 * @param {Object} adapter SportAdapter
 * @returns {Object} 已注册的协会插件
 */
function registerAssociationWithAdapter(plugin, adapter) {
  if (plugin && plugin.sportType === SPORT_TYPE.TEAM
    && (!adapter || !adapter.meta || adapter.meta.sportFormat !== plugin.teamSportFormat)) {
    throw new Error(`协会 ${plugin.id} 的 SportAdapter 与 teamSportFormat 不一致`);
  }
  if (plugin?.sportType === SPORT_TYPE.TEAM && adapter.meta.sportKey !== plugin.sportKey) {
    throw new Error(`协会 ${plugin.id} 的 SportAdapter 与 sportKey 不一致`);
  }
  const assoc = registerAssociationPlugin(plugin);
  try {
    registerSportAdapter(adapter);
  } catch (err) {
    unregisterAssociationPlugin(plugin.id);
    throw err;
  }
  return assoc;
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
  registerAssociationWithAdapter,
  toLegacyStrategy,
};
