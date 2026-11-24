const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadPage, instantiate, withWx } = require('./helpers/page-harness');
const { pageFileOf, isRegistered } = require('./helpers/page-registry');
const identity = require('../miniprogram/services/school-identity');
const session = require('../miniprogram/services/school-session');
const association = require('../miniprogram/services/association-scope');
const runtime = require('../miniprogram/services/runtime-mode');
const mock = require('../src/mock/school-mock.js');
const { openSportsTarget } = require('../miniprogram/templates/personal-sports-client');
const { loadSchoolMatchView } = require('../miniprogram/services/school-match-view');
const tap = dataset => ({ currentTarget: { dataset } });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const empty = extra => ({ ok: true, items: [], hasMore: false, asOf: '2026-10-28T00:00:00.000Z', ...extra });
const row = key => ({ key, title: key, target: { kind: 'personal_event', association: 'pkb', id: key } });
async function withDashboard(fn, run) {
  const prior = identity.forSchoolIdentity, priorApp = global.getApp;
  let user = { _id: 'demo_muc_member', platformStatus: 'active' };
  global.getApp = () => ({ getUserInfo: () => user });
  identity.forSchoolIdentity = scope => ({ getMySportsDashboard: payload => fn(payload, scope) });
  try { return await run(value => { user = value; }); }
  finally { identity.forSchoolIdentity = prior; global.getApp = priorApp; }
}
beforeEach(() => { runtime.setDataSource('mock'); mock.reset(); session.reset(); session.setSchoolId('muc'); association.setAssociation('pkb'); });

test('我的体育页面四件套已注册，所有WXML交互处理器存在且使用协会主题', () => {
  assert.equal(isRegistered('my-sports'), true);
  const config = loadPage('my-sports');
  for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.equal(fs.existsSync(pageFileOf('my-sports', '.' + extension)), true);
  const wxml = fs.readFileSync(pageFileOf('my-sports', '.wxml'), 'utf8');
  for (const [, method] of wxml.matchAll(/(?:bind|catch)(?:\w+|:\w+)="(\w+)"/g)) assert.equal(typeof config[method], 'function', method);
  assert.match(wxml, /\{\{themeClass\}\}/); assert.match(wxml, /已显示 \{\{items.length\}\} 条/);
  assert.doesNotMatch(wxml, /总计|成长值|经验值/);
});

test('快速切换分区及项目时，旧响应不能覆盖当前列表', async () => withDashboard((payload) => payload.section === 'schedule' ? first.promise : payload.project ? third.promise : second.promise, async () => {
  const p = instantiate(loadPage('my-sports'));
  const a = p.onLoad(), b = p.onTab(tap({ tab: 'passport' })), c = p.onProject(tap({ project: 'meet' }));
  third.resolve(empty({ items: [row('meet-record')] })); await c;
  second.resolve(empty({ items: [row('passport-old')] })); first.resolve(empty({ items: [row('schedule-old')] })); await Promise.all([a, b]);
  assert.equal(p.data.tab, 'passport'); assert.equal(p.data.project, 'meet'); assert.deepEqual(p.data.items.map(r => r.key), ['meet-record']);
}));
let first, second, third;
beforeEach(() => { first = defer(); second = defer(); third = defer(); });

test('续页失败保留已加载内容，重试仍用原游标；分页去重且不伪造总数', async () => {
  let calls = 0; const cursors = [];
  await withDashboard(payload => { cursors.push(payload.cursor); calls++;
    if (calls === 1) return empty({ items: [row('a')], hasMore: true, nextCursor: 'next' });
    if (calls === 2) throw new Error('网络暂不可用');
    return empty({ items: [row('a'), row('b')] });
  }, async () => {
    const p = instantiate(loadPage('my-sports')); await p.onLoad(); await p.onMore();
    assert.match(p.data.moreError, /网络/); assert.equal(p.data.items.length, 1);
    await p.onMore(); assert.deepEqual(p.data.items.map(r => r.key), ['a', 'b']);
    assert.deepEqual(cursors, ['', 'next', 'next']); assert.equal(p.data.hasMore, false);
  });
});

test('续页时权限已变化必须清除旧内容和打开的比赛；首次读取错误不能冒充空结果', async () => {
  let calls = 0;
  await withDashboard(() => ++calls === 1 ? empty({ items: [row('a')], hasMore: true, nextCursor: 'next' }) : { ok: false, resetRequired: true, message: '权限已变化，请刷新' }, async () => {
    const p = instantiate(loadPage('my-sports')); await p.onLoad(); p.setData({ focusMatchId: 'a' }); await p.onMore();
    assert.match(p.data.error, /权限/); assert.deepEqual(p.data.items, []); assert.equal(p.data.focusMatchId, ''); assert.equal(p.data.hasMore, false);
  });
  await withDashboard(() => { throw new Error('数据库不可用'); }, async () => {
    const p = instantiate(loadPage('my-sports')); await p.onLoad(); assert.match(p.data.error, /数据库/);
  });
});

