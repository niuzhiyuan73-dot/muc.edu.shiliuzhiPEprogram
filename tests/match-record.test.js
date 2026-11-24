const test = require('node:test');
const assert = require('node:assert');

const {
  sideOf,
  isParticipant,
  isRecorder,
  involvesCollege,
  canRecordScore,
  canConfirm,
  hasReferee,
  canAssignReferee,
  buildRefereePatch,
  needsScore,
  normalizeScores,
  buildMatchRecord,
  fillScheduledMatch,
} = require('../src/shared/services/match-record.js');
const { MATCH_TYPE, MATCH_STATUS, ROLE } = require('../src/shared/utils/constants.js');

/* ============================================================
 * 一、位置与身份
 * ============================================================ */

const DOUBLES = {
  _id: 'm1',
  matchType: MATCH_TYPE.DOUBLES,
  teamA: ['u01', 'u02'],
  teamB: ['u03', 'u04'],
  recorder: 'u01',
  status: MATCH_STATUS.PENDING,
};

test('sideOf —— 分辨站在 A 队、B 队还是没上场', () => {
  assert.strictEqual(sideOf(DOUBLES, 'u02'), 'A');
  assert.strictEqual(sideOf(DOUBLES, 'u03'), 'B');
  assert.strictEqual(sideOf(DOUBLES, 'u99'), null);
  assert.strictEqual(sideOf(null, 'u01'), null);
  assert.strictEqual(sideOf(DOUBLES, ''), null);
});

test('isParticipant / isRecorder —— 参赛与录入是两回事', () => {
  assert.strictEqual(isParticipant(DOUBLES, 'u04'), true);
  assert.strictEqual(isParticipant(DOUBLES, 'u99'), false);

  assert.strictEqual(isRecorder(DOUBLES, 'u01'), true);
  // 搭档在场上，但不是他录的
  assert.strictEqual(isRecorder(DOUBLES, 'u02'), false);
  assert.strictEqual(isRecorder(DOUBLES, 'u03'), false);
});

/* ============================================================
 * 二、确认权
 * ============================================================ */

test('canConfirm —— 对手方可以确认', () => {
  assert.strictEqual(canConfirm(DOUBLES, 'u03'), true);
  assert.strictEqual(canConfirm(DOUBLES, 'u04'), true);
});

test('canConfirm —— 录入方不能自己给自己盖章', () => {
  // 这是防刷分的第一道闸门：能自证的话，一个人就能凭空造出一场胜利
  assert.strictEqual(canConfirm(DOUBLES, 'u01'), false);
  // 录的人是对手，自己站在录入者对面，则可以确认
  assert.strictEqual(canConfirm(DOUBLES, 'u03'), true);
});

test('canConfirm —— 没上场的人、已生效或已撤销的都免谈', () => {
  assert.strictEqual(canConfirm(DOUBLES, 'u99'), false);
  assert.strictEqual(canConfirm({ ...DOUBLES, status: MATCH_STATUS.ACTIVE }, 'u03'), false);
  assert.strictEqual(canConfirm({ ...DOUBLES, status: MATCH_STATUS.REVOKED }, 'u03'), false);
  assert.strictEqual(canConfirm(null, 'u03'), false);
});

test('canConfirm —— mock 单账号下放宽为「参与即可」，并能看出这是放宽来的', () => {
  // 本地演示只有一个账号，严格按对手确认的话没有任何一场能确认成功
  assert.strictEqual(canConfirm(DOUBLES, 'u01', { isMock: true }), true);
  // 但没上场的人仍然不行，放宽不是放水
  assert.strictEqual(canConfirm(DOUBLES, 'u99', { isMock: true }), false);
});

test('canConfirm —— 录入者不在场上时不做额外限制', () => {
  const orphan = { ...DOUBLES, recorder: 'u99' };
  assert.strictEqual(canConfirm(orphan, 'u01'), true);
});

test('canConfirm —— 管理员可以确认任意一场（含自己没打的）', () => {
  // 临场收口：双方都认账却没人掏手机点确认，管理员代为确认
  assert.strictEqual(canConfirm(DOUBLES, 'u99', { role: ROLE.ADMIN }), true);
  assert.strictEqual(canConfirm(DOUBLES, 'u01', { role: ROLE.ADMIN }), true);
  // 但仍只限「待确认」：已生效的要比分要改，得先撤销
  assert.strictEqual(
    canConfirm({ ...DOUBLES, status: MATCH_STATUS.ACTIVE }, 'u99', { role: ROLE.ADMIN }),
    false
  );
  // 学院负责人没有这项放宽，仍按对手方口径
  assert.strictEqual(canConfirm(DOUBLES, 'u99', { role: ROLE.STAFF }), false);
});

