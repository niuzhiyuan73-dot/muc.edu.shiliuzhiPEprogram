/**
 * M3：重抽 + 总裁判
 * ============================================================
 * 这两件事绑在一起：抽错了（组数、每组人数现场才知道准数）要能重来，
 * 而最常发现抽错的是管理员与本届总裁判，所以两者同档。
 *
 * 守的边界：
 *   1. 管理员/总裁判能重抽；普通会员不能；
 *   2. 重抽把场次作废（仓储没有 remove），赛程列表里看不到旧场次，且能重新抽；
 *   3. 已发布成绩或已录分时拒绝重抽——重排会让已录的成绩对不上人；
 *   4. 总裁判随届：结束运动会自动卸任，下一届不再带着发布权。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const reg = require('../src/server/services/meet-registration-service.js');
const schedule = require('../src/server/services/meet-schedule-service.js');
const advance = require('../src/server/services/meet-advance-service.js');
const { getMeetSessionScores } = require('../src/server/services/meet-score-service.js');
const { meetEventKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const LEAD = 'u_lead';
const CHIEF = 'u_chief';
const STUDENTS = ['u_s1', 'u_s2', 'u_s3', 'u_s4', 'u_s5'];

const users = ['u_admin', LEAD, CHIEF, ...STUDENTS].map((id) => ({
  _id: id, openId: `o_${id}`, nickName: id, realName: id,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const members = ['u_admin', LEAD, CHIEF, ...STUDENTS].map((id) => ({
  _id: schoolMemberKey(id, SCHOOL), schoolId: SCHOOL, userId: id, collegeId: 'c01',
  status: 'active', gender: 'male',
}));

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/** 一届「5 人报名、按每组 4 人分成 2 组」的最小世界；enroll:false 时只建届不报名 */
async function makeWorld(options = {}) {
  const enroll = options.enroll !== false;
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users,
    colleges: [{ _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '一院', status: 'active' }],
    schoolMembers: members,
    schoolRoles: [{ _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' }],
  });

  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: LEAD }, admin);

  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 8 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  if (!enroll) return { repo, meetId, admin, eventKey };
  // 先全员交意向，再逐条提交名单：D25 规定本院报过正式名单后意向入口就关了
  for (const userId of STUDENTS) {
    const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
    assert.equal(interest.ok, true, interest.message);
  }
  for (const userId of STUDENTS) {
    const submitted = await reg.submitMeetCollegeEntry({ eventKey, userIds: [userId] }, await ctxOf(repo, LEAD, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    const approved = await reg.reviewMeetEntry({ entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    assert.equal(approved.ok, true, approved.message);
  }
  // 5 人、每组最多 4 人 → 2 组
  const procedure = await meetService.setMeetEventProcedure(
    { eventKey, rounds: 'final', heatCapacity: 4 }, admin);
  assert.equal(procedure.ok, true, procedure.message);

  return { repo, meetId, admin, eventKey };
}

const sessionsOf = async (repo, meetId, actor = 'u_admin') => {
  const view = await schedule.getMeetSchedule({}, await ctxOf(repo, actor, meetId));
  assert.equal(view.ok, true, view.message);
  return view.data.items.find((row) => row.eventKey === view.data.items[0].eventKey).sessions;
};

test('管理员抽签后可以重抽：场次清空、分组标记归零、赛程里看不到旧场次', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();

  const drawn = await advance.drawMeetHeats({ eventKey }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal((await sessionsOf(repo, meetId)).length, 2);

  const reset = await advance.resetMeetDraw({ eventKey }, admin);
  assert.equal(reset.ok, true, reset.message);
  assert.equal(reset.data.clearedSessions, 2);
  assert.equal((await sessionsOf(repo, meetId)).length, 0, '作废场次不该出现在赛程里');

  // 重抽之后可以再抽（heatDraw 已清空），且新场次照常可见
  const again = await advance.drawMeetHeats({ eventKey }, admin);
  assert.equal(again.ok, true, again.message);
  assert.equal((await sessionsOf(repo, meetId)).length, 2);
});

test('重抽之后可以改赛制（原先只提示「请先删除场次」，而没有删除动作）', async () => {
  const { admin, eventKey } = await makeWorld();
  await advance.drawMeetHeats({ eventKey }, admin);

  const blocked = await meetService.setMeetEventProcedure({ eventKey, rounds: 'final', heatCapacity: 2 }, admin);
  assert.equal(blocked.ok, false, '已排场次时不能改结构');

  const reset = await advance.resetMeetDraw({ eventKey }, admin);
  assert.equal(reset.ok, true, reset.message);
  const allowed = await meetService.setMeetEventProcedure({ eventKey, rounds: 'final', heatCapacity: 2 }, admin);
  assert.equal(allowed.ok, true, allowed.message);
});

test('重抽后恢复待排期的决赛，旧裁判任务失效，同一人可重新指派并开赛', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  const procedure = await meetService.setMeetEventProcedure({
    eventKey, rounds: 'heat_final', heatCapacity: 4, advance: { mode: 'per_heat', count: 1 },
  }, admin);
  assert.equal(procedure.ok, true, procedure.message);
  assert.equal((await advance.drawMeetHeats({ eventKey }, admin)).ok, true);
  const final = (await sessionsOf(repo, meetId)).find(row => row.round === 'final');
  const { sessionKey } = final;
  const chief = await ctxOf(repo, CHIEF, meetId);

  const initial = await schedule.assignMeetJudge({ sessionKey, judgeId: CHIEF }, admin);
  assert.equal(initial.data.created, true);
  assert.equal((await schedule.getMyMeetJudgeTasks({}, chief)).data.items.length, 1);

  assert.equal((await advance.resetMeetDraw({ eventKey }, admin)).ok, true);
  assert.equal((await advance.drawMeetHeats({ eventKey }, admin)).ok, true);
  const revived = (await sessionsOf(repo, meetId)).find(row => row.sessionKey === sessionKey);
  assert.ok(revived, '重抽后应重新显示同一主键的决赛场次');
  assert.equal(revived.judgeCount, 0);
  assert.deepEqual((await schedule.getMyMeetJudgeTasks({}, chief)).data.items, []);
  const judgeSessions = await schedule.listMeetEventSessions({ eventKey }, chief);
  assert.equal(judgeSessions.data.items.find(row => row.sessionKey === sessionKey).assignedToMe, false);
  assert.equal((await getMeetSessionScores({ sessionKey }, chief)).data.canEnter, false);

  const saved = await schedule.saveMeetSession({ eventKey, round: 'final', index: 1,
    startAt: '2026-10-25T10:00:00+08:00', venue: '田径场' }, admin);
  assert.equal(saved.ok, true, saved.message);
  assert.equal((await schedule.startMeetEvent({ sessionKey }, admin)).ok, false);
  const assigned = await schedule.assignMeetJudges({ sessionKeys: [sessionKey], judgeIds: [CHIEF] }, admin);
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal(assigned.data.created, 1);
  assert.equal((await schedule.getMyMeetJudgeTasks({}, chief)).data.items.length, 1);
  assert.equal((await getMeetSessionScores({ sessionKey }, chief)).data.canEnter, true);
  assert.equal((await schedule.startMeetEvent({ sessionKey }, admin)).ok, true);
});

test('三队签表按先读后写提交，自动轮空不妨碍重抽，实判结果仍会阻止', async () => {
  const scope = { schoolId: SCHOOL, meetId: 'm_bye' };
  const eventKey = meetEventKey(scope.meetId, 'basketball', 'male');
  const db = database({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, status: 'active' }],
    users: [{ _id: 'admin', platformRole: 'admin', platformStatus: 'active' }],
    sportsMeets: [{ _id: scope.meetId, ...scope, status: 'running' }],
    sportsMeetEvents: [{ _id: eventKey, ...scope, status: 'active', scoreType: 'versus', format: 'single_elim' }],
    sportsMeetEntries: [1, 2, 3].map(i => ({
      _id: `entry${i}`, ...scope, eventKey, status: 'approved', collegeId: `c0${i}`,
    })),
  });
  const repo = createRepo(db);
  const admin = await ctxOf(repo, 'admin', scope.meetId);
  const sessions = () => repo.forMeet(scope).sportsMeetSessions.listByProject(eventKey);

  assert.equal((await advance.drawMeetBracket({ eventKey, seed: 1 }, admin)).ok, true);
  const ops = db.traces.at(-1).map(row => row.kind);
  const firstWrite = ops.indexOf('set');
  assert.ok(firstWrite > 0 && ops.slice(firstWrite).every(kind => kind === 'set'), ops.join(', '));
  assert.equal((await sessions()).filter(row => row.winnerEntryKey).length, 1, '已有自动轮空结果');
  assert.equal((await advance.resetMeetDraw({ eventKey }, admin)).ok, true);

  assert.equal((await advance.drawMeetBracket({ eventKey, seed: 2 }, admin)).ok, true);
  const match = (await sessions()).find(row => row.round === 'r1' && row.entryKeys.every(Boolean));
  const result = await advance.setMeetMatchWinner({ sessionKey: match._id, winnerEntryKey: match.entryKeys[0] }, admin);
  assert.equal(result.ok, true, result.message);
  assert.equal((await advance.resetMeetDraw({ eventKey }, admin)).ok, false);
});

