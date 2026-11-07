/**
 * 运动会：预赛晋级与赛制名次（B8a）
 * ============================================================
 * 这里只有纯函数，不碰仓储、不碰事务。原因很直接：晋级与名次是「算数」，
 * 一旦和读写混在一起，就没法用字面量断言「三个人 12.1/12.2/12.3 该谁晋级」。
 * 服务层负责取数、写库，判定全部委托给本模块。
 *
 * 【预赛晋级（D46／D47）】
 * 三种口径都实现，创建项目时逐项选：
 *   per_heat  每组前 N 名晋级；
 *   overall   全部预赛成绩里总排名前 N 名晋级；
 *   hybrid    每组前 n 名直接晋级，再按总成绩补足到 N 名。
 * 晋级边界同分**全部晋级**（D47 已确认），不做抽签、不做加赛：
 *   · 每组前 N 用「组内竞赛排名 ≤ N」判定，并列者名次相同，自然一起进；
 *   · 总成绩前 N 用同样的规则，第 N 与第 N+1 同值时两人都进。
 * 这不是「近似处理」——用竞赛排名（1,2,2,4）表达边界，同分必然同时满足或
 * 同时不满足，不需要额外写一段「扩展并列」的补丁。
 *
 * 【赛制名次（D51）】
 * 单败淘汰的名次由「输在哪一轮」唯一决定：
 *   冠军 1、亚军 2、半决赛负者 3/3、四分之一决赛负者 5/5/5/5……
 * 通式是 `2^(总轮数 - 输的轮次) + 1`，与竞赛排名（1,2,3,3,5,5,5,5）完全一致。
 * 循环赛按胜场排，同胜场先比**组内相互战绩**（小联赛胜场），仍相同才并列。
 *
 * 【为什么不做双败/小组+淘汰】
 * 双败要给每支队伍维护「胜者组/败者组」两条路径，名次还要区分「败者组第几轮
 * 出局」；小组+淘汰要先分组再跨组晋级。两者都不是「加几十行」的量级，而且
 * 学校运动会的拔河几乎都是单败。所以配置时只接受单败与循环，其余赛制当场
 * 拒绝，而不是悄悄按单败跑出一个看起来合理、实际错的名次。
 * ============================================================
 */

const { compareMeasure } = require('./meet-measure.js');
const { bracketSizeOf, standardSeedOrder } = require('../utils/bracket.js');
const { DEFAULT_LANE_CAPACITY } = require('./meet-event-catalog.js');
const { compareCode } = require('../utils/text-order.js');

/**
 * 每组人数（径赛道数）的兜底值。
 *
 * 真正的默认值已由项目模板的 `heatCapacity` 承担（见 catalog 的 `heatRuleOf`）。
 * 这里保留常量只为兼容既有导入点，**不要再写死第二个数字**——两处各写
 * 一个默认值，改场地道数时必然漏掉一处。
 */
const DEFAULT_LANE_COUNT = DEFAULT_LANE_CAPACITY;

/** 晋级口径。 */
const ADVANCE_MODE = Object.freeze({
  PER_HEAT: 'per_heat',
  OVERALL: 'overall',
  HYBRID: 'hybrid',
});

/** 支持自动名次的赛制（与 utils/constants.js 的 EVENT_FORMAT 同名）。 */
const MEET_FORMAT = Object.freeze({
  SINGLE_ELIM: 'single_elim',
  ROUND_ROBIN: 'round_robin',
  GROUP_KNOCKOUT: 'group_knockout',
});

const FORMAT_LABEL = Object.freeze({
  [MEET_FORMAT.SINGLE_ELIM]: '单败淘汰',
  [MEET_FORMAT.ROUND_ROBIN]: '循环赛',
  [MEET_FORMAT.GROUP_KNOCKOUT]: '小组+淘汰',
});

/** 有数值方向的项目（计时/距离/高度/次数/评分）。 */
function rankByValue(rows, order) {
  const sorted = [...rows].sort((a, b) => {
    const compared = compareMeasure(a.value, b.value, order);
    if (compared === null || compared === 0) return 0;
    return compared;
  });
  let lastValue = null;
  let lastRank = 0;
  sorted.forEach((row, index) => {
    if (lastValue !== null && compareMeasure(row.value, lastValue, order) === 0) {
      row.rank = lastRank;
    } else {
      row.rank = index + 1;
      lastValue = row.value;
      lastRank = row.rank;
    }
  });
  return sorted;
}

