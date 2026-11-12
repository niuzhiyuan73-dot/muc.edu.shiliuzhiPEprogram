/**
 * 组队两页的装配测试（team-list / team-detail）
 * ============================================================
 * 这两页只做展示与转发：真正的权限与幂等在 team-service 里，已由
 * tests/team-service.test.js 覆盖。这里守的是「界面把动作接到了正确的接口、
 * 拿到了正确的入参、失败时给了人话」——页面拼接错了，服务端再对也没用。
 *
 * 【为什么单开一份工装，而不是并进 page.test.js】
 * page.test.js 用 `registered[N]` 下标取页面配置，新增页面就得同步维护下标，
 * 加一页错一次。这里按**文件路径**加载（loadPage），不依赖注册顺序；
 * page.test.js 的注册方式后续单独重构，不在这批里搅动。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const space = require('../miniprogram/services/association-space.js');
const associationScope = require('../miniprogram/services/association-scope.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const {
  cloneData, loadPage, instantiate, withApi,
} = require('./helpers/page-harness.js');

/** 页面的 wx 桩：navigateTo / navigateBack / showModal(默认确认) */
function withWx(run) {
  const previous = global.wx;
  const modals = [];
  global.wx = {
    navigateTo: () => undefined,
    navigateBack: () => undefined,
    showModal: (options) => {
      modals.push(options.title);
      if (options.success) options.success({ confirm: true });
    },
  };
  return Promise.resolve(run(modals)).finally(() => { global.wx = previous; });
}

const TEAM = {
  teamId: 'tm_1', name: '热浪队', initial: '热', sport: 'basketball', college: '',
  status: 'active', statusLabel: '正常', captainId: 'u_cap', captainName: '队长',
  memberCount: 1, isMine: false, isCaptain: false, canManage: false, canApply: true,
  pending: false, membershipStatus: '', membershipLabel: '',
};

/* ============================================================
 * team-list
 * ============================================================ */

test('组队列表 —— 首屏取列表并落到 data，空列表给出提示', () => withApi({
  listTeams: () => ({ ok: true, teams: [], canManage: false }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.teams, []);
  assert.equal(calls[0][0], 'listTeams');
  assert.equal(calls[0][1].mine, false);
}));

test('组队列表 —— 搜索与「我的球队」都会重新取数，并把条件带上', () => withApi({
  listTeams: (payload) => ({ ok: true, teams: payload.mine ? [TEAM] : [], canManage: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  page.onInputKeyword({ detail: { value: '热浪' } });
  await page.onSearch();
  assert.equal(calls.at(-1)[1].keyword, '热浪');

  await page.onToggleMine();
  assert.equal(page.data.mineOnly, true);
  assert.equal(calls.at(-1)[1].mine, true);
  assert.equal(page.data.teams.length, 1);
  assert.equal(page.data.canManage, true);
}));

test('组队列表 —— 建队成功给出待审提示并刷新；失败把原因留在页面上', () => withApi({
  listTeams: () => ({ ok: true, teams: [], canManage: false }),
  createTeamApplication: (payload) => (payload.name === '热浪队'
    ? { ok: true, teamId: 'tm_1' }
    : { ok: false, message: '同协会已有同名球队，请换一个名字' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '热浪队' } });
  await page.onSubmitCreate();
  assert.equal(page.data.creating, false, '成功后收起表单');
  assert.match(page.data.notice, /等协会负责人审核/);
  const created = calls.find(call => call[0] === 'createTeamApplication');
  assert.equal(created[1].name, '热浪队');
  assert.match(created[1].requestId, /^team_/, '请求编号由页面生成');

  page.onOpenCreate();
  page.onInputName({ detail: { value: '重复队' } });
  await page.onSubmitCreate();
  assert.equal(page.data.noticeError, true);
  assert.match(page.data.notice, /同名/);
}));

test('组队列表 —— 接口抛错时给「请稍后重试」，不把异常抛到页面外', () => withApi({
  listTeams: () => { throw new Error('boom'); },
}, async () => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();
  assert.equal(page.data.loading, false);
  assert.match(page.data.error, /稍后重试/);
}));

