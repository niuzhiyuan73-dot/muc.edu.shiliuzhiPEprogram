/**
 * 判球流水折叠（2026-10-23 第三轮 X-13）
 * ============================================================
 * `rallies` 只增不减：一场长盘 200~400 球，而每次判球都要整文档重写 + 整段重放，
 * 成本随球数线性增长，越到决胜局越卡。现在只保留最近 RALLY_KEEP 球作为撤销窗口，
 * 更早的按「局边界」折叠进 `folded`（base 续算点 + 已结算局 / 盘 / 抢七摘要）。
 *
 * 这组用例守的是**折叠不能改变任何比分**：
 *   1. 折叠后的派生字段与「全量流水从头重算」逐字相同；
 *   2. 正式比分（含网球盘分与抢七）不许少报已折叠的局；
 *   3. 撤销仍然正确，且撤到窗口底部就停（口径变更：折不到开场）；
 *   4. 折叠只发生在局边界——base 与摘要的局数必须自洽。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIVE_STATUS, RALLY_FOLD_AT, createLive, applyRally, undoRally, hasRally,
  replayRallies, toOfficialScores, foldedCount,
} = require('../src/shared/services/live-score.js');

const NOW = new Date('2026-10-23T10:00:00Z');
// bestOf 只有 1 / 3 / 5 三种（match-format 的 BEST_OF_OPTIONS），5 局制需要 3 局到手
const POINT_MATCH = { _id: 'm_point', teamA: ['a'], teamB: ['b'], gamePoints: 11, bestOf: 5 };
const TENNIS_MATCH = {
  _id: 'm_tennis', teamA: ['a'], teamB: ['b'],
  scoring: 'tennis', bestOf: 3, setGames: 6, tiebreakAt: 6, tiebreakPoints: 7,
};

/** 一局 11:5：先交替到 5:5，再连拿 6 分（共 16 球） */
function pointGame(winner = 'A') {
  const loser = winner === 'A' ? 'B' : 'A';
  const out = [];
  for (let i = 0; i < 5; i += 1) out.push(winner, loser);
  for (let i = 0; i < 6; i += 1) out.push(winner);
  return out;
}

/** 一局 4:0（网球，共 4 球） */
function tennisGame(winner = 'A') {
  return [winner, winner, winner, winner];
}

/** 4 局 2:2 的进行中局面（64 球，已跨过折叠阈值） */
const LIVE_SIDES = [
  ...pointGame('A'), ...pointGame('B'), ...pointGame('A'), ...pointGame('B'),
];
/** 再接一局给 A：3:2，整场结束（80 球） */
const DONE_SIDES = [...LIVE_SIDES, ...pointGame('A')];

/** 逐球判下去（每球带唯一编号），返回最终实时态 */
function play(match, sides) {
  let state = createLive(match, { actorId: 'u1', now: NOW });
  const ids = [];
  sides.forEach((side, index) => {
    const id = `r${index + 1}`;
    ids.push(id);
    state = applyRally(state, side, { rallyId: id });
  });
  return { state, ids };
}

/** 参照组：同一串球，从开场一次性全量重算 */
function replayAll(match, sides) {
  return replayRallies(sides.map((side) => ({ side })), createLive(match, { now: NOW }));
}

/** 断言派生字段与全量重算一致 */
function assertSameProgress(state, ref, label) {
  for (const field of ['pointsA', 'pointsB', 'gamesA', 'gamesB', 'gameIndex']) {
    assert.equal(state[field], ref[field], `${label}：${field} 与全量重算不一致`);
  }
  if (ref.sets) {
    assert.equal(state.setsA, ref.setsA, `${label}：setsA 不一致`);
    assert.equal(state.setsB, ref.setsB, `${label}：setsB 不一致`);
    assert.equal(state.setIndex, ref.setIndex, `${label}：setIndex 不一致`);
    assert.equal(state.inTiebreak, ref.inTiebreak, `${label}：inTiebreak 不一致`);
  }
}

test('长盘判球：窗口有界，且比分与全量重算逐字相同', () => {
  assert.equal(LIVE_SIDES.length, 64, '夹具应当是 4 局 × 16 球');

  const { state } = play(POINT_MATCH, LIVE_SIDES);
  const ref = replayAll(POINT_MATCH, LIVE_SIDES);

  assert.ok(foldedCount(state) > 0, '64 球应当触发折叠');
  assert.ok(state.rallies.length <= RALLY_FOLD_AT,
    `窗口 ${state.rallies.length} 球，应当折到 ${RALLY_FOLD_AT} 以内`);
  assertSameProgress(state, ref, 'point 长盘');
  assert.equal(state.status, LIVE_STATUS.LIVE);
});

