/** 校内运动会的无时区输入统一按北京时间解释，避免云函数 UTC 与手机相差八小时。 */
function parseMeetTime(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim().replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return NaN;
  if (!isCalendarDate(match[1])) return NaN;
  return Date.parse(match[5] ? text : `${text}+08:00`);
}

/**
 * `YYYY-MM-DD` 是不是**真实存在**的日历日。
 *
 * 【为什么不能只判 `Number.isFinite(Date.parse(...))`】（2026-10-28 审计 2 B-1）
 * V8 的 ISO 解析器对「当月天数不够」的日期会静默进位：
 * `Date.parse('2026-02-30T00:00:00Z')` → 2026-03-02，`2026-04-31` → 2026-05-01。
 * 于是「2 月 30 日」既能通过校验、又能原样落库，而比较大小的时候按 3 月 2 日算——
 * 用户看到的日期和系统判定的日期不是同一天。
 * 月/日为 0 或 13 以上会得到 NaN，只有「小月 31 日、二月 30 日」这一类才会进位，
 * 所以单靠 isFinite 拦不住。回读一次 `toISOString().slice(0,10)` 与原串比对即可。
 *
 * @param {string} text `YYYY-MM-DD`
 * @returns {boolean}
 */
function isCalendarDate(text) {
  const day = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === text;
}

module.exports = { parseMeetTime, isCalendarDate };
