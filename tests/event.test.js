/**
 * 赛事纯服务 —— 权限、表单校验、报名与名次 单元测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  canManageEvent,
  canStartEvent,
  startBlockedReason,
  canCheckIn,
  canFinishEvent,
  canDrawEvent,
  canSignUp,
  canCancelSignup,
  signupCountOf,
  signupOf,
  buildSignupRecord,
  buildCheckInPatch,
  normalizeDraft,
  validateEvent,
  buildEventRecord,
  validatePlacements,
  levelLabelOf,
  bronzeLabelOf,
  statusLabelOf,
  signupStateOf,
  buildEventRow,
  buildSignupRow,
} = require('../src/shared/services/event.js');

const {
  ROLE,
  USER_STATUS,
  GENDER,
  MATCH_TYPE,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  LEG_DISCIPLINE,
} = require('../src/shared/utils/constants.js');

/** 一位正常在册的普通会员 */
const member = (id, extra = {}) => ({
  _id: id,
  nickName: `会员${id}`,
  role: ROLE.MEMBER,
  status: USER_STATUS.ACTIVE,
  ...extra,
});

/** 一位学院负责人 */
const staff = (id = 's1', extra = {}) => ({
  _id: id,
  nickName: `学院负责人${id}`,
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  ...extra,
});

/** 一位管理员 */
const admin = (id = 'a1', extra = {}) => ({
  _id: id,
  nickName: `管理员${id}`,
  role: ROLE.ADMIN,
  status: USER_STATUS.ACTIVE,
  ...extra,
});

/** 一场处于「报名中」的赛事 */
const openEvent = (extra = {}) => ({
  _id: 'e01',
  title: '五月男单赛',
  matchType: MATCH_TYPE.SINGLES,
  level: EVENT_LEVEL.THIRD,
  bronzeMode: EVENT_BRONZE_MODE.TIED,
  seedMode: SEED_MODE.ELO,
  seedCount: 8,
  status: EVENT_STATUS.SIGNUP,
  quota: 8,
  results: [],
  ...extra,
});

const signupRecord = (userId, status = SIGNUP_STATUS.SIGNED, extra = {}) => ({
  eventId: 'e01',
  userId,
  status,
  signTime: new Date('2026-05-01T09:00:00'),
  checkInTime: null,
  ...extra,
});

const validForm = (extra = {}) => ({
  title: '五月男单赛',
  description: '常规赛事，单败淘汰制',
  matchType: MATCH_TYPE.SINGLES,
  level: EVENT_LEVEL.SECOND,
  bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
  seedMode: SEED_MODE.ELO,
  seedCount: 8,
  location: '学校体育馆 1 号场',
  startTime: new Date('2026-05-01T10:00:00'),
  quota: 8,
  courtCount: 4,
  ...extra,
});

describe('canManageEvent —— 发布 / 管理权（仅管理员）', () => {
  test('只有管理员可以发布 / 修改 / 抽签 / 开始 / 结束赛事', () => {
    assert.equal(canManageEvent(admin()), true);
  });

  test('学院负责人与普通会员都没有管理权，本地模拟数据源也不放宽', () => {
    // 学院负责人比会员多的只是「代签到」与「录入比分」，赛事本身的操盘权收到管理员
    assert.equal(canManageEvent(staff()), false);
    assert.equal(canManageEvent(member('m1')), false);
    // 判定只看角色——否则本地上每位会员都会看到「＋发布」
    assert.equal(canManageEvent(member('m1'), { isMock: true }), false);
  });

  test('待审核 / 离校 / 已禁用 / 未登录一律不行', () => {
    assert.equal(canManageEvent(admin('a1', { status: USER_STATUS.PENDING })), false);
    assert.equal(canManageEvent(admin('a1', { status: USER_STATUS.DISABLED })), false);
    assert.equal(canManageEvent(admin('a1', { status: USER_STATUS.LEFT })), false);
    assert.equal(canManageEvent(null), false);
  });
});

