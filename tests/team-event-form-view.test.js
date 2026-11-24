/**
 * P-04：团队赛事建赛表单的声明驱动配置。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { eventFormConfigOf } = require('../miniprogram/packageTeam/services/team-event-form-view.js');
const {
  registerAssociationWithAdapter,
  unregisterSportAdapter,
} = require('../miniprogram/shared/sports/registry.js');
const {
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
} = require('../miniprogram/shared/associations/registry.js');
const { createSportAdapter } = require('../src/shared/sports/contract.js');

test('建赛表单配置由 SportAdapter.rules.presetOptions 驱动', () => {
  const basketball = eventFormConfigOf('bk');
  assert.equal(basketball.mode, 'basketball');
  assert.ok(basketball.presets.length >= 2);
  assert.ok(basketball.presets.some(item => item.key === basketball.defaultPresetKey));

  const football = eventFormConfigOf('fb');
  assert.equal(football.mode, 'football');

  assert.deepEqual(eventFormConfigOf('unknown_association'), {
    mode: 'unsupported', presets: [], defaultPresetKey: '',
  });
});

test('动态排球协会无需改页面即可获得建赛预设', () => {
  const format = 'volleyball_form6';
  const assoc = 'vb_form_test';
  const adapter = createSportAdapter({
    meta: {
      sportFormat: format,
      sportKey: 'volleyball_form',
      supportsLiveScore: false,
      supportsMatchData: true,
      supportsRedraw: true,
      allowsDraw: false,
      defaultMatchTimeFromEvent: true,
    },
    rules: {
      defaultPresetKey: 'vb-bo5',
      presetOptions: [
        { key: 'vb-bo5', label: '五局三胜' },
        { key: 'vb-bo3', label: '三局两胜' },
      ],
      defaultRules: () => ({ sets: 5 }),
      normalizeRules: input => input || { sets: 5 },
      formatRules: () => '五局三胜',
    },
    standings: { computeTable: () => [] },
    view: { eventFormMode: 'volleyball' },
  });
  registerAssociationWithAdapter({
    id: assoc,
    name: '表单测试排球协会',
    shortName: '表单排球',
    sportName: '排球',
    sportKey: 'volleyball_form',
    logoGlyph: '排',
    logoIcon: '/assets/assoc/vb.png',
    theme: { primary: '#2563EB', primaryDark: '#1D4ED8', primaryLight: '#DBEAFE', accent: '#FACC15' },
    sportType: SPORT_TYPE.TEAM,
    teamSportFormat: format,
    rulesKey: 'volleyballRules',
    volleyballRules: { sportFormat: format, sets: 5, pointsPerSet: 25 },
    capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.EVENTS],
    status: 'active',
  }, adapter);
  try {
    const config = eventFormConfigOf(assoc);
    assert.equal(config.mode, 'volleyball');
    assert.deepEqual(config.presets.map(item => item.key), ['vb-bo5', 'vb-bo3']);
    assert.equal(config.defaultPresetKey, 'vb-bo5');
  } finally {
    unregisterSportAdapter(format);
    unregisterAssociationPlugin(assoc);
  }
});
