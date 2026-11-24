/**
 * 个人战绩统计
 * ============================================================
 * 这些函数回答的是「我的」页面里的问题：
 *   - 我一共打了多少场？赢了几场？
 *   - 我和谁交过手？对谁赢得最多、输给谁最多？
 *   - 我和谁搭档胜率最高？
 *   - 我的分数这一路是怎么涨上来的？
 *   - 我参加过哪些比赛，拿了第几名？
 *
 * 【输入是什么】
 * 全部基于「带逐人明细」的比赛，也就是每场都带 players 的那种
 * （Elo 逐场结算改造后来自比赛上的结算快照）。明细里记着每个人赛前
 * 赛后的分数、加了几个积分，所以这里不必再算一遍算法，只做筛选、归并、排序。
 *
 * 【纯函数】
 * 不修改任何入参。所有排序都在副本上进行。
 * ============================================================
 */

const { ALL_RATING_POOLS } = require('./constants.js');

/**
 * 从一场比赛中抽出某位会员的视角。
 *
 * 返回他站在哪一边、搭档是谁、对手是谁、赢了没有、
 * 这一场分数和积分各变了多少。他是「我」的页面里最基础的一块砖。
 *
 * 对 players 明细做了兼容：理论上所有比赛都该带明细，但真实运行中
 * 可能遇到只存了 teamA/teamB 的老数据，这时退化为按 winner 字段判断胜负，
 * 只是拿不到具体的分数变动。
 *
 * @param {Object} match 比赛记录
 * @param {string} userId 会员编号
 * @returns {Object|null} 该会员没参加这场比赛时返回 null
 */
function viewMatch(match, userId) {
  if (!match) return null;

  const teamA = match.teamA || [];
  const teamB = match.teamB || [];
  const detail = (match.players || []).find((p) => p.userId === userId);

  const inA = teamA.includes(userId);
  const inB = teamB.includes(userId);
  if (!detail && !inA && !inB) return null;

  const side = detail ? detail.side : inA ? 'A' : 'B';
  const myTeam = side === 'A' ? teamA : teamB;
  const otherTeam = side === 'A' ? teamB : teamA;

  return {
    matchId: match._id,
    matchTime: match.matchTime,
    matchType: match.matchType,
    pool: detail ? detail.pool : match.pool,
    eventId: match.eventId || null,
    // 赛制要跟着逐场明细一起走：脱离赛制就看不出 11:9（或 6:4）到底打完没有，
    // 一场 21 分制的比赛和一局 11 分制的比赛，同样的数字含义完全不同。
    // 网球多一层「盘」，所以赛制字段整组带出（见 match-format.formatOfRecord）。
    gamePoints: match.gamePoints,
    bestOf: match.bestOf,
    scoring: match.scoring || 'point',
    setGames: match.setGames,
    tiebreakAt: match.tiebreakAt,
    tiebreakPoints: match.tiebreakPoints,
    noAd: match.noAd === true,
    side,
    isWin: detail ? detail.isWin : match.winner === side,
    eloBefore: detail ? detail.eloBefore : null,
    eloAfter: detail ? detail.eloAfter : null,
    eloDelta: detail ? detail.eloDelta : null,
    pointDelta: detail ? detail.pointDelta : null,
    // 结算快照原样带出（若有）：走势按结算序号连链、页面解释「这场为什
    // 么算 / 不算分」都要用它（Elo 逐场结算改造）
    settlement: match.settlement || null,
    partnerIds: myTeam.filter((id) => id !== userId),
    opponentIds: [...otherTeam],
    // 统一成「我方 : 对方」的顺序，页面直接渲染即可，不必再关心 A/B
    score: side === 'A'
      ? { mine: match.scoreA, theirs: match.scoreB }
      : { mine: match.scoreB, theirs: match.scoreA },
    // 抢七小分同样要跟着视角翻转：a/b 在记录里是 A/B 的，翻到「我方」这一侧
    // 之后 formatScore 才能把括号标在正确的一方身上
    tiebreaks: (Array.isArray(match.tiebreaks) ? match.tiebreaks : []).map((item) => (
      side === 'A'
        ? { ...item }
        : { setIndex: item.setIndex, a: item.b, b: item.a }
    )),
    location: match.location || '',
  };
}