describe('赛事状态机 —— 开始 / 签到 / 结束', () => {
  test('只有报名中的赛事能开始（且只有管理员）', () => {
    assert.equal(canStartEvent(openEvent(), admin()), true);
    assert.equal(canStartEvent(openEvent(), staff()), false);
    assert.equal(canStartEvent(openEvent({ status: EVENT_STATUS.ONGOING }), admin()), false);
    assert.equal(canStartEvent(openEvent({ status: EVENT_STATUS.FINISHED }), admin()), false);
  });

  test('只有进行中的赛事能签到与结束', () => {
    const ongoing = openEvent({ status: EVENT_STATUS.ONGOING });
    // 签到放给学院负责人分担；结束赛事仍只有管理员
    assert.equal(canCheckIn(ongoing, staff()), true);
    assert.equal(canCheckIn(ongoing, admin()), true);
    assert.equal(canFinishEvent(ongoing, admin()), true);
    assert.equal(canFinishEvent(ongoing, staff()), false);

    assert.equal(canCheckIn(openEvent(), staff()), false);
    assert.equal(canFinishEvent(openEvent(), admin()), false);
    assert.equal(canCheckIn(openEvent({ status: EVENT_STATUS.FINISHED }), staff()), false);
  });

  test('普通会员不能开始 / 签到 / 结束', () => {
    assert.equal(canStartEvent(openEvent(), member('m1')), false);
    assert.equal(canCheckIn(openEvent({ status: EVENT_STATUS.ONGOING }), member('m1')), false);
    assert.equal(canFinishEvent(openEvent({ status: EVENT_STATUS.ONGOING }), member('m1')), false);
  });
});

describe('canCheckIn —— 学院负责人代签只限本学院', () => {
  const ongoing = () => openEvent({ status: EVENT_STATUS.ONGOING });

  test('管理员可以为任何学院的人签到', () => {
    const target = member('m9', { college: '美术学院' });
    assert.equal(canCheckIn(ongoing(), admin(), { target }), true);
  });

  test('学院负责人只能签本学院的人', () => {
    const me = staff('s1', { college: '信息工程学院' });
    assert.equal(canCheckIn(ongoing(), me, { target: member('m1', { college: '信息工程学院' }) }), true);
    // 替别的学院签会把本院的账记到别人名下，拦住
    assert.equal(canCheckIn(ongoing(), me, { target: member('m2', { college: '美术学院' }) }), false);
  });

  test('学院负责人没有学院时，代签一律不放行（宁严勿松）', () => {
    const noCollege = staff('s1');
    assert.equal(canCheckIn(ongoing(), noCollege, { target: member('m1', { college: '体育学院' }) }), false);
  });

  test('传 targetCollege 与传整个 target 等价', () => {
    const me = staff('s1', { college: '体育学院' });
    assert.equal(canCheckIn(ongoing(), me, { targetCollege: '体育学院' }), true);
    assert.equal(canCheckIn(ongoing(), me, { targetCollege: '美术学院' }), false);
  });

  test('不指定目标时只判「有没有代签资格」，与学院无关', () => {
    // 写入口总会带上目标；这里保住旧口径，免得上层漏传时被误伤
    assert.equal(canCheckIn(ongoing(), staff('s1')), true);
    assert.equal(canCheckIn(ongoing(), admin()), true);
  });
});

describe('startBlockedReason —— 未抽签不得开赛', () => {
  test('单打没抽签时给出「请先抽签」', () => {
    assert.equal(startBlockedReason(openEvent()), '请先抽签，再开始赛事');
  });

  test('单打已抽签可以开始', () => {
    assert.equal(startBlockedReason(openEvent({ draw: { seedValue: 1 } })), '');
  });

  test('双打同样要先抽签才能开始', () => {
    assert.equal(
      startBlockedReason(openEvent({ matchType: MATCH_TYPE.DOUBLES })),
      '请先抽签，再开始赛事'
    );
    assert.equal(
      startBlockedReason(openEvent({ matchType: MATCH_TYPE.DOUBLES, draw: { seedValue: 1 } })),
      ''
    );
  });

  test('赛事不存在时给出提示', () => {
    assert.equal(startBlockedReason(null), '找不到这场赛事');
  });
});

describe('canDrawEvent —— 抽签资格（仅管理员）', () => {
  test('管理员在报名中可抽签', () => {
    assert.equal(canDrawEvent(openEvent(), admin()), true);
  });

  test('学院负责人不再有抽签权', () => {
    assert.equal(canDrawEvent(openEvent(), staff()), false);
  });

  test('开赛后不可抽签 / 重抽（决策 7）', () => {
    assert.equal(canDrawEvent(openEvent({ status: EVENT_STATUS.ONGOING }), admin()), false);
    assert.equal(canDrawEvent(openEvent({ status: EVENT_STATUS.FINISHED }), admin()), false);
  });

  test('双打赛事同样可抽签，与单打同步', () => {
    assert.equal(canDrawEvent(openEvent({ matchType: MATCH_TYPE.DOUBLES }), admin()), true);
  });

  test('普通会员与访客都不行', () => {
    assert.equal(canDrawEvent(openEvent(), member('m1')), false);
    assert.equal(canDrawEvent(openEvent(), null), false);
  });
});

