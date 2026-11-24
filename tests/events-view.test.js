/**
 * 赛事页视图模型 单元测试（纯函数部分）
 * ============================================================
 * events-view.js 现在只剩展示规则构建器；接真实数据源的三个旧装载器
 * （loadEventsView / loadEventDetailView / loadEventPlacementView）已随
 * 协议 1 下线删除，它们守护的端到端行为由 S2 测试接管：
 *   · 积分榜 / 列表截断 → tests/school-events-panel-view.test.js
 *   · 签表推进 / 重抽 / 手工种子 / 场地看板 → tests/school-event-view.test.js
 *   · 置顶排序与 canPin（个人赛 / 学院赛）→ school-event-view / school-college-view
 *   · 名次积分进入会员统计 → tests/school-event-view.test.js
 * ============================================================
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  MEDALS,
  TOP_LIMIT,
  medalOf,
  avatarOf,
  countEvents,
  describeSeason,
  buildPointsRows,
  sortEvents,
  roundLabelOf,
  totalRoundsOf,
  maxRoundOf,
  describeDraw,
  byeTextOf,
  teamTextOf,
  entryTextOf,
  buildBracketRows,
  buildSignupRows,
  formatOf,
  isGroupedFormat,
  isDoubleElimFormat,
  hasAutoPlacements,
  groupLabelOf,
  buildStandings,
  drawnTeamIds,
  buildTeamRows,
} = require('../miniprogram/services/events-view.js');
const { sortCollegeEvents } = require('../src/shared/services/college-event.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  BRACKET_STAGE,
  RATING_POOL,
  USER_STATUS,
  ROLE,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  COLLEGE_EVENT_STATUS,
  TEAM_ID_SEPARATOR,
} = require('../src/shared/utils/constants.js');

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('medalOf / avatarOf —— 与排行榜页同一套规则', () => {
  assert.deepStrictEqual(MEDALS, ['gold', 'silver', 'bronze']);
  assert.strictEqual(medalOf(1), 'gold');
  assert.strictEqual(medalOf(3), 'bronze');
  assert.strictEqual(medalOf(4), '');
  assert.strictEqual(avatarOf('巴特尔'), '巴');
  assert.strictEqual(avatarOf(''), '?');
});

test('countEvents —— 只数「单打 + 已结束」的赛事', () => {
  const counts = countEvents([
    {
      _id: 'e1',
      matchType: MATCH_TYPE.SINGLES,
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }, { userId: 'b' }],
    },
    {
      _id: 'e2',
      matchType: MATCH_TYPE.DOUBLES, // 双打不计分，也不该计入场次
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }, { userId: 'c' }],
    },
    {
      _id: 'e3',
      matchType: MATCH_TYPE.SINGLES,
      status: 1, // 没结束
      results: [{ userId: 'a' }],
    },
    {
      _id: 'e4',
      matchType: MATCH_TYPE.SINGLES,
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }],
    },
  ]);

  assert.strictEqual(counts.get('a'), 2, 'a 只算 e1、e4 两场');
  assert.strictEqual(counts.get('b'), 1);
  assert.strictEqual(counts.get('c'), undefined, '双打伙伴不上积分榜');
});

test('countEvents —— 空输入返回空 Map', () => {
  assert.strictEqual(countEvents(null).size, 0);
  assert.strictEqual(countEvents([]).size, 0);
});

test('describeSeason —— 有锚点写起算日，开过新赛季再补一句', () => {
  assert.strictEqual(describeSeason({}), '当前赛季');
  assert.strictEqual(describeSeason({ anchorTime: '2026-04-08T18:00:00' }), '本赛季自 4月8日 起');
  assert.strictEqual(
    describeSeason({ anchorTime: '2026-04-08T18:00:00', resetTime: '2026-06-01T00:00:00' }),
    '本赛季自 4月8日 起，6月1日 开启新赛季'
  );
});

test('buildPointsRows —— 滤掉 0 分的人，按积分降序并重新编号', () => {
  const users = [
    { _id: 'a', nickName: '甲', points: 30 },
    { _id: 'b', nickName: '乙', points: 0 }, // 没积分，不该上榜
    { _id: 'c', nickName: '丙', points: 52 },
    { _id: 'd', nickName: '丁' }, // 连 points 字段都没有，视作 0
  ];
  const rows = buildPointsRows(users, new Map([['a', 2], ['c', 3]]), 'c');

  assert.deepStrictEqual(
    rows.map((r) => r.userId),
    ['c', 'a'],
    '按积分从高到低，且 0 分的人被滤掉'
  );
  assert.deepStrictEqual(
    rows.map((r) => r.rank),
    [1, 2],
    '滤人之后名次必须连续，不能留空档'
  );
  assert.strictEqual(rows[0].isMe, true);
  assert.strictEqual(rows[1].isMe, false);
  assert.strictEqual(rows[0].medal, 'gold');
  assert.strictEqual(rows[1].medal, 'silver');
  assert.strictEqual(rows[0].valueText, '52');
  assert.strictEqual(rows[0].noteText, '赛季积分');
  assert.strictEqual(rows[0].detailText, '3 场赛事');
});

test('buildPointsRows —— 参赛场次缺失时算 0 场，不写成 undefined', () => {
  const rows = buildPointsRows([{ _id: 'a', nickName: '甲', points: 2 }], new Map(), null);
  assert.strictEqual(rows[0].detailText, '0 场赛事');
});

test('buildPointsRows —— 传入非数组返回空榜', () => {
  assert.deepStrictEqual(buildPointsRows(null, new Map(), null), []);
});

/* ---------- 签表（抽签结果） ---------- */

