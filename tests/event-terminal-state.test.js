/**
 * 终态不可变：赛事一旦结束（名次已公布），它的比赛台账就不许再改
 * ============================================================
 * 2026-10-16 只读审计发现的一整类缺口：子实体（比分 / 比赛 / 大场）的写动作
 * 只看自身状态，不看父赛事是否已进终态。于是「名次已公布」之后还能
 *   · 跨校：撤销比分、重录比分，把公布的冠军和台账里的冠军弄成两回事；
 *   · 校内个人赛：确认一场没打完的比赛 —— 收尾的 `advanceSchoolEvent` 会在
 *     **已结束**的赛事上再补排一轮（凭空多出一场决赛），或把生效的比赛作废、
 *     改变等级分回放，而对外公布的 results 纹丝不动；
 *   · 学院赛：记弃权、改排阵、开大场、改派裁判。
 *
 * 这三条链路的闸门都补在同一次提交里，本文件把「终态只读」当成一条不变式钉住：
 * 名次是唯一对外口径，赛事结束即只读；要更正得走赛事修订，不是偷偷改台账。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { schoolMemberKey } = require('../src/shared/utils/school');
const {
  MATCH_TYPE, MATCH_STATUS, EVENT_STATUS, COLLEGES, COLLEGE_EVENT_STATUS, TIE_STATUS, LEG_DISCIPLINE,
  TIE_ALGO, TIE_NET_MODE,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

/* ────────────────────────── 跨校邀请赛 ────────────────────────── */

const exchange = require('../src/server/services/exchange-service');
const exchangeForm = {
  title: '民大北航交流赛', location: '模拟球场', startTime: '2026-11-01T10:00:00Z',
  participantSchoolIds: ['muc', 'buaa'], quota: 4, schoolQuotas: { muc: 2, buaa: 2 },
  requestId: 'terminal-1', format: 'single_elim',
};

async function exchangeCall(repo, action, payload = {}, actor = 'demo_muc_admin', schoolId = 'muc') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association: 'pkb' }, now: NOW });
  return (await exchange[action](payload, ctx)).data;
}

/** 四人报名 + 锁定名单，返回赛事编号。 */
async function exchangeReadyFour(repo) {
  const created = await exchangeCall(repo, 'createExchangeEvent', exchangeForm);
  assert.equal(created.ok, true, created.message);
  const eventId = created.event._id;
  assert.equal((await exchangeCall(repo, 'respondExchangeInvitation',
    { eventId, decision: 'accepted' }, 'demo_buaa_admin', 'buaa')).ok, true);
  for (const [actor, schoolId] of [['demo_muc_member', 'muc'], ['demo_muc_admin', 'muc'],
    ['demo_buaa_member', 'buaa'], ['demo_buaa_admin', 'buaa']]) {
    const signed = await exchangeCall(repo, 'signUpExchangeEvent', { eventId }, actor, schoolId);
    assert.equal(signed.ok, true, signed.message);
  }
  assert.equal((await exchangeCall(repo, 'lockExchangeRoster', { eventId })).ok, true);
  return eventId;
}

const pendingExchangeMatches = async (repo, eventId) =>
  (await repo.exchangeMatches.listByEvent(eventId)).filter(row => row.status === 'pending');

test('跨校邀请赛：名次确认之后，比分不可撤、不可重录', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const eventId = await exchangeReadyFour(repo);
  assert.equal((await exchangeCall(repo, 'drawExchangeEvent', { eventId, seedValue: 42 })).ok, true);

  // 四人不败淘汰：两场半决赛 → 打完补出决赛 → 决赛也打完，才能确认名次。
  const semis = await pendingExchangeMatches(repo, eventId);
  assert.equal(semis.length, 2, '四人单败首轮两场');
  for (const match of semis) {
    const scored = await exchangeCall(repo, 'submitExchangeScore',
      { eventId, matchId: match._id, scoreA: 11, scoreB: 9 });
    assert.equal(scored.ok, true, scored.message);
  }
  const final = await pendingExchangeMatches(repo, eventId);
  assert.equal(final.length, 1, '半决赛打完补出决赛');
  assert.equal((await exchangeCall(repo, 'submitExchangeScore',
    { eventId, matchId: final[0]._id, scoreA: 11, scoreB: 9 })).ok, true);

  const confirmed = await exchangeCall(repo, 'confirmExchangeRanking', { eventId });
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(confirmed.event.status, 'finished');
  const frozen = (await repo.exchangeEvents.getById(eventId)).results;
  assert.equal(frozen.length, 4, '名次已冻结在赛事上');

  // 终态：重录必须被拒；撤销动作已整体删除，不再存在「事后反悔」的入口。
  const rescore = await exchangeCall(repo, 'submitExchangeScore',
    { eventId, matchId: semis[0]._id, scoreA: 4, scoreB: 11 });
  assert.equal(rescore.ok, false, '已结束的赛事不能重录比分');
  assert.match(rescore.message, /已结束/);
  const handlers = require('../src/server/services/exchange-service.js');
  assert.equal(typeof handlers.revokeExchangeScore, 'undefined', '交流赛撤销比分已删除');

  // 台账与名次都没被动过：撤销会被「已结束」挡住，而不是悄悄改掉比分。
  assert.deepEqual((await repo.exchangeEvents.getById(eventId)).results, frozen, '名次未被改写');
  assert.equal((await repo.exchangeMatches.getById(semis[0]._id)).status, 'active', '比分仍在');
  assert.equal((await repo.exchangeMatches.getById(semis[0]._id)).scoreA, 11, '比分未被清空');
});

