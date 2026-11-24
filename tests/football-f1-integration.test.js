// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { schoolMemberKey, teamMemberKey, schoolKey, schoolAssociationKey } = require('../src/shared/utils/school');
const teamService = require('../src/server/services/team-service');
const eventService = require('../src/server/services/team-event-service');
const { createFootballEventForm, validateFootballEventForm } = require('../miniprogram/utils/football-event-form');
const { fixture: cloudFixture } = require('../tools/audit-basketball-cloud.cjs');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
const schoolMock = require('../src/mock/school-mock.js');
const { getAssociation, workbenchTabsOf, basketballRulesOf } = require('../src/shared/utils/associations');
const SCOPE = { schoolId: 'muc', association: 'fb' };
const NOW = new Date('2026-10-20T12:00:00Z');

async function fixture(cloud = false) {
  const cloudEnv = cloud ? await cloudFixture({ count: 2 }) : null;
  const repo = cloudEnv ? cloudEnv.repo : createSchoolMemoryRepo(createSchoolDemoSeed());
  for (const [index, id] of ['capA', 'capB', ...Array.from({ length: 29 }, (_, i) => `fp${i}`)].entries()) {
    await repo.users.set(id, { _id: id, openId: `football_${id}`, nickName: id, platformStatus: 'active',
      platformRole: 'member', primarySchoolId: 'muc' });
    const memberId = schoolMemberKey(id, 'muc');
    await repo.schoolMembers.set(memberId, { _id: memberId, schoolId: 'muc', userId: id,
      collegeId: index % 2 ? 'c01' : 'c02', status: 'active' });
  }
  const call = async (action, payload = {}, actor = 'demo_muc_admin', scope = SCOPE) => {
    if (cloudEnv) {
      const user = await repo.users.getById(actor);
      const response = await handleSchoolRequest({ protocolVersion: 2, ...scope, action, payload }, { repo, openId: user.openId, now: NOW });
      return response.data || response;
    }
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope, now: NOW });
    return (await (teamService[action] || eventService[action])(payload, ctx)).data;
  };
  async function putTeam(id, captain, members) {
    await repo.teams.set(id, { _id: id, ...SCOPE, sport: 'football', name: id, captainId: captain, status: 'active' });
    for (const userId of members) {
      const key = teamMemberKey(id, userId);
      await repo.teamMembers.set(key, { _id: key, ...SCOPE, teamId: id, userId,
        status: 'active', role: userId === captain ? 'captain' : 'member' });
    }
  }
  const rosterA = ['capA', ...Array.from({ length: 10 }, (_, i) => `fp${i}`)];
  const rosterB = ['capB', ...Array.from({ length: 10 }, (_, i) => `fp${i + 10}`)];
  await putTeam('footballA', 'capA', rosterA);
  await putTeam('footballB', 'capB', rosterB);
  const created = await call('createTeamEvent', { name: '十一人制自由组队杯', requestId: 'football_f1' });
  assert.equal(created.ok, true, created.message);
  return { repo, call, putTeam, rosterA, rosterB, eventId: created.eventId, db: cloudEnv && cloudEnv.db };
}

test('F1 足球注册：团队页签、独立规则、校内启用配置与云端元数据一致', () => {
  const association = getAssociation('fb');
  assert.equal(association.teamSportFormat, 'football11');
  assert.deepEqual(workbenchTabsOf('fb').map(tab => tab.tab), ['space', 'teams', 'myTeams', 'events']);
  assert.equal(basketballRulesOf('fb'), null);
  const mirror = require('../cloudfunctions/data/lib/shared/utils/associations');
  assert.deepEqual(mirror.getAssociation('fb'), association);
  assert.ok(createSchoolDemoSeed().schoolAssociations.some(row => row.schoolId === 'muc' && row.association === 'fb' && row.status === 'active'));
});

