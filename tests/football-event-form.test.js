const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createFootballEventForm: create, setFootballEventField: update, applyFootballPreset: preset,
  hasCustomFootballRules: customized, validateFootballEventForm: validate, footballEventFormView: view,
} = require('../miniprogram/utils/football-event-form');
const { STANDARD_PRESET_KEY, DEFAULT_PRESET_KEY, TIE_BREAK } = require('../src/shared/utils/football-rules');
const ready = () => ({ ...create(), name: ' 自由组队足球杯 ' });

test('足球表单产生完整请求、保留单双名单边界，预览不改变草稿', () => {
  const form = ready();
  const before = JSON.stringify(form);
  const result = validate(form);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.payload.name, '自由组队足球杯');
  assert.equal(result.payload.sportFormat, 'football11');
  assert.equal(result.payload.rules.halfMinutes, 40);
  assert.equal(result.payload.rules.eventRosterMin, 11);
  assert.equal(result.payload.rules.eventRosterMax, 22);
  assert.equal(result.payload.rules.matchRosterMax, 22);
  assert.equal(result.payload.rules.scoringMode, 'post_match');
  assert.match(result.summary, /直接点球/);
  assert.equal(JSON.stringify(form), before);
  assert.equal(create('typo'), null);
});

test('足球表单清空/非法数字不回填默认，错误定位具体字段', () => {
  for (const [field, value] of [['halfMinutes', ''], ['halfTimeMinutes', '16'], ['eventRosterMin', '6'],
    ['eventRosterMax', '-1'], ['matchRosterMax', '27'], ['substitutionLimit', '3.5'], ['substitutionOpportunities', ' ']]) {
    const form = update(ready(), field, value);
    const result = validate(form);
    assert.equal(result.ok, false, `${field}=${value}`);
    assert.ok(result.errors[field], `${field}=${value}`);
    assert.equal(result.payload, null);
  }
  assert.equal(update(ready(), 'presetKey', STANDARD_PRESET_KEY), null);
  assert.equal(update(ready(), '__proto__', 'x'), null);
  assert.equal(update(ready(), 'returnAllowed', 'true'), null);
  assert.equal(update(ready(), 'name', 123), null);
});

test('足球表单人数上下限、换人容量、禁止换人和加时的组合校验', () => {
  for (const [changes, field] of [
    [{ eventRosterMin: '23' }, 'eventRosterMin'],
    [{ eventRosterMax: '18', matchRosterMax: '22' }, 'matchRosterMax'],
    [{ matchRosterMax: '11', substitutionLimit: '5' }, 'substitutionLimit'],
    [{ substitutionLimit: '0', substitutionOpportunities: '3' }, 'substitutionOpportunities'],
    [{ knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTimeAdditional: true, substitutionOpportunities: 'unlimited' }, 'extraTimeAdditional'],
  ]) {
    const result = validate({ ...ready(), ...changes });
    assert.equal(result.ok, false); assert.ok(result.errors[field], JSON.stringify(result));
  }
  const zero = validate({ ...ready(), matchRosterMax: '7', substitutionLimit: '0', substitutionOpportunities: '0' });
  assert.equal(zero.ok, true, zero.message);
  const returns = validate({ ...ready(), returnAllowed: true, substitutionLimit: 'all_named', substitutionOpportunities: 'unlimited' });
  assert.equal(returns.ok, true); assert.match(returns.summary, /校园/);
});

test('足球表单切换预设需保护自定义值，确认后保留名称和赛制', () => {
  const form = { ...ready(), format: 'round_robin', halfMinutes: '35' };
  const before = JSON.stringify(form);
  assert.equal(customized(form), true);
  assert.equal(preset(form, STANDARD_PRESET_KEY).needsConfirmation, true);
  assert.equal(JSON.stringify(form), before);
  const next = preset(form, STANDARD_PRESET_KEY, true).form;
  assert.equal(next.name, form.name); assert.equal(next.format, 'round_robin'); assert.equal(next.halfMinutes, '45');
  assert.equal(customized(next), false);
  assert.equal(preset(form, 'bad', true).ok, false);
  assert.equal(customized({ ...create(), name: '修改名称', format: 'round_robin' }), false);
  assert.equal(preset(form, DEFAULT_PRESET_KEY).form.halfMinutes, '35', '重选当前预设不丢自定义值');
});

test('循环赛隐藏决胜与加时字段，隐藏值不阻塞创建，也不进入规则摘要', () => {
  const form = { ...create(STANDARD_PRESET_KEY), name: '循环联赛', format: 'round_robin',
    extraTimeHalfMinutes: '', extraTimeAdditional: true };
  const result = validate(form);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.payload.rules.extraTime, null);
  assert.equal(result.payload.rules.substitutions.extraTimeAdditionalPlayers, 0);
  assert.match(result.summary, /允许平局/);
  assert.doesNotMatch(result.summary, /淘汰赛|加时|点球各/);
  const keys = view(form).fields.map(field => field.key);
  assert.equal(keys.includes('knockoutTieBreak'), false);
  assert.equal(keys.includes('extraTimeHalfMinutes'), false);
});

test('足球表单动态字段说明、摘要与错误只在需要时展示', () => {
  const empty = create();
  assert.equal(view(empty).error, '');
  assert.match(view(empty, true).error, /名称/);
  const form = { ...ready(), knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTimeHalfMinutes: '10',
    extraTimeAdditional: true, returnAllowed: true };
  const result = validate(form);
  assert.equal(result.ok, true);
  assert.equal(result.rules.extraTime.halfMinutes, 10);
  const fields = view(form).fields;
  assert.ok(fields.some(field => field.key === 'extraTimeAdditional'));
  assert.match(fields.find(field => field.key === 'substitutionLimit').label, /人次/);
  const limited = fields.find(field => field.key === 'substitutionOpportunities');
  assert.equal(limited.showNumber, true);
  assert.equal(limited.selectedLabel, '指定次数');
  const direct = update(form, 'knockoutTieBreak', TIE_BREAK.DIRECT);
  assert.equal(direct.extraTimeAdditional, false);
  assert.equal(validate(direct).rules.extraTime, null);
});

test('非法 presetKey 的预览不抛 TypeError，退回空标签', () => {
  const form = { ...ready(), presetKey: 'missing-preset' };
  const preview = view(form);
  assert.equal(preview.presetLabel, '');
  assert.equal(preview.presetIndex, -1);
});
