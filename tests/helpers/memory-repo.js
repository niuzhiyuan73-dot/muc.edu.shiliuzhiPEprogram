/**
 * 内存仓储（仅测试用）
 * ============================================================
 * 实现 cloudfunctions/data/src/repository.js 约定的接口，但数据放在 Map 里。
 * 有了它，云函数的核心逻辑不需要云环境、不需要凭据、不需要网络就能测——
 * 这是当初把业务逻辑与 wx-server-sdk 隔开的全部回报。
 *
 * 【事务怎么模拟】
 * 微信云开发的事务提供「读已提交 + 冲突重试」。这里照样模拟：
 *   · 事务开始时把每个集合作一份浅拷贝当作草稿本，处理器在草稿本上读写；
 *   · 正常返回就把草稿本换回仓库，抛错就整份丢掉；
 *   · 提交前做冲突检测——本事务写过的集合若被外部（非事务）写入抢先改过
 *     版本，就把草稿本整份丢弃、重跑事务（最多 5 次），与真库的冲突重试一致
 *     （见 §9.2；写版本号由每个集合的写计数维护）。
 *
 * 浅拷贝是安全的：处理器从不就地修改读到的文档，一律 spread 出新的
 * （cloud-repo.js 那边也是同样的纪律，因为云开发的事务也要求这样）。
 *
 * 【为什么 set 要补上 _id】
 * 云开发按 doc(id) 写入时 id 来自路径，文档里不存 _id 字段，读回来时
 * 由 SDK 补上。内存版没有路径这一层，于是在写入时补，读出来才一致。
 * ============================================================
 */

/** 浅拷贝一条文档。null / 原始值原样返回。 */
const { SCHOOL_COLLECTIONS, attachSchoolRepository } = require('../../cloudfunctions/data/src/school-repository.js');
const { memoryMatchPage } = require('../../miniprogram/services/match-list-query');
const { fieldValues } = require('../../miniprogram/services/scoped-team-reads');
const { memoryDirectoryPage, memoryDirectoryCount } = require('../../miniprogram/services/account-directory');
const { memoryPersonalPage } = require('../../miniprogram/services/personal-sports-query');

function clone(doc) {
  return doc === null || typeof doc !== 'object' ? doc : { ...doc };
}

/**
 * 极简 `db.command` 替身：只实现学校仓储实际用到的操作符（gte / gt / in / and）。
 *
 * 【为什么必须有】（2026-10-21）
 * 云端 `matches.listSince` 把 `matchTime >= 分界点` 下推成 `cmd.gte(...)`
 * （名单里原名 listRatedSince，2026-10-22 以不带 status 过滤的形态重新落地）。
 * 内存仓储若把那个对象当成「等于某个对象」来比，条件恒假、录分页的交手次数会
 * **静默变空**——这类「本地绿、云端对」的分叉正是这组契约测试要防的。
 */
const CMD = Symbol('db.command');
const command = {
  gte: (value) => ({ [CMD]: 'gte', value }),
  lte: (value) => ({ [CMD]: 'lte', value }),
  lt: (value) => ({ [CMD]: 'lt', value }),
  neq: (value) => ({ [CMD]: 'neq', value }),
  or: (value) => ({ [CMD]: 'or', value }),
  // 字段是否存在：用于数「回填前的历史文档」（没有 memberStatus 的那些）。
  exists: (value) => ({ [CMD]: 'exists', value }),
  gt: (value) => ({ [CMD]: 'gt', value }),
  in: (value) => ({ [CMD]: 'in', value }),
  and: (value) => ({ [CMD]: 'and', value }),
};
const isCommand = (value) => Boolean(value && value[CMD]);
/** 值转时间戳：Date 与 ISO 串都认，认不出返回 null（退化为字符串比较）。 */
const toTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};
const compare = (left, right) => {
  const a = toTime(left);
  const b = toTime(right);
  if (a !== null && b !== null) return a - b;
  return String(left === null || left === undefined ? '' : left)
    .localeCompare(String(right === null || right === undefined ? '' : right));
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
    if (cond[CMD] === 'in') return Array.isArray(cond.value) && fieldValues(doc, field).some(value => cond.value.includes(value));
    if (cond[CMD] === 'gte') return compare(doc[field], cond.value) >= 0;
    if (cond[CMD] === 'lte') return compare(doc[field], cond.value) <= 0;
    if (cond[CMD] === 'lt') return compare(doc[field], cond.value) < 0;
    if (cond[CMD] === 'neq') return doc[field] !== cond.value;
    if (cond[CMD] === 'gt') return compare(doc[field], cond.value) > 0;
    if (cond[CMD] === 'exists') return (doc[field] !== undefined) === Boolean(cond.value);
    return false;
  });
}

