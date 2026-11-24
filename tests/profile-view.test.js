const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  pickProject,
  buildChart,
  buildHistoryRow,
  loadSchoolMemberView,
  loadSchoolProfileSummaryView,
  DEFAULT_HISTORY_LIMIT,
} = require('../miniprogram/services/profile-view.js');
const { PLACEHOLDER } = require('../src/shared/utils/format.js');
const { sortProjectsForDisplay } = require('../src/shared/utils/leaderboard.js');
const { RANK_PROJECT_CONFIG } = require('../src/shared/utils/constants.js');

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('sortProjectsForDisplay —— 单打排在双打前面，其余按出场次数', () => {
  // 双打一场四个人，场次天然比单打多；不重排的话页面一打开就是双打
  const projects = [
    { project: 'doubles', pool: 'doubles', matchCount: 52 },
    { project: 'men_singles', pool: 'singles', matchCount: 37 },
  ];
  const sorted = sortProjectsForDisplay(projects);

  assert.deepStrictEqual(sorted.map((item) => item.project), ['men_singles', 'doubles']);
  // 只是展示顺序，不能把调用方传进来的数组就地改掉
  assert.strictEqual(projects[0].project, 'doubles');
});

test('sortProjectsForDisplay —— 没有单打成绩时双打仍排在最前，不会给空页', () => {
  const projects = [{ project: 'doubles', pool: 'doubles', matchCount: 5 }];
  assert.deepStrictEqual(sortProjectsForDisplay(projects).map((item) => item.project), ['doubles']);
  assert.deepStrictEqual(sortProjectsForDisplay(null), []);
});

test('pickProject —— 优先使用调用方指定的项目', () => {
  const projects = [{ project: 'doubles' }, { project: 'men_singles' }];
  assert.strictEqual(pickProject(projects, 'men_singles').project, 'men_singles');
});

test('pickProject —— 指定的项目不存在时退回列表第一个，不返回空', () => {
  // 男会员点不到「女单」，此时不能给空白页。loadMemberView 传进来的
  // 列表已经按「单打在前」排过，所以第一个就是他该看的项目。
  const projects = [{ project: 'men_singles' }, { project: 'doubles' }];
  assert.strictEqual(pickProject(projects, 'women_singles').project, 'men_singles');
});

test('pickProject —— 没有任何项目时返回 null', () => {
  assert.strictEqual(pickProject([], 'doubles'), null);
  assert.strictEqual(pickProject(null), null);
  assert.strictEqual(pickProject(undefined, 'doubles'), null);
});

test('buildChart —— 没打过比赛时曲线只有一个起点', () => {
  const chart = buildChart([], 1000);
  assert.strictEqual(chart.empty, true);
  assert.deepStrictEqual(chart.values, [1000]);
  assert.strictEqual(chart.currentElo, 1000);
  assert.strictEqual(chart.pointCount, 0);
  // 没有对局就谈不上「最大涨幅」，此时必须是 null 而不是编造一个 0
  assert.strictEqual(chart.best, null);
  assert.strictEqual(chart.worst, null);
});

test('buildChart —— 序列首部补上入池起点分', () => {
  // 曲线要从进池那天开始画，这样和图上那条虚线（起点）才衔接得上
  const history = [
    { eloAfter: 1016, eloDelta: 16, matchTime: '2026-04-06T18:00:00' },
    { eloAfter: 1004, eloDelta: -12, matchTime: '2026-04-08T18:00:00' },
    { eloAfter: 1030, eloDelta: 26, matchTime: '2026-04-10T18:00:00' },
  ];
  const chart = buildChart(history, 1000);

  assert.deepStrictEqual(chart.values, [1000, 1016, 1004, 1030]);
  assert.strictEqual(chart.pointCount, 3);
  assert.strictEqual(chart.startElo, 1000);
  assert.strictEqual(chart.currentElo, 1030);
  assert.strictEqual(chart.maxElo, 1030);
  assert.strictEqual(chart.minElo, 1000);
});