test('F1 自由组队允许跨学院入队，队长无管理权，足球标识正确且跨范围拒绝', async () => {
  const f = await fixture();
  const applied = await f.call('createTeamApplication', { name: '跨学院自由队', requestId: 'football_team' }, 'capA');
  assert.equal(applied.ok, true, applied.message);
  assert.equal((await f.repo.teams.getById(applied.teamId)).sport, 'football');
  assert.equal((await f.call('reviewTeamApplication', { teamId: applied.teamId, approve: true }, 'capA')).ok, false);
  assert.equal((await f.call('reviewTeamApplication', { teamId: applied.teamId, approve: true })).ok, true);
  assert.equal((await f.call('applyToJoinTeam', { teamId: applied.teamId }, 'capB')).ok, true);
  assert.equal((await f.call('reviewTeamMember', { teamId: applied.teamId, userId: 'capB', approve: true }, 'capA')).ok, true);
  const detail = await f.call('getTeam', { teamId: applied.teamId }, 'capB');
  assert.equal(detail.members.length, 2);
  assert.equal(detail.team.sport, 'football');
  assert.equal((await f.call('getTeam', { teamId: applied.teamId }, 'demo_muc_admin', { schoolId: 'muc', association: 'bk' })).ok, false);
  assert.equal((await f.call('getTeam', { teamId: applied.teamId }, 'demo_buaa_admin', { schoolId: 'buaa', association: 'fb' })).ok, false);
});

