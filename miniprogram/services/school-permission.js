/** 校级能力独立于旧 ROLE.ADMIN 数值。资源归属校验始终先于局部角色。 */
const { PLATFORM_STATUS, PLATFORM_ROLE, SCHOOL_MEMBER_STATUS, SCHOOL_ROLE } = require('../utils/school.js');

/**
 * 可授予的校级权限。三档与三种角色一一对应：
 *   schoolAdmin        写 school_roles（校级管理员）
 *   associationLeader  写 memberships.role='leader'（协会负责人）
 *   collegeLeader      写 memberships.role='staff' + collegeId（学院负责人）
 */
const PERMISSION = Object.freeze({
  SCHOOL_ADMIN: 'schoolAdmin',
  ASSOCIATION_LEADER: 'associationLeader',
  COLLEGE_LEADER: 'collegeLeader',
});

/** 权限的中文名，供界面拼选项与列表标签 */
const PERMISSION_LABEL = Object.freeze({
  schoolAdmin: '校级管理员',
  associationLeader: '协会负责人',
  collegeLeader: '学院负责人',
});

/** 目标没有管理角色时的兜底标签 */
const MEMBER_LABEL = '会员';

/**
 * 目标当前持有的（尚有效的）权限；一个账号最多一档（校级 > 协会 > 学院）。
 * 与 grantablePermissions / 成员列表共用同一套判定，界面标签不会与授权口径分叉。
 *
 * @param {Object|null} schoolRole school_roles 行
 * @param {Object|null} membership memberships 行
 * @returns {string} PERMISSION 之一，或空串（普通会员）
 */
function permissionOf(schoolRole, membership) {
  if (schoolRole && schoolRole.status === 'active' && schoolRole.role === SCHOOL_ROLE.ADMIN) {
    return PERMISSION.SCHOOL_ADMIN;
  }
  if (membership && membership.status === 'active' && membership.role === 'leader') {
    return PERMISSION.ASSOCIATION_LEADER;
  }
  if (membership && membership.status === 'active' && membership.role === 'staff' && membership.collegeId) {
    return PERMISSION.COLLEGE_LEADER;
  }
  return '';
}

function permissionLabelOf(schoolRole, membership) {
  const key = permissionOf(schoolRole, membership);
  return key ? PERMISSION_LABEL[key] : MEMBER_LABEL;
}

/** actor 在本校是否是**在册会员**（管理授权不隐含参赛身份，反之亦然）。 */
function isLocalActiveMember(ctx) {
  return Boolean(ctx && ctx.schoolMember && ctx.schoolMember.status === SCHOOL_MEMBER_STATUS.ACTIVE &&
    ctx.actor && ctx.actor.primarySchoolId === ctx.schoolId);
}

/** 学校与协会都启用时，读接口才谈得上可用（与写接口共用这道前置）。 */
function schoolReadable(ctx) {
  return Boolean(ctx && ctx.actor && ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE &&
    ctx.school && ctx.school.status === 'active' &&
    ctx.schoolAssociation && ctx.schoolAssociation.status === 'active');
}

/**
 * 当前身份是不是**平台管理员**：账号级身份，不随学校变化，可跨校读、跨校管。
 * @param {Object|null} ctx
 * @returns {boolean}
 */
function isPlatformAdminCtx(ctx) {
  return Boolean(ctx && ctx.actor
    && ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE
    && ctx.actor.platformRole === PLATFORM_ROLE.ADMIN);
}

/**
 * 当前身份能不能读这所学校。**所有在册会员都能读任意启用学校**——跨校只读
 * 的门槛就是「有效平台账号 + 目标学校启用」，不含任何管理角色要求。
 * 写接口不放宽：见 grantablePermissions。
 *
 * @param {Object} ctx
 * @returns {boolean}
 */
function canReadSchool(ctx) {
  return schoolReadable(ctx);
}

/**
 * 当前身份**能授予哪些**权限。这是「一个入口、权限不同」的唯一口径：
 *   · 平台管理员：校级管理员 / 协会负责人 / 学院负责人；
 *   · 校级管理员：协会负责人 / 学院负责人（不能再指定同级或更高）；
 *   · 协会负责人：学院负责人。
 * 跨校（非本校在册会员）一律返回空——只读浏览不给授权入口。
 *
 * @param {Object} ctx
 * @returns {string[]} PERMISSION 的子集，按档次从高到低
 */
function grantablePermissions(ctx) {
  if (!schoolReadable(ctx)) return [];
  if (isPlatformAdminCtx(ctx)) {
    return [PERMISSION.SCHOOL_ADMIN, PERMISSION.ASSOCIATION_LEADER, PERMISSION.COLLEGE_LEADER];
  }
  if (!isLocalActiveMember(ctx)) return [];
  const schoolAdmin = ctx.schoolRole && ctx.schoolRole.status === 'active' &&
    ctx.schoolRole.role === SCHOOL_ROLE.ADMIN;
  const leader = ctx.membership && ctx.membership.status === 'active' && ctx.membership.role === 'leader';
  if (schoolAdmin) return [PERMISSION.ASSOCIATION_LEADER, PERMISSION.COLLEGE_LEADER];
  if (leader) return [PERMISSION.COLLEGE_LEADER];
  return [];
}

/**
 * 当前身份能不能授予某一档权限。
 * @param {Object} ctx
 * @param {string} permission PERMISSION 之一
 * @returns {boolean}
 */
function canGrantPermission(ctx, permission) {
  return grantablePermissions(ctx).includes(permission);
}

function canSchoolAction(ctx, action, resource) {
  if (!ctx || !ctx.actor || ctx.actor.platformStatus !== PLATFORM_STATUS.ACTIVE) return false;
  if (!resource || resource.schoolId !== ctx.schoolId) return false;
  if (resource.association && resource.association !== ctx.association) return false;
  if (!ctx.school || ctx.school.status !== 'active' || !ctx.schoolAssociation || ctx.schoolAssociation.status !== 'active') return false;
  const known = ['readMembers', 'participate', 'reviewMembers', 'manageSchool', 'manageAssociation', 'manageCollege'];
  if (!known.includes(action)) return false;
  const memberActive = ctx.schoolMember && ctx.schoolMember.status === SCHOOL_MEMBER_STATUS.ACTIVE &&
    ctx.actor.primarySchoolId === ctx.schoolId;
  // 管理授权不自动赋予参赛身份，平台管理员也必须具备本校有效身份。
  if (action === 'participate') return Boolean(memberActive);
  if (ctx.actor.platformRole === PLATFORM_ROLE.ADMIN) return true;
  if (!memberActive) return false;
  const schoolAdmin = ctx.schoolRole && ctx.schoolRole.status === 'active' && ctx.schoolRole.role === 'admin';
  const membership = ctx.membership && ctx.membership.status === 'active' ? ctx.membership : null;
  if (action === 'readMembers') return true;
  if (action === 'reviewMembers' || action === 'manageSchool') return Boolean(schoolAdmin);
  if (action === 'manageAssociation') return Boolean(schoolAdmin || membership && membership.role === 'leader');
  return Boolean(schoolAdmin || membership && (membership.role === 'leader' ||
    membership.role === 'staff' && resource.collegeId && membership.collegeId === resource.collegeId));
}

module.exports = {
  canSchoolAction,
  canReadSchool,
  schoolReadable,
  isPlatformAdminCtx,
  isLocalActiveMember,
  permissionOf,
  permissionLabelOf,
  grantablePermissions,
  canGrantPermission,
  PERMISSION,
  PERMISSION_LABEL,
  MEMBER_LABEL,
};
