const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PRESET_KEY, STANDARD_PRESET_KEY, RULE_PRESETS, TIE_BREAK,
  presetOf, defaultRulesFor, normalizeFootballRules: normalize, formatFootballRules,
} = require('../src/shared/utils/football-rules');

test('足球校园与标准时长两套预设，快照可独立序列化且归一化幂等', () => {
  const campus = normalize({ presetKey: DEFAULT_PRESET_KEY });
  assert.equal(campus.halfMinutes, 40);
  assert.equal(campus.halfTimeMinutes, 10);
  assert.equal(campus.eventRosterMin, 11);
  assert.equal(campus.eventRosterMax, 22);
  assert.equal(campus.matchRosterMax, 22);
  assert.equal(campus.minOnField, 7);
  assert.equal(campus.substitutions.limit, 5);
  assert.equal(campus.substitutions.opportunities, 3);
  assert.equal(campus.knockoutTieBreak, TIE_BREAK.DIRECT);
  assert.equal(campus.extraTime, null);
  assert.equal(campus.scoringMode, 'post_match');
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(campus))), campus);
  const standard = normalize({ presetKey: STANDARD_PRESET_KEY });
  assert.equal(standard.halfMinutes, 45);
  assert.equal(standard.halfTimeMinutes, 15);
  assert.deepEqual(standard.extraTime, { halfMinutes: 15 });
  assert.equal(standard.knockoutTieBreak, TIE_BREAK.EXTRA_TIME);
  assert.deepEqual(normalize(standard), standard);
});

test('足球预设深拷贝与默认规则不会污染下一份赛事', () => {
  const a = presetOf();
  a.substitutions.limit = 99;
  a.leaguePoints.win = 9;
  const b = presetOf(STANDARD_PRESET_KEY);
  b.extraTime.halfMinutes = 1;
  assert.equal(defaultRulesFor().substitutions.limit, 5);
  assert.equal(RULE_PRESETS[DEFAULT_PRESET_KEY].leaguePoints.win, 3);
  assert.equal(presetOf(STANDARD_PRESET_KEY).extraTime.halfMinutes, 15);
  assert.equal(defaultRulesFor('football7'), null);
  assert.equal(presetOf('fiba-4x10'), null);
});

test('足球自定义表单整数字符串、单场与赛事名单分开、嵌套配置按预设补齐', () => {
  const input = { sportFormat: 'football11', halfMinutes: '35', halfTimeMinutes: '5',
    eventRosterMax: '28', matchRosterMax: '18', substitutions: { limit: '7' } };
  const before = JSON.stringify(input);
  const r = normalize(input);
  assert.equal(r.halfMinutes, 35);
  assert.equal(r.eventRosterMax, 28);
  assert.equal(r.matchRosterMax, 18);
  assert.equal(r.substitutions.limit, 7);
  assert.equal(r.substitutions.opportunities, 3);
  assert.equal(JSON.stringify(input), before);
});

