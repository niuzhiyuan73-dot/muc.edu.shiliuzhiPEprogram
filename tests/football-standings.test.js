const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeFootballTable: table } = require('../src/shared/utils/football-standings');
const { defaultRulesFor, RANKING_POLICY } = require('../src/shared/utils/football-rules');
let seq = 0;
const teams = ids => ids.map(teamId => ({ teamId, teamName: `队${teamId}` }));
const played = (teamA, teamB, scoreA, scoreB, more = {}) => ({
  _id: `m${++seq}`, teamA, teamB, scoreA, scoreB,
  winner: scoreA === scoreB ? null : scoreA > scoreB ? 'A' : 'B', status: 'published', revision: 1, ...more,
});

test('足球 0:0 各得一分，正式胜平负不采用点球晋级 winner', () => {
  const rows = table({ entries: teams(['a', 'b']), matches: [played('a', 'b', 0, 0, {
    winner: 'A', shootoutScore: { A: 4, B: 3 },
  })] });
  rows.forEach(row => {
    assert.equal(row.draws, 1); assert.equal(row.wins, 0); assert.equal(row.losses, 0);
    assert.equal(row.points, 1); assert.equal(row.goalsFor, 0); assert.equal(row.goalDifference, 0);
    assert.equal(row.rank, null); assert.equal(row.rankingStatus, 'pending');
  });
});

test('足球按积分排序：一胜四平七分排在两胜三负六分前', () => {
  const entries = teams(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const matches = [
    played('a', 'c', 1, 0), played('a', 'd', 1, 0), played('a', 'e', 0, 1), played('a', 'f', 0, 1), played('a', 'g', 0, 1),
    played('b', 'c', 1, 0), played('b', 'd', 0, 0), played('b', 'e', 0, 0), played('b', 'f', 0, 0), played('b', 'g', 0, 0),
  ];
  const rows = table({ entries, matches });
  assert.ok(rows.findIndex(r => r.teamId === 'b') < rows.findIndex(r => r.teamId === 'a'));
  assert.equal(rows.find(r => r.teamId === 'b').points, 7);
  assert.equal(rows.find(r => r.teamId === 'a').points, 6);
});

test('足球净胜球优先与相互战绩优先可产生不同且可复核的名次', () => {
  const entries = teams(['a', 'b', 'c', 'd']);
  const matches = [played('a', 'b', 1, 0), played('a', 'c', 0, 1), played('b', 'd', 5, 0)];
  const goalFirst = table({ entries, matches });
  const headFirst = table({ entries, matches, rules: { ...defaultRulesFor(), rankingPolicy: RANKING_POLICY.HEAD_TO_HEAD } });
  assert.ok(goalFirst.findIndex(r => r.teamId === 'b') < goalFirst.findIndex(r => r.teamId === 'a'));
  assert.ok(headFirst.findIndex(r => r.teamId === 'a') < headFirst.findIndex(r => r.teamId === 'b'));
});

test('足球三队循环相胜的小积分表与输入顺序无关，未决名次不按 ID 发奖', () => {
  const entries = teams(['a', 'b', 'c']);
  const matches = [played('a', 'b', 1, 0), played('b', 'c', 1, 0), played('c', 'a', 1, 0)];
  const first = table({ entries, matches });
  assert.deepEqual(table({ entries: entries.slice().reverse(), matches: matches.slice().reverse() }), first);
  assert.deepEqual(first.map(r => r.rank), [null, null, null]);
  assert.deepEqual(first.map(r => r.position), [1, 2, 3]);
  first.forEach(r => { assert.equal(r.rankFrom, 1); assert.equal(r.rankTo, 3); assert.equal(r.rankingLabel, '同分待确认'); });
});

test('足球抽签确认必须覆盖整个未决组并带审计字段，改判后旧决定失效', () => {
  const entries = teams(['a', 'b']); const matches = [played('a', 'b', 1, 1)];
  const tieKey = table({ entries, matches })[0].tieKey;
  const decision = { tieKey, teamIds: ['b', 'a'], reason: '现场抽签', decidedBy: 'leader', decidedAt: '2026-10-20T10:00:00Z' };
  const rows = table({ entries, matches, rankingDecisions: [decision] });
  assert.deepEqual(rows.map(r => r.teamId), ['b', 'a']);
  assert.deepEqual(rows.map(r => r.rank), [1, 2]);
  assert.equal(rows[0].rankingLabel, '抽签确认');
  for (const bad of [{ ...decision, reason: '' }, { ...decision, decidedBy: '' },
    { ...decision, decidedAt: 'bad' }, { ...decision, teamIds: ['b', 'b'] }, { ...decision, teamIds: ['a'] }]) {
    assert.equal(table({ entries, matches, rankingDecisions: [bad] })[0].rank, null);
  }
  assert.equal(table({ entries, matches: [{ ...matches[0], scoreA: 2, scoreB: 2, revision: 2 }], rankingDecisions: [decision] })[0].rank, null);
  assert.equal(table({ entries, matches: [{ ...matches[0], revision: 2 }], rankingDecisions: [decision] })[0].rank, null);
});

test('足球仅计算已发布正式进球，包括判定比分但不加点球大战', () => {
  const rows = table({ entries: teams(['a', 'b']), matches: [
    played('a', 'b', 3, 0, { forfeit: 'B' }),
    played('a', 'b', 1, 1, { shootoutScore: { A: 4, B: 3 } }),
    played('a', 'b', 90, 0, { status: 'reviewing' }),
    played('a', 'b', 90, 0, { status: 'canceled' }),
    played('a', 'outside', 90, 0),
  ] });
  const a = rows.find(r => r.teamId === 'a');
  assert.equal(a.played, 2); assert.equal(a.points, 4);
  assert.equal(a.goalsFor, 4); assert.equal(a.goalsAgainst, 1); assert.equal(a.goalDifference, 3);
});

test('足球拒绝缺失或非法的已发布比分、重复比赛和重复队伍', () => {
  const entries = teams(['a', 'b']);
  for (const bad of [null, undefined, '', '0', true, -1, 0.5, Infinity]) {
    assert.throws(() => table({ entries, matches: [played('a', 'b', bad, 0)] }), /比分/);
  }
  const match = played('a', 'b', 1, 0);
  assert.throws(() => table({ entries, matches: [match, match] }), /重复/);
  assert.throws(() => table({ entries, matches: [{ ...match, _id: '' }] }), /编号/);
  assert.throws(() => table({ entries, matches: [played('a', 'b', Number.MAX_SAFE_INTEGER, 0), played('a', 'b', 1, 0)] }), /安全整数/);
  assert.throws(() => table({ entries: teams(['a', 'a']) }), /重复/);
  assert.throws(() => table({ entries, rules: { sportFormat: 'basketball5' } }), /规则/);
  assert.deepEqual(table(), []);
});

test('足球积分计算不修改队伍、赛果、规则或人工决定', () => {
  const input = { entries: teams(['b', 'a']), matches: [played('a', 'b', 1, 1)], rules: defaultRulesFor() };
  const before = JSON.stringify(input);
  table(input);
  assert.equal(JSON.stringify(input), before);
  const source = require('../src/shared/utils/football-standings');
  const cloud = require('../cloudfunctions/data/lib/shared/utils/football-standings');
  assert.deepEqual(cloud.computeFootballTable(input), source.computeFootballTable(input));
});
