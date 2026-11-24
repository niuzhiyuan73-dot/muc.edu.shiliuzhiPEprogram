/**
 * 团队运动 SportAdapter 契约与统一字段读取辅助（共享纯模块）
 * ============================================================
 * 兼容过渡期同时支持读取 `sportDraft`/`footballDraft`、
 * `sportPublished`/`footballPublished`、`sportLineups`/`footballLineups`。
 */

function draftOf(match) {
  return (match && (match.sportDraft || match.footballDraft)) || null;
}

function publishedOf(match) {
  return (match && (match.sportPublished || match.footballPublished)) || null;
}

function lineupsOf(match) {
  return (match && (match.sportLineups || match.footballLineups)) || null;
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
  ]) {
    if (!isBool(meta[flag])) {
      return { ok: false, message: `meta.${flag} 必须为布尔值` };
    }
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

module.exports = {
  draftOf,
  publishedOf,
  lineupsOf,
  validateSportAdapter,
};
