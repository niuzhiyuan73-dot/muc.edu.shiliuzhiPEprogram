/**
 * 淘汰赛签表算法
 * ============================================================
 * 【为什么把「标准种子排位」搬出模拟数据】
 * 抽签只解决两件事：强手不能早碰（1 号与 2 号分处上下半区），轮空要给
 * 强手。这两件事其实由同一张表说了算——标准种子排位表。它原先埋在
 * seed.js 的模拟数据生成里，正式抽签要用同一份实现；若各抄一份，迟早
 * 分叉。所以抬到工具层，seed.js 反向引用。
 *
 * 【一套算法同时覆盖「纯随机」与「有种子」】
 * 把排位表的输出理解为「位置 → 实力名次」，再按名次填人：
 *   名次 1..S   → 种子（已按 1 号、2 号… 排好）
 *   名次 S+1..N → 非种子，洗牌后填入
 *   名次 N+1..P → 轮空
 * S = 0 时前半段没有种子，整张表就是纯随机抽签。轮空天然落在对阵高种子
 * 的位置——因为最低的名次恰好被排到强手对面。
 *
 * 【为什么人数不必是 2 的幂】
 * 报名人数几乎不会刚好是 8、16。补齐到不小于 N 的最小 2 的幂 P，多出的
 * P−N 个位置就是轮空。这正是原 simulateBracket 抛错、做不了真实抽签的
 * 原因（它只服务于固定规模的演示数据）。
 * ============================================================
 */

const { shuffle } = require('./random.js');

/**
 * 生成标准种子排位表。
 *
 * 【为什么不能按实力两两相邻配对】
 * 若把 8 人按实力排成 1,2,3,4,5,6,7,8 再 (1,2)(3,4)(5,6)(7,8) 配对，
 * 头号种子与二号种子第一轮就要碰面，最强的两人必有一个首轮出局，
 * 赛事含金量大打折扣。标准排位把强手分散到不同半区，让高种子在决赛前
 * 都遇不上彼此，这才是真实赛事的编排习惯。
 *
 * 返回「位置 → 种子序号」的数组。8 人时为 [1,8,4,5,2,7,3,6]，
 * 即 (1 对 8)(4 对 5)(2 对 7)(3 对 6)。
 *
 * 递推构造：规模每扩大一倍，原有序列中每个种子 s 后面补一个
 * (新规模 + 1 - s)，凑成「和为 新规模+1」的对称对。
 *
 * @param {number} size 参赛规模，必须是 2 的幂次
 * @returns {number[]} 各位置应放置的种子序号（从 1 开始）
 */
function standardSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const roundSize = order.length * 2;
    const next = [];
    for (const seed of order) {
      next.push(seed);
      next.push(roundSize + 1 - seed);
    }
    order = next;
  }
  return order;
}

/**
 * 不小于 count 的最小 2 的幂。count ≤ 1 时返回 1。
 *
 * @param {number} count
 * @returns {number}
 */
function bracketSizeOf(count) {
  let size = 1;
  while (size < count) size *= 2;
  return size;
}

/**
 * 抽签：把参赛者摆进签表，产出首轮对阵与轮空名单。
 *
 * 纯函数、无副作用；随机源由调用方传入，便于测试与「落库一个种子值即可
 * 复核」的可复现要求。
 *
 * @param {Object} params
 * @param {string[]} params.entries 参赛者编号（顺序无关）
 * @param {string[]} [params.seeds] 种子编号，**已按 1 号、2 号…排好序**；可为空
 * @param {Function} params.random 随机源 () => [0,1)
 * @returns {{
 *   ok:boolean, size:number, slots:Array<string|null>, byes:string[],
 *   seeds:string[], pairs:Array<Array<string|null>>, errors:Object, firstError:string
 * }}
 *   slots 为「位置 → 参赛者」，null 表示该位置轮空；
 *   pairs 为按 (0,1)(2,3)… 切分好的首轮对阵；
 *   byes 为首轮轮空的参赛者（对阵轮空位置的那一方）。
 */
function drawBracket({ entries, seeds = [], random } = {}) {
  const errors = {};
  const list = Array.isArray(entries) ? entries : [];
  const seedList = Array.isArray(seeds) ? seeds : [];

  if (list.length < 2) {
    errors.entries = '参赛人数不足 2 人，无法抽签';
  } else if (new Set(list).size !== list.length) {
    errors.entries = '参赛名单存在重复';
  }

  if (new Set(seedList).size !== seedList.length) {
    errors.seeds = '种子名单存在重复';
  } else if (seedList.length > list.length) {
    errors.seeds = '种子数不能超过参赛人数';
  } else if (seedList.some((id) => !list.includes(id))) {
    errors.seeds = '种子必须是参赛者之一';
  }

  if (typeof random !== 'function') {
    errors.random = '缺少随机源';
  }

  const firstError = errors.entries || errors.seeds || errors.random || '';
  if (firstError) {
    return {
      ok: false,
      size: 0,
      slots: [],
      byes: [],
      seeds: seedList.slice(),
      pairs: [],
      errors,
      firstError,
    };
  }

  const size = bracketSizeOf(list.length);
  // 位置 → 实力名次；再翻成 名次 → 参赛者，两次映射即得到签表
  const order = standardSeedOrder(size);

  const seedSet = new Set(seedList);
  const nonSeeds = shuffle(random, list.filter((id) => !seedSet.has(id)));

  // 名次从 1 起算；前 S 名是种子，接着是非种子，末尾留空即轮空
  const byRank = new Array(size).fill(null);
  seedList.forEach((id, index) => {
    byRank[index] = id;
  });
  nonSeeds.forEach((id, index) => {
    byRank[seedList.length + index] = id;
  });

  const slots = order.map((rank) => byRank[rank - 1]);

  const pairs = [];
  const byes = [];
  for (let i = 0; i < size; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    pairs.push([a, b]);
    if (a === null && b !== null) byes.push(b);
    else if (b === null && a !== null) byes.push(a);
  }

  return {
    ok: true,
    size,
    slots,
    byes,
    seeds: seedList.slice(),
    pairs,
    errors: {},
    firstError: '',
  };
}

module.exports = {
  standardSeedOrder,
  bracketSizeOf,
  drawBracket,
};
