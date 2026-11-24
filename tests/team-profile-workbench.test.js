// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { instantiate, loadPage, withApi, withWx } = require('./helpers/page-harness');
const { teamProfileView } = require('../miniprogram/utils/team-profile-view');
const { workbenchTabsOf, getAssociation } = require('../src/shared/utils/associations');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const service = require('../src/server/services/team-event-service');
const groups = require('../src/server/services/association-group-service');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
function component(file) {
  let definition; const previous = global.Component;
  global.Component = value => { definition = value; };
  try { const id = require.resolve(`../miniprogram/${file}`); delete require.cache[id]; require(id); }
  finally { global.Component = previous; }
  const instance = instantiate({ data: definition.data, ...definition.methods });
  instance.properties = { active: true, association: 'fb' };
  return { definition, instance };
}
const profile = sportFormat => ({ ok: true, sportFormat, name: '本人', teams: [], events: [], honors: [], statEvents: [],
  totals: { games: 2, appearanceGames: 1, goals: 1, goalsText: '1', goalsRecordedMatches: 1,
    points: 0, pointsText: '0', pointsPerGameText: '0', pointsRecordedMatches: 1,
    assists: null, assistsText: '—', assistsRecordedMatches: 0 } });

test('球队工作台：足球和篮球拥有并列“我的球队”，支持直达、懒挂载与刷新转发', () => {
  for (const id of ['fb', 'bk']) {
    assert.deepEqual(workbenchTabsOf(id).map(t => t.label), ['协会空间', '组队', '我的球队', '赛事']);
    const page = instantiate(loadPage('association-home/association-home.js'));
    page.onLoad({ association: id, tab: 'myTeams' });
    assert.equal(page.data.activeTab, 'myTeams'); assert.equal(page.data.mounted.myTeams, true);
    let refreshed = 0; page.selectComponent = id => { assert.equal(id, '#myTeams'); return { onPullDownRefresh: () => { refreshed += 1; } }; };
    page.onPullDownRefresh(); assert.equal(refreshed, 1);
  }
  assert.equal(workbenchTabsOf('pkb').some(t => t.tab === 'myTeams'), false);
});
test('球队页签直接显示累计，无需跳转独立页；篮球和足球指标及未知值分别展示', async () => {
  const { instance, definition } = component('components/team-profile-panel/team-profile-panel.js');
  await withApi({ getMyTeamProfile: () => profile('football11') }, async () => {
    await definition.lifetimes.attached.call(instance);
    assert.equal(instance.data.profile.isFootball, true);
    assert.equal(instance.data.profile.statCells.find(c => c.field === 'goals').totalText, '1');
    assert.equal(instance.data.profile.statCells.find(c => c.field === 'assists').totalText, '—');
  });
  const basketball = teamProfileView(profile('basketball5'));
  assert.equal(basketball.statCells.length, 7); assert.equal(basketball.totals.appearanceGames, 1);
  assert.equal(basketball.statCells.find(c => c.field === 'points').totalText, '0');
  assert.equal(basketball.statCells.find(c => c.field === 'points').recordedMatches, 1);
});
test('球队页签刷新忽略旧响应，返回详情及重切页签均更新；错误时清除旧成绩', async () => {
  const { instance, definition } = component('components/team-profile-panel/team-profile-panel.js');
  let release; let attempt = 0;
  await withApi({ getMyTeamProfile: () => {
    if (++attempt === 1) return new Promise(resolve => { release = resolve; });
    return attempt === 4 ? { ok: false, message: '身份已失效' } : profile('football11');
  } }, async () => {
    const old = instance.refresh(); await instance.refresh();
    release({ ...profile('football11'), name: '旧响应' }); await old;
    assert.equal(instance.data.profile.name, '本人');
    await definition.pageLifetimes.show.call(instance); assert.equal(attempt, 3);
    await definition.properties.active.observer.call(instance, true);
    assert.equal(instance.data.profile, null); assert.equal(instance.data.error, '身份已失效');
  });
});
test('球队页签保留球队/赛事跳转，旧“我的”入口改指向协会页签且模板不再展示旧卡', async () => {
  const { instance } = component('components/team-profile-panel/team-profile-panel.js');
  await withWx(({ navigations }) => {
    instance.onOpenTeam({ currentTarget: { dataset: { teamid: 'team:1' } } });
    instance.onOpenEvent({ currentTarget: { dataset: { eventid: 'event:1' } } });
    assert.match(navigations[0], /teamId=team%3A1/); assert.match(navigations[1], /eventId=event%3A1/);
    const old = instantiate(loadPage('profile/profile.js')); old.currentAssociation = () => 'bk'; old.onGoMyTeamProfile();
    assert.match(navigations[2], /association=bk&tab=myTeams/);
  });
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/profile.wxml'), 'utf8');
  assert.equal(source.includes('onGoMyTeamProfile'), false);
});

