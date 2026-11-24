/**
 * B2：forMeet 的两端契约（云端装配 vs 本地模拟仓储）
 * ============================================================
 * 项目有两套仓储实现：云端 `attachSchoolRepository`（测试里用
 * tests/helpers/memory-repo 装配，与云函数同一份代码）与本地模拟的
 * `createSchoolMemoryRepo`。业务只依赖注入的 repo，两者必须可互换。
 *
 * 运动会是本项目第一个**不挂协会**的学校级业务，所以这里除了比对集合与方法面，
 * 还要钉住三件容易写错的事：
 *   1. 写入的文档带 schoolId + meetId，**绝不带 association**（否则等于把运动会
 *      挂到匹克球协会上，停用协会会连带影响运动会）；
 *   2. 跨届、跨校读写一律拒绝，不能靠客户端传参绕过；
 *   3. forScope 不能看见运动会集合，forMeet 也不能看见协会集合——两套范围不许互串。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { MEET_COLLECTIONS } = require('../src/shared/utils/meet-scope.js');
const { SCOPED_COLLECTIONS, SCHOOL_COLLECTIONS } = require('../cloudfunctions/data/src/school-repository.js');

const SCOPE = { schoolId: 'muc', meetId: 'mt_muc_abc' };
const OTHER_MEET = { schoolId: 'muc', meetId: 'mt_muc_xyz' };
const OTHER_SCHOOL = { schoolId: 'pku', meetId: 'mt_muc_abc' };
const RESULT_LEVEL = ['scope', 'transaction'];
const REQUIRED_METHODS = ['getById', 'insert', 'list', 'set', 'update', 'remove'];

const collectionKeys = (surface) => Object.keys(surface).filter((key) => !RESULT_LEVEL.includes(key)).sort();
const methodNames = (target) => Object.keys(target).filter((key) => typeof target[key] === 'function').sort();

const bothCases = [
  ['云端装配', () => createMemoryRepo()],
  ['本地模拟', () => createSchoolMemoryRepo()],
];

test('两端 forMeet 暴露同一组运动会集合', () => {
  for (const [label, make] of bothCases) {
    const surface = make().forMeet(SCOPE);
    assert.deepEqual(collectionKeys(surface), [...MEET_COLLECTIONS].sort(), `${label} 集合清单不符`);
  }
});

test('运动会集合只进基础清单，绝不进协会受范围清单', () => {
  // 这是一条结构性护栏：一旦有人把运动会集合塞进 SCOPED_COLLECTIONS，
  // 每次写入都会被强行加上 association，等于把运动会挂到匹克球协会上。
  for (const key of MEET_COLLECTIONS) {
    assert.ok(SCHOOL_COLLECTIONS.includes(key), `${key} 未进基础集合清单`);
    assert.equal(SCOPED_COLLECTIONS.includes(key), false, `${key} 混进了协会受范围清单`);
  }
});

/**
 * 运动会集合的标准方法面：五件套 + 按需的下推读。
 * 每一项都必须是「两端同时有」——这是本测试后半段逐字比对的依据。
 */
function expectedMethodsOf(key) {
  let expected = [...REQUIRED_METHODS];
  // 录分页只要「本场次的报名与成绩」（2026-10-23 H-9）：一届的报名与成绩可上千条，
  // 而一个场次十几条。报名按编号批读、成绩按 sessionKey 查。
  // 2026-10-26 第五轮 B：凡带 eventKey 的运动会集合统一给 listByProject，
  // 把「读一届再按项目过滤」的 45 处调用点换掉。
  const PROJECT_SCOPED = ['sportsMeetEntries', 'sportsMeetSessions', 'sportsMeetInterests',
    'sportsMeetScores', 'sportsMeetPublications', 'sportsMeetJudgeAssignments', 'sportsMeetResultRows'];
  if (PROJECT_SCOPED.includes(key)) {
    expected = [...expected, 'listByProject'];
  }
  if (key === 'sportsMeetScores' || key === 'sportsMeetJudgeAssignments') {
    expected = [...expected, 'listBySession'];
  }
  if (key === 'sportsMeetJudgeAssignments') expected = [...expected, 'listByJudge'];
  // 我的参赛页只要「我报了哪些项目」（2026-10-23 第三轮 X-9）：意向按 userId、
  // 名单按 userIds（一行是「项目 × 学院」的名额占位，参赛者在数组里）。
  if (key === 'sportsMeetInterests' || key === 'sportsMeetEntries') {
    expected = [...expected, 'listByUser'];
  }
  // 我的荣誉按参赛者下推（第二十二轮 P3）：荣誉表停写后改从发布快照取，
  // 不能把一届全部 publication 读回来再摊平。
  if (key === 'sportsMeetPublications') expected = [...expected, 'listByParticipant'];
  return expected.sort();
}

test('两端 forMeet 每个集合的方法面逐字相同', () => {
  const cloud = createMemoryRepo().forMeet(SCOPE);
  const mock = createSchoolMemoryRepo().forMeet(SCOPE);
  for (const key of MEET_COLLECTIONS) {
    assert.deepEqual(methodNames(mock[key]), methodNames(cloud[key]), `${key} 的方法面对不上`);
    assert.deepEqual(methodNames(cloud[key]), expectedMethodsOf(key), `${key} 的方法面变了，请同步本测试与另一端实现`);
  }
});

test('写入的文档带 schoolId 与 meetId，且不带 association', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);
    await scoped.sportsMeets.set(SCOPE.meetId, { name: '第 59 届田径运动会' });

    const raw = await repo.sportsMeets.getById(SCOPE.meetId);
    assert.equal(raw.schoolId, 'muc', `${label} 未补 schoolId`);
    assert.equal(raw.meetId, SCOPE.meetId, `${label} 未补 meetId`);
    assert.equal('association' in raw, false, `${label} 给运动会塞了 association`);
  }
});

