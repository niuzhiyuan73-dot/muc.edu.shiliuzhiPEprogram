const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { createSchoolHandlers } = require('../src/server/services/school-membership-service');
const { getSchoolMemberProfile } = require('../src/server/services/school-rank-service');
const { buildSchoolAccount } = require('../src/server/services/school-member');
const { buildProfilePatch } = require('../src/shared/services/profile');
const { listAssociationMembers } = require('../src/server/services/association-member-service');
const { detachUserFromTeams, leaveTeam, reviewTeamMember } = require('../src/server/services/team-service');
const { getMyTeamProfile } = require('../src/server/services/team-event-service');
const { schoolKey, schoolAccountKey, schoolMemberKey, schoolMembershipKey, teamKey, teamMemberKey } = require('../src/shared/utils/school');
const { sha256 } = require('../src/shared/utils/sha256');
const { migrateExport } = require('../tools/migrate-account-ids');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const NOW = new Date('2026-10-23T04:00:00Z');
const scope = { schoolId: 'muc', association: 'bk' };
const add = (seed, id) => {
  seed.users.push({ _id: id, openId: `synthetic_${id}`, nickName: id, realName: '测试甲', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
  seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
    collegeId: 'c01', studentId: 'SYNTHETIC_STUDENT', status: 'active' });
};
const context = (repo, actorId, association = 'pkb') => buildSchoolContext({ repo, actorId,
  scope: { schoolId: 'muc', association }, now: NOW });

test('学号仅本人和校级审核者可见，协会负责人不能读取他人学号', async () => {
  const seed = createSchoolDemoSeed(); add(seed, 'victim'); add(seed, 'leader');
  seed.memberships.push({ _id: schoolMembershipKey('leader', { schoolId: 'muc', association: 'pkb' }),
    schoolId: 'muc', association: 'pkb', userId: 'leader', role: 'leader', status: 'active' });
  const repo = createSchoolMemoryRepo(seed);
  for (const [actor, visible] of [['victim', true], ['demo_muc_admin', true], ['demo_muc_member', false], ['leader', false]]) {
    const result = (await getSchoolMemberProfile({ userId: 'victim' }, await context(repo, actor))).data;
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.user, 'studentId'), visible, actor);
  }
  const denied = (await getSchoolMemberProfile({ userId: 'victim' }, await context(repo, 'demo_buaa_member'))).data;
  assert.equal(denied.ok, false);
});

test('SHA-256 与 Node 标准实现一致，公开编号不包含 OpenID，且无 Node 全局依赖', () => {
  for (const value of ['', 'abc', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(1000), '测试😀']) {
    assert.equal(sha256(value), crypto.createHash('sha256').update(value).digest('hex'));
  }
  const key = schoolAccountKey('synthetic_openid_secret');
  assert.match(key, /^acc:[a-f0-9]{40}$/);
  assert.equal(key.includes('synthetic_openid_secret'), false);
  assert.equal(key, schoolAccountKey('synthetic_openid_secret'));
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/shared/utils/sha256.js'), 'utf8'), sandbox);
  assert.equal(sandbox.module.exports.sha256('abc'), sha256('abc'));
});

test('超长字段在注册和修改两条路径均被拒绝，合法头像和空昵称兜底兼容', () => {
  const long = 'x'.repeat(300000);
  for (const field of ['nickName', 'avatarUrl']) {
    assert.equal(buildSchoolAccount({ openId: 'synthetic', profile: { realName: '测试甲', gender: 'M', [field]: long } }).ok, false);
    assert.equal(buildProfilePatch({ [field]: long }).ok, false);
  }
  for (const avatarUrl of ['', 'cloud://env/avatars/a.jpeg', 'https://cdn.example/a.png']) {
    assert.equal(buildProfilePatch({ avatarUrl }).ok, true);
  }
  assert.equal(buildProfilePatch({ avatarUrl: 'javascript:alert(1)' }).ok, false);
  assert.equal(buildProfilePatch({ avatarUrl: 'https://cdn.example/a\nb' }).ok, false);
  const built = buildSchoolAccount({ openId: 'synthetic', profile: { realName: '一二三四五六七八九十一二三四五', gender: 'M' } });
  assert.equal(built.ok, true); assert.equal(built.account.nickName.length, 12);
});