for (const cloud of [false, true]) {
  const label = cloud ? '真实云端路由/仓储模拟' : '本地仓储';
  test(`F1 ${label}：自定义规则保存读回且幂等重试不改历史规则`, async () => {
    const f = await fixture(cloud);
    const form = { ...createFootballEventForm(), name: '自定义十一人制联赛', format: 'round_robin', halfMinutes: '35',
      halfTimeMinutes: '5', eventRosterMax: '28', matchRosterMax: '18', substitutionLimit: '7' };
    const input = { ...validateFootballEventForm(form).payload, requestId: 'football_custom' };
    const created = await f.call('createTeamEvent', input);
    assert.equal(created.ok, true, created.message);
    const detail = await f.call('getTeamEvent', { eventId: created.eventId }, 'capA');
    assert.equal(detail.ok, true, detail.message);
    assert.equal(detail.event.rules.halfMinutes, 35);
    assert.equal(detail.event.rules.eventRosterMax, 28);
    assert.equal(detail.event.rules.matchRosterMax, 18);
    assert.equal(detail.event.supportsLiveScore, false); assert.equal(detail.event.supportsMatchData, true);
    assert.doesNotMatch(detail.event.rulesText, /淘汰赛|加时|犯离场/);
    const retried = await f.call('createTeamEvent', { ...input, rules: { ...input.rules, halfMinutes: 40 } });
    assert.equal(retried.eventId, created.eventId);
    assert.equal((await f.repo.teamEvents.getById(created.eventId)).rules.halfMinutes, 35);
  });

  test(`F1 ${label}：同届单人单队、拒绝重复号码、被退回后可以换队报名`, async () => {
    const f = await fixture(cloud);
    await f.putTeam('footballB', 'capB', ['capB', ...f.rosterA.slice(1)]);
    assert.equal((await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballA' }, 'capA')).ok, true);
    const duplicate = await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB' }, 'capB');
    assert.equal(duplicate.ok, false); assert.match(duplicate.message, /其他球队/);
    assert.equal((await f.call('reviewTeamEntry', { eventId: f.eventId, teamId: 'footballA', approve: false })).ok, true);
    const badNumbers = ['capB', ...f.rosterA.slice(1)].map(userId => ({ userId, no: 1 }));
    const bad = await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB', roster: badNumbers }, 'capB');
    assert.equal(bad.ok, false); assert.match(bad.message, /号码.*重复/);
    assert.equal((await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB' }, 'capB')).ok, true);
    assert.equal((await f.call('getTeamEntryRoster', { eventId: f.eventId, teamId: 'footballB' }, 'capA')).ok, false);
  });

  test(`F1 ${label}：失效会籍/停用账号/已转校球员不能写入足球名单`, async () => {
    const f = await fixture(cloud);
    const user = await f.repo.users.getById('fp0');
    const member = await f.repo.schoolMembers.getById(schoolMemberKey('fp0', 'muc'));
    for (const [patchUser, patchMember] of [[{ platformStatus: 'disabled' }, {}], [{ primarySchoolId: 'buaa' }, {}], [{}, { status: 'left' }]]) {
      await f.repo.users.set('fp0', { ...user, ...patchUser });
      await f.repo.schoolMembers.set(member._id, { ...member, ...patchMember });
      const result = await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballA' }, 'capA');
      assert.equal(result.ok, false); assert.match(result.message, /身份已失效/);
      assert.equal(await f.repo.teamEventEntries.getById(schoolKey('ten', f.eventId, 'footballA')), null);
    }
  });
}

test('F1 并发两队报名同一球员，只有一份生效，刷新重试仍拒绝重复', async () => {
  const f = await fixture();
  await f.putTeam('footballB', 'capB', ['capB', ...f.rosterA.slice(1)]);
  const results = await Promise.all([
    f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballA' }, 'capA'),
    f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB' }, 'capB'),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const entries = await f.repo.forScope(SCOPE).teamEventEntries.list();
  assert.equal(entries.length, 1);
  const losingTeam = entries[0].teamId === 'footballA' ? 'footballB' : 'footballA';
  const retried = await f.call('submitTeamEntry', { eventId: f.eventId, teamId: losingTeam }, losingTeam === 'footballA' ? 'capA' : 'capB');
  assert.equal(retried.ok, false); assert.match(retried.message, /其他球队/);
});

test('F1 云端事务窗口：提交前另一队报名，版本复核阻止资格双占', async () => {
  const f = await fixture(true);
  await f.putTeam('footballB', 'capB', ['capB', ...f.rosterA.slice(1)]);
  f.db.beforeTransaction = async () => {
    assert.equal((await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB' }, 'capB')).ok, true);
  };
  const result = await f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballA' }, 'capA');
  assert.equal(result.ok, false); assert.match(result.message, /刚被改过/);
  assert.equal((await f.repo.forScope(SCOPE).teamEventEntries.list()).length, 1);
});

test('F1 云端 28 人报名在百次事务预算内；成员检查中断不留半份名单', async () => {
  const f = await fixture(true);
  const ids = ['capA', ...Array.from({ length: 27 }, (_, i) => `fp${i}`)];
  await f.putTeam('footballA', 'capA', ids);
  const created = await f.call('createTeamEvent', { name: '大名单足球杯', requestId: 'football_28', rules: { eventRosterMax: 28 } });
  const submitted = await f.call('submitTeamEntry', { eventId: created.eventId, teamId: 'footballA' }, 'capA');
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.rosterCount, 28);
  assert.ok(f.db.traces.every(trace => trace.length <= 100));
  assert.ok(f.db.traces.some(trace => trace.length > 80), '真正走过资格点读');
  f.db.failSet('teamEvents', 1);
  await assert.rejects(f.call('submitTeamEntry', { eventId: f.eventId, teamId: 'footballB' }, 'capB'), /RPC failure/);
  assert.equal(await f.repo.teamEventEntries.getById(schoolKey('ten', f.eventId, 'footballB')), null);
});

test('F1 默认演示合并保留篮球并显示足球，普通成员有我的球队且学校停用会阻断访问', async () => {
  schoolMock.reset();
  schoolMock.setDemoActor('demo_muc_admin');
  assert.ok((await schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'bk' }).listTeams({})).teams.length >= 4);
  assert.equal((await schoolMock.forAssociationSpace(SCOPE).listTeams({})).teams.length, 3);
  schoolMock.setDemoActor('u06');
  const mine = await schoolMock.forAssociationSpace(SCOPE).listTeams({ mine: true });
  assert.equal(mine.ok, true); assert.ok(mine.teams.some(team => team.name === '石榴红足球队'));
  const { repo } = await fixture();
  const key = schoolAssociationKey(SCOPE);
  const config = await repo.schoolAssociations.getById(key);
  await repo.schoolAssociations.set(key, { ...config, status: 'disabled' });
  await assert.rejects(buildSchoolContext({ repo, actorId: 'u06', scope: SCOPE, now: NOW }), /未启用/);
  schoolMock.reset();
});