const isLive = (row) => row && row.status !== 'void' && Number.isFinite(row.value);

/**
 * 由预赛结果算出晋级名单。
 *
 * @param {Object} params
 * @param {Array} params.heats `[{ index, rows: [{ entryKey, value, status }] }]`
 * @param {string} params.mode ADVANCE_MODE
 * @param {number} params.count 晋级总人数（per_heat 时是「每组前 N」）
 * @param {string} params.order 'asc' | 'desc'
 * @returns {{ok:boolean, message?:string, advanced?:Array, perHeat?:Array, heatRanks?:Object}}
 *   advanced 按**总成绩顺序**排列（不是按组），决赛道次可直接用它。
 */
function advanceFromHeats({ heats = [], mode = ADVANCE_MODE.PER_HEAT, count = 1, order } = {}) {
  const target = Number(count);
  if (!Number.isInteger(target) || target < 1) {
    return { ok: false, message: '晋级人数必须是正整数' };
  }
  if (order !== 'asc' && order !== 'desc') {
    return { ok: false, message: '晋级排序方向非法' };
  }
  const list = Array.isArray(heats) ? heats.filter((heat) => heat && Array.isArray(heat.rows)) : [];
  if (list.length === 0) return { ok: false, message: '没有预赛分组' };

  // 组内先排名：并列由竞赛排名自然表达，不需要额外扩展
  const prepared = list.map((heat) => ({
    index: heat.index,
    ranked: rankByValue(heat.rows.filter(isLive).map((row) => ({ ...row })), order),
  }));

  const all = [];
  prepared.forEach((heat) => {
    heat.ranked.forEach((row) => all.push({ ...row, heatIndex: heat.index }));
  });
  if (all.length === 0) return { ok: false, message: '预赛没有任何有效成绩' };

  const globalRanked = rankByValue(all, order);
  const picked = new Set();

  if (mode === ADVANCE_MODE.PER_HEAT) {
    prepared.forEach((heat) => {
      heat.ranked.forEach((row) => {
        if (row.rank <= target) picked.add(row.entryKey);
      });
    });
  } else if (mode === ADVANCE_MODE.OVERALL) {
    globalRanked.forEach((row) => {
      if (row.rank <= target) picked.add(row.entryKey);
    });
  } else if (mode === ADVANCE_MODE.HYBRID) {
    // 每组先取 floor(N / 组数) 人直接晋级，再按总成绩补足到 N。
    // 用 floor 而不是 ceil：ceil 会让「每组前 2」在 N=3、两组时直接进 4 人，
    // 超过约定的晋级人数。N 小于组数时每组一个都不直进，退化成按总成绩取前 N，
    // 这也是「混合晋级」在该情形下唯一说得通的口径。
    const perHeat = Math.floor(target / prepared.length);
    if (perHeat > 0) {
      prepared.forEach((heat) => {
        heat.ranked.forEach((row) => {
          if (row.rank <= perHeat) picked.add(row.entryKey);
        });
      });
    }
    let lastValue;
    for (const row of globalRanked) {
      if (picked.has(row.entryKey)) continue;
      if (picked.size >= target) {
        // 已够人数，但若下一位与刚补进来的人同成绩，仍要一起晋级（D47）
        if (compareMeasure(row.value, lastValue, order) !== 0) break;
      }
      picked.add(row.entryKey);
      lastValue = row.value;
    }
  } else {
    return { ok: false, message: '晋级口径只能是每组前 N、总成绩前 N 或混合晋级' };
  }

  const advanced = globalRanked
    .filter((row) => picked.has(row.entryKey))
    .map((row) => ({
      entryKey: row.entryKey,
      heatIndex: row.heatIndex,
      heatRank: row.rank,
      value: row.value,
    }));

  const perHeat = prepared.map((heat) => ({
    index: heat.index,
    advanced: heat.ranked.filter((row) => picked.has(row.entryKey)).length,
  }));

  return { ok: true, advanced, perHeat, heatRanks: globalRanked };
}

/** 单败淘汰的总轮数：8 人 → 3 轮。 */
function bracketTotalRounds(size) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 2) return 1;
  return Math.max(1, Math.ceil(Math.log2(n)));
}

