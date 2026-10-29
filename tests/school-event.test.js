/**
 * 学校维度：个人赛事「发布 + 报名」阶段（迁移清单 M1-a）
 *
 * 守的是两件事：
 *   1. 同协会的会员能读能报，跨学校 / 跨协会读不到、更写不进；
 *   2. 报名阶段的规则（名额、性别项目、报名截止 / 抽签冻结、幂等）与旧栈同一口径。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-event-service');
const {
  schoolMemberKey, schoolEventKey, schoolEventSignupKey,
} = require('../miniprogram/utils/school');
const { MATCH_TYPE, EVENT_STATUS, SIGNUP_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const startAt = new Date(NOW.getTime() + DAY).toISOString();

function fixture({ memberGender = 'M' } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  const setGender = (id, gender) => {
    const user = seed.users.find(item => item._id === id);
    if (user) user.gender = gender;
  };
  setGender('demo_muc_member', memberGender);
  setGender('demo_muc_admin', 'M');
  setGender('demo_buaa_member', 'M');
  // 第二个民大在册会员：用于验证名额上限（同样满足「本协会有效会员」资格）。
  seed.users.push({ _id: 'demo_muc_member_2', openId: 'mock_openid_muc_member_2',
    nickName: '民大模拟会员二', gender: 'M', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: 'muc', simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_member_2', 'muc'),
    userId: 'demo_muc_member_2', schoolId: 'muc', collegeId: 'c01',
    studentId: 'TEST003', status: 'active', simulated: true });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '周末单打赛', description: '协会常规赛', matchType: MATCH_TYPE.SINGLES, level: 3,
  format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
  startTime: startAt, courtCount: 2, ...extra,
});

test('列表分页：超过 50 场可读完，不重复、不跨学校', async () => {
  const repo = fixture();
  for (let i = 0; i < 52; i += 1) await publish(repo, `page_${i}`);
  const first = await call(repo, 'listSchoolEvents', { limit: 50 });
  const second = await call(repo, 'listSchoolEvents', { limit: 50, offset: first.nextOffset });
  assert.equal(first.events.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(second.events.length, 2);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.events, ...second.events].map(row => row.eventId)).size, 52);
  const other = await call(repo, 'listSchoolEvents', {}, { schoolId: 'buaa', actor: 'demo_buaa_admin' });
  assert.equal(other.events.length, 0);
});

test('置顶：管理员可改且重试幂等，会员及跨范围请求不能改', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin');
  const payload = { eventId: event.eventId, pinned: true };
  assert.equal((await call(repo, 'setSchoolEventPinned', payload, { actor: 'demo_muc_member' })).ok, false);
  assert.equal((await call(repo, 'setSchoolEventPinned', payload, { actor: 'demo_platform_admin', schoolId: 'buaa' })).ok, false);
  assert.equal((await call(repo, 'setSchoolEventPinned', payload, { actor: 'demo_platform_admin', association: 'tt' })).ok, false);
  assert.equal((await call(repo, 'setSchoolEventPinned', { ...payload, pinned: 'true' })).ok, false);
  assert.equal((await call(repo, 'setSchoolEventPinned', payload)).event.pinned, true);
  const stored = await repo.events.getById(event.eventId);
  await call(repo, 'setSchoolEventPinned', payload);
  assert.deepEqual(await repo.events.getById(event.eventId), stored);
  assert.equal((await call(repo, 'setSchoolEventPinned', { ...payload, pinned: false })).event.pinned, false);
});

test('置顶：审计失败会回滚赛事修改', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin_rollback');
  const before = await repo.events.getById(event.eventId);
  const transaction = repo.transaction.bind(repo);
  repo.transaction = work => transaction(tx => {
    tx.audit.append = async () => { throw new Error('audit unavailable'); };
    return work(tx);
  });
  await assert.rejects(call(repo, 'setSchoolEventPinned', { eventId: event.eventId, pinned: true }), /audit unavailable/);
  assert.deepEqual(await repo.events.getById(event.eventId), before);
});

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishSchoolEvent', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.event;
}

test('发布：仅协会负责人及以上可发，会员被拒', async () => {
  const repo = fixture();
  const byMember = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /负责人/);

  const byAdmin = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.event.status, EVENT_STATUS.SIGNUP);
  assert.equal(byAdmin.event.signupCount, 0);
});

test('发布：请求编号幂等，改内容重发被拒；非法编号与非法表单被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1');
  const again = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() });
  assert.equal(again.ok, true);
  assert.equal(again.event.eventId, first.eventId, '同编号同内容返回同一条');

  const changed = await call(repo, 'publishSchoolEvent',
    { requestId: 'r1', ...valid({ title: '换了名字的赛' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);

  const badToken = await call(repo, 'publishSchoolEvent', { requestId: '含 空格', ...valid() });
  assert.equal(badToken.ok, false);

  const badForm = await call(repo, 'publishSchoolEvent', { requestId: 'r2', ...valid({ title: '短' }) });
  assert.equal(badForm.ok, false);
  assert.ok(badForm.errors && badForm.errors.title, '表单错误按字段下发');
});

test('报名：会员可报，人数计数与重复报名幂等', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  const signed = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(signed.ok, true, signed.message);
  assert.equal(signed.signup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(signed.event.signupCount, 1);

  const again = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(again.ok, true, '重复报名幂等');
  assert.equal(again.event.signupCount, 1, '不重复计数');

  const detail = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(detail.ok, true);
  assert.equal(detail.event.mySignup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(detail.capabilities.canSignUp, false, '已报名不能再报');
  assert.equal(detail.capabilities.canCancelSignup, true);
});

test('详情：能力旗标按角色与赛程状态下发，写端仍会再判一次', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 报名阶段：会员可报不能开赛/抽签/录名次；管理员可开赛但还不能开（未抽签由写端挡）。
  const asMember = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(asMember.capabilities.canSignUp, true);
  assert.equal(asMember.capabilities.canStart, false);
  assert.equal(asMember.capabilities.canDraw, false);
  assert.equal(asMember.capabilities.canFinish, false);

  const asAdmin = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  assert.equal(asAdmin.capabilities.canDraw, true, '负责人可抽签');
  assert.equal(asAdmin.capabilities.canStart, true, '负责人可开赛');
  assert.equal(asAdmin.capabilities.canFinish, false, '还没开赛，不能录名次');

  // 详情不下发未抽签时的签表 / 名次（真值为空）。
  assert.equal(asAdmin.event.draw, null);
  assert.deepEqual(asAdmin.event.results, []);
});

test('报名名单：带姓名与学院；取消者剔除；跨校读不到', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member_2' });
  // 第三个人报了又退，名单里不应出现。
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_admin' });
  await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId }, { actor: 'demo_muc_admin' });

  const roster = await call(repo, 'listSchoolEventSignups', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(roster.ok, true, roster.message);
  assert.deepEqual(roster.signups.map(row => row.userId).sort(),
    ['demo_muc_member', 'demo_muc_member_2'], '取消报名的人不占名单');

  const first = roster.signups.find(row => row.userId === 'demo_muc_member');
  assert.ok(first, '报名者在名单里');
  assert.ok(first.nickName, '带昵称');
  assert.equal(typeof first.college, 'string');
  assert.equal(first.status, SIGNUP_STATUS.SIGNED);
  assert.equal(first.canCheckIn, false, '报名阶段还不能签到');

  // 名单只下发展示字段：不得出现学号 / 手机号。
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'studentId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'phone'), false);

  // 外校读不到这份名单。
  const buaa = await call(repo, 'listSchoolEventSignups', { eventId: event.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_admin' });
  assert.equal(buaa.ok, false);
});

test('报名：名额满了就拒，取消报名释放名额', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1', { quota: 1 });

  const first = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(first.ok, true);

  const second = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member_2' });
  assert.equal(second.ok, false, '名额只剩 0，第二人被拒');
  assert.match(second.message, /满/);

  const cancel = await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.event.signupCount, 0);
  assert.equal(cancel.event.mySignup.status, SIGNUP_STATUS.CANCELED);

  const resub = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(resub.ok, true, '取消后可重新报名');
  assert.equal(resub.event.signupCount, 1);
});

test('历史计数分叉：详情按台账展示，列表按汇总并保留本人报名状态', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r_count', { quota: 8 });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member_2' });

  // 手工把主记录计数改小（模拟演示种子 / 早期导入留下的分叉数据）
  await repo.transaction(async (tx) => {
    const doc = await tx.events.getById(event.eventId);
    await tx.events.set(event.eventId, { ...doc, signupCount: 0 });
  });

  const detail = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  assert.equal(detail.event.signupCount, 2, '详情不能因为计数器是 0 就说没人报名');
  assert.equal(detail.event.quotaText, '2/8 人');
  assert.equal(detail.signupCount, 2);

  const list = await call(repo, 'listSchoolEvents', {});
  const row = list.events.find(item => item.eventId === event.eventId);
  assert.equal(row.signupCount, 0, '列表不再读取台账，历史计数偏差需要校正汇总');
  assert.equal(row.quotaText, '0/8 人');
  assert.equal(row.isSignup, true);

  // 取消后展示回落：台账里只剩一个有效报名
  await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  const after = await call(repo, 'getSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member_2' });
  assert.equal(after.event.signupCount, 1);
  assert.equal(after.event.quotaText, '1/8 人');
});

test('名额与展示同一把尺子：计数偏小时不许超员，计数偏大时不放行', async () => {
  const repo = fixture();

  // F1：计数偏小（0），台账里已经坐满 2 个 —— 只看计数会超员，必须按占用数拦下
  const full = await publish(repo, 'r_quota_low', { quota: 2 });
  await call(repo, 'signUpSchoolEvent', { eventId: full.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: full.eventId }, { actor: 'demo_muc_member_2' });
  await repo.transaction(async (tx) => {
    const doc = await tx.events.getById(full.eventId);
    await tx.events.set(full.eventId, { ...doc, signupCount: 0 });
  });

  const detail = await call(repo, 'getSchoolEvent', { eventId: full.eventId }, { actor: 'demo_muc_admin' });
  assert.equal(detail.event.quotaText, '2/2 人');
  assert.equal(detail.capabilities.canSignUp, false, '页面不该给一个点下去必被拒的报名按钮');
  assert.match(detail.signupNote, /满/);

  // 第三个会员（管理员自己）直接调写接口也必须被拦：展示与写入口径一致，且不超员
  const blocked = await call(repo, 'signUpSchoolEvent', { eventId: full.eventId }, { actor: 'demo_muc_admin' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /满/);
  const roster = await call(repo, 'listSchoolEventSignups', { eventId: full.eventId });
  assert.equal(roster.signups.length, 2, '名额 2 就是 2 个人，不能因为计数是 0 就多收一个');

  // F2：计数偏大（3）而台账只有 2 个有效 —— 展示按台账，名额按占用数（取大）：
  // 页面不显示「还能报」，写接口也不放行，两边一致
  const high = await publish(repo, 'r_quota_high', { quota: 3 });
  await call(repo, 'signUpSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_member_2' });
  await repo.transaction(async (tx) => {
    const doc = await tx.events.getById(high.eventId);
    await tx.events.set(high.eventId, { ...doc, signupCount: 3 });
  });

  const highDetail = await call(repo, 'getSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_admin' });
  assert.equal(highDetail.event.quotaText, '2/3 人', '展示按台账，两个人就是两个人');
  assert.equal(highDetail.capabilities.canSignUp, false, '计数说占了 3 位，就不该再放人进来');
  assert.match(highDetail.signupNote, /满/);
  const alsoBlocked = await call(repo, 'signUpSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_admin' });
  assert.equal(alsoBlocked.ok, false);
  assert.match(alsoBlocked.message, /满/);

  // 取消一位：占用数跟着降，可以补位；落库后计数不再低于台账
  await call(repo, 'cancelSchoolEventSignup', { eventId: high.eventId }, { actor: 'demo_muc_member' });
  const afterCancel = await call(repo, 'signUpSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_admin' });
  assert.equal(afterCancel.ok, true, afterCancel.message);
  const stored = await repo.events.getById(high.eventId);
  const rosterAfter = await call(repo, 'listSchoolEventSignups', { eventId: high.eventId });
  assert.ok(stored.signupCount >= rosterAfter.signups.length,
    '计数不会低于台账：低计数会让下一次报名按偏小的数放行');
  assert.equal(afterCancel.event.quotaText, '2/3 人');

  // 虚高的计数仍在（历史数据留下的水位）：占用数取大，所以写端与详情页一致地拒绝，
  // 不会再出现「页面说还能报、点下去被拒」或反过来超员的情形
  const resub = await call(repo, 'signUpSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_member' });
  assert.equal(resub.ok, false);
  assert.match(resub.message, /满/);
  const finalDetail = await call(repo, 'getSchoolEvent', { eventId: high.eventId }, { actor: 'demo_muc_member' });
  assert.equal(finalDetail.capabilities.canSignUp, false);
  assert.match(finalDetail.signupNote, /满/);
});

test('写路径：请求期间账号被停用，开赛 / 抽签 / 录名次都不落库（F1/F2 同类扫尾）', async () => {
  const repo = fixture();
  const event = await publish(repo, 'inflight_event');
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member_2' });

  const disableAtTxStart = () => {
    const transaction = repo.transaction;
    repo.transaction = async fn => {
      const user = await repo.users.getById('demo_muc_admin');
      await repo.users.set(user._id, { ...user, platformStatus: 'disabled' });
      return transaction(fn);
    };
    return () => { repo.transaction = transaction; };
  };

  const restore = disableAtTxStart();
  const drawn = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 42 });
  assert.equal(drawn.ok, false, '停用之后不能再抽签');
  assert.match(drawn.message, /停用|权限/);
  assert.equal((await repo.events.getById(event.eventId)).status, EVENT_STATUS.SIGNUP, '状态没有被改动');

  // 撤掉注入、恢复账号：同一笔抽签照常落库（拒绝的是身份，不是流程）
  restore();
  const user = await repo.users.getById('demo_muc_admin');
  await repo.users.set(user._id, { ...user, platformStatus: 'active' });
  const okDraw = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 42 });
  assert.equal(okDraw.ok, true, okDraw.message);

  // 开赛与录名次共用同一道闸：管理员角色在事务前被撤，两个动作都不该生效
  const transaction = repo.transaction;
  repo.transaction = async fn => {
    const key = require('../miniprogram/utils/school').schoolRoleKey('demo_muc_admin', 'muc');
    const role = await repo.schoolRoles.getById(key);
    await repo.schoolRoles.set(key, { ...role, status: 'disabled' });
    return transaction(fn);
  };
  const started = await call(repo, 'startSchoolEvent', { eventId: event.eventId });
  assert.equal(started.ok, false, '撤权之后不能再开赛');
  assert.equal((await repo.events.getById(event.eventId)).status, EVENT_STATUS.SIGNUP);
});

test('报名：性别项目只收相符性别', async () => {
  const repo = fixture({ memberGender: 'F' });
  const event = await publish(repo, 'r1', { discipline: 'MS' }); // 男单

  const blocked = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /男单/);

  const byMale = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_admin' });
  assert.equal(byMale.ok, true, byMale.message);
});

test('跨学校 / 跨协会：读不到、写不进', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 北航看不到民大的赛事。
  const buaaList = await call(repo, 'listSchoolEvents', {}, {
    schoolId: 'buaa', actor: 'demo_buaa_admin', association: 'pkb',
  });
  assert.equal(buaaList.ok, true);
  assert.equal(buaaList.events.length, 0, '外校列表为空');

  const buaaGet = await call(repo, 'getSchoolEvent', { eventId: event.eventId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member', association: 'pkb',
  });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /不存在/);

  // 北航会员报名民大 / 北航的赛事键（同一 eventId 在北航范围内不存在）。
  const buaaSignup = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member', association: 'pkb',
  });
  assert.equal(buaaSignup.ok, false);

  // 民大另一协会（乒乓）也看不到。
  const otherAssoc = await call(repo, 'listSchoolEvents', {}, {
    actor: 'demo_muc_member', association: 'tt',
  });
  assert.equal(otherAssoc.ok, true);
  assert.equal(otherAssoc.events.length, 0, '本校外协会看不到');
});

test('主记录带范围：schoolId + association，键含范围', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const stored = await repo.events.getById(event.eventId);
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(event.eventId, schoolEventKey(require('../miniprogram/utils/school')
    .schoolKey('e', 'demo_muc_admin', 'r1'), { schoolId: 'muc', association: 'pkb' }));
});

test('报名记录：稳定主键按范围生成，跨范围读不到', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });

  const key = schoolEventSignupKey(event.eventId, 'demo_muc_member', { schoolId: 'muc', association: 'pkb' });
  const row = await repo.eventSignups.getById(key);
  assert.equal(row.schoolId, 'muc');
  assert.equal(row.association, 'pkb');
  assert.equal(row.status, SIGNUP_STATUS.SIGNED);

  // 换一个范围用同一个键读不到。
  const otherKey = schoolEventSignupKey(event.eventId, 'demo_muc_member', { schoolId: 'buaa', association: 'pkb' });
  assert.equal(await repo.eventSignups.getById(otherKey), null);
});

test('报名截止后不能再报；抽签冻结报名', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 直接把赛事推进到进行中（开赛在后续切片接入，这里只验证报名端的闸门）。
  const stored = await repo.events.getById(event.eventId);
  await repo.events.set(event.eventId, { ...stored, status: EVENT_STATUS.ONGOING });
  const afterStart = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(afterStart.ok, false);
  assert.match(afterStart.message, /截止/);

  // 另一场：报名中但已抽签（draw 非空）——名单冻结。
  const drawn = await publish(repo, 'r2');
  const drawnDoc = await repo.events.getById(drawn.eventId);
  await repo.events.set(drawn.eventId, { ...drawnDoc, draw: { size: 2, slots: [] } });
  const afterDraw = await call(repo, 'signUpSchoolEvent', { eventId: drawn.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(afterDraw.ok, false);
  assert.match(afterDraw.message, /抽签/);
});

/* ------------------------------------------------------------------ 小组限制（B6） */

