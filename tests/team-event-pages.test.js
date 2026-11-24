/**
 * 团队赛事两页的装配测试（team-event-list / team-event-detail）
 * ============================================================
 * 后端（team-event-service）已由 tests/team-event.test.js 覆盖到全流程。
 * 这里守的是界面这一层：动作接到哪个接口、带什么参数、失败时给什么话、
 * 轮次标题算得对不对。
 *
 * 与 team-pages.test.js 共用 tests/helpers/page-harness.js 的工装。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness.js');
const associationScope = require('../miniprogram/services/association-scope.js');

// 团队赛事页只在团队协会下打开；测试工装默认是匹克球，显式切到篮球。
associationScope.setAssociation('bk');

const EVENT = {
  eventId: 'tev_1',
  name: '秋季联赛',
  format: 'single_elim',
  sportFormat: 'basketball5',
  status: 'locked',
  statusLabel: '名单已锁定',
  rulesText: '4 节 × 10 分钟 · 个人 5 犯离场 · 全队每节第 5 犯起罚球 · 加时 5 分钟',
  rules: { presetKey: 'fiba-4x10' },
  entryCount: 4,
  canManage: true,
  createdAt: '2026-10-19T10:00:00.000Z',
};

function matchOf(round, slot, extra = {}) {
  return {
    matchId: `x_tev_1_r${round}_main_${slot}`,
    round,
    stage: 'main',
    slot,
    teamA: `tm_${round}${slot}a`,
    teamB: `tm_${round}${slot}b`,
    teamAName: `甲队${round}${slot}`,
    teamBName: `乙队${round}${slot}`,
    scoreA: null,
    scoreB: null,
    scoreText: '—',
    overtime: false,
    forfeit: null,
    winner: null,
    status: 'scheduled',
    statusLabel: '未开赛',
    canRecord: true,
    canPublish: true,
    ...extra,
  };
}

/* ============================================================
 * team-event-list
 * ============================================================ */

test('赛事列表 —— 首屏取列表，空态与可建赛标记落到 data', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.events, []);
  assert.equal(page.data.canManage, true);
  assert.equal(calls[0][0], 'listTeamEvents');
}));

test('赛事列表 —— 建赛带上赛制与规则预设，成功后收起表单并刷新', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [EVENT], canManage: true }),
  createTeamEvent: () => ({ ok: true, eventId: 'tev_1' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '秋季联赛' } });
  page.onPickFormat({ detail: { value: 1 } }); // 循环赛
  page.onPickPreset({ detail: { value: 1 } }); // 校园 2×20
  await page.onSubmitCreate();

  const created = calls.find(call => call[0] === 'createTeamEvent');
  assert.equal(created[1].name, '秋季联赛');
  assert.equal(created[1].format, 'round_robin');
  assert.equal(created[1].presetKey, 'campus-2x20');
  assert.match(created[1].requestId, /^tev_/, '请求编号由页面生成');
  assert.equal(page.data.creating, false);
  assert.match(page.data.notice, /报名/);
  assert.equal(calls.filter(call => call[0] === 'listTeamEvents').length, 2, '建完要刷新列表');
}));

test('赛事列表 —— 建赛失败把服务端原话留在页面上，表单不收起', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
  createTeamEvent: () => ({ ok: false, message: '同协会已有同名赛事' }),
}, async () => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '秋季联赛' } });
  await page.onSubmitCreate();

  assert.equal(page.data.creating, true, '失败不能把用户填的东西收掉');
  assert.equal(page.data.notice, '同协会已有同名赛事');
  assert.equal(page.data.noticeError, true);
}));

test('赛事列表 —— 点一行打开详情', async () => {
  await withApi({
    listTeamEvents: () => ({ ok: true, events: [EVENT], canManage: false }),
  }, async () => {
    await withWx(async ({ navigations }) => {
      const page = instantiate(loadPage('team-event-list/team-event-list.js'));
      await page.onLoad();
      page.onOpenEvent({ currentTarget: { dataset: { eventid: 'tev_1' } } });
      assert.match(navigations[0], /team-event-detail\?eventId=tev_1/);
    });
  });
});

/* ============================================================
 * team-event-detail
 * ============================================================ */

/** 一份四队淘汰赛的详情：两场半决赛 + 一场决赛 */
function detailFixture(overrides = {}) {
  return {
    ok: true,
    event: EVENT,
    entries: [
      {
        teamId: 'tm_a', teamName: '热浪队', status: 'locked', statusLabel: '已锁定', rosterCount: 6, placement: null,
      },
      {
        teamId: 'tm_b', teamName: '闪电队', status: 'submitted', statusLabel: '待审核', rosterCount: 5, placement: null,
      },
    ],
    matches: [
      matchOf(1, 0),
      matchOf(1, 1),
      matchOf(2, 0),
    ],
    submitCandidates: [],
    table: [],
    placements: [],
    ...overrides,
  };
}

