/**
 * 赛制阶段派发器
 * ============================================================
 * 单败淘汰只有一条主线：一轮打完排下一轮。循环赛、小组赛、以及「小组
 * 打完接着淘汰」的复合赛制，则要按阶段序列逐段推进。这里钉住四件事：
 *
 *   1. 循环赛逐轮放行，一轮打完才排下一轮；
 *   2. 奇数人轮空不生成比赛；
 *   3. 小组赛的闸门是「全部小组打完」，之后才按组内名次跨组交叉；
 *   4. 名次由赛制推导：循环赛按积分表，淘汰赛按输在第几轮，
 *      开了倒三角排位则一路排到第 8 名。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInitialMatches,
  planStageMatches,
  findDependentMatches,
  planGroupPhase,
  knockoutBracket,
  derivePlacements,
  placementsFromBracket,
  hasDoubleKnockout,
  walkDoubleElim,
} = require('../miniprogram/services/format-plan.js');
const { eventMatchKey } = require('../miniprogram/services/draw.js');
const { roundRobinRounds } = require('../miniprogram/utils/standings.js');
const { standardSeedOrder, bracketSizeOf } = require('../miniprogram/utils/bracket.js');
const {
  MATCH_STATUS,
  BRACKET_STAGE,
  EVENT_FORMAT,
  EVENT_PLACEMENT_MODE,
  EVENT_BRONZE_MODE,
} = require('../miniprogram/utils/constants.js');

/** 一场比赛（默认已生效、A 方胜、无逐局比分） */
function mk(eventId, round, stage, slot, a, b, { winner = 'A', group, status = MATCH_STATUS.ACTIVE } = {}) {
  const match = {
    _id: eventMatchKey(eventId, round, stage, slot, group),
    round,
    stage,
    slot,
    teamA: [a],
    teamB: [b],
    scoreA: [],
    scoreB: [],
    winner,
    status,
  };
  if (group !== undefined) match.group = group;
  return match;
}

/** 把派发出来的一轮对阵落成比赛记录 */
function materialize(eventId, planned) {
  return planned.pairs.map((pair, slot) =>
    mk(eventId, planned.round, planned.stage, slot, pair[0], pair[1], { group: planned.group })
  );
}

describe('planStageMatches —— 循环赛逐轮放行', () => {
  const entries = ['u1', 'u2', 'u3', 'u4'];
  const event = { _id: 'rr1', format: EVENT_FORMAT.ROUND_ROBIN };
  const draw = { groups: [{ group: 0, entries }] };

  test('从空台账起步：先排第 1 轮，共两场', () => {
    const plan = planStageMatches({ event, draw, matches: [] });
    assert.equal(plan.ok, true);
    assert.equal(plan.rounds.length, 1);
    assert.equal(plan.rounds[0].round, 1);
    assert.equal(plan.rounds[0].group, 0);
    assert.equal(plan.rounds[0].stage, BRACKET_STAGE.GROUP);
    assert.equal(plan.rounds[0].pairs.length, 2);
  });

  test('一轮打完才放下一轮，三轮走完六种组合各一次', () => {
    let matches = [];
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      const plan = planStageMatches({ event, draw, matches });
      assert.equal(plan.ok, true, `第 ${index + 1} 轮应排得出来`);
      assert.equal(plan.rounds.length, 1);
      assert.equal(plan.rounds[0].round, index + 1);
      seen.push(...plan.rounds[0].pairs.map(([a, b]) => [a, b].sort().join('-')));
      matches = matches.concat(materialize('rr1', plan.rounds[0]));
    }
    assert.deepEqual(seen.slice().sort(), ['u1-u2', 'u1-u3', 'u1-u4', 'u2-u3', 'u2-u4', 'u3-u4']);
    assert.equal(matches.length, 6);
  });

  test('全部打完就无话可排，不会凭空多出一轮', () => {
    let matches = [];
    for (let index = 0; index < 3; index += 1) {
      matches = matches.concat(materialize('rr1', planStageMatches({ event, draw, matches }).rounds[0]));
    }
    const done = planStageMatches({ event, draw, matches });
    assert.equal(done.ok, false);
    assert.deepEqual(done.rounds, []);
  });

  test('上一轮还有一场悬着时，下一轮不冒头', () => {
    const first = planStageMatches({ event, draw, matches: [] }).rounds[0];
    const partial = materialize('rr1', first);
    partial[0] = { ...partial[0], status: MATCH_STATUS.PENDING }; // 一场尚未确认
    const plan = planStageMatches({ event, draw, matches: partial });
    assert.equal(plan.ok, false);
  });
});