test('buildChart —— 单场最大涨幅与最大跌幅单独拎出来', () => {
  const history = [
    { eloAfter: 1016, eloDelta: 16, matchTime: '2026-04-06T18:00:00' },
    { eloAfter: 974, eloDelta: -42, matchTime: '2026-04-08T18:00:00' },
    { eloAfter: 1004, eloDelta: 30, matchTime: '2026-04-10T18:00:00' },
  ];
  const chart = buildChart(history, 1000);

  assert.strictEqual(chart.best.deltaText, '+30');
  assert.strictEqual(chart.best.dateText, '4月10日');
  assert.strictEqual(chart.worst.deltaText, '-42');
  assert.strictEqual(chart.worst.dateText, '4月8日');
});

test('buildChart —— 起点分不同也能正确算涨幅，不假设一定是 1000', () => {
  // 动态初始分机制下，新人的起点可能是 1125 这样的值
  const chart = buildChart([{ eloAfter: 1150, eloDelta: 25, matchTime: '2026-05-01T18:00:00' }], 1125);
  assert.deepStrictEqual(chart.values, [1125, 1150]);
  assert.strictEqual(chart.currentElo, 1150);
});

test('buildHistoryRow —— 双打显示搭档，单打写明「单打」', () => {
  const doubles = buildHistoryRow({
    matchId: 'm1',
    matchTime: '2026-05-01T18:00:00',
    isWin: true,
    opponentNames: ['张三', '李四'],
    partnerNames: ['王五'],
    score: { mine: [11, 12], theirs: [9, 10] },
    eloDelta: 9,
    pointDelta: 3,
    eventId: 'e1',
    pool: 'doubles',
  });

  assert.strictEqual(doubles.rivalText, '张三、李四');
  assert.strictEqual(doubles.partnerText, '搭档 王五');
  assert.strictEqual(doubles.scoreText, '11:9  12:10');
  assert.strictEqual(doubles.resultText, '胜');
  assert.strictEqual(doubles.eloDeltaText, '+9');
  assert.strictEqual(doubles.pointDeltaText, '+3');
  assert.strictEqual(doubles.hasPointDelta, true, '真的有积分时才显示那一行');
  assert.strictEqual(doubles.isEvent, true);
  assert.strictEqual(doubles.poolLabel, '双打');

  const singles = buildHistoryRow({
    matchId: 'm2',
    matchTime: '2026-05-02T18:00:00',
    isWin: false,
    opponentNames: ['张三'],
    partnerNames: [],
    score: { mine: [9], theirs: [11] },
    eloDelta: -14,
    pointDelta: 1,
    eventId: null,
    pool: 'singles',
  });

  assert.strictEqual(singles.partnerText, '单打');
  assert.strictEqual(singles.resultText, '负');
  assert.strictEqual(singles.eloDeltaText, '-14');
  assert.strictEqual(singles.isEvent, false);
  assert.strictEqual(singles.poolLabel, '单打');
});

test('buildHistoryRow —— 分数没涨没跌时显示 0，不显示 -0', () => {
  const row = buildHistoryRow({
    matchId: 'm3',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: [],
    partnerNames: [],
    score: { mine: [], theirs: [] },
    eloDelta: -0,
    pointDelta: 0,
    eventId: null,
    pool: 'doubles',
  });

  assert.strictEqual(row.eloDeltaText, '0');
  assert.strictEqual(row.scoreText, PLACEHOLDER);
  // 日常比赛不给积分，0 分那一行整行隐去，不留一句「积分 0」
  assert.strictEqual(row.hasPointDelta, false);
});

test('buildHistoryRow —— 带赛制时渲染成「11 分制 · 三局两胜」', () => {
  const row = buildHistoryRow({
    matchId: 'm4',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: ['张三'],
    partnerNames: [],
    score: { mine: [11, 9], theirs: [9, 11] },
    eloDelta: 8,
    pointDelta: 2,
    eventId: null,
    pool: 'singles',
    gamePoints: 11,
    bestOf: 3,
  });

  assert.strictEqual(row.formatText, '11 分制 · 三局两胜');
});

