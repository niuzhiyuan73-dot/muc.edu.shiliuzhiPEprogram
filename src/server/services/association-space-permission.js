/**
 * 协会空间的读取、管理、参加资格（纯判定）
 * ============================================================
 * 空间内容（分组、通知、训练、成员名录）比学校浏览更窄：**只有本协会的有效会员
 * 与空间管理者能读**。现有的 canReadSchool 允许任何有效账号跨校只读，直接拿来
 * 放行空间名单会把别协会的内部信息漏出去，所以这里另立一把更严的锁。
 *
 * 【三种资格，互不替代】
 *   · 读空间：本协会有效会员，或空间管理者（含平台管理员）；
 *   · 管空间：学校管理员、协会负责人、平台管理员（复用 manageAssociation）；
 *   · 参加：只有本协会有效会员（平台管理员的管理权不自动赋予参训资格）。
 *
 * 【为什么参加资格不直接用 participate】
 * canSchoolAction 的 participate 只证明「本校有效身份 + 学校协会启用」，与旧
 * 代码里的语义一致，本模块直接复用它作为本协会会员资格的事实来源；活动的小组
 * 限制在它之上叠加（见 association-audience.js）。管理权与参加资格分别判断，
 * 管理者本人要参赛也必须满足 membership 资格。
 * ============================================================
 */

const { canSchoolAction, isPlatformAdminCtx, isLocalActiveMember, schoolReadable } = require('./school-permission.js');

/**
 * 能不能管理本协会空间（建组、选人、发通知、发训练、确认签到）。
 * @param {Object} ctx
 * @returns {boolean}
 */
function canManageAssociationSpace(ctx) {
  return canSchoolAction(ctx, 'manageAssociation', ctx);
}

/**
 * 是不是本协会**有效会员**——能读空间内容、能报名参加活动。
 * 口径：有效平台账号 + 本校有效学校身份 + primarySchoolId 匹配 + 学校与协会启用。
 * @param {Object} ctx
 * @returns {boolean}
 */
function canParticipateInAssociation(ctx) {
  return canSchoolAction(ctx, 'participate', ctx);
}

/**
 * 能不能读取本协会空间内容与成员名录。
 * 比 canReadSchool 严：外校只读浏览不给内部名单。
 * @param {Object} ctx
 * @returns {boolean}
 */
function canReadAssociationSpace(ctx) {
  if (!schoolReadable(ctx)) return false;
  return isPlatformAdminCtx(ctx) || isLocalActiveMember(ctx);
}

module.exports = {
  canManageAssociationSpace,
  canParticipateInAssociation,
  canReadAssociationSpace,
};