/* ============================================================
 * 三、（已删除）撤销权
 * ============================================================
 * canRevoke 及其用例已随 Elo 逐场结算改造一并删除：确认即最终结算，
 * 不存在管理员撤销路径；发现录错走确认前驳回（见 canConfirm 用例）。
 * ============================================================ */


/* ============================================================
 * 三、录分与确认的边界
 * ============================================================ */

test('needsScore —— 没比分的待确认比赛要人先录分', () => {
  // 抽签排出来的比赛就是这个样子：状态是待确认，但比分与胜方都还没有
  const scheduled = { ...DOUBLES, scoreA: [], scoreB: [], winner: null };
  assert.strictEqual(needsScore(scheduled), true);
});

test('needsScore —— 已有胜方的待确认比赛不用再录', () => {
  // 日常约球录完就是这个状态，等着对手确认即可
  assert.strictEqual(needsScore({ ...DOUBLES, winner: 'A' }), false);
});

test('needsScore —— 已生效、已撤销、空记录都不算「待录分」', () => {
  assert.strictEqual(needsScore({ ...DOUBLES, status: MATCH_STATUS.ACTIVE }), false);
  assert.strictEqual(needsScore({ ...DOUBLES, status: MATCH_STATUS.REVOKED }), false);
  assert.strictEqual(needsScore(null), false);
  assert.strictEqual(needsScore(undefined), false);
});

/* ============================================================
 * 四、比分整理
 * ============================================================ */

test('normalizeScores —— 去掉尾部空行，转成数字', () => {
  // 三局两胜渲染三行，一局一胜的人只会填第一行
  assert.deepStrictEqual(normalizeScores(['11', '9', '', '']), [11, 9]);
  assert.deepStrictEqual(normalizeScores(['11', ' 9 ']), [11, 9]);
  assert.deepStrictEqual(normalizeScores([11, 9]), [11, 9]);
  assert.deepStrictEqual(normalizeScores(['', '', '']), []);
  assert.deepStrictEqual(normalizeScores(null), []);
});

test('normalizeScores —— 中间的空行保留成 null，不被悄悄跳过', () => {
  // 跳过的话，多录的一局会被挤掉，比分与赛制就对不上了
  assert.deepStrictEqual(normalizeScores(['11', '', '11']), [11, null, 11]);
});

test('normalizeScores —— 非数字变成 NaN（而不是 0）', () => {
  // 当成 0 的话，「11:0」和「没填」在数据里长得一模一样
  const result = normalizeScores(['11', 'abc']);
  assert.strictEqual(result[0], 11);
  assert.ok(Number.isNaN(result[1]));
});

/* ============================================================
 * 五、录入校验
 * ============================================================ */

const NOW = '2026-05-10T00:00:00';
const MIN = '2026-04-06T00:00:00';

/** 一份合法的单打录入参数 */
function singlesParams(overrides = {}) {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    matchTime: '2026-05-01T18:00:00',
    location: '学校体育馆 1 号场',
    ...overrides,
  };
}

test('buildMatchRecord —— 合法单打能组装出完整记录', () => {
  const result = buildMatchRecord(singlesParams(), { now: NOW, minMatchTime: MIN });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.firstError, '');
  assert.deepStrictEqual(result.scoreErrors, []);

  const record = result.record;
  assert.strictEqual(record.matchType, MATCH_TYPE.SINGLES);
  // 池漏了会被 getMatches({ pool }) 静默过滤掉，录进去却查不到
  assert.strictEqual(record.pool, 'singles');
  assert.deepStrictEqual(record.scoreA, [11, 11]);
  assert.deepStrictEqual(record.scoreB, [9, 7]);
  assert.strictEqual(record.gamePoints, 11);
  assert.strictEqual(record.bestOf, 3);
  assert.strictEqual(record.winner, 'A');
  assert.strictEqual(record.recorder, 'u01', '录入者默认是 A 队第一位');
  assert.strictEqual(record.eventId, null, '日常约球没有赛事归属');
});

