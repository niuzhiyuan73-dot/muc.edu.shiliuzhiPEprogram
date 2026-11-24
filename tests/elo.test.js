/**
 * ELO 等级分算法单元测试
 *
 * 运行方式：npm test
 * 这些测试不需要微信开发者工具，纯 Node 环境即可运行。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONFIG,
  WINNER,
  expectedScore,
  resolveEventKFactor,
  teamAverageRating,
  calculateMatchRatings,
  floorToStep,
  calculatePlacementRating,
  initialRatingFor,
} = require('../src/shared/utils/elo.js');

/** 构造一个选手对象的辅助函数，减少测试代码重复 */
const player = (rating, matchCount = 20) => ({ rating, matchCount });

describe('expectedScore —— 期望胜率', () => {
  test('双方分数相同时，期望胜率为 0.5', () => {
    assert.equal(expectedScore(1000, 1000), 0.5);
  });

  test('双方期望胜率之和恒为 1（互补性）', () => {
    const cases = [
      [1000, 1400],
      [1400, 1000],
      [1200, 1250],
      [800, 2000],
    ];
    for (const [a, b] of cases) {
      const sum = expectedScore(a, b) + expectedScore(b, a);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${a} vs ${b} 期望胜率之和应为 1，实际 ${sum}`);
    }
  });

  test('分差 400 分时，强方期望胜率约为 0.909', () => {
    // 1 / (1 + 10^(-1)) = 1 / 1.1 ≈ 0.9091
    const result = expectedScore(1400, 1000);
    assert.ok(Math.abs(result - 0.9090909) < 1e-6, `实际值 ${result}`);
  });

  test('分数越高，期望胜率越大（单调性）', () => {
    assert.ok(expectedScore(1200, 1000) > expectedScore(1100, 1000));
    assert.ok(expectedScore(1500, 1000) > expectedScore(1200, 1000));
  });
});

describe('K 值 —— 日常统一 16、赛事按等级', () => {
  test('日常约球不再按人分段：无论场次与分数都是 16', () => {
    // 规则已收敛为一个常数，这里直接比对配置值，防止有人又把分段加回来
    assert.equal(DEFAULT_CONFIG.kStandard, 16);
    assert.equal(DEFAULT_CONFIG.provisionalMatchCount, undefined);
    assert.equal(DEFAULT_CONFIG.kProvisional, undefined);
    assert.equal(DEFAULT_CONFIG.kHigh, undefined);
    assert.equal(DEFAULT_CONFIG.highRatingThreshold, undefined);
  });

  test('赛事的固定 K：一级 32、二级 24、三级 16', () => {
    assert.equal(resolveEventKFactor(1, DEFAULT_CONFIG), 32);
    assert.equal(resolveEventKFactor(2, DEFAULT_CONFIG), 24);
    assert.equal(resolveEventKFactor(3, DEFAULT_CONFIG), 16);
  });

  test('赛事等级缺失时退回日常 K', () => {
    assert.equal(resolveEventKFactor(undefined, DEFAULT_CONFIG), DEFAULT_CONFIG.kStandard);
    assert.equal(resolveEventKFactor(99, DEFAULT_CONFIG), DEFAULT_CONFIG.kStandard);
  });
});

describe('队伍平均分', () => {
  test('单打时队伍平均分即选手本人分数', () => {
    assert.equal(teamAverageRating([player(1234)]), 1234);
  });

  test('双打时队伍平均分为两人算术平均', () => {
    assert.equal(teamAverageRating([player(1200), player(1400)]), 1300);
  });
});

describe('initialRatingFor —— 按性别取初始分', () => {
  test('男会员从默认初始分起步（当前 1450）', () => {
    assert.equal(initialRatingFor('M'), DEFAULT_CONFIG.initialRating);
    assert.equal(initialRatingFor('M'), 1450);
  });

  test('女会员比男会员低 genderInitialGap 分（当前低 150，即 1300）', () => {
    assert.equal(
      initialRatingFor('F'),
      DEFAULT_CONFIG.initialRating - DEFAULT_CONFIG.genderInitialGap
    );
    assert.equal(initialRatingFor('F'), 1300);
  });

  test('性别缺失或取值意外时回落到默认初始分', () => {
    // 老数据与测试造的假会员大多没有 gender 字段，必须能安全落地
    assert.equal(initialRatingFor(undefined), DEFAULT_CONFIG.initialRating);
    assert.equal(initialRatingFor(null), DEFAULT_CONFIG.initialRating);
    assert.equal(initialRatingFor('X'), DEFAULT_CONFIG.initialRating);
  });

  test('跟随自定义配置：改了 initialRating，男女起点一起平移', () => {
    const config = { ...DEFAULT_CONFIG, initialRating: 1200 };
    assert.equal(initialRatingFor('M', config), 1200);
    assert.equal(initialRatingFor('F', config), 1200 - DEFAULT_CONFIG.genderInitialGap);
  });

  test('把 genderInitialGap 设为 0 即可关闭性别差异', () => {
    const config = { ...DEFAULT_CONFIG, genderInitialGap: 0 };
    assert.equal(initialRatingFor('F', config), DEFAULT_CONFIG.initialRating);
  });
});

describe('floorToStep —— 向下取整到步长', () => {
  test('默认步长 50', () => {
    assert.equal(floorToStep(1783), 1750);
    assert.equal(floorToStep(1500), 1500); // 正好是整数倍时不变
    assert.equal(floorToStep(1499), 1450);
  });

  test('支持自定义步长', () => {
    assert.equal(floorToStep(1783, 100), 1700);
    assert.equal(floorToStep(125, 25), 125);
    assert.equal(floorToStep(149, 25), 125);
  });
});

describe('calculatePlacementRating —— 新人按对手水平定级', () => {
  test('有胜场时取击败过的最高分对手，并向下取到 50 的整数倍', () => {
    assert.equal(
      calculatePlacementRating({
        opponentRatings: [1783, 1600, 1550, 1400, 1300],
        beatenRatings: [1783, 1550],
      }),
      1750
    );
  });

  test('全败时取最低分对手，并用默认初始分封顶', () => {
    // 最低对手 1550 向下取整仍是 1550，被 cap（当前 1450）压到 1450
    assert.equal(
      calculatePlacementRating({
        opponentRatings: [1900, 1800, 1700, 1600, 1550],
        beatenRatings: [],
      }),
      DEFAULT_CONFIG.initialRating
    );
  });

  test('全败且最低对手低于上限时按最低对手向下取整定级', () => {
    assert.equal(
      calculatePlacementRating({
        opponentRatings: [1400, 1370],
        beatenRatings: [],
      }),
      1350
    );
  });

  test('两者都为空时返回 null', () => {
    assert.equal(calculatePlacementRating({ opponentRatings: [], beatenRatings: [] }), null);
    assert.equal(calculatePlacementRating(), null);
  });

  test('支持自定义步长与上限', () => {
    assert.equal(
      calculatePlacementRating({ opponentRatings: [1783], beatenRatings: [1783], step: 100 }),
      1700
    );
    assert.equal(
      calculatePlacementRating({ opponentRatings: [1900], beatenRatings: [], cap: 1200 }),
      1200
    );
  });

  test('结果为 0 时不会返回 -0', () => {
    const result = calculatePlacementRating({ opponentRatings: [40], beatenRatings: [] });
    assert.equal(result, 0);
    assert.ok(!Object.is(result, -0));
  });
});

describe('calculateMatchRatings —— 单打', () => {
  test('同分对局获胜，得分恰好为 K 值的一半', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 20)],
      teamB: [player(1000, 20)],
      winner: WINNER.TEAM_A,
    });
    // K = 16，期望胜率 0.5，胜场得分 = 16 × (1 - 0.5) = 8
    assert.equal(result.teamA[0].k, 16);
    assert.equal(result.teamA[0].delta, 8);
    assert.equal(result.teamA[0].before, 1000);
    assert.equal(result.teamA[0].after, 1008);
    assert.equal(result.teamB[0].delta, -8);
    assert.equal(result.teamB[0].after, 992);
  });

  test('以弱胜强：低分选手获胜收益显著偏高', () => {
    const result = calculateMatchRatings({
      teamA: [player(1200, 20)],
      teamB: [player(1400, 20)],
      winner: WINNER.TEAM_A,
    });
    // 期望胜率约 0.2403，得分 = round(16 × 0.7597) = 12
    assert.equal(result.teamA[0].delta, 12);
    assert.ok(result.teamA[0].delta > 8, '爆冷获胜应比同分对局赢得更多分');
  });

  test('以强负弱：高分选手失利损失显著偏大', () => {
    const result = calculateMatchRatings({
      teamA: [player(1400, 20)],
      teamB: [player(1200, 20)],
      winner: WINNER.TEAM_B,
    });
    // 期望胜率约 0.7597，失利得分 = round(16 × (-0.7597)) = -12
    assert.equal(result.teamA[0].delta, -12);
    assert.ok(Math.abs(result.teamA[0].delta) > 8, '被爆冷应比同分对局损失更多分');
  });

  test('以强胜弱：高分选手获胜收益偏低', () => {
    const result = calculateMatchRatings({
      teamA: [player(1400, 20)],
      teamB: [player(1200, 20)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.teamA[0].delta, 4);
    assert.ok(result.teamA[0].delta < 8, '战胜弱手收益应低于同分对局');
  });

  test('平局：同分选手双方均不涨分', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 20)],
      teamB: [player(1000, 20)],
      winner: WINNER.DRAW,
    });
    assert.equal(result.teamA[0].delta, 0);
    assert.equal(result.teamB[0].delta, 0);
  });

  test('零和约束：赢家加分与输家减分完全相等', () => {
    const result = calculateMatchRatings({
      teamA: [player(1234, 20)],
      teamB: [player(987, 20)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.teamA[0].delta + result.teamB[0].delta, 0);
  });

  test('日常比赛不因场次、分数改变 K：新人与老手用同一个 K', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 2)],
      teamB: [player(2200, 50)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.teamA[0].k, 16);
    assert.equal(result.teamB[0].k, 16);
    assert.equal(result.teamA[0].delta + result.teamB[0].delta, 0);
  });

  test('返回的期望胜率之和为 1，且保留四位小数', () => {
    const result = calculateMatchRatings({
      teamA: [player(1300, 20)],
      teamB: [player(1100, 20)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(Number((result.expectedA + result.expectedB).toFixed(4)), 1);
  });

  test('新会员首场获胜同样按日常 K=16 计算', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 0)],
      teamB: [player(1000, 0)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.teamA[0].k, 16);
    assert.equal(result.teamA[0].delta, 8);
  });

  test('赛事比赛按等级取 K，不看选手场次', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 0)],
      teamB: [player(1000, 50)],
      winner: WINNER.TEAM_A,
      eventLevel: 1,
    });
    assert.equal(result.teamA[0].k, 32);
    assert.equal(result.teamB[0].k, 32);
    assert.equal(result.teamA[0].delta, 16);
  });

  test('极端分差下不会出现分数爆炸', () => {
    const result = calculateMatchRatings({
      teamA: [player(2400, 100)],
      teamB: [player(400, 100)],
      winner: WINNER.TEAM_B,
    });
    // 2400 分选手输给 400 分选手，最多损失一个 K 值（16 分），不应出现异常值
    assert.ok(Math.abs(result.teamA[0].delta) <= DEFAULT_CONFIG.kStandard);
    assert.equal(result.teamB[0].delta, -result.teamA[0].delta);
  });
});

describe('calculateMatchRatings —— 双打', () => {
  test('同队两名队员获得完全相同的分数变动（公平性要求）', () => {
    const result = calculateMatchRatings({
      teamA: [player(1200, 20), player(1400, 20)],
      teamB: [player(1200, 20), player(1000, 20)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.teamA[0].delta, result.teamA[1].delta);
    assert.equal(result.teamB[0].delta, result.teamB[1].delta);
  });

  test('使用队伍平均分计算期望胜率', () => {
    const result = calculateMatchRatings({
      teamA: [player(1200, 20), player(1400, 20)], // 平均 1300
      teamB: [player(1200, 20), player(1000, 20)], // 平均 1100
      winner: WINNER.TEAM_A,
    });
    // 与「单打 1300 vs 1100」应得到完全一致的期望胜率
    const singles = calculateMatchRatings({
      teamA: [player(1300, 20)],
      teamB: [player(1100, 20)],
      winner: WINNER.TEAM_A,
    });
    assert.equal(result.expectedA, singles.expectedA);
  });

  test('四名队员的等级分变动总和为零', () => {
    const result = calculateMatchRatings({
      teamA: [player(1350, 20), player(1180, 30)],
      teamB: [player(1260, 20), player(1090, 15)],
      winner: WINNER.TEAM_B,
    });
    const totalDelta = [...result.teamA, ...result.teamB].reduce((s, p) => s + p.delta, 0);
    assert.equal(totalDelta, 0);
  });

  test('每名队员的 after 等于 before 加 delta', () => {
    const result = calculateMatchRatings({
      teamA: [player(1350, 20), player(1180, 30)],
      teamB: [player(1260, 20), player(1090, 15)],
      winner: WINNER.TEAM_A,
    });
    for (const p of [...result.teamA, ...result.teamB]) {
      assert.equal(p.after, p.before + p.delta);
    }
  });
});

describe('输入校验', () => {
  test('队伍为空时抛出错误', () => {
    assert.throws(
      () => calculateMatchRatings({ teamA: [], teamB: [player(1000)], winner: 'A' }),
      /A 队必须是非空数组/
    );
  });

  test('单队超过 2 人时抛出错误', () => {
    assert.throws(
      () =>
        calculateMatchRatings({
          teamA: [player(1000), player(1000), player(1000)],
          teamB: [player(1000)],
          winner: 'A',
        }),
      /最多只能有 2 名选手/
    );
  });

  test('等级分不是数字时抛出错误', () => {
    assert.throws(
      () =>
        calculateMatchRatings({
          teamA: [{ rating: '1000', matchCount: 5 }],
          teamB: [player(1000)],
          winner: 'A',
        }),
      /rating 必须是有效数字/
    );
  });

  test('matchCount 为负数时抛出错误', () => {
    assert.throws(
      () =>
        calculateMatchRatings({
          teamA: [{ rating: 1000, matchCount: -1 }],
          teamB: [player(1000)],
          winner: 'A',
        }),
      /matchCount 必须是非负数字/
    );
  });

  test('winner 取值非法时抛出错误', () => {
    assert.throws(
      () =>
        calculateMatchRatings({
          teamA: [player(1000)],
          teamB: [player(1000)],
          winner: 'C',
        }),
      /winner 必须是/
    );
  });

  test('自定义配置可以覆盖默认参数', () => {
    const result = calculateMatchRatings({
      teamA: [player(1000, 20)],
      teamB: [player(1000, 20)],
      winner: WINNER.TEAM_A,
      config: { kStandard: 40 },
    });
    assert.equal(result.teamA[0].delta, 20);
  });
});

describe('不变量检查（对整个分数体系的健全性验证）', () => {
  test('随机对局中，零和与平均分收敛性质始终成立', () => {
    // 用固定序列代替随机数，保证测试可复现
    const ratings = [1000, 1100, 900, 1500, 1750, 400, 1600, 1250];
    for (let i = 0; i < ratings.length; i += 2) {
      const result = calculateMatchRatings({
        teamA: [player(ratings[i], 30)],
        teamB: [player(ratings[i + 1], 30)],
        winner: i % 4 === 0 ? WINNER.TEAM_A : WINNER.TEAM_B,
      });
      assert.equal(
        result.teamA[0].delta + result.teamB[0].delta,
        0,
        `对局 ${ratings[i]} vs ${ratings[i + 1]} 违反了零和约束`
      );
    }
  });

  test('强者获胜时等级分上升，弱者落败时等级分下降（方向正确性）', () => {
    const result = calculateMatchRatings({
      teamA: [player(1800, 30)],
      teamB: [player(1000, 30)],
      winner: WINNER.TEAM_A,
    });
    assert.ok(result.teamA[0].delta >= 0, '胜方等级分不应下降');
    assert.ok(result.teamB[0].delta <= 0, '负方等级分不应上升');
  });
});
