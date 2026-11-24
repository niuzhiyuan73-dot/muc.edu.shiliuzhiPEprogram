/**
 * 比赛链序比较器（Elo 逐场结算改造：从旧回放引擎中提取）
 * ============================================================
 * 【谁还在用】
 * rating-cap.js 的额度计算按「回放同款顺序」逐场推进，额度占满的判定必须
 * 与结算顺序同源。旧回放引擎（replay.js）删除后，这个比较器独立成模块——
 * 不得为了一个 comparator 保留整套回放（交接文档 §9.2）。
 *
 * 【为什么不能只比时间】
 * 一场赛事的全部签表比赛共用同一个 matchTime（抽签时统一取 event.startTime），
 * 所以「时刻相同」是常态而不是边角。而 Array#sort 只保证稳定——平局时保留
 * 入参顺序。入参顺序从哪来？云端是数据库的翻页扫描，没有任何顺序保证。
 * 于是同一批数据、两次读取可能给出不同的次序。这是「查不出来」的一类错误，
 * 必须堵死。
 *
 * 【平局时按什么排】
 *   1. 同一张签表内先比轮次——下一轮的人正是本轮打上来的，顺序反了就错；
 *   2. 小组赛整段排在淘汰赛之前（小组赛喂出淘汰赛的对阵）；
 *   3. 同轮内先胜者组、后败者组、最后总决赛，让双败的轮次正确交错；
 *   4. 还平就比签位、比编号，保证任意两条记录都有确定的先后（全序）。
 *
 * 【为什么不比较「谁先被创建」】
 * 台账里没有可靠的创建序（云端翻页顺序本身就不稳），拿它当依据等于把
 * 不确定性再引回来。签位与编号都是确定性的，够用。
 * ============================================================
 */

const { BRACKET_STAGE } = require('../../shared/utils/constants.js');

/** 阶段在同一时刻内的先后：胜者组先于败者组，总决赛最后。 */
const STAGE_TIEBREAK = {
  [BRACKET_STAGE.WINNERS]: 0,
  [BRACKET_STAGE.MAIN]: 0,
  [BRACKET_STAGE.BRONZE]: 0,
  [BRACKET_STAGE.PLACEMENT]: 0,
  [BRACKET_STAGE.LOSERS]: 1,
  [BRACKET_STAGE.GRAND_FINAL]: 2,
};

/** 取一个可比较的数字，缺失 / 非法一律给 fallback */
function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 比赛链序的全序比较器：时间 → 赛事范围 → 阶段 → 轮次 → 组别 → 签位 → 编号。
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareMatchOrder(a, b) {
  const timeA = new Date(a && a.matchTime).getTime();
  const timeB = new Date(b && b.matchTime).getTime();
  // 时间缺失 / 非法的排到最后，且彼此之间仍由后面的字段定序
  const ta = Number.isFinite(timeA) ? timeA : Infinity;
  const tb = Number.isFinite(timeB) ? timeB : Infinity;
  if (ta !== tb) return ta - tb;

  // 不属于同一张签表的（含日常约球）互不依赖，给一个确定的次序即可
  const scopeA = (a && (a.eventId || a.collegeEventId)) || '';
  const scopeB = (b && (b.eventId || b.collegeEventId)) || '';
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;

  const groupA = a && a.stage === BRACKET_STAGE.GROUP ? 0 : 1;
  const groupB = b && b.stage === BRACKET_STAGE.GROUP ? 0 : 1;
  if (groupA !== groupB) return groupA - groupB;

  const roundA = numOr(a && a.round, -1);
  const roundB = numOr(b && b.round, -1);
  if (roundA !== roundB) return roundA - roundB;

  const stageA = STAGE_TIEBREAK[a && a.stage];
  const stageB = STAGE_TIEBREAK[b && b.stage];
  const sa = stageA === undefined ? 0 : stageA;
  const sb = stageB === undefined ? 0 : stageB;
  if (sa !== sb) return sa - sb;

  const slotA = numOr(a && a.slot, -1);
  const slotB = numOr(b && b.slot, -1);
  if (slotA !== slotB) return slotA - slotB;

  const idA = String((a && a._id) || '');
  const idB = String((b && b._id) || '');
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

/** 把比赛按链序升序排列（新数组，不改入参）。 */
function sortMatchOrder(matches) {
  return [...matches].sort(compareMatchOrder);
}

module.exports = { compareMatchOrder, sortMatchOrder };
