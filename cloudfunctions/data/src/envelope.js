/**
 * 云函数回包信封
 * ============================================================
 * 【两层 ok 的区别，别搞混】
 * 前端 services/school-cloud.js 的 requestFor 只看顶层 ok：不是 true 就 throw。所以
 *   顶层 ok:false  = 基础设施故障（未知操作、参数坏了、数据库报错）
 *   顶层 ok:true   = 请求被正常处理了，业务成败看 data 里面的 ok
 *
 * 【为什么业务失败不能放顶层】
 * mock 的写接口在业务失败时是「正常 resolve」出一个
 * { ok:false, match:null, message }，页面照着这个形状读。若云端把业务
 * 失败写成顶层 ok:false，页面收到的就变成异常，同一种失败在两种数据源
 * 下的表现会不一样——切数据源就崩，正是这一层要避免的。
 * ============================================================
 */

/**
 * 正常回包。业务对象（含它自己的 ok 字段）原样放进 data。
 * @param {*} data
 * @returns {{ok: true, data: *}}
 */
function ok(data) {
  return { ok: true, data };
}

/**
 * 故障回包。只在「请求本身就处理不了」时使用。
 * @param {string} message 面向用户的中文说明
 * @returns {{ok: false, message: string}}
 */
function fail(message) {
  return { ok: false, message: String(message || '服务异常，请稍后再试') };
}

module.exports = { ok, fail };
