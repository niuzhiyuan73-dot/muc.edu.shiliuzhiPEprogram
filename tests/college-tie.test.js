/**
 * 学院赛大场规则的纯逻辑自检
 * ============================================================
 * 大场（tie）是「两个学院之间的一轮对抗」，是赛事级开始与排阵之间的
 * 中间层。每条边界都用字面量钉死：
 *
 *   1. 赛事级开始 —— 仅管理员，且必须已抽签（D35）；
 *   2. 首轮生成 —— 由签位两两配对，轮空不产生大场；
 *   3. 大场状态 —— 双方排阵齐即待开赛，已开始的不回退（D38）；
 *   4. 大场级开始 —— 仅管理员，且双方排阵已齐；
 *   5. 行数据的预计算布尔量 —— 模板不写业务逻辑。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  chunkPairs,
  firstRoundPairsOf,
  buildTiesForRound,
  disciplineToMatchType,
  isDoublesDiscipline,
  collegeLegKey,
  collegeLegFormatOf,
  buildLegMatchDrafts,
  scoreTextOf,
  totalPoints,
  legResultOf,
  isEloEligibleMatch,
  canStartCollegeEvent,
  tieStatusOf,
  canStartTie,
  tieStatusLabelOf,
  canAssignTieReferee,
  legMatchIdsOf,
  summarizeTie,
  canFinishTie,
  entrantsForRound,
  isRoundComplete,
  nextRoundPairsOf,
  roundTextOf,
  buildTieRow,
} = require('../src/shared/services/college-tie.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  TIE_STATUS,
  BRACKET_STAGE,
  TIE_ALGO,
  TIE_NET_MODE,
  MATCH_TYPE,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_COMPETITION,
  COLLEGE_LEG_FORMAT,
  EVENT_LEVEL,
  TEAM,
} = require('../src/shared/utils/constants.js');
const { validateMatchScore } = require('../src/shared/utils/match-format.js');

/** 造一条小项 */
function leg(legNo, discipline, winner, pointsA = 0, pointsB = 0) {
  return {
    legNo,
    discipline,
    matchId: `l_ce01_t_ce01_1_main_0_${legNo}`,
    winner,
    outcome: null,
    pointsA,
    pointsB,
  };
}

/** 管理员 */
const ADMIN = { _id: 'u01', nickName: '巴特尔', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };

/** 体育学院的负责人 */
const STAFF = {
  _id: 'u02',
  nickName: '张宇轩',
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  college: '体育学院',
};

