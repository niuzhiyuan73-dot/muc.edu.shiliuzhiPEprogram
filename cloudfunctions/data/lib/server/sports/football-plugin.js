/**
 * 足球服务端扩展插件（仅云端/服务端）
 * ============================================================
 * 按白名单收口可覆写的团队协议动作，绝不暴露 isFootball / conflicts /
 * footballMatchView 等内部辅助函数。
 */

const footballMatchService = require('../services/football-match-service.js');
const footballScheduleService = require('../services/football-schedule-service.js');
const { TEAM_PLUGIN_ACTION_ALLOWLIST } = require('./action-allowlist.js');

const merged = { ...footballMatchService, ...footballScheduleService };
const actions = {};
for (const name of TEAM_PLUGIN_ACTION_ALLOWLIST) {
  if (typeof merged[name] === 'function') actions[name] = merged[name];
}

module.exports = Object.freeze({
  sportFormat: 'football11',
  actions: Object.freeze(actions),
});
