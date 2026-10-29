/** 赛事工作台及全部列表：赛事、积分和身份使用同一 S2 范围。 */
const space = require('./association-space');
const identity = require('./school-identity');
const { loadSchoolEventListView } = require('./school-event-view');
const { buildPointsRows, describeSeason } = require('./events-view');
const { formatPercent } = require('../utils/format');
const { USER_STATUS } = require('../utils/constants');

/**
 * 赛事工作台面板：积分榜前 10 + 最近的几场赛事。
 *
 * 【为什么不再「取齐全部赛事」】（2026-10-29 第十一轮审计 P2-4）
 * `listLimit: Infinity` 会让装载器按 50 条一页循环翻到底，而服务端每页都是一次
 * 「整表读 + 全量排序 + 切片」——一个开了三年的协会，打开面板就是几十次全表读，
 * 只为了把 `events.length` 当赛事总数。服务端在分页前已经算好 `totalAll`
 * （不带状态筛选的总量），直接用它即可，页面只取第一页。
 */
async function loadSchoolEventsPanelView(options) {
  const { schoolId, association, listLimit = 3, includePoints = true } = options;
  const scope = { schoolId, association };
  const api = space.forScope(scope);
  const session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
  const actorId = session.user && session.user.userId;
  const [personal, stats, season] = await Promise.all([
    loadSchoolEventListView({ ...scope, actorId, limit: Math.max(1, Math.min(listLimit, 20)) }),
    includePoints ? api.getSchoolMemberStats({}) : { ok: true, members: [] },
    includePoints ? api.getSchoolSeason({}) : { ok: true, season: {} },
  ]);
  if (!stats.ok || !season.ok) throw new Error(stats.message || season.message || '积分读取失败');
  const allRows = buildPointsRows(stats.members.map(row => ({ ...row, _id: row.userId, status: USER_STATUS.ACTIVE })), new Map(), actorId)
    .map(row => ({ ...row, detailText: '赛事与训练积分' }));
  const rows = allRows.slice(0, 10);
  const total = allRows.length;
  const me = allRows.find(row => row.userId === actorId);
  const events = personal.events.slice(0, listLimit);
  const eventTotal = personal.eventTotalAll;
  return {
    seasonText: describeSeason(season.season), rows, allRows, total,
    hasMore: total > rows.length, empty: !total,
    playerCountText: total > 10 ? `前 10 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: '本赛季还没有积分记录',
    me: me ? { rank: me.rank, total, beatText: `超过 ${formatPercent((total - me.rank) / total)} 的会员` } : null,
    meHint: me ? '' : '本赛季还没有积分',
    events, hasEvents: events.length > 0, eventTotal,
    eventsEmptyNote: personal.eventsEmptyNote, hasMoreEvents: eventTotal > events.length,
    canPublish: personal.canPublish,
  };
}

module.exports = { loadSchoolEventsPanelView };
