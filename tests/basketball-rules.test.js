/**
 * 篮球规则快照的纯逻辑自检
 * ============================================================
 * 规则快照决定「怎么算一场球」：几节、每节多久、几次犯规离场、全队第几次
 * 犯规起罚球。它一旦写错，比赛录完了才发现规则不对，只能整场重录。
 *
 * 这里钉住四件事：
 *   1. 两份预设的数值（FIBA 4×10 / 校园 2×20），以及与官方的差异；
 *   2. 非法值一律判非法，不静默夹取——夹取会让「选了 6 节」悄悄变成 4 节；
 *   3. 报名下限是 5 人（本项目口径），不是 CUBAL 的 8 人；
 *   4. 3x3 首版不开放：能读旧快照，但不能新建。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  BASKETBALL_FORMAT,
  FOUL_WINDOW,
  RULE_PRESETS,
  DEFAULT_PRESET_KEY,
  presetOf,
  defaultRulesFor,
  normalizeBasketballRules,
  isValidBasketballRules,
  formatBasketballRules,
  canStartWithRoster,
} = require('../src/shared/utils/basketball-rules.js');

/* ============================================================
 * 一、预设数值
 * ============================================================ */

test('预设 —— FIBA 四节：4×10、个人 5 犯、每节第 5 犯起罚球、24 秒', () => {
  const rules = presetOf('fiba-4x10');

  assert.strictEqual(rules.periods, 4);
  assert.strictEqual(rules.periodMinutes, 10);
  assert.strictEqual(rules.overtimeMinutes, 5);
  assert.strictEqual(rules.personalFoulLimit, 5, 'FIBA 是 5 犯离场，NBA 才是 6 犯');
  assert.strictEqual(rules.teamFoulPenalty, 5, '每节全队第 5 犯起罚球');
  assert.strictEqual(rules.foulWindow, FOUL_WINDOW.PERIOD);
  assert.strictEqual(rules.threePointLine, 6.75);
  assert.strictEqual(rules.shotClock, 24);
  assert.strictEqual(rules.rosterMin, 5, '本项目按满 5 人可开赛，不采用 CUBAL 的 8 人下限');
  assert.strictEqual(rules.rosterMax, 12);
  assert.strictEqual(rules.minOnCourt, 2, '场上不足 2 人判负，否则 5 人开赛会撞死局');
  assert.strictEqual(rules.allowDraw, false);
});

test('预设 —— 校园上下半场：2×20，全队犯规按半场重置', () => {
  const rules = presetOf('campus-2x20');

  assert.strictEqual(rules.periods, 2);
  assert.strictEqual(rules.periodMinutes, 20);
  assert.strictEqual(rules.foulWindow, FOUL_WINDOW.HALF, '院系赛习惯按半场重置全队犯规');
  // 除节数与犯规窗口外，其余沿用 FIBA 口径
  assert.strictEqual(rules.personalFoulLimit, 5);
  assert.strictEqual(rules.teamFoulPenalty, 5);
});

test('预设 —— 取不到预设时退回默认，绝不抛错', () => {
  assert.strictEqual(presetOf('nope').key, DEFAULT_PRESET_KEY);
  assert.strictEqual(presetOf('').key, DEFAULT_PRESET_KEY);
  assert.strictEqual(presetOf(undefined).key, DEFAULT_PRESET_KEY);
  // 返回副本：改返回的对象不影响预设本身
  const copy = presetOf('fiba-4x10');
  copy.periods = 99;
  assert.strictEqual(RULE_PRESETS['fiba-4x10'].periods, 4);
});

/* ============================================================
 * 二、校验与归一
 * ============================================================ */

test('归一 —— 只给 presetKey 也能补成一份完整快照', () => {
  const rules = normalizeBasketballRules({ presetKey: 'campus-2x20' });

  assert.ok(rules);
  assert.strictEqual(rules.sportFormat, BASKETBALL_FORMAT.FIVE);
  assert.strictEqual(rules.periods, 2);
  assert.strictEqual(rules.ruleVersion, 'campus-2026');
  assert.strictEqual(rules.enabled, true);
});

