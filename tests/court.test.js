/**
 * 场地分配 单元测试
 *
 * 需求只有一句「同一轮次场地不能重复」，但它是靠四个性质立住的，
 * 每条都对应一个会真出错的场景：
 *   1. 同池不重复 —— 同轮两场同时开打却拿到同一块场地；
 *   2. 场地够用时只有一批 —— 分批机制不该在不需要时露出来；
 *   3. 与输入顺序无关 —— 签表生成走「只补不覆盖」，同一批比赛会被重算，
 *      若结果随读库顺序漂移，界面上刷新一次场号就变了；
 *   4. courtNo 恒在 1..N 内 —— 越界会显示出一块根本不存在的场地。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  poolKeyOf,
  compareForCourt,
  normalizeCourtCount,
  planCourts,
  withCourts,
} = require('../src/shared/services/court.js');
const { BRACKET_STAGE, COURT_LIMITS } = require('../src/shared/utils/constants.js');

/** 造一场比赛。只带分配用得到的字段，_id 用来兜底排序 */
function match(id, extra = {}) {
  return {
    _id: id,
    stage: BRACKET_STAGE.MAIN,
    round: 1,
    slot: 0,
    group: null,
    ...extra,
  };
}

/** 按 _id 汇总场号，方便比对「同一场比赛在不同输入顺序下的结果」 */
function courtById(list, courtCount) {
  const plan = planCourts(list, courtCount);
  const map = new Map();
  list.forEach((item, index) => map.set(item._id, plan[index].courtNo));
  return map;
}

describe('poolKeyOf —— 「同一轮次」的口径', () => {
  test('淘汰树的四个阶段共用同一个池：同轮决赛与季军赛会同时开打', () => {
    const round3 = { round: 3 };
    const main = poolKeyOf({ ...round3, stage: BRACKET_STAGE.MAIN });
    const bronze = poolKeyOf({ ...round3, stage: BRACKET_STAGE.BRONZE });
    const placement = poolKeyOf({ ...round3, stage: BRACKET_STAGE.PLACEMENT });
    const gf = poolKeyOf({ ...round3, stage: BRACKET_STAGE.GRAND_FINAL });

    assert.strictEqual(main, bronze);
    assert.strictEqual(main, placement);
    assert.strictEqual(main, gf);
  });

  test('双败的胜者组与败者组分池：两个区的 round 各自从 1 计数', () => {
    const wb = poolKeyOf({ stage: BRACKET_STAGE.WINNERS, round: 1 });
    const lb = poolKeyOf({ stage: BRACKET_STAGE.LOSERS, round: 1 });
    assert.notStrictEqual(wb, lb, '不能把胜者组第 1 轮与败者组第 1 轮当成同一批');
  });

  test('小组赛跨组合并成一个池：各组同轮次通常同时开打', () => {
    const groupA = poolKeyOf({ stage: BRACKET_STAGE.GROUP, group: 1, round: 2 });
    const groupB = poolKeyOf({ stage: BRACKET_STAGE.GROUP, group: 2, round: 2 });
    assert.strictEqual(groupA, groupB);
  });

  test('小组池与淘汰池不会撞在一起：group 阶段的 round 与正赛各算各的', () => {
    const group = poolKeyOf({ stage: BRACKET_STAGE.GROUP, group: 1, round: 1 });
    const knockout = poolKeyOf({ stage: BRACKET_STAGE.MAIN, round: 1 });
    assert.notStrictEqual(group, knockout);
  });

  test('阶段缺省当正赛；轮次不是数字时当 0，不产生 undefined 池键', () => {
    assert.strictEqual(poolKeyOf({ round: 2 }), poolKeyOf({ stage: BRACKET_STAGE.MAIN, round: 2 }));
    assert.strictEqual(poolKeyOf({ round: undefined }), 'ko|0');
  });
});