/** 普通会员 */
const MEMBER = { _id: 'u03', nickName: '李明', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 已抽签、待开赛的学院赛 */
function event(overrides = {}) {
  return {
    _id: 'ce01',
    title: '2026 学院杯',
    legPlan: ['MS', 'MD', 'XD'],
    status: COLLEGE_EVENT_STATUS.READY,
    ...overrides,
  };
}

/** 一场大场 */
function tie(overrides = {}) {
  return {
    _id: 't_ce01_1_main_0',
    eventId: 'ce01',
    round: 1,
    stage: BRACKET_STAGE.MAIN,
    slot: 0,
    collegeA: '体育学院',
    collegeB: '信息工程学院',
    legs: [
      { legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null },
      { legNo: 2, discipline: 'MD', matchId: '', winner: null, outcome: null },
      { legNo: 3, discipline: 'XD', matchId: '', winner: null, outcome: null },
    ],
    winner: null,
    status: TIE_STATUS.PENDING_LINEUP,
    lineupA: false,
    lineupB: false,
    ...overrides,
  };
}

/* ============================================================
 * 一、赛事级开始
 * ============================================================ */

test('canStartCollegeEvent —— 仅管理员，且必须已抽签', () => {
  assert.strictEqual(canStartCollegeEvent(event(), ADMIN), true);
  assert.strictEqual(canStartCollegeEvent(event(), STAFF), false);
  assert.strictEqual(canStartCollegeEvent(event(), MEMBER), false);
  assert.strictEqual(canStartCollegeEvent(event(), null), false);
});

test('canStartCollegeEvent —— 报名中 / 进行中 / 已结束都不能再点开始', () => {
  for (const status of [
    COLLEGE_EVENT_STATUS.SIGNUP,
    COLLEGE_EVENT_STATUS.ONGOING,
    COLLEGE_EVENT_STATUS.FINISHED,
  ]) {
    assert.strictEqual(canStartCollegeEvent(event({ status }), ADMIN), false, `status=${status}`);
  }
});

/* ============================================================
 * 二、首轮生成
 * ============================================================ */

test('chunkPairs —— 两两分组，落单的补 null', () => {
  assert.deepStrictEqual(chunkPairs(['a', 'b', 'c', 'd']), [['a', 'b'], ['c', 'd']]);
  assert.deepStrictEqual(chunkPairs(['a', 'b', 'c']), [['a', 'b'], ['c', null]]);
  assert.deepStrictEqual(chunkPairs(null), []);
});

test('firstRoundPairsOf —— 由签表 slots 推出首轮对阵', () => {
  const draw = { slots: ['体育学院', null, '经济学院', '管理学院'] };
  assert.deepStrictEqual(firstRoundPairsOf(draw), [
    ['体育学院', null],
    ['经济学院', '管理学院'],
  ]);
});

test('buildTiesForRound —— 小项按赛事 legPlan 预先铺好，胜负留空', () => {
  const ties = buildTiesForRound({
    event: event(),
    round: 1,
    pairs: [['体育学院', '信息工程学院']],
  });

  assert.strictEqual(ties.length, 1);
  const built = ties[0];
  assert.strictEqual(built._id, 't_ce01_1_main_0');
  assert.strictEqual(built.round, 1);
  assert.strictEqual(built.slot, 0);
  assert.strictEqual(built.collegeA, '体育学院');
  assert.strictEqual(built.collegeB, '信息工程学院');
  assert.deepStrictEqual(
    built.legs.map((leg) => leg.discipline),
    ['MS', 'MD', 'XD']
  );
  assert.deepStrictEqual(
    built.legs.map((leg) => leg.legNo),
    [1, 2, 3]
  );
  assert.strictEqual(built.status, TIE_STATUS.PENDING_LINEUP);
  assert.strictEqual(built.lineupA, false);
  assert.strictEqual(built.lineupB, false);
  assert.strictEqual(built.winner, null);
});

test('buildTiesForRound —— 轮空的一侧不产生大场', () => {
  const ties = buildTiesForRound({
    event: event(),
    round: 1,
    pairs: [['体育学院', null], ['经济学院', '管理学院']],
  });
  assert.strictEqual(ties.length, 1);
  assert.strictEqual(ties[0].collegeA, '经济学院');
  // 签位序号仍按原位置：第二对是 slot 1，不是 0
  assert.strictEqual(ties[0].slot, 1);
});

test('buildTiesForRound —— 缺赛事 / 非数组对阵时给空数组', () => {
  assert.deepStrictEqual(buildTiesForRound({ event: null, round: 1, pairs: [] }), []);
  assert.deepStrictEqual(buildTiesForRound({ event: event(), round: 1, pairs: null }), []);
});

/* ============================================================
 * 三、大场状态
 * ============================================================ */

test('tieStatusOf —— 双方排阵齐即待开赛，否则待排阵', () => {
  assert.strictEqual(tieStatusOf(tie()), TIE_STATUS.PENDING_LINEUP);
  assert.strictEqual(tieStatusOf(tie({ lineupA: true })), TIE_STATUS.PENDING_LINEUP);
  assert.strictEqual(
    tieStatusOf(tie({ lineupA: true, lineupB: true })),
    TIE_STATUS.READY
  );
});

test('tieStatusOf —— 已开始 / 已结束的不被排阵情况打回', () => {
  assert.strictEqual(
    tieStatusOf(tie({ status: TIE_STATUS.ONGOING, lineupA: true, lineupB: true })),
    TIE_STATUS.ONGOING
  );
  assert.strictEqual(
    tieStatusOf(tie({ status: TIE_STATUS.FINISHED, lineupA: false, lineupB: false })),
    TIE_STATUS.FINISHED
  );
});

test('tieStatusOf —— 空值给默认待排阵', () => {
  assert.strictEqual(tieStatusOf(null), TIE_STATUS.PENDING_LINEUP);
});

test('tieStatusLabelOf —— 认不出的状态一律按「待排阵」兜底', () => {
  assert.strictEqual(tieStatusLabelOf(tie({ lineupA: true, lineupB: true })), '待开赛');
  // status 非 进行中 / 已结束 时，状态由排阵情况推出：都没交即待排阵
  assert.strictEqual(tieStatusLabelOf({ status: 99 }), '待排阵');
  assert.strictEqual(tieStatusLabelOf(null), '待排阵');
});

/* ============================================================
 * 四、大场级开始
 * ============================================================ */

test('canStartTie —— 仅管理员，且双方排阵已齐', () => {
  const ready = tie({ lineupA: true, lineupB: true });
  assert.strictEqual(canStartTie(ready, ADMIN), true);
  assert.strictEqual(canStartTie(ready, STAFF), false);
  assert.strictEqual(canStartTie(ready, MEMBER), false);
  assert.strictEqual(canStartTie(ready, null), false);
});

test('canStartTie —— 排阵没齐或已开始都不能点', () => {
  assert.strictEqual(canStartTie(tie({ lineupA: true }), ADMIN), false);
  assert.strictEqual(canStartTie(tie(), ADMIN), false);
  assert.strictEqual(
    canStartTie(tie({ status: TIE_STATUS.ONGOING, lineupA: true, lineupB: true }), ADMIN),
    false
  );
});

/* ============================================================
 * 五、行数据
 * ============================================================ */

test('roundTextOf —— 轮次文案，非法值给空串', () => {
  assert.strictEqual(roundTextOf(1), '第 1 轮');
  assert.strictEqual(roundTextOf(2), '第 2 轮');
  assert.strictEqual(roundTextOf(0), '');
  assert.strictEqual(roundTextOf('x'), '');
});

test('buildTieRow —— 预计算状态布尔量与小项标签', () => {
  const row = buildTieRow(tie({ lineupA: true, lineupB: true }), { actor: ADMIN });

  assert.strictEqual(row.tieId, 't_ce01_1_main_0');
  assert.strictEqual(row.collegeA, '体育学院');
  assert.strictEqual(row.collegeB, '信息工程学院');
  assert.strictEqual(row.status, TIE_STATUS.READY);
  assert.strictEqual(row.statusLabel, '待开赛');
  assert.strictEqual(row.isReady, true);
  assert.strictEqual(row.isPendingLineup, false);
  assert.strictEqual(row.lineupASubmitted, true);
  assert.strictEqual(row.lineupBSubmitted, true);
  assert.strictEqual(row.canStart, true);
  assert.strictEqual(row.legCount, 3);
  assert.deepStrictEqual(
    row.legRows.map((leg) => leg.disciplineLabel),
    ['男单', '男双', '混双']
  );
});

test('buildTieRow —— 会员那一行没有开始权，缺数据也不渲染 undefined', () => {
  const row = buildTieRow(tie({ lineupA: true, lineupB: true }), { actor: MEMBER });
  assert.strictEqual(row.canStart, false);
  assert.strictEqual(row.winner, null);
  assert.strictEqual(row.legRows[0].matchId, '');
  // 还没录分：胜负留空、没有弃权标注
  assert.strictEqual(row.legRows[0].winner, null);
  assert.strictEqual(row.legRows[0].outcomeText, '');
});

test('buildTieRow —— 弃权的小项标出「弃权」', () => {
  const legs = [
    { legNo: 1, discipline: 'MS', winner: '体育学院', outcome: 'forfeit' },
    { legNo: 2, discipline: 'MD', winner: null, outcome: null },
  ];
  const row = buildTieRow(tie({ legs }), { actor: ADMIN });
  assert.strictEqual(row.legRows[0].outcomeText, '弃权');
  assert.strictEqual(row.legRows[1].outcomeText, '');
});

/* ============================================================
 * 六、小场：归属、键与赛制（M4-1）
 * ============================================================ */

test('disciplineToMatchType / isDoublesDiscipline —— 单打类记单打，其余记双打', () => {
  assert.strictEqual(disciplineToMatchType('MS'), MATCH_TYPE.SINGLES);
  assert.strictEqual(disciplineToMatchType('WS'), MATCH_TYPE.SINGLES);
  assert.strictEqual(disciplineToMatchType('MD'), MATCH_TYPE.DOUBLES);
  assert.strictEqual(disciplineToMatchType('WD'), MATCH_TYPE.DOUBLES);
  assert.strictEqual(disciplineToMatchType('XD'), MATCH_TYPE.DOUBLES);

  assert.strictEqual(isDoublesDiscipline('MS'), false);
  assert.strictEqual(isDoublesDiscipline('XD'), true);
  assert.strictEqual(isDoublesDiscipline('XX'), false);
});

test('collegeLegKey —— 赛事 + 大场 + 小项序号唯一确定一场小场', () => {
  assert.strictEqual(collegeLegKey('ce01', 't_ce01_1_main_0', 1), 'l_ce01_t_ce01_1_main_0_1');
  assert.strictEqual(collegeLegKey('ce01', 't_ce01_1_main_0', 2), 'l_ce01_t_ce01_1_main_0_2');
});

test('buildLegMatchDrafts —— 由大场与双方排阵铺出小场草稿', () => {
  const lineups = [
    { tieId: 't_ce01_1_main_0', college: '体育学院', entries: [{ legNo: 1, players: ['u01'] }, { legNo: 2, players: ['u01', 'u02'] }] },
    { tieId: 't_ce01_1_main_0', college: '信息工程学院', entries: [{ legNo: 1, players: ['u03'] }, { legNo: 2, players: ['u03', 'u04'] }] },
  ];
  const target = tie({
    legs: [
      { legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null },
      { legNo: 2, discipline: 'MD', matchId: '', winner: null, outcome: null },
    ],
  });
  const built = buildLegMatchDrafts({ event: event(), tie: target, lineups, now: '2026-06-01T12:00:00' });

  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.drafts.length, 2);

  const singles = built.drafts[0];
  assert.strictEqual(singles._id, 'l_ce01_t_ce01_1_main_0_1');
  assert.strictEqual(singles.competition, MATCH_COMPETITION.COLLEGE);
  assert.strictEqual(singles.collegeEventId, 'ce01');
  assert.strictEqual(singles.tieId, 't_ce01_1_main_0');
  assert.strictEqual(singles.round, 1);
  assert.strictEqual(singles.legNo, 1);
  assert.strictEqual(singles.discipline, 'MS');
  assert.strictEqual(singles.matchType, MATCH_TYPE.SINGLES);
  assert.strictEqual(singles.pool, 'singles');
  assert.deepStrictEqual(singles.teamA, ['u01']);
  assert.deepStrictEqual(singles.teamB, ['u03']);
  assert.strictEqual(singles.level, EVENT_LEVEL.FIRST);
  assert.strictEqual(singles.eventId, null);
  assert.strictEqual(singles.status, MATCH_STATUS.PENDING);
  assert.strictEqual(singles.outcome, MATCH_OUTCOME.NORMAL);
  assert.strictEqual(singles.bestOf, COLLEGE_LEG_FORMAT.bestOf);
  assert.strictEqual(singles.gamePoints, COLLEGE_LEG_FORMAT.gamePoints);
  assert.deepStrictEqual(singles.scoreA, []);

  const doubles = built.drafts[1];
  assert.strictEqual(doubles.matchType, MATCH_TYPE.DOUBLES);
  assert.strictEqual(doubles.pool, 'doubles');
  assert.deepStrictEqual(doubles.teamA, ['u01', 'u02']);
});