describe('buildInitialMatches —— 首轮与轮空', () => {
  test('循环赛奇数人：每轮一场，轮空位不生成比赛', () => {
    const event = { _id: 'rr2', format: EVENT_FORMAT.ROUND_ROBIN, location: '1 号场', startTime: '2026-01-01 09:00' };
    const draw = { groups: [{ group: 0, entries: ['u1', 'u2', 'u3'] }] };
    const drafts = buildInitialMatches(event, draw);

    assert.equal(drafts.length, 1);
    assert.ok(drafts[0].teamA[0] && drafts[0].teamB[0]);
    assert.equal(drafts[0].group, 0);
    assert.equal(drafts[0].stage, BRACKET_STAGE.GROUP);
  });

  test('单败淘汰仍是摆主签表首轮（旧行为不受影响）', () => {
    const event = { _id: 'se1', format: EVENT_FORMAT.SINGLE_ELIM, location: '1 号场', startTime: '2026-01-01 09:00' };
    const draw = { size: 4, slots: ['u1', 'u2', 'u3', 'u4'] };
    const drafts = buildInitialMatches(event, draw);

    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts.map((item) => item._id), [
      eventMatchKey('se1', 1, BRACKET_STAGE.MAIN, 0),
      eventMatchKey('se1', 1, BRACKET_STAGE.MAIN, 1),
    ]);
  });

  test('缺赛事或缺签表时不产出比赛', () => {
    assert.deepEqual(buildInitialMatches(null, { slots: ['u1', 'u2'] }), []);
    assert.deepEqual(buildInitialMatches({ _id: 'x' }, null), []);
  });
});

describe('小组赛 —— 全部打完才出淘汰签表', () => {
  const event = { _id: 'gk1', format: EVENT_FORMAT.GROUP_KNOCKOUT, advancePerGroup: 1, bronzeMode: EVENT_BRONZE_MODE.TIED };
  const draw = {
    groups: [
      { group: 0, entries: ['a1', 'a2'] },
      { group: 1, entries: ['b1', 'b2'] },
    ],
  };

  test('首轮把两组各排一场', () => {
    const plan = planStageMatches({ event, draw, matches: [] });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.rounds.map((item) => item.group).sort(), [0, 1]);
    plan.rounds.forEach((item) => assert.equal(item.stage, BRACKET_STAGE.GROUP));
  });

  test('只有一组打完时，淘汰签表还出不来', () => {
    const plan = planStageMatches({ event, draw, matches: [] });
    const onlyFirst = materialize('gk1', plan.rounds[0]);
    assert.equal(knockoutBracket(event, draw, onlyFirst), null);
  });

  test('两组名次落定后，跨组交叉排出主签表首轮', () => {
    const plan = planStageMatches({ event, draw, matches: [] });
    const matches = plan.rounds.flatMap((item) => materialize('gk1', item));

    const next = planStageMatches({ event, draw, matches });
    assert.equal(next.ok, true);
    assert.equal(next.rounds.length, 1);
    assert.equal(next.rounds[0].stage, BRACKET_STAGE.MAIN);
    // A 组第一 对 B 组第一
    assert.deepEqual(next.rounds[0].pairs, [['a1', 'b1']]);
  });

  test('淘汰赛打完后不再排任何比赛', () => {
    const plan = planStageMatches({ event, draw, matches: [] });
    let matches = plan.rounds.flatMap((item) => materialize('gk1', item));
    const knockout = planStageMatches({ event, draw, matches }).rounds[0];
    matches = matches.concat(materialize('gk1', knockout));

    const after = planStageMatches({ event, draw, matches });
    assert.equal(after.ok, false);
    assert.deepEqual(after.rounds, []);
  });

  test('planGroupPhase 缺分组时安静返回空', () => {
    assert.deepEqual(planGroupPhase(event, { groups: [] }, []), []);
  });
});

