/**
 * 批量指派裁判 + 录分入口（B9c）
 * ============================================================
 * 两条动因：
 *   · 「连续几个项目都是同一批裁判」——逐个场次逐个裁判地派不现实；
 *   · 预赛分多组后，只派了第 1 组，其余组在裁判端根本没有入口。
 *
 * 同时补上一处**与裁决相反**的旧实现：removeMeetJudge 的注释写「只允许撤换
 * 还没提交成绩的裁判」，而 N4 的裁决是「只允许撤换**已提交成绩**的裁判」
 * （分母按原始指派算，撤掉没交的人会让本场永远凑不齐全员提交）。
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
const COLLEGES = ['c01', 'c02'];
const LEAD = { c01: 'u_l1', c02: 'u_l2' };
const JUDGES = ['u_j1', 'u_j2', 'u_j3'];

// 每院 15 人：30 人 / 每组 15 = 2 个预赛组
const STUDENTS = {};
for (const c of COLLEGES) {
  STUDENTS[c] = Array.from({ length: 15 }, (_, i) => `u_${c}_${i + 1}`);
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
  for (const c of COLLEGES) {
    await leadService.grantMeetCollegeLead({ collegeId: c, userId: LEAD[c] }, admin);
  }

  const eventKey = meetEventKey(meetId, 'middle-1500m', 'male');
  await meetService.configureMeetEvent(
    { templateId: 'middle-1500m', group: 'male', perCollegeLimit: 15 }, admin);
  // 预赛+决赛：分组后会有 2 个预赛组 + 1 个决赛，共 3 个场次
  await meetService.setMeetEventProcedure({
    eventKey, rounds: 'heat_final', heatCapacity: 15, advance: { mode: 'per_heat', count: 1 },
  }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  for (const c of COLLEGES) {
    for (const student of STUDENTS[c]) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, student, meetId));
      assert.equal(interest.ok, true, interest.message);
    }
    for (const student of STUDENTS[c]) {
      const submitted = await reg.submitMeetCollegeEntry(
        { eventKey, userIds: [student] }, await ctxOf(repo, LEAD[c], meetId));
      assert.equal(submitted.ok, true, submitted.message);
      await reg.reviewMeetEntry({ entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    }
  }

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 9 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heatCount, 2);

  return {
    repo, meetId, admin, eventKey,
    heats: [meetSessionKey(meetId, eventKey, 'heat', 1), meetSessionKey(meetId, eventKey, 'heat', 2)],
    final: meetSessionKey(meetId, eventKey, 'final', 1),
  };
}

test('批量指派到整个项目：一次派出全部场次', async () => {
  const { admin, heats, final } = await makeWorld();
  const result = await schedule.assignMeetJudges({ judgeIds: JUDGES, eventKey: null }, admin);
  assert.equal(result.ok, false, '不传范围应当被拒绝');

  const world = await makeWorld();
  const byEvent = await schedule.assignMeetJudges(
    { judgeIds: JUDGES, eventKey: world.eventKey }, world.admin);
  assert.equal(byEvent.ok, true, byEvent.message);
  assert.equal(byEvent.data.sessionCount, 3, '2 个预赛组 + 1 个决赛');
  assert.equal(byEvent.data.created, 9, '3 名裁判 × 3 个场次');
  assert.equal(byEvent.data.existed, 0);

  // 每个场次都拿到 3 名裁判
  for (const sessionKey of [...world.heats, world.final]) {
    const session = await world.repo.sportsMeetSessions.getById(sessionKey);
    assert.equal(session.judgeIds.length, 3, `${sessionKey} 应有 3 名裁判`);
    assert.equal(session.judgeCount, 3);
  }
  void heats; void final;
});

test('批量指派幂等：重复指派不产生重复记录', async () => {
  const world = await makeWorld();
  const first = await schedule.assignMeetJudges(
    { judgeIds: JUDGES, eventKey: world.eventKey }, world.admin);
  assert.equal(first.data.created, 9);
  const second = await schedule.assignMeetJudges(
    { judgeIds: JUDGES, eventKey: world.eventKey }, world.admin);
  assert.equal(second.ok, true, second.message);
  assert.equal(second.data.created, 0, '已指派的跳过');
  assert.equal(second.data.existed, 9);
});

test('批量指派校验资格：不在册或账号无效直接拒绝，且不落任何数据', async () => {
  const world = await makeWorld();
  const bad = await schedule.assignMeetJudges(
    { judgeIds: ['u_ghost'], eventKey: world.eventKey }, world.admin);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不是本校在册成员/);

  const sessions = await world.repo.sportsMeetSessions.list();
  for (const session of sessions) {
    assert.equal((session.judgeIds || []).length, 0, '资格校验失败不应留下半套指派');
  }
});

test('按日期范围批量指派', async () => {
  const world = await makeWorld();
  // 先给场次排时间，否则按日期匹配不到
  for (const [index, sessionKey] of [...world.heats, world.final].entries()) {
    const session = await world.repo.sportsMeetSessions.getById(sessionKey);
    const saved = await schedule.saveMeetSession({
      eventKey: world.eventKey,
      round: session.round,
      index: session.index,
      startAt: `2026-10-24T0${8 + index}:00`,
      venue: '田径场',
    }, world.admin);
    assert.equal(saved.ok, true, saved.message);
  }
  const byDate = await schedule.assignMeetJudges(
    { judgeIds: ['u_j1'], date: '2026-10-24' }, world.admin);
  assert.equal(byDate.ok, true, byDate.message);
  assert.equal(byDate.data.sessionCount, 3);
  assert.equal(byDate.data.created, 3);
});

test('多人多场按读写总预算拆事务也能全部完成', async () => {
  const world = await makeWorld();
  // 构造 40 个场次触发分批（直接写库，模拟大项目）。
  const many = [];
  for (let i = 1; i <= 40; i += 1) {
    const key = meetSessionKey(world.meetId, world.eventKey, 'final', i);
    await world.repo.sportsMeetSessions.set(key, {
      schoolId: SCHOOL, meetId: world.meetId, eventKey: world.eventKey,
      round: 'final', index: i, roundLabel: `决赛 第 ${i} 枪`,
      entryKeys: [], judgeIds: [], status: 'scheduled',
      startAt: `2026-10-24T10:00`, venue: '田径场', createdAt: T0, updatedAt: T0,
    });
    many.push(key);
  }
  const judges = ['u_j1', 'u_j2', 'u_j3', 'u_j4', 'u_j5'];
  // 补两个裁判账号（原世界只有 3 个）
  await world.repo.users.set('u_j4', {
    _id: 'u_j4', openId: 'o_u_j4', nickName: 'u_j4', realName: 'u_j4',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
  });
  await world.repo.users.set('u_j5', {
    _id: 'u_j5', openId: 'o_u_j5', nickName: 'u_j5', realName: 'u_j5',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
  });
  await world.repo.schoolMembers.set(schoolMemberKey('u_j4', SCHOOL), {
    _id: schoolMemberKey('u_j4', SCHOOL), schoolId: SCHOOL, userId: 'u_j4',
    collegeId: 'c01', status: 'active', gender: 'male',
  });
  await world.repo.schoolMembers.set(schoolMemberKey('u_j5', SCHOOL), {
    _id: schoolMemberKey('u_j5', SCHOOL), schoolId: SCHOOL, userId: 'u_j5',
    collegeId: 'c01', status: 'active', gender: 'male',
  });

  // 循环里 index=1 与 makeWorld 已建的决赛是同一个主键，所以实际新增 39 个，
  // 总计 2 预赛 + 40 个 final 位 = 42 场。
  const expected = 42;
  const result = await schedule.assignMeetJudges(
    { judgeIds: judges, eventKey: world.eventKey }, world.admin);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.sessionCount, expected, '全部场次都派到');
  assert.equal(result.data.created, expected * 5, `5 名裁判 × ${expected} 个场次`);

  // 抽查首尾两个场次的名单长度
  for (const key of [many[0], many[many.length - 1]]) {
    const session = await world.repo.sportsMeetSessions.getById(key);
    assert.equal(session.judgeIds.length, 5, `${key} 应有 5 名裁判`);
  }
});

test('N4：只能撤换已提交成绩的裁判', async () => {
  const world = await makeWorld();
  const sessionKey = world.heats[0];
  await schedule.assignMeetJudges(
    { judgeIds: ['u_j1'], eventKey: world.eventKey }, world.admin);

  // 未提交成绩就撤 → 拒绝（与旧实现的注释相反，这里按 N4 裁决）
  const early = await schedule.removeMeetJudge({ sessionKey, judgeId: 'u_j1' }, world.admin);
  assert.equal(early.ok, false);
  assert.match(early.message, /已提交成绩/);

  // 录一条并提交
  const session = await world.repo.sportsMeetSessions.getById(sessionKey);
  const entryKey = session.entryKeys[0];
  const saved = await score.saveMeetJudgeScore(
    { sessionKey, entryKey, judgeId: 'u_j1', rawText: '330.00' }, world.admin);
  assert.equal(saved.ok, true, `录分应成功：${saved.message}`);
  const submitted = await score.submitMeetJudgeScore(
    { sessionKey, entryKey, judgeId: 'u_j1' }, world.admin);
  assert.equal(submitted.ok, true, `提交应成功：${submitted.message}`);

  // 提交后可以撤，且分数保留在库
  const late = await schedule.removeMeetJudge({ sessionKey, judgeId: 'u_j1' }, world.admin);
  assert.equal(late.ok, true, late.message);
  const after = await world.repo.sportsMeetSessions.getById(sessionKey);
  assert.equal(after.judgeIds.includes('u_j1'), false, '名单里应去掉');
  const kept = await world.repo.sportsMeetScores.list();
  assert.ok(kept.some((doc) => doc.judgeId === 'u_j1'
    && doc.sessionKey === sessionKey && doc.state === 'submitted'), '已提交的分数应保留');
});

test('录分入口：同项目可查看，仅本场指派后可录分', async () => {
  const world = await makeWorld();
  // 只派第 1 个预赛组
  await schedule.assignMeetJudges(
    { judgeIds: ['u_j1'], sessionKeys: [world.heats[0]] }, world.admin);

  const view1 = await score.getMeetSessionScores(
    { sessionKey: world.heats[0] }, await ctxOf(world.repo, 'u_j1', world.meetId));
  assert.equal(view1.data.canEnter, true, '本场被指派');

  const view2 = await score.getMeetSessionScores(
    { sessionKey: world.heats[1] }, await ctxOf(world.repo, 'u_j1', world.meetId));
  assert.equal(view2.data.canEnter, false, '查看同项目不等于获得本场录分权限');

  // 完全没被指派的人仍不能录
  const view3 = await score.getMeetSessionScores(
    { sessionKey: world.heats[1] }, await ctxOf(world.repo, 'u_j2', world.meetId));
  assert.equal(view3.data.canEnter, false);

  // 管理员可代录
  const view4 = await score.getMeetSessionScores(
    { sessionKey: world.heats[1] }, world.admin);
  assert.equal(view4.data.canEnter, true);
});

test('场次清单：录分页据此做场次切换', async () => {
  const world = await makeWorld();
  await schedule.assignMeetJudges(
    { judgeIds: ['u_j1', 'u_j2'], eventKey: world.eventKey }, world.admin);

  const list = await schedule.listMeetEventSessions(
    { eventKey: world.eventKey }, await ctxOf(world.repo, 'u_j1', world.meetId));
  assert.equal(list.ok, true, list.message);
  assert.equal(list.data.items.length, 3);
  for (const item of list.data.items) {
    assert.equal(item.assignedToMe, true);
    assert.equal(item.judgeIds.length, 2);
  }
  assert.equal(list.data.items[0].round, 'heat');
  assert.equal(list.data.items[2].round, 'final');
});

test('裁判 ≥5 人时给出风险提示，3 人时不给（Q2：只提示、不拦截）', async () => {
  const three = await makeWorld();
  await schedule.assignMeetJudges(
    { judgeIds: JUDGES, sessionKeys: [three.heats[0]] }, three.admin);
  const small = await score.getMeetResultPreview(
    { eventKey: three.eventKey, sessionKey: three.heats[0] }, three.admin);
  assert.equal(small.ok, true, small.message);
  assert.equal(small.data.warning, '', '3 名裁判不应提示');

  const five = await makeWorld();
  for (const id of ['u_j4', 'u_j5']) {
    await five.repo.users.set(id, {
      _id: id, openId: `o_${id}`, nickName: id, realName: id,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
    });
    await five.repo.schoolMembers.set(schoolMemberKey(id, SCHOOL), {
      _id: schoolMemberKey(id, SCHOOL), schoolId: SCHOOL, userId: id,
      collegeId: 'c01', status: 'active', gender: 'male',
    });
  }
  const assigned = await schedule.assignMeetJudges(
    { judgeIds: [...JUDGES, 'u_j4', 'u_j5'], sessionKeys: [five.heats[0]] }, five.admin);
  assert.equal(assigned.data.created, 5);

  const big = await score.getMeetResultPreview(
    { eventKey: five.eventKey, sessionKey: five.heats[0] }, five.admin);
  assert.equal(big.ok, true, big.message);
  assert.match(big.data.warning, /无人读出过的成绩/);

  // 只提示不拦截：发布仍然走到「缺成绩」这一步，而不是被裁判人数挡住
  const published = await score.publishMeetResults(
    { eventKey: five.eventKey, sessionKey: five.heats[0] }, five.admin);
  assert.equal(published.ok, false);
  assert.match(published.message, /没有收齐/);
});

/**
 * 开赛与录分的耦合（F9）
 * ============================================================
 * 「开赛」原先只由赛程页的按钮触发，而录分不看届次状态：裁判能直接录分，
 * 届次却停在「赛程已发布」。现在首次录分即视为开赛。
 */

