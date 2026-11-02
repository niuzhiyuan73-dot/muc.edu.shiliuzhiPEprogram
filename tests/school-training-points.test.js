/**
 * B5：训练积分在学校维度计分管线上的收尾（T20 / T22 / T24）
 * ============================================================
 * 训练状态机（提交 / 确认 / 退回 / 撤销）已有 T04–T17、T25 覆盖；这三条
 * 落在「学校维度计分管线」上（school-rank-service 的按范围回放）：
 *
 *   T20  民大匹克球的签到不改变北航 / 民大羽毛球的积分（跨范围隔离）；
 *   T22  确认事务中途故障：签到事实、版本、审计一起回滚；
 *   T24  重置赛季后积分按新边界重算，不落快照、无从复用旧快照。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const groupHandlers = require('../miniprogram/services/association-group-service');
const trainingHandlers = require('../miniprogram/services/association-training-service');
const rankHandlers = require('../miniprogram/services/school-rank-service');
const { buildTrainingPointFacts } = require('../miniprogram/services/training-points');
const { trainingRegistrationKey } = require('../miniprogram/utils/school');
const { MATCH_TYPE, EVENT_STATUS, USER_STATUS } = require('../miniprogram/utils/constants');

const HANDLERS = { ...groupHandlers, ...trainingHandlers, ...rankHandlers };

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 3600000;
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

/** 发布训练并让 demo_muc_member 报名、签到、被负责人确认。 */
async function confirmedCheckIn(repo, token, { startAt, now }) {
  const pub = await call(repo, 'publishTraining',
    { requestId: token, title: '周末训练', description: '常规训练', location: '综合体育馆', startAt });
  assert.equal(pub.ok, true, pub.message);
  const training = pub.training;
  const confirmNow = now || new Date(training.startAt);
  await call(repo, 'registerTraining', { trainingId: training.trainingId }, { actor: 'demo_muc_member' });
  const submitted = await call(repo, 'requestTrainingCheckIn', { trainingId: training.trainingId },
    { actor: 'demo_muc_member', now: confirmNow });
  assert.equal(submitted.ok, true, submitted.message);
  const confirmed = await call(repo, 'confirmTrainingCheckIn',
    { trainingId: training.trainingId, userId: 'demo_muc_member' }, { now: confirmNow });
  assert.equal(confirmed.ok, true, confirmed.message);
  return training;
}

const memberStats = async (repo, opts) => {
  const result = await call(repo, 'getSchoolMemberStats', { userIds: ['demo_muc_member'] }, opts);
  assert.equal(result.ok, true, result.message);
  return result.members[0];
};

/**
 * 直写积分事实（绕过业务写路径）之后必须补一次代际。
 *
 * 赛季积分物化在会员行上（season-points.js）：真实写路径（结算、签到确认/撤销、
 * 取消训练）在事务里推 `seasons.version`，读取端据此判断物化值是否落后。测试若
 * 直接把「已结束赛事」塞进仓储，就必须自己补这一步——否则读到的是旧物化值。
 */
async function bumpPointsVersion(repo) {
  const { bumpSeasonVersion } = require('../miniprogram/services/season-points.js');
  await repo.transaction(tx => bumpSeasonVersion(tx, { schoolId: 'muc', association: 'pkb' }, NOW));
}

test('T20 训练积分按范围隔离：民大匹克球签到不动民大羽球与北航积分', async () => {
  const repo = fixture();
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });

  // 本范围：积分 +1，等级分 / 场数不受训练影响
  const pkb = await memberStats(repo, { actor: 'demo_muc_member' });
  assert.equal(pkb.points, 1, '民大匹克球 +1');
  assert.equal(pkb.ratings.singles.matchCount, 0, '训练不动等级分');

  // 同校另一协会：积分不变
  const tt = await memberStats(repo, { actor: 'demo_muc_member', association: 'tt' });
  assert.equal(tt.points, 0, '民大羽毛球积分不变');

  // 别校：北航会员的积分不变
  const buaa = await call(repo, 'getSchoolMemberStats', { userIds: ['demo_buaa_member'] },
    { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.equal(buaa.ok, true, buaa.message);
  assert.equal(buaa.members[0].points, 0, '北航积分不变');
});

