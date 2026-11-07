/**
 * 团队赛事的积分表与名次（纯模块）
 * ============================================================
 * 篮球的比分是「一个数字」（96:88），不是个人赛那种「逐局比分数组」。
 * 因此不能复用 utils/standings.js——那一套按「每局胜者」累计局分，
 * 把 96 当成一局的得分会算出毫无意义的数字。这里单独算：
 *
 *   1. computeTeamTable      —— 循环赛积分表（胜场 → 相互战绩 → 净胜分 → 总得分）
 *   2. computeTeamPlacements —— 淘汰赛名次（冠军 → 亚军 → 季军赛/淘汰轮次）
 *
 * 【为什么平局链必须写到「球队 id」为止】
 * 名次是发奖与晋级的唯一依据。若最后一级比较不稳定，同一批比赛在两台
 * 机器上能算出两个第三名。所以最后一级用 teamId 兜底，绝不留平局。
 *
 * 【只认已发布的比赛】
 * 待审核（reviewing）的比分随时可能被改，把它算进积分表等于让名次
 * 随一次误录而抖动。发布才代表「这一场定了」。
 * ============================================================
 */

const { TEAM_MATCH_STATUS, BRACKET_STAGE } = require('./constants.js');
const { compareCode } = require('./text-order.js');

/**
 * 这一场是否已定局：已发布即定局。
 *
 * 平局（`allowDraw` 的循环赛）也是定局——它照样占一场、照样计得失分，
 * 只是没有胜方。因此这里不看 `winner`，谁能算冠军由名次函数另行判断。
 */
function isFinal(match) {
  return Boolean(match) && match.status === TEAM_MATCH_STATUS.PUBLISHED;
}

/** 比分转数字，缺失一律按 0（弃权方通常没有得分） */
function scoreOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 空积分行 */
function emptyRow(teamId, teamName) {
  return {
    teamId,
    teamName: teamName || teamId,
    played: 0,
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    diff: 0,
    rank: 0,
  };
}

/**
 * 循环赛 / 小组赛积分表。
 *
 * 排序口径（依次比较）：
 *   1. 胜场多者在前
 *   2. 胜场相同的一组里，先比**相互战绩**（只算这组队之间的比赛）
 *   3. 再比净胜分（得分 − 失分）
 *   4. 再比总得分
 *   5. 最后按球队 id 兜底，保证结果可复核
 *
 * @param {Object} params
 * @param {Array<{teamId:string, teamName:string}>} params.entries 参赛队
 * @param {Array<Object>} params.matches 该赛事的全部比赛（内部只取已发布）
 * @returns {Array<Object>} 积分表，按名次排好，rank 从 1 起
 */
function computeTeamTable({ entries, matches } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const rows = new Map();
  list.forEach((entry) => {
    const teamId = entry && entry.teamId;
    if (!teamId) return;
    rows.set(teamId, emptyRow(teamId, entry.teamName));
  });

  const finals = (Array.isArray(matches) ? matches : []).filter(isFinal);

  finals.forEach((match) => {
    const a = rows.get(match.teamA);
    const b = rows.get(match.teamB);
    // 一方不在参赛名单里（例如报名被撤销）就整场跳过，不要凭空造出队伍
    if (!a || !b) return;
    const sa = scoreOf(match.scoreA);
    const sb = scoreOf(match.scoreB);
    a.played += 1;
    b.played += 1;
    a.pointsFor += sa;
    a.pointsAgainst += sb;
    b.pointsFor += sb;
    b.pointsAgainst += sa;
    if (match.winner === 'A') {
      a.wins += 1;
      b.losses += 1;
    } else if (match.winner === 'B') {
      b.wins += 1;
      a.losses += 1;
    }
  });

  const rowList = [...rows.values()];
  rowList.forEach((row) => {
    row.diff = row.pointsFor - row.pointsAgainst;
  });

  // 相互战绩：只统计「这一组里」的队彼此之间的胜场
  const headToHeadWins = (group) => {
    const ids = new Set(group.map((row) => row.teamId));
    const wins = new Map(group.map((row) => [row.teamId, 0]));
    finals.forEach((match) => {
      if (!ids.has(match.teamA) || !ids.has(match.teamB)) return;
      const winner = match.winner === 'A' ? match.teamA : match.teamB;
      wins.set(winner, (wins.get(winner) || 0) + 1);
    });
    return wins;
  };

  rowList.sort((x, y) => y.wins - x.wins);
  // 胜场相同的连续区间内做二级排序
  let start = 0;
  while (start < rowList.length) {
    let end = start + 1;
    while (end < rowList.length && rowList[end].wins === rowList[start].wins) end += 1;
    const group = rowList.slice(start, end);
    if (group.length > 1) {
      const h2h = headToHeadWins(group);
      group.sort((x, y) => (
        (h2h.get(y.teamId) - h2h.get(x.teamId))
        || (y.diff - x.diff)
        || (y.pointsFor - x.pointsFor)
        || compareCode(x.teamId, y.teamId)
      ));
      group.forEach((row, index) => {
        rowList[start + index] = row;
      });
    }
    start = end;
  }

  rowList.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rowList;
}

