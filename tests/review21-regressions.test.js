const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { buildMeetContext } = require('../src/server/services/meet-context');
const { buildDirectory } = require('../src/server/services/school-actor');
const { accountDirectoryFields } = require('../src/server/services/account-directory');
const { schoolMemberKey, associationGroupMemberKey } = require('../src/shared/utils/school');
const C = require('../src/shared/utils/constants');
const college = require('../src/server/services/school-college-service');
const groups = require('../src/server/services/association-group-service');
const advance = require('../src/server/services/meet-advance-service');
const scope = { schoolId: 'muc', association: 'pkb' };
const now = new Date('2026-11-16T00:00:00Z');
const actorId = 'demo_muc_admin';

async function fixture(count = 0, target = scope) {
  const seed = createSchoolDemoSeed();
  const ids = Array.from({ length: count }, (_, i) => 'new' + String(i).padStart(5, '0'));
  for (const id of ids) {
    const user = { _id: id, nickName: id, primarySchoolId: 'muc', platformStatus: 'active', gender: 'M' };
    seed.users.push({ ...user, ...accountDirectoryFields(user) });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', collegeId: 'c01', status: 'active' });
  }
  seed.users = seed.users.map(user => ({ ...user, ...accountDirectoryFields(user) }));
  const db = database(seed), repo = createRepo(db);
  const context = id => buildSchoolContext({ repo, actorId: id, scope: target, now });
  return { db, repo, ids, context, ctx: await context(actorId) };
}
async function publish(f, extra = {}) {
  const result = (await college.publishCollegeEvent({ requestId: 'review21', title: '学院团体赛',
    legPlan: [C.LEG_DISCIPLINE.MS], rosterMin: 1, rosterMax: 30, tieAlgo: C.TIE_ALGO.FULL_POINTS,
    tieNetMode: C.TIE_NET_MODE.WIN_DIFF, startTime: '2026-11-17T00:00:00Z', location: '体育馆', courtCount: 1, ...extra }, f.ctx)).data;
  assert.equal(result.ok, true, result.message);
  return result.event.eventId;
}
const submit = (f, eventId, memberIds, collegeId = 'c01') => college.submitCollegeEntry({ eventId, collegeId, memberIds }, f.ctx).then(r => r.data);
async function createGroup(f) {
  const result = (await groups.createAssociationGroup({ requestId: 'review21', name: '容量测试组', memberIds: [] }, f.ctx)).data;
  assert.equal(result.ok, true, result.message);
  return result.group.groupId;
}
const add = (f, groupId, memberIds) => groups.addAssociationGroupMembers({ groupId, memberIds }, f.ctx).then(r => r.data);

for (const invalid of ['disabled', 'foreign', 'missing']) test('学院名单拒绝当前' + invalid + '账号', async () => {
  const f = await fixture(1), eventId = await publish(f), id = invalid === 'missing' ? 'absent' : f.ids[0];
  const user = await f.repo.users.getById(id);
  if (invalid === 'missing') await f.repo.schoolMembers.set(schoolMemberKey(id, 'muc'),
    { userId: id, schoolId: 'muc', collegeId: 'c01', status: 'active' });
  else await f.repo.users.set(id, { ...user, ...(invalid === 'foreign' ? { primarySchoolId: 'buaa' } : { platformStatus: invalid }) });
  const result = await submit(f, eventId, [id]);
  assert.equal(result.ok, false);
  assert.equal((await f.repo.forScope(scope).collegeEntries.listByEvent(eventId)).length, 0);
});

for (const invalid of ['disabled', 'left', 'college']) test('学院名单事务内拒绝在途资格变化：' + invalid, async () => {
  const f = await fixture(1), eventId = await publish(f), id = f.ids[0];
  f.db.beforeTransaction = async () => {
    if (invalid === 'disabled') {
      const user = await f.repo.users.getById(id);
      await f.repo.users.set(id, { ...user, platformStatus: 'disabled' });
    } else {
      const key = schoolMemberKey(id, 'muc'), row = await f.repo.schoolMembers.getById(key);
      await f.repo.schoolMembers.set(key, { ...row, ...(invalid === 'left' ? { status: 'left' } : { collegeId: 'c02' }) });
    }
  };
  assert.equal((await submit(f, eventId, [id])).ok, false);
  assert.equal((await f.repo.forScope(scope).collegeEntries.listByEvent(eventId)).length, 0);
});

