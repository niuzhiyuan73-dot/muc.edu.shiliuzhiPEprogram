const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const groupHandlers = require('../src/server/services/association-group-service');
const handlers = require('../src/server/services/association-training-service');
const { buildTrainingPointFacts } = require('../src/server/services/training-points');
const { schoolMemberKey } = require('../src/shared/utils/school');

const HANDLERS = { ...groupHandlers, ...handlers };

const NOW = new Date('2026-10-13T10:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();

function fixture({ leader = false } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  if (leader) {
    seed.memberships.push({ _id: require('../src/shared/utils/school').schoolMembershipKey(
      'demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'leader', status: 'active' });
  }
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await HANDLERS[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({ title: '周末训练', description: '常规训练',
  location: '综合体育馆', startAt: at(HOUR), ...extra });

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishTraining', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.training;
}

/** 报名 + 在开始时刻提交签到，返回 { training, registration }。 */
async function checkIn(repo, training, actor = 'demo_muc_member') {
  await call(repo, 'registerTraining', { trainingId: training.trainingId }, { actor });
  const submitted = await call(repo, 'requestTrainingCheckIn', { trainingId: training.trainingId },
    { actor, now: new Date(Date.parse(training.startAt)) });
  return submitted;
}

const factsOf = async (repo) => buildTrainingPointFacts({
  trainings: await repo.associationTrainings.list(),
  registrations: await repo.trainingRegistrations.list(),
});
const audits = async (repo, action) => (await repo.auditLogs.list()).filter(row => row.action === action);

test('T04 未报名不能签到，且只会给自己签到（忽略伪造 userId）', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const noSignup = await call(repo, 'requestTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_admin' }, { actor: 'demo_muc_member',
      now: new Date(Date.parse(t.startAt)) });
  assert.equal(noSignup.ok, false, '未报名不能签到');
  assert.match(noSignup.message, /先报名/);

  // 报名后提交，即使 payload 里塞了别人的 userId，也只改自己那一行。
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  const submitted = await call(repo, 'requestTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_admin' },
    { actor: 'demo_muc_member', now: new Date(Date.parse(t.startAt)) });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.registration.attendanceStatus, 'pending');
  const adminReg = await repo.trainingRegistrations.getById(
    require('../src/shared/utils/school').trainingRegistrationKey(t.trainingId, 'demo_muc_admin',
      { schoolId: 'muc', association: 'pkb' }));
  assert.equal(adminReg, null, '伪造的 userId 未落库');
});

test('T05 / T06 本人签到只到 pending，负责人确认才成功', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const submitted = await checkIn(repo, t);
  assert.equal(submitted.registration.attendanceStatus, 'pending', '签到只到待确认');
  assert.equal(await factsOf(repo).then(f => f.length), 0, '待确认不产生积分事实');

  const byMember = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' },
    { actor: 'demo_muc_member', now: new Date(Date.parse(t.startAt)) });
  assert.equal(byMember.ok, false, '普通会员不能确认签到');

  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' },
    { now: new Date(Date.parse(t.startAt)) });
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(confirmed.registration.attendanceStatus, 'confirmed');
  const facts = await factsOf(repo);
  assert.equal(facts.length, 1, '确认后产生一条积分事实');
  assert.equal(facts[0].amount, 1);
  assert.equal(facts[0].effectiveAt, t.startAt, '积分归属训练发生时间');
});

test('T07 重复确认与并发确认最终只有一次、审计不重复', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await checkIn(repo, t);
  const startNow = new Date(Date.parse(t.startAt));

  const results = await Promise.all([1, 2].map(() => call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow })));
  assert.equal(results.filter(r => r.ok).length >= 1, true, '至少一次成功');
  assert.equal((await factsOf(repo)).length, 1, '最终只有一条积分事实');
  assert.equal((await audits(repo, 'confirmTrainingCheckIn')).length, 1, '审计只写一次');

  const again = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal(again.ok, true, '重复确认幂等');
  assert.equal(again.registration.attendanceStatus, 'confirmed');
  assert.equal((await audits(repo, 'confirmTrainingCheckIn')).length, 1, '幂等不重复写审计');
});

test('T08 直接确认未提交者被拒，不能跳过会员动作', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  const result = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: new Date(Date.parse(t.startAt)) });
  assert.equal(result.ok, false);
  assert.match(result.message, /尚未提交/);
});

test('T09 退回后会员重提再确认，最终只有一条事实', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const startNow = new Date(Date.parse(t.startAt));
  await checkIn(repo, t);

  const rejected = await call(repo, 'rejectTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member', reason: '未到场' }, { now: startNow });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.registration.attendanceStatus, 'rejected');

  const needReason = await call(repo, 'rejectTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal(needReason.ok, false, '退回必须给原因');

  const resubmit = await call(repo, 'requestTrainingCheckIn', { trainingId: t.trainingId },
    { actor: 'demo_muc_member', now: startNow });
  assert.equal(resubmit.ok, true, '窗口内可重新提交');
  assert.equal(resubmit.registration.attendanceStatus, 'pending');

  await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal((await factsOf(repo)).length, 1);
});