describe('canSignUp —— 报名判定', () => {
  test('报名中的赛事，在册会员可以报名', () => {
    assert.equal(canSignUp(openEvent(), member('m1')), true);
  });

  test('未开始以外（进行中 / 已结束）不能报名', () => {
    assert.equal(canSignUp(openEvent({ status: EVENT_STATUS.ONGOING }), member('m1')), false);
    assert.equal(canSignUp(openEvent({ status: EVENT_STATUS.FINISHED }), member('m1')), false);
  });

  test('已离校的人不能报名（决策 11）', () => {
    assert.equal(canSignUp(openEvent(), member('m1', { status: USER_STATUS.LEFT })), false);
  });

  test('待审核的账号不能报名', () => {
    assert.equal(canSignUp(openEvent(), member('m1', { status: USER_STATUS.PENDING })), false);
  });

  test('已经报过名的不能重复报名', () => {
    const actor = member('m1');
    assert.equal(canSignUp(openEvent(), actor, { signup: signupRecord('m1') }), false);
  });

  test('签到过的同样不能再次报名', () => {
    const actor = member('m1');
    assert.equal(
      canSignUp(openEvent(), actor, { signup: signupRecord('m1', SIGNUP_STATUS.CHECKED_IN) }),
      false
    );
  });

  test('取消过报名的可以重新报名', () => {
    const actor = member('m1');
    assert.equal(
      canSignUp(openEvent(), actor, { signup: signupRecord('m1', SIGNUP_STATUS.CANCELED) }),
      true
    );
  });

  test('名额满了就不再放人进来', () => {
    const full = [signupRecord('a'), signupRecord('b')];
    assert.equal(canSignUp(openEvent({ quota: 2 }), member('m1'), { signups: full }), false);
    assert.equal(canSignUp(openEvent({ quota: 3 }), member('m1'), { signups: full }), true);
  });

  test('名额为 0 视为不限', () => {
    assert.equal(canSignUp(openEvent({ quota: 0 }), member('m1')), true);
  });

  test('取消报名的不占名额', () => {
    const list = [signupRecord('a'), signupRecord('b', SIGNUP_STATUS.CANCELED)];
    assert.equal(signupCountOf(openEvent(), list), 1);
    assert.equal(canSignUp(openEvent({ quota: 2 }), member('m1'), { signups: list }), true);
  });

  test('退过赛的人重新报名，同样要占名额（不再被豁免）', () => {
    // 名额 2：a 在册、b 退了赛；此时 c 补上了空位 —— 有效人数已经满
    const list = [
      signupRecord('a'),
      signupRecord('b', SIGNUP_STATUS.CANCELED),
      signupRecord('c'),
    ];
    assert.equal(signupCountOf(openEvent(), list), 2);
    // b 想再报一次：他就是退了赛的那个人，不能凭「有记录」白占第三个位子
    assert.equal(
      canSignUp(openEvent({ quota: 2 }), member('b'), { signups: list, signup: list[1] }),
      false
    );
    // 少一个人时他就能回来
    assert.equal(
      canSignUp(openEvent({ quota: 3 }), member('b'), { signups: list, signup: list[1] }),
      true
    );
  });

  test('抽签后名单冻结，再多的人也不能报名（决策 5）', () => {
    // 赛事仍是「报名中」，所以挡住他的必须是 draw 而不是状态
    const drawn = openEvent({ draw: { seedValue: 1 } });
    assert.equal(drawn.status, EVENT_STATUS.SIGNUP);
    assert.equal(canSignUp(drawn, member('m1')), false);
  });

  test('项目不限 —— 男女都能报名，合池单打不禁男女对打', () => {
    // 没声明项目的赛事（历史数据 / 表单留空）一律按「不限」处理
    assert.equal(canSignUp(openEvent({ discipline: '' }), member('m1', { gender: GENDER.MALE })), true);
    assert.equal(canSignUp(openEvent({ discipline: '' }), member('m2', { gender: GENDER.FEMALE })), true);
  });

  test('单性别项目 —— 男单只收男会员，女单只收女会员', () => {
    const ms = openEvent({ discipline: LEG_DISCIPLINE.MS });
    assert.equal(canSignUp(ms, member('m1', { gender: GENDER.MALE })), true);
    assert.equal(canSignUp(ms, member('m2', { gender: GENDER.FEMALE })), false);

    const ws = openEvent({ discipline: LEG_DISCIPLINE.WS });
    assert.equal(canSignUp(ws, member('m1', { gender: GENDER.MALE })), false);
    assert.equal(canSignUp(ws, member('m2', { gender: GENDER.FEMALE })), true);
  });

  test('双打项目 —— 男双限男、女双限女，混双不限（配对留给抽签）', () => {
    const md = openEvent({ matchType: MATCH_TYPE.DOUBLES, discipline: LEG_DISCIPLINE.MD });
    assert.equal(canSignUp(md, member('m1', { gender: GENDER.MALE })), true);
    assert.equal(canSignUp(md, member('m2', { gender: GENDER.FEMALE })), false);

    const wd = openEvent({ matchType: MATCH_TYPE.DOUBLES, discipline: LEG_DISCIPLINE.WD });
    assert.equal(canSignUp(wd, member('m2', { gender: GENDER.FEMALE })), true);
    assert.equal(canSignUp(wd, member('m1', { gender: GENDER.MALE })), false);

    const xd = openEvent({ matchType: MATCH_TYPE.DOUBLES, discipline: LEG_DISCIPLINE.XD });
    assert.equal(canSignUp(xd, member('m1', { gender: GENDER.MALE })), true);
    assert.equal(canSignUp(xd, member('m2', { gender: GENDER.FEMALE })), true);
  });
});

