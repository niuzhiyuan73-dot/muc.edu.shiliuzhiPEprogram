/**
 * 一个 OpenID 只解析到一条账号（只读审计 H5 / 产品决策 P1）
 * ============================================================
 * 【两件事】
 *   1. **确定性**：`getByOpenId` 过去用 `.where({openId}).limit(1)`，没有
 *      `orderBy`——同一 OpenID 若留下两条账号，返回哪一条**不确定**，表现为
 *      「注册过却进不去」「榜单里没有我」，且不可复现。云端与本地模拟仓储都
 *      改成「按 _id 升序取定」。
 *   2. **键统一**：旧协议的 `memberKey` 与协议 2 的 `schoolAccountKey` 过去是
 *      两把键（`u_<md5>` vs `acc:<openId>`），于是同一微信身份会留下两条账号。
 *      产品已定「协议 1 完全下线」，因此 `memberKey` 直接复用协议 2 的键。
 *
 * 两套协议从此落到同一条账号文档上，趁线上还没有真实数据统一，成本接近零。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { memberKey } = require('../cloudfunctions/data/src/core/idempotency');
const { schoolAccountKey } = require('../src/shared/utils/school');

/**
 * 云数据库桩：只实现 getByOpenId 用到的那条查询链，并**记录**调用顺序。
 *
 * 【为什么必须记 orderBy】
 * 真实云开发里「不写 orderBy 就没有顺序保证」。桩若总是帮我们排好序，
 * 这条测试就会在「没修」的情况下也变绿——那就白测了。所以顺序**只在调用方
 * 显式 orderBy 时才应用**：没调用 orderBy 时按插入顺序返回（第一条是 u_…），
 * 调用后按 _id 升序返回（第一条是 acc:…）。
 */
function database(seedUsers) {
  const log = [];
  return {
    log,
    collection() {
      const state = { where: {}, sort: null, limit: null };
      const api = {
        where(cond) { state.where = cond; log.push('where'); return api; },
        orderBy(field, dir) { state.sort = { field, dir }; log.push(`orderBy:${field}:${dir}`); return api; },
        limit(n) { state.limit = n; log.push(`limit:${n}`); return api; },
        skip() { return api; },
        async get() {
          let rows = seedUsers.filter(doc =>
            Object.entries(state.where).every(([key, value]) => doc[key] === value));
          if (state.sort) {
            const { field, dir } = state.sort;
            rows = rows.slice().sort((a, b) => {
              const x = String(a[field]); const y = String(b[field]);
              const cmp = x < y ? -1 : x > y ? 1 : 0;
              return dir === 'desc' ? -cmp : cmp;
            });
          }
          return { data: typeof state.limit === 'number' ? rows.slice(0, state.limit) : rows };
        },
      };
      return api;
    },
    async runTransaction(fn) { return fn(this); },
  };
}

/** 同一 OpenID 的两条账号：旧协议键（字典序更大）在前，协议 2 键在后。 */
const TWO_ACCOUNTS = [
  { _id: 'u_9f2c1e', openId: 'openid-dup', nickName: '旧协议那条' },
  { _id: 'acc:openid-dup', openId: 'openid-dup', nickName: '协议 2 那条' },
];

test('云端 getByOpenId 明确要求按 _id 升序，且取定那一条', async () => {
  // 存储顺序特意让「旧协议那条」在前：没加 orderBy 时会返回它，加了才返回 acc:。
  const db = database(TWO_ACCOUNTS);
  const repo = createRepo(db);
  const first = await repo.users.getByOpenId('openid-dup');

  assert.ok(db.log.includes('orderBy:_id:asc'),
    'getByOpenId 必须显式 orderBy(_id, asc)——云开发不指定顺序时返回哪条无保证');
  assert.equal(first._id, 'acc:openid-dup',
    '必须取到 _id 最小的那条，而不是「碰巧返回的第一条」');
});

test('云端 getByOpenId 的确定性不随存储顺序变化', async () => {
  const a = await createRepo(database(TWO_ACCOUNTS)).users.getByOpenId('openid-dup');
  const b = await createRepo(database(TWO_ACCOUNTS.slice().reverse())).users.getByOpenId('openid-dup');
  assert.equal(a._id, b._id, '两次不同存储顺序必须解析到同一条账号');
  assert.equal(a._id, 'acc:openid-dup');
});

test('本地模拟仓储的 getByOpenId 与云端同口径', async () => {
  const repo = createSchoolMemoryRepo({ users: TWO_ACCOUNTS });
  assert.equal((await repo.users.getByOpenId('openid-dup'))._id, 'acc:openid-dup');
  assert.equal(await repo.users.getByOpenId(''), null);
  assert.equal(await repo.users.getByOpenId('openid-unknown'), null);
});

test('旧协议的 memberKey 与协议 2 的账号键是同一把（P1 第二步）', () => {
  const openId = 'openid-unified';
  assert.equal(memberKey(openId), schoolAccountKey(openId),
    '两套协议必须落到同一条 users 文档上');
  assert.match(schoolAccountKey(openId), /^acc:/);
  assert.doesNotMatch(memberKey(openId), /^u_/, '不应再有 u_ 前缀的旧键');

  // 幂等性与区分度保持不变
  assert.equal(memberKey(openId), memberKey(openId));
  assert.notEqual(memberKey('openid-a'), memberKey('openid-b'));
});
