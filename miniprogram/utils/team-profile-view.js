/** 独立成绩页与协会内“我的球队”页签共用展示形状，数值仍由后端公开快照计算。 */
const { getSportAdapter } = require('../shared/sports/registry.js');

function teamProfileView(profile) {
  const format = profile && profile.sportFormat;
  // 旧数据没有 sportFormat：保留篮球兜底；新运动有明确格式但适配器缺失时
  // 不再假装是篮球，宁可空列，避免把篮球指标标成别的运动。
  const adapter = getSportAdapter(format)
    || (format ? null : getSportAdapter('basketball5'));
  const isFootball = Boolean(adapter && adapter.view.eventFormMode === 'football');
  const columns = (adapter && (adapter.view.profileStatColumns || adapter.view.statColumns)) || [];
  const definitions = columns.map(col => [col.key, col.label]);
  const totals = profile.totals || {};
  const cellsOf = source => definitions.map(([field, label]) => {
    const total = source[field]; const matches = source[`${field}RecordedMatches`];
    const perGame = source[`${field}PerGameText`] ?? (Number.isInteger(total) && matches > 0
      ? String(Math.round(total / matches * 10) / 10) : '—');
    return { field, label, totalText: source[`${field}Text`] ?? '—', perGameText: perGame,
      recordedMatches: Number.isInteger(matches) ? matches : 0 };
  });
  return { ...profile, isFootball,
    teams: profile.teams || [], events: profile.events || [], honors: profile.honors || [],
    // 出场只有一个口径：服务端给的 appearanceGames。
    // 足球 = 赛后报告里逐场标了「实际出场」的场次；篮球 = 单场名单 ∪ 个人统计。
    // 足球原先退回 totals.games，值其实相同（aggregate 的 games 也只累加
    // appeared 行），但那是**另算一遍**的口径——两边一旦有一处改动就会分叉。
    // 现在统一由服务端给，view 只负责兜底旧接口。
    totals: { ...totals, appearanceGames: totals.appearanceGames ?? totals.games ?? 0 },
    statCells: cellsOf(totals),
    statEvents: (profile.statEvents || []).map(row => ({ ...row, statCells: cellsOf(row) })),
  };
}
module.exports = { teamProfileView };