/** 会改动数据的集合方法名（用于给基础集合自动挂上「写」钩子） */
const WRITE_METHODS = new Set(['set', 'insert', 'update', 'remove']);

/**
 * 给一个集合的操作对象套上「写钩子」：任何写方法被调用时先记一笔。
 * 只读方法（list / getById / get / listByEvent …）原样透传。
 */
function withWriteHook(ops, key, onWrite) {
  const out = {};
  for (const [name, fn] of Object.entries(ops)) {
    out[name] = WRITE_METHODS.has(name) && typeof fn === 'function'
      ? (...args) => { onWrite(key); return fn(...args); }
      : fn;
  }
  return out;
}

/**
 * 每个集合的形状：有 _id 的用 Map 存，纯追加日志用数组。
 * 键名与 repository.js 里的逻辑名一致。
 */
function emptyStore() {
  return {
    ...Object.fromEntries(SCHOOL_COLLECTIONS.map((key) => [key, new Map()])),
    users: new Map(),
    matches: new Map(),
    events: new Map(),
    eventSignups: new Map(),
    collegeEvents: new Map(),
    collegeEntries: new Map(),
    ties: new Map(),
    lineups: new Map(),
    liveScores: new Map(),
    announcements: new Map(),
    memberships: new Map(),
    seasons: new Map(),
    auditLogs: [],
  };
}

/**
 * 建一个内存仓储。
 *
 * @param {Object} [seed] { users, matches, events, announcements, seasons }，均为文档数组
 * @returns {Object} 仓储
 */
