const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { schoolMemberKey, schoolMembershipKey, schoolKey } = require('../src/shared/utils/school');
const service = require('../src/server/services/team-event-service');
const { TEAM_MATCH_STATUS } = require('../src/shared/utils/constants');

const scope = { schoolId: 'muc', association: 'bk' };
async function fixture({ statPolicy = 'basic', fullRoster = false } = {}) {
  const seed = createSchoolDemoSeed();
  for (const id of ['scorer', 'viewer', 'leader', 'other', 'bench']) {
    seed.users.push({ _id: id, openId: `mock_${id}`, platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', status: 'active', collegeId: 'c01' });
  }
  seed.memberships.push({ _id: schoolMembershipKey('leader', scope), userId: 'leader', ...scope, role: 'leader', status: 'active' });
  const repo = createSchoolMemoryRepo(seed);
  await repo.teamEvents.set('event', { _id: 'event', ...scope, name: '篮球赛', format: 'single_elim',
    status: 'scheduled', revision: 1, rules: { periods: 2 }, statPolicy });
  await repo.teams.set('a', { _id: 'a', ...scope, name: '甲队', captainId: 'scorer' });
  await repo.teams.set('b', { _id: 'b', ...scope, name: '乙队', captainId: 'other' });
  for (const [teamId, roster] of [
    ['a', [{ userId: 'scorer', name: '小明', no: 7 }, { userId: 'bench', name: '小林', no: 8 }]],
    ['b', [{ userId: 'other', name: '小王', no: 0 }]],
  ]) {
    const id = schoolKey('ten', 'event', teamId);
    await repo.teamEventEntries.set(id, { _id: id, ...scope, eventId: 'event', teamId, roster: fullRoster ? [roster[0], ...Array.from({ length: 4 }, (_, i) => ({ userId: `${teamId}${i}`, name: `队员${i}`, no: i + 10 })), ...(teamId === 'a' ? [roster[1]] : [])] : roster, status: 'locked' });
  }
  await repo.teamMatches.set('match', { _id: 'match', ...scope, eventId: 'event', teamA: 'a', teamB: 'b',
    status: 'scheduled', scoreA: null, scoreB: null, round: 1, revision: 1 });
  let seq = 0;
  const call = async (action, payload = {}, actorId = 'scorer') => {
    const ctx = await buildSchoolContext({ repo, actorId, scope, now: new Date('2026-10-20T08:00:00Z') });
    return (await service[action]({ matchId: 'match', ...payload }, ctx)).data;
  };
  const op = async (type, extra = {}) => {
    const match = await repo.teamMatches.getById('match');
    return call('updateTeamLiveScore', { type, operationId: `op_${++seq}`,
      expectRevision: match.liveScore.revision, ...extra });
  };
  return { repo, call, op };
}

test('实时开台恢复、逐笔加分、分节与撤销；独立个人账本不受影响', async () => {
  const { repo, call, op } = await fixture();
  const before = await repo.matches.list();
  assert.equal((await call('startTeamLiveScore')).live.scoreA, 0);
  await op('score', { side: 'A', points: 2 });
  await op('score', { side: 'B', points: 3 });
  const again = await call('startTeamLiveScore');
  assert.equal(again.live.scoreA, 2);
  assert.equal(again.live.scoreB, 3);
  assert.equal((await op('nextPeriod')).live.period, 2);
  assert.equal((await op('undo')).live.period, 1, '撤销换节');
  const undone = await op('undo');
  assert.equal(undone.live.scoreB, 0, '撤销最近的三分');
  assert.deepEqual(await repo.matches.list(), before);
  assert.equal((await repo.teamMatches.getById('match')).scoreA, null, '未结束不落正式分');
});

test('丢回执重试、撤销后重试旧请求不重复计分；同版本并发只接收一次', async () => {
  const { call, op } = await fixture();
  await call('startTeamLiveScore');
  const request = { type: 'score', side: 'A', points: 3, operationId: 'same', expectRevision: 0 };
  await call('updateTeamLiveScore', request);
  assert.equal((await call('updateTeamLiveScore', request)).live.scoreA, 3);
  await op('undo');
  assert.equal((await call('updateTeamLiveScore', request)).live.scoreA, 0);
  const results = await Promise.all(['one', 'two'].map(operationId => call('updateTeamLiveScore', {
    ...request, operationId, expectRevision: 2,
  })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).code, 'LIVE_CONFLICT');
});

test('仅授权记录员可写；跨范围读不到、越权与非法加分无副作用', async () => {
  const { repo, call, op } = await fixture();
  assert.equal((await call('startTeamLiveScore', {}, 'viewer')).ok, false);
  await call('startTeamLiveScore');
  assert.equal((await op('score', { side: 'A', points: 4 })).ok, false);
  assert.equal((await repo.teamMatches.getById('match')).liveScore.revision, 0);
  const ctx = await buildSchoolContext({ repo, actorId: 'viewer', scope, now: new Date() });
  const foreign = await repo.teamMatches.getById('match');
  await repo.teamMatches.set('foreign', { ...foreign, _id: 'foreign', schoolId: 'elsewhere' });
  assert.deepEqual((await service.getTeamLiveScores({ matchIds: ['foreign'] }, ctx)).data.scores, []);
  assert.equal((await call('getTeamLiveScores', { matchIds: Array.from({ length: 51 }, (_, n) => String(n)) })).ok, false);
});

test('记录员指派在赛事详情有入口，改派后旧记录员失去计分权', async () => {
  const { repo, call } = await fixture();
  const match = await repo.teamMatches.getById('match');
  await repo.teamMatches.set('match', { ...match, recorderId: 'viewer' });
  const assigned = (await call('getTeamEvent', { eventId: 'event' }, 'viewer')).matches[0];
  assert.equal(assigned.canRecord, true);
  assert.equal(assigned.canSeePending, true);
  assert.equal((await call('startTeamLiveScore', {}, 'viewer')).ok, true);
  await repo.teamMatches.set('match', { ...(await repo.teamMatches.getById('match')), recorderId: '' });
  const denied = await call('updateTeamLiveScore', { operationId: 'denied', expectRevision: 0, type: 'score', side: 'A', points: 1 }, 'viewer');
  assert.equal(denied.ok, false);
});

test('常规平分进入多次加时，完赛只变待审核，重试结束幂等，发布后才正式生效', async () => {
  const { repo, call, op } = await fixture();
  await call('startTeamLiveScore');
  await op('score', { side: 'A', points: 2 });
  assert.equal((await op('finish')).ok, false, '不能跳过常规节次');
  await op('nextPeriod');
  await op('score', { side: 'B', points: 2 });
  assert.equal((await op('finish')).ok, false, '平分不能提交');
  assert.equal((await op('nextPeriod')).live.periodLabel, '加时 1');
  assert.equal((await op('nextPeriod')).live.periodLabel, '加时 2');
  await op('score', { side: 'A', points: 1 });
  assert.equal((await op('nextPeriod')).ok, false, '非平分不继续加时');
  const match = await repo.teamMatches.getById('match');
  const finish = { type: 'finish', operationId: 'finish', expectRevision: match.liveScore.revision };
  const done = await call('updateTeamLiveScore', finish);
  assert.equal(done.live.submitted, true);
  assert.equal((await call('updateTeamLiveScore', finish)).ok, true);
  const saved = await repo.teamMatches.getById('match');
  assert.equal(saved.status, TEAM_MATCH_STATUS.REVIEWING);
  assert.equal(saved.scoreA, 3);
  assert.equal(saved.overtime, true);
  assert.equal(saved.periods.length, 4);
  assert.equal((await op('undo')).ok, false);
  const pub = await call('publishTeamMatch', { approve: true, expectRevision: saved.revision }, 'leader');
  assert.equal(pub.ok, true, pub.message);
  assert.equal((await repo.teamMatches.getById('match')).status, TEAM_MATCH_STATUS.PUBLISHED);
});

test('观众能看实时摘要，结束后按审核权限隐藏，计分不能绕过实时台覆盖', async () => {
  const { call, op } = await fixture();
  await call('startTeamLiveScore');
  await op('score', { side: 'A', points: 2 });
  const live = await call('getTeamLiveScores', { matchIds: ['match'] }, 'viewer');
  assert.equal(live.scores[0].scoreText, '2 : 0');
  assert.equal(live.scores[0].live.periodLabel, '第 1 节');
  assert.equal('history' in live.scores[0].live, false);
  assert.equal('playerRows' in live.scores[0].live, false, '未审核个人统计不随公开实时总分泄漏');
  assert.equal((await call('recordTeamMatch', { scoreA: 50, scoreB: 40 })).ok, false);
  await op('nextPeriod');
  await op('finish');
  const reviewing = await call('getTeamLiveScores', { matchIds: ['match'] }, 'viewer');
  assert.equal(reviewing.scores[0].live, null);
  assert.equal(reviewing.scores[0].scoreText, '待审核');
  assert.equal(reviewing.scores[0].scoreA, null);
});

test('选人加分同步球队；未知得分者只记球队；可只补个人且允许个人合计大于总分', async () => {
  const { repo, call, op } = await fixture();
  const started = await call('startTeamLiveScore');
  assert.equal(started.rosters[0].players[0].no, 7);
  await op('score', { side: 'A', points: 2, userId: 'scorer' });
  await op('score', { side: 'A', points: 3 });
  await op('score', { side: 'A', points: 2, userId: 'scorer', playerOnly: true });
  const extra = await op('score', { side: 'A', points: 3, userId: 'scorer', playerOnly: true });
  assert.equal(extra.ok, true);
  assert.equal(extra.live.scoreA, 5);
  assert.equal(extra.live.playerRows[0].points, 7);
  for (const field of ['fouls', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers']) {
    assert.equal((await op('stat', { side: 'A', userId: 'scorer', field, delta: 1 })).ok, true);
  }
  const saved = await repo.teamMatchStats.getById(schoolKey('tms', 'match', 'a'));
  assert.equal(saved.players[0].points, 7);
  assert.equal(saved.players[0].fouls, 1);
  assert.equal(saved.players[0].rebounds, 1);
  assert.equal(saved.status, 'draft');
  assert.equal((await repo.teamMatches.getById('match')).liveScore.scoreA, 5);
  assert.equal((await call('getTeamEventPlayerStats', { eventId: 'event' }, 'viewer')).players.length, 0);
  assert.equal((await call('saveTeamMatchStats', { players: [{ userId: 'scorer', points: 99 }] })).ok, false);
});

test('选人得分与统计撤销原子回退；重试不重复；减到零与未记录区分', async () => {
  const { repo, call, op } = await fixture();
  await call('startTeamLiveScore');
  const request = { type: 'score', side: 'A', userId: 'scorer', points: 3, operationId: 'selected', expectRevision: 0 };
  await call('updateTeamLiveScore', request);
  await call('updateTeamLiveScore', request);
  assert.equal((await call('startTeamLiveScore')).live.playerRows[0].points, 3);
  const undone = await op('undo');
  assert.equal(undone.live.scoreA, 0);
  assert.deepEqual(undone.live.playerRows, []);
  assert.equal((await call('updateTeamLiveScore', request)).live.scoreA, 0);
  let doc = await repo.teamMatchStats.getById(schoolKey('tms', 'match', 'a'));
  assert.deepEqual(doc.players, []);
  await op('stat', { side: 'A', userId: 'scorer', field: 'rebounds', delta: 1 });
  await op('stat', { side: 'A', userId: 'scorer', field: 'rebounds', delta: -1 });
  doc = await repo.teamMatchStats.getById(schoolKey('tms', 'match', 'a'));
  assert.equal(doc.players[0].rebounds, 0);
  assert.equal(doc.players[0].fouls, null);
  const before = JSON.stringify(doc);
  assert.equal((await op('stat', { side: 'A', userId: 'scorer', field: 'rebounds', delta: -1 })).ok, false);
  assert.equal(JSON.stringify(await repo.teamMatchStats.getById(doc._id)), before);
});

test('球员只认本方报名与出场快照；不能给另一队或名单外的人记分', async () => {
  const { repo, call, op } = await fixture();
  const match = await repo.teamMatches.getById('match');
  await repo.teamMatches.set('match', { ...match, lineups: { A: ['scorer'] } });
  await call('startTeamLiveScore');
  for (const userId of ['other', 'bench', 'not-on-roster']) {
    assert.equal((await op('score', { side: 'A', userId, points: 2 })).ok, false);
  }
  assert.equal((await op('stat', { side: 'A', field: 'fouls', delta: 1 })).ok, false);
  assert.equal((await op('stat', { side: 'A', userId: 'scorer', field: '__proto__', delta: 1 })).ok, false);
  assert.equal((await repo.teamMatches.getById('match')).liveScore.revision, 0);
  assert.equal((await repo.teamMatchStats.list()).length, 0);
});

test('已有整场统计不丢失或强行分节；球队与球员分不一致也能结束并随比赛发布', async () => {
  const { repo, call, op } = await fixture({ statPolicy: 'detailed' });
  const key = schoolKey('tms', 'match', 'a');
  await repo.teamMatchStats.set(key, { _id: key, ...scope, matchId: 'match', eventId: 'event', teamId: 'a',
    mode: 'basic', players: [{ userId: 'scorer', points: 11, fouls: 0, rebounds: null }],
    rows: [], status: 'draft', integrity: 'basic', revision: 5 });
  const opened = await call('startTeamLiveScore');
  assert.equal(opened.live.statMode, 'basic');
  assert.equal(opened.live.playerRows[0].points, 11);
  await op('score', { side: 'A', userId: 'scorer', points: 1, playerOnly: true });
  await op('score', { side: 'A', points: 2 });
  await op('nextPeriod');
  assert.equal((await op('finish')).ok, true);
  const match = await repo.teamMatches.getById('match');
  const pub = await call('publishTeamMatch', { approve: true, expectRevision: match.revision }, 'leader');
  assert.equal(pub.ok, true, pub.message);
  const board = await call('getTeamEventPlayerStats', { eventId: 'event' }, 'viewer');
  assert.equal(board.players[0].points, 12);
  assert.equal(board.players[0].rebounds, null);
  assert.equal(board.players[0].fouls, 0);
  assert.equal((await repo.teamMatches.getById('match')).scoreA, 2);
  assert.equal((await call('getTeamMatchStats')).statPolicy, 'basic');
});

test('按节选人记分支持加时；结束后统计面板能读写加时行，重复结束不会翻倍', async () => {
  const { repo, call, op } = await fixture({ statPolicy: 'detailed' });
  await call('startTeamLiveScore');
  await op('score', { side: 'A', userId: 'scorer', points: 2 });
  await op('nextPeriod');
  await op('score', { side: 'B', userId: 'other', points: 2 });
  await op('nextPeriod');
  await op('score', { side: 'A', userId: 'scorer', points: 1 });
  await op('stat', { side: 'A', userId: 'scorer', field: 'steals', delta: 1 });
  await op('finish');
  const panel = await call('getTeamMatchStats');
  assert.equal(panel.periods, 3);
  assert.equal(panel.statPolicy, 'detailed');
  assert.equal(panel.sides[0].players.find(row => row.userId === 'scorer').points, 3);
  assert.equal(panel.sides[0].rows.find(row => row.period === 3).steals, 1);
  const saved = await call('saveTeamMatchStats', { mode: 'detailed', expectRevision: panel.sides[0].revision,
    rows: panel.sides.flatMap(side => side.rows || []) });
  assert.equal(saved.ok, true, saved.message);
  assert.equal((await repo.teamMatchStats.getById(schoolKey('tms', 'match', 'a'))).rows.filter(row => row.period === 3).length, 1);
});

test('统计写入中断时整笔回滚，不能只记了球队分或半边统计', async () => {
  const { repo, call, op } = await fixture();
  await call('startTeamLiveScore');
  const transaction = repo.transaction.bind(repo);
  repo.transaction = callback => transaction(async root => {
    const forScope = root.forScope.bind(root);
    root.forScope = input => {
      const tx = forScope(input);
      const set = tx.teamMatchStats.set;
      tx.teamMatchStats.set = async (id, doc) => {
        if (doc.teamId === 'b') throw new Error('模拟第二侧写入中断');
        return set(id, doc);
      };
      return tx;
    };
    return callback(root);
  });
  await assert.rejects(op('score', { side: 'A', userId: 'scorer', points: 2 }), /写入中断/);
  const match = await repo.teamMatches.getById('match');
  assert.equal(match.liveScore.scoreA, 0);
  assert.equal(match.liveScore.revision, 0);
  assert.deepEqual(match.liveScore.playerRows, []);
  assert.deepEqual(await repo.teamMatchStats.list(), []);
});

test('已经记录实时统计的球员不能从出场名单移除，避免统计与名单脱节', async () => {
  const { repo, call, op } = await fixture();
  const id = schoolKey('ten', 'event', 'a');
  const entry = await repo.teamEventEntries.getById(id);
  await repo.teamEventEntries.set(id, { ...entry, roster: [...entry.roster, { userId: 'viewer', name: '替补', no: 9 }] });
  await call('startTeamLiveScore');
  await op('stat', { side: 'A', userId: 'scorer', field: 'fouls', delta: 1 });
  const match = await repo.teamMatches.getById('match');
  const removed = await call('saveTeamMatchLineup', { side: 'A', players: ['bench', 'viewer'], expectRevision: match.revision });
  assert.equal(removed.ok, false);
  assert.match(removed.message, /实时统计/);
  assert.equal((await repo.teamMatches.getById('match')).liveScore.playerRows[0].fouls, 1);
});


test('场上最多五人；替补必须换入，换下后不能录入，重进与撤销保持场上名单和原统计', async () => {
  const { call, op } = await fixture({ fullRoster: true });
  const opened = await call('startTeamLiveScore');
  assert.equal(opened.live.onCourt.A.length, 5);
  assert.equal(opened.rosters[0].players.length, 6);
  assert.equal(opened.live.onCourt.A.includes('bench'), false);
  assert.equal((await op('score', { side: 'A', userId: 'bench', points: 2 })).ok, false);
  await op('stat', { side: 'A', userId: 'scorer', field: 'fouls', delta: 1 });
  const changed = await op('substitute', { side: 'A', outId: 'scorer', inId: 'bench' });
  assert.equal(changed.ok, true, changed.message);
  assert.equal(changed.live.onCourt.A.length, 5);
  assert.equal(changed.live.onCourt.A.includes('scorer'), false);
  assert.equal(changed.live.playerRows[0].fouls, 1);
  assert.deepEqual((await call('startTeamLiveScore')).live.onCourt, changed.live.onCourt);
  assert.equal((await op('stat', { side: 'A', userId: 'scorer', field: 'rebounds', delta: 1 })).ok, false);
  await op('score', { side: 'A', userId: 'bench', points: 3 });
  await op('undo');
  const undone = await op('undo');
  assert.deepEqual(undone.live.onCourt, opened.live.onCourt);
  assert.equal(undone.live.scoreA, 0);
  assert.equal(undone.live.playerRows[0].fouls, 1);
});

test('换人拒绝跨队、非名单、场下换下或重复上场；幂等请求不重复换人', async () => {
  const { call, op } = await fixture({ fullRoster: true });
  await call('startTeamLiveScore');
  for (const extra of [{ outId: 'scorer', inId: 'other' }, { outId: 'scorer', inId: 'unknown' },
    { outId: 'bench', inId: 'bench' }, { outId: 'bench', inId: 'scorer' }, { outId: 'scorer', inId: 'a0' }]) {
    assert.equal((await op('substitute', { side: 'A', ...extra })).ok, false);
  }
  assert.equal((await call('startTeamLiveScore')).live.revision, 0);
  const request = { type: 'substitute', side: 'A', outId: 'scorer', inId: 'bench', expectRevision: 0, operationId: 'swap_once' };
  const first = await call('updateTeamLiveScore', request);
  assert.equal(first.ok, true);
  assert.deepEqual((await call('updateTeamLiveScore', request)).live, first.live);
  await op('undo');
  assert.equal((await call('updateTeamLiveScore', request)).live.onCourt.A.includes('scorer'), true);
});

test('旧实时比赛迁移前五人；开台后禁止通过修改出场名单绕过换人', async () => {
  const { repo, call } = await fixture({ fullRoster: true });
  const first = await call('startTeamLiveScore');
  const match = await repo.teamMatches.getById('match');
  delete match.liveScore.onCourt;
  await repo.teamMatches.set('match', match);
  assert.deepEqual((await call('startTeamLiveScore')).live.onCourt, first.live.onCourt);
  const current = await repo.teamMatches.getById('match');
  const result = await call('saveTeamMatchLineup', { side: 'A', players: ['scorer', 'bench'], expectRevision: current.revision });
  assert.equal(result.ok, false);
  assert.match(result.message, /换人/);
});

test('观众轮询只发 3 次批读，不逐场点读（2026-10-26 第五轮审查 A）', async () => {
  const { repo } = await fixture();
  // 同一届赛事的 7 场：改造前 = 7 次比赛点读 + 7 次同一赛事点读 + 14 次球队点读。
  for (let i = 0; i < 6; i += 1) {
    await repo.teamMatches.set(`m${i}`, { _id: `m${i}`, ...scope, eventId: 'event',
      teamA: 'a', teamB: 'b', status: 'scheduled', revision: 1 });
  }
  const calls = [];
  const rawForScope = repo.forScope.bind(repo);
  repo.forScope = (input) => {
    const surface = rawForScope(input);
    for (const key of ['teamMatches', 'teamEvents', 'teams']) {
      for (const name of ['getById', 'listByIds', 'list']) {
        const raw = surface[key][name];
        if (typeof raw !== 'function') continue;
        surface[key][name] = (...args) => { calls.push(`${key}.${name}`); return raw(...args); };
      }
    }
    return surface;
  };
  const ctx = await buildSchoolContext({ repo, actorId: 'viewer', scope, now: new Date('2026-10-20T08:00:00Z') });
  const ids = ['match', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const { data } = await service.getTeamLiveScores({ matchIds: ids }, ctx);

  assert.equal(data.scores.length, 7, '七场都要回');
  assert.equal(calls.filter(name => name.endsWith('.getById')).length, 0, '不许逐场点读');
  assert.equal(calls.filter(name => name === 'teamMatches.listByIds').length, 1);
  assert.equal(calls.filter(name => name === 'teamEvents.listByIds').length, 1, '同一赛事只读一次');
  assert.ok(calls.filter(name => name === 'teams.listByIds').length <= 1, '球队最多一次批读');
  assert.ok(calls.length <= 3, `一轮轮询最多 3 次读，实际 ${calls.join(', ')}`);
});
