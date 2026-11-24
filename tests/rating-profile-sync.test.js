// 入口限流按 openId 每秒计数，这些用例用同一身份连打（申请→审核→转校），
// 属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
/**
 * 评级冗余档案字段（gender / memberStatus）的写入与同步
 * ============================================================
 * 方案 A 只增加两个字段，但这两个字段必须**永远与权威表一致**，
 * 否则清单会出错：性别错了 → 项目筛错；状态错了 → 已转出的人还挂在榜上。
 *
 * 这里按「谁在什么时机改它」分三组钉住：
 *   1. 建档（首次结算）：起点分按性别算，同时把性别与 active 落库；
 *   2. 每次结算：性别按账号刷新（结算本来就点读了 users，零额外成本）；
 *   3. 会籍变更：入会通过 → active，转校通过 → 原校各协会标 transferred。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
const {
  computeSettlement, materializeRatings, settleMatchInTransaction, buildRatingDoc,
  syncRatingProfileInTransaction,
} = require('../src/server/services/school-rating-service');
const {
  memberRatingKey, schoolMemberKey, SCHOOL_MEMBER_STATUS,
} = require('../src/shared/utils/school');
const { RATING_POOL } = require('../src/shared/utils/constants');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const NOW = new Date('2026-10-23T02:00:00Z');

/* ------------------------------------------------ 1. 纯函数：结算刷新性别 */

describe('结算路径刷新冗余 gender', () => {
  const match = {
    _id: 'm1', ...SCOPE, matchType: 1, pool: RATING_POOL.SINGLES,
    teamA: ['u1'], teamB: ['u2'], winner: 'A',
    matchTime: '2026-10-22T02:00:00.000Z', status: 1, competition: 'personal',
  };

  /** 两份已有评级，性别被旧值污染（模拟很久以前建档、之后改过档）。 */
  function ratingsView() {
    const ratings = new Map([
      ['u1', buildRatingDoc({ userId: 'u1', pool: RATING_POOL.SINGLES, scope: SCOPE, startElo: 1450, gender: 'F', now: NOW })],
      ['u2', buildRatingDoc({ userId: 'u2', pool: RATING_POOL.SINGLES, scope: SCOPE, startElo: 1300, gender: 'M', now: NOW })],
    ]);
    ratings.get('u1').elo = 1600;
    ratings.get('u2').elo = 1500;
    return ratings;
  }

  test('给了账号档案：每份评级文档的 gender 按 users 刷新', () => {
    const profileByUser = new Map([['u1', { gender: 'M' }], ['u2', { gender: 'F' }]]);
    const { ratingDocs } = computeSettlement({
      match, eventLevel: undefined, ratingsByUser: ratingsView(), seq: 1, settledAt: NOW, profileByUser,
    });
    const byUser = new Map(ratingDocs.map(row => [row.userId, row.doc]));
    assert.equal(byUser.get('u1').gender, 'M');
    assert.equal(byUser.get('u2').gender, 'F');
  });

  test('没给账号档案（纯函数单测口径）：保留原值，不写空串', () => {
    const { ratingDocs } = computeSettlement({
      match, eventLevel: undefined, ratingsByUser: ratingsView(), seq: 1, settledAt: NOW,
    });
    const byUser = new Map(ratingDocs.map(row => [row.userId, row.doc]));
    assert.equal(byUser.get('u1').gender, 'F', '没有权威值时不猜');
    assert.equal(byUser.get('u2').gender, 'M');
  });

  test('memberStatus 不在结算路径改写——补录旧比赛不能把已转出的人改回 active', () => {
    const ratings = ratingsView();
    ratings.get('u1').memberStatus = SCHOOL_MEMBER_STATUS.TRANSFERRED;
    const { ratingDocs } = computeSettlement({
      match, eventLevel: undefined, ratingsByUser: ratings, seq: 1, settledAt: NOW,
      profileByUser: new Map([['u1', { gender: 'M' }], ['u2', { gender: 'F' }]]),
    });
    const u1 = ratingDocs.find(row => row.userId === 'u1').doc;
    assert.equal(u1.memberStatus, SCHOOL_MEMBER_STATUS.TRANSFERRED);
  });
});

/* ---------------------------------------- 2. 事务：建档与结算落库的字段 */

