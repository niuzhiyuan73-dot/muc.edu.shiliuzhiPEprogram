/**
 * 团队赛事 P3：个人与球队成绩展示
 * ============================================================
 * 这一组守的是「成绩怎么算、给谁看」：
 *   · 参赛经历读报名快照 —— 退队之后历史仍在；
 *   · 跨赛事累计只算已发布，且按赛事分组，不同届不混算；
 *   · 未记录的指标是 null 与「—」，不是 0；
 *   · 别人的档案只有协会负责人能查；
 *   · 球队战绩在归档之后仍可查（历史是公开事实，不随归档消失）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/team-event-service');
const teamHandlers = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey } = require('../src/shared/utils/school');
const { TEAM_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

function fixture(teamCount = 2, roster = 5) {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: `${id}昵称`, realName: id, gender: 'M',
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

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

async function callTeam(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/** 建 N 支队、报名、锁定、抽签（单循环），返回赛事与球队编号 */
async function lockedEvent(repo, { teamCount = 2, roster = 5 } = {}) {
  const event = await call(repo, 'createTeamEvent', {
    name: '秋季联赛', requestId: 'req_e1', format: 'round_robin',
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
  const drawn = await call(repo, 'drawTeamEvent', { eventId: event.eventId });
  assert.equal(drawn.ok, true, drawn.message);
  return { eventId: event.eventId, teamIds };
}

/** 让 teamId 赢下它参与的每一场，并按需录一条个人统计 */
async function playAndPublish(repo, eventId, teamId, { stats = null } = {}) {
  const matches = (await call(repo, 'listTeamMatches', { eventId })).matches
    .filter(row => row.status === 'scheduled' && (row.teamA === teamId || row.teamB === teamId));
  for (const row of matches) {
    const isA = row.teamA === teamId;
    await call(repo, 'recordTeamMatch', {
      matchId: row.matchId,
      scoreA: isA ? 80 : 70,
      scoreB: isA ? 70 : 80,
    });
    if (stats && stats[row.matchId]) {
      const saved = await call(repo, 'saveTeamMatchStats', {
        matchId: row.matchId, mode: 'basic', players: stats[row.matchId],
      });
      assert.equal(saved.ok, true, saved.message);
    }
    await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  }
  return matches;
}

test('我的团队档案 —— 队长看到球队、角色与冠军荣誉', async () => {
  const repo = fixture();
  const { eventId, teamIds } = await lockedEvent(repo);
  await playAndPublish(repo, eventId, teamIds[0]);
  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);

  const profile = await call(repo, 'getMyTeamProfile', {}, 'u_t0c');
  assert.equal(profile.ok, true, profile.message);
  assert.equal(profile.isSelf, true);
  assert.equal(profile.teams.length, 1);
  assert.equal(profile.teams[0].teamId, teamIds[0]);
  assert.equal(profile.teams[0].roleLabel, '队长');
  assert.equal(profile.teams[0].statusLabel, '正常');
  assert.equal(profile.teams[0].memberCount, 5);
  assert.equal(profile.teams[0].current, true);

  // 参赛经历与荣誉：单循环两支队只打一场，赢了就是冠军
  assert.equal(profile.events.length, 1);
  assert.equal(profile.events[0].eventId, eventId);
  assert.equal(profile.events[0].games, 1);
  assert.equal(profile.events[0].placementText, '冠军');
  assert.match(profile.events[0].recordText, /1 场 · 1 胜 0 负/);
  assert.equal(profile.honors.length, 1);
  assert.equal(profile.honors[0].placementText, '冠军');
  assert.equal(profile.honors[0].teamName, '球队1');
  assert.match(profile.totals.recordText, /1 场 · 1 胜 0 负/);
});

test('跨赛事累计 —— 只算已发布；没记录的指标是 null 与「—」，不是 0', async () => {
  const repo = fixture(3, 5);
  const { eventId, teamIds } = await lockedEvent(repo, { teamCount: 3 });
  const playerId = 'u_t0p0';

  // team0 的两场比赛里只有一场发布，另一场停在待审核
  const matches = (await call(repo, 'listTeamMatches', { eventId })).matches
    .filter(row => row.teamA === teamIds[0] || row.teamB === teamIds[0]);
  assert.equal(matches.length, 2);

  const first = matches[0];
  const isA = first.teamA === teamIds[0];
  await call(repo, 'recordTeamMatch', {
    matchId: first.matchId, scoreA: isA ? 88 : 70, scoreB: isA ? 70 : 88,
  });
  const saved = await call(repo, 'saveTeamMatchStats', {
    matchId: first.matchId,
    mode: 'basic',
    // 只填得分：篮板等其余指标「这场没记录」，不能算成 0
    players: [{ userId: playerId, points: 18 }],
  });
  assert.equal(saved.ok, true, saved.message);
  await call(repo, 'publishTeamMatch', { matchId: first.matchId, approve: true });

  // 第二场只录不发布：待审核的比分与统计都不该进个人累计
  const second = matches[1];
  const secondIsA = second.teamA === teamIds[0];
  await call(repo, 'recordTeamMatch', {
    matchId: second.matchId, scoreA: secondIsA ? 90 : 60, scoreB: secondIsA ? 60 : 90,
  });
  await call(repo, 'saveTeamMatchStats', {
    matchId: second.matchId, mode: 'basic', players: [{ userId: playerId, points: 30 }],
  });

  const profile = await call(repo, 'getMyTeamProfile', {}, playerId);
  assert.equal(profile.ok, true, profile.message);
  assert.equal(profile.totals.points, 18, '未发布的那场不算');
  assert.equal(profile.totals.games, 1);
  assert.equal(profile.totals.pointsText, '18');
  assert.equal(profile.totals.rebounds, null, '没记录 ≠ 0');
  assert.equal(profile.totals.reboundsText, '—');
  assert.equal(profile.totals.reboundsPerGame, null);

  // 按赛事分组：同一批数字落在这一届名下，不与别的届混算
  assert.equal(profile.statEvents.length, 1);
  assert.equal(profile.statEvents[0].eventId, eventId);
  assert.equal(profile.statEvents[0].points, 18);
  assert.equal(profile.statEvents[0].reboundsText, '—');
});

test('参赛经历 —— 退队之后历史仍在，球队标记为已离队', async () => {
  const repo = fixture();
  const { eventId, teamIds } = await lockedEvent(repo);
  await playAndPublish(repo, eventId, teamIds[0]);
  await call(repo, 'settleTeamEvent', { eventId });

  const memberId = 'u_t0p1';
  const left = await callTeam(repo, 'leaveTeam', { teamId: teamIds[0] }, memberId);
  assert.equal(left.ok, true, left.message);

  const profile = await call(repo, 'getMyTeamProfile', {}, memberId);
  assert.equal(profile.ok, true, profile.message);
  assert.equal(profile.teams.length, 1, '离队不抹掉「我曾在这支队」');
  assert.equal(profile.teams[0].current, false);
  assert.equal(profile.teams[0].memberStatusLabel, '已离队');
  assert.equal(profile.events.length, 1, '报名快照还在，参赛经历不该消失');
  assert.equal(profile.honors.length, 1, '当年的冠军仍是他的团队荣誉');
});

test('我的团队档案 —— 别人的档案只有协会负责人能查', async () => {
  const repo = fixture();
  const { eventId, teamIds } = await lockedEvent(repo);
  await playAndPublish(repo, eventId, teamIds[0]);
  await call(repo, 'settleTeamEvent', { eventId });

  // 普通队员查别人：拒绝
  const refused = await call(repo, 'getMyTeamProfile', { userId: 'u_t1c' }, 'u_t0p0');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /只能查看自己的团队成绩/);

  // 普通队员查自己：可以
  const self = await call(repo, 'getMyTeamProfile', {}, 'u_t0p0');
  assert.equal(self.ok, true, self.message);
  assert.equal(self.isSelf, true);

  // 协会负责人代查：可以
  const byLeader = await call(repo, 'getMyTeamProfile', { userId: 'u_t1c' }, 'u_leader');
  assert.equal(byLeader.ok, true, byLeader.message);
  assert.equal(byLeader.isSelf, false);
  assert.equal(byLeader.teams[0].teamId, teamIds[1]);
});

