/**
 * 学校维度：比赛记录状态机（迁移清单 M1-b）
 *
 * 守的是：录入 / 确认 / 驳回 / 撤销 / 弃权的权限与流转与旧栈同口径，
 * 且每条记录都钉在 `schoolId + association` 上，跨校读不到、写不进。
 * 签表晋级（advanceEvent）属 M1-a2，本片不测。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RATED_PAIR_LIMIT } = require('../src/shared/utils/constants');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-match-service');
const {
  schoolMemberKey, schoolMatchKey, schoolKey, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS,
} = require('../src/shared/utils/school');
const {
  MATCH_TYPE, MATCH_STATUS, MATCH_OUTCOME,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  const add = (id, gender = 'M') => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member');            // 参赛者甲（也是录入者）
  add('demo_muc_member_2');          // 参赛者乙（对手）
  add('demo_muc_member_3');          // 无关的普通会员
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const casual = (extra = {}) => ({
  matchType: MATCH_TYPE.SINGLES, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
  scoreA: [11], scoreB: [9], gamePoints: 11, bestOf: 1, matchTime: at(-HOUR), ...extra,
});

async function record(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'submitSchoolMatch', { requestId: token, ...casual(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.match;
}

test('录入：参赛者可录，非参赛的普通会员被拒', async () => {
  const repo = fixture();
  const byPlayer = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() },
    { actor: 'demo_muc_member' });
  assert.equal(byPlayer.ok, true, byPlayer.message);
  assert.equal(byPlayer.match.status, MATCH_STATUS.PENDING);
  assert.equal(byPlayer.match.winner, 'A', '胜负由比分推出');

  const byStranger = await call(repo, 'submitSchoolMatch', { requestId: 'r2', ...casual() },
    { actor: 'demo_muc_member_3' });
  assert.equal(byStranger.ok, false);
  assert.match(byStranger.message, /参赛者/);
});

test('录入：请求编号幂等，改内容重发被拒', async () => {
  const repo = fixture();
  const first = await record(repo, 'r1');
  const again = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() });
  assert.equal(again.ok, true);
  assert.equal(again.match.matchId, first.matchId);

  const changed = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual({ scoreA: [11], scoreB: [5] }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);
});

test('确认：严格口径下只有对手能确认，录入方自己不行', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const byRecorder = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member' });
  assert.equal(byRecorder.ok, false, '录入方不能给自己盖章');

  const byOpponent = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(byOpponent.ok, true, byOpponent.message);
  assert.equal(byOpponent.match.status, MATCH_STATUS.ACTIVE);
});

test('确认即结算：同一比赛重复确认幂等，已结算后驳回/弃权均被拒', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');
  const first = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(first.ok, true, first.message);
  const ratingDoc = await repo.memberRatings.getById(
    require('../src/shared/utils/school.js').memberRatingKey('demo_muc_member', 'singles',
      { schoolId: 'muc', association: 'pkb' }));
  const counterId = require('../src/shared/utils/school.js').ratingSeqKey({ schoolId: 'muc', association: 'pkb' });
  const afterFirst = { rating: ratingDoc && ratingDoc.elo, seq: (await repo.ratingCounters.getById(counterId)).seq };

  // 确认响应丢失后的重试：返回既有结果，评级与序号纹丝不动
  const retry = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(retry.ok, true, retry.message);
  const ratingAgain = await repo.memberRatings.getById(ratingDoc._id);
  assert.equal(ratingAgain.elo, afterFirst.rating, '重复确认不再加分');
  assert.equal(ratingAgain.matchCount, 1);
  assert.equal((await repo.ratingCounters.getById(counterId)).seq, afterFirst.seq, '序号不再消耗');

  // 已结算比赛封口：驳回（requirePending）与弃权（canForfeit 仅待确认）都被拒
  const reject = await call(repo, 'rejectSchoolMatch',
    { matchId: match.matchId, reason: '不认' }, { actor: 'demo_muc_member_2' });
  assert.equal(reject.ok, false);
  const forfeit = await call(repo, 'forfeitSchoolMatch',
    { matchId: match.matchId, forfeitBy: 'demo_muc_member' }, { actor: 'demo_muc_member' });
  assert.equal(forfeit.ok, false);
  const stored = await repo.matches.getById(match.matchId);
  assert.equal(stored.status, MATCH_STATUS.ACTIVE);
  assert.ok(stored.settlement && stored.settlement.settlementSeq >= 1);
});

test('弃权：终态封口带不计分结算快照，且不占评级', async () => {
  const repo = fixture();
  // 直接种一场带 eventId 的赛事比赛并记弃权
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', 'evf1'), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb', eventId: 'evt1',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
  });
  const forfeited = await call(repo, 'forfeitSchoolMatch', { matchId, forfeitBy: 'demo_muc_member' },
    { actor: 'demo_muc_member' });
  assert.equal(forfeited.ok, true, forfeited.message);
  const stored = await repo.matches.getById(matchId);
  assert.equal(stored.status, MATCH_STATUS.ACTIVE);
  assert.equal(stored.settlement.status, 'excluded', '弃权写不计分快照');
  assert.equal(stored.settlement.exclusionReason, 'forfeit');
  assert.equal(stored.settlement.settlementSeq, null, '不计分不占序号');
  // 参赛者没有评级文档被建出来
  const ratingKey = require('../src/shared/utils/school.js').memberRatingKey;
  assert.equal(await repo.memberRatings.getById(ratingKey('demo_muc_member', 'singles', { schoolId: 'muc', association: 'pkb' })), null);
});

test('确认：管理员可确认任意一场；无比分不能确认', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const admin = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_admin' });
  assert.equal(admin.ok, true, admin.message);

  // 无比分（抽签生成）的比赛不能确认：直接种一条待确认、无胜方的记录。
  const blankId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', 'r2'), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(blankId, {
    _id: blankId, schoolId: 'muc', association: 'pkb',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
  });
  const noScore = await call(repo, 'confirmSchoolMatch', { matchId: blankId },
    { actor: 'demo_muc_member_2' });
  assert.equal(noScore.ok, false);
  assert.match(noScore.message, /还没有比分/);
});

test('驳回：须填理由，状态落到已撤销（action=reject）', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const noReason = await call(repo, 'rejectSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /理由/);

  const rejected = await call(repo, 'rejectSchoolMatch',
    { matchId: match.matchId, reason: '比分记错了' }, { actor: 'demo_muc_member_2' });
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal(rejected.match.status, MATCH_STATUS.REVOKED);
  assert.equal(rejected.match.action, 'reject');
});

test('撤销已取消：action 不在协议 2 白名单，已结算比赛没有撤销入口', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');
  const confirmed = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(confirmed.ok, true, confirmed.message);

  // 撤销动作已随 Elo 逐场结算改造从协议 2 删除：白名单与实现里都没有它
  const actions = require('../src/shared/utils/school-actions.js');
  assert.equal(actions.SCHOOL_SPACE_ACTIONS.includes('revokeSchoolMatch'), false,
    '撤销动作不应在协议 2 白名单里');
  const write = require('../miniprogram/utils/write.js');
  assert.equal(write.SCHOOL_WRITE_ACTIONS.includes('revokeSchoolMatch'), false,
    '撤销动作不应在写操作名单里');

  // 服务端实现也不再导出：旧 action 无从构造
  assert.equal(typeof require('../src/server/services/school-match-service.js').revokeSchoolMatch,
    'undefined', '撤销实现已删除');
  assert.ok(confirmed.match.settlement, '确认即结算：比赛带结算快照');
});

test('弃权：日常约球不能弃；赛事比赛本人可弃，胜方判给对手', async () => {
  const repo = fixture();
  const casualMatch = await record(repo, 'r1');
  const casualForfeit = await call(repo, 'forfeitSchoolMatch', { matchId: casualMatch.matchId },
    { actor: 'demo_muc_member' });
  assert.equal(casualForfeit.ok, false, '日常约球没有晋级，谈不上弃权');

  // 直接种一场带 eventId 的赛事比赛（抽签签表见 M1-a2）。
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', 'evm1'), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb', eventId: 'evt1',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
  });
  const forfeited = await call(repo, 'forfeitSchoolMatch', { matchId },
    { actor: 'demo_muc_member' });
  assert.equal(forfeited.ok, true, forfeited.message);
  assert.equal(forfeited.match.status, MATCH_STATUS.ACTIVE);
  assert.equal(forfeited.match.outcome, MATCH_OUTCOME.FORFEIT);
  assert.equal(forfeited.match.winner, 'B', '甲弃权则乙获胜');
});

/* ---------- M1-a2 剩余：既有赛程比赛按 matchId 补录 ---------- */

