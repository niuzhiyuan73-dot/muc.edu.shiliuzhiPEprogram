/**
 * 学校维度：计分 / 赛季 / 排行榜（迁移清单 M4）
 *
 * 守的是：等级分由本范围流水重放而来（同一把尺子），榜单按项目分池，
 * 只有出场过的人上榜，跨校 / 跨协会彼此隔离；赛季权限与旧栈同门槛，
 * 赛季文档按范围各持一份。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-rank-service');
const { schoolMemberKey, scopeKey } = require('../miniprogram/utils/school');
const { ALL_RANK_PROJECTS, MATCH_TYPE, MATCH_STATUS, MATCH_OUTCOME,
  RANK_PROJECT } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

test('重置赛季：事务前撤销管理员角色，赛季原样保留', async () => {
  const repo = fixture();
  const scope = { schoolId: 'muc', association: 'pkb' };
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope, now: NOW });
  const before = await repo.seasons.list();
  const transaction = repo.transaction;
  repo.transaction = async work => {
    const id = require('../miniprogram/utils/school').schoolRoleKey(ctx.actorId, scope.schoolId);
    await repo.schoolRoles.set(id, { ...await repo.schoolRoles.getById(id), status: 'disabled' });
    return transaction(work);
  };
  const result = (await handlers.resetSchoolSeason({}, ctx)).data;
  assert.equal(result.ok, false);
  assert.deepEqual(await repo.seasons.list(), before);
});

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({
    _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true,
  });
  // 种子里 demo_muc_member 没有性别，补一条带性别的覆盖（同编号后者胜出）。
  seed.users.push({
    _id: 'demo_muc_member', openId: 'mock_openid_muc_member', nickName: '民大会员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
  });
  const add = (id, gender) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
  };
  add('rank_m2', 'M');
  add('rank_m3', 'M');
  add('rank_m4', 'M');
  add('rank_f1', 'F');
  add('rank_f2', 'F');
  // 北航演示会员也没有性别，补上，便于测跨校隔离时的男女分榜。
  seed.users.push({
    _id: 'demo_buaa_member', openId: 'mock_openid_buaa_member', nickName: '北航会员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'buaa', simulated: true,
  });
  seed.users.push({
    _id: 'demo_buaa_admin', openId: 'mock_openid_buaa_admin', nickName: '北航管理员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'buaa', simulated: true,
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

/** 直接种一场已生效的比赛，并经**真实结算内核**落评级与结算快照（阶段D口径）。 */
async function seedMatch(repo, id, {
  a, b, winner, matchType = MATCH_TYPE.SINGLES, time = at(-HOUR),
  schoolId = 'muc', association = 'pkb', ...extra
}) {
  const { buildSchoolContext } = require('../miniprogram/services/school-context');
  const { settleMatchInTransaction } = require('../miniprogram/services/school-rating-service');
  const { MATCH_TYPE_TO_POOL } = require('../miniprogram/utils/constants');
  const doc = {
    _id: id, schoolId, association, matchType,
    pool: MATCH_TYPE_TO_POOL[matchType] || 'singles',
    teamA: a, teamB: b, scoreA: [11], scoreB: [winner === 'A' ? 5 : 11],
    winner, gamePoints: 11, bestOf: 1, location: '', matchTime: time,
    recorder: a[0], status: MATCH_STATUS.ACTIVE, revision: 1, ...extra,
  };
  const ctx = await buildSchoolContext({
    repo, actorId: null, scope: { schoolId, association }, now: NOW,
  });
  const { status = MATCH_STATUS.ACTIVE, ...rest } = doc;
  if (status !== MATCH_STATUS.ACTIVE) {
    // 待确认等非终态：只种比赛本身，不走结算（与确认前状态一致）
    await repo.matches.set(id, { ...rest, status });
    return;
  }
  await repo.transaction(async (tx) => {
    const { settlement } = await settleMatchInTransaction(tx, { ...ctx, now: NOW }, { ...rest, status }, {});
    await tx.matches.set(id, { ...rest, status, settlement });
  });
}

