/**
 * 运动会权限判定（B3）
 * ============================================================
 * 与 `school-permission.js` **刻意分开**的一份判定。
 *
 * 【为什么不能复用 manageCollege】
 * 现有学校的 `manageCollege` 允许三类人：校级管理员、**协会负责人**、学院负责人
 * （membership.role='staff' + collegeId）。那是「协会自己的学院赛」的权限口径。
 * 运动会是学校级业务，R11 的要求是「只有学院负责人可以提交正式报名」，
 * 若直接套用 manageCollege：
 *   · 某协会负责人自动获得替学院报运动会的权力（他没被授权过这件事）；
 *   · 一个学院在某协会的 staff 身份也能报名，等于跨协会借权。
 * 交接文档 §7.2 把这点列为「最容易出错的地方」。所以这里只认三样：
 *   平台管理员 / 本校校级管理员 / 本校该学院的**学院部长**（独立授权关系）。
 *
 * 【权限一律现算，不缓存】
 * 页面打开时的权限快照不能作为写入依据。服务层每个写动作都在事务内重读上下文
 * 与授权记录，再调这里判定——撤权立刻生效。
 * ============================================================
 */

const {
  PLATFORM_STATUS, PLATFORM_ROLE, SCHOOL_MEMBER_STATUS, SCHOOL_ROLE,
} = require('../utils/school.js');
const { MEET_COLLEGE_LEAD_STATUS } = require('../utils/meet-scope.js');

/** 账号本身有效（被停用的账号任何动作都不行）。 */
function isActiveActor(ctx) {
  return Boolean(ctx && ctx.actor && ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE);
}

/** 平台管理员：账号级身份，可跨校（R03）。 */
function isPlatformAdminCtx(ctx) {
  return isActiveActor(ctx) && ctx.actor.platformRole === PLATFORM_ROLE.ADMIN;
}

/** 本校在册会员：账号有效 + 学籍在学校且状态 active，且账号主校就是这所学校。 */
function isLocalActiveMember(ctx) {
  // 账号被停用时，学籍记录可能仍是 active（停用的是平台账号，不是学籍）。
  // 这里必须先判账号再判学籍，否则「停用的人还能替学院报名」。
  return Boolean(isActiveActor(ctx) && ctx.schoolMember
    && ctx.schoolMember.status === SCHOOL_MEMBER_STATUS.ACTIVE
    && ctx.actor.primarySchoolId === ctx.schoolId);
}

/** 本校校级管理员：只能管本校（R03）。 */
function isSchoolAdminCtx(ctx) {
  return isLocalActiveMember(ctx) && Boolean(ctx.schoolRole
    && ctx.schoolRole.status === 'active' && ctx.schoolRole.role === SCHOOL_ROLE.ADMIN);
}

/** 能不能读这届运动会：账号有效 + 学校启用。草稿的可见性由服务层再收一层。 */
function meetReadable(ctx) {
  return Boolean(isActiveActor(ctx) && ctx.school && ctx.school.status === 'active');
}

/** 能不能发起 / 配置 / 删除运动会、任命总裁判：校级管理员及以上。 */
function canManageMeet(ctx) {
  return meetReadable(ctx) && (isPlatformAdminCtx(ctx) || isSchoolAdminCtx(ctx));
}

/** 授权记录是否有效：状态 active 且有明确的人。 */
function isActiveMeetLead(leadDoc) {
  return Boolean(leadDoc
    && leadDoc.status === MEET_COLLEGE_LEAD_STATUS.ACTIVE
    && typeof leadDoc.userId === 'string' && leadDoc.userId);
}

/**
 * 这个人是不是该学院当前有效的学院部长。
 *
 * 三个条件缺一不可：记录属于本校、学院对得上、人就是当前操作者。
 * 只判「存在一条 active 记录」而不比对 userId，会让同院另一位被撤权的人继续能写。
 *
 * @param {Object} ctx 运动会上下文
 * @param {Object|null} leadDoc 该学院的授权记录
 * @param {string} collegeId 目标学院
 */
function canLeadCollegeMeet(ctx, leadDoc, collegeId) {
  if (!isLocalActiveMember(ctx) || !collegeId) return false;
  if (!isActiveMeetLead(leadDoc)) return false;
  return leadDoc.schoolId === ctx.schoolId
    && leadDoc.collegeId === collegeId
    && leadDoc.userId === ctx.actorId;
}

/**
 * 能不能替某学院提交正式名单。
 *
 * 只有学院部长可以（R11）。管理员代报是 D13 的**显式例外**，由服务层单独判断
 * 并记录，不在这里默认放行——否则「高级管理员自动覆盖 R11」就会悄悄成立。
 */
function canSubmitForCollege(ctx, leadDoc, collegeId) {
  return canLeadCollegeMeet(ctx, leadDoc, collegeId);
}

/**
 * 是不是**本届**在任的总裁判（B4）。
 *
 * 总裁判随届任命（`sportsMeets` 上的 chiefJudge 字段），只在本届有效：换一届要
 * 重新任命。判定四件事缺一不可——记录在任、就是本人、同一届、同校。
 */
function isChiefJudge(ctx, meet) {
  if (!isLocalActiveMember(ctx)) return false;
  const chief = meet && meet.chiefJudge;
  return Boolean(chief && chief.status === 'active' && chief.userId === ctx.actorId
    && chief.schoolId === ctx.schoolId && chief.meetId === ctx.meetId);
}

/**
 * 能不能审核 / 发布结果 / 重排：校级管理员及以上，或本届被任命的总裁判（B4）。
 *
 * options.chiefJudge 传当届的 chiefJudge 记录（不是布尔量）：调用方在事务内刚
 * 读过 meet，直接透传即可；不传就等于「只认管理员」。
 */
function canPublishMeetResult(ctx, options = {}) {
  if (canManageMeet(ctx)) return true;
  if (!isLocalActiveMember(ctx)) return false;
  // 缺省取上下文里的当届记录（meet-context 已把 sportsMeets 文档放进 ctx.meet）：
  // 调用方不必逐个记得传，少一处漏传就是「总裁判点不动」。
  const chief = options.chiefJudge !== undefined
    ? options.chiefJudge
    : (ctx.meet && ctx.meet.chiefJudge);
  return Boolean(chief && chief.status === 'active' && chief.userId === ctx.actorId
    && chief.schoolId === ctx.schoolId && chief.meetId === ctx.meetId);
}

module.exports = {
  isActiveActor,
  isPlatformAdminCtx,
  isLocalActiveMember,
  isSchoolAdminCtx,
  meetReadable,
  canManageMeet,
  isActiveMeetLead,
  isChiefJudge,
  canLeadCollegeMeet,
  canSubmitForCollege,
  canPublishMeetResult,
};
