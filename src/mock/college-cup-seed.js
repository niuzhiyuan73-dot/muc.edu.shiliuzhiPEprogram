/**
 * 石榴籽杯演示数据（2026-10-20 扩容）
 * ============================================================
 * 目标：每个项目至少两届**已结束**的石榴籽杯，并且有两个项目各留一届**进行中**。
 *
 *   球拍项目（匹克球 / 乒乓 / 羽球 / 网球）
 *     · 2024 届：8 所学院、只打男单（规模大、只留一个签位维度）
 *     · 2025 届：4 所学院、男单 + 女单（规模小、两个小项）
 *     · 匹克球另有 2026 届进行中：八进四打完一半
 *   团队项目（篮球 / 足球）
 *     · 2024 / 2025 届：4 支院队单败淘汰，名次落在院队上
 *     · 篮球另有 2026 届进行中：半决赛打完一场
 *
 * 【为什么直接产文档，而不是把服务动作重放一遍】
 * 真实的「发布 → 交名单 → 审核 → 抽签 → 排阵 → 逐场录分 → 结名次」要跑上百次
 * 事务，而且依赖 mock 的同步动作栈；这里只是**演示历史**，读取端要的是
 * 「赛事 + 名单 + 大场 + 比分 + 名次」这几张表的最终形态。所以按真实文档的
 * 字段形状直接产，主键一律走 utils/school 的正式生成函数，读端分不出差别。
 *
 * 【为什么小场不落 matches】
 * 历史杯赛没人会回来改分，名次与签表已经写在赛事上；给小场造 matchId 反而
 * 会引出一堆指向不存在记录的链接（点进去「比赛不存在」）。所以小场只带
 * `scoreText` 与胜负，matchId 留空——这正是「历史记录」该有的样子。
 * ============================================================
 */

const { MEMBER_SEED } = require('./seed.js');
const {
  collegeEventKey, collegeEntryKey, collegeTeamKey, teamMemberKey, schoolKey,
} = require('../shared/utils/school.js');
const { collegeTieKey } = require('../shared/services/college-draw.js');
const {
  COLLEGES,
  COLLEGE_EVENT_STATUS, TIE_STATUS, LEG_DISCIPLINE, BRACKET_STAGE,
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_TYPE, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS,
  TEAM_MATCH_STATUS, CUP_MODE, MATCH_OUTCOME, EVENT_FORMAT,
} = require('../shared/utils/constants.js');
const { normalizeBasketballRules } = require('../shared/utils/basketball-rules.js');
const { normalizeFootballRules, DEFAULT_PRESET_KEY } = require('../shared/utils/football-rules.js');
const { normalizeFootballReport, FIELDS } = require('../shared/utils/football-report.js');
// 届次的年份与「进行中」那一届的时间线都跟着锚点滚，见 demo-clock.js
const { demoIso, demoAt, demoYear } = require('./demo-clock.js');

const SCHOOL_ID = 'muc';
const ADMIN_ID = 'demo_muc_admin';
/** 审计类时间戳统一取锚点（今天 09:00），不参与「赛事是否过期」的判断 */
const ISO = demoIso(0);

/** 会员按学院分桶：学院赛名单只能写本学院的人 */
const MEMBERS_BY_COLLEGE = (() => {
  const map = new Map();
  MEMBER_SEED.forEach((member, index) => {
    const userId = `u${String(index + 1).padStart(2, '0')}`;
    const row = map.get(member.college) || { ids: [], men: [], women: [] };
    row.ids.push(userId);
    if (member.gender === 'M') row.men.push(userId);
    if (member.gender === 'F') row.women.push(userId);
    map.set(member.college, row);
  });
  return map;
})();

const collegeRow = (college) => MEMBERS_BY_COLLEGE.get(college) || { ids: [], men: [], women: [] };