/** 造一条抽签生成的待确认比赛，字段与 draw.js 的产出一致 */
function scheduledRecord(over = {}) {
  return {
    _id: 'm1',
    eventId: 'e1',
    round: 1,
    stage: BRACKET_STAGE.MAIN,
    slot: 1,
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['a'],
    teamB: ['b'],
    scoreA: [],
    scoreB: [],
    gamePoints: 11,
    bestOf: 3,
    winner: null,
    recorder: 'a',
    matchTime: '2026-05-20T09:00:00',
    location: '学校体育馆',
    status: MATCH_STATUS.PENDING,
    ...over,
  };
}

/** 一场 4 签位的赛事：总轮数为 2，第 1 轮即半决赛 */
const BRACKET_EVENT = {
  _id: 'e1',
  draw: { seedMode: 'elo', seedCount: 4, drawCount: 1, size: 4, seeds: ['a', 'b'], byes: [] },
};

const BRACKET_MEMBERS = new Map([
  ['a', { _id: 'a', nickName: '甲' }],
  ['b', { _id: 'b', nickName: '乙' }],
  ['z', { _id: 'z', nickName: '客' }],
]);

test('roundLabelOf —— 从最后一轮倒着数，决赛/半决赛/四分之一决赛才叫得对', () => {
  assert.strictEqual(roundLabelOf(3, 3), '决赛');
  assert.strictEqual(roundLabelOf(2, 3), '半决赛');
  assert.strictEqual(roundLabelOf(1, 3), '四分之一决赛');
  assert.strictEqual(roundLabelOf(3, 5), '四分之一决赛');
  assert.strictEqual(roundLabelOf(4, 5), '半决赛');
  assert.strictEqual(roundLabelOf(5, 5), '决赛');
  assert.strictEqual(roundLabelOf(1, 5), '第 1 轮', '离决赛还远的那几轮按数字叫');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.BRONZE), '季军赛');
});

test('roundLabelOf —— 轮次或总轮数缺失时绝不吐出 undefined', () => {
  // 这正是「每场都显示第 undefined 轮」的病根：轮次缺失时曾直接拼进
  // 模板字符串。缺什么就老实说什么，不能把 undefined 印到界面上。
  assert.strictEqual(roundLabelOf(undefined, 3), '轮次待定');
  assert.strictEqual(roundLabelOf(null, 3), '轮次待定');
  assert.strictEqual(roundLabelOf('x', 3), '轮次待定');
  // 总轮数算不出来（老赛事没有 draw）时不假装知道倒数第几，只报第几轮
  assert.strictEqual(roundLabelOf(2, undefined), '第 2 轮');
  assert.strictEqual(roundLabelOf(2, 0), '第 2 轮');
  assert.strictEqual(roundLabelOf(2, null), '第 2 轮');
  // 无论怎么传，都不能出现 undefined
  for (const [round, total] of [[undefined, undefined], [null, 0], ['', '']]) {
    assert.ok(!roundLabelOf(round, total).includes('undefined'));
  }
});

