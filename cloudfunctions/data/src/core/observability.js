/**
 * 云函数入口观测、追踪与错误分级模块（G1 底座）
 * ============================================================
 * - 使用 AsyncLocalStorage 聚合单次请求内的事务次数、读写量与重试次数；
 * - 统一把 TX_CONFLICT / TX_BUDGET_EXCEEDED / READ_CAP_EXCEEDED 映射为
 *   明确、可操作的中文提示；
 * - 按条件或开关输出单行结构化 JSON 日志。
 * ============================================================
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { fail } = require('../envelope.js');

const traceStorage = new AsyncLocalStorage();

function createTraceId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function runWithTrace(meta, fn) {
  const store = {
    traceId: meta.traceId || createTraceId(),
    action: meta.action || '',
    schoolId: meta.schoolId || '',
    association: meta.association || '',
    openIdHash: meta.openIdHash || '',
    startMs: Number.isFinite(meta.startMs) ? meta.startMs : Date.now(),
    txCount: 0,
    txReads: 0,
    txWrites: 0,
    txRetries: 0,
    maxTxOps: 0,
  };
  return traceStorage.run(store, () => fn(store));
}

function recordTxMetrics({ reads = 0, writes = 0, retries = 0 } = {}) {
  const store = traceStorage.getStore();
  if (!store) return;
  const r = Number(reads) || 0;
  const w = Number(writes) || 0;
  store.txCount += 1;
  store.txReads += r;
  store.txWrites += w;
  store.txRetries += Number(retries) || 0;
  if (r + w > store.maxTxOps) store.maxTxOps = r + w;
}

function getTraceMetrics() {
  return traceStorage.getStore() || null;
}

const ERROR_MESSAGES = Object.freeze({
  TX_CONFLICT: '数据刚刚被他人修改，请刷新后重试',
  TX_BUDGET_EXCEEDED: '单次操作数量超出云端事务限制，请缩小范围或分批处理',
  TX_READ_AFTER_WRITE: '服务端事务执行顺序异常，请稍后重试',
  READ_CAP_EXCEEDED: '本次查询数据量过大，请缩小筛选范围后重试',
});

function mapErrorToFail(err) {
  const code = err && err.code;
  if (code && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    return fail(ERROR_MESSAGES[code]);
  }
  return fail('服务异常，请稍后再试');
}

function shouldEmitStructuredLog(store, hasError) {
  if (hasError) return true;
  if (typeof process !== 'undefined' && process && process.env && process.env.STRUCTURED_LOG === 'all') {
    return true;
  }
  if (!store) return false;
  const durationMs = Date.now() - store.startMs;
  return durationMs >= 1000 || store.txRetries > 0 || store.maxTxOps >= 50;
}

function buildStructuredLog(store, extra = {}) {
  const durationMs = store ? Math.max(0, Date.now() - store.startMs) : 0;
  return {
    level: extra.level || (extra.code ? 'error' : 'info'),
    event: extra.event || 'cloud_request',
    traceId: store ? store.traceId : createTraceId(),
    action: store ? store.action : extra.action || '',
    schoolId: store ? store.schoolId : extra.schoolId || '',
    association: store ? store.association : extra.association || '',
    openIdHash: store ? store.openIdHash : extra.openIdHash,
    durationMs,
    txCount: store ? store.txCount : 0,
    txReads: store ? store.txReads : 0,
    txWrites: store ? store.txWrites : 0,
    txRetries: store ? store.txRetries : 0,
    maxTxOps: store ? store.maxTxOps : 0,
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

module.exports = {
  createTraceId,
  runWithTrace,
  recordTxMetrics,
  getTraceMetrics,
  mapErrorToFail,
  shouldEmitStructuredLog,
  buildStructuredLog,
  ERROR_MESSAGES,
};
