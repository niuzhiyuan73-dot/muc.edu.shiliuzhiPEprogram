/**
 * 团队运动（篮球）的演示内容
 * ============================================================
 * 一条完整的团队赛链路摆在这里：建队 → 报名 → 锁定 → 抽签 → 录分 → 发布 →
 * 季军赛 → 结算名次 → 个人统计 → 球员数据榜。打开小程序切到篮球协会，
 * 每一步都有东西可点，不需要先在云控制台建数据。
 *
 * 【为什么单独一个文件，而不是塞进 school-seed】
 * school-seed 的演示内容按「学校 + 协会」切片，被近二十个用例按条数断言；
 * 团队内容是另一套集合、另一套服务，混在一起会让那些断言随球队多寡漂移。
 * 这里只被 createSchoolDemoContent 调一次，谁要谁接。
 *
 * 【为什么比分与统计是手工摆的，而不是驱动服务跑一遍】
 * 运动会演示数据是驱动真实服务跑出来的（meet-seed.js），因为那一套的
 * 状态机有几十个分支，手摆必然对不上。团队赛这一版的形状是固定的：
 * 4 支队 → 2 场半决赛 + 决赛 + 季军赛，比分与统计照着写反而更直观，
 * 也更容易让人看懂「一场比赛的统计长什么样」。
 *
 * 【为什么统计的每节得分要刚好加得起来】
 * 演示数据里出现「个人合计 58，球队 60，差 2 分待归属」这种提醒，
 * 看的人会以为是 bug。所以每节的分都是按比例切出来的整数，合计分毫不差。
 * ============================================================
 */

const { MEMBER_SEED } = require('./seed.js');
const { eventMatchKey } = require('../shared/services/draw.js');
const { schoolKey, schoolMembershipKey, teamMemberKey } = require('../shared/utils/school.js');
const {
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS,
  TEAM_MATCH_STATUS, EVENT_FORMAT, EVENT_BRONZE_MODE, BRACKET_STAGE,
} = require('../shared/utils/constants.js');
const { normalizeBasketballRules } = require('../shared/utils/basketball-rules.js');
const { demoIso, demoAt } = require('./demo-clock.js');

const SCHOOL_ID = 'muc';
const ASSOCIATION = 'bk';
const SCOPE = { schoolId: SCHOOL_ID, association: ASSOCIATION };
/**
 * 与其它演示内容同一个时间锚点（见 demo-clock.js）。
 *
 * 【为什么不再写死 2026-03-01】
 * 写死的锚点会让「报名中 / 进行中」的赛事在几个月后变成一堆开赛在过去的
 * 记录——状态是存下来的字段，不会跟着时间走。改用会滚的锚点后，同一天内
 * 反复 reset 仍然完全一致，跨天则整体前移，演示数据不会烂掉。
 */
const ISO = demoIso(0);

/** 旧演示账号 u01–u24 的昵称，名单快照里要写当时的名字 */
const NICK = new Map(MEMBER_SEED.map((item, index) => [`u${String(index + 1).padStart(2, '0')}`, item.nickName]));
const nameOf = userId => NICK.get(userId) || userId;

/** 四支球队：队长 + 4 名队员，全部取自有学校身份的旧演示账号 */
const TEAM_SPECS = [
  { slug: 'heat', name: '热浪队', captain: 'u01', members: ['u02', 'u03', 'u04', 'u05'] },
  { slug: 'flash', name: '闪电队', captain: 'u06', members: ['u07', 'u08', 'u09', 'u10'] },
  { slug: 'rock', name: '磐石队', captain: 'u11', members: ['u12', 'u13', 'u14', 'u15'] },
  { slug: 'wind', name: '疾风队', captain: 'u16', members: ['u17', 'u18', 'u19', 'u20'] },
];

const teamIdOf = slug => schoolKey('tm', SCHOOL_ID, ASSOCIATION, slug);

/** 把整数按比例切成整数数组，和恰好等于原数（四舍五入会差个一两分） */
function splitExact(total, weights) {
  const out = weights.map(weight => Math.floor(total * weight));
  let left = total - out.reduce((sum, value) => sum + value, 0);
  for (let i = 0; left > 0; i += 1, left -= 1) out[i % out.length] += 1;
  return out;
}