describe('结算落库带上冗余档案字段', () => {
  function repo() {
    return createSchoolMemoryRepo({
      users: [
        { _id: 'u1', gender: 'M' },
        { _id: 'u2', gender: 'F' },
      ],
    });
  }
  const match = {
    _id: 'm2', ...SCOPE, matchType: 1, pool: RATING_POOL.SINGLES,
    teamA: ['u1'], teamB: ['u2'], winner: 'A',
    matchTime: '2026-10-22T02:00:00.000Z', status: 1, competition: 'personal',
  };

  test('首次结算建档：gender 与状态一次落齐', async () => {
    const repoRef = repo();
    await repoRef.transaction(async (tx) => {
      await settleMatchInTransaction(tx, { ...SCOPE, now: NOW }, match, {});
    });
    const doc = await repoRef.memberRatings.getById(memberRatingKey('u1', RATING_POOL.SINGLES, SCOPE));
    assert.equal(doc.gender, 'M');
    assert.equal(doc.memberStatus, SCHOOL_MEMBER_STATUS.ACTIVE);
    const female = await repoRef.memberRatings.getById(memberRatingKey('u2', RATING_POOL.SINGLES, SCOPE));
    assert.equal(female.gender, 'F');
    assert.equal(female.startElo, 1300, '起点分仍按性别取，性别冗余不影响定级');
  });

  test('已有评级：第二次结算把性别刷新成账号当前值', async () => {
    const repoRef = repo();
    await repoRef.transaction(async (tx) => {
      const doc = buildRatingDoc({ userId: 'u1', pool: RATING_POOL.SINGLES, scope: SCOPE, startElo: 1450, gender: 'F', now: NOW });
      await tx.memberRatings.set(doc._id, doc);
    });
    await repoRef.transaction(async (tx) => {
      await settleMatchInTransaction(tx, { ...SCOPE, now: NOW }, match, {});
    });
    const doc = await repoRef.memberRatings.getById(memberRatingKey('u1', RATING_POOL.SINGLES, SCOPE));
    assert.equal(doc.gender, 'M', '账号是男，文档要跟上');
    assert.equal(doc.matchCount, 1);
  });
});

/* --------------------------------------- 3. 同步函数本身（幂等与只写变化） */

describe('syncRatingProfileInTransaction', () => {
  test('只写字段真的变了的文档；扫描数覆盖全部协会 × 全部池', async () => {
    const repoRef = createSchoolMemoryRepo({ users: [{ _id: 'u1', gender: 'M' }] });
    // 只有 pkb 有两条评级，其余协会没有文档——不补建档，只计入 missing
    for (const pool of [RATING_POOL.SINGLES, RATING_POOL.DOUBLES]) {
      const doc = buildRatingDoc({ userId: 'u1', pool, scope: SCOPE, startElo: 1450, gender: 'M', now: NOW });
      await repoRef.memberRatings.set(doc._id, doc);
    }
    const first = await repoRef.transaction(async (tx) => syncRatingProfileInTransaction(tx, {
      userId: 'u1', schoolId: 'muc', gender: 'M',
      memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED, now: NOW,
    }));
    assert.equal(first.scanned, 12, '6 协会 × 2 池都要看过一眼');
    assert.equal(first.updated, 2, '只有 pkb 的两条存在');
    assert.equal(first.missing, 10);

    const second = await repoRef.transaction(async (tx) => syncRatingProfileInTransaction(tx, {
      userId: 'u1', schoolId: 'muc', gender: 'M',
      memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED, now: NOW,
    }));
    assert.equal(second.updated, 0, '状态已是目标值，重复调用不产生写');
  });

  test('不允许写入未知的在册状态', async () => {
    const repoRef = createSchoolMemoryRepo({ users: [] });
    await assert.rejects(
      () => repoRef.transaction(async (tx) => syncRatingProfileInTransaction(tx, {
        userId: 'u1', schoolId: 'muc', memberStatus: 'ghost',
      })),
      /未知的在册状态/,
    );
  });
});

/* ------------------------------------------------- 4. 会籍路径的接入（集成） */

function seededRepo() {
  const seed = createSchoolDemoSeed();
  seed.users.push(...['new1', 'new2'].map(id => ({ _id: id, openId: id, platformStatus: 'active', platformRole: 'member' })));
  return createMemoryRepo(seed);
}
const request = (repo, action, payload = {}, openId = 'new1', schoolId = 'muc') => handleSchoolRequest({
  protocolVersion: 2, schoolId, association: 'pkb', action, payload,
}, { repo, openId, now: new Date('2026-10-23T02:00:00Z') });

