/**
 * 统一数据云函数入口
 * ============================================================
 * 全站只有一个云函数，名为 data。前端把请求包成
 *   { protocolVersion: 2, schoolId, association, action, payload }
 * 这里按协议 2（学校维度）分发，返回
 *   { ok: true, data }  正常（业务失败也在 data.ok 里）
 *   { ok: false, message }  基础设施故障（未知操作、数据库报错等）
 *
 * 【为什么只有一个云函数】
 * 权限校验、身份解析（按 OpenID 查账号）、错误信封只写一份。云函数按
 * 个数计费与部署，散成几十个之后，改一条共用规则要改几十处。
 *
 * 【只有这个文件认识 wx-server-sdk】
 * 业务逻辑全在 src/ 下，不认识云开发，所以能在普通 Node 里跑单元测试。
 * 把 SDK 收在这一层，测试才不需要云环境、也不需要凭据。
 *
 * 【协议 1 已完全下线（P10）】
 * 旧协议（顶层 action + association 的 66 个动作与 dispatch）已删除；
 * 不带 protocolVersion 的请求一律得到「请升级客户端」，不会再执行任何
 * 旧动作。route.js 的判据保留，是为了把「没带版本号」与「版本不对」
 * 的提示分开（2026-10-16 只读审计 H6）。
 *
 * 【时区为什么要在入口钉死（2026-10-17 只读审计 C1）】
 * 云函数容器默认 UTC+0，而小程序端在中国 UTC+8。客户端历史上有几处把
 * 「日期 + 时间选择器」直接拼成 naive 串（无时区后缀）发送，服务端
 * `new Date(naive)` 按运行时区解析——同一个串在云端比客户端意图晚 8 小时，
 * 录分被判「比赛时间不能晚于现在」、赛事与训练的开赛/签到窗口整体偏移。
 * 客户端已改为发送 ISO 绝对串（match-entry-view / event-edit /
 * college-event-edit / association-space-panel 四处），但 naive 串一旦
 * 残留（旧版本客户端、控制台直写），偏移就会回来。官方建议给函数配置
 * 环境变量 TZ=Asia/Shanghai（见同目录 config.json）；这里在模块加载时
 * 再兜底一次：已显式配置则不覆盖，未配置则按北京时间解析。
 *
 * 【仓储为什么要缓存】
 * 云函数容器会热复用。db 句柄建一次就够。冷启动时重建，缓存自然从头来过。
 * ============================================================
 */

// 必须在任何 Date 解析之前执行（模块加载期，早于首个请求）。
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

const { createRepo } = require('./src/adapters/cloud-repo.js');
const { handleSchoolRequest } = require('./src/core/school-request.js');
const { isSchoolRequest } = require('./src/core/route.js');
const { setUgcChecker } = require('./lib/server/services/ugc-safety.js');
const {
  createTraceId, runWithTrace, mapErrorToFail, shouldEmitStructuredLog, buildStructuredLog,
} = require('./src/core/observability.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

if (process.env.UGC_WECHAT_CHECK === 'on'
  && cloud.openapi && cloud.openapi.security && typeof cloud.openapi.security.msgSecCheck === 'function') {
  setUgcChecker(async ({ content, openId, scene }) => cloud.openapi.security.msgSecCheck({
    content,
    version: 2,
    scene: scene || 2,
    openid: openId || undefined,
  }));
}

/**
 * 日志里的用户标识：OpenID 的短哈希。
 *
 * 【为什么不能直接记 OpenID】（2026-10-22 第二轮审查 S-4）
 * OpenID 是微信用户的唯一标识，属于个人信息。云函数日志保留一段时间且对
 * 有控制台权限的人可检索，把明文 OpenID 写进去超出了排障的必要范围。
 * 取 8 位哈希：同一个人每次都映射到同一个值，仍然能按用户串起一次故障的
 * 全部请求，但日志本身不再能反向定位到具体账号。
 *
 * @param {string} openId
 * @returns {string|undefined}
 */
function maskOpenId(openId) {
  if (!openId) return undefined;
  return crypto.createHash('sha1').update(String(openId)).digest('hex').slice(0, 8);
}

/** 容器级仓储单例 */
let repo = null;

// 【启动留痕】（2026-10-27 第八轮审查 P3）
// 这几项都能用环境变量收紧或关闭（限流、读上限、事务预算、上下文缓存）。
// 线上排查「为什么没限流」「为什么读上限是 500」时，先看这一行日志，
// 不必去猜控制台配置改没改过；RATE_LIMIT=off 单独用告警级别打出来。
(function logStartupConfig() {
  const disabled = process.env.RATE_LIMIT === 'off';
  const payload = {
    tz: process.env.TZ,
    rateLimit: disabled ? 'off' : 'on',
    maxReadRows: process.env.MAX_READ_ROWS || '(默认 10000)',
    txBudget: process.env.TX_OPERATION_BUDGET || '(默认 100)',
    contextCacheTtlMs: process.env.CONTEXT_CACHE_TTL_MS || '(默认 5000)',
  };
  if (disabled) console.warn('[data] 启动配置：限流已关闭（RATE_LIMIT=off），仅供压测/验收', payload);
  else console.log('[data] 启动配置', payload);
}());

function getRepo() {
  if (!repo) repo = createRepo(cloud.database());
  return repo;
}

/**
 * 云函数入口。
 * @param {Object} event { protocolVersion, schoolId, association, action, payload }
 * @returns {Promise<Object>} 回包信封
 */
exports.main = async (event = {}) => {
  // 供 catch 里写日志用：openId 只在协议 2 分支取得，旧协议请求本就是空的。
  let openId = '';
  const safeEvent = event && typeof event === 'object' ? event : {};
  const traceId = createTraceId();
  return runWithTrace({
    traceId,
    action: safeEvent.action,
    schoolId: safeEvent.schoolId,
    association: safeEvent.association,
  }, async (traceStore) => {
    try {
      // 只认 protocolVersion（见 src/core/route.js 的说明）。
      if (isSchoolRequest(safeEvent)) {
        const { OPENID, CLIENTIP } = cloud.getWXContext();
        openId = OPENID || '';
        traceStore.openIdHash = maskOpenId(openId) || '';
        // CLIENTIP 只给匿名限流分桶用（见 core/rate-limit.js 的 ANON_LIMITS）。
        const res = await handleSchoolRequest(safeEvent, { repo: getRepo(), openId, clientIp: CLIENTIP || '' });
        if (shouldEmitStructuredLog(traceStore, false)) {
          console.log(JSON.stringify(buildStructuredLog(traceStore, { level: 'info', event: 'cloud_request' })));
        }
        return res;
      }

      // 协议 1 已下线：不带 protocolVersion 的请求不做任何业务。
      return fail('请升级客户端后再使用（需要协议版本 2）');
    } catch (err) {
      traceStore.openIdHash = traceStore.openIdHash || maskOpenId(openId) || '';
      const payload = buildStructuredLog(traceStore, {
        level: 'error',
        event: 'cloud_request_error',
        code: err && err.code,
        error: err && (err.stack || err.message || String(err)),
      });
      console.error(JSON.stringify(payload));
      return mapErrorToFail(err);
    }
  });
};