test('归一 —— 非法值一律判非法，不静默夹取', () => {
  const cases = [
    [{ presetKey: 'fiba-4x10', periods: 5 }, '节数超出 1–4'],
    [{ presetKey: 'fiba-4x10', periodMinutes: 30 }, '单节时长超出 5–20'],
    [{ presetKey: 'fiba-4x10', personalFoulLimit: 9 }, '个人犯规格上限之外'],
    [{ presetKey: 'fiba-4x10', teamFoulPenalty: 0 }, '全队犯规阈值不能为 0'],
    [{ presetKey: 'fiba-4x10', rosterMin: 4 }, '5 人制报名下限不能低于场上人数'],
    [{ presetKey: 'fiba-4x10', rosterMin: 12, rosterMax: 8 }, '下限不能大于上限'],
    [{ presetKey: 'fiba-4x10', minOnCourt: 6 }, '场上人数不能超过报名下限'],
    [{ presetKey: 'fiba-4x10', sportFormat: 'handball' }, '未知制式'],
    [{}, '空对象：没有 sportFormat'],
    [null, 'null'],
  ];
  for (const [input, why] of cases) {
    assert.strictEqual(normalizeBasketballRules(input), null, why);
    assert.strictEqual(isValidBasketballRules(input), false, why);
  }
});

test('归一 —— 幂等：归一后的结果再归一还是一样', () => {
  const once = normalizeBasketballRules({ presetKey: 'fiba-4x10' });
  const twice = normalizeBasketballRules(once);

  assert.deepStrictEqual(twice, once);
});

test('归一 —— 三人制：能读旧快照（enabled=false），不能新建', () => {
  const legacy = { ...presetOf('fiba-4x10'), sportFormat: BASKETBALL_FORMAT.THREE, enabled: false };
  const read = normalizeBasketballRules(legacy);
  assert.ok(read, '旧的三层快照要能读出来');
  assert.strictEqual(read.enabled, false);

  const created = { ...presetOf('fiba-4x10'), sportFormat: BASKETBALL_FORMAT.THREE };
  assert.strictEqual(normalizeBasketballRules(created), null, '首版不开放三人制新建');
});

/* ============================================================
 * 三、报名下限与文案
 * ============================================================ */

test('canStartWithRoster —— 满 5 人可开赛，4 人不行', () => {
  const rules = presetOf('fiba-4x10');

  assert.deepStrictEqual(canStartWithRoster(5, rules), { ok: true, need: 5 });
  assert.deepStrictEqual(canStartWithRoster(8, rules), { ok: true, need: 5 });
  assert.deepStrictEqual(canStartWithRoster(4, rules), { ok: false, need: 5 });
  assert.deepStrictEqual(canStartWithRoster(undefined, rules), { ok: false, need: 5 });
  // 规则缺省时按默认预设判断，不抛错
  assert.strictEqual(canStartWithRoster(5, null).ok, true);
});

test('formatBasketballRules —— 一行说清节数、犯规与加时', () => {
  assert.strictEqual(
    formatBasketballRules(presetOf('fiba-4x10')),
    '4 节 × 10 分钟 · 个人 5 犯离场 · 全队每节第 5 犯起罚球 · 加时 5 分钟'
  );
  assert.strictEqual(
    formatBasketballRules({ ...presetOf('campus-2x20'), allowDraw: true }),
    '2 节 × 20 分钟 · 个人 5 犯离场 · 全队每半场第 5 犯起罚球 · 加时 5 分钟 · 允许平局'
  );
  assert.strictEqual(formatBasketballRules({ periods: 9 }), '', '非法快照给空串，不拼半句话');
});

test('defaultRulesFor —— 五人制给 FIBA 预设，三人制给未启用占位', () => {
  assert.strictEqual(defaultRulesFor().key, DEFAULT_PRESET_KEY);
  assert.strictEqual(defaultRulesFor(BASKETBALL_FORMAT.FIVE).periods, 4);

  const three = defaultRulesFor(BASKETBALL_FORMAT.THREE);
  assert.strictEqual(three.sportFormat, BASKETBALL_FORMAT.THREE);
  assert.strictEqual(three.enabled, false);
  assert.strictEqual(three.scoreLimit, 21, '3x3 是先到 21 分');
  assert.strictEqual(three.shotClock, 12, '3x3 进攻时限 12 秒');
});
