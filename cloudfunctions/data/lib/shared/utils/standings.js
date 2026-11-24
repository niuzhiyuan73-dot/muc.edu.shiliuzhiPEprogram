/**
 * 循环赛 / 小组赛的编排与积分表
 * ============================================================
 * 循环赛与淘汰赛是两种完全不同的编排方式：淘汰赛是「输一场就出局」的
 * 倒立树，循环赛是「人人碰一遍」的圆桌。这里放三件纯计算的事：
 *
 *   1. groupEntries    —— 把名单分进各组（蛇形，强手分散）
 *   2. roundRobinRounds —— 排出组内全部对局（圆桌轮转法）
 *   3. computeStandings —— 按战绩算出名次（含平局链）
 *
 * 【为什么是纯模块】
 * 分组结果与名次都必须可复核：同一个 seedValue 重跑一遍，谁在哪一组、
 * 谁排第几，必须一模一样。因此这里不碰 wx、不碰数据源、不看时钟，
 * 一切顺序都由入参决定（见 tests/standings.test.js）。
 *
 * 【为什么平局链要写到「签位次序」为止】
 * 积分表是名次与积分的唯一依据。若名次会随对象遍历顺序漂移，同一场
 * 比赛在两台机器上就能算出两个第 3 名——这是不可复核的。所以比较器
 * 的每一级都必须确定，最后一级用「分组时的原始次序」兜底，绝不留平局。
 * ============================================================
 */

const { MATCH_STATUS, TEAM_ID_SEPARATOR } = require('./constants.js');
const { gameWinners } = require('./match-format.js');

/**
 * 比赛记录里一方的「签位编号」。
 *
 * 单打一方是一个人，编号即本人；双打一方是两人，编号是两人拼成的队号
 * （与 draw.teamIdOf 同一拼法）。积分表的 entries 正是签位编号，两者必须
 * 同形才能对上；若只取 teamA[0]，双打每一场都会因对不上而被静默漏掉。
 *
 * @param {Array<string>} team
 * @returns {string}
 */
function entryIdOf(team) {
  return (Array.isArray(team) ? team : []).filter(Boolean).join(TEAM_ID_SEPARATOR);
}

/**
 * 蛇形（snake）把有序名单分进各组。
 *
 * 【为什么不是「前 1/4 一组、后 1/4 一组」】
 * 名单已按种子强弱排好。若顺着切，第一组会挤满最强的几人，第二组全是
 * 弱手——小组赛还没打，出线名额就定了。蛇形让 1 号去 A 组、2 号去 B 组，
 * 折返时再让 3 号去 B 组、4 号去 A 组，强手被摊到各组，组间实力才均衡。
 *
 * 例：6 人分 2 组 → [[e1,e4,e5],[e2,e3,e6]]
 *
 * @param {string[]} entries 已按强弱排序的参赛者
 * @param {number} [groupCount=1] 组数，循环赛为 1
 * @returns {string[][]} 各组名单（组内保持分配次序）
 */
function groupEntries(entries, groupCount = 1) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const count = Number.isFinite(Number(groupCount)) && Number(groupCount) >= 1
    ? Math.floor(Number(groupCount))
    : 1;
  const groups = Array.from({ length: count }, () => []);

  list.forEach((id, index) => {
    const row = Math.floor(index / count);
    const col = index % count;
    // 偶数行从左往右，奇数行从右往左，折线走位
    const target = row % 2 === 0 ? col : count - 1 - col;
    groups[target].push(id);
  });

  return groups;
}

/**
 * 圆桌轮转法排出循环赛的全部轮次。
 *
 * 【做法】
 * 固定第一个位置，其余位置每轮顺时针转一格，首尾两两配对。n 个人的
 * 循环赛恰好要打 n−1 轮，每轮 n/2 场（n 为奇数时先补一个「轮空」占位，
 * 于是每轮有一人歇着）。
 *
 * 【奇数人为什么补占位而不是少排一轮】
 * 3 个人两两交手要打 3 场，每轮 1 场、共 3 轮——若直接两两组合成
 * (a,b) 就漏了 a-c 与 b-c。补一个占位后，占位转到谁对面谁就轮空，
 * 三场一场不少。
 *
 * 【轮空为什么不生成比赛】
 * 与淘汰赛同一条纪律：没有对手就没有比赛。这里把含占位的对阵直接跳过，
 * 由调用方按「这一轮的空缺」去理解谁在歇。
 *
 * @param {string[]} entryIds 同一小组的参赛者
 * @returns {Array<Array<Array<string>>>} 逐轮的场次；每场为 [甲, 乙]
 */
