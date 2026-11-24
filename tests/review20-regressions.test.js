const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { buildMeetContext } = require('../src/server/services/meet-context');
const { schoolMemberKey, collegeEntryKey, scopeKey, associationGroupMemberKey } = require('../src/shared/utils/school');
const C = require('../src/shared/utils/constants');
const points = require('../src/server/services/season-points');
const college = require('../src/server/services/school-college-service');
const meetService = require('../src/server/services/meet-service');
const { touchEvent } = require('../src/server/services/meet-consistency');
const scope = { schoolId: 'muc', association: 'pkb' };
const meetScope = { schoolId: 'muc', meetId: 'm' };
const now = new Date('2026-11-14T00:00:00Z');
const schoolContext = repo => buildSchoolContext({ repo, scope, actorId: 'demo_muc_admin', now });

test('待重算期间的新签到使旧任务失效，不覆盖较新的两分', async () => {
  const seed = createSchoolDemoSeed();
  seed.events = [];
  seed.associationTrainings = ['t1', 't2'].map(_id => ({ _id, ...scope, startAt: now, status: 'published' }));
  const fact = trainingId => ({ _id: trainingId, ...scope, trainingId,
    userId: 'demo_muc_member', signupStatus: 'registered', attendanceStatus: 'confirmed', pointEffectiveAt: now });
  seed.trainingRegistrations = [fact('t1')];
  const repo = createSchoolMemoryRepo(seed);
  const ctx = { repo, ...scope, now };
  const id = scopeKey(scope);
  await repo.seasons.set(id, { _id: id, ...scope, version: 1, pointsSettledVersion: 0, pointsSchemaVersion: points.POINTS_SCHEMA });
  const transaction = repo.transaction.bind(repo);
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) {
      injected = true;
      await transaction(async tx => {
        await tx.trainingRegistrations.set('t2', fact('t2'));
        await points.applyTrainingFactDelta(tx, ctx, { userId: 'demo_muc_member', delta: 1, effectiveAt: now });
      });
      await points.refreshAssociationPoints(ctx);
    }
    return transaction(fn);
  };
  const old = await points.refreshAssociationPoints(ctx);
  assert.equal(old.stale, true);
  const season = await repo.seasons.getById(id);
  const row = await repo.schoolMembers.getById(schoolMemberKey('demo_muc_member', 'muc'));
  assert.equal(season.version, 2);
  assert.equal(points.settledPointsOf(season, [row], 'pkb').get('demo_muc_member'), 2);
});

function meetSeed(count = 1) {
  return {
    schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: [{ _id: 'admin', platformStatus: 'active', platformRole: 'admin' }],
    sportsMeets: [{ _id: 'm', ...meetScope, name: '运动会', status: 'running' }],
    sportsMeetEvents: Array.from({ length: count }, (_, i) => ({
      _id: 'e' + i, ...meetScope, name: '项目' + i, status: 'active', revision: 1,
    })),
    sportsMeetEntries: Array.from({ length: count }, (_, i) => ({
      _id: 'entry' + i, ...meetScope, eventKey: 'e' + i, status: 'approved', userIds: ['admin'],
    })),
  };
}
async function meetFixture(seed) {
  const db = database(seed);
  const repo = createRepo(db);
  const ctx = await buildMeetContext({ repo, actorId: 'admin', scope: meetScope, now });
  return { db, repo, ctx };
}

test('重抽事务拒绝在途录分，保留参赛名单和成绩', async () => {
  const seed = meetSeed();
  seed.sportsMeetSessions = [{ _id: 's', ...meetScope, eventKey: 'e0', entryKeys: ['entry0'] }];
  const f = await meetFixture(seed);
  f.db.beforeTransaction = async () => {
    await f.repo.transaction(async tx => {
      await tx.sportsMeetScores.set('score', { _id: 'score', ...meetScope, eventKey: 'e0', sessionKey: 's', value: 100 });
      await touchEvent(tx, 'e0');
    });
  };
  const result = await require('../src/server/services/meet-advance-service').resetMeetDraw({ eventKey: 'e0' }, f.ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /变化/);
  assert.deepEqual((await f.repo.sportsMeetSessions.getById('s')).entryKeys, ['entry0']);
  assert.ok(await f.repo.sportsMeetScores.getById('score'));
});

