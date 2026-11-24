const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness');
const config = loadPage('team-live-score/team-live-score.js');
const detail = loadPage('team-event-detail/team-event-detail.js');
const initial = () => ({ revision: 0, scoreA: 0, scoreB: 0, period: 1, regulationPeriods: 2,
  periodLabel: '第 1 节', periods: [{ label: '第 1 节', scoreA: 0, scoreB: 0 }], canUndo: false, submitted: false });
const opened = live => ({ ok: true, actorId: 'scorer', matchId: 'm:1', teamAName: '甲队', teamBName: '乙队', live });
const scoreEvent = (side, points) => ({ currentTarget: { dataset: { side, points } } });
const { createBasketballLive, applyBasketballOperation, basketballLiveView } = require('../src/shared/utils/basketball-live');
const rosters = [{ side: 'A', players: [{ userId: 'p1', name: '小明', no: 7 }, { userId: 'p2', name: '小林', no: 8 }] },
  { side: 'B', players: [{ userId: 'p3', name: '小王', no: 0 }] }];

test('计分台首屏恢复并兼容编码编号；快速连点即时预览、逐笔串行保存', () => withWx(() => {
  let release;
  let current = initial();
  return withApi({
    startTeamLiveScore: payload => payload.matchId === 'm:1' ? opened(current) : { ok: false },
    updateTeamLiveScore: async payload => {
      if (payload.expectRevision === 0) await new Promise(resolve => { release = resolve; });
      assert.equal(payload.expectRevision, current.revision);
      current = { ...current, revision: current.revision + 1, scoreA: current.scoreA + payload.points, canUndo: true };
      return { ok: true, live: current };
    },
  }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm%3A1' });
    const first = page.onScore(scoreEvent('A', 2));
    page.onScore(scoreEvent('A', 3));
    assert.equal(page.data.live.scoreA, 5, '往返前即可看到两次点击');
    assert.equal(page.data.live.periods[0].scoreA, 5, '分节预览与总分同步');
    assert.equal(page.data.pendingCount, 2);
    release();
    await first;
    assert.equal(page.data.live.scoreA, 5);
    assert.equal(page.data.pendingCount, 0);
    const writes = calls.filter(([name]) => name === 'updateTeamLiveScore');
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0][1].operationId, writes[1][1].operationId);
    page.onUnload();
  });
}));

test('回执丢失：失败保留原操作编号与版本，重试不创建第二次加分', () => withWx(() => {
  let attempts = 0;
  return withApi({ startTeamLiveScore: () => opened(initial()), updateTeamLiveScore: () => {
    attempts += 1;
    if (attempts === 1) throw new Error('丢失回执');
    return { ok: true, live: { ...initial(), revision: 1, scoreA: 3 } };
  } }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    await page.onScore(scoreEvent('A', 3));
    assert.equal(page.data.failed, true);
    assert.equal(page.data.pendingCount, 1);
    await page.onRetry();
    const writes = calls.filter(([name]) => name === 'updateTeamLiveScore');
    assert.deepEqual(writes[0][1], writes[1][1]);
    assert.equal(page.data.live.scoreA, 3);
    assert.equal(page.data.failed, false);
    assert.equal(page.data.pendingCount, 0);
    page.onUnload();
  });
}));

test('退出重进恢复未同步操作：服务端已收到的点击不被重新加分', () => withWx(() => {
  const storage = new Map();
  wx.getStorageSync = key => storage.get(key);
  wx.setStorageSync = (key, value) => storage.set(key, JSON.parse(JSON.stringify(value)));
  let current = initial();
  let first = true;
  return withApi({ startTeamLiveScore: () => opened(current), updateTeamLiveScore: () => {
    if (first) {
      first = false;
      current = { ...initial(), scoreA: 2, revision: 1 };
      throw new Error('服务端保存后断网');
    }
    return { ok: true, live: current };
  } }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    await page.onScore(scoreEvent('A', 2));
    page.onUnload();
    const restored = instantiate(config);
    await restored.onLoad({ matchId: 'm:1' });
    assert.equal(restored.data.live.scoreA, 2);
    assert.equal(restored.data.pendingCount, 0);
    const writes = calls.filter(([name]) => name === 'updateTeamLiveScore');
    assert.equal(writes[0][1].operationId, writes[1][1].operationId);
    restored.onUnload();
  });
}));

test('未保存点击不允许结束或撤销；卸载后迟到回执不写界面', () => withWx(() => {
  let release;
  return withApi({ startTeamLiveScore: () => opened(initial()), updateTeamLiveScore: () =>
    new Promise(resolve => { release = resolve; }) }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    const writing = page.onScore(scoreEvent('A', 1));
    page.onFinish();
    page.onUndo();
    assert.equal(calls.filter(([name]) => name === 'updateTeamLiveScore').length, 1);
    page.onUnload();
    page.setData = () => assert.fail('卸载后不应更新页面');
    release({ ok: true, live: { ...initial(), scoreA: 1, revision: 1 } });
    await writing;
  });
}));

