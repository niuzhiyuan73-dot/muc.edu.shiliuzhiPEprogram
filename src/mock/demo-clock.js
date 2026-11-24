/**
 * 演示数据的时间锚点
 * ============================================================
 * 【为什么需要这个模块（2026-10-20 修正）】
 * 演示数据原先在四个文件里各写各的日期：`school-seed.js` 锚在 2026-03-01、
 * `team-demo.js` 自己一套、`college-cup-seed.js` 又一套、`meet-seed.js` 按
 * 「第 58/59/60 届」写死年份。写死的结果是：**演示数据会随时间一起过期**。
 *
 * 症状不是报错，而是自相矛盾：赛事的状态是存下来的字段（有 results 就算
 * 「已结束」，否则「报名中」），不是按当前时间算的。于是锚点一过期，界面上
 * 就出现「报名中」却开赛在半年前的赛事。2026-10-20 实测时，24 场协会个人赛
 * 没有一场的开赛时间晚于当天。
 *
 * 【为什么锚到「当天 09:00」而不是 Date.now()】
 * 只取到「日」这一级：
 *   · 同一天内反复 reset 得到完全一致的记录（页面用例要 reset 几十次，
 *     种子必须可复现，否则断言会今天过明天红）；
 *   · 跨天自动整体往前滚一天，不会隔几个月就烂掉。
 * 时:分固定 09:00 是因为种子里广泛使用「整天偏移」（ago / startOffsetDays），
 * 显示出来「10月24日 09:00」才像真的一场上午的比赛；对齐到 0 点会让所有
 * 演示赛事都显示「08:00」或「00:00」，反而不像。
 *
 * 【需要绝对固定日期的用例】
 * 把 now 显式传进构建函数（`createSchoolDemoContent({ now })`），不要依赖
 * 这个锚点——它是「会滚的」，拿它做精确断言迟早会红。
 * ============================================================
 */

/** 一天的毫秒数。种子里到处要用，集中在这里，免得各文件各写一个 86400000。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 当天 09:00（本地时区）。
 *
 * 【为什么是本地时区】
 * 展示层 `utils/format.js` 用 `getMonth()/getHours()` 等本地方法读时间，
 * 落库的却是 ISO（UTC）。用本地 09:00 构造，显示端才会还原成「09:00」；
 * 若按 UTC 09:00 构造，北京时区下会显示成 17:00。
 *
 * @returns {Date}
 */
function demoToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
}

/**
 * 锚点加减若干天。
 * @param {number} [offsetDays=0] 正数向后、负数向前
 * @returns {Date}
 */
function demoDay(offsetDays = 0) {
  return new Date(demoToday().getTime() + offsetDays * DAY_MS);
}

/**
 * 锚点加减若干天后的 ISO 字符串（种子里的时间字段都是这个形状）。
 * @param {number} [offsetDays=0]
 * @returns {string}
 */
function demoIso(offsetDays = 0) {
  return demoDay(offsetDays).toISOString();
}

/**
 * 锚点加减若干天，并指定当天的时:分。
 *
 * 种子里有些场次排在上午 9:30 / 10:30（同一届赛事逐场顺延），
 * 只按整天偏移写不出来，所以单开一个按「天 + 时:分」取时间的入口。
 *
 * @param {number} offsetDays 偏移天数
 * @param {number} hour 小时（本地时区，0–23）
 * @param {number} [minute=0] 分钟
 * @returns {string} ISO 字符串
 */
function demoAt(offsetDays, hour, minute = 0) {
  const day = demoDay(offsetDays);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).toISOString();
}

/**
 * 演示数据的「当年」。
 *
 * 届次名称（第 N 届 / 2026 石榴籽杯）要跟着一起滚，否则会出现
 * 「2026 石榴籽杯」排在 2027 年的场次上。
 *
 * @returns {number}
 */
function demoYear() {
  return new Date().getFullYear();
}

module.exports = {
  DAY_MS, demoToday, demoDay, demoIso, demoAt, demoYear,
};
