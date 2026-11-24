const test = require('node:test');
const assert = require('node:assert');

const {
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  BEST_OF_LABEL,
  DEFAULT_FORMAT,
  gamesToWin,
  isValidFormat,
  createMatchFormat,
  formatMatchFormat,
  validateGame,
  validateMatchScore,
} = require('../src/shared/utils/match-format.js');

/* ============================================================
 * 一、赛制本身
 * ============================================================ */

test('gamesToWin —— 单数局制取一半向上取整', () => {
  assert.strictEqual(gamesToWin(1), 1, '一局定胜负，赢 1 局即可');
  assert.strictEqual(gamesToWin(3), 2, '三局两胜');
  assert.strictEqual(gamesToWin(5), 3, '五局三胜');
});

test('可选的分数与局数正好是需求里列的那些', () => {
  assert.deepStrictEqual(GAME_POINTS_OPTIONS, [11, 15, 21]);
  assert.deepStrictEqual(BEST_OF_OPTIONS, [1, 3, 5]);
});

test('isValidFormat —— 只认 11/15/21 分制与 1/3/5 局制', () => {
  assert.ok(isValidFormat({ gamePoints: 11, bestOf: 1 }));
  assert.ok(isValidFormat({ gamePoints: 15, bestOf: 3 }));
  assert.ok(isValidFormat({ gamePoints: 21, bestOf: 5 }));

  // 9 分局、4 局制这些不在需求范围内
  assert.strictEqual(isValidFormat({ gamePoints: 9, bestOf: 3 }), false);
  assert.strictEqual(isValidFormat({ gamePoints: 11, bestOf: 2 }), false);
  assert.strictEqual(isValidFormat({ gamePoints: 11, bestOf: 4 }), false);
  assert.strictEqual(isValidFormat(null), false);
  assert.strictEqual(isValidFormat({}), false);
});

test('createMatchFormat —— 补上 gamesToWin，非法赛制直接抛错', () => {
  const format = createMatchFormat(21, 5);
  assert.deepStrictEqual(format, { gamePoints: 21, bestOf: 5, gamesToWin: 3 });

  // 默认值应当是最常用的 11 分制三局两胜
  assert.strictEqual(createMatchFormat().gamePoints, DEFAULT_FORMAT.gamePoints);
  assert.strictEqual(createMatchFormat().bestOf, DEFAULT_FORMAT.bestOf);

  assert.throws(() => createMatchFormat(11, 4), /不支持的赛制/);
});

test('formatMatchFormat —— 拼出给人看的赛制文案', () => {
  assert.strictEqual(formatMatchFormat({ gamePoints: 11, bestOf: 3 }), '11 分制 · 三局两胜');
  assert.strictEqual(formatMatchFormat({ gamePoints: 21, bestOf: 1 }), '21 分制 · 一局一胜');
  assert.strictEqual(formatMatchFormat({ gamePoints: 15, bestOf: 5 }), '15 分制 · 五局三胜');
  assert.strictEqual(formatMatchFormat({ gamePoints: 9, bestOf: 3 }), '');
});

test('BEST_OF_LABEL —— 三种局制都有中文说法', () => {
  assert.strictEqual(BEST_OF_LABEL[1], '一局一胜');
  assert.strictEqual(BEST_OF_LABEL[3], '三局两胜');
  assert.strictEqual(BEST_OF_LABEL[5], '五局三胜');
});

/* ============================================================
 * 二、单局校验
 * ============================================================ */

test('单局 —— 够分且领先 2 分才算赢', () => {
  assert.deepStrictEqual(validateGame(11, 9, 11, 0), []);
  assert.deepStrictEqual(validateGame(11, 0, 11, 0), [], '零封也合法');
  assert.deepStrictEqual(validateGame(9, 11, 11, 0), [], '反过来写同样合法');
});

test('单局 —— 只领先 1 分不算打完', () => {
  // 这正是「不封顶」的含义：11:10 之后还要再打
  assert.deepStrictEqual(validateGame(11, 10, 11, 0), ['第 1 局胜方必须领先 2 分（11:10）']);
  assert.deepStrictEqual(validateGame(10, 11, 11, 0), ['第 1 局胜方必须领先 2 分（10:11）']);
});