/** 轮次名称：最后一轮叫决赛，倒数第二轮叫半决赛，其余按序号。 */
function bracketRoundLabel(roundNo, totalRounds) {
  const round = Number(roundNo);
  const total = Number(totalRounds);
  if (round === total) return '决赛';
  if (round === total - 1) return '半决赛';
  return `第 ${round} 轮`;
}

/**
 * 单败淘汰的最终名次。
 *
 * @param {Object} params
 * @param {string[]} params.entries 参赛记录
 * @param {number} params.totalRounds 总轮数
 * @param {Array} params.matches `[{ roundNo, index, entryKeys:[a,b], winnerEntryKey }]`
 * @returns {{ok:boolean, message?:string, rows?:Array, champion?:string, pending?:Array}}
 */
function bracketStandings({ entries = [], totalRounds = 1, matches = [] } = {}) {
  const total = Number(totalRounds) || 1;
  const pending = [];
  const lossRound = new Map();
  let champion = '';

  for (const match of matches) {
    const [a, b] = match.entryKeys || [];
    // 双侧都空是签表补位的空场，不算未决
    if (!a && !b) continue;
    // 有胜负即可判定：轮空场次只有一方（另一方为 null），但它已经有胜者
    if (!match.winnerEntryKey) {
      pending.push({ roundNo: match.roundNo, index: match.index, sessionKey: match.sessionKey || '' });
      continue;
    }
    const loser = match.winnerEntryKey === a ? b : a;
    if (loser) lossRound.set(loser, Number(match.roundNo));
    if (Number(match.roundNo) === total) champion = match.winnerEntryKey;
  }
  if (pending.length > 0) {
    return { ok: false, message: `还有 ${pending.length} 场没有决出胜负`, pending };
  }
  if (!champion) return { ok: false, message: '还没有产生冠军', pending: [] };

  const rows = [];
  for (const entryKey of entries) {
    if (entryKey === champion) {
      rows.push({ entryKey, rank: 1 });
      continue;
    }
    const round = lossRound.get(entryKey);
    // 从未出场（既没赢也没输）不给名次，由调用方按无成绩处理
    if (!round) continue;
    rows.push({ entryKey, rank: Math.pow(2, total - round) + 1 });
  }
  rows.sort((a, b) => a.rank - b.rank || compareCode(a.entryKey, b.entryKey));
  return { ok: true, champion, rows, pending: [] };
}

/**
 * 循环赛对阵表（轮转法）。奇数人补一个空位，轮到空位的人该轮轮空。
 *
 * @param {string[]} entries
 * @returns {Array<Array<[string,string]>>} 每轮的对阵
 */