/** 胜方 / 负方 */
function winnerOf(match) {
  return match.winner === 'A' ? match.teamA : match.teamB;
}
function loserOf(match) {
  return match.winner === 'A' ? match.teamB : match.teamA;
}

/**
 * 淘汰赛名次。
 *
 * 口径：
 *   - 决赛胜者是冠军，负者亚军；
 *   - 有季军赛（`stage='bronze'` 且已发布）时，按它定 3/4 名；
 *   - 其余球队按「被淘汰的轮次」倒序（越晚被淘汰越好），同轮再按积分表次序。
 *
 * 【为什么用「被淘汰的轮次」而不是「比赛编号」】
 * 签表规模不同，轮次数也不同；用轮次比较与规模无关，4 队与 32 队同一套代码。
 *
 * @param {Object} params
 * @param {Object} params.draw 签表（只用 size）
 * @param {Array<Object>} params.matches 该赛事全部比赛
 * @param {Array<Object>} [params.table] computeTeamTable 的结果，做同轮次的次序依据
 * @returns {Array<{rank:number, teamId:string, note:string}>}
 */
function computeTeamPlacements({ draw, matches, table } = {}) {
  const size = Number(draw && draw.size) || 0;
  if (size < 2) return [];

  const finals = (Array.isArray(matches) ? matches : []).filter(isFinal);
  // 名次只认「判明了胜负」的比赛：平局对定名次没有帮助，但它在积分表里照算
  const decided = finals.filter((match) => Boolean(match.winner));

  const totalRounds = Math.round(Math.log2(size));
  const finalMatch = decided.find(
    (match) => Number(match.round) === totalRounds && (match.stage || BRACKET_STAGE.MAIN) === BRACKET_STAGE.MAIN
      && Number(match.slot) === 0
  );
  if (!finalMatch) return [];

  const tableIndex = new Map(
    (Array.isArray(table) ? table : []).map((row, index) => [row.teamId, index])
  );
  const byTable = (a, b) => (
    (tableIndex.has(a) ? tableIndex.get(a) : 999) - (tableIndex.has(b) ? tableIndex.get(b) : 999)
  );

  const champion = winnerOf(finalMatch);
  const runnerUp = loserOf(finalMatch);

  // 每支队最后输在哪一轮：轮次越大，走得越远
  const lostRound = new Map();
  decided.forEach((match) => {
    const loser = loserOf(match);
    const round = Number(match.round) || 0;
    if (!lostRound.has(loser) || round > lostRound.get(loser)) lostRound.set(loser, round);
  });

  const placements = [];
  const push = (teamId, note) => {
    if (!teamId) return;
    if (placements.some((row) => row.teamId === teamId)) return;
    placements.push({ rank: placements.length + 1, teamId, note });
  };

  push(champion, '冠军');
  push(runnerUp, '亚军');

  const bronze = decided.find(
    (match) => Number(match.round) === totalRounds && match.stage === BRACKET_STAGE.BRONZE
  );

  if (bronze) {
    push(winnerOf(bronze), '季军');
    push(loserOf(bronze), '第四名');
  }

  const rest = [...lostRound.keys()]
    .filter((teamId) => teamId !== champion && teamId !== runnerUp
      && (!bronze || (teamId !== winnerOf(bronze) && teamId !== loserOf(bronze))))
    .sort((a, b) => (lostRound.get(b) - lostRound.get(a)) || byTable(a, b));

  rest.forEach((teamId) => push(teamId, '淘汰'));
  return placements;
}

module.exports = {
  isFinal,
  computeTeamTable,
  computeTeamPlacements,
};
