/**
 * 录入表单的纯逻辑自检
 * ============================================================
 * 表单里有三类容易出错、又非测不可的地方：
 *
 *   1. 换项目 / 换局制时的「扩容与缩容」——多出来的格子要丢、缺的要补，
 *      但用户已经填过的内容不能跟着一起没。
 *   2. 胜方只能从比分推，不能由用户指定。推不出来时必须老实返回 null，
 *      而不是默认 A 队赢。
 *   3. 表单 → 接口入参的搬运：空选手要滤掉（交给人数的校验去报错），
 *      winner / recorder 一个都不许带——它们由数据层决定。
 *
 * 这些逻辑不碰 wx API，所以能全部用字面量输入钉死在这里。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MATCH_TYPE_OPTIONS,
  GAME_POINTS_LABELS,
  BEST_OF_LABELS,
  teamSizeOf,
  createForm,
  scheduledForm,
  createTeams,
  resizeTeams,
  resizeScores,
  toScoreRows,
  winnerOf,
  formatTextOf,
  toSubmitParams,
  formatOptionsOf,
  scoreUnitLabelOf,
  buildPickerRows,
  pickerEmptyText,
} = require('../miniprogram/services/match-entry-view.js');
const { MATCH_TYPE } = require('../src/shared/utils/constants.js');
const { GAME_POINTS_OPTIONS, BEST_OF_OPTIONS } = require('../src/shared/utils/match-format.js');

const ME = { _id: 'u06', nickName: '赵明宇' };

/* ============================================================
 * 一、选项与人数
 * ============================================================ */

test('选项 —— 单打排在双打前面，与全站默认口径一致', () => {
  assert.deepStrictEqual(
    MATCH_TYPE_OPTIONS.map((item) => item.value),
    [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES]
  );
  assert.strictEqual(MATCH_TYPE_OPTIONS[0].label, '单打');
});

test('选项 —— picker 的文案与下标同源，不会错位', () => {
  // picker 吃的是下标，页面再按下标回查常量；两处必须同一份来源
  assert.deepStrictEqual(
    GAME_POINTS_LABELS,
    GAME_POINTS_OPTIONS.map((value) => `${value} 分制`)
  );
  assert.deepStrictEqual(
    BEST_OF_LABELS,
    BEST_OF_OPTIONS.map((value) => ({ 1: '一局一胜', 3: '三局两胜', 5: '五局三胜' }[value]))
  );
});

test('teamSizeOf —— 单打一人、双打两人，未知项目退回一人', () => {
  assert.strictEqual(teamSizeOf(MATCH_TYPE.SINGLES), 1);
  assert.strictEqual(teamSizeOf(MATCH_TYPE.DOUBLES), 2);
  assert.strictEqual(teamSizeOf(undefined), 1);
});

/* ============================================================
 * 二、建表
 * ============================================================ */

test('createForm —— 默认单打、11 分制三局两胜，A 队第一格是自己', () => {
  const form = createForm(ME);

  assert.strictEqual(form.matchType, MATCH_TYPE.SINGLES);
  assert.deepStrictEqual(form.teamA, ['u06']);
  assert.deepStrictEqual(form.teamB, ['']);
  assert.deepStrictEqual(form.scoreA, ['', '', '']);
  assert.deepStrictEqual(form.scoreB, ['', '', '']);
  assert.strictEqual(form.gamePoints, 11);
  assert.strictEqual(form.bestOf, 3);
});

test('createForm —— 没有登录态时第一格留空，而不是写进一个假的自己', () => {
  // 页面会用 blockReason 把整张表挡住；这里留空是为了万一漏挡，
  // 也只会变成「请选择参赛会员」的校验错误，而不是凭空记一场
  const form = createForm(null);
  assert.deepStrictEqual(form.teamA, ['']);
});

