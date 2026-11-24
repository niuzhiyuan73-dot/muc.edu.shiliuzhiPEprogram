/**
 * 种子随机数 与 随机工具函数 单元测试
 *
 * 这些测试守护的是一条底线：模拟数据必须可复现。
 * 一旦随机性失控，所有依赖具体数值的测试和界面调试都会失效。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSeededRandom,
  randomInt,
  pick,
  shuffle,
  chance,
} = require('../src/shared/utils/random.js');

describe('createSeededRandom —— 可复现的随机数', () => {
  test('相同种子产生完全相同的数列', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(a(), b());
    }
  });

  test('不同种子产生不同的数列', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    let same = 0;
    for (let i = 0; i < 100; i += 1) {
      if (a() === b()) same += 1;
    }
    assert.ok(same < 5, `两个不同种子应几乎不重合，实际重合 ${same} 次`);
  });

  test('输出落在 [0, 1) 区间内', () => {
    const random = createSeededRandom(2026);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      assert.ok(value >= 0 && value < 1, `越界值：${value}`);
    }
  });

  test('分布大致均匀（十等分每格约 10%）', () => {
    const random = createSeededRandom(7);
    const buckets = new Array(10).fill(0);
    const total = 20000;
    for (let i = 0; i < total; i += 1) {
      buckets[Math.floor(random() * 10)] += 1;
    }
    for (const count of buckets) {
      const ratio = count / total;
      // 允许 20% 的相对偏差，模拟数据不需要密码学级的均匀度
      assert.ok(ratio > 0.08 && ratio < 0.12, `分布不均：${ratio}`);
    }
  });
});

describe('randomInt —— 区间整数', () => {
  test('结果始终落在闭区间内', () => {
    const random = createSeededRandom(11);
    for (let i = 0; i < 500; i += 1) {
      const value = randomInt(random, 3, 7);
      assert.ok(Number.isInteger(value));
      assert.ok(value >= 3 && value <= 7, `越界值：${value}`);
    }
  });

  test('上下界相等时只返回该值', () => {
    const random = createSeededRandom(11);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(randomInt(random, 5, 5), 5);
    }
  });

  test('两端的值都能取到（闭区间而非左闭右开）', () => {
    const random = createSeededRandom(3);
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      seen.add(randomInt(random, 0, 3));
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  });
});

describe('pick —— 随机取元素', () => {
  test('取到的元素必定来自原数组', () => {
    const random = createSeededRandom(5);
    const array = ['x', 'y', 'z'];
    for (let i = 0; i < 200; i += 1) {
      assert.ok(array.includes(pick(random, array)));
    }
  });

  test('空数组返回 undefined 而不是崩溃', () => {
    assert.equal(pick(createSeededRandom(1), []), undefined);
  });

  test('非数组同样安全返回', () => {
    assert.equal(pick(createSeededRandom(1), null), undefined);
  });
});

describe('shuffle —— 洗牌', () => {
  test('不修改原数组', () => {
    const random = createSeededRandom(9);
    const original = [1, 2, 3, 4, 5];
    const copy = [...original];
    shuffle(random, original);
    assert.deepEqual(original, copy);
  });

  test('元素不增不减', () => {
    const random = createSeededRandom(9);
    const original = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = shuffle(random, original);
    assert.equal(result.length, original.length);
    assert.deepEqual([...result].sort((a, b) => a - b), original);
  });

  test('相同种子得到相同的排列', () => {
    const a = shuffle(createSeededRandom(77), [1, 2, 3, 4, 5, 6]);
    const b = shuffle(createSeededRandom(77), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(a, b);
  });

  test('确实打乱了顺序（多跑几次不应每次都一样）', () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8];
    const seen = new Set();
    // 用不同种子模拟「多跑几次」。若洗牌失效，所有结果都会等于原顺序
    for (let seed = 0; seed < 20; seed += 1) {
      seen.add(shuffle(createSeededRandom(seed), original).join(','));
    }
    assert.ok(seen.size > 10, `洗牌结果过于单一，只有 ${seen.size} 种排列`);
  });

  test('长度为 1 或空的数组原样返回', () => {
    const random = createSeededRandom(1);
    assert.deepEqual(shuffle(random, [1]), [1]);
    assert.deepEqual(shuffle(random, []), []);
  });
});

describe('chance —— 概率判定', () => {
  test('概率为 0 时永不发生', () => {
    const random = createSeededRandom(13);
    for (let i = 0; i < 200; i += 1) {
      assert.equal(chance(random, 0), false);
    }
  });

  test('概率为 1 时必然发生', () => {
    const random = createSeededRandom(13);
    for (let i = 0; i < 200; i += 1) {
      assert.equal(chance(random, 1), true);
    }
  });

  test('发生频率与给定概率大致相符', () => {
    const random = createSeededRandom(13);
    let hits = 0;
    const total = 10000;
    for (let i = 0; i < total; i += 1) {
      if (chance(random, 0.3)) hits += 1;
    }
    const ratio = hits / total;
    assert.ok(ratio > 0.27 && ratio < 0.33, `实际频率 ${ratio}，偏离 0.3 过多`);
  });
});