test('buildHistoryRow —— 老数据没有赛制时 formatText 是空串，模板可挡住', () => {
  const row = buildHistoryRow({
    matchId: 'm5',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: [],
    partnerNames: [],
    score: { mine: [], theirs: [] },
    eloDelta: 0,
    pointDelta: 0,
    eventId: null,
    pool: 'doubles',
  });

  assert.strictEqual(row.formatText, '');
});

/* ============================================================
 * 二、端到端部分（已迁走）
 * ============================================================
 * 原先这一段有 30 条 `loadMemberView`（协议 1 装载器）的端到端用例，连同它
 * 依赖的门面（getMembers / getMyProjects / setMemberElo）一起删除。逐条去向：
 *
 * A. 展示口径（19 条）→ 已迁到本文件后面「loadSchoolMemberView —— 旧栈
 *    loadMemberView 的 S2 对应」一组。S2 里这些规则全部由**客户端**从 DTO
 *    整形出来（服务端只给数据），因此是重写而不是照搬：
 *      · 项目标签恰好一个选中 / 默认停在单打 / 项目不存在退回默认
 *      · 分数卡与曲线末点同源 / 曲线高低点 / 名次与百分位
 *      · 交锋胜负之和 / 逐场时间倒序 / historyLimit 下传
 *      · 赛事汇总与明细对得上 / 近期状态 W·L
 *      · 切项目整页跟着换 / 不同会员各自数据 / 头卡昵称真名 / 头像首字兜底
 *
 * B. 任免与改分入口（8 条）+ 角色徽标按 isGlobalAdmin 推断（3 条）
 *    → **S2 无对应，且不是漏了**：这些入口在 B4 / B8 就已从个人主页移除
 *    （指定权限统一走学校身份页 `grantSchoolPermission`，改分收尾归 B5），
 *    S2 装载器里 leader / associationLeader / currentElo 三个 visible 恒为
 *    false。旧栈那几条守的是**已经被产品移除的行为**——协议 1 装载器一删，
 *    它们守护的对象也随之消失。由新组里「任免 / 改分入口一律不出现」与
 *    「角色徽标直接来自服务端 permissionLabel」两条反向钉住。
 * ============================================================ */

/* ============================================================
 * S2 装载器（B4-c）
 * ============================================================ */

/** 一份最小的 S2 个人资料 DTO（getSchoolMemberProfile 的返回形状） */
function schoolProfileDto(overrides = {}) {
  return {
    ok: true,
    found: true,
    user: {
      userId: 'u06', nickName: '明宇', realName: '赵明宇', avatarUrl: '', gender: 'M',
      collegeId: 'c12', college: '法学院', studentId: '2023000006', points: 12,
      permissionLabel: '会员', role: 0,
    },
    projects: [{
      project: 'men_singles', pool: 1, label: '男单', elo: 1520, startElo: 1450,
      delta: 70, matchCount: 3, wins: 2, losses: 1, rank: 2, total: 10, beatPercent: 80,
    }],
    active: 'men_singles',
    ratingHistory: [{ eloAfter: 1490, eloDelta: 40, matchTime: '2026-10-01T09:00:00Z' }],
    headToHead: [{ opponentId: 'u03', nickName: '思远', matchCount: 1, wins: 1, losses: 0, winRate: 1, eloDeltaSum: 8 }],
    partners: [{ partnerId: 'u05', nickName: '子涵', matchCount: 1, wins: 1, losses: 0, winRate: 1 }],
    history: [{
      matchId: 'm1', matchTime: '2026-10-01T09:00:00Z', isWin: true, opponentNames: ['思远'],
      partnerNames: [], score: { mine: [11], theirs: [8] }, eloDelta: 8, pointDelta: 0,
      eventId: '', pool: 1, gamePoints: 11, bestOf: 3,
    }],
    form: { results: [true], wins: 1, losses: 0, streak: 1 },
    honors: {
      summary: { eventCount: 1, championCount: 0, topThreeCount: 1, bestPlacement: 3 },
      records: [{ eventId: 'ev1', title: '春季杯', startTime: '2026-03-01T09:00:00Z', placement: 3, participantCount: 8 }],
    },
    message: '',
    ...overrides,
  };
}

