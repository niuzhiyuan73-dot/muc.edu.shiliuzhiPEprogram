/**
 * 学校维度：赛事工作台面板装载器 loadSchoolEventsPanelView
 * ============================================================
 * 【为什么现在才补】`school-events-panel-view.js` 是「赛事」页（components/
 * events-panel）唯一的取数口——两个赛事分支（个人赛 / 学院赛）+ 赛季积分榜
 * + 身份会话，全部由它一次取齐。但 P10 合并批之前它**零测试覆盖**：全仓
 * grep 只命中页面调用点，旧栈那 12 条「赛事页 ——」用例守的全是协议 1 的
 * loadEventsView。删旧栈前必须先把等价覆盖建起来。
 *
 * 【本文件怎么造数据】装载器只认三个外部依赖：association-space.forScope、
 * school-identity.forSchoolIdentity，以及 events-view 的纯构建器。这里把前
 * 两个替身掉（与 school-event-view.test.js 的 asSpace 同路数），纯构建器用
 * 真货——要守的正是「纯构建器的输出被装载器正确接起来」。
 *
 * 守的是：
 *   1. 积分榜只列前 10，但 total 报完整人数、计数文案如实交代总数；
 *   2. 名次在完整榜上算：排在显示行之外的本人也拿得到名次；
 *   3. 只列正积分的人；按积分降序；名次连续；
 *   4. 两个赛事分支各自的截断、总数与「查看全部」标记；
 *   5. 积分读失败时抛错，不吞成空榜。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const assocSpace = require('../miniprogram/services/association-space');
const identity = require('../miniprogram/services/school-identity');
const { loadSchoolEventsPanelView } = require('../miniprogram/services/school-events-panel-view');
const { describeSearch } = require('../miniprogram/services/rank-view');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const ME = 'demo_muc_member';
const TOP_LIMIT = 10;

/** 造 N 位会员的积分快照：编号 m1..mN，积分从高到低 */
function membersOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `m${index + 1}`,
    nickName: `会员${index + 1}`,
    avatarUrl: '',
    points: count - index,
    eventCount: 1,
  }));
}

/**
 * 把装载器的两个外部依赖换成替身跑一段。
 * @param {Object} options
 * @param {Array} [options.members] getSchoolMemberStats 的成员行
 * @param {Array} [options.events] 个人赛事列表
 * @param {Object} [options.season] 赛季文档
 * @param {boolean} [options.statsOk] 积分读端是否成功
 * @param {Function} run
 */
/**
 * `getSchoolMemberStats` 的替身：按**新契约**（top / me / total）返回。
 *
 * 面板已经改成只取前 50 名（2026-10-29 第十二轮审计），替身必须同步模拟服务端
 * 的「过滤零分 → 按积分降序、同分按编号 → 截断 → 给本人名次」。若这里偷懒直接
 * 返回 members，测出来的就是替身自己，而不是面板。
 */
