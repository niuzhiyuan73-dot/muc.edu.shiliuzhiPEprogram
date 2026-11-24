/**
 * 学校身份演示仓储（复用统一仓储内核 + 严苛云端仿真器）。
 * 写事务串行排队 + 冲突重试 + 可选严苛模式（CLOUD_STRICT_SIM=1）。
 */
const { compareCode } = require('../shared/utils/text-order.js');
const { SCHOOL_COLLECTIONS, attachSchoolRepository } = require('../../src/server/services/school-repository.js');
const { EVENT_SCOPED, ALL_COLLECTIONS } = require('../../src/server/services/school-collections.js');
const { applyPatch } = require('../../src/server/services/patch-utils.js');
const { runTransactionWithRetry } = require('../../src/server/services/tx-retry.js');
const { memoryMatchPage } = require('../../src/server/services/match-list-query');
const { fieldValues } = require('../../src/server/services/scoped-team-reads.js');
const { memoryDirectoryPage, memoryDirectoryCount } = require('../../src/server/services/account-directory.js');
const { memoryPersonalPage } = require('../../src/server/services/personal-sports-query.js');
const { memoryOverviewIO } = require('../../src/server/services/school-overview-reads.js');
const { pageOfCollection } = require('../../src/server/services/event-list-page.js');

const KEYS = ALL_COLLECTIONS;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function envFlag(name) {
  if (typeof process === 'undefined' || !process) return '';
  const env = process['env'];
  return env ? String(env[name] || '') : '';
}

const CMD = Symbol('db.command');
const command = {
  gte: (value) => ({ [CMD]: 'gte', value }),
  lte: (value) => ({ [CMD]: 'lte', value }),
  lt: (value) => ({ [CMD]: 'lt', value }),
  neq: (value) => ({ [CMD]: 'neq', value }),
  or: (value) => ({ [CMD]: 'or', value }),
  exists: (value) => ({ [CMD]: 'exists', value }),
  gt: (value) => ({ [CMD]: 'gt', value }),
  in: (value) => ({ [CMD]: 'in', value }),
  and: (value) => ({ [CMD]: 'and', value }),
};
const isCommand = (value) => Boolean(value && value[CMD]);

const toTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

const compare = (left, right) => {
  const a = toTime(left);
  const b = toTime(right);
  if (a !== null && b !== null) return a - b;
  return compareCode(left, right);
};

function matchWhere(doc, where) {
  if (!where) return true;
  if (isCommand(where)) {
    if (where[CMD] === 'and') return where.value.every((part) => matchWhere(doc, part));
    if (where[CMD] === 'or') return where.value.some((part) => matchWhere(doc, part));
    return false;
  }
  return Object.keys(where).every((field) => {
    const cond = where[field];
    if (!isCommand(cond)) return fieldValues(doc, field).includes(cond);
    if (cond[CMD] === 'and') return cond.value.every((part) => matchWhere(doc, part));
    if (cond[CMD] === 'in') return Array.isArray(cond.value) && fieldValues(doc, field).some((v) => cond.value.includes(v));
    if (cond[CMD] === 'gte') return compare(doc[field], cond.value) >= 0;
    if (cond[CMD] === 'lte') return compare(doc[field], cond.value) <= 0;
    if (cond[CMD] === 'lt') return compare(doc[field], cond.value) < 0;
    if (cond[CMD] === 'neq') return doc[field] !== cond.value;
    if (cond[CMD] === 'gt') return compare(doc[field], cond.value) > 0;
    if (cond[CMD] === 'exists') return (doc[field] !== undefined) === Boolean(cond.value);
    return false;
  });
}

const WRITE_METHODS = new Set(['set', 'insert', 'update', 'remove']);

function withWriteHook(ops, key, onWrite) {
  const out = {};
  for (const [name, fn] of Object.entries(ops)) {
    out[name] = WRITE_METHODS.has(name) && typeof fn === 'function'
      ? (...args) => { onWrite(key); return fn(...args); }
      : fn;
  }
  return out;
}