test('roundLabelOf —— 小组看数字叫，胜者组 / 败者组带区名，总决赛与排位赛有专名', () => {
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.GROUP), '第 1 轮');
  // 胜者组与败者组各自从第 1 轮数起，必须带区名才分得清
  assert.strictEqual(roundLabelOf(2, 3, BRACKET_STAGE.WINNERS), '胜者组 · 第 2 轮');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.LOSERS), '败者组 · 第 1 轮');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.GRAND_FINAL), '总决赛');
  assert.strictEqual(roundLabelOf(2, 3, BRACKET_STAGE.PLACEMENT), '5–8 名排位赛');
  assert.strictEqual(roundLabelOf(undefined, 3, BRACKET_STAGE.GROUP), '轮次待定');
  assert.strictEqual(roundLabelOf(undefined, 3, BRACKET_STAGE.WINNERS), '胜者组 · 轮次待定');
});

test('formatOf / isGroupedFormat —— 老赛事缺省按单败，不误判成要分组', () => {
  assert.strictEqual(formatOf({}), EVENT_FORMAT.SINGLE_ELIM);
  assert.strictEqual(formatOf(null), EVENT_FORMAT.SINGLE_ELIM);
  assert.strictEqual(isGroupedFormat({ format: EVENT_FORMAT.ROUND_ROBIN }), true);
  assert.strictEqual(isGroupedFormat({ format: EVENT_FORMAT.GROUP_KNOCKOUT }), true);
  assert.strictEqual(isGroupedFormat({}), false);
});

test('isDoubleElimFormat / hasAutoPlacements —— 双败也要自动排名次', () => {
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.DOUBLE_ELIM }), true);
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.GROUP_DOUBLE_ELIM }), true);
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.SINGLE_ELIM }), false);
  assert.strictEqual(isDoubleElimFormat({}), false);
  // 单败淘汰仍由管理员手工录名次，不预填
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.DOUBLE_ELIM }), true);
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.ROUND_ROBIN }), true);
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.SINGLE_ELIM }), false);
});

test('groupLabelOf —— 组号自 0 起，0 号就是 A 组', () => {
  assert.strictEqual(groupLabelOf(0, EVENT_FORMAT.GROUP_KNOCKOUT), 'A 组');
  assert.strictEqual(groupLabelOf(1, EVENT_FORMAT.GROUP_KNOCKOUT), 'B 组');
  assert.strictEqual(groupLabelOf(3, EVENT_FORMAT.GROUP_KNOCKOUT), 'D 组');
  // 循环赛只有一组，不摆字母
  assert.strictEqual(groupLabelOf(0, EVENT_FORMAT.ROUND_ROBIN), '循环赛');
});

test('totalRoundsOf —— 签位数是 2 的几次幂就几轮，非法值收敛成 0', () => {
  assert.strictEqual(totalRoundsOf({ size: 2 }), 1);
  assert.strictEqual(totalRoundsOf({ size: 4 }), 2);
  assert.strictEqual(totalRoundsOf({ size: 8 }), 3);
  assert.strictEqual(totalRoundsOf({ size: 16 }), 4);
  assert.strictEqual(totalRoundsOf({ size: 1 }), 0);
  assert.strictEqual(totalRoundsOf(null), 0);
  assert.strictEqual(totalRoundsOf({}), 0);
});

test('maxRoundOf —— 从比赛记录反推最大轮次，作为没有 draw 时的兜底', () => {
  assert.strictEqual(maxRoundOf([{ round: 1 }, { round: 3 }, { round: 2 }]), 3);
  assert.strictEqual(maxRoundOf([{ round: 2 }]), 2);
  assert.strictEqual(maxRoundOf([{ round: 'x' }, {}]), 0);
  assert.strictEqual(maxRoundOf([]), 0);
  assert.strictEqual(maxRoundOf(null), 0);
});

test('describeDraw —— 说清第几次抽签、几个签位、几位种子', () => {
  assert.strictEqual(describeDraw(null), '');
  assert.strictEqual(
    describeDraw({ drawCount: 2, size: 8, seeds: ['a', 'b'] }),
    '第 2 次抽签 · 8 个签位 · 2 位种子'
  );
  // 没有种子时不硬凑一句「0 位种子」
  assert.strictEqual(describeDraw({ drawCount: 1, size: 4 }), '第 1 次抽签 · 4 个签位');
});

test('byeTextOf —— 轮空的人要点名，没人轮空时不留一句空话', () => {
  const memberMap = new Map([['a', { nickName: '甲' }], ['b', { nickName: '乙' }]]);
  assert.strictEqual(byeTextOf({ byes: ['a', 'b'] }, memberMap), '轮空直接晋级：甲、乙');
  assert.strictEqual(byeTextOf({ byes: [] }, memberMap), '');
  assert.strictEqual(byeTextOf(null, memberMap), '');
});

