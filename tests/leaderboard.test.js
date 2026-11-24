/**
 * 排行榜排序与名次计算单元测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  winRate,
  buildLeaderboard,
  calculateTrend,
} = require('../src/shared/utils/leaderboard.js');

/** 构造用户对象的辅助函数 */
const user = (id, elo, extra = {}) => ({
  _id: id,
  nickName: `选手${id}`,
  elo,
  points: 0,
  wins: 20,
  losses: 10,
  lastMatchTime: new Date('2026-09-01'),
  ...extra,
});

describe('winRate —— 胜率计算', () => {
  test('正常计算胜率', () => {
    assert.equal(winRate(7, 3), 0.7);
  });

  test('零场次时返回 0 而非 NaN（避免除零错误）', () => {
    const result = winRate(0, 0);
    assert.equal(result, 0);
    assert.ok(!Number.isNaN(result));
  });

  test('全胜为 1，全败为 0', () => {
    assert.equal(winRate(5, 0), 1);
    assert.equal(winRate(0, 5), 0);
  });
});

describe('buildLeaderboard —— 排序', () => {
  test('按等级分降序排列', () => {
    const list = buildLeaderboard([user('a', 1000), user('b', 1400), user('c', 1200)]);
    assert.deepEqual(
      list.map((p) => p._id),
      ['b', 'c', 'a']
    );
  });

  test('名次从 1 开始且连续递增', () => {
    const list = buildLeaderboard([user('a', 1000), user('b', 1400), user('c', 1200)]);
    assert.deepEqual(
      list.map((p) => p.rank),
      [1, 2, 3]
    );
  });

  test('等级分相同时按胜率降序打破并列', () => {
    const list = buildLeaderboard([
      user('a', 1200, { wins: 5, losses: 5 }), // 胜率 0.5
      user('b', 1200, { wins: 9, losses: 1 }), // 胜率 0.9
    ]);
    assert.deepEqual(
      list.map((p) => p._id),
      ['b', 'a']
    );
  });

  test('等级分与胜率都相同时按总胜场数降序', () => {
    const list = buildLeaderboard([
      user('a', 1200, { wins: 10, losses: 10 }),
      user('b', 1200, { wins: 20, losses: 20 }),
    ]);
    assert.deepEqual(
      list.map((p) => p._id),
      ['b', 'a']
    );
  });

  test('所有指标都相同时按 ID 兜底排序，保证结果稳定', () => {
    const first = buildLeaderboard([user('b', 1200), user('a', 1200)]);
    const second = buildLeaderboard([user('a', 1200), user('b', 1200)]);
    // 无论输入顺序如何，输出顺序必须一致
    assert.deepEqual(
      first.map((p) => p._id),
      second.map((p) => p._id)
    );
  });

  test('名次不并列：即使等级分相同也不会出现两个第 1 名', () => {
    const list = buildLeaderboard([user('a', 1200), user('b', 1200), user('c', 1200)]);
    assert.deepEqual(
      list.map((p) => p.rank),
      [1, 2, 3]
    );
  });

  test('按积分排序时切换主排序字段', () => {
    const list = buildLeaderboard(
      [user('a', 1200, { points: 10 }), user('b', 1000, { points: 50 })],
      { sortBy: 'points' }
    );
    assert.deepEqual(
      list.map((p) => p._id),
      ['b', 'a']
    );
  });

  test('不修改传入的原数组（纯函数特性）', () => {
    const input = [user('a', 1000), user('b', 1400)];
    const snapshot = input.map((p) => p._id);
    buildLeaderboard(input);
    assert.deepEqual(
      input.map((p) => p._id),
      snapshot,
      'buildLeaderboard 不应改变调用方传入的数组顺序'
    );
  });

  test('传入非数组时抛出错误', () => {
    assert.throws(() => buildLeaderboard(null), /players 必须是数组/);
  });
});

describe('buildLeaderboard —— 状态标记', () => {
  test('参赛场次不足 10 场标记为定级中', () => {
    const list = buildLeaderboard([user('a', 1200, { wins: 3, losses: 2 })]);
    assert.equal(list[0].status, 'provisional');
  });

  test('参赛场次达到 10 场且近期活跃标记为正常', () => {
    const list = buildLeaderboard([user('a', 1200, { wins: 8, losses: 4 })]);
    assert.equal(list[0].status, 'active');
  });

  test('超过 90 天未参赛标记为不活跃', () => {
    const now = new Date('2026-09-01').getTime();
    const list = buildLeaderboard(
      [user('a', 1200, { lastMatchTime: new Date('2026-05-01') })], // 约 123 天前
      { now }
    );
    assert.equal(list[0].status, 'inactive');
  });

  test('定级中优先于不活跃标记（新人长期不参赛仍显示定级中）', () => {
    const now = new Date('2026-09-01').getTime();
    const list = buildLeaderboard(
      [user('a', 1200, { wins: 2, losses: 1, lastMatchTime: new Date('2026-01-01') })],
      { now }
    );
    assert.equal(list[0].status, 'provisional');
  });

  test('不活跃会员保留原有等级分，不影响排序', () => {
    const now = new Date('2026-09-01').getTime();
    const list = buildLeaderboard(
      [
        user('a', 1500, { lastMatchTime: new Date('2025-01-01') }), // 不活跃但分高
        user('b', 1000),
      ],
      { now }
    );
    assert.equal(list[0]._id, 'a');
    assert.equal(list[0].elo, 1500);
    assert.equal(list[0].status, 'inactive');
  });

  test('附加的派生字段正确', () => {
    const list = buildLeaderboard([user('a', 1200, { wins: 15, losses: 5 })]);
    assert.equal(list[0].matchCount, 20);
    assert.equal(list[0].winRate, 0.75);
  });
});

describe('calculateTrend —— 近期状态趋势', () => {
  test('数据不足时返回 null', () => {
    assert.equal(calculateTrend([{ isWin: true }]), null);
  });

  test('最近 5 场明显好于前 5 场时判定为上升', () => {
    const matches = [
      ...Array(5).fill({ isWin: true }), // 最近 5 场全胜
      ...Array(5).fill({ isWin: false }), // 之前 5 场全败
      ...Array(5).fill({ isWin: false }),
    ];
    const result = calculateTrend(matches);
    assert.equal(result.trend, 'up');
    assert.equal(result.recentRate, 1);
    assert.equal(result.previousRate, 0);
  });

  test('最近 5 场明显差于前 5 场时判定为下滑', () => {
    const matches = [
      ...Array(5).fill({ isWin: false }),
      ...Array(5).fill({ isWin: true }),
    ];
    assert.equal(calculateTrend(matches).trend, 'down');
  });

  test('两段胜率相同时判定为持平', () => {
    const matches = [
      ...Array(5).fill({ isWin: true }),
      { isWin: false },
      ...Array(5).fill({ isWin: true }),
    ];
    const result = calculateTrend(matches.slice(0, 5).concat(matches.slice(6)));
    assert.equal(result.trend, 'flat');
  });

  test('窗口为 0 或负数时返回 null，不吐出 NaN', () => {
    // 窗口为 0 会让两段胜率都算成 0/0=NaN，比较全为假、trend 悄悄变 'flat'，
    // NaN 再一路渲染到页面上。宁可返回 null（页面显示「数据不足」）。
    const matches = Array(10).fill({ isWin: true });
    assert.equal(calculateTrend(matches, 0), null);
    assert.equal(calculateTrend(matches, -3), null);
  });

  test('入参不是数组时返回 null，不抛错', () => {
    assert.equal(calculateTrend(null), null);
    assert.equal(calculateTrend(undefined), null);
  });
});