/** 把预赛/决赛都排上时间与场地，再发布赛程（届次转为 scheduled） */
async function publishReadySchedule(world) {
  for (const [index, sessionKey] of [...world.heats, world.final].entries()) {
    const session = await world.repo.sportsMeetSessions.getById(sessionKey);
    const saved = await schedule.saveMeetSession({
      eventKey: world.eventKey,
      round: session.round,
      index: session.index,
      startAt: `2026-10-24T${String(8 + index).padStart(2, '0')}:00`,
      venue: '田径场',
    }, world.admin);
    assert.equal(saved.ok, true, saved.message);
  }
  const published = await schedule.publishMeetSchedule({}, world.admin);
  assert.equal(published.ok, true, published.message);
  assert.equal(published.data.meet.status, 'scheduled');
}

/** 取某场次的第一条参赛记录，供录分使用 */
async function firstEntryOf(world, sessionKey) {
  const session = await world.repo.sportsMeetSessions.getById(sessionKey);
  return { session, entryKey: (session.entryKeys || [])[0] };
}

test('首次录分即开赛：届次与场次都从「未开始」推进到「进行中」', async () => {
  const world = await makeWorld();
  await publishReadySchedule(world);
  const assigned = await schedule.assignMeetJudges({ judgeIds: ['u_j1'], eventKey: world.eventKey }, world.admin);
  assert.equal(assigned.ok, true, assigned.message);

  const { entryKey, session } = await firstEntryOf(world, world.heats[0]);
  assert.equal(session.status, 'scheduled', '抽签后的场次还没开始');

  const saved = await score.saveMeetJudgeScore(
    { sessionKey: world.heats[0], entryKey, rawText: '275.20' },
    await ctxOf(world.repo, 'u_j1', world.meetId));
  assert.equal(saved.ok, true, saved.message);

  const meet = await world.repo.sportsMeets.getById(world.meetId);
  assert.equal(meet.status, 'running', '录了第一条成绩，届次就应进入「进行中」');
  const after = await world.repo.sportsMeetSessions.getById(world.heats[0]);
  assert.equal(after.status, 'running');
  assert.ok(after.startedAt, '场次要记下开赛时间');
});