test('buildMatchRecord —— 带上 eventId 时原样落库', () => {
  const inEvent = buildMatchRecord(singlesParams({ eventId: 'e07' }), {
    now: NOW,
    minMatchTime: MIN,
  });
  assert.strictEqual(inEvent.ok, true);
  assert.strictEqual(inEvent.record.eventId, 'e07');
});

test('buildMatchRecord —— 胜负由比分推出，不接受外部指定', () => {
  const bWins = buildMatchRecord(
    singlesParams({ scoreA: ['9', '7'], scoreB: ['11', '11'] }),
    { now: NOW, minMatchTime: MIN }
  );
  assert.strictEqual(bWins.record.winner, 'B');
});

test('buildMatchRecord —— 双打两两配对合法', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01', 'u02'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.pool, 'doubles');
  assert.strictEqual(result.record.recorder, 'u01');
});

test('buildMatchRecord —— 双打少一个人要被拦下', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamA, /双打每队需要 2 位会员/);
  assert.strictEqual(result.firstError, result.errors.teamA);
});

test('buildMatchRecord —— 一个人不能同时出现在两队', () => {
  const result = buildMatchRecord(
    singlesParams({ teamB: ['u01'] }),
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamB, /不能同时出现在两队/);
});

test('buildMatchRecord —— 同一队里不能有重复的人', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01', 'u01'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamA, /不能重复/);
});

test('buildMatchRecord —— 传了名单时校验参赛者都在名单里', () => {
  // 本地注册账号不在种子里，回放时会直接抛错，所以必须在这里先拦住
  const result = buildMatchRecord(singlesParams(), {
    now: NOW,
    minMatchTime: MIN,
    members: [{ _id: 'u01' }, { _id: 'u99' }],
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamB, /不在名单中/);
});

test('buildMatchRecord —— 没选项目时先提示选项目', () => {
  const result = buildMatchRecord(singlesParams({ matchType: undefined }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.matchType, '请选择单打或双打');
  assert.strictEqual(result.firstError, '请选择单打或双打');
});

test('buildMatchRecord —— 赛制不合法时只报赛制，不报一堆连带错误', () => {
  const result = buildMatchRecord(singlesParams({ gamePoints: 9, bestOf: 3 }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.format, '请选择有效的分制与局制');
  assert.deepStrictEqual(result.scoreErrors, [], '赛制都不对，比分的报错没有意义');
});

test('buildMatchRecord —— 比分没打完会逐条列出', () => {
  const result = buildMatchRecord(
    singlesParams({ scoreA: ['11', '11'], scoreB: ['10', '7'] }),
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.scoreErrors, ['第 1 局胜方必须领先 2 分（11:10）']);
  assert.strictEqual(result.firstError, result.scoreErrors[0]);
});

test('buildMatchRecord —— 空比分拦下', () => {
  const result = buildMatchRecord(singlesParams({ scoreA: ['', ''], scoreB: ['', ''] }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.scoreErrors, ['至少要录入 1 局比分']);
});

test('buildMatchRecord —— 同样不能打平', () => {
  const result = buildMatchRecord(singlesParams({ scoreA: ['11', '11'], scoreB: ['11', '9'] }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.scoreErrors.some((e) => e.includes('不能打平')));
});

/* ============================================================
 * 六、时间窗
 * ============================================================ */

test('buildMatchRecord —— 没填时间要拦下', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: undefined }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.matchTime, '请选择比赛时间');
});

test('buildMatchRecord —— 时间不能录到赛季首场之前', () => {
  // 一旦允许，回放的定级锚点会前移，全体中途入会者的初始分被静默重算
  const result = buildMatchRecord(singlesParams({ matchTime: '2026-03-01T18:00:00' }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.matchTime, /不能早于本赛季首场/);
});

test('buildMatchRecord —— 时间不能录到未来', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: '2026-06-01T18:00:00' }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.matchTime, /不能晚于现在/);
});

test('buildMatchRecord —— 时间边界正好取到首场那一刻也算合法', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: MIN }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, true);
});

test('buildMatchRecord —— 不注入时间时跳过时间校验，不偷读系统时钟', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: '2099-01-01T18:00:00' }));
  assert.strictEqual(result.ok, true);
});

/* ============================================================
 * 七、错误顺序
 * ============================================================ */