test('buildBracketRows —— 按轮次→阶段→签位排，季军赛紧跟同轮的正赛', () => {
  const rows = buildBracketRows(
    [
      scheduledRecord({ _id: 'final', round: 2, slot: 1 }),
      scheduledRecord({ _id: 'semi2', round: 1, slot: 2 }),
      scheduledRecord({ _id: 'bronze', round: 1, slot: 1, stage: BRACKET_STAGE.BRONZE }),
      scheduledRecord({ _id: 'semi1', round: 1, slot: 1 }),
    ],
    BRACKET_EVENT,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['semi1', 'semi2', 'bronze', 'final'],
    '先排第 1 轮正赛（按签位）→ 季军赛 → 再排决赛'
  );
  assert.strictEqual(rows[3].roundText, '决赛');
  assert.strictEqual(rows[0].roundText, '半决赛');
  assert.strictEqual(rows[2].roundText, '季军赛');
});

test('buildBracketRows —— 别的赛事的比赛不混进签表', () => {
  const rows = buildBracketRows(
    [scheduledRecord({ _id: 'x', eventId: 'other' })],
    BRACKET_EVENT,
    BRACKET_MEMBERS,
    { actor: null }
  );
  assert.deepStrictEqual(rows, []);
});

test('buildBracketRows —— 没有 draw 的老赛事按最大轮次把轮次名认对', () => {
  // 种子里的历史赛事是直接模拟出来的，没有抽签记录。只要比赛带轮次，
  // 就能推回总轮数：8 签 3 轮，第 1 轮是八进四、第 2 轮半决赛、第 3 轮决赛。
  const legacy = { _id: 'e1' };
  const played = (over) =>
    scheduledRecord({ status: MATCH_STATUS.ACTIVE, scoreA: [11], scoreB: [7], winner: 'A', ...over });
  const rows = buildBracketRows(
    [
      played({ _id: 'final', round: 3, slot: 0 }),
      played({ _id: 'sf', round: 2, slot: 0 }),
      played({ _id: 'qf', round: 1, slot: 0 }),
    ],
    legacy,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.roundText),
    ['四分之一决赛', '半决赛', '决赛']
  );
  for (const row of rows) {
    assert.ok(!row.roundText.includes('undefined'), `轮次名不该是 undefined：${row.roundText}`);
  }
});

test('buildBracketRows —— 连轮次都没有的脏记录也只写「轮次待定」', () => {
  const rows = buildBracketRows(
    [scheduledRecord({ _id: 'mystery', round: undefined })],
    { _id: 'e1' },
    BRACKET_MEMBERS,
    { actor: null }
  );
  assert.strictEqual(rows[0].roundText, '轮次待定');
});

test('buildSignupRows —— 每人后面带上本场池的等级分与赛季积分', () => {
  const members = new Map([
    [
      'a',
      {
        _id: 'a',
        nickName: '甲',
        points: 26,
        ratings: {
          singles: { elo: 1523, matchCount: 12 },
          doubles: { elo: 1401, matchCount: 3 },
        },
      },
    ],
    [
      'b',
      {
        _id: 'b',
        nickName: '乙',
        points: 8,
        ratings: {
          singles: { elo: 1388, matchCount: 5 },
          doubles: { elo: 1450, matchCount: 0 },
        },
      },
    ],
  ]);

  const rows = buildSignupRows(
    [
      { userId: 'a', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-01T12:00:00' },
      { userId: 'b', status: SIGNUP_STATUS.CHECKED_IN, signTime: '2026-05-02T12:00:00' },
    ],
    members,
    { event: { _id: 'e1', pool: RATING_POOL.SINGLES } }
  );

  assert.strictEqual(rows[0].statText, '等级分 1523 · 积分 26');
  assert.strictEqual(rows[1].statText, '等级分 1388 · 积分 8');
  assert.strictEqual(rows[0].avatarText, '甲');
});

test('buildSignupRows —— 双打赛事取双打池的分，查无此人时不硬凑默认分', () => {
  const members = new Map([
    [
      'a',
      {
        _id: 'a',
        nickName: '甲',
        points: 0,
        ratings: {
          singles: { elo: 1523, matchCount: 12 },
          doubles: { elo: 1401, matchCount: 3 },
        },
      },
    ],
  ]);
  const rows = buildSignupRows(
    [
      { userId: 'a', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-01T12:00:00' },
      { userId: 'ghost', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-02T12:00:00' },
    ],
    members,
    { event: { _id: 'e2', pool: RATING_POOL.DOUBLES } }
  );

  assert.strictEqual(rows[0].statText, '等级分 1401 · 积分 0');
  assert.strictEqual(rows[1].statText, '', '档案缺失时留空，不假装是 1450 分');
});

test('buildBracketRows —— 没录分时参赛者只看到「录分」，看不到「确认」', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER },
  });
  const row = rows[0];

  assert.strictEqual(row.isMine, true);
  assert.strictEqual(row.canRecord, true);
  assert.strictEqual(row.canConfirm, false, '确认要按胜方计分，没比分就无从确认');
  assert.strictEqual(row.scoreText, '', '还没比分不该渲染成 0:0');
  assert.strictEqual(row.teamAText, '甲');
  assert.strictEqual(row.teamBText, '乙');
  assert.strictEqual(row.statusLabel, '待确认');
});