test('球队战绩 —— 胜负、胜率、名次与近期战绩都对得上，归档后仍可查', async () => {
  const repo = fixture();
  const { eventId, teamIds } = await lockedEvent(repo);
  await playAndPublish(repo, eventId, teamIds[0]);
  await call(repo, 'settleTeamEvent', { eventId });

  const record = await call(repo, 'getTeamRecord', { teamId: teamIds[0] }, 'u_t1p0');
  assert.equal(record.ok, true, record.message);
  // 战绩的 sportFormat 取球队实际参赛赛事的声明（篮球赛 → basketball5），
  // 而不是笼统按当前协会回退；跨协会分享打开时两者可能不同。
  assert.equal(record.sportFormat, 'basketball5');
  assert.equal(record.team.name, '球队1');
  assert.equal(record.team.statusLabel, '正常');
  assert.equal(record.team.captainName, 'u_t0c昵称', '队长的名字给昵称，不把编号铺到页面上');
  assert.equal(record.team.memberCount, 5);
  assert.equal(record.overall.games, 1);
  assert.equal(record.overall.wins, 1);
  assert.equal(record.overall.winRateText, '100%');
  assert.equal(record.seasons.length, 1);
  assert.equal(record.seasons[0].placementText, '冠军');
  assert.equal(record.recent.length, 1);
  assert.equal(record.recent[0].result, 'win');
  assert.equal(record.recent[0].resultLabel, '胜');
  assert.equal(record.recent[0].scoreText, '80 : 70');

  // 归档：不再接人报名，但历史成绩照旧查得到
  await callTeam(repo, 'archiveTeam', { teamId: teamIds[0] }, 'u_t0c');
  const archived = await call(repo, 'getTeamRecord', { teamId: teamIds[0] }, 'u_t1p0');
  assert.equal(archived.ok, true, archived.message);
  assert.equal(archived.team.archived, true);
  assert.equal(archived.team.status, TEAM_STATUS.ARCHIVED);
  assert.equal(archived.seasons[0].placementText, '冠军');
  assert.equal(archived.overall.wins, 1);
});