/**
 * 学院全名 → 稳定编号（c01…）。
 *
 * 名单主键与院队的管理权都按 collegeId 走：编号留空的话，学院负责人打开院队
 * 会被判成「不归你管」，杯赛名单也会与页面上提交的那条对不上。
 */
const COLLEGE_ID_BY_NAME = new Map(COLLEGES.map((name, index) => [
  name, `c${String(index + 1).padStart(2, '0')}`,
]));
const collegeIdOf = college => COLLEGE_ID_BY_NAME.get(college) || '';

/** 8 所学院：每所都有男队员（只打男单），且至少两名会员 */
const EIGHT_COLLEGES = Object.freeze([
  '体育学院', '信息工程学院', '经济学院', '管理学院',
  '法学院', '历史文化学院', '民族学与社会学学院', '教育学院',
]);
/** 4 所学院：男女都有人，排得出男单 + 女单 */
const FOUR_COLLEGES = Object.freeze(['经济学院', '管理学院', '法学院', '历史文化学院']);

const scopeOf = association => ({ schoolId: SCHOOL_ID, association });

/** 按 _id 去重：同一支院队会在多届杯赛里重复出现 */
function uniqueBy(rows) {
  const seen = new Map();
  for (const row of rows) if (row && row._id && !seen.has(row._id)) seen.set(row._id, row);
  return [...seen.values()];
}

/** 单败签表：每轮的对手按相邻签位两两配对，胜者进入下一轮 */
function bracketOf(colleges, ongoingRound = 0) {
  const rounds = [];
  let seeds = colleges.slice();
  let round = 1;
  while (seeds.length > 1) {
    const pairs = [];
    for (let index = 0; index < seeds.length; index += 2) {
      pairs.push([seeds[index], seeds[index + 1]]);
    }
    rounds.push({ round, pairs });
    seeds = pairs.map(pair => pair[0]);
    round += 1;
  }
  return ongoingRound > 0 ? rounds.filter(row => row.round <= ongoingRound) : rounds;
}

/**
 * 一届杯赛的时间线。
 * ============================================================
 * 【历史届与进行中届为什么要分开算】
 * 历史届已经打完，开赛钉在当年 5-18 就行——它永远在过去，不会与「现在」冲突。
 * 进行中的一届却不能钉日期：原先三年全写死（2024 / 2025 / 2026），2026 那届
 * 标着「进行中」却停在 5 月 18 日。今天（2026-10-20）打开就是「一场进行了
 * 五个月的学院赛」，界面上自相矛盾，而且再过几个月只会更离谱。
 *
 * 所以进行中的一届相对演示锚点排：开赛落在 6 天前（半决赛打完一半，正打到
 * 一半），报名与抽签在开赛前 20 天。锚点本身见 demo-clock.js，同一天内恒定。
 *
 * @param {number} year 届次（同时进标题）
 * @param {boolean} ongoing 是否进行中
 * @returns {{startTime:string, publishTime:string, startedAt:string,
 *   finishedAt:(string|undefined), matchTime:(slot:number)=>string}}
 */
function timelineOf(year, ongoing) {
  if (!ongoing) {
    return {
      startTime: `${year}-05-18T09:00:00.000Z`,
      publishTime: `${year}-05-01T09:00:00.000Z`,
      startedAt: `${year}-05-18T09:00:00.000Z`,
      finishedAt: `${year}-05-20T18:00:00.000Z`,
      matchTime: slot => `${year}-05-18T09:${String(slot * 20).padStart(2, '0')}:00.000Z`,
    };
  }
  return {
    startTime: demoAt(-6, 9),
    publishTime: demoIso(-20),
    startedAt: demoAt(-6, 9),
    finishedAt: undefined,
    matchTime: slot => demoAt(-6, 9, slot * 20),
  };
}

/** 一场小项：赢家按「签位靠前的一方」定，比分固定 11:5（网球 6:3） */
function legOf(discipline, tennis, aWins = true) {
  return {
    legNo: 0,
    discipline,
    matchId: '',
    winner: aWins ? 'A' : 'B',
    outcome: MATCH_OUTCOME.NORMAL,
    scoreText: aWins ? (tennis ? '6:3' : '11:5') : (tennis ? '3:6' : '5:11'),
  };
}

