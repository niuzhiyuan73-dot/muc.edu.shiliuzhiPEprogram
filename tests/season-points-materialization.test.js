/**
 * 赛季积分物化到会员行（2026-10-29 第十三轮）
 * ============================================================
 * 积分原来每次读都要把 `events` + `associationTrainings` +
 * `trainingRegistrations` 读回来重算。物化之后：
 *
 *   · 写路径（赛事结算 / 签到确认 / 撤销 / 取消训练）在事务里推
 *     `seasons.version`，事务外重算并把分写到 `schoolMembers` 行上；
 *   · 读路径（榜单、成绩行、个人事实）先看 `pointsSettledVersion === version`，
 *     相等就用行上的值（**零额外读**），不等就回退实时聚合。
 *
 * 这条测试盯四件事：
 *   1. 结算后会员行上真有分，且榜单读不再碰三份事实；
 *   2. 代际落后时回退实时聚合，分数仍然正确（宁可慢，不可错）；
 *   3. 重算只写变化的人（不变化就一次写都不发）；
 *   4. 重算用 update 合并，不覆盖学籍字段；跨赛季能把旧分清掉。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const trainingHandlers = require('../miniprogram/services/association-training-service');
const rankHandlers = require('../miniprogram/services/school-rank-service');
const eventHandlers = require('../miniprogram/services/school-event-service');
const seasonPoints = require('../miniprogram/services/season-points');
const { schoolMemberKey, scopeKey } = require('../miniprogram/utils/school');
const { EVENT_STATUS, MATCH_TYPE } = require('../miniprogram/utils/constants');

const HANDLERS = { ...trainingHandlers, ...rankHandlers, ...eventHandlers };
const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 3600000;
const SCOPE = { schoolId: 'muc', association: 'pkb' };
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({
    _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true,
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await HANDLERS[action](payload, ctx)).data;
}

async function ctxOf(repo, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  return buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
}

/** 直写事实后补一次代际：真实写路径在事务里做这一步，测试播种要自己补。 */
async function bumpPointsVersion(repo) {
  await repo.transaction(tx => seasonPoints.bumpSeasonVersion(tx, SCOPE, NOW));
}

/** 数各集合的整表读次数：用来钉「物化命中后不再读三份事实」。 */
function trackReads(repo) {
  const counts = { events: 0, trainings: 0, registrations: 0, memberRows: 0 };
  const map = [['events', 'events'], ['associationTrainings', 'trainings'],
    ['trainingRegistrations', 'registrations'], ['schoolMembers', 'memberRows']];
  for (const [key, field] of map) {
    const original = repo[key].list.bind(repo[key]);
    repo[key].list = async (...args) => {
      counts[field] += 1;
      return original(...args);
    };
  }
  return counts;
}

/** 数会员行写入次数：用来钉「只写变化的人」。 */
function trackMemberWrites(repo) {
  let count = 0;
  // 受范围仓储的 update 最终落到集合的 set（读-合并-写），所以盯 set 就够。
  const original = repo.schoolMembers.set.bind(repo.schoolMembers);
  repo.schoolMembers.set = async (...args) => {
    count += 1;
    return original(...args);
  };
  return () => count;
}

/** 发布 + 报名 + 提交 + 负责人确认，返回 trainingId。 */
async function confirmedCheckIn(repo, token, { startAt, now } = {}) {
  const pub = await call(repo, 'publishTraining',
    { requestId: token, title: '周末训练', description: '常规训练', location: '综合体育馆', startAt });
  assert.equal(pub.ok, true, pub.message);
  const trainingId = pub.training.trainingId;
  const confirmNow = now || new Date(pub.training.startAt);
  await call(repo, 'registerTraining', { trainingId }, { actor: 'demo_muc_member' });
  await call(repo, 'requestTrainingCheckIn', { trainingId }, { actor: 'demo_muc_member', now: confirmNow });
  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId, userId: 'demo_muc_member' }, { now: confirmNow });
  assert.equal(confirmed.ok, true, confirmed.message);
  return trainingId;
}

const memberRow = async (repo) => repo.schoolMembers.getById(schoolMemberKey('demo_muc_member', 'muc'));

