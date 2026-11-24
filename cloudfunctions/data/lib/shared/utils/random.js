/**
 * 可复现的伪随机数生成器
 * ============================================================
 * 【为什么不用 Math.random()】
 * 模拟数据必须「每次运行都一样」。否则：
 *   - 单元测试无法断言具体数值（这次跑出 1420，下次 1395）
 *   - 界面调试时排名忽上忽下，无法判断是代码问题还是数据变了
 *   - 团队协作时，两人看到的数据不同，无法复现问题
 *
 * 所以用固定种子的伪随机数：只要种子相同，产生的数列就完全相同。
 *
 * 算法采用 mulberry32：代码短、速度快、分布均匀，
 * 足够模拟数据使用（不用于任何安全场景）。
 * ============================================================
 */

/**
 * 创建一个带种子的随机数生成器。
 *
 * @param {number} seed 种子。相同种子必定产生相同数列。
 * @returns {Function} 调用一次返回 [0, 1) 区间的随机数
 *
 * @example
 * const r1 = createSeededRandom(42);
 * const r2 = createSeededRandom(42);
 * r1() === r2();  // true，永远成立
 */
function createSeededRandom(seed) {
  let state = seed >>> 0;

  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成区间内的随机整数（含两端）。
 *
 * @param {Function} random 随机数生成器
 * @param {number} min 下界（含）
 * @param {number} max 上界（含）
 * @returns {number}
 */
function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * 从数组中随机取一个元素。
 *
 * @param {Function} random
 * @param {Array} array
 * @returns {*} 数组非空时返回其中一个元素，否则返回 undefined
 */
function pick(random, array) {
  if (!Array.isArray(array) || array.length === 0) {
    return undefined;
  }
  return array[Math.floor(random() * array.length)];
}

/**
 * 洗牌（Fisher-Yates 算法），返回新数组，不修改原数组。
 *
 * 用朴素实现时常见的错误是每个位置随机交换一次，那样会破坏均匀分布；
 * Fisher-Yates 从后往前逐个确定，能保证每种排列等概率出现。
 *
 * @param {Function} random
 * @param {Array} array
 * @returns {Array} 打乱顺序的新数组
 */
function shuffle(random, array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 按概率判断是否发生。
 *
 * @param {Function} random
 * @param {number} probability 发生概率，区间 [0, 1]
 * @returns {boolean}
 */
function chance(random, probability) {
  return random() < probability;
}

module.exports = {
  createSeededRandom,
  randomInt,
  pick,
  shuffle,
  chance,
};