test('T10 / T14 撤销确认令积分事实失效，取消训练使全部签到不计分', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const startNow = new Date(Date.parse(t.startAt));
  await checkIn(repo, t);
  await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal((await factsOf(repo)).length, 1);

  const needReason = await call(repo, 'revokeTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal(needReason.ok, false, '撤销必须给原因');

  const revoked = await call(repo, 'revokeTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member', reason: '误点' }, { now: startNow });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.registration.attendanceStatus, 'pending');
  assert.equal((await factsOf(repo)).length, 0, '撤销后事实失效');

  // 重新确认后取消整场训练：即便签到已确认，也不再计分。
  await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal((await factsOf(repo)).length, 1);
  await call(repo, 'cancelTraining', { trainingId: t.trainingId, reason: '场地冲突' },
    { now: new Date(Date.parse(t.startAt) + 5 * MIN) });
  assert.equal((await factsOf(repo)).length, 0, '取消训练后签到不计分');

  const afterCancel = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal(afterCancel.ok, false, '取消后不能确认签到');
});

test('T11 签到窗口：开始前 30 分钟才可提交，结束即关闭', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });

  const tooEarly = await call(repo, 'requestTrainingCheckIn', { trainingId: t.trainingId },
    { actor: 'demo_muc_member', now: new Date(NOW.getTime() + 10 * MIN) });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.message, '签到尚未开始');

  const openEdge = await call(repo, 'requestTrainingCheckIn', { trainingId: t.trainingId },
    { actor: 'demo_muc_member', now: new Date(Date.parse(t.checkInOpenAt)) });
  assert.equal(openEdge.ok, true, '窗口开启时刻可签到');

  const closed = await call(repo, 'requestTrainingCheckIn', { trainingId: t.trainingId },
    { actor: 'demo_muc_member', now: new Date(Date.parse(t.endAt) + MIN) });
  assert.equal(closed.ok, false);
  assert.equal(closed.message, '签到已结束');
});

test('T12 训练结束后仍可处理原有 pending 确认', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await checkIn(repo, t); // pending
  const afterEnd = new Date(Date.parse(t.endAt) + MIN);
  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: afterEnd });
  assert.equal(confirmed.ok, true, '结束后可补确认已提交的 pending');
  assert.equal((await factsOf(repo)).length, 1);
});

test('T17 同一人在两个选中小组里，只报名一次、确认一次、只加 1 分', async () => {
  const repo = fixture();
  const g1 = (await call(repo, 'createAssociationGroup',
    { requestId: 'g1', name: '新手组', memberIds: ['demo_muc_member'] })).group;
  const g2 = (await call(repo, 'createAssociationGroup',
    { requestId: 'g2', name: '校队组', memberIds: ['demo_muc_member'] })).group;
  const t = await publish(repo, 'r1',
    { audienceMode: 'groups', audienceGroupIds: [g1.groupId, g2.groupId] });

  const startNow = new Date(Date.parse(t.startAt));
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  await call(repo, 'requestTrainingCheckIn', { trainingId: t.trainingId }, { actor: 'demo_muc_member', now: startNow });
  await call(repo, 'confirmTrainingCheckIn', { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  const facts = await factsOf(repo);
  assert.equal(facts.length, 1, '命中两个小组仍只算一条事实');
  assert.equal(facts[0].amount, 1);
});

test('T25 已报名后失去会员身份，负责人确认被拒并自动移除报名', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const startNow = new Date(Date.parse(t.startAt));
  await checkIn(repo, t);

  // 令其学校在册身份失效（离校 / 停用）。
  const memberKey = schoolMemberKey('demo_muc_member', 'muc');
  const member = await repo.schoolMembers.getById(memberKey);
  await repo.schoolMembers.set(memberKey, { ...member, status: 'inactive' });

  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: t.trainingId, userId: 'demo_muc_member' }, { now: startNow });
  assert.equal(confirmed.ok, false, '身份失效后不能确认');
  assert.match(confirmed.message, /自动移除/);

  const reg = await repo.trainingRegistrations.getById(
    require('../src/shared/utils/school').trainingRegistrationKey(t.trainingId, 'demo_muc_member',
      { schoolId: 'muc', association: 'pkb' }));
  assert.equal(reg.signupStatus, 'canceled', '报名被自动取消');
  assert.equal(reg.attendanceStatus, 'not_submitted');
  const training = await repo.associationTrainings.getById(t.trainingId);
  assert.equal(training.signupCount, 0, '名额被释放');
  assert.equal((await audits(repo, 'autoRemoveOnConfirm')).length, 1, '自动移除留下审计');
  assert.equal((await factsOf(repo)).length, 0, '不产生积分事实');
});

test('赛季重置：未确认的 pending 自动退回为未参加（T15）', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await checkIn(repo, t); // pending

  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin',
    scope: { schoolId: 'muc', association: 'pkb' }, now: new Date(Date.parse(t.endAt) + MIN) });
  const returned = await handlers.returnPendingOnSeasonReset(repo, ctx);
  assert.equal(returned, 1);

  const reg = await repo.trainingRegistrations.getById(
    require('../src/shared/utils/school').trainingRegistrationKey(t.trainingId, 'demo_muc_member',
      { schoolId: 'muc', association: 'pkb' }));
  assert.equal(reg.attendanceStatus, 'not_submitted', 'pending 被退回为未参加');
  assert.match(reg.rejectionReason, /赛季/);
  assert.equal((await factsOf(repo)).length, 0, '退回后不计分');
  assert.equal((await audits(repo, 'seasonResetReturn')).length, 1);
});
