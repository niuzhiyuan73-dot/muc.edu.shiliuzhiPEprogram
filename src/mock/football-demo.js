/** 足球演示：保留报名流程，另给一届明确标注的已完赛示例用于查看成绩。 */
const { MEMBER_SEED } = require('./seed.js');
const { schoolKey, teamMemberKey } = require('../shared/utils/school.js');
const { normalizeFootballRules, DEFAULT_PRESET_KEY } = require('../shared/utils/football-rules.js');
const { TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_ENTRY_STATUS, TEAM_EVENT_STATUS } = require('../shared/utils/constants.js');
const { normalizeFootballReport, FIELDS } = require('../shared/utils/football-report.js');
const { demoIso } = require('./demo-clock.js');
const SCOPE = Object.freeze({ schoolId: 'muc', association: 'fb' });
const ISO = demoIso(0);
const idOf = index => `u${String(index + 1).padStart(2, '0')}`;
const nameOf = userId => {
  const member = MEMBER_SEED[Number(userId.slice(1)) - 1];
  return member ? member.realName || member.nickName || userId : userId;
};

function createFootballDemoContent() {
  const specs = [
    { slug: 'pomegranate', name: '石榴红足球队', ids: Array.from({ length: 12 }, (_, index) => idOf(index)) },
    { slug: 'campus', name: '绿茵同行队', ids: Array.from({ length: 12 }, (_, index) => idOf(index + 12)) },
  ];
  const teams = [];
  const teamMembers = [];
  specs.forEach(spec => {
    const teamId = schoolKey('tm', SCOPE.schoolId, SCOPE.association, spec.slug);
    spec.teamId = teamId;
    teams.push({ _id: teamId, ...SCOPE, sport: 'football', name: spec.name, college: '',
      captainId: spec.ids[0], status: TEAM_STATUS.ACTIVE, revision: 1, createdAt: ISO, updatedAt: ISO, simulated: true });
    spec.ids.forEach((userId, index) => {
      const key = teamMemberKey(teamId, userId);
      teamMembers.push({ _id: key, ...SCOPE, teamId, userId, role: index === 0 ? 'captain' : 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE, joinedAt: ISO, updatedAt: ISO, simulated: true });
    });
  });
  const pendingId = schoolKey('tm', SCOPE.schoolId, SCOPE.association, 'recruiting');
  teams.push({ _id: pendingId, ...SCOPE, sport: 'football', name: '校园新星队（待审核）', college: '',
    captainId: 'u06', status: TEAM_STATUS.PENDING, revision: 1, createdAt: ISO, updatedAt: ISO, simulated: true });
  const pendingMember = teamMemberKey(pendingId, 'u06');
  teamMembers.push({ _id: pendingMember, ...SCOPE, teamId: pendingId, userId: 'u06', role: 'captain',
    status: TEAM_MEMBER_STATUS.ACTIVE, joinedAt: ISO, updatedAt: ISO, simulated: true });
  const rules = normalizeFootballRules({ presetKey: DEFAULT_PRESET_KEY });
  const eventId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'campus-cup');
  const teamEvents = [{ _id: eventId, ...SCOPE, name: '自由组队足球杯（报名中）', sportFormat: 'football11',
    rules, format: 'single_elim', statPolicy: 'basic', bronzeMode: 'playoff', status: TEAM_EVENT_STATUS.REGISTRATION,
    entryMin: rules.eventRosterMin, entryMax: rules.eventRosterMax, lockedCount: 0,
    startTime: demoIso(12), location: '校足球场', revision: 1,
    createdBy: 'demo_muc_admin', createdAt: ISO, updatedAt: ISO, simulated: true }];
  const teamEventEntries = specs.map((spec, index) => ({
    _id: schoolKey('ten', eventId, spec.teamId), ...SCOPE, eventId, teamId: spec.teamId,
    status: index === 0 ? TEAM_ENTRY_STATUS.APPROVED : TEAM_ENTRY_STATUS.SUBMITTED,
    roster: spec.ids.map((userId, playerIndex) => ({ userId, name: nameOf(userId), no: playerIndex + 1 })),
    submittedBy: spec.ids[0], submittedAt: ISO,
    reviewedBy: index === 0 ? 'demo_muc_admin' : null, reviewedAt: index === 0 ? ISO : null,
    lockedAt: null, placement: null, updatedAt: ISO, simulated: true,
  }));
  const completedId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'completed-demo');
  const completedEntries = specs.map(spec => ({ ...teamEventEntries.find(e => e.teamId === spec.teamId),
    _id: schoolKey('ten', completedId, spec.teamId), eventId: completedId, status: 'locked',
    lockedAt: ISO, placement: spec === specs[0] ? 1 : 2 }));
  teamEventEntries.push(...completedEntries);
  const reportSides = {};
  for (const [i, key] of ['A', 'B'].entries()) {
    reportSides[key] = { players: completedEntries[i].roster.map((p, index) => ({
      userId: p.userId, starter: index < 11, appeared: index < 11, goalkeeper: index === 0,
      ...Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? null : 0])),
      goals: index === 0 ? 1 : 0, ownGoals: key === 'B' && index === 1 ? 1 : 0,
      assists: key === 'A' && index === 1 ? 1 : 0,
      yellowCards: key === 'A' && index === 11 ? 1 : 0,
    })), coverage: Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? 'none' : 'full'])),
    substitutions: { status: 'full', regulationCount: 0, regulationOpportunities: 0, halfTimeCount: 0,
      extraTimeCount: 0, extraTimeOpportunities: 0, extraBreakCount: 0, incomingIds: [] } };
  }
  const normalized = normalizeFootballReport({ result: { regulationScore: { A: 2, B: 1 } }, sides: reportSides,
    goalEvents: [{ side: 'A', type: 'normal', scorerId: specs[0].ids[0], assistId: specs[0].ids[1] },
      { side: 'B', type: 'normal', scorerId: specs[1].ids[0] }, { side: 'B', type: 'own_goal', scorerId: specs[1].ids[1] }] },
  { rules, format: 'round_robin', rosters: { A: completedEntries[0].roster, B: completedEntries[1].roster } });
  if (!normalized.ok) throw new Error(normalized.message);
  const placements = specs.map((spec, i) => ({ teamId: spec.teamId, teamName: spec.name, rank: i + 1, note: i ? '亚军' : '冠军' }));
  teamEvents.push({ ...teamEvents[0], _id: completedId, name: '足球循环赛（已完赛演示）', format: 'round_robin',
    status: 'finished', startTime: demoIso(-1), lockedCount: 2,
    draw: { size: 2, roundCount: 1, slots: specs.map(s => s.teamId) },
    placements, finishedAt: ISO, revision: 5 });
  const matchId = `x_${completedId}_r1_group_0`;
  const teamMatches = [{ _id: matchId, ...SCOPE, eventId: completedId, sportFormat: 'football11', rules,
    teamA: specs[0].teamId, teamB: specs[1].teamId, round: 1, stage: 'group', slot: 0,
    status: 'published', scoreA: 2, scoreB: 1, winner: 'A', forfeit: null, overtime: false,
    sportPublished: normalized.value, sportPublishedRevision: 3, sportDraft: null,
    revision: 3, recordedBy: 'demo_muc_admin', publishedBy: 'demo_muc_admin', publishedAt: ISO,
    matchTime: demoIso(-1), durationMinutes: 110, location: '校足球场（演示）',
    createdAt: ISO, updatedAt: ISO, simulated: true }];
  // 有效学校成员在启用的协会中默认就是普通会员，不需要额外写角色行。
  // 管理者使用已有 demo_muc_admin 学校角色；不让 u01 等普通演示账号额外升权。

  // ------------------------------------------------------------
  // 扩容（2026-10-20）：再补四届，赛事数到 6（3 倍），场次从 1 到 4。
  //
  // 【为什么不是严格的 3 场】
  // 足球演示只有两支 11 人队（24 名种子会员刚好用完），第三届队凑不出来。
  // 于是用「主客场两回合」把场次做厚：循环赛两回合 2 场 + 单败决赛 1 场，
  // 加上原有 1 场共 4 场——超过 3 倍，且每场都是真实的两人队对阵。
  // ------------------------------------------------------------
  const extraEvents = [];
  const extraEntries = [];
  const extraMatches = [];

  const extraEvent = (slug, extra) => ({
    _id: schoolKey('tev', SCOPE.schoolId, SCOPE.association, slug),
    ...SCOPE,
    sportFormat: 'football11',
    rules,
    statPolicy: 'basic',
    bronzeMode: 'playoff',
    entryMin: rules.eventRosterMin,
    entryMax: rules.eventRosterMax,
    lockedCount: 2,
    revision: 2,
    createdBy: 'demo_muc_admin',
    createdAt: ISO,
    updatedAt: ISO,
    simulated: true,
    ...extra,
  });
  const lockedEntriesOf = (eventId) => specs.map(spec => ({
    _id: schoolKey('ten', eventId, spec.teamId), ...SCOPE, eventId, teamId: spec.teamId,
    status: 'locked', roster: spec.ids.map((userId, index) => ({ userId, name: nameOf(userId), no: index + 1 })),
    submittedBy: spec.ids[0], submittedAt: ISO, reviewedBy: 'demo_muc_admin', reviewedAt: ISO,
    lockedAt: ISO, placement: null, updatedAt: ISO, simulated: true,
  }));
  /**
   * 一份「已发布」的赛后报告快照。
   *
   * 【为什么每场都必须有】统计端只认 `status === 'published' && sportPublished`
   * 的比赛（见 football-match-service 的 publicMatches）。扩容时补的那几场当初
   * 只写了 scoreA/scoreB，结果就是：赛事写着「已完赛」、名次也在，但
   *   · 比赛详情的比分显示「—」（footballMatchView 是从报告里取比分的）；
   *   · 出场数与球队战绩全为 0（没有报告的比赛进不了统计）；
   *   · 「我的球队」里出现「1 场出场 / 4 项荣誉」这种看起来自相矛盾的组合。
   * 报告是比分与个人统计的唯一真相源，演示数据也必须给全。
   *
   * 详细版（乌龙、助攻、黄牌）只在首场演示里出现；这里按比分把进球分给前几位
   * 首发，其余统计填 0 并标 full —— 形状合法，页面读得出数据。
   */
  const publishedReportOf = (scoreA, scoreB, format) => {
    const goalsBy = { A: scoreA, B: scoreB };
    const rosterOf = index => specs[index].ids.map((userId, no) => ({ userId, name: nameOf(userId), no: no + 1 }));
    const sides = {};
    for (const [i, key] of ['A', 'B'].entries()) {
      sides[key] = {
        players: specs[i].ids.map((userId, index) => ({
          userId, starter: index < 11, appeared: index < 11, goalkeeper: index === 0,
          ...Object.fromEntries(Object.keys(FIELDS).map(field => [field, null])),
          goals: index < goalsBy[key] ? 1 : 0,
          ownGoals: 0, assists: 0, yellowCards: 0, secondYellow: 0, directRed: 0,
        })),
        coverage: Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? 'none' : 'full'])),
        substitutions: { status: 'full', regulationCount: 0, regulationOpportunities: 0, halfTimeCount: 0,
          extraTimeCount: 0, extraTimeOpportunities: 0, extraBreakCount: 0, incomingIds: [] },
      };
    }
    const goalEvents = [];
    for (let n = 0; n < scoreA; n += 1) goalEvents.push({ side: 'A', type: 'normal', scorerId: specs[0].ids[n] });
    for (let n = 0; n < scoreB; n += 1) goalEvents.push({ side: 'B', type: 'normal', scorerId: specs[1].ids[n] });
    const out = normalizeFootballReport(
      { result: { regulationScore: { A: scoreA, B: scoreB } }, sides, goalEvents },
      { rules, format, rosters: { A: rosterOf(0), B: rosterOf(1) } },
    );
    if (!out.ok) throw new Error(`足球演示报告不合法：${out.message}`);
    return out.value;
  };
  const playedMatch = (eventId, round, stage, slot, scoreA, scoreB, matchTime, format = 'round_robin') => ({
    _id: `x_${eventId}_r${round}_${stage}_${slot}`,
    ...SCOPE, eventId, sportFormat: 'football11', rules,
    teamA: specs[0].teamId, teamB: specs[1].teamId, round, stage, slot,
    status: 'published', scoreA, scoreB, winner: scoreA > scoreB ? 'A' : 'B', forfeit: null, overtime: false,
    // 没有这两个字段，「已发布」就是一句空话（见上面的说明）
    sportPublished: publishedReportOf(scoreA, scoreB, format), sportPublishedRevision: 2, sportDraft: null,
    revision: 2, recordedBy: 'demo_muc_admin', publishedBy: 'demo_muc_admin', publishedAt: ISO,
    matchTime, durationMinutes: 105, location: '校足球场', createdAt: ISO, updatedAt: ISO, simulated: true,
  });

  // 1. 双回合循环赛（已结束）：热浪两回合总比分 4:2
  const springId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'spring-league');
  extraEvents.push(extraEvent('spring-league', {
    name: '春季足球联赛（双回合）', format: 'round_robin', status: 'finished',
    startTime: demoIso(-197), location: '校足球场',
    draw: { size: 2, roundCount: 2, slots: specs.map(s => s.teamId) },
    placements: [{ teamId: specs[0].teamId, teamName: specs[0].name, rank: 1, note: '冠军' },
      { teamId: specs[1].teamId, teamName: specs[1].name, rank: 2, note: '亚军' }],
    finishedAt: ISO, revision: 4,
  }));
  extraEntries.push(...lockedEntriesOf(springId));
  extraMatches.push(
    playedMatch(springId, 1, 'group', 0, 2, 1, demoIso(-197)),
    playedMatch(springId, 2, 'group', 0, 2, 1, demoIso(-190)),
  );

  // 2. 单败决赛（已结束）：与循环赛错开，演示「一局定胜负」的名次形状
  const cupId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'autumn-cup');
  extraEvents.push(extraEvent('autumn-cup', {
    name: '秋季足球杯（决赛）', format: 'single_elim', status: 'finished',
    startTime: demoIso(-29), location: '校足球场',
    draw: { size: 2, roundCount: 1, slots: specs.map(s => s.teamId) },
    placements: [{ teamId: specs[1].teamId, teamName: specs[1].name, rank: 1, note: '冠军' },
      { teamId: specs[0].teamId, teamName: specs[0].name, rank: 2, note: '亚军' }],
    finishedAt: ISO, revision: 3,
  }));
  extraEntries.push(...lockedEntriesOf(cupId));
  extraMatches.push(playedMatch(cupId, 1, 'main', 0, 1, 3, demoIso(-29), 'single_elim'));

  // 3. 报名中：两支都还在等审核，与既有「报名中」那届的审核态错开
  const winterId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'winter-friendly');
  extraEvents.push(extraEvent('winter-friendly', {
    name: '冬季足球友谊赛（报名中）', format: 'single_elim', status: 'registration',
    startTime: demoIso(46), location: '校足球场', lockedCount: 0, revision: 1,
  }));
  extraEntries.push(...specs.map(spec => ({
    _id: schoolKey('ten', winterId, spec.teamId), ...SCOPE, eventId: winterId, teamId: spec.teamId,
    status: 'submitted', roster: spec.ids.map((userId, index) => ({ userId, name: nameOf(userId), no: index + 1 })),
    submittedBy: spec.ids[0], submittedAt: ISO, reviewedBy: null, reviewedAt: null,
    lockedAt: null, placement: null, updatedAt: ISO, simulated: true,
  })));

  // 4. 名单已锁定、等待抽签
  const youthId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'youth-invite');
  extraEvents.push(extraEvent('youth-invite', {
    name: '青年足球邀请赛（待抽签）', format: 'single_elim', status: 'locked',
    startTime: demoIso(25), location: '校足球场', revision: 2,
  }));
  extraEntries.push(...lockedEntriesOf(youthId));

  teamEvents.push(...extraEvents);
  teamEventEntries.push(...extraEntries);
  teamMatches.push(...extraMatches);

  return { teams, teamMembers, teamEvents, teamEventEntries, teamMatches, teamMatchStats: [], memberships: [] };
}

module.exports = { createFootballDemoContent };