test('createTeams —— 双打两队各两格', () => {
  const teams = createTeams(MATCH_TYPE.DOUBLES, ME);
  assert.deepStrictEqual(teams.teamA, ['u06', '']);
  assert.deepStrictEqual(teams.teamB, ['', '']);
});

/* ============================================================
 * 三、换项目 / 换局制时的增删
 * ============================================================ */

test('resizeTeams —— 双打换单打丢掉多出来的队友，前面的保留', () => {
  const form = { teamA: ['u06', 'u01'], teamB: ['u02', 'u03'] };
  const fitted = resizeTeams(form, MATCH_TYPE.SINGLES);

  assert.deepStrictEqual(fitted.teamA, ['u06']);
  assert.deepStrictEqual(fitted.teamB, ['u02']);
});

test('resizeTeams —— 单打换双打补出空格子，填过的搭档不白填', () => {
  const form = { teamA: ['u06'], teamB: ['u02'] };
  const fitted = resizeTeams(form, MATCH_TYPE.DOUBLES);

  assert.deepStrictEqual(fitted.teamA, ['u06', '']);
  assert.deepStrictEqual(fitted.teamB, ['u02', '']);
});

test('resizeTeams —— 缺字段时兜底成空格子，不抛错', () => {
  assert.deepStrictEqual(resizeTeams({}, MATCH_TYPE.SINGLES), { teamA: [''], teamB: [''] });
  assert.deepStrictEqual(resizeTeams({ teamA: null }, MATCH_TYPE.DOUBLES), {
    teamA: ['', ''],
    teamB: ['', ''],
  });
});

test('resizeScores —— 从三局扩到五局补空行，已有比分之一字不动', () => {
  assert.deepStrictEqual(resizeScores(5, ['11', '9']), ['11', '9', '', '', '']);
});

test('resizeScores —— 从五局缩到一局只留第一行', () => {
  assert.deepStrictEqual(resizeScores(1, ['11', '9', '11', '', '']), ['11']);
});

test('resizeScores —— 原值缺失时整排空行', () => {
  assert.deepStrictEqual(resizeScores(3, undefined), ['', '', '']);
});

/* ============================================================
 * 四、比分 → 胜方
 * ============================================================ */

test('toScoreRows —— 两组比分按局配对，短的一边补空串', () => {
  assert.deepStrictEqual(toScoreRows(['11', '9'], ['9']), [
    { index: 0, a: '11', b: '9' },
    { index: 1, a: '9', b: '' },
  ]);
  assert.deepStrictEqual(toScoreRows(null, null), []);
});

test('winnerOf —— 两局拿下就判 A 胜，表单里存的是字符串也认', () => {
  assert.strictEqual(winnerOf(['11', '11'], ['9', '7'], 11, 3), 'A');
  assert.strictEqual(winnerOf(['9', '7'], ['11', '11'], 11, 3), 'B');
});

test('winnerOf —— 局分打平或没打完时返回 null，而不是默认 A 队赢', () => {
  // 1:1 还没分出胜负
  assert.strictEqual(winnerOf(['11', '9'], ['9', '11'], 11, 3), null);
  // 11:10 是没打完的局（先到 11 分还要领先 2 分）
  assert.strictEqual(winnerOf(['11'], ['10'], 11, 3), null);
  // 一行都没填
  assert.strictEqual(winnerOf(['', ''], ['', ''], 11, 3), null);
});

test('winnerOf —— 已经分出胜负却多录了一局，同样不认', () => {
  // 三局两胜录成 11:9 11:9 11:9：第三局开打前比赛其实已经结束了
  assert.strictEqual(winnerOf(['11', '11', '11'], ['9', '9', '9'], 11, 3), null);
});

/* ============================================================
 * 五、赛制文案与提交入参
 * ============================================================ */

test('formatTextOf —— 合法赛制给文案，非法赛制给空串', () => {
  assert.strictEqual(formatTextOf(11, 3), '11 分制 · 三局两胜');
  assert.strictEqual(formatTextOf(21, 5), '21 分制 · 五局三胜');
  assert.strictEqual(formatTextOf(11, 2), '');
});

