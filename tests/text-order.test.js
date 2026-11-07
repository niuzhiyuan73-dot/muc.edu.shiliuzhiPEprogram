/**
 * 排序键的确定性（2026-11-07 审查 P2-5）
 * ============================================================
 * `localeCompare` 的结果依赖运行时的 locale 与 ICU：Node（测试）与 JSCore（真机）
 * 对同一对字符串可能给出不同顺序。用在「编号 / 时间戳」这类排序键上，症状是
 * 同一份数据两端顺序不同；用在分页的次级判据上更糟——相邻两页的边界会重叠或漏行。
 *
 * `compareCode` 直接比 UTF-16 码元，两端逐字一致。这条用例钉三件事：
 *   1. 它不依赖 locale（同一个输入永远同一个输出）；
 *   2. 空值当空串处理，不抛异常；
 *   3. 用它排完的顺序是「全序」——任意两项都能分出先后，没有并列的模糊区间。
 *
 * 展示名（中文）仍走 `localeCompare(..., 'zh-Hans-CN')`，属于产品口径，
 * 见 utils/text-order.js 的说明，不在本用例范围。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compareCode } = require('../miniprogram/utils/text-order');

test('compareCode 按码元比较：符号、大小写、数字都确定', () => {
  assert.equal(compareCode('a', 'b'), -1);
  assert.equal(compareCode('b', 'a'), 1);
  assert.equal(compareCode('a', 'a'), 0);
  // 大小写：码元序里大写在小写之前，这与多数 locale 排序相反——正因为要确定
  assert.equal(compareCode('B', 'a'), -1);
  // 数字串按字符比较，不是按数值
  assert.equal(compareCode('10', '9'), -1);
  // 编号里常见的分隔符也是确定的
  assert.ok(compareCode('sm:muc:u1', 'sm:muc:u2') < 0);
  assert.ok(compareCode('sm:muc:u1', 'sm_muc:u1') < 0);
});

test('compareCode 把 null / undefined 当空串，不抛异常', () => {
  assert.equal(compareCode(null, ''), 0);
  assert.equal(compareCode(undefined, ''), 0);
  assert.equal(compareCode(null, 'a'), -1);
  assert.equal(compareCode(123, '124'), -1, '数字按字符串比');
});

test('同一批编号排序两次结果一致，且是全序（无并列）', () => {
  const ids = ['sm:muc:u10', 'sm:muc:u2', 'sm:muc:u1', 'sm:muc:U1', 'sm:muc:u1_x'];
  const once = [...ids].sort(compareCode);
  const twice = [...ids].sort(compareCode);
  assert.deepEqual(once, twice, '两次排序必须一致');

  // 全序：任意两项都必须能分出先后（只有自己与自己相等）
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      assert.notEqual(compareCode(a, b), 0, `${a} 与 ${b} 不应并列`);
      assert.equal(compareCode(a, b), -compareCode(b, a), '比较必须反对称');
    }
  }
});