test('loadSchoolMemberView —— 由 S2 资料 DTO 整形出与旧栈一致的视图', async () => {
  const api = { getSchoolMemberProfile: async () => schoolProfileDto() };
  const view = await loadSchoolMemberView(api, { userId: 'u06' });

  assert.strictEqual(view.found, true);
  assert.strictEqual(view.user.userId, 'u06');
  assert.strictEqual(view.user.nickName, '明宇');
  assert.strictEqual(view.user.roleLabel, '会员');
  assert.strictEqual(view.activeProject, 'men_singles');
  assert.strictEqual(view.summary.matchCount, 3);
  assert.strictEqual(view.summary.rankText.includes('2'), true);
  assert.strictEqual(view.chart.values.length, 2, '起点 + 一个走势点');
  assert.strictEqual(view.headToHead[0].opponentId, 'u03');
  assert.strictEqual(view.partners[0].partnerId, 'u05');
  assert.strictEqual(view.history[0].matchId, 'm1');
  assert.strictEqual(view.events.records[0].placement, 3);
  assert.strictEqual(view.events.summary.topThreeCount, 1);
  // S2 下任免 / 改分入口一律不出现（统一走学校身份页）
  assert.strictEqual(view.leader.visible, false);
  assert.strictEqual(view.associationLeader.visible, false);
  assert.strictEqual(view.currentElo.visible, false);
});

/* --------------------------------------------- 旧栈 loadMemberView 的 S2 对应 */

/**
 * 【为什么补这一组】loadSchoolMemberView 是个人详情页 / 他人主页（
 * templates/member-view.js）唯一的取数口，但**此前只有 2 条**假 DTO 用例
 * （形状对了没、查无此人）。旧栈 loadMemberView 那 26 条守的展示口径
 * （项目标签、默认单打、分数卡与曲线同源、交锋、逐场倒序、historyLimit、
 * 赛事汇总、近期状态、角色徽标）在 S2 全是**客户端**整形出来的（服务端只给
 * DTO），删旧栈前必须先把它们建起来。
 *
 * 【哪些旧用例不再有对应】
 *   · 任免学院 / 协会负责人、手工改分那 8 条：这些入口在 B4 / B8 就已从个人
 *     主页移除（指定权限统一走学校身份页），S2 装载器里三个 visible 恒为 false。
 *     旧栈那几条守的是**已经被产品移除的行为**，连同 loadMemberView 一并删除，
 *     由本组「任免 / 改分入口一律不出现」反向钉住。
 *   · 「协会负责人显协会负责人」那条：S2 的 roleLabel 直接来自服务端
 *     permissionLabel，不再由客户端按 isGlobalAdmin 推断，规则换了地方。
 */