test('buildLegMatchDrafts —— 缺排阵 / 缺赛事大场时拒绝生成', () => {
  const target = tie({
    legs: [{ legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null }],
  });
  const missing = buildLegMatchDrafts({ event: event(), tie: target, lineups: [] });
  assert.strictEqual(missing.ok, false);
  assert.deepStrictEqual(missing.drafts, []);
  assert.match(missing.message, /排阵不齐/);

  assert.strictEqual(buildLegMatchDrafts({ event: null, tie: target }).ok, false);
  assert.strictEqual(buildLegMatchDrafts({ event: event(), tie: null }).ok, false);
});

test('scoreTextOf / totalPoints —— 比分文本与累计局分', () => {
  assert.strictEqual(scoreTextOf({ scoreA: [11, 9], scoreB: [9, 11] }), '11:9 9:11');
  assert.strictEqual(scoreTextOf({ scoreA: [], scoreB: [] }), '');
  assert.strictEqual(totalPoints([11, 9, 11]), 31);
  assert.strictEqual(totalPoints(null), 0);
});

test('legResultOf —— 胜负换算成学院名，带走比分文本与累计局分', () => {
  const target = tie();
  const match = {
    _id: 'l_ce01_t_ce01_1_main_0_1',
    legNo: 1,
    discipline: 'MS',
    winner: TEAM.A,
    outcome: MATCH_OUTCOME.NORMAL,
    scoreA: [11, 9, 11],
    scoreB: [9, 11, 9],
  };
  const result = legResultOf(target, match);
  assert.strictEqual(result.winner, '体育学院');
  assert.strictEqual(result.matchId, 'l_ce01_t_ce01_1_main_0_1');
  assert.strictEqual(result.scoreText, '11:9 9:11 11:9');
  assert.strictEqual(result.pointsA, 31);
  assert.strictEqual(result.pointsB, 29);

  // B 侧胜出换算成 B 学院；弃权原样带出
  assert.strictEqual(
    legResultOf(target, { ...match, winner: TEAM.B }).winner,
    '信息工程学院'
  );
  assert.strictEqual(
    legResultOf(target, { ...match, winner: null, outcome: MATCH_OUTCOME.FORFEIT }).outcome,
    MATCH_OUTCOME.FORFEIT
  );
});

