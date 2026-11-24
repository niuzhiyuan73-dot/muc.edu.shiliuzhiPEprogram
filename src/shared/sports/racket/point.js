/**
 * 球拍两层分制 ScoringAdapter（匹克球 / 乒乓球 / 羽毛球）
 */

const {
  GAME_POINTS_OPTIONS,
  BEST_OF_LABEL,
  DEFAULT_FORMAT,
} = require('../../utils/match-format.js');

const pointScoringAdapter = Object.freeze({
  scoring: 'point',
  scoreUnit: '局',
  isThreeLayer: false,
  usePointTextClass: false,

  buildFormatOptions(rules = {}) {
    const bestOfOptions = (rules.bestOfOptions || []).slice();
    const defaultFormat = { ...(rules.defaultFormat || {}) };
    const gamePointsOptions = (rules.gamePointsOptions || GAME_POINTS_OPTIONS).slice();
    return {
      scoring: 'point',
      defaultFormat,
      bestOfOptions,
      bestOfLabels: bestOfOptions.map(value => BEST_OF_LABEL[value]),
      gamePointsOptions,
      gamePointsLabels: gamePointsOptions.map(value => `${value} 分制`),
      setGamesOptions: [],
      setGamesLabels: [],
      noAd: false,
    };
  },

  scheduledFormatPatch(record, bestOf) {
    return {
      gamePoints: Number(record && record.gamePoints) || DEFAULT_FORMAT.gamePoints,
      bestOf,
    };
  },

  describeLive(live) {
    return {
      scoreText: `${live.pointsA} : ${live.pointsB}`,
      setsText: '',
      pointsTextA: String(live.pointsA),
      pointsTextB: String(live.pointsB),
      setIndex: 0,
      gameIndexText: `第 ${Number(live.gameIndex || 0) + 1} 局`,
      tiebreakText: '',
      scoring: 'point',
      usePointTextClass: false,
    };
  },
});

module.exports = { pointScoringAdapter };
