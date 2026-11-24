const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { buildMeetContext } = require('../src/server/services/meet-context');
const points = require('../src/server/services/season-points');
const { schoolMemberKey, scopeKey } = require('../src/shared/utils/school');
const handlers = require('../cloudfunctions/data/src/core/school-member-handlers');
const scope = { schoolId: 'muc', association: 'pkb' };
const now = new Date('2026-11-14T00:00:00Z');

test('云客户端传递学校名册游标', async () => {
  const original = global.wx;
  let sent;
  global.wx = { cloud: { callFunction: async ({ data }) => {
    sent = data.payload;
    return { result: { ok: true, data: { ok: true } } };
  } } };
  try {
    const api = require('../miniprogram/services/school-cloud').forSchoolIdentity(scope);
    await api.getSchoolMembers({ cursor: 'next', limit: 7 });
    assert.deepEqual(sent, { cursor: 'next', limit: 7 });
  } finally { global.wx = original; }
});

test('名册按有效账号分页且未入校账号看不到管理角色', async () => {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'new', platformStatus: 'active' },
    { _id: 'disabled', platformStatus: 'disabled', primarySchoolId: 'muc' });
  seed.schoolMembers.push({ _id: schoolMemberKey('disabled', 'muc'),
    schoolId: 'muc', userId: 'disabled', status: 'active' });
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'new', scope, now });
  const rows = [];
  let cursor = '';
  do {
    const { data } = await handlers.getSchoolMembers({ limit: 1, cursor }, ctx);
    assert.equal(data.readOnly, true);
    assert.ok(data.members.every(row => !('permissionLabel' in row)));
    rows.push(...data.members);
    assert.ok(!data.hasMore || data.nextCursor !== cursor);
    cursor = data.nextCursor;
    if (!data.hasMore) {
      assert.equal(rows.length, data.total);
      break;
    }
  } while (rows.length < 20);
  assert.ok(rows.length > 1);
  assert.ok(!rows.some(row => row.userId === 'disabled'));
});

test('刷新首屏后旧翻页不会遗留加载锁', async () => {
  const { loadPage, instantiate } = require('./helpers/page-harness');
  const service = require('../miniprogram/services/school-identity');
  const original = service.forSchoolIdentity;
  const page = instantiate(loadPage('school-identity'));
  let finish;
  page.api = { getSchoolMembers: () => new Promise(resolve => { finish = resolve; }) };
  page.setData({ memberHasMore: true });
  service.forSchoolIdentity = () => ({
    getSchoolDirectory: async () => ({ ok: true, schools: [], colleges: [] }),
    getSchoolIdentitySession: async () => ({ ok: true }),
    getSchoolMembers: async () => ({ ok: true, members: [], grants: [], hasMore: true, nextCursor: 'new' }),
  });
  try {
    const old = page.onLoadMoreMembers();
    await page.reload();
    finish({ ok: true, members: [] });
    await old;
    assert.equal(page.data.memberLoadingMore, false);
    assert.equal(page.data.memberCursor, 'new');
  } finally { service.forSchoolIdentity = original; }
});

test('非零积分缺本赛季锚点时同一事务使积分物化失效', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const id = scopeKey(scope);
  await repo.seasons.set(id, { _id: id, ...scope, resetTime: '2026-11-01T00:00:00Z',
    version: 7, pointsSettledVersion: 7, pointsSchemaVersion: points.POINTS_SCHEMA });
  const memberKey = schoolMemberKey('demo_muc_member', scope.schoolId);
  const member = await repo.schoolMembers.getById(memberKey);
  await repo.schoolMembers.set(memberKey, { ...member, seasonPointsByAssociation: { pkb: 4 } });
  const result = await repo.transaction(tx => points.applyTrainingFactDelta(tx,
    { ...scope, now }, { userId: 'demo_muc_member', delta: 1, effectiveAt: now }));
  assert.equal(result.needsRefresh, true);
  assert.equal(points.isSettled(await repo.seasons.getById(id)), false);
});

test('单人增量不使未变化会员与其它协会失效', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const id = scopeKey(scope);
  const season = { _id: id, ...scope, version: 7, pointsSettledVersion: 7,
    pointsSchemaVersion: points.POINTS_SCHEMA };
  await repo.seasons.set(id, season);
  for (const userId of ['demo_muc_member', 'demo_muc_member_2']) {
    const key = schoolMemberKey(userId, 'muc');
    const row = await repo.schoolMembers.getById(key);
    await repo.schoolMembers.set(key, { ...row,
      seasonPointsByAssociation: { pkb: 4, tt: 9 },
      pointsAnchorByAssociation: { pkb: '', tt: '' },
      pointsVersionByAssociation: { pkb: 7, tt: 3 } });
  }
  await repo.transaction(tx => points.applyTrainingFactDelta(tx, { ...scope, now },
    { userId: 'demo_muc_member', delta: 1, effectiveAt: now }));
  const rows = await repo.forScope(scope).schoolMembers.list();
  const map = points.settledPointsOf(await repo.seasons.getById(id), rows, 'pkb');
  assert.equal(map.get('demo_muc_member'), 5);
  assert.equal(map.get('demo_muc_member_2'), 4);
  const other = points.settledPointsOf({ ...season, version: 3, pointsSettledVersion: 3 }, rows, 'tt');
  assert.equal(other.get('demo_muc_member'), 9);
});