test('toSubmitParams —— 日期与时间拼成完整时间串', () => {
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06'],
    teamB: ['u02'],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    date: '2026-09-01',
    time: '18:30',
    location: '学校体育馆 1 号场',
  });

  // 断言写成 round-trip：发出去的串必须与「本地 2026-09-01 18:30」是同一
  // 时刻，且不依赖运行机器的时区（云端 UTC 下这条也应成立）。
  assert.strictEqual(params.matchTime, new Date('2026-09-01T18:30:00').toISOString());
  assert.strictEqual(params.location, '学校体育馆 1 号场');
});

test('toSubmitParams —— 比赛时间是 ISO 绝对串，不是 naive 本地串（C1 云端时区回归）', () => {
  // 云函数容器时区 UTC+0、小程序端 UTC+8：naive 串发上去会被按 UTC 解析，
  // 「刚打完的比赛」被判「不能晚于现在」或落库时刻整体偏移 8 小时。
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06'],
    teamB: ['u02'],
    date: '2026-09-01',
    time: '18:30',
  });

  assert.match(params.matchTime, /(?:Z|[+-]\d{2}:\d{2})$/, '必须带时区标识');
  assert.strictEqual(
    new Date(params.matchTime).getTime(),
    new Date('2026-09-01T18:30:00').getTime(),
    '必须与本地墙上时间是同一绝对时刻',
  );
});

test('toSubmitParams —— 日期或时间没填时比赛时间为空串，交给校验去报错', () => {
  const base = { matchType: MATCH_TYPE.SINGLES, teamA: ['u06'], teamB: ['u02'] };
  assert.strictEqual(toSubmitParams({ ...base, date: '2026-09-01', time: '' }).matchTime, '');
  assert.strictEqual(toSubmitParams({ ...base, date: '', time: '18:30' }).matchTime, '');
});

test('toSubmitParams —— 空选手滤掉，人数不对交给数据层报错', () => {
  // 在表单层悄悄补一个人，等于替用户签了名；宁可让校验说「请选择参赛会员」
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06', ''],
    teamB: [''],
  });

  assert.deepStrictEqual(params.teamA, ['u06']);
  assert.deepStrictEqual(params.teamB, []);
});

test('toSubmitParams —— 绝不带 winner 与 recorder，它们由数据层说了算', () => {
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06'],
    teamB: ['u02'],
    scoreA: ['9', '7'],
    scoreB: ['11', '11'],
    gamePoints: 11,
    bestOf: 3,
    date: '2026-09-01',
    time: '18:30',
    winner: 'A',
    recorder: 'u02',
  });

  assert.strictEqual('winner' in params, false);
  assert.strictEqual('recorder' in params, false);
  // 比分照搬，胜方让 match-record 从它推——这里输入的是 B 队赢
  assert.deepStrictEqual(params.scoreA, ['9', '7']);
  assert.deepStrictEqual(params.scoreB, ['11', '11']);
});

/* ============================================================
 * 六、抽签排定的比赛 → 表单
 * ============================================================ */

/** 一条抽签生成的待确认比赛，字段与 draw.js 的产出一致 */
const SCHEDULED = {
  _id: 'x_e1_r1_main_1',
  eventId: 'e1',
  round: 1,
  stage: 'main',
  slot: 1,
  matchType: MATCH_TYPE.SINGLES,
  teamA: ['u06'],
  teamB: ['u02'],
  gamePoints: 11,
  bestOf: 3,
  winner: null,
  recorder: 'u06',
  matchTime: '2026-05-20T09:30:00',
  location: '学校体育馆 2 号场',
};

