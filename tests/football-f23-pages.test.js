const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness');
const associationScope = require('../miniprogram/services/association-scope');
const { defaultRulesFor } = require('../src/shared/utils/football-rules');
const { createReportForm, reportPayload } = require('../miniprogram/packageTeam/utils/football-report-form.js');
const { normalizeFootballReport } = require('../src/shared/utils/football-report');
const base = () => ({ ok: true, sportFormat: 'football11', matchId: 'fm:1', eventId: 'fe:1', rules: defaultRulesFor(),
  format: 'round_robin', revision: 1, teamAName: '足球甲队', teamBName: '足球乙队', canEdit: true,
  canReview: false, needReview: false, pending: false, rosters: {
    A: Array.from({ length: 12 }, (_, i) => ({ userId: `a${i}`, name: `甲${i}`, no: i + 1 })),
    B: Array.from({ length: 12 }, (_, i) => ({ userId: `b${i}`, name: `乙${i}`, no: i + 1 })),
  } });
const input = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
function football(t) {
  const previous = associationScope.getAssociation(); associationScope.setAssociation('fb');
  t.after(() => associationScope.setAssociation(previous));
}
test('F2 表单：空比分保持空白，读取 0:0 不丢零，未出场者不默认首发', () => {
  const initial = createReportForm(base());
  assert.equal(initial.regulationA, ''); assert.equal(initial.sides[0].players[0].selected, false);
  const data = base(); data.report = { result: { regulationScore: { A: 0, B: 0 } }, sides: {} };
  const form = createReportForm(data);
  assert.equal(form.regulationA, '0'); assert.deepEqual(reportPayload(form).result.regulationScore, { A: '0', B: '0' });
  assert.equal(reportPayload(form).result.shootoutScore, null);
});
test('F2 页面：空分被拦、0:0 可预览提交、请求重试复用编号且防连点', t => {
  football(t); let attempts = 0; let release;
  return withApi({ getTeamMatchStats: () => base(), recordTeamMatch: async () => {
    attempts += 1; if (attempts === 1) throw new Error('lost response');
    return new Promise(resolve => { release = resolve; });
  } }, async calls => {
    const page = instantiate(loadPage('football-match/football-match.js'));
    await page.onLoad({ matchId: 'fm%3A1' });
    assert.equal(page.data.error, ''); await page.onSubmit(); assert.match(page.data.notice, /常规时间/);
    page.onInput(input('regulationA', '0')); page.onInput(input('regulationB', '0'));
    await page.onSubmit(); assert.equal(page.data.preview.scoreText, '0 : 0');
    assert.equal(calls.some(c => c[0] === 'recordTeamMatch'), false);
    await page.onSubmit(); assert.match(page.data.notice, /可重试/);
    const pending = page.onSubmit(); await page.onSubmit();
    const writes = calls.filter(c => c[0] === 'recordTeamMatch');
    assert.equal(writes.length, 2); assert.equal(writes[0][1].requestId, writes[1][1].requestId);
    assert.equal(writes[0][1].expectRevision, 1); release({ ok: true }); await pending;
    assert.equal(page.data.busy, false);
  });
});
test('F2 页面：加时/点球依规程出现，改变阶段清除不适用数据', t => {
  football(t);
  const info = base(); info.format = 'single_elim';
  info.rules = { ...info.rules, knockoutTieBreak: 'extra_time_penalties', extraTime: { halfMinutes: 15 } };
  return withApi({ getTeamMatchStats: () => info }, async () => {
    const page = instantiate(loadPage('football-match/football-match.js')); await page.onLoad({ matchId: 'fm' });
    page.onInput(input('regulationA', '1')); page.onInput(input('regulationB', '1'));
    assert.equal(page.data.showExtra, true); assert.equal(page.data.showShootout, false);
    page.onInput(input('extraA', '0')); page.onInput(input('extraB', '0')); page.onSwitch(input('extraTimeCompleted', true));
    assert.equal(page.data.showShootout, true);
    page.onInput(input('shootoutA', '4')); page.onInput(input('shootoutB', '3'));
    page.onInput(input('regulationA', '2'));
    assert.equal(page.data.showExtra, false); assert.equal(page.data.form.extraA, '');
    assert.equal(page.data.form.shootoutA, '');
  });
});
test('F2 页面：快速名单分开首发与未出场替补，普通只读用户不能修改或提交', t => {
  football(t);
  return withApi({ getTeamMatchStats: () => base() }, async calls => {
    const page = instantiate(loadPage('football-match/football-match.js')); await page.onLoad({ matchId: 'fm' });
    page.onQuickLineup();
    const rows = page.data.form.sides[0].players;
    assert.equal(rows.filter(p => p.starter).length, 11); assert.equal(rows[0].goalkeeper, true);
    assert.equal(rows[11].selected, true); assert.equal(rows[11].appeared, false);
    page.setData({ 'info.canEdit': false });
    page.onInput(input('regulationA', '8')); page.onQuickLineup(); await page.onSubmit();
    assert.equal(page.data.form.regulationA, ''); assert.equal(calls.filter(c => c[0] === 'recordTeamMatch').length, 0);
  });
});
test('F2 页面：队长赛前名单仅能保存本方，不经过赛后录分', t => {
  football(t); const data = base();
  data.sides = ['A', 'B'].map(side => ({ side, players: data.rosters[side], editable: side === 'B', lineup: null }));
  return withApi({ getTeamMatchLineup: () => data, saveTeamMatchLineup: () => ({ ok: true }) }, async calls => {
    const page = instantiate(loadPage('football-match/football-match.js')); await page.onLoad({ matchId: 'fm', lineup: '1' });
    page.onQuickLineup(); assert.equal(page.data.form.sides[0].players[0].selected, false);
    page.onSide({ currentTarget: { dataset: { index: 1 } } }); page.onQuickLineup();
    await page.onSubmit(); const write = calls.find(c => c[0] === 'saveTeamMatchLineup');
    assert.equal(write[1].side, 'B'); assert.equal(write[1].lineup.players.length, 12);
    assert.equal(calls.some(c => c[0] === 'recordTeamMatch'), false);
  });
});
test('F2/F3 赛事页：足球榜单和报告入口，无实时订阅；返回后刷新', t => {
  football(t);
  const event = { eventId: 'fe', sportFormat: 'football11', supportsMatchData: true, supportsLiveScore: false,
    format: 'round_robin', status: 'running', canManage: true };
  return withApi({ getTeamEvent: () => ({ ok: true, event, matches: [], table: [] }),
    getTeamEventPlayerStats: () => ({ ok: true, players: [{ userId: 'a', goals: 1 }], assists: [{ userId: 'b', assists: 1 }], coverageText: '已发布一场' }) }, async calls => {
    const page = instantiate(loadPage('team-event-detail/team-event-detail.js')); await page.onLoad({ eventId: 'fe' });
    await page.onLoadPlayerStats(); assert.equal(page.data.footballAssists[0].assists, 1);
    assert.equal(page.liveSubscription, null); assert.equal(calls.some(c => c[0] === 'getTeamLiveScores'), false);
    await withWx(({ navigations }) => { page.onOpenFootball({ currentTarget: { dataset: { matchid: 'fm:1' } } });
      assert.match(navigations[0], /football-match\?matchId=fm%3A1/); });
    await page.onShow(); assert.equal(calls.filter(c => c[0] === 'getTeamEvent').length, 2);
  });
});
test('F3 个人页按运动展示足球累计，团队荣誉注明报名成员', t => {
  football(t);
  return withApi({ getMyTeamProfile: () => ({ ok: true, sportFormat: 'football11', totals: { games: 0, goalsText: '—' }, teams: [], events: [], honors: [], statEvents: [] }) }, async () => {
    const page = instantiate(loadPage('my-team-profile/my-team-profile.js')); await page.onLoad();
    assert.equal(page.data.isFootball, true); assert.equal(page.data.profile.totals.games, 0);
  });
});

test('F2 审核页只能发布已保存版本，未保存的表单改动须先提交', t => {
  football(t); const data = base(); data.canReview = true;
  data.report = normalizeFootballReport({ result: { regulationScore: { A: 1, B: 0 } },
    sides: { A: { players: [] }, B: { players: [] } } }, data).value;
  return withApi({ getTeamMatchStats: () => data, publishTeamMatch: () => ({ ok: true }) }, async calls => {
    const page = instantiate(loadPage('football-match/football-match.js')); await page.onLoad({ matchId: 'fm' });
    page.onInput(input('regulationA', '2'));
    await page.onReview({ currentTarget: { dataset: { approve: 'true' } } });
    assert.match(page.data.notice, /未保存/); assert.equal(calls.some(c => c[0] === 'publishTeamMatch'), false);
    await page.refresh(); await page.onReview({ currentTarget: { dataset: { approve: 'true' } } });
    assert.equal(calls.filter(c => c[0] === 'publishTeamMatch').length, 1);
  });
});
