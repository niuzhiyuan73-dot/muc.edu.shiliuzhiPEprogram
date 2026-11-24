/**
 * B8a：预赛 → 决赛的推进，以及拔河等胜负项目的自动名次
 * ============================================================
 * 端到端覆盖两条链路：
 *   1. 抽签分预赛 → 各组录分 → 各组发布 → 晋级 → 决赛录分 → 决赛发布计分；
 *   2. 生成签表 → 逐场判定胜负 → 发布出 1/2/3/3 名次与 18/14/12/12 学院分。
 * 重点盯三件容易做错的事：
 *   · 预赛发布**不计分**（否则一个项目计两次分）；
 *   · 没打完的签表不能发布（半程名次没有意义）；
 *   · 改判一场会顺着签表把下游「已被淘汰的人」清掉。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const reg = require('../src/server/services/meet-registration-service.js');
const schedule = require('../src/server/services/meet-schedule-service.js');
const score = require('../src/server/services/meet-score-service.js');
const advance = require('../src/server/services/meet-advance-service.js');
const { meetEventKey, meetSessionKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const VENUE = { venue: '田径场直道' };

const COLLEGES = ['c01', 'c02', 'c03', 'c04'];
const LEAD = { c01: 'u_l1', c02: 'u_l2', c03: 'u_l3', c04: 'u_l4' };
const STUDENTS = {
  c01: ['u_a1', 'u_a2'], c02: ['u_b1', 'u_b2'], c03: ['u_c1', 'u_c2'], c04: ['u_d1', 'u_d2'],
};

const people = [
  ['u_admin', '校管理员'], ['u_l1', '部长一'], ['u_l2', '部长二'], ['u_l3', '部长三'], ['u_l4', '部长四'],
  ['u_a1', '甲一'], ['u_a2', '甲二'], ['u_b1', '乙一'], ['u_b2', '乙二'],
  ['u_c1', '丙一'], ['u_c2', '丙二'], ['u_d1', '丁一'], ['u_d2', '丁二'],
  ['u_j1', '裁判一'], ['u_j2', '裁判二'], ['u_j3', '裁判三'],
];
const users = people.map(([id, name]) => ({
  _id: id, openId: `o_${id}`, name, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const colleges = COLLEGES.map((id, index) => ({
  _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id, name: `${index + 1} 院`, status: 'active',
}));
const memberRows = [];
for (const id of COLLEGES) {
  memberRows.push([LEAD[id], id]);
  for (const student of STUDENTS[id]) memberRows.push([student, id]);
}
for (const judge of ['u_j1', 'u_j2', 'u_j3', 'u_admin']) memberRows.push([judge, 'c01']);
const members = memberRows.map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId, status: 'active', gender: 'male',
}));
const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/**
 * 建一届运动会，配两个项目：
 *   · 100 米：预赛 + 决赛，每组前 1 晋级；
 *   · 拔河：单败淘汰，两队一组。
 */
