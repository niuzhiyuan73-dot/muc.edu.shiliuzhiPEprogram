/**
 * 学院总榜与个人荣誉（B8）
 * ============================================================
 * 学院总分与荣誉都在**发布成绩的同一个事务里**累加（见 meet-score-service 的
 * publishMeetResults），所以这里只做读取与排序，不再现算一遍。
 *
 * 【为什么读快照而不是实时聚合】
 * 一届的结果行可能上千（40 学院 × 90+ 项目组别 × 每项若干条）。每次打开总榜都
 * 全量扫一遍，云开发上既要分页又要排序，慢且贵。发布本身是低频写操作，
 * 累加放进那个事务，这里读到的就是现成的一页。
 *
 * 【快照与结果行的关系】
 * 正式结果行（sportsMeetResultRows）是事实来源，快照只是加速读取的派生数据。
 * 两者不一致时以结果行为准——这也是为什么「重发」必须先在事务里把旧分减掉：
 * 结果行按同主键覆盖，旧值会消失，而快照是累加的，不减就会翻倍。
 * ============================================================
 */

const {
  meetReadable, canManageMeet,
} = require('./meet-permission.js');
const { listAliveEvents } = require('../utils/meet-scope.js');
const { compareCode } = require('../utils/text-order.js');

// DTO 补 ok:true，与其余三域同形（见 meet-service.js 的说明）。
const ok = (data) => ({ ok: true, data: { ...data, ok: data.ok === undefined ? true : data.ok } });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });

const PAGE_MAX = 100;

/** 学院名：取本届学院范围里的快照名，学院改名不影响历史榜单。 */
async function collegeNamesOf(ctx) {
  const rows = await ctx.repo.forMeet(scopeOf(ctx)).sportsMeetColleges.list();
  const names = new Map();
  for (const row of rows) {
    if (row && row.schoolId === ctx.schoolId) names.set(row.collegeId, row.name || row.collegeId);
  }
  return names;
}

/**
 * 学院总榜。
 *
 * 排序口径（决策文档 4.2「学院总分同分处理」）：
 * 总分 → 金牌数 → 银牌数 → 铜牌数 → 学院编号。
 * 名次按竞赛排名给：两个学院同分则并列，下一名次跳号。
 */
async function getMeetStandings(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  const [meet, standings, names, scope, publications] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scopeOf(ctx)).sportsMeetStandings.list(),
    collegeNamesOf(ctx),
    ctx.repo.forMeet(scopeOf(ctx)).sportsMeetColleges.list(),
    ctx.repo.forMeet(scopeOf(ctx)).sportsMeetPublications.list(),
  ]);
  if (!meet || meet.schoolId !== ctx.schoolId || meet.status === 'deleted') {
    return refused('运动会不存在或已删除');
  }

  const offset = Math.max(0, Number(payload.offset) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(payload.limit) || 50));

  // D82：显示本届**参与范围**内所有学院——只要报名了一个人就算参与，
  // 未得分显示 0。参与范围来自报名时落下的 sportsMeetColleges 快照，
  // 所以零分学院也会出现在榜上，且学院名是当届快照（改名不漂移）。
  const byCollege = new Map();
  for (const row of scope) {
    if (!row || row.schoolId !== ctx.schoolId || row.meetId !== ctx.meetId) continue;
    byCollege.set(row.collegeId, { total: 0, gold: 0, silver: 0, bronze: 0, updatedAt: '' });
  }
  for (const doc of standings) {
    if (!doc || doc.schoolId !== ctx.schoolId || doc.meetId !== ctx.meetId) continue;
    const row = byCollege.get(doc.collegeId)
      || { total: 0, gold: 0, silver: 0, bronze: 0, updatedAt: '' };
    row.total = Number(doc.total) || 0;
    row.gold = Number(doc.gold) || 0;
    row.silver = Number(doc.silver) || 0;
    row.bronze = Number(doc.bronze) || 0;
    row.updatedAt = doc.updatedAt || '';
    byCollege.set(doc.collegeId, row);
  }

  const rows = [...byCollege.entries()].map(([collegeId, row]) => ({
    collegeId,
    collegeName: names.get(collegeId) || collegeId,
    total: row.total,
    gold: row.gold,
    silver: row.silver,
    bronze: row.bronze,
    updatedAt: row.updatedAt,
  }))
    .sort((a, b) => b.total - a.total
      || b.gold - a.gold
      || b.silver - a.silver
      || b.bronze - a.bronze
      || compareCode(a.collegeId, b.collegeId));

  // 竞赛排名 1,2,2,4：比较键完全相同的学院并列
  const ranked = [];
  let lastKey = '';
  let lastRank = 0;
  rows.forEach((row, index) => {
    const key = `${row.total}|${row.gold}|${row.silver}|${row.bronze}`;
    row.rank = key === lastKey ? lastRank : index + 1;
    lastKey = key;
    lastRank = row.rank;
    ranked.push(row);
  });

  return ok({
    meetId: ctx.meetId,
    meetName: meet.name || '',
    // 「有没有正式成绩」看正式发布记录，不看榜上行数：报了名还没发成绩时，
    // 参与范围内的学院都以 0 分上榜，但页面要显示「总榜暂未生成」。
    published: publications.some((doc) => doc && doc.meetId === ctx.meetId && doc.official !== false),
    total: ranked.length,
    offset,
    limit,
    items: ranked.slice(offset, offset + limit),
  });
}