describe('canCancelSignup —— 退赛判定', () => {
  const actor = member('m1');

  test('报名中且已报名，可以取消', () => {
    assert.equal(canCancelSignup(openEvent(), actor, { signup: signupRecord('m1') }), true);
  });

  test('没报名 / 别人名下的记录都不能取消', () => {
    assert.equal(canCancelSignup(openEvent(), actor, { signup: null }), false);
    assert.equal(canCancelSignup(openEvent(), actor, { signup: signupRecord('m2') }), false);
  });

  test('已签到的 / 已取消的不能再取消', () => {
    assert.equal(
      canCancelSignup(openEvent(), actor, { signup: signupRecord('m1', SIGNUP_STATUS.CHECKED_IN) }),
      false
    );
    assert.equal(
      canCancelSignup(openEvent(), actor, { signup: signupRecord('m1', SIGNUP_STATUS.CANCELED) }),
      false
    );
  });

  test('报名截止后不能取消', () => {
    assert.equal(
      canCancelSignup(openEvent({ status: EVENT_STATUS.ONGOING }), actor, {
        signup: signupRecord('m1'),
      }),
      false
    );
  });

  test('抽签后名单冻结，已报名的人也不能退赛（决策 5）', () => {
    assert.equal(
      canCancelSignup(openEvent({ draw: { seedValue: 1 } }), actor, { signup: signupRecord('m1') }),
      false
    );
  });
});

describe('signupOf / signupCountOf', () => {
  test('signupOf 找得到本人的记录，找不到返回 null', () => {
    const list = [signupRecord('a'), signupRecord('b')];
    assert.equal(signupOf(list, 'b').userId, 'b');
    assert.equal(signupOf(list, 'c'), null);
    assert.equal(signupOf(list, null), null);
  });

  test('signupCountOf 兼容直接挂在赛事上的报名列表', () => {
    const event = openEvent({ signups: [signupRecord('a'), signupRecord('b')] });
    assert.equal(signupCountOf(event), 2);
  });
});

describe('buildSignupRecord —— 组装报名记录', () => {
  test('正常报名：状态为已报名，签到时间为空', () => {
    const actor = member('m1');
    const result = buildSignupRecord(openEvent(), actor, { now: new Date('2026-05-01T09:00:00') });
    assert.equal(result.ok, true);
    assert.equal(result.record.eventId, 'e01');
    assert.equal(result.record.userId, 'm1');
    assert.equal(result.record.status, SIGNUP_STATUS.SIGNED);
    assert.equal(result.record.checkInTime, null);
  });

  test('离校的人报名被拒，且给出说得清的文案', () => {
    const result = buildSignupRecord(openEvent(), member('m1', { status: USER_STATUS.LEFT }));
    assert.equal(result.ok, false);
    assert.equal(result.record, null);
    assert.match(result.message, /离校/);
  });

  test('报名截止后报名被拒', () => {
    const result = buildSignupRecord(openEvent({ status: EVENT_STATUS.ONGOING }), member('m1'));
    assert.equal(result.ok, false);
  });

  test('性别不符的报名被拒，文案点明是哪一项、限什么性别', () => {
    const result = buildSignupRecord(
      openEvent({ discipline: LEG_DISCIPLINE.WS }),
      member('m1', { gender: GENDER.MALE })
    );
    assert.equal(result.ok, false);
    assert.equal(result.record, null);
    assert.match(result.message, /女单/);
    assert.match(result.message, /女会员/);
  });

  test('赛事或会员缺失时不抛错，只返回失败', () => {
    assert.equal(buildSignupRecord(null, member('m1')).ok, false);
    assert.equal(buildSignupRecord(openEvent(), null).ok, false);
  });
});