test('跨届读不到：另一届的同一主键读回 null', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);
    await scoped.sportsMeetEntries.set('mtr:1', { note: '本届报名' });

    const otherMeet = repo.forMeet(OTHER_MEET);
    assert.equal(await otherMeet.sportsMeetEntries.getById('mtr:1'), null, `${label} 跨届可读`);
    assert.equal((await otherMeet.sportsMeetEntries.list()).length, 0, `${label} 跨届出现在列表里`);
  }
});

test('跨届写入被拒绝', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);
    await assert.rejects(
      () => scoped.sportsMeetEntries.set('mtr:1', { meetId: OTHER_MEET.meetId }),
      /不能写入其他学校或其他运动会的数据|不属于当前范围/,
      `${label} 允许写入其他届的数据`,
    );
  }
});

test('跨校写入被拒绝', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(OTHER_SCHOOL);
    await assert.rejects(
      () => scoped.sportsMeetEntries.set('mtr:1', { schoolId: 'muc' }),
      /不能写入其他学校或其他运动会的数据/,
      `${label} 允许写入其他学校的数据`,
    );
  }
});

test('重复插入报「记录已存在」，更新不存在的记录报错', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);
    await scoped.sportsMeetColleges.insert({ _id: 'mtcol:1', name: '信息工程学院' });
    await assert.rejects(
      () => scoped.sportsMeetColleges.insert({ _id: 'mtcol:1' }),
      /记录已存在/,
      `${label} 重复插入未拦`,
    );
    await assert.rejects(
      () => scoped.sportsMeetColleges.update('mtcol:none', { x: 1 }),
      /不属于当前范围/,
      `${label} 更新不存在的记录未拦`,
    );
  }
});

test('两套范围不互串：forScope 看不到运动会，forMeet 看不到协会集合', () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scopeSurface = repo.forScope({ schoolId: 'muc', association: 'pkb' });
    for (const key of MEET_COLLECTIONS) {
      assert.equal(scopeSurface[key], undefined, `${label} 的 forScope 暴露了 ${key}`);
    }

    const meetSurface = repo.forMeet(SCOPE);
    for (const key of ['matches', 'events', 'lineups', 'collegeEntries', 'memberRatings']) {
      assert.equal(meetSurface[key], undefined, `${label} 的 forMeet 暴露了 ${key}`);
    }
  }
});

test('事务内可点读、不可整表查；写入随事务提交', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);

    await scoped.transaction(async (tx) => {
      // 事务回调收到的是「已限定范围」的仓储：直接点读集合，不需要再 forMeet。
      assert.equal(typeof tx.sportsMeetQuotaUsage.getById, 'function', `${label} 事务内缺集合`);
      await tx.sportsMeetQuotaUsage.set('mtq:1', { used: 2 });
      const doc = await tx.sportsMeetQuotaUsage.getById('mtq:1');
      assert.equal(doc.used, 2);
      assert.equal(doc.meetId, SCOPE.meetId);
      // list 是同步抛错（两套实现都如此），要用 async 包一层才能被 rejects 接住
      await assert.rejects(async () => tx.sportsMeetQuotaUsage.list(), /事务内/, `${label} 事务内允许整表查`);
    });

    const after = await scoped.sportsMeetQuotaUsage.getById('mtq:1');
    assert.equal(after.used, 2, `${label} 事务写入未落库`);
  }
});

test('事务抛错时运动会写入一并回滚', async () => {
  for (const [label, make] of bothCases) {
    const repo = make();
    const scoped = repo.forMeet(SCOPE);

    await assert.rejects(
      () => scoped.transaction(async (tx) => {
        await tx.sportsMeetQuotaUsage.set('mtq:rollback', { used: 9 });
        throw new Error('业务校验失败');
      }),
      /业务校验失败/,
      label,
    );
    assert.equal(await scoped.sportsMeetQuotaUsage.getById('mtq:rollback'), null, `${label} 未回滚`);
  }
});

test('listByParticipant 只回含该成员的发布快照（第二十二轮 P3）', async () => {
  const repo = createSchoolMemoryRepo({
    sportsMeetPublications: [
      { _id: 'mtp:1:e1:s1', schoolId: 'muc', meetId: 'meet1', eventKey: 'e1', status: 'published',
        rows: [{ entryKey: 'a', userIds: ['u1', 'u2'] }, { entryKey: 'b', userIds: ['u3'] }] },
      { _id: 'mtp:1:e2:s2', schoolId: 'muc', meetId: 'meet1', eventKey: 'e2', status: 'published',
        rows: [{ entryKey: 'c', userIds: ['u3'] }] },
      { _id: 'mtp:9:e1:s1', schoolId: 'muc', meetId: 'meet9', eventKey: 'e1', status: 'published',
        rows: [{ entryKey: 'd', userIds: ['u1'] }] },
    ],
  });
  const scoped = repo.forMeet({ schoolId: 'muc', meetId: 'meet1' });
  const mine = await scoped.sportsMeetPublications.listByParticipant('u1');
  assert.deepEqual(mine.map(doc => doc._id), ['mtp:1:e1:s1'], '只回本场次、且本人参赛的那一条');
  assert.deepEqual(await scoped.sportsMeetPublications.listByParticipant(''), [], '空编号不退化成整表读');
  assert.deepEqual(await scoped.sportsMeetPublications.listByParticipant('nobody'), []);
});
