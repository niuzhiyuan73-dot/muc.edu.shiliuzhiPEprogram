/**
 * 团队运动服务端插件允许覆写的动作白名单
 * ============================================================
 * 只有这里列出的协议动作可以按运动覆写；`createTeamEvent`、报名审核、
 * 抽签、结算、实时计分等核心动作留在通用内核，防止插件绕过统一鉴权。
 */

const TEAM_PLUGIN_ACTION_ALLOWLIST = Object.freeze([
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

module.exports = { TEAM_PLUGIN_ACTION_ALLOWLIST };
