/**
 * B8a：晋级与赛制名次的纯算式
 * ============================================================
 * 这一组不碰仓储，全部是字面量断言，因为「谁晋级」「谁第几名」必须能被
 * 人工核算：
 *   · 每组前 N：3 人一组取 2 人；
 *   · 总成绩前 N：跨组按成绩取前 N；
 *   · 边界同分：第 2 与第 3 同成绩 → 两人都进（D47 全部晋级）；
 *   · 单败：8 队名次必须是 1,2,3,3,5,5,5,5；
 *   · 循环赛：先胜场、再相互战绩、仍平则并列。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  ADVANCE_MODE, advanceFromHeats, bracketStandings, bracketTotalRounds,
  bracketRoundLabel, roundRobinRounds, roundRobinStandings, rankByValue,
} = require('../miniprogram/services/meet-advance.js');

/** 构造一组预赛：heats[index] = [[entryKey, 成绩], ...] */
function heatsOf(spec) {
  return spec.map((rows, index) => ({
    index: index + 1,
    rows: rows.map(([entryKey, value]) => ({ entryKey, value, status: 'result' })),
  }));
}

test('每组前 N：两组各取前 1，按总成绩排序返回', () => {
  const result = advanceFromHeats({
    heats: heatsOf([
      [['a', 1230], ['b', 1250]],
      [['c', 1220], ['d', 1240]],
    ]),
    mode: ADVANCE_MODE.PER_HEAT,
    count: 1,
    order: 'asc', // 计时项目越小越好
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.advanced.map((row) => row.entryKey), ['c', 'a']);
  assert.deepEqual(result.perHeat, [{ index: 1, advanced: 1 }, { index: 2, advanced: 1 }]);
});

test('总成绩前 N：跨组按成绩取，不看组别', () => {
  const result = advanceFromHeats({
    heats: heatsOf([
      [['a', 1230], ['b', 1290]],
      [['c', 1220], ['d', 1240]],
    ]),
    mode: ADVANCE_MODE.OVERALL,
    count: 2,
    order: 'asc',
  });
  assert.deepEqual(result.advanced.map((row) => row.entryKey), ['c', 'a']);
});

test('边界同分全部晋级：第 2 与第 3 同成绩时两人都进（D47）', () => {
  const result = advanceFromHeats({
    heats: heatsOf([[
      ['a', 1220], ['b', 1240], ['c', 1240], ['d', 1260],
    ]]),
    mode: ADVANCE_MODE.OVERALL,
    count: 2,
    order: 'asc',
  });
  // 竞赛排名是 1,2,2,4 —— 名次 ≤2 的三人一起晋级，不是「取够 2 个就停」
  assert.equal(result.advanced.length, 3);
  assert.deepEqual(result.advanced.map((row) => row.entryKey), ['a', 'b', 'c']);
});

test('混合晋级：先每组取够，再按总成绩补足', () => {
  const result = advanceFromHeats({
    heats: heatsOf([
      [['a', 1210], ['b', 1290]],
      [['c', 1220], ['d', 1230]],
    ]),
    // 每组先取 1 人（ceil(3/2)=2？—— 这里 N=3、两组，perHeat=2，故直接取满）
    mode: ADVANCE_MODE.HYBRID,
    count: 3,
    order: 'asc',
  });
  assert.equal(result.advanced.length, 3);
  assert.deepEqual(result.advanced.map((row) => row.entryKey), ['a', 'c', 'd']);
});

test('无成绩不参与晋级，也不会因为记 0 而排到最前（A3）', () => {
  const result = advanceFromHeats({
    heats: [{
      index: 1,
      rows: [
        { entryKey: 'a', value: 1240, status: 'result' },
        { entryKey: 'b', value: null, status: 'void' },
        { entryKey: 'c', value: 1250, status: 'result' },
      ],
    }],
    mode: ADVANCE_MODE.PER_HEAT,
    count: 2,
    order: 'asc',
  });
  assert.deepEqual(result.advanced.map((row) => row.entryKey), ['a', 'c']);
});

test('排序方向必须给定，缺失时直接拒绝而不是默认升序', () => {
  const result = advanceFromHeats({
    heats: heatsOf([[['a', 1]]]),
    mode: ADVANCE_MODE.PER_HEAT,
    count: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /排序方向/);
});

test('竞赛排名：并列同名次且跳号', () => {
  const rows = rankByValue([
    { entryKey: 'a', value: 1220 },
    { entryKey: 'b', value: 1220 },
    { entryKey: 'c', value: 1240 },
  ], 'asc');
  assert.deepEqual(rows.map((row) => [row.entryKey, row.rank]), [['a', 1], ['b', 1], ['c', 3]]);
});

test('单败名次：8 队 1,2,3,3,5,5,5,5', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const matches = [
    // 四分之一决赛
    { roundNo: 1, index: 1, entryKeys: ['a', 'b'], winnerEntryKey: 'a' },
    { roundNo: 1, index: 2, entryKeys: ['c', 'd'], winnerEntryKey: 'c' },
    { roundNo: 1, index: 3, entryKeys: ['e', 'f'], winnerEntryKey: 'e' },
    { roundNo: 1, index: 4, entryKeys: ['g', 'h'], winnerEntryKey: 'g' },
    // 半决赛
    { roundNo: 2, index: 1, entryKeys: ['a', 'c'], winnerEntryKey: 'a' },
    { roundNo: 2, index: 2, entryKeys: ['e', 'g'], winnerEntryKey: 'e' },
    // 决赛
    { roundNo: 3, index: 1, entryKeys: ['a', 'e'], winnerEntryKey: 'a' },
  ];
  const result = bracketStandings({ entries, totalRounds: 3, matches });
  assert.equal(result.ok, true, result.message);
  const rankOf = new Map(result.rows.map((row) => [row.entryKey, row.rank]));
  assert.deepEqual(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key) => rankOf.get(key)),
    [1, 5, 3, 5, 2, 5, 3, 5],
  );
});