describe('derivePlacements —— 名次按赛制推导', () => {
  test('循环赛按积分表排出 1..N', () => {
    const event = { _id: 'rr3', format: EVENT_FORMAT.ROUND_ROBIN };
    const draw = { groups: [{ group: 0, entries: ['u1', 'u2', 'u3'] }] };

    const schedule = roundRobinRounds(['u1', 'u2', 'u3']);
    const matches = schedule.map((pairs, index) =>
      mk('rr3', index + 1, BRACKET_STAGE.GROUP, 0, pairs[0][0], pairs[0][1], { group: 0 })
    );

    const result = derivePlacements({ event, draw, matches });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
    ]);
  });

  test('循环赛没打完时名次尚未确定', () => {
    const event = { _id: 'rr4', format: EVENT_FORMAT.ROUND_ROBIN };
    const draw = { groups: [{ group: 0, entries: ['u1', 'u2', 'u3'] }] };
    const result = derivePlacements({ event, draw, matches: [] });
    assert.equal(result.ok, false);
  });

  test('单人循环赛没有可打的比赛，直接按积分表给名次', () => {
    // 第十八轮审查 P3：allDecided([]) 为 false，单人组会永远卡在「还没打完」。
    const event = { _id: 'rr1', format: EVENT_FORMAT.ROUND_ROBIN };
    const draw = { groups: [{ group: 0, entries: ['u1'] }] };
    const result = derivePlacements({ event, draw, matches: [] });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.results, [{ userId: 'u1', placement: 1 }]);
  });

  test('小组赛：出线者按淘汰成绩、未出线者按小组名次续排', () => {
    const event = { _id: 'gk2', format: EVENT_FORMAT.GROUP_KNOCKOUT, advancePerGroup: 1, bronzeMode: EVENT_BRONZE_MODE.TIED };
    const draw = {
      groups: [
        { group: 0, entries: ['a1', 'a2'] },
        { group: 1, entries: ['b1', 'b2'] },
      ],
    };
    const matches = [
      mk('gk2', 1, BRACKET_STAGE.GROUP, 0, 'a1', 'a2', { group: 0 }),
      mk('gk2', 1, BRACKET_STAGE.GROUP, 0, 'b1', 'b2', { group: 1 }),
      mk('gk2', 1, BRACKET_STAGE.MAIN, 0, 'a1', 'b1'),
    ];

    const result = derivePlacements({ event, draw, matches });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { userId: 'a1', placement: 1 },
      { userId: 'b1', placement: 2 },
      { userId: 'a2', placement: 3 },
      { userId: 'b2', placement: 4 },
    ]);
  });

  test('单败淘汰的名次也一并推算，省去手工录入', () => {
    const event = { _id: 'se2', format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: EVENT_BRONZE_MODE.TIED };
    const draw = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };
    const matches = [
      mk('se2', 1, BRACKET_STAGE.MAIN, 0, 'p1', 'p2'),
      mk('se2', 1, BRACKET_STAGE.MAIN, 1, 'p3', 'p4'),
      mk('se2', 2, BRACKET_STAGE.MAIN, 0, 'p1', 'p3'),
    ];

    const result = derivePlacements({ event, draw, matches });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { userId: 'p1', placement: 1 },
      { userId: 'p3', placement: 2 },
      { userId: 'p2', placement: 3 },
      { userId: 'p4', placement: 3 },
    ]);
  });
});