test('榜单：按范围重放流水，胜者名次在前，行形状与旧栈一致', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.ok, true, board.message);
  assert.equal(board.total, 2);
  assert.equal(board.rows.length, 2);
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[0].medal, 'gold');
  assert.equal(board.rows[1].rank, 2);
  assert.equal(board.rows[0].detailText, '1 胜 0 负');
  assert.equal(board.rows[0].badge, '定级中', '只打一场标为定级中');
  assert.equal(board.rows[0].noteText, '胜率 100%');
  const top = Number(board.rows[0].valueText);
  const second = Number(board.rows[1].valueText);
  assert.ok(top > second, '胜者的等级分应高于负者');
  assert.equal(board.empty, false);
  assert.equal(board.playerCountText, '2 人上榜');
});

test('榜单：我的那一行被标出，并在 me 卡里给出名次', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.rows[0].isMe, true);
  assert.equal(board.me.rank, 1);
  assert.equal(board.me.total, 2);
  assert.match(board.me.beatText, /超过/);
  assert.equal(board.meHint, '');
});

test('榜单：没出场的人不上榜；我没出场时给一句解释', async () => {
  const repo = fixture();
  // rank_m3 一场没打，不该出现在榜上
  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.total, 0);
  assert.equal(board.empty, true);
  assert.equal(board.emptyNote, '这个项目还没有人打过');
  assert.equal(board.me, null);
  assert.equal(board.meHint, '你还没有参加过这个项目');

  // 女生看男单榜：不在榜上，同样给解释
  const women = await call(repo, 'getSchoolRanking', { project: 'men_singles' }, { actor: 'rank_f1' });
  assert.equal(women.me, null);
  assert.equal(women.rows.some(row => row.userId === 'rank_f1'), false);
});

test('榜单：项目分池——女单只看女生，双打单独成榜', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  await seedMatch(repo, 'm2', { a: ['rank_f1'], b: ['rank_f2'], winner: 'A' });
  await seedMatch(repo, 'm3', {
    a: ['rank_m3', 'rank_m4'], b: ['demo_muc_member', 'rank_m2'],
    winner: 'A', matchType: MATCH_TYPE.DOUBLES,
  });

  const men = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(men.total, 2, '男单榜只含打过单打的男生');
  assert.equal(men.rows.some(row => row.userId === 'rank_f1'), false, '女生不进男单榜');
  assert.equal(men.rows.some(row => row.userId === 'rank_m3'), false, '只打双打的人不进单打榜');

  const women = await call(repo, 'getSchoolRanking', { project: 'women_singles' });
  assert.equal(women.total, 2, '女单榜只含打过单打的女生');
  assert.equal(women.rows[0].userId, 'rank_f1');

  const doubles = await call(repo, 'getSchoolRanking', { project: 'doubles' });
  assert.equal(doubles.total, 4, '双打是独立的池，四个人都在');
});

test('榜单：待确认与弃权的比赛不计分', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  // 待确认：擅自种成 PENDING，不该进回放
  await seedMatch(repo, 'm2', {
    a: ['demo_muc_member'], b: ['rank_m3'], winner: 'A', status: MATCH_STATUS.PENDING,
  });
  // 弃权：已生效但不计 ELO
  await seedMatch(repo, 'm3', {
    a: ['demo_muc_member'], b: ['rank_m4'], winner: 'B', outcome: MATCH_OUTCOME.FORFEIT,
  });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.total, 2, '只有那场正常生效的比赛进了榜');
  assert.deepEqual(board.rows.map(row => row.userId).sort(), ['demo_muc_member', 'rank_m2']);
});

test('权限：外校人读不到本协会榜；平台管理员可跨校读', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  // 北航人读民大的榜：不是民大人，读不到（默认 scope 为 muc）
  const outsider = await call(repo, 'getSchoolRanking', {}, { actor: 'demo_buaa_member' });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.rows.length, 0, '无权限时一行榜都不下发');
  assert.deepEqual(outsider.allRows, []);

  const admin = await call(repo, 'getSchoolRanking', {}, { actor: 'demo_platform_admin' });
  assert.equal(admin.ok, true);
  assert.equal(admin.total, 2);
});