for (const cloud of [false, true]) test(`篮球累计${cloud ? '云端协议2' : '本地'}：只读公开统计，逐指标覆盖，球队场次不冒充个人出场`, async () => {
  const seed = createSchoolDemoSeed(); const repo = cloud ? createRepo(database(seed)) : createSchoolMemoryRepo(seed);
  const scope = { schoolId: 'muc', association: 'bk' }; const actor = 'demo_muc_member';
  await repo.teams.set('totalTeam', { _id: 'totalTeam', ...scope, name: '累计示例队', captainId: actor, status: 'active' });
  await repo.teamEvents.set('totalEvent', { _id: 'totalEvent', ...scope, status: 'running', name: '累计测试赛' });
  await repo.teamEventEntries.set('totalEntry', { _id: 'totalEntry', ...scope, eventId: 'totalEvent', teamId: 'totalTeam', status: 'locked', roster: [{ userId: actor, name: '本人' }] });
  for (let i = 0; i < 3; i++) {
    const matchId = `totalMatch${i}`;
    await repo.teamMatches.set(matchId, { _id: matchId, ...scope, eventId: 'totalEvent', teamA: 'totalTeam', teamB: 'opponent',
      status: i < 2 ? 'published' : 'reviewing', scoreA: 20, scoreB: 10, winner: 'A',
      ...(i === 0 ? { lineups: { A: [actor] } } : {}) });
    await repo.teamMatchStats.set(`totalStats${i}`, { _id: `totalStats${i}`, ...scope, eventId: 'totalEvent', matchId, teamId: 'totalTeam',
      status: 'pending', players: [{ userId: actor, points: 99 }], published: { mode: 'basic', integrity: 'basic',
        players: [{ userId: actor, points: i ? 5 : 0, rebounds: i ? 2 : null, assists: null }] } });
  }
  const read = async () => {
    if (cloud) {
      const user = await repo.users.getById(actor);
      const response = await handleSchoolRequest({ protocolVersion: 2, ...scope, action: 'getMyTeamProfile', payload: {} }, { repo, openId: user.openId });
      return response.data;
    }
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope });
    return (await service.getMyTeamProfile({}, ctx)).data;
  };
  const result = await read(); assert.equal(result.ok, true, result.message);
  assert.equal(result.totals.points, 5); assert.equal(result.totals.pointsRecordedMatches, 2);
  assert.equal(result.totals.pointsPerGame, 2.5); assert.equal(result.totals.reboundsRecordedMatches, 1);
  assert.equal(result.totals.reboundsPerGame, 2); assert.equal(result.totals.assistsText, '—');
  assert.equal(result.totals.eligibleMatchCount, 2); assert.equal(result.totals.lineupRecordedMatches, 1);
  // 出场取「定过名单」与「本人这一场有统计」两处证据的并集：第二场没定名单但录了分，
  // 那个人确实上过场；第三场还停在待审核（未发布），一分都不算。
  assert.equal(result.totals.appearanceGames, 2); assert.equal(result.totals.statOnlyAppearanceGames, 1);
  // 参赛经历每一行也要带同一份出场口径：赛事数（events.length）与场次数
  // （appearanceGames）单位不同，逐行给出才能把账对上。
  assert.equal(result.events[0].eligibleMatchCount, 2);
  assert.equal(result.events[0].appearedMatches, 2);
  assert.equal((await read()).totals.points, 5);
});