/** 种一条抽签排定的待确认比赛（个人赛签表场次）。 */
async function seedScheduled(repo, id, extra = {}) {
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', id), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb', eventId: 'evt1', round: 1, stage: 'main', slot: 1,
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '一号场',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
    ...extra,
  });
  return matchId;
}

test('补录：既有赛程比赛按 matchId 补分，就地更新、不另立记录', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');
  const before = await repo.matches.getById(matchId);

  const filled = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { actor: 'demo_muc_member' });
  assert.equal(filled.ok, true, filled.message);
  assert.equal(filled.match.matchId, matchId, '就地更新，编号不变');
  assert.equal(filled.match.status, MATCH_STATUS.PENDING);
  assert.equal(filled.match.winner, 'A', '胜负由比分推');
  assert.equal(filled.match.location, '一号场', '场地取自原记录');
  assert.deepEqual(filled.match.teamA, ['demo_muc_member'], '对阵取自原记录');

  // 库里仍只有这一条（补录不改立新记录）
  const all = await repo.forScope({ schoolId: 'muc', association: 'pkb' }).matches.list();
  assert.equal(all.length, 1);
  // 版本递增；比赛时间保持原 ISO 字符串（不写 Date 对象进库）
  const after = await repo.matches.getById(matchId);
  assert.equal(after.revision, 2);
  assert.equal(after.matchTime, before.matchTime);
});

