/** 比赛列表的受控查询规格；云端只取一页，内存端保持同一筛选与排序口径。 */
const { MATCH_STATUS } = require('../utils/constants');

const isListMatch = doc => Boolean(doc && Array.isArray(doc.teamA) && Array.isArray(doc.teamB) &&
  typeof doc.status === 'number' && doc.matchTime);
const compareId = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const compareMatches = (a, b) => ((Date.parse(b.matchTime) || 0) - (Date.parse(a.matchTime) || 0)) ||
  compareId(String(b._id), String(a._id));

/**
 * 比赛列表的游标编解码（2026-10-29 第十一轮审计 P2-7）。
 *
 * 【为什么要统一成字符串】同一批列表接口里，公告/成员/分组/训练返回的
 * `nextCursor` 都是不透明字符串，只有比赛返回 `{matchTime, id}` 对象。同名同义
 * 两种类型，任何「把下一页游标原样回传」的封装都会在比赛这一路踩成
 * `[object Object]`。这里按 `matchTime|id` 编码，段内 `encodeURIComponent`，
 * 与 `association-member.js` 的编码风格一致（不透明、可原样回传）。
 *
 * 解码失败返回 null，调用方按「游标无效」拒掉，不要静默退回第一页——
 * 那会让「翻不动」看起来像「已经到底了」。
 */
function encodeMatchCursor(cursor) {
  if (!cursor || typeof cursor.matchTime !== 'string' || typeof cursor.id !== 'string') return '';
  if (!cursor.matchTime || !cursor.id) return '';
  return `${encodeURIComponent(cursor.matchTime)}|${encodeURIComponent(cursor.id)}`;
}

function decodeMatchCursor(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > 700) return null;
  const parts = raw.split('|');
  if (parts.length !== 2) return null;
  try {
    const matchTime = decodeURIComponent(parts[0]);
    const id = decodeURIComponent(parts[1]);
    if (!matchTime || !id) return null;
    return { matchTime, id };
  } catch (err) {
    return null;
  }
}

function listFilter(payload = {}) {
  const filter = {};
  for (const key of ['pool', 'status']) {
    if (typeof payload[key] === 'number') filter[key] = payload[key];
  }
  for (const key of ['eventId', 'userId']) {
    if (typeof payload[key] === 'string' && payload[key]) filter[key] = payload[key];
  }
  return filter;
}

/** 聚合 match 使用原生查询操作符；范围来自服务上下文，客户端不能覆盖。 */
function matchListWhere(scope, filter, cursor) {
  const where = {
    schoolId: scope.schoolId, association: scope.association,
    teamA: { $type: 'array' }, teamB: { $type: 'array' },
    // 查询 $type 会检查数组元素，必须排除 status:[0] 这类畸形数据。
    status: { $type: 'number', $not: { $type: 'array' } },
    matchTime: { $exists: true, $nin: ['', null, false, 0] },
  };
  for (const key of ['pool', 'eventId']) {
    if (filter[key] !== undefined) where[key] = filter[key];
  }
  const and = [where];
  if (filter.status !== undefined) and.push({ status: filter.status });
  if (filter.userId) and.push({ $or: [{ teamA: filter.userId }, { teamB: filter.userId }] });
  if (cursor) and.push({ $or: [
    { matchTime: { $lt: cursor.matchTime } },
    { matchTime: cursor.matchTime, _id: { $lt: cursor.id } },
  ] });
  return and.length === 1 ? where : { $and: and };
}

function memoryMatchPage(docs, scope, { filter = {}, limit, offset = 0, cursor = null }) {
  const base = docs.filter(doc => isListMatch(doc) && doc.schoolId === scope.schoolId &&
    doc.association === scope.association &&
    (filter.pool === undefined || doc.pool === filter.pool) &&
    (!filter.eventId || doc.eventId === filter.eventId) &&
    (!filter.userId || doc.teamA.includes(filter.userId) || doc.teamB.includes(filter.userId)));
  const pendingCount = base.filter(doc => doc.status === MATCH_STATUS.PENDING).length;
  const rows = base.filter(doc => filter.status === undefined || doc.status === filter.status).sort(compareMatches);
  const remaining = cursor ? rows.filter(doc => compareMatches(doc, { matchTime: cursor.matchTime, _id: cursor.id }) > 0) : rows;
  const start = cursor ? 0 : offset;
  return { rows: remaining.slice(start, start + limit), total: rows.length, pendingCount,
    hasMore: remaining.length > start + limit };
}

module.exports = {
  isListMatch, listFilter, matchListWhere, memoryMatchPage, encodeMatchCursor, decodeMatchCursor,
};