test('T22 确认事务中途故障：签到事实、版本、审计一起回滚', async () => {
  const repo = fixture();
  const pub = await call(repo, 'publishTraining',
    { requestId: 'r1', title: '周末训练', description: '常规训练', location: '综合体育馆', startAt: at(HOUR) });
  const training = pub.training;
  await call(repo, 'registerTraining', { trainingId: training.trainingId }, { actor: 'demo_muc_member' });
  await call(repo, 'requestTrainingCheckIn', { trainingId: training.trainingId },
    { actor: 'demo_muc_member', now: new Date(training.startAt) });

  // 注入故障：审计写入抛错，确认事务中途失败
  const failingRepo = {
    ...repo,
    transaction: (fn) => repo.transaction(async (tx) => fn({
      ...tx,
      audit: { append: async () => { throw new Error('审计服务不可用'); } },
    })),
  };
  await assert.rejects(
    call(failingRepo, 'confirmTrainingCheckIn',
      { trainingId: training.trainingId, userId: 'demo_muc_member' }, { now: new Date(training.startAt) }),
    /审计服务不可用/
  );

  // 一起回滚：仍是 pending、版本停在提交签到后、审计没写、积分事实为 0
  const key = trainingRegistrationKey(training.trainingId, 'demo_muc_member', { schoolId: 'muc', association: 'pkb' });
  const reg = await repo.trainingRegistrations.getById(key);
  assert.equal(reg.attendanceStatus, 'pending');
  assert.equal(reg.revision, 2, '报名 + 提交签到各 +1；确认失败不再 +1');
  const confirmAudits = (await repo.auditLogs.list()).filter((row) => row.action === 'confirmTrainingCheckIn');
  assert.equal(confirmAudits.length, 0, '审计不残留半条');
  const facts = buildTrainingPointFacts({
    trainings: await repo.associationTrainings.list(),
    registrations: await repo.trainingRegistrations.list(),
  });
  assert.equal(facts.length, 0, '积分事实不残留');
});

test('T24 重置赛季后积分按新边界重算；S2 不落快照、无从复用旧快照', async () => {
  const repo = fixture();
  assert.equal(repo.rankings, undefined, 'S2 仓储没有排行榜快照集合，每次现算');

  // 边界之前的训练：发布在未来、确认在开始时刻，随后把赛季分界划到它之后
  await confirmedCheckIn(repo, 'r_old', { startAt: at(HOUR), now: new Date(at(HOUR)) });
  const before = await memberStats(repo, { actor: 'demo_muc_member' });
  assert.equal(before.points, 1, '无边界时计入');

  const reset = await call(repo, 'resetSchoolSeason', { resetTime: at(2 * HOUR) });
  assert.equal(reset.ok, true, reset.message);

  const after = await memberStats(repo, { actor: 'demo_muc_member' });
  assert.equal(after.points, 0, '分界之前的训练积分不再计入本赛季');

  // 分界之后的新训练照常计分
  await confirmedCheckIn(repo, 'r_new', { startAt: at(3 * HOUR), now: new Date(at(3 * HOUR)) });
  const latest = await memberStats(repo, { actor: 'demo_muc_member' });
  assert.equal(latest.points, 1, '新赛季训练积分照常');
});

test('积分合计一致：赛事名次 + 训练签到的总分在统计 / 个人资料 / 积分榜三处一致', async () => {
  const repo = fixture();
  // 来源一：训练签到 +1
  await confirmedCheckIn(repo, 'r1', { startAt: at(HOUR) });
  // 来源二：已结束赛事的名次积分（校级第 1）
  await repo.events.set('ev_finished', {
    _id: 'ev_finished', schoolId: 'muc', association: 'pkb', title: '春季杯',
    status: EVENT_STATUS.FINISHED, matchType: MATCH_TYPE.SINGLES, pool: 1, level: 3,
    startTime: at(-3 * 24 * HOUR), finishedAt: at(-2 * 24 * HOUR),
    results: [{ userId: 'demo_muc_member', placement: 1 }, { userId: 'demo_muc_admin', placement: 2 }],
  });
  // 直写事实后补代际，模拟 finishSchoolEvent 事务里的那一步
  await bumpPointsVersion(repo);

  const stats = await call(repo, 'getSchoolMemberStats', { userIds: ['demo_muc_member'] },
    { actor: 'demo_muc_member' });
  const profile = await call(repo, 'getSchoolMemberProfile', { userId: 'demo_muc_member' },
    { actor: 'demo_muc_member' });

  assert.ok(stats.members[0].points > 1, '两个来源都计入（训练 +1，名次另有分值）');
  assert.equal(profile.user.points, stats.members[0].points, '个人资料与统计读端一致');

  // 积分榜展示（events 面板同款构建器）
  const { buildPointsRows } = require('../miniprogram/services/events-view');
  const panelRows = buildPointsRows(
    stats.members.map((row) => ({ ...row, _id: row.userId, status: USER_STATUS.ACTIVE })),
    new Map(),
    'demo_muc_member'
  );
  const panelRow = panelRows.find((row) => row.userId === 'demo_muc_member');
  assert.ok(panelRow, '积分榜上有本人');
  assert.equal(Number(panelRow.valueText), stats.members[0].points, '积分榜展示与合计一致');
});
