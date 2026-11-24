/** 2026-10-16 独立验收探针。只操作内存仓储，不连接云端、不修改业务文件。
 * node tools/acceptance-audit.cjs
 * 发现不满足安全/一致性预期的行为时退出码 1；修复后应全部 PASS。
 */
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const matches = require('../src/server/services/school-match-service');
const events = require('../src/server/services/school-event-service');
const { schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school');
const { MATCH_TYPE, MATCH_STATUS, RATED_PAIR_LIMIT } = require('../src/shared/utils/constants');
const scope = { schoolId: 'muc', association: 'pkb' };
const now = new Date('2026-10-16T10:00:00Z');
const admin = 'demo_muc_admin', member = 'demo_muc_member';
function fixture() {
  const seed = createSchoolDemoSeed();
  for (const id of ['audit_player_2', 'audit_player_3']) {
    seed.users.push({ _id: id, openId: id, nickName: id, gender: 'M', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', collegeId: 'c01', status: 'active' });
  }
  return createSchoolMemoryRepo(seed);
}
async function call(repo, action, payload, actor = admin) {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope, now });
  return (await ({ ...matches, ...events })[action](payload, ctx)).data;
}
const params = requestId => ({ requestId, matchType: MATCH_TYPE.SINGLES, teamA: [admin], teamB: [member],
  gamePoints: 11, bestOf: 1, scoreA: [11], scoreB: [8], matchTime: '2026-10-16T09:00:00Z', location: '验收测试' });
function required(result) { assert.equal(result.ok, true, result.message); return result; }
const probes = [];
const probe = (id, name, fn) => probes.push({ id, name, fn });

probe('F1', '已禁用账号不能确认比赛', async () => {
  const repo = fixture();
  const match = required(await call(repo, 'submitSchoolMatch', params('disabled_actor'))).match;
  const user = await repo.users.getById(member);
  await repo.users.set(member, { ...user, platformStatus: 'disabled' });
  const read = await call(repo, 'getSchoolMatch', { matchId: match.matchId }, member);
  // 经过实际协议 2 分发入口及云端共享镜像，身份由 OpenID 解析，非客户端伪造 actor。
  const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
  const write = (await handleSchoolRequest({ protocolVersion: 2, ...scope,
    action: 'confirmSchoolMatch', payload: { matchId: match.matchId } }, { repo, openId: user.openId, now })).data;
  const stored = await repo.matches.getById(match.matchId);
  return { pass: !write.ok && stored.status === MATCH_STATUS.PENDING,
    readAllowed: read.ok, confirmAllowed: write.ok, finalStatus: stored.status };
});

probe('F2', '管理员授权在事务前撤销后不能替他人录分', async () => {
  const repo = fixture();
  const transaction = repo.transaction.bind(repo);
  repo.transaction = async work => {
    const key = schoolRoleKey(admin, 'muc');
    const role = await repo.schoolRoles.getById(key);
    await repo.schoolRoles.set(key, { ...role, status: 'disabled' });
    return transaction(work);
  };
  const result = await call(repo, 'submitSchoolMatch', { ...params('revoked_role'), teamA: [member], teamB: ['audit_player_2'] });
  return { pass: !result.ok, submitAllowedAfterRoleRevoked: result.ok, matchCount: (await repo.matches.list()).length };
});

probe('F3', '剩一个交手名额时两次并发提交最多成功一次', async () => {
  const repo = fixture();
  for (let i = 0; i < RATED_PAIR_LIMIT - 1; i += 1) required(await call(repo, 'submitSchoolMatch', params(`prior_${i}`)));
  const results = await Promise.all(['parallel_a', 'parallel_b'].map(id => call(repo, 'submitSchoolMatch', params(id))));
  const count = (await repo.matches.list()).length;
  return { pass: count <= RATED_PAIR_LIMIT, limit: RATED_PAIR_LIMIT, count, concurrentAccepted: results.filter(r => r.ok).length };
});

probe('F4', '平台禁用选手不能被直接传 ID 录入新比赛', async () => {
  const repo = fixture();
  await repo.users.set(member, { ...await repo.users.getById(member), platformStatus: 'disabled' });
  const context = await call(repo, 'getSchoolMatchEntryContext', {});
  const result = await call(repo, 'submitSchoolMatch', params('disabled_opponent'));
  return { pass: !result.ok, visibleInPicker: context.members.some(row => row.userId === member), submitAllowed: result.ok };
});

probe('F5', '已下线的撤销接口不能改变已生效半决赛及下游决赛', async () => {
  const repo = fixture();
  const event = required(await call(repo, 'publishSchoolEvent', { requestId: 'bracket', title: '验收四人淘汰赛',
    matchType: MATCH_TYPE.SINGLES, level: 3, format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
    startTime: '2026-10-16T09:00:00Z', courtCount: 2 })).event;
  for (const actor of [admin, member, 'audit_player_2', 'audit_player_3']) required(await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, actor));
  required(await call(repo, 'drawSchoolEvent', { eventId: event.eventId, seedValue: 42 }));
  required(await call(repo, 'startSchoolEvent', { eventId: event.eventId }));
  const firstRound = required(await call(repo, 'listSchoolMatches', { eventId: event.eventId })).matches;
  assert.equal(firstRound.length, 2);
  for (const match of firstRound) {
    const wins = Math.floor(match.bestOf / 2) + 1;
    required(await call(repo, 'submitSchoolMatch', { matchId: match.matchId,
      scoreA: Array(wins).fill(match.gamePoints), scoreB: Array(wins).fill(0) }));
    required(await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }));
  }
  const downstream = required(await call(repo, 'listSchoolMatches', { eventId: event.eventId })).matches.filter(m => !firstRound.some(f => f.matchId === m.matchId));
  assert.ok(downstream.length > 0, '确认半决赛后应生成下游');
  const before = await repo.matches.list();
  const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
  const result = await handleSchoolRequest({ protocolVersion: 2, ...scope, action: 'revokeSchoolMatch',
    payload: { matchId: firstRound[0].matchId, reason: '验收：半决赛比分错误' } },
    { repo, openId: 'mock_openid_muc_admin', now });
  assert.deepEqual(await repo.matches.list(), before, '被拒绝的旧接口不能改比赛或下游签表');
  const final = await repo.matches.getById(downstream[0].matchId);
  return { pass: !result.ok, revokeAllowed: result.ok, downstreamCount: downstream.length,
    downstreamStillPending: final.status === MATCH_STATUS.PENDING, downstreamTeams: [final.teamA, final.teamB] };
});

(async () => {
  let failures = 0;
  for (const { id, name, fn } of probes) {
    try {
      const result = await fn();
      if (!result.pass) failures += 1;
      console.log(JSON.stringify({ id, name, ...result }));
    } catch (error) {
      failures += 1;
      console.log(JSON.stringify({ id, name, probeError: error.message }));
    }
  }
  console.log(JSON.stringify({ probes: probes.length, failed: failures }));
  process.exitCode = failures ? 1 : 0;
})();