describe('compareForCourt —— 池内排序必须是全序', () => {
  test('同轮次先排正赛，再排季军赛；同阶段按签位', () => {
    const list = [
      match('x_bronze', { stage: BRACKET_STAGE.BRONZE, slot: 0 }),
      match('x_main_1', { slot: 1 }),
      match('x_main_0', { slot: 0 }),
    ];
    const sorted = list.slice().sort(compareForCourt).map((item) => item._id);
    assert.deepStrictEqual(sorted, ['x_main_0', 'x_main_1', 'x_bronze']);
  });

  test('各项全平时用 _id 兜底：比较式不能返回 0，否则排序取决于输入顺序', () => {
    const a = match('x_a');
    const b = match('x_b');
    assert.ok(compareForCourt(a, b) < 0);
    assert.ok(compareForCourt(b, a) > 0);
    assert.strictEqual(compareForCourt(a, a), 0);
  });

  test('排序不依赖运行时语言环境：同样的两项在任意次序下都排出同一个结果', () => {
    const ids = ['x_10', 'x_2', 'x_A', 'x_a'];
    const forward = ids
      .map((id) => match(id))
      .sort(compareForCourt)
      .map((item) => item._id);
    const backward = ids
      .slice()
      .reverse()
      .map((id) => match(id))
      .sort(compareForCourt)
      .map((item) => item._id);
    assert.deepStrictEqual(forward, backward);
  });
});

describe('normalizeCourtCount —— 场地数的兜底', () => {
  test('合法值原样返回，小数截断', () => {
    assert.strictEqual(normalizeCourtCount(3), 3);
    assert.strictEqual(normalizeCourtCount('4'), 4);
    assert.strictEqual(normalizeCourtCount(2.9), 2);
  });

  test('缺失 / 非法 / 小于 1 一律当 1 块：历史赛事没有这个字段', () => {
    for (const value of [undefined, null, '', 'abc', 0, -3, NaN, Infinity]) {
      assert.strictEqual(normalizeCourtCount(value), 1, `输入 ${String(value)}`);
    }
  });

  test('超过上限收到上限，保证 courtNo ≤ courtCount 恒成立', () => {
    assert.strictEqual(normalizeCourtCount(COURT_LIMITS.MAX + 50), COURT_LIMITS.MAX);
  });
});

describe('planCourts —— 场地够用', () => {
  test('同池内一场一个场号，绝不重复', () => {
    const list = [match('x_0', { slot: 0 }), match('x_1', { slot: 1 }), match('x_2', { slot: 2 })];
    const plan = planCourts(list, 3);

    assert.deepStrictEqual(plan.map((item) => item.courtNo), [1, 2, 3]);
    assert.deepStrictEqual(plan.map((item) => item.wave), [1, 1, 1], '够用时只有一批');
  });

  test('场地比比赛多时只用到前几块，不空转', () => {
    const list = [match('x_0', { slot: 0 }), match('x_1', { slot: 1 })];
    const plan = planCourts(list, 5);
    assert.deepStrictEqual(plan.map((item) => item.courtNo), [1, 2]);
  });

  test('池间互不影响：两个池各自从 1 号场开始', () => {
    const list = [
      match('x_main_0', { round: 1, slot: 0 }),
      match('x_main_1', { round: 1, slot: 1 }),
      match('x_wb_0', { stage: BRACKET_STAGE.WINNERS, round: 1, slot: 0 }),
      match('x_wb_1', { stage: BRACKET_STAGE.WINNERS, round: 1, slot: 1 }),
    ];
    const plan = planCourts(list, 2);
    assert.deepStrictEqual(plan.map((item) => item.courtNo), [1, 2, 1, 2]);
  });

  test('轮次不同就是不同的池：第 1 轮的场号不会占住第 2 轮的', () => {
    const list = [
      match('x_r1', { round: 1, slot: 0 }),
      match('x_r2', { round: 2, slot: 0 }),
      match('x_r3', { round: 3, slot: 0 }),
    ];
    const plan = planCourts(list, 1);
    assert.deepStrictEqual(plan.map((item) => item.courtNo), [1, 1, 1]);
    assert.deepStrictEqual(plan.map((item) => item.wave), [1, 1, 1], '不同轮次各算一批');
  });

  test('空列表返回空数组，不抛错', () => {
    assert.deepStrictEqual(planCourts([], 3), []);
    assert.deepStrictEqual(planCourts(null, 3), []);
  });
});

