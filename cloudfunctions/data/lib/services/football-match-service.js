const { loadTeamProfileData, indexMatches } = require('./team-profile-data');
/** 足球赛后录分与成绩。复用团队 action，按运动分派；所有写入在事务内重判权限。 */
const { canReadAssociationSpace, canManageAssociationSpace } = require('./association-space-permission');
const { buildSchoolContext } = require('./school-context');
const { schoolKey } = require('../utils/school');
const { teamSportStrategyFor } = require('../utils/team-sport-rules');
const { normalizeFootballReport, scoreText, FIELDS } = require('../utils/football-report');
const { TEAM_EVENT_STATUS_LABEL, TEAM_STATUS_LABEL, TEAM_MEMBER_STATUS_LABEL } = require('../utils/constants');
const { compareCode } = require('../utils/text-order.js');
const ok = data => ({ ok: true, data });
const refused = message => ({ ok: false, message });
const clone = value => JSON.parse(JSON.stringify(value));
const scoped = (doc, ctx) => doc && doc.schoolId === ctx.schoolId && doc.association === ctx.association;
const requestPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const entryKey = (eventId, teamId) => schoolKey('ten', eventId, teamId);
const canRead = ctx => ctx.actorId && canReadAssociationSpace(ctx);
const isFootball = ctx => teamSportStrategyFor(ctx.association)?.sportFormat === 'football11';
const validEvent = (ctx, event, match) => scoped(event, ctx)
  && teamSportStrategyFor(ctx.association, event)?.sportFormat === 'football11'
  && (!match || match.sportFormat === 'football11');
const canEdit = (ctx, match) => canManageAssociationSpace(ctx) || match.recorderId === ctx.actorId;
const placementText = n => ({ 1: '冠军', 2: '亚军', 3: '季军' }[n] || (n ? `第 ${n} 名` : ''));
const recordText = r => `${r.wins} 胜 ${r.draws} 平 ${r.losses} 负 · 点球 ${r.shootoutWins} 胜 ${r.shootoutLosses} 负`;
const publicMatches = matches => matches.filter(m => m.status === 'published' && m.footballPublished);
/**
 * 出场覆盖：球队打了多少场、其中多少场有本人出场记录。
 *
 * 【足球为什么只认报告里的 appeared】篮球没有「实际出场」字段，只能拿单场名单
 * 兜底；足球的赛后报告逐人标了「实际出场」，能区分「名单里有、实际没上」
 * （替补未登场、受伤未用）。用名单兜底会把坐板凳的人算成出场，所以这里
 * 只有一个证据：报告里 `appeared === true`。
 *
 * `appearedMatches` 就是界面上的「已记录出场」——它与「参赛经历」里的赛事数
 * 不是一回事：一个赛事有多场比赛，报名即计入荣誉，出场要逐场有报告才算。
 */function appearanceCoverage(matches, entries, userId) {
  let eligibleMatchCount = 0; let lineupRecordedMatches = 0; let appearedMatches = 0;
  for (const match of publicMatches(matches)) {
    const entry = entries.find(e => e.eventId === match.eventId && [match.teamA, match.teamB].includes(e.teamId)
      && e.status === 'locked' && e.roster?.some(p => p.userId === userId));
    if (!entry) continue;
    eligibleMatchCount += 1;
    const side = entry.teamId === match.teamA ? 'A' : 'B';
    const sideReport = match.footballPublished.sides[side];
    if (sideReport.players.length) lineupRecordedMatches += 1;
    if (sideReport.players.some(p => p.userId === userId && p.appeared)) appearedMatches += 1;
  }
  return { eligibleMatchCount, lineupRecordedMatches, appearedMatches };
}

