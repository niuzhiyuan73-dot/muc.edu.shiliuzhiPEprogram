/**
 * 篮球 SportAdapter 插件（共享纯模块）
 */

const basketball = require('../../utils/basketball-rules.js');
const { computeTeamTable } = require('../../utils/team-standings.js');
const { draftOf, publishedOf, lineupsOf } = require('../contract.js');

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function normalizeBasketball(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.sportFormat && input.sportFormat !== basketball.BASKETBALL_FORMAT.FIVE) return null;
  if (own(input, 'presetKey') && !own(basketball.RULE_PRESETS, input.presetKey)) return null;
  const keys = new Set([
    ...Object.keys(basketball.presetOf()), 'presetKey', 'enabled',
  ]);
  if (Object.keys(input).some(key => !keys.has(key))) return null;
  return basketball.normalizeBasketballRules(input);
}

const basketballAdapter = Object.freeze({
  meta: Object.freeze({
    sportFormat: basketball.BASKETBALL_FORMAT.FIVE,
    sportKey: 'basketball',
    supportsLiveScore: true,
    supportsMatchData: true,
    supportsRedraw: true,
    redrawRefuseMessage: '',
    allowsDraw: false,
    defaultMatchTimeFromEvent: true,
    defaultDurationMinutes: () => 90,
    requiresStrictRulesOnEntry: false,
    requiresWinnerOnElimSettle: false,
    sharedEliminationRank: false,
    supportsRankingDecisions: false,
  }),
  rules: Object.freeze({
    defaultPresetKey: basketball.DEFAULT_PRESET_KEY,
    defaultRules: () => normalizeBasketball({ presetKey: basketball.DEFAULT_PRESET_KEY }),
    normalizeRules: normalizeBasketball,
    formatRules: basketball.formatBasketballRules,
  }),
  permissions: Object.freeze({
    canRecord: ({ manage, captain, isRecorder, supportsMatchData = true } = {}) =>
      Boolean(supportsMatchData && (manage || captain || isRecorder)),
    canSeePending: ({ manage, captain, isRecorder } = {}) =>
      Boolean(manage || captain || isRecorder),
    canSetLineup: ({ active, manage, captain } = {}) =>
      Boolean(active && (manage || captain)),
    canEditSchedule: ({ manage, eventActive, match } = {}) =>
      Boolean(manage && eventActive && match && match.status !== 'canceled'),
  }),
  matchLifecycle: Object.freeze({
    initMatchExtra: event => ({
      matchTime: (event && event.startTime) || null,
    }),
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
  }),
  standings: Object.freeze({
    computeTable: computeTeamTable,
    adjustEliminationPlacements: placements => placements,
  }),
  view: Object.freeze({
    eventFormMode: 'basketball',
    recordPageUrl: () => '',
    liveScorePageUrl: matchId => `/packageTeam/team-live-score/team-live-score?matchId=${encodeURIComponent(matchId)}`,
    recordHintText: '',
    statColumns: Object.freeze([
      Object.freeze({ key: 'points', label: '得分' }),
      Object.freeze({ key: 'fouls', label: '犯规' }),
    ]),
  }),
});

module.exports = { basketballAdapter, normalizeBasketball };