test('已开赛的届次再录分：状态不变、版本号不重复自增', async () => {
  const world = await makeWorld();
  await publishReadySchedule(world);
  await schedule.assignMeetJudges({ judgeIds: ['u_j1'], eventKey: world.eventKey }, world.admin);

  const first = await firstEntryOf(world, world.heats[0]);
  await score.saveMeetJudgeScore(
    { sessionKey: world.heats[0], entryKey: first.entryKey, rawText: '275.20' },
    await ctxOf(world.repo, 'u_j1', world.meetId));
  const started = await world.repo.sportsMeets.getById(world.meetId);

  await score.saveMeetJudgeScore(
    { sessionKey: world.heats[0], entryKey: first.entryKey, rawText: '275.30' },
    await ctxOf(world.repo, 'u_j1', world.meetId));
  const again = await world.repo.sportsMeets.getById(world.meetId);

  assert.equal(again.status, 'running');
  assert.equal(again.version, started.version, '已在进行中，不该再抬版本');
});

test('已结束的届次不会被录分「重新开赛」', async () => {
  const world = await makeWorld();
  await publishReadySchedule(world);
  await schedule.assignMeetJudges({ judgeIds: ['u_j1'], eventKey: world.eventKey }, world.admin);

  const finished = await world.repo.sportsMeets.getById(world.meetId);
  await world.repo.sportsMeets.set(world.meetId, { ...finished, status: 'finished' });

  const { entryKey } = await firstEntryOf(world, world.heats[0]);
  await score.saveMeetJudgeScore(
    { sessionKey: world.heats[0], entryKey, rawText: '275.20' },
    await ctxOf(world.repo, 'u_j1', world.meetId));

  const meet = await world.repo.sportsMeets.getById(world.meetId);
  assert.equal(meet.status, 'finished', '只允许 scheduled → running，不倒退也不复活');
});