const groupHandlers = require('../miniprogram/services/association-group-service');

async function callGroup(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await groupHandlers[action](payload, ctx)).data;
}

/** 建一个小组并把若干会员放进去，返回 groupId。 */
async function makeGroup(repo, token, memberIds) {
  const created = await callGroup(repo, 'createAssociationGroup',
    { requestId: token, name: `精英组${token}`, memberIds });
  assert.equal(created.ok, true, created.message);
  return created.group.groupId;
}

test('B6 发布赛事带小组限制：非法表单拒绝，合法落库并在 DTO 里下发', async () => {
  const repo = fixture();
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member']);

  const emptyGroups = await call(repo, 'publishSchoolEvent',
    { requestId: 'r1', ...valid({ audienceMode: 'groups', audienceGroupIds: [] }) });
  assert.equal(emptyGroups.ok, false);
  assert.match(emptyGroups.message, /至少选择一个小组/);

  const allWithGroups = await call(repo, 'publishSchoolEvent',
    { requestId: 'r2', ...valid({ audienceMode: 'all', audienceGroupIds: [groupId] }) });
  assert.equal(allWithGroups.ok, false);
  assert.match(allWithGroups.message, /不能指定小组/);

  const ok = await call(repo, 'publishSchoolEvent',
    { requestId: 'r3', ...valid({ audienceMode: 'groups', audienceGroupIds: [groupId] }) });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.event.audienceMode, 'groups');
  assert.deepEqual(ok.event.audienceGroupIds, [groupId]);

  // 旧赛事 / 未带限制的赛事按「不限」下发
  const plain = await publish(repo, 'r4');
  assert.equal(plain.audienceMode, 'all');
  assert.deepEqual(plain.audienceGroupIds, []);
});