test('结束提交后保持只读、显示等审核；平分结束提示加时', () => withWx(async () => {
  await withApi({ startTeamLiveScore: () => opened({ ...initial(), period: 2, scoreA: 2, scoreB: 2 }) }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    page.onFinish();
    assert.match(page.data.notice, /加时/);
    assert.equal(calls.length, 1);
    page.onUnload();
  });
  await withApi({ startTeamLiveScore: () => opened({ ...initial(), submitted: true, scoreA: 8 }) }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    await page.onScore(scoreEvent('B', 2));
    assert.equal(page.data.submitted, true);
    assert.equal(calls.length, 1);
    page.onUnload();
  });
}));

test('赛事详情实时计分入口编码编号；轮询更新比分与节次、隐藏/卸载停止更新', () => withWx(async ({ navigations }) => {
  const page = instantiate(detail);
  page.scope = { schoolId: 'muc', association: 'bk' };
  page.data.rounds = [{ matches: [{ matchId: 'm:1', status: 'scheduled' }] }];
  page.onOpenLiveScore({ currentTarget: { dataset: { matchid: 'm:1' } } });
  assert.match(navigations[0], /team-live-score.*m%3A1/);
  await withApi({ getTeamLiveScores: () => ({ ok: true, scores: [{ matchId: 'm:1',
    status: 'live', statusLabel: '进行中', revision: 2, scoreText: '5 : 3',
    live: { periodLabel: '第 2 节' }, pointsA: 5, pointsB: 3 }] }) }, async () => {
    page.watchScores(page.data.rounds[0].matches);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.rounds[0].matches[0].scoreText, '5 : 3');
    assert.equal(page.data.rounds[0].matches[0].live.periodLabel, '第 2 节');
    page.onHide();
    page.onUnload();
  });
}));

test('提交结束请求期间锁住加分，不能在待审核之后再排入一球', () => withWx(() => {
  let release;
  return withApi({ startTeamLiveScore: () => opened({ ...initial(), period: 2, scoreA: 3 }),
    updateTeamLiveScore: () => new Promise(resolve => { release = resolve; }) }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    page.onFinish();
    assert.equal(page.data.controlsPending, true);
    page.onScore(scoreEvent('B', 2));
    assert.equal(page.pending.length, 1);
    assert.equal(calls.filter(([name]) => name === 'updateTeamLiveScore').length, 1);
    release({ ok: true, live: { ...initial(), revision: 1, period: 2, scoreA: 3, submitted: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.pendingCount, 0);
    assert.equal(page.data.submitted, true);
    page.onUnload();
  });
}));

const playerEvent = userId => ({ currentTarget: { dataset: { userid: userId } } });
const statEvent = (field, delta) => ({ currentTarget: { dataset: { field, delta } } });
const fullRosters = [{ side: 'A', players: Array.from({ length: 12 }, (_, i) => ({ userId: `a${i}`, name: `甲${i}`, no: i })) },
  { side: 'B', players: Array.from({ length: 5 }, (_, i) => ({ userId: `b${i}`, name: `乙${i}`, no: i })) }];
function courtState(list = rosters) {
  return { ...createBasketballLive({ periods: 2 }), onCourt: Object.fromEntries(list.map(side =>
    [side.side, side.players.slice(0, 5).map(player => player.userId)])) };
}

test('单次选人录入保存后回主台；只补个人分与统计保留差额，累计统计按需打开', () => withWx(() => {
  let state = courtState();
  return withApi({ startTeamLiveScore: () => ({ ...opened(basketballLiveView(state)), rosters }),
    updateTeamLiveScore: payload => { state = applyBasketballOperation(state, payload); return { ok: true, live: basketballLiveView(state) }; },
  }, async () => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    assert.deepEqual(page.data.playerTotals, []);
    page.onSelectPlayer(playerEvent('p1'));
    assert.equal(page.data.view, 'player');
    await page.onPlayerScore(scoreEvent('A', 2));
    assert.equal(page.data.view, 'main');
    assert.equal(page.data.selectedUserId, '');
    assert.equal(page.data.live.scoreA, 2);
    page.onSelectPlayer(playerEvent('p1'));
    page.onTogglePlayerOnly({ detail: { value: true } });
    await page.onPlayerScore(scoreEvent('A', 3));
    assert.equal(page.data.live.scoreA, 2);
    assert.match(page.data.teamDifferences[0].differenceText, /多 3 分/);
    for (const field of ['rebounds', 'fouls']) {
      page.onSelectPlayer(playerEvent('p1'));
      await page.onStat(statEvent(field, 1));
      assert.equal(page.data.view, 'main');
    }
    page.onSelectPlayer(playerEvent('p1'));
    await page.onStat(statEvent('rebounds', -1));
    page.onOpenStats();
    assert.equal(page.data.view, 'stats');
    assert.equal(page.data.playerTotals[0].cells.find(cell => cell.field === 'rebounds').text, '0');
    assert.equal(page.data.playerTotals[1].cells.find(cell => cell.field === 'rebounds').text, '—');
    page.onMain();
    assert.deepEqual(page.data.playerTotals, []);
    await page.onScore(scoreEvent('A', 3));
    assert.equal(page.data.live.scoreA, 5);
    assert.equal(page.data.live.playerRows[0].points, 5);
    page.onUnload();
  });
}));

