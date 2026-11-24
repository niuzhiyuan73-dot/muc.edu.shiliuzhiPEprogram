/**
 * 运动会成绩计量与精度（B1）
 * ============================================================
 * 只做三件事：把裁判输入的文本变成可比较的整数、按规则排序、按规则回显。
 * 不碰仓储、不碰页面，因此能全部在单测里跑完。
 *
 * 【为什么内部用「最小单位整数」而不是浮点】
 * 6.78 * 100 在 JS 里是 677.9999999999999，0.29 * 100 是 28.999999999999996。
 * 用浮点做截断，会把 6.78 截成 6.77、把 0.29 截成 0.28——这类偏差在名次上
 * 就是「并列变先后」。所以这里**完全不乘浮点**：直接按十进制字符串切位，
 * 整数部分与小数位分别取，再拼成整数。缩放入口只有这一处，后面全部整数比较。
 *
 * 【两种舍入方向为什么不同（世界田联 TR19／TR25）】
 *   - 计时：判读到 1/100 秒，输入超过 2 位小数一律**拒绝**（不当场四舍五入，
 *     也不静默截断——那等于替裁判改成绩）；
 *   - 距离与高度：TR25 规定记录为「所测距离以下最近的厘米」，即**截断**。
 *     输入 6.789 米记 6.78 米，这是规则要求，不是精度丢失。
 *   - 次数：只收整数；评分：0–100、最多 1 位小数。
 *
 * 【手计时不做换算（N17）】
 * TR19 原本要求手计时向上取到下一个 0.1 秒，本项目已明确**不换算**：
 * 裁判录入的即秒表读数，原样记录。这是刻意保留的偏差，不在本模块内纠正。
 *
 * 【无成绩不是 0】
 * `compareMeasure` 遇到空值返回 null 而不是把 0 当最小值——计时项目里
 * 0 秒会是第一名。调用方必须显式处理「无成绩」，不给静默兜底。
 * ============================================================
 */

const {
  MEET_SCORE_TYPE,
  MEET_ORDER,
  MEET_ENTRY_FORM,
} = require('./meet-event-catalog.js');

/** 各类型的合法精度与取值范围（缩放后的整数边界）。 */
const MEASURE_RULES = Object.freeze({
  [MEET_SCORE_TYPE.TIME]: Object.freeze({
    scale: 100,
    unit: '秒',
    maxDecimals: 2,
    round: 'reject-extra', // 超出位数直接拒绝
    min: 1, // 0.01 秒
    max: 8640000, // 24 小时
  }),
  [MEET_SCORE_TYPE.DISTANCE]: Object.freeze({
    scale: 100,
    unit: '米',
    maxDecimals: 3,
    round: 'truncate', // 截断到厘米（TR25）
    min: 1,
    max: 10000, // 100 米
  }),
  [MEET_SCORE_TYPE.HEIGHT]: Object.freeze({
    scale: 100,
    unit: '米',
    maxDecimals: 3,
    round: 'truncate',
    min: 1,
    max: 500, // 5 米
  }),
  [MEET_SCORE_TYPE.COUNT]: Object.freeze({
    scale: 1,
    unit: '次',
    maxDecimals: 0,
    round: 'reject-extra',
    min: 0,
    max: 10000,
  }),
  [MEET_SCORE_TYPE.SCORE]: Object.freeze({
    scale: 10,
    unit: '分',
    maxDecimals: 1,
    round: 'reject-extra',
    min: 0,
    max: 1000, // 100.0 分
  }),
  [MEET_SCORE_TYPE.VERSUS]: Object.freeze({
    scale: 1,
    unit: null,
    maxDecimals: 0,
    round: 'none',
    min: null,
    max: null,
  }),
});

/** 拒绝原因 → 可直接展示给裁判的中文（页面不再另写一套文案）。 */
const REASON_TEXT = Object.freeze({
  'not-a-number': '请只填数字',
  empty: '请填写成绩',
  'too-many-decimals': '小数位数超出该项目允许的精度',
  'out-of-range': '成绩超出该项目的合法范围',
  'versus-not-measured': '胜负项目不录入数值成绩，请用赛制名次',
  'unknown-score-type': '未知的成绩类型',
});

