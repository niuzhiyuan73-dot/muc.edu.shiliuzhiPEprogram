const { test } = require('node:test');
const assert = require('node:assert/strict');
const { teamSportStrategy, teamSportStrategyFor } = require('../src/shared/utils/team-sport-rules');
const { getAssociation, isKnownAssociation, basketballRulesOf } = require('../src/shared/utils/associations');
const { DEFAULT_PRESET_KEY, defaultRulesFor } = require('../src/shared/utils/football-rules');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { schoolMemberKey, schoolMembershipKey } = require('../src/shared/utils/school');
const service = require('../src/server/services/team-event-service');

const scope = { schoolId: 'muc', association: 'bk' };
const footballRules = defaultRulesFor();

// F0 不注册足球入口。仅在隔离的测试进程中把现有协会元数据换成足球，
// 验证将来 F1 注册后的真实 service 路径；每条用例后恢复，不伪造请求级运动开关。
function footballMetadata(t) {
  const association = getAssociation('bk');
  const original = association.teamSportFormat;
  association.teamSportFormat = 'football11';
  t.after(() => { association.teamSportFormat = original; });
}
async function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'f0leader', openId: 'mock_f0leader', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
  seed.schoolMembers.push({ _id: schoolMemberKey('f0leader', 'muc'), userId: 'f0leader', schoolId: 'muc', status: 'active', collegeId: 'c01' });
  seed.memberships.push({ _id: schoolMembershipKey('f0leader', scope), ...scope, userId: 'f0leader', status: 'active', role: 'leader' });
  const repo = createSchoolMemoryRepo(seed);
  const call = async (action, payload = {}) => {
    const ctx = await buildSchoolContext({ repo, actorId: 'f0leader', scope, now: new Date('2026-10-20T12:00:00Z') });
    return (await service[action](payload, ctx)).data;
  };
  return { repo, call };
}
async function footballEvent(repo, extra = {}) {
  const event = { _id: 'football', ...scope, name: '足球基础测试', sportFormat: 'football11',
    rules: footballRules, format: 'round_robin', status: 'running', revision: 1, ...extra };
  await repo.teamEvents.set(event._id, event);
  for (const id of ['a', 'b']) {
    await repo.teams.set(id, { _id: id, ...scope, name: `队${id}`, captainId: 'f0leader', status: 'active' });
    await repo.teamEventEntries.set(`entry${id}`, { _id: `entry${id}`, ...scope, eventId: event._id,
      teamId: id, status: 'locked', roster: [] });
  }
  await repo.teamMatches.set('fmatch', { _id: 'fmatch', ...scope, sportFormat: 'football11', eventId: event._id,
    teamA: 'a', teamB: 'b', scoreA: 0, scoreB: 0, winner: 'A', status: 'published', revision: 1, round: 1 });
  return event;
}

test('运动分派按可信协会元数据；未知协会/运动不回落到篮球，F1 已注册足球', () => {
  assert.equal(teamSportStrategy('football11').supportsLiveScore, false);
  assert.equal(teamSportStrategy('basketball5').supportsLiveScore, true);
  assert.equal(teamSportStrategy('volleyball'), null);
  assert.equal(teamSportStrategy('__proto__'), null);
  assert.equal(teamSportStrategyFor('unknown'), null);
  assert.equal(teamSportStrategyFor('pkb'), null);
  assert.equal(teamSportStrategyFor('bk').sportFormat, 'basketball5');
  assert.equal(teamSportStrategyFor('bk', { rules: footballRules }), null);
  assert.equal(teamSportStrategyFor('bk', { association: 'pkb' }), null);
  assert.equal(isKnownAssociation('fb'), true);
});

test('旧篮球赛事没有制式也能读取，显式错误制式拒绝', t => {
  const association = getAssociation('bk');
  const previous = association.teamSportFormat;
  delete association.teamSportFormat;
  t.after(() => { association.teamSportFormat = previous; });
  assert.equal(teamSportStrategyFor('bk', { rules: { periods: 2 } }).sportFormat, 'basketball5');
  assert.equal(teamSportStrategyFor('bk', { sportFormat: 'football11' }), null);
  assert.equal(teamSportStrategyFor('bk', { rules: { sportFormat: 'basketball3' } }), null);
  association.teamSportFormat = null;
  assert.equal(teamSportStrategyFor('bk'), null, '显式未知值不能当成缺字段');
});

test('篮球分派入口不静默接收足球预设、足球字段或错误字段', () => {
  const normalize = teamSportStrategy('basketball5').normalizeRules;
  for (const input of [footballRules, { presetKey: DEFAULT_PRESET_KEY }, { presetKey: 'fiba-4x10', halfMinutes: 40 },
    { presetKey: '', periods: 4 }, { presetKey: 'fiba-4x10', periodMinute: 10 }]) assert.equal(normalize(input), null);
  assert.equal(normalize({ presetKey: 'campus-2x20' }).periods, 2);
});