test('scheduledForm —— 对阵、赛制、时间、场地全部照抄，一个字都不给改', () => {
  const form = scheduledForm(SCHEDULED);

  assert.strictEqual(form.matchType, MATCH_TYPE.SINGLES);
  assert.deepStrictEqual(form.teamA, ['u06']);
  assert.deepStrictEqual(form.teamB, ['u02']);
  assert.strictEqual(form.gamePoints, 11);
  assert.strictEqual(form.bestOf, 3);
  assert.strictEqual(form.date, '2026-05-20');
  assert.strictEqual(form.time, '09:30', '拿到时分即可，秒交给 picker 不管');
  assert.strictEqual(form.location, '学校体育馆 2 号场');
});

test('scheduledForm —— 比分按局制留空，不把待填的格子填成 0', () => {
  const form = scheduledForm(SCHEDULED);
  assert.deepStrictEqual(form.scoreA, ['', '', '']);
  assert.deepStrictEqual(form.scoreB, ['', '', '']);
});

test('scheduledForm —— 缺字段时退回默认赛制，不抛错', () => {
  const form = scheduledForm({ teamA: ['u06'], teamB: ['u02'] });
  assert.strictEqual(form.bestOf, 3);
  assert.strictEqual(form.gamePoints, 11);
  assert.strictEqual(form.date, '');
  assert.strictEqual(form.time, '');
  assert.deepStrictEqual(form.teamA, ['u06']);
});

test('scheduledForm —— 空记录不抛错，给一份能渲染的空表', () => {
  const form = scheduledForm(null);
  assert.deepStrictEqual(form.teamA, []);
  assert.deepStrictEqual(form.teamB, []);
  assert.strictEqual(form.matchType, MATCH_TYPE.SINGLES);
});

/* ============================================================
 * 七、找人面板的筛选
 * ============================================================ */

const ROSTER = [
  { id: 'u01', name: '巴特尔', realName: '巴特尔' },
  // 昵称只取了真名的一部分：真实姓名「赵明宇」，面板上显示「明宇」
  { id: 'u02', name: '明宇', realName: '赵明宇' },
  { id: 'u03', name: '张伟', realName: '张伟' },
  { id: 'u04', name: 'Leo', realName: '李奥' },
];

test('buildPickerRows —— 空搜索词给出全名单', () => {
  const rows = buildPickerRows(ROSTER, '', '');

  assert.strictEqual(rows.length, ROSTER.length);
  assert.deepStrictEqual(
    rows.map((row) => row.id),
    ['u01', 'u02', 'u03', 'u04']
  );
});

test('buildPickerRows —— 按昵称子串筛选，忽略大小写与首尾空格', () => {
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, '张', '').map((row) => row.id),
    ['u03']
  );
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, ' le ', '').map((row) => row.id),
    ['u04'],
    '搜 le 应当能命中 Leo'
  );
  assert.deepStrictEqual(buildPickerRows(ROSTER, '王', ''), []);
});

test('buildPickerRows —— 真实姓名同样能命中（昵称只是真名的一部分时）', () => {
  // 昵称「明宇」、真名「赵明宇」：输入「赵」必须能找到这个人，
  // 而面板上显示的名字仍然是昵称「明宇」。
  const byReal = buildPickerRows(ROSTER, '赵', '');
  assert.deepStrictEqual(byReal.map((row) => row.id), ['u02']);
  assert.strictEqual(byReal[0].name, '明宇', '命中后显示的仍是昵称');

  // 昵称与真名都能各自命中同一个人，且只出现一行
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, '明宇', '').map((row) => row.id),
    ['u02']
  );
  // 真名的其他部分（如「奥」）也照常命中
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, '奥', '').map((row) => row.id),
    ['u04']
  );
});

test('buildPickerRows —— 名单里没有 realName 字段时退回只按昵称匹配', () => {
  const bare = [{ id: 'u01', name: '张三' }];
  assert.deepStrictEqual(buildPickerRows(bare, '张', '').map((row) => row.id), ['u01']);
  assert.deepStrictEqual(buildPickerRows(bare, '李', ''), []);
});

