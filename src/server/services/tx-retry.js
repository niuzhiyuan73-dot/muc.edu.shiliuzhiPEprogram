/**
 * 云端与仿真器通用的事务冲突分类与有界抖动退避重试（G1 底座）
 * ============================================================
 * 【设计要点】
 *   1. 只对「可识别的瞬态事务锁/写写冲突」重试，业务校验错误、权限错误、
 *      预算超限与写后读违例绝不重试；
 *   2. 冲突判定函数 `isRetryableTxConflict` 可按真云校准结果扩展；
 *   3. `TX_RETRY_MAX=0` 可一键关闭重试，退回旧行为；
 *   4. 传入的 `runOnce` 必须满足「幂等 + 无外部副作用」。
 * ============================================================
 */

const NON_RETRYABLE_CODES = new Set([
  'TX_BUDGET_EXCEEDED',
  'TX_READ_AFTER_WRITE',
  'READ_CAP_EXCEEDED',
  'SCHOOL_INACTIVE',
  'ASSOCIATION_DISABLED',
  -502005,
  '-502005',
]);

const RETRYABLE_CODES = new Set([
  112,
  '112',
  -502001,
  '-502001',
  'WRITE_CONFLICT',
  'TX_CONFLICT',
  'TransientTransactionError',
]);

const RETRYABLE_MSG_RE = /write\s*conflict|transaction\s*(conflict|aborted|lock)|transienttransactionerror|lock\s*timeout/i;

function readEnvInt(name, fallback, min = 0) {
  if (typeof process === 'undefined' || !process || !process.env) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const num = Number(raw);
  return Number.isFinite(num) && num >= min ? Math.floor(num) : fallback;
}

/**
 * 判断错误是否属于可重试的瞬态事务冲突。
 * @param {*} err
 * @returns {boolean}
 */
function isRetryableTxConflict(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.errCode !== undefined ? err.errCode : err.code;
  if (code !== undefined && NON_RETRYABLE_CODES.has(code)) return false;
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;
  const msg = String(err.errMsg || err.message || '');
  return RETRYABLE_MSG_RE.test(msg);
}

/**
 * 带随机抖动的指数退避重试包装器。
 *
 * @param {Function} runOnce (attempt: number) => Promise<*>
 * @param {Object} [options]
 * @param {number} [options.maxRetries] 最大重试次数（默认读 TX_RETRY_MAX 或 3）
 * @param {number} [options.baseDelayMs] 基础退避毫秒数（默认读 TX_RETRY_BASE_MS 或 40）
 * @param {Function} [options.delay] (ms) => Promise<void>
 * @param {Function} [options.random] () => number [0, 1)
 * @param {Function} [options.onRetry] ({ attempt, delayMs, error }) => void
 * @returns {Promise<{result: *, retries: number}>}
 */
async function runTransactionWithRetry(runOnce, options = {}) {
  const maxRetries = Number.isFinite(Number(options.maxRetries)) && Number(options.maxRetries) >= 0
    ? Math.floor(Number(options.maxRetries))
    : readEnvInt('TX_RETRY_MAX', 3, 0);
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs)) && Number(options.baseDelayMs) >= 0
    ? Math.floor(Number(options.baseDelayMs))
    : readEnvInt('TX_RETRY_BASE_MS', 40, 0);
  const wait = typeof options.delay === 'function'
    ? options.delay
    : (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const rand = typeof options.random === 'function' ? options.random : () => Math.random();

  let attempt = 0;
  let lastErr = null;
  for (;;) {
    try {
      const result = await runOnce(attempt);
      return { result, retries: attempt };
    } catch (err) {
      if (!isRetryableTxConflict(err)) throw err;
      lastErr = err;
      if (attempt >= maxRetries) {
        const wrapped = new Error('数据刚刚被他人修改，请刷新后重试');
        wrapped.code = 'TX_CONFLICT';
        wrapped.retries = attempt;
        wrapped.cause = lastErr;
        throw wrapped;
      }
      const jitter = Math.floor(Math.max(0, Math.min(0.9999, Number(rand()) || 0)) * baseDelayMs);
      const delayMs = baseDelayMs * (2 ** attempt) + jitter;
      if (typeof options.onRetry === 'function') {
        options.onRetry({ attempt: attempt + 1, delayMs, error: err });
      }
      await wait(delayMs);
      attempt += 1;
    }
  }
}

module.exports = {
  isRetryableTxConflict,
  runTransactionWithRetry,
};
