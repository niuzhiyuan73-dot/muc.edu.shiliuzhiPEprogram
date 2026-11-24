/**
 * 配置与赛制的补充覆盖（2026-10-18）
 * ============================================================
 * 这一组盯的是「页面上点了没反应 / 点了反而错」的那几处：
 *   · 不限人数与不限名额：入场式展示必须能报任意人数、任意队数；
 *   · 删除项目：继续配置时要能把已选项目去掉，且发布后不能再删；
 *   · 代报学院列表：校管理员要能选/搜学院，学院部长拿不到全院名单；
 *   · 小组+淘汰：小组赛打完自动出线，淘汰赛打完自动出名次；
 *   · 裁判名单：显示真实姓名，撤销后人数跟着变（不再靠一个会漂移的计数）。
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
const markSubmitted = require('./helpers/judge-score.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const COLLEGES = ['c01', 'c02', 'c03', 'c04'];
const LEAD = { c01: 'u_l1', c02: 'u_l2', c03: 'u_l3', c04: 'u_l4' };
const STUDENTS = {
  c01: ['u_a1', 'u_a2', 'u_a3', 'u_a4'], c02: ['u_b1', 'u_b2', 'u_b3'],
  c03: ['u_c1', 'u_c2', 'u_c3'], c04: ['u_d1', 'u_d2', 'u_d3'],
};
const NAMES = {
  u_admin: '校管理员',
  u_a1: '甲一', u_a2: '甲二', u_a3: '甲三', u_a4: '甲四',
  u_b1: '乙一', u_b2: '乙二', u_b3: '乙三',
  u_c1: '丙一', u_c2: '丙二', u_c3: '丙三',
  u_d1: '丁一', u_d2: '丁二', u_d3: '丁三',
  u_l1: '部长一', u_l2: '部长二', u_l3: '部长三', u_l4: '部长四',
  u_j1: '裁判一', u_j2: '裁判二', u_j3: '裁判三',
};

const ids = ['u_admin', ...Object.keys(NAMES)];
const users = ids.map((id) => ({
  _id: id,
  openId: `o_${id}`,
  // 姓名只在 nickName / realName 上，没有 name —— 与线上账号一致
  nickName: NAMES[id] || '',
  realName: NAMES[id] || '',
  platformStatus: 'active',
  platformRole: 'member',
  primarySchoolId: SCHOOL,
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

test('不限人数与不限名额：入场式展示可以任意人数、任意队数', async () => {
  const world = await makeWorld();
  const { meetId, admin, enroll } = world;
  const eventKey = meetEventKey(meetId, 'show-parade', 'mixed');

  const configured = await meetService.configureMeetEvent({
    templateId: 'show-parade', group: 'mixed', members: 0, perCollegeLimit: 0,
  }, admin);
  assert.equal(configured.ok, true, configured.message);
  assert.equal(configured.data.event.membersUnlimited, true);
  assert.equal(configured.data.event.limitUnlimited, true);

  await meetService.publishMeetRegistration(WINDOW, admin);
  // 3 个人一队也能报（不限人数）
  await enroll(eventKey, STUDENTS.c01.slice(0, 3), LEAD.c01);
  // 同一学院报第二队：D25 规定本院本项目提交后意向入口关闭，所以第 4 个学生
  // 的意向要在第一次提交之前就交（这里补交会被拒，属于预期规则而不是缺陷）
  const late = await reg.submitMeetInterest(
    { eventKey }, await ctxOf(world.repo, STUDENTS.c01[3], meetId));
  assert.equal(late.ok, false, '提交后意向入口应关闭（D25）');
});

test('删除项目：草稿可删，删完列表里不再出现，发布后拒绝', async () => {
  const world = await makeWorld();
  const { meetId, admin } = world;
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await meetService.configureMeetEvent({ templateId: 'sprint-200m', group: 'male' }, admin);
  const key = meetEventKey(meetId, 'sprint-100m', 'male');

  const removed = await meetService.removeMeetEvent({ eventKey: key }, admin);
  assert.equal(removed.ok, true, removed.message);
  assert.equal(removed.data.eventCount, 1);

  const detail = await meetService.getSportsMeet({}, admin);
  assert.deepEqual(detail.data.events.map((row) => row.templateId), ['sprint-200m']);

  await meetService.publishMeetRegistration(WINDOW, admin);
  const late = await meetService.removeMeetEvent(
    { eventKey: meetEventKey(meetId, 'sprint-200m', 'male') }, admin);
  assert.equal(late.ok, false);
  assert.match(late.message, /已发布报名/);
});

test('代报学院列表：校管理员可读，学院部长被拒', async () => {
  const world = await makeWorld();
  const { meetId, admin } = world;
  const all = await meetService.listMeetColleges({}, admin);
  assert.equal(all.ok, true, all.message);
  assert.equal(all.data.items.length, 4);

  const searched = await meetService.listMeetColleges({ keyword: '2 院' }, admin);
  assert.equal(searched.ok, true);
  assert.equal(searched.data.items.length, 1);
  assert.equal(searched.data.items[0].collegeId, 'c02');

  const lead = await meetService.listMeetColleges({}, await ctxOf(world.repo, 'u_l1', meetId));
  assert.equal(lead.ok, false);
  assert.match(lead.message, /校级管理员/);
});

test('代报：管理员选定学院后能看到该院项目与名额', async () => {
  const world = await makeWorld();
  const { meetId, admin } = world;
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  const board = await reg.listMeetCollegeEvents({ collegeId: 'c02' }, admin);
  assert.equal(board.ok, true, board.message);
  assert.equal(board.data.collegeId, 'c02');
  assert.equal(board.data.byAdmin, true);
  assert.equal(board.data.items.length, 1);
  assert.equal(board.data.items[0].limit, 3);
});

test('裁判名单：显示真实姓名、撤销后人数同步、开赛判定跟着变', async () => {
  const world = await makeWorld();
  const { meetId, admin } = world;
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await schedule.saveMeetSession({
    eventKey, round: 'final', index: 1, startAt: '2026-10-24 09:00', venue: '田径场',
  }, admin);
  const sessionKey = meetSessionKey(meetId, eventKey, 'final', 1);

  const candidates = await schedule.listMeetJudgeCandidates({}, admin);
  assert.equal(candidates.ok, true, candidates.message);
  const names = candidates.data.items.map((row) => row.name);
  assert.equal(names.includes('未命名'), false, '姓名应取 nickName / realName');
  assert.equal(names.includes('裁判一'), true);

  const searched = await schedule.listMeetJudgeCandidates({ keyword: '裁判二' }, admin);
  assert.deepEqual(searched.data.items.map((row) => row.name), ['裁判二']);

  await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_j1' }, admin);
  await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_j2' }, admin);
  let doc = await world.repo.sportsMeetSessions.getById(sessionKey);
  assert.deepEqual(doc.judgeIds, ['u_j1', 'u_j2']);
  assert.equal(doc.judgeCount, 2);

  // N4：撤换前必须先有成绩，否则本场永远凑不齐全员提交
  for (const judgeId of ['u_j1', 'u_j2']) {
    await markSubmitted(world.repo, {
      schoolId: SCHOOL, meetId, eventKey, sessionKey, judgeId,
    });
  }
  await schedule.removeMeetJudge({ sessionKey, judgeId: 'u_j1' }, admin);
  doc = await world.repo.sportsMeetSessions.getById(sessionKey);
  assert.deepEqual(doc.judgeIds, ['u_j2']);
  assert.equal(doc.judgeCount, 1);

  await schedule.removeMeetJudge({ sessionKey, judgeId: 'u_j2' }, admin);
  const started = await schedule.startMeetEvent({ sessionKey }, admin);
  assert.equal(started.ok, false);
  assert.match(started.message, /还没有指派裁判/);
});

test('小组+淘汰：小组赛打完自动出线，淘汰赛打完自动出名次', async () => {
  const world = await makeWorld();
  const { meetId, admin, enroll } = world;
  const eventKey = meetEventKey(meetId, 'tug-of-war', 'mixed');
  const configured = await meetService.configureMeetEvent({
    templateId: 'tug-of-war', group: 'mixed', members: 2, perCollegeLimit: 1,
    format: 'group_knockout', groups: { count: 2, advancePerGroup: 1 },
  }, admin);
  assert.equal(configured.ok, true, configured.message);
  assert.deepEqual(configured.data.event.groups, { count: 2, advancePerGroup: 1 });

  await meetService.publishMeetRegistration(WINDOW, admin);
  const teamOf = {};
  for (const collegeId of COLLEGES) {
    teamOf[collegeId] = await enroll(eventKey, STUDENTS[collegeId].slice(0, 2), LEAD[collegeId]);
  }

  const drawn = await advance.drawMeetBracket({ eventKey, seed: 5 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  const groupMatches = drawn.data.matches.filter((row) => row.roundNo > 0 && row.entryKeys.some(Boolean));
  assert.ok(groupMatches.length >= 2, '每个小组至少一场');

  // 小组赛没打完 → 不能发布
  const early = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(early.ok, false);
  assert.match(early.message, /小组赛/);

  const sessions = await world.repo.sportsMeetSessions.list();
  const groupSessions = sessions.filter((row) => row.eventKey === eventKey && row.round.startsWith('g'));
  for (const session of groupSessions) {
    // 每组由第一方取胜：c01>c02、c03>c04（分组由种子决定，这里只保证每场都判胜）
    const won = await advance.setMeetMatchWinner(
      { sessionKey: session._id, winnerEntryKey: session.entryKeys[0] },
      admin,
    );
    assert.equal(won.ok, true, won.message);
  }

  const bracket = await advance.getMeetBracket({ eventKey }, admin);
  assert.equal(bracket.ok, true, bracket.message);
  assert.equal(bracket.data.groupStage.complete, true);
  const finalMatch = bracket.data.matches.find((row) => row.roundNo === 1 && row.stage === 'knockout');
  assert.equal(finalMatch.entryKeys.filter(Boolean).length, 2, '两个小组第一出线进决赛');

  const finished = await advance.setMeetMatchWinner(
    { sessionKey: finalMatch.sessionKey, winnerEntryKey: finalMatch.entryKeys[0] }, admin);
  assert.equal(finished.ok, true, finished.message);

  const published = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(published.ok, true, published.message);
  const rows = published.data.publication.rows;
  assert.deepEqual(rows.map((row) => row.rank).sort(), [1, 2, 3, 3]);
  // 团体项目 ×2：18 / 14 / 12 / 12
  assert.deepEqual(rows.map((row) => row.points).sort((a, b) => b - a), [18, 14, 12, 12]);
});


test('小组边界同分全部出线时扩充淘汰签表，六队不会被截成两队', async () => {
  const world = await makeWorld();
  const {repo,meetId,admin}=world;
  const eventKey=meetEventKey(meetId,'tug-of-war','mixed');
  await meetService.configureMeetEvent({templateId:'tug-of-war',group:'mixed',format:'group_knockout',groups:{count:2,advancePerGroup:1}},admin);
  const event=await repo.sportsMeetEvents.getById(eventKey);
  await repo.sportsMeetEvents.set(eventKey,{...event,bracket:{format:'group_knockout',size:2,totalRounds:1,groups:{count:2,advancePerGroup:1},groupEntries:{1:['a','b','c'],2:['d','e','f']}}});
  for (const [group, keys] of [[1,['a','b','c']],[2,['d','e','f']]]) {
    for (let i=0;i<3;i++) {
      const key=meetSessionKey(meetId,eventKey,'g'+group,i+1);
      await repo.sportsMeetSessions.set(key,{schoolId:SCHOOL,meetId,eventKey,round:'g'+group,index:i+1,entryKeys:[keys[i],keys[(i+1)%3]],winnerEntryKey:''});
    }
  }
  const finalKey=meetSessionKey(meetId,eventKey,'r1',1);
  await repo.sportsMeetSessions.set(finalKey,{schoolId:SCHOOL,meetId,eventKey,round:'r1',index:1,entryKeys:[null,null],winnerEntryKey:''});
  const groups=(await repo.sportsMeetSessions.list()).filter(row=>row.round.startsWith('g'));
  for (const match of groups) {
    const result=await advance.setMeetMatchWinner({sessionKey:match._id,winnerEntryKey:match.entryKeys[0]},admin);
    assert.equal(result.ok,true,result.message);
  }
  const updated=await repo.sportsMeetEvents.getById(eventKey);
  assert.equal(updated.bracket.size,8);
  const first=(await repo.sportsMeetSessions.list()).filter(row=>row.eventKey===eventKey && row.round==='r1');
  assert.deepEqual(first.flatMap(row=>row.entryKeys).filter(Boolean).sort(),['a','b','c','d','e','f']);
});