/**
 * 我的荣誉。
 *
 * 荣誉按参赛记录存（一条记录可能对应多名队员），所以这里按 userIds 过滤。
 * 一届荣誉上限约 800 条，一次 list 后本地过滤，读取端可接受。
 */
async function getMyMeetHonors(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');

  const [meet, honors, events] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scopeOf(ctx)).sportsMeetHonors.list(),
    listAliveEvents(ctx.repo.forMeet(scopeOf(ctx)).sportsMeetEvents),
  ]);
  if (!meet || meet.schoolId !== ctx.schoolId || meet.status === 'deleted') {
    return refused('运动会不存在或已删除');
  }

  const eventOf = new Map(events.map((doc) => [doc._id, doc]));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(payload.limit) || 50));

  const mine = honors
    .filter((doc) => doc && doc.schoolId === ctx.schoolId && doc.meetId === ctx.meetId)
    .filter((doc) => Array.isArray(doc.userIds) && doc.userIds.includes(ctx.actorId))
    // 无名次的荣誉是「作废」占位（报名撤回、被排除出签表），不展示
    .filter((doc) => Number(doc.rank) > 0)
    .map((doc) => {
      const event = eventOf.get(doc.eventKey);
      return {
        eventKey: doc.eventKey,
        name: event ? event.name : doc.eventKey,
        group: event ? event.group : '',
        collegeId: doc.collegeId,
        rank: Number(doc.rank),
        points: Number(doc.points) || 0,
        publishedAt: doc.publishedAt || '',
      };
    })
    .sort((a, b) => a.rank - b.rank
      || compareCode(b.publishedAt, a.publishedAt)
      || String(a.name).localeCompare(String(b.name)));

  const summary = {
    gold: mine.filter((row) => row.rank === 1).length,
    silver: mine.filter((row) => row.rank === 2).length,
    bronze: mine.filter((row) => row.rank === 3).length,
    points: mine.reduce((sum, row) => sum + row.points, 0),
  };

  return ok({
    meetId: ctx.meetId,
    meetName: meet.name || '',
    total: mine.length,
    offset,
    limit,
    summary,
    items: mine.slice(offset, offset + limit),
  });
}

module.exports = {
  getMeetStandings,
  getMyMeetHonors,
  // 供动作层与测试复用分页上限
  PAGE_MAX,
  canManageMeet,
};
