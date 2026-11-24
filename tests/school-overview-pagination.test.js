const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildSchoolContext } = require('../src/server/services/school-context');
const announcements = require('../src/server/services/school-announcement-service');
const teams = require('../src/server/services/team-event-service');
const SCOPE = { schoolId: 'muc', association: 'pkb' };

function fixture(cloud) {
  const seed = createSchoolDemoSeed();
  seed.announcements = Array.from({ length: 127 }, (_, i) => ({
    _id: `notice${String(i).padStart(3, '0')}`, ...SCOPE, title: `公告${i}`, content: `正文${i}`,
    category: i % 2 ? '通知' : '赛事', status: i % 7 ? 'published' : 'archived',
    pinned: i % 3 === 0, publishTime: `2026-10-${String(1 + i % 4).padStart(2, '0')}T12:00:00.000Z`,
  }));
  seed.announcements.push({ ...seed.announcements[1], _id: 'foreign', schoolId: 'buaa', title: '外校机密' });
  seed.teamEvents = ['registration', 'locked', 'scheduled', 'running', 'finished', 'canceled', 'draft']
    .flatMap((status, s) => Array.from({ length: 9 }, (_, i) => ({
      _id: `team${s}${i}`, schoolId: 'muc', association: 'fb', name: `${status}${i}`, status,
      startTime: `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, privateNotes: '内部数据',
    })));
  seed.teamEvents.push({ ...seed.teamEvents[0], _id: 'other-school', schoolId: 'buaa' },
    { ...seed.teamEvents[0], _id: 'other-sport', association: 'bk' });
  seed.teamMatches = Array.from({ length: 211 }, (_, i) => ({ _id: `m${i}`, schoolId: 'muc', association: 'fb' }));
  seed.teamMatches.push({ _id: 'foreign-match', schoolId: 'buaa', association: 'fb' });
  const db = cloud ? database(seed) : null;
  const repo = db ? createRepo(db) : createSchoolMemoryRepo(seed);
  const original = repo.forScope;
  repo.forScope = scope => {
    const scoped = original(scope);
    for (const key of ['announcements', 'teamEvents', 'teamEventEntries', 'teamMatches']) {
      scoped[key].list = () => { throw new Error(`禁止概览全量读 ${key}`); };
    }
    return scoped;
  };
  const call = async (service, payload, actor = 'demo_muc_admin', scope = SCOPE) => {
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope });
    return (await service(payload, ctx)).data;
  };
  return { seed, repo, call };
}

for (const cloud of [false, true]) {
  const side = cloud ? '云适配器' : '模拟仓储';
  test(`${side}：公告跨三页稳定排序、同刻编号去重、普通会员看不到下架和外校公告`, async () => {
    const { call, seed } = fixture(cloud);
    const expected = seed.announcements.filter(row => row.schoolId === 'muc' && row.status === 'published')
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.publishTime.localeCompare(a.publishTime) || b._id.localeCompare(a._id));
    const all = [];
    let cursor = '', pages = 0;
    do {
      const page = await call(announcements.listSchoolAnnouncements, { limit: 20, cursor }, 'demo_muc_member');
      assert.equal(page.ok, true, page.message);
      assert.equal(page.total, expected.length);
      assert.ok(page.announcements.length <= 20);
      all.push(...page.announcements);
      assert.equal(page.hasMore, Boolean(page.nextCursor));
      cursor = page.nextCursor;
      assert.ok(++pages < 10, '游标必须前进');
    } while (cursor);
    assert.deepEqual(all.map(row => row.announcementId), expected.map(row => row._id));
    assert.ok(all.every(row => !row.canArchive && !row.archived));
    const hidden = await call(announcements.listSchoolAnnouncements, { status: 'archived' }, 'demo_muc_member');
    assert.deepEqual(hidden.announcements, []);
    const denied = await call(announcements.listSchoolAnnouncements, {}, 'demo_buaa_member');
    assert.equal(denied.ok, false);
  });

  test(`${side}：公告游标绑定学校与筛选，管理员可续读下架台账且上限50`, async () => {
    const { call } = fixture(cloud);
    const first = await call(announcements.listSchoolAnnouncements, { limit: 999 });
    assert.equal(first.announcements.length, 50);
    assert.equal(first.total, 127);
    const typed = await call(announcements.listSchoolAnnouncements, { limit: 999, status: { arbitrary: 'filter' } });
    assert.deepEqual(typed.announcements, first.announcements, '非字符串状态不能作为数据库查询对象');
    const next = await call(announcements.listSchoolAnnouncements, { limit: 50, cursor: first.nextCursor });
    assert.equal(next.ok, true);
    assert.equal(new Set([...first.announcements, ...next.announcements].map(row => row.announcementId)).size, 100);
    for (const payload of [{ cursor: '%' }, { cursor: first.nextCursor, category: '通知' },
      { cursor: first.nextCursor, status: 'published' }]) {
      const invalid = await call(announcements.listSchoolAnnouncements, payload);
      assert.equal(invalid.ok, false);
      assert.match(invalid.message, /游标/);
    }
    const foreign = await call(announcements.listSchoolAnnouncements, { cursor: first.nextCursor }, 'demo_buaa_admin',
      { schoolId: 'buaa', association: 'pkb' });
    assert.equal(foreign.ok, false);
    const acrossSport = await call(announcements.listSchoolAnnouncements, { cursor: first.nextCursor, limit: 50 },
      'demo_muc_admin', { ...SCOPE, association: 'tt' });
    assert.deepEqual(acrossSport.announcements, next.announcements, '公告按学校分页，不随协会改变');
  });

  test(`${side}：团队首页有界查询，排除草稿/结束赛，只返回摘要和真实总数`, async () => {
    const { call } = fixture(cloud);
    const page = await call(teams.listTeamEvents, { home: true, limit: 5 }, 'demo_muc_member', { ...SCOPE, association: 'fb' });
    assert.equal(page.ok, true, page.message);
    assert.equal(page.events.length, 5);
    assert.equal(page.hasMore, true);
    assert.equal(page.totalAll, 54);
    assert.equal(page.matchTotal, 211);
    assert.ok(page.events.every(row => row.eventKind === 'team' && (row.isSignup || row.isOngoing)));
    assert.ok(page.events.every(row => row.startTime === '2026-11-01T10:00:00.000Z'
      || row.startTime === '2026-11-02T10:00:00.000Z'));
    assert.equal(JSON.stringify(page).includes('内部数据'), false);
    const denied = await call(teams.listTeamEvents, { home: true }, 'demo_buaa_member', { ...SCOPE, association: 'fb' });
    assert.equal(denied.ok, false);
    const wrongSport = await call(teams.listTeamEvents, { home: true });
    assert.equal(wrongSport.ok, false);
  });
}

test('概览查询计划：公告一页最多51条+计数，团队首页最多6条+两次计数，所有读取内置范围', async () => {
  const { attachOverviewReads } = require('../src/server/services/school-overview-reads');
  const reads = [];
  const surface = { scope: SCOPE, announcements: {}, teamEvents: {} };
  attachOverviewReads(surface, { inTx: false,
    command: { in: value => ({ in: value }) },
    top: async (key, where, order, limit) => { reads.push({ key, where, order, limit }); return []; },
    count: async (key, where) => { reads.push({ key, where, count: true }); return 0; },
  });
  await surface.announcements.listPage({ status: 'published', limit: 50 });
  await surface.teamEvents.homeSummary({ limit: 5 });
  assert.equal(reads.length, 5);
  assert.deepEqual(reads.filter(row => !row.count).map(row => row.limit), [51, 6]);
  assert.ok(reads.every(row => row.where.schoolId === 'muc'));
  assert.ok(reads.filter(row => row.key.startsWith('team')).every(row => row.where.association === 'pkb'));
  const tx = { scope: SCOPE, announcements: {}, teamEvents: {} };
  attachOverviewReads(tx, { inTx: true });
  await assert.rejects(tx.announcements.listPage(), /事务内/);
  await assert.rejects(tx.teamEvents.homeSummary(), /事务内/);
});
