const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCloudFixes, fixture } = require('../tools/audit-basketball-cloud.cjs');

test('云端真实路由与仓储：六项审计缺陷恢复正确行为，32场顺延不超限', async () => {
  const results = await verifyCloudFixes();
  assert.equal(results.length, 7);
});

test('重抽前的检查与提交之间开台，事务拒绝覆盖并保留已记比分', async () => {
  const f = await fixture();
  await f.call('drawTeamEvent', { eventId: 'event' });
  const matchId = (await f.matches())[0]._id;
  f.db.beforeTransaction = async () => {
    await f.call('startTeamLiveScore', { matchId });
    await f.call('updateTeamLiveScore', { matchId, type: 'score', side: 'A', points: 3,
      operationId: 'race_live', expectRevision: 0 });
  };
  const result = await f.call('drawTeamEvent', { eventId: 'event' });
  assert.equal(result.ok, false);
  assert.equal((await f.repo.teamMatches.getById(matchId)).liveScore.scoreA, 3);
});

test('锁名单前被另一请求退回报名，版本复核拒绝整笔锁定', async () => {
  const f = await fixture({ status: 'registration' });
  f.db.beforeTransaction = async () => {
    await f.call('reviewTeamEntry', { eventId: 'event', teamId: 'team0', approve: false });
  };
  const result = await f.call('lockTeamEntries', { eventId: 'event' });
  assert.equal(result.ok, false);
  const entries = await f.repo.forScope({ schoolId: 'muc', association: 'bk' }).teamEventEntries.list();
  assert.equal(entries.some(row => row.status === 'locked'), false);
});

test('旧版本曾部分锁定名单，重试按完整目标计数而非只算剩余approved', async () => {
  const f = await fixture({ status: 'registration' });
  const entries = await f.repo.forScope({ schoolId: 'muc', association: 'bk' }).teamEventEntries.list();
  await f.repo.teamEventEntries.set(entries[0]._id, { ...entries[0], status: 'locked' });
  const result = await f.call('lockTeamEntries', { eventId: 'event' });
  assert.equal(result.locked, 4);
  assert.equal((await f.repo.teamEvents.getById('event')).lockedCount, 4);
});

test('晋级生成决赛和季军赛时RPC中断，全部回滚且重试无缺场', async () => {
  const f = await fixture();
  await f.call('drawTeamEvent', { eventId: 'event' });
  for (const match of await f.matches()) {
    await f.call('recordTeamMatch', { matchId: match._id, scoreA: 50, scoreB: 40 });
    await f.call('publishTeamMatch', { matchId: match._id, approve: true });
  }
  f.db.failSet('teamMatches', 2);
  await assert.rejects(f.call('advanceTeamRound', { eventId: 'event' }), /RPC failure/);
  assert.equal((await f.matches()).length, 2);
  assert.equal((await f.call('advanceTeamRound', { eventId: 'event' })).matchCount, 2);
  assert.equal((await f.matches()).length, 4);
});

test('已经finished但报名名次未写齐的旧数据，重试按已结算快照补齐且幂等', async () => {
  const f = await fixture({ count: 2 });
  await f.call('drawTeamEvent', { eventId: 'event' });
  const matchId = (await f.matches())[0]._id;
  await f.call('recordTeamMatch', { matchId, scoreA: 50, scoreB: 40 });
  await f.call('publishTeamMatch', { matchId, approve: true });
  const settled = await f.call('settleTeamEvent', { eventId: 'event' });
  const entries = await f.repo.forScope({ schoolId: 'muc', association: 'bk' }).teamEventEntries.list();
  for (const entry of entries) {
    const { placement, ...missing } = entry;
    await f.repo.teamEventEntries.set(entry._id, missing);
  }
  assert.deepEqual((await f.call('settleTeamEvent', { eventId: 'event' })).placements, settled.placements);
  for (const entry of entries) assert.equal((await f.repo.teamEventEntries.getById(entry._id)).placement, entry.placement);
  assert.equal((await f.call('settleTeamEvent', { eventId: 'event' })).ok, true);
});

test('超大抽签在写前返回明确容量错误，没有创建部分赛程', async () => {
  const f = await fixture({ count: 21, format: 'round_robin' });
  const result = await f.call('drawTeamEvent', { eventId: 'event' });
  assert.equal(result.code, 'TEAM_BATCH_LIMIT');
  assert.equal(f.db.traces.length, 0, '容量不足时不启动事务');
  assert.equal((await f.matches()).length, 0);
  assert.equal((await f.repo.teamEvents.getById('event')).status, 'locked');
});

test('10 队篮球单循环在云端预算内一次抽出 45 场', async () => {
  const f = await fixture({ count: 10, format: 'round_robin' });
  const result = await f.call('drawTeamEvent', { eventId: 'event' });
  assert.equal(result.ok, true, result.message);
  assert.equal((await f.matches()).length, 45);
  assert.equal(f.db.traces[0].length, 98);
});

test('请求开始后队长被停用，事务重读身份拒绝录分及管理球队', async () => {
  const f = await fixture({ count: 2 });
  await f.call('drawTeamEvent', { eventId: 'event' });
  const matchId = (await f.matches())[0]._id;
  const disable = async () => {
    const user = await f.repo.users.getById('captain');
    await f.repo.users.set('captain', { ...user, platformStatus: 'disabled' });
  };
  f.db.beforeTransaction = disable;
  assert.equal((await f.call('recordTeamMatch', { matchId, scoreA: 50, scoreB: 40 }, 'captain')).ok, false);
  assert.equal((await f.repo.teamMatches.getById(matchId)).scoreA, null);
  const user = await f.repo.users.getById('captain');
  await f.repo.users.set('captain', { ...user, platformStatus: 'active' });
  f.db.beforeTransaction = disable;
  assert.equal((await f.call('archiveTeam', { teamId: 'team0' }, 'captain')).ok, false);
  assert.equal((await f.repo.teams.getById('team0')).status, 'active');
});