test('不同学院的并发提交均成功，同时继续维护供抽签复核的版本', async () => {
  const f = await fixture(2), eventId = await publish(f), id = f.ids[1];
  const key = schoolMemberKey(id, 'muc'), row = await f.repo.schoolMembers.getById(key);
  await f.repo.schoolMembers.set(key, { ...row, collegeId: 'c02' });
  let second;
  f.db.beforeTransaction = async () => { second = await submit(f, eventId, [id], 'c02'); };
  assert.equal((await submit(f, eventId, [f.ids[0]])).ok, true);
  assert.equal(second.ok, true);
  assert.equal((await f.repo.forScope(scope).collegeEntries.listByEvent(eventId)).length, 2);
});

test('小组一次添加30人自动分批，重试不重复计数，所有事务均在预算内', async () => {
  const f = await fixture(30), groupId = await createGroup(f);
  const result = await add(f, groupId, f.ids);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.added, 30);
  assert.equal((await add(f, groupId, f.ids)).added, 0);
  assert.equal((await f.repo.associationGroups.getById(groupId)).memberCount, 30);
  assert.ok(f.db.traces.every(trace => trace.length <= 100));
});

test('小组第二批失败报告已完成数量，重试补齐剩余成员', async () => {
  const f = await fixture(30), groupId = await createGroup(f);
  f.db.failSet('associationGroupMembers', 21);
  const partial = await add(f, groupId, f.ids);
  assert.equal(partial.ok, false); assert.equal(partial.added, 20); assert.equal(partial.partial, true);
  assert.equal((await add(f, groupId, f.ids)).added, 10);
  assert.equal((await f.repo.associationGroups.getById(groupId)).memberCount, 30);
});

test('60人小组按组分页删除，关系全部失效，重复删除幂等', async () => {
  const f = await fixture(60), groupId = await createGroup(f);
  for (let i = 0; i < 60; i += 30) assert.equal((await add(f, groupId, f.ids.slice(i, i + 30))).ok, true);
  const revision = (await f.repo.associationGroups.getById(groupId)).revision;
  const payload = { groupId, expectedRevision: revision };
  assert.equal((await groups.deleteAssociationGroup(payload, f.ctx)).data.ok, true);
  const group = await f.repo.associationGroups.getById(groupId);
  assert.equal(group.status, 'deleted'); assert.equal(group.cleanupPending, false);
  for (const id of f.ids) assert.equal((await f.repo.associationGroupMembers.getById(associationGroupMemberKey(groupId, id, scope))).status, 'removed');
  assert.equal((await groups.deleteAssociationGroup(payload, f.ctx)).data.deleted, false);
  assert.ok(f.db.traces.every(trace => trace.length <= 100));
});

test('删除清理中断后立即阻止新报名和同编号重建，重试可完成清理', async () => {
  const f = await fixture(60), groupId = await createGroup(f);
  for (let i = 0; i < 60; i += 30) await add(f, groupId, f.ids.slice(i, i + 30));
  const eventId = await publish(f, { audienceMode: 'groups', audienceGroupIds: [groupId] });
  const payload = { groupId, expectedRevision: (await f.repo.associationGroups.getById(groupId)).revision };
  f.db.failSet('associationGroupMembers', 31);
  const partial = (await groups.deleteAssociationGroup(payload, f.ctx)).data;
  assert.equal(partial.ok, false); assert.equal(partial.cleanupPending, true);
  const pending = (await groups.listAssociationGroups({}, f.ctx)).data.groups.find(row => row.groupId === groupId);
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.canReadRoster, false);
  assert.ok(!(await groups.listAssociationGroups({}, await f.context(f.ids[45]))).data.groups.some(row => row.groupId === groupId));
  const remaining = f.ids[45];
  assert.equal((await f.repo.associationGroupMembers.getById(associationGroupMemberKey(groupId, remaining, scope))).status, 'active');
  assert.equal((await submit({ ...f, ctx: await f.context(actorId) }, eventId, [remaining])).ok, false);
  assert.equal((await groups.createAssociationGroup({ requestId: 'review21', name: '容量测试组' }, f.ctx)).data.ok, false);
  assert.equal((await groups.deleteAssociationGroup(payload, f.ctx)).data.ok, true);
  assert.equal((await f.repo.associationGroups.getById(groupId)).cleanupPending, false);
});

