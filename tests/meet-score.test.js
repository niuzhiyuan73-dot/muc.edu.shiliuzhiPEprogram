/**
 * B7：录分、汇总、名次与发布
 * ============================================================
 * 这一批的判定标准是「数字对不对」，所以测试几乎全是字面量断言：
 *   · 三裁判 12.30 / 12.50 / 12.40 → 去极值后 12.40（等价中位数）；
 *   · 两人同成绩 → 竞赛排名 1,1,3；分数各得该名次分（D74，不守恒）；
 *   · 无成绩 → 无名次、学院 0 分、绝不按 0 秒排第一（A3）；
 *   · 团体 ×2、展示类不计分（D72／N16）；
 *   · 重复发布换版本，读端只认当前版本（D87 无痕更正）。
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
const { meetEventKey, meetSessionKey } = require('../src/shared/utils/meet-scope.js');
const markSubmitted = require('./helpers/judge-score.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
// 报名窗口覆盖测试用的「当前时间」（T0 = 比赛日上午），避免两套时钟打架
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const SESSION = { round: 'final', index: 1, startAt: '2026-10-24T09:00', endAt: '2026-10-24T09:30', venue: '田径场直道' };

const COL = ['c01', 'c02', 'c03'];
const users = [
  ['u_admin', '校管理员'], ['u_lead1', '一院部长'], ['u_lead2', '二院部长'], ['u_lead3', '三院部长'],
  ['u_a', '甲'], ['u_a2', '甲二'], ['u_b', '乙'], ['u_c', '丙'],
  ['u_j1', '裁判一'], ['u_j2', '裁判二'], ['u_j3', '裁判三'],
].map(([id, name]) => ({
  _id: id, openId: `o_${id}`, name, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));

const colleges = COL.map((id, index) => ({
  _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id, name: `${index + 1} 院`, status: 'active',
}));

const members = [
  ['u_admin', 'c01'], ['u_lead1', 'c01'], ['u_lead2', 'c02'], ['u_lead3', 'c03'],
  ['u_a', 'c01'], ['u_a2', 'c01'], ['u_b', 'c02'], ['u_c', 'c03'],
  ['u_j1', 'c01'], ['u_j2', 'c01'], ['u_j3', 'c01'],
].map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId,
  status: 'active', gender: 'male',
}));

const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/** 建一届：100 米（个人计分）+ 接力（团体计分）+ 广播体操（不计分），三条报名全部通过 */
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

  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  // 接力与展示类都是「队伍」，人数必须 ≥2（D39）；这里各用一院的两人组，上限 1 队
  await meetService.configureMeetEvent({ templateId: 'relay-4x100', group: 'male', members: 2, perCollegeLimit: 1 }, admin);
  await meetService.configureMeetEvent({ templateId: 'show-gymnastics', group: 'mixed', members: 2, perCollegeLimit: 1 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead1' }, admin);
  await leadService.grantMeetCollegeLead({ collegeId: 'c02', userId: 'u_lead2' }, admin);
  await leadService.grantMeetCollegeLead({ collegeId: 'c03', userId: 'u_lead3' }, admin);

  const sprint = meetEventKey(meetId, 'sprint-100m', 'male');
  const relay = meetEventKey(meetId, 'relay-4x100', 'male');
  const show = meetEventKey(meetId, 'show-gymnastics', 'mixed');

  /** 报名 → 部长提交 → 管理员审核，一步都不省 */
  const enroll = async (eventKey, userIds, leadId) => {
    for (const userId of userIds) {
      const submittedInterest = await reg.submitMeetInterest(
        { eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(submittedInterest.ok, true, submittedInterest.message);
    }
    const submitted = await reg.submitMeetCollegeEntry(
      { eventKey, userIds }, await ctxOf(repo, leadId, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    const approved = await reg.reviewMeetEntry(
      { entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    assert.equal(approved.ok, true, approved.message);
  };

  // 100 米：三个学院各 1 人
  await enroll(sprint, ['u_a'], 'u_lead1');
  await enroll(sprint, ['u_b'], 'u_lead2');
  await enroll(sprint, ['u_c'], 'u_lead3');
  // 接力与展示类：只有一院报，两人一队
  await enroll(relay, ['u_a', 'u_a2'], 'u_lead1');
  await enroll(show, ['u_a', 'u_a2'], 'u_lead1');

  // 三个项目各一个场次，各派 3 名裁判
  for (const eventKey of [sprint, relay, show]) {
    await schedule.saveMeetSession({ eventKey, ...SESSION }, admin);
    const sessionKey = meetSessionKey(meetId, eventKey, 'final', 1);
    for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
      await schedule.assignMeetJudge({ sessionKey, judgeId }, admin);
    }
  }

  return { repo, meetId, admin, sprint, relay, show };
}

const sessionOf = (meetId, eventKey) => meetSessionKey(meetId, eventKey, 'final', 1);

/** 管理员代录某个裁判的分数（D70） */
async function giveScore(world, sessionKey, entryKey, judgeId, rawText, allowResubmit = false) {
  const saved = await score.saveMeetJudgeScore(
    { sessionKey, entryKey, judgeId, rawText, allowResubmit }, world.admin);
  assert.equal(saved.ok, true, saved.message);
  const submitted = await score.submitMeetJudgeScore(
    { sessionKey, entryKey, judgeId }, world.admin);
  assert.equal(submitted.ok, true, submitted.message);
}

/** 找某学院在某项目上的参赛记录 */
async function entryOf(world, eventKey, collegeId) {
  const list = await world.repo.sportsMeetEntries.list();
  const doc = list.find((row) => row.eventKey === eventKey && row.collegeId === collegeId && row.status === 'approved');
  assert.ok(doc, `${collegeId} 在 ${eventKey} 上没有通过审核的记录`);
  return doc._id;
}

test('三裁判去极值取平均：12.30 / 12.50 / 12.40 → 12.40', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');

  await giveScore(world, sessionKey, a, 'u_j1', '12.30');
  await giveScore(world, sessionKey, a, 'u_j2', '12.50');
  await giveScore(world, sessionKey, a, 'u_j3', '12.40');

  const preview = await score.getMeetResultPreview({ eventKey: sprint }, world.admin);
  assert.equal(preview.ok, true, preview.message);
  const row = preview.data.items.find((item) => item.entryKey === a);
  assert.equal(row.text, '12.40');
});

test('没收齐裁判成绩不能发布', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  await giveScore(world, sessionKey, a, 'u_j1', '12.30');

  const published = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  assert.equal(published.ok, false);
  assert.match(published.message, /没有收齐裁判成绩/);
});

test('名次与积分：第一 9 分、第二 7 分、第三 6 分', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  const b = await entryOf(world, sprint, 'c02');
  const c = await entryOf(world, sprint, 'c03');

  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, a, judgeId, '12.10');
    await giveScore(world, sessionKey, b, judgeId, '12.20');
    await giveScore(world, sessionKey, c, judgeId, '12.30');
  }

  const result = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  assert.equal(result.ok, true, result.message);
  const rows = result.data.publication.rows;
  assert.equal(rows.find((row) => row.entryKey === a).rank, 1);
  assert.equal(rows.find((row) => row.entryKey === a).points, 9);
  assert.equal(rows.find((row) => row.entryKey === b).points, 7);
  assert.equal(rows.find((row) => row.entryKey === c).points, 6);
});

test('并列：两人同成绩 → 1,1,3；各得该名次分（不守恒）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  const b = await entryOf(world, sprint, 'c02');
  const c = await entryOf(world, sprint, 'c03');

  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, a, judgeId, '12.20');
    await giveScore(world, sessionKey, b, judgeId, '12.20');
    await giveScore(world, sessionKey, c, judgeId, '12.40');
  }

  const result = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  const rows = result.data.publication.rows;
  assert.equal(rows.find((row) => row.entryKey === a).rank, 1);
  assert.equal(rows.find((row) => row.entryKey === b).rank, 1);
  assert.equal(rows.find((row) => row.entryKey === c).rank, 3, '竞赛排名应跳号');
  assert.equal(rows.find((row) => row.entryKey === a).points, 9);
  assert.equal(rows.find((row) => row.entryKey === b).points, 9, '并列各得该名次分');
  assert.equal(rows.find((row) => row.entryKey === c).points, 6);
});