function createMemoryRepo(seed = {}) {
  const store = emptyStore();

  for (const key of Object.keys(store)) {
    const docs = seed[key];
    if (!docs) continue;
    if (key === 'auditLogs') {
      store[key] = docs.map(clone);
      continue;
    }
    for (const doc of docs) store[key].set(doc._id, clone(doc));
  }

  // 【集合写版本号：模拟真库的「读已提交 + 冲突重试」】
  // 每个集合一个单调递增的写计数。事务开始时记下各集合的版本，提交前若发现
  // 本事务写过的集合被「外部（非事务）写入」改过版本，就丢弃草稿本、重跑事务。
  // 这补上了 §9.2 的 conflict 模拟：让「报名事务同步更新 membershipRevision」
  // 这类依赖写写冲突的保护能够在测试里真正被触发，而不是只靠串行化蒙混过去。
  const versions = new Map();
  const bump = (key) => versions.set(key, (versions.get(key) || 0) + 1);

  /**
   * 在某个目标上组装集合操作。目标可以是真仓库，也可以是事务草稿本。
   * @param {Object} target
   * @param {boolean} inTx
   * @param {Function} [onWrite] 每次写集合时回调，参数为集合名
   */
  function collections(target, inTx, onWrite) {
    const list = (key) => {
      if (inTx) throw new Error(`事务内不允许整表读取（${key}），请改用 getById`);
      return [...target[key].values()].map(clone);
    };

    const read = (key, id) => {
      const doc = target[key].get(id);
      return Promise.resolve(doc ? clone(doc) : null);
    };

    const repo = {
      users: {
        list: () => list('users'),
        getById: (id) => read('users', id),
        // 按一批编号取账号（与云端 users.listByIds 同口径）。业务用它替掉
        // 「读全平台 users 再建 Map」，避免测试里也跑出全表读的假象。
        listByIds: async (ids) => {
          const uniq = [...new Set((Array.isArray(ids) ? ids : [])
            .filter((id) => typeof id === 'string' && id))];
          return uniq.map((id) => target.users.get(id)).filter(Boolean).map(clone);
        },
        getByOpenId: async (openId) => {
          if (!openId) return null;
          for (const doc of target.users.values()) {
            if (doc.openId === openId) return clone(doc);
          }
          return null;
        },
        set: async (id, doc) => {
          target.users.set(id, { ...doc, _id: id });
        },
      },

      matches: {
        list: () => list('matches'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
          return [...target.matches.values()].filter((doc) => doc.eventId === eventId).map(clone);
        },
        getById: (id) => read('matches', id),
        insert: async (doc) => {
          target.matches.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.matches.get(id);
          if (!current) throw new Error(`更新失败：找不到比赛 ${id}`);
          target.matches.set(id, { ...current, ...patch });
        },
      },

      events: {
        list: () => list('events'),
        getById: (id) => read('events', id),
        insert: async (doc) => {
          target.events.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.events.get(id);
          if (!current) throw new Error(`更新失败：找不到赛事 ${id}`);
          target.events.set(id, { ...current, ...patch });
        },
      },

      eventSignups: {
        list: () => list('eventSignups'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（eventSignups），请改用 getById');
          return [...target.eventSignups.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('eventSignups', id),
        insert: async (doc) => {
          target.eventSignups.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.eventSignups.get(id);
          if (!current) throw new Error(`更新失败：找不到报名记录 ${id}`);
          target.eventSignups.set(id, { ...current, ...patch });
        },
      },

      collegeEvents: {
        list: () => list('collegeEvents'),
        getById: (id) => read('collegeEvents', id),
        insert: async (doc) => {
          target.collegeEvents.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.collegeEvents.get(id);
          if (!current) throw new Error(`更新失败：找不到学院赛 ${id}`);
          target.collegeEvents.set(id, { ...current, ...patch });
        },
      },

      collegeEntries: {
        list: () => list('collegeEntries'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（collegeEntries），请改用 getById');
          return [...target.collegeEntries.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('collegeEntries', id),
        insert: async (doc) => {
          target.collegeEntries.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.collegeEntries.get(id);
          if (!current) throw new Error(`更新失败：找不到学院名单 ${id}`);
          target.collegeEntries.set(id, { ...current, ...patch });
        },
      },

      ties: {
        list: () => list('ties'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（ties），请改用 getById');
          return [...target.ties.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('ties', id),
        insert: async (doc) => {
          target.ties.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.ties.get(id);
          if (!current) throw new Error(`更新失败：找不到大场 ${id}`);
          target.ties.set(id, { ...current, ...patch });
        },
      },

      lineups: {
        list: () => list('lineups'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（lineups），请改用 getById');
          return [...target.lineups.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('lineups', id),
        insert: async (doc) => {
          target.lineups.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.lineups.get(id);
          if (!current) throw new Error(`更新失败：找不到排阵 ${id}`);
          target.lineups.set(id, { ...current, ...patch });
        },
      },

      // 实时比分：一场一条，_id = 'ls_' + matchId。与 cloud-repo 一样不提供
      // list / listByEvent——写入与轮询都按编号定位，事务内外都够用。
      liveScores: {
        getById: (id) => read('liveScores', id),
        // 轮询与比赛列表都要按一批编号读实时比分（云端是 `_.in` 一次批查）。
        // 桩里缺这个方法时，业务一旦走到批读就 TypeError——本地绿、云端对，
        // 属于最难查的那类差异（2026-10-23 第三轮 X-3 补）。
        listByIds: (ids) => [...new Set((Array.isArray(ids) ? ids : [])
          .filter(id => typeof id === 'string' && id))]
          .map(id => target.liveScores.get(id)).filter(Boolean).map(clone),
        insert: async (doc) => {
          target.liveScores.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.liveScores.get(id);
          if (!current) throw new Error(`更新失败：找不到实时比分 ${id}`);
          target.liveScores.set(id, { ...current, ...patch });
        },
      },

      announcements: {
        list: () => list('announcements'),
        getById: (id) => read('announcements', id),
        insert: async (doc) => {
          target.announcements.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.announcements.get(id);
          if (!current) throw new Error(`更新失败：找不到公告 ${id}`);
          target.announcements.set(id, { ...current, ...patch });
        },
      },

      memberships: {
        list: () => list('memberships'),
        listByUser: (userId) => {
          if (inTx) throw new Error('事务内不允许条件读取（memberships），请改用 get');
          return [...target.memberships.values()]
            .filter((doc) => doc.userId === userId)
            .map(clone);
        },
        get: (id) => read('memberships', id),
        set: async (id, doc) => {
          target.memberships.set(id, { ...doc, _id: id });
        },
        remove: async (id) => {
          target.memberships.delete(id);
        },
      },

      seasons: {
        // 2026-10-28 第十轮只读审计 P2：这里从前只有 get/set，而共享服务写的是
        // `repo.seasons.getById(...)`（赛季文档是「每范围一份」的点读，没有条件查询
        // 的需求）。于是这套桩下一调赛季就读到 `getById is not a function`，五个动作
        // （getSchoolSeason / resetSchoolSeason / getSchoolMemberStats /
        // getSchoolMemberProfile / getSchoolMatchEntryContext）在桩上永远跑不通，
        // 3222 条用例全绿也照不出来——两端真实仓储都有 getById（school-memory-repo.js
        // 逐集合生成、cloud-repo.js 的「三件套补齐」），只有桩少了一层。
        // get 保留：既有调用方（memberships.get）保留别名口径，这里同样两种叫法都认。
        getById: (id) => read('seasons', id),
        get: (id) => read('seasons', id),
        list: () => [...target.seasons.values()].map(clone),
        set: async (id, doc) => {
          target.seasons.set(id, { ...doc, _id: id });
        },
      },


      audit: {
        append: async (entry) => {
          target.auditLogs.push(clone(entry));
        },
      },
    };
    const built = attachSchoolRepository(repo, {
      // 与云端 io.cmd 对应：listRatedSince 等范围查询靠它构造操作符。
      cmd: command,
      memberPage: async (scope, options) => memoryDirectoryPage(list('schoolMembers'), list('users'), scope, options),
      memberCount: async (scope, options) => memoryDirectoryCount(list('schoolMembers'), list('users'), scope, options),
      personalPage: async (source, auth, query) => memoryPersonalPage(list, source, auth, query),
      matchPage: async (scope, options) => memoryMatchPage(list('matches'), scope, options),
      read,
      set: async (key, id, doc) => {
        if (onWrite) onWrite(key);
        target[key].set(id, { ...doc, _id: id });
      },
      query: (key, where) => list(key).filter((doc) => matchWhere(doc, where)),
      // 按一批 _id 取（云端走 `_.in` 并按 PAGE_SIZE 切片）。**必须一起套范围条件**：
      // 主键可能来自调用方，只按 _id 查等于把归属校验交给了调用方。
      byIds: async (key, ids, scopeFields = {}) => {
        const uniq = [...new Set((Array.isArray(ids) ? ids : [])
          .filter((id) => typeof id === 'string' && id))];
        if (uniq.length === 0) return [];
        return list(key).filter((doc) => uniq.includes(doc._id)
          && Object.entries(scopeFields).every(([field, value]) => doc[field] === value));
      },
      // 条件 + 排序 + 限量（与云端 io.top 同语义）：榜单取「按 elo 前 N」用。
      top: (key, where, order, limit) => {
        const rows = list(key).filter((doc) => matchWhere(doc, where));
        rows.sort((a, b) => {
          for (const rule of (order || [])) {
            const diff = compare(a[rule.field], b[rule.field]);
            if (diff !== 0) return rule.direction === 'desc' ? -diff : diff;
          }
          return 0;
        });
        return rows.slice(0, Math.max(1, Number(limit) || 1));
      },
      // 只回数字（与云端 io.count 同语义）。
      count: (key, where) => list(key).filter((doc) => matchWhere(doc, where)).length,
    }, inTx);

    // 基础集合的写方法直接落在 target 上，不走 io.set，故按方法名套钩子。
    // 学校专属集合（SCHOOL_COLLECTIONS）的写其实都经 io.set，已在上面的 set 里记过，
    // 这里跳过以免重复计数。就地改写 built 而不另建对象——attachSchoolRepository
    // 的 result.transaction 闭包引用的是同一个 repo，换对象会把它指丢。
    if (onWrite) {
      for (const [key, ops] of Object.entries(built)) {
        if (SCHOOL_COLLECTIONS.includes(key) || !ops || typeof ops !== 'object') continue;
        built[key] = withWriteHook(ops, key, onWrite);
      }
    }
    return built;
  }

  const repo = collections(store, false, bump);

  // 【事务排队：模拟真实数据库的冲突串行化】
  // 真云开发事务是「读已提交 + 冲突重试」：两个事务同时改同一批文档时，后到
  // 的那个会被回滚重试，绝不会出现「两边都读到旧值、然后互相覆盖」的丢失更新。
  // 早先这里直接 await fn(草稿本)，两个并发事务会各自基于同一份旧快照提交，
  // 后提交的把先提交的整个盖掉——这会把 P0 要验的「并发占用最后名额」测成假绿。
  // 现在把事务排成一条队列：一个跑完（提交或回滚）再放行下一个，与真库的
  // 串行结果一致。业务代码仍必须自己用事务内共享文档做冲突点，不能依赖这一点。
  const MAX_ATTEMPTS = 5;
  let queue = Promise.resolve();
  repo.transaction = (fn) => {
    const run = queue.then(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const scratch = emptyStore();
        for (const key of Object.keys(scratch)) {
          scratch[key] = key === 'auditLogs' ? [...store[key]] : new Map(store[key]);
        }

        const startVersions = new Map(versions);
        const written = new Set();
        const result = await fn(collections(scratch, true, (key) => written.add(key)));

        // 提交前冲突检测：本事务写过的集合，若被外部（非事务）写入抢先改过版本，
        // 说明草稿本建立在过期快照上，整份丢弃、重跑事务（与真库的冲突重试一致）。
        let conflicted = false;
        for (const key of written) {
          if ((versions.get(key) || 0) !== (startVersions.get(key) || 0)) { conflicted = true; break; }
        }
        if (conflicted) continue;

        // 走到这里说明没抛错、也没冲突，草稿本整体生效，并为写过的集合进一版
        for (const key of Object.keys(store)) store[key] = scratch[key];
        for (const key of written) versions.set(key, (startVersions.get(key) || 0) + 1);
        return result;
      }
      throw new Error('事务冲突重试次数耗尽');
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return repo;
}

module.exports = { createMemoryRepo };