test('buildPickerRows —— 给每行配首字，并标记这一格当前选中的人', () => {
  const rows = buildPickerRows(ROSTER, '', 'u03');

  assert.strictEqual(rows[0].avatarText, '巴');
  const picked = rows.find((row) => row.id === 'u03');
  assert.strictEqual(picked.selected, true);
  assert.strictEqual(rows.filter((row) => row.selected).length, 1, '只该有一个人被打勾');
});

test('buildPickerRows —— 选中的人被搜掉时不抛错，非数组当空名单', () => {
  const rows = buildPickerRows(ROSTER, '张', 'u04');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows.some((row) => row.selected), false, 'u04 没被搜出来，自然没有打勾的行');
  assert.deepStrictEqual(buildPickerRows(null, '张', ''), []);
});

test('pickerEmptyText —— 有搜索词时把词写进提示，没有时给通用那句', () => {
  assert.strictEqual(pickerEmptyText('王'), '没有名字含「王」的会员');
  assert.strictEqual(pickerEmptyText('  王 '), '没有名字含「王」的会员');
  assert.strictEqual(pickerEmptyText(''), '还没有可选的会员');
  assert.strictEqual(pickerEmptyText(null), '还没有可选的会员');
});

test('buildPickerRows —— 不传交手场次时每行都是 0，与从前一样', () => {
  const rows = buildPickerRows(ROSTER, '', '');

  assert.deepStrictEqual(
    rows.map((row) => row.pairCount),
    [0, 0, 0, 0],
    '没传就当作一场没打过，不凭空编数字'
  );
  assert.ok(rows.every((row) => row.pairFull === false), '没满额就不该标红');
});

test('buildPickerRows —— 打过的挂上场次，没打过的不挂', () => {
  const rows = buildPickerRows(ROSTER, '', '', {
    counts: { u01: 3, u03: 15 },
    limit: 15,
  });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.strictEqual(byId.u01.pairCount, 3);
  assert.strictEqual(byId.u01.pairFull, false);
  assert.strictEqual(byId.u02.pairCount, 0, '一场没打过就是 0，模板据此不渲染徽标');
  assert.strictEqual(byId.u02.pairFull, false);
});

test('buildPickerRows —— 打满上限的那一行标成满额，好先劝住用户', () => {
  const rows = buildPickerRows(ROSTER, '', '', { counts: { u03: 15 }, limit: 15 });
  const full = rows.find((row) => row.id === 'u03');

  assert.strictEqual(full.pairCount, 15);
  assert.strictEqual(full.pairFull, true, '满了就该标红——选了他也提交不上去');
});

test('buildPickerRows —— 超限的历史数据照样标满额', () => {
  // 历史导入或规则生效前录下的场次会超过上限，如实显示 18，不截到 15
  const rows = buildPickerRows(ROSTER, '', '', { counts: { u03: 18 }, limit: 15 });
  const row = rows.find((item) => item.id === 'u03');

  assert.strictEqual(row.pairCount, 18);
  assert.strictEqual(row.pairFull, true);
});

test('buildPickerRows —— 上限缺失或不可用时绝不误标满额', () => {
  // 没有入场次表：一场没打过
  const none = buildPickerRows(ROSTER, '', '', null).find((item) => item.id === 'u03');
  assert.strictEqual(none.pairCount, 0);
  assert.strictEqual(none.pairFull, false);

  for (const pairInfo of [{ counts: { u03: 15 } }, { counts: { u03: 15 }, limit: 0 }]) {
    const row = buildPickerRows(ROSTER, '', '', pairInfo).find((item) => item.id === 'u03');
    assert.strictEqual(row.pairCount, 15);
    assert.strictEqual(row.pairFull, false, '连上限都不知道，就不能说人家打满了');
  }
});

