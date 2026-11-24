/**
 * 统一有界版本化批任务引擎（G3: VersionedBatchJob）
 * ============================================================
 * 将大批量写入（大签表、百人成绩发布明细、批量派裁判、积分刷新、删组清理等）
 * 收口到同一套分批与版本乐观锁契约：
 *   1. 默认每批总事务操作数上限 `DEFAULT_MAX_OPS_PER_BATCH = 60`（可通过环境变量
 *      `BATCH_JOB_MAX_OPS` 校准，无需改业务代码）；
 *   2. 支持 `startCursor` + `maxBatches` 分步续跑（前端/后台均可接力）；
 *   3. 任意批次发现 `stale: true`（目标版本漂移）或失败即中止并返回确定进度。
 * ============================================================
 */

const DEFAULT_MAX_OPS_PER_BATCH = 60;

function hasNodeEnv() {
  return typeof process !== 'undefined' && Boolean(process) && Boolean(process.env);
}

function resolveMaxOpsPerBatch(override) {
  const HARD_CAP = 90;
  // 业务自身天花板：显式 override 优先（如派裁判的 JUDGE_OPERATION_BUDGET=90），
  // 否则用默认预算。BATCH_JOB_MAX_OPS 是全局校准预算，与业务天花板取较小值：
  // T-06 真云实测若发现平台更严，设一次环境变量即可收紧全部接入点；同时不会
  // 把某个保守场景的批大小反向抬过它自己的天花板。
  const numericOverride = Number(override);
  const businessCap = Number.isFinite(numericOverride) && numericOverride >= 10
    ? Math.min(HARD_CAP, Math.floor(numericOverride))
    : DEFAULT_MAX_OPS_PER_BATCH;
  if (hasNodeEnv()) {
    const raw = process.env.BATCH_JOB_MAX_OPS;
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 10) return Math.min(businessCap, Math.floor(parsed));
    }
  }
  return businessCap;
}

function computeBatchSize({
  opsPerItem = 2,
  fixedOps = 8,
  maxOpsPerBatch,
  maxItemsPerBatch = Infinity,
} = {}) {
  const budget = resolveMaxOpsPerBatch(maxOpsPerBatch);
  const perItem = Math.max(1, Math.floor(Number(opsPerItem) || 1));
  const fixed = Math.max(0, Math.floor(Number(fixedOps) || 0));
  const cap = Number.isFinite(Number(maxItemsPerBatch)) && Number(maxItemsPerBatch) > 0
    ? Math.floor(Number(maxItemsPerBatch))
    : Infinity;
  const available = Math.max(perItem, budget - fixed);
  return Math.max(1, Math.min(cap, Math.floor(available / perItem)));
}

/**
 * 执行带版本守卫与游标续跑的批任务。
 *
 * @param {Object} options
 * @param {Array} options.items 待处理条目
 * @param {number} [options.opsPerItem=2] 每条目在单批事务内的操作数估算
 * @param {number} [options.fixedOps=8] 每批事务的固定读写开销（freshContext/版本校验等）
 * @param {number} [options.maxOpsPerBatch] 覆盖单批操作预算（默认 60）
 * @param {number} [options.maxItemsPerBatch] 单批最大条目上限（可选）
 * @param {number} [options.startCursor=0] 起始游标（0-based 下标）
 * @param {number} [options.maxBatches=Infinity] 本次最多执行几批（用于渐进续跑）
 * @param {Function} options.runBatch async ({ slice, batchIndex, startIndex, endIndex, isLast }) => ({ ok, stale?, written?, skipped?, failed?, message? })
 */
async function runVersionedBatchJob(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  const total = items.length;
  const batchSize = computeBatchSize(options);
  const start = Math.max(0, Math.min(total, Math.floor(Number(options.startCursor) || 0)));
  const maxBatches = Number.isFinite(Number(options.maxBatches)) && Number(options.maxBatches) > 0
    ? Math.floor(Number(options.maxBatches))
    : Infinity;
  const runBatch = options.runBatch;
  if (typeof runBatch !== 'function') {
    throw new Error('runVersionedBatchJob 缺少 runBatch 回调');
  }

  let cursor = start;
  let batches = 0;
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let failed = 0;

  while (cursor < total && batches < maxBatches) {
    const end = Math.min(total, cursor + batchSize);
    const slice = items.slice(cursor, end);
    const isLast = end >= total;
    const res = await runBatch({
      slice,
      batchIndex: batches,
      startIndex: cursor,
      endIndex: end,
      isLast,
    });
    batches += 1;
    if (!res || res.ok === false) {
      failed += slice.length;
      return {
        ok: false,
        done: false,
        stale: Boolean(res && res.stale),
        processed,
        written,
        skipped,
        failed,
        batches,
        batchSize,
        nextCursor: cursor,
        total,
        message: (res && res.message) || '批处理中止',
        extra: res && res.extra,
      };
    }
    processed += slice.length;
    written += Number(res.written || 0);
    skipped += Number(res.skipped || 0);
    cursor = end;
  }

  return {
    ok: true,
    done: cursor >= total,
    stale: false,
    processed,
    written,
    skipped,
    failed,
    batches,
    batchSize,
    nextCursor: cursor,
    total,
    message: '',
  };
}

module.exports = {
  DEFAULT_MAX_OPS_PER_BATCH,
  resolveMaxOpsPerBatch,
  computeBatchSize,
  runVersionedBatchJob,
};
