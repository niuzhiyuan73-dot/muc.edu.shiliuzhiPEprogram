/**
 * S2 比赛面板装载器 loadSchoolMatchView（P10 合并批补的覆盖）
 * ============================================================
 * 【为什么现在才补】`school-match-view.js` 是比赛面板（components/match-panel）
 * 唯一的取数口，页面一直在用，但**此前零测试覆盖**——旧栈的
 * `loadMatchView` 有 14 条端到端用例守着，S2 这个装载器一条都没有。删旧栈前
 * 必须先把等价覆盖建起来，否则「测试全绿」的覆盖面会静默缩水。
 *
 * 【接口形状与旧栈不同，因此是重写而不是照搬】
 *   · 旧栈 `loadMatchView({ userId, user, tab, limit })`：自己去问门面「当前用户
 *     是谁」，查无此人时返回 `{ found: false }`；
 *   · S2  `loadSchoolMatchView(api, tab)`：api 由页面注入（已绑定 scope），
 *     viewer 从服务端上下文取，读失败**抛错**而不是返回 found:false。
 *
 * 守的是：
 *   1. 读失败抛错，不静默返回空页（旧栈的 found:false 在 S2 无对应通路）；
 *   2. viewer 认当前会话身份，不传 userId；访客 / 无本协会身份都不下发台账；
 *   3. 标签切换、默认标签、非法标签退回；
 *   4. 每行的「是不是我的比赛」「胜 / 负」按 viewer 算；
 *   5. limit 如实下传，total / hasMore 原样透传；
 *   6. 录一场 → 待确认标签出现它；确认后转已生效且不可再确认。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-match-service');
const { loadSchoolMatchView } = require('../miniprogram/services/school-match-view');
const { TAB, TAB_LABEL, TAB_EMPTY, DEFAULT_LIMIT } = require('../miniprogram/services/match-view');
const { schoolMemberKey } = require('../src/shared/utils/school');
const { MATCH_TYPE, MATCH_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

const ME = 'demo_muc_member';
const RIVAL = 'demo_muc_member_2';

/** 演示仓储：两位参赛者都在民大匹克球在册 */
function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, gender = 'M') => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  add(ME);
  add(RIVAL);
  return createSchoolMemoryRepo(seed);
}

/** 按 scope 造一个「已绑定范围」的 api（页面拿到的就是这种） */
function apiOf(repo, opts = {}) {
  const { actor = ME, schoolId = 'muc', association = 'pkb' } = opts;
  const invoke = async (action, payload) => {
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now: NOW });
    return (await handlers[action](payload, ctx)).data;
  };
  return {
    getSchoolMatchEntryContext: payload => invoke('getSchoolMatchEntryContext', payload),
    listSchoolMatches: payload => invoke('listSchoolMatches', payload),
  };
}

const casual = (extra = {}) => ({
  matchType: MATCH_TYPE.SINGLES, teamA: [ME], teamB: [RIVAL],
  scoreA: [11], scoreB: [9], gamePoints: 11, bestOf: 1, matchTime: at(-HOUR), ...extra,
});

