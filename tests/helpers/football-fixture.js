// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../../src/server/services/school-context');
const service = require('../../src/server/services/team-event-service');
const { schoolMemberKey, schoolMembershipKey, teamMemberKey, schoolKey } = require('../../src/shared/utils/school');
const { database } = require('../../tools/audit-basketball-cloud.cjs');
const { createRepo } = require('../../cloudfunctions/data/src/adapters/cloud-repo');
const { handleSchoolRequest } = require('../../cloudfunctions/data/src/core/school-request');
const SCOPE = { schoolId: 'muc', association: 'fb' };
const NOW = new Date('2026-10-20T12:00:00Z');
async function fixture({ cloud = false, count = 2, format = 'round_robin', rules = {} } = {}) {
  const seed = createSchoolDemoSeed();
  for (const id of ['recorder', 'viewer', ...Array.from({ length: count * 12 }, (_, i) => `f${i}`)]) {
    seed.users.push({ _id: id, openId: `fb_${id}`, nickName: id, platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', status: 'active', collegeId: 'c01' });
    seed.memberships.push({ _id: schoolMembershipKey(id, SCOPE), ...SCOPE, userId: id, status: 'active', role: 'member' });
  }
  seed.users = seed.users.map(user => ({ ...user, ...require('../../src/server/services/account-directory').accountDirectoryFields(user) }));
  const db = cloud ? database(seed) : null;
  const repo = cloud ? createRepo(db) : createSchoolMemoryRepo(seed);
  let request = 0;
  const call = async (action, payload = {}, actor = 'demo_muc_admin', scope = SCOPE) => {
    if (cloud) {
      const user = await repo.users.getById(actor);
      const response = await handleSchoolRequest({ protocolVersion: 2, ...scope, action, payload }, { repo, openId: user.openId, now: NOW });
      return response.data || response;
    }
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope, now: NOW });
    return (await service[action](payload, ctx)).data;
  };
  const created = await call('createTeamEvent', { name: '足球完整赛季', requestId: 'football_f23', format, rules });
  assert.equal(created.ok, true, created.message);
  const eventId = created.eventId;
  for (let n = 0; n < count; n++) {
    const teamId = `ft${n}`; const captainId = `f${n * 12}`;
    await repo.teams.set(teamId, { _id: teamId, ...SCOPE, name: `足球队${n}`, sport: 'football', captainId, status: 'active' });
    for (let p = 0; p < 12; p++) {
      const userId = `f${n * 12 + p}`; const key = teamMemberKey(teamId, userId);
      await repo.teamMembers.set(key, { _id: key, ...SCOPE, userId, teamId, status: 'active', role: p ? 'member' : 'captain' });
    }
    assert.equal((await call('submitTeamEntry', { eventId, teamId }, captainId)).ok, true);
    assert.equal((await call('reviewTeamEntry', { eventId, teamId, approve: true })).ok, true);
  }
  assert.equal((await call('lockTeamEntries', { eventId })).ok, true);
  const draw = await call('drawTeamEvent', { eventId, seed: 23 });
  assert.equal(draw.ok, true, draw.message);
  const matches = async () => (await repo.forScope(SCOPE).teamMatches.list()).filter(m => m.eventId === eventId);
  async function write(action, match, payload, actor) {
    const current = await repo.teamMatches.getById(typeof match === 'string' ? match : match._id);
    return call(action, { matchId: current._id, expectRevision: current.revision, requestId: `f23_${++request}`, ...payload }, actor);
  }
  async function report(match, result = { regulationScore: { A: 0, B: 0 } }, withPlayers = false) {
    const sides = {};
    for (const [key, teamId] of [['A', match.teamA], ['B', match.teamB]]) {
      const entry = await repo.teamEventEntries.getById(schoolKey('ten', eventId, teamId));
      sides[key] = { players: withPlayers ? entry.roster.map((p, i) => ({ userId: p.userId, starter: i < 11, appeared: i < 11, goalkeeper: i === 0 })) : [], coverage: {}, substitutions: { status: 'none' } };
    }
    return { result, sides, goalEvents: [] };
  }
  async function publish(match, data) {
    const recorded = await write('recordTeamMatch', match, { report: data });
    assert.equal(recorded.ok, true, recorded.message);
    const published = await write('publishTeamMatch', match, { approve: true });
    assert.equal(published.ok, true, published.message);
    return published;
  }
  return { repo, db, call, eventId, matches, write, report, publish, SCOPE };
}
module.exports = { fixture, SCOPE };
