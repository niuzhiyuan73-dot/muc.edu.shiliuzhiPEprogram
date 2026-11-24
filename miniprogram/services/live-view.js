/**
 * 实时比分的展示整形
 * ============================================================
 * 查看端要把「正在进行的那一场」显示在终局比分的位置上。状态机吐出来的
 * liveScoreOf 是给数据看的，这里把它翻成页面上要的两三行字：当前局比分、
 * 局数、第几局、进行中 / 已结束。
 *
 * 【为什么不写在各页里】
 * 比赛页、赛事详情、学院赛详情三处都要同一句话「进行中 · 11 : 9」。
 * 分开写迟早会分叉（一处标「进行中」一处标「实时」），所以只此一份。
 * 本模块是纯函数，不碰数据源，可以在 Node 里直接测。
 *
 * 【首屏与增量为什么共用同一套整形】
 * 首屏的 live 来自既有读接口（record.live），增量来自轮询适配器
 * （getLiveScores）。两处字段同源，都经 describeLive 整形，页面才能
 * 「首屏什么样，刷新后还什么样」。
 * ============================================================
 */

const { getScoringAdapter } = require('../shared/sports/racket/registry.js');

/**
 * 把一条实时视图整形成行上要显示的字段。没有实时态返回 null。
 *
 * @param {Object|null} live liveScoreOf 的返回值
 * @returns {Object|null}
 */
function describeLive(live) {
  if (!live) return null;
  const finished = Boolean(live.finished);
  const display = getScoringAdapter(live.scoring).describeLive(live);

  return {
    matchId: live.matchId,
    ...display,
    /** 大比分（已结束的局数），如「1 : 0」；网球为本盘局分「4 : 3」 */
    gamesText: `${live.gamesA} : ${live.gamesB}`,
    gameIndex: live.gameIndex,
    /** 'A' | 'B' | ''，供查看端高亮领先方 */
    leading: live.leading || '',
    finished,
    statusLabel: finished ? '已结束' : '进行中',
  };
}

/**
 * 把一批实时视图贴回已经整好的行上（按 matchId 对齐）。
 *
 * 只在视图里出现的行才动：既让轮询的增量落到界面上，又不动其余行——
 * 没比分的行保持原对象引用，setData 的开销跟着实际变化走。
 *
 * @param {Array<Object>} rows 视图模型已经算好的行（含 matchId）
 * @param {Array<Object>} views getLiveScores 的结果
 * @returns {Array<Object>}
 */
function applyLiveRows(rows, views) {
  const byMatch = new Map();
  for (const view of Array.isArray(views) ? views : []) {
    if (view && view.matchId) byMatch.set(view.matchId, describeLive(view));
  }
  if (byMatch.size === 0) return Array.isArray(rows) ? rows : [];

  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || !byMatch.has(row.matchId)) return row;
    return { ...row, live: byMatch.get(row.matchId), liveActive: true };
  });
}

/**
 * 与 applyLiveRows 同理，但行藏在「大场 → 小项」两层里。
 * 学院赛详情页的小项挂在大场下，轮询回来的增量要落到对应的 legRow 上。
 *
 * @param {Array<Object>} ties 大场行，每行带 legRows（含 matchId）
 * @param {Array<Object>} views getLiveScores 的结果
 * @returns {Array<Object>}
 */
function applyLiveTies(ties, views) {
  const byMatch = new Map();
  for (const view of Array.isArray(views) ? views : []) {
    if (view && view.matchId) byMatch.set(view.matchId, describeLive(view));
  }
  if (byMatch.size === 0) return Array.isArray(ties) ? ties : [];

  return (Array.isArray(ties) ? ties : []).map((tie) => {
    if (!tie || !Array.isArray(tie.legRows)) return tie;
    return {
      ...tie,
      legRows: tie.legRows.map((leg) => {
        if (!leg || !byMatch.has(leg.matchId)) return leg;
        return { ...leg, live: byMatch.get(leg.matchId), liveActive: true };
      }),
    };
  });
}

module.exports = { describeLive, applyLiveRows, applyLiveTies };