test('单局 —— 没到目标分不算打完', () => {
  assert.deepStrictEqual(validateGame(10, 8, 11, 0), ['第 1 局没有人打到 11 分（10:8）']);
  assert.deepStrictEqual(validateGame(0, 5, 11, 0), ['第 1 局没有人打到 11 分（0:5）']);
});

test('单局 —— deuce 之后可以一路打上去', () => {
  // 不封顶，所以这些都必须判为合法
  assert.deepStrictEqual(validateGame(12, 10, 11, 0), []);
  assert.deepStrictEqual(validateGame(13, 11, 11, 0), []);
  assert.deepStrictEqual(validateGame(17, 15, 11, 0), []);
  assert.deepStrictEqual(validateGame(23, 21, 21, 0), []);
});

test('单局 —— 打平不合法', () => {
  assert.deepStrictEqual(validateGame(11, 11, 11, 0), ['第 1 局必须分出胜负，不能打平（11:11）']);
});

test('单局 —— 负数与非整数不合法', () => {
  assert.deepStrictEqual(validateGame(-1, 11, 11, 0), ['第 1 局的比分不能是负数']);
  assert.deepStrictEqual(validateGame(11.5, 9, 11, 0), ['第 1 局的比分必须是整数']);
  assert.deepStrictEqual(validateGame('11', 9, 11, 0), ['第 1 局的比分必须是整数']);
});

test('单局 —— 15 分制按 15 分判定', () => {
  assert.deepStrictEqual(validateGame(15, 13, 15, 0), []);
  assert.deepStrictEqual(validateGame(15, 14, 15, 0), ['第 1 局胜方必须领先 2 分（15:14）']);
  assert.deepStrictEqual(validateGame(14, 12, 15, 0), ['第 1 局没有人打到 15 分（14:12）']);
});

test('单局 —— 错误提示里的局号从 1 开始', () => {
  assert.deepStrictEqual(validateGame(11, 10, 11, 2), ['第 3 局胜方必须领先 2 分（11:10）']);
});

/* ============================================================
 * 三、整场校验
 * ============================================================ */

const F11_3 = { gamePoints: 11, bestOf: 3 };
const F11_1 = { gamePoints: 11, bestOf: 1 };
const F11_5 = { gamePoints: 11, bestOf: 5 };

test('整场 —— 三局两胜：2:0 与 2:1 都合法', () => {
  const straight = validateMatchScore([11, 11], [9, 7], F11_3);
  assert.strictEqual(straight.valid, true);
  assert.deepStrictEqual(straight.errors, []);
  assert.strictEqual(straight.winner, 'A');
  assert.strictEqual(straight.gamesA, 2);
  assert.strictEqual(straight.gamesB, 0);

  const three = validateMatchScore([11, 9, 11], [9, 11, 9], F11_3);
  assert.strictEqual(three.valid, true);
  assert.strictEqual(three.winner, 'A');
  assert.strictEqual(three.gamesA, 2);
  assert.strictEqual(three.gamesB, 1);
});

test('整场 —— B 队获胜时胜方是 B', () => {
  const result = validateMatchScore([9, 7], [11, 11], F11_3);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.winner, 'B');
});

test('整场 —— 没打够局数不能算结束', () => {
  // 1:1 只是打平，三局两胜还没完
  const result = validateMatchScore([11, 9], [9, 11], F11_3);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['三局两胜需要有一方赢下 2 局才能结束，当前 1 : 1']);
});

test('整场 —— 分出胜负后多录的局要报错', () => {
  // 前两局 A 已经 2:0 拿下，第三局根本不该存在
  const result = validateMatchScore([11, 11, 11], [9, 9, 9], F11_3);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, [
    '三局两胜需要有一方赢下 2 局才能结束，当前 3 : 0',
  ]);
});

