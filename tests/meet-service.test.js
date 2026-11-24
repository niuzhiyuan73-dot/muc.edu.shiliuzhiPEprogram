// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
/**
 * B4：运动会草稿、项目运行时配置与报名发布
 * ============================================================
 * 这一段的产品约束集中在三处，测试逐条钉死：
 *   1. R04：没有项目不能发布报名（不能建一个空运动会）；
 *   2. 配置只在草稿期可改（发布后改限额等于改已生效的规则）；
 *   3. 组别 × 项目是独立报名单位，限额与人数按项目形态区分
 *      （单人按人、团体按队、多人协作按组，三人板鞋强制 3 人）。
 * 另外验证协议 2 的 **meet 分支**：运动会请求不带 association 也能被正确分发。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request.js');
const { meetEventKey } = require('../src/shared/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const NOW = new Date('2026-10-17T09:00:00Z');

const users = [
  { _id: 'u_admin', openId: 'o_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_stu', openId: 'o_stu', name: '普通学生', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
];

const colleges = [
  { _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '信息工程学院', status: 'active' },
];

const schoolMembers = [
  { _id: schoolMemberKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', collegeId: 'c01', status: 'active', gender: 'male' },
  { _id: schoolMemberKey('u_stu', SCHOOL), schoolId: SCHOOL, userId: 'u_stu', collegeId: 'c01', status: 'active', gender: 'male' },
];

const schoolRoles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

function makeRepo() {
  return createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });
}

const ctxOf = (repo, actorId, meetId = '', at = NOW) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

const DRAFT = {
  name: '中央民族大学第 59 届田径运动会',
  year: 2026,
  startDate: '2026-10-24',
  endDate: '2026-10-25',
  location: '学校田径场',
};

/** 建一届草稿，返回 meetId。 */
async function createDraft(repo, at = NOW) {
  const result = await meetService.createSportsMeet(DRAFT, await ctxOf(repo, 'u_admin', '', at));
  assert.equal(result.ok, true, result.message);
  return result.data.meet.meetId;
}

const WINDOW = { openAt: '2026-10-01T08:00', closeAt: '2026-10-15T18:00' };

test('校管理员可发起草稿，初始状态为筹备中且无项目', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const doc = await repo.sportsMeets.getById(meetId);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.schoolId, SCHOOL);
  assert.equal(doc.eventCount, 0);
  assert.equal(doc.createdBy, 'u_admin');
});

test('普通学生不能发起运动会', async () => {
  const repo = makeRepo();
  const result = await meetService.createSportsMeet(DRAFT, await ctxOf(repo, 'u_stu'));
  assert.equal(result.ok, false);
  assert.match(result.message, /校级管理员及以上/);
  assert.equal((await repo.sportsMeets.listBySchool(SCHOOL)).length, 0);
});

test('同一秒重复发起是幂等的，不会建出两届', async () => {
  const repo = makeRepo();
  const first = await meetService.createSportsMeet(DRAFT, await ctxOf(repo, 'u_admin', '', NOW));
  const second = await meetService.createSportsMeet(DRAFT, await ctxOf(repo, 'u_admin', '', NOW));
  assert.equal(first.data.created, true);
  assert.equal(second.data.created, false);
  assert.equal((await repo.sportsMeets.listBySchool(SCHOOL)).length, 1);
});

test('结束日期早于开始日期被拒绝', async () => {
  const repo = makeRepo();
  const result = await meetService.createSportsMeet(
    { ...DRAFT, startDate: '2026-10-25', endDate: '2026-10-24' }, await ctxOf(repo, 'u_admin'));
  assert.equal(result.ok, false);
  assert.match(result.message, /结束日期不能早于开始日期/);
});

test('R04：没有项目不能发布报名', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const result = await meetService.publishMeetRegistration(WINDOW, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, false);
  assert.match(result.message, /至少选择一个项目/);
});

test('配置单人项目：默认每学院 3 人、直接决赛', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const result = await meetService.configureMeetEvent(
    { templateId: 'sprint-100m', group: 'male' }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.event.perCollegeLimit, 3);
  assert.equal(result.data.event.entryForm, 'single');
  assert.equal(result.data.event.members, 1);
  assert.equal(result.data.event.rounds, 'final');
  assert.equal(result.data.eventCount, 1);
});

test('配置团体项目：默认每学院 1 队，人数可改', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const result = await meetService.configureMeetEvent(
    { templateId: 'relay-4x100', group: 'male', members: 4 }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.event.perCollegeLimit, 1);
  assert.equal(result.data.event.members, 4);
  assert.equal(result.data.event.entryForm, 'team');
});