/* ────────────────────────── 校内个人赛事 ────────────────────────── */

const eventHandlers = require('../src/server/services/school-event-service');
const matchHandlers = require('../src/server/services/school-match-service');

/** 民大 pkb：管理员 + 四名在册男会员（够排一张 4 人单败签表）。 */
function eventFixture() {
  const seed = createSchoolDemoSeed();
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

async function eventCall(repo, action, payload = {}, actor = 'demo_muc_admin') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  return (await eventHandlers[action](payload, ctx)).data;
}

async function matchCall(repo, action, payload = {}) {
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  return (await matchHandlers[action](payload, ctx)).data;
}

const eventMatches = async (repo, eventId) =>
  (await repo.matches.list()).filter(row => row.eventId === eventId);

test('校内个人赛：赛事结束之后，比赛不可确认 / 撤销 / 弃权，也不再补排下一轮', async () => {
  const repo = eventFixture();
  const published = await eventCall(repo, 'publishSchoolEvent', {
    requestId: 'terminal-r1', title: '周末单打赛', description: '协会常规赛',
    matchType: MATCH_TYPE.SINGLES, level: 3, format: 'single_elim', bronzeMode: 'tied',
    seedMode: 'elo', seedCount: 4, startTime: at(DAY), courtCount: 2,
  });
  assert.equal(published.ok, true, published.message);
  const eventId = published.event.eventId;

  const members = ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4'];
  for (const actor of members) {
    assert.equal((await eventCall(repo, 'signUpSchoolEvent', { eventId }, actor)).ok, true);
  }
  const drawn = await eventCall(repo, 'drawSchoolEvent', { eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.matchIds.length, 2);
  assert.equal((await eventCall(repo, 'startSchoolEvent', { eventId })).ok, true);

  // 第一场录好比分（待对手确认），然后**没打完就手工录名次**把赛事结束掉——
  // 这正是审计里那条路径：结束之后再确认，会在已结束的赛事上补出一场决赛。
  const first = await repo.matches.getById(drawn.matchIds[0]);
  await repo.matches.set(first._id, { ...first, scoreA: [11], scoreB: [9], winner: 'A', recorder: 'demo_muc_admin' });

  const finished = await eventCall(repo, 'finishSchoolEvent', {
    eventId,
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'demo_muc_member_2', placement: 2 }],
  });
  assert.equal(finished.ok, true, finished.message);
  assert.equal(finished.event.status, EVENT_STATUS.FINISHED);
  assert.equal((await eventMatches(repo, eventId)).length, 2, '结束时只有首轮两场');

  const confirm = await matchCall(repo, 'confirmSchoolMatch', { matchId: drawn.matchIds[0] });
  assert.equal(confirm.ok, false, '已结束的赛事不能确认比赛');
  assert.match(confirm.message, /已结束/);

  // 撤销已随逐场结算改造删除（服务实现不再导出），只剩驳回 / 弃权仍被终态闸拦住
  assert.equal(typeof matchHandlers.revokeSchoolMatch, 'undefined', '撤销实现已删除');
  const reject = await matchCall(repo, 'rejectSchoolMatch', { matchId: drawn.matchIds[0], reason: '录错了' });
  assert.equal(reject.ok, false, '已结束的赛事不能驳回比赛');
  assert.match(reject.message, /已结束/);

  const second = await repo.matches.getById(drawn.matchIds[1]);
  const forfeitBy = (second.teamA || [])[0];
  assert.ok(forfeitBy, '第二场得有场上的人才能记弃权');
  const forfeit = await matchCall(repo, 'forfeitSchoolMatch', { matchId: drawn.matchIds[1], forfeitBy });
  assert.equal(forfeit.ok, false, '已结束的赛事不能记弃权');
  assert.match(forfeit.message, /已结束/);

  // 关键回归：三次尝试之后，台账必须与结束时一模一样——没有凭空多出的决赛，
  // 也没有任何一场被确认生效（原先 confirm 会补出第三场）。
  const after = await eventMatches(repo, eventId);
  assert.equal(after.length, 2, '结束后不再补排下一轮');
  assert.equal(after.every(row => row.status !== MATCH_STATUS.ACTIVE), true, '没有比赛被确认生效');
  assert.equal((await repo.matches.getById(drawn.matchIds[0])).status, MATCH_STATUS.PENDING, '待确认的仍待确认');
});