test('篮球建赛拒绝伪造足球参数，个人比赛和 Elo 集合不受影响', async () => {
  const { repo, call } = await fixture();
  const before = await repo.matches.list();
  const ratings = await repo.memberRatings.list();
  for (const extra of [{ sportFormat: 'football11' }, { presetKey: DEFAULT_PRESET_KEY }, { rules: footballRules }, { rules: [] }, { rules: null },
    { presetKey: DEFAULT_PRESET_KEY, rules: { presetKey: 'fiba-4x10' } }]) {
    const result = await call('createTeamEvent', { name: '不应建立', requestId: 'f0_invalid', ...extra });
    assert.equal(result.ok, false);
  }
  assert.equal((await repo.teamEvents.list()).some(event => event.name === '不应建立'), false);
  assert.deepEqual(await repo.matches.list(), before);
  assert.deepEqual(await repo.memberRatings.list(), ratings);
});

test('足球按独立规则建快照且详情走足球积分；不会出现篮球字段或实时能力', async t => {
  footballMetadata(t);
  const { repo, call } = await fixture();
  assert.equal(basketballRulesOf('bk'), null);
  const result = await call('createTeamEvent', { name: '足球规则验证', requestId: 'f0_valid' });
  assert.equal(result.ok, true, result.message);
  const stored = await repo.teamEvents.getById(result.eventId);
  assert.equal(stored.sportFormat, 'football11');
  assert.equal(stored.entryMin, 11); assert.equal(stored.entryMax, 22);
  assert.equal(stored.rules.halfMinutes, 40);
  assert.equal(stored.rules.periods, undefined); assert.equal(stored.rules.personalFoulLimit, undefined);
  const wrong = await call('createTeamEvent', { name: '不接受篮球', requestId: 'f0_wrong', presetKey: 'fiba-4x10' });
  assert.equal(wrong.ok, false);
  await footballEvent(repo);
  const detail = await call('getTeamEvent', { eventId: 'football' });
  assert.equal(detail.ok, true, detail.message);
  assert.equal(detail.event.supportsLiveScore, false);
  assert.match(detail.event.rulesText, /十一人制/);
  detail.table.forEach(row => { assert.equal(row.points, 1); assert.equal(row.draws, 1); assert.equal(row.rank, null); });
});

test('足球后端拒绝实时开台、操作和订阅；赛后接口拒绝缺少版本的篮球格式请求', async t => {
  footballMetadata(t);
  const { repo, call } = await fixture();
  await footballEvent(repo, { status: 'scheduled' });
  const match = await repo.teamMatches.getById('fmatch');
  await repo.teamMatches.set('fmatch', { ...match, status: 'scheduled', scoreA: null, scoreB: null });
  const before = await repo.teamMatches.list();
  for (const [action, payload] of [
    ['startTeamLiveScore', { matchId: 'fmatch' }],
    ['updateTeamLiveScore', { matchId: 'fmatch', operationId: 'f0_op', type: 'score', side: 'A', points: 3 }],
    ['getTeamLiveScores', { matchIds: ['fmatch'] }],
  ]) {
    const denied = await call(action, payload);
    assert.equal(denied.ok, false); assert.match(denied.message, /不支持实时/);
  }
  for (const action of ['saveTeamMatchLineup', 'recordTeamMatch', 'publishTeamMatch',
    'reviewTeamMatchStats', 'saveTeamMatchStats']) {
    const denied = await call(action, { matchId: 'fmatch', eventId: 'football', teamId: 'a', scoreA: 3, scoreB: 0 });
    assert.equal(denied.ok, false, action); assert.match(denied.message, /请求编号或比赛版本/, action);
  }
  const lineup = await call('getTeamMatchLineup', { matchId: 'fmatch' });
  assert.equal(lineup.minOnCourt, 7);
  assert.equal((await call('getMyTeamProfile', {})).sportFormat, 'football11');
  assert.equal((await call('getTeamRecord', { teamId: 'a' })).sportFormat, 'football11');
  assert.deepEqual(await repo.teamMatches.list(), before);
});

test('足球循环赛同分不结算；完整审计的抽签结果可使最终名次明确', async t => {
  footballMetadata(t);
  const { repo, call } = await fixture();
  const event = await footballEvent(repo);
  const pending = await call('settleTeamEvent', { eventId: event._id });
  assert.equal(pending.ok, false); assert.match(pending.message, /同分/);
  assert.equal((await repo.teamEvents.getById(event._id)).status, 'running');
  const detail = await call('getTeamEvent', { eventId: event._id });
  const decision = { tieKey: detail.table[0].tieKey, teamIds: ['b', 'a'], reason: '抽签记录',
    decidedBy: 'f0leader', decidedAt: '2026-10-20T12:00:00Z' };
  await repo.teamEvents.set(event._id, { ...event, rankingDecisions: [decision] });
  const settled = await call('settleTeamEvent', { eventId: event._id });
  assert.equal(settled.ok, true, settled.message);
  const final = await repo.teamEvents.getById(event._id);
  assert.deepEqual(final.placements.map(row => [row.teamId, row.rank]), [['b', 1], ['a', 2]]);
});

test('足球运动身份与存储快照不一致时拒绝载入，而不是调用篮球规则', async t => {
  footballMetadata(t);
  const { repo, call } = await fixture();
  await footballEvent(repo, { rules: { sportFormat: 'basketball5' } });
  const denied = await call('getTeamEvent', { eventId: 'football' });
  assert.equal(denied.ok, false); assert.match(denied.message, /运动规则/);
});
