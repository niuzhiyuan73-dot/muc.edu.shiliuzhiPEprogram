const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, SCOPE } = require('./helpers/football-fixture');
const { schoolKey, schoolMemberKey } = require('../miniprogram/utils/school');
const { normalizeFootballReport, normalizeResult, matchMinutes } = require('../miniprogram/utils/football-report');
const { defaultRulesFor, normalizeFootballRules, STANDARD_PRESET_KEY } = require('../miniprogram/utils/football-rules');
const rules = defaultRulesFor();

test('10 队足球单循环在云端预算内一次抽出 45 场', async () => {
  const f = await fixture({ cloud: true, count: 10 });
  assert.equal((await f.matches()).length, 45);
  assert.equal(f.db.traces.at(-1).length, 98);
});

test('F2 足球结果拒绝空分、非法阶段；0:0、提前决胜的点球总分合法且不叠加进球', () => {
  for (const value of ['', null, true, -1, '1e1', 1.2]) {
    assert.equal(normalizeResult({ regulationScore: { A: value, B: 0 } }, rules, 'round_robin').ok, false);
  }
  assert.equal(normalizeResult({ regulationScore: { A: 0, B: 0 } }, rules, 'round_robin').ok, true);
  const tied = { regulationScore: { A: 1, B: 1 }, shootoutScore: { A: 3, B: 0 }, refereeConfirmed: true };
  const result = normalizeResult(tied, rules, 'single_elim');
  assert.equal(result.ok, true); assert.equal(result.value.scoreA, 1); assert.equal(result.value.winner, 'A');
  assert.equal(normalizeResult({ ...tied, regulationScore: { A: 2, B: 1 } }, rules, 'single_elim').ok, false);
  assert.equal(normalizeResult({ ...tied, shootoutScore: { A: 3, B: 3 } }, rules, 'single_elim').ok, false);
  assert.equal(normalizeResult({ ...tied, refereeConfirmed: false }, rules, 'single_elim').ok, false);
  assert.equal(normalizeResult({ ...tied, extraTimeScore: { A: 0, B: 0 } }, rules, 'single_elim').ok, false);
  assert.equal(normalizeResult(tied, rules, 'round_robin').ok, false);
  const standard = normalizeFootballRules({ presetKey: STANDARD_PRESET_KEY });
  assert.equal(normalizeResult(tied, standard, 'single_elim').ok, false);
  assert.equal(normalizeResult({ ...tied, extraTimeScore: { A: 0, B: 0 }, extraTimeCompleted: true }, standard, 'single_elim').ok, true);
  const wonExtra = normalizeResult({ regulationScore: { A: 1, B: 1 }, extraTimeScore: { A: 0, B: 2 }, extraTimeCompleted: true }, standard, 'single_elim');
  assert.equal(wonExtra.value.scoreB, 3); assert.equal(wonExtra.value.winner, 'B');
  assert.equal(matchMinutes(rules, 'round_robin'), 110); assert.equal(matchMinutes(standard, 'single_elim'), 155);
});

