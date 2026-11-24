/**
 * 前端第一、二批改进的纯逻辑与页面契约
 * ============================================================
 * 守四类容易“看起来改了、实际没生效”的行为：
 *   1. 全部赛事只取一页，筛选条件真正下推，续页不会把旧结果拼进新查询；
 *   2. 晋级之路按阶段 + 轮次分列，并能说清“我的下一场”；
 *   3. 本地统计草稿按版本恢复，版本不同必须报冲突而不是覆盖；
 *   4. 首页行动文案与生涯节点只来自已下发的事实，不新增权限判断。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi } = require('./helpers/page-harness');
const { buildBracketLanes, describeMyBracket } = require('../miniprogram/services/events-view');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const eventHandlers = require('../src/server/services/school-event-service');
const { EVENT_STATUS } = require('../src/shared/utils/constants');
const { keyOf, save, load, clear, merge } = require('../miniprogram/packageTeam/services/stats-draft.js');
const {
  actionTextOf,
  withPersonalActions,
  careerMilestonesOf,
} = require('../miniprogram/templates/personal-sports-client');

const EVENTS = [
  {
    eventId: 'e1', title: '2026 春季赛', statusLabel: '报名中', isSignup: true,
    startTime: '2026-04-01T02:00:00.000Z', level: 2, matchType: 1, quota: 8,
  },
  {
    eventId: 'e2', title: '2026 秋季赛', statusLabel: '已结束', isFinished: true,
    startTime: '2026-10-01T02:00:00.000Z', level: 2, matchType: 1, quota: 16,
  },
];

test('全部赛事：首屏只取一页，筛选与续页都带服务端参数', async () => {
  const calls = [];
  await withApi({
    listSchoolEvents: (payload) => {
      calls.push(payload);
      if (payload.offset > 0) {
        return {
          ok: true, canManage: false, hasMore: false, nextOffset: 2, total: 2,
          events: [EVENTS[1]],
        };
      }
      return {
        ok: true, canManage: true, hasMore: true, nextOffset: 1, total: 2,
        events: [EVENTS[0]],
      };
    },
  }, async () => {
    const page = instantiate(loadPage('event-list'));
    await page.onLoad({});
    assert.equal(calls[0].limit, 20, '首屏不应再使用 Infinity');
    assert.equal(calls[0].offset, 0);
    assert.equal(page.data.view.events.length, 1);
    assert.equal(page.data.hasMore, true);

    await page.onPickStatus({ detail: { value: 2 } });
    assert.equal(calls[calls.length - 1].status, 1, '「进行中」对应 EVENT_STATUS.ONGOING');
    assert.equal(calls[calls.length - 1].offset, 0, '筛选变化必须回到第一页');

    page.setData({ statusIndex: 0, nextOffset: 1 });
    await page.onLoadMore();
    assert.equal(calls[calls.length - 1].offset, 1);
    assert.deepEqual(page.data.view.events.map(row => row.id), ['e1', 'e2']);
    assert.equal(page.data.hasMore, false);
  });
});

test('全部赛事：筛选变化后，旧续页响应不能追加到新列表', async () => {
  let resolveMore;
  let calls = 0;
  await withApi({
    listSchoolEvents: (payload) => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, canManage: false, hasMore: true, nextOffset: 1, total: 3, events: [EVENTS[0]] };
      }
      if (calls === 2) {
        return new Promise((resolve) => { resolveMore = resolve; });
      }
      return { ok: true, canManage: false, hasMore: false, nextOffset: 1, total: 1, events: [EVENTS[1]] };
    },
  }, async () => {
    const page = instantiate(loadPage('event-list'));
    await page.onLoad({});
    const more = page.onLoadMore();
    await page.onPickStatus({ detail: { value: 2 } });
    resolveMore({ ok: true, canManage: false, hasMore: false, nextOffset: 2, total: 2, events: [EVENTS[0]] });
    await more;
    assert.deepEqual(page.data.view.events.map(row => row.id), ['e2'], '旧续页不能污染筛选后的列表');
    assert.equal(page.data.busy, false, '被丢弃的续页也不能把 busy 锁死');
  });
});

test('石榴籽杯：改筛选后旧续页不追加，且不会把 busy 锁死', async () => {
  let resolveMore;
  let calls = 0;
  await withApi({
    listCollegeEvents: (payload) => {
      calls += 1;
      const row = {
        eventId: payload.offset ? 'old-more' : `page-${calls}`,
        title: payload.offset ? '旧续页' : '当前页', status: 0, statusLabel: '报名中',
        legPlanText: '', rosterText: '',
      };
      if (payload.offset) return new Promise((resolve) => { resolveMore = resolve; });
      return { ok: true, canManage: false, events: [row], total: 2, hasMore: true };
    },
  }, async () => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'pkb' });
    const more = page.loadMore();
    await page.onPickYear({ detail: { value: 1 } });
    resolveMore({
      ok: true, canManage: false, total: 1, hasMore: false,
      events: [{ eventId: 'old-more', title: '旧续页', status: 0, statusLabel: '报名中', legPlanText: '', rosterText: '' }],
    });
    await more;
    assert.equal(page.data.rows.some(row => row.eventId === 'old-more'), false,
      '旧续页不能追加到新筛选结果');
    assert.equal(page.data.rows.length, 1);
    assert.equal(page.data.busy, false);
  });
});

test('全部赛事：协会图标与名称进入列表行，供文字 + 图形双重识别', async () => {
  await withApi({
    listSchoolEvents: () => ({
      ok: true, canManage: false, hasMore: false, nextOffset: 1, total: 1,
      events: [EVENTS[0]],
    }),
  }, async () => {
    const page = instantiate(loadPage('event-list'));
    await page.onLoad({});
    const row = page.data.view.events[0];
    assert.ok(row.associationName, '需要协会简称，不能只靠颜色');
    assert.ok(row.associationGlyph, '需要协会文字徽标');
  });
});

test('赛事接口：关键词、年份与状态在同一范围下推，total 是过滤后条数', async () => {
  const seed = createSchoolDemoSeed();
  seed.events = seed.events || [];
  seed.events.push(
    {
      _id: 'evt:muc:pkb:history-2025', schoolId: 'muc', association: 'pkb',
      title: '2025 校友邀请赛', location: '老校区馆', status: EVENT_STATUS.FINISHED,
      startTime: '2025-12-31T15:30:00.000Z', matchType: 1, level: 3,
    },
    {
      _id: 'evt:muc:pkb:spring-2026', schoolId: 'muc', association: 'pkb',
      title: '2026 春季联赛', location: '新校区馆', status: EVENT_STATUS.SIGNUP,
      startTime: '2026-04-01T02:00:00.000Z', matchType: 1, level: 3,
    },
  );
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({
    repo, actorId: 'demo_muc_admin',
    scope: { schoolId: 'muc', association: 'pkb' },
    now: new Date('2026-10-28T10:00:00Z'),
  });
  const call = async payload => (await eventHandlers.listSchoolEvents(payload, ctx)).data;

  const byKeyword = await call({ keyword: '校友', limit: 20, offset: 0 });
  assert.deepEqual(byKeyword.events.map(row => row.eventId), ['evt:muc:pkb:history-2025']);
  assert.equal(byKeyword.total, 1);
  assert.ok(byKeyword.totalAll >= 2, 'totalAll 保留过滤前总量，供概况使用');

  const byYear = await call({ year: '2026', limit: 20, offset: 0 });
  assert.deepEqual(byYear.events.map(row => row.eventId), ['evt:muc:pkb:spring-2026']);

  const byStatus = await call({ status: EVENT_STATUS.SIGNUP, keyword: '联赛', limit: 20, offset: 0 });
  assert.deepEqual(byStatus.events.map(row => row.eventId), ['evt:muc:pkb:spring-2026']);

  const byLocation = await call({ keyword: '老校区', limit: 20, offset: 0 });
  assert.deepEqual(byLocation.events.map(row => row.eventId), ['evt:muc:pkb:history-2025']);
});

test('晋级之路：按阶段和轮次分列，并说清我的下一场/已结束', () => {
  const rows = [
    {
      matchId: 'm1', stage: 'main', round: 1, slot: 0, roundText: '半决赛', groupText: '',
      teamAText: '甲', teamBText: '乙', isMine: true, isWinner: false, winnerSide: '',
      liveActive: false, statusClass: 'tag-gray', statusLabel: '未开始', canRecord: true,
    },
    {
      matchId: 'm2', stage: 'main', round: 2, slot: 0, roundText: '决赛', groupText: '',
      teamAText: '甲', teamBText: '丙', isMine: true, isWinner: false, winnerSide: '',
      liveActive: false, statusClass: 'tag-gray', statusLabel: '未开始', canConfirm: false,
    },
    {
      matchId: 'm3', stage: 'bronze', round: 1, slot: 0, roundText: '季军赛', groupText: '',
      teamAText: '乙', teamBText: '丁', isMine: false, isWinner: false, winnerSide: '',
      liveActive: false, statusClass: 'tag-gray', statusLabel: '未开始',
    },
  ];
  const lanes = buildBracketLanes(rows);
  assert.deepEqual(lanes.map(lane => lane.key), ['main:1', 'main:2', 'bronze:1']);
  assert.deepEqual(lanes.map(lane => lane.label), ['半决赛', '决赛', '季军赛']);
  assert.match(describeMyBracket(rows), /你的下一场：半决赛/);
  assert.match(describeMyBracket([]), /暂未找到/);
});

test('团队赛事详情：后发刷新优先，退出后旧响应不得重新订阅比分', async () => {
  let resolveFirst;
  let calls = 0;
  const baseEvent = {
    eventId: 'tev_1', name: '刷新测试', format: 'single_elim', status: 'scheduled',
    statusLabel: '赛程已发布', entryCount: 2, canManage: true, draw: { size: 2 },
    supportsMatchData: false,
  };
  const response = name => ({
    ok: true,
    event: { ...baseEvent, name },
    matches: [{
      matchId: 'm1', round: 1, stage: 'main', slot: 0, teamA: 'a', teamB: 'b',
      teamAName: '甲', teamBName: '乙', status: 'scheduled', statusLabel: '未开始',
    }],
    entries: [], submitCandidates: [], table: [], placements: [],
  });
  await withApi({
    getTeamEvent: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return response('最新赛事');
    },
  }, async () => {
    const page = instantiate(loadPage('team-event-detail'));
    const first = page.onLoad({ eventId: 'tev_1' });
    const second = page.refresh();
    await second;
    assert.equal(page.data.event.name, '最新赛事');
    resolveFirst(response('旧赛事'));
    await first;
    assert.equal(page.data.event.name, '最新赛事', '后发请求应保持优先');

    // 卸载后只有“离开”这一件事，旧响应不能再改页面状态。
    const pending = page.refresh();
    page.onUnload();
    const before = page.data.event.name;
    await pending;
    assert.equal(page.data.event.name, before);
  });
});

test('统计草稿：按场次隔离、版本一致才恢复，成功后清除', () => {
  const store = new Map();
  const storage = {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    remove: key => store.delete(key),
  };
  const key = keyOf({ schoolId: 'muc', association: 'bk', matchId: 'm1', userId: 'u1' });
  const other = keyOf({ schoolId: 'muc', association: 'bk', matchId: 'm2', userId: 'u1' });
  assert.notEqual(key, other);

  assert.equal(save(key, {
    revision: 2,
    mode: 'basic',
    rows: [{ key: 'r1', points: '12', unknown: 'secret' }],
  }, storage), true);
  const draft = load(key, storage);
  assert.equal(draft.revision, 2);
  assert.equal(draft.rows[0].points, '12');

  const base = [{ key: 'r1', points: '', fouls: '' }, { key: 'r2', points: '', fouls: '' }];
  const merged = merge(base, draft, ['points', 'fouls'], 2);
  assert.equal(merged.restored, true);
  assert.equal(merged.rows[0].points, '12');
  assert.equal(merged.rows[0].unknown, undefined, '未知字段不能进入视图');
  assert.equal(merged.rows[1].points, '', '未被草稿覆盖的行保持服务端值');

  const conflict = merge(base, draft, ['points'], 3);
  assert.equal(conflict.restored, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.rows[0].points, '', '版本不同时不得自动套用旧草稿');

  clear(key, storage);
  assert.equal(load(key, storage), null);
});

test('统计录入：单字段更新能同步到分组，关闭后恢复草稿，保存成功即清除', async () => {
  const event = {
    eventId: 'tev_1', name: '统计测试赛', format: 'single_elim', sportFormat: 'basketball5', status: 'scheduled',
    statusLabel: '赛程已发布', entryCount: 2, canManage: true, draw: { size: 2 },
    supportsMatchData: true, rulesText: '4 节', rules: {},
  };
  const match = {
    matchId: 'm1', round: 1, stage: 'main', slot: 0,
    teamA: 'ta', teamB: 'tb', teamAName: '甲队', teamBName: '乙队',
    status: 'scheduled', statusLabel: '未开始', scoreText: '—', canRecord: true,
  };
  const stats = {
    ok: true,
    match: { matchId: 'm1', teamAName: '甲队', teamBName: '乙队' },
    statPolicy: 'basic', periods: 1, canEdit: true,
    sides: [
      { teamId: 'ta', teamName: '甲队', revision: 0, rows: null, players: [{ userId: 'p1', name: '甲一' }] },
      { teamId: 'tb', teamName: '乙队', revision: 0, rows: null, players: [{ userId: 'p2', name: '乙一' }] },
    ],
  };
  const store = new Map();
  const previousWx = global.wx;
  global.wx = {
    getStorageSync: key => store.get(key),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: key => store.delete(key),
  };
  try {
    await withApi({
      getTeamEvent: () => ({
        ok: true, event, matches: [match], entries: [], submitCandidates: [], table: [], placements: [],
      }),
      getTeamMatchStats: () => stats,
      getTeamEventPlayerStats: () => ({ ok: true, players: [] }),
      saveTeamMatchStats: () => ({ ok: true, warnings: [] }),
    }, async (calls) => {
      const page = instantiate(loadPage('team-event-detail'));
      await page.onLoad({ eventId: 'tev_1' });
      await page.onOpenStats({ currentTarget: { dataset: { matchid: 'm1' } } });
      const target = page.data.statRows.find(row => row.userId === 'p1');
      page.onInputStat({
        currentTarget: { dataset: { key: target.key, field: 'points' } },
        detail: { value: '12' },
      });
      assert.equal(page.data.statRows.find(row => row.userId === 'p1').points, '12');
      assert.equal(page.data.statGroups[0].rows.find(row => row.userId === 'p1').points, '12',
        '分组结构也必须同步，否则界面仍显示空值');

      page.onCloseStats();
      const draftKey = keyOf({
        schoolId: page.scope.schoolId, association: page.scope.association, matchId: 'm1',
      });
      assert.ok(store.has(draftKey), '关闭面板应把未提交输入留在本机');

      await page.onOpenStats({ currentTarget: { dataset: { matchid: 'm1' } } });
      assert.match(page.data.statsDraftNote, /恢复/);
      assert.equal(page.data.statRows.find(row => row.userId === 'p1').points, '12');

      await page.onSaveStats();
      assert.equal(calls.filter(call => call[0] === 'saveTeamMatchStats').length, 1);
      assert.equal(store.has(draftKey), false, '服务端接收后必须清除本地草稿');
    });
  } finally {
    global.wx = previousWx;
  }
});

test('统计草稿：超过 24 小时自动失效并删除', () => {
  const store = new Map();
  const storage = {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    remove: key => store.delete(key),
  };
  const key = 'expired';
  store.set(key, {
    version: 1, savedAt: Date.now() - 25 * 60 * 60 * 1000, revision: 1, mode: 'basic', rows: [],
  });
  assert.equal(load(key, storage), null);
  assert.equal(store.has(key), false);
});

test('首页下一步：按目标类型给明确动词，未知目标仍可回退', () => {
  assert.equal(actionTextOf({ target: { kind: 'confirm_score' }, state: '待确认比分' }), '确认比分');
  assert.equal(actionTextOf({ target: { kind: 'meet_score' }, state: '裁判成绩待提交' }), '提交成绩');
  assert.equal(actionTextOf({ target: { kind: 'team_event' }, state: '待审核报告' }), '审核报告');
  assert.equal(actionTextOf({ target: { kind: 'personal_match' }, state: '进行中' }), '查看现场');
  assert.equal(actionTextOf(null), '查看记录');

  const dashboard = withPersonalActions({
    schedule: { items: [{ target: { kind: 'confirm_score' }, state: '待确认比分' }] },
    tasks: { items: [{ target: { kind: 'school_identity' }, state: '待处理' }] },
  });
  assert.equal(dashboard.schedule.items[0].actionText, '确认比分');
  assert.equal(dashboard.tasks.items[0].actionText, '去审核');
});

test('生涯节点：只收已核验事实，按时间倒序，不生成成长值', () => {
  const items = [
    { key: 'a', time: '2025-01-01T00:00:00Z', timeText: '2025-01-01', title: '2025 春', projectName: '匹克球', proof: '已确认比分', target: {} },
    { key: 'b', time: '2026-10-01T00:00:00Z', timeText: '2026-10-01', title: '2026 秋', projectName: '匹克球', rank: 2, proof: '已发布个人名次', honor: true, target: {} },
    { key: 'c', time: '2026-09-01T00:00:00Z', timeText: '2026-09-01', title: '无证明记录', target: {} },
  ];
  const rows = careerMilestonesOf(items);
  assert.deepEqual(rows.map(row => row.key), ['b', 'a']);
  assert.equal(rows[0].year, '2026');
  assert.equal(rows[0].detail, '第 2 名');
  assert.ok(!JSON.stringify(rows).includes('成长值'));
});