/** 直接经服务层录一场（不经过视图），返回 matchId */
async function recordMatch(repo, token, extra = {}) {
  const ctx = await buildSchoolContext({ repo, actorId: ME, scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  const result = await handlers.submitSchoolMatch({ requestId: token, ...casual(extra) }, ctx);
  assert.equal(result.data.ok, true, result.data.message);
  return result.data.match.matchId;
}

/** 直接经服务层确认一场 */
async function confirmMatch(repo, matchId, actor = RIVAL) {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  return (await handlers.confirmSchoolMatch({ matchId }, ctx)).data;
}

/* ---------------------------------------------------------- 读失败：抛错而非空页 */

describe('读失败 —— S2 抛错，没有旧栈那种 found:false 通路', () => {
  test('取录入上下文失败时抛错，不返回空页', async () => {
    const repo = fixture();
    const api = {
      ...apiOf(repo),
      getSchoolMatchEntryContext: async () => ({ ok: false, message: '数据源不可用' }),
    };
    await assert.rejects(loadSchoolMatchView(api, TAB.MINE), /数据源不可用/);
  });

  test('列表失败时抛错，不返回空页', async () => {
    const repo = fixture();
    await recordMatch(repo, 'r-list-fail');
    const api = {
      ...apiOf(repo),
      listSchoolMatches: async () => ({ ok: false, message: '台账读取失败' }),
    };
    await assert.rejects(loadSchoolMatchView(api, TAB.MINE), /台账读取失败/);
  });
});

/* ------------------------------------------------------------ viewer 与访客 */

test('viewer 认当前会话身份，不需要页面传 userId', async () => {
  const repo = fixture();
  const view = await loadSchoolMatchView(apiOf(repo), TAB.MINE);

  assert.equal(view.found, true);
  assert.equal(view.viewer.userId, ME);
  assert.equal(view.viewer.loggedIn, true);
  assert.equal(view.needLogin, false);
  assert.equal(view.emptyText, TAB_EMPTY[TAB.MINE]);
});

test('访客（未登录）不下发任何台账，并给出登录引导', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-guest');

  const view = await loadSchoolMatchView(apiOf(repo, { actor: '' }), TAB.MINE);

  assert.equal(view.viewer.userId, null);
  assert.equal(view.viewer.loggedIn, false);
  assert.deepEqual(view.records, [], '访客不该看到任何一行内部台账');
  assert.equal(view.total, 0);
  assert.equal(view.pendingCount, 0);
  assert.equal(view.needLogin, true);
  assert.match(view.emptyText, /请先登录/);
});

test('访客两个标签都是空的，不泄露流转中的成绩', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-guest-2');
  const api = apiOf(repo, { actor: '' });

  assert.deepEqual((await loadSchoolMatchView(api, TAB.PENDING)).records, []);
  assert.deepEqual((await loadSchoolMatchView(api, TAB.MINE)).records, []);
});

test('没有本协会有效身份时不拉内部台账，给出身份提示', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-outsider');

  // 外校管理员看民大：身份不属本协会，读不到台账
  const view = await loadSchoolMatchView(apiOf(repo, { actor: 'demo_buaa_admin' }), TAB.MINE);

  assert.deepEqual(view.records, []);
  assert.equal(view.total, 0);
  assert.match(view.emptyText, /身份|权限/);
});

/* --------------------------------------------------------------- 标签 */

test('两个标签里恰好有一个是选中的', async () => {
  const repo = fixture();
  const view = await loadSchoolMatchView(apiOf(repo), TAB.PENDING);

  assert.equal(view.tabs.length, Object.keys(TAB).length);
  const active = view.tabs.filter(item => item.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].tab, view.activeTab);
  assert.equal(active[0].label, TAB_LABEL[view.activeTab]);
});

test('不传标签或传非法标签都退回「我的比赛」，不给空白页', async () => {
  const repo = fixture();

  assert.equal((await loadSchoolMatchView(apiOf(repo))).activeTab, TAB.MINE);
  for (const bad of ['nope', null, undefined, 99]) {
    const view = await loadSchoolMatchView(apiOf(repo), bad);
    assert.equal(view.activeTab, TAB.MINE);
    assert.equal(view.emptyText, TAB_EMPTY[TAB.MINE]);
  }
});

/* --------------------------------------------------------------- 行内容 */

test('「我的比赛」里每一行都确实有我，且分出胜负的标出胜 / 负', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-mine-1');
  const confirmed = await recordMatch(repo, 'r-mine-2');
  await confirmMatch(repo, confirmed);

  const view = await loadSchoolMatchView(apiOf(repo), TAB.MINE);
  assert.ok(view.records.length > 0, '本人应当有比赛');
  assert.ok(view.records.every(row => row.isMine), '默认标签只该出现我参与的场次');

  for (const row of view.records.filter(item => item.winnerSide)) {
    assert.notEqual(row.resultText, '', '分出胜负的比赛该有胜/负标记');
  }
  const done = view.records.find(row => row.matchId === confirmed);
  assert.equal(done.statusLabel, '已生效');
  assert.equal(done.resultText, '胜', '我赢了这一场');
});

test('旁观者的比赛不标胜负 —— 每一行都按 viewer 而不是录入者算', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-spectate');

  // 以无关第三人的视角看：这一场不是他的
  const other = apiOf(repo, { actor: 'demo_muc_member_3' });
  const view = await loadSchoolMatchView(other, TAB.MINE);
  for (const row of view.records) {
    assert.equal(row.isMine, false);
    assert.equal(row.resultText, '', '看别人的比赛不该被标一个「负」');
  }
});

