/**
 * 跨校邀请赛门面
 * ============================================================
 * 与协会空间门面同一套写法：按当前数据源选绑定范围的客户端。
 *
 * 【2026-10-16 起云端已开放】
 * 此前非模拟模式直接抛「跨校邀请赛尚未开放云端」——因为 S4 落地时没有云环境，
 * 云端也没注册跨校 action。现在服务实现已随共享库镜像上云、协议 2 分发里也
 * 注册了这些动作（见 cloudfunctions/data/src/core/school-exchange-handlers.js），
 * 于是这里按数据源直接选择，与「协会空间」保持一致：不再有「只有本地能用」的功能。
 *
 * 仍要提醒的是：邀请赛的任何动作都不写校内 events / matches，也不产生校内等级分
 * 与积分（服务端强制 eventScope=inter_school、ratingPolicy=unrated）。
 */
const identity = require('../../services/school-identity.js');
const cloud = require('../../services/school-cloud.js');
// 演示仓储惰性加载（数据源为 cloud 时用不上）：见 school-mock-loader.js 与
// 2026-10-16 只读审计 H7。
const { loadSchoolMock } = require('../../services/school-mock-loader.js');

/**
 * 取得绑定到某学校某协会的邀请赛客户端。
 * @param {{schoolId: string, association: string}} scope
 * @returns {Object} 邀请赛动作集合
 */
function forScope(scope) {
  return identity.isMockNow() ? loadSchoolMock().forExchange(scope) : cloud.forExchange(scope);
}

module.exports = { forScope };