test('11队循环赛在事务开始前拒绝容量超限', async () => {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: [{ _id: 'admin', platformStatus: 'active', platformRole: 'admin' }],
    sportsMeets: [{ _id: 'meet', schoolId: 'muc', status: 'scheduled' }],
    sportsMeetEvents: [{ _id: 'event', schoolId: 'muc', meetId: 'meet',
      status: 'active', scoreType: 'versus', format: 'round_robin' }],
    sportsMeetEntries: Array.from({ length: 11 }, (_, i) => ({
      _id: 'entry' + i, schoolId: 'muc', meetId: 'meet', eventKey: 'event',
      status: 'approved', collegeId: 'college' + i,
    })),
  });
  const ctx = await buildMeetContext({ repo, actorId: 'admin', scope: { schoolId: 'muc', meetId: 'meet' }, now });
  repo.transaction = async () => { throw new Error('不应进入超限事务'); };
  const result = await require('../src/server/services/meet-advance-service').drawMeetBracket({ eventKey: 'event' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /容量/);
});

test('荣誉读取正式发布快照，派生索引旧值不影响更正结果', async () => {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: [{ _id: 'admin', platformStatus: 'active', platformRole: 'admin' }],
    sportsMeets: [{ _id: 'meet', schoolId: 'muc', status: 'finished' }],
    sportsMeetPublications: [{ _id: 'pub', schoolId: 'muc', meetId: 'meet', eventKey: 'event',
      version: 2, status: 'published', official: true, rows: [
        { entryKey: 'entry', userIds: ['admin'], rank: 2, points: 7, status: 'result' },
      ] }],
    sportsMeetHonors: [{ _id: 'honor', schoolId: 'muc', meetId: 'meet', eventKey: 'event',
      version: 1, userIds: ['admin'], rank: 1, points: 9 }],
  });
  const ctx = await buildMeetContext({ repo, actorId: 'admin', scope: { schoolId: 'muc', meetId: 'meet' }, now });
  const result = await require('../src/server/services/meet-standing-service').getMyMeetHonors({}, ctx);
  assert.equal(result.data.items[0].rank, 2);
  assert.equal(result.data.summary.gold, 0);
});
test('过期积分重算不能覆盖较新的事实版本', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const id = scopeKey(scope);
  await repo.seasons.set(id, { _id: id, ...scope, version: 1, pointsSettledVersion: 0,
    pointsSchemaVersion: points.POINTS_SCHEMA });
  await repo.events.set('race', { _id: 'race', ...scope, status: 2, matchType: 1,
    level: 1, finishedAt: now, results: [{ userId: 'demo_muc_member', placement: 1 }] });
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope, now });
  const original = repo.transaction.bind(repo);
  let changed = false;
  repo.transaction = async fn => {
    if (!changed) {
      changed = true;
      await original(async tx => {
        const season = await tx.seasons.getById(id);
        await tx.seasons.set(id, { ...season, version: 2, pointsSettledVersion: 2 });
        const key = schoolMemberKey('demo_muc_member', 'muc');
        const row = await tx.schoolMembers.getById(key);
        await tx.schoolMembers.set(key, { ...row, seasonPointsByAssociation: { pkb: 99 } });
      });
    }
    return original(fn);
  };
  const result = await points.refreshAssociationPoints(ctx);
  assert.equal(result.stale, true);
  const row = await repo.schoolMembers.getById(schoolMemberKey('demo_muc_member', 'muc'));
  assert.equal(row.seasonPointsByAssociation.pkb, 99);
});
test('失效账号占满名册前段时单次扫描有界，游标仍可继续', async () => {
  const seed = createSchoolDemoSeed();
  for (let i = 0; i < 201; i++) {
    const userId = 'aaa' + String(i).padStart(3, '0');
    seed.schoolMembers.push({ _id: schoolMemberKey(userId, 'muc'),
      schoolId: 'muc', userId, status: 'active' });
  }
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope, now });
  const first = (await handlers.getSchoolMembers({ limit: 50 }, ctx)).data;
  assert.equal(first.members.length, 0);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = (await handlers.getSchoolMembers({ limit: 50, cursor: first.nextCursor }, ctx)).data;
  assert.ok(second.members.length > 0);
  assert.equal(second.hasMore, false);
});
