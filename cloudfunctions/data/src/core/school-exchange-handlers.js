/**
 * 跨校邀请赛处理器注册表（协议 2）
 * ============================================================
 * 与协会空间处理器并列，由 school-request.js 合并分发；业务实现来自共享库镜像
 * （见 tools/sync-cloud-lib.js），与客户端同一份，避免两边规则分叉。
 *
 * 【为什么现在才注册】
 * S4 实施时用户没有云环境，跨校邀请赛只在本地模拟口径开放，`services/exchange.js`
 * 在非模拟模式下直接拒绝。2026-10-16 用户要求「剩余能力补齐并同步到云函数」，
 * 于是这里把邀请赛的全部动作接进协议 2 分发：客户端换到云数据源后走的就是这些。
 *
 * 【范围仍由协议 2 保证】
 * 邀请赛是跨校的，但每一次请求仍带调用者自己的 schoolId + association：
 * 身份、角色与「本校是否在这场赛事里」都由服务端按该范围复核，客户端传的
 * 学校字段不被信任。
 */
const { SCHOOL_EXCHANGE_ACTIONS, pickActions } = require('../../lib/shared/utils/school-actions.js');
const exchangeService = require('../../lib/server/services/exchange-service.js');

module.exports = Object.freeze(pickActions([exchangeService], SCHOOL_EXCHANGE_ACTIONS));