test('buildPickerRows —— 场次表里的杂数据不会污染行', () => {
  // 编号对不上的人（比如已离校的）不会凭空多出一行；坏数字当作没打过
  const rows = buildPickerRows(ROSTER, '', '', {
    counts: { u01: 'x', u02: null, ghost: 5 },
    limit: 15,
  });

  assert.strictEqual(rows.length, ROSTER.length);
  assert.strictEqual(rows.find((row) => row.id === 'u01').pairCount, 0);
  assert.strictEqual(rows.find((row) => row.id === 'u02').pairCount, 0);
  assert.ok(!rows.some((row) => row.id === 'ghost'));
});

test('buildPickerRows —— 交手场次跟着搜索筛选走，不会串到别人身上', () => {
  const rows = buildPickerRows(ROSTER, '张', '', { counts: { u03: 7 }, limit: 15 });

  assert.deepStrictEqual(rows.map((row) => row.id), ['u03']);
  assert.strictEqual(rows[0].pairCount, 7);
});

/* ============================================================
 * 九、网球协会的录入表单
 * ============================================================
 * 网球是全站唯一走「分 → 局 → 盘」三层计分的协会，录入页因此有三处不同：
 * 选项表换成盘制 + 每盘局数（没有再多的分制）、比分格子叫「盘」、
 * 提交时带的是 setGames/tiebreakAt/noAd 这组字段而不是 gamePoints。
 * 这三处任一处漏了，6 局盘里的 6:4 就会被按「11 分制的一局」解读。
 * ============================================================ */

test('formatOptionsOf —— 网球给的是盘制 + 每盘局数，一个分制选项都不给', () => {
  const options = formatOptionsOf('tn');

  assert.strictEqual(options.scoring, 'tennis');
  assert.deepStrictEqual(options.bestOfOptions, [1, 3]);
  assert.deepStrictEqual(options.bestOfLabels, ['一盘决胜', '三盘两胜']);
  assert.deepStrictEqual(options.setGamesOptions, [6, 4]);
  assert.deepStrictEqual(options.setGamesLabels, ['6 局（标准盘）', '4 局（短盘）']);
  assert.deepStrictEqual(options.gamePointsOptions, [], '网球没有「11/15/21 分制」可选');
  assert.deepStrictEqual(options.gamePointsLabels, []);
  assert.strictEqual(options.noAd, false, '默认带占先');
  assert.strictEqual(options.defaultFormat.setGames, 6);
  assert.strictEqual(options.defaultFormat.tiebreakAt, 6);
});

test('formatOptionsOf —— 非网球协会照旧是分制 + 局制，且没有网球选项', () => {
  const options = formatOptionsOf('bd');

  assert.strictEqual(options.scoring, 'point');
  assert.deepStrictEqual(options.bestOfOptions, BEST_OF_OPTIONS);
  assert.deepStrictEqual(options.gamePointsOptions, GAME_POINTS_OPTIONS);
  assert.deepStrictEqual(options.setGamesOptions, []);
  assert.strictEqual(options.noAd, false);

  // 未知 / 空协会也不能炸，退回匹克球口径
  ['', 'nope', undefined, null].forEach((id) => {
    const fallback = formatOptionsOf(id);
    assert.strictEqual(fallback.scoring, 'point');
    assert.deepStrictEqual(fallback.gamePointsOptions, GAME_POINTS_OPTIONS);
  });
});

test('createForm —— 网球按盘建比分格子，赛制字段随表单走', () => {
  const options = formatOptionsOf('tn');
  const form = createForm(ME, options);

  // 默认一盘决胜 → 只留一行；这一行是一盘的局分，不是三局的分
  assert.strictEqual(form.scoreA.length, 1);
  assert.strictEqual(form.scoreB.length, 1);
  assert.strictEqual(form.scoring, 'tennis');
  assert.strictEqual(form.bestOf, 1);
  assert.strictEqual(form.setGames, 6);
  assert.strictEqual(form.tiebreakAt, 6);
  assert.strictEqual(form.tiebreakPoints, 7);
  assert.strictEqual(form.noAd, false);
  assert.strictEqual(form.gamePoints, undefined, '网球表单不该带 gamePoints');

  // 三盘两胜就三行
  const bestOf3 = createForm(ME, {
    ...options,
    defaultFormat: { ...options.defaultFormat, bestOf: 3 },
  });
  assert.strictEqual(bestOf3.scoreA.length, 3);

  // 短盘 + 无占先一并带出来
  const shortForm = createForm(ME, {
    ...options,
    defaultFormat: { ...options.defaultFormat, setGames: 4, tiebreakAt: 4, noAd: true },
  });
  assert.strictEqual(shortForm.setGames, 4);
  assert.strictEqual(shortForm.tiebreakAt, 4);
  assert.strictEqual(shortForm.noAd, true);
});

