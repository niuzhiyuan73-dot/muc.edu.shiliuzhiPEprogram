/**
 * 客户端统一会话（B3：登录与会话统一）
 * ============================================================
 * 旧栈的「我是谁」散落在 app.globalData.userInfo / 本地缓存 / school-session /
 * school-mock.actorId 多处，登录、退出、切换演示身份各管各的，改一处漏一处。
 * 本模块把「谁是当前登录人」收成一份会话：
 *
 *   · 事实来源只有 S2 的 getSchoolIdentitySession（平台账号 + 学校身份 +
 *     能力布尔量，见 school-membership-service）；
 *   · 为尚未迁移的旧页面派生一份**兼容用户对象**（buildCompatUser），
 *     只做展示形状适配，字段由 S2 会话推导，不伪造、不当授权依据；
 *   · epoch 每次写入 +1，异步请求据此丢弃过期响应（B3 §7.2.6）。
 *
 * 本模块不含 wx、不落盘——持久化（storage）由 app.setUserInfo 负责；
 * 浏览范围（当前学校 / 协会）仍归 school-session / association-scope。
 * 客户端专用（有可变状态），不镜像进云函数。
 * ============================================================
 */

const { ROLE, USER_STATUS } = require('../shared/utils/constants.js');
const { PLATFORM_STATUS } = require('../shared/utils/school.js');

/**
 * 学校身份状态 → 旧栈数字状态（仅用于兼容展示）。
 *
 * 【口径】平台账号停用 → 已禁用；无学校身份 → 待审核（旧栈注册即待审核，
 * 未入会同样只能浏览）；身份已驳回 → 已禁用（与旧栈 rejectMember 置 DISABLED
 * 同口径，且不再误报「待审核」）。已离校 → 已离校。
 * 兼容数字状态只供未迁移页面渲染与 resolveAuthState 判定，任何写路径都以
 * S2 服务端能力为准。
 *
 * @param {Object} session getSchoolIdentitySession 的返回
 * @returns {number|null}
 */
function statusOf(session) {
  const user = session && session.user;
  if (!user) return null;
  if (user.platformStatus === PLATFORM_STATUS.DISABLED) return USER_STATUS.DISABLED;
  const account = session.account;
  if (!account) return USER_STATUS.PENDING;
  const map = {
    pending: USER_STATUS.PENDING,
    active: USER_STATUS.ACTIVE,
    rejected: USER_STATUS.DISABLED,
    disabled: USER_STATUS.DISABLED,
    left: USER_STATUS.LEFT,
  };
  const mapped = map[account.status];
  return mapped === undefined ? USER_STATUS.PENDING : mapped;
}

/**
 * S2 能力档位 → 旧栈数值角色（兼容展示）。
 * 平台管理员 / 校级管理员 / 协会负责人按管理员；学院负责人按学院职员。
 * 与 services/school-actor.js 的 legacyRoleOf 同一口径，只是入口是会话布尔量。
 *
 * @param {Object} session getSchoolIdentitySession 的返回
 * @returns {number}
 */
function roleOf(session) {
  if (!session) return ROLE.MEMBER;
  if (session.isPlatformAdmin) return ROLE.ADMIN;
  const map = {
    schoolAdmin: ROLE.ADMIN,
    associationLeader: ROLE.ADMIN,
    collegeLeader: ROLE.STAFF,
  };
  const role = map[session.permission];
  return role === undefined ? ROLE.MEMBER : role;
}

/**
 * 由 S2 会话派生旧页面认的「用户对象」（单一适配入口，B3 §7.2.4）。
 *
 * 字段全部来自会话（本人账号 + 学校身份）与可选的本协会会员档案（学院全名）。
 * 档案读不到时降级：昵称 / 实名 / 性别仍由会话给出，college 留空——绝不
 * 每页伪造 _id / role / college。
 *
 * @param {Object} dto { session: getSchoolIdentitySession 返回, profile?: getSchoolMember 行 }
 * @returns {Object|null} 旧栈形状的兼容用户；无账号时为 null
 */
function buildCompatUser(dto) {
  const session = dto && dto.session;
  if (!session || !session.user) return null;
  const user = session.user;
  const profile = dto.profile || {};
  const account = session.account || {};
  return {
    _id: user.userId,
    nickName: user.nickName || profile.nickName || user.realName || '',
    avatarUrl: user.avatarUrl || profile.avatarUrl || '',
    realName: user.realName || profile.realName || '',
    gender: user.gender || profile.gender || '',
    college: profile.collegeName || '',
    studentId: account.studentId || '',
    role: roleOf(session),
    status: statusOf(session),
    isGlobalAdmin: Boolean(session.isPlatformAdmin),
  };
}

/** 当前会话 DTO（S2 会话 + 可选档案）；无会话时为 null。 */
let current = null;

/** 会话纪元：每次 apply / clear +1；异步请求凭它丢弃过期响应。 */
let epoch = 0;

/**
 * 写入一份会话。
 * @param {Object} dto { session, profile? }
 * @returns {number} 新的 epoch
 */
function apply(dto) {
  current = dto;
  epoch += 1;
  return epoch;
}

/** 清空会话（退出登录 / 账号不存在时）。 */
function clear() {
  current = null;
  epoch += 1;
  return epoch;
}

/** 当前会话 DTO。 */
function get() {
  return current;
}

/** 当前 epoch，供异步竞态防护。 */
function epochNow() {
  return epoch;
}

/** 是否已登录（存在平台账号会话）。 */
function isLoggedIn() {
  return Boolean(current && current.session && current.session.user);
}

module.exports = {
  statusOf, roleOf, buildCompatUser,
  apply, clear, get, epochNow, isLoggedIn,
};