/** 每节的全队得分：按 22 / 26 / 24 / 28 这样的节奏切，合计就是终场比分 */
function periodSplit(total, periods) {
  const weights = Array.from({ length: periods }, (_, index) => (index + 1) / (periods * (periods + 1) / 2));
  return splitExact(total, weights);
}

/** 得分权重：首发三人拿大头，替补也有零有整 */
const POINT_WEIGHTS = [0.45, 0.3, 0.15, 0.1, 0];
/** 其他指标的固定形态：和比分无关，只要稳定可复现 */
const OTHER_STATS = [
  { rebounds: 7, assists: 5, steals: 2, blocks: 1, turnovers: 2, fouls: 1 },
  { rebounds: 5, assists: 3, steals: 1, blocks: 1, turnovers: 2, fouls: 2 },
  { rebounds: 4, assists: 2, steals: 1, blocks: 0, turnovers: 1, fouls: 3 },
  { rebounds: 3, assists: 1, steals: 0, blocks: 0, turnovers: 1, fouls: 2 },
  { rebounds: 2, assists: 0, steals: 0, blocks: 0, turnovers: 1, fouls: 4 },
];

/** 按节造一队 5 个人的统计行；合计得分与球队终场比分分毫不差 */
function statRowsOf(roster, teamScore, periods) {
  const perPeriod = periodSplit(teamScore, periods);
  const rows = [];
  roster.forEach((player, index) => {
    for (let period = 1; period <= periods; period += 1) {
      const teamPoints = perPeriod[period - 1];
      const mine = splitExact(teamPoints, POINT_WEIGHTS)[index];
      rows.push({
        period,
        userId: player.userId,
        points: mine,
        ...OTHER_STATS[index % OTHER_STATS.length],
      });
    }
  });
  return rows;
}

/** 球队文档 */
function teamDocs() {
  return TEAM_SPECS.map((spec) => {
    const teamId = teamIdOf(spec.slug);
    const roster = [spec.captain, ...spec.members];
    const docs = [{
      _id: teamId,
      schoolId: SCHOOL_ID,
      association: ASSOCIATION,
      sport: 'basketball',
      name: spec.name,
      captainId: spec.captain,
      status: TEAM_STATUS.ACTIVE,
      createdAt: ISO,
      updatedAt: ISO,
    }];
    roster.forEach((userId, index) => {
      docs.push({
        _id: teamMemberKey(teamId, userId),
        schoolId: SCHOOL_ID,
        association: ASSOCIATION,
        teamId,
        userId,
        role: index === 0 ? 'captain' : 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE,
        joinedAt: ISO,
        updatedAt: ISO,
      });
    });
    return docs;
  }).flat();
}

/** 报名文档（含锁定那一刻的名单快照） */
function entryDocOf(eventId, spec, status, placement) {
  const teamId = teamIdOf(spec.slug);
  const roster = [spec.captain, ...spec.members];
  return {
    _id: schoolKey('ten', eventId, teamId),
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    eventId,
    teamId,
    status,
    roster: roster.map(userId => ({ userId, name: nameOf(userId) })),
    submittedBy: spec.captain,
    submittedAt: ISO,
    lockedAt: status === TEAM_ENTRY_STATUS.LOCKED ? ISO : null,
    placement: placement || null,
    updatedAt: ISO,
  };
}

/**
 * 一届已打完的淘汰赛：4 队 → 半决赛 ×2 + 决赛 + 季军赛，全部已发布并结算。
 * 这是演示数据的主体：赛程、名次、统计、球员榜全都挂在它身上。
 */
