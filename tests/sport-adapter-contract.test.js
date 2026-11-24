/**
 * 切片 P-02：SportAdapter 公共契约、双插件与服务端运动插件注册表测试
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { validateSportAdapter, createSportAdapter } = require('../src/shared/sports/contract.js');
const {
  getSportAdapter,
  getSportAdapterFor,
  listSportAdapters,
  registerSportAdapter,
  unregisterSportAdapter,
} = require('../src/shared/sports/registry.js');
const {
  getServerSportPlugin,
  getServerSportPluginFor,
  listServerSportPlugins,
  registerServerSportPlugin,
  unregisterServerSportPlugin,
} = require('../src/server/sports/registry.js');
const {
  registerAssociationPlugin,
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
} = require('../src/shared/associations/registry.js');
const { ASSOCIATION_STATUS } = require('../src/shared/utils/constants.js');
const { defaultRulesFor: footballDefaultRules, DEFAULT_PRESET_KEY: FB_PRESET } = require('../src/shared/utils/football-rules.js');

describe('P-02 共享 SportAdapter 公共契约与隔离守卫', () => {
  test('全部已注册 SportAdapter 均满足六组标准契约', () => {
    const adapters = listSportAdapters();
    assert.ok(adapters.length >= 2);
    for (const adapter of adapters) {
      const check = validateSportAdapter(adapter);
      assert.equal(check.ok, true, `${adapter.meta?.sportFormat}: ${check.message}`);
    }
  });

  test('原型链与未知输入安全：均返回 null，不回落默认运动', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'volleyball', '', null]) {
      assert.equal(getSportAdapter(bad), null);
    }
    assert.equal(getSportAdapterFor('pkb'), null);
    assert.equal(getSportAdapterFor('unknown'), null);
    assert.equal(getSportAdapterFor('bk').meta.sportFormat, 'basketball5');
    assert.equal(getSportAdapterFor('fb').meta.sportFormat, 'football11');
  });

  test('跨运动规则隔离：篮球与足球 normalizeRules 互相拒绝', () => {
    const bk = getSportAdapter('basketball5');
    const fb = getSportAdapter('football11');
    assert.equal(bk.rules.normalizeRules(footballDefaultRules()), null);
    assert.equal(bk.rules.normalizeRules({ presetKey: FB_PRESET }), null);
    assert.equal(fb.rules.normalizeRules({ presetKey: 'fiba-4x10' }), null);
    assert.equal(fb.rules.normalizeRules({ periods: 4 }), null);
  });

  test('权限与生命周期契约矩阵：篮球与足球差异精确收口进插件', () => {
    const bk = getSportAdapter('basketball5');
    const fb = getSportAdapter('football11');

    // 队长录分/待审权限差异
    assert.equal(bk.permissions.canRecord({ manage: false, captain: true, isRecorder: false }), true);
    assert.equal(fb.permissions.canRecord({ manage: false, captain: true, isRecorder: false }), false);
    assert.equal(fb.permissions.canRecord({ manage: false, captain: false, isRecorder: true }), true);
    assert.equal(bk.permissions.canSeePending({ manage: false, captain: true, isRecorder: false }), true);
    assert.equal(fb.permissions.canSeePending({ manage: false, captain: true, isRecorder: false }), false);

    // 首发与排期差异
    assert.equal(fb.permissions.canSetLineup({ active: true, manage: false, captain: true, match: { sportDraft: { ok: true } } }), false);
    assert.equal(fb.permissions.canEditSchedule({ manage: true, eventActive: true, match: { status: 'reviewing' } }), false);
    assert.equal(bk.permissions.canEditSchedule({ manage: true, eventActive: true, match: { status: 'reviewing' } }), true);

    // 场次初始扩展与结算拦截
    assert.deepEqual(bk.matchLifecycle.initMatchExtra({ startTime: '2026-10-20T10:00:00Z' }), { matchTime: '2026-10-20T10:00:00Z' });
    const fbExtra = fb.matchLifecycle.initMatchExtra({ rules: footballDefaultRules(), format: 'round_robin' });
    assert.equal(fbExtra.matchTime, null);
    assert.ok(fbExtra.durationMinutes >= 90);
    assert.equal(fb.matchLifecycle.validateBeforeSettle([{ sportDraft: { a: 1 } }]).ok, false);
    assert.equal(bk.matchLifecycle.validateBeforeSettle([{ sportDraft: { a: 1 } }]).ok, true);

    // 同轮淘汰并列名次调整
    const adjusted = fb.standings.adjustEliminationPlacements(
      [
        { teamId: 't1', rank: 3, note: '淘汰' },
        { teamId: 't2', rank: 4, note: '淘汰' },
      ],
      [
        { stage: 'main', round: 1, winner: 'A', teamA: 'w1', teamB: 't1' },
        { stage: 'main', round: 1, winner: 'A', teamA: 'w2', teamB: 't2' },
      ],
    );
    assert.deepEqual(adjusted.map(r => r.rank), [3, 3]);
    assert.equal(adjusted[0].note, '同轮淘汰（并列）');
  });
});

describe('P-02 服务端插件注册表与三层隔离守卫', () => {
  test('服务端注册表按白名单收口动作，不暴露内部辅助函数且不进入小程序包', () => {
    const plugins = listServerSportPlugins();
    assert.ok(plugins.some(p => p.sportFormat === 'basketball5'));
    assert.ok(plugins.some(p => p.sportFormat === 'football11'));

    const fb = getServerSportPlugin('football11');
    assert.equal(typeof fb.actions.recordTeamMatch, 'function');
    assert.equal(typeof fb.actions.updateTeamMatchSchedule, 'function');
    for (const leaked of ['isFootball', 'footballMatchView', 'conflicts']) {
      assert.equal(fb.actions[leaked], undefined, `内部函数 ${leaked} 不得暴露在插件 actions 上`);
    }

    // 三层边界：miniprogram 不得出现 server/sports；src/shared/sports 不得引用 src/server
    assert.equal(fs.existsSync(path.join(ROOT, 'miniprogram', 'shared', 'server')), false);
    for (const rel of ['contract.js', 'registry.js', 'basketball/adapter.js', 'football/adapter.js']) {
      const content = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'sports', rel), 'utf8');
      assert.equal(/server\//.test(content), false, `src/shared/sports/${rel} 不得引用 server/`);
    }
  });

  test('动态注册与注销 SportAdapter + ServerSportPlugin 闭环', () => {
    assert.throws(() => unregisterSportAdapter('basketball5'), /不可注销/);
    assert.throws(() => unregisterServerSportPlugin('football11'), /不可注销/);
    assert.throws(() => registerSportAdapter({ meta: { sportFormat: 'bad' } }), /缺少必需/);

    const vbAdapter = Object.freeze({
      meta: Object.freeze({
        sportFormat: 'volleyball6_test',
        sportKey: 'volleyball',
        supportsLiveScore: true,
        supportsMatchData: true,
        supportsRedraw: true,
        allowsDraw: false,
        defaultMatchTimeFromEvent: true,
        defaultDurationMinutes: () => 90,
        requiresStrictRulesOnEntry: false,
        requiresWinnerOnElimSettle: false,
        sharedEliminationRank: false,
        supportsRankingDecisions: false,
        strictEntryRosterCheck: false,
        schedulePeopleSource: 'membership',
      }),
      rules: Object.freeze({
        defaultPresetKey: 'fivb-bo5',
        defaultRules: () => ({ presetKey: 'fivb-bo5', sets: 5 }),
        normalizeRules: input => input,
        formatRules: () => '五局三胜制',
      }),
      permissions: Object.freeze({
        canRecord: ({ manage }) => Boolean(manage),
        canSeePending: ({ manage }) => Boolean(manage),
        canSetLineup: ({ manage }) => Boolean(manage),
        canEditSchedule: ({ manage }) => Boolean(manage),
      }),
      matchLifecycle: Object.freeze({
        initMatchExtra: () => ({ matchTime: null }),
        hasActivityOrDraft: () => false,
        validateBeforeSettle: () => ({ ok: true, message: '' }),
        validateRankingDecisions: () => ({ ok: true, decisions: [] }),
        validateEntryPayload: () => ({ ok: true, message: '' }),
        decorateMatchView: () => ({}),
      }),
      standings: Object.freeze({
        computeTable: () => [],
        adjustEliminationPlacements: p => p,
      }),
      view: Object.freeze({
        eventFormMode: 'volleyball',
        recordPageUrl: id => `/packageTeam/vb/vb?matchId=${id}`,
        liveScorePageUrl: id => `/packageTeam/vb-live/vb-live?matchId=${id}`,
        recordHintText: '五局三胜',
        statColumns: Object.freeze([]),
      }),
    });

    registerAssociationPlugin({
      id: 'vb_p02_test',
      name: '测试排球协会',
      shortName: '排球',
      sportName: '排球',
      sportKey: 'volleyball',
      logoGlyph: '排',
      logoIcon: '/assets/assoc/vb.png',
      theme: { primary: '#1E88E5', primaryDark: '#1565C0', primaryLight: '#E3F2FD', accent: '#FDD835' },
      sportType: SPORT_TYPE.TEAM,
      teamSportFormat: 'volleyball6_test',
      volleyballRules: { presetKey: 'fivb-bo5', sets: 5 },
      capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.EVENTS],
      status: ASSOCIATION_STATUS.ACTIVE,
    });
    registerSportAdapter(vbAdapter);
    registerServerSportPlugin({
      sportFormat: 'volleyball6_test',
      actions: { getTeamRecord: async () => ({ ok: true }) },
    });

    try {
      const hitAdapter = getSportAdapterFor('vb_p02_test');
      const hitServer = getServerSportPluginFor('vb_p02_test');
      assert.equal(hitAdapter.meta.sportFormat, 'volleyball6_test');
      assert.equal(typeof hitServer.actions.getTeamRecord, 'function');
    } finally {
      unregisterServerSportPlugin('volleyball6_test');
      unregisterSportAdapter('volleyball6_test');
      unregisterAssociationPlugin('vb_p02_test');
    }
  });
});

describe('P-03 内核去硬编码与全库 sport* 字段统一守卫', () => {
  test('createSportAdapter 为可选钩子提供默认空实现并通过契约校验', () => {
    const minimal = createSportAdapter({
      meta: {
        sportFormat: 'minimal_sport',
        sportKey: 'minimal',
        supportsLiveScore: false,
        supportsMatchData: true,
        supportsRedraw: true,
        allowsDraw: false,
        defaultMatchTimeFromEvent: true,
      },
      rules: {
        defaultPresetKey: 'default',
        defaultRules: () => ({}),
        normalizeRules: input => input,
        formatRules: () => '默认规则',
      },
      standings: {
        computeTable: () => [],
      },
      view: {
        eventFormMode: 'minimal',
      },
    });
    assert.equal(validateSportAdapter(minimal).ok, true);
    assert.equal(minimal.matchLifecycle.validateBeforeSettle([]).ok, true);
    assert.deepEqual(minimal.matchLifecycle.decorateMatchView({}, {}), {});
    assert.deepEqual(minimal.standings.adjustEliminationPlacements([{ rank: 1 }], []), [{ rank: 1 }]);
  });

  test('team-event-service.js 已彻底消除运动硬编码与旧足球模块直连', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src', 'server', 'services', 'team-event-service.js'), 'utf8');
    for (const forbidden of [
      'football11', 'basketball5', 'footballDraft', 'footballPublished',
      'footballLineups', 'football-match-service', 'football-schedule-service', 'football-report',
    ]) {
      assert.equal(content.includes(forbidden), false, `team-event-service.js 不得再包含 ${forbidden}`);
    }
  });

  test('src/ 与 config/db-indexes.json 中已无旧 football* 单场字段残留', () => {
    const legacyFields = [
      'footballDraft', 'footballPublished', 'footballLineups',
      'footballAudit', 'footballRequests', 'footballScheduleRevision', 'footballScheduleRequests',
    ];
    const walk = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const targets = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'config', 'db-indexes.json')];
    for (const file of targets) {
      const text = fs.readFileSync(file, 'utf8');
      for (const field of legacyFields) {
        assert.equal(text.includes(field), false, `${path.relative(ROOT, file)} 仍残留旧字段 ${field}`);
      }
    }
  });
});