for (const cloud of [false, true]) {
  const label = cloud ? '协议2云端' : '本地';
  test(`F2 ${label}：完整三队循环赛、轮空、0:0、3/1/0及结算荣誉`, async () => {
    const f = await fixture({ cloud, count: 3 });
    const matches = await f.matches(); assert.equal(matches.length, 3);
    for (const [i, match] of matches.entries()) {
      await f.publish(match, await f.report(match, { regulationScore: { A: i, B: 0 } }));
    }
    const detail = await f.call('getTeamEvent', { eventId: f.eventId });
    assert.equal(detail.table.reduce((s, r) => s + r.played, 0), 6);
    assert.equal(detail.table.reduce((s, r) => s + r.points, 0), 8);
    const settled = await f.call('settleTeamEvent', { eventId: f.eventId });
    assert.equal(settled.ok, true, settled.message); assert.equal(settled.placements.length, 3);
    const profile = await f.call('getMyTeamProfile', {}, 'f0');
    assert.equal(profile.events.length, 1); assert.equal(profile.totals.games, 0, '只录比分不伪造出场');
    if (cloud) assert.ok(f.db.traces.every(t => t.length <= 100));
  });
  test(`F2 ${label}：淘汰赛点球晋级、奇数轮空、季军赛、完成一届`, async () => {
    const f = await fixture({ cloud, count: 3, format: 'single_elim' });
    assert.equal((await f.matches()).length, 1);
    const semi = (await f.matches())[0];
    await f.publish(semi, await f.report(semi, { regulationScore: { A: 1, B: 1 }, shootoutScore: { A: 4, B: 3 }, refereeConfirmed: true }));
    const advanced = await f.call('advanceTeamRound', { eventId: f.eventId });
    assert.equal(advanced.ok, true, advanced.message);
    const fresh = (await f.matches()).filter(m => m.status === 'scheduled');
    assert.ok(fresh.some(m => [m.teamA, m.teamB].includes(semi.teamA)));
    for (const match of fresh) await f.publish(match, await f.report(match, { regulationScore: { A: 2, B: 0 } }));
    const done = await f.call('settleTeamEvent', { eventId: f.eventId });
    assert.equal(done.ok, true, done.message);
    assert.equal(done.placements.length, 3);
    const record = await f.call('getTeamRecord', { teamId: semi.teamA });
    assert.equal(record.overall.shootoutWins, 1);
    assert.equal(record.overall.draws, 1); assert.equal(record.overall.goalsFor < 8, true);
  });
  test(`F2 ${label}：四队淘汰改判更新未开赛对阵，已有结果则阻止，不污染旧成绩`, async () => {
    const f = await fixture({ cloud, count: 4, format: 'single_elim' });
    const semis = await f.matches();
    for (const m of semis) await f.publish(m, await f.report(m, { regulationScore: { A: 2, B: 0 } }));
    assert.equal((await f.call('advanceTeamRound', { eventId: f.eventId })).ok, true);
    const semi = semis[0];
    const oldPublic = (await f.call('getTeamEvent', { eventId: f.eventId }, 'viewer')).matches.find(m => m.matchId === semi._id);
    assert.equal(oldPublic.scoreA, 2);
    assert.equal((await f.write('recordTeamMatch', semi, { reason: '裁判改判', report: await f.report(semi, { regulationScore: { A: 0, B: 2 } }) })).ok, true);
    const beforeApprove = (await f.call('getTeamEvent', { eventId: f.eventId }, 'viewer')).matches.find(m => m.matchId === semi._id);
    assert.equal(beforeApprove.scoreA, 2); assert.equal(beforeApprove.reportPending, false);
    const approved = await f.write('publishTeamMatch', semi, { approve: true });
    assert.equal(approved.ok, true, approved.message); assert.equal(approved.updatedDownstream, 2);
    const later = (await f.matches()).filter(m => m.round === 2);
    assert.ok(later.find(m => m.stage === 'main').teamA === semi.teamB || later.find(m => m.stage === 'main').teamB === semi.teamB);
    const final = later.find(m => m.stage === 'main');
    await f.publish(final, await f.report(final, { regulationScore: { A: 1, B: 0 } }));
    assert.equal((await f.write('recordTeamMatch', semi, { reason: '再次核对', report: await f.report(semi, { regulationScore: { A: 3, B: 0 } }) })).ok, true);
    const denied = await f.write('publishTeamMatch', semi, { approve: true });
    assert.equal(denied.ok, false); assert.match(denied.message, /下游/);
    assert.equal((await f.repo.teamMatches.getById(semi._id)).scoreA, 0);
    assert.equal((await f.repo.teamMatches.getById(final._id)).status, 'published');
  });
  test(`F2 ${label}：录入权限、草稿隔离、版本竞争与请求幂等`, async () => {
    const f = await fixture({ cloud }); const match = (await f.matches())[0];
    const data = await f.report(match);
    const cap = match.teamA === 'ft0' ? 'f0' : 'f12';
    assert.equal((await f.write('recordTeamMatch', match, { report: data }, cap)).ok, false, '队长不自动获得录分权');
    assert.equal((await f.call('getTeamMatchStats', { matchId: match._id }, cap)).ok, false);
    const payload = { matchId: match._id, expectRevision: match.revision, requestId: 'same_write', report: data };
    const first = await f.call('recordTeamMatch', payload);
    assert.equal(first.ok, true, first.message);
    const retry = await f.call('recordTeamMatch', payload); assert.deepEqual(retry, first);
    const stale = await f.call('recordTeamMatch', { ...payload, requestId: 'other' }); assert.equal(stale.ok, false);
    const hidden = await f.call('getTeamMatchStats', { matchId: match._id }, 'viewer'); assert.equal(hidden.ok, false);
    const list = await f.call('getTeamEvent', { eventId: f.eventId }, cap);
    assert.equal(list.matches[0].scoreA, null); assert.equal(list.matches[0].canRecord, false);
    const badScope = await f.call('getTeamMatchStats', { matchId: match._id }, 'demo_muc_admin', { schoolId: 'muc', association: 'bk' }); assert.equal(badScope.ok, false);
    if (cloud) {
      const before = await f.repo.teamMatches.getById(match._id);
      f.db.failSet('teamEvents', 1);
      await assert.rejects(f.write('publishTeamMatch', match, { approve: true }), /RPC failure/);
      assert.deepEqual(await f.repo.teamMatches.getById(match._id), before, '事件写失败回滚比赛写入');
    }
  });
  test(`F3 ${label}：进球乌龙核对、替补受牌不增出场、覆盖范围、更正替换累计`, async () => {
    const f = await fixture({ cloud }); const m = (await f.matches())[0];
    const data = await f.report(m, { regulationScore: { A: 3, B: 0 } }, true);
    const a = data.sides.A.players; const b = data.sides.B.players;
    a[0].goals = 2; b[0].ownGoals = 1;
    data.sides.A.coverage.goals = 'partial'; data.sides.B.coverage.ownGoals = 'partial';
    b[11].yellowCards = 2; b[11].secondYellow = 1; b[11].directRed = 0;
    for (const field of ['yellowCards', 'secondYellow', 'directRed']) data.sides.B.coverage[field] = 'partial';
    await f.publish(m, data);
    const team = await f.call('getTeamRecord', { teamId: m.teamA }); assert.equal(team.overall.goalsFor, 3);
    const scorer = await f.call('getMyTeamProfile', {}, a[0].userId);
    assert.equal(scorer.totals.games, 1); assert.equal(scorer.totals.goals, 2); assert.equal(scorer.totals.assists, null);
    const bench = await f.call('getMyTeamProfile', {}, b[11].userId);
    assert.equal(bench.totals.games, 0); assert.equal(bench.totals.yellowCards, 2); assert.equal(bench.totals.dismissals, 1);
    const correction = await f.report(m, { regulationScore: { A: 1, B: 0 } }, true);
    correction.sides.A.players[0].goals = 1; correction.sides.A.coverage.goals = 'partial';
    const saved = await f.write('saveTeamMatchStats', m, { report: correction, reason: '按原始裁判报告更正' });
    assert.equal(saved.ok, true, saved.message);
    assert.equal((await f.call('getMyTeamProfile', {}, a[0].userId)).totals.goals, 2);
    assert.equal((await f.write('reviewTeamMatchStats', m, { approve: true })).ok, true);
    assert.equal((await f.call('getMyTeamProfile', {}, a[0].userId)).totals.goals, 1);
    assert.equal((await f.call('getMyTeamProfile', {}, a[0].userId)).totals.games, 1);
    const board = await f.call('getTeamEventPlayerStats', { eventId: f.eventId });
    assert.equal(board.scorers[0].goals, 1); assert.equal(board.completeCount, 0);
    assert.equal(board.scorers[0].goalsRecordedMatches, 1);
  });
}