function roundRobinRounds(entryIds) {
  const list = Array.isArray(entryIds) ? entryIds.slice() : [];
  if (list.length < 2) return [];

  // 奇数人补一个占位，凑成偶数；占位不参赛
  const seats = list.length % 2 === 0 ? list.slice() : list.concat([null]);
  const size = seats.length;
  const totalRounds = size - 1;
  const rounds = [];
  let order = seats.slice();

  for (let round = 0; round < totalRounds; round += 1) {
    const pairs = [];
    for (let i = 0; i < size / 2; i += 1) {
      const a = order[i];
      const b = order[size - 1 - i];
      if (a && b) pairs.push([a, b]);
    }
    rounds.push(pairs);

    // 固定第一个，其余顺时针转一格
    order = [order[0]].concat([order[size - 1]], order.slice(1, size - 1));
  }

  return rounds;
}

/**
 * 一场比赛折算进积分表的几项数据。
 * 只认「已生效且判明了胜负」的比赛——待确认、被撤销都不算数。
 *
 * @param {Object} match
 * @returns {{a:string,b:string,gamesA:number,gamesB:number,pointsA:number,pointsB:number,winner:string}|null}
 */
function tallyOf(match) {
  if (!match || match.status !== MATCH_STATUS.ACTIVE || !match.winner) return null;
  const a = entryIdOf(match.teamA);
  const b = entryIdOf(match.teamB);
  if (!a || !b) return null;

  const scoreA = Array.isArray(match.scoreA) ? match.scoreA : [];
  const scoreB = Array.isArray(match.scoreB) ? match.scoreB : [];

  // 有比分就按逐单元胜负算局分与总分；比分缺失时退化成「胜方 1:0」，
  // 至少不把这场已确认的比赛漏掉。
  //
  // 网球不需要分支：scoreA/scoreB 的元素是「每盘的局数」，元素多寡比大小
  // 就是谁拿下这一盘，所以这里的 gamesA 实际是「赢了几盘」、pointsA 是
  // 「赢了多少局」。积分表并列时的第三级（总得分）用它依然说得通。
  let gamesA;
  let gamesB;
  if (scoreA.length > 0 && scoreA.length === scoreB.length) {
    const winners = gameWinners(scoreA, scoreB);
    gamesA = winners.filter((w) => w === true).length;
    gamesB = winners.filter((w) => w === false).length;
  } else {
    gamesA = match.winner === 'A' ? 1 : 0;
    gamesB = match.winner === 'B' ? 1 : 0;
  }

  const pointsA = scoreA.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const pointsB = scoreB.reduce((sum, value) => sum + (Number(value) || 0), 0);

  return { a, b, gamesA, gamesB, pointsA, pointsB, winner: match.winner };
}

/**
 * 一组内相互交手的胜场小表——平局链的第二级。
 *
 * 【为什么不能直接用总胜场】
 * 两人总胜场相同、其中一人正面赢过对方，排名就该压过对方。三人以上
 * 循环套时（甲胜乙、乙胜丙、丙胜甲）小表也分不出高低，那就自然落到
 * 下一级（净胜局），不会卡死。
 *
 * @param {string[]} ids 同一胜场的若干人
 * @param {Array<Object>} matches 组内全部比赛
 * @returns {Map<string, number>} 各自在小组内的胜场
 */
function headToHeadWins(ids, matches) {
  const inGroup = new Set(ids);
  const wins = new Map(ids.map((id) => [id, 0]));

  matches.forEach((match) => {
    const tally = tallyOf(match);
    if (!tally) return;
    if (!inGroup.has(tally.a) || !inGroup.has(tally.b)) return;
    if (match.winner === 'A') wins.set(tally.a, wins.get(tally.a) + 1);
    else wins.set(tally.b, wins.get(tally.b) + 1);
  });

  return wins;
}

