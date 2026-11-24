/**
 * 学院赛发布规则的纯逻辑自检
 * ============================================================
 * 学院赛与个人赛并行，发布口径自成一套，所以每条边界都用字面量钉死：
 *
 *   1. 发布权 —— 只有管理员；学院负责人、会员、访客、被禁用的管理员都不行。
 *   2. 小项序列 —— 至少一项、都在项目池内、上限之内；同名可重复。
 *   3. 人数区间 —— 单项落在硬边界内，且「最少 ≤ 最多」两道都要过。
 *   4. 算法与口径 —— 选「先到 N 场胜」时净胜口径无意义，落库留 null。
 *   5. 行数据的预计算布尔量 —— 模板不写业务逻辑。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  LEG_PLAN_MIN,
  LEG_PLAN_MAX,
  canManageCollegeEvent,
  normalizeDraft,
  validateCollegeEvent,
  buildCollegeEventRecord,
  statusLabelOf,
  tieAlgoLabelOf,
  tieNetModeLabelOf,
  legPlanTextOf,
  rosterRangeTextOf,
  buildCollegeEventRow,
  canFinishCollegeEvent,
  validateCollegePlacements,
  buildCollegeResultRows,
} = require('../src/shared/services/college-event.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  TIE_ALGO,
  TIE_NET_MODE,
  ROSTER_LIMITS,
} = require('../src/shared/utils/constants.js');

/** 一位管理员 */
const ADMIN = { _id: 'u01', nickName: '巴特尔', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };
/** 一位学院负责人 */
const STAFF = {
  _id: 'u02',
  nickName: '张宇轩',
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  college: '体育学院',
};
/** 一位普通会员 */
const MEMBER = { _id: 'u03', nickName: '李明', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 一份合法草稿；各用例在其上改一处 */
function draft(overrides = {}) {
  return {
    title: '2026 学院杯',
    description: '各学院组队参加',
    legPlan: ['MS', 'WS', 'MD'],
    allowMultiEntry: true,
    rosterMin: 4,
    rosterMax: 20,
    courtCount: 4,
    tieAlgo: TIE_ALGO.FULL_POINTS,
    tieNetMode: TIE_NET_MODE.WIN_DIFF,
    location: '学校体育馆',
    startTime: '2026-10-01T09:00:00',
    ...overrides,
  };
}

/* ============================================================
 * 一、发布权
 * ============================================================ */

test('canManageCollegeEvent —— 只有管理员能发布学院赛', () => {
  assert.strictEqual(canManageCollegeEvent(ADMIN), true);
  assert.strictEqual(canManageCollegeEvent(STAFF), false);
  assert.strictEqual(canManageCollegeEvent(MEMBER), false);
  assert.strictEqual(canManageCollegeEvent(null), false);
});

test('canManageCollegeEvent —— 被禁用的管理员同样没有发布权', () => {
  const banned = { ...ADMIN, status: USER_STATUS.DISABLED };
  assert.strictEqual(canManageCollegeEvent(banned), false);
});

test('canManageCollegeEvent —— 与数据源无关，本地也不放宽', () => {
  assert.strictEqual(canManageCollegeEvent(MEMBER, { isMock: true }), false);
});

/* ============================================================
 * 二、表单校验
 * ============================================================ */

test('validateCollegeEvent —— 一份合法草稿全部通过', () => {
  const result = validateCollegeEvent(draft());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.firstError, '');
  assert.deepStrictEqual(result.errors, {});
});

test('validateCollegeEvent —— 名称长度为 2~30', () => {
  assert.match(validateCollegeEvent(draft({ title: '赛' })).errors.title, /2~30/);
  assert.match(validateCollegeEvent(draft({ title: '甲'.repeat(31) })).errors.title, /2~30/);
});

test('validateCollegeEvent —— 小项序列不能为空、不能越池、不能超上限', () => {
  assert.match(validateCollegeEvent(draft({ legPlan: [] })).errors.legPlan, /至少/);
  assert.match(validateCollegeEvent(draft({ legPlan: ['MS', 'XX'] })).errors.legPlan, /男单/);
  const tooMany = new Array(LEG_PLAN_MAX + 1).fill('MS');
  assert.match(validateCollegeEvent(draft({ legPlan: tooMany })).errors.legPlan, /最多/);
});