test('已生效的比赛带出赛制文案', async () => {
  const repo = fixture();
  const matchId = await recordMatch(repo, 'r-format');
  await confirmMatch(repo, matchId);

  const view = await loadSchoolMatchView(apiOf(repo), TAB.MINE);
  const row = view.records.find(item => item.matchId === matchId);
  assert.match(row.formatText, /^\d+ 分制 · (一局一胜|三局两胜|五局三胜)$/);
});

/* ---------------------------------------------------------- 分页参数透传 */

test('limit 如实下传，用的是视图模块的默认上限', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-limit');

  const seen = [];
  const base = apiOf(repo);
  const api = {
    getSchoolMatchEntryContext: base.getSchoolMatchEntryContext,
    listSchoolMatches: async payload => { seen.push(payload); return base.listSchoolMatches(payload); },
  };
  await loadSchoolMatchView(api, TAB.MINE);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].limit, DEFAULT_LIMIT);
  assert.equal(seen[0].userId, ME, '按 viewer 拉本人的台账');
  assert.equal(seen[0].status, undefined, '「我的比赛」不按状态过滤');
});

test('待确认标签把状态条件下传到服务端', async () => {
  const repo = fixture();
  await recordMatch(repo, 'r-pending-filter');

  const seen = [];
  const base = apiOf(repo);
  const api = {
    getSchoolMatchEntryContext: base.getSchoolMatchEntryContext,
    listSchoolMatches: async payload => { seen.push(payload); return base.listSchoolMatches(payload); },
  };
  await loadSchoolMatchView(api, TAB.PENDING);

  assert.equal(seen[0].status, MATCH_STATUS.PENDING);
});

test('total / hasMore / pendingCount 原样透传，不拿本页条数冒充总数', async () => {
  const api = {
    getSchoolMatchEntryContext: async () => ({ ok: true, viewer: { userId: ME, nickName: ME },
      canRecord: true, members: [{ userId: ME, nickName: '我' }], pairInfo: null,
      seasonStart: null, message: '' }),
    listSchoolMatches: async () => ({ ok: true, matches: [], total: 250, hasMore: true,
      pendingCount: 7 }),
  };

  const view = await loadSchoolMatchView(api, TAB.MINE);
  assert.equal(view.total, 250, 'total 报筛选后的总数，页面据此提示「只显示最近 N 场」');
  assert.equal(view.hasMore, true);
  assert.equal(view.pendingCount, 7);
  assert.deepEqual(view.records, []);
});

/* ------------------------------------------------------------ 状态流转 */

test('录一场之后，待确认标签出现它；S2 严格口径下不再放宽确认', async () => {
  const repo = fixture();
  const matchId = await recordMatch(repo, 'r-flow-1');

  const view = await loadSchoolMatchView(apiOf(repo), TAB.PENDING);
  assert.equal(view.pendingCount, 1);

  const row = view.records.find(item => item.matchId === matchId);
  assert.ok(row, '刚录的这场应当出现在待确认里');
  assert.equal(row.statusLabel, '待确认');
  assert.equal(row.isMine, true);

  // 【与旧栈不同、且是有意为之】旧栈在演示数据源下放宽「录入者也能确认」，
  // 并在页面挂一条「演示口径」提示。S2 的 matchSummary 不再放宽
  // （见 match-view.buildRecordRow 的注释：演示数据源不再放宽），因此这里
  // 既不该出现 confirmRelaxed，也不该挂演示口径提示。这条断言守的就是
  // 「别把旧栈的放宽悄悄加回来」。
  assert.equal(row.confirmRelaxed, false);
  assert.equal(view.demoNotice, '');
});

test('确认后状态变为已生效，且不再可确认', async () => {
  const repo = fixture();
  const matchId = await recordMatch(repo, 'r-flow-2');
  const confirmed = await confirmMatch(repo, matchId);
  assert.equal(confirmed.ok, true, confirmed.message);

  const mine = await loadSchoolMatchView(apiOf(repo), TAB.MINE);
  const row = mine.records.find(item => item.matchId === matchId);
  assert.ok(row);
  assert.equal(row.statusLabel, '已生效');
  assert.equal(row.canConfirm, false);
  assert.equal(row.resultText, '胜');

  // 待确认标签里不再有它
  const pending = await loadSchoolMatchView(apiOf(repo), TAB.PENDING);
  assert.equal(pending.records.some(item => item.matchId === matchId), false);
  assert.equal(pending.pendingCount, 0);
});