/**
 * 一届球拍学院赛（赛事 + 名单 + 大场）。
 *
 * @param {Object} options
 * @param {string} options.association 协会 id
 * @param {string} options.sportName 项目名（进标题）
 * @param {number} options.year 届次（进标题）
 * @param {Array<string>} options.colleges 参赛学院
 * @param {Array<string>} options.disciplines 小项
 * @param {boolean} [options.ongoing] 是否进行中
 */
function racketCup({ association, sportName, year, colleges, disciplines, ongoing = false }) {
  const scope = scopeOf(association);
  const tennis = association === 'tn';
  const eventId = collegeEventKey(`cup-${association}-${year}`, scope);
  const rounds = bracketOf(colleges, ongoing ? 2 : 0);
  const finished = !ongoing;
  const tl = timelineOf(year, ongoing);

  const entries = colleges.map((college) => {
    const row = collegeRow(college);
    const collegeId = collegeIdOf(college);
    return {
      _id: collegeEntryKey(eventId, collegeId || college, scope),
      eventId,
      schoolId: SCHOOL_ID,
      association,
      college,
      collegeId,
      members: row.ids.slice(),
      status: 'approved',
      submitBy: ADMIN_ID,
      submittedName: '演示管理员',
      submitTime: ISO,
      reviewedBy: ADMIN_ID,
      reviewTime: ISO,
      revision: 1,
      remark: '',
      reason: '',
    };
  });

  const ties = [];
  rounds.forEach(({ round, pairs }) => {
    pairs.forEach(([collegeA, collegeB], slot) => {
      const tieId = collegeTieKey(eventId, round, slot, BRACKET_STAGE.MAIN);
      // 进行中：八进四全部打完；半决赛只打完第一场，第二场停在「待开赛」。
      // 已结束：全部打完，只留决赛与季军赛的胜负。
      const isLastOfRound = slot === pairs.length - 1;
      const pending = ongoing && round === 2 && isLastOfRound;
      const legs = disciplines.map((discipline, index) => {
        const leg = legOf(discipline, tennis, true);
        leg.legNo = index + 1;
        if (pending) {
          leg.winner = null;
          leg.scoreText = '';
        }
        return leg;
      });
      ties.push({
        _id: tieId,
        eventId,
        schoolId: SCHOOL_ID,
        association,
        round,
        stage: BRACKET_STAGE.MAIN,
        slot,
        collegeA,
        collegeB,
        legs,
        winner: pending ? null : 'A',
        status: pending ? TIE_STATUS.READY : TIE_STATUS.FINISHED,
        referee: '',
        refereeAt: null,
        refereeBy: '',
        lineupA: !pending,
        lineupB: !pending,
        startedAt: pending ? null : ISO,
        finishedAt: pending ? null : ISO,
        courtNo: slot + 1,
        revision: 1,
        updatedAt: ISO,
      });
    });
  });

  // 季军赛：两个半决赛的负者（只在打完之后才出现）
  if (finished && colleges.length >= 4) {
    const losers = ties
      .filter(tie => tie.round === 1)
      .map(tie => tie.collegeB);
    const semiRound = Math.max(...ties.map(tie => tie.round));
    if (losers.length >= 2) {
      const bronzeId = collegeTieKey(eventId, semiRound, 99, BRACKET_STAGE.BRONZE);
      ties.push({
        _id: bronzeId,
        eventId,
        schoolId: SCHOOL_ID,
        association,
        round: semiRound,
        stage: BRACKET_STAGE.BRONZE,
        slot: 0,
        collegeA: losers[0],
        collegeB: losers[1],
        legs: disciplines.map((discipline, index) => ({
          ...legOf(discipline, tennis, index === 0),
          legNo: index + 1,
        })),
        winner: 'A',
        status: TIE_STATUS.FINISHED,
        referee: '',
        refereeAt: null,
        refereeBy: '',
        lineupA: true,
        lineupB: true,
        startedAt: ISO,
        finishedAt: ISO,
        courtNo: 1,
        revision: 1,
        updatedAt: ISO,
      });
    }
  }

  const placements = finished
    ? colleges.map((college, index) => ({ college, placement: index + 1 }))
    : [];

  const event = {
    _id: eventId,
    schoolId: SCHOOL_ID,
    association,
    title: `${year} 石榴籽杯${sportName}学院赛`,
    description: finished
      ? `${colleges.length} 所学院单败淘汰，已结束`
      : `${colleges.length} 所学院单败淘汰，当前进行到半决赛`,
    format: EVENT_FORMAT.SINGLE_ELIM,
    legPlan: disciplines.slice(),
    allowMultiEntry: true,
    rosterMin: 2,
    rosterMax: 20,
    tieAlgo: 'full_points',
    tieNetMode: 'win_diff',
    status: finished ? COLLEGE_EVENT_STATUS.FINISHED : COLLEGE_EVENT_STATUS.ONGOING,
    currentRound: finished ? bracketOf(colleges).length : 2,
    seedColleges: colleges.slice(),
    results: placements,
    location: association === 'tn' ? '网球场' : '学校体育馆',
    startTime: tl.startTime,
    publishTime: tl.publishTime,
    courtCount: 4,
    pinned: false,
    publisherId: ADMIN_ID,
    publisherName: '演示管理员',
    draw: { size: colleges.length, roundCount: bracketOf(colleges).length, slots: colleges.slice(), byes: [], seeds: [] },
    fingerprint: JSON.stringify([`${year}`, association, colleges.length]),
    revision: finished ? 4 : 3,
    startedAt: tl.startedAt,
    ...(finished ? { finishedAt: tl.finishedAt } : {}),
    updatedAt: ISO,
  };

  return { event, entries, ties };
}

