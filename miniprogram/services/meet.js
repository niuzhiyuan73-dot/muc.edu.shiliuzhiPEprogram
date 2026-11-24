/**
 * 运动会门面（mock / cloud 同一套接口）
 * ============================================================
 * 与 exchange.js 同一套写法：按当前数据源选绑定范围的客户端。
 *
 * 【为什么范围里没有 association】
 * 运动会是学校级栏目。这里只拼 `{ schoolId, meetId? }`——与其余三个门面
 * （身份 / 协会空间 / 跨校）刻意不同。若为了复用而塞一个协会参数，云端就会
 * 把它当成「该协会的运动会」，协会停用会连带停用运动会。
 *
 * 【meetId 什么时候传】
 * 列表页、发起、搜项目模板没有「届」，只传 schoolId；
 * 详情页与配置动作必须传 meetId，否则服务端不知道在改哪一届。
 * ============================================================
 */

const identity = require('./school-identity.js');
const cloud = require('./school-cloud.js');
// 演示仓储惰性加载：数据源为 cloud 时用不上（见 school-mock-loader.js）
const { loadSchoolMock } = require('./school-mock-loader.js');
const { meetRequestScope } = require('../shared/utils/meet-scope.js');

/**
 * 取得绑定到某学校的运动会客户端。
 *
 * @param {{schoolId: string, meetId?: string}} scope
 * @returns {Object} 运动会动作集合（12 个）
 */
function forScope(scope) {
  const target = meetRequestScope(scope);
  const client = identity.isMockNow() ? loadSchoolMock().forMeet(target) : cloud.forMeet(target);
  // 运动会页面统一通过 try/catch 呈现失败；通用云端写守卫返回 ok:false 时不能当作成功。
  return Object.freeze(Object.fromEntries(Object.entries(client).map(([name, method]) => [name, async (...args) => {
    const result = await method(...args);
    if (result && result.ok === false) {
      const error = new Error(result.message || result.firstError || '操作失败，请稍后重试');
      error.details = result;
      throw error;
    }
    return result;
  }])));

}

module.exports = { forScope };
