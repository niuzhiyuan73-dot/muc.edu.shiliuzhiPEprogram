const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  PLACEHOLDER,
  toDate,
  displayYearOf,
  formatDate,
  formatDateTime,
  formatTime,
  formatSigned,
  formatElo,
  formatPercent,
  formatPlacement,
  formatRank,
  formatScore,
} = require('../src/shared/utils/format.js');

test('toDate —— 兼容各种时间形态', () => {
  assert.ok(toDate(new Date('2026-09-10T15:30:00')) instanceof Date);
  assert.ok(toDate('2026-09-10T15:30:00') instanceof Date);
  assert.ok(toDate(new Date('2026-09-10T15:30:00').getTime()) instanceof Date);
});

test('toDate —— 无效输入一律返回 null，不抛异常', () => {
  // 页面上「没有这个字段」和「字段是空字符串」都很常见，
  // 让调用方到处判空太啰嗦，所以在这里统一收口
  assert.strictEqual(toDate(null), null);
  assert.strictEqual(toDate(undefined), null);
  assert.strictEqual(toDate(''), null);
  assert.strictEqual(toDate('不是时间'), null);
  assert.strictEqual(toDate(NaN), null);
});

test('formatDate —— 月日格式，不补零', () => {
  // 中文里「9月10日」比「09月10日」自然。
  // 入参一律带 Z：不带时区的字符串会被按「运行机器的本地时区」解析，
  // 这套用例就只在东八区的机器上成立（放在 UTC 的 CI 上跑必红）。
  assert.strictEqual(formatDate('2026-09-10T07:30:00.000Z'), '9月10日'); // 北京时间 15:30
  assert.strictEqual(formatDate('2026-11-30T16:00:00.000Z'), '12月1日'); // 北京时间 12-01 00:00
});

test('formatDate —— 无值显示占位符', () => {
  assert.strictEqual(formatDate(null), PLACEHOLDER);
  assert.strictEqual(formatDate('乱码'), PLACEHOLDER);
});

test('formatDateTime —— 月日加时分', () => {
  assert.strictEqual(formatDateTime('2026-09-10T07:30:00.000Z'), '9月10日 15:30');
});

test('formatTime —— 个位数补零，避免出现 9:5 这种写法', () => {
  assert.strictEqual(formatTime('2026-09-10T01:05:00.000Z'), '09:05'); // 北京时间 09:05
  assert.strictEqual(formatTime('2026-09-10T15:59:00.000Z'), '23:59'); // 北京时间 23:59
  assert.strictEqual(formatTime(null), PLACEHOLDER);
});

/* ============================================================
 * 展示时区：固定东八区，与运行环境无关
 * ============================================================
 * 这些函数**两端都在跑**——页面拿它渲染，云函数拿它生成公告/赛事/报名
 * 的时间文案。而云函数的环境时区是 UTC+0，不是 UTC+8。若用 getHours()
 * 这类本地方法，同一条数据在本地是「09:00」、在云端就成了「01:00」，
 * 差 8 小时，且本地测试照不出来（测试机也是东八区）。
 *
 * 下面这些用例全部用带 Z 的绝对时刻，因此它们编码的是「一段时间点该显示
 * 成什么」，而不是「这台机器怎么想」。
 * ============================================================ */

test('展示时间按东八区算，与运行环境时区无关', () => {
  // 2026-10-24T01:00Z = 北京时间 10 月 24 日 09:00
  assert.strictEqual(formatDateTime('2026-10-24T01:00:00.000Z'), '10月24日 09:00');
  assert.strictEqual(formatTime('2026-10-24T01:00:00.000Z'), '09:00');
  assert.strictEqual(formatDate('2026-10-24T01:00:00.000Z'), '10月24日');
});

test('跨日边界：UTC 还是前一天，北京时间已是次日', () => {
  // 2026-10-23T16:30Z = 北京时间 10 月 24 日 00:30
  assert.strictEqual(formatDateTime('2026-10-23T16:30:00.000Z'), '10月24日 00:30');
  assert.strictEqual(formatDate('2026-10-23T16:30:00.000Z'), '10月24日');
  // 2026-10-23T15:30Z = 北京时间 10 月 23 日 23:30
  assert.strictEqual(formatDateTime('2026-10-23T15:30:00.000Z'), '10月23日 23:30');
});

test('跨年边界：年份也按东八区判', () => {
  // 2025-12-31T16:30Z = 北京时间 2026 年 1 月 1 日 00:30
  assert.strictEqual(formatDate('2025-12-31T16:30:00.000Z'), '1月1日');
  assert.strictEqual(displayYearOf('2025-12-31T16:30:00.000Z'), 2026);
  // 2025-12-31T15:30Z = 北京时间 2025 年 12 月 31 日 23:30
  assert.strictEqual(displayYearOf('2025-12-31T15:30:00.000Z'), 2025);
  assert.strictEqual(displayYearOf(null), null);
});

