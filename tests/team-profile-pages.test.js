/**
 * 「我的球队」页装配测试（P3）
 * ============================================================
 * 服务端已经把场次、胜负、名次、累计数据算好了，页面只做三件事：
 *   取到 → 摆出来 → 点得动。
 * 这里守的就是这三件事，外加失败时不要白屏。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness.js');

function profileFixture(overrides = {}) {
  return {
    ok: true,
    userId: 'u_cap',
    name: '队长昵称',
    isSelf: true,
    teams: [
      {
        teamId: 'tm:1', name: '热浪队', isCaptain: true, roleLabel: '队长',
        status: 'active', statusLabel: '正常', memberStatus: 'active', memberStatusLabel: '在队',
        current: true, memberCount: 6, joinedAt: null, recordText: '3 场 · 2 胜 1 负',
      },
      {
        teamId: 'tm:2', name: '老东家', isCaptain: false, roleLabel: '队员',
        status: 'active', statusLabel: '正常', memberStatus: 'left', memberStatusLabel: '已离队',
        current: false, memberCount: 5, joinedAt: null, recordText: '还没打完一场',
      },
    ],
    events: [
      {
        eventId: 'tev:1', name: '秋季联赛', teamName: '热浪队', statusLabel: '已结束',
        placement: 1, placementText: '冠军', recordText: '2 场 · 2 胜 0 负',
      },
    ],
    honors: [{ eventId: 'tev:1', eventName: '秋季联赛', teamName: '热浪队', placement: 1, placementText: '冠军' }],
    statEvents: [
      {
        eventId: 'tev:1', name: '秋季联赛', teamName: '热浪队', games: 2,
        points: 28, pointsText: '28', pointsPerGame: 14, pointsPerGameText: '14',
        rebounds: null, reboundsText: '—', reboundsPerGame: null, reboundsPerGameText: '—',
        assists: null, assistsText: '—', assistsPerGame: null, assistsPerGameText: '—',
      },
    ],
    totals: {
      games: 2, wins: 2, losses: 0, draws: 0, recordText: '2 场 · 2 胜 0 负',
      points: 28, pointsText: '28', pointsPerGame: 14, pointsPerGameText: '14',
      rebounds: null, reboundsText: '—', reboundsPerGame: null, reboundsPerGameText: '—',
      assists: null, assistsText: '—', assistsPerGame: null, assistsPerGameText: '—',
    },
    ...overrides,
  };
}

test('我的球队 —— 首屏取档案，数据原样落到 data', () => withApi({
  getMyTeamProfile: () => profileFixture(),
}, async (calls) => {
  const page = instantiate(loadPage('my-team-profile/my-team-profile.js'));
  await page.onLoad();

  assert.equal(calls[0][0], 'getMyTeamProfile');
  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.equal(page.data.profile.name, '队长昵称');
  assert.equal(page.data.profile.teams.length, 2);
  assert.equal(page.data.profile.teams[0].isCaptain, true);
  assert.equal(page.data.profile.teams[1].current, false);
  assert.equal(page.data.profile.honors[0].placementText, '冠军');
}));

test('我的球队 —— 「没记录」原样显示成「—」，不渲染成 0', () => withApi({
  getMyTeamProfile: () => profileFixture(),
}, async () => {
  const page = instantiate(loadPage('my-team-profile/my-team-profile.js'));
  await page.onLoad();

  assert.equal(page.data.profile.totals.pointsText, '28');
  assert.equal(page.data.profile.totals.reboundsText, '—');
  assert.equal(page.data.profile.statEvents[0].reboundsText, '—');
  assert.equal(page.data.profile.totals.assistsPerGameText, '—');
}));

test('我的球队 —— 点球队与点赛事都带上编码后的编号', () => withApi({
  getMyTeamProfile: () => profileFixture(),
}, async () => withWx(async ({ navigations }) => {
  const page = instantiate(loadPage('my-team-profile/my-team-profile.js'));
  await page.onLoad();

  page.onOpenTeam({ currentTarget: { dataset: { teamid: 'tm:1' } } });
  page.onOpenEvent({ currentTarget: { dataset: { eventid: 'tev:1' } } });

  assert.equal(navigations[0], '/packageTeam/team-detail/team-detail?teamId=tm%3A1');
  assert.equal(navigations[1], '/packageTeam/team-event-detail/team-event-detail?eventId=tev%3A1');
})));

test('我的球队 —— 取数失败给一句人话，不停在加载态', () => withApi({
  getMyTeamProfile: () => ({ ok: false, message: '该协会不是团队项目' }),
}, async () => {
  const page = instantiate(loadPage('my-team-profile/my-team-profile.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '该协会不是团队项目');
  assert.equal(page.data.profile, null);
}));

test('我的球队 —— 下拉刷新重新取数并收起动画', async () => {
  const previous = global.wx;
  let stops = 0;
  global.wx = { stopPullDownRefresh: () => { stops += 1; } };
  try {
    let calls = 0;
    await withApi({
      getMyTeamProfile: () => { calls += 1; return profileFixture(); },
    }, async () => {
      const page = instantiate(loadPage('my-team-profile/my-team-profile.js'));
      await page.onLoad();
      calls = 0;
      await page.onPullDownRefresh();
      assert.equal(calls, 1, '下拉应重新取一次档案');
      assert.equal(stops, 1, '无论成功失败都要收起下拉动画');
    });
  } finally { global.wx = previous; }
});