test('validateCollegeEvent —— 同名小项可以重复出现（D19）', () => {
  const result = validateCollegeEvent(draft({ legPlan: ['MS', 'MS', 'WD'] }));
  assert.strictEqual(result.ok, true);
});

test('validateCollegeEvent —— 小项序列下限就是 1', () => {
  assert.strictEqual(LEG_PLAN_MIN, 1);
  assert.strictEqual(validateCollegeEvent(draft({ legPlan: ['MS'] })).ok, true);
});

test('validateCollegeEvent —— 人数上下限各有一道硬边界', () => {
  assert.match(validateCollegeEvent(draft({ rosterMin: 0 })).errors.rosterMin, /整数/);
  assert.match(
    validateCollegeEvent(draft({ rosterMax: ROSTER_LIMITS.MAX + 1 })).errors.rosterMax,
    /整数/
  );
  // 小数按与个人赛 quota 相同的口径截断取整，不报错、也不留在记录里
  const truncated = validateCollegeEvent(draft({ rosterMin: 4.5 }));
  assert.strictEqual(truncated.ok, true);
  assert.strictEqual(truncated.draft.rosterMin, 4);
  // 非数字则报错
  assert.match(validateCollegeEvent(draft({ rosterMin: '四' })).errors.rosterMin, /整数/);
});

test('validateCollegeEvent —— 最少人数不能大于最多人数', () => {
  const result = validateCollegeEvent(draft({ rosterMin: 10, rosterMax: 8 }));
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.rosterMax, /不能小于/);
});

test('validateCollegeEvent —— 人数留空取默认 4–20', () => {
  const result = validateCollegeEvent(draft({ rosterMin: '', rosterMax: undefined }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.draft.rosterMin, ROSTER_LIMITS.DEFAULT_MIN);
  assert.strictEqual(result.draft.rosterMax, ROSTER_LIMITS.DEFAULT_MAX);
});

test('validateCollegeEvent —— 未知算法被挡住', () => {
  const result = validateCollegeEvent(draft({ tieAlgo: 'coin' }));
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.tieAlgo, /算法/);
});

test('validateCollegeEvent —— 选「先到 N 场胜」时不要求净胜口径', () => {
  const result = validateCollegeEvent(draft({ tieAlgo: TIE_ALGO.FIRST_TO_N, tieNetMode: '' }));
  assert.strictEqual(result.ok, true);
});

test('validateCollegeEvent —— 选「打满比净胜」时净胜口径必须合法', () => {
  const result = validateCollegeEvent(
    draft({ tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: 'magic' })
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.tieNetMode, /净胜口径/);
});

test('validateCollegeEvent —— 时间与场地沿用个人赛口径', () => {
  assert.match(validateCollegeEvent(draft({ startTime: '' })).errors.startTime, /时间/);
  assert.match(validateCollegeEvent(draft({ location: '甲'.repeat(41) })).errors.location, /40/);
});

test('validateCollegeEvent —— 第一条错误按表单顺序取', () => {
  const result = validateCollegeEvent(draft({ title: '', legPlan: [] }));
  assert.match(result.firstError, /赛事名称/);
});

/* ============================================================
 * 三、装配记录
 * ============================================================ */

test('buildCollegeEventRecord —— 落库记录带齐发布信息与占位字段', () => {
  const now = new Date('2026-09-12T10:00:00');
  const result = buildCollegeEventRecord(draft(), { actor: ADMIN, now });

  assert.strictEqual(result.ok, true);
  const record = result.record;
  assert.strictEqual(record.title, '2026 学院杯');
  assert.deepStrictEqual(record.legPlan, ['MS', 'WS', 'MD']);
  assert.strictEqual(record.status, COLLEGE_EVENT_STATUS.SIGNUP);
  assert.strictEqual(record.publishTime, now);
  assert.strictEqual(record.publisherId, 'u01');
  assert.strictEqual(record.publisherName, '巴特尔');
  // 抽签与名次的占位，读的时候不必判 undefined
  assert.deepStrictEqual(record.currentRound, 0);
  assert.deepStrictEqual(record.seedColleges, []);
  assert.deepStrictEqual(record.results, []);
});