function footballMatchView(match, editor) {
  const report = editor && match.footballDraft ? match.footballDraft : match.footballPublished;
  const result = report && report.result;
  return { scoreText: result ? scoreText(result) : match.status === 'reviewing' ? '待审核' : '—',
    scoreA: result ? result.scoreA : null, scoreB: result ? result.scoreB : null,
    winner: result ? result.winner : null, forfeit: result ? result.forfeit : null,
    overtime: Boolean(result && result.extraTimeCompleted),
    resultKind: result ? result.kind : null,
    regulationScore: result ? result.regulationScore : null,
    extraTimeScore: result ? result.extraTimeScore : null,
    shootoutScore: result ? result.shootoutScore : null,
    reportPending: Boolean(editor && match.footballDraft),
    statPending: Boolean(editor && match.footballDraft),
    hasLineup: Boolean(report && ['A', 'B'].some(side => report.sides[side].players.length)),
    durationMinutes: match.durationMinutes || null };
}

async function readTarget(payload, ctx) {
  if (!canRead(ctx)) return refused('账号或本校在册会员身份已失效，无权访问本协会');
  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!scoped(match, ctx)) return refused('比赛不存在，或不在本协会');
  const event = await repo.teamEvents.getById(match.eventId);
  if (!validEvent(ctx, event, match)) return refused('赛事运动规则与协会不符');
  const entries = await Promise.all([match.teamA, match.teamB].map(id => repo.teamEventEntries.getById(entryKey(event._id, id))));
  const teams = await Promise.all([match.teamA, match.teamB].map(id => repo.teams.getById(id)));
  return { ok: true, repo, match, event, entries, teams };
}

async function getTeamMatchStats(payload, ctx) {
  const target = await readTarget(payload, ctx);
  if (!target.ok) return ok(target);
  const { match, event, entries, teams } = target;
  const editor = canEdit(ctx, match);
  if (!editor && !match.footballPublished) return ok(refused('这场还没发布，报告暂不可查看'));
  const report = editor ? match.footballDraft || match.footballPublished : match.footballPublished;
  return ok({ ok: true, sportFormat: 'football11', matchId: match._id, eventId: event._id,
    revision: Number(match.revision) || 0, rules: event.rules, format: event.format,
    teamAName: teams[0]?.name || match.teamA, teamBName: teams[1]?.name || match.teamB,
    report: report ? clone(report) : null,
    publishedReport: match.footballPublished ? clone(match.footballPublished) : null,
    rosters: { A: entries[0]?.roster || [], B: entries[1]?.roster || [] },
    lineups: editor ? match.footballLineups || {} : {},
    canEdit: editor && event.status !== 'canceled' && match.status !== 'canceled',
    canReview: canManageAssociationSpace(ctx) && Boolean(match.footballDraft),
    pending: editor && Boolean(match.footballDraft), needReview: Boolean(match.footballPublished),
    correctionReason: editor ? match.footballDraftReason || '' : '',
    audit: canManageAssociationSpace(ctx) ? match.footballAudit || [] : [], message: '' });
}