describe('loadSchoolMemberView —— 旧栈 loadMemberView 的 S2 对应', () => {
  /** 单打 + 双打都在，双打场次更多：用来确认「默认单打」不是碰巧 */
  function twoProjectDto(overrides = {}) {
    return schoolProfileDto({
      projects: [
        { project: 'doubles', pool: 'doubles', label: '双打', elo: 1480, startElo: 1450, delta: 30,
          matchCount: 9, wins: 6, losses: 3, rank: 4, total: 12, beatPercent: 66 },
        { project: 'men_singles', pool: 'singles', label: '男单', elo: 1520, startElo: 1450, delta: 70,
          matchCount: 3, wins: 2, losses: 1, rank: 2, total: 10, beatPercent: 80 },
      ],
      active: 'men_singles',
      // 末点必须与项目的 elo 一致：分数卡与曲线是对同一事实的两种推导，
      // fixture 里对不上，这条不变式就形同没有在守
      ratingHistory: [
        { eloAfter: 1500, eloDelta: 50, matchTime: '2026-10-02T09:00:00Z' },
        { eloAfter: 1520, eloDelta: 20, matchTime: '2026-10-03T09:00:00Z' },
      ],
      ...overrides,
    });
  }

  const apiOf = dto => ({ getSchoolMemberProfile: async () => dto });

  test('项目切换标签里恰好有一个是选中的', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    const active = view.projectTabs.filter(tab => tab.active);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].project, view.activeProject);
    assert.strictEqual(view.hasProject, true);
  });

  test('默认停在单打上，而不是场次更多的双打', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    assert.strictEqual(view.activeProject, 'men_singles');
    assert.strictEqual(view.projectTabs[0].active, true, '默认项目应当排在标签首位');
    assert.strictEqual(view.projectTabs[0].project, 'men_singles');
  });

  test('分数卡与曲线的末点必须是同一个数', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    const values = view.chart.values;
    assert.strictEqual(values[values.length - 1], view.summary.elo);
  });

  test('曲线高低点与数据一致，首部补上入池起点分', async () => {
    const dto = twoProjectDto({
      ratingHistory: [
        { eloAfter: 1460, eloDelta: 10, matchTime: '2026-10-01T09:00:00Z' },
        { eloAfter: 1440, eloDelta: -20, matchTime: '2026-10-02T09:00:00Z' },
        { eloAfter: 1520, eloDelta: 80, matchTime: '2026-10-03T09:00:00Z' },
      ],
    });
    const view = await loadSchoolMemberView(apiOf(dto), {});
    assert.strictEqual(view.chart.values[0], 1450, '首部补上入池起点分');
    assert.ok(view.chart.maxElo >= 1520);
    assert.ok(view.chart.minElo <= 1440);
    assert.strictEqual(view.summary.deltaUp, true);
    assert.strictEqual(view.summary.recordText, '2 胜 1 负');
  });

  test('交锋记录里每行的胜负之和等于交手场次', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    assert.ok(view.headToHead.length > 0);
    for (const row of view.headToHead) {
      assert.strictEqual(row.recordText, '1 胜 0 负');
      assert.ok(row.winRateText.length > 0);
    }
  });

  test('逐场战绩按时间倒序，最近的排在最前', async () => {
    const dto = twoProjectDto({
      history: [
        { matchId: 'm1', matchTime: '2026-10-05T09:00:00Z', isWin: true, opponentNames: ['思远'],
          partnerNames: [], score: { mine: [11], theirs: [8] }, eloDelta: 8, pointDelta: 0,
          eventId: '', pool: 1, gamePoints: 11, bestOf: 3 },
        { matchId: 'm0', matchTime: '2026-10-01T09:00:00Z', isWin: false, opponentNames: ['子涵'],
          partnerNames: [], score: { mine: [8], theirs: [11] }, eloDelta: -5, pointDelta: 0,
          eventId: '', pool: 1, gamePoints: 11, bestOf: 3 },
      ],
    });
    const view = await loadSchoolMemberView(apiOf(dto), {});
    assert.strictEqual(view.history[0].matchId, 'm1');
    assert.ok(view.history[0].dateText >= view.history[1].dateText, '时间倒序');
  });

  test('historyLimit 如实下传给服务端', async () => {
    const seen = [];
    const api = {
      getSchoolMemberProfile: async (payload) => { seen.push(payload); return twoProjectDto(); },
    };
    await loadSchoolMemberView(api, { userId: 'u06', historyLimit: 3 });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].historyLimit, 3);
    assert.strictEqual(seen[0].userId, 'u06');
    // 不传时按模块默认值
    seen.length = 0;
    await loadSchoolMemberView(api, {});
    assert.strictEqual(seen[0].historyLimit, DEFAULT_HISTORY_LIMIT);
  });

  test('赛事汇总与赛事明细对得上，名次翻成人话', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    assert.strictEqual(view.events.records.length, view.events.summary.eventCount);
    assert.strictEqual(view.events.records[0].placementText, '四强');
    assert.strictEqual(view.events.records[0].isTop, true);
    assert.strictEqual(view.events.summary.topThreeCount, 1);
    assert.strictEqual(view.events.summary.championCount, 0);
  });

  test('近期状态是 W / L 串，胜负之和等于点数', async () => {
    const dto = twoProjectDto({ form: { results: [true, true, false], wins: 2, losses: 1, streak: 0 } });
    const view = await loadSchoolMemberView(apiOf(dto), {});
    assert.deepStrictEqual(view.form.dots, ['W', 'W', 'L']);
    assert.strictEqual(view.form.wins + view.form.losses, view.form.dots.length);
    assert.strictEqual(view.form.streakText, '暂无连胜');
  });

  test('切换项目之后整页跟着换；项目不存在时退回默认而不是空白页', async () => {
    const api = apiOf(twoProjectDto());

    const doubles = await loadSchoolMemberView(api, { project: 'doubles' });
    assert.strictEqual(doubles.activeProject, 'doubles');
    assert.strictEqual(doubles.activeProjectLabel, '双打');
    assert.strictEqual(doubles.summary.matchCount, 9);

    // 女单不在他的项目里：退回默认（单打），不给空白页
    const fallback = await loadSchoolMemberView(api, { project: 'women_singles' });
    assert.strictEqual(fallback.found, true);
    assert.strictEqual(fallback.hasProject, true);
    assert.notStrictEqual(fallback.activeProject, 'women_singles');
    assert.strictEqual(fallback.activeProject, 'men_singles');
  });

  test('不同会员看到的是各自的数据', async () => {
    const mk = (userId, elo) => apiOf(schoolProfileDto({
      user: { userId, nickName: '昵称' + userId, realName: '', avatarUrl: '', gender: 'M',
        collegeId: 'c12', college: '法学院', studentId: 's1', points: 0,
        permissionLabel: '会员', role: 0 },
      projects: [{ project: 'men_singles', pool: 1, label: '男单', elo, startElo: 1450,
        delta: elo - 1450, matchCount: 3, wins: 2, losses: 1, rank: 2, total: 10, beatPercent: 80 }],
      honors: { summary: { eventCount: 0, championCount: 0, topThreeCount: 0, bestPlacement: null }, records: [] },
    }));
    const me = await loadSchoolMemberView(mk('u06', 1520), {});
    const other = await loadSchoolMemberView(mk('u01', 1600), {});
    assert.notStrictEqual(other.user.userId, me.user.userId);
    assert.notStrictEqual(other.summary.elo, me.summary.elo);
  });

  test('头卡同时给出昵称与真名；头像缺省时用昵称首字兜底', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    assert.strictEqual(view.user.nickName, '明宇');
    assert.strictEqual(view.user.realName, '赵明宇');
    assert.strictEqual(view.user.showRealName, true);
    assert.strictEqual(view.user.avatarText, view.user.nickName.slice(0, 1));
    assert.ok(view.user.studentId);
  });

  test('角色徽标直接来自服务端 permissionLabel，不由客户端推断', async () => {
    const withLabel = label => apiOf(schoolProfileDto({
      user: { userId: 'u06', nickName: '明宇', realName: '赵明宇', avatarUrl: '', gender: 'M',
        collegeId: 'c12', college: '法学院', studentId: 's1', points: 0,
        permissionLabel: label, role: 0 },
    }));
    assert.strictEqual((await loadSchoolMemberView(withLabel('协会负责人'), {})).user.roleLabel, '协会负责人');
    assert.strictEqual((await loadSchoolMemberView(withLabel('管理员'), {})).user.roleLabel, '管理员');
    assert.strictEqual((await loadSchoolMemberView(withLabel('会员'), {})).user.roleLabel, '会员');
  });

  test('任免 / 改分入口一律不出现（统一走学校身份页）', async () => {
    const view = await loadSchoolMemberView(apiOf(twoProjectDto()), {});
    assert.strictEqual(view.leader.visible, false);
    assert.strictEqual(view.associationLeader.visible, false);
    assert.strictEqual(view.currentElo.visible, false);
  });
});

