const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFootballAssociation } = require('../src/shared/utils/football-association');
const { createFootballDemoContent } = require('../src/mock/football-demo.js');
const { createTeamDemoContent } = require('../src/mock/team-demo.js');
const { isKnownAssociation } = require('../src/shared/utils/associations');
const { normalizeFootballRules } = require('../src/shared/utils/football-rules');
const { MEMBER_SEED } = require('../src/mock/seed.js');

test('足球协会定义可供接入且不含篮球/Elo 配置，不提前修改当前注册表', () => {
  const registeredBefore = isKnownAssociation('fb');
  const meta = createFootballAssociation();
  assert.equal(meta.id, 'fb'); assert.equal(meta.teamSportFormat, 'football11');
  assert.deepEqual(meta.capabilities, ['space', 'teams', 'myTeams', 'events']);
  assert.equal(meta.basketballRules, undefined); assert.equal(meta.elo, undefined); assert.equal(meta.format, undefined);
  assert.equal(meta.footballRules.halfMinutes, 40);
  meta.footballRules.substitutions.limit = 99; meta.theme.primary = '#fff'; meta.capabilities.push('rank');
  assert.equal(createFootballAssociation().footballRules.substitutions.limit, 5);
  assert.equal(createFootballAssociation().theme.primary, '#0D6B45');
  assert.deepEqual(createFootballAssociation().capabilities, ['space', 'teams', 'myTeams', 'events']);
  assert.equal(isKnownAssociation('fb'), registeredBefore);
});

test('足球演示可重复生成，和篮球各集合主键不冲突、不串改', () => {
  const basketball = createTeamDemoContent();
  const before = JSON.stringify(basketball);
  const football = createFootballDemoContent();
  assert.deepEqual(football, createFootballDemoContent());
  for (const [collection, rows] of Object.entries(football)) {
    const ids = new Set(rows.map(row => row._id));
    assert.equal(ids.size, rows.length, collection);
    rows.forEach(row => { assert.equal(row.schoolId, 'muc'); assert.equal(row.association, 'fb'); });
    const combined = [...(basketball[collection] || []), ...rows];
    assert.equal(new Set(combined.map(row => row._id)).size, combined.length, collection);
  }
  assert.equal(JSON.stringify(basketball), before);
  // 扩容后共 4 场：原有 1 场 + 双回合 2 场 + 单败决赛 1 场
  assert.equal(football.teamMatches.length, 4); assert.deepEqual(football.teamMatchStats, []);
  const demoMatch = football.teamMatches.find(row => row.footballPublished);
  assert.ok(demoMatch, '至少有一场带战报的快照');
  assert.equal(demoMatch.footballPublished.result.scoreA, 2);
  assert.deepEqual(football.memberships, [], '普通会员沿用学校身份，不在演示数据中额外升权');
});

test('足球演示有两支跨学院十二人自由球队，名单人数与号码正确，审核状态可区分', () => {
  const content = createFootballDemoContent();
  const active = content.teams.filter(team => team.status === 'active');
  assert.equal(active.length, 2);
  assert.ok(content.teams.some(team => team.status === 'pending'));
  const event = content.teamEvents[0];
  assert.ok(normalizeFootballRules(event.rules));
  assert.equal(event.entryMin, 11); assert.equal(event.entryMax, 22); assert.equal(event.status, 'registration');
  const eventUsers = new Set();
  for (const team of active) {
    assert.equal(team.sport, 'football'); assert.equal(team.college, '');
    const members = content.teamMembers.filter(row => row.teamId === team._id && row.status === 'active');
    assert.equal(members.length, 12);
    assert.equal(members.filter(row => row.role === 'captain').length, 1);
    const colleges = new Set(members.map(row => MEMBER_SEED[Number(row.userId.slice(1)) - 1].college));
    assert.ok(colleges.size > 1, '队员来自不同学院');
    const entry = content.teamEventEntries.find(row => row.teamId === team._id);
    assert.equal(entry.roster.length, 12);
    assert.equal(new Set(entry.roster.map(row => row.no)).size, 12);
    for (const row of entry.roster) {
      assert.ok(members.some(member => member.userId === row.userId));
      assert.ok(row.name && row.name !== row.userId);
      assert.equal(eventUsers.has(row.userId), false, '同一届赛事不能代表两队');
      eventUsers.add(row.userId);
    }
  }
  assert.deepEqual(new Set(content.teamEventEntries.filter(row => row.eventId === event._id).map(row => row.status)), new Set(['approved', 'submitted']));
  content.teamEvents[0].rules.substitutions.limit = 0;
  assert.equal(createFootballDemoContent().teamEvents[0].rules.substitutions.limit, 5);
});
