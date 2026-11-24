/**
 * 展示层格式化
 * ============================================================
 * 页面里到处都要把数字和时间变成人话：
 * 「1097」要写成「1097」，「+18」要带正号，「9月10日」不能写成 ISO 串。
 *
 * 【为什么单独抽一个模块】
 * 同一件事如果每个页面各写一遍，迟早会出现
 * 「排行榜写的 9月10日，个人页写的 09-10」这种不一致。
 * 统一在这里定义，改一处，全站生效。
 *
 * 【全部是纯函数】
 * 不依赖 wx API、不读系统时间，因而可以在 Node 里直接测试。
 * ============================================================
 */

/** 无效或缺席时统一显示的占位符，避免页面上出现 undefined / NaN */
const PLACEHOLDER = '—';

/** 把数字补成两位，用于 09:05 这样的时间 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 把各种形式的时间值转成 Date。
 * 接受 Date、时间戳、ISO 字符串；无法解析时返回 null。
 *
 * 单独抽出来是因为调用方传来的东西很杂：有的来自数据库（Date），
 * 有的来自 JSON（字符串），有的本身就是空。让每个函数各自判空
 * 太啰嗦，也不容易判得一致。
 *
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 把值转成数字，空值一律返回 null。
 *
 * 【为什么不能直接用 Number()】
 * Number(null) 是 0、Number('') 也是 0。数据里「这个字段没有」
 * 往往表现为 null 或空串，若直接转换就会把「没有」渲染成「0 分」，
 * 页面上看起来像是真有一个 0 分，这是会误导人的。
 *
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 展示时区固定为东八区（学校所在地）。
 *
 * 【为什么不能直接用本地时区（2026-10-20 只读审计）】
 * 这个模块**同时在两端跑**：页面里用它渲染，云函数里也用它生成 `*Text`
 * 字段（公告发布时间、赛事开赛时间、报名提交时间、入会时间……共 5 处，
 * 见 cloudfunctions/data/lib/services 下的 announcement / event /
 * college-entry / college-event / member-review）。
 *
 * 而云函数的运行环境时区是 **UTC+0**，不是 UTC+8（微信官方「注意事项 & FAQ」
 * 明写：如需 UTC+8 要自行配 TZ 环境变量）。于是同一条数据：
 *
 *   本地（东八区）：2026-10-24T01:00:00Z → 「10月24日 09:00」
 *   云端（UTC）  ：同一时间          → 「10月24日 01:00」
 *
 * 整整差 8 小时，而且本地测试永远发现不了——测试也跑在东八区的机器上。
 *
 * 【修法：把「墙上时钟」算出来，再用 UTC 取字段】
 * 先把时间点平移到东八区，之后一律用 getUTC* 读。这样结果只取决于时间点
 * 本身，与运行环境时区无关：本地、云函数、UTC 的 CI 机器算出来都一样。
 *
 * 【语义说明】
 * 赛事、报名、公告的时间都以学校所在地（东八区）为准。海外用户看到的是
 * 北京时间而不是当地时间，这是刻意的选择——比分与赛程要和学校对得上。
 */
const DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把时间值换算成「东八区的墙上时钟」。
 * 返回的 Date 请一律用 getUTC* 读取，不要用 get*（那又会回到运行环境时区）。
 *
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
function toDisplayClock(value) {
  const date = toDate(value);
  return date ? new Date(date.getTime() + DISPLAY_OFFSET_MS) : null;
}

/**
 * 展示用的年份（东八区）。云端按「哪一年发起」筛选时用，避免用
 * getFullYear() 落在服务器时区上——那样跨年前后 8 小时内的记录会归错年。
 *
 * @param {Date|string|number} value
 * @returns {number|null}
 */
function displayYearOf(value) {
  const clock = toDisplayClock(value);
  return clock ? clock.getUTCFullYear() : null;
}

/**
 * 日期：9月10日
 * @param {Date|string|number} value
 * @returns {string}
 */
function formatDate(value) {
  const clock = toDisplayClock(value);
  if (!clock) return PLACEHOLDER;
  return `${clock.getUTCMonth() + 1}月${clock.getUTCDate()}日`;
}

/**
 * 日期时间：9月10日 15:30
 * @param {Date|string|number} value
 * @returns {string}
 */
function formatDateTime(value) {
  const clock = toDisplayClock(value);
  if (!clock) return PLACEHOLDER;
  return `${clock.getUTCMonth() + 1}月${clock.getUTCDate()}日 `
    + `${pad2(clock.getUTCHours())}:${pad2(clock.getUTCMinutes())}`;
}

/**
 * 只取时间：15:30
 * @param {Date|string|number} value
 * @returns {string}
 */
function formatTime(value) {
  const clock = toDisplayClock(value);
  if (!clock) return PLACEHOLDER;
  return `${pad2(clock.getUTCHours())}:${pad2(clock.getUTCMinutes())}`;
}