test('整场 —— 五局三胜：3:2 合法，打满 5 局', () => {
  const result = validateMatchScore([11, 9, 11, 9, 11], [9, 11, 9, 11, 9], F11_5);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.gamesA, 3);
  assert.strictEqual(result.gamesB, 2);
  assert.strictEqual(result.winner, 'A');
});

test('整场 —— 五局三胜：2:2 还没打完', () => {
  const result = validateMatchScore([11, 9, 11, 9], [9, 11, 9, 11], F11_5);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['五局三胜需要有一方赢下 3 局才能结束，当前 2 : 2']);
});

test('整场 —— 一局一胜只能有 1 局', () => {
  const one = validateMatchScore([11], [9], F11_1);
  assert.strictEqual(one.valid, true);
  assert.strictEqual(one.winner, 'A');

  const two = validateMatchScore([11, 11], [9, 9], F11_1);
  assert.strictEqual(two.valid, false);
  assert.ok(two.errors.some((e) => e.includes('最多打 1 局')));
});

test('整场 —— 超过局制上限要报错', () => {
  const result = validateMatchScore([11, 9, 11, 9], [9, 11, 9, 11], F11_3);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('最多打 3 局')));
});

test('整场 —— 局内比分有问题会逐条列出', () => {
  const result = validateMatchScore([11, 11], [10, 8], F11_3);
  assert.strictEqual(result.valid, false);
  // 只有第 1 局不合法；第 2 局的 11:8 是正常比分，不该被牵连
  assert.deepStrictEqual(result.errors, ['第 1 局胜方必须领先 2 分（11:10）']);
});

test('整场 —— 两队局数不一致要拦下来', () => {
  const result = validateMatchScore([11, 11, 11], [9, 9], F11_3);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['两队局数不一致（3 局对 2 局）']);
});

test('整场 —— 空比分与非数组都要拦下来', () => {
  assert.deepStrictEqual(validateMatchScore([], [], F11_3).errors, ['至少要录入 1 局比分']);
  assert.deepStrictEqual(validateMatchScore(null, [9], F11_3).errors, ['比分必须是数组']);
  assert.deepStrictEqual(validateMatchScore([11], undefined, F11_3).errors, ['比分必须是数组']);
});

test('整场 —— 赛制非法时不做猜测', () => {
  const result = validateMatchScore([11], [9], { gamePoints: 9, bestOf: 3 });
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['赛制不合法，无法校验比分']);
  assert.strictEqual(result.winner, null);
});

test('整场 —— 真实的 deuce 比分应当被接受', () => {
  // 21 分制打满三局且每局都拖到 deuce。注意不能让同一队连赢前两局，
  // 否则比赛在第二局就结束了，第三局反而成了「多录的」
  const result = validateMatchScore([23, 19, 21], [21, 21, 19], { gamePoints: 21, bestOf: 3 });
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.strictEqual(result.winner, 'A');
  assert.strictEqual(result.gamesA, 2);
  assert.strictEqual(result.gamesB, 1);
});

test('整场 —— 同一队连赢前两局后，第三局是多录的', () => {
  // 这正是上面那条注释所描述的情形，必须判为非法
  const result = validateMatchScore([23, 21, 19], [21, 19, 21], { gamePoints: 21, bestOf: 3 });
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['比赛在第 2 局就已分出胜负，多录了 1 局']);
});

/* ============================================================
 * 四、网球（三层计分：分 → 局 → 盘）
 * ============================================================ */

const {
  SCORING,
  TENNIS_SET_GAMES_OPTIONS,
  TENNIS_BEST_OF_OPTIONS,
  DEFAULT_TENNIS_FORMAT,
  scoringOf,
  normalizeTennisFormat,
  createTennisFormat,
  validateTennisSet,
  tennisGameWon,
  tennisSetWon,
} = require('../src/shared/utils/match-format.js');

const T6_3 = { scoring: 'tennis', bestOf: 3, setGames: 6, tiebreakAt: 6, tiebreakPoints: 7, noAd: false };
const T6_1 = { ...T6_3, bestOf: 1 };
const T4_1 = { ...T6_1, setGames: 4, tiebreakAt: 4 };

