/**
 * 切片 P-04：球拍 ScoringAdapter、前端声明驱动、虚拟第 7 协会开闭原则端到端实证
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, instantiate, withApi } = require('./helpers/page-harness.js');
const associationScope = require('../miniprogram/services/association-scope.js');
const miniprogramAssociations = require('../miniprogram/shared/associations/registry.js');

const ROOT = path.join(__dirname, '..');

const {
  validateScoringAdapter,
  getScoringAdapter,
  listScoringAdapters,
} = require('../src/shared/sports/racket/registry.js');
const { formatOptionsOf, scoreUnitLabelOf, scheduledForm } = require('../miniprogram/services/match-entry-view.js');
const { describeLive } = require('../miniprogram/services/live-view.js');
const { teamProfileView } = require('../miniprogram/utils/team-profile-view.js');

const {
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
} = require('../src/shared/associations/registry.js');
const { createSportAdapter } = require('../src/shared/sports/contract.js');
const { registerAssociationWithAdapter, unregisterSportAdapter } = require('../src/shared/sports/registry.js');
const { registerServerSportPlugin, unregisterServerSportPlugin } = require('../src/server/sports/registry.js');
const miniprogramSportsRegistry = require('../miniprogram/shared/sports/registry.js');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context.js');
const teamHandlers = require('../src/server/services/team-service.js');
const eventHandlers = require('../src/server/services/team-event-service.js');
const { schoolMemberKey, schoolMembershipKey } = require('../src/shared/utils/school.js');
const {
  ASSOCIATION_STATUS,
  TEAM_EVENT_STATUS,
  TEAM_MATCH_STATUS,
} = require('../src/shared/utils/constants.js');

describe('P-04 球拍 ScoringAdapter 与前端视图声明驱动', () => {
  test('全部内置 ScoringAdapter 满足契约，未知计分制安全回落 point', () => {
    const adapters = listScoringAdapters();
    assert.equal(adapters.length >= 2, true);
    for (const adapter of adapters) {
      const check = validateScoringAdapter(adapter);
      assert.equal(check.ok, true, `${adapter.scoring}: ${check.message}`);
    }
    assert.equal(getScoringAdapter('tennis').scoreUnit, '盘');
    assert.equal(getScoringAdapter('tennis').usePointTextClass, true);
    assert.equal(getScoringAdapter('point').scoreUnit, '局');
    assert.equal(getScoringAdapter('unknown_scoring').scoring, 'point');
  });

  test('match-entry-view 与 live-view 通过 ScoringAdapter 产出一致展示字段', () => {
    const pkbOpts = formatOptionsOf('pkb');
    assert.equal(pkbOpts.scoring, 'point');
    assert.ok(pkbOpts.gamePointsOptions.length > 0);
    assert.equal(scoreUnitLabelOf({ scoring: 'point' }), '局');

    const tnOpts = formatOptionsOf('tn');
    assert.equal(tnOpts.scoring, 'tennis');
    assert.ok(tnOpts.setGamesOptions.length > 0);
    assert.equal(scoreUnitLabelOf({ scoring: 'tennis' }), '盘');

    const tnScheduled = scheduledForm({
      scoring: 'tennis', bestOf: 3, setGames: 4, tiebreakAt: 4, tiebreakPoints: 7, noAd: true,
    });
    assert.equal(tnScheduled.scoring, 'tennis');
    assert.equal(tnScheduled.setGames, 4);
    assert.equal(tnScheduled.noAd, true);

    const livePoint = describeLive({
      matchId: 'm1', scoring: 'point', pointsA: 9, pointsB: 7, gamesA: 1, gamesB: 0, gameIndex: 1, leading: 'A', finished: false,
    });
    assert.equal(livePoint.scoreText, '9 : 7');
    assert.equal(livePoint.gameIndexText, '第 2 局');
    assert.equal(livePoint.usePointTextClass, false);

    const liveTennis = describeLive({
      matchId: 'm2', scoring: 'tennis', pointTextA: '40', pointTextB: '30',
      gamesA: 5, gamesB: 4, setsA: 1, setsB: 0, setIndex: 1, inTiebreak: false, leading: 'A', finished: false,
    });
    assert.equal(liveTennis.scoreText, '40 : 30');
    assert.equal(liveTennis.setsText, '1 : 0');
    assert.equal(liveTennis.gameIndexText, '第 2 盘');
    assert.equal(liveTennis.usePointTextClass, true);
  });

  test('teamProfileView 按 SportAdapter.view.profileStatColumns 声明渲染指标列', () => {
    const bkView = teamProfileView({
      sportFormat: 'basketball5',
      totals: { points: 24, pointsText: '24', pointsRecordedMatches: 2 },
    });
    assert.equal(bkView.isFootball, false);
    assert.equal(bkView.statCells[0].field, 'points');
    assert.equal(bkView.statCells[0].totalText, '24');

    const fbView = teamProfileView({
      sportFormat: 'football11',
      totals: { goals: 3, goalsText: '3', goalsRecordedMatches: 2 },
    });
    assert.equal(fbView.isFootball, true);
    assert.equal(fbView.statCells[0].field, 'goals');

    const customAdapter = createSportAdapter({
      meta: {
        sportFormat: 'volleyball_view_test',
        sportKey: 'volleyball',
        supportsLiveScore: true,
        supportsMatchData: true,
        supportsRedraw: true,
        allowsDraw: false,
        defaultMatchTimeFromEvent: true,
        strictEntryRosterCheck: false,
        schedulePeopleSource: 'membership',
      },
      rules: {
        defaultPresetKey: 'std-5',
        defaultRules: () => ({ bestOf: 5, setPoints: 25 }),
        normalizeRules: r => r || { bestOf: 5, setPoints: 25 },
        formatRules: () => '五局三胜',
      },
      standings: { computeTable: () => [] },
      view: {
        eventFormMode: 'volleyball',
        profileStatColumns: [
          { key: 'spikes', label: '扣球得分' },
          { key: 'blocks', label: '拦网' },
        ],
      },
    });
    miniprogramSportsRegistry.registerSportAdapter(customAdapter);
    try {
      const vbView = teamProfileView({
        sportFormat: 'volleyball_view_test',
        totals: { spikes: 18, spikesText: '18', spikesRecordedMatches: 2 },
      });
      assert.equal(vbView.isFootball, false);
      assert.deepEqual(vbView.statCells.map(c => c.label), ['扣球得分', '拦网']);
      assert.equal(vbView.statCells[0].totalText, '18');
    } finally {
      miniprogramSportsRegistry.unregisterSportAdapter('volleyball_view_test');
    }

    const unknown = teamProfileView({
      sportFormat: 'volleyball_unknown',
      totals: { points: 10, pointsText: '10', pointsRecordedMatches: 1 },
    });
    assert.deepEqual(unknown.statCells, [], '未知运动不得回落成篮球指标');
  });
});

describe('P-04 虚拟第 7 协会插件端到端开闭原则实证（零内核代码改动）', () => {
  test('动态注册第 7 协会 vb_e2e 并跑通建队→建赛→报名→抽签→录分→发布→积分榜→结算全链路', async () => {
    const ASSOC_ID = 'vb_e2e';
    const SPORT_FORMAT = 'volleyball6_e2e';
    const SCOPE = { schoolId: 'muc', association: ASSOC_ID };
    const NOW = new Date('2026-10-25T10:00:00Z');

    const normalizeVbRules = ({ presetKey = 'vb-bo5' } = {}) => {
      if (presetKey === 'vb-bo5') {
        return { presetKey, sportFormat: SPORT_FORMAT, bestOf: 5, setPoints: 25, entryMin: 6, entryMax: 12 };
      }
      if (presetKey === 'vb-bo3') {
        return { presetKey, sportFormat: SPORT_FORMAT, bestOf: 3, setPoints: 21, entryMin: 6, entryMax: 12 };
      }
      return null;
    };

    const vbAdapter = createSportAdapter({
      meta: {
        sportFormat: SPORT_FORMAT,
        sportKey: 'volleyball_e2e',
        supportsLiveScore: true,
        supportsMatchData: true,
        supportsRedraw: true,
        allowsDraw: false,
        defaultMatchTimeFromEvent: true,
        strictEntryRosterCheck: false,
        schedulePeopleSource: 'membership',
      },
      rules: {
        defaultPresetKey: 'vb-bo5',
        presetOptions: [
          { key: 'vb-bo5', label: '五局三胜 · 25 分' },
          { key: 'vb-bo3', label: '三局两胜 · 21 分' },
        ],
        defaultRules: () => normalizeVbRules(),
        normalizeRules: normalizeVbRules,
        formatRules: r => `排球 ${(r && r.bestOf) || 5}局制 · ${(r && r.setPoints) || 25}分`,
      },
      standings: {
        computeTable({ entries, matches }) {
          const map = new Map();
          for (const entry of entries || []) {
            map.set(entry.teamId, {
              teamId: entry.teamId,
              teamName: entry.teamName,
              played: 0,
              wins: 0,
              losses: 0,
              points: 0,
              diff: 0,
            });
          }
          for (const m of matches || []) {
            if (m.status !== TEAM_MATCH_STATUS.PUBLISHED) continue;
            const a = map.get(m.teamA);
            const b = map.get(m.teamB);
            if (!a || !b) continue;
            a.played += 1;
            b.played += 1;
            a.diff += (m.scoreA - m.scoreB);
            b.diff += (m.scoreB - m.scoreA);
            if (m.winner === 'A') {
              a.wins += 1;
              b.losses += 1;
              a.points += 3;
            } else {
              b.wins += 1;
              a.losses += 1;
              b.points += 3;
            }
          }
          return [...map.values()]
            .sort((x, y) => y.points - x.points || y.diff - x.diff)
            .map((row, idx) => ({ ...row, rank: idx + 1 }));
        },
      },
      view: {
        eventFormMode: 'volleyball',
        recordHintText: '排球五局三胜，胜积 3 分。',
        statColumns: [{ key: 'spikes', label: '扣球' }],
        profileStatColumns: [{ key: 'spikes', label: '扣球' }],
      },
    });

    const associationPlugin = {
      id: ASSOC_ID,
      name: '民大排球协会（虚拟实证）',
      shortName: '排协',
      sportName: '排球',
      sportKey: 'volleyball_e2e',
      logoGlyph: '排',
      logoIcon: '/assets/assoc/vb.png',
      theme: {
        primary: '#2563EB',
        primaryDark: '#1D4ED8',
        primaryLight: '#DBEAFE',
        accent: '#FACC15',
      },
      sportType: SPORT_TYPE.TEAM,
      teamSportFormat: SPORT_FORMAT,
      rulesKey: 'volleyballRules',
      status: ASSOCIATION_STATUS.ACTIVE,
      capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.EVENTS],
      volleyballRules: normalizeVbRules(),
    };
    const previousAssociation = associationScope.getAssociation();
    registerAssociationWithAdapter(associationPlugin, vbAdapter);
    registerServerSportPlugin({
      sportFormat: SPORT_FORMAT,
      actions: {},
    });

    try {
      miniprogramSportsRegistry.registerAssociationWithAdapter(associationPlugin, vbAdapter);
      associationScope.setAssociation(ASSOC_ID);
      const seed = createSchoolDemoSeed();
      seed.schoolAssociations.push({
        _id: `muc:${ASSOC_ID}`,
        schoolId: 'muc',
        association: ASSOC_ID,
        enabled: true,
      });

      const addMember = (id, role = 'member') => {
        seed.users.push({
          _id: id,
          openId: `mock_openid_${id}`,
          nickName: id,
          gender: 'M',
          platformStatus: 'active',
          platformRole: 'member',
          primarySchoolId: 'muc',
          simulated: true,
        });
        seed.schoolMembers.push({
          _id: schoolMemberKey(id, 'muc'),
          userId: id,
          schoolId: 'muc',
          collegeId: 'c01',
          studentId: id,
          status: 'active',
          simulated: true,
        });
        seed.memberships.push({
          _id: schoolMembershipKey(id, SCOPE),
          userId: id,
          schoolId: 'muc',
          association: ASSOC_ID,
          role,
          status: 'active',
        });
      };

      addMember('vb_leader', 'leader');
      addMember('vb_cap_a', 'member');
      addMember('vb_cap_b', 'member');
      for (let i = 1; i <= 5; i += 1) addMember(`vb_a${i}`);
      for (let i = 1; i <= 5; i += 1) addMember(`vb_b${i}`);

      const repo = createSchoolMemoryRepo(seed);
      const runTeam = async (action, payload, actor = 'vb_leader') => {
        const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
        return (await teamHandlers[action](payload, ctx)).data;
      };
      const runEvent = async (action, payload, actor = 'vb_leader') => {
        const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
        return (await eventHandlers[action](payload, ctx)).data;
      };

      const mkTeam = async (name, cap, prefix) => {
        const app = await runTeam('createTeamApplication', { name, requestId: `req_${cap}` }, cap);
        assert.equal(app.ok, true, app.message);
        const rev = await runTeam('reviewTeamApplication', { teamId: app.teamId, approve: true });
        assert.equal(rev.ok, true, rev.message);
        for (let i = 1; i <= 5; i += 1) {
          const join = await runTeam('applyToJoinTeam', { teamId: app.teamId }, `${prefix}${i}`);
          assert.equal(join.ok, true, join.message);
          const okMem = await runTeam('reviewTeamMember', { teamId: app.teamId, userId: `${prefix}${i}`, approve: true }, cap);
          assert.equal(okMem.ok, true, okMem.message);
        }
        return app.teamId;
      };

      const teamAId = await mkTeam('苍鹰排球队', 'vb_cap_a', 'vb_a');
      const teamBId = await mkTeam('雪豹排球队', 'vb_cap_b', 'vb_b');

      const eventName = '民大排球秋季赛';
      const eventId = await withApi({
        listTeamEvents: payload => runEvent('listTeamEvents', payload),
        createTeamEvent: payload => runEvent('createTeamEvent', payload),
      }, async (calls) => {
        const page = instantiate(loadPage('team-event-list'));
        await page.onLoad();
        assert.equal(page.scope.association, ASSOC_ID);
        assert.equal(page.data.presetOptions[page.data.presetIndex].key, 'vb-bo5');
        page.onOpenCreate();
        page.onInputName({ detail: { value: eventName } });
        page.onPickFormat({ detail: { value: 1 } });
        page.onPickPreset({ detail: { value: 1 } });
        await page.onSubmitCreate();

        const [, payload] = calls.find(([name]) => name === 'createTeamEvent');
        assert.equal(payload.presetKey, 'vb-bo3');
        assert.equal(page.data.creating, false, page.data.notice);
        const created = page.data.events.find(event => event.name === eventName);
        assert.ok(created?.eventId, '创建成功且刷新后可见');
        return created.eventId;
      });

      assert.equal((await runEvent('submitTeamEntry', { eventId, teamId: teamAId }, 'vb_cap_a')).ok, true);
      assert.equal((await runEvent('submitTeamEntry', { eventId, teamId: teamBId }, 'vb_cap_b')).ok, true);
      assert.equal((await runEvent('reviewTeamEntry', { eventId, teamId: teamAId, approve: true })).ok, true);
      assert.equal((await runEvent('reviewTeamEntry', { eventId, teamId: teamBId, approve: true })).ok, true);
      assert.equal((await runEvent('lockTeamEntries', { eventId })).ok, true);

      const drawn = await runEvent('drawTeamEvent', { eventId });
      assert.equal(drawn.ok, true, drawn.message);
      assert.equal(drawn.matchCount, 1);

      const detailBefore = await runEvent('getTeamEvent', { eventId });
      assert.equal(detailBefore.ok, true);
      assert.equal(detailBefore.event.sportFormat, SPORT_FORMAT);
      assert.match(detailBefore.event.rulesText, /排球 3局制 · 21分/);

      const matchId = detailBefore.matches[0].matchId;
      const recorded = await runEvent('recordTeamMatch', { matchId, scoreA: 2, scoreB: 1 });
      assert.equal(recorded.ok, true, recorded.message);

      // 新运动的统计字段按插件 statColumns 声明（spikes）保存与读取，
      // 服务端不再只认篮球 7 项——这是插件化"新运动统计可用"的开闭实证。
      const savedStats = await runEvent('saveTeamMatchStats', {
        matchId,
        mode: 'basic',
        players: [{ userId: 'vb_a1', spikes: 8 }],
      }, 'vb_cap_a');
      assert.equal(savedStats.ok, true, savedStats.message);
      const matchStats = await runEvent('getTeamMatchStats', { matchId }, 'vb_cap_a');
      assert.equal(matchStats.ok, true, matchStats.message);
      const aSide = matchStats.sides.find(side => side.teamId === teamAId);
      const spikeRow = aSide.players.find(row => row.userId === 'vb_a1');
      assert.equal(spikeRow.spikes, 8, '排球 spikes 字段服务端原样存回');

      const published = await runEvent('publishTeamMatch', { matchId, approve: true });
      assert.equal(published.ok, true, published.message);

      const detailAfter = await runEvent('getTeamEvent', { eventId });
      assert.equal(detailAfter.table.length, 2);
      assert.equal(detailAfter.table[0].points, 3);
      assert.equal(detailAfter.table[0].diff, 1);

      const settled = await runEvent('settleTeamEvent', { eventId });
      assert.equal(settled.ok, true, settled.message);
      const settledDetail = await runEvent('getTeamEvent', { eventId });
      assert.equal(settledDetail.event.status, TEAM_EVENT_STATUS.FINISHED);
      assert.equal(settledDetail.placements.length, 2);
      assert.equal(settledDetail.placements[0].rank, 1);

      const record = await runEvent('getTeamRecord', { teamId: settledDetail.placements[0].teamId }, 'vb_cap_a');
      assert.equal(record.ok, true, record.message);
      assert.equal(record.sportFormat, SPORT_FORMAT);
      assert.equal(record.overall.wins, 1);
      assert.equal(record.seasons[0].placement, 1);

      const myProfile = await runEvent('getMyTeamProfile', {}, 'vb_cap_a');
      assert.equal(myProfile.ok, true, myProfile.message);
      assert.equal(myProfile.sportFormat, SPORT_FORMAT);
    } finally {
      associationScope.setAssociation(previousAssociation);
      miniprogramSportsRegistry.unregisterSportAdapter(SPORT_FORMAT);
      miniprogramAssociations.unregisterAssociationPlugin(ASSOC_ID);
      unregisterServerSportPlugin(SPORT_FORMAT);
      unregisterSportAdapter(SPORT_FORMAT);
      unregisterAssociationPlugin(ASSOC_ID);
    }
  });
});

describe('P-04 前端插件化静态守卫', () => {
  test('通用页面与视图不再硬编码 football11 / tennis / football-match 跳转路径', () => {
    const targets = [
      'miniprogram/packageTeam/team-event-detail/team-event-detail.js',
      'miniprogram/packageTeam/team-event-list/team-event-list.js',
      'miniprogram/packageTeam/my-team-profile/my-team-profile.js',
      'miniprogram/packageTeam/team-detail/team-detail.js',
      'miniprogram/utils/team-profile-view.js',
      'miniprogram/templates/personal-sports-client.js',
      'miniprogram/packageEvent/match-entry/match-entry.js',
      'miniprogram/services/match-entry-view.js',
      'miniprogram/services/live-view.js',
      'miniprogram/packageTeam/live-score/live-score.wxml',
    ];
    for (const rel of targets) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.equal(/===\s*['"]football11['"]/.test(text), false, `${rel} 仍含 === 'football11'`);
      assert.equal(/===\s*['"]tennis['"]/.test(text), false, `${rel} 仍含 === 'tennis'`);
      assert.equal(/\/packageTeam\/football-match\//.test(text), false, `${rel} 仍含硬编码 /packageTeam/football-match/`);
    }
    // 正向守卫：建赛表单不再 import 篮球预设，详情页不再写死统计字段。
    const listSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/packageTeam/team-event-list/team-event-list.js'), 'utf8');
    assert.equal(/basketball-rules|RULE_PRESETS/.test(listSrc), false, '建赛页不得再依赖篮球规则预设');
    const detailSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/packageTeam/team-event-detail/team-event-detail.js'), 'utf8');
    assert.equal(/STAT_FIELDS/.test(detailSrc), false, '详情页不得再写死 STAT_FIELDS');
  });
});
