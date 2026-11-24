/**
 * 分池榜单、进步榜、百分位 单元测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractPoolStats,
  buildLeaderboard,
  buildPoolLeaderboard,
  buildProjectLeaderboard,
  buildProgressLeaderboard,
  calculatePercentile,
  percentileFromBoard,
} = require('../src/shared/utils/leaderboard.js');

const { createEmptyRatings, applyMatchResult } = require('../src/shared/utils/rating.js');
const { RATING_POOL, RANK_PROJECT } = require('../src/shared/utils/constants.js');
const { DEFAULT_CONFIG } = require('../src/shared/utils/elo.js');

/** 未指定分数时的默认初始分（当前 1450），随配置变化 */
const DEFAULT_ELO = DEFAULT_CONFIG.initialRating;

/**
 * 构造一个会员，可为各池指定分数与场次。
 * @example
 * makeUser('a', { doubles: [1400, 30] })
 */
function makeUser(id, poolSpec = {}) {
  const ratings = createEmptyRatings();
  for (const [pool, [elo, matchCount]] of Object.entries(poolSpec)) {
    ratings[pool] = {
      elo,
      matchCount,
      wins: Math.floor(matchCount / 2),
      losses: matchCount - Math.floor(matchCount / 2),
      lastMatchTime: new Date('2026-09-01'),
    };
  }
  return { _id: id, nickName: `会员${id}`, points: 0, ratings };
}

describe('extractPoolStats —— 摊平某个池的分数', () => {
  test('只取指定池的分数', () => {
    const user = makeUser('a', {
      singles: [1400, 30],
      doubles: [1100, 20],
    });
    const stats = extractPoolStats(user, RATING_POOL.DOUBLES);
    assert.equal(stats.elo, 1100);
    assert.equal(stats.matchCount, 20);
  });

  test('保留昵称与头像等展示字段', () => {
    const user = makeUser('a', { doubles: [1100, 20] });
    const stats = extractPoolStats(user, RATING_POOL.DOUBLES);
    assert.equal(stats._id, 'a');
    assert.equal(stats.nickName, '会员a');
  });

  test('积分不区分池，各池取出的是同一个值', () => {
    const user = makeUser('a');
    user.points = 42;
    assert.equal(extractPoolStats(user, RATING_POOL.DOUBLES).points, 42);
    assert.equal(extractPoolStats(user, RATING_POOL.SINGLES).points, 42);
  });

  test('从未参赛的池返回初始分', () => {
    const user = makeUser('a', { doubles: [1400, 30] });
    assert.equal(extractPoolStats(user, RATING_POOL.SINGLES).elo, DEFAULT_ELO);
  });

  test('不把隐私字段带进榜单（榜单会原样下发给任意访客）', () => {
    const user = makeUser('a', { doubles: [1400, 30] });
    // 用户文档里实际带着的东西，一个都不该出现在榜单行上
    Object.assign(user, {
      phone: '13800000000',
      studentId: '2026001',
      openId: 'ox_openid_secret',
      realName: '赵明宇',
    });

    const stats = extractPoolStats(user, RATING_POOL.DOUBLES);

    assert.equal(stats.user, undefined, '不应挂上原始用户对象');
    for (const field of ['phone', 'studentId', 'openId', 'realName']) {
      assert.equal(stats[field], undefined, `榜单行不应含 ${field}`);
    }
  });
});

describe('buildPoolLeaderboard —— 分池排名', () => {
  test('双打榜按双打分排序，与单打分无关', () => {
    const users = [
      makeUser('a', { singles: [1600, 30], doubles: [1000, 5] }), // 单打好、双打弱
      makeUser('b', { singles: [1000, 30], doubles: [1400, 5] }), // 单打弱、双打好
    ];

    const doublesBoard = buildPoolLeaderboard(users, RATING_POOL.DOUBLES);
    assert.deepEqual(doublesBoard.map((p) => p._id), ['b', 'a']);

    const singlesBoard = buildPoolLeaderboard(users, RATING_POOL.SINGLES);
    assert.deepEqual(singlesBoard.map((p) => p._id), ['a', 'b']);
  });

  test('名次连续且从 1 开始', () => {
    const users = [
      makeUser('a', { doubles: [1400, 20] }),
      makeUser('b', { doubles: [1200, 20] }),
      makeUser('c', { doubles: [1000, 20] }),
    ];
    const board = buildPoolLeaderboard(users, RATING_POOL.DOUBLES);
    assert.deepEqual(board.map((p) => p.rank), [1, 2, 3]);
  });

  test('从未打过双打的会员在双打榜上使用初始分参赛', () => {
    const users = [
      makeUser('a', { doubles: [1600, 20] }),
      makeUser('b', { singles: [2000, 50] }), // 只打过单打
    ];
    const board = buildPoolLeaderboard(users, RATING_POOL.DOUBLES);
    assert.deepEqual(board.map((p) => p._id), ['a', 'b']);
    assert.equal(board[1].elo, DEFAULT_ELO);
    assert.equal(board[1].status, 'provisional'); // 0 场，标记为定级中
  });

  test('传入非数组时抛出错误', () => {
    assert.throws(() => buildPoolLeaderboard(null, RATING_POOL.DOUBLES), /users 必须是数组/);
  });

  test('不修改传入的用户数组', () => {
    const users = [makeUser('a', { doubles: [1000, 20] }), makeUser('b', { doubles: [1400, 20] })];
    const before = users.map((u) => u._id);
    buildPoolLeaderboard(users, RATING_POOL.DOUBLES);
    assert.deepEqual(users.map((u) => u._id), before);
  });
});