test('折叠之后正式比分仍包含已归档的局（不许少报）', () => {
  const { state } = play(POINT_MATCH, LIVE_SIDES);
  const ref = replayAll(POINT_MATCH, LIVE_SIDES);

  const official = toOfficialScores(state);
  assert.deepEqual(official.scoreA, ref.games.map((game) => game.a));
  assert.deepEqual(official.scoreB, ref.games.map((game) => game.b));
  assert.equal(official.scoreA.length, 4, '四局一局都不能少');
});

test('打到整场结束：状态与正式比分同样不受折叠影响', () => {
  const { state } = play(POINT_MATCH, DONE_SIDES);
  const ref = replayAll(POINT_MATCH, DONE_SIDES);

  assert.equal(state.status, LIVE_STATUS.FINISHED, '三局到手应当整场结束');
  assert.ok(ref.finished);
  assertSameProgress(state, ref, '整场结束');
  assert.deepEqual(toOfficialScores(state).scoreA, [11, 5, 11, 5, 11]);
  assert.deepEqual(toOfficialScores(state).scoreB, [5, 11, 5, 11, 5]);
});

test('网球：盘分与抢七摘要不因折叠丢失', () => {
  // 第一盘 6:0（6 局 × 4 球），第二盘再打 3 局，共 9 局 = 36 球；再加两局越过阈值
  const sides = [
    ...tennisGame('A'), ...tennisGame('A'), ...tennisGame('A'),
    ...tennisGame('A'), ...tennisGame('A'), ...tennisGame('A'),
    ...tennisGame('A'), ...tennisGame('A'), ...tennisGame('A'),
    ...tennisGame('A'), ...tennisGame('A'),
  ];
  assert.equal(sides.length, 44);

  const { state } = play(TENNIS_MATCH, sides);
  const ref = replayAll(TENNIS_MATCH, sides);

  assert.ok(foldedCount(state) > 0, '44 球应当触发折叠');
  assertSameProgress(state, ref, '网球折叠');
  assert.deepEqual(toOfficialScores(state), {
    scoreA: ref.sets.map((set) => set.a),
    scoreB: ref.sets.map((set) => set.b),
    tiebreaks: ref.tiebreaks.map((item) => ({ ...item })),
  });
  assert.deepEqual(toOfficialScores(state).scoreA, [6], '第一盘 6:0 必须留在正式比分里');
});

test('折叠只发生在局边界：base 的局数与摘要条数自洽', () => {
  const { state } = play(POINT_MATCH, LIVE_SIDES);

  assert.ok(state.folded && state.folded.base, '折叠后必须有续算点');
  assert.equal(state.folded.games.length, state.folded.base.gamesA + state.folded.base.gamesB,
    '摘要里的局数必须等于 base 记的局数——否则就是切在了半局中间');
  assert.ok(state.folded.base.gamesA + state.folded.base.gamesB >= 1, '应当至少折掉一局');
});

test('撤销：折叠后仍然算得对，撤到窗口底部就停（折不到开场）', () => {
  const { state } = play(POINT_MATCH, LIVE_SIDES);

  const undone = undoRally(state);
  const ref = replayAll(POINT_MATCH, LIVE_SIDES.slice(0, -1));
  assertSameProgress(undone, ref, '撤一球');
  assert.deepEqual(toOfficialScores(undone).scoreA, ref.games.map((game) => game.a));

  // 一路撤到窗口空：必须停下，且分数退回折叠水位（不是 0:0）
  let cursor = state;
  for (let guard = 0; cursor.rallies.length > 0 && guard < 200; guard += 1) {
    cursor = undoRally(cursor);
  }
  assert.equal(cursor.rallies.length, 0);
  assert.equal(foldedCount(cursor) > 0, true);
  assert.ok(cursor.gamesA + cursor.gamesB > 0, '撤到窗口底应停在折叠水位，而不是回到开场');

  const again = undoRally(cursor);
  assert.equal(again, cursor, '窗口为空时原样返回，由服务层给「已归档」文案');
});

test('幂等窗口就是撤销窗口：折叠掉的编号不再命中', () => {
  const { state, ids } = play(POINT_MATCH, LIVE_SIDES);

  assert.equal(hasRally(state, ids[ids.length - 1]), true, '最近一球必须能判重');
  assert.equal(hasRally(state, ids[0]), false,
    '已折叠的球不在窗口里——重发要跨 20+ 球才会发生，客户端失败即整屏刷新，不会重发');
});
