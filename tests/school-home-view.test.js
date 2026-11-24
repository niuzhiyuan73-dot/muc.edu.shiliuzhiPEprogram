/**
 * B4-b：学校维度首页装载器（school-home-view）
 * ============================================================
 * 守的是：
 *   1. 首页按「当前浏览学校」聚合公告 / 近期赛事 / 概况（公告 2026-10-18 起是
 *      学校级一条通道，只取一次；赛事与概况仍按协会汇总）；
 *   2. 游客只看公告（§11.8），赛事与概况不取；
 *   3. 跨校只读浏览得到真实空聚合，不编数字、不展示静态演示内容；
 *   4. 分页循环取完，不把第一页当全集；单协会读失败跳过，不拖垮整页。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../miniprogram/services/runtime-mode.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const {
  loadSchoolHomeView, announcementRow, eventRow, isUpcomingEvent, sortUpcoming,
} = require('../miniprogram/services/school-home-view.js');

beforeEach(() => {
  runtime.setDataSource('mock');
  schoolMock.reset();
  schoolSession.reset();
});

/* ============================================================
 * 纯函数
 * ============================================================ */

test('isUpcomingEvent —— 只认报名中 / 进行中', () => {
  assert.strictEqual(isUpcomingEvent({ isSignup: true }), true);
  assert.strictEqual(isUpcomingEvent({ isOngoing: true }), true);
  assert.strictEqual(isUpcomingEvent({ isSignup: false, isOngoing: false }), false);
  assert.strictEqual(isUpcomingEvent(null), false);
});

test('sortUpcoming —— 只留近期、开赛时间升序、按 limit 截断', () => {
  const rows = [
    { id: 'a', isSignup: false, isOngoing: true, startTime: '2026-11-05T09:00:00' },
    { id: 'b', isSignup: true, isOngoing: false, startTime: '2026-10-20T09:00:00' },
    { id: 'c', isSignup: false, isOngoing: false, startTime: '2026-10-01T09:00:00' }, // 已结束
  ];
  const result = sortUpcoming(rows, 3);
  assert.deepStrictEqual(result.map((row) => row.id), ['b', 'a'], '已结束不进近期，最近要打的在前');
});

test('announcementRow / eventRow —— 渲染字段齐备，无 undefined 泄露', () => {
  const assoc = { id: 'pkb', shortName: '匹克球', logoGlyph: '匹' };
  // 公告是学校级的一条通道：不再带协会标注与分类
  const a = announcementRow(
    { announcementId: 'ann_1', title: 't', content: '', pinned: false, publishTime: '2026-10-01T00:00:00Z' }
  );
  const e = eventRow(
    { eventId: 'ev_1', title: 't', statusLabel: '报名中', isOngoing: false, startTime: null, location: '', quotaText: '', mySignup: null },
    assoc
  );
  assert.ok(!JSON.stringify([a, e]).includes('undefined'), '渲染行里出现 undefined');
  assert.strictEqual(a.id, 'ann_1');
  assert.strictEqual(a.association, undefined, '公告不带协会标注');
  assert.strictEqual(e.association, 'pkb');
  assert.strictEqual(e.associationName, '匹克球');
  assert.strictEqual(e.associationGlyph, '匹');
  assert.strictEqual(e.signedUp, false);
});

/* ============================================================
 * 真实 mock 聚合
 * ============================================================ */

test('聚合 —— 民大首页：公告置顶在前、近期赛事、概况数字来自 S2', async () => {
  schoolMock.setDemoActor('u06');
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06' });

  assert.strictEqual(view.loggedIn, true);
  assert.ok(view.announcements.rows.length > 0);
  assert.strictEqual(view.announcements.rows[0].pinned, true, '置顶公告排在最前');
  // 公告是学校级的一条通道：民大演示 5 条，不按协会重复
  assert.strictEqual(view.announcements.total, 5, '演示公告按学校一份');
  for (const row of view.announcements.rows) {
    assert.ok(row.id && row.title, '每条公告带编号与标题');
    assert.strictEqual(row.associationName, undefined, '公告不再标注所属协会');
  }

  // 报名中的赛事：各协会汇总后默认只展示前 3 条（home-view 的 DEFAULT_EVENT_LIMIT）
  assert.strictEqual(view.upcomingEvents.length, 3, '近期赛事按默认条数截断');
  const upcoming = view.upcomingEvents[0];
  assert.strictEqual(upcoming.signedUp, false);
  assert.ok(upcoming.timeText, '赛事带开赛时间文案');

  // 会员数学校级一份（24 + 校管理员 + 会员 + 会员二 + 学院负责人）；比赛 / 赛事按协会汇总
  assert.strictEqual(view.summary.memberCount, 28);
  // 2026-10-20 起演示内容按 3 倍扩容，这里跟着走（球拍项目的赛事与流水都 ×3）
  const seed = require('../miniprogram/services/school-seed').createSchoolDemoContent();
  assert.strictEqual(view.summary.matchCount, seed.matches.filter(row => row.schoolId === 'muc').length
    + seed.teamMatches.filter(row => row.schoolId === 'muc').length);
  assert.strictEqual(view.summary.eventCount, seed.events.filter(row => row.schoolId === 'muc').length
    + seed.teamEvents.filter(row => row.schoolId === 'muc' && row.status !== 'draft').length);
  assert.strictEqual(view.summary.seasonText, '第 1 赛季');
});