/**
 * 带符号的整数：+18 / -12 / 0
 *
 * 【为什么要专门处理正号】
 * 分差是全站最重要的信息之一，正数没有「+」会让人一眼看不出是涨是跌。
 * 同时把 -0 归一成 0——浮点运算会出现 -0，界面上显示「-0」很怪。
 *
 * @param {number} value
 * @param {number} [digits=0] 保留几位小数
 * @returns {string}
 */
function formatSigned(value, digits = 0) {
  const number = toNumber(value);
  if (number === null) return PLACEHOLDER;

  let fixed = number.toFixed(digits);
  // toFixed 会把 -0.01 舍入成 '-0'。这种负零在界面上会让人以为扣了分，
  // 必须先判、再补正号，否则「+」的规则会被绕过去。
  if (Number(fixed) === 0) fixed = (0).toFixed(digits);

  return Number(fixed) > 0 ? `+${fixed}` : fixed;
}

/**
 * 取整展示等级分。等级分带小数没有意义，页面一律显示整数。
 * @param {number} value
 * @returns {number|string}
 */
function formatElo(value) {
  const number = toNumber(value);
  if (number === null) return PLACEHOLDER;
  return Math.round(number);
}

/**
 * 胜率：0.6429 → 64%
 *
 * @param {number} rate 区间 [0, 1]
 * @param {number} [digits=0] 保留几位小数
 * @returns {string}
 */
function formatPercent(rate, digits = 0) {
  const number = toNumber(rate);
  if (number === null) return PLACEHOLDER;
  return `${(number * 100).toFixed(digits)}%`;
}

/**
 * 名次文案。
 *
 * 【口径来源】
 * 淘汰赛里「第 N 轮出局」的名次是 2^k + 1（见 services/seed.js 的 simulateBracket），
 * 于是 3 表示四强、5 表示八强、9 表示十六强。
 * 对打球的人来说「八强」比「第 5 名」直观得多——第 5 名听起来像
 * 小组循环赛的第 5 名，而这里其实是进了淘汰赛。
 *
 * 其它名次（如小组循环赛）没有约定俗成的叫法，直接写「第 N 名」。
 *
 * @param {number} placement 名次，1 为冠军
 * @returns {string}
 */
function formatPlacement(placement) {
  const place = toNumber(placement);
  if (place === null || !Number.isInteger(place) || place < 1) return PLACEHOLDER;

  const map = { 1: '冠军', 2: '亚军', 3: '四强', 5: '八强', 9: '十六强' };
  return map[place] || `第${place}名`;
}

/**
 * 名次文案：第 6 / 24 名
 * @param {number} rank
 * @param {number} total
 * @returns {string}
 */
function formatRank(rank, total) {
  const place = toNumber(rank);
  if (place === null) return PLACEHOLDER;

  const count = toNumber(total);
  if (count === null) return `第 ${place} 名`;
  return `第 ${place} / ${count} 名`;
}

/**
 * 把两条比分数组还原成「11:9  12:10」这样的逐单元文案。
 *
 * 比赛数据里比分是两条数组（我方得分、对方得分），因为可能是三局两胜。
 * 页面上直接并列两排数字很难读，所以按单元配对。
 * 两边单元数不一致时以较短的一边为准，多出来的数据宁可丢掉也不错位。
 *
 * 【网球多一个括号】
 * 盘比分打到抢七时，网球记法要标出输方的抢七分：7:6(5)。第三个参数
 * 就是这些抢七小分（`[{setIndex,a,b}]`，a/b 与 mine/theirs 同侧）。
 * 不传就只输出 7:6——老赛制与没有记录小分的比赛都走这一路。
 *
 * @param {Array<number>} mine
 * @param {Array<number>} theirs
 * @param {Array<{setIndex:number,a:number,b:number}>} [tiebreaks]
 * @returns {string}
 */
function formatScore(mine, theirs, tiebreaks) {
  const a = Array.isArray(mine) ? mine : [];
  const b = Array.isArray(theirs) ? theirs : [];
  if (a.length === 0 || b.length === 0) return PLACEHOLDER;

  const marks = Array.isArray(tiebreaks) ? tiebreaks : [];
  const games = Math.min(a.length, b.length);
  const lines = [];
  for (let i = 0; i < games; i += 1) {
    let text = `${a[i]}:${b[i]}`;
    const tb = marks.find((item) => item && item.setIndex === i);
    // 括号里是**输方**的抢七分，这是网球的标准记法（7:6(5) 读作「七比六，抢七五比七」）
    if (tb) text += `(${a[i] > b[i] ? tb.b : tb.a})`;
    lines.push(text);
  }
  return lines.join('  ');
}

module.exports = {
  PLACEHOLDER,
  toDate,
  toNumber,
  toDisplayClock,
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
};
