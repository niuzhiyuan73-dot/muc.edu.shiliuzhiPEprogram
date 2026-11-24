/**
 * T-02 (G1) 统一仓储内核、字段级局部更新、冲突自愈、严苛仿真与声明式索引测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyPatch, assertPatchScopeSafe, isPartialUpdateEnabled } = require('../src/server/services/patch-utils.js');
const { isRetryableTxConflict, runTransactionWithRetry } = require('../src/server/services/tx-retry.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo.js');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository.js');
const {
  runWithTrace, recordTxMetrics, mapErrorToFail, shouldEmitStructuredLog, buildStructuredLog,
} = require('../cloudfunctions/data/src/core/observability.js');
const { validateIndexes, checkIndexDocSync, INDEX_FILE, DOC_FILE } = require('../tools/check-db-indexes.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

describe('1. patch-utils 字段级局部更新与安全校验', () => {
  test('支持顶层字段与点路径合并，且不修改原对象', () => {
    const src = { _id: 'm1', name: 'A', seasonPointsByAssociation: { tt: 10 }, extra: { k: 1 } };
    const next = applyPatch(src, { name: 'B', 'seasonPointsByAssociation.pkb': 22, drop: undefined });
    assert.equal(src.name, 'A');
    assert.equal(src.seasonPointsByAssociation.pkb, undefined);
    assert.equal(next.name, 'B');
    assert.equal(next.seasonPointsByAssociation.tt, 10);
    assert.equal(next.seasonPointsByAssociation.pkb, 22);
    assert.equal('drop' in next, false);
  });

  test('拒绝原型链污染路径（__proto__ / constructor / prototype）', () => {
    assert.throws(() => applyPatch({}, { '__proto__.polluted': true }), /非法更新字段路径/);
    assert.throws(() => applyPatch({}, { 'constructor.prototype.x': 1 }), /非法更新字段路径/);
    assert.throws(() => applyPatch({}, { 'a.prototype.b': 1 }), /非法更新字段路径/);
  });

  test('assertPatchScopeSafe 拦截顶层与点路径篡改归属或 _id', () => {
    assert.throws(
      () => assertPatchScopeSafe({ schoolId: 'buaa' }, SCOPE, '不能写入其他学校或协会的数据'),
      /不能写入其他学校或协会的数据/,
    );
    assert.throws(
      () => assertPatchScopeSafe({ 'association.sub': 'tt' }, SCOPE, '不能写入其他学校或协会的数据'),
      /不能写入其他学校或协会的数据/,
    );
    assert.throws(
      () => assertPatchScopeSafe({ _id: 'other' }, SCOPE, '不能写入其他学校或协会的数据', 'id1'),
      /记录 ID 不一致/,
    );
    assert.doesNotThrow(() => assertPatchScopeSafe({ schoolId: 'muc', 'meta.score': 3 }, SCOPE, 'x', 'id1'));
  });

  test('PARTIAL_UPDATE=off 可一键关闭局部更新', () => {
    const prev = process.env.PARTIAL_UPDATE;
    try {
      process.env.PARTIAL_UPDATE = 'off';
      assert.equal(isPartialUpdateEnabled(), false);
      delete process.env.PARTIAL_UPDATE;
      assert.equal(isPartialUpdateEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.PARTIAL_UPDATE;
      else process.env.PARTIAL_UPDATE = prev;
    }
  });
});

describe('2. tx-retry 事务冲突分类与有界抖动退避重试', () => {
  test('准确识别瞬态事务冲突码与文案，排除业务/预算/写后读/缺失集合错误', () => {
    assert.equal(isRetryableTxConflict({ errCode: 112 }), true);
    assert.equal(isRetryableTxConflict({ errCode: -502001 }), true);
    assert.equal(isRetryableTxConflict({ code: 'WRITE_CONFLICT' }), true);
    assert.equal(isRetryableTxConflict(new Error('Transaction aborted due to lock timeout')), true);

    assert.equal(isRetryableTxConflict({ code: 'TX_BUDGET_EXCEEDED', message: 'write conflict' }), false);
    assert.equal(isRetryableTxConflict({ code: 'TX_READ_AFTER_WRITE' }), false);
    assert.equal(isRetryableTxConflict({ errCode: -502005 }), false);
    assert.equal(isRetryableTxConflict(new Error('业务校验失败')), false);
  });

  test('冲突时按指数退避+抖动重试并最终自愈', async () => {
    const delays = [];
    let calls = 0;
    const { result, retries } = await runTransactionWithRetry(async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('WriteConflict');
        err.errCode = 112;
        throw err;
      }
      return 'ok';
    }, {
      maxRetries: 3,
      baseDelayMs: 10,
      random: () => 0.5,
      delay: async (ms) => { delays.push(ms); },
    });
    assert.equal(result, 'ok');
    assert.equal(retries, 2);
    assert.deepEqual(delays, [15, 25]);
  });

  test('重试耗尽抛出 TX_CONFLICT 明确提示；非冲突异常不重试', async () => {
    let bizCalls = 0;
    await assert.rejects(() => runTransactionWithRetry(async () => {
      bizCalls += 1;
      throw new Error('无权操作');
    }, { maxRetries: 3, delay: async () => {} }), /无权操作/);
    assert.equal(bizCalls, 1);

    let conflictCalls = 0;
    await assert.rejects(
      () => runTransactionWithRetry(async () => {
        conflictCalls += 1;
        const err = new Error('WriteConflict');
        err.code = 'WRITE_CONFLICT';
        throw err;
      }, { maxRetries: 2, delay: async () => {} }),
      (err) => err.code === 'TX_CONFLICT' && /刷新后重试/.test(err.message),
    );
    assert.equal(conflictCalls, 3);
  });

  test('TX_RETRY_MAX=0 可关闭重试', async () => {
    const prev = process.env.TX_RETRY_MAX;
    process.env.TX_RETRY_MAX = '0';
    let calls = 0;
    try {
      await assert.rejects(() => runTransactionWithRetry(async () => {
        calls += 1;
        const err = new Error('WriteConflict');
        err.errCode = 112;
        throw err;
      }), (err) => err.code === 'TX_CONFLICT');
      assert.equal(calls, 1);
    } finally {
      if (prev === undefined) delete process.env.TX_RETRY_MAX;
      else process.env.TX_RETRY_MAX = prev;
    }
  });
});

describe('3. 统一内存仓储与云端适配器局部 update / 冲突重试', () => {
  test('school-memory-repo 直接复用 attachSchoolRepository', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mock', 'school-memory-repo.js'), 'utf8');
    assert.match(src, /attachSchoolRepository/);
    assert.equal(src.includes('forMeet = '), false);
    assert.ok(src.split(/\r?\n/).length < 340, '合并内核后 school-memory-repo 应显著瘦身');
  });

  test('局部 update 在双端均支持点路径且不互相覆盖相邻键', async () => {
    const repo = createSchoolMemoryRepo({
      schoolMembers: [{
        _id: 'sm:muc:u1',
        schoolId: 'muc',
        userId: 'u1',
        status: 'active',
        seasonPointsByAssociation: { tt: 8 },
      }],
    });
    const pkb = repo.forScope({ schoolId: 'muc', association: 'pkb' });
    await pkb.schoolMembers.update('sm:muc:u1', { 'seasonPointsByAssociation.pkb': 15 });
    const row = await repo.schoolMembers.getById('sm:muc:u1');
    assert.deepEqual(row.seasonPointsByAssociation, { tt: 8, pkb: 15 });
  });

  test('cloud-repo 在事务内 update 后原地更新读缓存，同事务再读不增加读计数', async () => {
    let getCalls = 0;
    const docs = new Map([['e1', { _id: 'e1', schoolId: 'muc', association: 'pkb', title: '旧', count: 1 }]]);
    const db = {
      command: {},
      runTransaction: async (fn) => fn({
        collection: () => ({
          doc: (id) => ({
            get: async () => { getCalls += 1; return { data: docs.get(id) || null }; },
            set: async ({ data }) => { docs.set(id, { ...data, _id: id }); },
            update: async ({ data }) => { docs.set(id, { ...applyPatch(docs.get(id), data), _id: id }); },
          }),
        }),
      }),
    };
    const repo = createRepo(db);
    const res = await repo.forScope(SCOPE).transaction(async (tx) => {
      await tx.events.update('e1', { title: '新' });
      const after = await tx.events.getById('e1');
      return after;
    });
    assert.equal(getCalls, 1, 'update 后再 getById 应命中事务读缓存，只发起 1 次物理读');
    assert.equal(res.title, '新');
    assert.equal(res.count, 1);
  });

  test('cloud-repo 事务遇 WriteConflict 自动重试并自愈', async () => {
    let txRuns = 0;
    const docs = new Map([['e1', { _id: 'e1', schoolId: 'muc', association: 'pkb', count: 0 }]]);
    const db = {
      command: {},
      runTransaction: async (fn) => {
        txRuns += 1;
        const result = await fn({
          collection: () => ({
            doc: (id) => ({
              get: async () => ({ data: docs.get(id) || null }),
              set: async ({ data }) => { docs.set(id, { ...data, _id: id }); },
              update: async ({ data }) => { docs.set(id, { ...applyPatch(docs.get(id), data), _id: id }); },
            }),
          }),
        });
        if (txRuns === 1) {
          const err = new Error('WriteConflict');
          err.errCode = 112;
          throw err;
        }
        return result;
      },
    };
    const repo = createRepo(db);
    await repo.forScope(SCOPE).transaction(async (tx) => {
      await tx.events.update('e1', { count: 1 });
    }, { baseDelayMs: 0 });
    assert.equal(txRuns, 2);
    assert.equal(docs.get('e1').count, 1);
  });
});

describe('4. 严苛云仿真器（CLOUD_STRICT_SIM）', () => {
  test('严格模式拦截超 100 操作预算并抛出 TX_BUDGET_EXCEEDED', async () => {
    const repo = createSchoolMemoryRepo({}, { strict: true, txBudget: 10 });
    const scoped = repo.forScope(SCOPE);
    await assert.rejects(
      () => scoped.transaction(async (tx) => {
        for (let i = 0; i < 6; i += 1) await tx.events.getById(`ev_${i}`);
        for (let i = 0; i < 6; i += 1) {
          await tx.events.set(`ev_${i}`, { title: `E${i}` }); // 6 reads + 6 writes = 12 > 10
        }
      }),
      (err) => err.code === 'TX_BUDGET_EXCEEDED',
    );
  });

  test('严格模式拦截事务内写后未缓存读（TX_READ_AFTER_WRITE）', async () => {
    const repo = createSchoolMemoryRepo({
      events: [
        { _id: 'e1', schoolId: 'muc', association: 'pkb', title: 'E1' },
        { _id: 'e2', schoolId: 'muc', association: 'pkb', title: 'E2' },
      ],
    }, { strict: true });
    const scoped = repo.forScope(SCOPE);
    await assert.rejects(
      () => scoped.transaction(async (tx) => {
        await tx.events.update('e1', { title: 'E1-new' });
        await tx.events.getById('e2');
      }),
      (err) => err.code === 'TX_READ_AFTER_WRITE',
    );
  });

  test('严格模式允许同一文档先写后读（命中事务读缓存）', async () => {
    const repo = createSchoolMemoryRepo({
      events: [{ _id: 'e1', schoolId: 'muc', association: 'pkb', title: 'E1' }],
    }, { strict: true });
    const scoped = repo.forScope(SCOPE);
    const got = await scoped.transaction(async (tx) => {
      await tx.events.update('e1', { title: 'E1-new' });
      return tx.events.getById('e1');
    });
    assert.equal(got.title, 'E1-new');
  });

  test('严格模式允许先写集合 A 再读集合 B（按集合粒度隔离），同时仍拦截同集合写后读', async () => {
    const repo = createSchoolMemoryRepo({
      events: [{ _id: 'e1', schoolId: 'muc', association: 'pkb', title: 'E1' }],
      seasons: [{ _id: 'scope:muc:pkb', schoolId: 'muc', association: 'pkb', version: 2 }],
    }, { strict: true });
    const scoped = repo.forScope(SCOPE);
    const season = await scoped.transaction(async (tx) => {
      await tx.events.update('e1', { title: 'E1-new' });
      return tx.seasons.getById('scope:muc:pkb');
    });
    assert.equal(season.version, 2);
  });

  test('严格模式支持同集合「先全量点读、再批量写入」的两段式事务', async () => {
    const repo = createSchoolMemoryRepo({
      events: [
        { _id: 'e1', schoolId: 'muc', association: 'pkb', title: 'E1' },
        { _id: 'e2', schoolId: 'muc', association: 'pkb', title: 'E2' },
      ],
    }, { strict: true });
    const scoped = repo.forScope(SCOPE);
    await scoped.transaction(async (tx) => {
      const a = await tx.events.getById('e1');
      const b = await tx.events.getById('e2');
      await tx.events.set('e1', { ...a, title: 'E1-2' });
      await tx.events.set('e2', { ...b, title: 'E2-2' });
    });
    assert.equal((await scoped.events.getById('e1')).title, 'E1-2');
    assert.equal((await scoped.events.getById('e2')).title, 'E2-2');
  });

  test('并发冲突注入后自动丢弃草稿本重跑，最终状态一致不丢更新', async () => {
    let injected = false;
    let attempts = 0;
    const repo = createSchoolMemoryRepo({
      events: [{ _id: 'e1', schoolId: 'muc', association: 'pkb', count: 0 }],
    }, {
      strict: true,
      conflictInjector: async ({ attempt, state, versions, bump }) => {
        if (attempt === 0 && !injected) {
          injected = true;
          state.events.set('e1', { _id: 'e1', schoolId: 'muc', association: 'pkb', count: 10 });
          bump('events');
          assert.ok(versions.get('events') > 0);
        }
      },
    });
    const scoped = repo.forScope(SCOPE);
    await scoped.transaction(async (tx) => {
      attempts += 1;
      const cur = await tx.events.getById('e1');
      await tx.events.update('e1', { count: cur.count + 1 });
    });
    assert.equal(attempts, 2);
    assert.equal((await scoped.events.getById('e1')).count, 11);
  });
});

describe('5. 可观测追踪与错误分级、声明式索引校验', () => {
  test('observability 正确汇总请求内多事务指标并分级映射错误码', () => {
    const { store, log } = runWithTrace({
      traceId: 'tr-1', action: 'drawTeamEvent', schoolId: 'muc', association: 'bk', openIdHash: 'abcd1234',
    }, (s) => {
      recordTxMetrics({ reads: 12, writes: 40, retries: 1 });
      recordTxMetrics({ reads: 3, writes: 5, retries: 0 });
      return {
        store: s,
        log: buildStructuredLog(s, { level: 'info', event: 'cloud_request' }),
      };
    });
    assert.equal(store.txCount, 2);
    assert.equal(store.txReads, 15);
    assert.equal(store.txWrites, 45);
    assert.equal(store.txRetries, 1);
    assert.equal(store.maxTxOps, 52);
    assert.equal(shouldEmitStructuredLog(store, false), true);
    assert.equal(log.traceId, 'tr-1');
    assert.equal(log.maxTxOps, 52);

    assert.match(mapErrorToFail({ code: 'TX_CONFLICT' }).message, /刷新后重试/);
    assert.match(mapErrorToFail({ code: 'TX_BUDGET_EXCEEDED' }).message, /事务限制/);
    assert.match(mapErrorToFail({ code: 'READ_CAP_EXCEEDED' }).message, /数据量过大/);
    assert.equal(mapErrorToFail(new Error('boom')).message, '服务异常，请稍后再试');
  });

  test('声明式索引清单 config/db-indexes.json 校验 0 错误且覆盖所有 52 集合核心范围', () => {
    const doc = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    const errors = validateIndexes(doc);
    assert.deepEqual(errors, []);
    assert.ok(doc.indexes.length >= 60);
    assert.ok(Object.keys(COLLECTIONS).length === 52);
  });

  test('声明式索引自动生成文档与 config/db-indexes.json 一致，且篡改可检出漂移', () => {
    const doc = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    assert.equal(checkIndexDocSync(doc), null);
    const actual = fs.readFileSync(DOC_FILE, 'utf8');
    const tampered = actual.replace('声明索引', '声明索引_篡改');
    assert.match(checkIndexDocSync(doc, tampered), /不一致/);
  });
});
