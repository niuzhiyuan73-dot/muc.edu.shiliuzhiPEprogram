/**
 * 排行榜排序与名次计算
 * ============================================================
 * 策划书 4.4 节的要求：等级分相同时，依次比较总胜率、总胜场数、
 * 最近一场比赛时间，确保名次唯一（不出现两人并列第 5 名的情况）。
 *
 * 排序规则（优先级从高到低）：
 *   1. 等级分降序
 *   2. 胜率降序
 *   3. 总胜场数降序
 *   4. 最近一场比赛时间较早者靠前（同等成绩下先达到者排前，更公平）
 *   5. 用户 ID 升序（兜底，保证顺序绝对稳定）
 * ============================================================
 */

const { getPoolRating } = require('./rating.js');
const { RANK_PROJECT_CONFIG, RATING_POOL, isRankable } = require('./constants.js');
const { compareCode } = require('./text-order.js');

/** 长时间未参赛而被标记为「不活跃」的天数阈值 */
const INACTIVE_DAYS = 90;

/**
 * 「分数尚未收敛」的场次门槛：少于该场次标记为「定级中」。
 *
 * 这是展示层的统计判据，与比赛用多大的 K 无关——日常 K 早已统一为 16，
 * 不再有谁前几场用大 K 的说法。但一个人只打了两三场，分数确实还压在
 * 初始分附近、说明不了水平，榜上标注出来仍是必要的。
 */
const PROVISIONAL_MATCH_COUNT = 10;

/**
 * 计算胜率。总场次为 0 时返回 0，避免除以零得到 NaN。
 *
 * @param {number} wins
 * @param {number} losses
 * @returns {number} 胜率，区间 [0, 1]
 */
function winRate(wins, losses) {
  const total = wins + losses;
  return total === 0 ? 0 : wins / total;
}

/**
 * 把用户列表排序并写入名次。
 *
 * 【重要】本函数不修改传入的数组，返回全新数组。
 * 纯函数是这个模块能在测试中被反复调用的前提。
 *
 * @param {Array<Object>} players 用户列表，元素需含：
 *        { _id, nickName, elo, points, wins, losses, lastMatchTime }
 * @param {Object} [options]
 * @param {'elo'|'points'} [options.sortBy='elo'] 排序依据
 * @param {number} [options.now=Date.now()] 当前时间戳，用于判定不活跃，便于测试注入
 * @returns {Array<Object>} 排序后并附加 rank、winRate、status 的新数组
 */
function buildLeaderboard(players, { sortBy = 'elo', now = Date.now() } = {}) {
  if (!Array.isArray(players)) {
    throw new Error('players 必须是数组');
  }

  const enriched = players.map((player) => {
    const wins = player.wins || 0;
    const losses = player.losses || 0;
    const matchCount = wins + losses;
    const rate = winRate(wins, losses);

    let status = 'active';
    if (matchCount < PROVISIONAL_MATCH_COUNT) {
      status = 'provisional'; // 定级中：分数尚未收敛，榜单上单独标注
    } else if (player.lastMatchTime) {
      const idleDays = (now - new Date(player.lastMatchTime).getTime()) / 86400000;
      if (idleDays > INACTIVE_DAYS) {
        status = 'inactive'; // 长期未参赛：保留等级分，但标注出来
      }
    }

    return { ...player, wins, losses, matchCount, winRate: rate, status };
  });

  enriched.sort((a, b) => {
    // 1. 主排序字段
    if (sortBy === 'points') {
      if (b.points !== a.points) return b.points - a.points;
    } else if (b.elo !== a.elo) {
      return b.elo - a.elo;
    }

    // 2. 胜率降序
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;

    // 3. 总胜场数降序
    if (b.wins !== a.wins) return b.wins - a.wins;

    // 4. 最近比赛时间较早者靠前
    const timeA = a.lastMatchTime ? new Date(a.lastMatchTime).getTime() : Infinity;
    const timeB = b.lastMatchTime ? new Date(b.lastMatchTime).getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;

    // 5. ID 兜底，保证排序结果稳定（同样的输入永远得到同样的顺序）
    return compareCode(a._id, b._id);
  });

  // 写入名次。注意：名次是连续的，不因等级分相同而并列。
  return enriched.map((player, index) => ({ ...player, rank: index + 1 }));
}