/** 团队项目的一届学院赛：篮球 4 院淘汰赛，足球 2 院单场决赛（见下方说明） */
function teamCup({ association, sportName, year, ongoing = false }) {
  const scope = scopeOf(association);
  const eventId = schoolKey('tev', SCHOOL_ID, association, `cup-${year}`);
  const football = association === 'fb';
  // 【足球为什么只有 2 支院队】足球是 11 人制：首发 11 人、最低 7 人上场。
  // 4 队 × 11 = 44 人，种子池（24 名会员）撑不住；硬按 5 人一队造，就会得到
  // 「5 人院队打 11 人制杯赛还能拿名次」——连一份合法的赛后报告都发不出来
  // （normalizeFootballReport 要求首发 11 人），统计端只能整场丢弃，
  // 界面上就表现成「一场没打却有名次」。
  // 所以足球缩到 2 支院队 × 11 人打一场决赛，规模小但每一环都能自洽。
  // 篮球 5 人制仍保留 4 院单败淘汰的完整形状。
  const colleges = football ? FOUR_COLLEGES.slice(0, 2) : FOUR_COLLEGES.slice();
  const rosterSize = football ? 11 : 5;
  const rules = football ? normalizeFootballRules({ presetKey: DEFAULT_PRESET_KEY }) : normalizeBasketballRules({ presetKey: 'fiba-4x10' });
  const tl = timelineOf(year, ongoing);

  // 院队：系统预置的学院代表队。足球每队 11 人（能踢 11 人制），篮球每队 5 人。
  const pool = football
    ? Array.from({ length: 22 }, (_, index) => `u${String(index + 1).padStart(2, '0')}`)
    : ['u01', 'u02', 'u03', 'u04', 'u05', 'u06', 'u07', 'u08', 'u09', 'u10',
      'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20'];
  const nameOf = (userId) => {
    const index = Number(String(userId).slice(1)) - 1;
    const member = MEMBER_SEED[index];
    return member ? `${member.nickName}` : userId;
  };
  const teams = [];
  const teamMembers = [];
  const entries = [];
  // 院队编号必须与系统派生的一致（collegeTeamKey 收的是 collegeId，不是全名），
  // 否则「我的球队」里的院队与杯赛里的院队会是两支不同的队。
  const teamIdFor = college => collegeTeamKey(collegeIdOf(college) || college, scope);
  colleges.forEach((college, index) => {
    const teamId = teamIdFor(college);
    const roster = pool.slice(index * rosterSize, index * rosterSize + rosterSize);
    teams.push({
      _id: teamId,
      schoolId: SCHOOL_ID,
      association,
      sport: football ? 'football' : 'basketball',
      name: `${college}代表队`,
      college,
      collegeId: collegeIdOf(college),
      type: TEAM_TYPE.COLLEGE,
      status: TEAM_STATUS.ACTIVE,
      captainId: '',
      memberCount: roster.length,
      revision: 1,
      createdBy: ADMIN_ID,
      createdAt: ISO,
      updatedAt: ISO,
    });
    roster.forEach((userId) => {
      teamMembers.push({
        _id: teamMemberKey(teamId, userId),
        schoolId: SCHOOL_ID,
        association,
        teamId,
        userId,
        role: 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE,
        source: 'picked',
        joinedAt: ISO,
        leftAt: null,
        updatedAt: ISO,
      });
    });
    entries.push({
      _id: schoolKey('ten', eventId, teamId),
      schoolId: SCHOOL_ID,
      association,
      eventId,
      teamId,
      status: TEAM_ENTRY_STATUS.LOCKED,
      roster: roster.map((userId, playerIndex) => ({ userId, name: nameOf(userId), no: playerIndex + 1 })),
      submittedBy: ADMIN_ID,
      submittedAt: ISO,
      reviewedBy: ADMIN_ID,
      reviewedAt: ISO,
      lockedAt: ISO,
      placement: null,
      updatedAt: ISO,
    });
  });

  // 单败：篮球「半决赛两场 → 决赛 + 季军赛」，足球「一场决赛」
  const roundRobin = false;
  const rosterOf = college => (entries.find(row => row.teamId === teamIdFor(college)) || {}).roster || [];
  /**
   * 足球赛的赛后报告快照。
   *
   * 【为什么必须有】统计端只认 `status === 'published' && footballPublished`
   * 的比赛；缺报告的比赛连比分都显示不出来（详情页从报告里取比分），
   * 出场与战绩一律为 0 —— 这就会造出「没打却有亚军」的假象。
   */
  const footballReportOf = (home, away, scoreA, scoreB) => {
    const sidesOf = (college, goals) => ({
      players: rosterOf(college).map((player, index) => ({
        userId: player.userId, starter: true, appeared: true, goalkeeper: index === 0,
        ...Object.fromEntries(Object.keys(FIELDS).map(field => [field, null])),
        goals: index < goals ? 1 : 0,
        ownGoals: 0, assists: 0, yellowCards: 0, secondYellow: 0, directRed: 0,
      })),
      coverage: Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? 'none' : 'full'])),
      substitutions: { status: 'full', regulationCount: 0, regulationOpportunities: 0, halfTimeCount: 0,
        extraTimeCount: 0, extraTimeOpportunities: 0, extraBreakCount: 0, incomingIds: [] },
    });
    const goalEvents = [];
    for (let n = 0; n < scoreA; n += 1) goalEvents.push({ side: 'A', type: 'normal', scorerId: rosterOf(home)[n].userId });
    for (let n = 0; n < scoreB; n += 1) goalEvents.push({ side: 'B', type: 'normal', scorerId: rosterOf(away)[n].userId });
    const out = normalizeFootballReport(
      { result: { regulationScore: { A: scoreA, B: scoreB } }, sides: { A: sidesOf(home, scoreA), B: sidesOf(away, scoreB) }, goalEvents },
      { rules, format: 'single_elim', rosters: { A: rosterOf(home), B: rosterOf(away) } },
    );
    if (!out.ok) throw new Error(`学院赛足球报告不合法：${out.message}`);
    return out.value;
  };
  const matches = [];
  const pushMatch = (round, stage, slot, home, away, scoreA, scoreB, status) => {
    matches.push({
      _id: `x_${eventId}_r${round}_${stage}_${slot}`,
      schoolId: SCHOOL_ID,
      association,
      eventId,
      sportFormat: football ? 'football11' : undefined,
      rules,
      // 对阵必须按签位传进来。原先写死 colleges[0] / colleges[1]，结果一届
      // 「4 院单败」的 4 场全是同两队，另外两院一场没打却排 3、4 名。
      teamA: teamIdFor(home),
      teamB: teamIdFor(away),
      round,
      stage,
      slot,
      status,
      scoreA,
      scoreB,
      winner: scoreA > scoreB ? 'A' : 'B',
      forfeit: null,
      overtime: false,
      ...(football ? {
        footballPublished: footballReportOf(home, away, scoreA, scoreB),
        footballPublishedRevision: 2, footballDraft: null,
      } : {}),
      revision: 2,
      recordedBy: ADMIN_ID,
      publishedBy: ADMIN_ID,
      publishedAt: ISO,
      matchTime: tl.matchTime(slot),
      location: '学校体育馆',
      createdAt: ISO,
      updatedAt: ISO,
    });
  };
  if (football) {
    // 2 院单场决胜：c0 2:1 c1
    if (!ongoing) pushMatch(1, BRACKET_STAGE.MAIN, 0, colleges[0], colleges[1], 2, 1, TEAM_MATCH_STATUS.PUBLISHED);
  } else {
    // 4 院单败：半决赛（c0 v c1、c2 v c3）→ 决赛（c0 v c3）+ 季军赛（c1 v c2）
    pushMatch(1, BRACKET_STAGE.MAIN, 0, colleges[0], colleges[1], 78, 71, TEAM_MATCH_STATUS.PUBLISHED);
    pushMatch(1, BRACKET_STAGE.MAIN, 1, colleges[2], colleges[3], 66, 74, TEAM_MATCH_STATUS.PUBLISHED);
    if (!ongoing) {
      pushMatch(2, BRACKET_STAGE.BRONZE, 0, colleges[1], colleges[2], 81, 69, TEAM_MATCH_STATUS.PUBLISHED);
      pushMatch(2, BRACKET_STAGE.MAIN, 0, colleges[0], colleges[3], 85, 79, TEAM_MATCH_STATUS.PUBLISHED);
    }
  }

  // 名次由上面的结果推出，不再按学院顺序硬排：
  //   足球 —— c0 2:1 胜 → c0 冠军、c1 亚军
  //   篮球 —— c0 决赛胜 c3；c3 亚军；季军赛 c1 胜 c2 → c1 季军、c2 第四
  const ranked = football
    ? [colleges[0], colleges[1]]
    : [colleges[0], colleges[3], colleges[1], colleges[2]];
  const placements = ongoing ? [] : ranked.map((college, index) => ({
    teamId: teamIdFor(college),
    teamName: `${college}代表队`,
    rank: index + 1,
    note: index === 0 ? '冠军' : (index === 1 ? '亚军' : ''),
  }));

  const event = {
    _id: eventId,
    schoolId: SCHOOL_ID,
    association,
    name: `${year} 石榴籽杯${sportName}学院赛`,
    format: roundRobin ? EVENT_FORMAT.ROUND_ROBIN : EVENT_FORMAT.SINGLE_ELIM,
    rules,
    sportFormat: football ? 'football11' : undefined,
    bronzeMode: 'playoff',
    statPolicy: 'basic',
    status: ongoing ? TEAM_EVENT_STATUS.RUNNING : TEAM_EVENT_STATUS.FINISHED,
    cupMode: CUP_MODE.COLLEGE,
    entryMin: rules.eventRosterMin || rules.rosterMin,
    entryMax: rules.eventRosterMax || rules.rosterMax,
    startTime: tl.startTime,
    location: '学校体育馆',
    lockedCount: colleges.length,
    draw: { size: colleges.length, roundCount: football ? 1 : 2, slots: colleges.map(college => teamIdFor(college)) },
    placements,
    revision: ongoing ? 3 : 5,
    createdBy: ADMIN_ID,
    createdAt: ISO,
    updatedAt: ISO,
    ...(ongoing ? {} : { finishedAt: tl.finishedAt }),
  };

  return {
    teams, teamMembers, teamEvents: [event], teamEventEntries: entries, teamMatches: matches,
  };
}

