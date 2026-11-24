/**
 * 训练积分：事实归一、按赛季过滤与去重（纯计算）
 * ============================================================
 * 【积分唯一的来源是“事实”，不是一个可增减的余额】
 * 训练积分不直接改 `user.points`，而是从**已确认的报名记录**推导出一条事实：
 *   { sourceType: 'training', sourceId: trainingId, userId, amount: 1, effectiveAt }
 * 回放时把这些事实叠加到赛事积分之上。这样“取消训练 / 撤销确认 / 赛季重置”
 * 都只是改变了事实集合，总分自然重算，不会出现“减了又加、最后对不上”的账。
 *
 * 【归属赛季按训练发生时间（startAt），不按确认时间】
 * 确认可能发生在训练结束后、甚至跨到下一个赛季的前一刻；积分却应该记在
 * 训练**发生**的那个赛季。所以事实的 effectiveAt 取 `pointEffectiveAt`
 * （确认时从不可变的 training.startAt 复制而来），缺失时才退回训练的 startAt。
 *
 * 【为什么在最终结果上统一叠加】
 * 旧回放引擎内部跑两遍回放（先探定级、再正式算）。若把训练事实塞进某一遍
 * 的循环里，另一遍就会漏加或多加。因此事实只在两遍跑完之后、对最终结果叠加
 * **一次**。本模块的 apply 也因此必须幂等：
 * 同一份 users 与同一批 facts 反复调用只加一次。
 *
 * 【纯函数】
 * 不修改传入的 trainings / registrations / users，全部返回新对象。
 * ============================================================
 */

const { TRAINING_SIGNUP_STATUS, TRAINING_STATUS } = require('../../shared/utils/constants.js');

/** 一次成功确认的签到固定加 1 点（需求第 10 条） */
const TRAINING_POINT_AMOUNT = 1;
/** 事实来源标记：训练区别于赛事 */
const TRAINING_POINT_SOURCE = 'training';

/**
 * 签到状态。放在这里而不是 constants，是因为它只服务训练签到这一处状态机；
 * 与训练报名状态（registered/canceled）正交。
 */
const ATTENDANCE_STATUS = Object.freeze({
  NOT_SUBMITTED: 'not_submitted',
  PENDING: 'pending',
  REJECTED: 'rejected',
  CONFIRMED: 'confirmed',
});

/**
 * 把「已确认的报名记录」归一成训练积分事实。
 *
 * 只认同时满足三条的记录：
 *   1. 报名有效（signupStatus === registered）；
 *   2. 签到已确认（attendanceStatus === confirmed）；
 *   3. 对应训练存在且**未被取消**（取消训练使所有签到失效）。
 * 同一次训练、同一用户最多一条事实（registration 的稳定主键本就保证唯一，
 * 这里再用 userId|trainingId 去重，防脏数据重复计数）。
 *
 * @param {Object} params
 * @param {Array<Object>} [params.trainings] 训练主记录列表
 * @param {Array<Object>} [params.registrations] 报名记录列表
 * @returns {Array<{sourceType:string, sourceId:string, userId:string, amount:number, effectiveAt:(string|null)}>}
 */
function buildTrainingPointFacts({ trainings = [], registrations = [] } = {}) {
  const byId = new Map();
  for (const training of trainings) {
    if (training && training._id) byId.set(training._id, training);
  }

  const facts = [];
  const seen = new Set();
  for (const reg of registrations) {
    if (!reg) continue;
    if (reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) continue;
    if (reg.attendanceStatus !== ATTENDANCE_STATUS.CONFIRMED) continue;

    const training = byId.get(reg.trainingId);
    if (!training) continue;
    if (training.status === TRAINING_STATUS.CANCELED) continue;

    const dedupeKey = `${reg.userId}|${reg.trainingId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    facts.push({
      sourceType: TRAINING_POINT_SOURCE,
      sourceId: reg.trainingId,
      userId: reg.userId,
      amount: TRAINING_POINT_AMOUNT,
      effectiveAt: reg.pointEffectiveAt || training.startAt || null,
    });
  }
  return facts;
}

/**
 * 按赛季边界过滤事实。
 *
 * 边界为 `resetTime`：只有 `effectiveAt >= resetTime` 的事实算本赛季
 * （边界等于 resetTime 算新赛季，见规划 §6.3 第 3 条）。没有边界（从未重置）
 * 时统计全部。`effectiveAt` 缺失或非法的，在有边界时一律不计——宁可漏一个
 * 来路不明的事实，也不把旧赛季的分错记到新赛季。
 *
 * @param {Array<Object>} facts
 * @param {string|number|Date|null} resetTime
 * @returns {Array<Object>} 过滤后的新数组
 */
function factsInSeason(facts, resetTime) {
  if (!resetTime) return facts.slice();
  const resetMs = new Date(resetTime).getTime();
  if (!Number.isFinite(resetMs)) return facts.slice();
  return facts.filter(fact => {
    const at = new Date(fact.effectiveAt).getTime();
    return Number.isFinite(at) && at >= resetMs;
  });
}

/**
 * 把训练事实叠加到已回放的会员上（只动 `points`，不碰 ELO / 场数 / 胜率）。
 *
 * @param {Array<Object>} users 回放产出的会员副本（含 _id 与 points）
 * @param {Array<Object>} facts buildTrainingPointFacts 的产物
 * @param {Object} [options]
 * @param {string|number|Date|null} [options.resetTime] 赛季边界
 * @returns {Array<Object>} 新数组；未被命中的会员原样返回
 */
function applyTrainingPointFacts(users, facts, { resetTime = null } = {}) {
  const within = factsInSeason(Array.isArray(facts) ? facts : [], resetTime);
  const byUser = new Map();
  for (const fact of within) {
    byUser.set(fact.userId, (byUser.get(fact.userId) || 0) + Number(fact.amount || 0));
  }
  if (byUser.size === 0) return users;

  return users.map(user => {
    const gain = byUser.get(user._id);
    if (!gain) return user;
    return { ...user, points: Number(user.points || 0) + gain };
  });
}

module.exports = {
  TRAINING_POINT_AMOUNT,
  TRAINING_POINT_SOURCE,
  ATTENDANCE_STATUS,
  buildTrainingPointFacts,
  factsInSeason,
  applyTrainingPointFacts,
};