describe('buildProjectLeaderboard —— 分项目排名', () => {
  const gendered = (id, gender, spec) => ({ ...makeUser(id, spec), gender });

  test('男单榜与女单榜按性别筛选，取自同一个单打池', () => {
    const users = [
      gendered('a', 'M', { singles: [1500, 20] }),
      gendered('b', 'F', { singles: [1600, 20] }),
      gendered('c', 'M', { singles: [1200, 20] }),
    ];

    // 男单榜只取男生，并按同一个单打池的分数排序
    assert.deepEqual(
      buildProjectLeaderboard(users, RANK_PROJECT.MEN_SINGLES).map((p) => p._id),
      ['a', 'c']
    );
    // 女单榜只取女生，分数与男单榜来自同一个池，可直接比较
    assert.deepEqual(
      buildProjectLeaderboard(users, RANK_PROJECT.WOMEN_SINGLES).map((p) => p._id),
      ['b']
    );
  });

  test('双打榜不做性别过滤', () => {
    const users = [
      gendered('a', 'M', { doubles: [1500, 20] }),
      gendered('b', 'F', { doubles: [1400, 20] }),
    ];
    assert.deepEqual(
      buildProjectLeaderboard(users, RANK_PROJECT.DOUBLES).map((p) => p._id),
      ['a', 'b']
    );
  });

  test('未知项目名抛出错误', () => {
    assert.throws(
      () => buildProjectLeaderboard([], 'unknown_project'),
      /未知的排行榜项目/
    );
  });
});

describe('buildProgressLeaderboard —— 进步榜', () => {
  const entry = (id, startElo, currentElo, matchCount = 20) => ({
    _id: id,
    nickName: `会员${id}`,
    startElo,
    currentElo,
    matchCount,
  });

  test('按赛季内涨幅降序排列', () => {
    const board = buildProgressLeaderboard([
      entry('a', 1000, 1180), // +180
      entry('b', 1400, 1420), // +20
      entry('c', 1100, 1250), // +150
    ]);
    assert.deepEqual(board.map((p) => p._id), ['a', 'c', 'b']);
    assert.deepEqual(board.map((p) => p.delta), [180, 150, 20]);
  });

  test('正确计算 delta 字段', () => {
    const board = buildProgressLeaderboard([entry('a', 1000, 1180)]);
    assert.equal(board[0].delta, 180);
    assert.equal(board[0].startElo, 1000);
    assert.equal(board[0].currentElo, 1180);
  });

  test('涨幅为负的会员同样上榜（退步也应该看得见）', () => {
    const board = buildProgressLeaderboard([
      entry('a', 1400, 1200), // -200
      entry('b', 1000, 1050), // +50
    ]);
    assert.deepEqual(board.map((p) => p._id), ['b', 'a']);
    assert.deepEqual(board.map((p) => p.delta), [50, -200]);
  });

  test('场次不足的会员被过滤掉（防止运气被当成进步）', () => {
    const board = buildProgressLeaderboard([
      entry('a', 1000, 1200, 2), // 只打 2 场，涨了 200，不上榜
      entry('b', 1000, 1050, 20),
    ]);
    assert.deepEqual(board.map((p) => p._id), ['b']);
  });

  test('可自定义上榜门槛', () => {
    const board = buildProgressLeaderboard(
      [entry('a', 1000, 1200, 2), entry('b', 1000, 1050, 3)],
      { minMatches: 2 }
    );
    assert.equal(board.length, 2);
  });

  test('支持限制返回条数', () => {
    const board = buildProgressLeaderboard(
      [entry('a', 1000, 1200), entry('b', 1000, 1150), entry('c', 1000, 1100)],
      { limit: 2 }
    );
    assert.equal(board.length, 2);
    assert.deepEqual(board.map((p) => p._id), ['a', 'b']);
  });

  test('涨幅相同时，当前分高者靠前', () => {
    const board = buildProgressLeaderboard([
      entry('a', 1000, 1100), // +100
      entry('b', 1400, 1500), // +100
    ]);
    assert.deepEqual(board.map((p) => p._id), ['b', 'a']);
  });

  test('名次连续', () => {
    const board = buildProgressLeaderboard([entry('a', 1000, 1300), entry('b', 1000, 1200)]);
    assert.deepEqual(board.map((p) => p.rank), [1, 2]);
  });

  test('传入非数组时抛出错误', () => {
    assert.throws(() => buildProgressLeaderboard('x'), /entries 必须是数组/);
  });

  test('不修改传入的数组', () => {
    const input = [entry('a', 1000, 1100), entry('b', 1000, 1200)];
    const before = input.map((e) => e._id);
    buildProgressLeaderboard(input);
    assert.deepEqual(input.map((e) => e._id), before);
  });
});

