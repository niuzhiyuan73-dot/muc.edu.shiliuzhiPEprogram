/**
 * 学院赛抽签规则的纯逻辑自检
 * ============================================================
 * 抽签一次定下整场赛事的对阵结构，且抽签即锁定名单（D13），是学院赛里
 * 后果最重的一步。每条边界都用字面量钉死：
 *
 *   1. 抽签权 —— 仅管理员，且只在报名中；
 *   2. 谁能进签表 —— 只收已通过的名单（D11），去重、排序、去空白；
 *   3. 种子 —— 手工指定（D17），必须来自参赛学院且不重复；
 *   4. 落位 —— 同一个 seedValue 必须复现同一张签表（可复核）；
 *   5. 落库形状与确定性主键。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  canDrawCollegeEvent,
  approvedCollegesOf,
  validateCollegeDraw,
  planCollegeDraw,
  buildCollegeDrawRecord,
  collegeTieKey,
} = require('../src/shared/services/college-draw.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  BRACKET_STAGE,
} = require('../src/shared/utils/constants.js');

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

/** 一场正在报名的学院赛 */
function event(overrides = {}) {
  return {
    _id: 'ce01',
    title: '2026 学院杯',
    legPlan: ['MS', 'WS', 'MD'],
    status: COLLEGE_EVENT_STATUS.SIGNUP,
    ...overrides,
  };
}

/** 一份名单记录 */
function entry(college, status = COLLEGE_ENTRY_STATUS.APPROVED) {
  return { _id: `cen_${college}`, eventId: 'ce01', college, status };
}

/** 四所已通过审核的学院 */
const FOUR = [
  entry('体育学院'),
  entry('信息工程学院'),
  entry('经济学院'),
  entry('管理学院'),
];

/* ============================================================
 * 一、抽签权
 * ============================================================ */

test('canDrawCollegeEvent —— 只有管理员能在报名中抽签', () => {
  assert.strictEqual(canDrawCollegeEvent(event(), ADMIN), true);
  assert.strictEqual(canDrawCollegeEvent(event(), STAFF), false);
  assert.strictEqual(canDrawCollegeEvent(event(), MEMBER), false);
  assert.strictEqual(canDrawCollegeEvent(event(), null), false);
});

test('canDrawCollegeEvent —— 已抽签之后不能再抽', () => {
  for (const status of [
    COLLEGE_EVENT_STATUS.READY,
    COLLEGE_EVENT_STATUS.ONGOING,
    COLLEGE_EVENT_STATUS.FINISHED,
  ]) {
    assert.strictEqual(canDrawCollegeEvent(event({ status }), ADMIN), false, `status=${status}`);
  }
});

/* ============================================================
 * 二、谁能进签表
 * ============================================================ */

test('approvedCollegesOf —— 只收已通过，待审与退回都不进签表', () => {
  const entries = [
    entry('体育学院', COLLEGE_ENTRY_STATUS.APPROVED),
    entry('信息工程学院', COLLEGE_ENTRY_STATUS.PENDING),
    entry('经济学院', COLLEGE_ENTRY_STATUS.RETURNED),
    entry('管理学院', COLLEGE_ENTRY_STATUS.APPROVED),
  ];
  assert.deepStrictEqual(approvedCollegesOf(entries), ['体育学院', '管理学院']);
});

test('approvedCollegesOf —— 去重、去空白并按全名排序', () => {
  const entries = [
    entry(' 信息工程学院 '),
    entry('经济学院'),
    entry('信息工程学院'),
    entry(''),
    entry('管理学院'),
  ];
  assert.deepStrictEqual(approvedCollegesOf(entries), [
    '信息工程学院',
    '管理学院',
    '经济学院',
  ]);
});

test('approvedCollegesOf —— 空输入给空数组，不抛错', () => {
  assert.deepStrictEqual(approvedCollegesOf(null), []);
  assert.deepStrictEqual(approvedCollegesOf([]), []);
});

/* ============================================================
 * 三、抽签校验
 * ============================================================ */

test('validateCollegeDraw —— 找不到赛事 / 不是管理员 / 不在报名中都挡住', () => {
  assert.match(
    validateCollegeDraw({ event: null, actor: ADMIN, entries: FOUR }).message,
    /找不到/
  );
  assert.match(
    validateCollegeDraw({ event: event(), actor: STAFF, entries: FOUR }).message,
    /管理员/
  );
  assert.match(
    validateCollegeDraw({
      event: event({ status: COLLEGE_EVENT_STATUS.READY }),
      actor: ADMIN,
      entries: FOUR,
    }).message,
    /报名阶段/
  );
});

