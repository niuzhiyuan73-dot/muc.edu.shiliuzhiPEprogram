/**
 * 会员审核页的学校维度视图模型（协议 2，M3-b 页接）
 * ============================================================
 * 与旧栈 member-review-view.js 同一套路数：把权限算在视图模型里，页面拿到的
 * 每一行都自带 canApprove / canReject，页面只照着渲染按钮。取数改走学校维度
 * 的 `getSchoolApplications`（本校待审核台账），不再走旧门面。
 *
 * 【防泄漏闸门】
 * 没有审核权时直接返回 rows: [] 与一句 blockedText，一行申请都不下发——
 * 申请人的实名、学号、学院一旦漏出去就是全名单泄漏。判权由服务端回答
 * （school-identity 的 `canReview`），页面不自己推。
 *
 * 【「已处理」标签页为什么没了】
 * 旧栈的申请台账把驳回过的也留在里面，于是有「待审核 / 已处理」两个标签。
 * 学校维度把「通过」变成在册会员（进 getSchoolMembers 名录）、把「驳回」
 * 留在学校身份记录里但**不另设已驳回列表**（见 school-membership-service
 * 的 getSchoolApplications 说明）。既没有这份数据，就不再摆一个永远空着的
 * 标签——宁可少一个页签，也不给用户一个「驳回记录去哪了」的问号。
 *
 * 【登录态的判定】
 * 这里不再由页面传 user，而是直接读学校维度会话：会话里 `canReview` 就是
 * 服务端的判权结果，`user` 用来分辨「去登录」还是「没这个权限」。
 * ============================================================
 */

const { GENDER_LABEL } = require('../shared/utils/constants.js');
const { formatDateTime } = require('../shared/utils/format.js');
const identity = require('./school-identity.js');

/** 待审核台账的空态文案 */
const PENDING_EMPTY = '没有待审核的入会申请';

/**
 * 整形一条待审核申请。
 *
 * 权限算进数据里（与旧栈 buildApplicationRow 同约定），模板只照渲染按钮。
 * 学校维度不下发手机号，也不给待审件留驳回理由（驳回件不进这份台账），故行里没有
 * 这两项——比留两个永远为空的字段更诚实。
 *
 * @param {Object} application 服务端下发的申请摘要
 * @param {Object} ctx
 * @param {string} [ctx.viewerId] 当前审核者编号
 * @param {boolean} [ctx.canManage] 当前审核者有没有审核权
 * @returns {Object}
 */
function schoolApplicationRow(application, ctx = {}) {
  const { viewerId = '', canManage = false } = ctx;
  const isSelf = Boolean(viewerId && application.userId === viewerId);
  const allowed = Boolean(canManage && !isSelf);

  return {
    // 学校维度用申请人编号成键（审核也按 userId + revision 提交），故它就是行主键
    applicationId: application.userId,
    userId: application.userId,
    revision: Number(application.revision || 0),
    transfer: Boolean(application.transfer),
    transferFromName: application.transferFromName || '',
    // 昵称可能没填，退回实名再退回编号——绝不渲染出 undefined
    nickName: application.nickName || application.realName || application.userId,
    avatarUrl: application.avatarUrl || '',
    realName: application.realName || '',
    // 性别参与定级与单打榜过滤，是审核时该一起核对的信息
    genderText: GENDER_LABEL[application.gender] || '',
    studentId: application.studentId || '',
    college: application.collegeName || '',
    appliedAtText: application.appliedAt ? formatDateTime(application.appliedAt) : '',
    statusLabel: '待审核',
    statusClass: 'is-pending',
    isSelf,
    canApprove: allowed,
    canReject: allowed,
  };
}

/**
 * 装载学校维度会员审核页。
 *
 * @param {Object} options
 * @param {string} options.schoolId 当前学校
 * @param {string} options.association 当前协会（会员审核只按学校取数，协会仅用于范围校验）
 * @returns {Promise<Object>}
 */
async function loadSchoolMemberReviewView(options = {}) {
  const { schoolId, association } = options;
  const api = identity.forSchoolIdentity({ schoolId, association });

  const session = await api.getSchoolIdentitySession();
  const loggedIn = Boolean(session && session.user);
  const viewer = {
    userId: (session && session.user && session.user.userId) || '',
    loggedIn,
  };

  // 闸门：没有审核权就到此为止，绝不把申请人的资料发出去
  if (!session || !session.canReview) {
    return {
      allowed: false,
      blockedText: loggedIn
        ? '当前账号没有审核入会申请的权限，请联系管理员'
        : '请先登录后再审核入会申请',
      viewer,
      rows: [],
      pendingCount: 0,
      emptyText: PENDING_EMPTY,
    };
  }

  const result = await api.getSchoolApplications();
  if (!result || result.ok === false) throw new Error(result && result.message || '入会申请读取失败');
  const applications = (result && result.applications) || [];
  const rows = applications.map((application) =>
    schoolApplicationRow(application, { viewerId: viewer.userId, canManage: true }));

  return {
    allowed: true,
    blockedText: '',
    viewer,
    rows,
    pendingCount: rows.length,
    hasMore: Boolean(result.hasMore),
    emptyText: PENDING_EMPTY,
  };
}

module.exports = {
  PENDING_EMPTY,
  schoolApplicationRow,
  loadSchoolMemberReviewView,
};
