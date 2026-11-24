/**
 * 循环赛 / 小组赛的编排与积分表
 * ============================================================
 * 这里钉住三件纯计算的事，它们共同决定「谁在哪一组、谁排第几」：
 *   1. groupEntries    —— 蛇形分组，强手分散；
 *   2. roundRobinRounds —— 圆桌轮转法，奇数人轮空不生成比赛；
 *   3. computeStandings —— 平局链，且绝不留平局。
 *
 * 最后一条最要紧：积分表是名次与积分的唯一依据，名次一旦随遍历顺序
 * 漂移，同一场比赛在两台机器上就能算出两个第 3 名。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupEntries,
  roundRobinRounds,
  computeStandings,
  allDecided,
} = require('../src/shared/utils/standings.js');
const { MATCH_STATUS } = require('../src/shared/utils/constants.js');

/** 一场已生效、判明了胜负的单打比赛 */
function played(idA, idB, { scoreA, scoreB, winner = 'A', status = MATCH_STATUS.ACTIVE } = {}) {
  return {
    _id: `${idA}-${idB}`,
    teamA: [idA],
    teamB: [idB],
    scoreA: scoreA || [],
    scoreB: scoreB || [],
    winner,
    status,
  };
}

describe('groupEntries —— 蛇形分组，强手分散', () => {
  test('6 人分 2 组走折线：1、4、5 号同组，2、3、6 号同组', () => {
    const groups = groupEntries(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'], 2);
    assert.deepEqual(groups, [
      ['e1', 'e4', 'e5'],
      ['e2', 'e3', 'e6'],
    ]);
  });

  test('不传组数即单组，全名单原样落进去', () => {
    assert.deepEqual(groupEntries(['e1', 'e2', 'e3']), [['e1', 'e2', 'e3']]);
  });

  test('空名单与非数组入参不会抛错', () => {
    assert.deepEqual(groupEntries([], 2), [[], []]);
    assert.deepEqual(groupEntries(null, 1), [[]]);
  });

  test('每个人恰好落进一组，不重不漏', () => {
    const entries = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const flat = groupEntries(entries, 2).flat();
    assert.deepEqual(flat.slice().sort(), entries.slice().sort());
  });
});

describe('roundRobinRounds —— 圆桌轮转，人人碰一遍', () => {
  /** 把逐轮对局摊平，便于比对集合 */
  function flat(rounds) {
    return rounds.flat();
  }

  test('4 人排出 3 轮，每轮 2 场，六种组合各出现一次', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c', 'd']);
    assert.equal(rounds.length, 3);
    rounds.forEach((pairs) => assert.equal(pairs.length, 2));

    const keys = flat(rounds).map(([x, y]) => [x, y].sort().join('-'));
    assert.deepEqual(keys.slice().sort(), ['a-b', 'a-c', 'a-d', 'b-c', 'b-d', 'c-d']);
  });

  test('同一人在同一轮不会出现两次', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c', 'd', 'e']);
    rounds.forEach((pairs) => {
      const seen = new Set();
      pairs.forEach(([x, y]) => {
        assert.ok(!seen.has(x) && !seen.has(y), '同一轮里有人被排了两场');
        seen.add(x);
        seen.add(y);
      });
    });
  });

  test('奇数人补占位：每轮一人轮空，三场一场不少', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c']);
    assert.equal(rounds.length, 3);
    rounds.forEach((pairs) => assert.equal(pairs.length, 1));

    const keys = flat(rounds).map(([x, y]) => [x, y].sort().join('-'));
    assert.deepEqual(keys.slice().sort(), ['a-b', 'a-c', 'b-c']);
  });

  test('不足 2 人排不出比赛', () => {
    assert.deepEqual(roundRobinRounds([]), []);
    assert.deepEqual(roundRobinRounds(['a']), []);
  });

  test('同一名单重跑必得同一张赛程（可复核）', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(roundRobinRounds(ids), roundRobinRounds(ids));
  });
});