test('F2 同分确认通过受权接口保存操作者/理由，非管理员不能抽签；更正后旧名次失效', async () => {
  const f = await fixture(); const m = (await f.matches())[0]; await f.publish(m, await f.report(m));
  const detail = await f.call('getTeamEvent', { eventId: f.eventId });
  const rankingDecisions = [{ tieKey: detail.table[0].tieKey, teamIds: [m.teamB, m.teamA], reason: '现场抽签，B 优先' }];
  assert.equal((await f.call('settleTeamEvent', { eventId: f.eventId, rankingDecisions }, 'viewer')).ok, false);
  const settled = await f.call('settleTeamEvent', { eventId: f.eventId, rankingDecisions });
  assert.equal(settled.ok, true, settled.message);
  const event = await f.repo.teamEvents.getById(f.eventId); assert.equal(event.rankingDecisions[0].decidedBy, 'demo_muc_admin');
  assert.equal((await f.call('getMyTeamProfile', {}, m.teamB === 'ft0' ? 'f0' : 'f12')).honors[0].placement, 1);
  assert.equal((await f.write('recordTeamMatch', m, { report: await f.report(m, { regulationScore: { A: 1, B: 0 } }), reason: '补正' })).ok, true);
  const pendingTable = (await f.call('getTeamEvent', { eventId: f.eventId }, 'viewer')).table;
  assert.deepEqual(pendingTable.map(r => r.teamId), [m.teamB, m.teamA]);
  assert.ok(pendingTable.every(r => r.rank !== null), '未发布更正不使旧抽签名次失效');
  assert.equal((await f.write('publishTeamMatch', m, { approve: true })).ok, true);
  assert.equal((await f.call('getTeamEvent', { eventId: f.eventId })).placements.length, 0);
  assert.equal((await f.call('getMyTeamProfile', {}, 'f0')).honors.length, 0);
  assert.equal((await f.call('settleTeamEvent', { eventId: f.eventId })).ok, true);
});