describe('planCourts —— 场地不够时自动分批', () => {
  test('8 场 3 块场地：同一批内不重复，超出部分排到下一批', () => {
    const list = Array.from({ length: 8 }, (_, index) => match(`x_${index}`, { slot: index }));
    const plan = planCourts(list, 3);

    assert.deepStrictEqual(
      plan.map((item) => item.courtNo),
      [1, 2, 3, 1, 2, 3, 1, 2]
    );
    assert.deepStrictEqual(
      plan.map((item) => item.wave),
      [1, 1, 1, 2, 2, 2, 3, 3]
    );

    // 逐批检查：这是需求 3 的准确含义
    const byWave = new Map();
    plan.forEach((item, index) => {
      if (!byWave.has(item.wave)) byWave.set(item.wave, []);
      byWave.get(item.wave).push(item.courtNo);
    });
    byWave.forEach((courts, wave) => {
      assert.strictEqual(
        new Set(courts).size,
        courts.length,
        `第 ${wave} 批内场号重复了：${courts.join(',')}`
      );
    });
  });

  test('场号恒在 1..N 内，任何场地数都不越界', () => {
    const list = Array.from({ length: 13 }, (_, index) => match(`x_${index}`, { slot: index }));
    for (let count = COURT_LIMITS.MIN; count <= COURT_LIMITS.MAX; count += 1) {
      planCourts(list, count).forEach((item) => {
        assert.ok(item.courtNo >= 1 && item.courtNo <= count, `${count} 块场地排出 ${item.courtNo}`);
        assert.ok(item.wave >= 1);
      });
    }
  });

  test('一整轮切完为止：批次数 = ceil(场次数 / 场地数)', () => {
    const list = Array.from({ length: 8 }, (_, index) => match(`x_${index}`, { slot: index }));
    const plan = planCourts(list, 3);
    const waves = new Set(plan.map((item) => item.wave));
    assert.strictEqual(waves.size, Math.ceil(8 / 3));
  });
});

describe('planCourts —— 可重入（与输入顺序无关）', () => {
  test('打乱输入顺序，同一场比赛仍拿到同一个场号', () => {
    const ordered = Array.from({ length: 7 }, (_, index) => match(`x_${index}`, { slot: index }));
    const shuffled = [ordered[4], ordered[0], ordered[6], ordered[2], ordered[5], ordered[1], ordered[3]];

    const first = courtById(ordered, 3);
    const second = courtById(shuffled, 3);

    ordered.forEach((item) => {
      assert.strictEqual(second.get(item._id), first.get(item._id), `${item._id} 的场号漂移了`);
    });
  });

  test('跨池打乱同样稳定：分组打散后各池仍各排各的', () => {
    const ordered = [
      match('x_main_0', { round: 1, slot: 0 }),
      match('x_main_1', { round: 1, slot: 1 }),
      match('x_wb_0', { stage: BRACKET_STAGE.WINNERS, round: 1, slot: 0 }),
      match('x_wb_1', { stage: BRACKET_STAGE.WINNERS, round: 1, slot: 1 }),
      match('x_g_0', { stage: BRACKET_STAGE.GROUP, group: 1, round: 1, slot: 0 }),
      match('x_g_1', { stage: BRACKET_STAGE.GROUP, group: 2, round: 1, slot: 1 }),
    ];
    const shuffled = [ordered[3], ordered[5], ordered[0], ordered[4], ordered[2], ordered[1]];

    const first = courtById(ordered, 2);
    const second = courtById(shuffled, 2);
    ordered.forEach((item) => {
      assert.strictEqual(second.get(item._id), first.get(item._id), `${item._id} 的场号漂移了`);
    });
  });

  test('同一份输入算两遍结果完全一致', () => {
    const list = Array.from({ length: 9 }, (_, index) => match(`x_${index}`, { slot: index }));
    assert.deepStrictEqual(planCourts(list, 4), planCourts(list.slice(), 4));
  });

  test('场地数缺失（历史赛事）时全部落到 1 号场，不抛错', () => {
    const list = [match('x_0', { slot: 0 }), match('x_1', { slot: 1 }), match('x_2', { slot: 2 })];
    assert.deepStrictEqual(planCourts(list, undefined).map((item) => item.courtNo), [1, 1, 1]);
  });
});

describe('withCourts —— 回填场号', () => {
  test('返回带 courtNo 的新对象，不改动入参', () => {
    const list = [match('x_0', { slot: 0 }), match('x_1', { slot: 1 })];
    const filled = withCourts(list, 2);

    assert.deepStrictEqual(filled.map((item) => item.courtNo), [1, 2]);
    assert.deepStrictEqual(list.map((item) => item.courtNo), [undefined, undefined], '入参不能被改');
    assert.notStrictEqual(filled[0], list[0], '必须是新对象');
    // 其余字段原样带过去
    assert.strictEqual(filled[1]._id, 'x_1');
    assert.strictEqual(filled[1].slot, 1);
  });
});