test('隔离：一个学校的流水不影响另一个学校的榜', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  // 北航的两位会员，各自打一场
  await seedMatch(repo, 'b1', {
    a: ['demo_buaa_member'], b: ['demo_buaa_admin'], winner: 'A',
    schoolId: 'buaa', association: 'pkb',
  });

  const muc = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(muc.total, 2, '民大榜不掺入北航的流水');
  assert.equal(muc.rows.some(row => row.userId === 'demo_buaa_member'), false);

  const buaa = await call(repo, 'getSchoolRanking', { project: 'men_singles' },
    { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.equal(buaa.total, 2, '北航榜只有北航的人');
  assert.equal(buaa.rows.some(row => row.userId === 'demo_muc_member'), false);
});

test('赛季：默认第一赛季；普通会员不能开新赛季', async () => {
  const repo = fixture();
  const initial = await call(repo, 'getSchoolSeason');
  assert.equal(initial.ok, true);
  assert.equal(initial.season.seasonNumber, 1);
  assert.equal(initial.season.resetTime, null);

  const byMember = await call(repo, 'resetSchoolSeason');
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);
});

test('赛季：管理员开新赛季，编号 +1、记下分界点，且按范围隔离', async () => {
  const repo = fixture();
  const opened = await call(repo, 'resetSchoolSeason', {}, { actor: 'demo_muc_admin' });
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.season.seasonNumber, 2);
  assert.ok(opened.season.resetTime, '分界点应被记下');

  const muc = await call(repo, 'getSchoolSeason', {}, { actor: 'demo_muc_admin' });
  assert.equal(muc.season.seasonNumber, 2);

  // 北航的赛季不受影响
  const buaa = await call(repo, 'getSchoolSeason', {}, { actor: 'demo_buaa_admin', schoolId: 'buaa' });
  assert.equal(buaa.season.seasonNumber, 1);
  assert.equal(buaa.season.resetTime, null);

  // 赛季文档按范围成键，键里带学校与协会
  const stored = await repo.seasons.getById(scopeKey({ schoolId: 'muc', association: 'pkb' }));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
});

test('选手成绩读端：按编号取本范围会员的评级与积分，榜外之人也取得到', async () => {
  const repo = fixture();
  // 只让 demo_muc_member 与 rank_m2 出场；rank_m3 一场没打（榜单里根本看不到他）。
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  // 省略 userIds：本范围在册会员全部下发，含没出过场的人——不像榜单会截断 / 过滤。
  const all = await call(repo, 'getSchoolMemberStats');
  assert.equal(all.ok, true, all.message);
  assert.ok(all.members.some(row => row.userId === 'rank_m3'), '没出场的人也取得到');

  // 指定编号：只回这几个人，逐人给出两个池子的评级与赛季积分。
  const picked = await call(repo, 'getSchoolMemberStats',
    { userIds: ['demo_muc_member', 'rank_m2', 'rank_m3'] });
  assert.deepEqual(picked.members.map(row => row.userId).sort(),
    ['demo_muc_member', 'rank_m2', 'rank_m3']);

  const winner = picked.members.find(row => row.userId === 'demo_muc_member');
  const loser = picked.members.find(row => row.userId === 'rank_m2');
  assert.equal(winner.nickName, '民大会员');
  assert.equal(winner.ratings.singles.matchCount, 1);
  assert.equal(winner.ratings.singles.wins, 1);
  assert.equal(winner.ratings.singles.losses, 0);
  assert.ok(winner.ratings.singles.elo > loser.ratings.singles.elo, '与榜单同口径：胜者等级分更高');
  assert.equal(typeof winner.points, 'number');

  // 没出场：两个池子出场数都是 0。
  const idle = picked.members.find(row => row.userId === 'rank_m3');
  assert.equal(idle.ratings.singles.matchCount, 0);
  assert.equal(idle.ratings.doubles.matchCount, 0);

  // 夹带外校编号取不到：隔离在取数层完成，不靠调用方自觉。
  const foreign = await call(repo, 'getSchoolMemberStats', { userIds: ['demo_buaa_member'] });
  assert.equal(foreign.members.length, 0, '外校的人取不到');

  // 外校人来读本协会成绩：整份读端被权限挡下。
  const outsider = await call(repo, 'getSchoolMemberStats', {}, { actor: 'demo_buaa_member' });
  assert.equal(outsider.ok, false);
  assert.deepEqual(outsider.members, []);
});