test('isEloEligibleMatch —— 个人赛计、学院赛单打计、双打与弃权不计', () => {
  const base = { status: MATCH_STATUS.ACTIVE };
  // 个人赛（无 competition 字段的老数据）照计
  assert.strictEqual(isEloEligibleMatch({ ...base }), true);
  assert.strictEqual(isEloEligibleMatch({ ...base, competition: MATCH_COMPETITION.PERSONAL }), true);

  // 学院赛单打计、双打不计
  assert.strictEqual(
    isEloEligibleMatch({ ...base, competition: MATCH_COMPETITION.COLLEGE, discipline: 'MS' }),
    true
  );
  assert.strictEqual(
    isEloEligibleMatch({ ...base, competition: MATCH_COMPETITION.COLLEGE, discipline: 'MD' }),
    false
  );

  // 弃权一律不计，未生效的也不计
  assert.strictEqual(isEloEligibleMatch({ ...base, outcome: MATCH_OUTCOME.FORFEIT }), false);
  assert.strictEqual(isEloEligibleMatch({ status: MATCH_STATUS.PENDING }), false);
  assert.strictEqual(isEloEligibleMatch(null), false);
});

/* ============================================================
 * 七、大场汇总（M4-5）
 * ============================================================ */

test('summarizeTie —— 先到 N 场胜：赢够一半加一即结束', () => {
  const event = { tieAlgo: TIE_ALGO.FIRST_TO_N };
  const target = tie({
    legs: [leg(1, 'MS', '体育学院'), leg(2, 'MD', '体育学院'), leg(3, 'XD', null)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.complete, true);
  assert.strictEqual(summary.winnerSide, TEAM.A);
  assert.strictEqual(summary.winner, '体育学院');
  assert.strictEqual(summary.tied, false);
  assert.strictEqual(summary.winsA, 2);
  assert.strictEqual(summary.winsB, 0);
  // 剩下一个小项没打也不影响：先到 2 场就已分胜负
  assert.deepStrictEqual(summary.undecided, [3]);
});

test('summarizeTie —— 先到 N 场胜：还没赢够就是没结束', () => {
  const event = { tieAlgo: TIE_ALGO.FIRST_TO_N };
  const target = tie({
    legs: [leg(1, 'MS', '体育学院'), leg(2, 'MD', '信息工程学院'), leg(3, 'XD', null)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.complete, false);
  assert.strictEqual(summary.winnerSide, null);
  assert.strictEqual(summary.reason.includes('先到 2 场胜'), true);
});

test('summarizeTie —— 打满比净胜·小场胜场差', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF };
  const target = tie({
    legs: [
      leg(1, 'MS', '体育学院', 11, 5),
      leg(2, 'MD', '信息工程学院', 5, 11),
      leg(3, 'XD', '体育学院', 11, 8),
    ],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.complete, true);
  assert.strictEqual(summary.netWin, 1);
  assert.strictEqual(summary.winnerSide, TEAM.A);
  assert.strictEqual(summary.winner, '体育学院');
});

test('summarizeTie —— 打满比净胜·累计局分净胜', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.POINT_DIFF };
  // 小场 1:1 打平，但 A 的局分累计更高
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 2), leg(2, 'MD', '信息工程学院', 3, 11)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.netWin, 0);
  assert.strictEqual(summary.netPoint, 1);
  assert.strictEqual(summary.winnerSide, TEAM.A);
});

