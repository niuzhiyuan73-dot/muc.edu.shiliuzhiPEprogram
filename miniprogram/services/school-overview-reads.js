const { TEAM_EVENT_STATUS } = require('../utils/constants.js');

/** 有界的公告分页与团队首页摘要，查询条件始终包含资源范围。 */
function attachOverviewReads(surface, { inTx, top, count, command: cmd }) {
  const scope = surface.scope;
  const assertRead = () => { if (inTx) throw new Error('事务内不允许概览查询'); };
  if (surface.announcements) surface.announcements.listPage = async (options = {}) => {
    assertRead();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 20;
    const base = { schoolId: scope.schoolId };
    if (options.status) base.status = options.status;
    if (options.category) base.category = options.category;
    const queryKey = JSON.stringify([scope.schoolId, options.status || '', options.category || '']);
    let where = base;
    if (options.cursor) {
      let cursor;
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw new Error();
        cursor = JSON.parse(decodeURIComponent(options.cursor));
        if (cursor.key !== queryKey || typeof cursor.pinned !== 'boolean' || typeof cursor.at !== 'string'
          || typeof cursor.id !== 'string' || !cursor.id) throw new Error();
      } catch (error) {
        const invalid = new Error('公告分页游标无效，请刷新重试');
        invalid.code = 'INVALID_CURSOR'; throw invalid;
      }
      const pinned = cursor.pinned ? true : cmd.neq(true);
      const after = [
        { pinned, publishTime: cmd.lt(cursor.at) },
        { pinned, publishTime: cursor.at, _id: cmd.lt(cursor.id) },
      ];
      if (cursor.pinned) after.push({ pinned: cmd.neq(true) });
      where = cmd.and([base, cmd.or(after)]);
    }
    const [rows, total] = await Promise.all([
      top('announcements', where, [{ field: 'pinned', direction: 'desc' },
        { field: 'publishTime', direction: 'desc' }, { field: '_id', direction: 'desc' }], limit + 1),
      count('announcements', base),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = rows.length > limit;
    return { rows: page, total, hasMore, nextCursor: hasMore && last ? encodeURIComponent(JSON.stringify({
      key: queryKey, pinned: Boolean(last.pinned), at: String(last.publishTime || ''), id: last._id,
    })) : '' };
  };
  if (surface.teamEvents) surface.teamEvents.homeSummary = async (options = {}) => {
    assertRead();
    const base = { schoolId: scope.schoolId, association: scope.association };
    const active = [TEAM_EVENT_STATUS.REGISTRATION, TEAM_EVENT_STATUS.LOCKED, TEAM_EVENT_STATUS.SCHEDULED, TEAM_EVENT_STATUS.RUNNING];
    const visible = Object.values(TEAM_EVENT_STATUS).filter(status => status !== TEAM_EVENT_STATUS.DRAFT);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 20) : 5;
    const [events, totalAll, matchTotal] = await Promise.all([
      top('teamEvents', { ...base, status: cmd.in(active) }, [
        { field: 'startTime', direction: 'asc' }, { field: '_id', direction: 'asc' },
      ], limit + 1),
      count('teamEvents', { ...base, status: cmd.in(visible) }),
      count('teamMatches', base),
    ]);
    return { events: events.slice(0, limit), totalAll, matchTotal, hasMore: events.length > limit };
  };
}

// 内存实现与云端使用同一套查询计划；操作符只在这里解释，不引入小程序禁用 API。
const memoryCommand = Object.fromEntries(
  ['lt', 'lte', 'gt', 'gte', 'neq', 'in', 'and', 'or'].map(op => [op, value => ({ op, value })]),
);
function overviewMatches(row, where) {
  if (where.op === 'and') return where.value.every(part => overviewMatches(row, part));
  if (where.op === 'or') return where.value.some(part => overviewMatches(row, part));
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (!condition || !condition.op) return value === condition;
    if (condition.op === 'in') return condition.value.includes(value);
    // 时间/数值区间：赛事与学院赛的「按年份归档」要下推成 startTime / publishTime 的
    // 半开区间（2026-10-29 第十二轮审计），所以这里补齐比较操作符。
    if (condition.op === 'lt') return value < condition.value;
    if (condition.op === 'lte') return value <= condition.value;
    if (condition.op === 'gt') return value > condition.value;
    if (condition.op === 'gte') return value >= condition.value;
    if (condition.op === 'neq') return value !== condition.value;
    return false;
  });
}
function memoryOverviewIO(rows) {
  return { command: memoryCommand,
    // 同一份操作符构造器以 `cmd` 暴露：赛事列表下推（event-list-page）按云端
    // `io.cmd` 的接口写，两端必须拿到同样形状的东西。
    cmd: memoryCommand,
    count: async (key, where) => rows(key).filter(row => overviewMatches(row, where)).length,
    top: async (key, where, order, limit, offset = 0) => rows(key).filter(row => overviewMatches(row, where))
      .sort((a, b) => {
        for (const { field, direction } of order) {
          const av = a[field] == null ? '' : a[field];
          const bv = b[field] == null ? '' : b[field];
          if (av !== bv) return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
      }).slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + limit),
  };
}
module.exports = { attachOverviewReads, memoryOverviewIO };