test('切换学校或账号先清旧卡片；在途旧响应和卸载后的回调不能回写', async () => withDashboard(() => first.promise, async setUser => {
  const p = instantiate(loadPage('my-sports')); const loading = p.onLoad();
  setUser({ _id: 'other' }); first.resolve(empty({ items: [row('private-old')] })); await loading;
  assert.deepEqual(p.data.items, []);
  p.loaded = true; p.setData({ items: [row('old')] });
  identity.forSchoolIdentity = () => ({ getMySportsDashboard: () => second.promise });
  const changed = p.onShow(); assert.deepEqual(p.data.items, []);
  p.onUnload(); second.resolve(empty({ items: [row('late')] })); await changed; assert.deepEqual(p.data.items, []);
}));

test('个人中心入口复用真实本地接口，三个分区均有明确空态或事实卡片', async () => withWx(async () => {
  const priorApp = global.getApp;
  global.getApp = () => ({ getUserInfo: () => ({ _id: 'demo_muc_member', platformStatus: 'active' }) });
  try {
    mock.setDemoActor('demo_muc_member');
    const p = instantiate(loadPage('my-sports')); await p.onLoad({ tab: 'passport' });
    assert.equal(p.data.error, ''); assert.equal(p.data.tab, 'passport'); assert.match(p.data.caption, /确认或发布/);
    for (const tab of ['tasks', 'schedule']) { await p.onTab(tap({ tab })); assert.equal(p.data.error, ''); assert.ok(Array.isArray(p.data.items)); }
  } finally { global.getApp = priorApp; }
}));

test('跳转只编码一次，拒绝未知目标；打开个人比赛使用原有比赛面板', async () => withWx(async ({ navigations }) => {
  const id = 'match:100%:测试';
  assert.equal(openSportsTarget({ kind: 'confirm_score', association: 'pkb', id }), true);
  assert.ok(navigations[0].includes(`matchId=${encodeURIComponent(id)}`));
  assert.equal(new URL(`https://example.test${navigations[0]}`).searchParams.get('matchId'), id);
  assert.equal(openSportsTarget({ kind: '__proto__', id }), false);
  await withDashboard(() => empty({ items: [{ ...row('m'), target: { kind: 'confirm_score', association: 'tt', id } }] }), async () => {
    const p = instantiate(loadPage('my-sports')); await p.onLoad(); p.onOpen(tap({ key: 'm' }));
    assert.equal(p.data.focusMatchId, id); assert.equal(association.getAssociation(), 'tt'); assert.equal(navigations.length, 1);
  });
  let component; const oldComponent = global.Component;
  global.Component = value => { component = value; };
  const file = require.resolve('../miniprogram/components/match-panel/match-panel');
  try { delete require.cache[file]; require(file); } finally { global.Component = oldComponent; }
  const panel = instantiate({ data: { ...component.data, focusMatchId: id }, ...component.methods });
  panel.request = 1; panel.setData({ view: { records: [{ matchId: id, canAssignReferee: true }] } });
  const requested = [];
  panel.api = { listSchoolMembers: async payload => { requested.push(payload); return { ok: true, members: [{ userId: payload.cursor ? 'later' : 'outside-match', nickName: '其他裁判' }], hasMore: !payload.cursor, nextCursor: 'page2' }; } };
  await panel.onOpenReferee(tap({ matchId: id }));
  assert.equal(panel.data.referee.rows[0].id, 'outside-match');
  await panel.onMoreFocusedReferees(); assert.equal(panel.data.referee.rows.length, 2);
  assert.deepEqual(requested.map(r => [r.page, r.limit, r.cursor]), [[true, 20, ''], [true, 20, 'page2']]);
  const late = defer(); panel.api.listSchoolMembers = () => late.promise;
  const pending = panel.loadFocusedReferees('新裁判'); panel.onCancelReferee();
  late.resolve({ ok: true, members: [{ userId: 'late', nickName: '过期结果' }] }); await pending;
  assert.ok(!panel.data.referee.rows.some(r => r.id === 'late'));
}));