function finishedEvent() {
  const eventId = schoolKey('tev', SCHOOL_ID, ASSOCIATION, 'intercollegiate');
  const rules = normalizeBasketballRules({ presetKey: 'fiba-4x10' });
  const periods = rules.periods;
  const [heat, flash, rock, wind] = TEAM_SPECS;
  const rosterOf = spec => [spec.captain, ...spec.members].map(userId => ({ userId, name: nameOf(userId) }));

  const event = {
    _id: eventId,
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    name: '院际篮球邀请赛',
    format: EVENT_FORMAT.SINGLE_ELIM,
    rules,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    statPolicy: 'detailed',
    status: TEAM_EVENT_STATUS.FINISHED,
    entryMin: rules.rosterMin,
    entryMax: rules.rosterMax,
    // 已结束的一届：开赛落在 30 天前，finishedAt 用锚点（今天 09:00），
    // 「先开赛、后结束」的顺序才成立
    startTime: demoIso(-30),
    location: '体育馆主馆',
    lockedCount: 4,
    finishedAt: ISO,
    revision: 6,
    createdAt: ISO,
    updatedAt: ISO,
  };

  // 对阵必须是「一支队只从一个通道走下去」：
  //   半决赛 热浪胜闪电、疾风胜磐石 → 决赛 热浪 vs 疾风；
  //   季军赛由**两个半决赛的负者**打：闪电 vs 磐石。
  // 负者若同时出现在季军赛和决赛里，整届赛事就是假的（曾经就是这么摆错的）。
  const plan = [
    { round: 1, stage: BRACKET_STAGE.MAIN, slot: 0, a: heat, b: flash, scoreA: 78, scoreB: 71 },
    { round: 1, stage: BRACKET_STAGE.MAIN, slot: 1, a: rock, b: wind, scoreA: 66, scoreB: 74 },
    { round: 2, stage: BRACKET_STAGE.BRONZE, slot: 0, a: flash, b: rock, scoreA: 81, scoreB: 69 },
    { round: 2, stage: BRACKET_STAGE.MAIN, slot: 0, a: heat, b: wind, scoreA: 85, scoreB: 79 },
  ];

  const matches = plan.map((item) => {
    const matchId = eventMatchKey(eventId, item.round, item.stage, item.slot);
    const winner = item.scoreA > item.scoreB ? 'A' : 'B';
    return {
      _id: matchId,
      schoolId: SCHOOL_ID,
      association: ASSOCIATION,
      eventId,
      round: item.round,
      stage: item.stage,
      slot: item.slot,
      teamA: teamIdOf(item.a.slug),
      teamB: teamIdOf(item.b.slug),
      scoreA: item.scoreA,
      scoreB: item.scoreB,
      overtime: false,
      forfeit: null,
      winner,
      status: TEAM_MATCH_STATUS.PUBLISHED,
      matchTime: demoIso(-30),
      location: '体育馆主馆',
      recordedBy: 'demo_muc_admin',
      recordedAt: ISO,
      publishedBy: 'demo_muc_admin',
      publishedAt: ISO,
      // 这一届的名单赛前就定过：四队都按整份报名名单上场。
      // 演示数据不写名单，会让「已记录出场」和名单页的「已定 / 未定」双双为 0，
      // 看起来像功能坏了，而不是数据没填。
      lineups: {
        A: rosterOf(item.a).map(player => player.userId),
        B: rosterOf(item.b).map(player => player.userId),
      },
      revision: 2,
      createdAt: ISO,
      updatedAt: ISO,
    };
  });

  const stats = [];
  matches.forEach((match, index) => {
    const item = plan[index];
    [
      { spec: item.a, teamId: match.teamA, score: match.scoreA },
      { spec: item.b, teamId: match.teamB, score: match.scoreB },
    ].forEach((side) => {
      const key = schoolKey('tms', match._id, side.teamId);
      const rows = statRowsOf(rosterOf(side.spec), side.score, periods);
      stats.push({
        _id: key,
        schoolId: SCHOOL_ID,
        association: ASSOCIATION,
        eventId,
        matchId: match._id,
        teamId: side.teamId,
        mode: 'detailed',
        rows,
        players: [],
        integrity: 'full',
        // 演示的这一届已打完并发布：统计带着已发布快照，球员榜直接读得到。
        // 工作副本与快照此时是同一版——「已发布但不带快照」会让榜单空着。
        status: 'published',
        published: {
          mode: 'detailed',
          rows,
          players: [],
          integrity: 'full',
          revision: 1,
          publishedAt: ISO,
          publishedBy: 'demo_muc_admin',
        },
        publishedRevision: 1,
        publishedBy: 'demo_muc_admin',
        publishedAt: ISO,
        revision: 1,
        updatedBy: 'demo_muc_admin',
        updatedAt: ISO,
      });
    });
  });

  // 名次：冠军热浪、亚军疾风、季军闪电、第四磐石
  const placements = [
    { rank: 1, teamId: teamIdOf('heat'), teamName: '热浪队', note: '冠军' },
    { rank: 2, teamId: teamIdOf('wind'), teamName: '疾风队', note: '亚军' },
    { rank: 3, teamId: teamIdOf('flash'), teamName: '闪电队', note: '季军' },
    { rank: 4, teamId: teamIdOf('rock'), teamName: '磐石队', note: '第四名' },
  ];
  event.placements = placements;
  event.draw = {
    format: EVENT_FORMAT.SINGLE_ELIM,
    size: 4,
    slots: [teamIdOf('heat'), teamIdOf('flash'), teamIdOf('rock'), teamIdOf('wind')],
    byes: [],
    seeds: [],
    seed: 20260301,
    roundCount: 2,
    drawnAt: ISO,
  };

  const entries = TEAM_SPECS.map(spec => entryDocOf(
    eventId, spec, TEAM_ENTRY_STATUS.LOCKED,
    (placements.find(row => row.teamId === teamIdOf(spec.slug)) || {}).rank || null
  ));

  return { event, entries, matches, stats };
}