function statsStub(members) {
  const ranked = members
    .filter(row => Number(row.points) > 0)
    .sort((a, b) => (b.points - a.points)
      || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return (payload = {}) => {
    const top = Number.isInteger(payload.top) && payload.top > 0 ? Math.min(payload.top, 50) : 0;
    return {
      ok: true,
      top: ranked.slice(0, top || ranked.length),
      me: ranked.find(row => row.userId === ME) || null,
      total: ranked.length,
    };
  };
}

async function withStubs(options, run) {
  const {
    members = [], events = [], season = { startTime: '2026-09-01T00:00:00Z' },
    statsOk = true, seasonOk = true, includePoints = true,
  } = options;
  const origSpace = assocSpace.forScope;
  const origIdentity = identity.forSchoolIdentity;
  assocSpace.forScope = () => ({
    getSchoolMemberStats: async (payload = {}) => (statsOk
      ? statsStub(members)(payload) : { ok: false, message: '没有读取本协会积分的权限' }),
    getSchoolSeason: async () => (seasonOk ? { ok: true, season } : { ok: false, message: '赛季读取失败' }),
    listSchoolEvents: async () => ({ ok: true, events, canManage: true, hasMore: false }),
  });
  identity.forSchoolIdentity = () => ({
    getSchoolIdentitySession: async () => ({ user: { userId: ME } }),
  });
  try {
    return await run(await loadSchoolEventsPanelView({ ...SCOPE, includePoints }));
  } finally {
    assocSpace.forScope = origSpace;
    identity.forSchoolIdentity = origIdentity;
  }
}

/* ---------------------------------------------------------- 积分榜的展示口径 */

describe('赛季积分榜 —— 旧栈「赛事页」那一段的 S2 对应', () => {
  test('只列正积分的人；名次连续且按积分降序', async () => {
    await withStubs({
      members: [
        { userId: 'm1', nickName: '甲', avatarUrl: '', points: 30, eventCount: 2 },
        { userId: 'm2', nickName: '乙', avatarUrl: '', points: 10, eventCount: 1 },
        { userId: 'zero', nickName: '零分', avatarUrl: '', points: 0, eventCount: 1 },
      ],
    }, (view) => {
      assert.equal(view.total, 2, '零分的人不上榜');
      assert.equal(view.rows.some(row => row.userId === 'zero'), false);
      assert.equal(view.rows[0].userId, 'm1');
      view.allRows.forEach((row, index) => {
        assert.equal(row.rank, index + 1, '名次不能断档');
      });
      for (let i = 1; i < view.allRows.length; i += 1) {
        assert.ok(
          Number(view.allRows[i - 1].valueText) >= Number(view.allRows[i].valueText),
          '按积分从高到低'
        );
      }
      assert.equal(view.empty, false);
    });
  });

  test('只列前 10 名，但 total 报完整人数、计数文案如实交代总数', async () => {
    await withStubs({ members: membersOf(14) }, (view) => {
      assert.equal(view.rows.length, TOP_LIMIT);
      assert.equal(view.total, 14, 'total 是完整人数，不是这一页的条数');
      assert.equal(view.hasMore, true);
      assert.equal(view.playerCountText, `前 ${TOP_LIMIT} 名 · 共 14 人`);
      assert.equal(view.allRows.length, 14);
    });

    await withStubs({ members: membersOf(4) }, (view) => {
      assert.equal(view.playerCountText, '4 人上榜');
      assert.equal(view.hasMore, false);
    });
  });

  test('我在榜上时给与完整榜一致的名次；不在榜上时给一句解释', async () => {
    const members = membersOf(14);
    members[12] = { userId: ME, nickName: '我', avatarUrl: '', points: 2, eventCount: 1 };
    await withStubs({ members }, (view) => {
      assert.ok(view.me, '我在榜上');
      assert.equal(view.me.total, view.total, '分母是完整人数');
      assert.ok(view.me.rank > TOP_LIMIT, '这条要验证的正是「我排在显示行之外」');
      assert.equal(view.rows.some(row => row.userId === ME), false, '前十之外不该出现在列表里');
      assert.equal(view.me.rank, view.allRows.find(row => row.userId === ME).rank);
      assert.match(view.me.beatText, /超过/);
      assert.equal(view.meHint, '');
    });

    // 换一份没有我的榜
    await withStubs({ members: membersOf(3) }, (view) => {
      assert.equal(view.me, null);
      assert.equal(view.meHint, '本赛季还没有积分');
      assert.ok(view.rows.length > 0, '我不在榜上不代表榜是空的');
    });
  });

  test('搜索能查到前十之外的人，名次仍是榜上的绝对名次', async () => {
    await withStubs({ members: membersOf(14) }, (view) => {
      const outside = view.allRows[TOP_LIMIT];
      assert.ok(outside, '这份榜要超过前十才验证得了');
      const hit = describeSearch(view.allRows, outside.nickName).rows
        .find(row => row.userId === outside.userId);
      assert.ok(hit, '前十之外的人必须能被搜到');
      assert.equal(hit.rank, outside.rank, '筛选不能改动名次');
      assert.ok(hit.rank > TOP_LIMIT);
    });
  });

  test('空榜给空态文案，不是空白页', async () => {
    await withStubs({ members: [] }, (view) => {
      assert.equal(view.empty, true);
      assert.equal(view.emptyNote, '本赛季还没有积分记录');
      assert.equal(view.me, null);
    });
  });

  test('积分读端失败时抛错，不吞成空榜', async () => {
    await assert.rejects(
      withStubs({ members: [], statsOk: false }, () => {}),
      /没有读取本协会积分的权限/
    );
    await assert.rejects(
      withStubs({ members: [], seasonOk: false }, () => {}),
      /赛季读取失败/
    );
  });
});

/* --------------------------------------------------------- 赛事列表的截断 */

describe('赛事列表 —— 截断与「查看全部」标记', () => {
  const event = id => ({ eventId: id, title: `赛事${id}` });

  test('默认只摆最近 3 条，总数与「查看更多」如实交代', async () => {
    const events = ['e1', 'e2', 'e3', 'e4', 'e5'].map(event);
    await withStubs({ events }, (view) => {
      assert.equal(view.events.length, 3, '默认只摆 3 条');
      assert.equal(view.eventTotal, 5, '总数是全部，不是这一页的条数');
      assert.equal(view.hasMoreEvents, true);
      assert.equal(view.hasEvents, true);
    });
  });

  test('listLimit: Infinity 时拿到全部，不再有「查看更多」', async () => {
    const origSpace = assocSpace.forScope;
    const origIdentity = identity.forSchoolIdentity;
    assocSpace.forScope = () => ({
      getSchoolMemberStats: async () => ({ ok: true, members: [] }),
      getSchoolSeason: async () => ({ ok: true, season: {} }),
      listSchoolEvents: async () => ({ ok: true, events: ['e1', 'e2', 'e3', 'e4'].map(event), canManage: true, hasMore: false }),
    });
    identity.forSchoolIdentity = () => ({ getSchoolIdentitySession: async () => ({ user: { userId: ME } }) });
    try {
      const view = await loadSchoolEventsPanelView({ ...SCOPE, listLimit: Infinity });
      assert.equal(view.events.length, 4);
      assert.equal(view.hasMoreEvents, false);
    } finally {
      assocSpace.forScope = origSpace;
      identity.forSchoolIdentity = origIdentity;
    }
  });

  test('一条赛事都没有时给空态文案而不是空白', async () => {
    await withStubs({ events: [] }, (view) => {
      assert.equal(view.hasEvents, false);
      assert.equal(view.eventsEmptyNote, '还没有赛事，等管理员发布一场吧');
    });
  });

  test('includePoints: false 时不碰积分读端', async () => {
    const origSpace = assocSpace.forScope;
    const origIdentity = identity.forSchoolIdentity;
    let asked = 0;
    assocSpace.forScope = () => ({
      getSchoolMemberStats: async () => { asked += 1; return { ok: false, message: '' }; },
      getSchoolSeason: async () => { asked += 1; return { ok: false, message: '' }; },
      listSchoolEvents: async () => ({ ok: true, events: [], canManage: true, hasMore: false }),
      listCollegeEvents: async () => ({ ok: true, events: [], canManage: true, hasMore: false }),
    });
    identity.forSchoolIdentity = () => ({ getSchoolIdentitySession: async () => ({ user: { userId: ME } }) });
    try {
      const view = await loadSchoolEventsPanelView({ ...SCOPE, includePoints: false });
      assert.equal(asked, 0, '关掉积分就一次都不该去读');
      assert.equal(view.total, 0);
    } finally {
      assocSpace.forScope = origSpace;
      identity.forSchoolIdentity = origIdentity;
    }
  });
});
