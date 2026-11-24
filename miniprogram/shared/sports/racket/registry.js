/**
 * 球拍计分体系 ScoringAdapter 注册表（共享纯模块）
 */

const { pointScoringAdapter } = require('./point.js');
const { tennisScoringAdapter } = require('./tennis.js');

const BUILTIN_SCORING_ADAPTERS = Object.freeze({
  point: pointScoringAdapter,
  tennis: tennisScoringAdapter,
});

const dynamicAdapters = new Map();

function validateScoringAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { ok: false, message: 'ScoringAdapter 必须为对象' };
  }
  if (typeof adapter.scoring !== 'string' || !adapter.scoring.trim()) {
    return { ok: false, message: 'ScoringAdapter 缺少有效的 scoring 标识' };
  }
  if (typeof adapter.scoreUnit !== 'string' || !adapter.scoreUnit.trim()) {
    return { ok: false, message: 'ScoringAdapter 缺少有效的 scoreUnit' };
  }
  if (typeof adapter.isThreeLayer !== 'boolean' || typeof adapter.usePointTextClass !== 'boolean') {
    return { ok: false, message: 'ScoringAdapter 的 isThreeLayer / usePointTextClass 必须为布尔值' };
  }
  for (const fnName of ['buildFormatOptions', 'scheduledFormatPatch', 'describeLive']) {
    if (typeof adapter[fnName] !== 'function') {
      return { ok: false, message: `ScoringAdapter.${fnName} 必须为函数` };
    }
  }
  return { ok: true, message: '' };
}

function getScoringAdapter(scoring) {
  const key = typeof scoring === 'string' ? scoring.trim() : '';
  if (key && dynamicAdapters.has(key)) return dynamicAdapters.get(key);
  if (key && Object.prototype.hasOwnProperty.call(BUILTIN_SCORING_ADAPTERS, key)) {
    return BUILTIN_SCORING_ADAPTERS[key];
  }
  return BUILTIN_SCORING_ADAPTERS.point;
}

function listScoringAdapters() {
  return [...Object.values(BUILTIN_SCORING_ADAPTERS), ...dynamicAdapters.values()];
}

function registerScoringAdapter(adapter) {
  const check = validateScoringAdapter(adapter);
  if (!check.ok) throw new Error(check.message);
  if (Object.prototype.hasOwnProperty.call(BUILTIN_SCORING_ADAPTERS, adapter.scoring)) {
    throw new Error(`内置计分适配器 ${adapter.scoring} 不可覆盖`);
  }
  if (dynamicAdapters.has(adapter.scoring)) {
    throw new Error(`计分适配器 ${adapter.scoring} 已注册`);
  }
  dynamicAdapters.set(adapter.scoring, adapter);
  return adapter;
}

function unregisterScoringAdapter(scoring) {
  return dynamicAdapters.delete(scoring);
}

module.exports = {
  validateScoringAdapter,
  getScoringAdapter,
  listScoringAdapters,
  registerScoringAdapter,
  unregisterScoringAdapter,
};