test('summarizeTie —— 打满比净胜：主口径打平则比另一口径', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF };
  // 小场 1:1 打平，B 赢得更干脆，累计局分 B 领先
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 9), leg(2, 'MD', '信息工程学院', 3, 11)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.netWin, 0);
  assert.strictEqual(summary.netPoint, -6);
  assert.strictEqual(summary.winnerSide, TEAM.B);
  assert.match(summary.reason, /另一口径/);
});

test('summarizeTie —— 两套净胜口径都打平则判未决，不硬造赢家', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF };
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 9), leg(2, 'MD', '信息工程学院', 9, 11)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.complete, true);
  assert.strictEqual(summary.tied, true);
  assert.strictEqual(summary.winnerSide, null);
  assert.strictEqual(summary.winner, null);
  assert.match(summary.reason, /未决/);
});

test('summarizeTie —— 打满比净胜：还有小项没打完就不结束', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF };
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 5), leg(2, 'MD', null, 0, 0)],
  });
  const summary = summarizeTie({ tie: target, event: event });
  assert.strictEqual(summary.complete, false);
  assert.deepStrictEqual(summary.undecided, [2]);
  assert.strictEqual(summary.winnerSide, null);
});

test('summarizeTie / canFinishTie —— 缺算法与口径时按默认「打满比净胜·胜场差」', () => {
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 5), leg(2, 'MD', '体育学院', 11, 5)],
  });
  const summary = summarizeTie({ tie: target, event: {} });
  assert.strictEqual(summary.algo, TIE_ALGO.FULL_POINTS);
  assert.strictEqual(summary.netMode, TIE_NET_MODE.WIN_DIFF);
  assert.strictEqual(canFinishTie({ tie: target, event: {} }), true);
  assert.strictEqual(canFinishTie({ tie: tie(), event: {} }), false);
});