test('F2 中断不能发布；弃权保留实际与判定比分，未录球员不产生个人进球', async () => {
  const f = await fixture(); const m = (await f.matches())[0];
  const report = await f.report(m, { kind: 'interrupted', regulationScore: { A: 1, B: 0 }, note: '雷雨中断' });
  assert.equal((await f.write('recordTeamMatch', m, { report })).ok, true);
  assert.equal((await f.write('publishTeamMatch', m, { approve: true })).ok, false);
  assert.equal((await f.write('recordTeamMatch', m, { report: await f.report(m, {
    kind: 'forfeit', forfeit: 'A', regulationScore: { A: 1, B: 0 }, awardedScore: { A: 0, B: 3 }, note: '裁判确认弃权' }) })).ok, true);
  assert.equal((await f.write('publishTeamMatch', m, { approve: true })).ok, true);
  const publicReport = (await f.call('getTeamMatchStats', { matchId: m._id }, 'viewer')).report;
  assert.equal(publicReport.result.regulationScore.A, 1); assert.equal(publicReport.result.scoreB, 3);
  assert.equal((await f.call('getTeamEventPlayerStats', { eventId: f.eventId })).players.length, 0);
});

test('F2 云端排期：110 分钟默认、球队/场地/裁判冲突、整轮幂等及失效授权', async () => {
  const f = await fixture({ cloud: true, count: 4 }); const all = await f.matches();
  const a = all[0]; const b = all.find(m => ![a.teamA, a.teamB].includes(m.teamA) && ![a.teamA, a.teamB].includes(m.teamB));
  const schedule = { matchTime: '2026-10-21 14:00', location: '足球场1', refereeId: 'viewer', recorderId: 'recorder', durationMinutes: 110 };
  assert.equal((await f.write('updateTeamMatchSchedule', a, schedule)).ok, true);
  let conflict = await f.write('updateTeamMatchSchedule', b, { ...schedule, location: '足球场2' });
  assert.equal(conflict.ok, false); assert.match(conflict.message, /裁判/);
  conflict = await f.write('updateTeamMatchSchedule', b, { ...schedule, refereeId: '' });
  assert.equal(conflict.ok, false); assert.match(conflict.message, /场地/);
  assert.equal((await f.write('updateTeamMatchSchedule', b, { ...schedule, location: '足球场2', refereeId: '' })).ok, true);
  const shared = all.find(m => m._id !== a._id && m._id !== b._id && [m.teamA, m.teamB].some(id => [a.teamA, a.teamB].includes(id)));
  conflict = await f.write('updateTeamMatchSchedule', shared, { ...schedule, location: '足球场3', refereeId: '' });
  assert.equal(conflict.ok, false); assert.match(conflict.message, /球队/);
  assert.equal((await f.write('updateTeamMatchSchedule', shared, { ...schedule, matchTime: '2026-10-21 15:50', location: '足球场1', refereeId: '' })).ok, true);
  assert.equal((await f.write('updateTeamMatchSchedule', b, { durationMinutes: 90 })).ok, false);
  const shift = { eventId: f.eventId, round: a.round, shiftMinutes: 5, requestId: 'shift_once' };
  // 顺延可能与下一轮碰撞，先清掉那一场以验证幂等。
  assert.equal((await f.write('updateTeamMatchSchedule', shared, { matchTime: null })).ok, true);
  shift.expectRevision = (await f.repo.teamEvents.getById(f.eventId)).revision;
  const shifted = await f.call('updateTeamRoundSchedule', shift); assert.equal(shifted.ok, true, shifted.message);
  const time = (await f.repo.teamMatches.getById(a._id)).matchTime;
  assert.deepEqual(await f.call('updateTeamRoundSchedule', shift), shifted);
  assert.equal((await f.repo.teamMatches.getById(a._id)).matchTime, time);
  const member = await f.repo.schoolMembers.getById(schoolMemberKey('recorder', 'muc'));
  await f.repo.schoolMembers.set(member._id, { ...member, status: 'left' });
  assert.equal((await f.write('updateTeamMatchSchedule', a, { recorderId: 'recorder' })).ok, false);
});