/** 一届还在报名的赛事：一支已通过、一支待审核，用来演示审核与锁定 */
function registrationEvent() {
  const eventId = schoolKey('tev', SCHOOL_ID, ASSOCIATION, 'freshman');
  const rules = normalizeBasketballRules({ presetKey: 'campus-2x20' });
  const [heat, flash] = TEAM_SPECS;
  const event = {
    _id: eventId,
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    name: '新生杯（报名中）',
    format: EVENT_FORMAT.SINGLE_ELIM,
    rules,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    statPolicy: 'basic',
    status: TEAM_EVENT_STATUS.REGISTRATION,
    entryMin: rules.rosterMin,
    entryMax: rules.rosterMax,
    // 报名中的一届：开赛排在 12 天后，报名期落在「今天往前」这一段的语义才对
    startTime: demoIso(12),
    location: '东体育馆',
    lockedCount: 0,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  };
  const entries = [
    entryDocOf(eventId, heat, TEAM_ENTRY_STATUS.APPROVED),
    entryDocOf(eventId, flash, TEAM_ENTRY_STATUS.SUBMITTED),
  ];
  return { event, entries };
}

/**
 * 扩容（2026-10-20）：在原有「已打完 + 报名中」两届之外，再补四届，
 * 让赛事数到 6（3 倍）、场次到 12（3 倍），并且四种状态各有一届：
 *
 *   · 循环赛已结束 —— 四队单循环 3 轮 6 场，名次 1–4
 *   · 单败进行中   —— 半决赛已发布，决赛还没生成
 *   · 报名中       —— 一支通过、一支待审核
 *   · 已抽签待开赛 —— 名单锁定、签表已有、还没打
 *
 * 【为什么场次分布是 6 + 2】
 * 原有 4 场（半决赛 ×2 + 季军赛 + 决赛），加到 12 场正好 3 倍。
 * 循环赛按 4 队单循环自然是 6 场，剩下的 2 场放在「进行中」的半决赛上——
 * 不是硬凑数字：多出来的两届状态本来就该看到赛程的样子。
 */
