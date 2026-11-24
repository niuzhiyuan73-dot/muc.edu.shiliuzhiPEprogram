const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const schedule = require('../cloudfunctions/data/lib/server/services/meet-schedule-service');
const { buildMeetContext } = require('../cloudfunctions/data/lib/server/services/meet-context');
const { schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school');

async function fixture(judgeCount, sessionCount) {
  const judges = Array.from({ length: judgeCount }, (_, i) => `judge${i}`);
  const people = ['admin', ...judges];
  const scope = { schoolId: 'muc', meetId: 'budget-meet' };
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    _id: `session${String(i).padStart(2, '0')}`, ...scope, eventKey: `event${i % 2}`,
    status: 'scheduled', judgeIds: [], judgeCount: 0, startAt: '2026-10-24T08:00',
  }));
  const db = database({
    schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
    users: people.map(id => ({ _id: id, platformStatus: 'active', primarySchoolId: 'muc' })),
    schoolMembers: people.map(id => ({
      _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id, status: 'active',
    })),
    schoolRoles: [{ _id: schoolRoleKey('admin', 'muc'), schoolId: 'muc', userId: 'admin',
      status: 'active', role: 'admin' }],
    sportsMeets: [{ _id: scope.meetId, schoolId: 'muc', status: 'scheduled' }],
    sportsMeetEvents: ['event0', 'event1'].map(id => ({ _id: id, ...scope, status: 'active' })),
    sportsMeetSessions: sessions,
  });
  const repo = createRepo(db);
  const ctx = await buildMeetContext({ repo, actorId: 'admin', scope, now: new Date('2026-10-21T08:00:00Z') });
  const assign = () => schedule.assignMeetJudges({ judgeIds: judges, date: '2026-10-24' }, ctx);
  return { db, repo, ctx, judges, sessions, assign };
}

for (const count of [1, 5, 20, 21, 50]) {
  test(`云仓储：${count} 名裁判 × 14 场，每笔事务读写均在 90 次预算内且重试幂等`, async () => {
    const f = await fixture(count, 14);
    const assigned = await f.assign();
    assert.equal(assigned.ok, true, assigned.message);
    assert.equal(assigned.data.created, count * 14);
    assert.equal(assigned.data.sessionCount, 14);
    assert.ok(f.db.traces.length > 1, '应拆成多个事务');
    const repeated = await f.assign();
    assert.equal(repeated.ok, true, repeated.message);
    assert.equal(repeated.data.created, 0);
    assert.equal(repeated.data.existed, count * 14);
    for (const trace of f.db.traces) assert.ok(trace.length <= 90, `实际读写 ${trace.length}`);
    for (const session of f.sessions) {
      const stored = await f.repo.sportsMeetSessions.getById(session._id);
      assert.deepEqual(stored.judgeIds, f.judges);
      assert.equal(stored.judgeCount, count);
    }
    assert.equal((await f.repo.sportsMeetJudgeAssignments.list()).length, count * 14);
  });
}

test('跨裁判批次 RPC 中断：回滚当前事务，保留进度，重试补齐所有指派', async () => {
  const f = await fixture(50, 3);
  f.db.failSet('sportsMeetJudgeAssignments', 76); // 第一场 50 人完成，第二场已完成 20 人。
  const interrupted = await f.assign();
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.message, /RPC failure/);
  assert.deepEqual(interrupted.completedSessions, [f.sessions[0]._id]);
  assert.equal(interrupted.created, 70);
  assert.equal((await f.repo.sportsMeetJudgeAssignments.list()).length, 70);
  assert.equal((await f.repo.sportsMeetSessions.getById(f.sessions[1]._id)).judgeCount, 20);
  const retry = await f.assign();
  assert.equal(retry.ok, true, retry.message);
  assert.equal(retry.data.created, 80);
  assert.equal(retry.data.existed, 70);
  assert.equal((await f.repo.sportsMeetJudgeAssignments.list()).length, 150);
  for (const session of f.sessions) {
    assert.equal((await f.repo.sportsMeetSessions.getById(session._id)).judgeCount, 50);
  }
});

test('第二批裁判资格变化：写前复核拒绝，已经完成的指派可在恢复资格后补齐', async () => {
  const f = await fixture(50, 1);
  const runTransaction = f.db.runTransaction;
  let batches = 0;
  f.db.runTransaction = async fn => {
    if (++batches === 2) {
      await f.repo.users.set('judge20', { _id: 'judge20', platformStatus: 'disabled', primarySchoolId: 'muc' });
    }
    return runTransaction(fn);
  };
  const result = await f.assign();
  assert.equal(result.ok, false);
  assert.match(result.message, /资格已变化/);
  assert.deepEqual(result.completedSessions, []);
  assert.equal((await f.repo.sportsMeetJudgeAssignments.list()).length, 20);
  await f.repo.users.set('judge20', { _id: 'judge20', platformStatus: 'active', primarySchoolId: 'muc' });
  assert.equal((await f.assign()).ok, true);
  assert.equal((await f.repo.sportsMeetJudgeAssignments.list()).length, 50);
});
