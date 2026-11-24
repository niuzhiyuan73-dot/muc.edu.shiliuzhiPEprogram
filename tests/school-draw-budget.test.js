const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { database } = require('../tools/audit-basketball-cloud.cjs');
const { buildSchoolContext } = require('../src/server/services/school-context');
const service = require('../cloudfunctions/data/lib/server/services/school-event-service');
const { schoolMemberKey, schoolEventSignupKey } = require('../src/shared/utils/school');
const { EVENT_FORMAT, MATCH_TYPE } = require('../src/shared/utils/constants');
const scope = { schoolId: 'muc', association: 'pkb' };
const now = new Date('2026-10-28T08:00:00Z');

async function setup(matchType = MATCH_TYPE.SINGLES, count = 88) {
  const seed = createSchoolDemoSeed();
  for (let i = 0; i < count; i++) {
    const id = `budget-${i}`;
    seed.users.push({ _id: id, nickName: id, gender: 'M', primarySchoolId: 'muc', platformStatus: 'active' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), schoolId: 'muc', userId: id, status: 'active', collegeId: 'c01' });
  }
  const db = database(seed);
  const repo = createRepo(db);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope, now });
  const call = async (action, payload) => (await service[action](payload, ctx)).data;
  return { repo, db, ctx, call, matchType };
}

for (const matchType of [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES]) for (const format of Object.values(EVENT_FORMAT)) {
  test(`抽签容量：${matchType}/${format} 满容量及重抽均不超过 100 次云事务操作`, async () => {
    const count = matchType === MATCH_TYPE.SINGLES ? 88 : 176;
    const f = await setup(matchType, count);
    const published = await f.call('publishSchoolEvent', { requestId: 'capacity', title: '事务容量回归',
      matchType, format, level: 3, seedMode: 'elo', seedCount: 4, groupCount: 2, advancePerGroup: 2,
      bronzeMode: 'tied', startTime: '2026-11-01T08:00:00Z', courtCount: 2, quota: count });
    assert.equal(published.ok, true, published.message);
    const eventId = published.event.eventId;
    for (let i = 0; i < count; i++) {
      const userId = `budget-${i}`;
      const id = schoolEventSignupKey(eventId, userId, scope);
      await f.repo.eventSignups.set(id, { _id: id, ...scope, userId, eventId, status: 'signed', revision: 1 });
    }
    for (const seedValue of [42, 71]) {
      const drawn = await f.call('drawSchoolEvent', { eventId, seedValue });
      assert.equal(drawn.ok, true, drawn.message);
    }
    assert.ok(f.db.traces.every(trace => trace.length <= 100));
  });
}

test('256 人赛事在发布前拒绝；旧大赛事在报名和抽签前拒绝，均不写入', async () => {
  const f = await setup();
  const form = { requestId: 'oversize', title: '容量超限', matchType: MATCH_TYPE.SINGLES, format: 'single_elim',
    level: 3, seedMode: 'elo', seedCount: 4, bronzeMode: 'tied', startTime: '2026-11-01T08:00:00Z', courtCount: 2, quota: 256 };
  assert.equal((await f.call('publishSchoolEvent', form)).ok, false);
  assert.equal((await f.repo.events.list()).length, 0);
  const created = await f.call('publishSchoolEvent', { ...form, quota: 0 });
  assert.equal(created.ok, true, created.message);
  const id = created.event.eventId;
  await f.repo.events.set(id, { ...await f.repo.events.getById(id), signupCount: 88 });
  assert.equal((await f.call('signUpSchoolEvent', { eventId: id })).ok, false);
  for (let i = 0; i < 256; i++) {
    const key = schoolEventSignupKey(id, `old-${i}`, scope);
    await f.repo.eventSignups.set(key, { _id: key, ...scope, eventId: id, userId: `old-${i}`, status: 'signed' });
  }
  const before = f.db.traces.length;
  assert.equal((await f.call('drawSchoolEvent', { eventId: id })).ok, false);
  assert.equal(f.db.traces.length, before, '超限抽签在事务外拒绝');
  assert.equal((await f.repo.matches.list()).length, 0);
});
