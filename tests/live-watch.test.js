/**
 * 实时比分轮询适配器（M7 第四期）
 * ============================================================
 * 适配器是「不频繁刷新」的实现处，也是全仓唯一允许 setInterval 的地方。
 * 这里用假定时器把它钉死：
 *
 *   1. 没有进行中的比赛 ⇒ 零请求、零定时器；
 *   2. 有比赛 ⇒ 每 2 秒一次，订阅时立即补一次；
 *   3. 比分没变 ⇒ 一个字节都不回调；变了才回调；
 *   4. 单拍失败 ⇒ 静默跳过，下一拍照常；
 *   5. pause 停表、resume 立即补一次；取消后旧表不再跑。
 *
 * 【取数器改为必填后，本测试也换了注入方式】
 * 从前是「替换门面出口 `getLiveScores`」；协议 1 门面按 P10 下线后，适配器
 * 不再有缺省取数路径，改为**由调用方注入**（三个页面调用点本就都传了
 * `getSchoolLiveScores`）。所以这里改为注入一个假取数器，与页面的用法一致——
 * 顺带把「不传取数器会怎样」也变成可断言的行为。
 * ============================================================
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { watchLiveScores, POLL_INTERVAL } = require('../miniprogram/services/live-watch.js');

/** 让已 resolve 的 Promise 链跑完（不用被 mock 的 setImmediate） */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一条最小的实时视图 */
function view(matchId, pointsA, pointsB, extra = {}) {
  return {
    matchId,
    pointsA,
    pointsB,
    gamesA: 0,
    gamesB: 0,
    gameIndex: 0,
    status: 'live',
    finished: false,
    leading: '',
    gamePoints: 11,
    bestOf: 3,
    ...extra,
  };
}

describe('实时比分轮询适配器', () => {
  let handles = [];
  let calls = 0;
  /** 假取数器的实际行为，由各用例通过 install 指定 */
  let impl = async () => [];

  /**
   * 指定这一用例的取数行为，并把调用计数清零。
   * 计数是整段 describe 共用的，不归零就会把上一个用例的调用累加进来，
   * 断言「这一用例只请求了一次」时必然误判。
   */
  function install(fetcher) {
    calls = 0;
    impl = fetcher;
  }

  /** 与页面同样的用法：把取数器交给适配器 */
  function countingFetch(ids) {
    calls += 1;
    return impl(ids);
  }

  function watch(ids, cb) {
    const off = watchLiveScores(ids, cb, { fetch: countingFetch });
    handles.push(off);
    return off;
  }

  afterEach(() => {
    for (const off of handles) off();
    handles = [];
  });

  test('空名单 —— 不启表、不发一次请求', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => []);
    let updates = 0;

    watch([], () => {
      updates += 1;
    });
    await flush();
    t.mock.timers.tick(POLL_INTERVAL * 5);
    await flush();

    assert.equal(calls, 0, '没有进行中的比赛就该零请求');
    assert.equal(updates, 0);
  });

  test('订阅立即补一次；比分没变不回调，变了才回调', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let data = [view('m1', 1, 0)];
    install(() => data.map((item) => ({ ...item })));

    const seen = [];
    watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(calls, 1, '订阅时立即补一次');
    assert.equal(seen.length, 1);

    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 1, '比分没变时不惊动页面');

    data = [view('m1', 2, 0)];
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 2);
    assert.equal(seen[1][0].pointsA, 2);
  });

  test('单拍失败静默跳过，退避一拍后再照常', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let failing = true;
    install(async () => {
      if (failing) throw new Error('网络异常');
      return [view('m1', 1, 0)];
    });

    const seen = [];
    watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(seen.length, 0, '首发失败既不回调也不冒泡');

    // 失败一次 ⇒ 退避到 2 × POLL_INTERVAL（指数退避第一档）。
    // 故障期所有客户端若都按原节奏猛打，恢复期会被打得更久（审查 P2-12）。
    failing = false;
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 0, '退避期内不发下一拍');

    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 1, '退避结束后照常取到数据');
  });

  test('pause 停表、resume 立即补一次', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let data = [view('m1', 1, 0)];
    install(() => data.map((item) => ({ ...item })));

    const seen = [];
    const off = watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(calls, 1);

    off.pause();
    t.mock.timers.tick(POLL_INTERVAL * 3);
    await flush();
    assert.equal(calls, 1, '隐藏后不再请求');

    data = [view('m1', 5, 0)];
    off.resume();
    await flush();
    assert.equal(calls, 2, '回到前台立即补一次');
    assert.equal(seen.length, 2);
    assert.equal(seen[1][0].pointsA, 5);
  });

  test('取消订阅后旧表不再跑', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => [view('m1', 1, 0)]);

    const off = watch(['m1'], () => {});
    await flush();
    assert.equal(calls, 1);

    off();
    t.mock.timers.tick(POLL_INTERVAL * 3);
    await flush();
    assert.equal(calls, 1);
  });

  test('换名单重订阅 —— 同一时刻只有一张表在跑', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => [view('m1', 1, 0)]);

    let firstCallbacks = 0;
    watch(['m1'], () => {
      firstCallbacks += 1;
    });
    await flush();
    assert.equal(calls, 1);

    // 名单变了：再订阅一次，旧的应先被停掉
    watch(['m2'], () => {});
    await flush();
    assert.equal(calls, 2);

    const before = calls;
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(calls, before + 1, '只应有一张表在轮询');
    assert.equal(firstCallbacks, 1, '旧订阅停了就不再回调');
  });
});