function scaledTeamEvents() {
  const [heat, flash, rock, wind] = TEAM_SPECS;
  const rules = normalizeBasketballRules({ presetKey: 'campus-2x20' });
  const periods = rules.periods;
  const rosterOf = spec => [spec.captain, ...spec.members].map(userId => ({ userId, name: nameOf(userId) }));
  const teamId = spec => teamIdOf(spec.slug);
  const baseEvent = (slug, extra) => ({
    _id: schoolKey('tev', SCHOOL_ID, ASSOCIATION, slug),
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    rules,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    statPolicy: 'basic',
    entryMin: rules.rosterMin,
    entryMax: rules.rosterMax,
    lockedCount: 0,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...extra,
  });

  // 1. 循环赛：四队单循环 3 轮 × 2 场
  const roundRobin = baseEvent('round-robin', {
    name: '院际篮球循环赛',
    format: EVENT_FORMAT.ROUND_ROBIN,
    status: TEAM_EVENT_STATUS.FINISHED,
    startTime: demoIso(-120),
    location: '体育馆副馆',
    lockedCount: 4,
    finishedAt: ISO,
    revision: 4,
  });
  const roundRobinPairs = [
    [heat, flash, 81, 74],
    [rock, wind, 69, 77],
    [heat, rock, 88, 70],
    [flash, wind, 76, 80],
    [heat, wind, 83, 79],
    [flash, rock, 72, 68],
  ];
  const roundRobinMatches = roundRobinPairs.map(([a, b, scoreA, scoreB], index) => ({
    _id: eventMatchKey(roundRobin._id, Math.floor(index / 2) + 1, 'group', index % 2),
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    eventId: roundRobin._id,
    round: Math.floor(index / 2) + 1,
    stage: 'group',
    slot: index % 2,
    teamA: teamId(a),
    teamB: teamId(b),
    scoreA,
    scoreB,
    overtime: false,
    forfeit: null,
    winner: scoreA > scoreB ? 'A' : 'B',
    status: TEAM_MATCH_STATUS.PUBLISHED,
    matchTime: demoAt(-120 + Math.floor(index / 2), 9),
    location: '体育馆副馆',
    recordedBy: 'demo_muc_admin',
    recordedAt: ISO,
    publishedBy: 'demo_muc_admin',
    publishedAt: ISO,
    lineups: { A: rosterOf(a).map(p => p.userId), B: rosterOf(b).map(p => p.userId) },
    revision: 2,
    createdAt: ISO,
    updatedAt: ISO,
  }));
  // 循环赛名次：按胜负场排（热浪 3 胜、疾风 2 胜、闪电 1 胜、磐石 0 胜）
  const roundRobinPlacements = [
    { teamId: teamId(heat), teamName: heat.name, rank: 1, note: '冠军' },
    { teamId: teamId(wind), teamName: wind.name, rank: 2, note: '亚军' },
    { teamId: teamId(flash), teamName: flash.name, rank: 3, note: '季军' },
    { teamId: teamId(rock), teamName: rock.name, rank: 4, note: '' },
  ];
  roundRobin.placements = roundRobinPlacements;

  // 2. 单败进行中：半决赛已发布，决赛等晋级结果
  const running = baseEvent('winter-invitational', {
    name: '冬季篮球邀请赛',
    format: EVENT_FORMAT.SINGLE_ELIM,
    status: TEAM_EVENT_STATUS.RUNNING,
    startTime: demoIso(-6),
    location: '体育馆主馆',
    lockedCount: 4,
    draw: { size: 4, roundCount: 2, slots: [teamId(heat), teamId(flash), teamId(rock), teamId(wind)] },
    revision: 3,
  });
  const runningMatches = [
    { a: heat, b: flash, scoreA: 79, scoreB: 73 },
    { a: rock, b: wind, scoreA: 71, scoreB: 68 },
  ].map((item, index) => ({
    _id: eventMatchKey(running._id, 1, BRACKET_STAGE.MAIN, index),
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    eventId: running._id,
    round: 1,
    stage: BRACKET_STAGE.MAIN,
    slot: index,
    teamA: teamId(item.a),
    teamB: teamId(item.b),
    scoreA: item.scoreA,
    scoreB: item.scoreB,
    overtime: false,
    forfeit: null,
    winner: 'A',
    status: TEAM_MATCH_STATUS.PUBLISHED,
    matchTime: demoAt(-6, index === 0 ? 9 : 10, 30),
    location: '体育馆主馆',
    recordedBy: 'demo_muc_admin',
    recordedAt: ISO,
    publishedBy: 'demo_muc_admin',
    publishedAt: ISO,
    lineups: { A: rosterOf(item.a).map(p => p.userId), B: rosterOf(item.b).map(p => p.userId) },
    revision: 2,
    createdAt: ISO,
    updatedAt: ISO,
  }));

  // 3. 报名中：一支通过、一支待审核（与既有「新生杯」错开，避免同名同状态）
  const autumn = baseEvent('autumn-league', {
    name: '秋季篮球联赛（报名中）',
    format: EVENT_FORMAT.SINGLE_ELIM,
    status: TEAM_EVENT_STATUS.REGISTRATION,
    startTime: demoIso(25),
    location: '东体育馆',
  });
  const autumnEntries = [
    entryDocOf(autumn._id, rock, TEAM_ENTRY_STATUS.APPROVED),
    entryDocOf(autumn._id, wind, TEAM_ENTRY_STATUS.SUBMITTED),
  ];

  // 4. 已抽签待开赛：名单锁定、签表已有、一场未打
  const spring = baseEvent('spring-cup', {
    name: '春季篮球杯（待开赛）',
    format: EVENT_FORMAT.SINGLE_ELIM,
    status: TEAM_EVENT_STATUS.SCHEDULED,
    startTime: demoIso(160),
    location: '体育馆主馆',
    lockedCount: 4,
    draw: { size: 4, roundCount: 2, slots: [teamId(flash), teamId(heat), teamId(wind), teamId(rock)] },
    revision: 2,
  });
  const springEntries = [heat, flash, rock, wind]
    .map(spec => entryDocOf(spring._id, spec, TEAM_ENTRY_STATUS.LOCKED));

  // 循环赛的统计与既有那一届同源：已发布的比赛必须带统计，
  // 否则球员榜与「我的球队」的累计会缺一半数据。
  const roundRobinStats = [];
  roundRobinMatches.forEach((match, index) => {
    const [a, b] = roundRobinPairs[index];
    [
      { spec: a, sideTeamId: match.teamA, score: match.scoreA },
      { spec: b, sideTeamId: match.teamB, score: match.scoreB },
    ].forEach((side) => {
      const rows = statRowsOf(rosterOf(side.spec), side.score, periods);
      roundRobinStats.push({
        _id: schoolKey('tms', match._id, side.sideTeamId),
        schoolId: SCHOOL_ID,
        association: ASSOCIATION,
        eventId: roundRobin._id,
        matchId: match._id,
        teamId: side.sideTeamId,
        mode: 'basic',
        rows,
        players: [],
        integrity: 'full',
        status: 'published',
        published: { mode: 'basic', rows, players: [], integrity: 'full', revision: 1, publishedAt: ISO, publishedBy: 'demo_muc_admin' },
        publishedRevision: 1,
        publishedBy: 'demo_muc_admin',
        publishedAt: ISO,
        revision: 1,
        updatedBy: 'demo_muc_admin',
        updatedAt: ISO,
      });
    });
  });

  return {
    teamEvents: [roundRobin, running, autumn, spring],
    teamEventEntries: [
      ...[heat, flash, rock, wind].map(spec => entryDocOf(roundRobin._id, spec, TEAM_ENTRY_STATUS.LOCKED)),
      ...autumnEntries,
      ...springEntries,
    ],
    teamMatches: [...roundRobinMatches, ...runningMatches],
    teamMatchStats: roundRobinStats,
  };
}