test('buildBracketRows —— 非参赛的普通会员既不能录分也不能确认', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.MEMBER },
  });
  assert.strictEqual(rows[0].isMine, false);
  assert.strictEqual(rows[0].canRecord, false);
  assert.strictEqual(rows[0].canConfirm, false);
});

test('buildBracketRows —— 管理员不是参赛者也能代为录分', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(rows[0].canRecord, true);
});

test('buildBracketRows —— 录分不再按数据源放宽，普通会员登录也不是想录就录', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
    isMock: true,
  });
  assert.strictEqual(rows[0].canRecord, false, '录分只认参赛者与管理员，与真正写入时一致');
});

test('buildBracketRows —— 录完分换成对手确认，且不再出现「录分」', () => {
  const record = scheduledRecord({
    scoreA: [11],
    scoreB: [7],
    winner: 'A',
    status: MATCH_STATUS.PENDING,
  });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'b', role: ROLE.MEMBER },
  });
  const row = rows[0];

  assert.strictEqual(row.scoreText, '11:7');
  assert.strictEqual(row.winnerSide, 'A');
  assert.strictEqual(row.canRecord, false, '已经有比分，不该再给「录分」入口');
  assert.strictEqual(row.canConfirm, true, '站在录入者对面的 b 可以确认');
});

test('buildBracketRows —— 没指派裁判时，签表这一行与今天完全一致（零回归）', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  const row = rows[0];

  assert.strictEqual(row.hasReferee, false);
  assert.strictEqual(row.refereeName, '');
  assert.strictEqual(row.refereeNotice, '');
  assert.strictEqual(row.refereeIsParticipant, false);
  // 管理员能录分靠的是原有规则，不是裁判这条线
  assert.strictEqual(row.canRecord, true);
});

test('buildBracketRows —— 指派裁判的入口只开给管理员，且只在未生效的场次上', () => {
  const asAdmin = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asAdmin[0].canAssignReferee, true);

  // 普通会员（哪怕自己就是参赛者）看不到这个入口
  const asPlayer = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asPlayer[0].canAssignReferee, false);

  // 已经打完生效的场次不再改派，避免「改历史」
  const active = scheduledRecord({
    scoreA: [11, 11],
    scoreB: [5, 7],
    winner: 'A',
    status: MATCH_STATUS.ACTIVE,
  });
  const rows = buildBracketRows([active], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(rows[0].canAssignReferee, false);
});

test('buildBracketRows —— 指派裁判后签表标出是谁执法，旁人录分被收口', () => {
  const record = scheduledRecord({ referee: 'z' });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  const row = rows[0];

  assert.strictEqual(row.hasReferee, true);
  assert.strictEqual(row.refereeName, '客');
  assert.strictEqual(row.canRecord, false, '裁判接管后参赛者也不能自己录分');
  assert.match(row.refereeNotice, /仅裁判与管理员可录分/);
  // 裁判不在场上，「兼参赛」不亮
  assert.strictEqual(row.refereeIsParticipant, false);
});

test('buildBracketRows —— 裁判本人就是参赛者时给「兼参赛」提示（Q5）', () => {
  // a 既是 teamA 的选手又被指派为裁判：允许，但界面要说明
  const record = scheduledRecord({ referee: 'a' });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });

  assert.strictEqual(rows[0].refereeIsParticipant, true);
  // 裁判自己看这一行时不该看到「仅裁判与管理员可录分」的警告
  const asReferee = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asReferee[0].refereeNotice, '');
  assert.strictEqual(asReferee[0].canRecord, true, '裁判本人可以录分');
});