test('无成绩：不参与名次、学院 0 分，绝不会按 0 秒排第一（A3）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  const b = await entryOf(world, sprint, 'c02');

  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, a, judgeId, '12.10');
    await giveScore(world, sessionKey, b, judgeId, '12.20');
  }
  // c03 缺席，不录分；发布时把 c03 标为无成绩
  const c = await entryOf(world, sprint, 'c03');

  const result = await score.publishMeetResults(
    { eventKey: sprint, voidEntryKeys: [c] }, world.admin);
  assert.equal(result.ok, true, '管理员明确标无成绩后，无需伪造一条数值才能发布');

  // 给 c03 录一个无效尝试：先正常录，再标无成绩
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, c, judgeId, '13.00');
  }
  const published = await score.publishMeetResults(
    { eventKey: sprint, voidEntryKeys: [c] }, world.admin);
  assert.equal(published.ok, true, published.message);
  const row = published.data.publication.rows.find((item) => item.entryKey === c);
  assert.equal(row.status, 'void');
  assert.equal(row.rank, null);
  assert.equal(row.points, 0);

  const top = published.data.publication.rows.find((item) => item.entryKey === a);
  assert.equal(top.rank, 1, '无成绩不能挤掉第一名');
});

test('团体项目积分翻倍，展示类不计分（D72／N16）', async () => {
  const world = await makeWorld();
  const { meetId, relay, show } = world;

  for (const [eventKey, value, base] of [[relay, '50.00', 18], [show, '90.0', 0]]) {
    const sessionKey = sessionOf(meetId, eventKey);
    const a = await entryOf(world, eventKey, 'c01');
    for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
      await giveScore(world, sessionKey, a, judgeId, value);
    }
    const result = await score.publishMeetResults({ eventKey }, world.admin);
    assert.equal(result.ok, true, result.message);
    const row = result.data.publication.rows.find((item) => item.entryKey === a);
    assert.equal(row.rank, 1);
    assert.equal(row.points, base, `${eventKey} 第 1 名应得 ${base} 分`);
  }
});