test('球队战绩 —— 没有参赛的球队给空战绩，不编造数字', async () => {
  const repo = fixture();
  const created = await callTeam(repo, 'createTeamApplication', {
    name: '新队伍', requestId: 'req_new',
  }, 'u_t0c');
  await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });

  const record = await call(repo, 'getTeamRecord', { teamId: created.teamId });
  assert.equal(record.ok, true, record.message);
  assert.equal(record.overall.games, 0);
  assert.equal(record.overall.winRateText, '—');
  assert.equal(record.overall.recordText, '还没打完一场');
  assert.deepEqual(record.seasons, []);
  assert.deepEqual(record.recent, []);
});

/**
 * 战绩页的读量收窄（2026-10-27 第八轮审查 P1-4）
 * ============================================================
 * `getTeamRecord` 原实现一次读本协会历年的 teamEvents / teamEventEntries /
 * teamMatches / teamMembers / teams 五个集合，再加 buildDirectory（全校名册）——
 * 只为一个队的战绩页。届数越多、队伍越多，翻页越多，最后撞云函数超时。
 *
 * 这条用例盯的是「不再整表读」这件事本身：谁把 list() 改回来，它就红。
 * ============================================================
 */
function spyTeamFullReads(repo) {
  const calls = [];
  const raw = repo.forScope.bind(repo);
  repo.forScope = (input) => {
    const surface = raw(input);
    for (const key of ['teamEvents', 'teamEventEntries', 'teamMatches', 'teamMembers', 'teams']) {
      if (!surface[key] || typeof surface[key].list !== 'function') continue;
      const original = surface[key].list.bind(surface[key]);
      surface[key].list = (...args) => { calls.push(key); return original(...args); };
    }
    return surface;
  };
  return calls;
}

test('球队战绩按队收窄：不读本协会历年的五个集合', async () => {
  const repo = fixture();
  const { eventId, teamIds } = await lockedEvent(repo, { teamCount: 2 });
  await playAndPublish(repo, eventId, teamIds[0]);

  const calls = spyTeamFullReads(repo);
  const record = await call(repo, 'getTeamRecord', { teamId: teamIds[0] }, 'u_t1p0');
  assert.equal(record.ok, true, record.message);
  assert.deepEqual(calls, [],
    '战绩页应走 listByTeam / listByTeams / listByIds；整表读会随协会历史线性变慢');

  // 收窄之后口径不能变：该有的名次与近期战绩仍在
  assert.equal(record.overall.games, 1);
  assert.equal(record.seasons.length, 1);
  assert.equal(record.recent.length, 1);
  assert.equal(record.team.memberCount, 5);
  assert.equal(record.team.captainName, 'u_t0c昵称');
});
