/**
 * 团队运动 SportAdapter 契约与统一字段读取辅助（共享纯模块）
 * ============================================================
 * 单场运动扩展字段统一为：`sportDraft`、`sportPublished`、`sportLineups`。
 */

function draftOf(match) {
  return (match && match.sportDraft) || null;
}

function publishedOf(match) {
  return (match && match.sportPublished) || null;
}

function lineupsOf(match) {
  return (match && match.sportLineups) || null;
}

function isFn(value) {
  return typeof value === 'function';
}

function isBool(value) {
  return typeof value === 'boolean';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验 SportAdapter 是否满足六组标准契约。
 *
 * @param {Object} adapter
 * @returns {{ok:boolean, message:string}}
 */
function validateSportAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { ok: false, message: 'SportAdapter 必须为对象' };
  }
  const { meta, rules, permissions, matchLifecycle, standings, view } = adapter;
  if (!meta || !rules || !permissions || !matchLifecycle || !standings || !view) {
    return { ok: false, message: 'SportAdapter 缺少必需的六组契约之一' };
  }

  if (!isNonEmptyString(meta.sportFormat) || !isNonEmptyString(meta.sportKey)) {
    return { ok: false, message: 'meta 缺少有效的 sportFormat 或 sportKey' };
  }
  for (const flag of [
    'supportsLiveScore', 'supportsMatchData', 'supportsRedraw', 'allowsDraw',
    'defaultMatchTimeFromEvent', 'requiresStrictRulesOnEntry',
    'requiresWinnerOnElimSettle', 'sharedEliminationRank', 'supportsRankingDecisions',
    'strictEntryRosterCheck',
  ]) {
    if (!isBool(meta[flag])) {
      return { ok: false, message: `meta.${flag} 必须为布尔值` };
    }
  }
  if (meta.schedulePeopleSource !== 'membership' && meta.schedulePeopleSource !== 'school') {
    return { ok: false, message: 'meta.schedulePeopleSource 必须为 membership 或 school' };
  }
  if (!isFn(meta.defaultDurationMinutes)) {
    return { ok: false, message: 'meta.defaultDurationMinutes 必须为函数' };
  }

  if (!isNonEmptyString(rules.defaultPresetKey)) {
    return { ok: false, message: 'rules.defaultPresetKey 必须为非空字符串' };
  }
  for (const fnName of ['defaultRules', 'normalizeRules', 'formatRules']) {
    if (!isFn(rules[fnName])) {
      return { ok: false, message: `rules.${fnName} 必须为函数` };
    }
  }

  for (const fnName of ['canRecord', 'canSeePending', 'canSetLineup', 'canEditSchedule']) {
    if (!isFn(permissions[fnName])) {
      return { ok: false, message: `permissions.${fnName} 必须为函数` };
    }
  }

  for (const fnName of [
    'initMatchExtra', 'hasActivityOrDraft', 'validateBeforeSettle',
    'validateRankingDecisions', 'validateEntryPayload', 'decorateMatchView',
  ]) {
    if (!isFn(matchLifecycle[fnName])) {
      return { ok: false, message: `matchLifecycle.${fnName} 必须为函数` };
    }
  }

  for (const fnName of ['computeTable', 'adjustEliminationPlacements']) {
    if (!isFn(standings[fnName])) {
      return { ok: false, message: `standings.${fnName} 必须为函数` };
    }
  }

  if (!isNonEmptyString(view.eventFormMode) || typeof view.recordHintText !== 'string') {
    return { ok: false, message: 'view 缺少 eventFormMode 或 recordHintText' };
  }
  if (!isFn(view.recordPageUrl) || !isFn(view.liveScorePageUrl) || !Array.isArray(view.statColumns)) {
    return { ok: false, message: 'view 缺少 recordPageUrl / liveScorePageUrl / statColumns' };
  }

  return { ok: true, message: '' };
}

/**
 * 辅助工厂：为可选钩子提供显式默认空实现并执行契约校验，避免新运动插件重复写空壳。
 *
 * @param {Object} spec
 * @returns {Object} 冻结的 SportAdapter
 */
function createSportAdapter(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('SportAdapter 配置必须为对象');
  }
  const meta = Object.freeze({
    redrawRefuseMessage: '',
    requiresStrictRulesOnEntry: false,
    requiresWinnerOnElimSettle: false,
    sharedEliminationRank: false,
    supportsRankingDecisions: false,
    strictEntryRosterCheck: false,
    schedulePeopleSource: 'membership',
    defaultDurationMinutes: () => 90,
    ...(spec.meta || {}),
  });
  const rules = Object.freeze({ ...(spec.rules || {}) });
  const permissions = Object.freeze({
    canRecord: ({ manage, captain, isRecorder, supportsMatchData = true } = {}) =>
      Boolean(supportsMatchData && (manage || captain || isRecorder)),
    canSeePending: ({ manage, captain, isRecorder } = {}) =>
      Boolean(manage || captain || isRecorder),
    canSetLineup: ({ active, manage, captain } = {}) =>
      Boolean(active && (manage || captain)),
    canEditSchedule: ({ manage, eventActive, match } = {}) =>
      Boolean(manage && eventActive && match && match.status !== 'canceled'),
    ...(spec.permissions || {}),
  });
  const matchLifecycle = Object.freeze({
    initMatchExtra: event => ({ matchTime: (event && event.startTime) || null }),
    hasActivityOrDraft: match => Boolean(match && (
      match.status === 'live'
      || match.liveScore
      || draftOf(match)
      || publishedOf(match)
      || lineupsOf(match)
      || (match.scoreA !== null && match.scoreA !== undefined)
    )),
    validateBeforeSettle: () => ({ ok: true, message: '' }),
    validateRankingDecisions: (_payload, event) => ({
      ok: true,
      decisions: (event && event.rankingDecisions) || [],
    }),
    validateEntryPayload: () => ({ ok: true, message: '' }),
    decorateMatchView: () => ({}),
    ...(spec.matchLifecycle || {}),
  });
  const standings = Object.freeze({
    adjustEliminationPlacements: placements => placements,
    ...(spec.standings || {}),
  });
  const view = Object.freeze({
    recordHintText: '',
    recordPageUrl: () => '',
    liveScorePageUrl: () => '',
    statColumns: Object.freeze([]),
    ...(spec.view || {}),
  });
  const adapter = Object.freeze({ meta, rules, permissions, matchLifecycle, standings, view });
  const check = validateSportAdapter(adapter);
  if (!check.ok) throw new Error(check.message);
  return adapter;
}

module.exports = {
  draftOf,
  publishedOf,
  lineupsOf,
  validateSportAdapter,
  createSportAdapter,
};