/* ────────────────────────── 学院赛 ────────────────────────── */

const collegeHandlers = require('../src/server/services/school-college-service');
const C01 = 'c01';
const C02 = 'c02';
const NAME_C01 = COLLEGES[0];
const NAME_C02 = COLLEGES[1];

/** 民大 pkb：管理员 + c01 / c02 各有人可用（与 school-college.test.js 同形）。 */
function collegeFixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, collegeId) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member_2', C01);
  add('demo_muc_member_3', C02);
  return createSchoolMemoryRepo(seed);
}

async function collegeCall(repo, action, payload = {}) {
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  return (await collegeHandlers[action](payload, ctx)).data;
}

const collegeValid = extra => ({
  title: '院际杯羽毛球赛', description: '学院团体赛',
  legPlan: [LEG_DISCIPLINE.MS], allowMultiEntry: true, rosterMin: 1, rosterMax: 5,
  tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF,
  startTime: at(DAY), location: '综合体育馆', courtCount: 2, ...extra,
});

async function approveCollege(repo, eventId, collegeId, memberIds) {
  const submitted = await collegeCall(repo, 'submitCollegeEntry', { eventId, collegeId, memberIds });
  assert.equal(submitted.ok, true, submitted.message);
  const approved = await collegeCall(repo, 'reviewCollegeEntry', { eventId, collegeId, action: 'approve' });
  assert.equal(approved.ok, true, approved.message);
}

test('学院赛：名次录入之后，大场与小场的写动作全部被拒', async () => {
  const repo = collegeFixture();
  const published = await collegeCall(repo, 'publishCollegeEvent', { requestId: 'terminal-college', ...collegeValid() });
  assert.equal(published.ok, true, published.message);
  const eventId = published.event.eventId;

  await approveCollege(repo, eventId, C01, ['demo_muc_member_2']);
  await approveCollege(repo, eventId, C02, ['demo_muc_member_3']);
  assert.equal((await collegeCall(repo, 'drawCollegeEvent', { eventId, seedValue: 42 })).ok, true);
  const started = await collegeCall(repo, 'startCollegeEvent', { eventId });
  assert.equal(started.ok, true, started.message);
  const tieId = started.ties[0].tieId;

  // 双方排阵 → 开大场（大场转进行中），保留「赛事已结束但大场仍在进行」这个状态。
  assert.equal((await collegeCall(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] })).ok, true);
  assert.equal((await collegeCall(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] })).ok, true);
  const began = await collegeCall(repo, 'startCollegeTie', { tieId });
  assert.equal(began.ok, true, began.message);

  const finished = await collegeCall(repo, 'finishCollegeEvent', {
    eventId, results: [{ college: NAME_C01, placement: 1 }, { college: NAME_C02, placement: 2 }],
  });
  assert.equal(finished.ok, true, finished.message);
  assert.equal((await repo.collegeEvents.getById(eventId)).status, COLLEGE_EVENT_STATUS.FINISHED);

  const before = await repo.ties.getById(tieId);
  const legMatchId = before.legs[0].matchId;
  const legBefore = await repo.matches.getById(legMatchId);

  const forfeit = await collegeCall(repo, 'forfeitCollegeTieLeg', { tieId, legNo: 1, collegeId: C01 });
  assert.equal(forfeit.ok, false, '已结束的学院赛不能记弃权');
  assert.match(forfeit.message, /已结束/);

  const lineup = await collegeCall(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  assert.equal(lineup.ok, false, '已结束的学院赛不能改排阵');
  assert.match(lineup.message, /已结束/);

  const restart = await collegeCall(repo, 'startCollegeTie', { tieId });
  assert.equal(restart.ok, false, '已结束的学院赛不能开大场');
  assert.match(restart.message, /已结束/);

  const referee = await collegeCall(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'demo_muc_member_2' });
  assert.equal(referee.ok, false, '已结束的学院赛不能改派裁判');
  assert.match(referee.message, /已结束/);

  // 大场与小场都一字未改：状态、胜负、比分、版本号全都没动过。
  assert.deepEqual(await repo.ties.getById(tieId), before, '大场记录未被改写');
  assert.deepEqual(await repo.matches.getById(legMatchId), legBefore, '小场记录未被改写');
  assert.ok(!before.legs[0].winner, '小项本来就还没结果');
  assert.equal(legBefore.status, MATCH_STATUS.PENDING, '小场本就是待录分');
});
