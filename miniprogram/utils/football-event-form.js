/** 足球建赛表单模型。仅处理表单与请求组装，不读写数据，也不注册协会。
 * 原始数字保留字符串，使清空输入框后能够显示错误而不是悄悄恢复默认值。
 */
const {
  DEFAULT_PRESET_KEY, RULE_PRESETS, TIE_BREAK, RANKING_POLICY,
  normalizeFootballRules, formatFootballRules,
} = require('../shared/utils/football-rules.js');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const FORMATS = Object.freeze([
  { value: 'single_elim', label: '单淘汰赛' }, { value: 'round_robin', label: '单循环赛' },
]);
const NUMBER_FIELDS = Object.freeze({
  halfMinutes: ['每半场时长', 1, 45], halfTimeMinutes: ['中场休息', 1, 15],
  eventRosterMin: ['赛事报名人数下限', 7, 28], eventRosterMax: ['赛事报名人数上限', 7, 28],
  matchRosterMax: ['单场报名人数上限', 7, 26],
  extraTimeHalfMinutes: ['每半场加时时长', 1, 15],
});
const BOOLEAN_FIELDS = ['halfTimeCountsAsOpportunity', 'returnAllowed', 'extraTimeAdditional'];
const EDITABLE_FIELDS = ['name', 'format', ...Object.keys(NUMBER_FIELDS), ...BOOLEAN_FIELDS,
  'substitutionLimit', 'substitutionOpportunities', 'knockoutTieBreak', 'rankingPolicy'];

function createFootballEventForm(presetKey = DEFAULT_PRESET_KEY) {
  const rules = normalizeFootballRules({ presetKey });
  if (!rules) return null;
  const s = rules.substitutions;
  return {
    name: '', format: 'single_elim', presetKey,
    halfMinutes: String(rules.halfMinutes), halfTimeMinutes: String(rules.halfTimeMinutes),
    eventRosterMin: String(rules.eventRosterMin), eventRosterMax: String(rules.eventRosterMax),
    matchRosterMax: String(rules.matchRosterMax),
    substitutionLimit: String(s.limit), substitutionOpportunities: String(s.opportunities),
    halfTimeCountsAsOpportunity: s.halfTimeCountsAsOpportunity, returnAllowed: s.returnAllowed,
    knockoutTieBreak: rules.knockoutTieBreak,
    extraTimeHalfMinutes: String(rules.extraTime ? rules.extraTime.halfMinutes : 15),
    extraTimeAdditional: s.extraTimeAdditionalPlayers === 1,
    rankingPolicy: rules.rankingPolicy,
  };
}

function setFootballEventField(form, field, value) {
  if (!form || !EDITABLE_FIELDS.includes(field)) return null;
  if (BOOLEAN_FIELDS.includes(field) ? typeof value !== 'boolean' : typeof value !== 'string') return null;
  const next = { ...form, [field]: value };
  // 直接点球没有加时额外名额，切换该模式时明确清掉不适用的开关。
  if (field === 'knockoutTieBreak' && value === TIE_BREAK.DIRECT) next.extraTimeAdditional = false;
  return next;
}

function hasCustomFootballRules(form) {
  const original = form && createFootballEventForm(form.presetKey);
  if (!original) return false;
  return EDITABLE_FIELDS.filter(key => key !== 'name' && key !== 'format')
    .some(key => form[key] !== original[key]);
}

/** 覆盖自定义设置需要先在界面确认；名称与赛制始终保留。 */
function applyFootballPreset(form, presetKey, confirmed = false) {
  const next = createFootballEventForm(presetKey);
  if (!form || !next) return { ok: false, message: '规则预设不存在' };
  if (form.presetKey === presetKey) return { ok: true, form: clone(form) };
  if (hasCustomFootballRules(form) && !confirmed) return { ok: false, needsConfirmation: true };
  return { ok: true, form: { ...next, name: form.name, format: form.format } };
}

const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => typeof value === 'string'
  && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;