test('组队列表 —— 并发刷新时过期响应不覆盖新结果', () => {
  const pending = [];
  return withApi({
    listTeams: payload => new Promise((resolve) => { pending.push({ payload, resolve }); }),
  }, async () => {
    const page = instantiate(loadPage('team-list/team-list.js'));
    const first = page.onLoad();
    await new Promise(resolve => setImmediate(resolve));
    page.onInputKeyword({ detail: { value: '热浪' } });
    const second = page.onSearch();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(pending.length, 2, '应有两次在途请求');
    const fresh = { ...TEAM, teamId: 'tm_new', name: '新条件的结果' };
    const stale = { ...TEAM, teamId: 'tm_old', name: '旧条件的结果' };
    // 逆序返回：新的先到，旧的迟到——旧响应不许回写
    pending[1].resolve({ ok: true, teams: [fresh], canManage: false });
    pending[0].resolve({ ok: true, teams: [stale], canManage: false });
    await Promise.all([first, second]);
    assert.deepEqual(page.data.teams.map(row => row.teamId), ['tm_new']);
  });
});

test('组队列表 —— 刷新失败清掉旧列表，不把旧数据配新错误', () => {
  let fail = false;
  return withApi({
    listTeams: () => (fail
      ? { ok: false, message: '加载失败' }
      : { ok: true, teams: [TEAM], canManage: false, hasMore: true, nextOffset: 20, total: 21 }),
  }, async () => {
    const page = instantiate(loadPage('team-list/team-list.js'));
    await page.onLoad();
    assert.equal(page.data.teams.length, 1);
    fail = true;
    await page.refresh();
    assert.deepEqual(page.data.teams, []);
    assert.equal(page.data.hasMore, false);
    assert.equal(page.data.nextOffset, 0);
    assert.match(page.data.error, /加载失败/);
  });
});

/* ============================================================
 * team-detail
 * ============================================================ */

test('球队详情 —— 首屏拉到球队与名单；普通成员只看到在队的人', () => withApi({
  getTeam: () => ({
    ok: true,
    team: TEAM,
    members: [{ userId: 'u_cap', name: '队长', role: 'captain', status: 'active', statusLabel: '在队' }],
    pendingCount: 0,
  }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.scope = { schoolId: 'muc', association: 'bk' };
  page.data.teamId = 'tm_1';
  await page.onLoad({ teamId: 'tm_1' });

  assert.equal(page.data.error, '');
  assert.equal(page.data.team.name, '热浪队');
  assert.equal(page.data.members.length, 1);
  assert.equal(calls[0][0], 'getTeam');
  assert.equal(calls[0][1].teamId, 'tm_1');
}));

test('球队详情 —— 申请入队走 applyToJoinTeam，成功提示等队长审批', () => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, canApply: false, pending: true }, members: [], pendingCount: 0 }),
  applyToJoinTeam: () => ({ ok: true, status: 'pending' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';
  await page.onApply();

  assert.equal(calls[0][0], 'applyToJoinTeam');
  assert.equal(calls[0][1].teamId, 'tm_1');
  assert.match(page.data.notice, /等队长审批/);
}));

test('球队详情 —— 队长审批入队：通过带 approve=true，拒绝带 false', () => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, canManage: true }, members: [], pendingCount: 1 }),
  reviewTeamMember: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';

  await page.onApprove({ currentTarget: { dataset: { userid: 'u_m1' } } });
  const approved = calls.filter(call => call[0] === 'reviewTeamMember');
  assert.deepEqual(approved[0][1], { teamId: 'tm_1', userId: 'u_m1', approve: true });

  await page.onReject({ currentTarget: { dataset: { userid: 'u_m2' } } });
  const reviewed = calls.filter(call => call[0] === 'reviewTeamMember');
  assert.deepEqual(reviewed[1][1], { teamId: 'tm_1', userId: 'u_m2', approve: false });
}));

test('球队详情 —— 转让队长与归档都要二次确认', () => withWx(async (modals) => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, isCaptain: true, canManage: true }, members: [], pendingCount: 0 }),
  transferTeamCaptain: () => ({ ok: true }),
  archiveTeam: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';

  await page.onTransfer({ currentTarget: { dataset: { userid: 'u_m1', name: '小李' } } });
  assert.deepEqual(modals, ['转让队长']);
  const transferred = calls.find(call => call[0] === 'transferTeamCaptain');
  assert.deepEqual(transferred[1], { teamId: 'tm_1', userId: 'u_m1' });

  await page.onArchive();
  assert.deepEqual(modals, ['转让队长', '归档球队']);
  assert.ok(calls.some(call => call[0] === 'archiveTeam'));
})));