describe('buildCheckInPatch —— 代签', () => {
  test('已报名的可以签到，签到时间与代签人一并记下', () => {
    const result = buildCheckInPatch(signupRecord('m1'), staff('s1'), {
      now: new Date('2026-05-01T10:00:00'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.patch.status, SIGNUP_STATUS.CHECKED_IN);
    assert.equal(result.patch.actorId, 's1');
    assert.ok(result.patch.checkInTime instanceof Date);
  });

  test('没报名 / 已取消的不能签到', () => {
    assert.equal(buildCheckInPatch(null, staff()).ok, false);
    assert.equal(
      buildCheckInPatch(signupRecord('m1', SIGNUP_STATUS.CANCELED), staff()).ok,
      false
    );
  });

  test('重复签到被挡下', () => {
    assert.equal(
      buildCheckInPatch(signupRecord('m1', SIGNUP_STATUS.CHECKED_IN), staff()).ok,
      false
    );
  });
});

describe('validateEvent —— 发布校验', () => {
  test('完整表单通过，并把数字与日期收敛好', () => {
    const result = validateEvent(validForm());
    assert.equal(result.ok, true);
    assert.equal(result.draft.level, EVENT_LEVEL.SECOND);
    assert.ok(result.draft.startTime instanceof Date);
  });

  test('必须显式选择等级（决策 13）', () => {
    const result = validateEvent(validForm({ level: '' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.level, /等级/);
  });

  test('必须显式选择三四名赛方式（决策 8）', () => {
    const result = validateEvent(validForm({ bronzeMode: '' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.bronzeMode, /三四名/);
  });

  test('单打必须显式选择种子来源与数量（决策 2 / 3）', () => {
    const noMode = validateEvent(validForm({ seedMode: '' }));
    assert.equal(noMode.ok, false);
    assert.match(noMode.errors.seedMode, /种子来源/);

    const noCount = validateEvent(validForm({ seedCount: '' }));
    assert.equal(noCount.ok, false);
    assert.match(noCount.errors.seedCount, /种子数量/);

    // 只认 2 / 4 / 8
    assert.equal(validateEvent(validForm({ seedCount: 3 })).ok, false);
    assert.equal(validateEvent(validForm({ seedCount: 4 })).ok, true);
  });

  test('双打与单打同步：也要显式选种子来源与数量', () => {
    const noMode = validateEvent(
      validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: '', seedCount: 8 })
    );
    assert.equal(noMode.ok, false);
    assert.match(noMode.errors.seedMode, /种子来源/);

    const noCount = validateEvent(
      validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: SEED_MODE.ELO, seedCount: '' })
    );
    assert.equal(noCount.ok, false);
    assert.match(noCount.errors.seedCount, /种子数量/);
  });

  test('双打没有赛季积分，按积分定种子被拒并说明原因', () => {
    const result = validateEvent(
      validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: SEED_MODE.POINTS, seedCount: 8 })
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.seedMode, /没有赛季积分/);

    // 手工指定 / 按等级分都能通过
    assert.equal(
      validateEvent(validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: SEED_MODE.MANUAL })).ok,
      true
    );
    assert.equal(
      validateEvent(validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: SEED_MODE.ELO })).ok,
      true
    );
  });

  test('必须选择单打或双打', () => {
    assert.equal(validateEvent(validForm({ matchType: '' })).ok, false);
    assert.equal(validateEvent(validForm({ matchType: 99 })).ok, false);
  });

  test('赛事名称太短 / 太长都被拒', () => {
    assert.equal(validateEvent(validForm({ title: '赛' })).ok, false);
    assert.equal(validateEvent(validForm({ title: '赛'.repeat(31) })).ok, false);
  });

  test('缺少或非法的时间被拒', () => {
    assert.equal(validateEvent(validForm({ startTime: '' })).ok, false);
    assert.equal(validateEvent(validForm({ startTime: 'not-a-date' })).ok, false);
  });

  test('firstError 按表单顺序取第一条', () => {
    const result = validateEvent(validForm({ title: '', level: '' }));
    assert.match(result.firstError, /赛事名称/);
  });

  test('名额为负数被拒，0 表示不限', () => {
    assert.equal(validateEvent(validForm({ quota: -1 })).ok, false);
    assert.equal(validateEvent(validForm({ quota: 0 })).ok, true);
  });

  test('项目可选：留空 = 不限，向后兼容没有这个字段的老赛事', () => {
    assert.equal(validateEvent(validForm({ discipline: '' })).ok, true);
    assert.equal(validateEvent(validForm()).ok, true);
  });

  test('项目必须与单打 / 双打对得上：双打赛事选男单被拒', () => {
    const mismatch = validateEvent(
      validForm({ matchType: MATCH_TYPE.DOUBLES, discipline: LEG_DISCIPLINE.MS })
    );
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.errors.discipline, /不匹配/);

    assert.equal(
      validateEvent(validForm({ matchType: MATCH_TYPE.DOUBLES, discipline: LEG_DISCIPLINE.XD })).ok,
      true
    );
    assert.equal(
      validateEvent(validForm({ matchType: MATCH_TYPE.SINGLES, discipline: LEG_DISCIPLINE.MS })).ok,
      true
    );
  });

  test('项目不在小项池里被拒', () => {
    const result = validateEvent(validForm({ discipline: 'XX' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.discipline, /项目/);
  });
});