/**
 * 取数器必填：这一组守的是「不留悄悄读旧栈门面的缺省路径」。
 * 从前不传就回落到门面的 getLiveScores，那条路径在协议 1 下线后必须消失——
 * 否则页面已改接 S2，适配器却还在读旧台账，两处各说各话且只在真机上看得出来。
 */
describe('实时比分轮询适配器 —— 取数器必填', () => {
  const handles = [];

  afterEach(() => {
    while (handles.length) handles.pop()();
  });

  test('名单非空却不给取数器 —— 订阅当场报错', () => {
    assert.throws(
      () => watchLiveScores(['m1'], () => {}),
      /options\.fetch/,
      '缺省取数路径应当已经不存在'
    );
  });

  test('空名单不传取数器也不报错（本就不启表、不请求）', () => {
    const off = watchLiveScores([], () => {});
    handles.push(off);
    assert.equal(typeof off, 'function', '空名单仍应返回可用的取消句柄');
  });
});

test('篮球轮询：总分相同但节次版本变化仍回调，慢请求不并发堆积', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let release;
  const seen = [];
  const off = watchLiveScores(['basketball'], rows => seen.push(rows), { fetch: async () => {
    calls += 1;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return [{ matchId: 'basketball', pointsA: 2, pointsB: 2,
      status: 'live', revision: calls, live: { period: calls } }];
  } });
  try {
    t.mock.timers.tick(POLL_INTERVAL * 3);
    await flush();
    assert.equal(calls, 1, '未返回的请求不能堆积');
    release();
    await flush();
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 2, '换节也必须更新观众页面');
    assert.equal(seen[1][0].live.period, 2);
  } finally { off(); }
});

test('连续失败按指数退避，成功后回到原节奏', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let failing = true;
  const off = watchLiveScores(['m1'], () => {}, { fetch: async () => {
    calls += 1;
    if (failing) throw new Error('boom');
    return [{ matchId: 'm1', status: 'live' }];
  } });
  try {
    await flush();
    assert.equal(calls, 1, '订阅即拍一次');
    // 第 1 次失败 ⇒ 2×；第 2 次失败 ⇒ 4×
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    assert.equal(calls, 2, '第一档退避后重拍');
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    assert.equal(calls, 2, '第二档退避（4×）未到，不发请求');
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    assert.equal(calls, 3, '第二档退避到点才重拍');
    // 第 3 次失败后间隔是 16 秒（2×2³）。恢复：成功一拍后 interval 复位。
    failing = false;
    t.mock.timers.tick(POLL_INTERVAL * 8);
    await flush();
    assert.equal(calls, 4, '成功那一拍');
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(calls, 5, '成功后恢复 2 秒一拍');
  } finally { off(); }
});

test('没有 live 场次时降频到空闲间隔，出现 live 立刻恢复', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let live = false;
  const off = watchLiveScores(['m1'], () => {}, { fetch: async () => {
    calls += 1;
    return [{ matchId: 'm1', status: live ? 'live' : 'pending' }];
  } });
  try {
    await flush();
    // 连续 3 拍无 live 后降频：2+2+2 秒内应有 3 次调用
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    const beforeIdle = calls;
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    assert.equal(calls, beforeIdle, '空闲期内 2 秒不再发请求（已降到 8 秒）');
    t.mock.timers.tick(8000);
    await flush();
    assert.equal(calls, beforeIdle + 1, '空闲间隔到点才拍一次');

    live = true;
    t.mock.timers.tick(8000);
    await flush();
    const afterLive = calls;
    t.mock.timers.tick(POLL_INTERVAL * 2);
    await flush();
    assert.equal(calls, afterLive + 1, '出现 live 后回到 2 秒节奏');
  } finally { off(); }
});

test('网球盘分或抢七记录变化也触发回调', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let data = [view('m1', 0, 0, { setsA: 0, setsB: 0, tiebreaks: [] })];
  const seen = [];
  const off = watchLiveScores(['m1'], views => seen.push(views), {
    fetch: async () => data.map(item => ({ ...item })),
  });
  try {
    await flush();
    assert.equal(seen.length, 1);
    data = [view('m1', 0, 0, { setsA: 1, setsB: 0, tiebreaks: [{ setIndex: 0, a: 7, b: 5 }] })];
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 2, '盘分变化必须通知观众页');
    assert.equal(seen[1][0].setsA, 1);
  } finally { off(); }
});
