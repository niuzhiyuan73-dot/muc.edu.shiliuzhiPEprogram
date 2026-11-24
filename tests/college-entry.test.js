/**
 * 学院赛名单规则的纯逻辑自检
 * ============================================================
 * 名单决定「谁能代表这个学院上场」，是学院赛里权限最敏感的一处，所以
 * 每条边界都用字面量钉死：
 *
 *   1. 提交权 —— 学院负责人限本学院，管理员通行，会员与他院学院负责人都不行；
 *      名单锁定（已抽签）后一律不可提交。
 *   2. 名单构成 —— 在册、同学院、不重复、人数落在上下限内。
 *   3. 审核 —— 只有管理员；通过 / 退回各改一个状态；退回必须给理由。
 *   4. 替补口径 —— 名单内未上场者即替补。
 *   5. 行数据的预计算布尔量 —— 模板不写业务逻辑。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  canSubmitCollegeEntry,
  canReviewCollegeEntry,
  validateCollegeEntry,
  buildCollegeEntryRecord,
  validateEntryReview,
  remainingMemberIds,
  entryStateOf,
  buildCollegeEntryRow,
} = require('../src/shared/services/college-entry.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  TIE_ALGO,
  TIE_NET_MODE,
} = require('../src/shared/utils/constants.js');
const { REVIEW_ACTION } = require('../src/shared/services/member-review.js');

/** 体育学院的负责人 */
const STAFF = {
  _id: 'u02',
  nickName: '张宇轩',
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  college: '体育学院',
};

/** 信息工程学院的负责人 —— 用来验证「他院被拒」 */
const OTHER_STAFF = { ...STAFF, _id: 'u04', college: '信息工程学院' };

/** 管理员 */
const ADMIN = { _id: 'u01', nickName: '巴特尔', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };

/** 普通会员 */
const MEMBER = { _id: 'u03', nickName: '李明', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 一场正在报名的学院赛 */
function event(overrides = {}) {
  return {
    _id: 'ce01',
    title: '2026 学院杯',
    legPlan: ['MS', 'WS', 'MD'],
    allowMultiEntry: true,
    rosterMin: 4,
    rosterMax: 6,
    tieAlgo: TIE_ALGO.FULL_POINTS,
    tieNetMode: TIE_NET_MODE.WIN_DIFF,
    status: COLLEGE_EVENT_STATUS.SIGNUP,
    results: [],
    ...overrides,
  };
}

/** 一名体育学院的在册会员 */
function member(id, overrides = {}) {
  return {
    _id: id,
    nickName: `队员${id}`,
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
    college: '体育学院',
    ...overrides,
  };
}

const MEMBERS = [member('m1'), member('m2'), member('m3'), member('m4'), member('m5')];

/** 一份合法提交 */
function payload(overrides = {}) {
  return {
    eventId: 'ce01',
    college: '体育学院',
    memberIds: ['m1', 'm2', 'm3', 'm4'],
    ...overrides,
  };
}

/* ============================================================
 * 一、提交权
 * ============================================================ */

test('canSubmitCollegeEntry —— 学院负责人只能提交本学院', () => {
  assert.strictEqual(canSubmitCollegeEntry(event(), STAFF, { college: '体育学院' }), true);
  assert.strictEqual(canSubmitCollegeEntry(event(), STAFF, { college: '信息工程学院' }), false);
  assert.strictEqual(canSubmitCollegeEntry(event(), OTHER_STAFF, { college: '体育学院' }), false);
});

test('canSubmitCollegeEntry —— 管理员可以替任何学院兜底', () => {
  assert.strictEqual(canSubmitCollegeEntry(event(), ADMIN, { college: '信息工程学院' }), true);
});

test('canSubmitCollegeEntry —— 普通会员与访客都不能提交', () => {
  assert.strictEqual(canSubmitCollegeEntry(event(), MEMBER, { college: '体育学院' }), false);
  assert.strictEqual(canSubmitCollegeEntry(event(), null, { college: '体育学院' }), false);
});

test('canSubmitCollegeEntry —— 名单锁定后谁都不能再改', () => {
  for (const status of [
    COLLEGE_EVENT_STATUS.READY,
    COLLEGE_EVENT_STATUS.ONGOING,
    COLLEGE_EVENT_STATUS.FINISHED,
  ]) {
    assert.strictEqual(
      canSubmitCollegeEntry(event({ status }), ADMIN, { college: '体育学院' }),
      false,
      `status=${status} 不该可提交`
    );
  }
});

/* ============================================================
 * 二、名单校验
 * ============================================================ */

test('validateCollegeEntry —— 合法名单通过并去重', () => {
  const result = validateCollegeEntry(
    payload({ memberIds: ['m1', 'm2', 'm2', 'm3', 'm4'] }),
    { event: event(), actor: STAFF, members: MEMBERS }
  );
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.memberIds, ['m1', 'm2', 'm3', 'm4']);
});