function fail(reason, detail) {
  return { ok: false, reason, message: REASON_TEXT[reason] || '成绩无效', detail: detail || null };
}

/** 全角数字与小数点转半角。 */
function toHalfWidth(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  }
  return out;
}

/**
 * 校验并归一一条成绩。
 *
 * @param {string} scoreType MEET_SCORE_TYPE 之一
 * @param {string|number} raw 裁判输入
 * @returns {{ok:true,scoreType:string,scaled:number,text:string,unit:string|null}
 *          |{ok:false,reason:string,message:string,detail:*}}
 */
function normalizeMeasure(scoreType, raw) {
  const rule = MEASURE_RULES[scoreType];
  if (!rule) return fail('unknown-score-type', scoreType);
  if (scoreType === MEET_SCORE_TYPE.VERSUS) return fail('versus-not-measured');

  const source = typeof raw === 'number' ? String(raw) : String(raw == null ? '' : raw);
  const text = toHalfWidth(source).trim().replace(/\s+/g, '');
  if (!text) return fail('empty');

  // 只接受十进制字面量：0、38、12.34；不接受负号、指数、千分位。
  const matched = /^(\d{1,9})(?:\.(\d+))?$/.exec(text);
  if (!matched) return fail('not-a-number', text);

  const intPart = matched[1];
  const fracPart = matched[2] || '';

  if (fracPart.length > rule.maxDecimals) {
    return fail('too-many-decimals', { allowed: rule.maxDecimals, given: fracPart.length });
  }

  const decimals = String(rule.scale).length - 1; // 100 → 2 位，10 → 1 位，1 → 0 位
  // 截断（truncate）与补齐在这里是同一个动作：先补零到 scale 位，再切前 scale 位。
  // 对距离/高度来说，「输入 6.789」补零后切 2 位即 6.78，正是 TR25 的截断。
  const padded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const scaled = Number(intPart) * rule.scale + (padded ? Number(padded) : 0);

  if (!Number.isSafeInteger(scaled)) return fail('out-of-range', text);
  if (scaled < rule.min || scaled > rule.max) {
    return fail('out-of-range', { min: rule.min, max: rule.max, scaled });
  }

  return {
    ok: true,
    scoreType,
    scaled,
    text: formatMeasure(scoreType, scaled),
    unit: rule.unit,
  };
}

/**
 * 把缩放整数还原为展示文本。
 * 计时与距离/高度固定 2 位（12.30、6.78），评分 1 位（88.5），次数整数。
 */
function formatMeasure(scoreType, scaled) {
  if (!Number.isFinite(scaled)) return null;
  if (scoreType === MEET_SCORE_TYPE.VERSUS) return null;

  const rule = MEASURE_RULES[scoreType];
  if (!rule) return null;

  if (scoreType === MEET_SCORE_TYPE.COUNT) return String(scaled);

  const decimals = String(rule.scale).length - 1;
  const unit = rule.scale;
  const whole = Math.trunc(scaled / unit);
  const rest = Math.abs(scaled - whole * unit);
  return `${whole}.${String(rest).padStart(decimals, '0')}`;
}

/**
 * 按方向比较两条已归一成绩（入参是 `scaled` 整数）。
 *
 * 返回负数表示 a 排名更前。以下情况返回 **null**（不可比较），
 * 调用方必须自己决定「无成绩」怎么排，不能把它当 0：
 *   - 任一侧为 null / undefined / NaN；
 *   - 胜负项目（order 为 bracket），名次来自赛制而非数值。
 */
function compareMeasure(a, b, order) {
  if (order !== MEET_ORDER.ASC && order !== MEET_ORDER.DESC) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return order === MEET_ORDER.ASC ? a - b : b - a;
}

/** 该参赛形态的一条记录是否占用个人兼项额度（D35：single 与 group 占，team 不占）。 */
function countsTowardPersonalQuota(entryForm) {
  return entryForm === MEET_ENTRY_FORM.SINGLE || entryForm === MEET_ENTRY_FORM.GROUP;
}

module.exports = {
  MEASURE_RULES,
  REASON_TEXT,
  normalizeMeasure,
  formatMeasure,
  compareMeasure,
  countsTowardPersonalQuota,
};