/**
 * 计算胜率变化趋势：比较最近 N 场与之前 N 场的胜率差值。
 * 用于个人中心展示「最近状态上升/下滑」。
 *
 * @param {Array<{isWin: boolean}>} matchesDesc 按时间倒序的比赛记录
 * @param {number} [windowSize=5] 窗口大小
 * @returns {{recentRate: number, previousRate: number, trend: 'up'|'down'|'flat'}|null}
 *          数据不足时返回 null
 */
function calculateTrend(matchesDesc, windowSize = 5) {
  // windowSize 必须是个正数。为 0 时两个窗口都是空数组，胜率算成 0/0=NaN，
  // 下面的大小比较全为假，于是 trend 悄悄变成 'flat'，而 recentRate /
  // previousRate 带着 NaN 一路渲染到页面上。负数的 slice 语义更是另一回事。
  if (!Array.isArray(matchesDesc) || !(windowSize > 0)) {
    return null;
  }
  if (matchesDesc.length < windowSize * 2) {
    return null;
  }

  const recent = matchesDesc.slice(0, windowSize);
  const previous = matchesDesc.slice(windowSize, windowSize * 2);

  const rateOf = (list) => list.filter((m) => m.isWin).length / list.length;
  const recentRate = rateOf(recent);
  const previousRate = rateOf(previous);
  const diff = recentRate - previousRate;

  let trend = 'flat';
  if (diff > 0.001) trend = 'up';
  else if (diff < -0.001) trend = 'down';

  return {
    recentRate: Number(recentRate.toFixed(4)),
    previousRate: Number(previousRate.toFixed(4)),
    trend,
  };
}

/* ============================================================
 * 分池榜单与分项目榜单
 * ============================================================
 * 单打和双打各自独立计分，榜单必须分开生成。做法是先把 user 在某个池里
 * 的分数「摊平」成通用结构，再交给已有的 buildLeaderboard 排序——
 * 排序逻辑只写一次。
 *
 * 【池与项目的区别】
 *   池   —— 计算口径。单打是一个池，男女选手的分数都在里面。
 *   项目 —— 展示口径。男单榜 = 单打池里的男生，女单榜 = 单打池里的女生。
 * 一张榜单永远是「先按项目筛人，再按池取分」。两者分开的好处是
 * 男单榜和女单榜取自同一个池，两张榜上的分数可以直接比较。
 * ============================================================ */

/**
 * 把用户在指定池中的分数摊平成排行榜需要的扁平结构。
 *
 * @param {Object} user 用户对象（含 ratings 多池结构）
 * @param {string} pool 池名
 * @returns {Object} { _id, nickName, avatarUrl, elo, wins, losses, matchCount, lastMatchTime, points }
 */
function extractPoolStats(user, pool) {
  const bucket = getPoolRating(user, pool);

  return {
    _id: user._id,
    nickName: user.nickName,
    avatarUrl: user.avatarUrl,
    elo: bucket.elo,
    wins: bucket.wins,
    losses: bucket.losses,
    matchCount: bucket.matchCount,
    lastMatchTime: bucket.lastMatchTime,
    // 积分是所有项目统一累计的，不区分池
    points: user.points || 0,
    // 注意：这里只挑展示需要的字段，绝不把整个 user 对象挂上去。
    // 榜单会经 getLeaderboard / getHomeSummary 原样下发给客户端，
    // 而 user 里带着 phone、studentId、openId 等隐私字段——挂上它
    // 等于把全站会员的隐私暴露给任意访客（首页概览连登录都不需要）。
  };
}

/**
 * 生成某个池的排行榜。
 *
 * @param {Array<Object>} users 用户列表
 * @param {string} pool 池名
 * @param {Object} [options] 同 buildLeaderboard 的可选项
 * @returns {Array<Object>} 已排序并带 rank 的榜单
 *
 * @example
 * buildPoolLeaderboard(users, RATING_POOL.DOUBLES)
 */
function buildPoolLeaderboard(users, pool, options = {}) {
  if (!Array.isArray(users)) {
    throw new Error('users 必须是数组');
  }
  return buildLeaderboard(
    // 离校的人不上榜（决策 8）。挡在这里而不是挡在排序里：他的分数没有
    // 问题，只是不该占着名次；排掉之后名次自动连续，不用另做补位。
    users.filter((user) => isRankable(user)).map((user) => extractPoolStats(user, pool)),
    options
  );
}

