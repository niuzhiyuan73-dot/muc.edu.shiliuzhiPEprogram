/**
 * 学校维度：会员档案 / 名录（迁移清单 M3-b）
 *
 * 守的是：
 *   1. 名录只含「本校 + 在册 + 平台启用 + 归属本校」的会员；跨校外校人读不到
 *      （与协会空间同一把锁 `canReadAssociationSpace`），平台管理员可跨校读；
 *   2. 每行带 `gender` / `collegeName`（赛事报名性别项目、单打榜过滤要用），
 *      学号 / 手机号 / OpenID / 平台角色一律不下发；
 *   3. 可按学院编号 `collegeId` 过滤；
 *   4. 单个档案按 `userId` 取；归属别校 / 已停用 / 不存在一律「找不到」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-member-service');
const { schoolMemberKey } = require('../src/shared/utils/school');
const { COLLEGES } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const PLATFORM_ADMIN = 'demo_platform_admin';
const C01 = 'c01';
const C02 = 'c02';
const NAME_C01 = COLLEGES[0];
const NAME_C02 = COLLEGES[1];

test('5001 条会籍中先下推状态和学院，只批读 2 个符合条件的账号', async () => {
  const seed = createSchoolDemoSeed();
  for (let i = 0; i < 5001; i++) {
    const id = `scale-${i}`;
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id,
      collegeId: i < 3 ? C02 : C01, status: i === 2 ? 'left' : 'active' });
    seed.users.push({ _id: id, platformStatus: 'active', primarySchoolId: 'muc' });
  }
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  const readIds = [];
  const listByIds = repo.users.listByIds;
  repo.users.listByIds = ids => { readIds.push(...ids); return listByIds(ids); };
  const forScope = repo.forScope;
  repo.forScope = scope => {
    const result = forScope(scope);
    result.schoolMembers.list = () => { throw Error('不应读取全校会籍'); };
    return result;
  };
  const result = (await handlers.listSchoolMembers({ collegeId: C02 }, ctx)).data;
  assert.equal(result.ok, true);
  assert.equal(result.members.length, 2);
  assert.deepEqual(readIds.sort(), ['scale-0', 'scale-1']);
});

/** 民大在册会员：admin(c01) / member(c01,男) / member_2(c02,女) / member_3(c01,男) / disabled(c01,停用)。 */
function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.find(user => user._id === 'demo_muc_member').gender = 'M';
  const add = (id, collegeId, gender, platformStatus = 'active') => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, realName: `真名-${id}`,
      gender, platformStatus, platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member_2', C02, 'F');
  add('demo_muc_member_3', C01, 'M');
  add('demo_muc_disabled', C01, 'M', 'disabled');
  // 平台管理员：账号级身份，不带 primarySchoolId，可跨校读。
  seed.users.push({ _id: PLATFORM_ADMIN, openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

/* ------------------------------------------------------------ 名录 */

test('名录：本协会会员可读，只含本校在册且平台启用的会员', async () => {
  const repo = fixture();
  const view = await call(repo, 'listSchoolMembers');
  assert.equal(view.ok, true, view.message);
  const ids = view.members.map(row => row.userId).sort();
  assert.deepEqual(ids, ['demo_muc_admin', 'demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3']);
  assert.equal(view.total, 4);
  // 停用的账号不进名录。
  assert.equal(ids.includes('demo_muc_disabled'), false);
  // 平台管理员不带本校 identity，不在名录里。
  assert.equal(ids.includes(PLATFORM_ADMIN), false);
});

test('名录：每行带 gender / collegeName，且不下发隐私字段', async () => {
  const repo = fixture();
  const view = await call(repo, 'listSchoolMembers');
  const row = view.members.find(item => item.userId === 'demo_muc_member');
  assert.equal(row.gender, 'M');
  assert.equal(row.collegeId, C01);
  assert.equal(row.collegeName, NAME_C01);
  for (const hidden of ['studentId', 'phone', 'openId', 'platformRole', 'primarySchoolId']) {
    assert.equal(hidden in row, false, `不应下发 ${hidden}`);
  }

  const c02Row = view.members.find(item => item.userId === 'demo_muc_member_2');
  assert.equal(c02Row.gender, 'F');
  assert.equal(c02Row.realName, '真名-demo_muc_member_2');
  assert.equal(c02Row.collegeName, NAME_C02);
});

test('名录：可按学院编号过滤', async () => {
  const repo = fixture();
  const view = await call(repo, 'listSchoolMembers', { collegeId: C01 });
  const ids = view.members.map(row => row.userId).sort();
  assert.deepEqual(ids, ['demo_muc_admin', 'demo_muc_member', 'demo_muc_member_3']);
  assert.equal(view.members.every(row => row.collegeId === C01), true);
});

/* ------------------------------------------------------------ 跨校 */

test('跨校：外校会员读不到别校名录，平台管理员可跨校读', async () => {
  const repo = fixture();

  const crossRead = await call(repo, 'listSchoolMembers', {}, { actor: 'demo_buaa_member' });
  assert.equal(crossRead.ok, false);
  assert.match(crossRead.message, /没有读取本协会成员名录/);

  // 会员读自己的学校：只看到本校的人（北航演示账号自 2026-10-16 起扩充为 6 位）。
  const ownView = await call(repo, 'listSchoolMembers', {}, { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.equal(ownView.ok, true);
  assert.deepEqual(ownView.members.map(row => row.userId).sort(),
    ['demo_buaa_admin', 'demo_buaa_college_leader', 'demo_buaa_leader',
      'demo_buaa_member', 'demo_buaa_member_2', 'demo_buaa_member_3']);

  // 平台管理员可跨校读（读的仍是「当前范围那一所学校」的名录）：民大 4 位在册启用会员
  const adminView = await call(repo, 'listSchoolMembers', {}, { actor: PLATFORM_ADMIN });
  assert.equal(adminView.ok, true);
  assert.equal(adminView.members.length, 4);
});

/* ------------------------------------------------------------ 单档案 */

test('档案：按 userId 取单个；不存在 / 别校用户为拒', async () => {
  const repo = fixture();
  const one = await call(repo, 'getSchoolMember', { userId: 'demo_muc_member' });
  assert.equal(one.ok, true, one.message);
  assert.equal(one.member.userId, 'demo_muc_member');
  assert.equal(one.member.gender, 'M');
  assert.equal(one.member.collegeName, NAME_C01);

  const missing = await call(repo, 'getSchoolMember', { userId: 'nobody' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /找不到/);

  const noId = await call(repo, 'getSchoolMember', {});
  assert.equal(noId.ok, false);
  assert.match(noId.message, /缺少会员编号/);

  // 别校用户在本校没有 schoolMember：按「找不到」处理，不泄露其存在。
  const foreign = await call(repo, 'getSchoolMember', { userId: 'demo_buaa_member' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /找不到/);

  // 外校读权限本身也被挡在外。
  const crossRead = await call(repo, 'getSchoolMember', { userId: 'demo_muc_member' },
    { actor: 'demo_buaa_member' });
  assert.equal(crossRead.ok, false);
  assert.match(crossRead.message, /没有读取本协会成员名录/);
});