test('50项目全部发布后正常结束，事务操作数保持常数', async () => {
  const seed = meetSeed(50);
  seed.sportsMeetPublications = seed.sportsMeetEvents.map(event => ({
    _id: 'p' + event._id, ...meetScope, eventKey: event._id, official: true, status: 'published', version: 1,
  }));
  const f = await meetFixture(seed);
  const result = await meetService.finishSportsMeet({}, f.ctx);
  assert.equal(result.ok, true, result.message);
  assert.equal((await f.repo.sportsMeets.getById('m')).status, 'finished');
  assert.ok(f.db.traces[0].length < 15, JSON.stringify(f.db.traces[0]));
});

test('运动会收尾拒绝读取快照后的项目变更', async () => {
  const seed = meetSeed();
  seed.sportsMeetPublications = [{ _id: 'p', ...meetScope, eventKey: 'e0', official: true }];
  const f = await meetFixture(seed);
  f.db.beforeTransaction = () => f.repo.transaction(tx => touchEvent(tx, 'e0'));
  const result = await meetService.finishSportsMeet({}, f.ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /变化/);
  assert.equal((await f.repo.sportsMeets.getById('m')).status, 'running');
});

const collegePayload = extra => ({
  requestId: 'review20', title: '学院团体赛', description: '回归用例',
  legPlan: [C.LEG_DISCIPLINE.MS], rosterMin: 1, rosterMax: 30,
  tieAlgo: C.TIE_ALGO.FULL_POINTS, tieNetMode: C.TIE_NET_MODE.WIN_DIFF,
  startTime: '2026-11-15T00:00:00Z', location: '体育馆', courtCount: 1, ...extra,
});
async function collegeFixture({ people = 0, grouped = false } = {}) {
  const seed = createSchoolDemoSeed();
  const ids = Array.from({ length: people }, (_, i) => 'player' + i);
  for (const id of [...ids, 'otherCollege']) {
    seed.users.push({ _id: id, nickName: id, platformStatus: 'active', primarySchoolId: 'muc', gender: 'male' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id,
      collegeId: id === 'otherCollege' ? 'c02' : 'c01', status: 'active' });
  }
  const groups = Array.from({ length: 20 }, (_, i) => 'g' + String(i).padStart(2, '0'));
  if (grouped) {
    seed.associationGroups = groups.map(_id => ({ _id, ...scope, name: _id, status: 'active' }));
    seed.associationGroupMembers = ids.map(userId => ({
      _id: associationGroupMemberKey('g19', userId, scope), ...scope, userId, groupId: 'g19', status: 'active',
    }));
  }
  const db = database(seed), repo = createRepo(db), ctx = await schoolContext(repo);
  const result = (await college.publishCollegeEvent(collegePayload(grouped
    ? { audienceMode: 'groups', audienceGroupIds: groups } : {}), ctx)).data;
  assert.equal(result.ok, true, result.message);
  return { db, repo, ctx, ids, eventId: result.event.eventId };
}

test('学院名单重提与抽签并发时拒绝旧签表，待审名单不被锁入', async () => {
  const f = await collegeFixture();
  for (const [collegeId, memberIds] of [['c01', ['demo_muc_member']], ['c02', ['otherCollege']]]) {
    assert.equal((await college.submitCollegeEntry({ eventId: f.eventId, collegeId, memberIds }, f.ctx)).data.ok, true);
    assert.equal((await college.reviewCollegeEntry({ eventId: f.eventId, collegeId, action: 'approve' }, f.ctx)).data.ok, true);
  }
  f.db.beforeTransaction = async () => {
    const resubmitted = await college.submitCollegeEntry({ eventId: f.eventId, collegeId: 'c01', memberIds: ['demo_muc_member'] }, f.ctx);
    assert.equal(resubmitted.data.ok, true);
  };
  const drawn = (await college.drawCollegeEvent({ eventId: f.eventId, seedValue: 2 }, f.ctx)).data;
  assert.equal(drawn.ok, false);
  assert.match(drawn.message, /名单已变化/);
  assert.equal((await f.repo.collegeEvents.getById(f.eventId)).status, C.COLLEGE_EVENT_STATUS.SIGNUP);
  assert.equal((await f.repo.collegeEntries.getById(collegeEntryKey(f.eventId, 'c01', scope))).status, C.COLLEGE_ENTRY_STATUS.PENDING);
});

