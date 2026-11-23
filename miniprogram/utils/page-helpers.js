/**
 * 页面/组件共用的小工具。
 * ============================================================
 * 这些方法原先在十几个页面里逐字复制：改一处（比如给 toast 加时长）
 * 就得改十几处，漏一个就是行为不一致。收在这里，页面只保留同名方法转调，
 * 调用点一行都不用动。
 *
 * 只放「与页面生命周期无关、无状态」的东西；需要 this 的逻辑不要进来。
 */

const schoolSession = require('../services/school-session.js');
const associationScope = require('../services/association-scope.js');
const { LEGACY_SCHOOL_ID } = require('./school.js');

/** 当前学校 + 协会范围。每次现取，调用方不要在异步等待期间缓存。 */
function pageScope() {
  return {
    schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
    association: associationScope.getAssociation(),
  };
}

/** 统一的轻提示。开发者工具与真机都可能没有 wx（测试沙箱），先判存在。 */
function toast(title, icon = 'none') {
  if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon });
  }
}

/** 收起下拉刷新动画。无论成功失败都要调，否则动画会一直转。 */
function stopRefresh() {
  if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
    wx.stopPullDownRefresh();
  }
}

/** 客户端请求编号：同一页面内唯一即可，服务端负责真正的幂等。 */
function requestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { pageScope, toast, stopRefresh, requestId };
