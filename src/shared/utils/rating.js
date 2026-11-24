/**
 * 多池等级分状态管理
 * ============================================================
 * 【三层分工】
 *   elo.js        —— 数学层：给定分数，算出变动量是多少
 *   rating.js     —— 状态层：管好每位会员在各个池里的分数（本文件）
 *   leaderboard.js—— 展示层：排序、名次、榜单
 *
 * 这样分层的好处是：算法怎么改都不会影响数据结构，
 * 加一个新池也不会碰算法代码。
 *
 * 【数据结构】
 *   user.ratings = {
 *     singles: { elo, matchCount, wins, losses, lastMatchTime },
 *     doubles: { ... },
 *   }
 *
 * 每个池完全独立。打一场双打，只动 doubles，单打的分数纹丝不动。
 *
 * 【为什么单打只有一个池】
 * 男女单打合并成同一个池计算：男女会员之间存在互相交手的情况，
 * 若拆成两个池，跨性别那几场就没有归属，分数也无法互相比较。
 * 排行榜上再按性别拆出「男单榜」「女单榜」，那只是展示口径，
 * 底层取的是同一个池的分数。
 *
 * 【不可变原则】
 * 本文件所有更新函数都返回新对象，不修改传入的 user。
 * 这在云函数里尤其重要——避免并发写同一份数据导致分数错乱。
 * ============================================================
 */

const { ALL_RATING_POOLS, RATING_POOL } = require('./constants.js');
const { DEFAULT_CONFIG, initialRatingFor } = require('./elo.js');

/**
 * 创建一个空白的池分数记录。
 *
 * @param {number} [initialElo] 初始等级分，默认取算法配置中的初始值
 * @returns {{elo:number, startElo:number, matchCount:number, wins:number, losses:number, lastMatchTime:Date|null}}
 */
function createEmptyPoolRating(initialElo = DEFAULT_CONFIG.initialRating) {
  return {
    elo: initialElo,
    // 入池起点分。进步榜靠它算「这一路涨了多少分」。
    // 必须与 elo 分开存：elo 每场都在变，起点必须留痕才追得回来。
    startElo: initialElo,
    matchCount: 0,
    wins: 0,
    losses: 0,
    lastMatchTime: null,
  };
}

/**
 * 为一位新会员创建全部池的初始分数。
 *
 * @param {Object} [options]
 * @param {number} [options.initialElo] 初始等级分。传动态初始分即可实现
 *        「新人按当前俱乐部中位数入场」的规则。
 * @returns {Object} 以池名为键的分数对象
 *
 * @example
 * createEmptyRatings({ initialElo: 1650 })
 * // => { singles: {elo:1650,...}, doubles: {elo:1650,...} }
 */
function createEmptyRatings({ initialElo = DEFAULT_CONFIG.initialRating } = {}) {
  const ratings = {};
  for (const pool of ALL_RATING_POOLS) {
    ratings[pool] = createEmptyPoolRating(initialElo);
  }
  return ratings;
}

/**
 * 读取某位会员在指定池中的分数。
 *
 * 【容错设计】有两种情况会导致池数据缺失：
 *   1. 老会员的档案里没有后来新增的池
 *   2. 历史脏数据
 * 这时返回一份默认值，而不是抛错或返回 undefined，
 * 避免因为一条不完整的数据导致整个排行榜崩掉。
 *
 * @param {Object} user 用户对象
 * @param {string} pool 池名，取值见 RATING_POOL
 * @returns {Object} 该池的分数记录（始终是完整对象）
 */
function getPoolRating(user, pool) {
  const bucket = user && user.ratings && user.ratings[pool];
  // 缺失的池按性别补起点分（男 1450 / 女 1300），与回放给新会员定级的口径一致。
  // 【为什么不能统一按 1450 补】女会员的定级分本就低 150，档案里一旦缺了这个池
  // （老数据、后来新增的池），统一补 1450 会让她凭空高出 150 分，榜上排位失真。
  const blank = createEmptyPoolRating(initialRatingFor(user && user.gender));
  if (!bucket) return blank;
  // 补齐可能缺失的字段，防止老数据缺字段导致后续计算得到 NaN。
  // 只让 bucket 里「有值」的字段覆盖默认值：直接 spread 会让 bucket 中
  // 存在但为 null/undefined 的键（如 elo:null）盖掉默认分，把等级分算到 0 附近。
  const merged = { ...blank };
  for (const key of Object.keys(bucket)) {
    if (bucket[key] !== undefined && bucket[key] !== null) merged[key] = bucket[key];
  }
  return merged;
}

/**
 * 把一场比赛的结果应用到某位会员的某个池上。
 *
 * @param {Object} params
 * @param {Object} params.user 用户对象
 * @param {string} params.pool 池名
 * @param {number} params.delta 等级分变动量（由 elo.js 算出）
 * @param {boolean} params.isWin 是否获胜
 * @param {Date} params.matchTime 比赛时间
 * @returns {Object} 更新后的 ratings 对象（新对象，不修改原 user）
 */
function applyMatchResult({ user, pool, delta, isWin, matchTime }) {
  const current = getPoolRating(user, pool);

  // 【注意】先展开 current 再覆盖，不要只罗列这几个字段。
  // 只罗列会把 startElo 之类的附加字段悄悄丢掉，而且这种丢失
  // 在写下的当时完全看不出来，等进步榜算出一片 NaN 才会暴露。
  const updated = {
    ...current,
    elo: current.elo + delta,
    matchCount: current.matchCount + 1,
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    lastMatchTime: matchTime || current.lastMatchTime,
  };

  // 保留其它池的原值，只替换目标池
  const base = (user && user.ratings) || createEmptyRatings();
  return { ...base, [pool]: updated };
}

/**
 * 判断某位会员是否打过某个池。
 * 用于界面上决定「是否展示该池的分数」——从没打过双打的人，
 * 展示他的双打初始分没有意义，反而让人困惑。
 *
 * @param {Object} user
 * @param {string} pool
 * @returns {boolean}
 */
function hasPlayedPool(user, pool) {
  return getPoolRating(user, pool).matchCount > 0;
}

/**
 * 汇总一位会员在所有池中的总战绩。
 * 注意：这是「生涯总计」，仅用于个人主页展示，
 * 不参与任何池的排名计算（各池排名必须彼此独立）。
 *
 * @param {Object} user
 * @returns {{totalMatches:number, totalWins:number, totalLosses:number, winRate:number}}
 */
function summarizeCareer(user) {
  let totalMatches = 0;
  let totalWins = 0;
  let totalLosses = 0;

  for (const pool of ALL_RATING_POOLS) {
    const r = getPoolRating(user, pool);
    totalMatches += r.matchCount;
    totalWins += r.wins;
    totalLosses += r.losses;
  }

  return {
    totalMatches,
    totalWins,
    totalLosses,
    winRate: totalMatches === 0 ? 0 : totalWins / totalMatches,
  };
}

module.exports = {
  RATING_POOL,
  createEmptyPoolRating,
  createEmptyRatings,
  getPoolRating,
  applyMatchResult,
  hasPlayedPool,
  summarizeCareer,
};
