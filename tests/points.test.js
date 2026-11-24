/**
 * 积分算法单元测试
 * ============================================================
 * 积分只来自赛事（决策 9）。日常比赛不论输赢都不再产生积分，
 * 所以这里没有「胜 N 分、负 N 分」这类用例——那些规则已从算法里删掉。
 * ============================================================
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_POINT_CONFIG,
  placementBaseOf,
  calculateEventPoints,
} = require('../src/shared/utils/points.js');
const {
  EVENT_LEVEL,
  EVENT_LEVEL_MULTIPLIER,
  DEFAULT_EVENT_LEVEL,
} = require('../src/shared/utils/constants.js');

describe('placementBaseOf —— 名次档位基础分', () => {
  test('前四名各有固定档位', () => {
    assert.equal(placementBaseOf(1), 20);
    assert.equal(placementBaseOf(2), 14);
    assert.equal(placementBaseOf(3), 10);
    assert.equal(placementBaseOf(4), 7);
  });

  test('5 到 8 名共用八强档', () => {
    for (const rank of [5, 6, 7, 8]) {
      assert.equal(placementBaseOf(rank), 4);
    }
  });

  test('八强之外为 0：只拿参与分', () => {
    assert.equal(placementBaseOf(9), 0);
    assert.equal(placementBaseOf(16), 0);
    assert.equal(placementBaseOf(100), 0);
  });

  test('名次非法一律按 0 处理', () => {
    for (const bad of [undefined, null, 0, -1, 'x', NaN, {}]) {
      assert.equal(placementBaseOf(bad), 0);
    }
  });

  test('小数名次按非法处理，不落进八强档', () => {
    // 4.5 这种小数既不在档位表里，也不该被当成「八强」发分
    for (const bad of [4.5, 2.5, 8.1, 0.5]) {
      assert.equal(placementBaseOf(bad), 0);
    }
  });

  test('字符串数字按数字处理', () => {
    assert.equal(placementBaseOf('1'), 20);
    assert.equal(placementBaseOf('6'), 4);
  });

  test('自定义档位表生效', () => {
    const config = { ...DEFAULT_POINT_CONFIG, placementBase: { 1: 100 }, quarterfinalBase: 1 };
    assert.equal(placementBaseOf(1, config), 100);
    // 自定义表没有第 2 名，落到八强档
    assert.equal(placementBaseOf(2, config), 1);
  });
});

describe('calculateEventPoints —— 一次赛事的积分', () => {
  test('三级赛事冠军：2（参与）+ 20 × 1 = 22', () => {
    const r = calculateEventPoints({ placement: 1, level: EVENT_LEVEL.THIRD });
    assert.equal(r.participate, 2);
    assert.equal(r.placementScore, 20);
    assert.equal(r.multiplier, 1);
    assert.equal(r.total, 22);
  });

  test('二级赛事亚军：2（参与）+ 14 × 2 = 30', () => {
    const r = calculateEventPoints({ placement: 2, level: EVENT_LEVEL.SECOND });
    assert.equal(r.multiplier, 2);
    assert.equal(r.total, 30);
  });

  test('一级赛事冠军：2（参与）+ 20 × 4 = 82', () => {
    const r = calculateEventPoints({ placement: 1, level: EVENT_LEVEL.FIRST });
    assert.equal(r.multiplier, 4);
    assert.equal(r.total, 82);
  });

  test('未进八强也有参与分：仅 2 分', () => {
    const r = calculateEventPoints({ placement: 9, level: EVENT_LEVEL.FIRST });
    assert.equal(r.placementScore, 0);
    assert.equal(r.total, 2);
  });

  test('缺名次时只拿参与分', () => {
    assert.equal(calculateEventPoints({}).total, 2);
    assert.equal(calculateEventPoints({ level: EVENT_LEVEL.FIRST }).total, 2);
  });

  test('缺等级时按三级赛事计（决策 13 的默认值）', () => {
    const r = calculateEventPoints({ placement: 1 });
    assert.equal(r.multiplier, EVENT_LEVEL_MULTIPLIER[DEFAULT_EVENT_LEVEL]);
    assert.equal(r.total, 22);
  });

  test('等级非法时退回默认等级的倍数', () => {
    const r = calculateEventPoints({ placement: 1, level: 99 });
    assert.equal(r.multiplier, EVENT_LEVEL_MULTIPLIER[DEFAULT_EVENT_LEVEL]);
  });

  test('双打赛事一律不计分', () => {
    const r = calculateEventPoints({ placement: 1, level: EVENT_LEVEL.FIRST, isDoubles: true });
    assert.deepEqual(r, { participate: 0, placementScore: 0, multiplier: 0, total: 0 });
  });

  test('自定义参与分生效', () => {
    const r = calculateEventPoints({ placement: 1, config: { eventParticipate: 10 } });
    assert.equal(r.participate, 10);
    assert.equal(r.total, 30);
  });

  test('总分恒等于参与分与名次分之和', () => {
    for (const placement of [1, 2, 3, 4, 5, 8, 9, 16, undefined]) {
      for (const level of [1, 2, 3]) {
        const r = calculateEventPoints({ placement, level });
        assert.equal(r.total, r.participate + r.placementScore);
      }
    }
  });

  test('名额配与策划书 2.1 / 2.2 一致', () => {
    assert.equal(DEFAULT_POINT_CONFIG.eventParticipate, 2);
    assert.equal(DEFAULT_POINT_CONFIG.placementBase[1], 20);
    assert.equal(DEFAULT_POINT_CONFIG.placementBase[2], 14);
    assert.equal(DEFAULT_POINT_CONFIG.placementBase[3], 10);
    assert.equal(DEFAULT_POINT_CONFIG.placementBase[4], 7);
    assert.equal(DEFAULT_POINT_CONFIG.quarterfinalBase, 4);
    assert.equal(DEFAULT_POINT_CONFIG.quarterfinalMaxRank, 8);
    // 等级倍数：一级 4 倍、二级 2 倍、三级 1 倍
    assert.equal(EVENT_LEVEL_MULTIPLIER[EVENT_LEVEL.FIRST], 4);
    assert.equal(EVENT_LEVEL_MULTIPLIER[EVENT_LEVEL.SECOND], 2);
    assert.equal(EVENT_LEVEL_MULTIPLIER[EVENT_LEVEL.THIRD], 1);
  });

  test('已废止的日常积分字段不再出现在默认配置里', () => {
    for (const gone of ['win', 'loss', 'streakBonusThreshold', 'streakBonusMax', 'absencePenalty']) {
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_POINT_CONFIG, gone), false);
    }
  });
});
