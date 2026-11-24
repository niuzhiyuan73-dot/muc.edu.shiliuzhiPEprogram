/**
 * 网球实时计分状态机
 * ============================================================
 * 三层（分 → 局 → 盘）与两层（分 → 局）共用一套流水重算，但判据完全不同：
 *   一局：4 分且领先 2（无占先时 4:3 直接赢）
 *   一盘：6 局且领先 2；6:6 抢七，抢七先到 7 且领先 2
 * 这组用例把每条边界都钉住，包括「撤销一球能退回占先 / 退回 6:6」。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createLive,
  applyRally,
  undoRally,
  replayRallies,
  liveScoreOf,
  toOfficialScores,
  tennisPointText,
  LIVE_STATUS,
} = require('../src/shared/services/live-score.js');
const { describeLive } = require('../miniprogram/services/live-view.js');

const MATCH = {
  _id: 'm_tn_1',
  matchType: 1,
  teamA: ['u1'],
  teamB: ['u2'],
  scoring: 'tennis',
  bestOf: 1,
  setGames: 6,
  tiebreakAt: 6,
  tiebreakPoints: 7,
  noAd: false,
  competition: 'personal',
  matchTime: '2026-10-19T10:00:00Z',
};

/** 连判 n 球给某一方 */
function feed(state, side, n) {
  let next = state;
  for (let i = 0; i < n; i += 1) next = applyRally(next, side, {});
  return next;
}

/** A 赢一局、B 一局，交替推进到指定局分（每局 4:0） */
function playGames(state, gamesA, gamesB) {
  let next = state;
  for (let i = 0; i < Math.max(gamesA, gamesB); i += 1) {
    if (i < gamesA) next = feed(next, 'A', 4);
    if (i < gamesB) next = feed(next, 'B', 4);
  }
  return next;
}

test('网球 —— 4 球赢一局，分数清零、局数 +1', () => {
  const state = createLive(MATCH);
  assert.strictEqual(state.scoring, 'tennis');
  assert.strictEqual(state.status, LIVE_STATUS.LIVE);

  const after = feed(state, 'A', 4);
  assert.strictEqual(after.gamesA, 1);
  assert.strictEqual(after.gamesB, 0);
  assert.strictEqual(after.pointsA, 0);
  assert.strictEqual(after.pointsB, 0);
});

test('网球 —— 占先：40:40 后要连得 2 分，来回拉锯也能记', () => {
  let state = createLive(MATCH);
  state = feed(state, 'A', 3);
  state = feed(state, 'B', 3);
  assert.strictEqual(liveScoreOf(state).pointTextA, '40');
  assert.strictEqual(liveScoreOf(state).pointTextB, '40');

  state = feed(state, 'A', 1);
  assert.strictEqual(liveScoreOf(state).pointTextA, 'AD');
  assert.strictEqual(liveScoreOf(state).pointTextB, '40');
  assert.strictEqual(state.gamesA, 0, '占先还不是一局');

  state = feed(state, 'B', 1);
  assert.strictEqual(liveScoreOf(state).pointTextA, '40', '被追平回到 40:40');
  assert.strictEqual(state.gamesA, 0);

  state = feed(state, 'A', 2);
  assert.strictEqual(state.gamesA, 1, '连得两分才拿下这一局');
});

test('网球 —— 无占先：40:40 后下一分直接赢局', () => {
  let state = createLive({ ...MATCH, noAd: true });
  state = feed(state, 'A', 3);
  state = feed(state, 'B', 3);
  state = feed(state, 'A', 1);
  assert.strictEqual(state.gamesA, 1);
  assert.strictEqual(state.pointsA, 0);
});

test('网球 —— 6 局赢一盘（一盘决胜），整场随即结束', () => {
  let state = playGames(createLive(MATCH), 6, 4);
  assert.strictEqual(state.gamesA, 6);
  assert.strictEqual(state.gamesB, 4);
  assert.strictEqual(state.setsA, 1);
  assert.strictEqual(state.status, LIVE_STATUS.FINISHED);
});

test('网球 —— 5:5 之后 7:5 才结束一盘', () => {
  let state = playGames(createLive(MATCH), 5, 5);
  assert.strictEqual(state.status, LIVE_STATUS.LIVE, '5:5 还没结束');
  state = feed(state, 'A', 4);
  assert.strictEqual(state.gamesA, 6);
  assert.strictEqual(state.status, LIVE_STATUS.LIVE, '6:5 领先不足 2 局');
  state = feed(state, 'A', 4);
  assert.strictEqual(state.gamesA, 7);
  assert.strictEqual(state.setsA, 1);
  assert.strictEqual(state.status, LIVE_STATUS.FINISHED);
});

test('网球 —— 6:6 进抢七，抢七 7:5 拿下该盘记 7:6', () => {
  let state = playGames(createLive(MATCH), 6, 6);
  assert.strictEqual(state.inTiebreak, true, '6:6 应当进抢七');
  assert.strictEqual(liveScoreOf(state).pointTextA, '0');

  state = feed(state, 'B', 5);
  state = feed(state, 'A', 6);
  assert.strictEqual(state.inTiebreak, true, '抢七 6:5 还没结束');
  assert.strictEqual(state.status, LIVE_STATUS.LIVE);

  state = feed(state, 'A', 1);
  assert.strictEqual(state.inTiebreak, false);
  assert.strictEqual(state.gamesA, 7);
  assert.strictEqual(state.gamesB, 6);
  assert.strictEqual(state.setsA, 1);
  assert.strictEqual(state.status, LIVE_STATUS.FINISHED);

  const scores = toOfficialScores(state);
  assert.deepStrictEqual(scores.scoreA, [7]);
  assert.deepStrictEqual(scores.scoreB, [6]);
  assert.deepStrictEqual(scores.tiebreaks, [{ setIndex: 0, a: 7, b: 5 }]);
});