test('单次录入防连点；失败不跳走，重试同一笔成功后自动返回', () => withWx(() => {
  let state = courtState();
  let release;
  let writes = 0;
  return withApi({ startTeamLiveScore: () => ({ ...opened(basketballLiveView(state)), rosters }),
    updateTeamLiveScore: async payload => {
      if (++writes === 1) { await new Promise(resolve => { release = resolve; }); throw new Error('断网'); }
      state = applyBasketballOperation(state, payload);
      return { ok: true, live: basketballLiveView(state) };
    },
  }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    page.onSelectPlayer(playerEvent('p1'));
    const writing = page.onPlayerScore(scoreEvent('A', 2));
    page.onSelectPlayer(playerEvent('p2'));
    page.onStat(statEvent('rebounds', 1));
    page.onCancelPlayer();
    page.onScore(scoreEvent('A', 3));
    assert.equal(page.data.selectedUserId, 'p1');
    assert.equal(page.data.view, 'player');
    assert.equal(page.pending.length, 1);
    release(); await writing;
    assert.equal(page.data.failed, true);
    assert.equal(page.data.view, 'player');
    await page.onRetry();
    assert.equal(page.data.view, 'main');
    assert.equal(state.playerRows[0].points, 2);
    assert.equal(state.playerRows.length, 1);
    const requests = calls.filter(([name]) => name === 'updateTeamLiveScore');
    assert.deepEqual(requests[0][1], requests[1][1]);
    page.onUnload();
  });
}));

test('球员面板可以不选任何统计取消；不请求计分、不改比分或统计，下次打开恢复默认模式', () => withWx(() => {
  const state = courtState();
  return withApi({ startTeamLiveScore: () => ({ ...opened(basketballLiveView(state)), rosters }) }, async calls => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    const before = JSON.parse(JSON.stringify(page.data.live));
    page.onSelectPlayer(playerEvent('p1'));
    page.onTogglePlayerOnly({ detail: { value: true } });
    page.onCancelPlayer();
    assert.equal(page.data.view, 'main');
    assert.equal(page.data.selectedUserId, '');
    assert.equal(page.data.onlyPlayerPoints, false);
    assert.equal(page.pending.length, 0);
    assert.deepEqual(page.data.live, before);
    assert.deepEqual(calls.map(([name]) => name), ['startTeamLiveScore']);
    page.onSelectPlayer(playerEvent('p2'));
    assert.equal(page.data.view, 'player');
    assert.equal(page.data.selectedUserId, 'p2');
    assert.equal(page.data.onlyPlayerPoints, false);
    page.onCancelPlayer();
    assert.deepEqual(page.data.live, before);
    page.onUnload();
  });
}));

test('主台仅场上五人可点；替补分页换入，保存后回主台；统计与分节均分页', () => withWx(() => {
  let state = courtState(fullRosters);
  state.periods = Array.from({ length: 8 }, () => ({ scoreA: 0, scoreB: 0 }));
  return withApi({ startTeamLiveScore: () => ({ ...opened(basketballLiveView(state)), rosters: fullRosters }),
    updateTeamLiveScore: payload => { state = applyBasketballOperation(state, payload); return { ok: true, live: basketballLiveView(state) }; },
  }, async () => {
    const page = instantiate(config);
    await page.onLoad({ matchId: 'm:1' });
    assert.equal(page.data.playerChoices.length, 5);
    page.onSelectPlayer(playerEvent('a5'));
    assert.equal(page.data.view, 'main');
    page.onOpenSubstitute();
    assert.equal(page.data.benchChoices.length, 5);
    page.onPage({ currentTarget: { dataset: { kind: 'bench', delta: 1 } } });
    assert.equal(page.data.benchChoices.length, 2);
    page.onChooseOut(playerEvent('a0'));
    page.onChooseIn(playerEvent('a11'));
    await page.onSubstitute();
    assert.equal(page.data.view, 'main');
    assert.equal(page.data.playerChoices.length, 5);
    assert.equal(page.data.playerChoices[0].userId, 'a11');
    page.onSelectPlayer(playerEvent('a0'));
    assert.equal(page.data.view, 'main');
    page.onSelectPlayer(playerEvent('a11'));
    await page.onStat(statEvent('fouls', 1));
    page.onOpenStats();
    assert.equal(page.data.playerTotals.length, 5);
    assert.equal(page.data.totalsPages, 3);
    page.onPage({ currentTarget: { dataset: { kind: 'totals', delta: 2 } } });
    assert.equal(page.data.playerTotals.length, 2);
    assert.equal(page.data.playerTotals[1].cells.find(cell => cell.field === 'fouls').text, '1');
    page.onPage({ currentTarget: { dataset: { kind: 'period', delta: 1 } } });
    assert.equal(page.data.shownPeriods.length, 3);
    page.onMain();
    page.onSelectSide({ currentTarget: { dataset: { side: 'B' } } });
    assert.equal(page.data.courtCount, 5);
    assert.equal(page.data.playerChoices[0].userId, 'b0');
    page.onUnload();
  });
}));