test('三人板鞋强制 3 人一组，两人被拒绝', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const result = await meetService.configureMeetEvent(
    { templateId: 'fun-clogs', group: 'mixed', members: 2 }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, false);
  assert.match(result.message, /必须 3 人一组/);
});

test('胜负项目不支持预赛+决赛', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const result = await meetService.configureMeetEvent(
    { templateId: 'tug-of-war', group: 'mixed', members: 10, rounds: 'heat_final' },
    await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, false);
  assert.match(result.message, /胜负项目不支持预赛/);
});

test('同一项目组别重复配置是覆盖，不重复计数', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 3 }, ctx);
  const again = await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'female', perCollegeLimit: 3 }, ctx);
  assert.equal(again.data.eventCount, 2);
  const third = await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 2 }, ctx);
  assert.equal(third.data.eventCount, 2, '同项目组别重复配置不应再加一项');
  assert.equal(third.data.event.perCollegeLimit, 2);
});

test('男女是两条独立报名单位，主键不同', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'female' }, ctx);
  assert.ok(await repo.sportsMeetEvents.getById(meetEventKey(meetId, 'sprint-100m', 'male')));
  assert.ok(await repo.sportsMeetEvents.getById(meetEventKey(meetId, 'sprint-100m', 'female')));
});

test('发布报名：保存报名窗口并转为报名中', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);

  const result = await meetService.publishMeetRegistration(WINDOW, ctx);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.meet.status, 'registration');
  assert.equal(result.data.meet.registration.openAt, WINDOW.openAt);
});

test('报名截止早于开始时被拒绝', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  const result = await meetService.publishMeetRegistration(
    { openAt: '2026-10-15T18:00', closeAt: '2026-10-01T08:00' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /必须晚于开始时间/);
});

test('发布后不能再改配置或基本规则', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  await meetService.publishMeetRegistration(WINDOW, ctx);

  const config = await meetService.configureMeetEvent(
    { templateId: 'sprint-200m', group: 'male' }, ctx);
  assert.equal(config.ok, false);
  assert.match(config.message, /已发布报名/);

  const draft = await meetService.updateMeetDraft({ name: '改个名' }, ctx);
  assert.equal(draft.ok, false);
});

test('列表：草稿仅管理者可见，学生看不到', async () => {
  const repo = makeRepo();
  await createDraft(repo);

  const adminList = await meetService.listSportsMeets({}, await ctxOf(repo, 'u_admin'));
  assert.equal(adminList.data.total, 1);

  const studentList = await meetService.listSportsMeets({}, await ctxOf(repo, 'u_stu'));
  assert.equal(studentList.data.total, 0, '学生不应看到草稿');
});

test('列表：报名中置顶，支持关键词与年份筛选', async () => {
  const repo = makeRepo();
  const early = await meetService.createSportsMeet(
    { ...DRAFT, name: '春季运动会', startDate: '2026-04-01', endDate: '2026-04-02' },
    await ctxOf(repo, 'u_admin', '', new Date('2026-03-01T00:00:00Z')));
  assert.equal(early.ok, true);
  const summer = await meetService.createSportsMeet(
    { ...DRAFT, name: '秋季运动会', startDate: '2026-10-24', endDate: '2026-10-25' },
    await ctxOf(repo, 'u_admin', '', new Date('2026-09-01T00:00:00Z')));
  assert.equal(summer.ok, true);

  // 让秋季那届进入报名中
  const summerId = summer.data.meet.meetId;
  const ctx = await ctxOf(repo, 'u_admin', summerId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  await meetService.publishMeetRegistration(WINDOW, ctx);

  const listed = await meetService.listSportsMeets({}, await ctxOf(repo, 'u_admin'));
  assert.equal(listed.data.items[0].name, '秋季运动会', '报名中应置顶');

  const byKeyword = await meetService.listSportsMeets({ keyword: '春季' }, await ctxOf(repo, 'u_admin'));
  assert.equal(byKeyword.data.total, 1);
  assert.equal(byKeyword.data.items[0].name, '春季运动会');

  const byYear = await meetService.listSportsMeets({ year: 2025 }, await ctxOf(repo, 'u_admin'));
  assert.equal(byYear.data.total, 0);

  const page = await meetService.listSportsMeets({ limit: 1, offset: 1 }, await ctxOf(repo, 'u_admin'));
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.total, 2);
});

test('详情：草稿对学生不可见，管理员可见并返回项目与权限标记', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, await ctxOf(repo, 'u_admin', meetId));

  const asStudent = await meetService.getSportsMeet({}, await ctxOf(repo, 'u_stu', meetId));
  assert.equal(asStudent.ok, false);
  assert.match(asStudent.message, /尚未发布/);

  const asAdmin = await meetService.getSportsMeet({}, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(asAdmin.ok, true);
  assert.equal(asAdmin.data.events.length, 1);
  assert.equal(asAdmin.data.events[0].name, '100 米');
  assert.equal(asAdmin.data.permissions.canManage, true);
  assert.equal(asAdmin.data.permissions.collegeId, '');
});