test('14队两组各7队全部同分出线，最后一场成功扩签且不重写已完成小组赛', async () => {
  const meetScope = { schoolId: 'muc', meetId: 'm' }, eventKey = 'e';
  const db = database({ schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: [{ _id: 'admin', platformRole: 'admin', platformStatus: 'active' }],
    sportsMeets: [{ _id: 'm', ...meetScope, status: 'running' }],
    sportsMeetEvents: [{ _id: eventKey, ...meetScope, status: 'active', scoreType: 'versus', format: 'group_knockout', groups: { count: 2, advancePerGroup: 1 } }],
    sportsMeetEntries: Array.from({ length: 14 }, (_, i) => ({ _id: 'entry' + i, ...meetScope, eventKey, status: 'approved', collegeId: 'c' + i })) });
  const repo = createRepo(db), ctx = await buildMeetContext({ repo, actorId: 'admin', scope: meetScope, now });
  assert.equal((await advance.drawMeetBracket({ eventKey, seed: 21 }, ctx)).ok, true);
  const event = await repo.sportsMeetEvents.getById(eventKey);
  const matches = (await repo.forMeet(meetScope).sportsMeetSessions.listByProject(eventKey)).filter(row => row.round.startsWith('g'));
  let result;
  for (const match of matches) {
    const group = Object.values(event.bracket.groupEntries).find(ids => ids.includes(match.entryKeys[0]));
    const [a, b] = match.entryKeys;
    const winnerEntryKey = (group.indexOf(b) - group.indexOf(a) + 7) % 7 <= 3 ? a : b;
    result = await advance.setMeetMatchWinner({ sessionKey: match._id, winnerEntryKey }, ctx);
    assert.equal(result.ok, true, result.message);
  }
  assert.equal(result.data.expanded, true);
  const finalTrace = db.traces.at(-1);
  assert.ok(finalTrace.length <= 100);
  const groupWrites = finalTrace.filter(row => row.kind === 'set' && matches.some(match => match._id === row.id));
  assert.equal(groupWrites.length, 1);
});

test('学院赛排序对输入排列稳定：置顶、状态、时间、编号依次比较', () => {
  const sort = require('../src/shared/services/college-event').sortCollegeEvents;
  const rows = [{ _id: 'pin', pinned: true, status: 3 }, { _id: 'b', status: 0 }, { _id: 'a', status: 0 }];
  for (const input of [rows, rows.slice().reverse(), [rows[1], rows[0], rows[2]]]) assert.deepEqual(sort(input).map(row => row._id), ['pin', 'a', 'b']);
});

test('足球进球与助攻榜按数值降序，同分按编号稳定排序', async () => {
  const f = await fixture(0, { schoolId: 'muc', association: 'fb' }), target = f.ctx;
  await f.repo.teamEvents.set('e', { _id: 'e', schoolId: 'muc', association: 'fb', status: 'finished', sportFormat: 'football11' });
  const players = [{ userId: 'high', goals: 3, assists: 1 }, { userId: 'low', goals: 1, assists: 3 }, { userId: 'equal', goals: 3, assists: 1 }];
  await f.repo.teamMatches.set('match', { _id: 'match', schoolId: 'muc', association: 'fb', eventId: 'e', status: 'published',
    sportPublished: { sides: { A: { players, coverage: {} }, B: { players: [], coverage: {} } } } });
  const result = (await require('../src/server/services/football-match-service').getTeamEventPlayerStats({ eventId: 'e' }, target)).data;
  assert.deepEqual(result.scorers.map(row => row.userId), ['equal', 'high', 'low']);
  assert.deepEqual(result.assists.map(row => row.userId), ['low', 'equal', 'high']);
});

test('10001名新成员学校的目录及学院赛详情只取涉及的人，不触发全校读取上限', async () => {
  const f = await fixture(10001), eventId = await publish(f);
  const dir = await buildDirectory(f.ctx, [f.ids[10000]]);
  assert.equal(dir.members.length, 2);
  assert.ok(dir.memberIds.includes(f.ids[10000]));
  assert.equal((await college.getCollegeEvent({ eventId }, f.ctx)).data.ok, true);
  assert.equal((await submit(f, eventId, [f.ids[10000]])).ok, true);
  const entries = (await college.listCollegeEntries({ eventId }, f.ctx)).data.entries;
  assert.equal(entries[0].memberNames[0], f.ids[10000]);
});

