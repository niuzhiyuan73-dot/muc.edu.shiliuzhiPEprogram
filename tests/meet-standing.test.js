/**
 * 学院总榜与个人荣誉（B8）
 * ============================================================
 * 盯四件事：
 *   1. 发布正式成绩后，学院总分与金/银/铜按名次分表累加；
 *   2. **无痕更正不翻倍**——结果行按同主键覆盖，旧值会消失，而总榜是累加的，
 *      所以发布时必须先把旧分减掉。这是本文件最重要的一条；
 *   3. 预赛发布不计分、不产生荣誉（预赛名次是组内排名，不是奖牌名次）；
 *   4. 队伍项目一条参赛记录对应多名队员，每人都该有这条荣誉。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const reg = require('../src/server/services/meet-registration-service.js');
const schedule = require('../src/server/services/meet-schedule-service.js');
const score = require('../src/server/services/meet-score-service.js');
const standing = require('../src/server/services/meet-standing-service.js');
const { meetEventKey, meetSessionKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const COLLEGES = ['c01', 'c02', 'c03'];
const LEAD = { c01: 'u_l1', c02: 'u_l2', c03: 'u_l3' };
const JUDGES = ['u_j1', 'u_j2', 'u_j3'];
// 每院 4 人：1 人跑 100 米，4 人组一队接力（兼项不冲突：接力是团体项，不计入个人 2 项）
const STUDENTS = {};
for (const c of COLLEGES) {
  STUDENTS[c] = Array.from({ length: 4 }, (_, i) => `u_${c}_${i + 1}`);
}
const ids = ['u_admin', ...COLLEGES.map((c) => LEAD[c]), ...JUDGES,
  ...COLLEGES.flatMap((c) => STUDENTS[c])];
const users = ids.map((id) => ({
  _id: id, openId: `o_${id}`, nickName: id, realName: id,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const colleges = COLLEGES.map((id, index) => ({
  _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id, name: `${index + 1} 院`, status: 'active',
}));
const memberRows = [];
for (const c of COLLEGES) {
  memberRows.push([LEAD[c], c]);
  for (const s of STUDENTS[c]) memberRows.push([s, c]);
}
memberRows.push(['u_admin', 'c01'], ...JUDGES.map((j) => [j, 'c01']));
const members = memberRows.map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId, status: 'active', gender: 'male',
}));
const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/** 单人报名并审核通过 */
async function enrollSingle(repo, meetId, admin, eventKey, userId, leadId) {
  const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
  assert.equal(interest.ok, true, interest.message);
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: [userId] }, await ctxOf(repo, leadId, meetId));
  assert.equal(submitted.ok, true, submitted.message);
  await reg.reviewMeetEntry({ entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
  return submitted.data.entry._id;
}

/** 队伍整队报名并审核通过 */
async function enrollTeam(repo, meetId, admin, eventKey, userIds, leadId) {
  for (const userId of userIds) {
    const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
    assert.equal(interest.ok, true, interest.message);
  }
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds }, await ctxOf(repo, leadId, meetId));
  assert.equal(submitted.ok, true, submitted.message);
  await reg.reviewMeetEntry({ entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
  return submitted.data.entry._id;
}

async function makeWorld(withSessions = true) {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  for (const c of COLLEGES) {
    await leadService.grantMeetCollegeLead({ collegeId: c, userId: LEAD[c] }, admin);
  }
  const sprint = meetEventKey(meetId, 'sprint-100m', 'male');
  const relay = meetEventKey(meetId, 'relay-4x100', 'male');
  await meetService.configureMeetEvent(
    { templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1 }, admin);
  await meetService.configureMeetEvent(
    { templateId: 'relay-4x100', group: 'male', members: 4, perCollegeLimit: 1 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  // 100 米：每院 1 人
  const sprintEntries = {};
  for (const c of COLLEGES) {
    sprintEntries[c] = await enrollSingle(repo, meetId, admin, sprint, STUDENTS[c][0], LEAD[c]);
  }
  // 接力：每院 1 队
  const relayEntries = {};
  for (const c of COLLEGES) {
    relayEntries[c] = await enrollTeam(repo, meetId, admin, relay, STUDENTS[c], LEAD[c]);
  }

  // 排期 + 派 3 名裁判。预赛测试要先把赛制改掉再排期，故可跳过。
  for (const [eventKey, round] of (withSessions ? [[sprint, 'final'], [relay, 'final']] : [])) {
    await schedule.saveMeetSession({
      eventKey, round, index: 1, startAt: '2026-10-24 09:00', venue: '田径场',
    }, admin);
    await schedule.assignMeetJudges(
      { judgeIds: JUDGES, sessionKeys: [meetSessionKey(meetId, eventKey, round, 1)] }, admin);
  }
  return {
    repo, meetId, admin, sprint, relay, sprintEntries, relayEntries,
    sprintSession: meetSessionKey(meetId, sprint, 'final', 1),
    relaySession: meetSessionKey(meetId, relay, 'final', 1),
  };
}

/** 三名裁判给同一参赛记录打同一个成绩 */
async function giveScore(world, sessionKey, entryKey, rawText, allowResubmit = false) {
  for (const judgeId of JUDGES) {
    const saved = await score.saveMeetJudgeScore(
      { sessionKey, entryKey, judgeId, rawText, allowResubmit }, world.admin);
    assert.equal(saved.ok, true, saved.message);
    const submitted = await score.submitMeetJudgeScore({ sessionKey, entryKey, judgeId }, world.admin);
    assert.equal(submitted.ok, true, submitted.message);
  }
}

test('发布后学院总分与奖牌按名次分表累加', async () => {
  const world = await makeWorld();
  const { sprint, sprintEntries, sprintSession } = world;

  await giveScore(world, sprintSession, sprintEntries.c01, '12.10');
  await giveScore(world, sprintSession, sprintEntries.c02, '12.20');
  await giveScore(world, sprintSession, sprintEntries.c03, '12.30');
  const published = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  assert.equal(published.ok, true, published.message);

  const board = await standing.getMeetStandings({}, world.admin);
  assert.equal(board.ok, true, board.message);
  assert.equal(board.data.published, true);
  assert.equal(board.data.total, 3);
  assert.deepEqual(
    board.data.items.map((row) => [row.collegeId, row.rank, row.total, row.gold, row.silver, row.bronze]),
    [
      ['c01', 1, 9, 1, 0, 0],
      ['c02', 2, 7, 0, 1, 0],
      ['c03', 3, 6, 0, 0, 1],
    ],
  );
});

test('团体项目按双倍分计入，队员人人都拿到荣誉', async () => {
  const world = await makeWorld();
  const { relay, relayEntries, relaySession } = world;

  await giveScore(world, relaySession, relayEntries.c01, '45.10');
  await giveScore(world, relaySession, relayEntries.c02, '45.20');
  await giveScore(world, relaySession, relayEntries.c03, '45.30');
  const published = await score.publishMeetResults({ eventKey: relay }, world.admin);
  assert.equal(published.ok, true, published.message);

  const board = await standing.getMeetStandings({}, world.admin);
  assert.deepEqual(
    board.data.items.map((row) => [row.collegeId, row.total]),
    [['c01', 18], ['c02', 14], ['c03', 12]],
    '团体项目按个人同名次分的 2 倍计',
  );

  // 接力 4 名队员每人都该看到这条第一名的荣誉
  const mine = await standing.getMyMeetHonors({}, await ctxOf(world.repo, STUDENTS.c01[3], world.meetId));
  assert.equal(mine.ok, true, mine.message);
  assert.equal(mine.data.total, 1);
  assert.equal(mine.data.items[0].rank, 1);
  assert.equal(mine.data.items[0].points, 18);
  assert.equal(mine.data.summary.gold, 1);
  // 没参赛的人看不到
  const other = await standing.getMyMeetHonors({}, await ctxOf(world.repo, 'u_admin', world.meetId));
  assert.equal(other.data.total, 0);
});

test('无痕更正：重发后总分是修正值，不翻倍', async () => {
  const world = await makeWorld();
  const { sprint, sprintEntries, sprintSession } = world;

  await giveScore(world, sprintSession, sprintEntries.c01, '12.10');
  await giveScore(world, sprintSession, sprintEntries.c02, '12.20');
  await giveScore(world, sprintSession, sprintEntries.c03, '12.30');
  await score.publishMeetResults({ eventKey: sprint }, world.admin);

  // 更正：c01 变慢，c03 变快
  await giveScore(world, sprintSession, sprintEntries.c01, '13.00', true);
  await giveScore(world, sprintSession, sprintEntries.c03, '11.90', true);
  const second = await score.publishMeetResults({ eventKey: sprint, reason: '计时更正' }, world.admin);
  assert.equal(second.ok, true, `第二次发布失败：${second.message}`);
  assert.equal(second.data.publication.version, 2);

  const board = await standing.getMeetStandings({}, world.admin);
  assert.deepEqual(
    board.data.items.map((row) => [row.collegeId, row.rank, row.total]),
    [['c03', 1, 9], ['c02', 2, 7], ['c01', 3, 6]],
    '总分应是修正后的值，而不是新旧相加',
  );

  // 荣誉也跟着换人
  const mine = await standing.getMyMeetHonors({}, await ctxOf(world.repo, STUDENTS.c03[0], world.meetId));
  assert.equal(mine.data.summary.gold, 1, 'c03 的学生应拿到金牌');
  // 被反超的人仍有名次（降到第三、铜牌），只是不再是金牌
  const old = await standing.getMyMeetHonors({}, await ctxOf(world.repo, STUDENTS.c01[0], world.meetId));
  assert.equal(old.data.total, 1, '仍有名次');
  assert.equal(old.data.items[0].rank, 3);
  assert.equal(old.data.summary.gold, 0, '金牌已易主');
});

test('同分学院并列名次，下一名次跳号', async () => {
  const world = await makeWorld();
  const { sprint, sprintEntries, sprintSession } = world;
  // c01 与 c02 同成绩
  await giveScore(world, sprintSession, sprintEntries.c01, '12.10');
  await giveScore(world, sprintSession, sprintEntries.c02, '12.10');
  await giveScore(world, sprintSession, sprintEntries.c03, '12.30');
  await score.publishMeetResults({ eventKey: sprint }, world.admin);

  const board = await standing.getMeetStandings({}, world.admin);
  assert.deepEqual(
    board.data.items.map((row) => [row.collegeId, row.rank, row.total, row.gold]),
    [['c01', 1, 9, 1], ['c02', 1, 9, 1], ['c03', 3, 6, 0]],
  );
});

test('预赛发布不计学院分、不产生荣誉', async () => {
  // 不排期：赛制必须在还有场次之前改，改完再排期派裁判
  const world = await makeWorld(false);
  const { sprint } = world;
  await meetService.setMeetEventProcedure({
    eventKey: sprint, rounds: 'heat_final', heatCapacity: 8, advance: { mode: 'per_heat', count: 1 },
  }, world.admin);
  const advance = require('../src/server/services/meet-advance-service.js');
  const heats = await advance.drawMeetHeats({ eventKey: sprint, seed: 5 }, world.admin);
  assert.equal(heats.ok, true, heats.message);
  const heatKey = meetSessionKey(world.meetId, sprint, 'heat', 1);
  const session = await world.repo.sportsMeetSessions.getById(heatKey);
  await schedule.saveMeetSession({
    eventKey: sprint, round: 'heat', index: 1, startAt: '2026-10-24 09:00', venue: '田径场',
  }, world.admin);
  await schedule.assignMeetJudges({ judgeIds: JUDGES, sessionKeys: [heatKey] }, world.admin);
  for (const entryKey of session.entryKeys) await giveScore(world, heatKey, entryKey, '12.10');

  const published = await score.publishMeetResults({ eventKey: sprint, sessionKey: heatKey }, world.admin);
  assert.equal(published.ok, true, published.message);
  assert.equal(published.data.publication.official, false, '预赛不是正式成绩');

  const board = await standing.getMeetStandings({}, world.admin);
  assert.equal(board.data.published, false, '预赛不应产生总榜');
  const mine = await standing.getMyMeetHonors({}, await ctxOf(world.repo, STUDENTS.c01[0], world.meetId));
  assert.equal(mine.data.total, 0, '预赛名次不是荣誉');
});

test('成绩全部作废（记无成绩）时学院不得分、无荣誉', async () => {
  const world = await makeWorld();
  const { sprint, sprintEntries, sprintSession } = world;
  await giveScore(world, sprintSession, sprintEntries.c01, '12.10');
  await giveScore(world, sprintSession, sprintEntries.c02, '12.20');
  await giveScore(world, sprintSession, sprintEntries.c03, '12.30');
  await score.publishMeetResults(
    { eventKey: sprint, voidEntryKeys: [sprintEntries.c01] }, world.admin);

  const board = await standing.getMeetStandings({}, world.admin);
  assert.deepEqual(
    board.data.items.map((row) => [row.collegeId, row.rank, row.total]),
    // 0 分学院仍然入榜（排在最后），只是不得分、不占名次
    [['c02', 1, 9], ['c03', 2, 7], ['c01', 3, 0]],
    '记无成绩的参赛记录不得分、不占名次',
  );
  const mine = await standing.getMyMeetHonors({}, await ctxOf(world.repo, STUDENTS.c01[0], world.meetId));
  assert.equal(mine.data.total, 0);
});