test('单场面板只取指定比赛，探测原编号后最多解码一次，不加载全校名册或整页比赛', async () => {
  const calls = [], canonical = 'match:100%:测试';
  const api = { getSchoolMatch: async payload => {
    calls.push(payload);
    return payload.matchId === canonical ? { ok: true, viewer: { userId: 'u' }, members: [{ userId: 'u', nickName: '本人' }, { userId: 'v', nickName: '对手' }],
      match: { matchId: canonical, teamA: ['u'], teamB: ['v'], status: 0, scoreA: [], scoreB: [], matchType: 1, canConfirm: false } } : { ok: false };
  }, getSchoolMatchEntryContext: () => { throw new Error('不应读取全校名单'); }, listSchoolMatches: () => { throw new Error('不应读取整页台账'); } };
  const view = await loadSchoolMatchView(api, 'mine', { matchId: encodeURIComponent(canonical) });
  assert.equal(view.records.length, 1); assert.equal(view.records[0].canConfirm, false);
  assert.deepEqual(calls.map(row => row.matchId), [encodeURIComponent(canonical), canonical]);
  assert.ok(calls.every(row => row.presentation === true));
});

test('单场展示接口仅补充本场最多5人昵称；默认详情不扩张响应字段', async () => {
  const { createSchoolSeed } = require('../src/mock/school-seed.js');
  const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
  const { buildSchoolContext } = require('../src/server/services/school-context');
  const { getSchoolMatch } = require('../src/server/services/school-match-service');
  const { schoolMemberKey } = require('../src/shared/utils/school');
  const seed = createSchoolSeed();
  seed.users = ['u', 'v', 'r', 'unrelated'].map(_id => ({ _id, nickName: _id, realName: 'SECRET', platformStatus: 'active', primarySchoolId: 'muc' }));
  seed.schoolMembers = seed.users.map(user => ({ _id: schoolMemberKey(user._id, 'muc'), schoolId: 'muc', userId: user._id, status: 'active' }));
  seed.matches = [{ _id: 'm', schoolId: 'muc', association: 'pkb', teamA: ['u'], teamB: ['v'], referee: 'r', matchType: 1, matchTime: '2026-10-29T02:00:00.000Z', status: 0, winner: '', scoreA: [], scoreB: [] }];
  const repo = createSchoolMemoryRepo(seed), ids = [], prior = repo.users.listByIds;
  repo.users.listByIds = list => { ids.push(...list); return prior(list); };
  const ctx = await buildSchoolContext({ repo, actorId: 'u', scope: { schoolId: 'muc', association: 'pkb' } });
  const result = (await getSchoolMatch({ matchId: 'm', presentation: true }, ctx)).data;
  assert.deepEqual(ids.sort(), ['r', 'u', 'v']); assert.equal(result.viewer.userId, 'u'); assert.doesNotMatch(JSON.stringify(result), /SECRET|unrelated/);
  assert.equal((await getSchoolMatch({ matchId: 'm' }, ctx)).data.members, undefined);
});

test('首页个人安排不请求游客数据；换校立即移除旧卡片，过期回调不会回写', async () => withDashboard(() => first.promise, async setUser => {
  const p = instantiate(loadPage('index')); p.setData({ personal: { old: true } });
  const a = p.refreshPersonal(); session.setSchoolId('buaa');
  identity.forSchoolIdentity = () => ({ getMySportsDashboard: () => second.promise });
  const b = p.refreshPersonal(); assert.equal(p.data.personal, null);
  first.resolve({ ok: true, schedule: { items: [row('private-old')] }, tasks: { items: [] } }); await a;
  assert.equal(p.data.personal, null); second.resolve({ ok: true, schedule: { items: [] }, tasks: { items: [] } }); await b;
  setUser(null); identity.forSchoolIdentity = () => { throw new Error('游客不应读取个人安排'); };
  await p.refreshPersonal(); assert.equal(p.data.personal, null); assert.equal(p.data.personalError, '');
}));

test('运动会待办深链打开真实场次编号；学校审核页面沿用当前浏览学校', async () => {
  const p = instantiate(loadPage('meet-score'));
  p.reload = async () => p.setData({ tasks: [{ sessionKey: '场次:100%' }], events: [] });
  let opened = ''; p.openSession = async id => { opened = id; };
  await p.onLoad({ meetId: 'meet', sessionKey: encodeURIComponent('场次:100%') }); assert.equal(opened, '场次:100%');
  session.setSchoolId('buaa');
  const school = instantiate(loadPage('school-identity')); school.reload = async () => {};
  await school.onLoad(); assert.equal(school.data.schoolId, 'buaa');
});
