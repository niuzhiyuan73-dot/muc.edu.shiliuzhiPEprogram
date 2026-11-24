const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const groupHandlers = require('../src/server/services/association-group-service');
const handlers = require('../src/server/services/association-training-service');
const { schoolMembershipKey } = require('../src/shared/utils/school');

// 训练用例要用小组服务造受众，故合并两套动作到一个派发表。
const HANDLERS = { ...groupHandlers, ...handlers };

const NOW = new Date('2026-10-13T10:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();

/** 演示种子 + 可选协会负责人身份 + 可选「已失效会员」账号（有账号无在册身份）。 */
function fixture({ leader = false, ghost = false } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  if (leader) {
    seed.memberships.push({ _id: schoolMembershipKey('demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'leader', status: 'active' });
  }
  if (ghost) {
    seed.users.push({ _id: 'demo_muc_ghost', openId: 'mock_openid_ghost', nickName: '失踪会员',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
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

async function makeGroup(repo, token, memberIds, opts = {}) {
  const result = await call(repo, 'createAssociationGroup',
    { requestId: token, name: `小组${token}`, memberIds }, opts);
  assert.equal(result.ok, true, result.message);
  return result.group;
}

const trainingRows = async (repo) => repo.associationTrainings.list();

test('发布权限与表单校验：普通会员被拒，字段逐条拦截且不落库', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'publishTraining', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' })).ok, false, '普通会员不能发布训练');

  const cases = [
    { title: 'x' },
    { title: '题'.repeat(31) },
    { location: '' },
    { startAt: '' },
    { startAt: at(-HOUR) },
    { endAt: at(0) },
    { capacity: 0 },
    { capacity: -2 },
    { capacity: 1.5 },
    { capacity: 1001 },
    { audienceMode: 'groups', audienceGroupIds: [] },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const result = await call(repo, 'publishTraining', { requestId: `bad${i}`, ...valid(cases[i]) });
    assert.equal(result.ok, false, `拒绝第 ${i} 个非法表单`);
  }
  assert.equal((await trainingRows(repo)).length, 0, '全部拒绝时无写入');

  // 边界：协会负责人可发（用 leader 身份），开始时间可改在 1 小时后
  const led = fixture({ leader: true });
  assert.equal((await call(led, 'publishTraining', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' })).ok, true, '协会负责人可发');
});

test('容量留空表示不限，结束时间缺省为开始 + 2 小时', async () => {
  const repo = fixture();
  const unlimited = await publish(repo, 'r1', { capacity: '' });
  assert.equal(unlimited.capacity, null, '留空即不限');
  assert.equal(new Date(unlimited.endAt).getTime() - new Date(unlimited.startAt).getTime(),
    2 * HOUR, '缺省时长 2 小时');
  assert.equal(unlimited.state, 'open');
  assert.equal(unlimited.stateLabel, '可报名');

  const capped = await publish(repo, 'r2', { capacity: 3 });
  assert.equal(capped.capacity, 3);
});

test('T03 报名与取消幂等，名单随状态增减', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const first = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.training.signupCount, 1);

  const again = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(again.ok, true, '重复报名幂等');
  assert.equal(again.training.signupCount, 1, '人数不重复计');

  const roster = await call(repo, 'listTrainingRegistrations', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(roster.canManage, false, '会员看不到管理入口');
  assert.equal(roster.members.length, 1);
  assert.equal(roster.members[0].userId, 'demo_muc_member');

  const cancel = await call(repo, 'cancelTrainingRegistration', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.training.signupCount, 0);
  const cancelAgain = await call(repo, 'cancelTrainingRegistration', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(cancelAgain.ok, true, '重复取消幂等');
  assert.equal(cancelAgain.training.signupCount, 0);

  const adminRoster = await call(repo, 'listTrainingRegistrations', { trainingId: t.trainingId, filter: 'canceled' });
  assert.equal(adminRoster.canManage, true);
  assert.equal(adminRoster.registrations.length, 1, '管理端可见取消记录');
  assert.equal(adminRoster.registrations[0].signupStatus, 'canceled');
});

test('T02 并发抢最后一个名额：只成功一人，人数与记录一致', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1', { capacity: 1 });

  const [a, b] = await Promise.all([
    call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' }),
    call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_admin' }),
  ]);
  assert.equal([a, b].filter(r => r.ok).length, 1, '并发下只成功一人');
  assert.equal([a, b].find(r => !r.ok).message, '名额已满');

  const fresh = (await call(repo, 'getTraining', { trainingId: t.trainingId })).training;
  assert.equal(fresh.signupCount, 1, '人数与成功记录一致');
  const rows = await repo.trainingRegistrations.list();
  assert.equal(rows.filter(r => r.signupStatus === 'registered').length, 1);
});

test('时间边界：截止后不能报名，状态由服务器时间推导', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const before = await call(repo, 'getTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(before.training.state, 'open');
  assert.equal(before.canRegister, true, before.registerNote);

  const atStart = await call(repo, 'registerTraining', { trainingId: t.trainingId },
    { actor: 'demo_muc_member', now: new Date(Date.parse(t.startAt)) });
  assert.equal(atStart.ok, false, '开始时刻起不再接受报名');
  assert.equal(atStart.message, '报名已截止');

  const ongoing = await call(repo, 'getTraining', { trainingId: t.trainingId },
    { now: new Date(Date.parse(t.startAt) + MIN) });
  assert.equal(ongoing.training.state, 'ongoing');

  const done = await call(repo, 'getTraining', { trainingId: t.trainingId },
    { now: new Date(Date.parse(t.endAt) + MIN) });
  assert.equal(done.training.state, 'finished');
});

test('小组限制：仅命中组成员可报名，并集命中任一即可', async () => {
  const repo = fixture();
  const g1 = await makeGroup(repo, 'g1', ['demo_muc_member']);
  const g2 = await makeGroup(repo, 'g2', []);
  const t = await publish(repo, 'r1', { audienceMode: 'groups', audienceGroupIds: [g1.groupId, g2.groupId] });

  const inGroup = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(inGroup.ok, true, '命中任一小组即可报名');

  const outsider = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_admin' });
  assert.equal(outsider.ok, false, '不在组内不能报名');
  assert.equal(outsider.message, '本次训练仅限指定小组成员报名');

  const view = await call(repo, 'getTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_admin' });
  assert.equal(view.canRegister, false);
  assert.equal(view.registerNote, '本次训练仅限指定小组成员报名');
});

test('管理移除报名：人数回退，被移除者可重新报名', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });

  const removed = await call(repo, 'removeTrainingRegistration',
    { trainingId: t.trainingId, userId: 'demo_muc_member', reason: '重复占位' });
  assert.equal(removed.ok, true);
  assert.equal(removed.training.signupCount, 0);

  const rows = await repo.trainingRegistrations.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signupStatus, 'canceled');
  assert.equal(rows[0].attendanceStatus, 'not_submitted');

  const re = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  assert.equal(re.ok, true, '被移除后可重新报名');
  assert.equal(re.training.signupCount, 1);
});

test('编辑冻结：有人报名后时间与小组范围锁定，容量不得小于已报名人数', async () => {
  const repo = fixture();
  const g = await makeGroup(repo, 'g1', ['demo_muc_member', 'demo_muc_admin']);
  const t = await publish(repo, 'r1', { capacity: 5, audienceMode: 'groups', audienceGroupIds: [g.groupId] });

  // 编辑是整表单替换：改时间时也要带上现有小组范围，否则会被重置为「不限」。
  const noSignup = await call(repo, 'updateTraining',
    { trainingId: t.trainingId,
      ...valid({ startAt: at(2 * HOUR), audienceMode: 'groups', audienceGroupIds: [g.groupId] }),
      expectedRevision: t.revision });
  assert.equal(noSignup.ok, true, '无报名时可改开始时间');
  assert.equal(noSignup.training.startAt, at(2 * HOUR));
  assert.deepEqual(noSignup.training.audienceGroupIds, [g.groupId], '小组范围保持不变');

  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_admin' });
  const cur = (await call(repo, 'getTraining', { trainingId: t.trainingId })).training;
  assert.equal(cur.signupCount, 2);

  // 后续编辑都保持 cur 的时间不变，只改单个字段，避免把「改时间」与其它拒绝理由混在一起。
  const frozenTime = await call(repo, 'updateTraining',
    { trainingId: t.trainingId, ...valid({ startAt: at(3 * HOUR) }), expectedRevision: cur.revision });
  assert.equal(frozenTime.ok, false, '有报名后冻结开始时间');
  const frozenAudience = await call(repo, 'updateTraining',
    { trainingId: t.trainingId, ...valid({ startAt: cur.startAt, audienceMode: 'all', audienceGroupIds: [] }),
      expectedRevision: cur.revision });
  assert.equal(frozenAudience.ok, false, '有报名后冻结小组范围');
  const held = { startAt: cur.startAt, audienceMode: 'groups', audienceGroupIds: [g.groupId] };
  const below = await call(repo, 'updateTraining',
    { trainingId: t.trainingId, ...valid({ ...held, capacity: 1 }), expectedRevision: cur.revision });
  assert.equal(below.ok, false, '容量小于已报名人数被拒');
  const titleOnly = await call(repo, 'updateTraining',
    { trainingId: t.trainingId, ...valid({ ...held, title: '改后的标题', capacity: 2 }),
      expectedRevision: cur.revision });
  assert.equal(titleOnly.ok, true, '冻结下仍可改标题与不小于人数的容量');
  assert.equal(titleOnly.training.startAt, cur.startAt, '时间保持不变');
  assert.equal(titleOnly.training.title, '改后的标题');
});

test('取消与结束：取消后不能报名与编辑；未到结束时间不能提前结束', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  assert.equal((await call(repo, 'finishTraining', { trainingId: t.trainingId })).ok,
    false, '未到结束时间不能提前结束');

  const canceled = await call(repo, 'cancelTraining', { trainingId: t.trainingId, reason: '场地冲突' });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.training.state, 'canceled');

  assert.equal((await call(repo, 'registerTraining', { trainingId: t.trainingId },
    { actor: 'demo_muc_member' })).ok, false, '取消后不能报名');
  assert.equal((await call(repo, 'updateTraining',
    { trainingId: t.trainingId, ...valid(), expectedRevision: canceled.training.revision })).ok,
    false, '取消后不能编辑');
  assert.equal((await call(repo, 'cancelTraining', { trainingId: t.trainingId })).ok, true, '重复取消幂等');

  const t2 = await publish(repo, 'r2');
  const done = await call(repo, 'finishTraining', { trainingId: t2.trainingId },
    { now: new Date(Date.parse(t2.endAt) + MIN) });
  assert.equal(done.ok, true);
  assert.equal(done.training.status, 'finished');
  assert.equal(done.training.state, 'finished');
});

test('发布幂等：同请求编号同内容返回同一条，换内容被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1', { title: '固定标题' });
  const retry = await call(repo, 'publishTraining', { requestId: 'r1', ...valid({ title: '固定标题' }) });
  assert.equal(retry.ok, true);
  assert.equal(retry.training.trainingId, first.trainingId);
  assert.equal((await trainingRows(repo)).length, 1, '同一编号只落一条');

  const changed = await call(repo, 'publishTraining', { requestId: 'r1', ...valid({ title: '换标题' }) });
  assert.equal(changed.ok, false, '同编号换内容被拒');
});