/** 幂等回执随场次保存（最近 32 次），先查回执再比版本；任何拒绝都不写入。 */
async function mutate(payload, ctx, action, operation, { dependencies = false } = {}) {
  if (!canRead(ctx)) return ok(refused('账号或本校在册会员身份已失效'));
  if (!requestPattern.test(payload.requestId || '') || !Number.isInteger(payload.expectRevision)) return ok(refused('缺少请求编号或比赛版本，请刷新后重试'));
  const outside = await readTarget(payload, ctx);
  if (!outside.ok) return ok(outside);
  const related = dependencies ? (await outside.repo.teamMatches.listByEvent(outside.event._id))
    .filter(m => m._id !== outside.match._id) : [];
  if (related.length > 70) return ok(refused('关联赛程超过单次处理容量，请分届办赛'));
  const basis = outside.event.revision || 0;
  return ok(await ctx.repo.transaction(async root => {
    const context = await buildSchoolContext({ repo: root, actorId: ctx.actorId, scope: ctx, now: ctx.now });
    const fresh = { ...context, now: new Date(context.now).toISOString() };
    if (!canRead(fresh)) return refused('账号或本校身份已失效');
    const tx = root.forScope(fresh);
    const match = await tx.teamMatches.getById(payload.matchId);
    if (!scoped(match, fresh)) return refused('比赛不存在，或不在本协会');
    const event = await tx.teamEvents.getById(match.eventId);
    if (!validEvent(fresh, event, match)) return refused('赛事运动规则与协会不符');
    const key = `${fresh.actorId}:${action}:${payload.requestId}`;
    const previous = (match.footballRequests || []).find(r => r.key === key);
    if (previous) return previous.result;
    if (match.revision !== payload.expectRevision) return refused('这场比赛刚被改过，请刷新后重试');
    if (dependencies && (event.revision || 0) !== basis) return refused('赛事刚被改过，请刷新后重试');
    if (event.status === 'canceled' || match.status === 'canceled') return refused('赛事或比赛已取消');
    const rosters = {};
    const teams = {};
    for (const [side, id] of [['A', match.teamA], ['B', match.teamB]]) {
      const entry = await tx.teamEventEntries.getById(entryKey(event._id, id));
      if (!entry || entry.status !== 'locked') return refused('请先锁定参赛名单');
      rosters[side] = entry.roster || [];
      teams[side] = await tx.teams.getById(id);
    }
    const downstream = [];
    for (const row of related) {
      const actual = await tx.teamMatches.getById(row._id);
      if (!actual || actual.revision !== row.revision) return refused('关联比赛刚被改过，请刷新后重试');
      downstream.push(actual);
    }
    const output = await operation({ fresh, tx, root, match, event, teams, rosters, downstream });
    if (!output.ok) return output;
    const revision = match.revision + 1;
    const result = { ok: true, revision, warnings: output.warnings || [], message: '', ...(output.result || {}) };
    const next = { ...match, ...output.patch, revision, updatedAt: fresh.now,
      footballRequests: [...(match.footballRequests || []), { key, result }].slice(-32) };
    // UTF-16 字符数保守限额；即便全部为三字节中文也留在云端单文档容量内。
    if (JSON.stringify(next).length > 300000) return refused('本场修订记录已达安全容量，请导出审计记录后由管理员处理');
    // operation 仅构建写计划，全部点读结束后才落库。
    for (const doc of output.downstreamWrites || []) await tx.teamMatches.set(doc._id, doc);
    await tx.teamMatches.set(match._id, next);
    await tx.teamEvents.set(event._id, { ...event, ...(output.eventPatch || {}),
      revision: (event.revision || 0) + 1, updatedAt: fresh.now });
    return result;
  }));
}

function audit(match, fresh, action, reason) {
  return [...(match.footballAudit || []), { action, reason: reason || '', by: fresh.actorId,
    at: fresh.now, revision: match.revision + 1,
    previous: action === 'publish' ? match.footballPublished || null : null }];
}

async function recordTeamMatch(payload, ctx) {
  return mutate(payload, ctx, 'record', async ({ fresh, match, event, rosters }) => {
    if (!canEdit(fresh, match)) return refused('只有指派的录入人或协会管理者可以录分');
    if (!['scheduled', 'running', 'finished'].includes(event.status)) return refused('赛事当前不可录分');
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (reason.length > 500) return refused('更正理由不超过 500 字');
    if (match.footballPublished && !reason) return refused('更正已发布报告必须填写理由');
    const normalized = normalizeFootballReport(payload.report, { rules: event.rules, format: event.format, rosters });
    if (!normalized.ok) return normalized;
    return { ok: true, warnings: normalized.warnings, patch: {
      footballDraft: normalized.value, footballDraftReason: reason,
      status: match.footballPublished ? 'published' : 'reviewing', recordedBy: fresh.actorId, recordedAt: fresh.now,
      footballAudit: audit(match, fresh, 'submit', reason),
    }, eventPatch: event.status === 'scheduled' ? { status: 'running' } : {} };
  });
}