test('canFinishTie —— 未决的大场不能算结束', () => {
  const event = { tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF };
  const target = tie({
    legs: [leg(1, 'MS', '体育学院', 11, 9), leg(2, 'MD', '信息工程学院', 9, 11)],
  });
  assert.strictEqual(canFinishTie({ tie: target, event: event }), false);
});

/* ============================================================
 * 八、轮次推进（M4-6）
 * ============================================================ */

test('entrantsForRound —— 第 1 轮取签表，之后取上轮胜者', () => {
  const draw = { slots: ['A', 'B', 'C', 'D'] };
  const ties = [
    { round: 1, slot: 0, winner: 'A', status: TIE_STATUS.FINISHED },
    { round: 1, slot: 1, winner: 'C', status: TIE_STATUS.FINISHED },
  ];
  assert.deepStrictEqual(entrantsForRound({ draw, ties, round: 1 }), ['A', 'B', 'C', 'D']);
  assert.deepStrictEqual(entrantsForRound({ draw, ties, round: 2 }), ['A', 'C']);
});

test('isRoundComplete / nextRoundPairsOf —— 本轮全结束才生成下一轮', () => {
  const draw = { slots: ['A', 'B', 'C', 'D'] };
  const unfinished = [{ round: 1, slot: 0, winner: 'A', status: TIE_STATUS.FINISHED }, { round: 1, slot: 1, winner: null, status: TIE_STATUS.ONGOING }];
  assert.strictEqual(isRoundComplete({ ties: unfinished, round: 1 }), false);
  assert.deepStrictEqual(nextRoundPairsOf({ draw, ties: unfinished, round: 1 }), []);

  const finished = [
    { round: 1, slot: 0, winner: 'A', status: TIE_STATUS.FINISHED },
    { round: 1, slot: 1, winner: 'C', status: TIE_STATUS.FINISHED },
  ];
  assert.strictEqual(isRoundComplete({ ties: finished, round: 1 }), true);
  assert.deepStrictEqual(nextRoundPairsOf({ draw, ties: finished, round: 1 }), [['A', 'C']]);
});

test('nextRoundPairsOf —— 轮空直接进下一轮，冠军决出后没有下一轮', () => {
  // 3 个学院：签表补到 4，第二个签位轮空
  const draw = { slots: ['A', null, 'C', 'D'] };
  const round1 = [
    { round: 1, slot: 1, winner: 'D', status: TIE_STATUS.FINISHED },
  ];
  assert.deepStrictEqual(entrantsForRound({ draw, ties: round1, round: 2 }), ['A', 'D']);
  assert.deepStrictEqual(nextRoundPairsOf({ draw, ties: round1, round: 1 }), [['A', 'D']]);

  // 决赛打完，只剩冠军一人
  const round2 = [{ round: 2, slot: 0, winner: 'A', status: TIE_STATUS.FINISHED }];
  assert.deepStrictEqual(entrantsForRound({ draw, ties: round2, round: 3 }), ['A']);
  assert.deepStrictEqual(nextRoundPairsOf({ draw, ties: round2, round: 2 }), []);
});

/* ============================================================
 * 九、大场裁判（M6）
 * ============================================================
 * 大场是临场指挥的最小单位：一个裁判盯着这一整场（底下几个小项），
 * 派一个人比逐个小项派更贴近实际。裁判存在大场上，开赛时下发给小场。
 * ============================================================ */

test('canAssignTieReferee —— 未结束的大场都能指派或改派', () => {
  assert.strictEqual(canAssignTieReferee(tie()), true, '待排阵时就能先定人');
  assert.strictEqual(
    canAssignTieReferee(tie({ lineupA: true, lineupB: true })),
    true,
    '待开赛也能派'
  );
  assert.strictEqual(
    canAssignTieReferee(tie({ status: TIE_STATUS.ONGOING })),
    true,
    '开打后临时换人也要允许，不然裁判迟到整场就废了'
  );
  assert.strictEqual(canAssignTieReferee(tie({ status: TIE_STATUS.FINISHED })), false);
  assert.strictEqual(canAssignTieReferee(null), false);
});