test('buildMatchRecord —— 报错顺序从粗到细，先说该做的事', () => {
  const result = buildMatchRecord(
    { matchType: undefined, teamA: [], teamB: [], scoreA: [], scoreB: [], gamePoints: 11, bestOf: 3 },
    { now: NOW, minMatchTime: MIN }
  );

  // 什么都没填时，先提醒选项目，而不是甩一条比分错误
  assert.strictEqual(result.firstError, '请选择单打或双打');
});

/* ============================================================
 * 六、给抽签生成的比赛补录比分
 * ============================================================ */

/** 抽签生成的一场待确认比赛 */
function scheduled(overrides = {}) {
  return {
    _id: 'x_e07_r1_main_0',
    matchType: MATCH_TYPE.SINGLES,
    pool: 'singles',
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: [],
    scoreB: [],
    gamePoints: 11,
    bestOf: 3,
    winner: null,
    location: '学校体育馆 1 号场',
    matchTime: '2026-05-01T18:00:00',
    recorder: null,
    eventId: 'e07',
    round: 1,
    stage: 'main',
    slot: 0,
    status: MATCH_STATUS.PENDING,
    ...overrides,
  };
}

test('fillScheduledMatch —— 补上比分，胜方由比分推出', () => {
  const result = fillScheduledMatch(scheduled(), { scoreA: ['11', '11'], scoreB: ['9', '7'] }, {
    now: NOW,
    minMatchTime: MIN,
    recorder: 'u01',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.patch.winner, 'A');
  assert.deepStrictEqual(result.patch.scoreA, [11, 11]);
  assert.strictEqual(result.patch.recorder, 'u01');
  // 签位与赛事归属必须原样带回来，否则重抽去重会认不出这一场
  assert.strictEqual(result.patch._id, undefined, '补丁里不该带 _id，由调用方按既有编号合并');
  assert.strictEqual(result.patch.round, 1);
  assert.strictEqual(result.patch.stage, 'main');
  assert.strictEqual(result.patch.slot, 0);
  assert.strictEqual(result.patch.eventId, 'e07');
});

test('fillScheduledMatch —— 对阵与赛制取自记录，不吃入参', () => {
  const result = fillScheduledMatch(scheduled(), { scoreA: ['11', '11'], scoreB: ['5', '3'] }, {
    now: NOW,
    minMatchTime: MIN,
  });
  assert.deepStrictEqual(result.patch.teamA, ['u01']);
  assert.deepStrictEqual(result.patch.teamB, ['u02']);
  assert.strictEqual(result.patch.gamePoints, 11);
  assert.strictEqual(result.patch.bestOf, 3);
});

test('fillScheduledMatch —— 比分没打完仍按同一套校验拦下', () => {
  const result = fillScheduledMatch(scheduled(), { scoreA: ['11', '9'], scoreB: ['9', '11'] }, {
    now: NOW,
    minMatchTime: MIN,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.scoreErrors.length > 0);
});

test('fillScheduledMatch —— 已生效的比赛不能再补录', () => {
  const result = fillScheduledMatch(
    scheduled({ status: MATCH_STATUS.ACTIVE }),
    { scoreA: ['11'], scoreB: ['5'] },
    { now: NOW, minMatchTime: MIN }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.firstError, /待确认/);
});

test('fillScheduledMatch —— 没有记录时报找不到', () => {
  const result = fillScheduledMatch(null, { scoreA: ['11'], scoreB: ['5'] });
  assert.strictEqual(result.ok, false);
  assert.match(result.firstError, /找不到/);
});

/* ============================================================
 * 七、录分权（involvesCollege / canRecordScore）
 * ============================================================
 * 学院负责人的权限以学院为界：只有本学院有人上场的比赛才轮得到他
 * 代录。学院不存在比赛记录里（那里只有编号），所以由调用方传入 collegeOf。
 * ============================================================ */

/** 编号 → 学院，模拟会员档案 */
const COLLEGE_OF = (id) =>
  ({ u01: '体育学院', u02: '体育学院', u03: '美术学院', u04: '美术学院' }[id] || '');

test('involvesCollege —— 只要有一人属于该学院就算涉及', () => {
  assert.strictEqual(involvesCollege(DOUBLES, '体育学院', COLLEGE_OF), true);
  assert.strictEqual(involvesCollege(DOUBLES, '美术学院', COLLEGE_OF), true);
  assert.strictEqual(involvesCollege(DOUBLES, '信息工程学院', COLLEGE_OF), false);
});

test('involvesCollege —— 缺参数时一律为假，不抛错', () => {
  assert.strictEqual(involvesCollege(DOUBLES, '', COLLEGE_OF), false);
  assert.strictEqual(involvesCollege(DOUBLES, '体育学院', null), false);
  assert.strictEqual(involvesCollege(null, '体育学院', COLLEGE_OF), false);
});

test('canRecordScore —— 参赛者本人可以录自己的比赛', () => {
  assert.strictEqual(canRecordScore(DOUBLES, 'u02', { role: ROLE.MEMBER }), true);
});

test('canRecordScore —— 管理员可以代录任意一场', () => {
  assert.strictEqual(
    canRecordScore(DOUBLES, 'u99', { role: ROLE.ADMIN, collegeOf: COLLEGE_OF }),
    true
  );
});

test('canRecordScore —— 学院负责人只能代录本学院有人上场的比赛', () => {
  const options = { role: ROLE.STAFF, college: '体育学院', collegeOf: COLLEGE_OF };
  assert.strictEqual(canRecordScore(DOUBLES, 's1', options), true);

  const other = { role: ROLE.STAFF, college: '信息工程学院', collegeOf: COLLEGE_OF };
  assert.strictEqual(canRecordScore(DOUBLES, 's1', other), false);
});

test('canRecordScore —— 普通会员与访客都不能代录别人的比赛', () => {
  assert.strictEqual(canRecordScore(DOUBLES, 'u99', { role: ROLE.MEMBER }), false);
  assert.strictEqual(canRecordScore(DOUBLES, '', { role: ROLE.ADMIN }), false);
  assert.strictEqual(canRecordScore(null, 'u99', { role: ROLE.ADMIN }), false);
});

/* ============================================================
 * 八、裁判（referee）
 * ============================================================
 * 指定裁判后，录分权与确认权都收口到裁判本人 + 管理员。没指定时一切照旧，
 * 这是零回归的底线：现有比赛记录里根本没有 referee 字段。
 * ============================================================ */

test('hasReferee —— 没指定或空白串都算「没有裁判」', () => {
  assert.strictEqual(hasReferee(DOUBLES), false, '缺字段就是没裁判');
  assert.strictEqual(hasReferee({ ...DOUBLES, referee: '' }), false);
  assert.strictEqual(hasReferee({ ...DOUBLES, referee: '   ' }), false);
  assert.strictEqual(hasReferee({ ...DOUBLES, referee: null }), false);
  assert.strictEqual(hasReferee(null), false);
  assert.strictEqual(hasReferee({ ...DOUBLES, referee: 'u05' }), true);
});

test('裁判未指定时录分权与今天完全一致（零回归）', () => {
  // 参赛者照录，管理员照代录，学院负责人照按学院代录，旁人照挡
  assert.strictEqual(canRecordScore(DOUBLES, 'u02', { role: ROLE.MEMBER }), true);
  assert.strictEqual(canRecordScore(DOUBLES, 'u99', { role: ROLE.ADMIN }), true);
  assert.strictEqual(
    canRecordScore(DOUBLES, 's1', { role: ROLE.STAFF, college: '体育学院', collegeOf: COLLEGE_OF }),
    true
  );
  assert.strictEqual(canRecordScore(DOUBLES, 'u99', { role: ROLE.MEMBER }), false);
});

test('裁判未指定时确认权与今天完全一致（零回归）', () => {
  // 对手方确认、录入方不能自证、管理员兜底，全部不变
  assert.strictEqual(canConfirm(DOUBLES, 'u03'), true);
  assert.strictEqual(canConfirm(DOUBLES, 'u01'), false);
  assert.strictEqual(canConfirm(DOUBLES, 'u99', { role: ROLE.ADMIN }), true);
  assert.strictEqual(canConfirm(DOUBLES, 'u02', { isMock: true }), true);
});

test('指定裁判后，录分权只认裁判与管理员', () => {
  const judged = { ...DOUBLES, referee: 'u05' };
  // 裁判本人可以录
  assert.strictEqual(canRecordScore(judged, 'u05', { role: ROLE.MEMBER }), true);
  // 管理员兜底不变
  assert.strictEqual(canRecordScore(judged, 'u99', { role: ROLE.ADMIN }), true);
  // 参赛者本人反而录不了——这是「交给他执法」的题中之义
  assert.strictEqual(canRecordScore(judged, 'u01', { role: ROLE.MEMBER }), false);
  assert.strictEqual(canRecordScore(judged, 'u03', { role: ROLE.MEMBER }), false);
  // 学院负责人也不越过裁判代录
  assert.strictEqual(
    canRecordScore(judged, 's1', { role: ROLE.STAFF, college: '体育学院', collegeOf: COLLEGE_OF }),
    false
  );
});

test('指定裁判后，确认权只认裁判与管理员', () => {
  const judged = { ...DOUBLES, referee: 'u05' };
  // 裁判录完自己盖章，不必再等对手——他本来就是双方请来的见证人
  assert.strictEqual(canConfirm(judged, 'u05', { role: ROLE.MEMBER }), true);
  assert.strictEqual(canConfirm(judged, 'u99', { role: ROLE.ADMIN }), true);
  // 对手方不再自行确认
  assert.strictEqual(canConfirm(judged, 'u03'), false);
  // 录入方自证的老闸门在裁判场景下同样失效（裁判就是那个「录入方」）
  assert.strictEqual(canConfirm(judged, 'u01'), false);
});

test('指定裁判后仍只限「待确认」，已生效的要改先撤销', () => {
  const judged = {
    ...DOUBLES,
    referee: 'u05',
    status: MATCH_STATUS.ACTIVE,
  };
  assert.strictEqual(canConfirm(judged, 'u05'), false);
  assert.strictEqual(canConfirm(judged, 'u99', { role: ROLE.ADMIN }), false);
  // mock 放宽也不越过「已生效」这道墙
  assert.strictEqual(canConfirm(judged, 'u05', { isMock: true }), false);
});

test('canAssignReferee —— 只有待确认的比赛能指派或改派裁判', () => {
  assert.strictEqual(canAssignReferee(DOUBLES), true);
  assert.strictEqual(canAssignReferee({ ...DOUBLES, referee: 'u05' }), true, '改派也允许');
  assert.strictEqual(
    canAssignReferee({ ...DOUBLES, status: MATCH_STATUS.ACTIVE }),
    false,
    '已生效的比赛比分已入账，改裁判等于改口径'
  );
  assert.strictEqual(canAssignReferee({ ...DOUBLES, status: MATCH_STATUS.REVOKED }), false);
  assert.strictEqual(canAssignReferee(null), false);
});

test('buildRefereePatch —— 落库三个字段，指派人来自 ctx', () => {
  const at = new Date('2026-05-10T12:00:00');
  const patch = buildRefereePatch('u05', { actorId: 'a01', now: at });

  assert.strictEqual(patch.referee, 'u05');
  assert.strictEqual(patch.refereeBy, 'a01');
  assert.strictEqual(patch.refereeAt, at);
});

test('buildRefereePatch —— 传空串即撤下裁判，其余字段留痕', () => {
  // 撤下后 canRecordScore / canConfirm 立刻退回「人人照旧」的口径
  const patch = buildRefereePatch('', { actorId: 'a01' });
  assert.strictEqual(patch.referee, '');
  assert.strictEqual(hasReferee({ ...DOUBLES, ...patch }), false);
  assert.strictEqual(canRecordScore({ ...DOUBLES, ...patch }, 'u02'), true);
});

test('buildRefereePatch —— 编号两端空白被清掉，不留「看起来有裁判」的空壳', () => {
  const patch = buildRefereePatch('  u05  ', { actorId: 'a01' });
  assert.strictEqual(patch.referee, 'u05');
  // 缺省 ctx 时不抛错，落一个空指派人
  const bare = buildRefereePatch('u05');
  assert.strictEqual(bare.refereeBy, '');
});

/* ============================================================
 * 十、网球记录
 * ============================================================
 * 网球走三层计分，落库时与 11 分制只差「字段组」：
 * 带 scoring/setGames/tiebreakAt/tiebreakPoints/noAd 与抢七小分，
 * 不带 gamePoints。数组形状（scoreA/scoreB）与 bestOf 的含义照旧，
 * 所以 Elo、历史、格式化这些地方不用为网球另开一套。
 * ============================================================ */

/** 造一份网球录入参数 */
function tennisParams(overrides = {}) {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: ['6', '4', '7'],
    scoreB: ['4', '6', '6'],
    scoring: 'tennis',
    bestOf: 3,
    setGames: 6,
    tiebreakAt: 6,
    tiebreakPoints: 7,
    noAd: false,
    tiebreaks: [{ setIndex: 2, a: 7, b: 5 }],
    matchTime: '2026-05-01T18:00:00',
    location: '网球场 1 号',
    ...overrides,
  };
}

test('buildMatchRecord —— 网球记录带赛制与抢七小分，且不留 gamePoints', () => {
  const result = buildMatchRecord(tennisParams(), { now: NOW, minMatchTime: MIN });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.scoreErrors, []);

  const record = result.record;
  assert.deepStrictEqual(record.scoreA, [6, 4, 7]);
  assert.deepStrictEqual(record.scoreB, [4, 6, 6], '7:6 是合法的盘比分，不该被「领先 2」挡下');
  assert.strictEqual(record.scoring, 'tennis');
  assert.strictEqual(record.bestOf, 3);
  assert.strictEqual(record.setGames, 6);
  assert.strictEqual(record.tiebreakAt, 6);
  assert.strictEqual(record.tiebreakPoints, 7);
  assert.strictEqual(record.noAd, false);
  assert.strictEqual(record.gamePoints, undefined, '两套体系的字段不能混着落库');
  assert.strictEqual(record.winner, 'A');
  assert.deepStrictEqual(record.tiebreaks, [{ setIndex: 2, a: 7, b: 5 }]);
});