/**
 * 团队演示内容。
 *
 * @returns {{teams:Array, teamMembers:Array, teamEvents:Array,
 *   teamEventEntries:Array, teamMatches:Array, teamMatchStats:Array, memberships:Array}}
 */
function createTeamDemoContent() {
  const finished = finishedEvent();
  const registration = registrationEvent();
  const scaled = scaledTeamEvents();

  // 协会会籍：让「默认演示身份 u06」与四支球队的队长都能真的去申请入队。
  // 只加 bk，不动其它协会的会籍名单。
  const rosterIds = TEAM_SPECS.flatMap(spec => [spec.captain, ...spec.members]);
  const memberships = [...new Set(rosterIds)].map((userId) => ({
    _id: schoolMembershipKey(userId, SCOPE),
    userId,
    schoolId: SCHOOL_ID,
    association: ASSOCIATION,
    role: userId === 'u01' ? 'leader' : 'member',
    status: 'active',
    simulated: true,
  }));

  const docs = teamDocs();
  return {
    teams: docs.filter(doc => !doc.teamId),
    teamMembers: docs.filter(doc => doc.teamId),
    teamEvents: [finished.event, registration.event, ...scaled.teamEvents],
    teamEventEntries: [...finished.entries, ...registration.entries, ...scaled.teamEventEntries],
    teamMatches: [...finished.matches, ...scaled.teamMatches],
    teamMatchStats: [...finished.stats, ...scaled.teamMatchStats],
    memberships,
  };
}

module.exports = { createTeamDemoContent };