test('选人目录可搜索及连续翻页，接口不再一次下发全校人员', async () => {
  const f = await fixture(107);
  const service = require('../src/server/services/school-match-service');
  const first = (await service.getSchoolMatchEntryContext({}, f.ctx)).data;
  assert.ok(first.members.length <= 51); assert.equal(first.hasMore, true);
  const second = (await service.getSchoolMatchEntryContext({ cursor: first.nextCursor }, f.ctx)).data;
  const firstIds = new Set(first.members.map(row => row.userId).filter(id => id !== actorId));
  assert.ok(second.members.filter(row => row.userId !== actorId).every(row => !firstIds.has(row.userId)));
  const found = (await service.getSchoolMatchEntryContext({ keyword: f.ids[106] }, f.ctx)).data;
  assert.ok(found.members.some(row => row.userId === f.ids[106]));
});

/* ------------------------------------------------------------------ 第二十二轮 */

test('30 人学院名单在事务预算内提交成功，31 人按人数上限拒绝', async () => {
  const okFixture = await fixture(30);
  const okEvent = await publish(okFixture);
  const ok = await submit(okFixture, okEvent, okFixture.ids.slice(0, 30));
  assert.equal(ok.ok, true, ok.message);
  const saved = (await okFixture.repo.collegeEntries.list()).filter(row => row.eventId === okEvent);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].members.length, 30, '30 人必须整份落库，不能被截断');

  // 第二十二轮 P2：原先提交端只准备 31 人的目录，32 人起报「查不到的会员」；
  // 现在人数由 ROSTER_LIMITS.MAX 统一收口，超限给的是可执行的业务文案。
  const tooManyFixture = await fixture(31);
  const tooManyEvent = await publish(tooManyFixture);
  const tooMany = await submit(tooManyFixture, tooManyEvent, tooManyFixture.ids);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /最多 30 人/);
});

test('建组 28 人在预算内，29 人按上限拒绝', async () => {
  const f = await fixture(29);
  const created = await groups.createAssociationGroup({
    requestId: 'review22_create', name: '二十八人组', memberIds: f.ids.slice(0, 28),
  }, f.ctx).then(r => r.data);
  assert.equal(created.ok, true, created.message);

  const tooMany = await groups.createAssociationGroup({
    requestId: 'review22_create_too_many', name: '二十九人组', memberIds: f.ids,
  }, f.ctx).then(r => r.data);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /最多添加 28 名成员/);
});

/* ------------------------------------------------------------------ 第二十三轮 Batch A */