test('网球 —— 缺省 scoring 一律当 point，历史记录不受影响', () => {
  assert.strictEqual(scoringOf({ gamePoints: 11, bestOf: 3 }), SCORING.POINT);
  assert.strictEqual(scoringOf(null), SCORING.POINT);
  assert.strictEqual(scoringOf(T6_1), SCORING.TENNIS);
});

test('网球 —— 只认 6/4 局盘与 1/3 盘制，抢七点必须是 7', () => {
  assert.deepStrictEqual(TENNIS_SET_GAMES_OPTIONS, [6, 4]);
  assert.deepStrictEqual(TENNIS_BEST_OF_OPTIONS, [1, 3]);

  assert.ok(isValidFormat(T6_1));
  assert.ok(isValidFormat(T4_1));
  // 5 局盘、5 盘制、抢十都不在校内口径内，宁可拒绝也不悄悄接受
  assert.strictEqual(isValidFormat({ ...T6_1, setGames: 5, tiebreakAt: 5 }), false);
  assert.strictEqual(isValidFormat({ ...T6_1, bestOf: 5 }), false);
  assert.strictEqual(isValidFormat({ ...T6_1, tiebreakPoints: 10 }), false);
  assert.strictEqual(isValidFormat({ ...T6_1, tiebreakAt: 4 }), false);
  assert.strictEqual(isValidFormat({ scoring: 'tennis' }), false);
});

test('网球 —— createTennisFormat 补默认值并做校验', () => {
  const format = createTennisFormat({});
  assert.deepStrictEqual(format, {
    scoring: 'tennis',
    bestOf: DEFAULT_TENNIS_FORMAT.bestOf,
    setGames: 6,
    tiebreakAt: 6,
    tiebreakPoints: 7,
    noAd: false,
  });
  assert.strictEqual(createTennisFormat({ bestOf: 3, setGames: 4 }).setGames, 4);
  assert.strictEqual(createTennisFormat({ noAd: true }).noAd, true);
  assert.throws(() => createTennisFormat({ setGames: 8 }), /不支持的网球赛制/);
});

test('网球 —— 标准盘只认 6:0–6:4、7:5、7:6', () => {
  for (const [a, b] of [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 5], [7, 6], [0, 6], [6, 7]]) {
    assert.deepStrictEqual(validateTennisSet(a, b, T6_1, 0), [], `${a}:${b} 应当合法`);
  }
  // 6:5 是没打完，不是合法盘比分；7:4 不存在（6:4 时就结束了）；8:6 属于不抢七的 Advantage Set
  for (const [a, b] of [[6, 5], [6, 6], [7, 4], [8, 6], [5, 3]]) {
    assert.ok(validateTennisSet(a, b, T6_1, 0).length > 0, `${a}:${b} 应当被拦下`);
  }
});

test('网球 —— 短盘同构：4 局定盘', () => {
  for (const [a, b] of [[4, 0], [4, 1], [4, 2], [5, 3], [5, 4]]) {
    assert.deepStrictEqual(validateTennisSet(a, b, T4_1, 0), [], `${a}:${b} 短盘合法`);
  }
  for (const [a, b] of [[4, 3], [5, 2], [6, 4]]) {
    assert.ok(validateTennisSet(a, b, T4_1, 0).length > 0, `${a}:${b} 短盘应当被拦下`);
  }
});

test('网球 —— 盘比分的错误提示说清合法区间', () => {
  const errors = validateTennisSet(6, 5, T6_1, 1);
  assert.match(errors[0], /第 2 盘盘比分不合法/);
  assert.match(errors[0], /6:0–6:4/);
});

test('网球 —— 一局内：4 分且领先 2，无占先时 4:3 直接赢', () => {
  assert.strictEqual(tennisGameWon(4, 2, false), true);
  assert.strictEqual(tennisGameWon(4, 3, false), false, '有占先时 4:3 只是占先');
  assert.strictEqual(tennisGameWon(5, 3, false), true);
  assert.strictEqual(tennisGameWon(4, 3, true), true, '无占先 40:40 后一分定胜负');
  assert.strictEqual(tennisGameWon(3, 3, true), false);
});