/**
 * 石榴籽杯演示内容。
 *
 * @returns {{collegeEvents:Array, collegeEntries:Array, ties:Array,
 *   teams:Array, teamMembers:Array, teamEvents:Array,
 *   teamEventEntries:Array, teamMatches:Array}}
 */
function createCollegeCupContent() {
  const racketProjects = [
    { association: 'pkb', sportName: '匹克球', ongoing: true },
    { association: 'tt', sportName: '乒乓球', ongoing: false },
    { association: 'bd', sportName: '羽毛球', ongoing: false },
    { association: 'tn', sportName: '网球', ongoing: false },
  ];
  const collegeEvents = [];
  const collegeEntries = [];
  const ties = [];
  for (const project of racketProjects) {
    const cups = [
      racketCup({
        association: project.association, sportName: project.sportName, year: demoYear() - 2,
        colleges: EIGHT_COLLEGES, disciplines: [LEG_DISCIPLINE.MS],
      }),
      racketCup({
        association: project.association, sportName: project.sportName, year: demoYear() - 1,
        colleges: FOUR_COLLEGES, disciplines: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
      }),
    ];
    if (project.ongoing) {
      cups.push(racketCup({
        association: project.association, sportName: project.sportName, year: demoYear(),
        colleges: EIGHT_COLLEGES, disciplines: [LEG_DISCIPLINE.MS], ongoing: true,
      }));
    }
    for (const cup of cups) {
      collegeEvents.push(cup.event);
      collegeEntries.push(...cup.entries);
      ties.push(...cup.ties);
    }
  }

  const teamContent = { teams: [], teamMembers: [], teamEvents: [], teamEventEntries: [], teamMatches: [] };
  for (const project of [
    { association: 'bk', sportName: '篮球', ongoing: true },
    { association: 'fb', sportName: '足球', ongoing: false },
  ]) {
    const cups = [
      teamCup({ association: project.association, sportName: project.sportName, year: demoYear() - 2 }),
      teamCup({ association: project.association, sportName: project.sportName, year: demoYear() - 1 }),
    ];
    if (project.ongoing) {
      cups.push(teamCup({
        association: project.association, sportName: project.sportName, year: demoYear(), ongoing: true,
      }));
    }
    for (const cup of cups) {
      teamContent.teams.push(...cup.teams);
      teamContent.teamMembers.push(...cup.teamMembers);
      teamContent.teamEvents.push(...cup.teamEvents);
      teamContent.teamEventEntries.push(...cup.teamEventEntries);
      teamContent.teamMatches.push(...cup.teamMatches);
    }
  }

  return {
    collegeEvents,
    collegeEntries,
    ties,
    // 同一支院队会出现在一届届杯赛里：球队与队员按编号去重，赛事/报名/比赛各自独立
    teams: uniqueBy(teamContent.teams),
    teamMembers: uniqueBy(teamContent.teamMembers),
    teamEvents: teamContent.teamEvents,
    teamEventEntries: teamContent.teamEventEntries,
    teamMatches: teamContent.teamMatches,
  };
}

module.exports = { createCollegeCupContent };