function roundRobinRounds(entries = []) {
  const list = [...entries];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // 固定第一个位置，其余顺时针轮转
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * 循环赛名次：胜场优先，同胜场比组内相互战绩，仍相同则并列。
 *
 * 只用胜场与相互战绩，不引入净胜局/净胜分——拔河这类项目本来就只有胜负，
 * 引入不存在的指标等于编数据。
 *
 * @returns {{ok:boolean, message?:string, rows?:Array, pending?:Array}}
 */
function roundRobinStandings({ entries = [], matches = [] } = {}) {
  const wins = new Map(entries.map((key) => [key, 0]));
  const beat = new Set();
  const pending = [];

  for (const match of matches) {
    const [a, b] = match.entryKeys || [];
    if (!a && !b) continue;
    if (!match.winnerEntryKey) {
      pending.push({ roundNo: match.roundNo, index: match.index, sessionKey: match.sessionKey || '' });
      continue;
    }
    const loser = match.winnerEntryKey === a ? b : a;
    wins.set(match.winnerEntryKey, (wins.get(match.winnerEntryKey) || 0) + 1);
    if (loser) beat.add(`${match.winnerEntryKey}>${loser}`);
  }
  if (pending.length > 0) {
    return { ok: false, message: `还有 ${pending.length} 场没有决出胜负`, pending };
  }

  const groups = new Map();
  for (const entryKey of entries) {
    const won = wins.get(entryKey) || 0;
    if (!groups.has(won)) groups.set(won, []);
    groups.get(won).push(entryKey);
  }

  const rows = [];
  let position = 1;
  for (const won of [...groups.keys()].sort((a, b) => b - a)) {
    const group = groups.get(won);
    // 组内相互战绩：只统计本组内部谁赢过谁
    const inner = new Map(group.map((key) => [key, 0]));
    for (const a of group) {
      for (const b of group) {
        if (a !== b && beat.has(`${a}>${b}`)) inner.set(a, inner.get(a) + 1);
      }
    }
    const ordered = [...group].sort((a, b) => inner.get(b) - inner.get(a)
      || compareCode(a, b));
    let lastInner = null;
    let lastRank = 0;
    ordered.forEach((entryKey, index) => {
      const rank = lastInner !== null && inner.get(entryKey) === lastInner
        ? lastRank
        : position + index;
      rows.push({ entryKey, rank, wins: won });
      lastInner = inner.get(entryKey);
      lastRank = rank;
    });
    position += group.length;
  }
  return { ok: true, rows, pending: [] };
}

/**
 * 把参赛者分到若干组。
 *
 * 三条约束同时成立：
 *   1. **同单位尽量不同组**（编排规则原文：「同一单位的运动员尽量避免排在同一组」）。
 *      同院内战既消耗自己，也让「每组前 N 晋级」变成对人多那组不公；
 *   2. 各组人数最多差 1——人数不均同样会让每组前 N 失衡；
 *   3. 种子一列一个（1 号进第 1 组、2 号进第 2 组），强手不挤在一组。
 *
 * 预赛分组与小组赛分组是同一件事，只是名字不同，所以共用这一份实现——
 * 各写一份迟早会在「同院要不要分散」这种边界上分叉。
 *
 * @param {string[]} entryKeys 参赛记录主键
 * @param {number} bucketCount 组数
 * @param {string[]} seeds 种子（可空）
 * @param {Function} random 随机源；缺省按原顺序（测试需要可复现）
 * @param {Map<string,string>} [collegeOf] entryKey → collegeId；缺省则不做同院分散
 */
function splitIntoGroups(entryKeys, bucketCount, seeds, random, collegeOf) {
  const count = Math.max(1, Math.floor(Number(bucketCount) || 1));
  const buckets = Array.from({ length: count }, () => []);
  const seedList = (seeds || []).filter(Boolean);
  const seedSet = new Set(seedList);
  seedList.forEach((key, index) => {
    if (buckets[index % count]) buckets[index % count].push(key);
  });

  const rest = (entryKeys || []).filter((key) => !seedSet.has(key));
  const pool = typeof random === 'function'
    ? rest.map((key) => ({ key, r: random() })).sort((a, b) => a.r - b.r).map((row) => row.key)
    : rest;

  for (const key of pool) {
    const college = collegeOf ? collegeOf.get(key) : '';
    // 第一轮：找「还没有本院队员」的组里人数最少的
    let target = -1;
    if (college) {
      for (let i = 0; i < count; i += 1) {
        if (buckets[i].some((other) => collegeOf.get(other) === college)) continue;
        if (target < 0 || buckets[i].length < buckets[target].length) target = i;
      }
    }
    // 每个组都有本院队员（或没有学院信息）：**先比本院人数，再比总人数**。
    // 只比总人数会让同院扎堆——某一组先被塞进两个同院的人，后面就一直往那儿补。
    if (target < 0) {
      target = 0;
      for (let i = 1; i < count; i += 1) {
        const mine = (bucket) => (college
          ? bucket.filter((key) => collegeOf.get(key) === college).length
          : 0);
        const myI = mine(buckets[i]);
        const myTarget = mine(buckets[target]);
        if (myI < myTarget || (myI === myTarget && buckets[i].length < buckets[target].length)) {
          target = i;
        }
      }
    }
    buckets[target].push(key);
  }
  return buckets;
}

/**
 * 种子道次序列：1 号种子居中最优道，之后左右交替。
 *
 * 8 道 → [4,5,3,6,2,7,1,8]；6 道 → [3,4,2,5,1,6]。
 * 这是田径编排的标准做法（中间道次受弯道影响最小），不是随机分配。
 */
function seedLaneOrder(count) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (total === 0) return [];
  const mid = Math.floor((total + 1) / 2);
  const lanes = [];
  for (let step = 0; lanes.length < total && step <= total; step += 1) {
    // step 0 取中间；之后奇数步向右、偶数步向左，逐步加大距离
    const offset = step === 0 ? 0 : Math.ceil(step / 2);
    const lane = step % 2 === 1 ? mid + offset : mid - offset;
    if (lane >= 1 && lane <= total && !lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/**
 * 给一个分道组分配道次。
 *
 * 入参顺序即种子顺序（1 号在前），返回 `{ entryKey: lane }`。
 * 用普通对象而不是 Map：它要直接落库到云开发，Map 过不了 JSON 序列化。
 */
function assignLanes(entryKeys) {
  const keys = (entryKeys || []).filter(Boolean);
  const order = seedLaneOrder(keys.length);
  const lanes = {};
  keys.forEach((key, index) => {
    if (order[index]) lanes[key] = order[index];
  });
  return lanes;
}

/**
 * 小组赛阶段的名次：每组内部按循环赛口径排（胜场 → 相互战绩 → 并列）。
 *
 * @param {Object} params
 * @param {number} params.groupCount 小组数
 * @param {Object} params.groups `{ [index]: entryKey[] }` 各组参赛者
 * @param {Array} params.matches 小组赛对阵（含 groupIndex）
 */
function groupStageStandings({ groups = {}, matches = [] } = {}) {
  const pending = [];
  const rows = [];
  let complete = true;
  for (const key of Object.keys(groups).sort((a, b) => Number(a) - Number(b))) {
    const index = Number(key);
    const entries = groups[key] || [];
    const own = matches.filter((match) => Number(match.groupIndex) === index);
    const result = roundRobinStandings({ entries, matches: own });
    if (!result.ok) complete = false;
    (result.rows || []).forEach((row) => rows.push({ ...row, groupIndex: index }));
    if (!result.ok) pending.push(...(result.pending || []));
  }
  return { complete, rows, pending };
}

/**
 * 小组+淘汰的最终名次。
 *
 * 出线队伍按淘汰赛名次；未出线队伍并列「淘汰赛签位 + 1」。
 * 这样处理是因为未出线者之间没有再打过交叉赛，给出精确名次等于编数据；
 * 并列一个名次既能表达「都止步小组赛」，也不会凭空把某队排在另一队前面。
 */
function groupKnockoutStandings({
  entries = [], groupEntries = {}, advancePerGroup = 1,
  groupMatches = [], knockoutMatches = [], totalRounds = 1,
} = {}) {
  const groupStage = groupStageStandings({ groups: groupEntries, matches: groupMatches });
  if (!groupStage.complete) {
    return { ok: false, message: groupStage.pending.length
      ? `小组赛还有 ${groupStage.pending.length} 场没有决出胜负`
      : '小组赛还没有打完', pending: groupStage.pending };
  }

  // 每组出线几名是**规则**，不是分组数据。早先把它和 groupEntries 混在一个
  // 参数里，结果 advancePerGroup 永远是 undefined → 一个都出不了线。
  const perGroup = Number(advancePerGroup) || 1;
  const qualified = [];
  for (const key of Object.keys(groupEntries).sort((a, b) => Number(a) - Number(b))) {
    const index = Number(key);
    groupStage.rows
      .filter((row) => row.groupIndex === index && row.rank <= perGroup)
      .forEach((row) => qualified.push(row.entryKey));
  }
  const bracket = bracketStandings({ entries: qualified, totalRounds, matches: knockoutMatches });
  if (!bracket.ok) return bracket;

  const size = bracketSizeOf(qualified.length);
  const rows = bracket.rows.map((row) => ({ ...row, stage: 'knockout' }));
  const ranked = new Set(rows.map((row) => row.entryKey));
  for (const entryKey of entries) {
    if (ranked.has(entryKey)) continue;
    rows.push({ entryKey, rank: size + 1, stage: 'group' });
  }
  rows.sort((a, b) => a.rank - b.rank || compareCode(a.entryKey, b.entryKey));
  return { ok: true, rows, champion: bracket.champion, qualified, pending: [] };
}

module.exports = {
  ADVANCE_MODE,
  DEFAULT_LANE_COUNT,
  MEET_FORMAT,
  FORMAT_LABEL,
  rankByValue,
  advanceFromHeats,
  bracketTotalRounds,
  bracketRoundLabel,
  bracketStandings,
  roundRobinRounds,
  roundRobinStandings,
  splitIntoGroups,
  seedLaneOrder,
  assignLanes,
  groupStageStandings,
  groupKnockoutStandings,
};