test('重复发布换版本，读端只认当前版本（D87）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  const b = await entryOf(world, sprint, 'c02');
  const c = await entryOf(world, sprint, 'c03');

  // 发布要求所有通过审核的记录都收齐裁判成绩，三条都要录
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, a, judgeId, '12.10');
    await giveScore(world, sessionKey, b, judgeId, '12.20');
    await giveScore(world, sessionKey, c, judgeId, '12.30');
  }
  const first = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  assert.equal(first.data.publication.version, 1);

  // 更正：b 的成绩改成更快（已提交的分数要显式 allowResubmit 才能覆盖）
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    await giveScore(world, sessionKey, b, judgeId, '12.00', true);
  }
  const second = await score.publishMeetResults({ eventKey: sprint, reason: '计时更正' }, world.admin);
  assert.equal(second.ok, true, `第二次发布失败：${second.message}`);
  assert.equal(second.data.publication.version, 2);

  const read = await score.getPublishedResults({ eventKey: sprint }, world.admin);
  assert.equal(read.data.publication.version, 2);
  assert.equal(read.data.items.find((row) => row.entryKey === b).rank, 1, '更正后名次应更新');
  assert.equal(read.data.items.length, 3, '旧版本行不应混进结果');

  // D87 是「无痕更正」：版本号递增用于幂等，但行数据被覆盖，不保留旧版本供追溯
  const allRows = await world.repo.sportsMeetResultRows.list();
  assert.deepEqual([...new Set(allRows.map((row) => row.version))], [2], '结果行应被新版本覆盖');
});