test('单败未打完：拒绝出表并报出还差几场', () => {
  const result = bracketStandings({
    entries: ['a', 'b', 'c', 'd'],
    totalRounds: 2,
    matches: [
      { roundNo: 1, index: 1, entryKeys: ['a', 'b'], winnerEntryKey: 'a' },
      { roundNo: 1, index: 2, entryKeys: ['c', 'd'], winnerEntryKey: '' },
      { roundNo: 2, index: 1, entryKeys: ['a', null], winnerEntryKey: '' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /2 场/);
});

test('轮次名称：1 轮即决赛，2 轮是半决赛＋决赛', () => {
  assert.equal(bracketRoundLabel(1, 1), '决赛');
  assert.equal(bracketRoundLabel(1, 2), '半决赛');
  assert.equal(bracketRoundLabel(2, 2), '决赛');
  assert.equal(bracketRoundLabel(1, 3), '第 1 轮');
  assert.equal(bracketTotalRounds(16), 4);
});

test('循环赛对阵：4 队 3 轮 6 场，每对恰好交手一次', () => {
  const rounds = roundRobinRounds(['a', 'b', 'c', 'd']);
  const pairs = rounds.flat().map((pair) => [...pair].sort().join('-'));
  assert.equal(pairs.length, 6);
  assert.equal(new Set(pairs).size, 6);
  assert.deepEqual([...new Set(pairs)].sort(), ['a-b', 'a-c', 'a-d', 'b-c', 'b-d', 'c-d']);
});

test('循环赛对阵：5 队（奇数）每轮有一人轮空，共 5 轮 10 场', () => {
  const rounds = roundRobinRounds(['a', 'b', 'c', 'd', 'e']);
  assert.equal(rounds.length, 5);
  assert.equal(rounds.flat().length, 10);
});

test('循环赛名次：胜场优先，同胜场比相互战绩', () => {
  const matches = [
    { roundNo: 1, index: 1, entryKeys: ['a', 'b'], winnerEntryKey: 'a' },
    { roundNo: 1, index: 2, entryKeys: ['a', 'c'], winnerEntryKey: 'a' },
    { roundNo: 1, index: 3, entryKeys: ['d', 'a'], winnerEntryKey: 'd' },
    { roundNo: 1, index: 4, entryKeys: ['b', 'c'], winnerEntryKey: 'b' },
    { roundNo: 1, index: 5, entryKeys: ['b', 'd'], winnerEntryKey: 'b' },
    { roundNo: 1, index: 6, entryKeys: ['c', 'd'], winnerEntryKey: 'c' },
  ];
  const result = roundRobinStandings({ entries: ['a', 'b', 'c', 'd'], matches });
  assert.equal(result.ok, true, result.message);
  const rankOf = new Map(result.rows.map((row) => [row.entryKey, row.rank]));
  // a 与 b 都是 2 胜，a 赢过 b → a 在前；c 与 d 都是 1 胜，c 赢过 d
  assert.deepEqual([rankOf.get('a'), rankOf.get('b'), rankOf.get('c'), rankOf.get('d')], [1, 2, 3, 4]);
});

test('循环赛名次：相互战绩也分不出时并列', () => {
  const matches = [
    { roundNo: 1, index: 1, entryKeys: ['a', 'b'], winnerEntryKey: 'a' },
    { roundNo: 1, index: 2, entryKeys: ['b', 'c'], winnerEntryKey: 'b' },
    { roundNo: 1, index: 3, entryKeys: ['c', 'a'], winnerEntryKey: 'c' },
  ];
  const result = roundRobinStandings({ entries: ['a', 'b', 'c'], matches });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.rows.map((row) => row.rank), [1, 1, 1]);
});

test('循环赛未打完：拒绝出表', () => {
  const result = roundRobinStandings({
    entries: ['a', 'b'],
    matches: [{ roundNo: 1, index: 1, entryKeys: ['a', 'b'], winnerEntryKey: '' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /1 场/);
});

test('heatRank 记组内名次，overallRank 才是所有组混排后的名次', () => {
  const result = advanceFromHeats({
    heats: heatsOf([[['a10', 10], ['a11', 11]], [['b12', 12], ['b13', 13]]]),
    mode: ADVANCE_MODE.PER_HEAT, count: 1, order: 'desc',
  });
  assert.equal(result.ok, true, result.message);
  const a11 = result.advanced.find((row) => row.entryKey === 'a11');
  const b13 = result.advanced.find((row) => row.entryKey === 'b13');
  assert.equal(a11.heatRank, 1, 'a11 是第 1 组第一，组内名次应为 1');
  assert.equal(a11.overallRank, 3, 'a11 的总成绩排在 b13、b12 之后');
  assert.equal(b13.heatRank, 1);
  assert.equal(b13.overallRank, 1);
});
