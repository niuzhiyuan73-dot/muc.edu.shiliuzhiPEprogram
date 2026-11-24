/**
 * 团队赛事详情页的统计列声明。
 *
 * 统计字段属于运动插件：篮球 7 项、足球 4 项、新运动按 `view.statColumns`
 * 声明。页面只渲染这一份，不再写死 `STAT_FIELDS`。
 */

const { getSportAdapter } = require('../../shared/sports/registry.js');

function statFieldsOf(sportFormat, { leaderboard = false } = {}) {
  const view = getSportAdapter(sportFormat)?.view;
  const columns = (leaderboard ? view?.playerStatColumns : undefined) ?? view?.statColumns ?? [];
  return columns.map(col => ({
    field: col.key,
    label: col.label,
  }));
}

module.exports = { statFieldsOf };
