/**
 * 篮球 SportAdapter 插件（共享纯模块）
 */

const basketball = require('../../utils/basketball-rules.js');
const { computeTeamTable } = require('../../utils/team-standings.js');
const { createSportAdapter } = require('../contract.js');

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

const basketballAdapter = createSportAdapter({
  meta: {
    sportFormat: basketball.BASKETBALL_FORMAT.FIVE,
    sportKey: 'basketball',
    supportsLiveScore: true,
    supportsMatchData: true,
    supportsRedraw: true,
    allowsDraw: false,
    defaultMatchTimeFromEvent: true,
    strictEntryRosterCheck: false,
    schedulePeopleSource: 'membership',
  },
  rules: {
    defaultPresetKey: basketball.DEFAULT_PRESET_KEY,
    defaultRules: () => normalizeBasketball({ presetKey: basketball.DEFAULT_PRESET_KEY }),
    normalizeRules: normalizeBasketball,
    formatRules: basketball.formatBasketballRules,
  },
  standings: {
    computeTable: computeTeamTable,
  },
  view: {
    eventFormMode: 'basketball',
    liveScorePageUrl: matchId => `/packageTeam/team-live-score/team-live-score?matchId=${encodeURIComponent(matchId)}`,
    statColumns: Object.freeze([
      Object.freeze({ key: 'points', label: '得分' }),
      Object.freeze({ key: 'fouls', label: '犯规' }),
    ]),
    profileStatColumns: Object.freeze([
      Object.freeze({ key: 'points', label: '得分' }),
      Object.freeze({ key: 'rebounds', label: '篮板' }),
      Object.freeze({ key: 'assists', label: '助攻' }),
      Object.freeze({ key: 'steals', label: '抢断' }),
      Object.freeze({ key: 'blocks', label: '盖帽' }),
      Object.freeze({ key: 'turnovers', label: '失误' }),
      Object.freeze({ key: 'fouls', label: '犯规' }),
    ]),
  },
});

module.exports = { basketballAdapter, normalizeBasketball };