test('P0-1：真实微信注册账号 acc:<40位hex> 可完整走通运动会部长任命、意向、报名、派裁与录分', async () => {
  const { schoolAccountKey, collegeKey, schoolRoleKey } = require('../src/shared/utils/school');
  const { meetEventKey } = require('../src/shared/utils/meet-scope');
  const meetService = require('../src/server/services/meet-service');
  const leadService = require('../src/server/services/meet-college-lead-service');
  const regService = require('../src/server/services/meet-registration-service');
  const scheduleService = require('../src/server/services/meet-schedule-service');
  const scoreService = require('../src/server/services/meet-score-service');

  const adminId = schoolAccountKey('openid_real_admin_23');
  const leadId = schoolAccountKey('openid_real_lead_23');
  const stuId = schoolAccountKey('openid_real_student_23');
  const judgeId = schoolAccountKey('openid_real_judge_23');
  assert.equal(stuId.length, 44);
  assert.ok(stuId.startsWith('acc:'));

  const users = [adminId, leadId, stuId, judgeId].map((id) => ({
    _id: id, openId: id, nickName: id.slice(0, 10),
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc',
  }));
  const schoolMembers = [adminId, leadId, stuId, judgeId].map((id) => ({
    _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id,
    collegeId: 'c01', status: 'active', gender: 'male',
  }));
  const db = database({
    schools: [{ _id: 'muc', schoolId: 'muc', name: '中央民族大学', status: 'active' }],
    colleges: [{ _id: collegeKey('muc', 'c01'), schoolId: 'muc', collegeId: 'c01', name: '一院', status: 'active' }],
    users,
    schoolMembers,
    schoolRoles: [{ _id: schoolRoleKey(adminId, 'muc'), schoolId: 'muc', userId: adminId, role: 'admin', status: 'active' }],
  });
  const repo = createRepo(db);
  const ctxOf = (actor, meetId = '') => buildMeetContext({
    repo, actorId: actor, scope: { schoolId: 'muc', meetId }, now,
  });

  const created = await meetService.createSportsMeet({
    name: '真账号运动会', year: 2026, startDate: '2026-11-16', endDate: '2026-11-17',
  }, await ctxOf(adminId));
  assert.equal(created.ok, true);
  const meetId = created.data.meet.meetId;
  const adminCtx = await ctxOf(adminId, meetId);

  const granted = await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: leadId }, adminCtx);
  assert.equal(granted.ok, true, granted.message);

  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 4 }, adminCtx);
  await meetService.publishMeetRegistration({ openAt: '2026-11-01T00:00', closeAt: '2026-11-20T23:59' }, adminCtx);

  const interest = await regService.submitMeetInterest({ eventKey }, await ctxOf(stuId, meetId));
  assert.equal(interest.ok, true, interest.message);
  const withdrawn = await regService.withdrawMeetInterest({ eventKey }, await ctxOf(stuId, meetId));
  assert.equal(withdrawn.ok, true, withdrawn.message);
  assert.equal((await regService.submitMeetInterest({ eventKey }, await ctxOf(stuId, meetId))).ok, true);

  const entry = await regService.submitMeetCollegeEntry({ eventKey, userIds: [stuId] }, await ctxOf(leadId, meetId));
  assert.equal(entry.ok, true, entry.message);
  const entryKey = entry.data.entry._id;
  assert.equal((await regService.reviewMeetEntry({ entryKey, decision: 'approve' }, adminCtx)).ok, true);

  const savedSession = await scheduleService.saveMeetSession({
    eventKey, round: 'final', index: 1,
    startAt: '2026-11-16 09:00', endAt: '2026-11-16 10:00', venue: '田径场',
  }, adminCtx);
  assert.equal(savedSession.ok, true, savedSession.message);
  const sessionKey = savedSession.data.session.sessionKey;
  const updatedMeet = await repo.sportsMeets.getById(meetId);
  assert.ok(Number(updatedMeet.contentRevision) >= 1, 'saveMeetSession 不应回滚 contentRevision');
  assert.ok(Number(updatedMeet.scheduleRevision) >= 1);

  const assigned = await scheduleService.assignMeetJudge({ sessionKey, judgeId }, adminCtx);
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal((await scheduleService.publishMeetSchedule({}, adminCtx)).ok, true);
  assert.equal((await scheduleService.startMeetEvent({ sessionKey }, adminCtx)).ok, true);

  const scored = await scoreService.saveMeetJudgeScore({
    sessionKey, entryKey, rawText: '11.25',
  }, await ctxOf(judgeId, meetId));
  assert.equal(scored.ok, true, scored.message);
});

test('P0-3：停用平台管理员不能发布或下架全校公告，且 isPlatformAdminCtx 为 false', async () => {
  const announcements = require('../src/server/services/school-announcement-service');
  const { isPlatformAdminCtx } = require('../src/server/services/school-permission');
  const f = await fixture(0);
  await f.repo.users.set('plat_admin', {
    _id: 'plat_admin', openId: 'plat_admin', nickName: '平台管理员',
    platformRole: 'admin', platformStatus: 'active',
  });
  const activeCtx = await f.context('plat_admin');
  assert.equal(isPlatformAdminCtx(activeCtx), true);
  const pub = (await announcements.publishSchoolAnnouncement({
    requestId: 'ann_p0_3', title: '测试全校公告标题', content: '测试全校公告正文内容',
    category: C.ANNOUNCEMENT_CATEGORIES[0],
  }, activeCtx)).data;
  assert.equal(pub.ok, true, pub.message);

  await f.repo.users.set('plat_admin', {
    _id: 'plat_admin', openId: 'plat_admin', nickName: '平台管理员',
    platformRole: 'admin', platformStatus: 'disabled',
  });
  const disabledCtx = await f.context('plat_admin');
  assert.equal(isPlatformAdminCtx(disabledCtx), false);
  const blockedPub = (await announcements.publishSchoolAnnouncement({
    requestId: 'ann_p0_3_blocked', title: '停用后再次发布', content: '不应成功发布的内容',
    category: C.ANNOUNCEMENT_CATEGORIES[0],
  }, disabledCtx)).data;
  assert.equal(blockedPub.ok, false);
  const blockedArchive = (await announcements.archiveSchoolAnnouncement({
    announcementId: pub.announcement.announcementId,
  }, disabledCtx)).data;
  assert.equal(blockedArchive.ok, false);
});

