/**
 * 会员离开学校时的球队清理（detachUserFromTeams）
 * ============================================================
 * 转校只改 `school_members` 与 `memberships`，球队是另一套表。不清的话，
 * 一个已经转走的人仍然挂在校队名单里，甚至还是队长——报名时会被算进人数、
 * 锁定名单时会被拍进快照，等于让不属于本校的人上场。
 *
 * 这一组守三件事：
 *   1. 人走了，队员行要变成「已离队」并留时间；
 *   2. 队长走了，队长的位置要有人接（最早入队的在队队员），不能留空；
 *   3. 一个人都不剩，球队要归档，而不是留一支没有队长的活队。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const teamHandlers = require('../src/server/services/team-service');
const { detachUserFromTeams } = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey } = require('../src/shared/utils/school');
const { TEAM_STATUS, TEAM_MEMBER_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

/** 造 leader + 若干球员 */
function fixture(playerIds) {
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
  playerIds.forEach(add);
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/** 建一支队并把给定的人拉进来，返回 teamId */
async function teamWith(repo, captainId, memberIds) {
  const created = await call(repo, 'createTeamApplication', {
    name: '热浪队', requestId: `req_${captainId}`,
  }, captainId);
  await call(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
  for (const memberId of memberIds) {
    await call(repo, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
    await call(repo, 'reviewTeamMember', {
      teamId: created.teamId, userId: memberId, approve: true,
    }, captainId);
  }
  return created.teamId;
}

test('队长离校 —— 队长交给最早入队的在队队员，自己那一行变「已离队」', async () => {
  const repo = fixture(['u_cap', 'u_old', 'u_new']);
  const teamId = await teamWith(repo, 'u_cap', ['u_old', 'u_new']);

  const summary = await detachUserFromTeams(repo, {
    schoolId: 'muc', userId: 'u_cap', now: '2026-10-21T00:00:00.000Z', actorId: 'u_leader',
  });
  assert.equal(summary.detached, 1);
  assert.equal(summary.captainMoved, 1);
  assert.equal(summary.archived, 0);

  const team = await repo.forScope(SCOPE).teams.getById(teamId);
  assert.notEqual(team.captainId, 'u_cap', '走的人不能还是队长');
  assert.ok(['u_old', 'u_new'].includes(team.captainId));
  assert.equal(team.status, TEAM_STATUS.ACTIVE, '还有队员，不该归档');

  const rows = await repo.forScope(SCOPE).teamMembers.list();
  const gone = rows.find(row => row.userId === 'u_cap');
  assert.equal(gone.status, TEAM_MEMBER_STATUS.LEFT);
  assert.ok(gone.leftAt, '离队要留时间');

  const nextCaptain = rows.find(row => row.userId === team.captainId);
  assert.equal(nextCaptain.role, 'captain');
  assert.equal(nextCaptain.status, TEAM_MEMBER_STATUS.ACTIVE);
});

test('队长离校 —— 队里一个人都不剩时把球队归档，而不是留一支没队长的活队', async () => {
  const repo = fixture(['u_cap']);
  const teamId = await teamWith(repo, 'u_cap', []);

  const summary = await detachUserFromTeams(repo, {
    schoolId: 'muc', userId: 'u_cap', now: '2026-10-21T00:00:00.000Z', actorId: 'u_leader',
  });
  assert.equal(summary.detached, 1);
  assert.equal(summary.archived, 1);

  const team = await repo.forScope(SCOPE).teams.getById(teamId);
  assert.equal(team.status, TEAM_STATUS.ARCHIVED);
  assert.equal(team.archivedReason, 'captain-left');
});

test('普通队员离校 —— 只摘人，不动队长，也不归档', async () => {
  const repo = fixture(['u_cap', 'u_p1']);
  const teamId = await teamWith(repo, 'u_cap', ['u_p1']);

  const summary = await detachUserFromTeams(repo, {
    schoolId: 'muc', userId: 'u_p1', now: '2026-10-21T00:00:00.000Z', actorId: 'u_leader',
  });
  assert.equal(summary.detached, 1);
  assert.equal(summary.captainMoved, 0);
  assert.equal(summary.archived, 0);

  const team = await repo.forScope(SCOPE).teams.getById(teamId);
  assert.equal(team.captainId, 'u_cap');
  assert.equal(team.status, TEAM_STATUS.ACTIVE);
});

test('不在任何队里的人 —— 一个都不动，也不抛错', async () => {
  const repo = fixture(['u_cap']);
  await teamWith(repo, 'u_cap', []);

  const summary = await detachUserFromTeams(repo, {
    schoolId: 'muc', userId: 'u_nobody', now: '2026-10-21T00:00:00.000Z',
  });
  assert.deepEqual(summary, { detached: 0, captainMoved: 0, archived: 0 });

  // 缺参数时也不抛：调用方是转校流程，不能因为清理把主流程带崩
  assert.deepEqual(await detachUserFromTeams(null, {}), { detached: 0, captainMoved: 0, archived: 0 });
});

test('球队属于另一所学校 —— 清理只作用在指定学校内', async () => {
  const repo = fixture(['u_cap', 'u_p1']);
  const teamId = await teamWith(repo, 'u_cap', ['u_p1']);

  const summary = await detachUserFromTeams(repo, {
    schoolId: 'buaa', userId: 'u_cap', now: '2026-10-21T00:00:00.000Z',
  });
  assert.equal(summary.detached, 0);

  const rows = await repo.forScope(SCOPE).teamMembers.list();
  assert.equal(rows.find(row => row.userId === 'u_cap').status, TEAM_MEMBER_STATUS.ACTIVE);
  assert.ok(await repo.forScope(SCOPE).teams.getById(teamId));
});