test('B6 报名资格：只限命中组成员，非组成员被拒，详情口径与写入一致', async () => {
  const repo = fixture();
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member']); // 只有 member 在组里
  const event = await publish(repo, 'r1', { audienceMode: 'groups', audienceGroupIds: [groupId] });

  // 非组成员（同为有效会员）报名被拒
  const outsider = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member_2' });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /指定小组成员/);

  // 详情页对非组成员：不可报、原因一致
  const detail = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member_2' });
  assert.equal(detail.capabilities.canSignUp, false);
  assert.match(detail.signupNote, /指定小组成员/);

  // 组成员可报；详情页对本人：可报且已报
  const signed = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(signed.ok, true, signed.message);
  const mine = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(mine.mySignup.status, SIGNUP_STATUS.SIGNED);
});

test('B6 G05：报名后退组保留该报名；取消后重报失败', async () => {
  const repo = fixture();
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member']);
  const event = await publish(repo, 'r1', { audienceMode: 'groups', audienceGroupIds: [groupId] });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });

  // 报名后退组：报名仍保留（事实不追溯否定）
  await callGroup(repo, 'removeAssociationGroupMember', { groupId, userId: 'demo_muc_member' });
  const kept = await call(repo, 'getSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  assert.equal(kept.mySignup.status, SIGNUP_STATUS.SIGNED, '已报上的不因退组失效');

  // 取消后再想重报：资格已按当前组员关系复核 → 拒绝
  const canceled = await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(canceled.ok, true, canceled.message);
  const retry = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(retry.ok, false);
  assert.match(retry.message, /指定小组成员/);
});