test('球队详情 —— 业务失败时把服务端原话显示出来，不吞掉', () => withApi({
  getTeam: () => ({ ok: true, team: TEAM, members: [], pendingCount: 0 }),
  leaveTeam: () => ({ ok: false, message: '队长不能直接退队：请先转让队长，或直接归档这支球队' }),
}, async () => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';
  await page.onLeave();

  assert.equal(page.data.noticeError, true);
  assert.match(page.data.notice, /转让队长/);
  assert.equal(page.data.busy, false, '失败后要解除防连点');
}));

/* ============================================================
 * team-detail：战绩（P3）
 * ============================================================ */

function recordFixture(overrides = {}) {
  return {
    ok: true,
    team: {
      teamId: 'tm_1', name: '热浪队', status: 'active', statusLabel: '正常',
      archived: false, captainName: '队长', memberCount: 6,
    },
    overall: {
      games: 6, wins: 4, losses: 2, draws: 0, winRate: 67, winRateText: '67%',
      recordText: '6 场 · 4 胜 2 负',
    },
    seasons: [
      { eventId: 'tev_1', name: '秋季联赛', status: 'finished', statusLabel: '已结束', placement: 1, placementText: '冠军', recordText: '3 场 · 3 胜 0 负' },
      { eventId: 'tev_2', name: '新生杯', status: 'running', statusLabel: '进行中', placement: null, placementText: '', recordText: '3 场 · 1 胜 2 负' },
    ],
    recent: [
      { matchId: 'm1', opponentName: '闪电队', eventName: '秋季联赛', scoreText: '80 : 70', result: 'win', resultLabel: '胜', matchTimeText: '2026-10-20 14:00' },
      { matchId: 'm2', opponentName: '风暴队', eventName: '秋季联赛', scoreText: '62 : 75', result: 'loss', resultLabel: '负', matchTimeText: '' },
    ],
    ...overrides,
  };
}

test('球队详情 —— 战绩单独取，总胜负、历届名次与近期比赛都落到 data', () => withApi({
  getTeam: () => ({ ok: true, team: TEAM, members: [], pendingCount: 0 }),
  getTeamRecord: () => recordFixture(),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  await page.onLoad({ teamId: 'tm_1' });
  await page.loadRecord();

  assert.equal(page.data.record.overall.winRateText, '67%');
  assert.equal(page.data.record.overall.wins, 4);
  assert.equal(page.data.record.seasons[0].placementText, '冠军');
  assert.equal(page.data.record.seasons[1].placementText, '');
  assert.equal(page.data.record.recent[0].resultLabel, '胜');
  assert.equal(page.data.recordError, '');
  assert.equal(calls.find(call => call[0] === 'getTeamRecord')[1].teamId, 'tm_1');
}));

test('球队详情 —— 战绩取不到时只坏这一块，球队与名单照常显示', () => withApi({
  getTeam: () => ({ ok: true, team: TEAM, members: [], pendingCount: 0 }),
  getTeamRecord: () => ({ ok: false, message: '战绩服务暂不可用' }),
}, async () => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  await page.onLoad({ teamId: 'tm_1' });
  await page.loadRecord();

  assert.equal(page.data.team.name, '热浪队', '名单不该被战绩拖垮');
  assert.equal(page.data.record, null);
  assert.equal(page.data.recordError, '战绩服务暂不可用');
  assert.equal(page.data.error, '', '整页错误不该被点亮');
}));

test('球队详情 —— 归档球队的战绩照样能看', () => withApi({
  getTeam: () => ({
    ok: true,
    team: { ...TEAM, status: 'archived', statusLabel: '已归档', canApply: false },
    members: [],
    pendingCount: 0,
  }),
  getTeamRecord: () => recordFixture({
    team: { teamId: 'tm_1', name: '热浪队', status: 'archived', statusLabel: '已归档', archived: true, captainName: '队长', memberCount: 6 },
  }),
}, async () => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  await page.onLoad({ teamId: 'tm_1' });
  await page.loadRecord();

  assert.equal(page.data.record.team.archived, true);
  assert.equal(page.data.record.seasons[0].placementText, '冠军', '历史成绩不随归档消失');
  assert.equal(page.data.record.overall.games, 6);
}));
