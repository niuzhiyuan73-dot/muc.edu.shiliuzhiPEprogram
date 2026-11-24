/**
 * 报名窗口的展示口径 + 抽签后关闭意向
 * ============================================================
 * 用户报的问题：报名截止之后，界面仍然显示「我要报名 / 可报名 / 报名中」，
 * 点了才收到「当前不在报名时间内」。原因是页面只有状态（registration）没有
 * 时间判断，而时间窗口只在服务端写动作里校验。
 *
 * 现在 getSportsMeet 一次算好 registration.open / 文本时间，列表在窗口关闭时
 * 把状态标签改成「报名已截止」。这组用例盯住这个口径。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const reg = require('../src/server/services/meet-registration-service.js');
const advance = require('../src/server/services/meet-advance-service.js');
const { meetEventKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const LEAD = 'u_lead';
const STUDENTS = ['u_s1', 'u_s2', 'u_s3'];
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-20T23:59' };
const IN_WINDOW = new Date('2026-10-10T08:00:00Z');
const AFTER_CLOSE = new Date('2026-10-25T08:00:00Z');

const users = ['u_admin', LEAD, ...STUDENTS].map((id) => ({
  _id: id, openId: `o_${id}`, nickName: id, realName: id,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const members = ['u_admin', LEAD, ...STUDENTS].map((id) => ({
  _id: schoolMemberKey(id, SCHOOL), schoolId: SCHOOL, userId: id, collegeId: 'c01',
  status: 'active', gender: 'male',
}));

const ctxOf = (repo, actorId, meetId = '', at = IN_WINDOW) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

async function makeWorld() {
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
  return { repo, meetId, admin, eventKey };
}

test('报名窗口内：registration.open 为真，时间已去掉 ISO 的 T', async () => {
  const { repo, meetId } = await makeWorld();
  const view = await meetService.getSportsMeet({ meetId }, await ctxOf(repo, 'u_s1', meetId, IN_WINDOW));

  assert.equal(view.ok, true, view.message);
  assert.equal(view.data.meet.registration.open, true);
  assert.equal(view.data.meet.registration.openAt, '2026-10-01 00:00');
  assert.equal(view.data.meet.registration.closeAt, '2026-10-20 23:59');
});

test('截止之后：registration.open 为假，列表标签改成「报名已截止」', async () => {
  const { repo, meetId } = await makeWorld();

  const detail = await meetService.getSportsMeet({ meetId }, await ctxOf(repo, 'u_s1', meetId, AFTER_CLOSE));
  assert.equal(detail.data.meet.registration.open, false, '过了截止时间就不是报名期');
  assert.equal(detail.data.meet.status, 'registration', '届次状态本身不会自己流转');

  const list = await meetService.listSportsMeets({}, await ctxOf(repo, 'u_admin', '', AFTER_CLOSE));
  const row = list.data.items.find((item) => item.meetId === meetId);
  assert.equal(row.registrationOpen, false);
  assert.equal(row.statusLabel, '报名已截止');
});

test('补报窗口：开了之后 open 为真且 late 标记命中', async () => {
  const { repo, meetId, admin } = await makeWorld();
  const opened = await reg.openMeetLateWindow(
    { openAt: '2026-10-24T08:00', closeAt: '2026-10-26T20:00' }, admin);
  assert.equal(opened.ok, true, opened.message);

  const detail = await meetService.getSportsMeet({ meetId }, await ctxOf(repo, 'u_s1', meetId, AFTER_CLOSE));
  assert.equal(detail.data.meet.registration.open, true);
  assert.equal(detail.data.meet.registration.late, true);
  assert.equal(detail.data.meet.registration.lateEndText, '2026-10-26 20:00');
});

test('抽签之后不再收新的参赛意向', async () => {
  const { repo, meetId, admin, eventKey } = await makeWorld();
  // 先让三人交意向并过审，凑够抽签人数
  for (const userId of STUDENTS) {
    await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
  }
  for (const userId of STUDENTS) {
    const submitted = await reg.submitMeetCollegeEntry(
      { eventKey, userIds: [userId] }, await ctxOf(repo, LEAD, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    await reg.reviewMeetEntry({ entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
  }
  await meetService.setMeetEventProcedure({ eventKey, rounds: 'final', heatCapacity: 4 }, admin);
  const drawn = await advance.drawMeetHeats({ eventKey }, admin);
  assert.equal(drawn.ok, true, drawn.message);

  // 第四个人（没报过名的老师账号）再提意向：应被抽签挡住
  const late = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(late.ok, false);
  assert.match(late.message, /已经抽签/);
});

test('补报窗口只在已发布且未结束的届次开放', async () => {
  const { repo, meetId, admin } = await makeWorld();
  const current = await repo.sportsMeets.getById(meetId);
  await repo.sportsMeets.set(meetId, { ...current, status: 'draft' });
  const draft = await reg.openMeetLateWindow(
    { openAt: '2026-10-24T08:00', closeAt: '2026-10-26T20:00' }, admin);
  assert.equal(draft.ok, false);
  assert.match(draft.message, /尚未发布/);

  await repo.sportsMeets.set(meetId, { ...current, status: 'finished' });
  const finished = await reg.openMeetLateWindow(
    { openAt: '2026-10-24T08:00', closeAt: '2026-10-26T20:00' }, admin);
  assert.equal(finished.ok, false);
  assert.match(finished.message, /已结束/);
});