function createSchoolMemoryRepo(seed = {}, options = {}) {
  let state = Object.fromEntries(KEYS.map((key) => [key, new Map((seed[key] || []).map((doc) => [doc._id, clone(doc)]))]));
  const versions = new Map();
  const bump = (key) => versions.set(key, (versions.get(key) || 0) + 1);

  const strict = options.strict !== undefined ? Boolean(options.strict) : envFlag('CLOUD_STRICT_SIM') === '1';
  const rawBudget = Number(options.txBudget || envFlag('TX_OPERATION_BUDGET'));
  const txBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.min(100, Math.floor(rawBudget)) : 100;
  const enforceReadBeforeWrite = options.enforceReadBeforeWrite !== undefined
    ? Boolean(options.enforceReadBeforeWrite) : strict;

  const build = (getState, inTx, onWrite, txTracker) => {
    const recordRead = (key, id) => {
      if (!inTx || !txTracker) return clone(getState()[key].get(id) || null);
      const cacheKey = `${key}\0${id}`;
      if (!txTracker.reads.has(cacheKey)) {
        if (enforceReadBeforeWrite && txTracker.writtenCollections.has(key)) {
          const err = new Error(`事务内同集合写后读违例（${key}:${id}）：请将同集合读取提前到该集合首次写入之前`);
          err.code = 'TX_READ_AFTER_WRITE';
          throw err;
        }
        txTracker.stats.reads += 1;
        txTracker.guardBudget();
        txTracker.reads.set(cacheKey, clone(getState()[key].get(id) || null));
      }
      return clone(txTracker.reads.get(cacheKey));
    };

    const recordWrite = (key, id, nextDoc) => {
      if (onWrite) onWrite(key);
      if (!inTx || !txTracker) return;
      txTracker.writtenCollections.add(key);
      txTracker.stats.writes += 1;
      txTracker.guardBudget();
      const cacheKey = `${key}\0${id}`;
      txTracker.reads.set(cacheKey, nextDoc ? clone(nextDoc) : null);
    };

    const read = async (key, id) => recordRead(key, id);

    const list = (key) => {
      if (inTx) throw new Error(`事务内不允许整表读取（${key}），请改用 getById`);
      return [...getState()[key].values()].map(clone);
    };

    const repo = { inTx: Boolean(inTx) };
    for (const key of KEYS) {
      repo[key] = {
        getById: (id) => read(key, id),
        set: async (id, doc) => {
          const next = clone({ ...doc, _id: id });
          recordWrite(key, id, next);
          getState()[key].set(id, next);
        },
        remove: async (id) => {
          recordWrite(key, id, null);
          getState()[key].delete(id);
        },
        list: async () => list(key),
      };
    }

    repo.memberships.get = repo.memberships.getById;
    repo.seasons.update = async (id, patch) => {
      const cur = clone(getState().seasons.get(id) || null);
      if (!cur) throw new Error('记录不存在或不属于当前范围');
      const next = clone({ ...applyPatch(cur, patch), _id: id });
      recordWrite('seasons', id, next);
      getState().seasons.set(id, next);
    };
    repo.schoolMembers.update = async (id, patch) => {
      const cur = clone(getState().schoolMembers.get(id) || null);
      if (!cur) throw new Error('记录不存在或不属于当前范围');
      const next = clone({ ...applyPatch(cur, patch), _id: id });
      recordWrite('schoolMembers', id, next);
      getState().schoolMembers.set(id, next);
    };
    repo.users.listByIds = async (ids) => {
      const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))];
      const out = [];
      for (const id of uniq) {
        const doc = await read('users', id);
        if (doc) out.push(doc);
      }
      return out;
    };
    repo.users.getByOpenId = async (openId) => (await repo.users.list())
      .filter((user) => user.openId === openId)
      .sort((a, b) => compareCode(a._id, b._id))[0] || null;
    repo.audit = {
      append: async (entry) => {
        if (!entry._id) throw new Error('审计记录缺少 ID');
        await repo.auditLogs.set(entry._id, entry);
      },
    };

    const overview = memoryOverviewIO((key) => [...getState()[key].values()].map(clone));
    const built = attachSchoolRepository(repo, {
      cmd: command,
      memberPage: async (scope, opts) => memoryDirectoryPage(list('schoolMembers'), list('users'), scope, opts),
      memberCount: async (scope, opts) => memoryDirectoryCount(list('schoolMembers'), list('users'), scope, opts),
      personalPage: async (source, auth, query) => memoryPersonalPage(list, source, auth, query),
      matchPage: async (scope, opts) => memoryMatchPage(list('matches'), scope, opts),
      read,
      set: async (key, id, doc) => {
        const next = clone({ ...doc, _id: id });
        recordWrite(key, id, next);
        getState()[key].set(id, next);
      },
      update: async (key, id, patch) => {
        const cur = getState()[key].get(id);
        if (!cur) throw new Error('记录不存在或不属于当前范围');
        const next = clone({ ...applyPatch(cur, patch), _id: id });
        recordWrite(key, id, next);
        getState()[key].set(id, next);
      },
      remove: async (key, id) => {
        recordWrite(key, id, null);
        getState()[key].delete(id);
      },
      query: async (key, where) => {
        const isScopeOnlyQuery = where && !Array.isArray(where) && typeof where === 'object'
          && !where.$and
          && Object.keys(where).every((k) => k === 'schoolId' || k === 'association' || k === 'meetId');
        const rows = (!inTx && isScopeOnlyQuery && repo[key] && typeof repo[key].list === 'function')
          ? await repo[key].list()
          : list(key);
        return rows.filter((doc) => matchWhere(doc, where));
      },
      byIds: async (key, ids, scopeFields = {}) => {
        if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
        const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))];
        return uniq
          .map((id) => getState()[key].get(id))
          .filter((doc) => doc && Object.entries(scopeFields).every(([field, value]) => doc[field] === value))
          .map(clone);
      },
      top: async (key, where, order, limit, offset = 0) => {
        const rows = list(key).filter((doc) => matchWhere(doc, where));
        rows.sort((a, b) => {
          for (const rule of (order || [])) {
            const diff = compare(a[rule.field], b[rule.field]);
            if (diff !== 0) return rule.direction === 'desc' ? -diff : diff;
          }
          return 0;
        });
        const skip = Math.max(0, Number(offset) || 0);
        return rows.slice(skip, skip + Math.max(1, Number(limit) || 1));
      },
      count: async (key, where) => list(key).filter((doc) => matchWhere(doc, where)).length,
    }, inTx);

    // 还原各集合基础 list()，避免 io.query -> built[key].list 递归，同时保留测试对 repo[key].list 的拦截钩子
    for (const key of SCHOOL_COLLECTIONS) {
      if (built[key]) built[key].list = async () => list(key);
    }

    // 补充顶层快捷查询（与旧模拟端保持 100% 接口一致）
    built.liveScores.listByIds = async (ids) => {
      const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))];
      const out = [];
      for (const id of uniq) {
        const doc = await read('liveScores', id);
        if (doc) out.push(doc);
      }
      return out;
    };
    built.memberships.listByUser = async (userId) => {
      if (typeof userId !== 'string' || !userId) return [];
      return (await built.memberships.list()).filter((doc) => doc.userId === userId);
    };
    for (const key of EVENT_SCOPED) {
      built[key].listByEvent = async (eventId) => {
        if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
        return (await built[key].list()).filter((doc) => doc.eventId === eventId);
      };
    }
    // 兼容 forScope 概览直挂方法（由 attachOverviewReads / pageOfCollection 在受范围面提供）
    void overview;
    void pageOfCollection;

    if (onWrite) {
      for (const [key, ops] of Object.entries(built)) {
        if (SCHOOL_COLLECTIONS.includes(key) || !ops || typeof ops !== 'object') continue;
        built[key] = withWriteHook(ops, key, onWrite);
      }
    }
    return built;
  };

  const repo = build(() => state, false, bump, null);

  let queue = Promise.resolve();
  repo.transaction = (fn, txOptions = {}) => {
    const task = queue.then(async () => {
      const retryOpts = {
        maxRetries: txOptions.maxRetries !== undefined ? txOptions.maxRetries
          : (options.maxRetries !== undefined ? options.maxRetries : 3),
        baseDelayMs: txOptions.baseDelayMs !== undefined ? txOptions.baseDelayMs : 0,
      };
      const injector = txOptions.conflictInjector || options.conflictInjector;

      const { result } = await runTransactionWithRetry(async (attempt) => {
        const scratch = Object.fromEntries(KEYS.map((key) => [key, new Map(state[key])]));
        const startVersions = new Map(versions);
        const written = new Set();
        const txTracker = {
          reads: new Map(),
          stats: { reads: 0, writes: 0 },
          writtenCollections: new Set(),
          guardBudget: () => {
            if (!strict) return;
            if (txTracker.stats.reads + txTracker.stats.writes > txBudget) {
              const err = new Error(`事务读写总操作预算不足（读 ${txTracker.stats.reads} / 写 ${txTracker.stats.writes}，上限 ${txBudget}）：请缩小本次处理范围`);
              err.code = 'TX_BUDGET_EXCEEDED';
              throw err;
            }
          },
        };

        const out = await fn(build(() => scratch, true, (key) => written.add(key), txTracker));

        if (typeof injector === 'function') {
          await injector({ attempt, written, state, versions, bump });
        }

        for (const key of written) {
          if ((versions.get(key) || 0) !== (startVersions.get(key) || 0)) {
            const err = new Error('WriteConflict: concurrent modification');
            err.code = 'WRITE_CONFLICT';
            throw err;
          }
        }

        state = scratch;
        for (const key of written) versions.set(key, (startVersions.get(key) || 0) + 1);
        return out;
      }, retryOpts);

      return result;
    });
    queue = task.catch(() => {});
    return task;
  };

  return repo;
}

module.exports = { createSchoolMemoryRepo };