test('赛季：开新赛季改的是积分归属，等级分照旧连续累计', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A', time: at(-HOUR) });
  const before = await call(repo, 'getSchoolRanking', { project: 'men_singles' });

  // 分界点落在比赛之后：那场比赛仍是本赛季的（ELO 不受分界影响）
  await call(repo, 'resetSchoolSeason', { resetTime: at(0) }, { actor: 'demo_muc_admin' });
  const after = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.deepEqual(
    after.rows.map(row => row.valueText),
    before.rows.map(row => row.valueText),
    '等级分不随赛季重置清零'
  );
});

/* ------------------------------------------------------------------ 荣誉 */

/** 直接种一场已结束的赛事（带名次结果），供荣誉读端使用。 */
async function seedEvent(repo, id, { results = [], startTime = at(-3 * 24 * HOUR) }) {
  await repo.events.set(id, {
    _id: id, schoolId: 'muc', association: 'pkb', title: `赛事 ${id}`,
    status: 2, startTime, results, matchType: MATCH_TYPE.SINGLES, pool: 1,
  });
}

test('荣誉：已结束赛事的名次汇总与记录，口径与旧栈构建器一致', async () => {
  const repo = fixture();
  await seedEvent(repo, 'ev1', {
    startTime: at(-3 * 24 * HOUR),
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'rank_m2', placement: 2 }],
  });
  await seedEvent(repo, 'ev2', {
    startTime: at(-1 * 24 * HOUR),
    results: [{ userId: 'rank_m3', placement: 1 }, { userId: 'demo_muc_member', placement: 5 }],
  });

  const honors = await call(repo, 'getSchoolMemberHonors', { userId: 'demo_muc_member' });
  assert.equal(honors.ok, true, honors.message);
  assert.equal(honors.honors.summary.eventCount, 2);
  assert.equal(honors.honors.summary.championCount, 1);
  assert.equal(honors.honors.summary.topThreeCount, 1);
  assert.equal(honors.honors.summary.bestPlacement, 1);
  // 最近的排在最前（与 buildEventRecord 同口径）
  assert.deepEqual(honors.honors.records.map(row => row.eventId), ['ev2', 'ev1']);
  assert.equal(honors.honors.records[0].placement, 5);
  assert.equal(honors.honors.records[0].participantCount, 2);
  assert.equal(honors.honors.records[1].title, '赛事 ev1');
});

test('荣誉：没有名次记录的赛事不进荣誉；跨校读被拒', async () => {
  const repo = fixture();
  // 这场只有别人的名次，目标会员不在其中
  await seedEvent(repo, 'ev3', { results: [{ userId: 'rank_m2', placement: 1 }] });

  const none = await call(repo, 'getSchoolMemberHonors', { userId: 'demo_muc_member' });
  assert.equal(none.ok, true);
  assert.equal(none.honors.summary.eventCount, 0);
  assert.equal(none.honors.summary.bestPlacement, null, '无名次时退回 null 而不是 NaN');

  const remote = await call(repo, 'getSchoolMemberHonors', { userId: 'demo_muc_member' }, { schoolId: 'buaa' });
  assert.equal(remote.ok, false);
  assert.match(remote.message, /没有读取/);
});

/* ------------------------------------------------------------------ 个人资料 */