function validateFootballEventForm(form) {
  const errors = {};
  if (!form || !own(RULE_PRESETS, form.presetKey)) {
    return { ok: false, errors: { presetKey: '请选择有效规则预设' }, message: '请选择有效规则预设', rules: null, payload: null, summary: '' };
  }
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  if (name.length < 2 || name.length > 30) errors.name = '赛事名称需为 2–30 个字';
  if (!FORMATS.some(item => item.value === form.format)) errors.format = '请选择单淘汰赛或单循环赛';
  const extraTimeEnabled = form.format === 'single_elim' && form.knockoutTieBreak === TIE_BREAK.EXTRA_TIME;
  const extraTimeAdditional = extraTimeEnabled && form.extraTimeAdditional === true;
  for (const [key, [label, min, max]] of Object.entries(NUMBER_FIELDS)) {
    if (key === 'extraTimeHalfMinutes' && !extraTimeEnabled) continue;
    if (!integer(form[key], min, max)) errors[key] = `${label}需为 ${max ? `${min}–${max} 的` : `不小于 ${min} 的`}整数`;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof form[key] !== 'boolean') errors[key] = '请选择有效开关设置';
  }
  if (form.substitutionLimit !== 'all_named' && !integer(form.substitutionLimit, 0)) errors.substitutionLimit = '换人额度需为非负整数或全部列名替补';
  if (form.substitutionOpportunities !== 'unlimited' && !integer(form.substitutionOpportunities, 0)) errors.substitutionOpportunities = '换人机会需为非负整数或不限';
  if (!Object.values(TIE_BREAK).includes(form.knockoutTieBreak)) errors.knockoutTieBreak = '请选择有效平局决胜方式';
  if (!Object.values(RANKING_POLICY).includes(form.rankingPolicy)) errors.rankingPolicy = '请选择有效同分排序规则';
  if (!errors.eventRosterMin && !errors.eventRosterMax && Number(form.eventRosterMin) > Number(form.eventRosterMax)) {
    errors.eventRosterMin = '报名人数下限不能大于上限';
  }
  if (!errors.eventRosterMax && !errors.matchRosterMax && Number(form.matchRosterMax) > Number(form.eventRosterMax)) {
    errors.matchRosterMax = '单场报名人数不能超过赛事报名人数上限';
  }
  if (extraTimeAdditional && (form.substitutionLimit === 'all_named'
    || form.substitutionOpportunities === 'unlimited')) errors.extraTimeAdditional = '额外名额仅适用于启用加时且换人额度、机会均有限的比赛';
  if (!errors.substitutionLimit && !errors.matchRosterMax && !form.returnAllowed && form.substitutionLimit !== 'all_named'
    && Number(form.substitutionLimit) + (extraTimeAdditional ? 1 : 0) > Number(form.matchRosterMax) - 7) {
    errors.substitutionLimit = '换人额度超过单场名单可提供的替补人数';
  }
  if (form.substitutionLimit === '0' && (form.substitutionOpportunities !== '0' || extraTimeAdditional)) {
    errors.substitutionOpportunities = '禁止换人时，换人机会也应设为 0，且不增加加时名额';
  }
  const rules = normalizeFootballRules({
    presetKey: form.presetKey,
    halfMinutes: form.halfMinutes, halfTimeMinutes: form.halfTimeMinutes,
    eventRosterMin: form.eventRosterMin, eventRosterMax: form.eventRosterMax, matchRosterMax: form.matchRosterMax,
    substitutions: {
      limit: form.substitutionLimit, opportunities: form.substitutionOpportunities,
      halfTimeCountsAsOpportunity: form.halfTimeCountsAsOpportunity, returnAllowed: form.returnAllowed,
      extraTimeAdditionalPlayers: extraTimeAdditional ? 1 : 0,
      extraTimeAdditionalOpportunities: extraTimeAdditional ? 1 : 0,
    },
    knockoutTieBreak: form.format === 'round_robin' ? TIE_BREAK.DIRECT : form.knockoutTieBreak,
    extraTime: extraTimeEnabled ? { halfMinutes: form.extraTimeHalfMinutes } : null,
    rankingPolicy: form.rankingPolicy,
  });
  if (!rules && Object.keys(errors).length === 0) errors.rules = '规则配置不兼容，请检查人数、换人和加时设置';
  const summary = rules ? formatFootballRules(rules, form.format) : '';
  const ok = Object.keys(errors).length === 0;
  return {
    ok, errors, message: Object.values(errors)[0] || '', rules, summary,
    payload: ok ? { name, format: form.format, sportFormat: 'football11', presetKey: form.presetKey, rules } : null,
  };
}