describe('placementsFromBracket —— 倒三角 5–8 名排位', () => {
  test('4 人签表：半决赛负者按 bronzeMode 并列或分 3/4', () => {
    const event = { _id: 'se4', bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.NONE };
    const bracket = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };
    const matches = [
      mk('se4', 1, BRACKET_STAGE.MAIN, 0, 'p1', 'p2'),
      mk('se4', 1, BRACKET_STAGE.MAIN, 1, 'p3', 'p4'),
      mk('se4', 2, BRACKET_STAGE.MAIN, 0, 'p1', 'p3'),
    ];

    const map = placementsFromBracket(event, bracket, matches);
    assert.deepEqual([...map.entries()].sort((a, b) => a[1] - b[1]), [
      ['p1', 1],
      ['p3', 2],
      ['p2', 3],
      ['p4', 3],
    ]);
  });

  test('打三四名时半决赛负者分成 3、4', () => {
    const event = { _id: 'se5', bronzeMode: EVENT_BRONZE_MODE.PLAYOFF, placementMode: EVENT_PLACEMENT_MODE.NONE };
    const bracket = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };
    const matches = [
      mk('se5', 1, BRACKET_STAGE.MAIN, 0, 'p1', 'p2'),
      mk('se5', 1, BRACKET_STAGE.MAIN, 1, 'p3', 'p4'),
      mk('se5', 2, BRACKET_STAGE.BRONZE, 0, 'p2', 'p4'),
      mk('se5', 2, BRACKET_STAGE.MAIN, 0, 'p1', 'p3'),
    ];

    const map = placementsFromBracket(event, bracket, matches);
    assert.equal(map.get('p2'), 3);
    assert.equal(map.get('p4'), 4);
  });

  test('8 人签表默认不排位：八强负者并列第 5', () => {
    const event = { _id: 'se6', bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.NONE };
    const map = placementsFromBracket(event, { size: 8, slots: eightSlots() }, mainOnlyMatches('se6'));

    assert.equal(map.get('p1'), 1);
    assert.equal(map.get('p5'), 2);
    assert.equal(map.get('p3'), 3);
    assert.equal(map.get('p7'), 3);
    ['p2', 'p4', 'p6', 'p8'].forEach((id) => assert.equal(map.get(id), 5));
  });

  test('开了倒三角：八强负者一路排到第 8 名', () => {
    const event = { _id: 'se7', bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.TOP8 };
    const map = placementsFromBracket(event, { size: 8, slots: eightSlots() }, top8Matches('se7'));

    assert.equal(map.get('p1'), 1);
    assert.equal(map.get('p5'), 2);
    assert.equal(map.get('p3'), 3);
    assert.equal(map.get('p7'), 3);
    assert.equal(map.get('p2'), 5);
    assert.equal(map.get('p6'), 6);
    assert.equal(map.get('p4'), 7);
    assert.equal(map.get('p8'), 8);
  });

  test('排位赛少打一场就宁可不给名次', () => {
    const event = { _id: 'se8', bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.TOP8 };
    const matches = top8Matches('se8').filter(
      (match) => match._id !== eventMatchKey('se8', 3, BRACKET_STAGE.PLACEMENT, 1)
    );
    assert.equal(placementsFromBracket(event, { size: 8, slots: eightSlots() }, matches), null);
  });
});

