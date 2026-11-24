/**
 * 学校维度：个人赛事「开赛 / 抽签 / 代签 / 结束 + 签表推进」（迁移清单 M1-a2）
 *
 * 守的是：
 *   1. 生命周期各步的权限与前置条件与旧栈同口径（未抽签不能开赛、仅进行中可代签等）；
 *   2. 抽签生成的比赛绑定 `schoolId + association`，编号是确定性的签位键；
 *   3. 首轮全部确认 / 弃权后自动补排下一轮（advanceSchoolEvent），且「只补不覆盖」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-event-service');
const matchHandlers = require('../src/server/services/school-match-service');
const { schoolMemberKey } = require('../src/shared/utils/school');
const {
  MATCH_TYPE, MATCH_STATUS, MATCH_COMPETITION, EVENT_STATUS, SIGNUP_STATUS,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const startAt = new Date(NOW.getTime() + DAY).toISOString();

/** 民大 pkb：管理员 + 四名在册男会员（够排一张 4 人单败签表）。 */
function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  seed.users.find(item => item._id === 'demo_muc_admin').gender = 'M';
  seed.users.find(item => item._id === 'demo_muc_member').gender = 'M';
  ['_2', '_3', '_4'].forEach((suffix, index) => {
    const id = `demo_muc_member${suffix}`;
    seed.users.push({ _id: id, openId: `mock_openid${suffix}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: `TEST00${index + 3}`, status: 'active', simulated: true });
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

async function callMatch(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await matchHandlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '周末单打赛', description: '协会常规赛', matchType: MATCH_TYPE.SINGLES, level: 3,
  format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
  startTime: startAt, courtCount: 2, ...extra,
});

async function publish(repo, token, extra = {}) {
  const result = await call(repo, 'publishSchoolEvent', { requestId: token, ...valid(extra) });
  assert.equal(result.ok, true, result.message);
  return result.event;
}

async function signUp(repo, eventId, actor) {
  const result = await call(repo, 'signUpSchoolEvent', { eventId }, { actor });
  assert.equal(result.ok, true, result.message);
}

/** 报名 + 抽签（固定 seedValue 保证可复核）。 */
async function drawWith(repo, eventId, actors, seedValue = 42) {
  for (const actor of actors) await signUp(repo, eventId, actor);
  const drawn = await call(repo, 'drawSchoolEvent', { eventId, seedValue });
  assert.equal(drawn.ok, true, drawn.message);
  return drawn;
}

/** 直接给抽签生成的比赛补上比分与胜方（单元测试用，模拟已录好的成绩）。 */
async function scoreMatch(repo, matchId, winner = 'A') {
  const doc = await repo.matches.getById(matchId);
  const scoreA = winner === 'A' ? [11] : [9];
  const scoreB = winner === 'A' ? [9] : [11];
  await repo.matches.set(matchId, { ...doc, scoreA, scoreB, winner, recorder: 'demo_muc_admin' });
}

const eventMatches = async (repo, eventId) =>
  (await repo.matches.list()).filter(row => row.eventId === eventId);

test('重抽与确认并发：事务前刚结算的比赛及等级分必须完整保留', async () => {
  const repo = fixture();
  const event = await publish(repo, 'race-redraw');
  const draw = await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await scoreMatch(repo, draw.matchIds[0]);
  const transaction = repo.transaction;
  let settled;
  let ratings;
  repo.transaction = async work => {
    repo.transaction = transaction;
    const confirmation = await callMatch(repo, 'confirmSchoolMatch', { matchId: draw.matchIds[0] });
    assert.equal(confirmation.ok, true, confirmation.message);
    settled = await repo.matches.getById(draw.matchIds[0]);
    ratings = await repo.memberRatings.list();
    return transaction(work);
  };
  const result = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 71 });
  assert.equal(result.ok, false);
  assert.ok(settled.settlement);
  assert.deepEqual(await repo.matches.getById(draw.matchIds[0]), settled);
  assert.deepEqual(await repo.memberRatings.list(), ratings);
});

test('抽签计划期间报名版本变化：拒绝陈旧签表，不冻结新报名', async () => {
  const repo = fixture();
  const event = await publish(repo, 'race-signup');
  for (const actor of ['demo_muc_member', 'demo_muc_member_2']) await signUp(repo, event.eventId, actor);
  const transaction = repo.transaction;
  repo.transaction = async work => {
    repo.transaction = transaction;
    await signUp(repo, event.eventId, 'demo_muc_member_3');
    return transaction(work);
  };
  const result = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 42 });
  assert.equal(result.ok, false);
  assert.equal((await repo.events.getById(event.eventId)).draw, null);
  assert.equal((await eventMatches(repo, event.eventId)).length, 0);
});

test('开赛：未抽签不能开；抽签后可开；仅负责人可开赛', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  const beforeDraw = await call(repo, 'startSchoolEvent', { eventId: event.eventId });
  assert.equal(beforeDraw.ok, false);
  assert.match(beforeDraw.message, /抽签/);

  // 会员没有抽签权（两人报名后才有资格谈抽签）。
  await signUp(repo, event.eventId, 'demo_muc_member');
  await signUp(repo, event.eventId, 'demo_muc_member_2');
  const drawByMember = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 1 },
    { actor: 'demo_muc_member' });
  assert.equal(drawByMember.ok, false);

  const drawn = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 1 });
  assert.equal(drawn.ok, true, drawn.message);

  const startByMember = await call(repo, 'startSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(startByMember.ok, false, '普通会员不能开赛');

  const started = await call(repo, 'startSchoolEvent', { eventId: event.eventId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.event.status, EVENT_STATUS.ONGOING);
});

test('抽签：人数不足被拒；生成的比赛绑定范围且编号确定', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  const noOne = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 1 });
  assert.equal(noOne.ok, false);
  assert.match(noOne.message, /参赛人数不足/);

  const drawn = await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2'], 42);
  assert.equal(drawn.matchIds.length, 1, '两人单败只排一场首轮（即决赛）');

  const [match] = await eventMatches(repo, event.eventId);
  assert.equal(match._id, drawn.matchIds[0]);
  assert.equal(match.schoolId, 'muc');
  assert.equal(match.association, 'pkb');
  assert.equal(match.competition, MATCH_COMPETITION.PERSONAL);
  assert.equal(match.status, MATCH_STATUS.PENDING);
  assert.equal(match.eventId, event.eventId);
  assert.ok(String(match._id).startsWith('x_'), '签位键以 x_ 开头');
  assert.equal(match.teamA.length + match.teamB.length, 2);
});

test('重抽：覆盖同一批签位编号；已有比赛生效后被禁', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const first = await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2'], 42);

  const again = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 7 });
  assert.equal(again.ok, true, again.message);
  assert.deepEqual(again.matchIds, first.matchIds, '重抽落在同一批编号上，不堆两批');
  assert.equal((await eventMatches(repo, event.eventId)).length, 1);

  // 首轮确认生效：分数已发出去，不能再重抽。
  await scoreMatch(repo, first.matchIds[0], 'A');
  const confirmed = await callMatch(repo, 'confirmSchoolMatch', { matchId: first.matchIds[0] });
  assert.equal(confirmed.ok, true, confirmed.message);

  const blocked = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 9 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /生效/);
});

test('代签：进行中才可签；非管理端被拒；签到落到报名记录', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2'], 42);

  const beforeStart = await call(repo, 'checkInSchoolEvent',
    { eventId: event.eventId, userId: 'demo_muc_member' });
  assert.equal(beforeStart.ok, false);
  assert.match(beforeStart.message, /进行中/);

  await call(repo, 'startSchoolEvent', { eventId: event.eventId });

  const byMember = await call(repo, 'checkInSchoolEvent',
    { eventId: event.eventId, userId: 'demo_muc_member_2' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false, '普通会员不能代签');

  const checked = await call(repo, 'checkInSchoolEvent',
    { eventId: event.eventId, userId: 'demo_muc_member' });
  assert.equal(checked.ok, true, checked.message);
  assert.equal(checked.signup.status, SIGNUP_STATUS.CHECKED_IN);

  const again = await call(repo, 'checkInSchoolEvent',
    { eventId: event.eventId, userId: 'demo_muc_member' });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经签过到/);
});

test('结束：名次须落在报名者身上；合法名次把赛事置为已结束', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2'], 42);
  await call(repo, 'startSchoolEvent', { eventId: event.eventId });

  const stranger = await call(repo, 'finishSchoolEvent', {
    eventId: event.eventId, results: [{ userId: 'demo_muc_member_3', placement: 1 }],
  });
  assert.equal(stranger.ok, false);
  assert.match(stranger.message, /没有报名/);

  const finished = await call(repo, 'finishSchoolEvent', {
    eventId: event.eventId,
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'demo_muc_member_2', placement: 2 }],
  });
  assert.equal(finished.ok, true, finished.message);
  assert.equal(finished.event.status, EVENT_STATUS.FINISHED);
  assert.equal(finished.event.isFinished, true);
});

test('签表推进：两场首轮确认后补出决赛，只补不覆盖', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const drawn = await drawWith(repo, event.eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4'], 42);
  await call(repo, 'startSchoolEvent', { eventId: event.eventId });

  assert.equal(drawn.matchIds.length, 2, '4 人单败首轮两场');
  await scoreMatch(repo, drawn.matchIds[0], 'A');
  const firstConfirm = await callMatch(repo, 'confirmSchoolMatch', { matchId: drawn.matchIds[0] });
  assert.equal(firstConfirm.ok, true, firstConfirm.message);
  assert.equal((await eventMatches(repo, event.eventId)).length, 2, '另一场未完，先不补下一轮');

  await scoreMatch(repo, drawn.matchIds[1], 'B');
  const secondConfirm = await callMatch(repo, 'confirmSchoolMatch', { matchId: drawn.matchIds[1] });
  assert.equal(secondConfirm.ok, true, secondConfirm.message);

  const all = await eventMatches(repo, event.eventId);
  assert.equal(all.length, 3, '首轮打完后补出决赛');
  const final = all.find(row => row.round === 2);
  assert.ok(final, '决赛已排');
  assert.equal(final.status, MATCH_STATUS.PENDING);
  assert.equal(final.stage, 'main');
  assert.equal(final._id, `x_${event.eventId}_r2_main_0`);
});

test('签表推进：弃权生效也会补排下一轮', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const drawn = await drawWith(repo, event.eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4'], 42);
  await call(repo, 'startSchoolEvent', { eventId: event.eventId });

  // 第一场由一方弃权直接生效（无需比分）。
  const forfeit = await callMatch(repo, 'forfeitSchoolMatch',
    { matchId: drawn.matchIds[0], forfeitBy: 'demo_muc_member' });
  assert.equal(forfeit.ok, true, forfeit.message);
  assert.equal((await eventMatches(repo, event.eventId)).length, 2, '还有一场未完');

  // 第二场正常确认后才补决赛。
  await scoreMatch(repo, drawn.matchIds[1], 'A');
  await callMatch(repo, 'confirmSchoolMatch', { matchId: drawn.matchIds[1] });
  const all = await eventMatches(repo, event.eventId);
  assert.ok(all.some(row => row.round === 2), '弃权 + 确认共同推进出决赛');
});

test('跨学校：外校开赛 / 抽签写不进', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  const buaaStart = await call(repo, 'startSchoolEvent', { eventId: event.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_admin' });
  assert.equal(buaaStart.ok, false);
  assert.match(buaaStart.message, /不存在/);

  const buaaDraw = await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 1 },
    { schoolId: 'buaa', actor: 'demo_buaa_admin' });
  assert.equal(buaaDraw.ok, false);
});

test('详情与名单读端：抽签后带签表、开赛后名单可代签、结束后下发名次', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await drawWith(repo, event.eventId, ['demo_muc_member', 'demo_muc_member_2'], 42);

  // 抽签后（仍在报名阶段）：详情带签表（投影字段），可重抽、可开赛。
  const afterDraw = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  assert.equal(afterDraw.event.draw.drawCount, 1);
  assert.equal(afterDraw.event.draw.size, 2);
  assert.ok(Array.isArray(afterDraw.event.draw.slots));
  assert.equal(afterDraw.capabilities.canDraw, true, '报名阶段内仍可重抽');
  assert.equal(afterDraw.capabilities.canStart, true);
  assert.deepEqual(afterDraw.event.results, [], '未结束无名次');

  // 开赛后：报名名单逐行给出代签到能力；开赛 / 抽签入口关闭，录名次入口打开。
  await call(repo, 'startSchoolEvent', { eventId: event.eventId });
  const roster = await call(repo, 'listSchoolEventSignups', { eventId: event.eventId });
  assert.equal(roster.ok, true, roster.message);
  assert.equal(roster.signups.length, 2);
  assert.ok(roster.signups.every(row => row.canCheckIn === true), '进行中管理员可代签');

  const afterStart = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  assert.equal(afterStart.capabilities.canDraw, false, '已开赛不能再抽');
  assert.equal(afterStart.capabilities.canStart, false, '已开赛不能再开');
  assert.equal(afterStart.capabilities.canFinish, true);

  // 结束：详情下发名次，只投影 { userId, placement } 两个字段。
  await call(repo, 'finishSchoolEvent', {
    eventId: event.eventId,
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'demo_muc_member_2', placement: 2 }],
  });
  const finished = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  finished.event.results.forEach(row =>
    assert.deepEqual(Object.keys(row).sort(), ['placement', 'userId'], '名次不透传库记录'));
  const placements = Object.fromEntries(finished.event.results.map(row => [row.userId, row.placement]));
  assert.deepEqual(placements, { demo_muc_member: 1, demo_muc_member_2: 2 });
  assert.equal(finished.capabilities.canFinish, false, '已结束不能再录名次');
});

test('advanceSchoolEvent 被误当客户端 action 调用时不写入', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const ctx = await buildSchoolContext({
    repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW,
  });
  // 正常 handler 调用签名是 (payload, ctx)，这里的 eventId 位拿到的是 ctx 对象 → 首行收手。
  const result = await handlers.advanceSchoolEvent({ eventId: event.eventId }, ctx);
  assert.deepEqual(result, { ok: true, inserted: 0 });
  assert.equal((await eventMatches(repo, event.eventId)).length, 0);
});
