/**
 * B5：报名主链（意向 → 学院提交 → 校级审核）
 * ============================================================
 * 这一批的红线都在「不该发生的事」上，测试按红线组织：
 *   · 意向不占正式名额（D10），但一旦本院本项目提交了名单，意向入口立即关闭（D25）；
 *   · 部长只能从申请人里选（D14），不能凭空加人，也不能选外院学生（D16）；
 *   · 提交即预占、审核通过才转已用、驳回全部释放（D21／D32）——并发不能超卖；
 *   · 个人项目 2 项上限、同项目组别只报一次、队伍必须满员（D35／D37／D39）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const reg = require('../src/server/services/meet-registration-service.js');
const { meetEventKey, meetEntryKey, meetQuotaKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-17T09:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-20T23:59' };

const users = [
  ['u_admin', '校管理员'], ['u_lead', '一部部长'], ['u_s1', '学生一'], ['u_s2', '学生二'],
  ['u_s3', '学生三'], ['u_o1', '二院学生'], ['u_lead2', '二部部长'], ['u_none', '无学院学生'],
].map(([id, name]) => ({
  _id: id, openId: `o_${id}`, name, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));

const colleges = [
  { _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '信息工程学院', status: 'active' },
  { _id: collegeKey(SCHOOL, 'c02'), schoolId: SCHOOL, collegeId: 'c02', name: '体育学院', status: 'active' },
];

const schoolMembers = [
  ['u_admin', 'c01'], ['u_lead', 'c01'], ['u_s1', 'c01'], ['u_s2', 'c01'], ['u_s3', 'c01'],
  ['u_o1', 'c02'], ['u_lead2', 'c02'],
].map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId,
  status: 'active', gender: userId === 'u_s2' ? 'female' : 'male',
})).concat([{
  _id: schoolMemberKey('u_none', SCHOOL), schoolId: SCHOOL, userId: 'u_none',
  collegeId: '', status: 'active', gender: 'male',
}]);

const schoolRoles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/** 建一个「已发布报名、配好项目、授好部长」的世界 */
async function makeWorld() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });

  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;

  const admin = await ctxOf(repo, 'u_admin', meetId);
  // 单人项目每院 3 人；接力每院 1 队 4 人；拔河 1 队 10 人；展示类不计分
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await meetService.configureMeetEvent({ templateId: 'sprint-200m', group: 'male', perCollegeLimit: 1 }, admin);
  await meetService.configureMeetEvent({ templateId: 'sprint-400m', group: 'male' }, admin);
  await meetService.configureMeetEvent({ templateId: 'relay-4x100', group: 'male', members: 4 }, admin);
  await meetService.configureMeetEvent({ templateId: 'show-gymnastics', group: 'mixed', members: 3, perCollegeLimit: 1 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);
  await leadService.grantMeetCollegeLead({ collegeId: 'c02', userId: 'u_lead2' }, admin);

  return { repo, meetId };
}

const eventKeyOf = (meetId, templateId, group) => meetEventKey(meetId, templateId, group);
// ctxOf 是异步的：漏了 await 会把 Promise 当上下文传进去，表现是「请先登录」
const interest = async (repo, actorId, meetId, eventKey) =>
  reg.submitMeetInterest({ eventKey }, await ctxOf(repo, actorId, meetId));
const submit = async (repo, actorId, meetId, payload) =>
  reg.submitMeetCollegeEntry(payload, await ctxOf(repo, actorId, meetId));

test('没有学院归属的学生不能提交意向（D17）', async () => {
  const { repo, meetId } = await makeWorld();
  const result = await interest(repo, 'u_none', meetId, eventKeyOf(meetId, 'sprint-100m', 'male'));
  assert.equal(result.ok, false);
  assert.match(result.message, /学院归属/);
});

test('学生提交意向成功且重复提交幂等（D10 意向不占名额）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');

  const first = await interest(repo, 'u_s1', meetId, eventKey);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.data.created, true);
  assert.equal(first.data.interest.collegeId, 'c01', '学院应取学籍快照');

  const again = await interest(repo, 'u_s1', meetId, eventKey);
  assert.equal(again.data.created, false);

  // 意向不写名额计数
  const quota = await repo.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, 'c01'));
  assert.equal(quota, null);
});

test('学生可以撤回意向，但已入选后不能撤（D19）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');

  await interest(repo, 'u_s1', meetId, eventKey);
  const withdrawn = await reg.withdrawMeetInterest({ eventKey }, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(withdrawn.ok, true);

  await interest(repo, 'u_s1', meetId, eventKey);
  await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  const blocked = await reg.withdrawMeetInterest({ eventKey }, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /选入正式名单/);
});