async function publishTeamMatch(payload, ctx) {
  return mutate(payload, ctx, 'publish', async ({ fresh, match, event, rosters, downstream }) => {
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以审核发布');
    if (!match.footballDraft) return refused('没有待审核的足球报告');
    if (payload.approve !== true) return { ok: true, patch: { footballDraft: null, footballDraftReason: '',
      status: match.footballPublished ? 'published' : 'scheduled', footballAudit: audit(match, fresh, 'reject', payload.reason) } };
    const normalized = normalizeFootballReport(match.footballDraft, { rules: event.rules, format: event.format, rosters });
    if (!normalized.ok) return normalized;
    const report = normalized.value; const result = report.result;
    if (result.kind === 'interrupted') return refused('中断报告不能作为最终成绩发布；请依据裁判结论补录完赛或弃权判定');
    const downstreamWrites = [];
    if (match.footballPublished && match.winner !== result.winner && event.format === 'single_elim') {
      const affected = downstream.filter(m => Number(m.round) > Number(match.round)
        && [m.teamA, m.teamB].some(id => id === match.teamA || id === match.teamB));
      for (const doc of affected) {
        if (doc.status !== 'scheduled' || doc.footballDraft || doc.footballPublished || doc.scoreA != null
          || doc.lineups || doc.footballLineups || (doc.matchTime && Date.parse(doc.matchTime) <= Date.parse(fresh.now))) {
          return refused('下游比赛已有名单、结果或已到开赛时间，请先处理依赖后再改判');
        }
        const swap = id => id === match.teamA ? match.teamB : id === match.teamB ? match.teamA : id;
        downstreamWrites.push({ ...doc, teamA: swap(doc.teamA), teamB: swap(doc.teamB),
          matchTime: null, refereeId: null, recorderId: null, refereeName: '', recorderName: '',
          revision: doc.revision + 1, updatedAt: fresh.now,
          scheduleChangeReason: `上游 ${match._id} 改判，对阵更新后需重新安排` });
      }
    }
    return { ok: true, downstreamWrites, warnings: report.warnings,
      patch: { footballPublished: report, footballDraft: null, footballDraftReason: '',
        footballPublishedRevision: match.revision + 1,
        scoreA: result.scoreA, scoreB: result.scoreB, winner: result.winner, forfeit: result.forfeit,
        overtime: result.extraTimeCompleted, status: 'published', publishedBy: fresh.actorId, publishedAt: fresh.now,
        footballAudit: audit(match, fresh, 'publish', match.footballDraftReason) },
      eventPatch: { status: 'running', placements: [], rankingDecisions: [], finishedAt: null },
      result: { status: 'published', updatedDownstream: downstreamWrites.length } };
  }, { dependencies: true });
}

async function saveTeamMatchStats(payload, ctx) {
  // 比分、出场与统计始终共同审核，避免单独的统计版本与更正比分交叉。
  return recordTeamMatch(payload, ctx);
}
const reviewTeamMatchStats = publishTeamMatch;

async function getTeamMatchLineup(payload, ctx) {
  const target = await readTarget(payload, ctx);
  if (!target.ok) return ok(target);
  const { match, event, teams, entries } = target;
  const manage = canManageAssociationSpace(ctx); const editor = canEdit(ctx, match);
  if (!manage && !teams.some(t => t?.captainId === ctx.actorId) && !editor) return ok(refused('只有参赛队队长、录入人或协会负责人可以查看未发布名单'));
  const report = editor ? match.footballDraft || match.footballPublished : match.footballPublished;
  // rules 兜底：本服务其它 8 处都写成 `event.rules && event.rules.x`，只有这里直接解引用。
  // 新建赛事必经 normalizeRules（rules 必填），但历史文档或控制台手工改过的事件可能没有
  // 这个字段——那时整条「查看名单」会 500，而不是少一个上限值（2026-10-28 审计 2 B-4）。
  const rules = event.rules || {};
  return ok({ ok: true, revision: match.revision, minOnCourt: 7, matchRosterMax: rules.matchRosterMax,
    sportFormat: 'football11', matchId: match._id, rules, format: event.format,
    teamAName: teams[0]?.name || match.teamA, teamBName: teams[1]?.name || match.teamB,
    eventId: event._id,
    sides: ['A', 'B'].map((side, i) => ({ side, teamName: teams[i]?.name || '',
      editable: !match.footballDraft && !match.footballPublished && (manage || teams[i]?.captainId === ctx.actorId),
      players: entries[i]?.roster || [], lineup: report?.sides[side] || match.footballLineups?.[side] || null })) });
}