test('网球 —— 一盘结束的判据', () => {
  assert.strictEqual(tennisSetWon(6, 4, 6), true);
  assert.strictEqual(tennisSetWon(6, 5, 6), false);
  assert.strictEqual(tennisSetWon(7, 5, 6), true);
  assert.strictEqual(tennisSetWon(7, 6, 6), true);
});

test('网球 —— 整场：三盘两胜 2:0 与 2:1 都合法', () => {
  const straight = validateMatchScore([6, 6], [4, 3], T6_3);
  assert.strictEqual(straight.valid, true, JSON.stringify(straight.errors));
  assert.strictEqual(straight.winner, 'A');
  assert.strictEqual(straight.gamesA, 2);
  assert.strictEqual(straight.gamesB, 0);

  const three = validateMatchScore([6, 4, 7], [4, 6, 6], T6_3);
  assert.strictEqual(three.valid, true, JSON.stringify(three.errors));
  assert.strictEqual(three.winner, 'A');
  assert.strictEqual(three.gamesA, 2);
  assert.strictEqual(three.gamesB, 1);
});

test('网球 —— 整场：1:1 还没打完', () => {
  const result = validateMatchScore([6, 4], [4, 6], T6_3);
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors, ['三盘两胜需要有一方赢下 2 盘才能结束，当前 1 : 1']);
});

test('网球 —— 整场：已经 2:0 之后多录的第三盘要报错', () => {
  const result = validateMatchScore([6, 6, 6], [4, 4, 4], T6_3);
  assert.strictEqual(result.valid, false);
  // 与 point 同一口径：赢下的盘数超过需求时，报「不可能结束」而不是逐盘挑错
  assert.deepStrictEqual(result.errors, ['三盘两胜需要有一方赢下 2 盘才能结束，当前 3 : 0']);

  // 前两盘已经 2:0，第三盘才被对手拿下——决定性的是第 2 盘，第 3 盘是多录的
  const extra = validateMatchScore([6, 6, 4], [4, 4, 6], T6_3);
  assert.strictEqual(extra.valid, false);
  assert.deepStrictEqual(extra.errors, ['比赛在第 2 盘就已分出胜负，多录了 1 盘']);
});

test('网球 —— 整场：一盘决胜只能录一盘', () => {
  assert.strictEqual(validateMatchScore([7], [6], T6_1).valid, true);
  const two = validateMatchScore([6, 6], [4, 4], T6_1);
  assert.strictEqual(two.valid, false);
  assert.ok(two.errors.some((e) => e.includes('最多打 1 盘')));
});

test('网球 —— 整场：盘比分有问题逐盘列出，不牵连合法的盘', () => {
  const result = validateMatchScore([6, 6], [5, 4], T6_3);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /第 1 盘/);
});

test('网球 —— 赛制文案', () => {
  assert.strictEqual(formatMatchFormat(T6_1), '一盘决胜 · 每盘 6 局（6:6 抢七）');
  assert.strictEqual(formatMatchFormat(T6_3), '三盘两胜 · 每盘 6 局（6:6 抢七）');
  assert.strictEqual(formatMatchFormat(T4_1), '一盘决胜 · 每盘 4 局短盘（4:4 抢七）');
  assert.strictEqual(formatMatchFormat({ ...T6_1, noAd: true }), '一盘决胜 · 每盘 6 局（6:6 抢七） · 无占先');
  // 旧的 point 文案一个字都不许变
  assert.strictEqual(formatMatchFormat({ gamePoints: 11, bestOf: 3 }), '11 分制 · 三局两胜');
});

test('网球 —— normalizeTennisFormat 对非网球赛制返回 null', () => {
  assert.strictEqual(normalizeTennisFormat({ gamePoints: 11, bestOf: 3 }), null);
  assert.strictEqual(normalizeTennisFormat(null), null);
  assert.ok(normalizeTennisFormat(T6_1));
});