test('部长只能从提交过意向的学生里选（D14）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');

  const result = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(result.ok, false);
  assert.match(result.message, /未提交参赛意向/);
});

test('正式提交进入待审核并预占名额（D21／D32）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);

  const result = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.entry.status, 'pending_review');

  const quota = await repo.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, 'c01'));
  assert.equal(quota.pending, 1);
  assert.equal(quota.used, 0, '未审核通过前不能计入已用');

  // 意向转为「已被选中」
  const mine = await reg.getMyMeetParticipation({}, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(mine.data.interests[0].status, 'selected');
});

test('普通学生不能提交正式名单，部长不能替别的学院提交', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);

  const asStudent = await submit(repo, 'u_s1', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(asStudent.ok, false);

  // 另一院的部长不能提交 c01 的学生
  await interest(repo, 'u_o1', meetId, eventKey);
  const crossCollege = await submit(repo, 'u_lead2', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(crossCollege.ok, false);
  assert.match(crossCollege.message, /其他学院/);
});

test('超过每学院上限被拒绝（D29）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-200m', 'male'); // 上限 1
  await interest(repo, 'u_s1', meetId, eventKey);
  await interest(repo, 'u_s2', meetId, eventKey);

  const first = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(first.ok, true, first.message);
  const second = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s2'] });
  assert.equal(second.ok, false);
  assert.match(second.message, /名额已满/);
});

test('并发抢最后一个名额只有一个成功', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-200m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  await interest(repo, 'u_s2', meetId, eventKey);

  const [a, b] = await Promise.all([
    submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] }),
    submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s2'] }),
  ]);
  const okCount = [a, b].filter((result) => result.ok).length;
  assert.equal(okCount, 1, '并发提交超卖了名额');

  const quota = await repo.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, 'c01'));
  assert.equal(quota.pending, 1);
});

test('队伍人数不符被拒绝（D39，无替补 D40）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'relay-4x100', 'male');
  for (const id of ['u_s1', 'u_s2']) await interest(repo, id, meetId, eventKey);

  const result = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1', 'u_s2'] });
  assert.equal(result.ok, false);
  assert.match(result.message, /需 4 人/);
});

test('同一学生不能在同一项目报两次（D37）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);

  await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  const again = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(again.ok, false);
  assert.match(again.message, /已在本项目报名/);
});

test('个人项目最多 2 项；团体项目不计入个人额度（D35）', async () => {
  const { repo, meetId } = await makeWorld();
  const k100 = eventKeyOf(meetId, 'sprint-100m', 'male');
  const k200 = eventKeyOf(meetId, 'sprint-200m', 'male');
  const k400 = eventKeyOf(meetId, 'sprint-400m', 'male');
  const relay = eventKeyOf(meetId, 'relay-4x100', 'male');

  for (const key of [k100, k200, k400]) await interest(repo, 'u_s1', meetId, key);
  for (const id of ['u_s1', 'u_s2', 'u_s3', 'u_lead']) await interest(repo, id, meetId, relay);

  assert.equal((await submit(repo, 'u_lead', meetId, { eventKey: k100, userIds: ['u_s1'] })).ok, true);
  assert.equal((await submit(repo, 'u_lead', meetId, { eventKey: k200, userIds: ['u_s1'] })).ok, true);

  // 第 3 个个人项目：超额
  const third = await submit(repo, 'u_lead', meetId, { eventKey: k400, userIds: ['u_s1'] });
  assert.equal(third.ok, false);
  assert.match(third.message, /个人项目 2 项上限/);

  // 接力是团体项目，不计入个人额度，仍可报名
  const team = await submit(repo, 'u_lead', meetId, {
    eventKey: relay, userIds: ['u_s1', 'u_s2', 'u_s3', 'u_lead'],
  });
  assert.equal(team.ok, true, team.message);
});

test('审核通过：pending 转 used；已通过后不能再审核', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  const submitted = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });

  const approved = await reg.reviewMeetEntry(
    { entryKey: submitted.data.entry._id, decision: 'approve' }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(approved.ok, true, approved.message);

  const quota = await repo.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, 'c01'));
  assert.equal(quota.used, 1);
  assert.equal(quota.pending, 0);

  const again = await reg.reviewMeetEntry(
    { entryKey: submitted.data.entry._id, decision: 'approve' }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(again.ok, false);
});

test('驳回：释放名额、意向回退，可重新提交（B5 回退）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-200m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  const submitted = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });

  const rejected = await reg.reviewMeetEntry(
    { entryKey: submitted.data.entry._id, decision: 'reject', reason: '资料不符' },
    await ctxOf(repo, 'u_admin', meetId));
  assert.equal(rejected.ok, true, rejected.message);

  const quota = await repo.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, 'c01'));
  assert.equal(quota.pending, 0, '驳回必须释放预占');

  const mine = await reg.getMyMeetParticipation({}, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(mine.data.interests[0].status, 'pending', '意向应回到待选拔');

  const resubmit = await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  assert.equal(resubmit.ok, true, '驳回后应可重新提交');
});

