/**
 * B3：学院部长授权与运动会权限判定
 * ============================================================
 * 这一批的核心不是「能不能授予」，而是**授予之外的三条红线**：
 *   ① 协会负责人不得因为 manageCollege 顺带获得替学院报运动会的权力（§7.2）；
 *   ② 一院只有一名部长，并发/重复任命不会出现两个 active；
 *   ③ 撤权立刻生效，且保留记录（不物理删除、按 B3 不写审计）。
 *
 * 用本地模拟仓储 + 真实 buildMeetContext 跑，不碰 wx、不碰云 SDK。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const {
  canManageMeet, canLeadCollegeMeet, isPlatformAdminCtx, isSchoolAdminCtx,
} = require('../src/server/services/meet-permission.js');
const {
  grantMeetCollegeLead, revokeMeetCollegeLead, listMeetCollegeLeads, getMyMeetCollegeLead,
} = require('../src/server/services/meet-college-lead-service.js');
const {
  meetCollegeLeadKey, MEET_COLLEGE_LEAD_STATUS,
} = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';

const users = [
  { _id: 'u_admin', openId: 'o_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_lead', openId: 'o_lead', name: '信息工程学院部长', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_lead2', openId: 'o_lead2', name: '同院第二人', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_stu', openId: 'o_stu', name: '普通学生', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_other', openId: 'o_other', name: '体育学院学生', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_plat', openId: 'o_plat', name: '平台管理员', platformStatus: 'active', platformRole: 'admin', primarySchoolId: SCHOOL },
];

const colleges = [
  { _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '信息工程学院', status: 'active' },
  { _id: collegeKey(SCHOOL, 'c02'), schoolId: SCHOOL, collegeId: 'c02', name: '体育学院', status: 'active' },
];

const members = [
  { _id: schoolMemberKey('u_lead', SCHOOL), schoolId: SCHOOL, userId: 'u_lead', collegeId: 'c01', status: 'active', gender: 'male' },
  { _id: schoolMemberKey('u_lead2', SCHOOL), schoolId: SCHOOL, userId: 'u_lead2', collegeId: 'c01', status: 'active', gender: 'female' },
  { _id: schoolMemberKey('u_stu', SCHOOL), schoolId: SCHOOL, userId: 'u_stu', collegeId: 'c01', status: 'active', gender: 'male' },
  { _id: schoolMemberKey('u_other', SCHOOL), schoolId: SCHOOL, userId: 'u_other', collegeId: 'c02', status: 'active', gender: 'female' },
  { _id: schoolMemberKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', collegeId: 'c01', status: 'active', gender: 'male' },
];

const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

/** 协会负责人身份：用来验证它**不能**借 manageCollege 拿到运动会报名权。 */
const memberships = [
  {
    _id: `mem:${SCHOOL}:pkb:u_stu`, schoolId: SCHOOL, association: 'pkb', userId: 'u_stu',
    role: 'leader', status: 'active', collegeId: 'c01',
  },
];

function makeRepo() {
  return createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles, memberships,
  });
}

const ctxOf = (repo, actorId) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL }, now: new Date('2026-10-17T10:00:00Z'),
});

const readLead = (repo, collegeId) => repo.sportsMeetCollegeLeads.getById(meetCollegeLeadKey(SCHOOL, collegeId));

test('运动会上下文不含协会，结构上无法借协会权限', async () => {
  const repo = makeRepo();
  const ctx = await ctxOf(repo, 'u_stu');
  assert.equal(ctx.schoolId, SCHOOL);
  assert.equal(ctx.association, undefined);
  assert.equal(ctx.membership, undefined);
  assert.equal(ctx.schoolAssociation, undefined);
});

test('校管理员可以任命本院的学院部长', async () => {
  const repo = makeRepo();
  const result = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, await ctxOf(repo, 'u_admin'));
  assert.equal(result.ok, true);
  assert.equal(result.data.created, true);

  const lead = await readLead(repo, 'c01');
  assert.equal(lead.userId, 'u_lead');
  assert.equal(lead.status, MEET_COLLEGE_LEAD_STATUS.ACTIVE);
  assert.equal(lead.schoolId, SCHOOL);
  assert.equal(lead.grantedBy, 'u_admin');
});

test('普通学生不能任命学院部长', async () => {
  const repo = makeRepo();
  const result = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_stu' }, await ctxOf(repo, 'u_stu'));
  assert.equal(result.ok, false);
  assert.match(result.message, /校级管理员及以上/);
  assert.equal(await readLead(repo, 'c01'), null);
});

test('协会负责人身份不能借 manageCollege 任命（§7.2 红线）', async () => {
  const repo = makeRepo();
  // u_stu 在 pkb 协会是 leader，且带 collegeId='c01'——正是可能被 manageCollege 放行的组合
  const ctx = await ctxOf(repo, 'u_stu');
  assert.equal(ctx.membership, undefined, '运动会上下文不应读到协会身份');

  const result = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(await readLead(repo, 'c01'), null);
});