test('P0-4：12 人单败淘汰赛（含 4 轮空）首轮 4 名负者按并列第 9 名结算，不误触发八强逻辑', () => {
  const { standardSeedOrder, bracketSizeOf } = require('../src/shared/utils/bracket');
  const { buildInitialMatches, planStageMatches, derivePlacements } = require('../src/shared/services/format-plan');
  const { eventMatchKey } = require('../src/shared/services/draw');
  const ids = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
  const size = bracketSizeOf(ids.length);
  const byRank = new Array(size).fill(null);
  ids.forEach((id, i) => { byRank[i] = id; });
  const draw = { size, slots: standardSeedOrder(size).map((r) => byRank[r - 1]) };

  for (const placementMode of [C.EVENT_PLACEMENT_MODE.DEFAULT, C.EVENT_PLACEMENT_MODE.TOP8]) {
    const event = {
      _id: `ev12_${placementMode}`, format: C.EVENT_FORMAT.SINGLE_ELIM,
      matchType: C.MATCH_TYPE.SINGLES, level: 2, gamePoints: 11, bestOf: 1,
      bronzeMode: C.EVENT_BRONZE_MODE.TIED, placementMode, draw,
      location: '1号场', startTime: '2026-11-16 08:00',
    };
    const matches = buildInitialMatches(event, draw).map((m) => ({
      ...m, status: C.MATCH_STATUS.ACTIVE, winner: 'A', scoreA: [11], scoreB: [5],
    }));
    while (true) {
      const plan = planStageMatches({ event, draw, matches });
      if (!plan.ok || plan.rounds.length === 0) break;
      for (const step of plan.rounds) {
        step.pairs.forEach(([a, b], slot) => {
          matches.push({
            _id: eventMatchKey(event._id, step.round, step.stage, slot, step.group),
            round: step.round, stage: step.stage, slot,
            teamA: [a], teamB: [b], scoreA: [11], scoreB: [5],
            winner: 'A', status: C.MATCH_STATUS.ACTIVE,
          });
        });
      }
    }
    const derived = derivePlacements({ event, draw, matches });
    assert.equal(derived.ok, true, `mode=${placementMode} 应能完整推导名次`);
    const rank9 = derived.results.filter((r) => r.placement === 9);
    assert.equal(rank9.length, 4, '首轮出局的 4 人应为并列第 9 名');
  }
});

test('赛季重置后零分会员首次签到及移除均使用单行增量', async () => {
  const trainingService = require('../src/server/services/association-training-service');
  const { resetSchoolSeason } = require('../src/server/services/school-rank-service');
  const { refreshAssociationPoints } = require('../src/server/services/season-points');
  const f = await fixture(1);
  const [u1] = f.ids;

  const reset = (await resetSchoolSeason({ resetTime: now.toISOString() }, f.ctx)).data;
  assert.equal(reset.ok, true, reset.message);
  await refreshAssociationPoints(f.ctx);
  const baseline = await f.repo.schoolMembers.getById(schoolMemberKey(u1, 'muc'));
  assert.equal(baseline.pointsAnchorByAssociation?.pkb ?? '', '');

  const published = (await trainingService.publishTraining({
    requestId: 'tr_p0_5', title: '增量签到训练',
    startAt: '2026-11-16T01:00:00Z', endAt: '2026-11-16T03:00:00Z',
    location: '球馆', capacity: 10,
  }, f.ctx)).data;
  assert.equal(published.ok, true, published.message);
  const trainingId = published.training.trainingId;

  const tReg = new Date('2026-11-16T00:10:00Z');
  const tCheck = new Date('2026-11-16T01:10:00Z');
  const ctxAs = (id, at) => buildSchoolContext({ repo: f.repo, actorId: id, scope, now: at });

  assert.equal((await trainingService.registerTraining({ trainingId }, await ctxAs(u1, tReg))).data.ok, true);
  assert.equal((await trainingService.requestTrainingCheckIn({ trainingId }, await ctxAs(u1, tCheck))).data.ok, true);

  const txCountBeforeConfirm = f.db.traces.length;
  const confirmed = (await trainingService.confirmTrainingCheckIn({
    trainingId, userId: u1,
  }, await ctxAs(actorId, tCheck))).data;
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(f.db.traces.length - txCountBeforeConfirm, 1, '确认签到应单事务增量完成');

  const memberAfterConfirm = await f.repo.schoolMembers.getById(schoolMemberKey(u1, 'muc'));
  assert.equal(memberAfterConfirm.seasonPointsByAssociation.pkb, 1);

  const txCountBeforeRemove = f.db.traces.length;
  const removed = (await trainingService.removeTrainingRegistration({
    trainingId, userId: u1, reason: '请假撤销',
  }, await ctxAs(actorId, tCheck))).data;
  assert.equal(removed.ok, true, removed.message);
  assert.equal(f.db.traces.length - txCountBeforeRemove, 1, '移除已确认报名增量成功后不应再触发整表重算事务');
  const memberAfterRemove = await f.repo.schoolMembers.getById(schoolMemberKey(u1, 'muc'));
  assert.equal(memberAfterRemove.seasonPointsByAssociation.pkb, 0);
});