/* -------------------------------------- loadSchoolProfileSummaryView（「我的」页） */

describe('loadSchoolProfileSummaryView —— 头卡与跨协会荣誉聚合', () => {
  const SESSION = {
    user: { userId: 'u06', nickName: '明宇', realName: '赵明宇', avatarUrl: '' },
    account: { status: 'active', studentId: '2023000006' },
    permissionLabel: '会员',
    isPlatformAdmin: false,
  };

  const honorsOf = (records, summary) => ({ records, summary });

  /** 造一个只认指定协会的替身门面：其余协会读不到 */
  function clientFor(entries) {
    return {
      forScope: scope => ({
        getSchoolMember: async () => (entries[scope.association]
          ? { member: { collegeName: entries[scope.association].collegeName } } : {}),
        getSchoolMemberHonors: async () => (entries[scope.association]
          ? { ok: true, honors: entries[scope.association].honors } : { ok: false }),
      }),
    };
  }

  test('未登录（无会话）时返回 found:false', async () => {
    assert.deepStrictEqual(await loadSchoolProfileSummaryView({ schoolId: 'muc', session: null }), { found: false });
    assert.deepStrictEqual(await loadSchoolProfileSummaryView({ schoolId: 'muc', session: {} }), { found: false });
  });

  test('头卡：昵称 / 真名 / 学院 / 学号 / 身份状态都带出来', async () => {
    const view = await loadSchoolProfileSummaryView({
      schoolId: 'muc', session: SESSION,
      client: clientFor({ pkb: { collegeName: '法学院',
        honors: honorsOf([], { eventCount: 0, championCount: 0, topThreeCount: 0, bestPlacement: null }) } }),
    });
    assert.strictEqual(view.found, true);
    assert.strictEqual(view.user.nickName, '明宇');
    assert.strictEqual(view.user.realName, '赵明宇');
    assert.strictEqual(view.user.college, '法学院');
    assert.strictEqual(view.user.studentId, '2023000006');
    assert.strictEqual(view.user.statusLabel, '正常');
    assert.strictEqual(view.user.roleLabel, '会员');
  });

  test('荣誉跨协会聚合：汇总数字相加，没参赛的协会不出现', async () => {
    const record = (id, placement) => ({
      eventId: id, title: '赛事' + id, startTime: '2026-03-01T09:00:00Z',
      placement, participantCount: 8,
    });
    const view = await loadSchoolProfileSummaryView({
      schoolId: 'muc', session: SESSION,
      client: clientFor({
        pkb: { collegeName: '法学院', honors: honorsOf([record('e1', 1)],
          { eventCount: 2, championCount: 1, topThreeCount: 1, bestPlacement: 1 }) },
        tt: { collegeName: '法学院', honors: honorsOf([record('e2', 3)],
          { eventCount: 1, championCount: 0, topThreeCount: 1, bestPlacement: 3 }) },
      }),
    });
    assert.strictEqual(view.honors.summary.eventCount, 3, '汇总数字各协会相加');
    assert.strictEqual(view.honors.summary.championCount, 1);
    assert.strictEqual(view.honors.summary.topThreeCount, 2);
    assert.strictEqual(view.honors.summary.bestPlacementText, '冠军', '取各协会里最好的名次');
    // 只有真有荣誉的协会才成组
    assert.strictEqual(view.honors.groups.length, 2);
    for (const group of view.honors.groups) {
      assert.ok(group.associationId);
      assert.ok(group.records.length > 0);
    }
  });

  test('某个协会读不到（未启用 / 无权限）时跳过，不拖垮整页', async () => {
    const view = await loadSchoolProfileSummaryView({
      schoolId: 'muc', session: SESSION,
      client: { forScope: () => { throw new Error('该协会未启用'); } },
    });
    assert.strictEqual(view.found, true);
    assert.strictEqual(view.honors.groups.length, 0);
    assert.strictEqual(view.honors.summary.eventCount, 0);
    assert.strictEqual(view.user.college, '', '档案读不到时降级为空而不是抛错');
  });
});

test('loadSchoolMemberView —— 查无此人返回 found:false', async () => {
  const api = { getSchoolMemberProfile: async () => ({ ok: false, found: false, message: '没有找到这位会员' }) };
  const view = await loadSchoolMemberView(api, { userId: 'nobody' });
  assert.deepStrictEqual(view, { found: false });
});
