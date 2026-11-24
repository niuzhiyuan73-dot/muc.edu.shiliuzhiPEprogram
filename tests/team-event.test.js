/**
 * 团队赛事（C 期首片）：建赛 → 报名 → 审核 → 锁定名单
 * 守三件事：规则快照建赛时固化、报名人数按 5 人下限卡、锁定后不可再改。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/team-event-service');
const teamHandlers = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey } = require('../src/shared/utils/school');
const { TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS, TEAM_MATCH_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

function fixture(playerCount = 5) {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  ['u_cap', 'u_leader'].forEach(add);
  for (let i = 1; i < playerCount; i += 1) add(`u_p${i}`);
  seed.memberships.push({ _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active' });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

/** 球队相关动作在 team-service 里 */
async function callTeam(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/** 建一支已通过的队，队员为 u_cap + u_p1.. */
async function teamWithPlayers(repo, players = 4) {
  const created = await callTeam(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_t1' }, 'u_cap');
  await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
  for (let i = 1; i < players; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, `u_p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: created.teamId, userId: `u_p${i}`, approve: true }, 'u_cap');
  }
  return created.teamId;
}

test('建赛 —— 规则快照固化，报名阶段，名称重名被拒', async () => {
  const repo = fixture();
  const done = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1', presetKey: 'campus-2x20' });
  assert.equal(done.ok, true, done.message);

  const event = await repo.teamEvents.getById(done.eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.REGISTRATION);
  assert.equal(event.rules.periods, 2);
  assert.equal(event.rules.periodMinutes, 20);
  assert.equal(event.entryMin, 5, '报名下限取规则快照的 5 人');

  const same = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e2' });
  assert.equal(same.ok, false);
  assert.match(same.message, /同名/);
});

test('建赛 —— 普通会员不能建赛；非法规则被拒', async () => {
  const repo = fixture();
  const denied = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' }, 'u_cap');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /协会负责人/);

  const bad = await call(repo, 'createTeamEvent', {
    name: '秋季联赛', requestId: 'req_e2', rules: { periods: 9 },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不合法/);
});

test('报名 —— 只有队长能报，人数不足 5 人被拒', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 2); // 队长 + 1 名队员 = 2 人

  const notCaptain = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_p1');
  assert.equal(notCaptain.ok, false);
  assert.match(notCaptain.message, /队长/);

  const tooFew = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少需要 5 人/);
});

test('报名 → 审核 → 锁定：名单成为快照，锁后不可改', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 5);

  const submitted = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.status, TEAM_ENTRY_STATUS.SUBMITTED);

  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId, approve: true });
  const locked = await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, 1);

  const updated = await repo.teamEvents.getById(event.eventId);
  assert.equal(updated.status, TEAM_EVENT_STATUS.LOCKED, '锁定名单只到「名单已锁定」，赛程要抽签之后才有');

  const entry = await repo.teamEventEntries.getById(
    require('../src/shared/utils/school.js').schoolKey('ten', event.eventId, teamId)
  );
  assert.equal(entry.status, TEAM_ENTRY_STATUS.LOCKED);
  assert.equal(entry.roster.length, 5);
  assert.ok(entry.roster.every(row => row.name), '快照里要有当时的姓名');

  const again = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(again.ok, false);
  // 锁定后赛事已转「赛程已发布」，报名口先被状态挡住
  assert.match(again.message, /不开放报名|已锁定/);
});

test('详情 —— 非管理者看不到被退回的报名', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 5);
  await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId, approve: false });

  const asLeader = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_leader');
  assert.equal(asLeader.entries.length, 1);

  const asMember = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_p1');
  assert.equal(asMember.entries.length, 0);
});

/* ============================================================
 * 十、抽签 → 赛程 → 录分 → 发布 → 结算
 * ============================================================
 * 这一段才是「真的办完一届比赛」。此前的用例只到锁定名单；从这里开始，
 * 球队要按签表打、比分要发布才进积分表、名次要结算才算数。
 * ============================================================ */

/** 造一份能支撑 N 支球队 × R 人的种子数据 */
function fixtureFor(teamCount, roster) {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
  };
  add('u_leader');
  for (let t = 0; t < teamCount; t += 1) {
    add(`u_t${t}c`);
    for (let p = 0; p < roster - 1; p += 1) add(`u_t${t}p${p}`);
  }
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  return createSchoolMemoryRepo(seed);
}

/** 建 N 支队、各自报名、审核、锁定，返回赛事与球队编号 */
async function lockedEvent(repo, { teamCount = 4, roster = 5, format, placementMode } = {}) {
  const event = await call(repo, 'createTeamEvent', {
    name: '秋季联赛', requestId: 'req_e1', ...(format ? { format } : {}),
    ...(placementMode ? { placementMode } : {}),
  });
  const teamIds = [];
  for (let t = 0; t < teamCount; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(repo, 'createTeamApplication', {
      name: `球队${t + 1}`, requestId: `req_t${t}`,
    }, captain);
    await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let p = 0; p < roster - 1; p += 1) {
      const memberId = `u_t${t}p${p}`;
      await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
      await callTeam(repo, 'reviewTeamMember', {
        teamId: created.teamId, userId: memberId, approve: true,
      }, captain);
    }
    await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: created.teamId }, captain);
    await call(repo, 'reviewTeamEntry', {
      eventId: event.eventId, teamId: created.teamId, approve: true,
    });
    teamIds.push(created.teamId);
  }
  const locked = await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  assert.equal(locked.ok, true, locked.message);
  return { eventId: event.eventId, teamIds };
}

test('抽签 —— 四支队出两场半决赛，赛事转「赛程已发布」', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);

  const drawn = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.matchCount, 2, '4 支队首轮两场');
  assert.equal(drawn.rounds, 1);

  const event = await repo.teamEvents.getById(eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.SCHEDULED);
  assert.equal(event.draw.size, 4);
  assert.ok(Number.isInteger(event.draw.seed), '种子要落库，事后能复核');

  const list = await call(repo, 'listTeamMatches', { eventId });
  assert.equal(list.matches.length, 2);
  list.matches.forEach((row) => {
    assert.equal(row.status, TEAM_MATCH_STATUS.SCHEDULED);
    assert.equal(row.scoreText, '—', '没开打不能显示 0 : 0');
    assert.notEqual(row.teamA, row.teamB);
  });
});

test('抽签 —— 没锁定名单不能抽；已有比分不能重抽', async () => {
  const repo = fixtureFor(4, 5);
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const early = await call(repo, 'drawTeamEvent', { eventId: event.eventId });
  assert.equal(early.ok, false);
  assert.match(early.message, /锁定/);

  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const list = await call(repo, 'listTeamMatches', { eventId });
  const first = list.matches[0];
  await call(repo, 'recordTeamMatch', { matchId: first.matchId, scoreA: 80, scoreB: 70 });
  const again = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(again.ok, false);
  assert.match(again.message, /录了分/);
});

test('淘汰赛全流程 —— 两场半决赛发布后才能排决赛，决赛发布后可结算', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });

  const first = (await call(repo, 'listTeamMatches', { eventId })).matches;
  assert.equal(first.length, 2);

  // 半决赛还没发完就排下一轮 → 拒绝
  const tooEarly = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /未发布/);

  for (const row of first) {
    const recorded = await call(repo, 'recordTeamMatch', {
      matchId: row.matchId, scoreA: row.teamA < row.teamB ? 80 : 70, scoreB: row.teamA < row.teamB ? 70 : 80,
    });
    assert.equal(recorded.ok, true, recorded.message);
    const published = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
    assert.equal(published.ok, true, published.message);
  }

  const advanced = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(advanced.ok, true, advanced.message);
  assert.equal(advanced.matchCount, 2, '4 队签表下一轮是决赛 + 季军赛');

  const all = (await call(repo, 'listTeamMatches', { eventId })).matches;
  assert.equal(all.length, 4);
  const final = all.find(row => row.round === 2 && row.stage === 'main');
  const bronze = all.find(row => row.stage === 'bronze');
  assert.ok(final, '应当排出决赛');
  assert.ok(bronze, '季军赛是必须有的，不能只按净胜分排第三名');

  // 前面已发布，此时才能结算；决赛与季军赛都还没打
  const pending = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(pending.ok, false);
  assert.match(pending.message, /未发布/);

  for (const row of [final, bronze]) {
    await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 90, scoreB: 88 });
    await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  }

  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.placements.length, 4);
  assert.equal(settled.placements[0].note, '冠军');
  assert.equal(settled.placements[1].note, '亚军');
  assert.equal(settled.placements[2].note, '季军', '三四名由上场比赛决定，不是算出来的');
  assert.equal(settled.placements[3].note, '第四名');
  assert.deepEqual(settled.placements.map(row => row.rank), [1, 2, 3, 4]);

  // 季军赛的胜者就是第三名（要重新取一次，前面那份还是「未开赛」的快照）
  const playedBronze = (await call(repo, 'listTeamMatches', { eventId })).matches
    .find(row => row.stage === 'bronze');
  assert.equal(playedBronze.status, TEAM_MATCH_STATUS.PUBLISHED);
  const bronzeWinner = playedBronze.winner === 'A' ? playedBronze.teamA : playedBronze.teamB;
  assert.equal(settled.placements[2].teamId, bronzeWinner);

  const event = await repo.teamEvents.getById(eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.FINISHED);
  assert.equal(event.placements.length, 4);
});

test('循环赛 —— 抽签一次排完全部轮次，结算按积分表', async () => {
  const repo = fixtureFor(3, 5);
  const { eventId } = await lockedEvent(repo, { teamCount: 3, format: 'round_robin' });
  const drawn = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.rounds, 3, '3 支队单循环共 3 轮');
  assert.equal(drawn.matchCount, 3);

  const list = await call(repo, 'listTeamMatches', { eventId });
  // 让 teamA 全部赢：每人一场，最终 2 胜 1 负之类的分布不固定，这里只求全员打完
  for (const row of list.matches) {
    await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });
    await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  }

  const noNext = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(noNext.ok, false);
  assert.match(noNext.message, /循环赛没有下一轮/);

  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.placements.length, 3);
  assert.deepEqual(settled.placements.map(row => row.rank), [1, 2, 3]);
  assert.equal(settled.placements[0].note, '冠军');

  const detail = await call(repo, 'getTeamEvent', { eventId });
  assert.equal(detail.table.length, 3);
  assert.ok(detail.table.every(row => row.played === 2), '单循环每人打两场');
});

test('录分 —— 平局、非法比分、越权都被拦下', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  const tie = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 80 });
  assert.equal(tie.ok, false);
  assert.match(tie.message, /平局/);

  const bad = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80.5, scoreB: 70 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /整数/);

  const zero = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 0, scoreB: 0 });
  assert.equal(zero.ok, false);

  // 路过的会员（不是队长、不是管理者）
  const stranger = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70,
  }, 'u_t1p0');
  assert.equal(stranger.ok, false);
  assert.match(stranger.message, /队长/);

  // 抽签次序会随赛事版本变化，按实际对阵找队长，不依赖某个固定随机结果。
  const captain = (await repo.teams.getById(row.teamA)).captainId;
  const okAsCaptain = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70,
  }, captain);
  assert.equal(okAsCaptain.ok, true, okAsCaptain.message);
});

test('发布 —— 待审核驳回会把比分清空并要求重录', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });
  const rejected = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: false });
  assert.equal(rejected.ok, true);

  const after = (await call(repo, 'listTeamMatches', { eventId })).matches
    .find(item => item.matchId === row.matchId);
  assert.equal(after.status, TEAM_MATCH_STATUS.SCHEDULED);
  assert.equal(after.scoreA, null, '驳回不能留着旧比分让人猜');
  assert.equal(after.winner, null);

  const publishAgain = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  assert.equal(publishAgain.ok, false, '没重录就发布不了');
});

test('录分 —— 带个人统计时合计与球队得分不符只提示，不拒绝', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  // 统计里的人和球队必须真的属于这一方：签表是洗过牌的，不能假设谁对谁
  const entries = await repo.teamEventEntries.list();
  const roster = entries.find(item => item.teamId === row.teamA).roster;
  const scorer = roster[0].userId;

  const out = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId,
    scoreA: 80,
    scoreB: 70,
    stats: [{ teamId: row.teamA, players: [{ userId: scorer, points: 20, fouls: 3 }] }],
  });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /差 60 分待归属/);

  const stats = await repo.teamMatchStats.getById(
    require('../src/shared/utils/school.js').schoolKey('tms', row.matchId, row.teamA)
  );
  assert.equal(stats.integrity, 'basic');
  assert.deepEqual(stats.players, [{ userId: scorer, points: 20, fouls: 3 }]);
});

test('详情 —— 报名入口：队长只看到自己队，管理者看到所有还没报的队', async () => {
  const repo = fixtureFor(4, 5);
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  // 两支已通过的球队：t0（5 人）、t1（4 人，还差 1 个）
  const t0 = await callTeam(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_a' }, 'u_t0c');
  await callTeam(repo, 'reviewTeamApplication', { teamId: t0.teamId, approve: true });
  for (let i = 0; i < 4; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: t0.teamId }, `u_t0p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: t0.teamId, userId: `u_t0p${i}`, approve: true }, 'u_t0c');
  }
  const t1 = await callTeam(repo, 'createTeamApplication', { name: '闪电队', requestId: 'req_b' }, 'u_t1c');
  await callTeam(repo, 'reviewTeamApplication', { teamId: t1.teamId, approve: true });
  for (let i = 0; i < 3; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: t1.teamId }, `u_t1p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: t1.teamId, userId: `u_t1p${i}`, approve: true }, 'u_t1c');
  }

  // 队长：只有自己那支
  const asCaptain = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.equal(asCaptain.submitCandidates.length, 1);
  assert.equal(asCaptain.submitCandidates[0].teamId, t0.teamId);
  assert.equal(asCaptain.submitCandidates[0].memberCount, 5);
  assert.equal(asCaptain.submitCandidates[0].enough, true);

  // 管理者：两支都在，人数不足的那支标出来
  const asLeader = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_leader');
  assert.equal(asLeader.submitCandidates.length, 2);
  const weak = asLeader.submitCandidates.find(row => row.teamId === t1.teamId);
  assert.equal(weak.memberCount, 4);
  assert.equal(weak.enough, false);

  // 报过名（待审核）之后就不再出现在候选里
  await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: t0.teamId }, 'u_t0c');
  const after = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.deepEqual(after.submitCandidates, []);

  // 退回之后可以重报
  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId: t0.teamId, approve: false });
  const reopened = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.equal(reopened.submitCandidates.length, 1);
});

test('弃权 —— 弃权方判负，比分仍要合法，发布后进积分表', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  // A 队弃权：20:0，胜方是 B
  const recorded = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 0, scoreB: 20, forfeit: 'A',
  });
  assert.equal(recorded.ok, true, recorded.message);
  assert.equal(recorded.winner, 'B');

  const after = (await call(repo, 'listTeamMatches', { eventId })).matches
    .find(item => item.matchId === row.matchId);
  assert.equal(after.forfeit, 'A');
  assert.equal(after.winner, 'B');
  assert.equal(after.scoreText, '0 : 20');

  await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  const detail = await call(repo, 'getTeamEvent', { eventId });
  const lineA = detail.table.find(item => item.teamId === row.teamA);
  const lineB = detail.table.find(item => item.teamId === row.teamB);
  assert.equal(lineA.losses, 1, '弃权方记一场负');
  assert.equal(lineB.wins, 1);
  assert.equal(lineB.diff, 20);
});

test('弃权 —— 不给比分仍然拒绝（弃权也要有记分牌上的数字）', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  const zero = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 0, scoreB: 0, forfeit: 'A',
  });
  assert.equal(zero.ok, false);
  assert.match(zero.message, /0:0/);
});

/* ============================================================
 * 个人统计：得分与犯规
 * ============================================================
 * 名单来自「锁定那一刻的快照」，不是球队现在的成员表；空着的格子存 null
 * 而不是 0——「没统计」和「得了 0 分」是两件事，混起来场均分永远偏低。
 * ============================================================ */

test('统计面板 —— 按锁定名单两侧各列 5 人，初始一律未记录', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  assert.equal(panel.ok, true, panel.message);
  assert.equal(panel.sides.length, 2);
  panel.sides.forEach((side) => {
    assert.equal(side.players.length, 5, '锁定名单 5 人');
    assert.ok(side.players.every(player => player.points === null && player.fouls === null),
      '没录过就是 null，不是 0');
  });
  assert.equal(panel.canEdit, true);
});

test('统计保存 —— 合计与球队得分不符只提示；空格子保持 null', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];
  await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  const side = panel.sides[0];
  const saved = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId,
    players: [
      { userId: side.players[0].userId, points: 20, fouls: 3 },
      { userId: side.players[1].userId, points: '', fouls: '' },
    ],
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.warnings.length, 1);
  assert.match(saved.warnings[0], /差 60 分待归属/);

  const doc = await repo.teamMatchStats.getById(
    require('../src/shared/utils/school.js').schoolKey('tms', row.matchId, side.teamId)
  );
  assert.equal(doc.integrity, 'basic');
  const first = doc.players.find(item => item.userId === side.players[0].userId);
  assert.equal(first.points, 20);
  assert.equal(first.fouls, 3);
  // 基础模式七个指标都落一栏：没录的存 null，不落成 0
  assert.equal(first.rebounds, null);
  // 整行都空的球员根本不落库——「没录」不是「录了 0」
  assert.equal(doc.players.length, 1);

  // 但读回来时，名单里每个人都有一行，空格子显示成未记录
  const reread = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  const blank = reread.sides[0].players.find(item => item.userId === side.players[1].userId);
  assert.equal(blank.points, null);
  assert.equal(blank.fouls, null, '空着的格子是「未记录」，不能落成 0');
});

test('统计保存 —— 名单外的人、越界数字都被拒', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];
  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  const player = panel.sides[0].players[0];

  const outsider = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, players: [{ userId: 'u_leader', points: 10 }],
  });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /不在本场名单/);

  const tooMany = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, players: [{ userId: player.userId, points: 300 }],
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /0–199/);

  const badFouls = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, players: [{ userId: player.userId, fouls: 11.5 }],
  });
  assert.equal(badFouls.ok, false);
  assert.match(badFouls.message, /0–10/);
});

test('统计保存 —— 赛事结束后不能再改', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];
  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });

  // 直接改赛事状态，省去把整届打完
  const event = await repo.teamEvents.getById(eventId);
  await repo.teamEvents.set(eventId, { ...event, status: TEAM_EVENT_STATUS.FINISHED });

  const saved = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, players: [{ userId: panel.sides[0].players[0].userId, points: 10 }],
  });
  assert.equal(saved.ok, false);
  assert.match(saved.message, /已结束/);
});

/* ============================================================
 * D 期：按节统计、球员榜、并发版本
 * ============================================================
 * 按节统计解决「谁在哪一节打得好」，代价是录入量翻几倍——所以只有赛事
 * 显式开了 statPolicy=detailed 才允许走这条模式，默认仍是基础模式。
 * ============================================================ */

/** 建一支已通过的队并报名、锁定，返回赛事与球队 */
async function lockedDetailedEvent(repo, { teamCount = 2 } = {}) {
  const event = await call(repo, 'createTeamEvent', {
    name: '院际杯', requestId: 'req_d1', statPolicy: 'detailed', presetKey: 'campus-2x20',
  });
  const teamIds = [];
  for (let t = 0; t < teamCount; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(repo, 'createTeamApplication', {
      name: `球队${t + 1}`, requestId: `req_dt${t}`,
    }, captain);
    await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let i = 0; i < 4; i += 1) {
      const memberId = `u_t${t}p${i}`;
      await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
      await callTeam(repo, 'reviewTeamMember', {
        teamId: created.teamId, userId: memberId, approve: true,
      }, captain);
    }
    await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: created.teamId }, captain);
    await call(repo, 'reviewTeamEntry', {
      eventId: event.eventId, teamId: created.teamId, approve: true,
    });
    teamIds.push(created.teamId);
  }
  await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  return { eventId: event.eventId, teamIds };
}

test('按节统计 —— 合计由各行算出，节次越界与未开模式的赛事都被拒', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, teamIds } = await lockedDetailedEvent(repo);
  const drawn = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(drawn.ok, true, drawn.message);
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];
  await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 30, scoreB: 24 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  assert.equal(panel.statPolicy, 'detailed');
  assert.equal(panel.periods, 2, 'campus-2x20 是两节');
  const side = panel.sides.find(item => item.teamId === row.teamA);
  const player = side.players[0];

  // 第 1 节 8 分 3 板，第 2 节 7 分 2 板 → 合计 15 分 5 板
  const saved = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId,
    mode: 'detailed',
    rows: [
      { period: 1, userId: player.userId, points: 8, rebounds: 3 },
      { period: 2, userId: player.userId, points: 7, rebounds: 2 },
    ],
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.warnings.length, 1, '个人合计 15 ≠ 球队 30，只提示不拒绝');
  assert.match(saved.warnings[0], /差 15 分待归属/);

  const reread = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  const after = reread.sides.find(item => item.teamId === row.teamA).players[0];
  assert.equal(after.points, 15, '合计由各行算出，不双份存储');
  assert.equal(after.rebounds, 5);
  assert.equal(after.assists, null, '没录的指标是未记录，不是 0');

  const doc = await repo.teamMatchStats.getById(
    require('../src/shared/utils/school.js').schoolKey('tms', row.matchId, row.teamA)
  );
  assert.equal(doc.mode, 'detailed');
  assert.equal(doc.rows.length, 2);
  assert.equal(doc.integrity, 'partial', '5 人只录了 1 人');
  assert.equal(doc.revision, 1);

  // 节次越界
  const badPeriod = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, mode: 'detailed',
    rows: [{ period: 3, userId: player.userId, points: 5 }],
  });
  assert.equal(badPeriod.ok, false);
  assert.match(badPeriod.message, /节次需在 1–2/);

  // 中文指标名，不把字段键抛给用户
  const badValue = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, mode: 'detailed',
    rows: [{ period: 1, userId: player.userId, points: 300 }],
  });
  assert.equal(badValue.ok, false);
  assert.match(badValue.message, /个人得分」需为 0–199/);
});

test('按节统计 —— 赛事没开 detailed 时拒绝，录满全队才记 full', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];
  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  assert.equal(panel.statPolicy, 'basic', '默认只开基础模式');
  assert.equal(panel.periods, 4, '默认预设是 4 节');

  const denied = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, mode: 'detailed',
    rows: [{ period: 1, userId: panel.sides[0].players[0].userId, points: 5 }],
  });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /未开启按节统计/);

  // 另一份开了 detailed 的赛事：把 5 个人都录上 → full
  const repo2 = fixtureFor(2, 5);
  const detail = await lockedDetailedEvent(repo2);
  await call(repo2, 'drawTeamEvent', { eventId: detail.eventId });
  const m2 = (await call(repo2, 'listTeamMatches', { eventId: detail.eventId })).matches[0];
  const side = (await call(repo2, 'getTeamMatchStats', { matchId: m2.matchId })).sides
    .find(item => item.teamId === m2.teamA);
  await call(repo2, 'saveTeamMatchStats', {
    matchId: m2.matchId, mode: 'detailed',
    rows: side.players.map(player => ({ period: 1, userId: player.userId, points: 6 })),
  });
  const doc = await repo2.teamMatchStats.getById(
    require('../src/shared/utils/school.js').schoolKey('tms', m2.matchId, m2.teamA)
  );
  assert.equal(doc.integrity, 'full');
  assert.equal(doc.rows.length, 5);
});

test('球员数据榜 —— 只算已发布的比赛，按总得分排序', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId } = await lockedDetailedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });

  // 手动排出第二轮：单场赛制下两人只打一场，这里改成循环赛才能打两场
  const rr = fixtureFor(3, 5);
  const rrEvent = await call(rr, 'createTeamEvent', {
    name: '循环杯', requestId: 'req_rr', format: 'round_robin', statPolicy: 'detailed',
  });
  const rrTeams = [];
  for (let t = 0; t < 3; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(rr, 'createTeamApplication', {
      name: `队${t + 1}`, requestId: `req_rr${t}`,
    }, captain);
    await callTeam(rr, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let i = 0; i < 4; i += 1) {
      const memberId = `u_t${t}p${i}`;
      await callTeam(rr, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
      await callTeam(rr, 'reviewTeamMember', { teamId: created.teamId, userId: memberId, approve: true }, captain);
    }
    await call(rr, 'submitTeamEntry', { eventId: rrEvent.eventId, teamId: created.teamId }, captain);
    await call(rr, 'reviewTeamEntry', { eventId: rrEvent.eventId, teamId: created.teamId, approve: true });
    rrTeams.push(created.teamId);
  }
  await call(rr, 'lockTeamEntries', { eventId: rrEvent.eventId });
  await call(rr, 'drawTeamEvent', { eventId: rrEvent.eventId });

  const rows = (await call(rr, 'listTeamMatches', { eventId: rrEvent.eventId })).matches;
  const star = rows[0].teamA;
  // 第一场发布，第二场只录比分不发布
  await call(rr, 'recordTeamMatch', { matchId: rows[0].matchId, scoreA: 40, scoreB: 38 });
  await call(rr, 'publishTeamMatch', { matchId: rows[0].matchId, approve: true });
  await call(rr, 'recordTeamMatch', { matchId: rows[1].matchId, scoreA: 50, scoreB: 44 });
  const p1 = (await call(rr, 'getTeamMatchStats', { matchId: rows[0].matchId })).sides
    .find(item => item.teamId === star).players[0];
  // 比赛已发布后才补统计：这一版是「待审核」，不能直接改榜单
  await call(rr, 'saveTeamMatchStats', {
    matchId: rows[0].matchId, mode: 'detailed',
    rows: [{ period: 1, userId: p1.userId, points: 12, rebounds: 5, assists: 4 }],
  });

  const pendingBoard = await call(rr, 'getTeamEventPlayerStats', { eventId: rrEvent.eventId });
  assert.equal(pendingBoard.players.length, 0, '统计待审核期间榜单不跟着变');

  const approved = await call(rr, 'reviewTeamMatchStats', { matchId: rows[0].matchId, approve: true });
  assert.equal(approved.ok, true, approved.message);

  const board = await call(rr, 'getTeamEventPlayerStats', { eventId: rrEvent.eventId });
  assert.equal(board.matchCount, 1, '只算已发布的那一场');
  assert.equal(board.players.length, 1, '未发布的比赛不进榜');
  assert.equal(board.players[0].userId, p1.userId);
  assert.equal(board.players[0].points, 12);
  assert.equal(board.players[0].rebounds, 5);
  assert.equal(board.players[0].games, 1);
  assert.equal(board.players[0].pointsPerGame, 12);
  // 没录过的指标是 null（页面显示 —），不能冒充 0
  assert.equal(board.players[0].steals, null);
  assert.equal(board.players[0].stealsText, '—');
  assert.equal(board.players[0].turnovers, null);
  assert.equal(board.players[0].blocks, null);
});

test('并发 —— 版本号对不上的录分、发布与统计都被拒', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  const stale = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70, expectRevision: 99,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /刚被改过/);

  // 用对的版本号录进去，版本 +1
  const fresh = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70, expectRevision: 1,
  });
  assert.equal(fresh.ok, true, fresh.message);
  const after = await repo.teamMatches.getById(row.matchId);
  assert.equal(after.revision, 2, '每次录分版本 +1，页面据此判断要不要刷新');

  // 再拿旧版本号发布 → 拒
  const stalePublish = await call(repo, 'publishTeamMatch', {
    matchId: row.matchId, approve: true, expectRevision: 1,
  });
  assert.equal(stalePublish.ok, false);

  // 统计同样：拿不到对的版本号就拒绝覆盖
  const panel = await call(repo, 'getTeamMatchStats', { matchId: row.matchId });
  const player = panel.sides[0].players[0];
  await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId, players: [{ userId: player.userId, points: 10 }],
  });
  const staleStats = await call(repo, 'saveTeamMatchStats', {
    matchId: row.matchId,
    players: [{ userId: player.userId, points: 20 }],
    expectRevision: 0,
  });
  assert.equal(staleStats.ok, false);
  assert.match(staleStats.message, /统计刚被改过/);
});

test('文案 —— 赛事与比赛的审核状态是中文，不是英文枚举值', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);

  const locked = (await call(repo, 'listTeamEvents', {})).events
    .find(item => item.eventId === eventId);
  assert.equal(locked.status, TEAM_EVENT_STATUS.LOCKED);
  assert.equal(locked.statusLabel, '名单已锁定', '列表上要写中文，不能把枚举值直接铺出去');

  await call(repo, 'drawTeamEvent', { eventId });
  const scheduled = (await call(repo, 'listTeamEvents', {})).events
    .find(item => item.eventId === eventId);
  assert.equal(scheduled.statusLabel, '赛程已发布');

  // 比赛状态同理：未开赛 → 待审核
  const matches = (await call(repo, 'listTeamMatches', { eventId })).matches;
  assert.equal(matches[0].statusLabel, '未开赛');
  await call(repo, 'recordTeamMatch', { matchId: matches[0].matchId, scoreA: 80, scoreB: 70 });
  const after = (await call(repo, 'getTeamEvent', { eventId })).matches
    .find(item => item.matchId === matches[0].matchId);
  assert.equal(after.statusLabel, '待审核', '录完等发布，文案要说人话');
});

test('8 队单败 + 5–8 名排位：排位赛会生成，名次按排位赛结果结算', async () => {
  const repo = fixtureFor(8, 5);
  const { eventId } = await lockedEvent(repo, { teamCount: 8, roster: 5, placementMode: 'top8' });
  assert.equal((await repo.teamEvents.getById(eventId)).placementMode, 'top8');
  await call(repo, 'drawTeamEvent', { eventId });

  const play = async (rows) => {
    for (const row of rows) {
      const recorded = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });
      assert.equal(recorded.ok, true, recorded.message);
      const published = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
      assert.equal(published.ok, true, published.message);
    }
  };
  const list = async () => (await call(repo, 'listTeamMatches', { eventId })).matches;

  const first = await list();
  assert.equal(first.length, 4, '八强四场');
  await play(first);

  const second = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.matchCount, 4, '半决赛两场 + 5–8 名排位半决两场');
  const round2 = (await list()).filter(row => row.round === 2);
  assert.equal(round2.length, 4);
  await play(round2);

  const third = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(third.ok, true, third.message);
  assert.equal(third.matchCount, 4, '决赛 + 季军赛 + 5/6 名 + 7/8 名');
  const round3 = (await list()).filter(row => row.round === 3);
  assert.equal(round3.length, 4);
  await play(round3);

  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);
  assert.deepEqual(settled.placements.map(row => row.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(settled.placements.map(row => row.note),
    ['冠军', '亚军', '季军', '第四名', '第五名', '第六名', '第七名', '第八名']);
});