test('F3 足球名单、换人、进球助攻与纪律的结构性错误拦截', async () => {
  const f = await fixture(); const m = (await f.matches())[0];
  const data = await f.report(m, { regulationScore: { A: 1, B: 0 } }, true);
  const entries = await f.repo.forScope(f.SCOPE).teamEventEntries.list();
  const rosters = { A: entries.find(e => e.teamId === m.teamA).roster, B: entries.find(e => e.teamId === m.teamB).roster };
  const check = raw => normalizeFootballReport(raw, { rules, format: 'round_robin', rosters });
  assert.equal(check(data).ok, true);
  const mutate = fn => { const copy = structuredClone(data); fn(copy); return check(copy); };
  assert.equal(mutate(r => { r.sides.A.players[0].userId = 'unregistered'; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[0].goalkeeper = false; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[11].goals = 1; r.sides.A.coverage.goals = 'partial'; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[0].goals = 2; r.sides.A.coverage.goals = 'partial'; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[0].assists = 1; r.sides.A.coverage.assists = 'partial'; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[0].secondYellow = 1; r.sides.A.coverage.secondYellow = 'partial'; }).ok, false);
  const sub = { status: 'full', regulationCount: 1, regulationOpportunities: 1, halfTimeCount: 0, extraTimeCount: 0, extraTimeOpportunities: 0, extraBreakCount: 0 };
  assert.equal(mutate(r => { r.sides.A.substitutions = { ...sub, incomingIds: [r.sides.A.players[0].userId] }; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.players[11].appeared = true; r.sides.A.substitutions = { ...sub, incomingIds: [r.sides.A.players[11].userId] }; }).ok, true);
  assert.equal(mutate(r => { r.sides.A.substitutions = { ...sub, regulationCount: 6, incomingIds: [] }; }).ok, false);
  assert.equal(mutate(r => { r.sides.A.coverage.goals = 'full'; }).ok, false);
  const assisted = structuredClone(data);
  assisted.sides.A.players[0].goals = 1; assisted.sides.A.coverage.goals = 'partial';
  assisted.sides.A.players[1].assists = 1; assisted.sides.A.coverage.assists = 'partial';
  assisted.goalEvents = [{ side: 'A', type: 'normal', scorerId: assisted.sides.A.players[0].userId,
    assistId: assisted.sides.A.players[1].userId, minute: 23 }];
  assert.equal(check(assisted).ok, true);
  assisted.goalEvents[0].assistId = assisted.goalEvents[0].scorerId;
  assert.equal(check(assisted).ok, false);
  assisted.goalEvents[0].assistId = assisted.sides.A.players[1].userId; assisted.goalEvents[0].type = 'penalty';
  assert.equal(check(assisted).ok, false);
});