test('validateCollegeEntry —— 一个人都没勾时被挡下', () => {
  const result = validateCollegeEntry(payload({ memberIds: [] }), {
    event: event(),
    actor: STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /至少勾选/);
});

test('validateCollegeEntry —— 人数低于下限被挡，报出当前人数', () => {
  const result = validateCollegeEntry(payload({ memberIds: ['m1', 'm2'] }), {
    event: event(),
    actor: STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /至少 4 人/);
  assert.match(result.message, /当前 2 人/);
});

test('validateCollegeEntry —— 人数超过上限被挡', () => {
  const result = validateCollegeEntry(
    payload({ memberIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm1', 'm2'].map((id, i) => id + i) }),
    {
      event: event({ rosterMax: 6 }),
      actor: STAFF,
      members: [...MEMBERS, member('m10'), member('m11')],
    }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /最多 6 人/);
});

test('validateCollegeEntry —— 他院学院负责人提交被挡', () => {
  const result = validateCollegeEntry(payload(), {
    event: event(),
    actor: OTHER_STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /本学院/);
});

test('validateCollegeEntry —— 名单锁定后不能再提交', () => {
  const result = validateCollegeEntry(payload(), {
    event: event({ status: COLLEGE_EVENT_STATUS.READY }),
    actor: STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /锁定/);
});

test('validateCollegeEntry —— 查不到的会员被挡', () => {
  const result = validateCollegeEntry(payload({ memberIds: ['m1', 'm2', 'm3', 'ghost'] }), {
    event: event(),
    actor: STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /查不到/);
});

test('validateCollegeEntry —— 状态不正常的会员被挡', () => {
  const members = [...MEMBERS.slice(0, 3), member('m4', { status: USER_STATUS.LEFT })];
  const result = validateCollegeEntry(payload(), { event: event(), actor: STAFF, members });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不可用/);
});

test('validateCollegeEntry —— 跨院凑人被从源头挡住', () => {
  const members = [...MEMBERS.slice(0, 3), member('m4', { college: '信息工程学院' })];
  const result = validateCollegeEntry(payload(), { event: event(), actor: STAFF, members });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不属于本学院/);
});

test('validateCollegeEntry —— 不存在的学院被挡', () => {
  const result = validateCollegeEntry(payload({ college: '霍格沃茨' }), {
    event: event(),
    actor: ADMIN,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /学院无效/);
});

test('validateCollegeEntry —— 找不到赛事时给明确失败', () => {
  const result = validateCollegeEntry(payload(), { event: null, actor: STAFF, members: MEMBERS });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /找不到/);
});

/* ============================================================
 * 三、装配记录
 * ============================================================ */

test('buildCollegeEntryRecord —— 落库记录带提交人与审核占位', () => {
  const now = new Date('2026-09-12T10:00:00');
  const result = buildCollegeEntryRecord(payload(), {
    event: event(),
    actor: STAFF,
    members: MEMBERS,
    now,
  });

  assert.strictEqual(result.ok, true);
  const record = result.record;
  assert.strictEqual(record.eventId, 'ce01');
  assert.strictEqual(record.college, '体育学院');
  assert.deepStrictEqual(record.members, ['m1', 'm2', 'm3', 'm4']);
  assert.strictEqual(record.status, COLLEGE_ENTRY_STATUS.PENDING);
  assert.strictEqual(record.submittedBy, 'u02');
  assert.strictEqual(record.submitTime, now);
  // 审核痕迹先占位
  assert.strictEqual(record.reviewedBy, '');
  assert.strictEqual(record.reviewedAt, null);
  assert.strictEqual(record.reason, '');
});

test('buildCollegeEntryRecord —— 校验不过时不产出记录', () => {
  const result = buildCollegeEntryRecord(payload({ memberIds: [] }), {
    event: event(),
    actor: STAFF,
    members: MEMBERS,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.record, null);
});

/* ============================================================
 * 四、审核
 * ============================================================ */

/** 一份待审核的名单 */
const PENDING_ENTRY = {
  _id: 'cen01',
  eventId: 'ce01',
  college: '体育学院',
  members: ['m1', 'm2', 'm3', 'm4'],
  status: COLLEGE_ENTRY_STATUS.PENDING,
};

test('canReviewCollegeEntry —— 只有管理员', () => {
  assert.strictEqual(canReviewCollegeEntry(ADMIN), true);
  assert.strictEqual(canReviewCollegeEntry(STAFF), false);
  assert.strictEqual(canReviewCollegeEntry(MEMBER), false);
  assert.strictEqual(canReviewCollegeEntry(null), false);
});

test('validateEntryReview —— 学院负责人不能审，只有管理员能', () => {
  const result = validateEntryReview(STAFF, PENDING_ENTRY, REVIEW_ACTION.APPROVE, '');
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /管理员/);
  assert.strictEqual(result.status, null);
});

test('validateEntryReview —— 通过改「已通过」，不必给理由', () => {
  const result = validateEntryReview(ADMIN, PENDING_ENTRY, REVIEW_ACTION.APPROVE, '');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, COLLEGE_ENTRY_STATUS.APPROVED);
});

test('validateEntryReview —— 退回必须给理由', () => {
  const blank = validateEntryReview(ADMIN, PENDING_ENTRY, REVIEW_ACTION.REJECT, '   ');
  assert.strictEqual(blank.ok, false);
  assert.match(blank.message, /理由/);

  const ok = validateEntryReview(ADMIN, PENDING_ENTRY, REVIEW_ACTION.REJECT, '人数不够');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.status, COLLEGE_ENTRY_STATUS.RETURNED);
});

test('validateEntryReview —— 已经处理过的名单不能再动', () => {
  for (const status of [COLLEGE_ENTRY_STATUS.APPROVED, COLLEGE_ENTRY_STATUS.RETURNED]) {
    const result = validateEntryReview(ADMIN, { ...PENDING_ENTRY, status }, REVIEW_ACTION.APPROVE, '');
    assert.strictEqual(result.ok, false, `status=${status} 不该可审`);
    assert.match(result.message, /已经处理过/);
  }
});

test('validateEntryReview —— 未知动作与查不到都被挡', () => {
  assert.match(validateEntryReview(ADMIN, PENDING_ENTRY, 'burn', '').message, /未知/);
  assert.match(validateEntryReview(ADMIN, null, REVIEW_ACTION.APPROVE, '').message, /找不到/);
});

/* ============================================================
 * 五、替补口径
 * ============================================================ */

test('remainingMemberIds —— 名单内未上场者即替补，保持原顺序', () => {
  const entry = { members: ['m1', 'm2', 'm3', 'm4'] };
  assert.deepStrictEqual(remainingMemberIds(entry, ['m1', 'm3']), ['m2', 'm4']);
  assert.deepStrictEqual(remainingMemberIds(entry, []), ['m1', 'm2', 'm3', 'm4']);
  assert.deepStrictEqual(remainingMemberIds(entry, ['m1', 'm2', 'm3', 'm4']), []);
});

test('remainingMemberIds —— 缺数据时给空数组，不抛错', () => {
  assert.deepStrictEqual(remainingMemberIds(null), []);
  assert.deepStrictEqual(remainingMemberIds({}), []);
});

/* ============================================================
 * 六、状态与行数据
 * ============================================================ */

test('entryStateOf —— 没有记录是「未提交」，四种状态各有说法', () => {
  assert.strictEqual(entryStateOf(null).label, '未提交');
  assert.strictEqual(entryStateOf({ status: COLLEGE_ENTRY_STATUS.PENDING }).label, '待审核');
  assert.strictEqual(entryStateOf({ status: COLLEGE_ENTRY_STATUS.APPROVED }).label, '已通过');
  assert.strictEqual(entryStateOf({ status: COLLEGE_ENTRY_STATUS.RETURNED }).label, '已退回');
  assert.strictEqual(entryStateOf({ status: 99 }).label, '未知状态');
});

test('buildCollegeEntryRow —— 管理员看到待审核名单的可审标记', () => {
  const members = new Map(MEMBERS.map((item) => [item._id, item]));
  const row = buildCollegeEntryRow(PENDING_ENTRY, {
    actor: ADMIN,
    event: event(),
    members,
  });

  assert.strictEqual(row.college, '体育学院');
  assert.strictEqual(row.isPending, true);
  assert.strictEqual(row.memberCount, 4);
  assert.strictEqual(row.canReview, true);
  assert.strictEqual(row.canEdit, true);
  assert.deepStrictEqual(row.memberNames, ['队员m1', '队员m2', '队员m3', '队员m4']);
});

test('buildCollegeEntryRow —— 学院负责人只有本学院的名单能改', () => {
  const row = buildCollegeEntryRow(PENDING_ENTRY, { actor: STAFF, event: event() });
  assert.strictEqual(row.canEdit, true);
  // 学院负责人不能审核
  assert.strictEqual(row.canReview, false);

  const other = buildCollegeEntryRow({ ...PENDING_ENTRY, college: '信息工程学院' }, {
    actor: STAFF,
    event: event(),
  });
  assert.strictEqual(other.canEdit, false);
});

test('buildCollegeEntryRow —— 名单锁定后不可再改', () => {
  const row = buildCollegeEntryRow(PENDING_ENTRY, {
    actor: STAFF,
    event: event({ status: COLLEGE_EVENT_STATUS.READY }),
  });
  assert.strictEqual(row.canEdit, false);
});

test('buildCollegeEntryRow —— 会员看那一行没有任何操作', () => {
  const row = buildCollegeEntryRow(PENDING_ENTRY, { actor: MEMBER, event: event() });
  assert.strictEqual(row.canEdit, false);
  assert.strictEqual(row.canReview, false);
});

test('buildCollegeEntryRow —— 缺会员档案时退回编号，不渲染 undefined', () => {
  const row = buildCollegeEntryRow(PENDING_ENTRY, { actor: ADMIN, event: event() });
  assert.deepStrictEqual(row.memberNames, ['m1', 'm2', 'm3', 'm4']);
  assert.strictEqual(row.reason, '');
  assert.strictEqual(row.submittedName, '');
});