test('buildBracketRows —— 小组赛整体排在淘汰赛前，0 号组也标出组名', () => {
  const event = {
    _id: 'e1',
    format: EVENT_FORMAT.GROUP_KNOCKOUT,
    draw: {
      groups: [
        { group: 0, entries: ['a', 'b'] },
        { group: 1, entries: ['c', 'd'] },
      ],
    },
  };
  const rows = buildBracketRows(
    [
      // 淘汰赛第 1 轮：轮次值比小组赛还小，若不按阶段分区会插到最前面
      scheduledRecord({ _id: 'ko1', round: 1, stage: BRACKET_STAGE.MAIN, group: undefined }),
      scheduledRecord({ _id: 'gb1', round: 1, stage: BRACKET_STAGE.GROUP, group: 1, slot: 0 }),
      scheduledRecord({ _id: 'ga2', round: 2, stage: BRACKET_STAGE.GROUP, group: 0, slot: 0 }),
      scheduledRecord({ _id: 'ga1', round: 1, stage: BRACKET_STAGE.GROUP, group: 0, slot: 0 }),
    ],
    event,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['ga1', 'ga2', 'gb1', 'ko1'],
    'A 组（第 1→2 轮）→ B 组 → 淘汰赛，小组赛无论轮次都排在淘汰赛前'
  );
  assert.strictEqual(rows[0].groupText, 'A 组', '0 号组要有名字，不能被真值判断漏掉');
  assert.strictEqual(rows[2].groupText, 'B 组');
  assert.strictEqual(rows[3].groupText, '', '淘汰赛没有小组，不标组名');
  assert.strictEqual(rows[0].roundText, '第 1 轮', '小组赛的轮次只看数字叫');
});

test('buildBracketRows —— 双败按胜者组→败者组→总决赛分区，轮次带区名', () => {
  const event = { _id: 'e1', format: EVENT_FORMAT.DOUBLE_ELIM, draw: { size: 4, slots: [], byes: [] } };
  const rows = buildBracketRows(
    [
      // 总决赛的轮次值是 1，若不按阶段分区会插到胜者组第 2 轮之前
      scheduledRecord({ _id: 'gf1', round: 1, stage: BRACKET_STAGE.GRAND_FINAL, slot: 0 }),
      scheduledRecord({ _id: 'lb1', round: 1, stage: BRACKET_STAGE.LOSERS, slot: 0 }),
      scheduledRecord({ _id: 'wb2', round: 2, stage: BRACKET_STAGE.WINNERS, slot: 0 }),
      scheduledRecord({ _id: 'wb1', round: 1, stage: BRACKET_STAGE.WINNERS, slot: 0 }),
    ],
    event,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['wb1', 'wb2', 'lb1', 'gf1'],
    '胜者组两轮 → 败者组 → 总决赛'
  );
  assert.strictEqual(rows[0].roundText, '胜者组 · 第 1 轮');
  assert.strictEqual(rows[2].roundText, '败者组 · 第 1 轮');
  assert.strictEqual(rows[3].roundText, '总决赛');
});