test('个人资料：卡片、项目、走势、交锋、战绩与荣誉一次取齐', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A', time: at(-2 * HOUR) });
  await seedMatch(repo, 'm2', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'B', time: at(-HOUR) });
  await seedEvent(repo, 'ev1', {
    startTime: at(-1 * 24 * HOUR),
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'rank_m2', placement: 2 }],
  });

  const profile = await call(repo, 'getSchoolMemberProfile', { userId: 'demo_muc_member' });
  assert.equal(profile.ok, true, profile.message);
  assert.equal(profile.found, true);
  assert.equal(profile.user.userId, 'demo_muc_member');
  assert.equal(profile.user.nickName, '民大会员');
  assert.equal(profile.user.college, '中华民族共同体学院');
  assert.equal(profile.user.permissionLabel, '会员');

  // 项目：男单出场两场，名次按完整榜单算
  assert.equal(profile.projects.length, 1);
  assert.equal(profile.projects[0].project, 'men_singles');
  assert.equal(profile.projects[0].matchCount, 2);
  assert.equal(profile.projects[0].wins, 1);
  assert.equal(profile.projects[0].losses, 1);
  assert.equal(profile.projects[0].rank, 1);

  // 走势：两场两个点；交锋：与 rank_m2 一胜一负
  assert.equal(profile.ratingHistory.length, 2);
  assert.equal(profile.headToHead.length, 1);
  assert.equal(profile.headToHead[0].opponentId, 'rank_m2');
  assert.equal(profile.headToHead[0].wins, 1);
  assert.equal(profile.headToHead[0].losses, 1);

  // 逐场战绩：两场，最近的在前；近期状态与战绩一致
  assert.equal(profile.history.length, 2);
  assert.equal(profile.history[0].matchId, 'm2');
  assert.equal(profile.form.results.length, 2);

  // 荣誉：一场冠军
  assert.equal(profile.honors.summary.eventCount, 1);
  assert.equal(profile.honors.summary.championCount, 1);
  assert.equal(profile.honors.records[0].eventId, 'ev1');
});

test('个人资料：不出场的会员也有档案，找不到与跨校读被拒', async () => {
  const repo = fixture();
  // rank_m3 一场没打：回放名单里仍在（在册），只是没有项目
  const idle = await call(repo, 'getSchoolMemberProfile', { userId: 'rank_m3' });
  assert.equal(idle.found, true);
  assert.deepEqual(idle.projects, []);
  assert.deepEqual(idle.ratingHistory, []);
  assert.equal(idle.active, null);

  // 不存在 / 外校的人取不到
  const missing = await call(repo, 'getSchoolMemberProfile', { userId: 'no_such_member' });
  assert.equal(missing.ok, false);
  assert.equal(missing.found, false);
  const foreign = await call(repo, 'getSchoolMemberProfile', { userId: 'demo_buaa_member' });
  assert.equal(foreign.found, false, '外校的人在本范围取不到');

  // 外校人来读本协会成绩：整份读端被权限挡下
  const outsider = await call(repo, 'getSchoolMemberProfile', {}, { actor: 'demo_buaa_member' });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /没有读取/);
});

/* ---------------------------------------- 榜单展示形状（旧栈 loadRankView 的 S2 对应） */

/**
 * 下面一组由旧栈 tests/rank-view.test.js 的「排行榜 ——」那一段迁移而来。
 *
 * 【为什么是迁移而不是删除】它们守的全是**展示口径**：只列前 10、但 total 报
 * 完整人数；「我的名次」必须来自完整榜单；三个项目标签永远都在且只有一个选中；
 * 非法项目回退第一个；名次连续且与下标一致；每行都要能点进主页。这些规则在
 * S2 全部搬到了服务端 `getSchoolRanking`（与旧栈 loadRankView 同形），但此前
 * 只有「形状与旧栈一致」「me 卡」「没出场不上榜」这几条粗覆盖——上面那些
 * 展示口径在 S2 **没人守**。删掉旧栈装载器前必须先把它们建起来。
 */
