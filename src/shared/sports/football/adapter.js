/**
 * 足球 SportAdapter 插件（共享纯模块）
 */

const football = require('../../utils/football-rules.js');
const { computeFootballTable } = require('../../utils/football-standings.js');
const { matchMinutes, scoreText } = require('../../utils/football-report.js');
const { draftOf, publishedOf, lineupsOf } = require('../contract.js');

function decorateFootballMatchView(match, { canSeePending = false } = {}) {
  const draft = draftOf(match);
  const published = publishedOf(match);
  const report = canSeePending && draft ? draft : published;
  const result = report && report.result;
  return {
    scoreText: result ? scoreText(result) : match.status === 'reviewing' ? '待审核' : '—',
    scoreA: result ? result.scoreA : null,
    scoreB: result ? result.scoreB : null,
    winner: result ? result.winner : null,
    forfeit: result ? result.forfeit : null,
    overtime: Boolean(result && result.extraTimeCompleted),
    resultKind: result ? result.kind : null,
    regulationScore: result ? result.regulationScore : null,
    extraTimeScore: result ? result.extraTimeScore : null,
    shootoutScore: result ? result.shootoutScore : null,
    reportPending: Boolean(canSeePending && draft),
    statPending: Boolean(canSeePending && draft),
    hasLineup: Boolean(report && report.sides && ['A', 'B'].some(side => (report.sides[side]?.players || []).length)),
    durationMinutes: match.durationMinutes || null,
  };
}

function adjustFootballEliminationPlacements(placements, matches) {
  const rankByRound = new Map();
  return (placements || []).map(row => {
    if (row.note !== '淘汰') return row;
    const lost = (matches || []).find(m => m.stage !== 'bronze' && (m.winner === 'A' ? m.teamB : m.teamA) === row.teamId);
    const round = lost && lost.round;
    if (!rankByRound.has(round)) rankByRound.set(round, row.rank);
    return { ...row, rank: rankByRound.get(round), note: '同轮淘汰（并列）' };
  });
}

const footballAdapter = Object.freeze({
  meta: Object.freeze({
    sportFormat: football.FOOTBALL_FORMAT,
    sportKey: 'football',
    supportsLiveScore: false,
    supportsMatchData: true,
    supportsRedraw: false,
    redrawRefuseMessage: '足球赛程已经生成；首版不重抽，请核对现有签表或重建赛事',
    allowsDraw: true,
    defaultMatchTimeFromEvent: false,
    defaultDurationMinutes: (rules, format) => matchMinutes(rules, format),
    requiresStrictRulesOnEntry: true,
    requiresWinnerOnElimSettle: true,
    sharedEliminationRank: true,
    supportsRankingDecisions: true,
    strictEntryRosterCheck: true,
    schedulePeopleSource: 'school',
  }),
  rules: Object.freeze({
    defaultPresetKey: football.DEFAULT_PRESET_KEY,
    defaultRules: football.defaultRulesFor,
    normalizeRules: football.normalizeFootballRules,
    formatRules: football.formatFootballRules,
  }),
  permissions: Object.freeze({
    canRecord: ({ manage, isRecorder, supportsMatchData = true } = {}) =>
      Boolean(supportsMatchData && (manage || isRecorder)),
    canSeePending: ({ manage, isRecorder } = {}) =>
      Boolean(manage || isRecorder),
    canSetLineup: ({ active, manage, captain, match } = {}) =>
      Boolean(active && (manage || captain) && !draftOf(match)),
    canEditSchedule: ({ manage, eventActive, match } = {}) =>
      Boolean(manage && eventActive && match && match.status === 'scheduled'),
  }),
  matchLifecycle: Object.freeze({
    initMatchExtra: event => ({
      matchTime: null,
      rules: event.rules,
      durationMinutes: matchMinutes(event.rules, event.format),
    }),
    hasActivityOrDraft: match => Boolean(match && (
      match.status === 'live'
      || match.liveScore
      || draftOf(match)
      || publishedOf(match)
      || lineupsOf(match)
      || (match.scoreA !== null && match.scoreA !== undefined)
    )),
    validateBeforeSettle: matches => {
      if ((matches || []).some(match => Boolean(draftOf(match)))) {
        return { ok: false, message: '仍有足球报告待审核，请先审核后结算' };
      }
      return { ok: true, message: '' };
    },
    validateRankingDecisions: (payload = {}, event = {}, ctx = {}) => {
      if (payload.rankingDecisions !== undefined
        && (!Array.isArray(payload.rankingDecisions) || payload.rankingDecisions.some(row => !row
          || typeof row.tieKey !== 'string' || !Array.isArray(row.teamIds)
          || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500))) {
        return { ok: false, message: '抽签确认须填写有效的球队顺序与理由（不超过 500 字）' };
      }
      const decisions = Array.isArray(payload.rankingDecisions)
        ? payload.rankingDecisions.map(row => ({
          tieKey: row.tieKey,
          teamIds: row.teamIds,
          reason: row.reason,
          decidedBy: ctx.actorId || '',
          decidedAt: new Date(ctx.now || Date.now()).toISOString(),
        }))
        : (event && event.rankingDecisions) || [];
      return { ok: true, decisions };
    },
    validateEntryPayload: (payload = {}, event = {}) => {
      if (!football.normalizeFootballRules(event.rules)) {
        return { ok: false, message: '足球规则配置不合法' };
      }
      if (payload.roster !== undefined && !Array.isArray(payload.roster)) {
        return { ok: false, message: '报名名单格式不合法' };
      }
      return { ok: true, message: '' };
    },
    decorateMatchView: decorateFootballMatchView,
  }),
  standings: Object.freeze({
    computeTable: computeFootballTable,
    adjustEliminationPlacements: adjustFootballEliminationPlacements,
  }),
  view: Object.freeze({
    eventFormMode: 'football',
    recordPageUrl: (matchId, { lineup = false } = {}) =>
      `/packageTeam/football-match/football-match?matchId=${encodeURIComponent(matchId)}${lineup ? '&lineup=1' : ''}`,
    liveScorePageUrl: () => '',
    recordHintText: '点球胜负单列，正式平局不计为胜。',
    statColumns: Object.freeze([
      Object.freeze({ key: 'goals', label: '进球' }),
      Object.freeze({ key: 'assists', label: '助攻' }),
      Object.freeze({ key: 'yellowCards', label: '黄牌' }),
      Object.freeze({ key: 'dismissals', label: '红牌' }),
    ]),
  }),
});

module.exports = { footballAdapter };