test('buildCollegeEventRecord —— 选「先到 N 场胜」时净胜口径落 null', () => {
  const result = buildCollegeEventRecord(draft({ tieAlgo: TIE_ALGO.FIRST_TO_N }));
  assert.strictEqual(result.record.tieNetMode, null);
});

test('buildCollegeEventRecord —— 校验不过时不产出记录', () => {
  const result = buildCollegeEventRecord(draft({ title: '' }), { actor: ADMIN });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.record, null);
  assert.ok(result.firstError);
});

test('buildCollegeEventRecord —— 没有发布人时不落 undefined', () => {
  const result = buildCollegeEventRecord(draft(), {});
  assert.strictEqual(result.record.publisherId, '');
  assert.strictEqual(result.record.publisherName, '');
});

test('normalizeDraft —— 非数组小项当没填，开关兼容字符串', () => {
  const result = normalizeDraft({ legPlan: 'MS', allowMultiEntry: 'false' });
  assert.deepStrictEqual(result.legPlan, []);
  assert.strictEqual(result.allowMultiEntry, false);
});

/* ============================================================
 * 四、文案与列表行
 * ============================================================ */

test('statusLabelOf —— 四种状态各有各的说法', () => {
  assert.strictEqual(statusLabelOf({ status: COLLEGE_EVENT_STATUS.SIGNUP }), '报名中');
  assert.strictEqual(statusLabelOf({ status: COLLEGE_EVENT_STATUS.READY }), '待开赛');
  assert.strictEqual(statusLabelOf({ status: COLLEGE_EVENT_STATUS.ONGOING }), '进行中');
  assert.strictEqual(statusLabelOf({ status: COLLEGE_EVENT_STATUS.FINISHED }), '已结束');
  assert.strictEqual(statusLabelOf({ status: 99 }), '未知状态');
  assert.strictEqual(statusLabelOf(null), '');
});

test('tieNetModeLabelOf —— 先到 N 场胜时不给净胜口径文案', () => {
  assert.strictEqual(
    tieNetModeLabelOf({ tieAlgo: TIE_ALGO.FIRST_TO_N, tieNetMode: TIE_NET_MODE.WIN_DIFF }),
    ''
  );
  assert.strictEqual(
    tieNetModeLabelOf({ tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.POINT_DIFF }),
    '累计局分净胜'
  );
});

test('legPlanTextOf / rosterRangeTextOf —— 缺字段时给安全缺省', () => {
  assert.strictEqual(legPlanTextOf({ legPlan: ['MS', 'XD'] }), '男单 · 混双');
  assert.strictEqual(legPlanTextOf(null), '');
  assert.strictEqual(rosterRangeTextOf({ rosterMin: 6, rosterMax: 12 }), '6–12 人');
  assert.strictEqual(
    rosterRangeTextOf({}),
    `${ROSTER_LIMITS.DEFAULT_MIN}–${ROSTER_LIMITS.DEFAULT_MAX} 人`
  );
});

test('buildCollegeEventRow —— 管理员那一行带 canManage，会员没有', () => {
  const event = { _id: 'ce01', ...buildCollegeEventRecord(draft(), { actor: ADMIN }).record };

  const asAdmin = buildCollegeEventRow(event, { actor: ADMIN });
  assert.strictEqual(asAdmin.eventId, 'ce01');
  assert.strictEqual(asAdmin.isSignup, true);
  assert.strictEqual(asAdmin.legCount, 3);
  assert.strictEqual(asAdmin.canManage, true);

  const asMember = buildCollegeEventRow(event, { actor: MEMBER });
  assert.strictEqual(asMember.canManage, false);
});

test('buildCollegeEventRow —— 缺字段不渲染 undefined', () => {
  const row = buildCollegeEventRow({}, {});
  assert.strictEqual(row.title, '');
  assert.strictEqual(row.legPlanText, '');
  assert.strictEqual(row.tieAlgoLabel, '打满比净胜');
  assert.strictEqual(row.canManage, false);
});

test('tieAlgoLabelOf —— 缺字段按默认打满比净胜', () => {
  assert.strictEqual(tieAlgoLabelOf({}), '打满比净胜');
  assert.strictEqual(tieAlgoLabelOf({ tieAlgo: TIE_ALGO.FIRST_TO_N }), '先到 N 场胜');
  assert.strictEqual(tieAlgoLabelOf(null), '');
});