test('补录：非参赛的普通会员被拒；确认生效后不能再补录', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');

  const stranger = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { actor: 'demo_muc_member_3' });
  assert.equal(stranger.ok, false);
  assert.match(stranger.message, /参赛者/);

  // 参赛者补分 → 对手确认生效 → 再补录被拒（非「待确认」）
  await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] }, { actor: 'demo_muc_member' });
  await call(repo, 'confirmSchoolMatch', { matchId }, { actor: 'demo_muc_member_2' });
  const again = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [3] },
    { actor: 'demo_muc_member' });
  assert.equal(again.ok, false);
  assert.match(again.message, /待确认/);
});

test('比赛读端：签表编排字段（轮次 / 阶段 / 签位 / 场号 / 分组）随记录下发', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1', { group: 0, courtNo: 2 });

  const got = await call(repo, 'getSchoolMatch', { matchId });
  assert.equal(got.ok, true, got.message);
  assert.equal(got.match.round, 1);
  assert.equal(got.match.stage, 'main');
  assert.equal(got.match.slot, 1);
  assert.equal(got.match.group, 0);
  assert.equal(got.match.courtNo, 2);

  // 列表与详情同一契约：签表 / 分组 / 场地展示共享这些字段。
  const listed = await call(repo, 'listSchoolMatches', { eventId: 'evt1' });
  const row = listed.matches.find(item => item.matchId === matchId);
  assert.ok(row, '补录比赛出现在列表里');
  assert.equal(row.round, 1);
  assert.equal(row.courtNo, 2);
});

test('补录：跨校补不进', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');
  const buaa = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /找不到/);
});

test('指派裁判：仅管理员；裁判须在册，生效后不能改派', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const byMember = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false, '普通会员不能指派');

  const ghost = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'nobody' }, { actor: 'demo_muc_admin' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /找不到/);

  const assigned = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_admin' });
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal(assigned.match.referee, 'demo_muc_member_3');

  // 生效后不能改派：指定裁判后由裁判确认。
  await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_3' });
  const afterActive = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: '' }, { actor: 'demo_muc_admin' });
  assert.equal(afterActive.ok, false);
  assert.match(afterActive.message, /生效/);
});

test('防刷分：一对会员打满上限后不再让录', async () => {
  const repo = fixture();
  for (let i = 0; i < 15; i += 1) {
    const id = `seed_${i}`;
    await repo.matches.set(id, {
      _id: id, schoolId: 'muc', association: 'pkb',
      matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
      scoreA: [11], scoreB: [9], winner: 'A', gamePoints: 11, bestOf: 1, location: '',
      matchTime: at(-2 * HOUR - i * 60000), recorder: 'demo_muc_member',
      status: MATCH_STATUS.ACTIVE, revision: 1,
    });
  }
  const blocked = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /上限/);
});

test('跨学校：外校读不到也写不进', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const buaaList = await call(repo, 'listSchoolMatches', {}, {
    schoolId: 'buaa', actor: 'demo_buaa_member',
  });
  assert.equal(buaaList.ok, true);
  assert.equal(buaaList.matches.length, 0);

  const buaaGet = await call(repo, 'getSchoolMatch', { matchId: match.matchId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member',
  });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /找不到/);
});

