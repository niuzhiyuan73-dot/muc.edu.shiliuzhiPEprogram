/**
 * 场地分配
 * ============================================================
 * 纯函数，不碰 wx API、不做 I/O、不认识数据源。给它一批比赛和一个场地
 * 总数，它算出每场比赛该去几号场。
 *
 * 【要解决的问题】
 * 需求只有一句话：同一轮次的场地不能重复。听上去像排程，其实是道取模题
 * ——因为另外三条需求把时间、跨赛事、场地属性全都排除在外了：
 *   - 不给每场比赛排具体时间 → 不需要考虑时段冲突，只需要「同一批不撞号」；
 *   - 不考虑跨赛事排场地     → 场地池是赛事私有的，各算各的；
 *   - 场地只有编号区别       → 场地就是一个 1..N 的整数，没有可用性状态。
 *
 * 【场地不够怎么办：分批】
 * 「同一轮次场地不重复」在「同轮 8 场、只有 3 块场地」时数学上做不到，而
 * 场地数是发布时填的、那时还不知道报名多少人，所以冲突一定会发生。做法是
 * 把同池的比赛按序切批，**同一批内绝不重复**：场地够用时只有一批，就退化
 * 成需求原文的字面要求；不够时才排到第二批、第三批。
 *
 * 批次（wave）只是序号，不是时刻——「不排具体时间」这条没有被破坏。
 *
 * 【什么是「同一轮次」】
 * 不能简单按 round 分组：双败的胜者组第 1 轮与败者组第 1 轮的 round 都是 1，
 * 却不同时开打；小组赛里 A 组第 1 轮与 B 组第 1 轮 round 相同、group 不同，
 * 却通常同时开打。所以这里按「场地池键」分组，规则见 poolKeyOf。
 *
 * 【为什么排序必须与界面一致】
 * 场号是给人看的（「你去 2 号场」），界面上的行序就是管理员心里的赛程顺序。
 * 若分配用的次序与签表排序不同，第一批的场号就会落在看起来靠后的比赛上。
 * 所以 compareForCourt 与 events-view 的签表排序共用 constants.stageOrder。
 *
 * 【为什么必须可重入】
 * 下一轮比赛是「只补不覆盖」地生成的，分配会被重算。算法只依赖「有序列表
 * + N」，与读库顺序无关，重算结果必然一致——这是硬约束，不是优化。
 * ============================================================
 */

const { BRACKET_STAGE, COURT_LIMITS, stageOrder } = require('../utils/constants.js');

/** 取整数，非数字一律当 0（用于排序键，不用于校验） */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 场地池键：同一个池内的比赛共用同一批场地，池间互不影响。
 *
 * | stage                          | 池键          | 理由 |
 * |--------------------------------|---------------|------|
 * | main / bronze / placement / gf | `ko\|{round}` | 同属一棵淘汰树。同轮的决赛与季军赛通常同时开打，必须共享场地池，否则两场比赛会同时拿到 1 号场 |
 * | wb / lb                        | `{stage}\|{round}` | 双败的两个区各自从 round=1 重新计数，混在一起会把胜者组第 1 轮与败者组第 1 轮误当成同一批 |
 * | group                          | `group\|{round}` | 各组同轮次通常同时开打，故跨组合并成一个池 |
 *
 * @param {Object} match 比赛或学院赛大场记录（读 stage / round / group）
 * @returns {string}
 */
function poolKeyOf(match) {
  const stage = (match && match.stage) || BRACKET_STAGE.MAIN;
  const round = num(match && match.round);

  if (stage === BRACKET_STAGE.GROUP) return `group|${round}`;
  if (stage === BRACKET_STAGE.WINNERS || stage === BRACKET_STAGE.LOSERS) {
    return `${stage}|${round}`;
  }
  return `ko|${round}`;
}