test('validateCollegeDraw —— 不足两个学院不能抽签', () => {
  const result = validateCollegeDraw({
    event: event(),
    actor: ADMIN,
    entries: [entry('体育学院')],
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不足 2 个/);
  assert.deepStrictEqual(result.colleges, ['体育学院']);
});

test('validateCollegeDraw —— 种子必须是参赛学院之一', () => {
  const result = validateCollegeDraw({
    event: event(),
    actor: ADMIN,
    entries: FOUR,
    seedColleges: ['霍格沃茨'],
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /已通过审核的学院/);
});

test('validateCollegeDraw —— 种子不能重复', () => {
  const result = validateCollegeDraw({
    event: event(),
    actor: ADMIN,
    entries: FOUR,
    seedColleges: ['体育学院', '体育学院'],
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不能重复/);
});

test('validateCollegeDraw —— 合法种子按点击顺序保留', () => {
  const result = validateCollegeDraw({
    event: event(),
    actor: ADMIN,
    entries: FOUR,
    seedColleges: ['管理学院', '体育学院'],
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.seeds, ['管理学院', '体育学院']);
  // 学院名单本身按全名排序（默认字典序），与种子顺序无关
  assert.deepStrictEqual(result.colleges, ['体育学院', '信息工程学院', '管理学院', '经济学院']);
});

/* ============================================================
 * 四、落位
 * ============================================================ */

test('planCollegeDraw —— 缺少随机种子值时明确失败', () => {
  const plan = planCollegeDraw({ event: event(), actor: ADMIN, entries: FOUR });
  assert.strictEqual(plan.ok, false);
  assert.match(plan.message, /随机种子值/);
});

test('planCollegeDraw —— 四个学院补齐到 4 个签位，无轮空', () => {
  const plan = planCollegeDraw({ event: event(), actor: ADMIN, entries: FOUR, seedValue: 7 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.size, 4);
  assert.strictEqual(plan.slots.length, 4);
  assert.deepStrictEqual(plan.byes, []);
  // 参赛学院一个不多一个不少，且没有 null
  assert.deepStrictEqual([...plan.slots].sort(), [...plan.colleges].sort());
});

test('planCollegeDraw —— 三个学院补齐到 4 个签位，多出的位置是轮空', () => {
  const entries = FOUR.slice(0, 3);
  const plan = planCollegeDraw({ event: event(), actor: ADMIN, entries, seedValue: 11 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.size, 4);
  assert.strictEqual(plan.byes.length, 1);
  // 恰好一个 null 签位
  assert.strictEqual(plan.slots.filter((slot) => slot === null).length, 1);
});

test('planCollegeDraw —— 同一个 seedValue 复现同一张签表', () => {
  const a = planCollegeDraw({ event: event(), actor: ADMIN, entries: FOUR, seedValue: 20260912 });
  const b = planCollegeDraw({ event: event(), actor: ADMIN, entries: FOUR, seedValue: 20260912 });
  assert.deepStrictEqual(a.slots, b.slots);
  assert.strictEqual(a.seedValue, 20260912);
});

test('buildCollegeDrawRecord —— 落库记录带随机种子值、时间与操作人', () => {
  const plan = planCollegeDraw({ event: event(), actor: ADMIN, entries: FOUR, seedValue: 7 });
  const drawnAt = new Date('2026-09-12T10:00:00');
  const record = buildCollegeDrawRecord(plan, { drawnAt, drawnBy: 'u01' });

  assert.strictEqual(record.seedValue, 7);
  assert.strictEqual(record.drawnBy, 'u01');
  assert.strictEqual(record.drawnAt.getTime(), drawnAt.getTime());
  assert.strictEqual(record.size, 4);
  assert.strictEqual(record.slots.length, 4);
  assert.deepStrictEqual(record.byes, []);
});

/* ============================================================
 * 五、确定性主键
 * ============================================================ */

test('collegeTieKey —— 签位唯一确定一场大场，默认单败阶段', () => {
  assert.strictEqual(collegeTieKey('ce01', 1, 0), `t_ce01_1_${BRACKET_STAGE.MAIN}_0`);
  assert.strictEqual(collegeTieKey('ce01', 2, 3), `t_ce01_2_${BRACKET_STAGE.MAIN}_3`);
  // 位置不变、坐在位置上的学院才变：同一个位置重抽也还是同一个键
  assert.strictEqual(collegeTieKey('ce01', 1, 0), collegeTieKey('ce01', 1, 0));
});