async function saveTeamMatchLineup(payload, ctx) {
  return mutate(payload, ctx, 'lineup', async ({ fresh, match, event, teams, rosters }) => {
    const side = payload.side;
    if (!['A', 'B'].includes(side)) return refused('缺少出场方 A/B');
    if (!canManageAssociationSpace(fresh) && teams[side]?.captainId !== fresh.actorId) return refused('只能定自己队的单场名单');
    if (match.footballDraft || match.footballPublished) return refused('已有赛后报告，名单须随报告更正并审核');
    const { normalizeSide } = require('../utils/football-report');
    const normalized = normalizeSide(payload.lineup, rosters[side], event.rules, false);
    if (!normalized.ok) return normalized;
    return { ok: true, patch: { footballLineups: { ...match.footballLineups, [side]: normalized.value } } };
  });
}

function aggregate(matches, userId) {
  const map = new Map();
  for (const match of publicMatches(matches)) {
    for (const side of ['A', 'B']) {
      const teamId = side === 'A' ? match.teamA : match.teamB;
      for (const row of match.footballPublished.sides[side].players) {
        if (userId && row.userId !== userId) continue;
        let acc = map.get(row.userId);
        if (!acc) {
          acc = { userId: row.userId, name: row.name, teamId, games: 0, recordedMatches: 0, fields: {} };
          for (const field of [...Object.keys(FIELDS), 'dismissals']) acc.fields[field] = { total: 0, matches: 0 };
          map.set(row.userId, acc);
        }
        if (row.appeared) acc.games += 1;
        acc.recordedMatches += 1;
        for (const field of Object.keys(acc.fields)) {
          if (Number.isInteger(row[field])) { acc.fields[field].total += row[field]; acc.fields[field].matches += 1; }
        }
      }
    }
  }
  return [...map.values()].map(acc => {
    const out = { userId: acc.userId, name: acc.name, teamId: acc.teamId, games: acc.games, recordedMatches: acc.recordedMatches };
    for (const [field, cell] of Object.entries(acc.fields)) {
      const total = cell.matches ? cell.total : null;
      out[field] = total; out[`${field}Text`] = total === null ? '—' : String(total);
      out[`${field}RecordedMatches`] = cell.matches;
    }
    return out;
  });
}

async function getTeamEventPlayerStats(payload, ctx) {
  if (!canRead(ctx)) return ok(refused('账号或本校身份已失效'));
  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!validEvent(ctx, event) || event.status === 'draft') return ok(refused('赛事不存在或尚未发布'));
  const matches = publicMatches(await repo.teamMatches.listByEvent(event._id));
  const players = aggregate(matches);
  const order = field => players.filter(p => p[field] !== null).sort((a, b) => b[field] - a[field] || a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  const completeCount = matches.filter(m => ['A', 'B'].every(s => m.footballPublished.sides[s].coverage.goals === 'full'
    && m.footballPublished.sides[s].coverage.ownGoals === 'full')).length;
  return ok({ ok: true, sportFormat: 'football11', players: order('goals'), scorers: order('goals'), assists: order('assists'),
    matchCount: matches.length, completeCount, coverageText: `已发布 ${matches.length} 场，进球归属完整 ${completeCount} 场；榜单仅含已录入统计，不自动评奖。` });
}

function teamRecord(matches, teamId) {
  const record = { games: 0, wins: 0, draws: 0, losses: 0, shootoutWins: 0, shootoutLosses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const m of publicMatches(matches).filter(m => [m.teamA, m.teamB].includes(teamId))) {
    const a = m.teamA === teamId; const mine = a ? m.scoreA : m.scoreB; const other = a ? m.scoreB : m.scoreA;
    record.games += 1; record.goalsFor += mine; record.goalsAgainst += other;
    record[mine === other ? 'draws' : mine > other ? 'wins' : 'losses'] += 1;
    if (m.footballPublished.result.shootoutScore) record[(m.winner === 'A') === a ? 'shootoutWins' : 'shootoutLosses'] += 1;
  }
  return { ...record, recordText: recordText(record), winRateText: record.games ? `${Math.round(record.wins / record.games * 100)}%` : '—' };
}

