const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const { buildMeetContext } = require('../miniprogram/services/meet-context');
const { buildDirectory } = require('../miniprogram/services/school-actor');
const { accountDirectoryFields } = require('../miniprogram/services/account-directory');
const { schoolMemberKey, associationGroupMemberKey } = require('../miniprogram/utils/school');
const C = require('../miniprogram/utils/constants');
const college = require('../miniprogram/services/school-college-service');
const groups = require('../miniprogram/services/association-group-service');
const advance = require('../miniprogram/services/meet-advance-service');
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
  const sort = require('../miniprogram/services/college-event').sortCollegeEvents;
  const rows = [{ _id: 'pin', pinned: true, status: 3 }, { _id: 'b', status: 0 }, { _id: 'a', status: 0 }];
  for (const input of [rows, rows.slice().reverse(), [rows[1], rows[0], rows[2]]]) assert.deepEqual(sort(input).map(row => row._id), ['pin', 'a', 'b']);
});

test('足球进球与助攻榜按数值降序，同分按编号稳定排序', async () => {
  const f = await fixture(0, { schoolId: 'muc', association: 'fb' }), target = f.ctx;
  await f.repo.teamEvents.set('e', { _id: 'e', schoolId: 'muc', association: 'fb', status: 'finished', sportFormat: 'football11' });
  const players = [{ userId: 'high', goals: 3, assists: 1 }, { userId: 'low', goals: 1, assists: 3 }, { userId: 'equal', goals: 3, assists: 1 }];
  await f.repo.teamMatches.set('match', { _id: 'match', schoolId: 'muc', association: 'fb', eventId: 'e', status: 'published',
    footballPublished: { sides: { A: { players, coverage: {} }, B: { players: [], coverage: {} } } } });
  const result = (await require('../miniprogram/services/football-match-service').getTeamEventPlayerStats({ eventId: 'e' }, target)).data;
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
  const service = require('../miniprogram/services/school-match-service');
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
