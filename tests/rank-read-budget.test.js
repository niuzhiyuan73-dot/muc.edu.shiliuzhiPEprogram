/**
 * 榜单的读量（2026-10-23 方案 A 第 3 步）
 * ============================================================
 * 榜单原来无论要几行，都得把名册（20 页）+ 全部账号（20 页）+ 全部评级
 * （2000 人 × 4 池 = 80 页）读回来在内存里排。贵的根源是「排序键 elo 在评级表、
 * 过滤键性别 / 在册状态在名册」，数据库不能跨集合 join。
 *
 * 把两个字段冗余进评级表之后，只要 5 个 RPC 就够：前 N 一页、两次计数、
 * 一次按人取评级、一次批读账号。这条测试盯三件事：
 *   1. **不再整表读评级**（有人改回 list() 就红）；
 *   2. 名次与人数仍然正确，包括**排在前 50 之外的我**；
 *   3. 已转出的人不上榜（冗余字段真的被用上了）；
 *   4. 回填没跑时回落旧路径，榜单不会变空。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const rank = require('../src/server/services/school-rank-service');
const {
  collegeKey, schoolMemberKey, memberRatingKey, schoolAssociationKey, SCHOOL_MEMBER_STATUS,
} = require('../src/shared/utils/school');
const { RATING_POOL } = require('../src/shared/utils/constants');

const SCHOOL = 'muc';
const ASSOC = 'pkb';
const NOW = new Date('2026-10-23T10:00:00Z');
const SCOPE = { schoolId: SCHOOL, association: ASSOC };

/** 造 n 个男生 + n 个女生，评级一人一条（单打池），elo 依次递减。 */
function fixture({ men = 60, women = 5 } = {}) {
  const people = [];
  for (let i = 1; i <= men; i += 1) people.push({ id: `m${String(i).padStart(2, '0')}`, gender: 'M' });
  for (let i = 1; i <= women; i += 1) people.push({ id: `f${String(i).padStart(2, '0')}`, gender: 'F' });

  const users = people.map(p => ({
    _id: p.id, openId: `o_${p.id}`, nickName: p.id, gender: p.gender,
    platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
  }));
  const schoolMembers = people.map(p => ({
    _id: schoolMemberKey(p.id, SCHOOL), schoolId: SCHOOL, userId: p.id,
    collegeId: 'c01', status: SCHOOL_MEMBER_STATUS.ACTIVE,
  }));
  // 男生的 elo 从 1700 递减，第一名 m01
  const memberRatings = people.map((p, index) => ({
    _id: memberRatingKey(p.id, RATING_POOL.SINGLES, SCOPE),
    schoolId: SCHOOL, association: ASSOC, userId: p.id, pool: RATING_POOL.SINGLES,
    elo: p.gender === 'M' ? 1700 - index : 1300 - index,
    startElo: 1450, matchCount: 3, wins: 2, losses: 1,
    // 方案 A 的冗余字段：查询要用它筛项目与在册状态
    gender: p.gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE,
  }));

  return createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, schoolMembers, memberRatings,
    colleges: [{ _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '一院', status: 'active' }],
    schoolAssociations: [{
      _id: schoolAssociationKey(SCOPE), schoolId: SCHOOL, association: ASSOC, status: 'active',
    }],
  });
}

/** 记录走的是哪条取数路（包装 forScope 返回的集合方法）。 */
function spyScope(repo) {
  const calls = [];
  const raw = repo.forScope;
  repo.forScope = (input) => {
    const surface = raw(input);
    const collection = surface.memberRatings;
    if (collection) {
      for (const method of ['list', 'listTop', 'countRanked', 'listByUser']) {
        if (typeof collection[method] !== 'function') continue;
        const original = collection[method];
        collection[method] = (...args) => {
          calls.push({ method, args });
          return original.apply(collection, args);
        };
      }
    }
    return surface;
  };
  return calls;
}

async function callRanking(repo, payload = {}, actor = 'm55') {
  const ctx = await buildSchoolContext({
    repo, actorId: actor, scope: SCOPE, now: NOW,
  });
  return (await rank.getSchoolRanking(payload, ctx)).data;
}

