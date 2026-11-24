/**
 * 详情页的「迟到响应」（2026-10-26 只读审查 P2-8）
 * ============================================================
 * 症状：从赛事详情点进录分页，详情页 onUnload 后，先前发起的刷新请求才回来。
 * 原实现只用「清理已有订阅」收尾，没有让在途请求失效，于是旧响应照样
 * setData 并调用 syncLiveWatch —— 而实时比分订阅是**单例**（同一时刻只允许
 * 一个页面轮询），旧页面这一手会把**当前页面**的表顶掉：
 * 旧页在后台空转、新页的比分停更。
 *
 * 这里用页面夹具把「卸载 → 迟到响应」这条时序钉住：
 *   1. 已卸载的页面不回写 data；
 *   2. 已卸载的页面不重起轮询；
 *   3. 同一页面连发两次刷新时，先回来的那一次不回写（只认最后一次）；
 *   4. 正常（活着且可见）的页面照旧起轮询 —— 别把功能一起修没了。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate } = require('./helpers/page-harness.js');

const viewModule = require('../miniprogram/services/school-event-view.js');
const collegeViewModule = require('../miniprogram/packageCollege/services/school-college-view.js');
const liveWatch = require('../miniprogram/services/live-watch.js');

/** 假的订阅句柄：记录是否被调用、是否被 pause。 */
function fakeHandle() {
  const handle = () => { handle.stopped = true; };
  handle.pause = () => { handle.paused = true; };
  handle.resume = () => { handle.paused = false; };
  handle.stopped = false;
  handle.paused = false;
  return handle;
}

/** 临时替换某个模块的导出，跑完恢复。 */
async function withStub(target, name, value, run) {
  const original = target[name];
  target[name] = value;
  try {
    return await run();
  } finally {
    target[name] = original;
  }
}

/** 一个可以手动放行的 Promise。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * 造一个页面实例，并把「问身份」这一步变成同步返回。
 *
 * 必须这么做：refresh() 的第一个 await 就是 currentActorId，真实实现要发一次
 * 请求；两次并发刷新的**取数顺序**会因此变成不确定的，用例就测不稳。
 */
function makePage(relative) {
  const page = instantiate(loadPage(relative));
  page.currentActorId = async () => 'u_tester';
  return page;
}

const liveRowView = {
  eventId: 'sev:1',
  title: '秋季赛',
  bracketRows: [{ matchId: 'm1', liveActive: true, live: { finished: false } }],
};

test('赛事详情：卸载后迟到的响应既不回写也不重启轮询', async () => {
  const pending = deferred();
  let watches = 0;
  await withStub(viewModule, 'loadSchoolEventDetailView', () => pending.promise, async () => {
    await withStub(liveWatch, 'watchLiveScores', () => { watches += 1; return fakeHandle(); }, async () => {
      const page = makePage('packageEvent/event-detail/event-detail.js');
      const loaded = page.onLoad({ eventId: 'sev:1' });
      page.onUnload();

      pending.resolve(liveRowView);
      await loaded;

      assert.deepEqual(page.data.view, {}, '已卸载的页面不能被迟到的响应回写');
      assert.equal(watches, 0, '已卸载的页面不许重新起轮询（订阅是单例，会顶掉当前页）');
      assert.equal(page.data.loading, true, '加载态也不能被迟到响应改掉');
    });
  });
});

test('赛事详情：两次刷新都在途时，先回来的那次不回写', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  let watches = 0;
  await withStub(viewModule, 'loadSchoolEventDetailView', () => queue.shift().promise, async () => {
    await withStub(liveWatch, 'watchLiveScores', () => { watches += 1; return fakeHandle(); }, async () => {
      const page = makePage('packageEvent/event-detail/event-detail.js');
      // 不经过 onLoad：页面还活着（destroyed 未定义），只验证请求序号
      const a = page.refresh();
      await Promise.resolve(); // 让第一次刷新真的发出请求（否则它会被序号直接作废）
      const b = page.refresh();
      await Promise.resolve();
      assert.equal(queue.length, 0, '两次刷新都应已发出请求');

      // 先放行**旧**的那一次：它的响应必须被丢掉
      first.resolve({ eventId: 'sev:1', title: '旧快照', bracketRows: [] });
      await a;
      assert.equal(page.data.view.title, undefined, '旧响应不能覆盖');

      second.resolve(liveRowView);
      await b;
      assert.equal(page.data.view.title, '秋季赛');
      assert.equal(watches, 1, '只有最后一次刷新可以订阅');
    });
  });
});

test('赛事详情：活着且可见的页面照旧起轮询（功能不能被修没）', async () => {
  let watches = 0;
  await withStub(viewModule, 'loadSchoolEventDetailView', async () => liveRowView, async () => {
    await withStub(liveWatch, 'watchLiveScores', () => { watches += 1; return fakeHandle(); }, async () => {
      const page = makePage('packageEvent/event-detail/event-detail.js');
      await page.onLoad({ eventId: 'sev:1' });
      assert.equal(page.data.view.title, '秋季赛');
      assert.equal(watches, 1, '有正在计分的场次就要起轮询');
    });
  });
});

test('赛事详情：隐藏期间到货的刷新不重启轮询，回前台再订', async () => {
  const pending = deferred();
  let watches = 0;
  await withStub(viewModule, 'loadSchoolEventDetailView', () => pending.promise, async () => {
    await withStub(liveWatch, 'watchLiveScores', () => { watches += 1; return fakeHandle(); }, async () => {
      const page = makePage('packageEvent/event-detail/event-detail.js');
      const loaded = page.onLoad({ eventId: 'sev:1' });
      page.onHide(); // 切到录分页

      pending.resolve(liveRowView);
      await loaded;
      // 数据可以回写（页面还活着，用户还会回来），但不许起表
      assert.equal(page.data.view.title, '秋季赛');
      assert.equal(watches, 0, '隐藏的页面不该轮询');
    });
  });
});

test('学院赛详情：卸载后迟到的响应既不回写也不重启轮询', async () => {
  const pending = deferred();
  let watches = 0;
  const tiesView = {
    eventId: 'col:1',
    title: '学院杯',
    ties: [{ tieId: 't1', legRows: [{ matchId: 'm9', liveActive: true, live: { finished: false } }] }],
  };
  await withStub(collegeViewModule, 'loadCollegeEventDetailView', () => pending.promise, async () => {
    await withStub(liveWatch, 'watchLiveScores', () => { watches += 1; return fakeHandle(); }, async () => {
      const page = makePage('packageCollege/college-event-detail/college-event-detail.js');
      const loaded = page.onLoad({ eventId: 'col:1' });
      page.onUnload();

      pending.resolve(tiesView);
      await loaded;

      assert.equal(page.data.view && page.data.view.title, undefined, '已卸载的页面不能被迟到响应回写');
      assert.equal(watches, 0, '已卸载的页面不许重新起轮询');
    });
  });
});