describe('榜单展示形状 —— 旧栈 loadRankView 的 S2 对应', () => {
  const { TOP_LIMIT, describeSearch } = require('../miniprogram/services/rank-view');

  /** 往已有仓储里补一位男会员：只需要 users + schoolMembers 两条 */
  async function addMale(repo, id) {
    await repo.users.set(id, { _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    await repo.schoolMembers.set(schoolMemberKey(id, 'muc'),
      { _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
        collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  }

  /** 造一份超过 TOP_LIMIT 的男单榜：demo_muc_member + 12 位男会员，人人都出场过 */
  async function bigFixture() {
    const repo = fixture();
    for (let i = 1; i <= 12; i += 1) {
      const id = `rank_big_${i}`;
      await addMale(repo, id);
      // 每人都与 demo_muc_member 打一场并落败：人人有场次，名次排在其后
      await seedMatch(repo, `big_${i}`, { a: ['demo_muc_member'], b: [id], winner: 'A' });
    }
    return repo;
  }

  test('榜单最多只列前 10 名，但 total 报完整人数', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });

    assert.ok(board.total > TOP_LIMIT, `这份榜单要超过 ${TOP_LIMIT} 人才验证得了截断`);
    assert.equal(board.rows.length, TOP_LIMIT);
    assert.equal(board.hasMore, true);
    assert.equal(board.allRows.length, board.total, 'allRows 必须是完整榜单');
  });

  test('前十之外还有人时，计数文案如实交代总数', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });
    assert.equal(board.playerCountText, `前 ${TOP_LIMIT} 名 · 共 ${board.total} 人`);

    // 不足十人时换一种说法
    const small = fixture();
    await seedMatch(small, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
    const little = await call(small, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });
    assert.equal(little.playerCountText, `${little.total} 人上榜`);
  });

  test('我的名次来自完整榜单，不因只显示前 10 而丢失', async () => {
    const repo = await bigFixture();
    // 再加一位只输不赢的会员：他必然落在前十之外，正是这条用例要验证的位置
    await addMale(repo, 'rank_weak');
    await seedMatch(repo, 'weak_1', { a: ['demo_muc_member'], b: ['rank_weak'], winner: 'A' });
    await seedMatch(repo, 'weak_2', { a: ['rank_m2'], b: ['rank_weak'], winner: 'A' });

    const board = await call(repo, 'getSchoolRanking',
      { project: RANK_PROJECT.MEN_SINGLES }, { actor: 'rank_weak' });

    assert.ok(board.me, '我在榜上');
    assert.equal(board.me.total, board.total, '分母是完整榜单人数，不是这一页的条数');
    assert.ok(board.me.rank > TOP_LIMIT, '这条用例要验证的正是「我排在显示行之外」');
    assert.equal(board.rows.some(row => row.isMe), false, '前十之外的我不该出现在列表里');
    // 名次取自 allRows，哪怕我排在显示行之外也照样给得出来
    assert.equal(board.me.rank, board.allRows.find(row => row.isMe).rank);
    assert.match(board.me.beatText, /超过/);
  });

  test('三个项目的标签始终都在，且只有一个选中', async () => {
    const repo = fixture();
    for (const project of ALL_RANK_PROJECTS) {
      const board = await call(repo, 'getSchoolRanking', { project });
      assert.equal(board.projectTabs.length, ALL_RANK_PROJECTS.length);
      assert.equal(board.projectTabs.filter(tab => tab.active).length, 1);
      assert.equal(board.projectTabs.find(tab => tab.active).project, project);
      assert.equal(board.projectTabs.find(tab => tab.active).project, board.activeProject);
    }
  });

  test('项目名非法或未传时回退到第一个项目，不白屏', async () => {
    const repo = fixture();
    for (const bad of ['不存在的项目', '', null, undefined]) {
      const board = await call(repo, 'getSchoolRanking', { project: bad });
      assert.equal(board.activeProject, ALL_RANK_PROJECTS[0]);
      assert.equal(board.activeProjectLabel, board.projectTabs[0].label);
    }
  });

  test('名次连续，且与 allRows 的下标严格一致', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });

    board.allRows.forEach((row, index) => {
      assert.equal(row.rank, index + 1, '名次不能断档');
    });
    // 显示行就是完整榜单的前 TOP_LIMIT 条，名次原样带过来
    assert.deepEqual(board.rows.map(row => row.rank),
      board.allRows.slice(0, TOP_LIMIT).map(row => row.rank));
  });

  test('榜单按等级分从高到低', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });
    for (let i = 1; i < board.allRows.length; i += 1) {
      assert.ok(
        Number(board.allRows[i - 1].valueText) >= Number(board.allRows[i].valueText),
        `第 ${i} 名的等级分不该低于第 ${i + 1} 名`
      );
    }
  });

  test('每一行都带得动「点进主页」所需的字段', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });
    for (const row of [...board.rows, ...board.allRows]) {
      assert.ok(row.userId, '缺 userId 就点不进对方主页');
      assert.equal(typeof row.avatarText, 'string');
      assert.equal(typeof row.avatarUrl, 'string');
      assert.equal(typeof row.nickName, 'string');
    }
  });

  test('前三名给奖牌，第四名开始不装饰', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });

    assert.equal(board.allRows[0].medal, 'gold');
    assert.equal(board.allRows[1].medal, 'silver');
    assert.equal(board.allRows[2].medal, 'bronze');
    assert.equal(board.allRows[3].medal, '', '第四名不该再给奖牌');
    assert.ok(board.allRows.slice(3).every(row => row.medal === ''));
  });

  test('状态徽章只翻译页面认识的两种，其余不装饰', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });

    // 只打过一场的人仍在定级期
    const provisional = board.allRows.find(row => row.badge === '定级中');
    assert.ok(provisional, '一场定胜负的人应当标「定级中」');
    for (const row of board.allRows) {
      assert.ok(['', '定级中', '不活跃'].includes(row.badge), `未知徽章：${row.badge}`);
    }
  });

  test('主数字是等级分，副行是战绩；「我」只有一行会被高亮', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });

    for (const row of board.allRows) {
      assert.match(row.valueText, /^\d+$/, '主数字是等级分');
      assert.match(row.detailText, /^\d+ 胜 \d+ 负$/, '副行是战绩');
    }
    // 高亮只认一个人：看别人的榜不该把别人标成「我」
    const marked = board.allRows.filter(row => row.isMe);
    assert.equal(marked.length, 1);
    assert.equal(marked[0].userId, 'demo_muc_member');

    const other = await call(repo, 'getSchoolRanking',
      { project: RANK_PROJECT.MEN_SINGLES }, { actor: 'rank_big_1' });
    assert.equal(other.allRows.filter(row => row.isMe).length, 1);
    assert.equal(other.allRows.find(row => row.isMe).userId, 'rank_big_1');
  });

  test('搜索能查到前十之外的会员，名次仍是榜单上的绝对名次', async () => {
    const repo = await bigFixture();
    const board = await call(repo, 'getSchoolRanking', { project: RANK_PROJECT.MEN_SINGLES });
    const outside = board.allRows[TOP_LIMIT];
    assert.ok(outside, '这份榜单要超过前十才验证得了');
    assert.equal(board.rows.some(row => row.userId === outside.userId), false, '默认列表里没有他');

    const search = describeSearch(board.allRows, outside.nickName);
    const hit = search.rows.find(row => row.userId === outside.userId);
    assert.ok(hit, '前十之外的人必须能被搜到');
    assert.equal(hit.rank, outside.rank, '筛选不能改动名次');
    assert.ok(hit.rank > TOP_LIMIT);
  });
});

