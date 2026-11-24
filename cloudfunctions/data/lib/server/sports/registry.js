/**
 * 服务端运动扩展插件注册表（仅云端/服务端，绝不进入小程序包）
 */

const { getSportAdapterFor } = require('../../shared/sports/registry.js');
const basketballPlugin = require('./basketball-plugin.js');
const footballPlugin = require('./football-plugin.js');

const PLUGINS = new Map([
  [basketballPlugin.sportFormat, basketballPlugin],
  [footballPlugin.sportFormat, footballPlugin],
]);
const BUILTIN_FORMATS = new Set(PLUGINS.keys());

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
  if (!plugin.actions || typeof plugin.actions !== 'object' || Array.isArray(plugin.actions)) {
    throw new Error('服务端运动插件缺少 actions 映射');
  }
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
};