test('签到确认后积分落到会员行，榜单命中物化值且不再读三份事实', async () => {
  const repo = fixture();
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });

  const row = await memberRow(repo);
  assert.equal(row.seasonPoints, 1, '会员行上带着本赛季积分');
  assert.equal(row.pointsAnchor, '', '从未重置时锚点为空串');
  const season = await repo.seasons.getById(scopeKey(SCOPE));
  assert.equal(season.pointsSettledVersion, season.version, '物化已对齐代际');

  const counts = trackReads(repo);
  const stats = await call(repo, 'getSchoolMemberStats', { top: 5 }, { actor: 'demo_muc_member' });
  const mine = stats.top.find(m => m.userId === 'demo_muc_member');
  assert.equal(mine.points, 1, '榜单读到物化值');
  assert.deepEqual([counts.events, counts.trainings, counts.registrations], [0, 0, 0],
    '物化命中后不读赛事 / 训练 / 签到');
  assert.ok(counts.memberRows >= 1, '会员行照常读（积分是顺带的）');
});

test('代际落后时回退实时聚合：分数仍正确，且确实读了三份事实', async () => {
  const repo = fixture();
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });

  // 把代际推到物化之前（模拟「事实变了但还没重算」）
  const id = scopeKey(SCOPE);
  const season = await repo.seasons.getById(id);
  await repo.seasons.set(id, { ...season, version: season.version + 1 });

  const counts = trackReads(repo);
  const stats = await call(repo, 'getSchoolMemberStats', { top: 5 }, { actor: 'demo_muc_member' });
  const mine = stats.top.find(m => m.userId === 'demo_muc_member');
  assert.equal(mine.points, 1, '回退实时聚合后分数不变');
  assert.ok(counts.trainings >= 1 && counts.registrations >= 1, '回退时确实读了训练与签到');
});

test('重算只写变化的人：同一事实重算两次，第二次一次写都不发', async () => {
  const repo = fixture();
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });
  const ctx = await ctxOf(repo);
  const writes = trackMemberWrites(repo);

  const again = await seasonPoints.refreshAssociationPoints(ctx);
  assert.equal(again.written, 0, '分数没变的人不写');
  assert.equal(writes(), 0, '一次写请求都没发');
  assert.equal(again.stale, false, '代际一致');
});

test('重算用 update 合并：学籍字段不被覆盖', async () => {
  const repo = fixture();
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });
  const row = await memberRow(repo);
  assert.equal(row.collegeId, 'c01');
  assert.equal(row.studentId, 'TEST002', '学号仍在');
  assert.equal(row.status, 'active', '在册状态仍在');
});

test('撤销确认把会员行清零；取消训练让该训练的分整体失效', async () => {
  const repo = fixture();
  const trainingId = await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });
  assert.equal((await memberRow(repo)).seasonPoints, 1);

  const revoked = await call(repo, 'revokeTrainingCheckIn',
    { trainingId, userId: 'demo_muc_member', reason: '录错了' }, { now: new Date(at(2 * HOUR)) });
  assert.equal(revoked.ok, true, revoked.message);
  assert.equal((await memberRow(repo)).seasonPoints, 0, '撤销后行上归零');

  // 再确认一次，然后取消整场训练：分同样清零
  await call(repo, 'requestTrainingCheckIn', { trainingId },
    { actor: 'demo_muc_member', now: new Date(at(2 * HOUR)) });
  await call(repo, 'confirmTrainingCheckIn', { trainingId, userId: 'demo_muc_member' },
    { now: new Date(at(2 * HOUR)) });
  assert.equal((await memberRow(repo)).seasonPoints, 1);

  const canceled = await call(repo, 'cancelTraining', { trainingId, reason: '场地临时关闭' },
    { now: new Date(at(3 * HOUR)) });
  assert.equal(canceled.ok, true, canceled.message);
  assert.equal((await memberRow(repo)).seasonPoints, 0, '取消训练后该训练不再计分');
});

test('确认签到走增量维护：不整份重算，代际与行上的值同步前进', async () => {
  const repo = fixture();
  const pub = await call(repo, 'publishTraining',
    { requestId: 'r9', title: '周末训练', description: '常规训练', location: '综合体育馆', startAt: at(HOUR) });
  const trainingId = pub.training.trainingId;
  const startAt = pub.training.startAt;
  await call(repo, 'registerTraining', { trainingId }, { actor: 'demo_muc_member' });
  await call(repo, 'requestTrainingCheckIn', { trainingId },
    { actor: 'demo_muc_member', now: new Date(startAt) });
  // 先把「还没有确认」的状态物化一次，让代际处于已结算
  await seasonPoints.refreshAssociationPoints(await ctxOf(repo));

  const counts = trackReads(repo);
  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId, userId: 'demo_muc_member' }, { now: new Date(startAt) });
  assert.equal(confirmed.ok, true, confirmed.message);

  assert.equal((await memberRow(repo)).seasonPoints, 1, '行上 +1');
  assert.deepEqual([counts.events, counts.trainings, counts.registrations], [0, 0, 0],
    '高频动作不重算：不读赛事 / 训练 / 签到');
  const season = await repo.seasons.getById(scopeKey(SCOPE));
  assert.equal(season.pointsSettledVersion, season.version, '代际与物化值同步前进');
});