describe('双败淘汰 —— 胜者组 / 败者组 / 总决赛', () => {
  const draw4 = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };

  test('4 人走完：胜者组冠军一场不败夺冠，名次 1..4 不重不漏', () => {
    const matches = [
      mk('de1', 1, BRACKET_STAGE.WINNERS, 0, 'p1', 'p2', { winner: 'A' }),
      mk('de1', 1, BRACKET_STAGE.WINNERS, 1, 'p3', 'p4', { winner: 'A' }),
      mk('de1', 2, BRACKET_STAGE.WINNERS, 0, 'p1', 'p3', { winner: 'A' }),
      mk('de1', 1, BRACKET_STAGE.LOSERS, 0, 'p2', 'p4', { winner: 'A' }),
      mk('de1', 2, BRACKET_STAGE.LOSERS, 0, 'p2', 'p3', { winner: 'A' }),
      mk('de1', 1, BRACKET_STAGE.GRAND_FINAL, 0, 'p1', 'p2', { winner: 'A' }),
    ];

    const state = walkDoubleElim({ eventId: 'de1', bracket: draw4, matches });
    assert.equal(state.complete, true);
    assert.equal(state.champion, 'p1');
    assert.equal(state.runnerUp, 'p2');
    assert.deepEqual(sortedMap(state.placements), [
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
      ['p4', 4],
    ]);
  });

  test('败者组冠军先赢总决赛时，开了重赛要加赛一场', () => {
    const base = doubleElimFour('de2', { final: 'B' });
    const pending = walkDoubleElim({ eventId: 'de2', bracket: draw4, matches: base, gfReset: true });
    assert.equal(pending.complete, false);
    assert.deepEqual(
      pending.schedule.map((step) => [step.stage, step.round]),
      [[BRACKET_STAGE.GRAND_FINAL, 2]]
    );

    const done = walkDoubleElim({
      eventId: 'de2',
      bracket: draw4,
      matches: base.concat([mk('de2', 2, BRACKET_STAGE.GRAND_FINAL, 0, 'p1', 'p2', { winner: 'B' })]),
      gfReset: true,
    });
    assert.equal(done.complete, true);
    assert.equal(done.champion, 'p2');
    assert.equal(done.runnerUp, 'p1');
  });

  test('关掉重赛时，败者组冠军赢下总决赛一场即夺冠', () => {
    const state = walkDoubleElim({
      eventId: 'de3',
      bracket: draw4,
      matches: doubleElimFour('de3', { final: 'B' }),
      gfReset: false,
    });
    assert.equal(state.complete, true);
    assert.equal(state.champion, 'p2');
    assert.equal(state.runnerUp, 'p1');
  });

  test('非 2 的幂人数轮空不打乱败者组，名次仍是 1..N', () => {
    for (let n = 5; n <= 7; n += 1) {
      const ids = Array.from({ length: n }, (_, index) => `u${index + 1}`);
      const draw = slotsFor(ids);
      assert.equal(hasDoubleKnockout(EVENT_FORMAT.DOUBLE_ELIM), true);
      const { state } = playDoubleElim(`de-n${n}`, draw, () => 'A');
      assert.deepEqual(
        sortedMap(state.placements).map(([, place]) => place),
        Array.from({ length: n }, (_, index) => index + 1),
        `${n} 人的名次应当连续`
      );
      assert.equal(state.placements.has(null), false, '幽灵负者不该出现在名次里');
    }
  });

  test('4–8 人任意胜负组合，名次都是 1..N 且没有幽灵', () => {
    for (let n = 4; n <= 8; n += 1) {
      const ids = Array.from({ length: n }, (_, index) => `u${index + 1}`);
      const draw = slotsFor(ids);
      const { state } = playDoubleElim(`de-any${n}`, draw, (a, b) => (a < b ? 'A' : 'B'));
      const places = sortedMap(state.placements).map(([, place]) => place);
      assert.deepEqual(places, Array.from({ length: n }, (_, index) => index + 1), `n=${n}`);
      assert.equal(new Set(state.placements.keys()).size, n, `n=${n} 人数`);
      assert.equal(state.placements.has(null), false, `n=${n} 无幽灵`);
    }
  });
});

describe('双败淘汰 —— 逐轮放行与复合赛制', () => {
  test('先排胜者组，胜者组全打完后才排败者组', () => {
    const event = { _id: 'de4', format: EVENT_FORMAT.DOUBLE_ELIM, gfReset: true };
    const draw = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };

    const first = planStageMatches({ event, draw, matches: [] });
    assert.deepEqual(first.rounds.map((step) => [step.stage, step.round]), [
      [BRACKET_STAGE.WINNERS, 1],
    ]);

    const afterFirst = first.rounds.flatMap((step) => materialize('de4', step));
    const second = planStageMatches({ event, draw, matches: afterFirst });
    assert.deepEqual(second.rounds.map((step) => [step.stage, step.round]), [
      [BRACKET_STAGE.WINNERS, 2],
    ]);

    const afterSecond = afterFirst.concat(second.rounds.flatMap((step) => materialize('de4', step)));
    const third = planStageMatches({ event, draw, matches: afterSecond });
    assert.deepEqual(third.rounds.map((step) => [step.stage, step.round]), [
      [BRACKET_STAGE.LOSERS, 1],
    ]);
  });

  test('小组赛+双败：小组全部打完后，出线者直接进双败胜者组', () => {
    const event = {
      _id: 'gd1',
      format: EVENT_FORMAT.GROUP_DOUBLE_ELIM,
      advancePerGroup: 2,
      gfReset: true,
    };
    const draw = {
      groups: [
        { group: 0, entries: ['a1', 'a2'] },
        { group: 1, entries: ['b1', 'b2'] },
      ],
    };

    const groupPlan = planStageMatches({ event, draw, matches: [] });
    assert.deepEqual(groupPlan.rounds.map((step) => step.stage), [
      BRACKET_STAGE.GROUP,
      BRACKET_STAGE.GROUP,
    ]);

    const afterGroups = groupPlan.rounds.flatMap((step) => materialize('gd1', step));
    const knockout = planStageMatches({ event, draw, matches: afterGroups });
    assert.equal(knockout.ok, true);
    assert.equal(knockout.rounds[0].stage, BRACKET_STAGE.WINNERS);
    assert.equal(knockout.rounds[0].pairs.length, 2);
  });
});

