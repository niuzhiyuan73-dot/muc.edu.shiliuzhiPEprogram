/**
 * 赛季重置 —— 权限
 * ============================================================
 * 「开始新赛季」要回答一个问题：我有没有资格做？
 *
 * 【为什么单独成模块】
 * 与 announcement.js / member-review.js 同一套路数：纯判断，不碰 wx、
 * 不碰数据源，于是每一条边界都能用字面量在 Node 里钉死。云端与本地
 * 共用同一份，免得两边的权限判定各写各的。
 *
 * 【为什么门槛比发布公告高】
 * 发布公告错了，撤下来即可；开始新赛季会把全俱乐部的赛季积分清零，
 * 影响面大且不易察觉。因此这里要求 ROLE.ADMIN，而不是公告用的
 * ROLE.STAFF。
 *
 * 【重置做了什么、没做什么】
 * 只做两件事：记下分界时间、把赛季编号 +1。分界点之前的赛事积分
 * 不计入本赛季（见 school-points-service 的 collectEventPointFacts）。
 * 等级分（ELO）不参与重置，跨赛季连续累计。
 * ============================================================
 */

const { ROLE } = require('../../shared/utils/constants.js');
const { canManage } = require('../../shared/services/permission.js');

/**
 * 有没有开始新赛季的资格。
 *
 * 与审核、公告共用 permission.canManage，只把门槛抬到 ADMIN——
 * 不另写一套判定，免得某天权限规则改了这两处还各说各话。
 *
 * @param {Object|null} actor
 * @param {Object} [options] 透传给 permission.canManage
 * @returns {boolean}
 */
function canResetSeason(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

module.exports = {
  canResetSeason,
};