async function getTeamRecord(payload, ctx) {
  if (!canRead(ctx)) return ok(refused('账号或本校身份已失效'));
  const repo = ctx.repo.forScope(ctx); const team = await repo.teams.getById(payload.teamId);
  if (!scoped(team, ctx)) return ok(refused('球队不存在，或不在本协会'));
  // 【只读这支队自己的那几十条】（2026-10-26 只读审查 P2-7）
  // 原来把赛事、报名、比赛、球队四个集合**整表**读回本协会全部历史再内存过滤：
  // 一届 8 队单循环是 28 场，办三年就上千条，而页面只要这支队那几十场；
  // 而且每一届又对全量比赛 filter 一遍，成本随历史线性涨、跟这支队无关。
  // 现在：报名与比赛按球队下推（比赛按双方球队字段各查一次去重），
  // 关联赛事与对手球队按编号批读，比赛先建 eventId 索引再按赛事分组。
  const [entries, teamMatches] = await Promise.all([
    repo.teamEventEntries.listByTeam(team._id),
    repo.teamMatches.listByTeams([team._id]),
  ]);
  const lockedEntries = entries.filter(e => e.teamId === team._id && e.status === 'locked');
  const eventIds = [...new Set([
    ...lockedEntries.map(e => e.eventId),
    ...teamMatches.map(m => m.eventId),
  ])];
  const opponentIds = [...new Set([team._id, ...teamMatches.flatMap(m => [m.teamA, m.teamB])])];
  const [eventDocs, teamDocs] = await Promise.all([
    repo.teamEvents.listByIds(eventIds),
    repo.teams.listByIds(opponentIds),
  ]);
  const eventById = new Map(eventDocs.map(e => [e._id, e]));
  const teamById = new Map(teamDocs.map(t => [t._id, t]));
  const matchesByEvent = indexMatches(teamMatches, 'eventId');
  const seasons = lockedEntries.map(entry => {
    const event = eventById.get(entry.eventId); if (!event || event.status === 'draft') return null;
    const rank = event.status === 'finished' ? event.placements?.find(p => p.teamId === team._id)?.rank : null;
    return { eventId: event._id, name: event.name, statusLabel: TEAM_EVENT_STATUS_LABEL[event.status],
      placement: rank, placementText: placementText(rank), ...teamRecord(matchesByEvent.get(event._id) || [], team._id) };
  }).filter(Boolean);
  const recent = publicMatches(teamMatches).filter(m => [m.teamA, m.teamB].includes(team._id))
    .sort((a, b) => compareCode(b.matchTime || b.publishedAt, a.matchTime || a.publishedAt))
    .slice(0, 10).map(m => {
    const a = m.teamA === team._id; const mine = a ? m.scoreA : m.scoreB; const other = a ? m.scoreB : m.scoreA;
    const opponent = teamById.get(a ? m.teamB : m.teamA);
    return { matchId: m._id, opponentName: opponent ? opponent.name : '',
      eventName: (eventById.get(m.eventId) || {}).name || '',
      matchTimeText: m.matchTime ? new Date(Date.parse(m.matchTime) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ') : '',
      scoreText: a ? scoreText(m.footballPublished.result) : scoreText({ ...m.footballPublished.result,
        scoreA: m.scoreB, scoreB: m.scoreA, shootoutScore: m.footballPublished.result.shootoutScore
          ? { A: m.footballPublished.result.shootoutScore.B, B: m.footballPublished.result.shootoutScore.A } : null }),
      resultLabel: mine === other ? '平' : mine > other ? '胜' : '负' };
  });
  return ok({ ok: true, sportFormat: 'football11', team: { teamId: team._id, name: team.name, statusLabel: TEAM_STATUS_LABEL[team.status] },
    overall: teamRecord(teamMatches, team._id), seasons, recent });
}

async function getMyTeamProfile(payload, ctx) {
  if (!canRead(ctx)) return ok(refused('账号或本校身份已失效'));
  const id = payload.userId || ctx.actorId;
  if (id !== ctx.actorId && !canManageAssociationSpace(ctx)) return ok(refused('只能查看自己的团队成绩'));
  const { members, teams, entries, events, matches, user } = await loadTeamProfileData(ctx, id, { football: true });
  const matchesByEvent = indexMatches(matches, 'eventId');
  const eligible = entries.filter(e => e.status === 'locked' && e.roster?.some(p => p.userId === id));
  const eventRows = eligible.map(entry => {
    const event = events.find(e => e._id === entry.eventId); if (!event || event.status === 'draft') return null;
    const rank = event.status === 'finished' ? event.placements?.find(p => p.teamId === entry.teamId)?.rank : null;
    const eventMatches = (matchesByEvent.get(event._id) || []);
    return { eventId: event._id, name: event.name, teamId: entry.teamId,
      teamName: teams.find(t => t._id === entry.teamId)?.name || entry.teamId,
      statusLabel: TEAM_EVENT_STATUS_LABEL[event.status], placement: rank, placementText: placementText(rank),
      membershipLabel: '报名成员', ...teamRecord(eventMatches, entry.teamId),
      // 本项赛事的「球队打了几场 / 我出场几场」。与顶部「已记录出场」同一口径，
      // 让「报名了 4 项赛事、出场只有 1 场」能在同一行里对上账——
      // 赛事数与场次数本来就不是一个单位（见 appearanceCoverage 的说明）。
      ...appearanceCoverage(eventMatches, [entry], id) };
  }).filter(Boolean);
  const totals = aggregate(matches, id)[0] || { games: 0, goalsText: '—', assistsText: '—', yellowCardsText: '—', dismissalsText: '—' };
  const appearance = appearanceCoverage(matches, entries, id);
  const statEvents = eventRows.map(e => ({ eventId: e.eventId, name: e.name,
    ...(aggregate((matchesByEvent.get(e.eventId) || []), id)[0] || { games: 0, goalsText: '—', assistsText: '—', yellowCardsText: '—', dismissalsText: '—' }),
    ...appearanceCoverage((matchesByEvent.get(e.eventId) || []), entries, id) }));
  return ok({ ok: true, sportFormat: 'football11', name: user?.realName || user?.nickName || id,
    teams: members.filter(m => m.userId === id).map(m => {
      const team = teams.find(t => t._id === m.teamId); if (!team) return null;
      return { teamId: team._id, name: team.name, isCaptain: team.captainId === id,
        current: m.status === 'active', memberStatusLabel: TEAM_MEMBER_STATUS_LABEL[m.status],
        statusLabel: TEAM_STATUS_LABEL[team.status], memberCount: members.filter(r => r.teamId === team._id && r.status === 'active').length,
        recordText: teamRecord(matches, team._id).recordText };
    }).filter(Boolean).sort((a, b) => Number(b.current) - Number(a.current)), events: eventRows,
    honors: eventRows.filter(e => e.placement && e.placement <= 3).map(e => ({ ...e, eventName: e.name })),
    statEvents, totals: { ...totals, ...appearance,
      // 顶部「已记录出场」的唯一来源：报告里逐场标了「实际出场」的场次数。
      // 与 aggregate 的 games 同值（games 也只累加 appeared 行），这里显式给一个
      // 名字，是为了让「出场」的口径只有一处，不必让每个调用方去猜 games 的含义。
      appearanceGames: appearance.appearedMatches,
      recordText: '按已发布报告记录出场；团队荣誉归属报名成员' } });
}

module.exports = { isFootball, footballMatchView, getTeamMatchStats, recordTeamMatch, publishTeamMatch,
  saveTeamMatchStats, reviewTeamMatchStats, getTeamMatchLineup, saveTeamMatchLineup,
  getTeamEventPlayerStats, getMyTeamProfile, getTeamRecord };
