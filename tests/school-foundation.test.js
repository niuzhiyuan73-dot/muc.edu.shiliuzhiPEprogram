const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolSeed, createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { buildSchoolApplication } = require('../src/server/services/school-member');
const { canSchoolAction } = require('../src/server/services/school-permission');
const { buildSchoolContext } = require('../cloudfunctions/data/src/core/school-context');
const S = require('../src/shared/utils/school');
const { SCOPED_COLLECTIONS } = require('../cloudfunctions/data/src/school-repository');
const MUC = { schoolId: 'muc', association: 'pkb' };
const BUAA = { schoolId: 'buaa', association: 'pkb' };

test('pilot directory contains MUC and simulated Beihang with independent projects and colleges', () => {
  const seed = createSchoolSeed();
  assert.deepEqual(seed.schools.map(s => s.name), ['中央民族大学', '北京航空航天大学']);
  // 每校 × 每个登记协会一条，协会数由注册表决定（新增协会不必改这里）
  const { allAssociations } = require('../src/shared/utils/associations.js');
  assert.equal(seed.schoolAssociations.length, seed.schools.length * allAssociations().length);
  assert.ok(seed.colleges.filter(c => c.schoolId === 'buaa').every(c => c.simulated));
  assert.equal(new Set(seed.colleges.map(c => c._id)).size, seed.colleges.length);
  seed.schools[0].name = 'modified';
  assert.equal(createSchoolSeed().schools[0].name, '中央民族大学');
  const demo = createSchoolDemoSeed();
  assert.equal(demo.schoolMembers.filter(m => m.studentId === 'TEST001').length, 2);
  assert.ok(demo.users.every(u => u.platformRole === 'member'));
});

test('scope requires explicit school and project; legacy documents never silently match', () => {
  assert.throws(() => S.schoolScope({ association: 'pkb' }));
  assert.throws(() => S.schoolScope({ schoolId: 'muc', association: 'unknown' }));
  assert.equal(S.belongsToSchoolScope({ association: 'pkb' }, MUC), false);
  assert.equal(S.belongsToSchoolScope(BUAA, MUC), false);
  assert.equal(S.belongsToSchoolScope(MUC, MUC), true);
  assert.notEqual(S.schoolMemberKey('same', 'muc'), S.schoolMemberKey('same', 'buaa'));
  assert.notEqual(S.schoolMembershipKey('same', MUC), S.schoolMembershipKey('same', BUAA));
  assert.notEqual(S.schoolKey('x', 'a:b', 'c'), S.schoolKey('x', 'a', 'b:c'));
});

test('school application only accepts a college from the requested active school', () => {
  const seed = createSchoolSeed();
  const args = { userId: 'user', school: seed.schools[0], college: seed.colleges[0], studentId: ' TEST001 ', now: '2026-10-13' };
  const result = buildSchoolApplication(args);
  assert.equal(result.studentId, 'TEST001');
  assert.equal(result.status, 'pending');
  assert.equal(result.schoolId, 'muc');
  assert.throws(() => buildSchoolApplication({ ...args, college: seed.colleges.find(c => c.schoolId === 'buaa') }));
  assert.throws(() => buildSchoolApplication({ ...args, school: { ...args.school, status: 'disabled' } }));
  assert.throws(() => buildSchoolApplication({ ...args, studentId: 'a b' }));
});

for (const collection of SCOPED_COLLECTIONS) {
  test(`scoped ${collection}: list, direct-ID reads and transactional writes cannot cross schools`, async () => {
    const repo = createMemoryRepo();
    const a = repo.forScope(MUC)[collection];
    const b = repo.forScope(BUAA)[collection];
    await a.insert({ _id: 'a', marker: 'A' });
    await b.insert({ _id: 'b', marker: 'B' });
    assert.deepEqual((await a.list()).map(d => d._id), ['a']);
    assert.equal(await a.getById('b'), null);
    await assert.rejects(a.set('b', { marker: 'overwrite' }));
    await assert.rejects(a.insert({ _id: 'b' }));
    await assert.rejects(a.update('b', { marker: 'overwrite' }));
    await assert.rejects(a.update('a', { schoolId: 'buaa' }));
    await assert.rejects(a.set('a', { _id: 'b' }));
    assert.equal((await b.getById('b')).marker, 'B');
    await a.update('a', { marker: 'changed' });
    assert.equal((await a.getById('a')).marker, 'changed');
  });
}

test('project, season, ranking and manual-rating namespaces remain independent', async () => {
  const repo = createMemoryRepo();
  const tt = repo.forScope({ ...MUC, association: 'tt' });
  for (const collection of ['matches', 'seasons']) {
    await repo.forScope(MUC)[collection].insert({ _id: 'pkb', value: 123 });
    assert.equal(await tt[collection].getById('pkb'), null);
    await assert.rejects(tt[collection].set('pkb', { value: 456 }));
    assert.deepEqual(await tt[collection].list(), []);
  }
});