/**
 * 找出某位会员参加过的全部比赛（保持原顺序）。
 *
 * @param {Array<Object>} matches
 * @param {string} userId
 * @returns {Array<Object>} viewMatch 的结果数组
 */
function findPlayerMatches(matches, userId) {
  if (!Array.isArray(matches)) {
    throw new Error('matches 必须是数组');
  }
  const result = [];
  for (const match of matches) {
    const view = viewMatch(match, userId);
    if (view) result.push(view);
  }
  return result;
}

/**
 * 创建一个「编号 → 昵称」的查询函数。
 *
 * 让调用方把用户列表交给它，统计函数就不必自己认识用户结构，
 * 保持 stats.js 只关心比赛数据。
 *
 * @param {Array<Object>} users
 * @returns {Function} (userId) => 昵称，查不到时原样返回编号
 */
function createNameResolver(users) {
  const map = new Map();
  for (const user of users || []) {
    map.set(user._id, user.nickName || user._id);
  }
  return (userId) => map.get(userId) || userId;
}

/** 保证 nameOf 一定是可调用的函数 */
function normalizeNameOf(nameOf) {
  return typeof nameOf === 'function' ? nameOf : (id) => id;
}

/**
 * 按等级分池筛选比赛。
 * 不传 pool 时原样返回，调用方不必写 if。
 *
 * @param {Array<Object>} views viewMatch 的结果数组
 * @param {string} [pool]
 * @returns {Array<Object>}
 */
function filterByPool(views, pool) {
  return pool ? views.filter((view) => view.pool === pool) : views;
}

/**
 * 统计与每位对手的交锋记录。
 *
 * 【双打怎么算】
 * 一场双打有两位对手，两人各记一次。也就是说「交手 5 次」指的是
 * 有 5 场比赛的对面站着这个人，而不是 5 个独立的对手关系。
 * 对社团内部的「克星榜」来说，这个口径最直观。
 *
 * 【按池筛选】
 * 传了 pool 就只统计该池的交手。默认不限池，跨项目合并统计。
 * 个人主页的池切换靠这个参数实现。
 *
 * @param {Array<Object>} matches 回放后的比赛流水
 * @param {string} userId
 * @param {Object} [options]
 * @param {Function} [options.nameOf] 昵称解析函数
 * @param {number} [options.minMatches=1] 最少交手场次
 * @param {string} [options.pool] 只看某个池
 * @returns {Array<Object>} 按交手场次降序排列
 */
function buildHeadToHead(matches, userId, options = {}) {
  const { nameOf, minMatches = 1, pool } = options;
  const resolve = normalizeNameOf(nameOf);
  const table = new Map();

  for (const view of filterByPool(findPlayerMatches(matches, userId), pool)) {
    for (const opponentId of view.opponentIds) {
      if (!table.has(opponentId)) {
        table.set(opponentId, {
          opponentId,
          nickName: resolve(opponentId),
          matchCount: 0,
          wins: 0,
          losses: 0,
          eloDeltaSum: 0,
          lastMatchTime: null,
        });
      }

      const row = table.get(opponentId);
      row.matchCount += 1;
      if (view.isWin) row.wins += 1;
      else row.losses += 1;
      if (typeof view.eloDelta === 'number') row.eloDeltaSum += view.eloDelta;

      if (!row.lastMatchTime || new Date(view.matchTime) > new Date(row.lastMatchTime)) {
        row.lastMatchTime = view.matchTime;
      }
    }
  }

  return [...table.values()]
    .filter((row) => row.matchCount >= minMatches)
    .map((row) => ({ ...row, winRate: row.wins / row.matchCount }))
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.winRate - a.winRate ||
        (a.opponentId < b.opponentId ? -1 : 1)
    );
}