test('F2 并发录分只接受同版本的一份，不缺版本降级；云端重判被撤销的录入权', async () => {
  const f = await fixture(); const m = (await f.matches())[0];
  const report = await f.report(m);
  const payload = { matchId: m._id, expectRevision: m.revision, report };
  const result = await Promise.all([f.call('recordTeamMatch', { ...payload, requestId: 'concurrent_a' }),
    f.call('recordTeamMatch', { ...payload, requestId: 'concurrent_b' })]);
  assert.equal(result.filter(r => r.ok).length, 1);
  assert.equal((await f.call('recordTeamMatch', { matchId: m._id, requestId: 'missing_revision', report })).ok, false);
  const cloud = await fixture({ cloud: true }); const match = (await cloud.matches())[0];
  assert.equal((await cloud.write('updateTeamMatchSchedule', match, { recorderId: 'recorder' })).ok, true);
  const current = await cloud.repo.teamMatches.getById(match._id);
  cloud.db.beforeTransaction = async () => {
    const user = await cloud.repo.users.getById('recorder');
    await cloud.repo.users.set(user._id, { ...user, platformStatus: 'disabled' });
  };
  assert.equal((await cloud.call('recordTeamMatch', { matchId: match._id, expectRevision: current.revision,
    requestId: 'revoked', report: await cloud.report(match) }, 'recorder')).ok, false);
  assert.equal((await cloud.repo.teamMatches.getById(match._id)).footballDraft, undefined);
});

test('F2 云端赛程新增窗口由排期版本封住；失败不写半份时间', async () => {
  const f = await fixture({ cloud: true, count: 4 }); const matches = await f.matches();
  const a = matches[0]; const b = matches.find(m => ![a.teamA, a.teamB].includes(m.teamA) && ![a.teamA, a.teamB].includes(m.teamB));
  f.db.beforeTransaction = async () => {
    assert.equal((await f.write('updateTeamMatchSchedule', b, { matchTime: '2026-10-23 14:00', location: '足球场' })).ok, true);
  };
  const conflict = await f.write('updateTeamMatchSchedule', a, { matchTime: '2026-10-23 14:00', location: '足球场' });
  assert.equal(conflict.ok, false); assert.match(conflict.message, /赛程刚被改/);
  assert.equal((await f.repo.teamMatches.getById(a._id)).matchTime, null);
  for (const trace of f.db.traces) {
    const firstSet = trace.findIndex(r => r.kind === 'set');
    if (firstSet >= 0) assert.ok(trace.slice(firstSet).every(r => r.kind === 'set'), '事务中所有点读在写入前完成');
  }
});

test('F2/F3 足球默认演示有公开统计，出场覆盖与替补纪律分开；未知名单不显示为确认缺席', async () => {
  const schoolMock = require('../miniprogram/services/school-mock'); schoolMock.reset(); schoolMock.setDemoActor('u12');
  const client = schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'fb' });
  const profile = await client.getMyTeamProfile({});
  assert.equal(profile.ok, true);
  // 演示数据现在每场都有赛后报告（2026-10-23 修：原先扩容的几场只写了比分，
  // 报告缺失让统计端整场丢弃）。u12 是管理学院院队的首位首发，两届学院赛决赛
  // 都记录了出场；而春季联赛两场他是替补未登场，只吃到 1 张黄牌，出场不增加
  // ——「替补受牌不算出场」的口径仍然成立。
  assert.equal(profile.totals.games, 2);
  assert.equal(profile.totals.lineupRecordedMatches, 6); assert.equal(profile.totals.yellowCards, 1);
  const f = await fixture(); const m = (await f.matches())[0]; await f.publish(m, await f.report(m));
  const unknown = await f.call('getMyTeamProfile', {}, 'f0');
  assert.equal(unknown.totals.eligibleMatchCount, 1); assert.equal(unknown.totals.lineupRecordedMatches, 0);
  assert.equal(unknown.totals.goalsText, '—');
});