const badInputs = [
  ['空对象', {}], ['空值', null], ['数组', []],
  ['错误预设', { presetKey: 'campuz' }], ['原型键预设', { presetKey: '__proto__' }],
  ['空预设', { presetKey: '' }], ['篮球制式', { sportFormat: 'basketball5' }],
  ['七人制', { sportFormat: 'football7' }], ['拼错字段', { halfMinute: 30 }],
  ['半场过长', { halfMinutes: 46 }], ['小数', { halfMinutes: 35.5 }],
  ['空字符串', { halfMinutes: '' }], ['纯空白', { halfTimeMinutes: ' ' }],
  ['布尔时间', { halfMinutes: true }], ['null 时间', { halfTimeMinutes: null }],
  ['指数文本', { halfMinutes: '4e1' }], ['超长中场', { halfTimeMinutes: 16 }],
  ['不足七人', { eventRosterMin: 6 }], ['上下限颠倒', { eventRosterMin: 23 }],
  ['单场超过赛事名单', { eventRosterMax: 18 }], ['单场过大', { eventRosterMax: 30, matchRosterMax: 27 }],
  ['非法场上人数', { onFieldMax: 12 }], ['非法最低人数', { minOnField: 6 }],
  ['嵌套空值', { substitutions: null }], ['布尔文本', { substitutions: { returnAllowed: 'false' } }],
  ['换人负数', { substitutions: { limit: -1 } }], ['机会小数', { substitutions: { opportunities: 2.5 } }],
  ['超替补容量', { substitutions: { limit: 16 } }], ['禁换但有机会', { substitutions: { limit: 0 } }],
  ['非法平局模式', { knockoutTieBreak: 'replay' }], ['直接点球却填加时', { extraTime: { halfMinutes: 15 } }],
  ['加时为空', { knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTime: null }],
  ['加时太长', { knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTime: { halfMinutes: 16 } }],
  ['加时漏时长', { knockoutTieBreak: TIE_BREAK.EXTRA_TIME, extraTime: {} }],
  ['未开加时给额外名额', { substitutions: { extraTimeAdditionalPlayers: 1, extraTimeAdditionalOpportunities: 1 } }],
  ['额外名额机会不配对', { knockoutTieBreak: TIE_BREAK.EXTRA_TIME, substitutions: { extraTimeAdditionalPlayers: 1 } }],
  ['不限机会再加一', { knockoutTieBreak: TIE_BREAK.EXTRA_TIME,
    substitutions: { opportunities: 'unlimited', extraTimeAdditionalPlayers: 1, extraTimeAdditionalOpportunities: 1 } }],
  ['擅改积分', { leaguePoints: { win: 2 } }], ['未知排名政策', { rankingPolicy: 'id_wins' }],
  ['非法点球程序', { shootoutInitialKicks: 3 }], ['实时计分', { scoringMode: 'live' }],
  ['篮球字段', { personalFoulLimit: 5 }], ['未知规则版本', { ruleVersion: 'football11-v2' }],
  ['非法数值', { eventRosterMax: Number.MAX_SAFE_INTEGER + 1 }],
];
for (const [label, overrides] of badInputs) {
  test(`足球非法配置拒绝：${label}`, () => {
    const input = overrides && !Array.isArray(overrides) && Object.keys(overrides).length
      ? { sportFormat: 'football11', ...overrides } : overrides;
    assert.equal(normalize(input), null);
  });
}

test('足球加时可选且切换模式不残留另一预设的阶段', () => {
  const extra = normalize({ presetKey: DEFAULT_PRESET_KEY, knockoutTieBreak: TIE_BREAK.EXTRA_TIME,
    substitutions: { extraTimeAdditionalPlayers: 1, extraTimeAdditionalOpportunities: 1 } });
  assert.deepEqual(extra.extraTime, { halfMinutes: 15 });
  assert.equal(extra.substitutions.extraTimeAdditionalPlayers, 1);
  const direct = normalize({ presetKey: STANDARD_PRESET_KEY, knockoutTieBreak: TIE_BREAK.DIRECT });
  assert.equal(direct.extraTime, null);
  assert.deepEqual(normalize({ ...extra, extraTime: { halfMinutes: '10' } }).extraTime, { halfMinutes: 10 });
});

test('足球基层自定义换人与禁止换人均可明确保存，摘要完整说明口径', () => {
  const r = normalize({ sportFormat: 'football11', substitutions: {
    limit: 'all_named', opportunities: 'unlimited', returnAllowed: true, halfTimeCountsAsOpportunity: true,
  } });
  assert.ok(r);
  const text = formatFootballRules(r);
  for (const term of ['40 分钟', '中场休息 10', '11–22', '单场最多 22', '机会不限', '复入', '中场换人占机会', '直接点球', '胜 3', '赛后录分', '校园']) {
    assert.ok(text.includes(term), `${term} 缺失：${text}`);
  }
  assert.equal(formatFootballRules({ sportFormat: 'football7' }), '');
  assert.ok(normalize({ sportFormat: 'football11', matchRosterMax: 7, substitutions: { limit: 0, opportunities: 0 } }));
  assert.equal(formatFootballRules(defaultRulesFor()).includes('犯离场'), false);
});