test('未指派裁判的场次不能发布', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
    // N4：撤换前必须先有成绩
    await markSubmitted(world.repo, {
      schoolId: SCHOOL, meetId, eventKey: sprint, sessionKey, judgeId,
    });
    await schedule.removeMeetJudge({ sessionKey, judgeId }, world.admin);
  }
  const published = await score.publishMeetResults({ eventKey: sprint }, world.admin);
  assert.equal(published.ok, false);
  assert.match(published.message, /还没有指派裁判/);
});

test('非裁判不能录分；管理员可代录（D70）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');

  const outsider = await score.saveMeetJudgeScore(
    { sessionKey, entryKey: a, rawText: '12.30' }, await ctxOf(world.repo, 'u_b', meetId));
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /不是该场次的裁判/);

  const byAdmin = await score.saveMeetJudgeScore(
    { sessionKey, entryKey: a, judgeId: 'u_j1', rawText: '12.30' }, world.admin);
  assert.equal(byAdmin.ok, true, byAdmin.message);
});

test('成绩越界被拒（计时 0 秒、超过 2 位小数）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');

  const zero = await score.saveMeetJudgeScore(
    { sessionKey, entryKey: a, judgeId: 'u_j1', rawText: '0' }, world.admin);
  assert.equal(zero.ok, false);

  const tooPrecise = await score.saveMeetJudgeScore(
    { sessionKey, entryKey: a, judgeId: 'u_j1', rawText: '12.345' }, world.admin);
  assert.equal(tooPrecise.ok, false);
  assert.match(tooPrecise.message, /小数位数/);
});

test('已提交的分数不能悄悄覆盖（需显式重提）', async () => {
  const world = await makeWorld();
  const { meetId, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  const a = await entryOf(world, sprint, 'c01');
  await giveScore(world, sessionKey, a, 'u_j1', '12.30');

  const overwrite = await score.saveMeetJudgeScore(
    { sessionKey, entryKey: a, judgeId: 'u_j1', rawText: '12.20' }, world.admin);
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.message, /已提交/);
});


test('裁判保存后被停用，使用旧上下文提交仍被拒绝', async () => {
  const world = await makeWorld();
  const judge = await ctxOf(world.repo,'u_j1',world.meetId);
  const sessionKey = sessionOf(world.meetId,world.sprint);
  const entryKey = await entryOf(world,world.sprint,'c01');
  assert.equal((await score.saveMeetJudgeScore({sessionKey,entryKey,rawText:'12.30'},judge)).ok,true);
  const user = await world.repo.users.getById('u_j1');
  await world.repo.users.set('u_j1',{...user,platformStatus:'inactive'});
  assert.equal((await score.submitMeetJudgeScore({sessionKey,entryKey},judge)).ok,false);
});

test('普通成员可看发布成绩，公开名单不回退显示真实姓名', async () => {
  const world = await makeWorld();
  const sessionKey = sessionOf(world.meetId,world.sprint);
  for (const college of COL) {
    const entryKey = await entryOf(world,world.sprint,college);
    for (const judgeId of ['u_j1','u_j2','u_j3']) await giveScore(world,sessionKey,entryKey,judgeId,'12.30');
  }
  const user = await world.repo.users.getById('u_a');
  await world.repo.users.set('u_a',{...user,realName:'不能公开的真名',nickName:''});
  assert.equal((await score.publishMeetResults({eventKey:world.sprint},world.admin)).ok,true);
  const member = await ctxOf(world.repo,'u_b',world.meetId);
  const listed = await score.listMeetPublishedResults({},member);
  assert.equal(listed.ok,true,listed.message);
  assert.equal(listed.data.items.length,1);
  assert.equal(JSON.stringify(listed).includes('不能公开的真名'),false);
  const privateView = await score.getMeetSessionScores({sessionKey},member);
  assert.equal(privateView.data.items.length,0);
});