test('Batch A 安全与状态机止血：已结束学院赛锁小场、总裁判离校失权、平局相互战绩与重抽 voidedAt 过滤', async () => {
  // 1. 团队循环赛允许平局时，相互战绩不将平局计为 B 队胜场
  const { computeTeamTable } = require('../src/shared/utils/team-standings');
  const standings = computeTeamTable({
    entries: [
      { teamId: 'tA', teamName: 'A' },
      { teamId: 'tB', teamName: 'B' },
      { teamId: 'tC', teamName: 'C' },
    ],
    matches: [
      { status: 'published', teamA: 'tA', teamB: 'tB', scoreA: 1, scoreB: 1, winner: null },
      { status: 'published', teamA: 'tA', teamB: 'tC', scoreA: 2, scoreB: 0, winner: 'A' },
      { status: 'published', teamA: 'tB', teamB: 'tC', scoreA: 1, scoreB: 0, winner: 'A' },
    ],
  });
  // tA 与 tB 同为 1 胜 1 平，相互战绩为平局（0:0），tA 净胜球 +2 应排在 tB（净胜球 +1）之前
  assert.equal(standings[0].teamId, 'tA');
  assert.equal(standings[1].teamId, 'tB');

  // 2. 运动会总裁判离校/停用后失去成绩发布与重排权限
  const { isChiefJudge, canPublishMeetResult } = require('../src/server/services/meet-permission');
  const meetDoc = {
    _id: 'm1', schoolId: 'muc',
    chiefJudge: { userId: 'cj1', schoolId: 'muc', meetId: 'm1', status: 'active' },
  };
  const activeChiefCtx = {
    actorId: 'cj1', schoolId: 'muc', meetId: 'm1', meet: meetDoc,
    actor: { _id: 'cj1', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' },
    school: { status: 'active' },
    schoolMember: { userId: 'cj1', schoolId: 'muc', status: 'active' },
  };
  assert.equal(isChiefJudge(activeChiefCtx, meetDoc), true);
  assert.equal(canPublishMeetResult(activeChiefCtx), true);

  const transferredChiefCtx = {
    ...activeChiefCtx,
    actor: { ...activeChiefCtx.actor, primarySchoolId: 'buaa' },
    schoolMember: { ...activeChiefCtx.schoolMember, status: 'transferred' },
  };
  assert.equal(isChiefJudge(transferredChiefCtx, meetDoc), false);
  assert.equal(canPublishMeetResult(transferredChiefCtx), false);

  // 3. 已结束学院赛的小场不可补录、确认或驳回
  const matchService = require('../src/server/services/school-match-service');
  const f = await fixture(2);
  const eventId = await publish(f);
  await f.repo.collegeEvents.set(eventId, {
    ...(await f.repo.collegeEvents.getById(eventId)),
    status: C.COLLEGE_EVENT_STATUS.FINISHED,
  });
  await f.repo.matches.set('leg_finished_1', {
    _id: 'leg_finished_1', schoolId: 'muc', association: 'pkb',
    competition: C.MATCH_COMPETITION.COLLEGE, collegeEventId: eventId, tieId: 'tie_1', legNo: 1,
    matchType: C.MATCH_TYPE.SINGLES, pool: C.RATING_POOL.SINGLES,
    teamA: [f.ids[0]], teamB: [f.ids[1]], gamePoints: 11, bestOf: 1,
    scoreA: [11], scoreB: [6], winner: 'A',
    status: C.MATCH_STATUS.PENDING, matchTime: '2026-11-16T08:00:00Z',
  });
  const confirmFinished = (await matchService.confirmSchoolMatch({ matchId: 'leg_finished_1' }, f.ctx)).data;
  assert.equal(confirmFinished.ok, false);
  assert.match(confirmFinished.message, /学院赛已结束/);
  const submitFinished = (await matchService.submitSchoolMatch({
    matchId: 'leg_finished_1', scoreA: [11], scoreB: [7],
  }, f.ctx)).data;
  assert.equal(submitFinished.ok, false);
  assert.match(submitFinished.message, /学院赛已结束/);

  // 4. 运动会胜负项目已判胜后拒绝重排；重抽作废场次清空裁判且不阻塞预览/晋级
  const mScope = { schoolId: 'muc', meetId: 'm_void' }, evKey = 'e_void';
  const mDb = database({
    schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: [{ _id: 'admin', platformRole: 'admin', platformStatus: 'active' }],
    sportsMeets: [{ _id: 'm_void', ...mScope, status: 'running' }],
    sportsMeetEvents: [{
      _id: evKey, ...mScope, status: 'active',
      scoreType: 'versus', format: 'single_elim',
    }],
    sportsMeetEntries: [
      { _id: 'en1', ...mScope, eventKey: evKey, status: 'approved', collegeId: 'c1' },
      { _id: 'en2', ...mScope, eventKey: evKey, status: 'approved', collegeId: 'c2' },
    ],
  });
  const mRepo = createRepo(mDb);
  const mCtx = await buildMeetContext({ repo: mRepo, actorId: 'admin', scope: mScope, now });
  assert.equal((await advance.drawMeetBracket({ eventKey: evKey, seed: 1 }, mCtx)).ok, true);
  const s1 = (await mRepo.forMeet(mScope).sportsMeetSessions.listByProject(evKey))[0];
  await mRepo.sportsMeetSessions.set(s1._id, { ...s1, judgeIds: ['j1'], judgeCount: 1, winnerEntryKey: 'en1' });
  const refusedRedraw = await advance.resetMeetDraw({ eventKey: evKey }, mCtx);
  assert.equal(refusedRedraw.ok, false);
  assert.match(refusedRedraw.message, /已有比赛结果/);

  await mRepo.sportsMeetSessions.set(s1._id, { ...s1, judgeIds: ['j1'], judgeCount: 1, winnerEntryKey: '' });
  const okRedraw = await advance.resetMeetDraw({ eventKey: evKey }, mCtx);
  assert.equal(okRedraw.ok, true, okRedraw.message);
  const voidedDoc = await mRepo.sportsMeetSessions.getById(s1._id);
  assert.ok(voidedDoc.voidedAt);
  assert.deepEqual(voidedDoc.judgeIds, []);
  assert.equal(voidedDoc.judgeCount, 0);

  // 5. 云端与内存仓储事务内 repo.inTx 为 true（保证 freshContext 走串行点读），非事务为 false
  assert.equal(f.repo.inTx, false);
  await f.repo.transaction(async (tx) => {
    assert.equal(tx.inTx, true);
  });
  const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
  const memRepo = createSchoolMemoryRepo();
  assert.equal(memRepo.inTx, false);
  await memRepo.transaction(async (tx) => {
    assert.equal(tx.inTx, true);
  });

  // 6. 工作台全部 7 个面板组件均显式声明 active 属性
  const fs = require('node:fs');
  const path = require('node:path');
  for (const panel of [
    'association-space-panel', 'team-panel', 'team-profile-panel',
    'rank-panel', 'match-panel', 'team-events-panel', 'events-panel',
  ]) {
    const file = path.join(__dirname, '..', 'miniprogram', 'components', panel, `${panel}.js`);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /properties\s*:\s*\{[\s\S]*?\bactive\s*:/, `${panel} 应声明 active 属性`);
  }
});