describe('derivePlacements —— 双败名次推导', () => {
  test('打完的双败赛事推得出 1..N', () => {
    const event = { _id: 'de5', format: EVENT_FORMAT.DOUBLE_ELIM, gfReset: true };
    const draw4 = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };
    const result = derivePlacements({ event, draw: draw4, matches: doubleElimFour('de5') });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { userId: 'p1', placement: 1 },
      { userId: 'p2', placement: 2 },
      { userId: 'p3', placement: 3 },
      { userId: 'p4', placement: 4 },
    ]);
  });

  test('没打完时不给半截名次', () => {
    const event = { _id: 'de6', format: EVENT_FORMAT.DOUBLE_ELIM, gfReset: true };
    const draw4 = { size: 4, slots: ['p1', 'p2', 'p3', 'p4'] };
    const result = derivePlacements({ event, draw: draw4, matches: [] });
    assert.equal(result.ok, false);
  });
});

/** 4 人双败的一整套比赛：p1 胜者组夺冠，p2 从败者组杀出（可用 final 改决赛胜负） */
function doubleElimFour(eventId, { final = 'A' } = {}) {
  return [
    mk(eventId, 1, BRACKET_STAGE.WINNERS, 0, 'p1', 'p2', { winner: 'A' }),
    mk(eventId, 1, BRACKET_STAGE.WINNERS, 1, 'p3', 'p4', { winner: 'A' }),
    mk(eventId, 2, BRACKET_STAGE.WINNERS, 0, 'p1', 'p3', { winner: 'A' }),
    mk(eventId, 1, BRACKET_STAGE.LOSERS, 0, 'p2', 'p4', { winner: 'A' }),
    mk(eventId, 2, BRACKET_STAGE.LOSERS, 0, 'p2', 'p3', { winner: 'A' }),
    mk(eventId, 1, BRACKET_STAGE.GRAND_FINAL, 0, 'p1', 'p2', { winner: final }),
  ];
}

/** 由参赛名单推出标准签表（与 drawBracket 同一套排位，只是不洗牌） */
function slotsFor(ids) {
  const size = bracketSizeOf(ids.length);
  const order = standardSeedOrder(size);
  const byRank = new Array(size).fill(null);
  ids.forEach((id, index) => {
    byRank[index] = id;
  });
  return { size, slots: order.map((rank) => byRank[rank - 1]) };
}

/** 按给定胜负规则逐轮打完双败，返回最终状态与全部比赛 */
function playDoubleElim(eventId, draw, decide, gfReset = true) {
  const matches = [];
  for (let guard = 0; guard < 100; guard += 1) {
    const state = walkDoubleElim({ eventId, bracket: draw, matches, gfReset });
    if (state.complete) return { state, matches };
    assert.ok(state.schedule.length > 0, '双败推进不该卡住');
    const step = state.schedule[0];
    step.pairs.forEach(([a, b], slot) => {
      if (!a || !b) return; // 轮空 / 幽灵签位不产生比赛
      matches.push(mk(eventId, step.round, step.stage, slot, a, b, { winner: decide(a, b) }));
    });
  }
  throw new Error('双败推进超出上限');
}

/** Map<userId, placement> 转成按名次排好的键值对数组 */
function sortedMap(placements) {
  return Array.from(placements, ([userId, placement]) => [userId, placement]).sort(
    (a, b) => a[1] - b[1]
  );
}

/** 八人签位的名字，按签位次序 */
function eightSlots() {
  return ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
}