test('录入上下文：身份与名单不跨校，访客不获得成员或录入权', async () => {
  const repo = fixture();
  const own = await call(repo, 'getSchoolMatchEntryContext');
  assert.equal(own.canRecord, true);
  assert.equal(own.viewer.userId, 'demo_muc_member');
  assert.ok(own.members.some(m => m.userId === 'demo_muc_member_2'));
  assert.ok(own.members.every(m => !m.userId.startsWith('demo_buaa')));
  for (const opts of [{ actor: '' }, { schoolId: 'buaa' }]) {
    const denied = await call(repo, 'getSchoolMatchEntryContext', {}, opts);
    assert.equal(denied.canRecord, false);
    assert.deepEqual(denied.members, []);
    assert.equal(denied.pairInfo, null);
  }
});

test('列表：先按本人及状态过滤再截断，数量和更多标记准确', async () => {
  const repo = fixture();
  const first = await record(repo, 'list_first');
  await record(repo, 'list_second');
  await call(repo, 'confirmSchoolMatch', { matchId: first.matchId }, { actor: 'demo_muc_member_2' });
  const mine = await call(repo, 'listSchoolMatches', { userId: 'demo_muc_member', limit: 1 });
  assert.equal(mine.total, 2);
  assert.equal(mine.hasMore, true);
  assert.equal(mine.pendingCount, 1);
  const pending = await call(repo, 'listSchoolMatches', { userId: 'demo_muc_member', status: MATCH_STATUS.PENDING, limit: 1 });
  assert.equal(pending.total, 1);
  assert.equal(pending.hasMore, false);
  assert.equal(pending.matches[0].canSubmitScore, true);
  assert.equal(pending.matches[0].canRecord, false, '已填比分不显示首次录分按钮');
});

test('新赛季：交手次数提示与提交上限同时清零', async () => {
  const repo = fixture();
  for (let i = 0; i < RATED_PAIR_LIMIT; i += 1) {
    const match = await record(repo, `old_${i}`);
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }
  assert.equal((await call(repo, 'getSchoolMatchEntryContext')).pairInfo.counts.demo_muc_member_2, RATED_PAIR_LIMIT);
  const { scopeKey } = require('../src/shared/utils/school');
  const scope = { schoolId: 'muc', association: 'pkb' };
  await repo.seasons.set(scopeKey(scope), { ...scope, resetTime: at(-HOUR / 2) });
  assert.deepEqual((await call(repo, 'getSchoolMatchEntryContext')).pairInfo.counts, {});
  const result = await call(repo, 'submitSchoolMatch', { requestId: 'new_season', ...casual({ matchTime: at(-1000) }) });
  assert.equal(result.ok, true, result.message);
});

test('记录带范围：schoolId + association；非在册裁判被拒', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');
  const stored = await repo.matches.getById(match.matchId);
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');

  // 把会员停用后不能再当裁判。
  const key = schoolMemberKey('demo_muc_member_3', 'muc');
  const member = await repo.schoolMembers.getById(key);
  await repo.schoolMembers.set(key, { ...member, status: 'left' });
  const refused = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_admin' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /在册/);
});

test('在册判定使用 S2 字符串状态常量', () => {
  assert.equal(PLATFORM_STATUS.ACTIVE, 'active');
  assert.equal(SCHOOL_MEMBER_STATUS.ACTIVE, 'active');
});

/* ============================================================
 * 2026-10-16 独立验收的 5 条缺陷（F1/F5 高，F2/F3/F4 中）
 * ============================================================
 * 探针脚本 tools/acceptance-audit.cjs 证明了它们存在；这一节把它们固化成
 * 正式用例，并补上相邻边界，免得下次重构又把规则漏回去。
 */

/** 把某个账号的平台状态改掉（停用 / 恢复）。 */
async function setPlatformStatus(repo, userId, status) {
  const user = await repo.users.getById(userId);
  await repo.users.set(userId, { ...user, platformStatus: status });
}

/** 把某人的学籍 / 校级角色 / 协会身份改状态。 */
async function setMemberStatus(repo, userId, status) {
  const key = schoolMemberKey(userId, 'muc');
  const row = await repo.schoolMembers.getById(key);
  await repo.schoolMembers.set(key, { ...row, status });
}

async function setSchoolRoleStatus(repo, userId, status) {
  const { schoolRoleKey } = require('../src/shared/utils/school');
  const key = schoolRoleKey(userId, 'muc');
  const row = await repo.schoolRoles.getById(key);
  if (row) await repo.schoolRoles.set(key, { ...row, status });
}