describe('榜单读量：条件下推', () => {
  test('不再整表读评级：走 listTop / countRanked / listByUser', async () => {
    const repo = fixture();
    const calls = spyScope(repo);
    const data = await callRanking(repo, {});
    assert.equal(data.ok, true, data.message);

    assert.ok(!calls.some(call => call.method === 'list'),
      '整表读 memberRatings 回来了——那是这轮要消掉的 80 页');
    assert.ok(calls.some(call => call.method === 'listTop'), '要用 listTop 取前 N');
    assert.ok(calls.some(call => call.method === 'countRanked'), '要用聚合计数拿总人数');
  });

  test('前 10 行按 elo 降序，人数是聚合计数（不是取回来再数）', async () => {
    const repo = fixture();
    const data = await callRanking(repo, { project: 'men_singles' });
    assert.equal(data.total, 60, '60 个男生都上过场');
    assert.equal(data.rows.length, 10);
    assert.deepEqual(data.rows.map(row => row.userId),
      ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10']);
    assert.equal(data.rows[0].rank, 1);
    assert.equal(data.rows[0].medal, 'gold');
    assert.equal(data.hasMore, true);
    assert.equal(data.playerCountText, '前 10 名 · 共 60 人');
  });

  test('女单榜只算女生：同一个单打池，性别在评级表上被下推过滤', async () => {
    const repo = fixture();
    const data = await callRanking(repo, { project: 'women_singles' });
    assert.equal(data.total, 5);
    assert.deepEqual(data.rows.map(row => row.userId), ['f01', 'f02', 'f03', 'f04', 'f05']);
  });

  test('排在 50 名之外的我：名次照算，且单独补一行进搜索范围', async () => {
    const repo = fixture();
    // m55 的 elo 是 1700 - 54 = 1646，前面有 54 个人
    const data = await callRanking(repo, {}, 'm55');
    assert.equal(data.me.rank, 55);
    assert.equal(data.me.total, 60);
    const mine = data.allRows.find(row => row.isMe);
    assert.ok(mine, '榜外也要有「我」这一行，否则搜索搜不到自己');
    assert.equal(mine.rank, 55);
    assert.equal(data.rows.length, 10, '前 10 不变，我追加在后面');
  });

  test('已转出的人不上榜：冗余的 memberStatus 真的被用上了', async () => {
    const repo = fixture();
    // 把原本第 2 名标成已转出
    const second = await repo.memberRatings.getById(
      memberRatingKey('m02', RATING_POOL.SINGLES, SCOPE),
    );
    await repo.memberRatings.set(second._id, { ...second, memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED });

    const data = await callRanking(repo, { project: 'men_singles' });
    assert.equal(data.total, 59, '转出的人不占名次');
    assert.ok(!data.rows.some(row => row.userId === 'm02'), 'm02 不该出现在榜上');
    assert.equal(data.rows[1].userId, 'm03', '后面的人顺位递补');
  });

  test('新库榜单不执行旧数据回填巡检', async () => {
    const repo = fixture();
    const calls = spyScope(repo);
    assert.equal((await callRanking(repo)).total, 60);
    assert.ok(!calls.some(call => call.args[0] && call.args[0].missingProfile));
  });
});

describe('选手成绩读端：按编号下推（2026-10-26 只读审查 P2-6）', () => {
  /** 数「点读学籍 / 评级」与「整表读」各发生几次。 */
  function spyCollections(repo) {
    const counter = { memberPoint: 0, memberList: 0, ratingPoint: 0, eventList: 0, trainingList: 0, registrationList: 0 };
    const wrap = (target, method, key) => {
      const original = target[method];
      if (typeof original !== 'function') return;
      target[method] = (...args) => { counter[key] += 1; return original.apply(target, args); };
    };
    wrap(repo.schoolMembers, 'getById', 'memberPoint');
    wrap(repo.schoolMembers, 'list', 'memberList');
    wrap(repo.memberRatings, 'getById', 'ratingPoint');
    wrap(repo.events, 'list', 'eventList');
    wrap(repo.associationTrainings, 'list', 'trainingList');
    wrap(repo.trainingRegistrations, 'list', 'registrationList');
    return counter;
  }

  const statsOf = async (repo, payload) => {
    const ctx = await buildSchoolContext({ repo, actorId: 'm55', scope: SCOPE, now: NOW });
    // 上下文构建本身要读一次本人的学籍/账号，那不是被计量的取数，装好之后再开始数
    const counter = spyCollections(repo);
    const data = (await rank.getSchoolMemberStats(payload, ctx)).data;
    return { data, counter };
  };

  test('查一个人不再整表读名册与评级', async () => {
    const repo = fixture();
    const { data, counter } = await statsOf(repo, { userIds: ['m01'] });

    assert.equal(data.ok, true, data.message);
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].userId, 'm01');
    assert.equal(counter.memberList, 0, '不能整表读学籍——那是「查一个人读全校」的根源');
    assert.ok(counter.memberPoint <= 1, `学籍点读 ${counter.memberPoint} 次，应只读这一个人`);
    // 一个人 4 个评级池，最多 4 次点读
    assert.ok(counter.ratingPoint <= 4, `评级点读 ${counter.ratingPoint} 次，应只读这个人的池`);
  });

  test('ratingsOnly 只取评级计数：不读赛事、训练、训练报名', async () => {
    const repo = fixture();
    const { data, counter } = await statsOf(repo, { userIds: ['m01'], ratingsOnly: true });

    assert.equal(data.ok, true, data.message);
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].ratings.singles.matchCount, 3, '场次来自评级表');
    assert.equal(counter.eventList, 0, '选默认协会不需要赛事流水');
    assert.equal(counter.trainingList, 0);
    assert.equal(counter.registrationList, 0);
    assert.equal(data.members[0].points, 0, '不算积分时给 0，不假装算过');
  });

  test('ratingsOnly 未指定会员时明确拒绝，不返回一堆没有 points 的行', async () => {
    const repo = fixture();
    const { data } = await statsOf(repo, { ratingsOnly: true });
    assert.equal(data.ok, false);
    assert.match(data.message, /会员编号/);
  });

  test('外校账号与已转出的会员按编号也取不到（隔离在取数层）', async () => {
    const repo = fixture();
    const { data } = await statsOf(repo, { userIds: ['m01', 'not_exists'] });
    assert.equal(data.ok, true);
    assert.deepEqual(data.members.map(row => row.userId), ['m01']);
  });
});

test('回填巡检只在显式 diagnose 时发生，并回报缺失条数（第二十二轮 P3）', async () => {
  const repo = fixture();
  const plain = await callRanking(repo);
  assert.equal(plain.diagnostics, undefined, '默认读路径不付巡检这笔聚合');

  const diagnosed = await callRanking(repo, { diagnose: true });
  assert.deepEqual(diagnosed.diagnostics, { missingMemberStatus: 0 }, '新库回填完整时应为 0');
  assert.equal(diagnosed.total, plain.total, '诊断不改变榜单内容');
});