describe('calculatePercentile —— 百分位', () => {
  const flat = (id, elo, wins = 20, losses = 10) => ({
    _id: id,
    nickName: `会员${id}`,
    elo,
    points: 0,
    wins,
    losses,
    lastMatchTime: new Date('2026-09-01'),
  });

  test('第一名超过 99% 的会员（共 100 人）', () => {
    const players = Array.from({ length: 100 }, (_, i) => flat(`u${i}`, 2000 - i * 10));
    const result = calculatePercentile(players, 'u0');
    assert.equal(result.rank, 1);
    assert.equal(result.total, 100);
    assert.equal(result.beatCount, 99);
    assert.equal(result.beatPercent, 99);
  });

  test('最后一名超过 0% 的会员', () => {
    const players = Array.from({ length: 100 }, (_, i) => flat(`u${i}`, 2000 - i * 10));
    const result = calculatePercentile(players, 'u99');
    assert.equal(result.rank, 100);
    assert.equal(result.beatPercent, 0);
  });

  test('中游位置计算正确', () => {
    const players = Array.from({ length: 100 }, (_, i) => flat(`u${i}`, 2000 - i * 10));
    const result = calculatePercentile(players, 'u50'); // 第 51 名
    assert.equal(result.rank, 51);
    assert.equal(result.beatCount, 49);
    assert.equal(result.beatPercent, 49);
  });

  test('会员不在榜单中时返回 null', () => {
    const players = [flat('u0', 1200)];
    assert.equal(calculatePercentile(players, 'not-exist'), null);
  });

  test('支持按积分口径计算', () => {
    const players = [
      { ...flat('a', 1000), points: 10 },
      { ...flat('b', 1000), points: 50 },
    ];
    const result = calculatePercentile(players, 'b', { sortBy: 'points' });
    assert.equal(result.rank, 1);
  });

  test('beatPercent 保留一位小数', () => {
    const players = Array.from({ length: 3 }, (_, i) => flat(`u${i}`, 2000 - i * 10));
    const result = calculatePercentile(players, 'u0');
    assert.equal(result.beatPercent, 66.7); // 2 / 3
  });
});

describe('percentileFromBoard —— 从已排序的榜上直接读百分位', () => {
  const flat = (id, elo) => ({
    _id: id,
    nickName: `会员${id}`,
    elo,
    points: 0,
    wins: 20,
    losses: 10,
    lastMatchTime: new Date('2026-09-01'),
  });

  test('与 calculatePercentile 对同一批人给出完全一致的结果', () => {
    // 这是拆分的意义所在：省掉重复排序，但结果不能有一丝差别。
    // 榜单接口拿到的本来就是 buildLeaderboard 的产物，两条路径必须同解。
    const players = Array.from({ length: 40 }, (_, i) => flat(`u${i}`, 2000 - i * 10));
    const board = buildLeaderboard(players);
    for (const id of ['u0', 'u7', 'u39']) {
      assert.deepEqual(percentileFromBoard(board, id), calculatePercentile(players, id));
    }
  });

  test('空榜返回 null', () => {
    assert.equal(percentileFromBoard([], 'u0'), null);
  });

  test('入参不是数组时返回 null，不抛错', () => {
    // 榜单接口的调用方可能从 payload 里带进一个坏值，这里不能崩
    assert.equal(percentileFromBoard(null, 'u0'), null);
    assert.equal(percentileFromBoard(undefined, 'u0'), null);
  });

  test('会员不在榜上返回 null', () => {
    const board = buildLeaderboard([flat('u0', 1200)]);
    assert.equal(percentileFromBoard(board, 'nobody'), null);
  });
});