test('普通会员不能重抽；总裁判可以', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  await advance.drawMeetHeats({ eventKey }, admin);

  const member = await advance.resetMeetDraw({ eventKey }, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(member.ok, false);
  assert.match(member.message, /校级管理员及以上或本届总裁判/);

  const appointed = await meetService.appointMeetChiefJudge({ userId: CHIEF }, admin);
  assert.equal(appointed.ok, true, appointed.message);
  assert.equal(appointed.data.chiefJudge.name, CHIEF);

  const chief = await advance.resetMeetDraw({ eventKey }, await ctxOf(repo, CHIEF, meetId));
  assert.equal(chief.ok, true, chief.message);
});

test('已发布成绩的项目拒绝重抽', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  await advance.drawMeetHeats({ eventKey }, admin);
  // 直接落一条发布记录：重抽会把「已公开的名次」与新的分组对不上
  await repo.sportsMeetPublications.set('pub:test', {
    schoolId: SCHOOL, meetId, eventKey, sessionKey: 's', official: false, version: 1,
  });

  const reset = await advance.resetMeetDraw({ eventKey }, admin);
  assert.equal(reset.ok, false);
  assert.match(reset.message, /已经发布过成绩/);
});

test('已录分的项目拒绝重抽', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  await advance.drawMeetHeats({ eventKey }, admin);
  await repo.sportsMeetScores.set('score:test', {
    schoolId: SCHOOL, meetId, eventKey, sessionKey: 's', entryKey: 'e', judgeId: 'u_chief', state: 'submitted',
  });

  const reset = await advance.resetMeetDraw({ eventKey }, admin);
  assert.equal(reset.ok, false);
  assert.match(reset.message, /已有裁判录分/);
});

test('撤销总裁判后立刻失去重抽权', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  await advance.drawMeetHeats({ eventKey }, admin);
  await meetService.appointMeetChiefJudge({ userId: CHIEF }, admin);

  const revoked = await meetService.revokeMeetChiefJudge({}, admin);
  assert.equal(revoked.ok, true, revoked.message);
  const afterRevoke = await advance.resetMeetDraw({ eventKey }, await ctxOf(repo, CHIEF, meetId));
  assert.equal(afterRevoke.ok, false);
});

test('结束运动会时总裁判自动卸任（N5）', async () => {
  // 无人报名的一届：结束不会被「项目没有发布成绩」挡住，正好只验卸任
  const { repo, meetId, admin } = await makeWorld({ enroll: false });
  const appointed = await meetService.appointMeetChiefJudge({ userId: CHIEF }, admin);
  assert.equal(appointed.ok, true, appointed.message);

  const finished = await meetService.finishSportsMeet({}, admin);
  assert.equal(finished.ok, true, finished.message);
  const meet = await repo.sportsMeets.getById(meetId);
  assert.equal(meet.chiefJudge.status, 'revoked', '本届收口后总裁判自动卸任');
});