describe('buildEventRecord —— 组装赛事记录', () => {
  test('落库即「报名中」，池随项目写死', () => {
    const result = buildEventRecord(validForm({ matchType: MATCH_TYPE.DOUBLES }), {
      actor: staff('s1'),
      now: new Date('2026-04-01T00:00:00'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.record.status, EVENT_STATUS.SIGNUP);
    assert.equal(result.record.pool, 'doubles');
    assert.equal(result.record.level, EVENT_LEVEL.SECOND);
    assert.equal(result.record.bronzeMode, EVENT_BRONZE_MODE.PLAYOFF);
    assert.deepEqual(result.record.results, []);
  });

  test('单打记下种子来源与数量，尚未抽签时 draw 为空', () => {
    const result = buildEventRecord(validForm(), { actor: staff('s1') });
    assert.equal(result.record.seedMode, SEED_MODE.ELO);
    assert.equal(result.record.seedCount, 8);
    assert.equal(result.record.draw, null, '创建时还没抽签');
  });

  test('双打同样落种子字段——双打也要抽签，种子是「两人一组」', () => {
    const result = buildEventRecord(
      validForm({ matchType: MATCH_TYPE.DOUBLES, seedMode: SEED_MODE.MANUAL, seedCount: 4 }),
      { actor: staff('s1') }
    );
    assert.equal(result.ok, true);
    assert.equal(result.record.seedMode, SEED_MODE.MANUAL);
    assert.equal(result.record.seedCount, 4);
  });

  test('记下发布人，昵称缺失时逐层兜底', () => {
    const result = buildEventRecord(validForm(), {
      actor: { _id: 's9', nickName: '', realName: '张学院负责人' },
    });
    assert.equal(result.record.publisherId, 's9');
    assert.equal(result.record.publisherName, '张学院负责人');
  });

  test('项目落库：选了写下来，留空存 null（当作不限）', () => {
    const picked = buildEventRecord(validForm({ discipline: LEG_DISCIPLINE.MS }), {
      actor: staff('s1'),
    });
    assert.equal(picked.record.discipline, LEG_DISCIPLINE.MS);

    const blank = buildEventRecord(validForm({ discipline: '' }), { actor: staff('s1') });
    assert.equal(blank.record.discipline, null);
  });

  test('校验不过时不产出记录', () => {
    const result = buildEventRecord(validForm({ level: '' }));
    assert.equal(result.ok, false);
    assert.equal(result.record, null);
    assert.match(result.firstError, /等级/);
  });
});

describe('validatePlacements —— 名次成对校验', () => {
  /** 8 人赛：冠军、亚军、两个半决赛负者、四个八强 */
  const tiedBoard = [
    { userId: 'u1', placement: 1 },
    { userId: 'u2', placement: 2 },
    { userId: 'u3', placement: 3 },
    { userId: 'u4', placement: 3 },
    { userId: 'u5', placement: 5 },
    { userId: 'u6', placement: 5 },
    { userId: 'u7', placement: 5 },
    { userId: 'u8', placement: 5 },
  ];

  test('并列季军：两位第 3 名，没有第 4 名', () => {
    const result = validatePlacements(tiedBoard, { bronzeMode: EVENT_BRONZE_MODE.TIED });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 8);
  });

  test('并列模式下出现第 4 名被拒', () => {
    const bad = tiedBoard.map((row) => (row.userId === 'u4' ? { ...row, placement: 4 } : row));
    const result = validatePlacements(bad, { bronzeMode: EVENT_BRONZE_MODE.TIED });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /第 4 名/);
  });

  test('打三四名：第 3、第 4 名成对出现', () => {
    const playoff = tiedBoard.map((row) => (row.userId === 'u4' ? { ...row, placement: 4 } : row));
    const result = validatePlacements(playoff, { bronzeMode: EVENT_BRONZE_MODE.PLAYOFF });
    assert.equal(result.ok, true);
  });

  test('打三四名时只有第 3 名、没有第 4 名，被拒', () => {
    // 只留一位第 3 名：冠军、亚军、季军各一，第 4 名缺失
    const missingFourth = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
      { userId: 'u4', placement: 5 },
    ];
    const result = validatePlacements(missingFourth, { bronzeMode: EVENT_BRONZE_MODE.PLAYOFF });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /成对/);
  });

  test('打三四名时出现两位第 3 名，被拒', () => {
    const result = validatePlacements(tiedBoard, { bronzeMode: EVENT_BRONZE_MODE.PLAYOFF });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /第 3 名只能有一位/);
  });

  test('打三四名：参赛只有 3 人时排不出季军赛，允许单一位第 3 名', () => {
    // 3 人签表规模是 4，首轮必有一场轮空，半决赛只产生一个负者，
    // 第 4 名无从产生——若还按成对卡，这场赛事就永远结不了
    const three = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
    ];
    const result = validatePlacements(three, {
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      entryCount: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 3);
  });

  test('打三四名：参赛只有 3 人却报了第 4 名，被拒', () => {
    const impossible = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
      { userId: 'u4', placement: 4 },
    ];
    const result = validatePlacements(impossible, {
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      entryCount: 3,
    });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /第 4 名/);
  });

  test('打三四名：参赛满 4 人时仍要求第 3、第 4 名成对', () => {
    const board = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
      { userId: 'u4', placement: 5 },
    ];
    const result = validatePlacements(board, {
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      entryCount: 4,
    });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /成对/);
  });

  test('冠军必须恰好一位', () => {
    const noChampion = tiedBoard.map((row) => (row.userId === 'u1' ? { ...row, placement: 2 } : row));
    assert.equal(validatePlacements(noChampion).ok, false);
  });

  test('同一个人不能出现两次', () => {
    const dup = [...tiedBoard, { userId: 'u1', placement: 5 }];
    assert.equal(validatePlacements(dup).ok, false);
  });

  test('名次必须是正整数', () => {
    assert.equal(validatePlacements([{ userId: 'u1', placement: 0 }]).ok, false);
    assert.equal(validatePlacements([{ userId: 'u1', placement: 1.5 }]).ok, false);
    assert.equal(validatePlacements([{ userId: 'u1' }]).ok, false);
  });

  test('空名单被拒', () => {
    assert.equal(validatePlacements([]).ok, false);
    assert.equal(validatePlacements(null).ok, false);
  });

  test('缺省方式按并列处理（历史赛事口径）', () => {
    assert.equal(validatePlacements(tiedBoard).ok, true);
  });

  test('循环赛按阶梯口径：1..N 的普通名次表放行，第 4 名不再算错', () => {
    // 积分表排出来的名次必然出现第 4 名；若还套三四名成对规则，赛事永远结不了
    const ladder = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
      { userId: 'u4', placement: 4 },
      { userId: 'u5', placement: 5 },
      { userId: 'u6', placement: 6 },
    ];
    const result = validatePlacements(ladder, { format: EVENT_FORMAT.ROUND_ROBIN });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 6);
  });

  test('小组赛同样走阶梯口径，不必第 3、第 4 名成对', () => {
    const ladder = [
      { userId: 'u1', placement: 1 },
      { userId: 'u2', placement: 2 },
      { userId: 'u3', placement: 3 },
      { userId: 'u4', placement: 4 },
    ];
    assert.equal(validatePlacements(ladder, { format: EVENT_FORMAT.GROUP_KNOCKOUT }).ok, true);
  });

  test('阶梯口径仍守住「恰有一位冠军」', () => {
    const noChampion = [
      { userId: 'u1', placement: 2 },
      { userId: 'u2', placement: 3 },
    ];
    const result = validatePlacements(noChampion, { format: EVENT_FORMAT.ROUND_ROBIN });
    assert.equal(result.ok, false);
    assert.match(result.firstError, /冠军/);
  });
});

