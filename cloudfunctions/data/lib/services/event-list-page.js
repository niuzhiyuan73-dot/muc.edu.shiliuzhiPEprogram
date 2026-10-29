/**
 * 赛事 / 学院赛列表的受控分页
 * ============================================================
 * 【要解决什么】（2026-10-29 第十二轮审计）
 * `listSchoolEvents` / `listCollegeEvents` 原先是「整表读 + 内存筛选 + 内存排序 +
 * 切片」。一所协会开三年、两百多场比赛，每次翻页都要把所有赛事读回来重排一遍；
 * 首页、赛事页、学院赛页各发一次，读量随历史线性增长，而每页只显示 20 条。
 *
 * 这里把四件事一起下推：
 *   · 范围（schoolId + association）——始终在第一段条件里，不依赖调用方；
 *   · 状态（单个或一组）；
 *   · 时间区间（赛事按 startTime，学院赛按 publishTime 归档年份）；
 *   · 排序与 offset/limit（多字段链式 orderBy + skip + limit）。
 *
 * `total` 与 `totalAll` 用两次聚合计数：前者是过滤后的条数（分页基准），后者是
 * 「本协会一共多少场」（概况数字），都不再靠把列表读齐再数长度。
 *
 * 【为什么不在这里做关键词搜索】
 * 关键词要匹配 title / name / location 三个字段，云数据库没有可用于包含匹配的
 * 索引；强行下推成正则查询会退化成全表扫描，还绕过了索引。调用方在有关键词时
 * 回退到内存过滤（数据量是「本协会赛事数」，不是全库）。
 *
 * 【两端共用】
 * 云端（cloud-repo 的 io）与内存 mock（school-memory-repo）都通过
 * `attachSchoolRepository` 之外的同一份函数挂载，条件用两端各自的 `cmd` 构造，
 * 保证「本地能翻页、云端翻不动」这类只在真机出现的毛病不再发生。
 */

/** 单页上限：与赛事列表的既有上限一致，超出的部分靠 offset 续读。 */
const PAGE_MAX = 100;

/**
 * @param {Object} io 仓储 io（需要 cmd / top / count）
 * @param {{schoolId:string, association:string}} scope
 * @param {string} key 集合键（events / collegeEvents）
 * @param {Object} [options]
 * @param {string} [options.timeField='startTime'] 时间过滤字段
 * @param {number[]|null} [options.statuses] 状态集合；空表示不限
 * @param {string} [options.timeFrom] 时间下界（含），ISO 串
 * @param {string} [options.timeTo] 时间上界（不含），ISO 串
 * @param {Array<{field:string, direction:'asc'|'desc'}>} [options.order]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 * @returns {Promise<{rows:Array<Object>, total:number, totalAll:number, hasMore:boolean}>}
 */
async function pageOfCollection(io, scope, key, options = {}) {
  const {
    timeField = 'startTime', statuses = null, timeFrom = '', timeTo = '',
    order = [], limit = 20, offset = 0,
  } = options;
  const base = { schoolId: scope.schoolId, association: scope.association };
  const conds = [base];
  const statusList = Array.isArray(statuses) ? statuses.filter(value => typeof value === 'number') : [];
  if (statusList.length === 1) conds.push({ status: statusList[0] });
  else if (statusList.length > 1) conds.push({ status: io.cmd.in(statusList) });
  if (timeFrom) conds.push({ [timeField]: io.cmd.gte(timeFrom) });
  if (timeTo) conds.push({ [timeField]: io.cmd.lt(timeTo) });
  const where = conds.length === 1 ? conds[0] : io.cmd.and(conds);

  const size = Math.max(1, Math.min(Number(limit) || 20, PAGE_MAX));
  const skip = Math.max(0, Number(offset) || 0);
  // 多取一条判 hasMore：比再发一次「游标条件的 count」便宜，也不会随数据量变慢。
  const [fetched, total, totalAll] = await Promise.all([
    io.top(key, where, order, size + 1, skip),
    io.count(key, where),
    // totalAll 只按范围数：概况里的「N 场赛事」不能被「只看报名中」的筛选带偏。
    io.count(key, base),
  ]);
  return { rows: fetched.slice(0, size), total, totalAll, hasMore: fetched.length > size };
}

module.exports = { pageOfCollection, PAGE_MAX };
