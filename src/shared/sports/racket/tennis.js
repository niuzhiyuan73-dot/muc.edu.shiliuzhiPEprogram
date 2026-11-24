/**
 * 球拍三层网球 ScoringAdapter（盘 → 局 → 分 15/30/40/AD）
 */

const { TENNIS_BEST_OF_LABEL } = require('../../utils/match-format.js');

const SET_GAMES_LABELS = { 6: '6 局（标准盘）', 4: '4 局（短盘）' };

const tennisScoringAdapter = Object.freeze({
  scoring: 'tennis',
  scoreUnit: '盘',
  isThreeLayer: true,
  usePointTextClass: true,

  buildFormatOptions(rules = {}) {
    const bestOfOptions = (rules.bestOfOptions || []).slice();
    const defaultFormat = { ...(rules.defaultFormat || {}) };
    const setGamesOptions = (rules.setGamesOptions || []).slice();
    return {
      scoring: 'tennis',
      defaultFormat,
      bestOfOptions,
      bestOfLabels: bestOfOptions.map(value => TENNIS_BEST_OF_LABEL[value]),
      gamePointsOptions: [],
      gamePointsLabels: [],
      setGamesOptions,
      setGamesLabels: setGamesOptions.map(value => SET_GAMES_LABELS[value] || `${value} 局`),
      noAd: defaultFormat.noAd === true,
    };
  },

  scheduledFormatPatch(record = {}, bestOf) {
    return {
      scoring: 'tennis',
      bestOf,
      setGames: Number(record.setGames) || 6,
      tiebreakAt: Number(record.tiebreakAt) || Number(record.setGames) || 6,
      tiebreakPoints: Number(record.tiebreakPoints) || 7,
      noAd: record.noAd === true,
    };
  },

  describeLive(live) {
    return {
      scoreText: `${live.pointTextA} : ${live.pointTextB}`,
      setsText: `${live.setsA} : ${live.setsB}`,
      pointsTextA: live.pointTextA,
      pointsTextB: live.pointTextB,
      setIndex: Number(live.setIndex || 0),
      gameIndexText: `第 ${Number(live.setIndex || 0) + 1} 盘`,
      tiebreakText: live.inTiebreak ? '抢七' : '',
      scoring: 'tennis',
      usePointTextClass: true,
    };
  },
});

module.exports = { tennisScoringAdapter, SET_GAMES_LABELS };