for (const count of [6, 30]) test(count + '人均在第20组时可正常提交，事务预算内复核资格', async () => {
  const f = await collegeFixture({ people: count, grouped: true });
  const result = (await college.submitCollegeEntry({ eventId: f.eventId, collegeId: 'c01', memberIds: f.ids }, f.ctx)).data;
  assert.equal(result.ok, true, result.message);
  assert.ok(f.db.traces.at(-1).length <= 100);
  assert.equal(result.entry.memberCount, count);
});

test('资格快照读取后成员退出小组，事务拒绝整份名单', async () => {
  const f = await collegeFixture({ people: 6, grouped: true });
  const key = associationGroupMemberKey('g19', f.ids[0], scope);
  f.db.beforeTransaction = async () => {
    const row = await f.repo.associationGroupMembers.getById(key);
    await f.repo.associationGroupMembers.set(key, { ...row, status: 'left' });
    // 真实路径里 leaveAssociationGroup 会同时 +1 membershipRevision；
    // 第二十二轮起事务内按「组版本」复核名单资格，模拟必须带上这一步。
    const group = await f.repo.associationGroups.getById('g19');
    await f.repo.associationGroups.set('g19', {
      ...group, membershipRevision: Number(group.membershipRevision || 0) + 1,
    });
  };
  const result = (await college.submitCollegeEntry({ eventId: f.eventId, collegeId: 'c01', memberIds: f.ids }, f.ctx)).data;
  assert.equal(result.ok, false);
  assert.match(result.message, /资格已变化/);
  assert.equal(await f.repo.collegeEntries.getById(collegeEntryKey(f.eventId, 'c01', scope)), null);
});

test('空成员首屏仍有续页时展示卡片及续读入口', () => {
  const { pageFileOf } = require('./helpers/page-registry');
  const xml = fs.readFileSync(pageFileOf('school-identity', '.wxml'), 'utf8');
  assert.match(xml, /wx:if="{{members.length \|\| memberHasMore}}"/);
  assert.match(xml, /wx:if="{{!members.length && memberHasMore}}"/);
  assert.match(xml, /bindtap="onLoadMoreMembers"/);
});

test('运动护照从当前发布快照读取，缺失或过期明细不影响两页记录', async () => {
  const seed = createSchoolDemoSeed();
  const userId = 'demo_muc_member';
  seed.sportsMeets = [{ _id: 'm', ...meetScope, name: '运动会', status: 'finished' }];
  seed.sportsMeetEvents = [{ _id: 'e0', ...meetScope, name: '100m', status: 'active' }];
  seed.sportsMeetPublications = [{ _id: 'p', ...meetScope, eventKey: 'e0', status: 'published',
    version: 2, official: true, publishedAt: now.toISOString(),
    rows: ['a', 'b'].map((entryKey, i) => ({ entryKey, userIds: [userId], rank: i + 2, status: 'result' })),
  }];
  seed.sportsMeetResultRows = [{ _id: 'stale', ...meetScope, publicationKey: 'p', eventKey: 'e0',
    userIds: [userId], version: 1, rank: 1, status: 'result' }];
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: userId, scope, now });
  const service = require('../src/server/services/personal-sports-service');
  const first = (await service.getMySportsDashboard({ section: 'passport', project: 'meet', limit: 1 }, ctx)).data;
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].rank, 3);
  assert.equal(first.hasMore, true);
  assert.equal(JSON.parse(decodeURIComponent(first.nextCursor)).positions.meetResult.id, 'mtrow:p:b');
  const second = (await service.getMySportsDashboard({
    section: 'passport', project: 'meet', limit: 1, cursor: first.nextCursor,
  }, ctx)).data;
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].rank, 2);
  assert.notEqual(second.items[0].key, first.items[0].key);
  assert.equal(second.hasMore, false);
});

