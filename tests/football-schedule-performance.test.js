const test = require('node:test');
const assert = require('node:assert/strict');
const { conflicts } = require('../src/server/services/football-schedule-service');
const { fixture, SCOPE } = require('./helpers/football-fixture');

test('4000 场排期：赛事不再线性查找，时间只解析一次，保留跨日及包含区间冲突', () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ _id: `e${i}` }));
  events.find = () => { throw Error('内层不能 events.find'); };
  const matches = Array.from({ length: 4000 }, (_, i) => ({ _id: `m${i}`, eventId: `e${i % 100}`,
    teamA: `a${i}`, teamB: `b${i}`, location: `court${i}`, matchTime: '2026-10-28T23:30:00+08:00', durationMinutes: 110 }));
  const parse = Date.parse;
  let calls = 0;
  Date.parse = value => { calls++; return parse(value); };
  try { assert.equal(conflicts(matches, events), ''); }
  finally { Date.parse = parse; }
  assert.equal(calls, matches.length);
  assert.match(conflicts([matches[0], { ...matches[1], location: matches[0].location,
    matchTime: '2026-10-29T00:00:00+08:00' }], events), /场地/);
  assert.equal(conflicts([matches[0], { ...matches[1], location: matches[0].location,
    matchTime: '2026-10-29T01:20:00+08:00' }], events), '', '首尾相接无冲突');
});

for (const cloud of [false, true]) {
  test(`排期 ${cloud ? '云端' : '内存'}：候选查询按资源/时间/学校协会收窄，禁止全历史读取`, async () => {
    const f = await fixture({ cloud });
    const match = (await f.matches())[0];
    const base = { ...match, matchTime: '2026-10-28T16:00:00Z', durationMinutes: 110, location: 'target-court' };
    for (const [id, fields] of Object.entries({
      overlap: {}, old: { matchTime: '2020-01-01T00:00:00Z' }, unrelated: { teamA: 'x', teamB: 'y', location: 'other' },
      foreign: { schoolId: 'buaa' }, otherSport: { association: 'bk' },
    })) await f.repo.teamMatches.set(id, { ...base, ...fields, _id: id });
    const candidates = await f.repo.forScope(SCOPE).teamMatches.listScheduleCandidates([base]);
    assert.deepEqual(candidates.map(row => row._id).sort(), ['overlap']);
    const original = f.repo.forScope;
    f.repo.forScope = scope => {
      const result = original(scope);
      result.teamMatches.list = result.teamEvents.list = () => { throw Error('排期不得读取全历史'); };
      return result;
    };
    const result = await f.write('updateTeamMatchSchedule', match, { matchTime: '2026-11-15T16:00:00Z', location: 'new-court' });
    assert.equal(result.ok, true, result.message);
  });
}