describe('文案兜底 —— 历史赛事没有新字段也不显示 undefined', () => {
  test('等级缺省三级、方式缺省并列、状态缺省已结束', () => {
    const legacy = { _id: 'e01', status: EVENT_STATUS.FINISHED };
    assert.equal(levelLabelOf(legacy), '三级赛事');
    assert.equal(bronzeLabelOf(legacy), '并列季军');
    assert.equal(statusLabelOf(legacy), '已结束');
  });
});

describe('signupStateOf —— 报名状态文案', () => {
  test('没有记录显示未报名', () => {
    const state = signupStateOf(null);
    assert.equal(state.label, '未报名');
    assert.equal(state.signed, false);
  });

  test('已报名 / 已签到各自可辨', () => {
    assert.equal(signupStateOf(signupRecord('m1')).label, '已报名');
    const checked = signupStateOf(signupRecord('m1', SIGNUP_STATUS.CHECKED_IN));
    assert.equal(checked.checkedIn, true);
    assert.equal(checked.signed, true);
  });
});

describe('buildEventRow —— 把权限算进数据里', () => {
  test('会员看到的是报名口径，管理按钮一律关闭', () => {
    const row = buildEventRow(openEvent(), { actor: member('m1') });
    assert.equal(row.canSignUp, true);
    assert.equal(row.canCancelSignup, false);
    assert.equal(row.canStart, false);
    assert.equal(row.canFinish, false);
  });

  test('已报名后按钮翻转', () => {
    const row = buildEventRow(openEvent(), {
      actor: member('m1'),
      signups: [signupRecord('m1')],
    });
    assert.equal(row.canSignUp, false);
    assert.equal(row.canCancelSignup, true);
    assert.equal(row.signedUp, true);
    assert.equal(row.mySignupLabel, '已报名');
  });

  test('学院负责人只看到代签到，结束赛事交给管理员', () => {
    const row = buildEventRow(openEvent({ status: EVENT_STATUS.ONGOING }), { actor: staff('s1') });
    assert.equal(row.canCheckIn, true);
    assert.equal(row.canFinish, false);
    assert.equal(row.canStart, false);
  });

  test('管理员看到代签到与结束赛事', () => {
    const row = buildEventRow(openEvent({ status: EVENT_STATUS.ONGOING }), { actor: admin('a1') });
    assert.equal(row.canCheckIn, true);
    assert.equal(row.canFinish, true);
  });

  test('名额与时间文案成形，缺字段也不显示 undefined', () => {
    const row = buildEventRow(openEvent({ title: '', location: '', startTime: null }), {
      actor: member('m1'),
      signups: [signupRecord('a')],
    });
    assert.equal(row.title, '（未命名赛事）');
    assert.equal(row.quotaText, '1/8 人');
    assert.equal(row.statusLabel, '报名中');
    assert.equal(row.isDoubles, false);
    assert.ok(!row.timeText.includes('undefined'));
  });

  test('不限名额时只显示已报名人数', () => {
    const row = buildEventRow(openEvent({ quota: 0 }), { actor: member('m1') });
    assert.equal(row.quotaText, '0 人');
  });
});

describe('buildSignupRow —— 报名名单一行', () => {
  test('取到昵称头像，并标出是不是我', () => {
    const row = buildSignupRow(
      signupRecord('m1'),
      { nickName: '小王', avatarUrl: 'http://x/a.png' },
      { actor: member('m1') }
    );
    assert.equal(row.nickName, '小王');
    assert.equal(row.avatarUrl, 'http://x/a.png');
    assert.equal(row.isMe, true);
    assert.equal(row.statusLabel, '已报名');
  });

  test('找不到档案时用编号兜底，不显示 undefined', () => {
    const row = buildSignupRow(signupRecord('m1'), null);
    assert.equal(row.nickName, 'm1');
    assert.equal(row.avatarUrl, '');
  });
});