test('足球排期拒绝二月30日且保留原赛程，合法北京时间可保存', async () => {
  const f = await require('./helpers/football-fixture').fixture();
  const match = (await f.matches())[0];
  const before = await f.repo.teamMatches.getById(match._id);
  const failed = await f.write('updateTeamMatchSchedule', match, { matchTime: '2026-02-30 18:00' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /格式不正确/);
  assert.deepEqual(await f.repo.teamMatches.getById(match._id), before);
  const saved = await f.write('updateTeamMatchSchedule', match, { matchTime: '2026-11-15 18:00' });
  assert.equal(saved.ok, true, saved.message);
  assert.equal((await f.repo.teamMatches.getById(match._id)).matchTime, '2026-11-15T10:00:00.000Z');
});
test('锁定学院名单后不能审核仍待处理的申请', async () => {
  const f = await collegeFixture();
  const submitted = await college.submitCollegeEntry({ eventId: f.eventId, collegeId: 'c01', memberIds: ['demo_muc_member'] }, f.ctx);
  assert.equal(submitted.data.ok, true);
  const event = await f.repo.collegeEvents.getById(f.eventId);
  await f.repo.collegeEvents.set(event._id, { ...event, status: C.COLLEGE_EVENT_STATUS.READY });
  const result = (await college.reviewCollegeEntry({ eventId: f.eventId, collegeId: 'c01', action: 'approve' }, f.ctx)).data;
  assert.equal(result.ok, false);
  assert.match(result.message, /锁定/);
});

for (const action of ['getSchoolLiveScores', 'getTeamLiveScores']) test(action + '的批量轮询日预算可耗尽且不影响普通读取', () => {
  const rate = require('../cloudfunctions/data/src/core/rate-limit');
  const old = process.env.RATE_LIMIT;
  process.env.RATE_LIMIT = 'on';
  rate.resetRateLimit();
  try {
    const payload = { matchIds: Array.from({ length: 50 }, (_, i) => 'm' + i) };
    const cost = rate.readCostOf(action, payload);
    const rounds = Math.floor(rate.POLL_DAILY_LIMIT / cost);
    for (let i = 0; i < rounds; i++) {
      assert.equal(rate.guardRate('viewer', action, now.getTime() + i * 2000, { payload }), null);
    }
    const time = now.getTime() + rounds * 2000;
    const blocked = rate.guardRate('viewer', action, time, { payload });
    assert.equal(blocked.scope, 'day');
    assert.equal(rate.guardRate('viewer', 'getSchoolSeason', time), null);
    assert.equal(rate.guardRate('other', action, time, { payload }), null);
    assert.equal(rate.guardRate('viewer', action, time + 86400000, { payload }), null);
  } finally {
    if (old === undefined) delete process.env.RATE_LIMIT; else process.env.RATE_LIMIT = old;
    rate.resetRateLimit();
  }
});

test('单场篮球连续观赛两小时仍在额度内，重复编号不会放大成本', () => {
  const rate = require('../cloudfunctions/data/src/core/rate-limit');
  const old = process.env.RATE_LIMIT;
  process.env.RATE_LIMIT = 'on';
  rate.resetRateLimit();
  try {
    const payload = { matchIds: ['m', 'm'] };
    assert.equal(rate.readCostOf('getTeamLiveScores', payload), 3);
    const prefixed = { matchIds: [...Array(50).fill('m'), ...Array.from({ length: 49 }, (_, i) => 'n' + i)] };
    assert.equal(rate.readCostOf('getTeamLiveScores', prefixed), 150);
    assert.equal(rate.readCostOf('getSchoolLiveScores', prefixed), 1);
    for (let i = 0; i < 3600; i++) {
      assert.equal(rate.guardRate('viewer', 'getTeamLiveScores', now.getTime() + i * 2000, { payload }), null);
    }
  } finally {
    if (old === undefined) delete process.env.RATE_LIMIT; else process.env.RATE_LIMIT = old;
    rate.resetRateLimit();
  }
});