/** 预置一条「历史评级」，用来验证会籍变更会不会把它带上。 */
async function seedRating(repo, userId, {
  association = 'pkb', pool = RATING_POOL.SINGLES,
  memberStatus = SCHOOL_MEMBER_STATUS.ACTIVE, gender = 'M',
} = {}) {
  const scope = { schoolId: 'muc', association };
  const doc = buildRatingDoc({ userId, pool, scope, startElo: 1450, gender, now: NOW });
  doc.memberStatus = memberStatus;
  await repo.memberRatings.set(doc._id, doc);
  return doc._id;
}

async function join(repo, user, schoolId, studentId) {
  const applied = (await request(repo, 'applySchoolMembership', { collegeId: 'c01', studentId }, user, schoolId)).data;
  assert.equal(applied.ok, true, applied.message);
  const res = await request(repo, 'reviewSchoolMembership',
    { userId: user, decision: 'approve', revision: applied.account.revision },
    `mock_openid_${schoolId}_admin`, schoolId);
  assert.equal(res.data.ok, true, res.data.message);
}

describe('会籍变更把状态同步进评级表', () => {
  test('转校通过：原校各协会的评级一律标 transferred', async () => {
    const repo = seededRepo();
    await join(repo, 'new1', 'muc', 'MUC001');
    const singles = await seedRating(repo, 'new1');
    const doublesOtherAssociation = await seedRating(repo, 'new1', {
      association: 'bk', pool: RATING_POOL.DOUBLES,
    });
    const applied = (await request(repo, 'applySchoolTransfer',
      { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
    assert.equal(applied.ok, true, applied.message);
    const approved = (await request(repo, 'reviewSchoolTransfer',
      { userId: 'new1', decision: 'approve', revision: applied.account.revision },
      'mock_openid_buaa_admin', 'buaa')).data;
    assert.equal(approved.ok, true, approved.message);

    for (const id of [singles, doublesOtherAssociation]) {
      const doc = await repo.memberRatings.getById(id);
      assert.equal(doc.memberStatus, SCHOOL_MEMBER_STATUS.TRANSFERRED,
        '不标 transferred，原校榜单会把转走的人算进排名');
      assert.equal(doc.elo, 1450, '只改档案字段，分不动');
    }
  });

  test('入会通过：把上次留下的评级文档恢复为 active', async () => {
    const repo = seededRepo();
    // 模拟「曾转出、现在重新入校」：名册是已驳回态，评级还停在 transferred
    await repo.schoolMembers.set(schoolMemberKey('new2', 'muc'), {
      _id: schoolMemberKey('new2', 'muc'), userId: 'new2', schoolId: 'muc',
      collegeId: 'c01', studentId: 'OLD002', status: SCHOOL_MEMBER_STATUS.REJECTED, revision: 2,
    });
    const ratingId = await seedRating(repo, 'new2', { memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED });

    await join(repo, 'new2', 'muc', 'NEW002');
    const doc = await repo.memberRatings.getById(ratingId);
    assert.equal(doc.memberStatus, SCHOOL_MEMBER_STATUS.ACTIVE);
  });

  test('驳回入会不动评级：状态没变就不该产生写', async () => {
    const repo = seededRepo();
    await repo.schoolMembers.set(schoolMemberKey('new2', 'muc'), {
      _id: schoolMemberKey('new2', 'muc'), userId: 'new2', schoolId: 'muc',
      collegeId: 'c01', studentId: 'OLD002', status: SCHOOL_MEMBER_STATUS.REJECTED, revision: 2,
    });
    const ratingId = await seedRating(repo, 'new2', { memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED });
    const applied = (await request(repo, 'applySchoolMembership',
      { collegeId: 'c01', studentId: 'NEW002' }, 'new2', 'muc')).data;
    const rejected = (await request(repo, 'reviewSchoolMembership',
      { userId: 'new2', decision: 'reject', reason: '材料不全', revision: applied.account.revision },
      'mock_openid_muc_admin', 'muc')).data;
    assert.equal(rejected.ok, true, rejected.message);
    const doc = await repo.memberRatings.getById(ratingId);
    assert.equal(doc.memberStatus, SCHOOL_MEMBER_STATUS.TRANSFERRED, '驳回不改变在册状态');
  });
});
