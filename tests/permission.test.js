/**
 * 管理权限公共判定的纯逻辑自检
 * ============================================================
 * 这一层是「谁能管什么」的唯一出处：审核、公告、赛季重置、赛事操盘都走它。
 * 新增的 managesCollege 是学院负责人的权限边界，尤其要钉死——
 * 一条判宽的边界会让一个学院的负责人悄悄改到别的学院的名单。
 *
 * 判定只看角色与状态，不碰 wx、不碰数据源，所以全部能在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { isActive, canManage, managesCollege } = require('../src/shared/services/permission.js');
const { ROLE, USER_STATUS } = require('../src/shared/utils/constants.js');

/** 一位在岗会员，角色与学院由 extra 指定 */
const actor = (role, extra = {}) => ({
  _id: 'x1',
  nickName: '某人',
  role,
  status: USER_STATUS.ACTIVE,
  ...extra,
});

/* ============================================================
 * 一、账号状态
 * ============================================================ */

test('isActive —— 只有正常状态算可用', () => {
  assert.strictEqual(isActive(actor(ROLE.MEMBER)), true);
  assert.strictEqual(isActive(actor(ROLE.ADMIN)), true);
  assert.strictEqual(isActive(actor(ROLE.MEMBER, { status: USER_STATUS.PENDING })), false);
  assert.strictEqual(isActive(actor(ROLE.MEMBER, { status: USER_STATUS.DISABLED })), false);
  assert.strictEqual(isActive(actor(ROLE.MEMBER, { status: USER_STATUS.LEFT })), false);
  assert.strictEqual(isActive(null), false);
});

/* ============================================================
 * 二、通用管理权
 * ============================================================ */

test('canManage —— 默认门槛是最保守的管理员（忘了声明 minRole 时挡住越权，而不是放行）', () => {
  assert.strictEqual(canManage(actor(ROLE.MEMBER)), false);
  assert.strictEqual(canManage(actor(ROLE.STAFF)), false);
  assert.strictEqual(canManage(actor(ROLE.ADMIN)), true);
  assert.strictEqual(canManage(null), false);
});

test('canManage —— 显式声明门槛时才按声明的来', () => {
  // 抬高：任免学院负责人只给管理员
  assert.strictEqual(canManage(actor(ROLE.STAFF), { minRole: ROLE.ADMIN }), false);
  assert.strictEqual(canManage(actor(ROLE.ADMIN), { minRole: ROLE.ADMIN }), true);
  // 保留给临场事务的学院负责人档（实际业务里都还要再过 managesCollege）
  assert.strictEqual(canManage(actor(ROLE.STAFF), { minRole: ROLE.STAFF }), true);
  assert.strictEqual(canManage(actor(ROLE.MEMBER), { minRole: ROLE.STAFF }), false);
});

test('canManage —— 状态不可用时角色再高也没用', () => {
  assert.strictEqual(canManage(actor(ROLE.ADMIN, { status: USER_STATUS.DISABLED })), false);
  assert.strictEqual(canManage(actor(ROLE.ADMIN, { status: USER_STATUS.PENDING })), false);
});

/* ============================================================
 * 三、学院范围
 * ============================================================ */

test('managesCollege —— 管理员没有学院限制，全校通行', () => {
  assert.strictEqual(managesCollege(actor(ROLE.ADMIN), '体育学院'), true);
  // 管理员自己没填学院也不影响
  assert.strictEqual(managesCollege(actor(ROLE.ADMIN, { college: '' }), '美术学院'), true);
});

test('managesCollege —— 学院负责人只管本学院', () => {
  const leader = actor(ROLE.STAFF, { college: '体育学院' });
  assert.strictEqual(managesCollege(leader, '体育学院'), true);
  assert.strictEqual(managesCollege(leader, '美术学院'), false);
});

test('managesCollege —— 普通会员、访客、待审核一律不管', () => {
  assert.strictEqual(managesCollege(actor(ROLE.MEMBER, { college: '体育学院' }), '体育学院'), false);
  assert.strictEqual(managesCollege(null, '体育学院'), false);
  assert.strictEqual(
    managesCollege(actor(ROLE.STAFF, { college: '体育学院', status: USER_STATUS.PENDING }), '体育学院'),
    false
  );
});

test('managesCollege —— 空学院不算匹配，也不因两边都空而放行', () => {
  const leader = actor(ROLE.STAFF, { college: '体育学院' });
  assert.strictEqual(managesCollege(leader, ''), false);
  assert.strictEqual(managesCollege(actor(ROLE.STAFF, { college: '' }), ''), false);
  assert.strictEqual(managesCollege(actor(ROLE.STAFF, { college: '' }), '体育学院'), false);
});