/* ============================================================
 * 五、名次录入与结束（M5-1）
 * ============================================================ */

test('canFinishCollegeEvent —— 只有管理员且赛事进行中才可录名次', () => {
  const ongoing = { status: COLLEGE_EVENT_STATUS.ONGOING };
  assert.strictEqual(canFinishCollegeEvent(ongoing, ADMIN), true);
  assert.strictEqual(canFinishCollegeEvent(ongoing, STAFF), false);
  assert.strictEqual(canFinishCollegeEvent(ongoing, MEMBER), false);
  assert.strictEqual(canFinishCollegeEvent(ongoing, null), false);

  assert.strictEqual(
    canFinishCollegeEvent({ status: COLLEGE_EVENT_STATUS.SIGNUP }, ADMIN),
    false,
    '报名中还没有任何大场结果'
  );
  assert.strictEqual(
    canFinishCollegeEvent({ status: COLLEGE_EVENT_STATUS.FINISHED }, ADMIN),
    false,
    '已结束的赛事不能再录'
  );
  assert.strictEqual(canFinishCollegeEvent(null, ADMIN), false);
});

test('validateCollegePlacements —— 合法名单通过并规范化', () => {
  const result = validateCollegePlacements([
    { college: '体育学院', placement: '1' },
    { college: '经济学院', placement: 2 },
    { college: '管理学院', placement: 3 },
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.firstError, '');
  assert.deepStrictEqual(result.results, [
    { college: '体育学院', placement: 1 },
    { college: '经济学院', placement: 2 },
    { college: '管理学院', placement: 3 },
  ]);
});

test('validateCollegePlacements —— 空名单、缺学院、非正整数都被挡住', () => {
  assert.match(validateCollegePlacements([]).firstError, /请录入/);
  assert.match(validateCollegePlacements([{ college: '', placement: 1 }]).firstError, /名次/);
  assert.match(validateCollegePlacements([{ college: '体育学院', placement: 1.5 }]).firstError, /整数/);
  assert.match(validateCollegePlacements([{ college: '体育学院', placement: 0 }]).firstError, /名次/);
});

test('validateCollegePlacements —— 每所学院只能记一次', () => {
  const result = validateCollegePlacements([
    { college: '体育学院', placement: 1 },
    { college: '体育学院', placement: 2 },
  ]);
  assert.strictEqual(result.ok, false);
  assert.match(result.firstError, /每院只记一次/);
});

test('validateCollegePlacements —— 冠军有且只有一位', () => {
  const none = validateCollegePlacements([
    { college: '体育学院', placement: 2 },
    { college: '经济学院', placement: 3 },
  ]);
  assert.strictEqual(none.ok, false);
  assert.match(none.firstError, /冠军/);

  const two = validateCollegePlacements([
    { college: '体育学院', placement: 1 },
    { college: '经济学院', placement: 1 },
  ]);
  assert.strictEqual(two.ok, false);
  assert.match(two.firstError, /冠军/);
});

test('validateCollegePlacements —— 传入参赛学院名单时，外人被挡住', () => {
  // 越界的学院直接拒下，不留到落库后才发现
  const result = validateCollegePlacements(
    [
      { college: '体育学院', placement: 1 },
      { college: '哲学学院', placement: 2 },
    ],
    { colleges: ['体育学院', '经济学院'] }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.firstError, /参赛学院/);

  // 都在名单内则放行
  const good = validateCollegePlacements(
    [
      { college: '体育学院', placement: 1 },
      { college: '经济学院', placement: 2 },
    ],
    { colleges: ['体育学院', '经济学院'] }
  );
  assert.strictEqual(good.ok, true);
});

test('buildCollegeResultRows —— 按名次排序并把数字翻成文案', () => {
  const rows = buildCollegeResultRows({
    results: [
      { college: '管理学院', placement: 3 },
      { college: '体育学院', placement: 1 },
      { college: '经济学院', placement: 2 },
    ],
  });
  assert.deepStrictEqual(
    rows.map((row) => [row.college, row.placementText]),
    [
      ['体育学院', '冠军'],
      ['经济学院', '亚军'],
      ['管理学院', '四强'],
    ]
  );
  assert.deepStrictEqual(buildCollegeResultRows({}), []);
  assert.deepStrictEqual(buildCollegeResultRows(null), []);
});