test('scheduledForm —— 抽签排定的网球记录整块照抄赛制，不掺 gamePoints', () => {
  const form = scheduledForm({
    _id: 'm01',
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01'],
    teamB: ['u02'],
    scoring: 'tennis',
    bestOf: 1,
    setGames: 4,
    tiebreakAt: 4,
    tiebreakPoints: 7,
    noAd: true,
    matchTime: '2026-05-20T10:00:00',
    location: '网球场 1 号',
  });

  assert.strictEqual(form.scoring, 'tennis');
  assert.strictEqual(form.setGames, 4);
  assert.strictEqual(form.tiebreakAt, 4);
  assert.strictEqual(form.noAd, true);
  assert.strictEqual(form.gamePoints, undefined);
  assert.strictEqual(form.scoreA.length, 1, '一盘决胜只要一行');
  assert.strictEqual(form.location, '网球场 1 号');
});

test('winnerOf / formatTextOf —— 网球按盘判胜负，文案带盘制与每盘局数', () => {
  const format = { scoring: 'tennis', bestOf: 3, setGames: 6, tiebreakAt: 6, tiebreakPoints: 7, noAd: false };

  assert.strictEqual(winnerOf([6, 4, 6], [4, 6, 3], format), 'A');
  assert.strictEqual(winnerOf([4, 6, 3], [6, 4, 6], format), 'B');
  assert.strictEqual(winnerOf([6, 4], [4, 6], format), null, '才 1:1，还没分出胜负');
  assert.strictEqual(winnerOf([6], [5], format), null, '6:5 不是合法的盘比分');

  assert.strictEqual(formatTextOf(format), '三盘两胜 · 每盘 6 局（6:6 抢七）');
  assert.strictEqual(
    formatTextOf({ ...format, bestOf: 1, setGames: 4, tiebreakAt: 4, noAd: true }),
    '一盘决胜 · 每盘 4 局短盘（4:4 抢七） · 无占先'
  );
  // 老写法（分制 + 局制）照旧能用
  assert.strictEqual(formatTextOf(11, 3), '11 分制 · 三局两胜');
});

test('scoreUnitLabelOf / toSubmitParams —— 提交的是网球赛制字段，不是分制', () => {
  assert.strictEqual(scoreUnitLabelOf({ scoring: 'tennis', setGames: 6 }), '盘');
  assert.strictEqual(scoreUnitLabelOf({ gamePoints: 11, bestOf: 3 }), '局');

  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01', ''],
    teamB: ['u02'],
    scoreA: ['6', '7'],
    scoreB: ['4', '6'],
    scoring: 'tennis',
    bestOf: 3,
    setGames: 6,
    tiebreakAt: 6,
    tiebreakPoints: 7,
    noAd: false,
    date: '2026-05-20',
    time: '10:00',
    location: '网球场 1 号',
  });

  assert.deepStrictEqual(params.teamA, ['u01'], '空选手照旧滤掉');
  assert.strictEqual(params.scoring, 'tennis');
  assert.strictEqual(params.setGames, 6);
  assert.strictEqual(params.tiebreakAt, 6);
  assert.strictEqual(params.noAd, false);
  assert.strictEqual(params.gamePoints, undefined);
  assert.strictEqual(params.winner, undefined, '胜方由数据层从比分推');
});