test('在 UTC 环境里跑，结果必须与本机一致（模拟云函数）', () => {
  const modulePath = path.join(__dirname, '..', 'src', 'shared', 'utils', 'format.js');
  const script = [
    `const f = require(${JSON.stringify(modulePath)});`,
    "process.stdout.write(JSON.stringify([",
    "  f.formatDateTime('2026-10-24T01:00:00.000Z'),",
    "  f.formatDate('2026-10-23T16:30:00.000Z'),",
    "  f.formatTime('2026-10-24T01:00:00.000Z'),",
    "  f.displayYearOf('2025-12-31T16:30:00.000Z'),",
    ']));',
  ].join('\n');

  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });

  assert.deepStrictEqual(JSON.parse(out), ['10月24日 09:00', '10月24日', '09:00', 2026]);
});


test('formatSigned —— 正数必须带加号', () => {
  // 分差是全站最重要的信息，少了「+」就看不出涨跌
  assert.strictEqual(formatSigned(18), '+18');
  assert.strictEqual(formatSigned(-12), '-12');
  assert.strictEqual(formatSigned(0), '0');
});

test('formatSigned —— -0 归一成 0', () => {
  // 浮点运算会产出 -0，直接显示成「-0」会让人以为扣了分
  assert.strictEqual(formatSigned(-0), '0');
  assert.strictEqual(formatSigned(-0.0), '0');
  assert.strictEqual(formatSigned(-0.01), '0');
});

test('formatSigned —— 支持小数位', () => {
  assert.strictEqual(formatSigned(0.5, 1), '+0.5');
  assert.strictEqual(formatSigned(-0.25, 2), '-0.25');
});

test('formatSigned —— 非数字显示占位符', () => {
  assert.strictEqual(formatSigned(undefined), PLACEHOLDER);
  assert.strictEqual(formatSigned(NaN), PLACEHOLDER);
  assert.strictEqual(formatSigned('abc'), PLACEHOLDER);
});

test('空值不能被当成 0 显示出来', () => {
  // Number(null) 是 0、Number('') 也是 0。如果直接用 Number()，
  // 「没有这个字段」会在页面上变成「0 分」「0%」，
  // 看上去像是真有一个 0，这是会误导人的。
  for (const empty of [null, undefined, '']) {
    assert.strictEqual(formatSigned(empty), PLACEHOLDER, `formatSigned(${empty})`);
    assert.strictEqual(formatElo(empty), PLACEHOLDER, `formatElo(${empty})`);
    assert.strictEqual(formatPercent(empty), PLACEHOLDER, `formatPercent(${empty})`);
    assert.strictEqual(formatRank(empty, 24), PLACEHOLDER, `formatRank(${empty}, 24)`);
  }
});

test('formatElo —— 四舍五入到整数', () => {
  assert.strictEqual(formatElo(1097.4), 1097);
  assert.strictEqual(formatElo(1097.6), 1098);
  assert.strictEqual(formatElo(1000), 1000);
  assert.strictEqual(formatElo(null), PLACEHOLDER);
});

test('formatPercent —— 小数转百分比', () => {
  assert.strictEqual(formatPercent(0.6429), '64%');
  assert.strictEqual(formatPercent(0.6429, 1), '64.3%');
  assert.strictEqual(formatPercent(1), '100%');
  assert.strictEqual(formatPercent(0), '0%');
  assert.strictEqual(formatPercent(undefined), PLACEHOLDER);
});

test('formatPlacement —— 淘汰赛名次用习惯叫法', () => {
  // 名次公式是 2^k + 1：3 是四强、5 是八强、9 是十六强
  assert.strictEqual(formatPlacement(1), '冠军');
  assert.strictEqual(formatPlacement(2), '亚军');
  assert.strictEqual(formatPlacement(3), '四强');
  assert.strictEqual(formatPlacement(5), '八强');
  assert.strictEqual(formatPlacement(9), '十六强');
});

test('formatPlacement —— 没有约定叫法的名次如实写第几名', () => {
  assert.strictEqual(formatPlacement(4), '第4名');
  assert.strictEqual(formatPlacement(7), '第7名');
});

test('formatPlacement —— 无成绩时不给误导性的「第0名」', () => {
  assert.strictEqual(formatPlacement(0), PLACEHOLDER);
  assert.strictEqual(formatPlacement(null), PLACEHOLDER);
  assert.strictEqual(formatPlacement(undefined), PLACEHOLDER);
  assert.strictEqual(formatPlacement(1.5), PLACEHOLDER);
});

test('formatRank —— 有总数时写全，没有时只写名次', () => {
  assert.strictEqual(formatRank(6, 24), '第 6 / 24 名');
  assert.strictEqual(formatRank(6, undefined), '第 6 名');
  assert.strictEqual(formatRank(null, 24), PLACEHOLDER);
});

test('formatScore —— 逐局配对，三局两胜也能读', () => {
  assert.strictEqual(formatScore([11, 12], [9, 10]), '11:9  12:10');
  assert.strictEqual(formatScore([9, 11, 9], [11, 8, 11]), '9:11  11:8  9:11');
});

test('formatScore —— 两边局数不一致时以少的为准，宁缺勿错位', () => {
  assert.strictEqual(formatScore([11, 12], [9]), '11:9');
});

test('formatScore —— 没有比分时显示占位符', () => {
  assert.strictEqual(formatScore([], []), PLACEHOLDER);
  assert.strictEqual(formatScore(null, null), PLACEHOLDER);
});