/**
 * 计算一组循环赛的积分表。
 *
 * 【排序依据，从强到弱】
 *   1. 胜场多者靠前
 *   2. 相互战绩：同胜场的人里，赢过其余人的靠前
 *   3. 净胜局（拿下局数 − 丢掉局数）
 *   4. 净胜分（总得分 − 总失分）
 *   5. 签位次序（分组时的原始次序）——保证绝不留平局
 *
 * 前四级是通行的排名口径，第五级是为了「可复核」而设的兜底：真打到
 * 全同，也得有一个确定的先后，否则名次每次刷新都可能变。
 *
 * @param {Object} params
 * @param {string[]} params.entries 本组参赛者（顺序即签位次序）
 * @param {Array<Object>} [params.matches] 本组全部比赛
 * @returns {Array<Object>} 按名次排好的行，rank 从 1 开始
 */
function computeStandings({ entries, matches } = {}) {
  const ids = Array.isArray(entries) ? entries.slice() : [];
  const list = Array.isArray(matches) ? matches : [];
  const counted = list.map(tallyOf).filter(Boolean);

  const slotOf = new Map(ids.map((id, index) => [id, index]));
  const rows = ids.map((id, index) => ({
    id,
    rank: 0,
    played: 0,
    wins: 0,
    losses: 0,
    gamesWon: 0,
    gamesLost: 0,
    pointsWon: 0,
    pointsLost: 0,
    gameDiff: 0,
    pointDiff: 0,
    slot: index,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  counted.forEach((tally) => {
    const a = byId.get(tally.a);
    const b = byId.get(tally.b);
    if (!a || !b) return; // 组外的比赛不算进本组积分表

    a.played += 1;
    b.played += 1;
    a.gamesWon += tally.gamesA;
    a.gamesLost += tally.gamesB;
    b.gamesWon += tally.gamesB;
    b.gamesLost += tally.gamesA;
    a.pointsWon += tally.pointsA;
    a.pointsLost += tally.pointsB;
    b.pointsWon += tally.pointsB;
    b.pointsLost += tally.pointsA;

    // 局分相同时（例如两局各胜一局，靠总分定胜负）不能默认判给 B ——
    // 那会把一场 A 赢的比赛记成 B 赢。以记录里判定的 winner 为准。
    const aWon =
      tally.gamesA === tally.gamesB ? tally.winner === 'A' : tally.gamesA > tally.gamesB;
    const winner = aWon ? a : b;
    const loser = aWon ? b : a;
    winner.wins += 1;
    loser.losses += 1;
  });

  rows.forEach((row) => {
    row.gameDiff = row.gamesWon - row.gamesLost;
    row.pointDiff = row.pointsWon - row.pointsLost;
  });

  rows.sort((x, y) => (y.wins - x.wins) || (x.slot - y.slot));

  // 同胜场的人再按相互战绩分级；套圈时分不出高下就交给净胜局
  const ranked = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].wins === rows[i].wins) j += 1;
    const tier = rows.slice(i, j);
    if (tier.length > 1) {
      const h2h = headToHeadWins(tier.map((row) => row.id), list);
      tier.sort(
        (x, y) =>
          (h2h.get(y.id) - h2h.get(x.id)) ||
          (y.gameDiff - x.gameDiff) ||
          (y.pointDiff - x.pointDiff) ||
          (x.slot - y.slot)
      );
    }
    ranked.push(...tier);
    i = j;
  }

  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });

  return ranked;
}

/**
 * 一组比赛是否已全部分出胜负（小组出线的闸门）。
 *
 * @param {Array<Object>} [matches]
 * @returns {boolean}
 */
function allDecided(matches) {
  const list = Array.isArray(matches) ? matches : [];
  return list.length > 0 && list.every((match) => Boolean(tallyOf(match)));
}

module.exports = {
  groupEntries,
  roundRobinRounds,
  computeStandings,
  allDecided,
};
