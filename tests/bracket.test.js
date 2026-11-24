/**
 * 淘汰赛签表算法
 * ============================================================
 * 抽签要同时保证三件事，缺一不可：
 *   1. 种子不能早碰——1 号与 2 号分处上下半区，决赛前遇不上；
 *   2. 轮空给高种子——人数不是 2 的幂时，空位优先留给强手；
 *   3. 每人恰好一个签位，不多不少。
 * 这一组把三条钉死，另附可复现性（同一种子值必得同一张签表）。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { standardSeedOrder, bracketSizeOf, drawBracket } = require('../src/shared/utils/bracket.js');
const { createSeededRandom } = require('../src/shared/utils/random.js');

/** 参赛者 u1..uN */
function entrants(n) {
  return Array.from({ length: n }, (_, i) => `u${i + 1}`);
}

describe('standardSeedOrder —— 标准种子排位表', () => {
  test('小规模逐级正确', () => {
    assert.deepEqual(standardSeedOrder(1), [1]);
    assert.deepEqual(standardSeedOrder(2), [1, 2]);
    assert.deepEqual(standardSeedOrder(4), [1, 4, 2, 3]);
  });

  test('8 人时是 [1,8,4,5,2,7,3,6]——种子分散在不同半区', () => {
    assert.deepEqual(standardSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  });

  test('每张表都是 1..size 的一个排列', () => {
    for (const size of [2, 4, 8, 16, 32]) {
      const order = standardSeedOrder(size);
      assert.equal(order.length, size);
      assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i + 1));
    }
  });
});

describe('bracketSizeOf —— 补齐到 2 的幂', () => {
  test('恰好是 2 的幂时不变，否则扩到下一个', () => {
    assert.equal(bracketSizeOf(1), 1);
    assert.equal(bracketSizeOf(2), 2);
    assert.equal(bracketSizeOf(3), 4);
    assert.equal(bracketSizeOf(5), 8);
    assert.equal(bracketSizeOf(8), 8);
    assert.equal(bracketSizeOf(9), 16);
    assert.equal(bracketSizeOf(11), 16);
  });
});

describe('drawBracket —— 参数校验', () => {
  test('人数不足 2 人拒绝', () => {
    const result = drawBracket({ entries: ['u1'], random: createSeededRandom(1) });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /不足 2 人/);
  });

  test('参赛名单重复拒绝', () => {
    const result = drawBracket({ entries: ['u1', 'u1'], random: createSeededRandom(1) });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /重复/);
  });

  test('种子不在参赛名单里拒绝', () => {
    const result = drawBracket({
      entries: ['u1', 'u2'],
      seeds: ['u9'],
      random: createSeededRandom(1),
    });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /种子必须是参赛者/);
  });

  test('种子数超过参赛人数拒绝', () => {
    const result = drawBracket({
      entries: ['u1', 'u2'],
      seeds: ['u1', 'u2', 'u3'],
      random: createSeededRandom(1),
    });
    assert.equal(result.ok, false);
  });

  test('缺少随机源拒绝', () => {
    const result = drawBracket({ entries: ['u1', 'u2'] });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /随机源/);
  });
});

describe('drawBracket —— 纯随机（无种子）', () => {
  test('8 人无轮空，每人恰好一个签位', () => {
    const list = entrants(8);
    const result = drawBracket({ entries: list, random: createSeededRandom(7) });

    assert.equal(result.ok, true);
    assert.equal(result.size, 8);
    assert.equal(result.byes.length, 0);
    assert.deepEqual([...result.slots].sort(), [...list].sort());
  });

  test('人数不是 2 的幂时补齐，空位即轮空', () => {
    const list = entrants(6);
    const result = drawBracket({ entries: list, random: createSeededRandom(7) });

    assert.equal(result.size, 8);
    assert.equal(result.byes.length, 2, '8 签位里空出的 2 个位置就是 2 个轮空');
    assert.deepEqual([...result.slots].filter(Boolean).sort(), [...list].sort());
    assert.equal(result.slots.filter((slot) => slot === null).length, 2);
  });

  test('同一个随机种子值必得同一张签表（可复核）', () => {
    const a = drawBracket({ entries: entrants(11), random: createSeededRandom(2026) });
    const b = drawBracket({ entries: entrants(11), random: createSeededRandom(2026) });
    assert.deepEqual(a.slots, b.slots);
  });
});