/**
 * 统计与每位搭档的合作战绩。
 *
 * 单打没有搭档，自然不产生记录。这个榜在双打为主的社团里很有用：
 * 「跟谁搭档胜率最高」往往比个人分数更能说明问题。
 *
 * @param {Array<Object>} matches
 * @param {string} userId
 * @param {Object} [options]
 * @param {Function} [options.nameOf]
 * @param {number} [options.minMatches=1]
 * @param {string} [options.pool] 只看某个池
 * @returns {Array<Object>} 按合作场次降序排列
 */
function buildPartnerRecord(matches, userId, options = {}) {
  const { nameOf, minMatches = 1, pool } = options;
  const resolve = normalizeNameOf(nameOf);
  const table = new Map();

  for (const view of filterByPool(findPlayerMatches(matches, userId), pool)) {
    for (const partnerId of view.partnerIds) {
      if (!table.has(partnerId)) {
        table.set(partnerId, {
          partnerId,
          nickName: resolve(partnerId),
          matchCount: 0,
          wins: 0,
          losses: 0,
          eloDeltaSum: 0,
          lastMatchTime: null,
        });
      }

      const row = table.get(partnerId);
      row.matchCount += 1;
      if (view.isWin) row.wins += 1;
      else row.losses += 1;
      if (typeof view.eloDelta === 'number') row.eloDeltaSum += view.eloDelta;

      if (!row.lastMatchTime || new Date(view.matchTime) > new Date(row.lastMatchTime)) {
        row.lastMatchTime = view.matchTime;
      }
    }
  }

  return [...table.values()]
    .filter((row) => row.matchCount >= minMatches)
    .map((row) => ({ ...row, winRate: row.wins / row.matchCount }))
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.winRate - a.winRate ||
        (a.partnerId < b.partnerId ? -1 : 1)
    );
}

/**
 * 生成逐场战绩明细，最近的排在最前面。
 *
 * 这是「我的」页面最主要的一块内容：每一行显示对阵了谁、赢了还是输了、
 * 加了几分、扣了几分。倒序是因为大家最关心最近打得怎么样。
 *
 * @param {Array<Object>} matches 回放后的比赛流水
 * @param {string} userId
 * @param {Object} [options]
 * @param {Function} [options.nameOf]
 * @param {number} [options.limit] 最多返回多少场
 * @param {string} [options.pool] 只看某个池
 * @returns {Array<Object>}
 */
function buildMatchHistory(matches, userId, options = {}) {
  const { nameOf, limit, pool } = options;
  const resolve = normalizeNameOf(nameOf);

  const views = filterByPool(findPlayerMatches(matches, userId), pool);

  views.sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));

  const sliced = typeof limit === 'number' && limit >= 0 ? views.slice(0, limit) : views;

  return sliced.map((view) => ({
    ...view,
    partnerNames: view.partnerIds.map(resolve),
    opponentNames: view.opponentIds.map(resolve),
  }));
}

/**
 * 生成某个池的等级分变化曲线。
 *
 * 没有分数明细的比赛（老数据）会被跳过，因为它们无法在曲线上落点。
 *
 * 【排序口径】
 *   'time'       —— 按比赛发生时间升序（旧行为，测试与旧调用方默认）；
 *   'settlement' —— 按「结算序号」升序（Elo 逐场结算改造后的正确链序）。
 * 两条时间轴不能混为一谈：补录的旧比赛 matchTime 早，但它的分差落在
 * 结算链的当前位置——画等级分走势必须沿结算链连点，曲线才是真实路径
 * （交接文档 §4.2）。
 *
 * @param {Array<Object>} matches 回放后的比赛流水（或带结算快照的比赛）
 * @param {string} userId 会员编号
 * @param {string} pool 等级分池
 * @param {Object} [options]
 * @param {'time'|'settlement'} [options.order='time'] 排序口径
 * @returns {Array<Object>} 按所选顺序排列
 */
