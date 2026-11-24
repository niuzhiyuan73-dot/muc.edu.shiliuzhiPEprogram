/**
 * 文本键的确定性比较（2026-11-07 审查 P2）
 * ============================================================
 * 【为什么要单独一个函数】
 * `String.prototype.localeCompare` 的结果取决于**运行时的 locale 与 ICU**：
 * Node（测试）与微信 JSCore（真机）对同一对字符串可能给出不同顺序。用作
 * 排序键时表现为「同一份数据两端顺序不同」；用在分页的次级判据上更糟——
 * 相邻两页的边界可能重叠或漏行（翻页时看到重复/丢数据）。
 *
 * `compareCode` 直接比较 UTF-16 码元：没有 locale、没有 ICU，两端逐字一致。
 * 编号、时间戳、学号、学院编号这类「键」一律用它。
 *
 * 【展示名为什么不在这里统一】
 * 中文名要按拼音排，就必须有字表（ICU 或自带拼音表）。JSCore 对
 * `localeCompare(x, 'zh-Hans-CN')` 的支持不保证，所以拼音排序在真机上可能
 * 悄悄退化成码点序。这属于**产品口径**，不是随手能改的实现细节：当前保留
 * 各处的 `localeCompare(..., 'zh-Hans-CN')` 写法，待产品确认后再决定是否
 * 换成自带字表的排序。**不要**在没有字表的情况下把展示名改成 compareCode，
 * 那会把「按拼音」变成「按码点」，用户看得见。
 * ============================================================
 */

/**
 * 按 UTF-16 码元比较两个值（null / undefined 当空串）。
 *
 * @param {*} a
 * @param {*} b
 * @returns {number} -1 / 0 / 1
 */
function compareCode(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

module.exports = { compareCode };