test('legMatchIdsOf —— 抽出已生成的小场编号，没生成的不占位', () => {
  const target = tie({
    legs: [
      { legNo: 1, discipline: 'MS', matchId: 'l_ce01_t_ce01_1_main_0_1' },
      { legNo: 2, discipline: 'MD', matchId: '' },
      { legNo: 3, discipline: 'XD', matchId: 'l_ce01_t_ce01_1_main_0_3' },
    ],
  });
  assert.deepStrictEqual(legMatchIdsOf(target), [
    'l_ce01_t_ce01_1_main_0_1',
    'l_ce01_t_ce01_1_main_0_3',
  ]);
  assert.deepStrictEqual(legMatchIdsOf(tie({ legs: [] })), []);
  assert.deepStrictEqual(legMatchIdsOf(null), []);
});

test('buildTiesForRound —— 新生成的大场裁判字段留空占位', () => {
  const built = buildTiesForRound({
    event: event(),
    round: 1,
    pairs: [['体育学院', '信息工程学院']],
  })[0];
  assert.strictEqual(built.referee, '');
  assert.strictEqual(built.refereeAt, null);
  assert.strictEqual(built.refereeBy, '');
});

test('buildLegMatchDrafts —— 大场裁判下发给每个小场', () => {
  const lineups = [
    { tieId: 't_ce01_1_main_0', college: '体育学院', entries: [{ legNo: 1, players: ['u01'] }] },
    { tieId: 't_ce01_1_main_0', college: '信息工程学院', entries: [{ legNo: 1, players: ['u03'] }] },
  ];
  const at = new Date('2026-06-01T08:00:00');
  const target = tie({
    referee: 'u09',
    refereeAt: at,
    refereeBy: 'u01',
    legs: [{ legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null }],
  });
  const built = buildLegMatchDrafts({ event: event(), tie: target, lineups });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.drafts[0].referee, 'u09');
  assert.strictEqual(built.drafts[0].refereeBy, 'u01');
  assert.strictEqual(built.drafts[0].refereeAt, at);
});

test('buildLegMatchDrafts —— 大场没派裁判时，小场也不带裁判（零回归）', () => {
  const lineups = [
    { tieId: 't_ce01_1_main_0', college: '体育学院', entries: [{ legNo: 1, players: ['u01'] }] },
    { tieId: 't_ce01_1_main_0', college: '信息工程学院', entries: [{ legNo: 1, players: ['u03'] }] },
  ];
  const target = tie({
    legs: [{ legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null }],
  });
  const built = buildLegMatchDrafts({ event: event(), tie: target, lineups });
  assert.strictEqual(built.drafts[0].referee, '');
});

test('buildTieRow —— 裁判姓名与改派权一并算好，模板不再判断', () => {
  const row = buildTieRow(tie({ referee: 'u09' }), {
    actor: ADMIN,
    refereeName: '王裁判',
  });
  assert.strictEqual(row.referee, 'u09');
  assert.strictEqual(row.refereeName, '王裁判');
  assert.strictEqual(row.canAssignReferee, true);

  // 普通会员看得到人，但没有改派权
  const memberRow = buildTieRow(tie({ referee: 'u09' }), { actor: MEMBER, refereeName: '王裁判' });
  assert.strictEqual(memberRow.refereeName, '王裁判');
  assert.strictEqual(memberRow.canAssignReferee, true, 'canAssignReferee 只反映大场状态，权限由页面判');

  // 已结束的大场不能再改派
  const done = buildTieRow(tie({ referee: 'u09', status: TIE_STATUS.FINISHED }), { actor: ADMIN });
  assert.strictEqual(done.canAssignReferee, false);
});

test('buildTieRow —— 没派裁判时字段兜底为空，不渲染 undefined', () => {
  const row = buildTieRow(tie(), { actor: ADMIN });
  assert.strictEqual(row.referee, '');
  assert.strictEqual(row.refereeName, '');
});

/* ============================================================
 * 七、（已删除）撤销小场之后回滚大场
 * ============================================================
 * revertLegResult 及其四条用例已随 Elo 逐场结算改造一并删除：
 * 比赛一经确认即为最终结算，不存在「撤销小场回收大场」的路径。
 * ============================================================ */