test('赛事详情 —— 按轮次分组，四队签表的第 1 轮叫半决赛、第 2 轮叫决赛', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'scheduled', draw: { size: 4 } },
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.rounds.map(round => round.label), ['半决赛', '决赛']);
  assert.equal(page.data.rounds[0].matches.length, 2);
  assert.equal(page.data.rounds[1].matches.length, 1);
}));

test('赛事详情 —— 缺少赛事编号时给一句人话，不发请求', () => withApi({}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({});

  assert.equal(page.data.loading, false);
  assert.match(page.data.error, /缺少赛事编号/);
  assert.equal(calls.length, 0);
}));

test('赛事详情 —— 报名面板的身份文案与按钮文案由服务端下发', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'registration', isCollegeCup: true },
    entryPanel: { mode: 'school_admin', hint: '你是校级 / 协会管理员：可代任意学院报名，报名后仍需审核。' },
    submitCandidates: [
      { teamId: 'tm_c02', name: '民族学与社会学学院代表队', enough: true, actionText: '代 民族学与社会学学院 报名' },
    ],
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.entryPanel.mode, 'school_admin');
  assert.match(page.data.entryPanel.hint, /代任意学院报名/);
  assert.match(page.data.submitCandidates[0].actionText, /^代 /);
}));

test('赛事详情 —— 报名审核与锁定名单接的是对应接口', () => withApi({
  getTeamEvent: () => detailFixture({ event: { ...EVENT, status: 'registration' } }),
  reviewTeamEntry: () => ({ ok: true }),
  lockTeamEntries: () => ({ ok: true, locked: 2 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onApproveEntry({ currentTarget: { dataset: { teamid: 'tm_b' } } });
  const approved = calls.find(call => call[0] === 'reviewTeamEntry');
  assert.deepEqual(approved[1], { eventId: 'tev_1', teamId: 'tm_b', approve: true });

  await page.onRejectEntry({ currentTarget: { dataset: { teamid: 'tm_b' } } });
  const rejected = calls.filter(call => call[0] === 'reviewTeamEntry')[1];
  assert.equal(rejected[1].approve, false);

  await page.onLock();
  assert.equal(calls.filter(call => call[0] === 'lockTeamEntries').length, 1);
}));

test('赛事详情 —— 队长点「报名」先打开选人面板，勾完才提交', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'registration' },
    submitCandidates: [
      { teamId: 'tm_a', name: '热浪队', memberCount: 6, enough: true, need: 5 },
      { teamId: 'tm_b', name: '闪电队', memberCount: 4, enough: false, need: 5 },
    ],
  }),
  getTeamEntryRoster: () => ({
    ok: true,
    event: { eventId: 'tev_1', name: '秋季联赛', entryMin: 5, entryMax: 12, status: 'registration' },
    team: { teamId: 'tm_a', name: '热浪队', captainId: 'u_cap' },
    members: [
      { userId: 'u_cap', name: '队长', no: 4, selected: true },
      { userId: 'u_p1', name: '队员一', no: null, selected: true },
      { userId: 'u_p2', name: '队员二', no: null, selected: true },
      { userId: 'u_p3', name: '队员三', no: null, selected: true },
      { userId: 'u_p4', name: '队员四', no: null, selected: true },
      { userId: 'u_p5', name: '队员五', no: null, selected: false },
    ],
    status: null,
    canEdit: true,
  }),
  submitTeamEntry: () => ({ ok: true, status: 'submitted', rosterCount: 6 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.submitCandidates.length, 2);
  assert.equal(page.data.submitCandidates[1].enough, false, '人数不足的队不该给报名按钮');

  await page.onSubmitEntry({ currentTarget: { dataset: { teamid: 'tm_a' } } });
  assert.ok(page.data.entryEditing, '先开选人面板，不直接提交');
  assert.equal(page.data.entryEditing.selectedCount, 5);
  assert.equal(calls.filter(call => call[0] === 'submitTeamEntry').length, 0);

  // 勾上第六个人并给两个号码，再提交
  page.onToggleEntryMember({ currentTarget: { dataset: { userid: 'u_p5' } } });
  page.onInputJersey({ currentTarget: { dataset: { userid: 'u_p5' } }, detail: { value: '9' } });
  assert.equal(page.data.entryEditing.selectedCount, 6);
  await page.onSaveEntry();

  const submitted = calls.find(call => call[0] === 'submitTeamEntry');
  assert.equal(submitted[1].eventId, 'tev_1');
  assert.equal(submitted[1].teamId, 'tm_a');
  assert.deepEqual(submitted[1].roster[0], { userId: 'u_cap', no: '4' }, '号码按输入框字符串带回，服务端归一');
  assert.equal(submitted[1].roster.length, 6);
  assert.equal(submitted[1].roster[5].no, '9');
  assert.equal(page.data.entryEditing, null, '提交成功收起面板');
  assert.match(page.data.notice, /已报名 6 人/);
}));

