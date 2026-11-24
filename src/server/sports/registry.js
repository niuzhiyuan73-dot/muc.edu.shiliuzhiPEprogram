/**
 * 服务端运动扩展插件注册表（仅云端/服务端，绝不进入小程序包）
 */

const { getSportAdapterFor } = require('../../shared/sports/registry.js');
const { TEAM_PLUGIN_ACTION_ALLOWLIST } = require('./action-allowlist.js');
const basketballPlugin = require('./basketball-plugin.js');
const footballPlugin = require('./football-plugin.js');

const PLUGINS = new Map([
  [basketballPlugin.sportFormat, basketballPlugin],
  [footballPlugin.sportFormat, footballPlugin],
]);
const BUILTIN_FORMATS = new Set(PLUGINS.keys());
const ALLOWED_ACTIONS = new Set(TEAM_PLUGIN_ACTION_ALLOWLIST);

/** 动作映射必须只在白名单内且为函数；动态注册与内置插件共用这一道校验。 */
function assertAllowedActions(plugin) {
  if (!plugin.actions || typeof plugin.actions !== 'object' || Array.isArray(plugin.actions)) {
    throw new Error('服务端运动插件缺少 actions 映射');
  }
  for (const [name, fn] of Object.entries(plugin.actions)) {
    if (!ALLOWED_ACTIONS.has(name)) {
      throw new Error(`服务端运动插件动作不在白名单：${name}`);
    }
    if (typeof fn !== 'function') {
      throw new Error(`服务端运动插件动作必须是函数：${name}`);
    }
  }
}

// 内置插件直接构造、不走 registerServerSportPlugin，模块加载时补上同一道校验，
// 免得日后误改内置动作表而绕过白名单。
for (const plugin of PLUGINS.values()) assertAllowedActions(plugin);

function getServerSportPlugin(sportFormat) {
  if (typeof sportFormat !== 'string' || !sportFormat) return null;
  return PLUGINS.get(sportFormat) || null;
}

function getServerSportPluginFor(associationId, event = null) {
  const adapter = getSportAdapterFor(associationId, event);
  if (!adapter) return null;
  return getServerSportPlugin(adapter.meta.sportFormat);
}

function listServerSportPlugins() {
  return [...PLUGINS.values()];
}

function registerServerSportPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object' || typeof plugin.sportFormat !== 'string' || !plugin.sportFormat.trim()) {
    throw new Error('服务端运动插件缺少有效的 sportFormat');
  }
  assertAllowedActions(plugin);
  if (PLUGINS.has(plugin.sportFormat)) {
    throw new Error(`服务端运动插件已存在：${plugin.sportFormat}`);
  }
  const frozen = Object.freeze({
    sportFormat: plugin.sportFormat,
    actions: Object.freeze({ ...plugin.actions }),
  });
  PLUGINS.set(plugin.sportFormat, frozen);
  return frozen;
}

function unregisterServerSportPlugin(sportFormat) {
  if (BUILTIN_FORMATS.has(sportFormat)) {
    throw new Error(`内置服务端运动插件不可注销：${sportFormat}`);
  }
  return PLUGINS.delete(sportFormat);
}

module.exports = {
  getServerSportPlugin,
  getServerSportPluginFor,
  listServerSportPlugins,
  registerServerSportPlugin,
  unregisterServerSportPlugin,
  TEAM_PLUGIN_ACTION_ALLOWLIST,
};