/* ============================================================
 * 读放大：列表页不许查询报名集合，只点读当前页本人的记录（2026-10-21）
 * ============================================================
 * 列表要统计「每场报了几个人」，原来是把整个 eventSignups 翻页读一遍再内存聚合。
 * 云端每翻一页一次 RPC，赛事与报名一多，打开一次列表就是十几页，叠上每日读
 * 配额会撑不住。现在只读赛事主记录上的 signupCount（写端在报名 / 取消时维护）。
 *
 * 这条用例把「列表页不得读报名表」钉死：把 forScope 出来的 eventSignups.list
 * 换成会抛错的桩，列表仍然要跑通、人数仍然要对。
 * ============================================================ */
test('赛事列表不查询报名集合，仍显示汇总人数及本人报名状态', async () => {
  const repo = fixture();
  const created = await call(repo, 'publishSchoolEvent', valid({ requestId: 'list_no_signups' }));
  assert.equal(created.ok, true, created.message);
  const eventId = created.event.eventId;
  for (const actor of ['demo_muc_member', 'demo_muc_admin']) {
    const r = await call(repo, 'signUpSchoolEvent', { eventId }, { actor });
    assert.equal(r.ok, true, r.message);
  }

  // 禁止集合查询，并记录批读，确保不会换成逐场拉全体名单。
  // 2026-10-22 H-3：本人报名状态从「逐行点读」改成「按页一次 listByIds」，
  // 守卫意图不变——一次调用只带当前页的那些编号。
  const originalForScope = repo.forScope;
  const batched = [];
  let batchCalls = 0;
  repo.forScope = input => {
    const scoped = originalForScope(input);
    scoped.eventSignups = {
      ...scoped.eventSignups,
      list: () => { throw new Error('列表页不应读取 eventSignups 全表'); },
      listByEvent: () => { throw new Error('列表页不应查询单场报名名单'); },
      getById: () => { throw new Error('列表页不应逐行点读报名记录'); },
      listByIds: ids => {
        batchCalls += 1;
        batched.push(...ids);
        return originalForScope(input).eventSignups.listByIds(ids);
      },
    };
    return scoped;
  };

  let listed;
  try {
    listed = await call(repo, 'listSchoolEvents', { limit: 50 });
  } finally {
    repo.forScope = originalForScope;
  }

  assert.equal(listed.ok, true);
  const row = listed.events.find(item => item.eventId === eventId);
  assert.ok(row, '刚发布的赛事应当在列表里');
  assert.equal(row.signupCount, 2, '人数应来自赛事主记录的计数器');
  assert.equal(row.mySignup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(batchCalls, 1, '一页只发一次批读，不按行点读');
  assert.equal(batched.length, listed.events.length, '只取当前页本人的报名记录');
});

test('赛事列表只批读翻页后那几条本人报名，取消和未报名状态不丢失', async () => {
  const repo = fixture();
  const eventIds = [];
  for (let i = 0; i < 4; i += 1) {
    const event = await publish(repo, `mine_page_${i}`);
    eventIds.push(event.eventId);
    if (i < 3) await call(repo, 'signUpSchoolEvent', { eventId: event.eventId });
  }
  await call(repo, 'cancelSchoolEventSignup', { eventId: eventIds[1] });
  const originalForScope = repo.forScope;
  const reads = [];
  repo.forScope = input => {
    const scoped = originalForScope(input);
    scoped.eventSignups.getById = () => { throw new Error('列表不能逐行点读报名记录'); };
    scoped.eventSignups.list = scoped.eventSignups.listByEvent = () => {
      throw new Error('列表不能查询报名集合');
    };
    scoped.eventSignups.listByIds = ids => {
      reads.push(...ids);
      return originalForScope(input).eventSignups.listByIds(ids);
    };
    return scoped;
  };
  const page = await call(repo, 'listSchoolEvents', { offset: 1, limit: 2 });
  assert.equal(page.events.length, 2);
  assert.deepEqual(reads, page.events.map(row => schoolEventSignupKey(row.eventId, 'demo_muc_admin',
    { schoolId: 'muc', association: 'pkb' })));
  const all = await call(repo, 'listSchoolEvents', { limit: 50 });
  const byId = new Map(all.events.map(row => [row.eventId, row]));
  assert.equal(byId.get(eventIds[0]).mySignup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(byId.get(eventIds[1]).mySignup.status, SIGNUP_STATUS.CANCELED);
  assert.equal(byId.get(eventIds[1]).signupCount, 0);
  assert.equal(byId.get(eventIds[3]).mySignup, null);
});

/**
 * 赛事详情只查「我加入的小组」（2026-10-22 大用户量复查 H-3）
 * ============================================================
 * 「本次赛事仅限指定小组成员报名」这个判断，原来是把**整个协会的小组成员行**
 * 读回来再筛自己那几行。它在「组数 × 每组人数」上线性增长：6 个协会、每组几十
 * 人时是数百行（4 页 RPC），而真正用得上的只是自己加入的那一两条。
 */
test('赛事详情只查我加入的小组，不整表读成员关系', async () => {
  const repo = fixture();
  const created = await call(repo, 'publishSchoolEvent', valid({ requestId: 'detail_group_scope' }));
  assert.equal(created.ok, true, created.message);

  const originalForScope = repo.forScope;
  const asked = [];
  repo.forScope = input => {
    const scoped = originalForScope(input);
    scoped.associationGroupMembers = {
      ...scoped.associationGroupMembers,
      list: () => { throw new Error('详情页不应整表读小组成员'); },
      listByUser: userId => {
        asked.push(userId);
        return originalForScope(input).associationGroupMembers.listByUser(userId);
      },
    };
    return scoped;
  };
  try {
    const detail = await call(repo, 'getSchoolEvent', { eventId: created.event.eventId });
    assert.equal(detail.ok, true, detail.message);
  } finally {
    repo.forScope = originalForScope;
  }
  assert.deepEqual(asked, ['demo_muc_admin'], '只按当前登录人查他加入的组');
});

/**
 * 列表下推（2026-10-29 第十二轮审计）
 * ============================================================
 * `listSchoolEvents` 原先是「整表读 + 内存筛选排序切片」，每翻一页都要把本协会
 * 全部赛事读一遍。无关键词、无年份时现在全部下推。这里把整表读改成抛错：
 * 主路径仍要能翻页，而带关键词的那条回退路径**必须**读全表（本次不声称包含匹配
 * 能下推——云数据库没有可用于 contains 的索引）。
 */
test('列表下推：无关键词时不整表读赛事，仍能翻页与拿到总量', async () => {
  const repo = fixture();
  await publish(repo, 'r_push_1');
  await publish(repo, 'r_push_2');

  const forScope = repo.forScope.bind(repo);
  let listCalls = 0;
  repo.forScope = (scope) => {
    const surface = forScope(scope);
    surface.events.list = () => { listCalls += 1; throw new Error('无关键词时不应整表读赛事'); };
    return surface;
  };

  const first = await call(repo, 'listSchoolEvents', { limit: 1 });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.events.length, 1);
  assert.equal(listCalls, 0, '主路径不该整表读');
  assert.ok(first.total >= 2, 'total 是过滤后条数');
  assert.ok(first.totalAll >= first.total, 'totalAll 不小于过滤后的条数');
  assert.equal(first.hasMore, true, '还有下一页');
  assert.equal(first.nextOffset, 1);

  const second = await call(repo, 'listSchoolEvents', { limit: 1, offset: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.events.length, 1);
  assert.notEqual(second.events[0].eventId, first.events[0].eventId, '两页不重复');

  // 状态筛选同样下推
  const filtered = await call(repo, 'listSchoolEvents', { status: 0, limit: 5 });
  assert.equal(filtered.ok, true);
  assert.equal(listCalls, 0);
});

test('列表下推：关键词搜索仍回退内存（包含匹配没有可用索引）', async () => {
  const repo = fixture();
  await publish(repo, 'r_push_kw');

  const forScope = repo.forScope.bind(repo);
  repo.forScope = (scope) => {
    const surface = forScope(scope);
    surface.events.list = () => { throw new Error('关键词回退必须整表读'); };
    return surface;
  };

  await assert.rejects(call(repo, 'listSchoolEvents', { keyword: '春' }), /关键词回退必须整表读/);
});