/**
 * 把排行榜项目解析成「取哪个池的分数 + 只保留哪个性别」。
 *
 * @param {string} project 项目名，取值见 constants.RANK_PROJECT
 * @returns {{pool: string, gender: string|null}}
 * @throws {Error} 项目名非法时抛出
 */
function resolveProject(project) {
  const config = RANK_PROJECT_CONFIG[project];
  if (!config) {
    throw new Error(`未知的排行榜项目：${project}`);
  }
  return config;
}

/**
 * 挑出属于某个排行榜项目的会员。
 *
 * 女单榜只留女生、男单榜只留男生，双打榜不做性别过滤。
 * 注意这里筛的是「人」，不是分数——被筛掉的人不是没分，而是不该出现在
 * 这张榜上（比如男生的分数不该出现在女单榜里）。
 *
 * @param {Array<Object>} users 用户列表，需含 gender
 * @param {string} project
 * @returns {Array<Object>}
 */
function selectProjectUsers(users, project) {
  if (!Array.isArray(users)) {
    throw new Error('users 必须是数组');
  }
  const { gender } = resolveProject(project);
  // 离校的人不上榜。这一条与性别过滤是两码事：性别不符的人只是不在这张
  // 榜上，离校的人是不该在任何一张榜上——所以先按在册状态筛一道。
  const eligible = users.filter((user) => isRankable(user));
  return gender ? eligible.filter((user) => user.gender === gender) : eligible;
}

/**
 * 生成某个排行榜项目的榜单。
 *
 * @param {Array<Object>} users 用户列表
 * @param {string} project 项目名
 * @param {Object} [options] 同 buildLeaderboard 的可选项
 * @returns {Array<Object>} 已排序并带 rank 的榜单
 *
 * @example
 * buildProjectLeaderboard(users, RANK_PROJECT.WOMEN_SINGLES);
 */
function buildProjectLeaderboard(users, project, options = {}) {
  const { pool } = resolveProject(project);
  return buildPoolLeaderboard(selectProjectUsers(users, project), pool, options);
}

/**
 * 排一下「我的项目」在各页面上的先后。
 *
 * getMyProjects 是「出场多的在前」，但双打一场四个人，场次天然比单打多，
 * 于是双打总是压过单打，页面一打开看到的便是双打。多数人却是从单打入门的，
 * 先看到单打更符合直觉，所以这里只重排展示顺序：单打在左，其余按出场次数。
 *
 * 注意这只是展示口径——比赛流水、排名那些数据口径仍由各接口决定，
 * 改这里的顺序不会动到任何分数。
 *
 * @param {Array<Object>} projects getMyProjects 的结果（含 pool、matchCount）
 * @returns {Array<Object>} 新的数组，不改动入参
 */
function sortProjectsForDisplay(projects) {
  const list = Array.isArray(projects) ? [...projects] : [];
  const rank = (item) => (item.pool === RATING_POOL.SINGLES ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || b.matchCount - a.matchCount);
}

/* ============================================================
 * 进步榜
 * ============================================================
 * 【为什么需要】
 * 等级分是零和体系，封闭池里总分恒定。这意味着「所有人都涨分」
 * 是不可能发生的——如果人人都涨，那说明分数在通胀，排名就失去意义。
 *
 * 但会员确实需要「我进步了」的反馈。解决办法不是篡改等级分，
 * 而是换一把尺子：单独做一个按「赛季内等级分涨幅」排序的榜单。
 * 它从同一份数据派生，完全不影响等级分的零和性质。
 *
 * 就像体重不变但体脂率下降——需要的是另一把尺子，不是改体重秤。
 * ============================================================ */