test('重算按事务分批：45 个有分的人只开 2 次事务，而不是 45 次', async () => {
  const repo = fixture();
  const ids = [];
  for (let i = 0; i < 45; i += 1) {
    const id = `bulk_${String(i).padStart(2, '0')}`;
    ids.push(id);
    await repo.users.set(id, {
      _id: id, openId: `o_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc',
    });
    await repo.schoolMembers.set(schoolMemberKey(id, 'muc'), {
      _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id,
      collegeId: 'c01', studentId: id, status: 'active',
    });
  }
  await repo.events.set('ev_bulk', {
    _id: 'ev_bulk', schoolId: 'muc', association: 'pkb', title: '大名单赛',
    status: EVENT_STATUS.FINISHED, matchType: MATCH_TYPE.SINGLES, pool: 1, level: 3,
    startTime: at(-3 * 24 * HOUR), finishedAt: at(-2 * 24 * HOUR),
    results: ids.map((userId, index) => ({ userId, placement: index + 1 })),
  });
  await bumpPointsVersion(repo);

  const original = repo.transaction.bind(repo);
  let txs = 0;
  repo.transaction = (fn) => { txs += 1; return original(fn); };

  const result = await seasonPoints.refreshAssociationPoints(await ctxOf(repo));
  assert.equal(result.written, 45, '45 行都要写');
  assert.equal(txs, 2, '30 行一个事务，45 行 = 2 次');
  const rows = await Promise.all(ids.slice(0, 2).map(id => repo.schoolMembers.getById(schoolMemberKey(id, 'muc'))));
  assert.ok(rows.every(row => row.seasonPoints > 0), '每行都拿到分');
});

test('赛事结算走真实写路径：会员行立刻有分，旧赛季锚点被换掉', async () => {
  const repo = fixture();
  // 先把赛季分界划到过去，再结算一场本学期的赛事
  const reset = await call(repo, 'resetSchoolSeason', { resetTime: at(-10 * 24 * HOUR) });
  assert.equal(reset.ok, true, reset.message);

  const ctx = await ctxOf(repo);
  const eventId = 'ev_finished';
  await ctx.repo.forScope(ctx).events.set(eventId, {
    _id: eventId, schoolId: 'muc', association: 'pkb', title: '春季杯', format: 'single_elim',
    status: EVENT_STATUS.ONGOING, matchType: MATCH_TYPE.SINGLES, pool: 1, level: 3,
    startTime: at(-3 * 24 * HOUR), signupCount: 2, revision: 1,
  });
  for (const userId of ['demo_muc_member', 'demo_muc_member_2']) {
    await ctx.repo.forScope(ctx).eventSignups.set(`${eventId}_${userId}`, {
      _id: `${eventId}_${userId}`, schoolId: 'muc', association: 'pkb', eventId,
      userId, status: 'active', revision: 1,
    });
  }

  const finished = await call(repo, 'finishSchoolEvent', {
    eventId,
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'demo_muc_member_2', placement: 2 }],
  });
  assert.equal(finished.ok, true, finished.message);

  const row = await memberRow(repo);
  assert.ok(row.seasonPoints > 0, '结算后会员行立刻有分');
  assert.equal(row.pointsAnchor, new Date(at(-10 * 24 * HOUR)).toISOString(), '锚点跟着赛季走');
  const season = await repo.seasons.getById(scopeKey(SCOPE));
  assert.equal(season.pointsSettledVersion, season.version, '结算事务与重算对上了代际');

  // 只认本赛季：把分界推到这场赛事之后（结算时间是 NOW，分界取 NOW+1h），
  // 重算应当把分与锚点一起换掉
  await repo.seasons.set(scopeKey(SCOPE), {
    ...season, resetTime: at(HOUR), version: season.version + 1,
  });
  const refreshed = await seasonPoints.refreshAssociationPoints(await ctxOf(repo));
  assert.ok(refreshed.cleared >= 1, '跨赛季的旧分被清掉');
  assert.equal((await memberRow(repo)).seasonPoints, 0, '本赛季不再计这场');
});