/* ============================================================
 * 八、网球进石榴籽杯
 * ============================================================
 * 杯赛的小场原本写死「11 分制 · 一局一胜」，网球塞不进去。现在赛制由协会定，
 * 网球按 4 局短盘 + 无占先跑（一盘 20 分钟上下，才排得进团体赛的节奏）。
 * 这一节把「赛制怎么选」和「赛制怎么落进草稿」两件事钉死。
 * ============================================================ */

test('collegeLegFormatOf —— 网球协会走 4 局短盘 + 无占先，其余照旧 11 分制', () => {
  const tennis = collegeLegFormatOf('tn');
  assert.strictEqual(tennis.scoring, 'tennis');
  assert.strictEqual(tennis.bestOf, 1, '团体赛一小项只打一盘');
  assert.strictEqual(tennis.setGames, 4, '短盘：一盘 4 局');
  assert.strictEqual(tennis.tiebreakAt, 4, '4:4 抢七');
  assert.strictEqual(tennis.tiebreakPoints, 7);
  assert.strictEqual(tennis.noAd, true, '无占先：40:40 后一分定局，压缩时长');

  // 非网球 / 未知协会一律退回常规口径，且绝不抛错——抛了整场大场都开不了
  ['', 'bd', 'tt', 'nope', undefined, null].forEach((id) => {
    assert.deepStrictEqual(collegeLegFormatOf(id), COLLEGE_LEG_FORMAT, `协会 ${id} 应走常规口径`);
  });
});

test('buildLegMatchDrafts —— 网球小场把短盘赛制带进草稿，不留 gamePoints', () => {
  const lineups = [
    { tieId: 't_ce01_1_main_0', college: '体育学院', entries: [{ legNo: 1, players: ['u01'] }] },
    { tieId: 't_ce01_1_main_0', college: '信息工程学院', entries: [{ legNo: 1, players: ['u03'] }] },
  ];
  const target = tie({
    legs: [{ legNo: 1, discipline: 'MS', matchId: '', winner: null, outcome: null }],
  });

  const built = buildLegMatchDrafts({
    event: event(),
    tie: target,
    lineups,
    now: '2026-06-01T12:00:00',
    association: 'tn',
  });
  assert.strictEqual(built.ok, true);
  const draft = built.drafts[0];
  assert.strictEqual(draft.scoring, 'tennis');
  assert.strictEqual(draft.bestOf, 1);
  assert.strictEqual(draft.setGames, 4);
  assert.strictEqual(draft.tiebreakAt, 4);
  assert.strictEqual(draft.tiebreakPoints, 7);
  assert.strictEqual(draft.noAd, true);
  assert.strictEqual(draft.gamePoints, undefined, '网球记录不该带 gamePoints，否则两边读数会打架');

  // 同一套函数，不传协会就是常规口径（乒乓 / 羽毛球的杯赛小项照旧）
  const point = buildLegMatchDrafts({ event: event(), tie: target, lineups }).drafts[0];
  assert.strictEqual(point.gamePoints, COLLEGE_LEG_FORMAT.gamePoints);
  assert.strictEqual(point.bestOf, COLLEGE_LEG_FORMAT.bestOf);
  assert.strictEqual(point.scoring, undefined);
  assert.strictEqual(point.setGames, undefined);
});

test('buildLegMatchDrafts —— 网球草稿的赛制能直接过整场校验（5:3 是合法短盘）', () => {
  const format = collegeLegFormatOf('tn');
  assert.strictEqual(validateMatchScore([5], [3], format).valid, true);
  assert.strictEqual(validateMatchScore([5], [4], format).valid, true, '4:4 抢七后 5:4');
  assert.strictEqual(validateMatchScore([4], [3], format).valid, false, '4:3 还没打完');
  assert.match(
    validateMatchScore([6], [4], format).errors.join(''),
    /第 1 盘/,
    '常规 6 局的盘比分在短盘里不合法'
  );
});

test('scoreTextOf —— 网球 7:6 要带抢七小分，其余协会照旧', () => {
  // 单元之间是两空格，这是 formatScore 的既有口径（「11:9  12:10」），别改成单空格
  assert.strictEqual(
    scoreTextOf({
      scoring: 'tennis',
      scoreA: [6, 7],
      scoreB: [4, 6],
      tiebreaks: [{ setIndex: 1, a: 7, b: 5 }],
    }),
    '6:4  7:6(5)'
  );
  // 没有抢七小分的老网球记录，也不该多出空括号
  assert.strictEqual(scoreTextOf({ scoring: 'tennis', scoreA: [6], scoreB: [4] }), '6:4');
  assert.strictEqual(scoreTextOf({ scoreA: [11], scoreB: [9] }), '11:9');
});