test('网球 —— 三盘两胜：拿下两盘才结束，1:1 还要打第三盘', () => {
  let state = playGames(createLive({ ...MATCH, bestOf: 3 }), 6, 4);
  assert.strictEqual(state.status, LIVE_STATUS.LIVE, '1:0 还没打完');
  assert.strictEqual(state.setIndex, 1);

  // 第二盘让 B 拿下
  state = playGames(state, 0, 6);
  assert.strictEqual(state.setsA, 1);
  assert.strictEqual(state.setsB, 1);
  assert.strictEqual(state.status, LIVE_STATUS.LIVE);

  state = playGames(state, 6, 2);
  assert.strictEqual(state.setsA, 2);
  assert.strictEqual(state.status, LIVE_STATUS.FINISHED);

  const scores = toOfficialScores(state);
  assert.deepStrictEqual(scores.scoreA, [6, 0, 6]);
  assert.deepStrictEqual(scores.scoreB, [4, 6, 2]);
});

test('网球 —— 撤销一球能退回 40:40、退回 6:6、退回赛点前', () => {
  // 退回 40:40
  let state = createLive(MATCH);
  state = feed(state, 'A', 4);
  assert.strictEqual(state.gamesA, 1);
  state = undoRally(state);
  assert.strictEqual(state.gamesA, 0, '撤销制胜分，局数退回去');
  assert.strictEqual(state.pointsA, 3);
  assert.strictEqual(liveScoreOf(state).pointTextA, '40');

  // 退回 6:6（撤销抢七最后一分）
  let tie = playGames(createLive(MATCH), 6, 6);
  tie = feed(tie, 'A', 7);
  assert.strictEqual(tie.setsA, 1);
  tie = undoRally(tie);
  assert.strictEqual(tie.setsA, 0, '撤销抢七制胜分，盘数退回去');
  assert.strictEqual(tie.inTiebreak, true);
  assert.strictEqual(tie.pointsA, 6);
});

test('网球 —— 抢七后多判的球不再计入（脏数据 / 连点）', () => {
  let state = playGames(createLive(MATCH), 6, 6);
  state = feed(state, 'A', 7);
  const after = feed(state, 'B', 5);
  assert.strictEqual(after.setsA, 1);
  assert.strictEqual(after.setsB, 0);
  assert.strictEqual(after.gamesB, 6, '整场结束后不再加分');
});

test('网球 —— 短盘 4 局：4:4 抢七', () => {
  const short = { ...MATCH, setGames: 4, tiebreakAt: 4 };
  let state = playGames(createLive(short), 4, 4);
  assert.strictEqual(state.inTiebreak, true, '4:4 应当进抢七');
  state = feed(state, 'A', 7);
  assert.deepStrictEqual(toOfficialScores(state).scoreA, [5]);
  assert.deepStrictEqual(toOfficialScores(state).scoreB, [4]);
});

test('网球 —— 展示层：盘分 / 本盘局分 / 本局分三层都在', () => {
  let state = playGames(createLive({ ...MATCH, bestOf: 3 }), 6, 4);
  // 第二盘：A 先拿一局，再打成 15:30
  state = feed(state, 'A', 4);
  state = feed(state, 'A', 1);
  state = feed(state, 'B', 2);

  const view = describeLive(liveScoreOf(state));
  assert.strictEqual(view.scoring, 'tennis');
  assert.strictEqual(view.setsText, '1 : 0');
  assert.strictEqual(view.gamesText, '1 : 0', '本盘局分');
  assert.strictEqual(view.scoreText, '15 : 30');
  assert.strictEqual(view.pointsTextA, '15');
  assert.strictEqual(view.pointsTextB, '30');
  assert.strictEqual(view.gameIndexText, '第 2 盘');
  assert.strictEqual(view.tiebreakText, '');
});

test('网球 —— 展示层：抢七时标出「抢七」，大数字是抢七分', () => {
  let state = playGames(createLive(MATCH), 6, 6);
  state = feed(state, 'A', 3);
  state = feed(state, 'B', 3);

  const view = describeLive(liveScoreOf(state));
  assert.strictEqual(view.tiebreakText, '抢七');
  assert.strictEqual(view.pointsTextA, '3', '抢七不做 15/30/40 换算');
  assert.strictEqual(view.gamesText, '6 : 6');
});

test('tennisPointText —— 0/15/30/40/AD 与抢七的原样数字', () => {
  assert.strictEqual(tennisPointText(0, 0), '0');
  assert.strictEqual(tennisPointText(1, 0), '15');
  assert.strictEqual(tennisPointText(2, 2), '30');
  assert.strictEqual(tennisPointText(3, 1), '40');
  assert.strictEqual(tennisPointText(3, 3), '40');
  assert.strictEqual(tennisPointText(4, 3), 'AD');
  assert.strictEqual(tennisPointText(3, 4), '40', '对手占先时自己仍显示 40');
  assert.strictEqual(tennisPointText(4, 3, { noAd: true }), '40');
  assert.strictEqual(tennisPointText(5, 3, { tiebreak: true }), '5');
});

test('网球 —— 旧的 point 赛制一点没变（回归）', () => {
  const legacy = { _id: 'm1', matchType: 1, teamA: ['u1'], teamB: ['u2'], gamePoints: 11, bestOf: 3 };
  const state = createLive(legacy);
  assert.strictEqual(state.scoring, undefined, '老赛制不写 scoring 字段');
  const after = feed(state, 'A', 11);
  assert.strictEqual(after.gamesA, 1);
  assert.strictEqual(after.pointsA, 0);
  assert.strictEqual(replayRallies(after.rallies, after).games.length, 1);
});