test('F2 足球录入人候选包含无需额外角色行的普通会员；队长仅能维护本队单场名单', async () => {
  const f = await fixture({ cloud: true }); const m = (await f.matches())[0];
  const candidates = await f.call('getTeamMatchSchedule', { matchId: m._id });
  assert.ok(candidates.recorders.some(p => p.userId === 'demo_muc_member'));
  assert.equal((await f.write('updateTeamMatchSchedule', m, { recorderId: 'demo_muc_member' })).ok, true);
  const data = await f.report(m, { regulationScore: { A: 0, B: 0 } }, true);
  const cap = m.teamA === 'ft0' ? 'f0' : 'f12';
  assert.equal((await f.write('saveTeamMatchLineup', m, { side: 'A', lineup: data.sides.A }, cap)).ok, true);
  assert.equal((await f.write('saveTeamMatchLineup', m, { side: 'B', lineup: data.sides.B }, cap)).ok, false);
  const lineup = await f.call('getTeamMatchLineup', { matchId: m._id }, cap);
  assert.equal(lineup.sides[0].editable, true); assert.equal(lineup.sides[1].editable, false);
  assert.equal((await f.write('recordTeamMatch', m, { report: data }, 'demo_muc_member')).ok, true);
  assert.equal((await f.call('drawTeamEvent', { eventId: f.eventId })).ok, false, '报告不能被重新抽签抹掉');
  assert.equal((await f.write('saveTeamMatchLineup', m, { side: 'A', lineup: data.sides.A }, cap)).ok, false);
});

test('云端协议：足球比赛没有待审核报告就发不出去（云库不会出现「已发布却无报告」）', async () => {
  // 演示种子里曾经有过「status=published 但缺 footballPublished」的比赛（已修）。
  // 那个缺陷在云端不会发生：足球的 publishTeamMatch 以「有待审核报告」为前置，
  // 且只有这一条路径会写 footballPublished。这条用例把该前置钉住。
  const f = await fixture({ cloud: true });
  const match = (await f.matches())[0];
  // 走 write 包装：mutate 要求 requestId + expectRevision（幂等与并发保护）
  const blocked = await f.write('publishTeamMatch', match, { approve: true });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /没有待审核的足球报告/);

  const fresh = await f.repo.forScope(SCOPE).teamMatches.getById(match._id);
  assert.notEqual(fresh.status, 'published', '不能绕过报告直接把比赛标成已发布');
  assert.equal(fresh.footballPublished, undefined);
});

test('F2 单队战绩只读本队那几十条，不再整表读全协会历史（2026-10-26 只读审查 P2-7）', async () => {
  const f = await fixture({ count: 4 });
  const matches = await f.matches();
  const teamId = matches[0].teamA;

  const wholeTable = [];
  for (const key of ['teamEvents', 'teamEventEntries', 'teamMatches', 'teams']) {
    const original = f.repo[key].list;
    f.repo[key].list = (...args) => { wholeTable.push(key); return original.apply(f.repo[key], args); };
  }
  // 用例各自建仓储，探针不需要还原：本用例之后不会再读这个 repo
  const record = await f.call('getTeamRecord', { teamId });
  assert.equal(record.ok, true, record.message);
  assert.equal(record.overall.games, 0, '还没发布比分，战绩应为 0 而不是报错');
  assert.deepEqual(wholeTable, [],
    `单队战绩不该整表读这些集合：${wholeTable.join('、')}`);
});