test('重复注册和修改资料保持编号稳定，并同步目录搜索字段', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const handlers = createSchoolHandlers({ claimKey: () => 'unused' });
  const call = async payload => {
    const ctx = await buildSchoolContext({ repo, openId: 'synthetic_registration', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
    return (await handlers.registerSchoolAccount(payload, ctx)).data;
  };
  const one = await call({ profile: { realName: '测试乙', gender: 'M', nickName: 'ＡＢＣ' } });
  const two = await call({ profile: { realName: '测试丙', gender: 'F' } });
  assert.equal(one.account.userId, two.account.userId);
  const before = await repo.users.getById(one.account.userId);
  assert.equal(before.directoryNickName, 'abc');
  await handlers.updateSchoolProfile({ patch: { nickName: 'ＤＥＦ' } }, await context(repo, before._id));
  assert.equal((await repo.users.getById(before._id)).directoryNickName, 'def');
});

test('完整导出迁移重写嵌套主键、快照及对象键，保留 OpenID 和文本，二次执行不变', () => {
  const source = Object.fromEntries([...new Set(Object.values(COLLECTIONS))].map(name => [name, []]));
  const old = 'acc:synthetic_old_openid', next = schoolAccountKey('synthetic_old_openid');
  source.users = [{ _id: old, openId: 'synthetic_old_openid', nickName: 'ＡＢＣ', realName: '测试甲' }];
  const oldMember = schoolMemberKey(old, 'muc');
  source.school_members = [{ _id: oldMember, userId: old, schoolId: 'muc', studentId: 'S1' }];
  source.team_members = [{ _id: schoolKey('tmm', schoolKey('tm', oldMember), old), userId: old,
    snapshot: { players: [{ userId: old }], [old]: { name: old } } }];
  const first = migrateExport(source);
  assert.equal(first.migratedAccounts, 1);
  assert.equal(first.data.users[0]._id, next);
  assert.equal(first.data.users[0].openId, 'synthetic_old_openid');
  assert.equal(first.data.users[0].directoryNickName, 'abc');
  assert.equal(first.data.school_members[0]._id, schoolMemberKey(next, 'muc'));
  assert.equal(first.data.team_members[0]._id, schoolKey('tmm', schoolKey('tm', schoolMemberKey(next, 'muc')), next));
  assert.equal(first.data.team_members[0].snapshot.players[0].userId, next);
  assert.equal(first.data.team_members[0].snapshot[next].name, old);
  assert.deepEqual(migrateExport(first.data).data, first.data);
  assert.equal(source.users[0]._id, old);
  assert.throws(() => migrateExport({ users: source.users }), /不完整/);
  source.users.push({ ...source.users[0], _id: next });
  assert.throws(() => migrateExport(source), /重复微信账号/);
});

for (const make of [createSchoolMemoryRepo, createMemoryRepo]) test(`名录分页不再请求全校账号或全量会籍：${make.name}`, async () => {
  const seed = createSchoolDemoSeed();
  for (let i = 0; i < 2000; i++) add(seed, `synthetic_${i}`);
  const repo = make(seed);
  repo.users.listByIds = () => { throw new Error('不应批读全校账号'); };
  const rawScope = repo.forScope;
  repo.forScope = input => {
    const surface = rawScope(input);
    surface.schoolMembers.list = () => { throw new Error('不应读取全量会籍'); };
    return surface;
  };
  const ctx = await context(repo, 'demo_muc_member');
  const first = (await listAssociationMembers({ limit: 20 }, ctx)).data;
  assert.equal(first.members.length, 20); assert.equal(first.hasMore, true);
  const second = (await listAssociationMembers({ limit: 20, cursor: first.nextCursor }, ctx)).data;
  assert.equal(second.members.length, 20);
  assert.equal(first.members.some(a => second.members.some(b => b.userId === a.userId)), false);
});

function raceFixture(cloud = false, count = 2) {
  const seed = createSchoolDemoSeed();
  for (let i = 0; i < count; i++) add(seed, `candidate_${i}`);
  const id = teamKey('synthetic_race', scope), oldId = 'demo_muc_member';
  seed.teams = [{ _id: id, ...scope, name: '测试球队', type: 'free', status: 'active',
    captainId: oldId, memberCount: count + 1, updatedAt: '2026-01-01T00:00:00Z' }];
  seed.teamMembers = [oldId, ...Array.from({ length: count }, (_, i) => `candidate_${i}`)].map((userId, i) => ({
    _id: teamMemberKey(id, userId), ...scope, teamId: id, userId,
    status: 'active', role: i ? 'member' : 'captain', joinedAt: `2026-01-${String(i+1).padStart(2, '0')}T00:00:00Z`,
  }));
  const db = cloud ? database(seed) : null;
  return { seed, id, oldId, db, repo: cloud ? createRepo(db) : createSchoolMemoryRepo(seed) };
}

for (const cloud of [false, true]) test(`并发退队不复活，队长只交给仍有本校身份的成员：cloud=${cloud}`, async () => {
  const f = raceFixture(cloud);
  const nextCtx = await context(f.repo, 'candidate_0', 'bk');
  const leave = async () => {
    const result = (await leaveTeam({ teamId: f.id }, nextCtx)).data;
    assert.equal(result.ok, true, result.message);
  };
  if (cloud) f.db.beforeTransaction = leave;
  else {
    const raw = f.repo.transaction.bind(f.repo);
    f.repo.transaction = async fn => { f.repo.transaction = raw; await leave(); return raw(fn); };
  }
  await detachUserFromTeams(f.repo, { schoolId: 'muc', userId: f.oldId, now: NOW, actorId: 'demo_muc_admin' });
  const left = await f.repo.teamMembers.getById(teamMemberKey(f.id, 'candidate_0'));
  assert.equal(left.status, 'left');
  assert.equal((await f.repo.teams.getById(f.id)).captainId, 'candidate_1');
  if (cloud) assert.ok(f.db.traces.every(trace => trace.length <= 100));
});

test('多候选清理分批检查，停用成员不继任，云端事务保持预算内', async () => {
  const f = raceFixture(true, 26);
  for (let i = 0; i < 25; i++) {
    const id = `candidate_${i}`, doc = await f.repo.users.getById(id);
    await f.repo.users.set(id, { ...doc, platformStatus: 'disabled' });
  }
  await detachUserFromTeams(f.repo, { schoolId: 'muc', userId: f.oldId, now: NOW, actorId: 'demo_muc_admin' });
  assert.equal((await f.repo.teams.getById(f.id)).captainId, 'candidate_25');
  assert.ok(f.db.traces.length >= 2);
  assert.ok(Math.max(...f.db.traces.map(trace => trace.length)) < 100);
});

test('同一时间戳内一退一进，人数不变也通过版本识别新队籍，不能错误归档', async () => {
  const f = raceFixture(true, 1), incoming = 'new_candidate';
  await f.repo.users.set(incoming, { _id: incoming, openId: 'synthetic_new_candidate', platformStatus: 'active', primarySchoolId: 'muc' });
  await f.repo.schoolMembers.set(schoolMemberKey(incoming, 'muc'), { userId: incoming, schoolId: 'muc', status: 'active' });
  await f.repo.teamMembers.set(teamMemberKey(f.id, incoming), { ...scope, teamId: f.id, userId: incoming, role: 'member', status: 'pending' });
  const team = await f.repo.teams.getById(f.id);
  await f.repo.teams.set(f.id, { ...team, revision: 1, updatedAt: NOW.toISOString() });
  const leavingCtx = await context(f.repo, 'candidate_0', 'bk');
  const captainCtx = await context(f.repo, f.oldId, 'bk');
  f.db.beforeTransaction = async () => {
    assert.equal((await leaveTeam({ teamId: f.id }, leavingCtx)).data.ok, true);
    assert.equal((await reviewTeamMember({ teamId: f.id, userId: incoming, approve: true }, captainCtx)).data.ok, true);
  };
  await detachUserFromTeams(f.repo, { schoolId: 'muc', userId: f.oldId, now: NOW, actorId: 'demo_muc_admin' });
  const current = await f.repo.teams.getById(f.id);
  assert.equal(current.captainId, incoming); assert.equal(current.status, 'active');
});

for (const association of ['bk', 'fb']) for (const cloud of [false, true]) test(`未参赛者的个人团队页不读取无关历史：${association}, cloud=${cloud}`, async () => {
  const seed = createSchoolDemoSeed();
  for (const key of ['teams','teamMembers','teamEventEntries','teamEvents','teamMatches','teamMatchStats']) seed[key] = [];
  for (let i = 0; i < 1000; i++) {
    const scoped = { schoolId: 'muc', association }, teamId = `other_team_${i}`, eventId = `other_event_${i}`;
    seed.teams.push({ _id: teamId, ...scoped, status: 'active', name: teamId });
    seed.teamMembers.push({ _id: `other_member_${i}`, ...scoped, teamId, userId: 'other', status: 'active' });
    seed.teamEventEntries.push({ _id: `other_entry_${i}`, ...scoped, teamId, eventId, roster: [{ userId: 'other' }] });
    seed.teamEvents.push({ _id: eventId, ...scoped, status: 'finished' });
    seed.teamMatches.push({ _id: `other_match_${i}`, ...scoped, teamA: teamId, teamB: 'other', eventId, status: 'scheduled' });
    seed.teamMatchStats.push({ _id: `other_stat_${i}`, ...scoped, eventId, matchId: `other_match_${i}` });
  }
  const repo = cloud ? createRepo(database(seed)) : createSchoolMemoryRepo(seed), raw = repo.forScope;
  repo.forScope = input => {
    const surface = raw(input);
    for (const key of ['schoolMembers', 'teams', 'teamMembers', 'teamEventEntries', 'teamEvents', 'teamMatches', 'teamMatchStats']) {
      surface[key].list = () => { throw new Error(`不应全量读取 ${key}`); };
    }
    return surface;
  };
  const result = (await getMyTeamProfile({}, await context(repo, 'demo_muc_member', association))).data;
  assert.equal(result.ok, true);
  assert.equal(result.teams.length, 0); assert.equal(result.events.length, 0);
});

test('正常限流请求会回收过期桶，满容量不重置当前有效账号额度', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/data/src/core/rate-limit.js'), 'utf8');
  const sandbox = { module: { exports: {} }, process: { env: {} } };
  vm.runInNewContext(source+'\nmodule.exports.size=()=>buckets.size;', sandbox);
  const api = sandbox.module.exports;
  for (let i = 0; i < 25000; i++) assert.equal(api.guardRate(`u_${i}`, 'getX', i*1000), null);
  assert.ok(api.size() <= 1);
  api.resetRateLimit();
  for (let i = 0; i < 20000; i++) assert.equal(api.guardRate(`u_${i}`, 'getX', 0), null);
  assert.ok(api.guardRate('overflow', 'getX', 0));
  for (let i = 1; i < api.LIMITS.read; i++) assert.equal(api.guardRate('u_0', 'getX', 0), null);
  assert.ok(api.guardRate('u_0', 'getX', 0));
  assert.equal(api.guardRate('overflow', 'getX', 1000), null);
});
