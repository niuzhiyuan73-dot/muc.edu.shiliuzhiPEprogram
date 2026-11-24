/**
 * P-01/P-02 插件完整性：协会声明与 SportAdapter 必须成对存在。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  allAssociations,
  isKnownAssociation,
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
} = require('../src/shared/associations/registry.js');
const {
  getSportAdapterFor,
  listSportAdapters,
  registerAssociationWithAdapter,
  unregisterSportAdapter,
} = require('../src/shared/sports/registry.js');
const { createSportAdapter } = require('../src/shared/sports/contract.js');
const { ASSOCIATION_STATUS } = require('../src/shared/utils/constants.js');

function adapterOf(sportFormat, sportKey) {
  return createSportAdapter({
    meta: {
      sportFormat,
      sportKey,
      supportsLiveScore: false,
      supportsMatchData: true,
      supportsRedraw: true,
      allowsDraw: false,
      defaultMatchTimeFromEvent: true,
    },
    rules: {
      defaultPresetKey: 'default',
      defaultRules: () => ({ preset: 'default' }),
      normalizeRules: input => input || { preset: 'default' },
      formatRules: () => '默认规则',
    },
    standings: { computeTable: () => [] },
    view: { eventFormMode: 'volleyball' },
  });
}

function teamPlugin(overrides = {}) {
  return {
    id: 'vb_integrity',
    name: '完整性测试排球协会',
    shortName: '完整性排球',
    sportName: '排球',
    sportKey: 'volleyball_integrity',
    logoGlyph: '排',
    logoIcon: '/assets/assoc/vb.png',
    theme: { primary: '#2563EB', primaryDark: '#1D4ED8', primaryLight: '#DBEAFE', accent: '#FACC15' },
    sportType: SPORT_TYPE.TEAM,
    teamSportFormat: 'volleyball_integrity6',
    rulesKey: 'volleyballRules',
    volleyballRules: { sportFormat: 'volleyball_integrity6', sets: 5, pointsPerSet: 25 },
    capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.EVENTS],
    status: ASSOCIATION_STATUS.ACTIVE,
    ...overrides,
  };
}

test('每个启用中的团队协会都能取到 SportAdapter', () => {
  const teamAssociations = allAssociations().filter(
    assoc => assoc.sportType === SPORT_TYPE.TEAM && assoc.status === ASSOCIATION_STATUS.ACTIVE,
  );
  assert.ok(teamAssociations.length >= 2);
  for (const assoc of teamAssociations) {
    assert.ok(getSportAdapterFor(assoc.id), `${assoc.id} 缺少可用的 SportAdapter`);
  }
});

test('每个 SportAdapter 都能由对应运动的团队协会取得', () => {
  const associations = allAssociations().filter(assoc => assoc.sportType === SPORT_TYPE.TEAM);
  for (const adapter of listSportAdapters()) {
    assert.ok(
      associations.some(assoc => getSportAdapterFor(assoc.id) === adapter),
      `${adapter.meta.sportFormat} 缺少匹配的团队协会`,
    );
  }
});

test('联合注册拒绝 sportKey 不一致，两个注册表均不变', () => {
  const plugin = teamPlugin();
  const adapter = adapterOf(plugin.teamSportFormat, 'other_sport');
  assert.throws(() => registerAssociationWithAdapter(plugin, adapter), /sportKey 不一致/);
  assert.equal(isKnownAssociation(plugin.id), false);
  assert.equal(listSportAdapters().includes(adapter), false);
});

test('协会与适配器同时注册：适配器失败时协会回滚，不留下半套状态', () => {
  // basketball5 是内置格式，registerSportAdapter 必然抛“已存在”，
  // 用它验证 helper 在第二步失败后会注销第一步的协会。
  const plugin = teamPlugin({
    id: 'vb_rollback',
    sportKey: 'volleyball_rollback',
    teamSportFormat: 'basketball5',
    volleyballRules: { sportFormat: 'basketball5', sets: 5 },
  });
  assert.throws(
    () => registerAssociationWithAdapter(plugin, adapterOf(plugin.teamSportFormat, plugin.sportKey)),
    /已存在/,
  );
  assert.equal(isKnownAssociation('vb_rollback'), false, '适配器注册失败后协会必须回滚');
});

test('协会与适配器同时注册：成功后两者都可查询，注销顺序与注册相反', () => {
  const plugin = teamPlugin();
  const adapter = adapterOf('volleyball_integrity6', 'volleyball_integrity');
  registerAssociationWithAdapter(plugin, adapter);
  try {
    assert.equal(isKnownAssociation('vb_integrity'), true);
    assert.equal(getSportAdapterFor('vb_integrity').meta.sportFormat, 'volleyball_integrity6');
  } finally {
    unregisterSportAdapter('volleyball_integrity6');
    unregisterAssociationPlugin('vb_integrity');
  }
});
