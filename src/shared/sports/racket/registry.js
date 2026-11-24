/**
 * 球拍计分体系 ScoringAdapter 注册表（共享纯模块）
 * ============================================================
 * 目前只有 point / tennis 两套已立项计分制，因此注册表保持**静态**：
 * 没有 `registerScoringAdapter`。第三种计分制不只是加一个显示适配器，
 * 还要同时改 match-format 校验、match-record 录入、live-score 存储/回放；
 * 在那些内核完成前开放动态注册，会造出“能注册但算不对”的半插件。
 */

const { pointScoringAdapter } = require('./point.js');
const { tennisScoringAdapter } = require('./tennis.js');

const BUILTIN_SCORING_ADAPTERS = Object.freeze({
  point: pointScoringAdapter,
  tennis: tennisScoringAdapter,
});

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
  if (key && Object.prototype.hasOwnProperty.call(BUILTIN_SCORING_ADAPTERS, key)) {
    return BUILTIN_SCORING_ADAPTERS[key];
  }
  return BUILTIN_SCORING_ADAPTERS.point;
}

function listScoringAdapters() {
  return [...Object.values(BUILTIN_SCORING_ADAPTERS)];
}

module.exports = {
  validateScoringAdapter,
  getScoringAdapter,
  listScoringAdapters,
};