describe('computeStandings —— 名次由战绩算出来', () => {
  test('胜场多者靠前，局分与总分一并累计', () => {
    const rows = computeStandings({
      entries: ['a', 'b', 'c'],
      matches: [
        played('a', 'b', { scoreA: [11, 11], scoreB: [9, 7] }),
        played('a', 'c', { scoreA: [11, 11], scoreB: [5, 3] }),
        played('b', 'c', { scoreA: [11, 11], scoreB: [6, 4] }),
      ],
    });

    assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
    assert.deepEqual(rows.map((row) => row.rank), [1, 2, 3]);
    assert.deepEqual(rows.map((row) => row.wins), [2, 1, 0]);
    assert.deepEqual(rows.map((row) => row.losses), [0, 1, 2]);
    assert.deepEqual(rows.map((row) => row.gameDiff), [4, 0, -4]);
    assert.deepEqual(rows.map((row) => row.pointDiff), [20, 6, -26]);
    assert.deepEqual(rows.map((row) => row.played), [2, 2, 2]);
  });

  test('相互战绩优先于净胜分：正面赢过对方者压过对方', () => {
    // x 赢 y、y 赢 z，两人同为 1 胜；y 的净胜分远好于 x，但正面交手输了，
    // 名次就该是 x 在前——这正是平局链第二级存在的意义。
    const rows = computeStandings({
      entries: ['x', 'y', 'z'],
      matches: [
        played('x', 'y', { scoreA: [11, 5, 11], scoreB: [9, 11, 9] }),
        played('y', 'z', { scoreA: [11, 11], scoreB: [2, 2] }),
      ],
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get('x').wins, 1);
    assert.equal(byId.get('y').wins, 1);
    assert.equal(byId.get('y').gameDiff, byId.get('x').gameDiff, '净胜局相同，才轮到相互战绩说话');
    assert.ok(byId.get('y').pointDiff > byId.get('x').pointDiff, 'y 的净胜分更好');
    assert.deepEqual(rows.map((row) => row.id), ['x', 'y', 'z']);
  });

  test('局分打平时按记录的胜者判，不能默认判给 B', () => {
    // 两局各胜一局（1:1），靠总分定胜负，记录判定 A 胜。
    // 曾经的比较器在局分相等时无条件取 B，把 A 到手的胜利记成了 B 的。
    const rows = computeStandings({
      entries: ['a', 'b'],
      matches: [played('a', 'b', { scoreA: [11, 5], scoreB: [5, 11], winner: 'A' })],
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get('a').wins, 1);
    assert.equal(byId.get('b').wins, 0);
    assert.equal(byId.get('b').losses, 1);
    assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
  });

  test('全同战绩时按签位次序兜底，绝不并列', () => {
    const rows = computeStandings({ entries: ['p', 'q'], matches: [] });
    assert.deepEqual(rows.map((row) => row.id), ['p', 'q']);
    assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
  });

  test('待确认与被撤销的比赛不计入积分表', () => {
    const rows = computeStandings({
      entries: ['a', 'b'],
      matches: [
        played('a', 'b', { winner: 'A', status: MATCH_STATUS.PENDING }),
        played('a', 'b', { winner: 'A', status: MATCH_STATUS.REVOKED }),
      ],
    });

    assert.deepEqual(rows.map((row) => row.wins), [0, 0]);
    assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
  });

  test('组外的比赛不会算进本组积分表', () => {
    const rows = computeStandings({
      entries: ['a', 'b'],
      matches: [played('a', 'outside', { scoreA: [11], scoreB: [1] })],
    });

    assert.deepEqual(rows.map((row) => row.played), [0, 0]);
  });
});

describe('allDecided —— 小组出线的闸门', () => {
  test('全部生效并判明胜负才算打完', () => {
    assert.equal(allDecided([played('a', 'b'), played('a', 'c')]), true);
  });

  test('空表、待确认、无胜方都算没打完', () => {
    assert.equal(allDecided([]), false);
    assert.equal(allDecided([played('a', 'b', { status: MATCH_STATUS.PENDING })]), false);
    assert.equal(allDecided([played('a', 'b', { winner: null })]), false);
  });
});