test('赛事详情 —— 名单不能再改时，报名面板不打开', () => withApi({
  getTeamEvent: () => detailFixture({ event: { ...EVENT, status: 'registration' } }),
  getTeamEntryRoster: () => ({ ok: true, canEdit: false, members: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onSubmitEntry({ currentTarget: { dataset: { teamid: 'tm_a' } } });

  assert.equal(page.data.entryEditing, null);
  assert.match(page.data.notice, /不能修改这份名单/);
  assert.equal(calls.filter(call => call[0] === 'submitTeamEntry').length, 0);
}));

test('赛事详情 —— 抽签、排下一轮、结算都带赛事编号', () => withApi({
  getTeamEvent: () => detailFixture(),
  drawTeamEvent: () => ({ ok: true, matchCount: 2 }),
  advanceTeamRound: () => ({ ok: true, matchCount: 1 }),
  settleTeamEvent: () => ({ ok: true, placements: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onDraw();
  await page.onAdvance();
  await page.onSettle();

  ['drawTeamEvent', 'advanceTeamRound', 'settleTeamEvent'].forEach((name) => {
    const call = calls.find(item => item[0] === name);
    assert.ok(call, `${name} 没被调用`);
    assert.equal(call[1].eventId, 'tev_1');
  });
}));

test('赛事详情 —— 录分浮层带上对阵，提交把两个比分传成数字语义的字符串', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  assert.ok(page.data.recording, '应当打开浮层');
  assert.equal(page.data.recording.teamAName, '甲队10');
  assert.equal(page.data.scoreA, '', '没录过分的比赛不该预填 0');

  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '86' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  page.onToggleOvertime({ detail: { value: true } });
  await page.onSubmitScore();

  const recorded = calls.find(call => call[0] === 'recordTeamMatch');
  assert.equal(recorded[1].matchId, 'x_tev_1_r1_main_0');
  assert.equal(recorded[1].scoreA, '86');
  assert.equal(recorded[1].scoreB, '80');
  assert.equal(recorded[1].overtime, true);
  assert.equal(page.data.recording, null, '提交成功后浮层收起');
}));

test('赛事详情 —— 服务端提醒（个人合计与球队得分不符）显示出来而不是吞掉', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: ['个人得分合计 58，球队 60，差 2 分待归属'] }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '60' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '58' } });
  await page.onSubmitScore();

  assert.match(page.data.notice, /差 2 分待归属/);
  assert.equal(page.data.noticeError, false, '这是提醒，不是错误');
}));

test('赛事详情 —— 录分失败时浮层不收起，把原因留在页面上', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: false, message: '篮球不允许平局，请打加时后再录' }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '80' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  await page.onSubmitScore();

  assert.ok(page.data.recording, '失败别把浮层关掉，用户还得改比分');
  assert.match(page.data.notice, /平局/);
  assert.equal(page.data.noticeError, true);
}));

test('赛事详情 —— 发布与驳回带 approve 标记', () => withApi({
  getTeamEvent: () => detailFixture({
    matches: [matchOf(1, 0, { status: 'reviewing', statusLabel: '待审核', scoreA: 86, scoreB: 80, scoreText: '86 : 80' })],
  }),
  publishTeamMatch: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onPublish({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  await page.onRejectScore({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  const callsPublish = calls.filter(call => call[0] === 'publishTeamMatch');
  assert.equal(callsPublish[0][1].approve, true);
  assert.equal(callsPublish[1][1].approve, false);
}));

test('赛事详情 —— 已结算的赛事展示名次与积分表', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'finished', statusLabel: '已结束' },
    table: [
      {
        rank: 1, teamId: 'tm_a', teamName: '热浪队', played: 2, wins: 2, losses: 0, diff: 12,
      },
    ],
    placements: [
      { rank: 1, teamId: 'tm_a', teamName: '热浪队', note: '冠军' },
      { rank: 2, teamId: 'tm_c', teamName: '磐石队', note: '亚军' },
    ],
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.placements.length, 2);
  assert.equal(page.data.placements[0].note, '冠军');
  assert.equal(page.data.table[0].diff, 12);
}));