/**
 * 生成进步榜。
 *
 * @param {Array<Object>} entries 条目列表，每项需含：
 *        { _id, nickName, avatarUrl, startElo, currentElo, matchCount }
 *        其中 startElo 为赛季初快照，currentElo 为当前分数。
 * @param {Object} [options]
 * @param {number} [options.minMatches=5] 至少打满多少场才上榜。
 *        这个门槛的意义：只打两场就涨 40 分多半是运气而非进步，
 *        放进榜单会伤害公信力。
 * @param {number} [options.limit] 只取前 N 名
 * @returns {Array<Object>} 按涨幅降序排列，附加 delta 与 rank
 *
 * @example
 * buildProgressLeaderboard([
 *   { _id: 'a', nickName: '小王', startElo: 1500, currentElo: 1680, matchCount: 20 },
 *   { _id: 'b', nickName: '小李', startElo: 1900, currentElo: 1920, matchCount: 20 },
 * ]);
 * // => 小王 +180 排第 1，小李 +20 排第 2
 */
function buildProgressLeaderboard(entries, options = {}) {
  const { minMatches = 5, limit } = options;

  if (!Array.isArray(entries)) {
    throw new Error('entries 必须是数组');
  }

  const qualified = entries
    .filter((e) => (e.matchCount || 0) >= minMatches)
    .map((e) => ({ ...e, delta: e.currentElo - e.startElo }));

  qualified.sort((a, b) => {
    // 1. 涨幅降序
    if (b.delta !== a.delta) return b.delta - a.delta;
    // 2. 涨幅相同时，当前分数高者靠前（同样涨 50 分，从 1400 涨到 1450 更难）
    if (b.currentElo !== a.currentElo) return b.currentElo - a.currentElo;
    // 3. ID 兜底，保证顺序稳定
    return compareCode(a._id, b._id);
  });

  const ranked = qualified.map((e, index) => ({ ...e, rank: index + 1 }));
  return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
}

/**
 * 从一份已经排好序的榜单上读百分位。
 *
 * 返回的 beatPercent 语义是「超过了百分之多少的会员」。
 * 这比绝对分数直观得多——新人看不懂 1150 分是什么水平，
 * 但一看「超过了 72% 的会员」立刻就明白了。
 *
 * 【为什么与 calculatePercentile 分成两个】
 * calculatePercentile 的入参是「未排序的摊平数据」，它自己会先 buildLeaderboard
 * 再算百分位。但榜单接口手上往往已经有一份排好序的榜（buildProjectLeaderboard
 * 的产物），若再喂给 calculatePercentile，等于把整张榜重排一遍。分开之后，
 * 手上已有榜单的调用方直接走这里：结果一字不差，省掉一次 O(n log n) 排序
 * （getMyProjects 要按项目循环，一个页面就省下好几次）。
 *
 * @param {Array<Object>} board 已排序并带 rank 的榜单
 * @param {string} targetId 目标会员的 _id
 * @returns {{rank:number, total:number, beatCount:number, beatPercent:number}|null}
 *          目标不在榜单中时返回 null
 */
function percentileFromBoard(board, targetId) {
  if (!Array.isArray(board)) {
    return null;
  }

  const index = board.findIndex((p) => p._id === targetId);
  if (index === -1) {
    return null;
  }

  const total = board.length;
  const rank = index + 1;
  const beatCount = total - rank;

  return {
    rank,
    total,
    beatCount,
    // 分母用 total 而非 total - 1：第 1 名显示「超过了 99% 的会员」
    // 比「超过了 100% 的会员」更符合直觉
    beatPercent: total === 0 ? 0 : Number(((beatCount / total) * 100).toFixed(1)),
  };
}

/**
 * 计算某位会员在榜单中的百分位。
 *
 * @param {Array<Object>} players 已摊平的榜单数据（与 buildLeaderboard 输入一致）
 * @param {string} targetId 目标会员的 _id
 * @param {Object} [options] 同 buildLeaderboard 的可选项
 * @returns {{rank:number, total:number, beatCount:number, beatPercent:number}|null}
 *          目标不在榜单中时返回 null
 */
function calculatePercentile(players, targetId, options = {}) {
  return percentileFromBoard(buildLeaderboard(players, options), targetId);
}

module.exports = {
  INACTIVE_DAYS,
  PROVISIONAL_MATCH_COUNT,
  winRate,
  buildLeaderboard,
  calculateTrend,
  extractPoolStats,
  buildPoolLeaderboard,
  resolveProject,
  selectProjectUsers,
  buildProjectLeaderboard,
  buildProgressLeaderboard,
  calculatePercentile,
  percentileFromBoard,
  sortProjectsForDisplay,
};