test('列表：按状态筛选，跨校 / 跨协会隔离', async () => {
  const repo = fixture();
  const open = await publish(repo, 'a');
  const other = await publish(repo, 'b');
  await call(repo, 'cancelTraining', { trainingId: other.trainingId });

  const openList = await call(repo, 'listTrainings', { state: 'open' }, { actor: 'demo_muc_member' });
  assert.deepEqual(openList.trainings.map(r => r.trainingId), [open.trainingId]);
  const canceledList = await call(repo, 'listTrainings', { state: 'canceled' }, { actor: 'demo_muc_member' });
  assert.deepEqual(canceledList.trainings.map(r => r.trainingId), [other.trainingId]);

  assert.equal((await call(repo, 'listTrainings', {}, { actor: 'demo_buaa_member', schoolId: 'buaa' })).trainings.length,
    0, '别校列表为空');
  assert.equal((await call(repo, 'listTrainings', {}, { association: 'tt' })).trainings.length,
    0, '同校别协会列表为空');
  assert.equal((await call(repo, 'getTraining', { trainingId: open.trainingId }, { association: 'tt' })).ok,
    false, '别协会读不到本协会训练');
  assert.equal((await call(repo, 'registerTraining', { trainingId: open.trainingId },
    { actor: 'demo_buaa_member', schoolId: 'buaa' })).ok, false, '外校报不了');
  assert.equal((await call(repo, 'cancelTraining', { trainingId: open.trainingId },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' })).ok, false, '外校管不了');
  assert.equal((await repo.associationTrainings.getById(open.trainingId)).status,
    'published', '隔离后本训练未被改动');
});

test('失效身份：无本校在册会员身份者读不了空间、也报不了名', async () => {
  const repo = fixture({ ghost: true });
  const t = await publish(repo, 'r1');

  const view = await call(repo, 'getTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_ghost' });
  assert.equal(view.ok, false, '空间内容只对本协会有效会员开放');

  const reg = await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_ghost' });
  assert.equal(reg.ok, false);
  assert.equal(reg.message, '只有本协会有效会员可以报名');
  assert.equal((await repo.trainingRegistrations.list()).length, 0, '被拒时无报名写入');
});

test('账号未登录不能写：报名 / 发布都要先有登录身份', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  assert.equal((await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: '' })).ok, false);
  assert.equal((await call(repo, 'publishTraining', { requestId: 'r1', ...valid() }, { actor: '' })).ok, false);
});

test('报名名单按训练取，不读整个协会的报名台账（第三轮 X-8）', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'registerTraining', { trainingId: t.trainingId }, { actor: 'demo_muc_member' });

  // 盯住「整表读」这个动作本身：trainingRegistrations 只增不减，
  // 一个练了三年的协会是数千条 / 几十页 RPC，而这场训练只有一条报名。
  let fullReads = 0;
  const rawForScope = repo.forScope;
  repo.forScope = (input) => {
    const surface = rawForScope(input);
    const original = surface.trainingRegistrations.list;
    surface.trainingRegistrations.list = (...args) => { fullReads += 1; return original.apply(surface.trainingRegistrations, args); };
    return surface;
  };
  try {
    const roster = await call(repo, 'listTrainingRegistrations', { trainingId: t.trainingId });
    assert.equal(roster.ok, true, roster.message);
    assert.equal((roster.registrations || roster.members || []).length, 1, '内容仍要正确');
  } finally {
    repo.forScope = rawForScope;
  }
  assert.equal(fullReads, 0, `报名名单不该整表读（实际 ${fullReads} 次）`);
});