function footballEventFormView(form, showErrors = false) {
  const result = validateFootballEventForm(form);
  const fields = [];
  const add = (key, label, kind, options = null, note = '') => {
    const current = form[key];
    const choices = options && options.map(item => ({ ...item }));
    fields.push({ key, label, kind, value: current, note,
      error: showErrors ? result.errors[key] || '' : '', options: choices,
      selectedIndex: choices ? Math.max(0, choices.findIndex(item => item.value === current)) : 0,
      selectedLabel: choices ? (choices.find(item => item.value === current) || { label: '请选择' }).label : '',
    });
  };
  add('name', '赛事名称', 'text');
  add('format', '赛制', 'select', FORMATS);
  add('halfMinutes', '每半场时长（分钟）', 'number');
  add('halfTimeMinutes', '中场休息（分钟）', 'number');
  add('eventRosterMin', '赛事报名人数下限', 'number');
  add('eventRosterMax', '赛事报名人数上限', 'number');
  add('matchRosterMax', '单场报名人数上限', 'number', null, '赛事总名单与单场名单分别设置，单场最多 26 人');
  add('substitutionLimit', `换人额度（${form.returnAllowed ? '人次' : '人'}）`, 'quota', [
    { value: 'count', label: '指定额度' }, { value: 'all_named', label: '全部列名替补' },
  ]);
  add('substitutionOpportunities', '比赛中换人机会', 'quota', [
    { value: 'count', label: '指定次数' }, { value: 'unlimited', label: '不限' },
  ]);
  add('halfTimeCountsAsOpportunity', '中场换人计入机会', 'switch');
  add('returnAllowed', '允许换下再次上场', 'switch', null, '开启后采用校园复入规程，换人额度按替换人次解释');
  if (form.format === 'single_elim') {
    add('knockoutTieBreak', '平局决胜方式', 'select', [
      { value: TIE_BREAK.DIRECT, label: '直接点球' }, { value: TIE_BREAK.EXTRA_TIME, label: '先加时再点球' },
    ]);
  }
  if (form.format === 'single_elim' && form.knockoutTieBreak === TIE_BREAK.EXTRA_TIME) {
    add('extraTimeHalfMinutes', '每半场加时时长（分钟）', 'number');
    add('extraTimeAdditional', '加时额外换 1 人并增加 1 个换人机会', 'switch');
  }
  add('rankingPolicy', '同分排序', 'select', [
    { value: RANKING_POLICY.GOAL_DIFFERENCE, label: '净胜球优先' },
    { value: RANKING_POLICY.HEAD_TO_HEAD, label: '相互战绩优先' },
  ]);
  fields.forEach(field => {
    if (field.kind !== 'quota') return;
    const sentinel = field.key === 'substitutionLimit' ? 'all_named' : 'unlimited';
    field.selectedIndex = field.value === sentinel ? 1 : 0;
    field.selectedLabel = field.options[field.selectedIndex].label;
    field.showNumber = field.value !== sentinel;
  });
  const preset = RULE_PRESETS[form.presetKey] || null;
  return {
    fields, summary: result.summary,
    error: showErrors ? result.message : '',
    customized: hasCustomFootballRules(form),
    presetOptions: Object.entries(RULE_PRESETS).map(([value, item]) => ({ value, label: item.label })),
    presetIndex: preset ? Object.keys(RULE_PRESETS).indexOf(form.presetKey) : -1,
    presetLabel: preset ? preset.label : '',
  };
}

module.exports = {
  createFootballEventForm, setFootballEventField, hasCustomFootballRules,
  applyFootballPreset, validateFootballEventForm, footballEventFormView,
};
