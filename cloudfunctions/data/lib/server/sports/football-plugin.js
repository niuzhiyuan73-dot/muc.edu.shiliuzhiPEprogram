/**
 * 足球服务端扩展插件（仅云端/服务端）
 * ============================================================
 * 按白名单收口可覆写的团队协议动作，绝不暴露 isFootball / conflicts /
 * footballMatchView 等内部辅助函数。
 */

const footballMatchService = require('../services/football-match-service.js');
const footballScheduleService = require('../services/football-schedule-service.js');

const FOOTBALL_ACTION_NAMES = Object.freeze([
  'getTeamMatchStats',
  'recordTeamMatch',
  'publishTeamMatch',
  'saveTeamMatchStats',
  'reviewTeamMatchStats',
  'getTeamMatchLineup',
  'saveTeamMatchLineup',
  'getTeamEventPlayerStats',
  'getMyTeamProfile',
  'getTeamRecord',
  'updateTeamMatchSchedule',
  'updateTeamRoundSchedule',
]);

const merged = { ...footballMatchService, ...footballScheduleService };
const actions = {};
for (const name of FOOTBALL_ACTION_NAMES) {
  if (typeof merged[name] === 'function') actions[name] = merged[name];
}

module.exports = Object.freeze({
  sportFormat: 'football11',
  actions: Object.freeze(actions),
});