/** 只打到决赛的主签表比赛：A 方一路取胜 */
function mainOnlyMatches(eventId) {
  return [
    mk(eventId, 1, BRACKET_STAGE.MAIN, 0, 'p1', 'p2'),
    mk(eventId, 1, BRACKET_STAGE.MAIN, 1, 'p3', 'p4'),
    mk(eventId, 1, BRACKET_STAGE.MAIN, 2, 'p5', 'p6'),
    mk(eventId, 1, BRACKET_STAGE.MAIN, 3, 'p7', 'p8'),
    mk(eventId, 2, BRACKET_STAGE.MAIN, 0, 'p1', 'p3'),
    mk(eventId, 2, BRACKET_STAGE.MAIN, 1, 'p5', 'p7'),
    mk(eventId, 3, BRACKET_STAGE.MAIN, 0, 'p1', 'p5'),
  ];
}

/** 主签表 + 5–8 名排位赛全部打完 */
function top8Matches(eventId) {
  return mainOnlyMatches(eventId).concat([
    mk(eventId, 2, BRACKET_STAGE.PLACEMENT, 0, 'p2', 'p4'),
    mk(eventId, 2, BRACKET_STAGE.PLACEMENT, 1, 'p6', 'p8'),
    mk(eventId, 3, BRACKET_STAGE.PLACEMENT, 0, 'p2', 'p6'),
    mk(eventId, 3, BRACKET_STAGE.PLACEMENT, 1, 'p4', 'p8'),
  ]);
}

/* ============================================================
 * 撤销前的自查
 * ============================================================
 * 签表是「排」出来的：确认一场会把下一轮落成真实的比赛记录，而写入侧
 * 只补不覆盖、也没有删除。撤得回分数，却撤不掉已经排下去的那一轮，
 * 于是要先问「后面还挂着场次没有」——有就让管理员从后往前撤。
 * ============================================================ */