test('赛事详情 —— 季军赛与决赛同轮次但分开成组，标题不能混', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'scheduled', draw: { size: 4 } },
    matches: [
      matchOf(1, 0),
      matchOf(1, 1),
      matchOf(2, 0),
      matchOf(2, 0, {
        matchId: 'x_tev_1_r2_bronze_0', stage: 'bronze', teamAName: '甲队季', teamBName: '乙队季',
      }),
    ],
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.deepEqual(
    page.data.rounds.map(round => round.label),
    ['半决赛', '决赛', '季军赛'],
    '季军赛不能被塞进「决赛」那一组'
  );
  const bronze = page.data.rounds.find(round => round.label === '季军赛');
  assert.equal(bronze.matches.length, 1);
}));

test('赛事详情 —— 选弃权后自动填 20:0，并把这方作为 forfeit 提交', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  assert.deepEqual(page.data.forfeitLabels, ['正常完赛', '甲队10 弃权', '乙队10 弃权'],
    '弃权选项要用队名，不能让裁判自己对 A/B');

  // A 队弃权 → 0:20
  page.onPickForfeit({ detail: { value: 1 } });
  assert.equal(page.data.scoreA, '0');
  assert.equal(page.data.scoreB, '20');

  await page.onSubmitScore();
  const recorded = calls.find(call => call[0] === 'recordTeamMatch');
  assert.equal(recorded[1].forfeit, 'A');
  assert.equal(recorded[1].scoreA, '0');
  assert.equal(recorded[1].scoreB, '20');
}));

test('赛事详情 —— 切回「正常完赛」不再带 forfeit', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onPickForfeit({ detail: { value: 2 } });
  assert.equal(page.data.scoreA, '20');
  page.onPickForfeit({ detail: { value: 0 } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '86' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  await page.onSubmitScore();

  const recorded = calls.find(call => call[0] === 'recordTeamMatch');
  assert.equal(recorded[1].forfeit, null);
}));

/* ============================================================
 * 个人统计录入（基础 / 按节）与球员数据榜
 * ============================================================ */

/** 一份面板数据。默认基础模式：每队两人，七个指标都未记录 */
function statsPanel(overrides = {}) {
  const players = (prefix) => [1, 2].map(index => {
    const row = { userId: `${prefix}p${index}`, name: `${prefix} 球员${index}` };
    ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fouls']
      .forEach((field) => { row[field] = null; });
    return row;
  });
  return {
    ok: true,
    match: { matchId: 'x_tev_1_r1_main_0', teamAName: '热浪队', teamBName: '闪电队' },
    statPolicy: 'basic',
    periods: 4,
    sides: [
      { teamId: 'tm_a', teamName: '热浪队', players: players('a'), rows: null, revision: 0 },
      { teamId: 'tm_b', teamName: '闪电队', players: players('b'), rows: null, revision: 0 },
    ],
    canEdit: true,
    ...overrides,
  };
}

/** 按节模式的面板：每人每节一行 */
function detailedPanel(periods = 2) {
  const sides = ['a', 'b'].map((prefix) => ({
    teamId: `tm_${prefix}`,
    teamName: prefix === 'a' ? '热浪队' : '闪电队',
    players: [1, 2].map((index) => {
      const row = { userId: `${prefix}p${index}`, name: `${prefix} 球员${index}` };
      ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fouls']
        .forEach((field) => { row[field] = null; });
      return row;
    }),
    rows: [],
    revision: 0,
  }));
  return statsPanel({ statPolicy: 'detailed', periods, sides });
}

test('统计面板 —— 按服务端名单铺格子，未记录显示成空白而不是「null」', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel(),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  assert.ok(page.data.statsEditing);
  assert.equal(page.data.statsEditing.title, '热浪队 vs 闪电队');
  assert.equal(page.data.statGroups.length, 1, '基础模式只有一组');
  assert.equal(page.data.statRows.length, 4, '两队各两人');
  assert.equal(page.data.statRows[0].points, '', '未记录显示为空');
  assert.equal(page.data.statRows[0].rebounds, '');
}));