test('buildStandings —— 各组分表，胜场靠前的排前面，净胜带正负号', () => {
  const event = {
    _id: 'e1',
    format: EVENT_FORMAT.GROUP_KNOCKOUT,
    draw: {
      groups: [
        { group: 0, entries: ['a', 'b'] },
        { group: 1, entries: ['c', 'd'] },
      ],
    },
  };
  const played = (over) =>
    scheduledRecord({
      status: MATCH_STATUS.ACTIVE,
      scoreA: [11],
      scoreB: [7],
      winner: 'A',
      ...over,
    });
  const memberMap = new Map([
    ['a', { _id: 'a', nickName: '甲' }],
    ['b', { _id: 'b', nickName: '乙' }],
    ['c', { _id: 'c', nickName: '丙' }],
    ['d', { _id: 'd', nickName: '丁' }],
  ]);
  const standings = buildStandings(
    event,
    [
      played({ _id: 'a1', group: 0, stage: BRACKET_STAGE.GROUP, teamA: ['a'], teamB: ['b'] }),
      // B 组这场胜者写在 B 侧，顺带验证名次确实跟着战绩走
      played({
        _id: 'b1',
        group: 1,
        stage: BRACKET_STAGE.GROUP,
        teamA: ['c'],
        teamB: ['d'],
        scoreA: [7],
        scoreB: [11],
        winner: 'B',
      }),
    ],
    memberMap,
    { _id: 'c' }
  );

  assert.strictEqual(standings.length, 2);
  const groupA = standings.find((item) => item.group === 0);
  const groupB = standings.find((item) => item.group === 1);
  assert.strictEqual(groupA.groupLabel, 'A 组');
  assert.strictEqual(groupA.rows[0].nickName, '甲');
  assert.strictEqual(groupA.rows[0].rank, 1);
  assert.strictEqual(groupA.rows[0].wins, 1);
  assert.strictEqual(groupA.rows[0].gameDiffText, '+1');
  assert.strictEqual(groupA.rows[0].pointDiffText, '+4');
  assert.strictEqual(groupA.rows[1].gameDiffText, '-1');
  assert.strictEqual(groupA.rows[1].pointDiffText, '-4');
  assert.strictEqual(groupA.rows[0].isMe, false);
  assert.strictEqual(groupB.rows[0].nickName, '丁', 'B 组的胜者是丁');
  const meRow = groupB.rows.find((row) => row.nickName === '丙');
  assert.strictEqual(meRow.isMe, true, '丙登录时高亮丙那一行');
  assert.strictEqual(groupB.rows[0].isMe, false, '胜者丁不是当前登录人');
});

test('buildStandings —— 还没抽签（没有分组）时不硬造一张空表', () => {
  assert.deepStrictEqual(buildStandings({ _id: 'e1' }, [], BRACKET_MEMBERS), []);
  assert.deepStrictEqual(
    buildStandings({ _id: 'e1', draw: { groups: [] } }, [], BRACKET_MEMBERS),
    []
  );
});

/* ---------- 双打：一方的两人要一起显示 ---------- */

/** 队号 = 两名成员编号用分隔符拼起来，与 draw.teamIdOf 同一拼法 */
const teamId = (a, b) => [a, b].join(TEAM_ID_SEPARATOR);

const DOUBLES_MEMBERS = new Map([
  ['a', { _id: 'a', nickName: '甲' }],
  ['b', { _id: 'b', nickName: '乙' }],
  ['c', { _id: 'c', nickName: '丙' }],
  ['d', { _id: 'd', nickName: '丁' }],
]);

test('teamTextOf / entryTextOf / byeTextOf —— 双打一方两人一起显示', () => {
  assert.strictEqual(teamTextOf(['a'], DOUBLES_MEMBERS), '甲', '单打仍是一人一名');
  assert.strictEqual(teamTextOf(['a', 'b'], DOUBLES_MEMBERS), '甲、乙');
  assert.strictEqual(teamTextOf([], DOUBLES_MEMBERS), '待定');
  // 双打签位编号是队号，拆开后交给 teamTextOf
  assert.strictEqual(entryTextOf(teamId('a', 'b'), DOUBLES_MEMBERS), '甲、乙');
  // 查不到档案时退回编号，不留空白
  assert.strictEqual(entryTextOf(teamId('a', 'ghost'), DOUBLES_MEMBERS), '甲、ghost');
  assert.strictEqual(
    byeTextOf({ byes: [teamId('a', 'b'), 'c'] }, DOUBLES_MEMBERS),
    '轮空直接晋级：甲、乙、丙'
  );
});

test('buildBracketRows —— 双打两边各显两人，不再只露第一人', () => {
  const event = { _id: 'e1', matchType: MATCH_TYPE.DOUBLES, draw: { size: 4, slots: [] } };
  const rows = buildBracketRows(
    [
      scheduledRecord({
        matchType: MATCH_TYPE.DOUBLES,
        teamA: ['a', 'b'],
        teamB: ['c', 'd'],
      }),
    ],
    event,
    DOUBLES_MEMBERS,
    { actor: null }
  );

  assert.strictEqual(rows[0].teamAText, '甲、乙');
  assert.strictEqual(rows[0].teamBText, '丙、丁');
});