async function makeWorld({ tugColleges = COLLEGES, sprintColleges = ['c01', 'c02', 'c03'] } = {}) {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);

  await meetService.configureMeetEvent({
    templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1,
    rounds: 'heat_final', advance: { mode: 'per_heat', count: 1 },
  }, admin);
  await meetService.configureMeetEvent({
    templateId: 'tug-of-war', group: 'mixed', members: 2, perCollegeLimit: 1, format: 'single_elim',
  }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  for (const collegeId of COLLEGES) {
    const granted = await leadService.grantMeetCollegeLead({ collegeId, userId: LEAD[collegeId] }, admin);
    assert.equal(granted.ok, true, granted.message);
  }

  const enroll = async (eventKey, userIds, leadId) => {
    for (const userId of userIds) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(interest.ok, true, `${userId} 交意向失败：${interest.message}`);
    }
    const submitted = await reg.submitMeetCollegeEntry(
      { eventKey, userIds }, await ctxOf(repo, leadId, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    const approved = await reg.reviewMeetEntry(
      { entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    assert.equal(approved.ok, true, approved.message);
    return submitted.data.entry._id;
  };

  const sprint = meetEventKey(meetId, 'sprint-100m', 'male');
  const tug = meetEventKey(meetId, 'tug-of-war', 'mixed');

  const sprintEntries = {};
  for (const collegeId of sprintColleges) {
    sprintEntries[collegeId] = await enroll(sprint, [STUDENTS[collegeId][0]], LEAD[collegeId]);
  }
  const tugEntries = {};
  for (const collegeId of tugColleges) {
    tugEntries[collegeId] = await enroll(tug, STUDENTS[collegeId], LEAD[collegeId]);
  }

  return { repo, meetId, admin, sprint, tug, sprintEntries, tugEntries };
}

/** 给场次排时间并派 3 名裁判 */
async function prepareSession(world, sessionKey, startAt) {
  const session = await world.repo.sportsMeetSessions.getById(sessionKey);
  // 结束时间必须晚于开始时间，统一给半小时
  const endAt = new Date(Date.parse(`${startAt}:00Z`) + 30 * 60000).toISOString().slice(0, 16);
  const saved = await schedule.saveMeetSession({
    eventKey: session.eventKey, round: session.round, index: session.index,
    startAt, endAt, ...VENUE,
  }, world.admin);
  assert.equal(saved.ok, true, saved.message);
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    const assigned = await schedule.assignMeetJudge({ sessionKey, judgeId }, world.admin);
    assert.equal(assigned.ok, true, assigned.message);
  }
}

/** 管理员代录三名裁判的成绩并提交 */
async function scoreAll(world, sessionKey, entryKey, rawText) {
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    const saved = await score.saveMeetJudgeScore(
      { sessionKey, entryKey, judgeId, rawText }, world.admin);
    assert.equal(saved.ok, true, saved.message);
    const submitted = await score.submitMeetJudgeScore(
      { sessionKey, entryKey, judgeId }, world.admin);
    assert.equal(submitted.ok, true, submitted.message);
  }
}

test('预赛：抽签分组、各组独立录分发布、按名次晋级', async () => {
  const world = await makeWorld();
  const { meetId, admin, sprint, sprintEntries } = world;

  const drawn = await advance.drawMeetHeats({ eventKey: sprint, heatCount: 2 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heats.length, 2);
  const sizes = drawn.data.heats.map((heat) => heat.entryKeys.length).sort();
  assert.deepEqual(sizes, [1, 2], '三个人分两组，人数差不超过 1');

  const heat1 = meetSessionKey(meetId, sprint, 'heat', 1);
  const heat2 = meetSessionKey(meetId, sprint, 'heat', 2);
  const finalKey = meetSessionKey(meetId, sprint, 'final', 1);
  await prepareSession(world, heat1, '2026-10-24T09:00');
  await prepareSession(world, heat2, '2026-10-24T09:15');

  // 该组只列本组的人：预赛第 1 组的录分页不该出现另一组的学生
  const view = await score.getMeetSessionScores({ sessionKey: heat1 }, admin);
  assert.equal(view.ok, true, view.message);
  assert.equal(view.data.items.length, drawn.data.heats[0].entryKeys.length);

  const heatOf = new Map();
  drawn.data.heats.forEach((heat) => heat.entryKeys.forEach((key) => heatOf.set(key, heat.index)));
  // 让第 1 组（2 人）跑出 12.10 / 12.30
  const group1 = drawn.data.heats[0].entryKeys;
  await scoreAll(world, heat1, group1[0], '12.10');
  await scoreAll(world, heat1, group1[1], '12.30');
  await scoreAll(world, heat2, drawn.data.heats[1].entryKeys[0], '11.90');

  // 只发布了一组就晋级 → 必须拒绝
  const tooEarly = await advance.advanceMeetEvent({ eventKey: sprint }, admin);
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /预赛第 2 组/);

  const pub1 = await score.publishMeetResults({ eventKey: sprint, sessionKey: heat1 }, admin);
  assert.equal(pub1.ok, true, pub1.message);
  assert.equal(pub1.data.publication.official, false, '预赛不是正式成绩');
  assert.equal(pub1.data.publication.rows.every((row) => row.points === 0), true, '预赛不计学院分');

  const pub2 = await score.publishMeetResults({ eventKey: sprint, sessionKey: heat2 }, admin);
  assert.equal(pub2.ok, true, pub2.message);

  const advanced = await advance.advanceMeetEvent({ eventKey: sprint }, admin);
  assert.equal(advanced.ok, true, advanced.message);
  assert.equal(advanced.data.entryKeys.length, 2, '每组第 1 名晋级');

  const finalDoc = await world.repo.sportsMeetSessions.getById(finalKey);
  assert.deepEqual(finalDoc.entryKeys, advanced.data.entryKeys);

  // 决赛只在这两人之间比
  await prepareSession(world, finalKey, '2026-10-24T10:00');
  const finalView = await score.getMeetSessionScores({ sessionKey: finalKey }, admin);
  assert.equal(finalView.data.items.length, 2);

  const [first, second] = advanced.data.entryKeys;
  await scoreAll(world, finalKey, first, '11.80');
  await scoreAll(world, finalKey, second, '11.85');
  const published = await score.publishMeetResults({ eventKey: sprint, sessionKey: finalKey }, admin);
  assert.equal(published.ok, true, published.message);
  assert.equal(published.data.publication.official, true);
  const rows = published.data.publication.rows;
  assert.equal(rows.find((row) => row.entryKey === first).points, 9);
  assert.equal(rows.find((row) => row.entryKey === second).points, 7);
  // 场次与晋级无关的映射，只用来确保抽签没把同一个人放进两组
  assert.equal(heatOf.size, 3);
  assert.equal(Object.keys(sprintEntries).length, 3);
});

test('预赛成绩可以更正并重新发布，晋级随之更新', async () => {
  const world = await makeWorld();
  const { meetId, admin, sprint } = world;
  const drawn = await advance.drawMeetHeats({ eventKey: sprint, heatCount: 2, seed: 7 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  const heat1 = meetSessionKey(meetId, sprint, 'heat', 1);
  const heat2 = meetSessionKey(meetId, sprint, 'heat', 2);
  await prepareSession(world, heat1, '2026-10-24T09:00');
  await prepareSession(world, heat2, '2026-10-24T09:15');

  const keys = drawn.data.heats[0].entryKeys;
  assert.equal(keys.length, 2);
  await scoreAll(world, heat1, keys[0], '12.10');
  await scoreAll(world, heat1, keys[1], '12.20');
  await scoreAll(world, heat2, drawn.data.heats[1].entryKeys[0], '11.90');
  await score.publishMeetResults({ eventKey: sprint, sessionKey: heat1 }, admin);
  await score.publishMeetResults({ eventKey: sprint, sessionKey: heat2 }, admin);

  const first = await advance.advanceMeetEvent({ eventKey: sprint }, admin);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.data.entryKeys.includes(keys[0]), true, '第 1 组头名晋级');
  assert.equal(first.data.entryKeys.length, 2);

  // 更正：第 1 组第二人跑出最快
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await score.saveMeetJudgeScore(
      { sessionKey: heat1, entryKey: keys[1], judgeId, rawText: '11.99', allowResubmit: true }, admin);
    await score.submitMeetJudgeScore({ sessionKey: heat1, entryKey: keys[1], judgeId }, admin);
  }
  const republished = await score.publishMeetResults(
    { eventKey: sprint, sessionKey: heat1, reason: '计时更正' }, admin);
  assert.equal(republished.ok, true, republished.message);
  const top = republished.data.publication.rows.find((row) => row.rank === 1);
  assert.equal(top.entryKey, keys[1]);

  const second = await advance.advanceMeetEvent({ eventKey: sprint }, admin);
  assert.equal(second.ok, true, second.message);
  assert.equal(second.data.entryKeys.includes(keys[1]), true, '晋级名单应跟着更正后的名次走');
  assert.equal(second.data.entryKeys.includes(keys[0]), false, '被反超的人出局');
});

test('拔河单败淘汰：打完签表自动出名次与学院分', async () => {
  const world = await makeWorld();
  const { meetId, admin, tug, tugEntries } = world;

  const drawn = await advance.drawMeetBracket({ eventKey: tug, seed: 11 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.totalRounds, 2, '4 支队是半决赛＋决赛');
  assert.equal(drawn.data.matches.length, 3);

  const key = (round, index) => meetSessionKey(meetId, tug, `r${round}`, index);
  for (const [sessionKey, startAt] of [
    [key(1, 1), '2026-10-24T14:00'], [key(1, 2), '2026-10-24T14:30'],
  ]) {
    await prepareSession(world, sessionKey, startAt);
  }

  // 半决赛：c01 胜 c02，c03 胜 c04
  const semi1 = drawn.data.matches.find((row) => row.roundNo === 1 && row.index === 1);
  const semi2 = drawn.data.matches.find((row) => row.roundNo === 1 && row.index === 2);
  const win1 = semi1.entryKeys[0];
  const win2 = semi2.entryKeys[0];
  assert.equal((await advance.setMeetMatchWinner(
    { sessionKey: key(1, 1), winnerEntryKey: win1 }, admin)).ok, true);
  assert.equal((await advance.setMeetMatchWinner(
    { sessionKey: key(1, 2), winnerEntryKey: win2 }, admin)).ok, true);

  // 裁判打开一场对阵：看到的是对阵双方，不是录分框
  const judgeView = await score.getMeetSessionScores(
    { sessionKey: key(1, 1) }, await ctxOf(world.repo, 'u_j1', world.meetId));
  assert.equal(judgeView.ok, true, judgeView.message);
  assert.equal(judgeView.data.versus, true);
  assert.equal(judgeView.data.canEnter, false);

  // 决赛还没打 → 不能发布
  const early = await score.publishMeetResults({ eventKey: tug }, admin);
  assert.equal(early.ok, false);
  assert.match(early.message, /没有决出胜负/);

  await prepareSession(world, key(2, 1), '2026-10-24T15:00');
  assert.equal((await advance.setMeetMatchWinner(
    { sessionKey: key(2, 1), winnerEntryKey: win1 }, admin)).ok, true);

  const published = await score.publishMeetResults({ eventKey: tug }, admin);
  assert.equal(published.ok, true, published.message);
  const rows = published.data.publication.rows;
  const pointsOf = (entryKey) => (rows.find((row) => row.entryKey === entryKey) || {}).points;
  const rankOf = (entryKey) => (rows.find((row) => row.entryKey === entryKey) || {}).rank;

  assert.equal(rankOf(win1), 1);
  assert.equal(rankOf(win2), 2);
  // 团体项目 ×2：18 / 14 / 12 / 12
  assert.equal(pointsOf(win1), 18);
  assert.equal(pointsOf(win2), 14);
  const losers = Object.values(tugEntries).filter((id) => id !== win1 && id !== win2);
  assert.equal(losers.length, 2);
  for (const id of losers) {
    assert.equal(rankOf(id), 3, '半决赛负者并列第 3');
    assert.equal(pointsOf(id), 12);
  }
});

test('改判一场：下游「已被淘汰的人」必须被清掉，不能带着他继续打', async () => {
  const world = await makeWorld();
  const { meetId, admin, tug } = world;
  const drawn = await advance.drawMeetBracket({ eventKey: tug, seed: 13 }, admin);
  const key = (round, index) => meetSessionKey(meetId, tug, `r${round}`, index);

  const semi1 = drawn.data.matches.find((row) => row.roundNo === 1 && row.index === 1);
  const [a, b] = semi1.entryKeys;
  await advance.setMeetMatchWinner({ sessionKey: key(1, 1), winnerEntryKey: a }, admin);
  const second = drawn.data.matches.find((row) => row.roundNo === 1 && row.index === 2);
  await advance.setMeetMatchWinner({ sessionKey: key(1, 2), winnerEntryKey: second.entryKeys[0] }, admin);
  await advance.setMeetMatchWinner({ sessionKey: key(2, 1), winnerEntryKey: a }, admin);

  // 改判：半决赛 b 获胜
  const changed = await advance.setMeetMatchWinner({ sessionKey: key(1, 1), winnerEntryKey: b }, admin);
  assert.equal(changed.ok, true, changed.message);

  const finalDoc = await world.repo.sportsMeetSessions.getById(key(2, 1));
  assert.equal(finalDoc.entryKeys.includes(a), false, '被改判出局的人不能还在决赛里');
  assert.equal(finalDoc.entryKeys.includes(b), true);
  assert.equal(finalDoc.winnerEntryKey, '', '决赛原判定必须作废，等重新判');

  const bracket = await advance.getMeetBracket({ eventKey: tug }, admin);
  assert.equal(bracket.data.complete, false);
});

test('轮空：3 支队时首轮直接晋级，签表仍能出完整名次', async () => {
  const world = await makeWorld({ tugColleges: ['c01', 'c02', 'c03'] });
  const { meetId, admin, tug } = world;
  const drawn = await advance.drawMeetBracket({ eventKey: tug, seed: 17 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.size, 4, '3 支队补到 4 个签位');

  const round1 = drawn.data.matches.filter((row) => row.roundNo === 1);
  const byes = round1.filter((row) => row.entryKeys.filter(Boolean).length === 1);
  assert.equal(byes.length, 1, '正好一个轮空');
  assert.equal(byes[0].winnerEntryKey, byes[0].entryKeys.find(Boolean), '轮空直接判胜');

  const key = (round, index) => meetSessionKey(meetId, tug, `r${round}`, index);
  const played = round1.find((row) => row.entryKeys.filter(Boolean).length === 2);
  const winner = played.entryKeys[0];
  await advance.setMeetMatchWinner({ sessionKey: key(1, played.index), winnerEntryKey: winner }, admin);
  const finalDoc = await world.repo.sportsMeetSessions.getById(key(2, 1));
  assert.equal(finalDoc.entryKeys.filter(Boolean).length, 2, '决赛双方应就位');

  await advance.setMeetMatchWinner({ sessionKey: key(2, 1), winnerEntryKey: winner }, admin);
  const published = await score.publishMeetResults({ eventKey: tug }, admin);
  assert.equal(published.ok, true, published.message);
  const ranks = published.data.publication.rows.map((row) => row.rank).sort();
  assert.deepEqual(ranks, [1, 2, 3], '三队的名次是 1、2、3');
});

test('循环赛：全部对阵打完才有名次，胜负自动换算学院分', async () => {
  const world = await makeWorld({ tugColleges: ['c01', 'c02', 'c03'] });
  const { admin, tug } = world;
  // 改成循环赛再编排
  const events = await world.repo.sportsMeetEvents.list();
  const doc = events.find((row) => row._id === tug);
  await world.repo.sportsMeetEvents.set(tug, { ...doc, format: 'round_robin' });

  const drawn = await advance.drawMeetBracket({ eventKey: tug, seed: 19 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.format, 'round_robin');
  assert.equal(drawn.data.matches.length, 3, '3 队循环赛共 3 场');

  const pending = await score.publishMeetResults({ eventKey: tug }, admin);
  assert.equal(pending.ok, false);
  assert.match(pending.message, /没有决出胜负/);

  const sessions = await world.repo.sportsMeetSessions.list();
  const matches = sessions.filter((row) => row.eventKey === tug);
  // 三场各由前一方取胜：形成 a>b>c 的链条
  for (const match of matches) {
    const played = await advance.setMeetMatchWinner(
      { sessionKey: match._id, winnerEntryKey: match.entryKeys[0] }, admin);
    assert.equal(played.ok, true, played.message);
  }

  const published = await score.publishMeetResults({ eventKey: tug }, admin);
  assert.equal(published.ok, true, published.message);
  const rows = published.data.publication.rows;
  assert.deepEqual(rows.map((row) => row.rank).sort(), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.points).sort((a, b) => b - a), [18, 14, 12]);
});

test('赛程发布：预赛没抽签或场次没排期都不许发布', async () => {
  const world = await makeWorld();
  const { meetId, admin, sprint } = world;

  const notDrawn = await schedule.publishMeetSchedule({}, admin);
  assert.equal(notDrawn.ok, false);
  assert.match(notDrawn.message, /还没配齐时间与场地/);

  await advance.drawMeetHeats({ eventKey: sprint, heatCount: 2 }, admin);
  await prepareSession(world, meetSessionKey(meetId, sprint, 'heat', 1), '2026-10-24T09:00');

  // 只排了第 1 组：还有第 2 组与决赛没时间场地
  const partial = await schedule.publishMeetSchedule({}, admin);
  assert.equal(partial.ok, false);
  assert.match(partial.message, /还没配齐时间与场地/);
});