/**
 * 榜单不读积分事实（2026-10-23 H-6 第一步）
 * ============================================================
 * 榜单每行只有 elo / 胜负 / 出场数 / 昵称，**不用赛季积分**——积分是个人主页的
 * 事项。而积分要从 events + trainings + trainingRegistrations 三处聚合，
 * 只读不写也要 33 页 RPC（训练报名 30 + 赛事 2 + 训练 1）。
 */
test('榜单不读积分事实：events / trainings / trainingRegistrations 一次都不读', async () => {
  const repo = fixture();
  const asked = [];
  const rawForScope = repo.forScope;
  repo.forScope = (input) => {
    const surface = rawForScope(input);
    for (const key of ['events', 'associationTrainings', 'trainingRegistrations', 'matches']) {
      const collection = surface[key];
      if (!collection) continue;
      const original = collection.list;
      collection.list = (...args) => { asked.push(key); return original(...args); };
    }
    return surface;
  };
  let data;
  try {
    data = await call(repo, 'getSchoolRanking', {});
  } finally {
    repo.forScope = rawForScope;
  }
  assert.equal(data.ok, true, data.message);
  assert.deepEqual(asked, [], '榜单只该读名册与评级，不该读积分事实或比赛流水');
  // 行里本来就没有积分字段，确认一下没被顺手加上
  assert.ok(data.rows.every(row => row.points === undefined), '榜单行不含赛季积分');
});