test('聚合 —— 游客只看公告：近期赛事与概况不取', async () => {
  schoolMock.setDemoActor('u06');
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: '' });

  assert.strictEqual(view.loggedIn, false);
  assert.ok(view.announcements.rows.length > 0, '访客能看公告');
  assert.deepStrictEqual(view.upcomingEvents, [], '访客看不到近期赛事');
  assert.strictEqual(view.summary, null, '访客看不到概况');
});

test('首页跨项目：足球、篮球均展示为团队赛事；管理员也看不到已下架公告', async () => {
  schoolMock.setDemoActor('demo_muc_admin');
  const api = schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'pkb' });
  const first = await api.listSchoolAnnouncements({});
  const archivedId = first.announcements[0].announcementId;
  assert.equal((await api.archiveSchoolAnnouncement({ announcementId: archivedId })).ok, true);
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'demo_muc_admin', eventLimit: 100 });
  assert.ok(view.upcomingEvents.some(row => row.association === 'fb' && row.eventKind === 'team'));
  assert.ok(view.upcomingEvents.some(row => row.association === 'bk' && row.eventKind === 'team'));
  assert.ok(view.upcomingEvents.some(row => row.eventKind === 'individual'));
  assert.ok(!view.announcements.rows.some(row => row.id === archivedId));
});

test('聚合 —— 跨校只读浏览得到真实空聚合，不编数字', async () => {
  schoolMock.setDemoActor('demo_muc_member');
  const view = await loadSchoolHomeView({ schoolId: 'buaa', viewerId: 'demo_muc_member' });

  assert.strictEqual(view.loggedIn, true);
  assert.deepStrictEqual(view.announcements.rows, [], '民大会员读不到北航公告');
  assert.deepStrictEqual(view.upcomingEvents, []);
  assert.strictEqual(view.summary, null, '读不到任何协会时不编概况数字');
});

/* ============================================================
 * 分页与容错（注入替身客户端）
 * ============================================================ */

function fakeClient({ announcements = [], events = [], matchTotal = 0, seasonNumber = 1, memberTotal = 0, failAssociations = [] }) {
  const associations = require('../src/shared/utils/associations.js').allAssociations();
  const apiFor = (assocId) => ({
    async listSchoolAnnouncements(payload = {}) {
      if (failAssociations.includes(assocId)) throw new Error('没有读取协会空间的权限');
      const limit = payload.limit || 20;
      const page = announcements.slice(0, limit);
      return { ok: true, announcements: page, hasMore: announcements.length > page.length };
    },
    async listSchoolEvents(payload = {}) {
      if (failAssociations.includes(assocId)) throw new Error('没有读取协会空间的权限');
      const limit = payload.limit || 50;
      const offset = payload.offset || 0;
      // 与服务端同口径：status 支持单个值或数组、order 决定时间方向、
      // total 是筛选后的条数、totalAll 是筛选前的总量（概况用）
      const wanted = Array.isArray(payload.status)
        ? payload.status
        : (typeof payload.status === 'number' ? [payload.status] : []);
      const matchesStatus = (event) => {
        if (wanted.length === 0) return true;
        const status = event.isSignup ? 0 : (event.isOngoing ? 1 : 2);
        return wanted.includes(status);
      };
      const filtered = events.filter(matchesStatus);
      const ascending = payload.order === 'asc';
      const sorted = filtered.slice().sort((a, b) => {
        const ta = Date.parse(a.startTime) || 0;
        const tb = Date.parse(b.startTime) || 0;
        return ascending ? ta - tb : tb - ta;
      });
      const page = sorted.slice(offset, offset + limit);
      return {
        ok: true,
        events: page,
        hasMore: offset + page.length < sorted.length,
        nextOffset: offset + page.length,
        total: sorted.length,
        totalAll: events.length,
      };
    },
    async listSchoolMatches() {
      return { ok: true, total: matchTotal, matches: [], hasMore: false };
    },
    async listTeamEvents(payload = {}) {
      if (failAssociations.includes(assocId)) throw new Error('没有读取协会空间的权限');
      return { ok: true, events: events.filter(event => event.isSignup || event.isOngoing).slice(0, payload.limit || 5)
        .map(event => ({ ...event, eventKind: 'team' })), totalAll: events.length, matchTotal };
    },
    async getSchoolSeason() {
      return { ok: true, season: { seasonNumber } };
    },
    async listSchoolMembers() {
      return { ok: true, total: memberTotal, members: [] };
    },
  });
  const forScope = (scope) => apiFor(scope.association);
  return { forScope, associations };
}