test('本院本项目提交后，其他学生不能再提交意向（D25）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });

  const late = await interest(repo, 'u_s2', meetId, eventKey);
  assert.equal(late.ok, false);
  assert.match(late.message, /已提交正式名单/);
});

test('截止后不能提交；管理员开补报窗口后可以（D27）', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);

  const afterClose = new Date('2026-10-25T09:00:00Z');
  const closed = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: ['u_s1'] }, await ctxOf(repo, 'u_lead', meetId, afterClose));
  assert.equal(closed.ok, false);
  assert.match(closed.message, /不在报名时间/);

  const opened = await reg.openMeetLateWindow(
    { openAt: '2026-10-25T00:00', closeAt: '2026-10-26T23:59' }, await ctxOf(repo, 'u_admin', meetId, afterClose));
  assert.equal(opened.ok, true, opened.message);

  const late = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: ['u_s1'] }, await ctxOf(repo, 'u_lead', meetId, afterClose));
  assert.equal(late.ok, true, late.message);
});

test('管理员可代学院提交（D13），并标记为代报', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_o1', meetId, eventKey);

  const result = await submit(repo, 'u_admin', meetId, { eventKey, collegeId: 'c02', userIds: ['u_o1'] });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.byAdmin, true);
  assert.equal(result.data.entry.collegeId, 'c02');
});

test('名单列表：管理员看全届，学生看不到，部长只看本院', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  await interest(repo, 'u_o1', meetId, eventKey);
  await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });
  await submit(repo, 'u_lead2', meetId, { eventKey, userIds: ['u_o1'] });

  const all = await reg.listMeetEntries({}, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(all.data.items.length, 2);

  const mine = await reg.listMeetEntries({}, await ctxOf(repo, 'u_lead', meetId));
  assert.equal(mine.data.items.length, 1);
  assert.equal(mine.data.items[0].collegeId, 'c01');

  const student = await reg.listMeetEntries({}, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(student.ok, false);
});

test('学院工作台给出已报/上限/待审/意向人数', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  await interest(repo, 'u_s2', meetId, eventKey);
  await submit(repo, 'u_lead', meetId, { eventKey, userIds: ['u_s1'] });

  const board = await reg.listMeetCollegeEvents({}, await ctxOf(repo, 'u_lead', meetId));
  assert.equal(board.ok, true, board.message);
  const row = board.data.items.find((item) => item.eventKey === eventKey);
  assert.equal(row.used, 0);
  assert.equal(row.pending, 1);
  assert.equal(row.limit, 3);
  assert.equal(row.applicants, 1, '已入选者不再计入待选人数');
});

test('申请人池只列本院意向，带姓名与性别', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  await interest(repo, 'u_s1', meetId, eventKey);
  await interest(repo, 'u_s2', meetId, eventKey);
  await interest(repo, 'u_o1', meetId, eventKey);

  const pool = await reg.getMeetApplicantPool({ eventKey }, await ctxOf(repo, 'u_lead', meetId));
  assert.equal(pool.ok, true, pool.message);
  assert.deepEqual(pool.data.items.map((row) => row.userId).sort(), ['u_s1', 'u_s2']);
  assert.equal(pool.data.items.find((row) => row.userId === 'u_s2').gender, 'female');
});


test('撤回前一名额后补报名，不覆盖仍有效的后一条名单', async () => {
  const {repo, meetId} = await makeWorld();
  const eventKey = eventKeyOf(meetId, 'sprint-100m', 'male');
  for (const id of ['u_s1', 'u_s3']) assert.equal((await interest(repo,id,meetId,eventKey)).ok,true);
  const first = await submit(repo,'u_lead',meetId,{eventKey,userIds:['u_s1']});
  const second = await submit(repo,'u_lead',meetId,{eventKey,userIds:['u_s3']});
  const before = await repo.sportsMeetEntries.getById(second.data.entry._id);
  assert.equal((await reg.withdrawMeetCollegeEntry({entryKey:first.data.entry._id}, await ctxOf(repo,'u_lead',meetId))).ok,true);
  const third = await submit(repo,'u_lead',meetId,{eventKey,userIds:['u_s1']});
  assert.equal(third.ok,true,third.message);
  assert.notEqual(third.data.entry._id,second.data.entry._id);
  assert.notEqual(third.data.entry._id,first.data.entry._id);
  assert.deepEqual(await repo.sportsMeetEntries.getById(second.data.entry._id),before);
});