describe('drawBracket —— 有种子', () => {
  test('1、2 号种子分处上下半区，决赛前不相遇', () => {
    // 8 签位：位置 0 是 1 号种子，位置 4 是 2 号种子；两者最早只可能在决赛碰面
    const list = entrants(8);
    const result = drawBracket({ entries: list, seeds: ['u1', 'u2'], random: createSeededRandom(3) });

    assert.equal(result.slots[0], 'u1');
    assert.equal(result.slots[4], 'u2');
  });

  test('种子序号原样保留，不被洗牌打乱', () => {
    const list = entrants(8);
    const seeds = ['u5', 'u3', 'u1', 'u7'];
    const result = drawBracket({ entries: list, seeds, random: createSeededRandom(3) });

    assert.deepEqual(result.seeds, seeds);
    // 排位表 8 人为 [1,8,4,5,2,7,3,6]（位置 → 名次），据此翻出各种子的位置：
    // 名次 1→位置 0、名次 2→位置 4、名次 3→位置 6、名次 4→位置 2
    assert.equal(result.slots[0], 'u5'); // 1 号种子（名次 1）
    assert.equal(result.slots[4], 'u3'); // 2 号种子（名次 2）
    assert.equal(result.slots[6], 'u1'); // 3 号种子（名次 3）
    assert.equal(result.slots[2], 'u7'); // 4 号种子（名次 4）
  });

  test('6 人 2 种子：轮空全部给高种子', () => {
    const list = entrants(6);
    const result = drawBracket({ entries: list, seeds: ['u1', 'u2'], random: createSeededRandom(9) });

    assert.equal(result.size, 8);
    assert.deepEqual(result.byes, ['u1', 'u2'], '两个轮空按序给 1、2 号种子');
    assert.equal(result.slots[1], null);
    assert.equal(result.slots[5], null);
  });

  test('3 人 1 种子：唯一的轮空给这位种子', () => {
    const result = drawBracket({ entries: entrants(3), seeds: ['u1'], random: createSeededRandom(11) });
    assert.deepEqual(result.byes, ['u1']);
  });

  test('种子数等于参赛人数时，人人按种子序落位、不再随机', () => {
    const list = entrants(4);
    const result = drawBracket({ entries: list, seeds: ['u1', 'u2', 'u3', 'u4'], random: createSeededRandom(5) });

    // 排位表 4 人为 [1,4,2,3] → 位置 0 放 1 号、位置 1 放 4 号、位置 2 放 2 号、位置 3 放 3 号
    assert.deepEqual(result.slots, ['u1', 'u4', 'u2', 'u3']);
  });

  test('首轮对阵按 (0,1)(2,3)… 切分，轮空位置的对家留在 pairs 里', () => {
    const result = drawBracket({ entries: entrants(6), seeds: ['u1', 'u2'], random: createSeededRandom(9) });
    assert.equal(result.pairs.length, 4);
    assert.deepEqual(result.pairs[0], ['u1', null]);
    assert.deepEqual(result.pairs[2], ['u2', null]);
  });

  test('每人不重不漏，无论是否有种子', () => {
    const list = entrants(7);
    const result = drawBracket({ entries: list, seeds: ['u1', 'u2', 'u3'], random: createSeededRandom(13) });

    const placed = result.slots.filter(Boolean);
    assert.deepEqual([...placed].sort(), [...list].sort());
    assert.equal(result.byes.length, result.size - list.length);
  });
});