test('不能把外院成员任命为本院部长', async () => {
  const repo = makeRepo();
  const result = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_other' }, await ctxOf(repo, 'u_admin'));
  assert.equal(result.ok, false);
  assert.match(result.message, /不是本学院在册会员/);
});

test('一院一名：第二人被拒绝，同一人重复任命是幂等的', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');

  assert.equal((await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin)).ok, true);

  const second = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead2' }, admin);
  assert.equal(second.ok, false);
  assert.match(second.message, /已有学院部长/);

  const again = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);
  assert.equal(again.ok, true);
  assert.equal(again.data.created, false);
  assert.equal((await readLead(repo, 'c01')).userId, 'u_lead');
});

test('撤权后旧部长立即失去报名权，记录保留而非删除', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');
  await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);

  const beforeCtx = await ctxOf(repo, 'u_lead');
  assert.equal(canLeadCollegeMeet(beforeCtx, await readLead(repo, 'c01'), 'c01'), true);

  const revoked = await revokeMeetCollegeLead({ collegeId: 'c01' }, admin);
  assert.equal(revoked.ok, true);

  const afterCtx = await ctxOf(repo, 'u_lead');
  const lead = await readLead(repo, 'c01');
  assert.equal(lead.status, MEET_COLLEGE_LEAD_STATUS.REVOKED);
  assert.equal(canLeadCollegeMeet(afterCtx, lead, 'c01'), false, '撤权后仍能报名');
  assert.equal(lead.userId, 'u_lead', '记录被删除了，应保留');
});

test('撤销后可以任命新人，且新人立即生效', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');
  await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);
  await revokeMeetCollegeLead({ collegeId: 'c01' }, admin);

  const next = await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead2' }, admin);
  assert.equal(next.ok, true);
  assert.equal(next.data.created, true);

  const lead = await readLead(repo, 'c01');
  const leadCtx = await ctxOf(repo, 'u_lead2');
  assert.equal(canLeadCollegeMeet(leadCtx, lead, 'c01'), true);
});

test('没有任职记录时撤销被拒绝', async () => {
  const repo = makeRepo();
  const result = await revokeMeetCollegeLead({ collegeId: 'c02' }, await ctxOf(repo, 'u_admin'));
  assert.equal(result.ok, false);
  assert.match(result.message, /没有任职记录/);
});

test('平台管理员可任命，普通校级管理员与平台管理员的判定互不干扰', async () => {
  const repo = makeRepo();
  const platCtx = await ctxOf(repo, 'u_plat');
  assert.equal(isPlatformAdminCtx(platCtx), true);
  assert.equal(isSchoolAdminCtx(platCtx), false, '平台管理员不是本校校级管理员');

  const result = await grantMeetCollegeLead({ collegeId: 'c02', userId: 'u_other' }, platCtx);
  assert.equal(result.ok, true);

  const adminCtx = await ctxOf(repo, 'u_admin');
  assert.equal(canManageMeet(adminCtx), true);
  assert.equal(isSchoolAdminCtx(adminCtx), true);
});

test('学生既不能管理运动会，也不是任何学院的部长', async () => {
  const repo = makeRepo();
  const ctx = await ctxOf(repo, 'u_stu');
  assert.equal(canManageMeet(ctx), false);
  assert.equal(canLeadCollegeMeet(ctx, null, 'c01'), false);
});

test('名单只列本校在任部长，并带学院名', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');
  await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);
  await grantMeetCollegeLead({ collegeId: 'c02', userId: 'u_other' }, admin);

  const listed = await listMeetCollegeLeads({}, admin);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.data.items.map((item) => item.collegeId), ['c01', 'c02']);
  assert.equal(listed.data.items[0].collegeName, '信息工程学院');

  const byStudent = await listMeetCollegeLeads({}, await ctxOf(repo, 'u_stu'));
  assert.equal(byStudent.ok, false);
});

test('「我是不是部长」：在任返回本院，撤销后返回空串', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');
  await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);

  const mine = await getMyMeetCollegeLead({}, await ctxOf(repo, 'u_lead'));
  assert.equal(mine.data.collegeId, 'c01');
  assert.equal(mine.data.collegeName, '信息工程学院');

  await revokeMeetCollegeLead({ collegeId: 'c01' }, admin);
  const after = await getMyMeetCollegeLead({}, await ctxOf(repo, 'u_lead'));
  assert.equal(after.data.collegeId, '');
});

test('停用账号不能行使部长权限', async () => {
  const repo = makeRepo();
  const admin = await ctxOf(repo, 'u_admin');
  await grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);

  await repo.users.set('u_lead', { ...users.find((u) => u._id === 'u_lead'), platformStatus: 'disabled' });
  const ctx = await ctxOf(repo, 'u_lead');
  assert.equal(canLeadCollegeMeet(ctx, await readLead(repo, 'c01'), 'c01'), false);
});
