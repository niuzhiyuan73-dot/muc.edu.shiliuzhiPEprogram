/** 足球积分与同分排序。只读已发布正式比分，点球胜方不参与 3/1/0 或净胜球。
 * 相互战绩以最初同积分组生成一份小积分表，后续比较不缩组重算。
 * ID 只用于稳定展示；全部指标相同的名次为 null，必须另行确认。
 */
const { TEAM_MATCH_STATUS } = require('./constants.js');
const { defaultRulesFor, normalizeFootballRules, RANKING_POLICY } = require('./football-rules.js');
const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const validScore = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function emptyRow(entry) {
  return {
    teamId: entry.teamId, teamName: entry.teamName || entry.teamId,
    played: 0, wins: 0, draws: 0, losses: 0,
    points: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0,
  };
}
function accumulate(rows, match) {
  const a = rows.get(match.teamA);
  const b = rows.get(match.teamB);
  a.played += 1; b.played += 1;
  a.goalsFor += match.scoreA; a.goalsAgainst += match.scoreB;
  b.goalsFor += match.scoreB; b.goalsAgainst += match.scoreA;
  a.goalDifference = a.goalsFor - a.goalsAgainst;
  b.goalDifference = b.goalsFor - b.goalsAgainst;
  if (match.scoreA === match.scoreB) {
    a.draws += 1; b.draws += 1; a.points += 1; b.points += 1;
  } else {
    const winner = match.scoreA > match.scoreB ? a : b;
    const loser = winner === a ? b : a;
    winner.wins += 1; winner.points += 3; loser.losses += 1;
  }
  for (const row of [a, b]) {
    if (![row.goalsFor, row.goalsAgainst, row.goalDifference, row.points].every(Number.isSafeInteger)) {
      throw new Error('足球累计数据超出安全整数范围');
    }
  }
}

/**
 * @param {Object} params
 * @param {Object[]} params.rankingDecisions 管理员审计记录：tieKey、teamIds（名次顺序）、reason、decidedBy、decidedAt。
 * @returns {Object[]} rank=null/排名待确认的行不可直接转成最终名次。
 * 非法的已发布比分抛错，避免正式结算把空分当成零。未发布及名单外场次忽略。
 */
function computeFootballTable({ entries = [], matches = [], rules = defaultRulesFor(), rankingDecisions = [] } = {}) {
  const normalized = normalizeFootballRules(rules);
  if (!normalized) throw new Error('足球积分规则不合法');
  if (!Array.isArray(entries) || !Array.isArray(matches) || !Array.isArray(rankingDecisions)) {
    throw new Error('足球积分表参数不合法');
  }
  const rows = new Map();
  entries.forEach(entry => {
    if (!entry || typeof entry.teamId !== 'string' || !entry.teamId || rows.has(entry.teamId)) {
      throw new Error('参赛球队编号缺失或重复');
    }
    rows.set(entry.teamId, emptyRow(entry));
  });
  const finals = matches.filter(match => match && match.status === TEAM_MATCH_STATUS.PUBLISHED
    && rows.has(match.teamA) && rows.has(match.teamB));
  const ids = new Set();
  finals.forEach(match => {
    if (typeof match._id !== 'string' || !match._id.trim()) throw new Error('已发布足球比赛缺少编号');
    if (match.teamA === match.teamB || !validScore(match.scoreA) || !validScore(match.scoreB)) {
      throw new Error('已发布足球比赛的正式比分不合法');
    }
    if (match._id && ids.has(match._id)) throw new Error('已发布足球比赛重复');
    if (match._id) ids.add(match._id);
    accumulate(rows, match);
  });
  const list = [...rows.values()].sort((a, b) => b.points - a.points || compareId(a.teamId, b.teamId));
  // 决定绑定所有正式结果与版本，比赛被更正/重发后旧抽签记录不能继续生效。
  const basis = finals.map(match => [
    match._id || '', match.teamA, match.teamB, match.scoreA, match.scoreB,
    match.footballPublishedRevision || match.revision || 0, match.publishedAt || '',
  ]).sort((a, b) => compareId(JSON.stringify(a), JSON.stringify(b)));
  let start = 0;
  while (start < list.length) {
    let end = start + 1;
    while (end < list.length && list[end].points === list[start].points) end += 1;
    const group = list.slice(start, end);
    const mini = new Map(group.map(row => [row.teamId, emptyRow(row)]));
    finals.filter(match => mini.has(match.teamA) && mini.has(match.teamB)).forEach(match => accumulate(mini, match));
    const metrics = row => {
      const h = mini.get(row.teamId);
      const overall = [row.goalDifference, row.goalsFor];
      const head = [h.points, h.goalDifference, h.goalsFor];
      return normalized.rankingPolicy === RANKING_POLICY.HEAD_TO_HEAD ? [...head, ...overall] : [...overall, ...head];
    };
    const compare = (a, b) => {
      const x = metrics(a); const y = metrics(b);
      for (let i = 0; i < x.length; i += 1) { if (x[i] !== y[i]) return y[i] - x[i]; }
      return 0;
    };
    group.sort((a, b) => compare(a, b) || compareId(a.teamId, b.teamId));
    let offset = 0;
    while (offset < group.length) {
      let until = offset + 1;
      while (until < group.length && compare(group[offset], group[until]) === 0) until += 1;
      let tied = group.slice(offset, until);
      const tieKey = tied.length > 1 ? JSON.stringify({
        policy: normalized.rankingPolicy, teams: tied.map(row => row.teamId).sort(compareId), basis,
      }) : null;
      const decision = tieKey && rankingDecisions.find(item => item && item.tieKey === tieKey
        && Array.isArray(item.teamIds) && item.teamIds.length === tied.length
        && new Set(item.teamIds).size === tied.length && item.teamIds.every(id => tied.some(row => row.teamId === id))
        && typeof item.reason === 'string' && item.reason.trim()
        && typeof item.decidedBy === 'string' && item.decidedBy.trim()
        && typeof item.decidedAt === 'string' && Number.isFinite(Date.parse(item.decidedAt)));
      if (decision) {
        const byId = new Map(tied.map(row => [row.teamId, row]));
        tied = decision.teamIds.map(id => byId.get(id));
      }
      tied.forEach((row, index) => {
        const pending = tied.length > 1 && !decision;
        Object.assign(row, {
          rank: pending ? null : start + offset + index + 1,
          position: start + offset + index + 1,
          rankFrom: start + offset + 1, rankTo: start + until,
          rankingStatus: pending ? 'pending' : 'confirmed',
          rankingLabel: pending ? '同分待确认' : (decision ? '抽签确认' : '按竞赛规则排名'),
          tieKey, decision: decision ? { ...decision, teamIds: decision.teamIds.slice() } : null,
        });
        group[offset + index] = row;
      });
      offset = until;
    }
    group.forEach((row, index) => { list[start + index] = row; });
    start = end;
  }
  return list;
}

module.exports = { computeFootballTable };