test('buildStandings —— 双打一行是一队，任一成员是我即高亮整行', () => {
  const event = {
    _id: 'e1',
    matchType: MATCH_TYPE.DOUBLES,
    format: EVENT_FORMAT.ROUND_ROBIN,
    draw: { groups: [{ group: 0, entries: [teamId('a', 'b'), teamId('c', 'd')] }] },
  };
  const standings = buildStandings(
    event,
    [
      scheduledRecord({
        matchType: MATCH_TYPE.DOUBLES,
        group: 0,
        stage: BRACKET_STAGE.GROUP,
        teamA: ['a', 'b'],
        teamB: ['c', 'd'],
        status: MATCH_STATUS.ACTIVE,
        scoreA: [11],
        scoreB: [7],
        winner: 'A',
      }),
    ],
    DOUBLES_MEMBERS,
    { _id: 'b' }
  );

  const rows = standings[0].rows;
  assert.strictEqual(rows[0].nickName, '甲、乙');
  assert.strictEqual(rows[1].nickName, '丙、丁');
  assert.strictEqual(rows[0].isMe, true, '乙是队里一员，整行都该高亮');
  assert.strictEqual(rows[1].isMe, false);
});

test('drawnTeamIds / buildTeamRows —— 双打名次页一行一支队，带两名成员编号', () => {
  assert.deepStrictEqual(
    drawnTeamIds({ slots: [teamId('a', 'b'), teamId('c', 'd'), teamId('a', 'b')] }),
    [teamId('a', 'b'), teamId('c', 'd')],
    '去重且保序'
  );
  // 循环 / 小组看各组名单
  assert.deepStrictEqual(
    drawnTeamIds({ groups: [{ entries: [teamId('a', 'b')] }, { entries: [teamId('c', 'd')] }] }),
    [teamId('a', 'b'), teamId('c', 'd')]
  );
  assert.deepStrictEqual(drawnTeamIds(null), []);

  const rows = buildTeamRows([teamId('a', 'b'), teamId('c', 'd')], DOUBLES_MEMBERS);
  assert.strictEqual(rows[0].userId, teamId('a', 'b'));
  assert.deepStrictEqual(rows[0].userIds, ['a', 'b'], '提交时要据它把名次摊到两人');
  assert.strictEqual(rows[0].nickName, '甲、乙');
  assert.strictEqual(rows[0].avatarText, '甲');
});

/* ============================================================
 * 排序与常量（旧端到端段落删除后剩下的收尾）
 * ============================================================ */

test('赛事页 —— 等级常量齐全，供第一项的发布赛事使用', () => {
  assert.strictEqual(EVENT_LEVEL.FIRST, 1);
  assert.strictEqual(EVENT_LEVEL.SECOND, 2);
  assert.strictEqual(EVENT_LEVEL.THIRD, 3);
});

test('sortEvents —— 置顶的压过状态分档，取消置顶后回到原序', () => {
  const events = [
    { _id: 'finished', status: EVENT_STATUS.FINISHED, startTime: '2026-03-01T09:00:00' },
    { _id: 'ongoing', status: EVENT_STATUS.ONGOING, startTime: '2026-04-01T09:00:00' },
    { _id: 'signup', status: EVENT_STATUS.SIGNUP, startTime: '2026-05-01T09:00:00' },
  ];

  // 没有置顶时按 报名中 → 进行中 → 已结束
  assert.deepStrictEqual(sortEvents(events).map((e) => e._id), ['signup', 'ongoing', 'finished']);

  // 置顶是管理员的明确表态，要压过自动排序的一切规则：一场置顶的「已结束」
  // 赛事必须排在任何「报名中」之前，否则置顶就失去意义
  const pinned = [{ ...events[0], pinned: true }, events[1], events[2]];
  assert.deepStrictEqual(sortEvents(pinned).map((e) => e._id), ['finished', 'signup', 'ongoing']);
  assert.deepStrictEqual(sortEvents([]), []);
});

test('sortCollegeEvents —— 学院赛同样置顶优先，且不就地改写入参', () => {
  const events = [
    { _id: 'finished', status: COLLEGE_EVENT_STATUS.FINISHED, startTime: '2026-03-01T09:00:00' },
    { _id: 'signup', status: COLLEGE_EVENT_STATUS.SIGNUP, startTime: '2026-05-01T09:00:00' },
    { _id: 'pinned', status: COLLEGE_EVENT_STATUS.FINISHED, startTime: '2026-02-01T09:00:00', pinned: true },
  ];
  const before = events.map((e) => e._id);

  assert.deepStrictEqual(sortCollegeEvents(events).map((e) => e._id), ['pinned', 'signup', 'finished']);
  assert.deepStrictEqual(events.map((e) => e._id), before, '排序要另起数组，不能改乱入参');
});