test('项目模板搜索：46 项、别名命中、可按分类筛选', async () => {
  const repo = makeRepo();
  const ctx = await ctxOf(repo, 'u_stu');

  const all = await meetService.listSportsEventTemplates({}, ctx);
  assert.equal(all.data.total, 46);

  const hundreds = await meetService.listSportsEventTemplates({ keyword: '百米' }, ctx);
  assert.ok(hundreds.data.items.some((item) => item.templateId === 'sprint-100m'));

  const shows = await meetService.listSportsEventTemplates({ category: 'show' }, ctx);
  assert.equal(shows.data.total, 5);
  assert.equal(shows.data.items[0].defaultScored, false, '展示类默认不计分（N16）');
});

test('删除草稿：软删除，列表不再出现；已发布的拒绝删除', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const deleted = await meetService.deleteSportsMeet({}, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(deleted.ok, true);

  const doc = await repo.sportsMeets.getById(meetId);
  assert.equal(doc.status, 'deleted');
  const listed = await meetService.listSportsMeets({}, await ctxOf(repo, 'u_admin'));
  assert.equal(listed.data.total, 0);

  const repo2 = makeRepo();
  const liveId = await createDraft(repo2);
  const ctx = await ctxOf(repo2, 'u_admin', liveId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  await meetService.publishMeetRegistration(WINDOW, ctx);
  const refused = await meetService.deleteSportsMeet({}, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /撤销发布/);
});

test('协议 2 的 meet 分支：不带 association 也能分发', async () => {
  const repo = makeRepo();
  const created = await handleSchoolRequest({
    protocolVersion: 2, schoolId: SCHOOL, action: 'createSportsMeet', payload: DRAFT,
  }, { repo, openId: 'o_admin', now: NOW });
  assert.equal(created.ok, true, created.message);
  assert.equal(created.data.meet.status, 'draft');

  // 列表同样不带 association
  const listed = await handleSchoolRequest({
    protocolVersion: 2, schoolId: SCHOOL, action: 'listSportsMeets', payload: {},
  }, { repo, openId: 'o_admin', now: NOW });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.total, 1);

  // 协会动作仍然要求 association，不会被 meet 分支放宽
  const space = await handleSchoolRequest({
    protocolVersion: 2, schoolId: SCHOOL, action: 'listAssociationGroups', payload: {},
  }, { repo, openId: 'o_admin', now: NOW });
  assert.equal(space.ok, false);
  assert.match(space.message, /指定学校和项目/);
});


test('云端发布面包含公开成绩和结束运动会动作',()=>{
  const cloud=require('../miniprogram/services/school-cloud.js');
  const surface=cloud.forMeet({schoolId:'muc',meetId:'test'});
  assert.equal(typeof surface.listMeetPublishedResults,'function');
  assert.equal(typeof surface.finishSportsMeet,'function');
});


test('运动会门面将云写守卫失败重新抛给页面，避免假成功',async()=>{
  const identity=require('../miniprogram/services/school-identity.js');
  const cloud=require('../miniprogram/services/school-cloud.js');
  const facade=require('../miniprogram/packageMeet/services/meet.js');
  const oldMock=identity.isMockNow,oldMeet=cloud.forMeet;
  try {
    identity.isMockNow=()=>false;
    cloud.forMeet=()=>({publishMeetResults:async()=>({ok:false,message:'成绩没收齐'}),getSportsMeet:async()=>({meet:{name:'测试'}})});
    const client=facade.forScope({schoolId:'muc',meetId:'test'});
    await assert.rejects(()=>client.publishMeetResults({}),/成绩没收齐/);
    assert.equal((await client.getSportsMeet({})).meet.name,'测试');
  } finally {identity.isMockNow=oldMock;cloud.forMeet=oldMeet;}
});

test('软删除项目后复配，eventCount 补回且项目复活', async () => {
  const repo = makeRepo();
  const meetId = await createDraft(repo);
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  const key = meetEventKey(meetId, 'sprint-100m', 'male');
  const removed = await meetService.removeMeetEvent({ eventKey: key }, ctx);
  assert.equal(removed.ok, true, removed.message);
  assert.equal((await repo.sportsMeets.getById(meetId)).eventCount, 0);
  const again = await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, ctx);
  assert.equal(again.ok, true, again.message);
  assert.equal(again.data.eventCount, 1);
  assert.equal((await repo.sportsMeetEvents.getById(key)).status, 'active');
});
