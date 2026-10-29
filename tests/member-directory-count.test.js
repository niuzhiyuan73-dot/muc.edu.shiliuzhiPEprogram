/**
 * 会员名录「只数不取」与总数口径（2026-10-29 第十一轮审计 P2-3 / P2-9）
 * ============================================================
 * 守的是三件事：
 *   1. `listSchoolMembers({countOnly:true})` 只回数字，不读账号、不回成员行——
 *      首页概况只要一个「本校会员数」，不该把整份名录拉一遍；
 *   2. 这个数字与分页/平铺数出来的行数**逐条相等**（同一套目录过滤）；
 *   3. 身份页的 `total` 与首页同口径，不再出现「首页 1200 / 身份页 1215」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-member-service');
const { schoolMemberKey } = require('../miniprogram/utils/school');

const NOW = new Date('2026-10-13T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'pkb' };

function fixture() {
  const seed = createSchoolDemoSeed();
  // 造 3 个「有学籍但账号不能用 / 已转校」的人：他们只有 countByStatus 会数进去，
  // 目录口径（学籍 active × 账号 active × 归属本校）必须排除——这正是两套口径
  // 对不上的来源。
  seed.users.push({ _id: 'ghost_disabled', platformStatus: 'disabled', primarySchoolId: 'muc' });
  seed.users.push({ _id: 'ghost_transferred', platformStatus: 'active', primarySchoolId: 'other' });
  seed.users.push({ _id: 'ghost_missing' }); // 账号文档缺失
  for (const id of ['ghost_disabled', 'ghost_transferred', 'ghost_missing']) {
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id,
      collegeId: 'c01', status: 'active' });
  }
  return seed;
}

async function ctxOf(repo) {
  return buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE, now: NOW });
}

test('countOnly：只回数字，不批读账号，也不回成员行', async () => {
  const seed = fixture();
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await ctxOf(repo);
  let userBatches = 0;
  const listByIds = repo.users.listByIds;
  repo.users.listByIds = (...args) => { userBatches += 1; return listByIds(...args); };

  const flat = (await handlers.listSchoolMembers({}, ctx)).data; // 先量一次平铺，作为基准
  const batchesAfterFlat = userBatches;
  assert.ok(batchesAfterFlat > 0, '平铺模式本来就要批读账号');

  const counted = (await handlers.listSchoolMembers({ countOnly: true }, ctx)).data;
  assert.equal(counted.ok, true);
  assert.deepEqual(counted.members, [], '只要数字，不回成员行');
  assert.equal(userBatches, batchesAfterFlat, 'countOnly 不该再去批读账号');
  assert.equal(counted.total, flat.total, 'countOnly 与平铺必须数出同一个数');
});

test('countOnly 与分页逐页翻完的行数相等（同一套目录过滤）', async () => {
  const repo = createSchoolMemoryRepo(fixture());
  const ctx = await ctxOf(repo);
  const counted = (await handlers.listSchoolMembers({ countOnly: true }, ctx)).data;

  let cursor = '';
  let rows = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = (await handlers.listSchoolMembers({ page: true, limit: 20, cursor }, ctx)).data;
    assert.equal(page.ok, true);
    rows += page.members.length;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.ok(counted.total > 0, '演示数据里应当有会员');
  assert.equal(counted.total, rows, '总数必须等于分页能翻到的行数');
});

test('账号停用 / 已转校 / 账号缺失的学籍不计入目录总数', async () => {
  const repo = createSchoolMemoryRepo(fixture());
  const ctx = await ctxOf(repo);
  const counted = (await handlers.listSchoolMembers({ countOnly: true }, ctx)).data;
  const flat = (await handlers.listSchoolMembers({}, ctx)).data;
  const ids = new Set(flat.members.map(row => row.userId));
  for (const ghost of ['ghost_disabled', 'ghost_transferred', 'ghost_missing']) {
    assert.ok(!ids.has(ghost), `${ghost} 不该出现在名录里`);
  }
  assert.equal(counted.total, flat.members.length, '总数与名录行数必须逐条相等');
});

test('身份页（getSchoolMembers）的 total 与名录同口径', async () => {
  const repo = createSchoolMemoryRepo(fixture());
  const ctx = await ctxOf(repo);
  const counted = (await handlers.listSchoolMembers({ countOnly: true }, ctx)).data;
  // 身份页在 school-membership-service 里（经云端处理器注册），走同一把读权限锁
  const memberHandlers = require('../cloudfunctions/data/src/core/school-member-handlers.js');
  const list = await memberHandlers.getSchoolMembers({ limit: 5 }, ctx);
  const data = list && list.data ? list.data : list;
  assert.equal(data.ok, true);
  assert.equal(data.total, counted.total, '首页会员数与身份页总数必须一致');
});