test('发布时检测事务前快照过期，不写出混合版本成绩', async () => {
  const world=await makeWorld();
  const sessionKey=sessionOf(world.meetId,world.sprint);
  for(const college of COL){
    const entryKey=await entryOf(world,world.sprint,college);
    for(const judgeId of ['u_j1','u_j2','u_j3'])await giveScore(world,sessionKey,entryKey,judgeId,'12.30');
  }
  const transaction=world.repo.transaction;
  let intercepted=false;
  world.repo.transaction=async fn=>{
    if(!intercepted){
      intercepted=true;
      const event=await world.repo.sportsMeetEvents.getById(world.sprint);
      await world.repo.sportsMeetEvents.set(world.sprint,{...event,revision:Number(event.revision||0)+1});
    }
    return transaction(fn);
  };
  const result=await score.publishMeetResults({eventKey:world.sprint},world.admin);
  assert.equal(result.ok,false);
  assert.match(result.message,/变化/);
  assert.equal((await world.repo.sportsMeetPublications.list()).length,0);
  assert.equal((await world.repo.sportsMeetStandings.list()).length,0);
});

test('按项目下推：预览 / 发布 / 已发布结果 / 报名池只读本项目，不再整届扫描（第五轮 B）', async () => {
  const world = await makeWorld();
  const { repo, meetId, admin, sprint } = world;
  const sessionKey = sessionOf(meetId, sprint);
  // 三名裁判全部交卷、三个学院的参赛记录都收齐才能发布（缺分不发）
  let tick = 0;
  for (const collegeId of ['c01', 'c02', 'c03']) {
    const entryKey = await entryOf(world, sprint, collegeId);
    for (const judgeId of ['u_j1', 'u_j2', 'u_j3']) {
      tick += 1;
      await giveScore(world, sessionKey, entryKey, judgeId, `12.${30 + tick}`);
    }
  }
  const published = await score.publishMeetResults({ eventKey: sprint }, admin);
  assert.equal(published.ok, true, published.message);

  // 记录 forMeet 表面上的每一次读：改造前这些接口走的是 `.list()`（读一届的全部
  // 报名/成绩/场次/快照），改造后必须全部是 `.listByProject()`。
  const used = [];
  const rawForMeet = repo.forMeet.bind(repo);
  repo.forMeet = (scope) => {
    const surface = rawForMeet(scope);
    const keys = ['sportsMeetEntries', 'sportsMeetSessions', 'sportsMeetScores',
      'sportsMeetPublications', 'sportsMeetResultRows', 'sportsMeetJudgeAssignments', 'sportsMeetInterests'];
    for (const key of keys) {
      for (const name of ['list', 'listByProject']) {
        const raw = surface[key] && surface[key][name];
        if (typeof raw !== 'function') continue;
        surface[key][name] = (...args) => { used.push(`${key}.${name}`); return raw(...args); };
      }
    }
    return surface;
  };
  const unscoped = () => used.filter((name) => name.endsWith('.list'));

  used.length = 0;
  assert.equal((await score.getMeetResultPreview({ eventKey: sprint }, admin)).ok, true);
  assert.deepEqual(unscoped(), [], `预览不该整届读：${used.join(', ')}`);
  assert.ok(used.includes('sportsMeetEntries.listByProject'), '报名应当按项目下推');

  used.length = 0;
  assert.equal((await score.getPublishedResults({ eventKey: sprint }, admin)).ok, true);
  assert.deepEqual(unscoped(), [], `已发布结果不该整届读：${used.join(', ')}`);

  used.length = 0;
  const pool = await reg.getMeetApplicantPool({ eventKey: sprint, collegeId: 'c01' }, admin);
  assert.equal(pool.ok, true, pool.message);
  assert.deepEqual(unscoped(), [], `报名池不该整届读：${used.join(', ')}`);
});