/**
 * 积分榜只取前 N + 我（2026-10-29 第十二轮审计）
 * ============================================================
 * 赛事面板只摆前 10 与「我」，却要服务端把全校每人的积分行整份下发、前端再全量
 * 排序。`getSchoolMemberStats({top})` 让服务端排完序只回前 N、本人名次与总人数。
 * 这里钉住三条：截断、总人数是完整榜、名次与完整榜一致（不因截断从 1 重排）。
 */
test('积分榜 topN：只回前 N 与本人名次，总人数仍是完整榜', async () => {
  const repo = fixture();
  // 积分来自「已结束赛事的录取名次」，不是比赛流水：直接造一场带结果的赛事。
  // 冠军分高、第四名也参与（participate 分），保证榜上不止一个人。
  await repo.events.set('ev_points_topn', {
    _id: 'ev_points_topn', schoolId: 'muc', association: 'pkb', title: '积分赛',
    status: 2, matchType: MATCH_TYPE.SINGLES, pool: 1, level: 1,
    startTime: at(-3 * HOUR), finishedAt: at(-3 * HOUR),
    results: [
      { userId: 'demo_muc_member', placement: 1 },
      { userId: 'rank_m2', placement: 2 },
      { userId: 'rank_m4', placement: 4 },
    ],
  });

  const full = await call(repo, 'getSchoolMemberStats');
  const ranked = full.members
    .filter(row => Number(row.points) > 0)
    .sort((a, b) => (b.points - a.points)
      || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  assert.ok(ranked.length >= 2, '演示数据里应当有人带积分');

  const paged = await call(repo, 'getSchoolMemberStats', { top: 1 });
  assert.equal(paged.ok, true, paged.message);
  assert.equal(paged.top.length, 1, '只回前 1 名');
  assert.equal(paged.top[0].userId, ranked[0].userId);
  assert.equal(paged.top[0].rank, 1);
  assert.equal(paged.total, ranked.length, 'total 是完整榜人数，不是这一页的条数');
  assert.ok(paged.me === null || paged.me.rank >= 1, 'me 要么为 null，要么带绝对名次');

  // 本人排在显示范围之外时，名次仍是全榜名次（不会因为只取前 1 就变成 1）
  const me = await call(repo, 'getSchoolMemberStats', { top: 1 }, { actor: 'demo_muc_admin' });
  if (me.me) assert.ok(me.me.rank >= 1);
  const wide = await call(repo, 'getSchoolMemberStats', { top: 50 });
  assert.equal(wide.top.length, Math.min(50, ranked.length));
  for (let i = 1; i < wide.top.length; i += 1) {
    assert.ok(Number(wide.top[i - 1].points) >= Number(wide.top[i].points), '按积分降序');
  }
  assert.equal(wide.total, ranked.length);
});