test('school scope transaction rolls back all writes and prohibits collection queries', async () => {
  const repo = createMemoryRepo();
  const bound = repo.forScope(MUC);
  await assert.rejects(bound.transaction(async tx => {
    await tx.events.insert({ _id: 'ev' });
    await tx.schoolMembers.insert({ _id: 'sm', status: 'active' });
    throw new Error('injected failure');
  }), /injected/);
  assert.equal(await bound.events.getById('ev'), null);
  assert.equal(await bound.schoolMembers.getById('sm'), null);
  await assert.rejects(bound.transaction(tx => tx.events.list()), /事务内/);
});

test('school context only grants local admins local authority; legacy numeric admins have none', async () => {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const local = await buildSchoolContext({ repo, openId: 'mock_openid_muc_admin', scope: MUC });
  assert.equal(canSchoolAction(local, 'reviewMembers', MUC), true);
  assert.equal(canSchoolAction(local, 'reviewMembers', BUAA), false);
  const other = await buildSchoolContext({ repo, openId: 'mock_openid_muc_admin', scope: BUAA });
  assert.equal(canSchoolAction(other, 'reviewMembers', BUAA), false);
  const member = await buildSchoolContext({ repo, openId: 'mock_openid_muc_member', scope: MUC });
  assert.equal(canSchoolAction(member, 'participate', MUC), true);
  assert.equal(canSchoolAction({ ...member, actor: { ...member.actor, role: 2 } }, 'manageSchool', MUC), false);
  assert.equal(canSchoolAction(local, 'unknownAction', MUC), false);
  const platformAdmin = { ...other, actor: { ...other.actor, platformRole: 'admin' } };
  assert.equal(canSchoolAction(platformAdmin, 'manageSchool', BUAA), true);
  assert.equal(canSchoolAction(platformAdmin, 'participate', BUAA), false);
});

test('inactive identities, stale transfer roles and platform suspension deny writes', async () => {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const ctx = await buildSchoolContext({ repo, openId: 'mock_openid_muc_admin', scope: MUC });
  for (const status of ['pending', 'rejected', 'left', 'disabled']) {
    assert.equal(canSchoolAction({ ...ctx, schoolMember: { ...ctx.schoolMember, status } }, 'manageSchool', MUC), false);
  }
  assert.equal(canSchoolAction({ ...ctx, actor: { ...ctx.actor, primarySchoolId: 'buaa' } }, 'manageSchool', MUC), false);
  assert.equal(canSchoolAction({ ...ctx, actor: { ...ctx.actor, platformStatus: 'disabled' } }, 'manageSchool', MUC), false);
  assert.equal(canSchoolAction({ ...ctx, school: { ...ctx.school, status: 'disabled' } }, 'manageSchool', MUC), false);
});

test('association leaders do not acquire school review authority; college staff are scoped', async () => {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const userId = 'demo_muc_member';
  const id = S.schoolMembershipKey(userId, MUC);
  await repo.memberships.set(id, { ...MUC, userId, role: 'leader', status: 'active' });
  let ctx = await buildSchoolContext({ repo, openId: 'mock_openid_muc_member', scope: MUC });
  assert.equal(canSchoolAction(ctx, 'manageAssociation', MUC), true);
  assert.equal(canSchoolAction(ctx, 'reviewMembers', MUC), false);
  await repo.memberships.set(id, { ...MUC, userId, role: 'staff', status: 'active', collegeId: 'c01' });
  ctx = await buildSchoolContext({ repo, openId: 'mock_openid_muc_member', scope: MUC });
  assert.equal(canSchoolAction(ctx, 'manageCollege', { ...MUC, collegeId: 'c01' }), true);
  assert.equal(canSchoolAction(ctx, 'manageCollege', { ...MUC, collegeId: 'c02' }), false);
  assert.equal(canSchoolAction(ctx, 'manageCollege', { ...BUAA, collegeId: 'c01' }), false);
});

test('context rejects unknown or disabled organizations and corrupt role ownership', async () => {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  await assert.rejects(buildSchoolContext({ repo, scope: { ...MUC, schoolId: 'unknown' } }));
  await repo.schools.set('buaa', { schoolId: 'buaa', status: 'disabled' });
  await assert.rejects(buildSchoolContext({ repo, scope: BUAA }));
  await repo.schoolRoles.set(S.schoolRoleKey('demo_muc_member', 'muc'), { userId: 'someone_else', schoolId: 'muc', status: 'active', role: 'admin' });
  const ctx = await buildSchoolContext({ repo, openId: 'mock_openid_muc_member', scope: MUC });
  assert.equal(ctx.schoolRole, null);
  const guest = await buildSchoolContext({ repo, scope: MUC });
  assert.equal(canSchoolAction(guest, 'participate', MUC), false);
});