/**
 * 池内排序：阶段 → 组号 → 轮次 → 签位 → `_id`。
 *
 * 池键已经含 round（部分池还含 stage / group），所以池内这几项其实是常量，
 * 排序实际由 slot 决定。仍然把它们全写进比较式，是为了让这个函数在任何
 * 输入下都是**全序**：即使将来有人拿它去排跨池的列表，结果也稳定可复现。
 * 末位用 `_id` 兜底，与 match-order.compareMatchOrder 同一手法——比较式必须能
 * 分出胜负，否则排序结果取决于输入顺序，分配就不可重入了。
 *
 * `_id` 用 `<` 比较而不是 localeCompare：后者受运行时语言环境影响，同一份
 * 数据在不同机器上可能排出不同结果。
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareForCourt(a, b) {
  const byStage = stageOrder(a && a.stage) - stageOrder(b && b.stage);
  if (byStage !== 0) return byStage;

  const byGroup = num(a && a.group) - num(b && b.group);
  if (byGroup !== 0) return byGroup;

  const byRound = num(a && a.round) - num(b && b.round);
  if (byRound !== 0) return byRound;

  const bySlot = num(a && a.slot) - num(b && b.slot);
  if (bySlot !== 0) return bySlot;

  const keyA = String((a && a._id) || '');
  const keyB = String((b && b._id) || '');
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}

/**
 * 把场地数收敛成一个可用的正整数。
 *
 * 发布表单已经校验过 1..MAX，这里再兜一次是因为分配会在云端生成比赛时跑，
 * 而历史赛事没有 courtCount 字段（读到的是 undefined）。此时按 1 块场地
 * 分配——所有比赛都去 1 号场，与「没有场地信息」的现状最接近，也不会让
 * 签表生成整个失败。上限同样收口，保证 courtNo ≤ courtCount 恒成立。
 *
 * @param {number|string} value
 * @returns {number}
 */
function normalizeCourtCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < COURT_LIMITS.MIN) return COURT_LIMITS.MIN;
  return Math.min(Math.trunc(number), COURT_LIMITS.MAX);
}

/**
 * 给一批比赛分配场号。
 *
 * 输入不必是同一个池——内部会按 poolKeyOf 自行分组，各路互不干扰。这样
 * 调用方（抽签、推进轮次、学院赛）都不必先想清楚「哪些算同一轮」，把整批
 * 生成的结果直接丢进来即可。
 *
 * 返回值与入参**逐位对齐**（第 i 项对应 matches[i]），调用方可以按原下标
 * 回填；不改动入参。
 *
 * @param {Array<Object>} matches 比赛 / 大场列表
 * @param {number} courtCount 可用场地总数
 * @returns {Array<{courtNo:number, wave:number}>} 与 matches 等长
 */
function planCourts(matches, courtCount) {
  const list = Array.isArray(matches) ? matches : [];
  const size = normalizeCourtCount(courtCount);

  // 先按池收拢下标，池内再排序——排序只影响池内次序，不跨池
  const pools = new Map();
  list.forEach((match, index) => {
    const key = poolKeyOf(match);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(index);
  });

  // 占位符不会被读到：每个下标必属于恰好一个池，下面都会覆写
  const result = list.map(() => ({ courtNo: 0, wave: 1 }));

  pools.forEach((indexes) => {
    indexes.sort((left, right) => compareForCourt(list[left], list[right]));
    indexes.forEach((matchIndex, order) => {
      result[matchIndex] = {
        courtNo: (order % size) + 1,
        wave: Math.floor(order / size) + 1,
      };
    });
  });

  return result;
}

/**
 * 按分配结果回填场号，返回新对象，不改入参。
 *
 * @param {Array<Object>} matches
 * @param {number} courtCount
 * @returns {Array<Object>}
 */
function withCourts(matches, courtCount) {
  const list = Array.isArray(matches) ? matches : [];
  const plan = planCourts(list, courtCount);
  return list.map((match, index) => ({ ...match, courtNo: plan[index].courtNo }));
}

module.exports = {
  poolKeyOf,
  compareForCourt,
  normalizeCourtCount,
  planCourts,
  withCourts,
};
