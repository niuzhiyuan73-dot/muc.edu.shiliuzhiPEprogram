/**
 * 赛制在报名截止后设置 + 无预赛项目分多枪决赛
 * ============================================================
 * 两条都是「报名人数决定赛制」的推论：
 *   · 分几组、分几枪 = ceil(报名人数 / 每组人数)，所以赛制只能在人数定了之后设；
 *   · 直接决赛也可能要跑好几枪：所有人各跑一次，成绩合并排名，不晋级。
 * 这里盯三件事：赛制能改到什么时候、分组是否按跑道数算、多枪是否只发一次成绩。
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
const advance = require('../src/server/services/meet-advance-service.js');
const { meetEventKey, meetSessionKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const COLLEGES = ['c01', 'c02', 'c03', 'c04'];
const LEAD = { c01: 'u_l1', c02: 'u_l2', c03: 'u_l3', c04: 'u_l4' };
const STUDENTS = {
  c01: ['u_a1', 'u_a2'], c02: ['u_b1', 'u_b2'], c03: ['u_c1', 'u_c2'], c04: ['u_d1', 'u_d2'],
};

const ids = ['u_admin', ...COLLEGES.flatMap((c) => [LEAD[c], ...STUDENTS[c]]),
  'u_j1', 'u_j2', 'u_j3'];
const users = ids.map((id) => ({
  _id: id, openId: `o_${id}`, nickName: id, realName: id,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
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

async function makeWorld() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  for (const collegeId of COLLEGES) {
    await leadService.grantMeetCollegeLead({ collegeId, userId: LEAD[collegeId] }, admin);
  }
  const enroll = async (eventKey, userIds, leadId) => {
    for (const userId of userIds) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(interest.ok, true, interest.message);
    }
    const submitted = await reg.submitMeetCollegeEntry({ eventKey, userIds }, await ctxOf(repo, leadId, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    const approved = await reg.reviewMeetEntry(
      { entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    assert.equal(approved.ok, true, approved.message);
    return submitted.data.entry._id;
  };
  return { repo, meetId, admin, enroll };
}

test('赛制在报名后设置：没场次时可改，排了场次就锁定', async () => {
  const world = await makeWorld();
  const { meetId, admin, enroll } = world;
  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);
  for (const collegeId of COLLEGES) {
    await enroll(eventKey, [STUDENTS[collegeId][0]], LEAD[collegeId]);
  }

  // 报名后才定赛制：4 人、每组 2 人 → 2 组预赛
  const set = await meetService.setMeetEventProcedure({
    eventKey, rounds: 'heat_final', laneCount: 2, advance: { mode: 'per_heat', count: 1 },
  }, admin);
  assert.equal(set.ok, true, set.message);
  assert.equal(set.data.event.rounds, 'heat_final');
  assert.equal(set.data.event.laneCount, 2);

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 3 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heatCount, 2, '4 人 / 每组 2 人 = 2 组');

  // 已经有场次了 → 不能再改赛制
  const late = await meetService.setMeetEventProcedure({
    eventKey, rounds: 'final', laneCount: 6,
  }, admin);
  assert.equal(late.ok, false);
  assert.match(late.message, /已经排了场次/);
});

test('非法赛制参数被拒：跑道数越界、胜负项目配预赛', async () => {
  const world = await makeWorld();
  const { meetId, admin } = world;
  const sprint = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await meetService.configureMeetEvent({ templateId: 'tug-of-war', group: 'mixed', members: 2 }, admin);
  const tug = meetEventKey(meetId, 'tug-of-war', 'mixed');

  const badLane = await meetService.setMeetEventProcedure({ eventKey: sprint, laneCount: 1 }, admin);
  assert.equal(badLane.ok, false);
  assert.match(badLane.message, /跑道数/);

  const versusHeat = await meetService.setMeetEventProcedure({
    eventKey: tug, rounds: 'heat_final', laneCount: 6,
  }, admin);
  assert.equal(versusHeat.ok, false);
  assert.match(versusHeat.message, /胜负项目/);
});

test('无预赛分多枪：按跑道数分枪，一次发布合并排名', async () => {
  const world = await makeWorld();
  const { meetId, admin, enroll } = world;
  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);
  const entryOf = {};
  for (const collegeId of COLLEGES) {
    entryOf[collegeId] = await enroll(eventKey, [STUDENTS[collegeId][0]], LEAD[collegeId]);
  }

  // 直接决赛 + 每组 2 人 → 4 人分 2 枪
  const proc = await meetService.setMeetEventProcedure({
    eventKey, rounds: 'final', laneCount: 2,
  }, admin);
  assert.equal(proc.ok, true, proc.message);

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 9 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.rounds, 'final');
  assert.equal(drawn.data.heatCount, 2, '4 人 / 每组 2 人 = 2 枪');

  const sessions = (await world.repo.sportsMeetSessions.list())
    .filter((row) => row.eventKey === eventKey)
    .sort((a, b) => Number(a.index) - Number(b.index));
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((row) => row.round), ['final', 'final']);
  assert.deepEqual(sessions.map((row) => row.roundLabel), ['决赛 第 1 枪', '决赛 第 2 枪']);

  // 第一枪派裁判、录分；第二枪先不派 → 发布必须被拒（缺裁判）
  const first = sessions[0];
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await schedule.assignMeetJudge({ sessionKey: first._id, judgeId }, admin);
  }
  const firstTimes = ['12.10', '12.20'];
  for (const [index, entryKey] of first.entryKeys.entries()) {
    for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
      await score.saveMeetJudgeScore(
        { sessionKey: first._id, entryKey, judgeId, rawText: firstTimes[index] }, admin);
      await score.submitMeetJudgeScore({ sessionKey: first._id, entryKey, judgeId }, admin);
    }
  }
  const early = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(early.ok, false);
  assert.match(early.message, /还没有指派裁判/);

  // 第二枪补齐裁判与成绩
  const second = sessions[1];
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await schedule.assignMeetJudge({ sessionKey: second._id, judgeId }, admin);
  }
  const times = ['11.80', '12.40'];
  for (const [index, entryKey] of second.entryKeys.entries()) {
    for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
      await score.saveMeetJudgeScore(
        { sessionKey: second._id, entryKey, judgeId, rawText: times[index] }, admin);
      await score.submitMeetJudgeScore({ sessionKey: second._id, entryKey, judgeId }, admin);
    }
  }

  // 预览：合并两枪，出 4 条
  const preview = await score.getMeetResultPreview({ eventKey }, admin);
  assert.equal(preview.ok, true, preview.message);
  assert.equal(preview.data.multiSession, true);
  assert.equal(preview.data.sessionCount, 2);
  assert.equal(preview.data.items.length, 4);

  const published = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(published.ok, true, published.message);
  assert.equal(published.data.publication.official, true);
  const rows = published.data.publication.rows;
  assert.equal(rows.length, 4, '四条成绩合并成一份，不是每枪各发一份');
  assert.deepEqual(rows.map((row) => row.rank).sort(), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.points).sort((a, b) => b - a), [9, 7, 6, 5]);

  // 只产生一条发布记录：多枪不能各发各的
  const publications = await world.repo.sportsMeetPublications.list();
  assert.equal(publications.filter((row) => row.eventKey === eventKey).length, 1);
});