test('聚合 —— 公告超过单页限量时如实带 hasMore，概况赛事数取服务端总量', async () => {
  const announcements = Array.from({ length: 120 }, (_, i) => ({
    announcementId: `a${i}`, title: `公告${i}`, content: '', category: '通知',
    pinned: i === 0, publishTime: `2026-10-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const events = Array.from({ length: 80 }, (_, i) => ({
    eventId: `e${i}`, title: `赛${i}`, statusLabel: '已结束', isSignup: false, isOngoing: false,
    startTime: '2026-01-01T09:00:00', location: '', quotaText: '', mySignup: null,
  }));
  const client = fakeClient({ announcements, events, matchTotal: 5, memberTotal: 10 });
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', client });

  // 公告服务端单页限量 50（无 offset）：首页展示第一页的前 3 条，如实带上 hasMore
  assert.strictEqual(view.announcements.hasMore, true);
  assert.strictEqual(view.announcements.rows.length, 2, '首屏展示两条公告摘要');
  assert.strictEqual(view.announcements.rows[0].pinned, true, '置顶在最前');
  // 概况的赛事数用服务端返回的 totalAll（筛选前的总量），不再靠「循环取完再数」
  // 协会数由注册表决定（按 N 个设计），新增协会时聚合口径自然扩展，不必改数字
  const { activeAssociations } = require('../src/shared/utils/associations.js');
  const assocCount = activeAssociations().length;
  assert.strictEqual(view.summary.eventCount, 80 * assocCount, '概况赛事数按协会相加');
  assert.strictEqual(view.summary.matchCount, 5 * assocCount);
});

test('聚合 —— 单协会读失败跳过，其余协会照常聚合（公告不受影响）', async () => {
  const announcements = [{
    announcementId: 'a1', title: '停训通知', content: '',
    pinned: false, publishTime: '2026-10-01T00:00:00Z',
  }];
  const client = fakeClient({ announcements, failAssociations: ['tt', 'bd'] });
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', client });

  // 公告走第一个协会的客户端一次取全（它是学校级集合），tt / bd 失败与它无关
  assert.strictEqual(view.announcements.total, 1);
  assert.strictEqual(view.announcements.rows[0].title, '停训通知');
});

/**
 * 首页不再按协会循环取完赛事（2026-10-22 大用户量复查 H-1）
 * ============================================================
 * 原来每个协会 `collectEvents` 要循环翻页取**全部**赛事，而首页只展示 3 条。
 * 一个协会 200 场赛事就是 2 页 RPC，6 个协会还要在内存里排序全部；
 * 会员数更贵——按 6 个协会各读一遍全校名单，2000 人的学校就是 250 次读。
 *
 * 现在：每协会一次查询、只取「最近要开的几条」（status=[报名中,进行中] +
 * order=asc），会员数与赛季从协会循环里拎出来只读一次。
 */
test('首页每协会只发一次赛事查询，且只取近期几条', async () => {
  const events = Array.from({ length: 80 }, (_, i) => ({
    eventId: `e${i}`, title: `赛${i}`, statusLabel: '报名中', isSignup: true, isOngoing: false,
    startTime: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T09:00:00`,
    location: '', quotaText: '', mySignup: null,
  }));
  const base = fakeClient({ events, matchTotal: 5, memberTotal: 10 });

  const eventCalls = [];
  const memberCalls = [];
  const client = {
    associations: base.associations,
    forScope: (scope) => {
      const api = base.forScope(scope);
      return {
        ...api,
        async listSchoolEvents(payload = {}) {
          eventCalls.push({ assoc: scope.association, ...payload });
          return api.listSchoolEvents(payload);
        },
        async listTeamEvents(payload = {}) {
          eventCalls.push({ assoc: scope.association, ...payload });
          return api.listTeamEvents(payload);
        },
        async listSchoolMembers(payload = {}) {
          memberCalls.push(scope.association);
          return api.listSchoolMembers(payload);
        },
      };
    },
  };

  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', client });

  assert.strictEqual(eventCalls.length, base.associations.length,
    '每协会一次赛事查询：翻页循环会让读量随赛事总量增长');
  assert.ok(eventCalls.every(call => call.limit <= 10),
    `每个协会只该取首页需要的几条，实际取了 ${eventCalls.map(c => c.limit).join('/')}`);
  assert.deepStrictEqual(eventCalls[0].status, [0, 1], '只要报名中 + 进行中');
  assert.strictEqual(eventCalls[0].order, 'asc', '首页要「最近要打的在前」');
  assert.strictEqual(view.upcomingEvents.length, 3, '首屏仍只展示 3 条');

  assert.strictEqual(memberCalls.length, 1,
    '会员数是学校级的一份数字，读 6 遍等于把全校名单读 6 遍');
  assert.strictEqual(view.summary.memberCount, 10);
  assert.strictEqual(view.summary.eventCount, 80 * base.associations.length,
    '概况的赛事数仍是全部赛事，没有被「只看近期」的筛选带偏');
});