test('回归：名单为空但录过个人统计的场次仍算出场（已记录出场不再恒为 0）', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const scope = { schoolId: 'muc', association: 'bk' };
  const actor = 'demo_muc_member';
  await repo.teams.set('noLineupTeam', { _id: 'noLineupTeam', ...scope, name: '没定名单队', captainId: actor, status: 'active' });
  await repo.teamEvents.set('noLineupEvent', { _id: 'noLineupEvent', ...scope, status: 'running', name: '没定名单赛' });
  await repo.teamEventEntries.set('noLineupEntry', { _id: 'noLineupEntry', ...scope, eventId: 'noLineupEvent',
    teamId: 'noLineupTeam', status: 'locked', roster: [{ userId: actor, name: '本人' }] });
  // 一场已发布、比分与个人统计都录了，唯独没人点过「定出场名单」——计分台在名单为空时
  // 按整份报名名单录分，这正是截图里「累计得分 73、已记录出场 0」的由来。
  await repo.teamMatches.set('noLineupMatch', { _id: 'noLineupMatch', ...scope, eventId: 'noLineupEvent',
    teamA: 'noLineupTeam', teamB: 'opponent', status: 'published', scoreA: 73, scoreB: 60, winner: 'A' });
  await repo.teamMatchStats.set('noLineupStats', { _id: 'noLineupStats', ...scope, eventId: 'noLineupEvent',
    matchId: 'noLineupMatch', teamId: 'noLineupTeam', status: 'published',
    players: [{ userId: actor, points: 73, assists: 40 }],
    published: { mode: 'basic', integrity: 'basic', players: [{ userId: actor, points: 73, assists: 40 }] } });

  const ctx = await buildSchoolContext({ repo, actorId: actor, scope });
  const { data } = await service.getMyTeamProfile({}, ctx);
  assert.equal(data.ok, true, data.message);
  assert.equal(data.totals.lineupRecordedMatches, 0, '前置条件：一场名单都没定');
  assert.equal(data.totals.points, 73, '前置条件：本人统计已发布');
  assert.equal(data.totals.appearanceGames, 1, `出场应回落到个人统计，实际 ${data.totals.appearanceGames}`);
  assert.equal(data.totals.statOnlyAppearanceGames, 1, '这一场是「有统计、无名单」');
  assert.ok(data.totals.appearanceGames <= data.totals.eligibleMatchCount, '出场不得超过球队已发布场次');
});

test('普通会员入口：服务端声明小组名单权限，非组员无查看入口，组员不能移出他人', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed()); const scope = { schoolId: 'muc', association: 'fb' };
  const invoke = async (action, payload, actor) => (await groups[action](payload,
    await buildSchoolContext({ repo, actorId: actor, scope }))).data;
  const made = await invoke('createAssociationGroup', { requestId: 'ui_group', name: '名单权限测试', memberIds: ['demo_muc_member'] }, 'demo_muc_admin');
  assert.equal(made.ok, true, made.message);
  assert.equal((await invoke('listAssociationGroups', {}, 'demo_muc_member')).groups[0].canReadRoster, true);
  assert.equal((await invoke('listAssociationGroups', {}, 'demo_muc_member_2')).groups[0].canReadRoster, false);
  const { instance } = component('components/association-space-panel/association-space-panel.js');
  instance.setData({ canManage: false, groups: [{ groupId: 'g', canReadRoster: false }] });
  let calls = 0; instance.api = { getAssociationGroup: () => { calls += 1; }, removeAssociationGroupMember: () => { calls += 1; } };
  instance.onToggleGroupDetail({ currentTarget: { dataset: { groupid: 'g' } } });
  instance.onRemoveMember({ currentTarget: { dataset: { groupid: 'g', userid: 'x' } } });
  assert.equal(calls, 0);
});
test('足球图标为可部署的透明 PNG，注册表和工作台均使用图标', () => {
  const icon = getAssociation('fb').logoIcon; assert.equal(icon, '/assets/assoc/fb.png');
  const content = fs.readFileSync(path.join(__dirname, '../miniprogram', icon));
  assert.equal(content.subarray(1, 4).toString(), 'PNG');
  assert.equal(content.readUInt32BE(16), 144); assert.equal(content[25], 6, 'RGBA 透明图标');
  const page = instantiate(loadPage('association-home/association-home.js')); page.onLoad({ association: 'fb' });
  assert.equal(page.data.associationIcon, icon);
});

test('足球赛事入口按普通会员、队长、录入人和管理员分别下发，已发布比赛不展示名单/排期编辑', async () => {
  const { fixture } = require('./helpers/football-fixture');
  const f = await fixture(); const match = (await f.matches())[0];
  const read = async actor => (await f.call('getTeamEvent', { eventId: f.eventId }, actor)).matches[0];
  const viewer = await read('viewer');
  assert.equal(viewer.canSchedule, false); assert.equal(viewer.canRecord, false); assert.equal(viewer.canSetLineup, false);
  const captain = await read(match.teamA === 'ft0' ? 'f0' : 'f12');
  assert.equal(captain.canSetLineup, true); assert.equal(captain.canRecord, false);
  assert.equal((await f.write('updateTeamMatchSchedule', match, { recorderId: 'viewer' })).ok, true);
  const recorder = await read('viewer');
  assert.equal(recorder.canRecord, true); assert.equal(recorder.canSetLineup, false); assert.equal(recorder.canSchedule, false);
  await f.publish(match, await f.report(match));
  const admin = await read('demo_muc_admin');
  assert.equal(admin.canSchedule, false); assert.equal(admin.canSetLineup, false); assert.equal(admin.canRecord, true);
});
