/**
 * P-03：服务端运动插件动作白名单与动态分派。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSportAdapter } = require('../src/shared/sports/contract.js');
const {
  registerAssociationWithAdapter,
  unregisterSportAdapter,
} = require('../src/shared/sports/registry.js');
const {
  getServerSportPlugin,
  registerServerSportPlugin,
  unregisterServerSportPlugin,
  TEAM_PLUGIN_ACTION_ALLOWLIST,
} = require('../src/server/sports/registry.js');
const { unregisterAssociationPlugin, SPORT_TYPE, CAPABILITY } = require('../src/shared/associations/registry.js');
const { ASSOCIATION_STATUS } = require('../src/shared/utils/constants.js');
const teamHandlers = require('../src/server/services/team-event-service.js');

const FORMAT = 'volleyball_action6';
const ASSOC = 'vb_action_test';

function setup() {
  const adapter = createSportAdapter({
    meta: {
      sportFormat: FORMAT,
      sportKey: 'volleyball_action',
      supportsLiveScore: false,
      supportsMatchData: true,
      supportsRedraw: true,
      allowsDraw: false,
      defaultMatchTimeFromEvent: true,
    },
    rules: {
      defaultPresetKey: 'default',
      defaultRules: () => ({ sets: 5 }),
      normalizeRules: input => input || { sets: 5 },
      formatRules: () => '五局三胜',
    },
    standings: { computeTable: () => [] },
    view: { eventFormMode: 'volleyball' },
  });
  registerAssociationWithAdapter({
    id: ASSOC,
    name: '动作白名单测试排球协会',
    shortName: '动作排球',
    sportName: '排球',
    sportKey: 'volleyball_action',
    logoGlyph: '排',
    logoIcon: '/assets/assoc/vb.png',
    theme: { primary: '#2563EB', primaryDark: '#1D4ED8', primaryLight: '#DBEAFE', accent: '#FACC15' },
    sportType: SPORT_TYPE.TEAM,
    teamSportFormat: FORMAT,
    rulesKey: 'volleyballRules',
    volleyballRules: { sportFormat: FORMAT, sets: 5, pointsPerSet: 25 },
    capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.EVENTS],
    status: ASSOCIATION_STATUS.ACTIVE,
  }, adapter);
}

function cleanup() {
  unregisterServerSportPlugin(FORMAT);
  unregisterSportAdapter(FORMAT);
  unregisterAssociationPlugin(ASSOC);
}

test('内置足球插件的动作与白名单完整对齐，缺项/拼写错误可被发现', () => {
  const football = getServerSportPlugin('football11');
  assert.ok(football, '内置足球插件应已注册');
  const names = Object.keys(football.actions);
  // 白名单是足球这套服务端覆写的全集；少一个都说明实现被误删或白名单拼错。
  assert.deepEqual(names.slice().sort(), TEAM_PLUGIN_ACTION_ALLOWLIST.slice().sort());
  for (const name of names) assert.equal(typeof football.actions[name], 'function');
});

test('服务端插件只能注册白名单动作，核心动作不可覆写', () => {
  assert.ok(TEAM_PLUGIN_ACTION_ALLOWLIST.includes('getTeamRecord'));
  assert.throws(
    () => registerServerSportPlugin({
      sportFormat: 'evil_action6',
      actions: { createTeamEvent: async () => ({ ok: true }) },
    }),
    /白名单/,
  );
  assert.throws(
    () => registerServerSportPlugin({
      sportFormat: 'evil_action7',
      actions: { getTeamRecord: 'not a function' },
    }),
    /必须是函数/,
  );
});

test('白名单动作注册后，通用动作调用会分派到插件', async () => {
  setup();
  try {
    registerServerSportPlugin({
      sportFormat: FORMAT,
      actions: { getTeamRecord: async () => ({ ok: true, data: { hit: 'plugin' } }) },
    });
    const result = await teamHandlers.getTeamRecord({}, { association: ASSOC });
    assert.deepEqual(result, { ok: true, data: { hit: 'plugin' } });
  } finally {
    cleanup();
  }
});