describe('findDependentMatches —— 撤销前的自查', () => {
  /**
   * 签表比赛。mk 只把 eventId 编进 _id，真实草稿（见 draw.draftsFromPairs）
   * 是把它落成字段的，而这个自查正是按字段分组，所以这里补上。
   */
  function bracket(eventId, round, stage, slot, status = MATCH_STATUS.ACTIVE) {
    return { ...mk(eventId, round, stage, slot, 'p1', 'p2'), eventId, status };
  }

  const ids = (list) => list.map((m) => m._id);

  test('后面轮次的比赛会挡路，末轮不挡', () => {
    const semi = bracket('e1', 1, BRACKET_STAGE.MAIN, 0);
    const final = bracket('e1', 2, BRACKET_STAGE.MAIN, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(ids(findDependentMatches({ match: semi, matches: [semi, final] })), [final._id]);
    assert.deepEqual(findDependentMatches({ match: final, matches: [semi, final] }), []);
  });

  test('同一轮的邻场互不依赖，不挡', () => {
    const a = bracket('e1', 1, BRACKET_STAGE.MAIN, 0);
    const b = bracket('e1', 1, BRACKET_STAGE.MAIN, 1);
    assert.deepEqual(findDependentMatches({ match: a, matches: [a, b] }), []);
  });

  test('季军赛挡半决赛，却不挡决赛 —— 两者同处第 2 轮', () => {
    const semi = bracket('e1', 1, BRACKET_STAGE.MAIN, 0);
    const final = bracket('e1', 2, BRACKET_STAGE.MAIN, 0);
    const bronze = bracket('e1', 2, BRACKET_STAGE.BRONZE, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(
      ids(findDependentMatches({ match: semi, matches: [semi, final, bronze] })).sort(),
      [final._id, bronze._id].sort()
    );
    assert.deepEqual(
      findDependentMatches({ match: final, matches: [semi, final, bronze] }),
      [],
      '决赛不靠季军赛，不该被它锁死'
    );
  });

  test('小组循环的各轮彼此独立，不比轮次深浅', () => {
    const g1 = bracket('e1', 1, BRACKET_STAGE.GROUP, 0);
    const g2 = bracket('e1', 2, BRACKET_STAGE.GROUP, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(findDependentMatches({ match: g1, matches: [g1, g2] }), []);
  });

  test('小组赛喂出来的淘汰签表算「后面」', () => {
    const g1 = bracket('e1', 1, BRACKET_STAGE.GROUP, 0);
    const ko = bracket('e1', 1, BRACKET_STAGE.MAIN, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(ids(findDependentMatches({ match: g1, matches: [g1, ko] })), [ko._id]);
  });

  test('已经作废的下一轮不再挡路 —— 从后往前撤时它先走', () => {
    const semi = bracket('e1', 1, BRACKET_STAGE.MAIN, 0);
    const final = bracket('e1', 2, BRACKET_STAGE.MAIN, 0, MATCH_STATUS.REVOKED);
    assert.deepEqual(findDependentMatches({ match: semi, matches: [semi, final] }), []);
  });

  test('别的赛事的场次不算数', () => {
    const semi = bracket('e1', 1, BRACKET_STAGE.MAIN, 0);
    const otherEvent = bracket('e2', 2, BRACKET_STAGE.MAIN, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(findDependentMatches({ match: semi, matches: [semi, otherEvent] }), []);
  });

  test('学院赛小场自成一张签表 —— 按 collegeEventId 分组，同样挡得住', () => {
    // 小场刻意把 eventId 留空、改记 collegeEventId（见 college-tie.buildLegDrafts），
    // 撤销走的却是同一个 revokeMatch，所以自查必须也认得出它们
    const leg = (round, slot, status = MATCH_STATUS.ACTIVE) => ({
      _id: `ce1@tie@${round}@${slot}`,
      eventId: null,
      collegeEventId: 'ce1',
      round,
      stage: BRACKET_STAGE.MAIN,
      slot,
      status,
    });
    const r1 = leg(1, 0);
    const r1b = leg(1, 1);
    const r2 = leg(2, 0, MATCH_STATUS.PENDING);
    assert.deepEqual(ids(findDependentMatches({ match: r1, matches: [r1, r1b, r2] })), [r2._id]);
    assert.deepEqual(
      findDependentMatches({ match: r1, matches: [r1, r1b] }),
      [],
      '同一轮里各场小场互不依赖'
    );
  });

  test('日常约球没有签表，永远撤得动；入参残缺也不抛', () => {
    const daily = { _id: 'd1', eventId: null, teamA: ['p1'], teamB: ['p2'], status: MATCH_STATUS.ACTIVE };
    assert.deepEqual(findDependentMatches({ match: daily, matches: [daily] }), []);
    assert.deepEqual(findDependentMatches({ match: daily }), []);
    assert.deepEqual(findDependentMatches(), []);
  });
});

describe('buildInitialMatches —— 赛制由协会决定（网球）', () => {
  const tennisFormat = {
    scoring: 'tennis',
    bestOf: 1,
    setGames: 6,
    tiebreakAt: 6,
    tiebreakPoints: 7,
    noAd: false,
  };

  test('淘汰赛首轮草稿带网球赛制，且不留 gamePoints', () => {
    const event = { _id: 'tn1', format: EVENT_FORMAT.SINGLE_ELIM, location: '网球场', startTime: '2026-01-01 09:00' };
    const draw = { size: 4, slots: ['u1', 'u2', 'u3', 'u4'] };
    const drafts = buildInitialMatches(event, draw, tennisFormat);

    assert.equal(drafts.length, 2);
    drafts.forEach((draft) => {
      assert.equal(draft.scoring, 'tennis');
      assert.equal(draft.setGames, 6);
      assert.equal(draft.tiebreakAt, 6);
      assert.equal(draft.tiebreakPoints, 7);
      assert.equal(draft.gamePoints, undefined, '签表排的是 6 局盘，不能被读成 11 分制');
    });
  });

  test('循环赛与后续轮次同样沿用这份赛制', () => {
    const event = { _id: 'tn2', format: EVENT_FORMAT.ROUND_ROBIN, location: '网球场', startTime: '2026-01-01 09:00' };
    const draw = { groups: [{ group: 0, entries: ['u1', 'u2', 'u3'] }] };
    const drafts = buildInitialMatches(event, draw, tennisFormat);

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].scoring, 'tennis');
    assert.equal(drafts[0].setGames, 6);
  });

  test('不传赛制时照旧 11 分制，老调用方零改动', () => {
    const event = { _id: 'tn3', format: EVENT_FORMAT.SINGLE_ELIM, location: '1 号场', startTime: '2026-01-01 09:00' };
    const draw = { size: 2, slots: ['u1', 'u2'] };
    const drafts = buildInitialMatches(event, draw);

    assert.equal(drafts[0].gamePoints, 11);
    assert.equal(drafts[0].scoring, undefined);
  });
});
