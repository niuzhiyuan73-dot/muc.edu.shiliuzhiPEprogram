/**
 * B1：项目模板库与计量内核自检
 * ============================================================
 * 覆盖三件容易出错的事：
 *   1. 46 条模板的完整性与推导字段（order/unit/defaultScored 不许手写）；
 *   2. 计分口径 N16（展示类不计分、趣味类计分）与参赛形态的三分法；
 *   3. 精度与截断——尤其是浮点陷阱（6.78、0.29）与「无成绩不是 0」。
 *
 * 不碰 wx、不碰仓储，纯函数级断言。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MEET_SCORE_TYPE,
  MEET_ORDER,
  MEET_ENTRY_FORM,
  TEMPLATES,
  CATEGORY_ORDER,
  getTemplate,
  searchTemplates,
  listByCategory,
  normalizeKeyword,
} = require('../src/shared/services/meet-event-catalog.js');

const {
  normalizeMeasure,
  formatMeasure,
  compareMeasure,
  countsTowardPersonalQuota,
} = require('../src/shared/services/meet-measure.js');

const idsOf = (items) => items.map((item) => item.id);

test('模板库共 46 项，id 唯一', () => {
  assert.strictEqual(TEMPLATES.length, 46);
  assert.strictEqual(new Set(idsOf(TEMPLATES)).size, 46);
});

test('十类数量与决策文档 4.1 一致', () => {
  const expected = {
    sprint: 5, middle: 6, hurdle: 4, relay: 4, jump: 4,
    throw: 5, team: 2, fun: 8, reps: 3, show: 5,
  };
  for (const category of CATEGORY_ORDER) {
    const count = TEMPLATES.filter((item) => item.category === category).length;
    assert.strictEqual(count, expected[category], `${category} 数量`);
  }
  const total = Object.values(expected).reduce((sum, n) => sum + n, 0);
  assert.strictEqual(total, 46);
});

test('每条模板的字段取值都在枚举内，且推导字段自洽', () => {
  const scoreTypes = Object.values(MEET_SCORE_TYPE);
  const forms = Object.values(MEET_ENTRY_FORM);
  const orderByType = {
    time: MEET_ORDER.ASC,
    distance: MEET_ORDER.DESC,
    height: MEET_ORDER.DESC,
    count: MEET_ORDER.DESC,
    score: MEET_ORDER.DESC,
    versus: MEET_ORDER.BRACKET,
  };

  for (const item of TEMPLATES) {
    assert.ok(item.name && item.id, `缺少名称 ${item.id}`);
    assert.ok(scoreTypes.includes(item.scoreType), `${item.id} 成绩类型非法`);
    assert.ok(forms.includes(item.entryForm), `${item.id} 参赛形态非法`);
    assert.ok(item.recommendedGroups.length > 0, `${item.id} 缺推荐组别`);
    // 推导断言：order 必须与成绩类型对应，不允许手写成相反方向
    assert.strictEqual(item.order, orderByType[item.scoreType], `${item.id} 排序方向`);
    // 胜负项目没有单位，数值项目必须有单位
    if (item.scoreType === MEET_SCORE_TYPE.VERSUS) {
      assert.strictEqual(item.unit, null);
      assert.strictEqual(item.numeric, false);
    } else {
      assert.ok(item.unit, `${item.id} 缺单位`);
      assert.strictEqual(item.numeric, true);
    }
  }
});

test('N16：展示类默认不计分，趣味类默认计分，其余计分', () => {
  for (const item of TEMPLATES) {
    const expected = item.category !== 'show';
    assert.strictEqual(item.defaultScored, expected, `${item.id} defaultScored`);
  }
  // 逐项钉死，防止有人把入场式改成计分
  for (const id of ['show-gymnastics', 'show-aerobics', 'show-cheer', 'show-martial', 'show-parade']) {
    assert.strictEqual(getTemplate(id).defaultScored, false, `${id} 不应计分`);
  }
  for (const id of ['fun-three-leg', 'fun-clogs', 'fun-stilts']) {
    assert.strictEqual(getTemplate(id).defaultScored, true, `${id} 应计分`);
  }
});

test('组别推荐：110 米栏限男、100 米栏限女、混合接力只混合', () => {
  assert.deepStrictEqual([...getTemplate('hurdle-110m').recommendedGroups], ['male']);
  assert.deepStrictEqual([...getTemplate('hurdle-100m').recommendedGroups], ['female']);
  assert.deepStrictEqual([...getTemplate('relay-medley').recommendedGroups], ['mixed']);
  assert.deepStrictEqual([...getTemplate('relay-4x100').recommendedGroups], ['male', 'female']);
  assert.deepStrictEqual([...getTemplate('tug-of-war').recommendedGroups], ['mixed']);
});

test('参赛形态三分法：单人／固定人数组／队伍', () => {
  // 只有这三项是「固定人数组」（计入个人兼项）
  const groups = TEMPLATES.filter((item) => item.entryForm === MEET_ENTRY_FORM.GROUP);
  assert.deepStrictEqual(idsOf(groups).sort(), ['fun-clogs', 'fun-multi-leg', 'fun-three-leg']);

  // 固定人数：两人三足 2 人、三人板鞋 3 人（B2 强制）
  assert.strictEqual(getTemplate('fun-three-leg').fixedMembers, 2);
  assert.strictEqual(getTemplate('fun-clogs').fixedMembers, 3);
  assert.strictEqual(getTemplate('fun-clogs').defaultMembers, 3);

  // 接力与团体是队伍
  for (const id of ['relay-4x100', 'relay-4x400', 'relay-medley', 'relay-shuttle', 'tug-of-war', 'team-rope']) {
    assert.strictEqual(getTemplate(id).entryForm, MEET_ENTRY_FORM.TEAM, id);
  }
  assert.strictEqual(getTemplate('relay-4x100').defaultMembers, 4);
  assert.strictEqual(getTemplate('sprint-100m').entryForm, MEET_ENTRY_FORM.SINGLE);
});

test('兼项口径：单人/固定人数组计入个人额度，队伍不计入', () => {
  assert.strictEqual(countsTowardPersonalQuota('single'), true);
  assert.strictEqual(countsTowardPersonalQuota('group'), true);
  assert.strictEqual(countsTowardPersonalQuota('team'), false);
});

test('拔河是胜负项目，团体跳绳是计数项目', () => {
  const tug = getTemplate('tug-of-war');
  assert.strictEqual(tug.scoreType, MEET_SCORE_TYPE.VERSUS);
  assert.strictEqual(tug.order, MEET_ORDER.BRACKET);

  const rope = getTemplate('team-rope');
  assert.strictEqual(rope.scoreType, MEET_SCORE_TYPE.COUNT);
  assert.strictEqual(rope.order, MEET_ORDER.DESC);
});

test('搜索：别名、数字归一、全角、乘号变体', () => {
  assert.ok(idsOf(searchTemplates('100米')).includes('sprint-100m'));
  assert.ok(idsOf(searchTemplates('百米')).includes('sprint-100m'));
  assert.ok(idsOf(searchTemplates('１００米')).includes('sprint-100m'));
  assert.ok(idsOf(searchTemplates('4*100')).includes('relay-4x100'));
  assert.ok(idsOf(searchTemplates('4×100')).includes('relay-4x100'));
  assert.ok(idsOf(searchTemplates(' 1 0 0 米 ')).includes('sprint-100m'));
  assert.ok(idsOf(searchTemplates('铅球')).includes('throw-shot'));
  assert.strictEqual(searchTemplates('不存在的项目').length, 0);
  assert.strictEqual(normalizeKeyword('４×１００ 米'), '4x100米');
});

test('搜索：空关键词返回全部，可按分类过滤', () => {
  assert.strictEqual(searchTemplates('').length, 46);
  assert.strictEqual(searchTemplates('', { category: 'show' }).length, 5);
  assert.strictEqual(searchTemplates('', { category: 'relay' }).length, 4);
  assert.strictEqual(searchTemplates('接力', { category: 'show' }).length, 0);
});

test('分类分组：顺序与 4.1 一致，组内不丢项', () => {
  const grouped = listByCategory();
  assert.deepStrictEqual(grouped.map((g) => g.category), [...CATEGORY_ORDER]);
  const total = grouped.reduce((sum, g) => sum + g.items.length, 0);
  assert.strictEqual(total, 46);
});

test('模板对象只读，防止运行时被改写', () => {
  assert.ok(Object.isFrozen(TEMPLATES));
  assert.ok(Object.isFrozen(TEMPLATES[0]));
  assert.ok(Object.isFrozen(TEMPLATES[0].aliases));
});

test('计时：最多 2 位小数，超出直接拒绝而不是静默取整', () => {
  const ok = normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.34');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.scaled, 1234);
  assert.strictEqual(ok.text, '12.34');
  assert.strictEqual(ok.unit, '秒');

  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.3').scaled, 1230);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, '12').scaled, 1200);

  const tooMany = normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.345');
  assert.strictEqual(tooMany.ok, false);
  assert.strictEqual(tooMany.reason, 'too-many-decimals');

  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, '0').reason, 'out-of-range');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, '-1').reason, 'not-a-number');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, 'abc').reason, 'not-a-number');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.TIME, '   ').reason, 'empty');
});

test('距离：截断到厘米（向下），不是四舍五入', () => {
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.789').scaled, 678);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.789').text, '6.78');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.7').scaled, 670);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '8').scaled, 800);
  // 浮点陷阱：6.78 * 100 在 JS 里是 677.9999999999999，这里必须是 678
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.78').scaled, 678);
  // 同样：0.29 * 100 是 28.999999999999996
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '0.29').scaled, 29);

  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '100.01').reason, 'out-of-range');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.7894').reason, 'too-many-decimals');
});

test('高度：同样截断，范围 0–5 米', () => {
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.HEIGHT, '1.85').scaled, 185);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.HEIGHT, '1.855').scaled, 185);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.HEIGHT, '1.855').text, '1.85');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.HEIGHT, '0').reason, 'out-of-range');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.HEIGHT, '5.01').reason, 'out-of-range');
});

test('次数：只收整数，0 合法', () => {
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.COUNT, '45').scaled, 45);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.COUNT, '0').scaled, 0);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.COUNT, '45.5').reason, 'too-many-decimals');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.COUNT, '10001').reason, 'out-of-range');
});

test('评分：0–100，最多 1 位小数', () => {
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '88.5').scaled, 885);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '88.5').text, '88.5');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '100').scaled, 1000);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '0').scaled, 0);
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '88.55').reason, 'too-many-decimals');
  assert.strictEqual(normalizeMeasure(MEET_SCORE_TYPE.SCORE, '100.1').reason, 'out-of-range');
});

test('胜负项目不接收数值成绩', () => {
  const result = normalizeMeasure(MEET_SCORE_TYPE.VERSUS, '2');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'versus-not-measured');
});

test('未知成绩类型被拒绝，不静默当成功', () => {
  const result = normalizeMeasure('unknown-type', '1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unknown-score-type');
});

test('排序方向：计时小者优先，距离大者优先', () => {
  const t1 = normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.30').scaled;
  const t2 = normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.40').scaled;
  assert.ok(compareMeasure(t1, t2, MEET_ORDER.ASC) < 0, '12.30 应排在 12.40 之前');
  assert.ok(compareMeasure(t1, t2, MEET_ORDER.DESC) > 0);

  const d1 = normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.80').scaled;
  const d2 = normalizeMeasure(MEET_SCORE_TYPE.DISTANCE, '6.50').scaled;
  assert.ok(compareMeasure(d1, d2, MEET_ORDER.DESC) < 0, '6.80 应排在 6.50 之前');
});

test('无成绩不可比较，绝不当作 0 参与排序', () => {
  const best = normalizeMeasure(MEET_SCORE_TYPE.TIME, '12.30').scaled;
  assert.strictEqual(compareMeasure(best, null, MEET_ORDER.ASC), null);
  assert.strictEqual(compareMeasure(null, best, MEET_ORDER.ASC), null);
  assert.strictEqual(compareMeasure(best, undefined, MEET_ORDER.ASC), null);
  // 胜负项目没有数值方向
  assert.strictEqual(compareMeasure(1, 2, MEET_ORDER.BRACKET), null);
});

test('回显：计时补足两位，评分一位，次数整数', () => {
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.TIME, 1200), '12.00');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.TIME, 1205), '12.05');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.DISTANCE, 678), '6.78');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.HEIGHT, 185), '1.85');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.COUNT, 45), '45');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.SCORE, 885), '88.5');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.SCORE, 1000), '100.0');
  assert.strictEqual(formatMeasure(MEET_SCORE_TYPE.VERSUS, 1), null);
});