/** 往仓储里补一位在册会员（不动共享 fixture，免得影响既有用例的名单断言）。 */
async function addMember(repo, id, gender = 'M') {
  await repo.users.set(id, { _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
    platformStatus: PLATFORM_STATUS.ACTIVE, platformRole: 'member', primarySchoolId: 'muc' });
  await repo.schoolMembers.set(schoolMemberKey(id, 'muc'),
    { _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', collegeId: 'c01', status: 'active' });
}

/** 手工往仓储里塞一场比赛文档（绕过服务端），用于构造签表场景。 */
async function putMatch(repo, doc) {
  await repo.matches.set(doc._id, doc);
  return doc;
}

/** 签表比赛的通用形状：带 eventId + stage + round，才被判为「签表推出来的」。 */
const bracketMatchDoc = (extra = {}) => ({
  _id: 'm_x', eventId: 'ev_1', stage: 'main', round: 1, slot: 0,
  schoolId: 'muc', association: 'pkb', matchType: MATCH_TYPE.SINGLES, pool: 'singles',
  competition: 'personal', gamePoints: 11, bestOf: 1, teamA: [], teamB: [],
  scoreA: [], scoreB: [], winner: null, status: MATCH_STATUS.PENDING,
  location: '', matchTime: at(-2 * HOUR), recorder: 'demo_muc_member', revision: 1, ...extra,
});

/** 一张「两场半决赛 + 一场决赛」的签表：决赛阵容取自两场半决赛的胜者。 */
async function bracketRepo() {
  const repo = fixture();
  await addMember(repo, 'audit_player_4');
  await putMatch(repo, bracketMatchDoc({ _id: 'm_semi_1', round: 1, slot: 0,
    teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    status: MATCH_STATUS.ACTIVE, winner: 'A', scoreA: [11], scoreB: [7] }));
  await putMatch(repo, bracketMatchDoc({ _id: 'm_semi_2', round: 1, slot: 1,
    teamA: ['demo_muc_member_3'], teamB: ['audit_player_4'],
    status: MATCH_STATUS.ACTIVE, winner: 'A', scoreA: [11], scoreB: [9] }));
  await putMatch(repo, bracketMatchDoc({ _id: 'm_final', round: 2, slot: 0,
    teamA: ['demo_muc_member'], teamB: ['demo_muc_member_3'] }));
  return repo;
}

test('F1：账号被平台停用后不能再确认 / 驳回 / 弃权', async () => {
  const repo = fixture();
  const match = await record(repo, 'f1_confirm');
  await setPlatformStatus(repo, 'demo_muc_member_2', PLATFORM_STATUS.DISABLED);

  // 对手（正是能确认的那一方）被停用：读不到，也确认不了
  const read = await call(repo, 'getSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  assert.equal(read.ok, false, '停用账号读不到内部数据');
  const confirm = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  assert.equal(confirm.ok, false, '停用账号不能确认比赛');
  assert.match(confirm.message, /停用|权限/);
  const stored = await repo.matches.getById(match.matchId);
  assert.equal(stored.status, MATCH_STATUS.PENDING, '状态没有被改动');

  // 同一条通路上的驳回 / 弃权也要一起拦住（撤销已随逐场结算改造删除）
  const reject = await call(repo, 'rejectSchoolMatch',
    { matchId: match.matchId, reason: '不认' }, { actor: 'demo_muc_member_2' });
  assert.equal(reject.ok, false);
  const forfeit = await call(repo, 'forfeitSchoolMatch',
    { matchId: match.matchId, forfeitBy: 'demo_muc_member' }, { actor: 'demo_muc_member_2' });
  assert.equal(forfeit.ok, false);
  assert.equal((await repo.matches.getById(match.matchId)).status, MATCH_STATUS.PENDING);
});

test('F1 相邻：学籍离校、管理员角色被停用，同样不能改成绩状态', async () => {
  const repo = fixture();
  const match = await record(repo, 'f1_member');

  // 学籍被标为离校：读不到，确认不了
  await setMemberStatus(repo, 'demo_muc_member_2', SCHOOL_MEMBER_STATUS.LEFT);
  const byLeft = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  assert.equal(byLeft.ok, false);

  // 管理员角色被停用：不再是管理员，也不能以管理员身份确认
  const admin = await call(repo, 'submitSchoolMatch', { requestId: 'f1_admin',
    ...casual({ teamA: ['demo_muc_member'], teamB: ['demo_muc_member_3'] }) },
    { actor: 'demo_muc_member' });
  assert.equal(admin.ok, true, admin.message);
  await setSchoolRoleStatus(repo, 'demo_muc_admin', 'disabled');
  const byAdmin = await call(repo, 'confirmSchoolMatch', { matchId: admin.match.matchId }, { actor: 'demo_muc_admin' });
  assert.equal(byAdmin.ok, false, '撤掉校级角色后不能再代为确认');
});

test('F1 相邻：请求已经进入、事务开始时才被停用，同样写不进去', async () => {
  const repo = fixture();
  const match = await record(repo, 'f1_inflight');
  const transaction = repo.transaction.bind(repo);
  repo.transaction = async work => {
    // 复现竞态：预检查通过之后、事务真正开跑之前，账号被停用
    await setPlatformStatus(repo, 'demo_muc_member_2', PLATFORM_STATUS.DISABLED);
    return transaction(work);
  };
  const confirm = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  assert.equal(confirm.ok, false);
  assert.equal((await repo.matches.getById(match.matchId)).status, MATCH_STATUS.PENDING);
});

test('F2：管理员在请求期间被撤权，不能替他人录分', async () => {
  const repo = fixture();
  const transaction = repo.transaction.bind(repo);
  repo.transaction = async work => {
    await setSchoolRoleStatus(repo, 'demo_muc_admin', 'disabled');
    return transaction(work);
  };
  const result = await call(repo, 'submitSchoolMatch', {
    requestId: 'f2_revoked',
    ...casual({ teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'] }),
  }, { actor: 'demo_muc_admin' });
  assert.equal(result.ok, false, '撤权之后这一笔不该落库');
  assert.match(result.message, /参赛者|管理员/);
  assert.equal((await repo.matches.list()).length, 0);

  // 对照：没有撤权时同一个人录得进去
  const repo2 = fixture();
  const allowed = await call(repo2, 'submitSchoolMatch', {
    requestId: 'f2_ok', ...casual({ teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'] }),
  }, { actor: 'demo_muc_admin' });
  assert.equal(allowed.ok, true, allowed.message);
});

test('F2 相邻：撤权后也不能替他人补录签表场次', async () => {
  const repo = fixture();
  await putMatch(repo, bracketMatchDoc({
    _id: 'm_sched', teamA: ['demo_muc_member'], teamB: ['demo_muc_member_3'],
    status: MATCH_STATUS.PENDING,
  }));
  const transaction = repo.transaction.bind(repo);
  repo.transaction = async work => {
    await setSchoolRoleStatus(repo, 'demo_muc_admin', 'disabled');
    return transaction(work);
  };
  const result = await call(repo, 'submitSchoolMatch',
    { matchId: 'm_sched', scoreA: [11], scoreB: [5] }, { actor: 'demo_muc_admin' });
  assert.equal(result.ok, false);
  assert.equal((await repo.matches.getById('m_sched')).scoreA.length, 0, '比分没有落库');
});

test('F4：平台停用的选手不能进新比赛（直接传 ID 也不行）', async () => {
  const repo = fixture();
  await setPlatformStatus(repo, 'demo_muc_member_2', PLATFORM_STATUS.DISABLED);

  const context = await call(repo, 'getSchoolMatchEntryContext', {}, { actor: 'demo_muc_member' });
  assert.equal(context.members.some(m => m.userId === 'demo_muc_member_2'), false,
    '可选名单里不再出现停用选手');

  const result = await call(repo, 'submitSchoolMatch', {
    requestId: 'f4_direct', ...casual({ teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'] }),
  }, { actor: 'demo_muc_member' });
  assert.equal(result.ok, false, '写端必须拒绝，不能只靠界面隐藏');
  assert.match(result.message, /不在名单|参赛/);
  assert.equal((await repo.matches.list()).length, 0);
});

test('F4 相邻：已排定的签表场次里一方被停用，对手仍能录分并确认', async () => {
  const repo = fixture();
  await putMatch(repo, bracketMatchDoc({
    _id: 'm_left', teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    status: MATCH_STATUS.PENDING,
  }));
  // 一方事后被停用：对阵是抽签定死的既成事实，不该把对手卡在录分这一步
  await setPlatformStatus(repo, 'demo_muc_member_2', PLATFORM_STATUS.DISABLED);

  const filled = await call(repo, 'submitSchoolMatch',
    { matchId: 'm_left', scoreA: [11], scoreB: [6] }, { actor: 'demo_muc_member' });
  assert.equal(filled.ok, true, filled.message);
  const confirmed = await call(repo, 'confirmSchoolMatch', { matchId: 'm_left' }, { actor: 'demo_muc_admin' });
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal((await repo.matches.getById('m_left')).status, MATCH_STATUS.ACTIVE);
});

test('F4 相邻：停用选手的历史流水仍留在台账与回放里', async () => {
  const repo = fixture();
  const match = await record(repo, 'f4_history');
  await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_admin' });
  await setPlatformStatus(repo, 'demo_muc_member_2', PLATFORM_STATUS.DISABLED);

  const stored = await repo.matches.getById(match.matchId);
  assert.equal(stored.status, MATCH_STATUS.ACTIVE, '历史赛果不因停用而作废');
  const listed = await call(repo, 'listSchoolMatches', { userId: 'demo_muc_member' });
  assert.ok(listed.matches.some(row => row.matchId === match.matchId), '历史记录仍读得到');
});

test('F5（新语义）：已排进下一轮的比赛同样不可撤销——撤销入口已整体移除', async () => {
  // 撤销能力已随逐场结算改造删除：不存在「从最后一轮往前撤」的路径。
  // 保留一条护栏：已结算的半决赛不可被驳回（requirePending），状态不变。
  const repo = await bracketRepo();
  const reject = await call(repo, 'rejectSchoolMatch',
    { matchId: 'm_semi_1', reason: '录错了' }, { actor: 'demo_muc_admin' });
  assert.equal(reject.ok, false, '已生效比赛不能驳回');
  assert.match(reject.message, /待确认/);
  assert.equal((await repo.matches.getById('m_semi_1')).status, MATCH_STATUS.ACTIVE, '没有改动');
});

test('F3：已结算比赛不释放名额——录满之后不能借驳回腾出额度', async () => {
  const repo = fixture();
  const limit = RATED_PAIR_LIMIT;
  const first = await record(repo, 'seat_0');
  await call(repo, 'confirmSchoolMatch', { matchId: first.matchId }, { actor: 'demo_muc_member_2' });
  for (let i = 1; i < limit; i += 1) {
    const match = await record(repo, `seat_${i}`);
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }
  const blocked = await call(repo, 'submitSchoolMatch', { requestId: 'seat_full', ...casual() });
  assert.equal(blocked.ok, false, '打满之后录不进来');
  assert.match(blocked.message, /上限/);

  // 已生效比赛不可驳回（额度占用随之保留，交接文档 §4.4：已结算不释放额度）
  const reject = await call(repo, 'rejectSchoolMatch',
    { matchId: first.matchId, reason: '成绩不算' }, { actor: 'demo_muc_member_2' });
  assert.equal(reject.ok, false);
  const stillBlocked = await call(repo, 'submitSchoolMatch', { requestId: 'seat_after', ...casual() });
  assert.equal(stillBlocked.ok, false, '额度仍然占满');
});

test('F3：只剩一个名额时，两次并发提交只成功一次', async () => {
  const repo = fixture();
  const limit = RATED_PAIR_LIMIT;
  // 先把这一对打到只剩一个名额（自行录入 + 已确认，全部计入）
  for (let i = 0; i < limit - 1; i += 1) {
    const match = await record(repo, `fill_${i}`);
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }

  const [a, b] = await Promise.all([
    call(repo, 'submitSchoolMatch', { requestId: 'race_a', ...casual() }, { actor: 'demo_muc_member' }),
    call(repo, 'submitSchoolMatch', { requestId: 'race_b', ...casual({ matchTime: at(-2 * HOUR) }) },
      { actor: 'demo_muc_member' }),
  ]);
  const accepted = [a, b].filter(row => row.ok).length;
  assert.equal(accepted, 1, `并发下只能成功一次（实际 ${accepted}）`);
  const counted = (await repo.matches.list())
    .filter(row => row.status !== MATCH_STATUS.REVOKED).length;
  assert.equal(counted, limit, `最终不超过上限 ${limit}`);
});

test('F3：驳回（确认前）会释放名额，驳掉之后又能录进来', async () => {
  const repo = fixture();
  const limit = RATED_PAIR_LIMIT;
  // 占用最后一个名额但**不确认**（提交即占额度）
  const pending = await record(repo, 'seat_0');
  for (let i = 1; i < limit; i += 1) {
    const match = await record(repo, `seat_${i}`);
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }
  const blocked = await call(repo, 'submitSchoolMatch', { requestId: 'seat_full', ...casual() });
  assert.equal(blocked.ok, false, '额度占满');
  assert.match(blocked.message, /上限/);

  // 驳回那条**待确认**的比赛（确认前纠错保留）：额度释放一次
  const rejected = await call(repo, 'rejectSchoolMatch',
    { matchId: pending.matchId, reason: '比分记错' }, { actor: 'demo_muc_member_2' });
  assert.equal(rejected.ok, true, rejected.message);
  const again = await call(repo, 'submitSchoolMatch', { requestId: 'seat_after_reject', ...casual() });
  assert.equal(again.ok, true, again.message);
});

test('F3 相邻：双打一次占四对，任一对方满额即整笔拒绝', async () => {
  const repo = fixture();
  await addMember(repo, 'audit_player_4');
  await addMember(repo, 'audit_player_5');
  const limit = RATED_PAIR_LIMIT;
  // demo_muc_member + _2 这一对先打满
  for (let i = 0; i < limit; i += 1) {
    const match = await record(repo, `dbl_fill_${i}`, {
      matchType: MATCH_TYPE.DOUBLES, teamA: ['demo_muc_member', 'demo_muc_member_3'],
      teamB: ['demo_muc_member_2', 'audit_player_4'],
    }, { actor: 'demo_muc_member' });
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }
  const blocked = await call(repo, 'submitSchoolMatch', {
    requestId: 'dbl_over',
    ...casual({
      matchType: MATCH_TYPE.DOUBLES, teamA: ['demo_muc_member', 'demo_muc_member_3'],
      teamB: ['demo_muc_member_2', 'audit_player_5'],
    }),
  });
  assert.equal(blocked.ok, false, '双打里任一对打满就不能录');
  assert.match(blocked.message, /上限/);
});

test('F3 相邻：赛事比赛不受交手名额限制，赛季重置后计数清零', async () => {
  const repo = fixture();
  const limit = RATED_PAIR_LIMIT;
  for (let i = 0; i < limit; i += 1) {
    const match = await record(repo, `cap_${i}`);
    await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });
  }

  // 带 eventId 的赛事比赛：有名次与赛程兜底，不占日常约球的名额
  await putMatch(repo, {
    ...bracketMatchDoc({ _id: 'm_event_match', teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'] }),
    status: MATCH_STATUS.PENDING,
  });
  const bracketFill = await call(repo, 'submitSchoolMatch',
    { matchId: 'm_event_match', scoreA: [11], scoreB: [5] }, { actor: 'demo_muc_member' });
  assert.equal(bracketFill.ok, true, bracketFill.message);

  // 赛季重置：新赛季号 → 新键，计数天然清零
  const { scopeKey } = require('../src/shared/utils/school');
  await repo.seasons.set(scopeKey({ schoolId: 'muc', association: 'pkb' }),
    { schoolId: 'muc', association: 'pkb', seasonNumber: 2, resetTime: at(-HOUR / 2) });
  const afterReset = await call(repo, 'submitSchoolMatch', { requestId: 'cap_new_season', ...casual() });
  assert.equal(afterReset.ok, true, afterReset.message);

  // 旧赛季的计数文档留着（可审计），但不再参与判断
  const counts = await repo.pairCounts.list();
  assert.ok(counts.some(doc => doc.seasonNumber === 1), '旧赛季计数保留');
  assert.ok(counts.some(doc => doc.seasonNumber === 2), '新赛季另起一份计数');
});

test('F3：计数文档懒初始化——历史台账里的占用在第一次提交时被算进来', async () => {
  const repo = fixture();
  const limit = RATED_PAIR_LIMIT;
  // 直接往台账塞满额的历史比赛（模拟规则生效前录下的数据，没有任何计数文档）
  for (let i = 0; i < limit; i += 1) {
    await putMatch(repo, {
      ...bracketMatchDoc({ _id: `legacy_${i}` }),
      eventId: null, stage: undefined, round: undefined, slot: undefined,
      teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
      status: MATCH_STATUS.ACTIVE, winner: 'A', scoreA: [11], scoreB: [8],
    });
  }
  assert.equal((await repo.pairCounts.list()).length, 0, '前提：没有计数文档');

  const blocked = await call(repo, 'submitSchoolMatch', { requestId: 'legacy_over', ...casual() });
  assert.equal(blocked.ok, false, '历史占用要被算进来，不能因为没计数就从零开始');
  assert.match(blocked.message, /上限/);
});