test('统计面板 —— 只把填过的格子发上去，没填的球员不占位', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel(),
  saveTeamMatchStats: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  // a 队第 2 个人：12 分 4 犯
  const target = page.data.statRows.find(row => row.userId === 'ap2');
  page.onInputStat({ currentTarget: { dataset: { key: target.key, field: 'points' } }, detail: { value: '12' } });
  page.onInputStat({ currentTarget: { dataset: { key: target.key, field: 'fouls' } }, detail: { value: '4' } });

  const after = page.data.statRows.find(row => row.userId === 'ap2');
  assert.equal(after.points, '12');
  assert.equal(after.fouls, '4');
  assert.equal(page.data.statRows.find(row => row.userId === 'ap1').points, '', '别的格子不受影响');

  await page.onSaveStats();
  const saved = calls.find(call => call[0] === 'saveTeamMatchStats');
  assert.equal(saved[1].mode, 'basic');
  assert.equal(saved[1].expectRevision, 0, '把打开时拿到的版本号带回去');
  assert.deepEqual(saved[1].players, [{ userId: 'ap2', points: '12', rebounds: '', assists: '', steals: '', blocks: '', turnovers: '', fouls: '4' }]);
  assert.equal(page.data.statsEditing, null, '保存成功收起面板');
  assert.match(page.data.notice, /已保存/);
}));

test('统计面板 —— 按节模式：一节一组，保存带节次', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => detailedPanel(2),
  saveTeamMatchStats: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  assert.equal(page.data.statsEditing.mode, 'detailed');
  assert.deepEqual(page.data.statGroups.map(group => group.period), [1, 2], '按节分组');
  assert.equal(page.data.statGroups[0].rows.length, 4, '一节里两队各两人');

  // 同一人在两节各录一次：键必须不同，否则两节会串数据
  const first = page.data.statRows.find(row => row.userId === 'ap1' && row.period === 1);
  const second = page.data.statRows.find(row => row.userId === 'ap1' && row.period === 2);
  assert.notEqual(first.key, second.key, '键要带节次');
  page.onInputStat({ currentTarget: { dataset: { key: first.key, field: 'points' } }, detail: { value: '8' } });
  page.onInputStat({ currentTarget: { dataset: { key: second.key, field: 'points' } }, detail: { value: '7' } });

  const p1 = page.data.statRows.find(row => row.key === first.key);
  const p2 = page.data.statRows.find(row => row.key === second.key);
  assert.equal(p1.points, '8');
  assert.equal(p2.points, '7');

  await page.onSaveStats();
  const saved = calls.find(call => call[0] === 'saveTeamMatchStats');
  assert.equal(saved[1].mode, 'detailed');
  const rows = saved[1].rows.filter(row => row.userId === 'ap1');
  assert.equal(rows.length, 2, '两节各自一行');
  assert.deepEqual(rows.map(row => row.period).sort(), [1, 2]);
}));

test('统计面板 —— 合计与球队得分不符时把差额提示出来', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel(),
  saveTeamMatchStats: () => ({ ok: true, warnings: ['第 A 队个人得分合计 12，球队 80，差 68 分待归属'] }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  const target = page.data.statRows.find(row => row.userId === 'ap1');
  page.onInputStat({ currentTarget: { dataset: { key: target.key, field: 'points' } }, detail: { value: '12' } });
  await page.onSaveStats();

  assert.match(page.data.notice, /差 68 分待归属/);
  assert.equal(page.data.noticeError, false, '这是提醒不是错误');
}));

test('统计面板 —— 没权限时不打开面板，只给一句提示', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel({ canEdit: false }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  assert.equal(page.data.statsEditing, null);
  assert.match(page.data.notice, /没有录入权限/);
}));

test('统计面板 —— 一个格子都没填时不发请求', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel(),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  await page.onSaveStats();
  assert.equal(calls.filter(call => call[0] === 'saveTeamMatchStats').length, 0);
  assert.match(page.data.notice, /还没填/);
}));

test('球员数据榜 —— 打开详情就拉一次，落到 data 供模板渲染', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamEventPlayerStats: () => ({
    ok: true,
    players: [
      { userId: 'ap1', name: 'a 球员1', games: 2, points: 26, rebounds: 10, assists: 6, pointsPerGame: 13 },
    ],
  }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(calls.filter(call => call[0] === 'getTeamEventPlayerStats').length, 1);
  assert.equal(page.data.playerStats.length, 1);
  assert.equal(page.data.playerStats[0].pointsPerGame, 13);
}));

test('球员数据榜 —— 拉失败只留一句提示，不影响页面其他部分', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamEventPlayerStats: () => ({ ok: false, message: '赛事不存在' }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.deepEqual(page.data.playerStats, []);
  assert.match(page.data.playerStatsError, /赛事不存在/);
  assert.equal(page.data.error, '', '球员榜失败不该让整页报错');
}));

/* ============================================================
 * P0：页面把版本号带上，统计改动能走审核
 * ============================================================ */

