/**
 * 管理员评级调整（Elo 交接 §5.3）
 * ============================================================
 * 守的是「与结算同构」：一个事务内改评级 + 写审计 + 复用范围序号，
 * requestId 幂等，权限在事务内重读，且不伪造比赛记录。
 * 断言业务结果与持久化事实，不是实现细节。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { adjustMemberRating, validateRatingAdjustment, ratingAdjustmentKey } = require('../src/server/services/school-rating-service');
const { memberRatingKey, ratingSeqKey, schoolMemberKey } = require('../src/shared/utils/school');
const { RATING_POOL } = require('../src/shared/utils/constants');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const NOW = new Date('2026-11-25T02:00:00Z');
const TARGET = 'demo_muc_member';

function fixture() {
  const seed = createSchoolDemoSeed();
  return createSchoolMemoryRepo(seed);
}

async function ctxOf(repo, actorId) {
  return buildSchoolContext({ repo, actorId, scope: SCOPE, now: NOW });
}

/** 直接种一份评级文档，跳过结算（本文件只测调整，结算另有测试）。 */
async function seedRating(repo, { userId = TARGET, elo = 1500, pool = RATING_POOL.SINGLES } = {}) {
  const key = memberRatingKey(userId, pool, SCOPE);
  await repo.memberRatings.set(key, {
    _id: key, ...SCOPE, userId, pool, elo, startElo: 1450, startSource: 'gender',
    gender: 'M', memberStatus: 'active', matchCount: 3, wins: 2, losses: 1,
    version: 7, lastSettlementSeq: 4,
  });
  return key;
}

test('validateRatingAdjustment —— 目标分边界与增量', () => {
  assert.deepEqual(validateRatingAdjustment(1500, 1600), { target: 1600, delta: 100 });
  assert.deepEqual(validateRatingAdjustment(1500, 1400), { target: 1400, delta: -100 });
  for (const bad of [-1, 3001, 1.5, NaN, '1600', null, undefined]) {
    assert.throws(() => validateRatingAdjustment(1500, bad));
  }
  assert.throws(() => validateRatingAdjustment(NaN, 1600));
});

test('ratingAdjustmentKey —— 同 requestId 同键，缺 requestId 抛错', () => {
  const a = ratingAdjustmentKey(SCOPE, 'req-1');
  assert.equal(ratingAdjustmentKey(SCOPE, 'req-1'), a);
  assert.notEqual(ratingAdjustmentKey(SCOPE, 'req-2'), a);
  assert.throws(() => ratingAdjustmentKey(SCOPE, ''));
});

test('调整落库：评级改分 + 审计记录 + 复用范围序号，不伪造比赛', async () => {
  const repo = fixture();
  const ratingKey = await seedRating(repo);
  const ctx = await ctxOf(repo, 'demo_muc_admin');
  const res = await adjustMemberRating({
    userId: TARGET, pool: RATING_POOL.SINGLES, targetElo: 1600,
    reason: '人工复核更正', requestId: 'adj-1',
  }, ctx);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.adjustment.delta, 100);
  assert.equal(res.data.adjustment.after, 1600);

  const rating = await repo.memberRatings.getById(ratingKey);
  assert.equal(rating.elo, 1600, '当前分已更新');
  assert.equal(rating.startElo, 1450, '起点分不动');
  assert.equal(rating.matchCount, 3, '场数不动');
  assert.equal(rating.version, 8);

  const adjKey = ratingAdjustmentKey(SCOPE, 'adj-1');
  const record = await repo.ratingAdjustments.getById(adjKey);
  assert.equal(record.before, 1500);
  assert.equal(record.after, 1600);
  assert.equal(record.reason, '人工复核更正');
  assert.equal(record.operatorId, 'demo_muc_admin');
  assert.equal(record.seq, 1, '复用结算序号（计数文档从 0 起，本次分配 1）');
  const counter = await repo.ratingCounters.getById(ratingSeqKey(SCOPE));
  assert.equal(counter.seq, 1);
  assert.equal(counter.lastAdjustmentId, adjKey);

  // 不产生任何比赛文档变更
  assert.deepEqual(await repo.matches.list(), []);
});

test('幂等：同一 requestId 重放返回首次结果且不重复加分', async () => {
  const repo = fixture();
  const ratingKey = await seedRating(repo);
  const ctx = await ctxOf(repo, 'demo_muc_admin');
  const payload = { userId: TARGET, pool: RATING_POOL.SINGLES, targetElo: 1600,
    reason: '更正', requestId: 'adj-idem' };
  const first = await adjustMemberRating(payload, ctx);
  const second = await adjustMemberRating(payload, ctx);
  assert.equal(second.data.repeated, true);
  assert.equal(second.data.adjustment.seq, first.data.adjustment.seq);
  const rating = await repo.memberRatings.getById(ratingKey);
  assert.equal(rating.elo, 1600, '重放没有二次调整');
  assert.equal(rating.version, 8);
});

test('权限：普通会员与跨协会管理员都不能调整', async () => {
  const repo = fixture();
  await seedRating(repo);
  const payload = { userId: TARGET, pool: RATING_POOL.SINGLES, targetElo: 1600,
    reason: '越权尝试', requestId: 'adj-deny' };
  const member = await adjustMemberRating(payload, await ctxOf(repo, 'demo_muc_member'));
  assert.equal(member.data.ok, false);
  assert.match(member.data.message, /负责人/);
  const other = await adjustMemberRating(payload, await ctxOf(repo, 'demo_buaa_admin'));
  assert.equal(other.data.ok, false);
});

test('边界：目标分越界 / 无原因 / 无评级记录都拒绝', async () => {
  const repo = fixture();
  await seedRating(repo);
  const ctx = await ctxOf(repo, 'demo_muc_admin');
  const base = { userId: TARGET, pool: RATING_POOL.SINGLES, targetElo: 1600, reason: '更正' };
  assert.match((await adjustMemberRating({ ...base, targetElo: 3001, requestId: 'e1' }, ctx)).data.message, /0–3000/);
  assert.match((await adjustMemberRating({ ...base, reason: '  ', requestId: 'e2' }, ctx)).data.message, /原因/);
  // 管理员自身在册但没有评级文档，作为"在册却无评级"的目标
  const inRoster = await repo.schoolMembers.getById(schoolMemberKey('demo_muc_admin', 'muc'));
  assert.ok(inRoster, '测试前提：该会员在册');
  assert.match((await adjustMemberRating({ ...base, userId: 'demo_muc_admin', requestId: 'e3' }, ctx)).data.message, /还没有评级/);
});

test('无在册会籍的目标会员被拒绝', async () => {
  const repo = fixture();
  const key = schoolMemberKey(TARGET, 'muc');
  const member = await repo.schoolMembers.getById(key);
  assert.ok(member, '测试前提：该会员在册');
  // 内存仓储没有 delete，用状态覆盖模拟"已停用"（权威值就是 status）
  await repo.schoolMembers.set(key, { ...member, status: 'disabled' });
  const ctx = await ctxOf(repo, 'demo_muc_admin');
  const res = await adjustMemberRating({ userId: TARGET, pool: RATING_POOL.SINGLES,
    targetElo: 1600, reason: '更正', requestId: 'ghost-1' }, ctx);
  assert.equal(res.data.ok, false);
  assert.match(res.data.message, /在册/);
});