function buildRatingHistory(matches, userId, pool, options = {}) {
  const { order = 'time' } = options;
  if (!ALL_RATING_POOLS.includes(pool)) {
    throw new Error(`未知的等级分池：${pool}`);
  }

  const points = findPlayerMatches(matches, userId)
    .filter((view) => view.pool === pool && typeof view.eloAfter === 'number')
    .map((view) => ({ ...view, settlementSeq: (view.settlement && view.settlement.settlementSeq) || null }));
  if (order === 'settlement') {
    points.sort((a, b) => (a.settlementSeq || 0) - (b.settlementSeq || 0));
  } else {
    points.sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));
  }
  return points.map((view) => ({
    matchId: view.matchId,
    matchTime: view.matchTime,
    eloBefore: view.eloBefore,
    eloAfter: view.eloAfter,
    eloDelta: view.eloDelta,
    isWin: view.isWin,
    opponentIds: view.opponentIds,
  }));
}

/**
 * 汇编某位会员参加过的赛事与名次，最近的排在最前面。
 *
 * @param {Array<Object>} events 赛事列表
 * @param {string} userId
 * @param {Object} [options]
 * @param {string} [options.pool] 只看某个池的赛事
 * @returns {Array<Object>}
 */
function buildEventRecord(events, userId, options = {}) {
  const { pool } = options;

  return (events || [])
    .filter((event) => !pool || event.pool === pool)
    .filter((event) => (event.results || []).some((r) => r.userId === userId))
    .map((event) => {
      const mine = event.results.find((r) => r.userId === userId);
      return {
        eventId: event._id,
        title: event.title,
        matchType: event.matchType,
        pool: event.pool,
        location: event.location || '',
        startTime: event.startTime,
        placement: mine.placement,
        // 双打赛事一人一名，所以参赛人数即 results 长度
        participantCount: event.results.length,
      };
    })
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
}

/**
 * 汇总赛事名次。
 *
 * 名次口径：1 为冠军，2 为亚军，3 为四强，5 为八强。
 * 「进前三」因此等价于 placement <= 3。
 *
 * @param {Array<Object>} records buildEventRecord 的结果
 * @returns {{eventCount:number, championCount:number, topThreeCount:number, bestPlacement:number|null}}
 */
function summarizeEvents(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return { eventCount: 0, championCount: 0, topThreeCount: 0, bestPlacement: null };
  }

  // 名次可能缺失（赛事已录成绩但尚未排名次），Math.min(undefined,...) 会得到
  // NaN 并渲染成「NaN」。只统计有效名次，一个都没有时退回 null（而非 Infinity）。
  const placements = list.map((r) => r.placement).filter((p) => Number.isFinite(p));

  return {
    eventCount: list.length,
    championCount: list.filter((r) => r.placement === 1).length,
    topThreeCount: list.filter((r) => r.placement <= 3).length,
    bestPlacement: placements.length === 0 ? null : Math.min(...placements),
  };
}

/**
 * 近期状态：最近若干场的胜负序列。
 *
 * 按时间倒序取，返回的形状直接对应用界面上的小圆点
 * （赢显示实心、输显示空心），所以顺序是「最近的在最左边」。
 *
 * @param {Array<Object>} matches 回放后的比赛流水
 * @param {string} userId
 * @param {Object} [options]
 * @param {number} [options.limit=5] 取最近几场
 * @returns {{results:boolean[], wins:number, losses:number, streak:number}}
 */
function summarizeForm(matches, userId, options = {}) {
  const { limit = 5 } = options;

  const views = findPlayerMatches(matches, userId).sort(
    (a, b) => new Date(b.matchTime) - new Date(a.matchTime)
  );
  const recent = views.slice(0, limit).map((view) => view.isWin);

  // 当前连胜从最近一场开始数，遇到第一场失利立即停止。
  // 【为什么在 views 上数而不是在 recent 上】recent 只截了 limit 场，
  // 连胜超过 limit 时会被截短——7 连胜配上默认 limit=5 会显示成 5。
  let streak = 0;
  for (const view of views) {
    if (!view.isWin) break;
    streak += 1;
  }

  return {
    results: recent,
    wins: recent.filter(Boolean).length,
    losses: recent.filter((isWin) => !isWin).length,
    streak,
  };
}

module.exports = {
  viewMatch,
  findPlayerMatches,
  createNameResolver,
  buildHeadToHead,
  buildPartnerRecord,
  buildMatchHistory,
  buildRatingHistory,
  buildEventRecord,
  summarizeEvents,
  summarizeForm,
};
