/**
 * 学校维度：积分独立聚合（Elo 逐场结算改造）
 * ============================================================
 * 【为什么从回放里拆出来】
 * 旧体系的积分（赛事名次分 + 训练签到分）是在已删除的回放引擎内部结算的；
 * 旧回放删除后，积分改由**事实**独立聚合：赛事按「已结束 + 最终名次」、
 * 训练按「已确认签到」，各自产出积分事实，再按会员求和。积分与 Elo 彻底
 * 解耦——发积分不碰评级表，评级结算也不碰积分。
 *
 * 【与旧口径逐条对齐】（见 utils/points.js；旧 applyEventPoints 已随回放删除）
 *   · 只统计**已结束**的赛事；双打赛事不计分（决策 3）；
 *   · 赛事归属赛季按实际结束时间 finishedAt（缺失退回 endTime、再退回
 *     startTime），早于赛季分界点的不计入本赛季；
 *   · 无已确认小场但名次有效照样发分——积分认「名次」这件事本身；
 *   · 训练积分用 buildTrainingPointFacts / factsInSeason（同一把尺子）。
 *
 * 【pointDelta 的挂载】
 * 旧的「赛事分挂在该用户赛事最后一场」是派生展示位，不进不可变的 Elo
 * 快照。这里定义唯一挂载点：该用户在该赛事**结算序号最大**的计分小场。
 * 找不到可挂载的小场时，积分照发（在会员总分里），只是不挂到某一场上。
 * ============================================================
 */

const {
  calculateEventPoints,
} = require('../../shared/utils/points.js');
const {
  buildTrainingPointFacts, factsInSeason,
} = require('./training-points.js');
const {
  EVENT_STATUS, MATCH_TYPE, RATING_POOL,
} = require('../../shared/utils/constants.js');

/**
 * 一条赛事积分事实：谁、因哪场赛事、得多少分、按什么时间归赛季。
 * @typedef {{userId:string, eventId:string, amount:number, endedAt:string, level:number, placement:number}}
 */

/**
 * 从本范围赛事收集赛事积分事实。
 *
 * 只收「已结束 + 非双打 + 结束时间不早于赛季分界」的赛事；名次缺失的
 * 参赛者仍拿参与分（calculateEventPoints 对 placement 缺失给 0 名次分）。
 *
 * @param {Object} params
 * @param {Array<Object>} params.events 赛事列表（本范围）
 * @param {string|Date|null} [params.resetTime] 赛季分界点（null = 从未重置）
 * @returns {Array<Object>} 积分事实（含明细，供挂载与审计）
 */
function collectEventPointFacts({ events, resetTime = null }) {
  const resetMs = resetTime ? new Date(resetTime).getTime() : NaN;
  const resetApplies = Number.isFinite(resetMs);
  const facts = [];
  for (const event of events || []) {
    if (!event || event.status !== EVENT_STATUS.FINISHED) continue;
    // 双打赛事不计分（决策 3）
    const isDoubles =
      event.matchType === MATCH_TYPE.DOUBLES || event.pool === RATING_POOL.DOUBLES;
    if (isDoubles) continue;

    // 赛事什么时候结束以录入名次那一刻（finishedAt）为准；历史/种子赛事没有
    // finishedAt 时退回 endTime、再退回 startTime（与旧 applyEventPoints 同一优先级）。
    const endedAt = event.finishedAt || event.endTime || event.startTime;
    if (resetApplies) {
      const endedMs = new Date(endedAt).getTime();
      // 结束时间不可解析时不能当成「本赛季」：宁可跳过，也不要把来路不明的事实
      // 记进新赛季（第二十三轮审查 P1-18）。
      if (!Number.isFinite(endedMs) || endedMs < resetMs) continue;
    }

    for (const result of event.results || []) {
      if (!result || !result.userId) continue;
      const points = calculateEventPoints({
        placement: result.placement,
        level: event.level,
      });
      if (!(points.total > 0)) continue;
      facts.push({
        userId: result.userId,
        eventId: event._id,
        amount: points.total,
        endedAt: endedAt || null,
        level: event.level,
        placement: Number(result.placement) || 0,
      });
    }
  }
  return facts;
}

/**
 * 聚合一位会员的本赛季积分：赛事事实 + 赛季内训练事实。
 *
 * @param {Object} params
 * @param {Array<Object>} [params.events] 赛事列表
 * @param {Array<Object>} [params.trainings] 训练列表（本范围）
 * @param {Array<Object>} [params.trainingRegistrations] 训练报名记录（本范围）
 * @param {string|Date|null} [params.resetTime] 赛季分界点
 * @param {Array<{userId:string}>} [params.members] 只统计这些会员（可缺省）
 * @returns {Map<string,number>} userId → 本赛季积分
 */
function aggregatePoints({ events = [], trainings = [], trainingRegistrations = [], resetTime = null, members = null } = {}) {
  const wanted = Array.isArray(members) && members.length > 0
    ? new Set(members.map((m) => m.userId || m._id))
    : null;

  const totals = new Map();
  const add = (userId, amount) => {
    if (wanted && !wanted.has(userId)) return;
    totals.set(userId, (totals.get(userId) || 0) + Number(amount || 0));
  };

  for (const fact of collectEventPointFacts({ events, resetTime })) {
    add(fact.userId, fact.amount);
  }
  const trainingFacts = factsInSeason(
    buildTrainingPointFacts({ trainings, registrations: trainingRegistrations }),
    resetTime,
  );
  for (const fact of trainingFacts) {
    add(fact.userId, fact.amount);
  }
  return totals;
}

/**
 * 把赛事积分挂到该用户在该赛事**结算序号最大**的计分小场上
 * （「赛事分挂在最后一场」的确定化版本：以 settlementSeq 定「最后」，
 * 不按客户端比赛时间——补录的旧比赛 matchTime 早、但结算位置在最后）。
 *
 * 就地修改传入的 matches 数组元素（读取端的临时 DTO，不是库里的不可变快照）。
 *
 * @param {Array<Object>} matches 已按结算顺序排好的计分比赛（带 settlement.players）
 * @param {Array<Object>} eventFacts collectEventPointFacts 的产物
 */
function mountEventPointDeltas(matches, eventFacts) {
  for (const fact of eventFacts || []) {
    // 该用户在该赛事的最后一场：结算序号最大者（matches 已按结算顺序排列，
    // 从后往前找第一个命中即唯一挂载点）
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      if (match.eventId !== fact.eventId) continue;
      const player = (match.players || []).find((p) => p.userId === fact.userId);
      if (!player) continue;
      player.pointDelta = (player.pointDelta || 0) + fact.amount;
      break;
    }
  }
}

module.exports = {
  collectEventPointFacts,
  aggregatePoints,
  mountEventPointDeltas,
};