test('录分与发布 —— 都把赛程里拿到的版本号带回服务端', () => withApi({
  getTeamEvent: () => detailFixture({
    matches: [matchOf(1, 0, { status: 'reviewing', statusLabel: '待审核', revision: 3, scoreA: 86, scoreB: 80, scoreText: '86 : 80' })],
  }),
  recordTeamMatch: () => ({ ok: true, warnings: [] }),
  publishTeamMatch: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '88' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  await page.onSubmitScore();

  const recorded = calls.find(call => call[0] === 'recordTeamMatch');
  assert.equal(recorded[1].expectRevision, 3, '没有版本号，并发保护就是空转');

  await page.onPublish({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  const published = calls.find(call => call[0] === 'publishTeamMatch');
  assert.equal(published[1].expectRevision, 3, '发布同样要带版本号');
}));

test('统计面板 —— 已发布比赛的保存提示「等审核」，并给出审核按钮', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel({
    needReview: true,
    canReview: true,
    sides: [
      {
        teamId: 'tm_a', teamName: '热浪队', rows: null, revision: 2, pendingReview: true,
        players: [1, 2].map(index => ({
          userId: `ap${index}`, name: `a 球员${index}`,
          points: null, rebounds: null, assists: null, steals: null, blocks: null, turnovers: null, fouls: null,
        })),
      },
      {
        teamId: 'tm_b', teamName: '闪电队', rows: null, revision: 2, pendingReview: true,
        players: [],
      },
    ],
  }),
  saveTeamMatchStats: () => ({ ok: true, warnings: [], needReview: true }),
  reviewTeamMatchStats: () => ({ ok: true, approved: true, reviewed: 2 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  assert.equal(page.data.statsReview.canReview, true, '管理员要能在面板里审核');
  assert.equal(page.data.statsReview.pending, true);
  assert.equal(page.data.statsEditing.needReview, true);

  const target = page.data.statRows.find(row => row.userId === 'ap1');
  page.onInputStat({ currentTarget: { dataset: { key: target.key, field: 'points' } }, detail: { value: '9' } });
  await page.onSaveStats();

  const saved = calls.find(call => call[0] === 'saveTeamMatchStats');
  assert.equal(saved[1].expectRevision, 2);
  assert.match(page.data.notice, /等协会负责人审核/);
}));

test('统计面板 —— 审核通过/退回接的是独立接口，不是改比分', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchStats: () => statsPanel({ needReview: true, canReview: true }),
  reviewTeamMatchStats: () => ({ ok: true, approved: true, reviewed: 2 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  await page.onReviewStats({ currentTarget: { dataset: { approve: 'true' } } });
  const approved = calls.find(call => call[0] === 'reviewTeamMatchStats');
  assert.equal(approved[1].matchId, 'x_tev_1_r1_main_0');
  assert.equal(approved[1].approve, true);
  assert.match(page.data.notice, /榜单已更新/);

  await page.onOpenStats({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  await page.onReviewStats({ currentTarget: { dataset: { approve: 'false' } } });
  const rejected = calls.filter(call => call[0] === 'reviewTeamMatchStats')[1];
  assert.equal(rejected[1].approve, false);
  assert.match(page.data.notice, /退回/);
}));

test('球员数据榜 —— 模板读服务端给的展示文本，不再把 null 渲染成 0', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamEventPlayerStats: () => ({
    ok: true,
    players: [{
      userId: 'ap1', name: 'a 球员1', games: 1,
      points: 12, pointsText: '12', pointsPerGame: 12, pointsPerGameText: '12',
      rebounds: null, reboundsText: '—', reboundsPerGame: null, assists: null, assistsText: '—',
    }],
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.deepEqual(page.data.playerStats[0].cells.map(({ label, value }) => [label, value]), [
    ['得分', '12'], ['场均', '12'], ['篮板', '—'], ['助攻', '—'],
  ]);
  assert.deepEqual(page.data.playerStatFields.map(({ label }) => label), ['得分', '场均', '篮板', '助攻']);
  assert.equal(page.data.statFields.some(({ field }) => field === 'pointsPerGame'), false);
}));

/* ============================================================
 * P1：单场赛程（时间 / 场地 / 裁判 / 记录员）与整轮顺延
 * ============================================================ */

/** 一份赛程面板：裁判候选里剔除队长，记录员候选里保留 */
function schedulePanel(overrides = {}) {
  return {
    ok: true,
    match: {
      matchId: 'x_tev_1_r1_main_0',
      teamAName: '热浪队',
      teamBName: '闪电队',
      matchTime: '2026-10-21T06:00:00.000Z',
      location: '主馆',
      refereeId: '',
      recorderId: 'u_cap',
      revision: 4,
    },
    referees: [
      { userId: 'u_r1', name: '裁判甲', disabled: false, disabledReason: '' },
      { userId: 'u_cap', name: '队长乙', disabled: true, disabledReason: '参赛队队长不能执法自己队的比赛' },
    ],
    recorders: [
      { userId: 'u_cap', name: '队长乙', disabled: false, disabledReason: '' },
      { userId: 'u_r1', name: '裁判甲', disabled: false, disabledReason: '' },
    ],
    canEdit: true,
    ...overrides,
  };
}

test('赛程浮层 —— 时间转成输入框格式，裁判候选剔除队长，记录员保留', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchSchedule: () => schedulePanel(),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenSchedule({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  const editing = page.data.scheduleEditing;
  assert.ok(editing, '应当打开赛程浮层');
  assert.equal(editing.matchTime, '2026-10-21 14:00', 'ISO 按北京时间转成可编辑字符串');
  assert.deepEqual(editing.refereeLabels, ['不指派', '裁判甲'], '队长不能执法，不该出现在裁判名单里');
  assert.deepEqual(editing.recorderLabels, ['不指派', '队长乙', '裁判甲']);
  assert.equal(editing.recorderIndex, 1, '已指派的记录员要预先选中');
  assert.equal(editing.revision, 4, '版本号随面板带进来');
}));

test('赛程浮层 —— 保存带上四个字段与版本号，成功后收起并刷新', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchSchedule: () => schedulePanel(),
  updateTeamMatchSchedule: () => ({ ok: true, revision: 5 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenSchedule({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  page.onInputSchedule({ currentTarget: { dataset: { field: 'matchTime' } }, detail: { value: '2026-10-21 15:30' } });
  page.onInputSchedule({ currentTarget: { dataset: { field: 'location' } }, detail: { value: '副馆' } });
  page.onPickSchedulePerson({ currentTarget: { dataset: { role: 'referee' } }, detail: { value: 1 } });
  page.onPickSchedulePerson({ currentTarget: { dataset: { role: 'recorder' } }, detail: { value: 0 } });
  await page.onSubmitSchedule();

  const saved = calls.find(call => call[0] === 'updateTeamMatchSchedule');
  assert.equal(saved[1].matchId, 'x_tev_1_r1_main_0');
  assert.equal(saved[1].matchTime, '2026-10-21 15:30');
  assert.equal(saved[1].location, '副馆');
  assert.equal(saved[1].refereeId, 'u_r1');
  assert.equal(saved[1].recorderId, '', '选「不指派」就把记录员清掉');
  assert.equal(saved[1].expectRevision, 4);
  assert.equal(page.data.scheduleEditing, null);
  assert.match(page.data.notice, /赛程已更新/);
}));

test('赛程浮层 —— 已结束的比赛不给改，直接提示', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchSchedule: () => schedulePanel({ canEdit: false }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenSchedule({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  assert.equal(page.data.scheduleEditing, null);
  assert.match(page.data.notice, /不能再改赛程/);
  assert.equal(calls.filter(call => call[0] === 'updateTeamMatchSchedule').length, 0);
}));

test('整轮顺延 —— 带上轮次与分钟数，跳过数要说清楚', () => withApi({
  getTeamEvent: () => detailFixture(),
  updateTeamRoundSchedule: () => ({ ok: true, shifted: 1, skipped: 1 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenShift({ currentTarget: { dataset: { round: '1', stage: 'main', label: '半决赛' } } });
  assert.equal(page.data.shiftEditing.minutes, '30', '默认顺延 30 分钟');
  page.onInputShift({ detail: { value: '45' } });
  await page.onSubmitShift();

  const shifted = calls.find(call => call[0] === 'updateTeamRoundSchedule');
  assert.equal(shifted[1].eventId, 'tev_1');
  assert.equal(shifted[1].round, 1);
  assert.equal(shifted[1].stage, 'main');
  assert.equal(shifted[1].shiftMinutes, 45);
  assert.match(page.data.notice, /已顺延 1 场/);
  assert.match(page.data.notice, /跳过 1 场/);
  assert.equal(page.data.shiftEditing, null);
}));

/* ============================================================
 * P2：单场出场名单
 * ============================================================ */

/** 一份出场名单面板：A 侧可编辑、B 侧只读 */
function lineupPanel(overrides = {}) {
  return {
    ok: true,
    match: { matchId: 'x_tev_1_r1_main_0', teamAName: '热浪队', teamBName: '闪电队' },
    revision: 7,
    minOnCourt: 2,
    sides: [
      {
        side: 'A',
        teamId: 'tm_a',
        teamName: '热浪队',
        editable: true,
        players: [
          { userId: 'ap1', name: 'a 球员1', no: 4, checked: true },
          { userId: 'ap2', name: 'a 球员2', no: null, checked: true },
          { userId: 'ap3', name: 'a 球员3', no: 8, checked: false },
        ],
      },
      {
        side: 'B',
        teamId: 'tm_b',
        teamName: '闪电队',
        editable: false,
        players: [{ userId: 'bp1', name: 'b 球员1', no: 5, checked: true }],
      },
    ],
    canManage: true,
    ...overrides,
  };
}

test('出场名单 —— 默认停在可编辑的一侧，勾选按服务端回填', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchLineup: () => lineupPanel(),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenLineup({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  assert.ok(page.data.lineupEditing);
  assert.equal(page.data.lineupEditing.activeIndex, 0, '停在能改的那一侧');
  assert.equal(page.data.lineupEditing.minOnCourt, 2);
  assert.deepEqual(page.data.lineupPlayers.map(row => row.userId), ['ap1', 'ap2', 'ap3']);
  assert.deepEqual(page.data.lineupPlayers.map(row => row.checked), [true, true, false]);
}));

test('出场名单 —— 勾掉一人后保存，带上侧别与版本号', () => withApi({
  getTeamEvent: () => detailFixture(),
  // 最低 1 人：这条只验提交口径，人数下限另有专门的用例
  getTeamMatchLineup: () => lineupPanel({ minOnCourt: 1 }),
  saveTeamMatchLineup: () => ({ ok: true, side: 'A', lineup: ['ap1', 'ap2'], revision: 8 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenLineup({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  page.onToggleLineupPlayer({ currentTarget: { dataset: { userid: 'ap2' } } });
  await page.onSaveLineup();

  const saved = calls.find(call => call[0] === 'saveTeamMatchLineup');
  assert.equal(saved[1].matchId, 'x_tev_1_r1_main_0');
  assert.equal(saved[1].side, 'A');
  assert.deepEqual(saved[1].players, ['ap1'], '只提交勾上的人');
  assert.equal(saved[1].expectRevision, 7);
  assert.equal(page.data.lineupEditing, null);
  assert.match(page.data.notice, /出场名单已保存/);
}));

test('出场名单 —— 切到只读的一侧不给保存，少于最低人数也不发请求', () => withApi({
  getTeamEvent: () => detailFixture(),
  getTeamMatchLineup: () => lineupPanel(),
  saveTeamMatchLineup: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });
  await page.onOpenLineup({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  // 切到 B 侧：只能看
  page.onSwitchLineupSide({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(page.data.lineupPlayers.map(row => row.userId), ['bp1']);
  await page.onSaveLineup();
  assert.match(page.data.notice, /只能定自己队/);
  assert.equal(calls.filter(call => call[0] === 'saveTeamMatchLineup').length, 0);

  // 回到 A 侧全取消：低于场上最低人数
  page.onSwitchLineupSide({ currentTarget: { dataset: { index: 0 } } });
  page.onToggleLineupPlayer({ currentTarget: { dataset: { userid: 'ap1' } } });
  page.onToggleLineupPlayer({ currentTarget: { dataset: { userid: 'ap2' } } });
  await page.onSaveLineup();
  assert.match(page.data.notice, /至少 2 人/);
  assert.equal(calls.filter(call => call[0] === 'saveTeamMatchLineup').length, 0);
}));

/* ============================================================
 * 路由参数：真机把 query 原样透传（未解码）
 * ============================================================ */

test('赛事详情 —— 路由编号未解码时也能打开，并写回真实编号', () => withApi({
  // 只认解码后的编号：这正是微信开发者工具 / 真机的行为差异
  getTeamEvent: ({ eventId }) => (
    eventId === 'tev:muc:bk:autumn'
      ? detailFixture({ event: { ...EVENT, eventId } })
      : { ok: false, message: '赛事不存在，或不在本协会' }
  ),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  // 跳转方 encodeURIComponent 之后，真机 onLoad 拿到的是 %3A 形式
  await page.onLoad({ eventId: encodeURIComponent('tev:muc:bk:autumn') });

  assert.equal(page.data.error, '', '不能因为没解码就报「赛事不存在」');
  assert.equal(page.data.event.eventId, 'tev:muc:bk:autumn');
  assert.equal(page.data.eventId, 'tev:muc:bk:autumn', '解析出的编号要写回 data，后续动作才用得上');
  assert.deepEqual(
    calls.filter(call => call[0] === 'getTeamEvent').map(call => call[1].eventId),
    ['tev%3Amuc%3Abk%3Aautumn', 'tev:muc:bk:autumn'],
    '先试原值，未命中再试解码值'
  );
}));

test('赛事详情 —— 两个候选都查不到时，仍然给服务端的原话', () => withApi({
  getTeamEvent: () => ({ ok: false, message: '赛事尚未发布' }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev%3Amuc%3Abk%3Aautumn' });

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '赛事尚未发布');
}));