test('buildMatchRecord —— 网球赛制不合法时报「盘制与每盘局数」', () => {
  const result = buildMatchRecord(tennisParams({ setGames: 5, tiebreakAt: 5 }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.format, '请选择有效的盘制与每盘局数');
  assert.deepStrictEqual(result.scoreErrors, [], '赛制都不对，比分的报错没有意义');
});

test('buildMatchRecord —— 网球的「还差一局」与「多录一盘」都拦下', () => {
  const unfinished = buildMatchRecord(tennisParams({ scoreA: ['6'], scoreB: ['5'] }), {
    now: NOW,
    minMatchTime: MIN,
  });
  assert.strictEqual(unfinished.ok, false);
  assert.ok(
    unfinished.scoreErrors.some((text) => /第 1 盘/.test(text)),
    '6:5 不是打完的盘，要被点出来'
  );

  const extra = buildMatchRecord(tennisParams({ scoreA: ['6', '6', '6'], scoreB: ['4', '4', '4'] }), {
    now: NOW,
    minMatchTime: MIN,
  });
  assert.strictEqual(extra.ok, false, '已经 2:0 之后再录一盘要报错');
});

test('buildMatchRecord —— 抢七小分只做形状清洗，打平 / 0 分条目丢掉', () => {
  const result = buildMatchRecord(
    tennisParams({
      tiebreaks: [
        { setIndex: 0, a: 7, b: 5 },
        { setIndex: 1, a: 7, b: 7 },
        { setIndex: 2, a: 0, b: 0 },
        'junk',
      ],
    }),
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    result.record.tiebreaks,
    [{ setIndex: 0, a: 7, b: 5 }],
    '抢七永不决定胜负，所以这里只清形状，不拿它校验'
  );
});

test('fillScheduledMatch —— 网球补录沿用记录上的赛制，并把抢七小分带上去', () => {
  const match = {
    _id: 'm_tn01',
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: [],
    scoreB: [],
    scoring: 'tennis',
    bestOf: 1,
    setGames: 4,
    tiebreakAt: 4,
    tiebreakPoints: 7,
    noAd: true,
    status: MATCH_STATUS.PENDING,
    matchTime: '2026-05-01T18:00:00',
    location: '网球场 2 号',
    eventId: null,
    round: 1,
    stage: 'main',
    slot: 0,
  };

  const result = fillScheduledMatch(
    match,
    { scoreA: ['5'], scoreB: ['4'], tiebreaks: [{ setIndex: 0, a: 7, b: 5 }] },
    { now: NOW, minMatchTime: MIN, recorder: 'u01' }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.patch.scoreA, [5]);
  assert.strictEqual(result.patch.scoring, 'tennis');
  assert.strictEqual(result.patch.setGames, 4);
  assert.strictEqual(result.patch.noAd, true);
  assert.strictEqual(result.patch.gamePoints, undefined);
  assert.deepStrictEqual(result.patch.tiebreaks, [{ setIndex: 0, a: 7, b: 5 }]);
  assert.strictEqual(result.patch.winner, 'A');
});
