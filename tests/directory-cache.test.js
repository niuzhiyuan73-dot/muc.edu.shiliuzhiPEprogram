// 全校名册目录缓存（2026-10-29 第十一轮审计 P1-1）
//
// `buildDirectory` 是球队 / 录分 / 赛程指派等 14 处读路径的公共前置：它读全校在册
// 成员再批读全校账号，一所 2000 人的学校就是 40 次 RPC。这里钉住四件事：
//   1. 同一个仓储在窗口内只读一次（缓存真的省读）；
//   2. 写动作（invalidateAll）之后必须重读，不能拿着旧名单判权限；
//   3. 换一个仓储必须自己读（缓存按实例分桶，不能做成模块级全局 Map）；
//   4. 判球类的按范围失效不清它（否则一场 50 球会把缓存连续打掉）。
//
// 缓存默认在测试环境关闭（context-cache.readTtl 在 --test 下返回 0），
// 所以每条用例显式 __setTtlForTest 打开，结束后复位。
process.env.RATE_LIMIT = 'off';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const contextCache = require('../miniprogram/services/context-cache.js');
const { buildDirectory } = require('../miniprogram/services/school-actor.js');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/**
 * 数一数这次调用读了多少条成员、发了几批账号读取。
 * 代理要能穿透 `forScope()` 返回的新对象，否则计数全落在 0 上（假绿）。
 */
function countingRepo() {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const hits = { memberRows: 0, userBatches: 0 };
  const wrap = (obj) => new Proxy(obj, {
    get(target, key) {
      const value = target[key];
      if (typeof value === 'function') {
        return (...args) => {
          const result = value.apply(target, args);
          const passthrough = (res) => (key === 'forScope' && res && typeof res === 'object' ? wrap(res) : res);
          return result && typeof result.then === 'function' ? result.then(passthrough) : passthrough(result);
        };
      }
      if (key === 'schoolMembers' && value && typeof value === 'object') {
        const list = value.list;
        return { ...value, list: async (...args) => {
          const rows = await list.apply(value, args);
          hits.memberRows += Array.isArray(rows) ? rows.length : 0;
          return rows;
        } };
      }
      if (key === 'users' && value && typeof value === 'object') {
        const listByIds = value.listByIds;
        return { ...value, listByIds: async (...args) => {
          hits.userBatches += 1;
          return listByIds.apply(value, args);
        } };
      }
      if (value && typeof value === 'object') return wrap(value);
      return value;
    },
  });
  return { repo: wrap(repo), hits };
}

function ctxOf(repo) {
  return { repo, schoolId: SCOPE.schoolId, association: SCOPE.association, actorId: '' };
}

test.afterEach(() => contextCache.__setTtlForTest(0));

test('目录缓存：同一仓储第二次不再读名册与账号', async () => {
  contextCache.__setTtlForTest(5000);
  const { repo, hits } = countingRepo();
  const ctx = ctxOf(repo);

  const first = await buildDirectory(ctx);
  const rowsAfterFirst = hits.memberRows;
  const batchesAfterFirst = hits.userBatches;
  assert.ok(rowsAfterFirst > 0, '第一次必须真的读名册');
  assert.ok(batchesAfterFirst > 0, '第一次必须真的批读账号');

  const second = await buildDirectory(ctx);
  assert.equal(hits.memberRows, rowsAfterFirst, '窗口内第二次不该再读名册');
  assert.equal(hits.userBatches, batchesAfterFirst, '窗口内第二次不该再批读账号');
  // 省读不能省出不同的结果
  assert.deepEqual(second.activeMemberIds, first.activeMemberIds);
  assert.deepEqual(second.colleges, first.colleges);
});

test('目录缓存：写动作整体失效后必须重读（撤权不能落在旧名单上）', async () => {
  contextCache.__setTtlForTest(5000);
  const { repo, hits } = countingRepo();
  const ctx = ctxOf(repo);

  await buildDirectory(ctx);
  const rowsAfterFirst = hits.memberRows;
  contextCache.invalidateAll();
  await buildDirectory(ctx);
  assert.ok(hits.memberRows > rowsAfterFirst, '失效后必须重新读名册');
});

test('目录缓存：按范围失效（判球类写）不清它', async () => {
  contextCache.__setTtlForTest(5000);
  const { repo, hits } = countingRepo();
  const ctx = ctxOf(repo);

  await buildDirectory(ctx);
  const rowsAfterFirst = hits.memberRows;
  contextCache.invalidateScope(SCOPE.schoolId, SCOPE.association);
  await buildDirectory(ctx);
  assert.equal(hits.memberRows, rowsAfterFirst, '判球不该打掉全校目录缓存');
});

test('目录缓存：换一个仓储必须自己读（不能做成模块级全局）', async () => {
  contextCache.__setTtlForTest(5000);
  const a = countingRepo();
  const b = countingRepo();
  await buildDirectory(ctxOf(a.repo));
  assert.equal(b.hits.memberRows, 0, '新仓储还没读过');
  await buildDirectory(ctxOf(b.repo));
  assert.ok(b.hits.memberRows > 0, '新仓储必须自己读一次');
});
