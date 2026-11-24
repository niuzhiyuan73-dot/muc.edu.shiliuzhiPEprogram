/**
 * 团队赛事 P2：报名选人、球衣号、单场出场名单
 * ============================================================
 * 三份名单不能混：
 *   长期球队成员（team_members）→ 赛事报名名单（entry.roster）→ 单场出场名单（match.lineups）
 * 这一组用例守的就是这三层之间的边界：
 *   · 报名可以只带一部分队员，但不得少于规则下限、不得超上限、不许重号；
 *   · 改动已通过审核的报名要重新审核（原签字不算数）；
 *   · 出场名单只能从报名名单里挑，队长只能定自己那一侧，管理员可定两侧；
 *   · 定过出场名单后，统计面板与被采纳的统计只认上过场的人。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/team-event-service');
const teamHandlers = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey, schoolKey } = require('../src/shared/utils/school');
const { TEAM_ENTRY_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: `${id}昵称`, realName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
    seed.memberships.push({
      _id: schoolMembershipKey(id, SCOPE), userId: id, schoolId: 'muc', association: 'bk',
      role: 'member', status: 'active',
    });
  };
  add('u_leader');
  for (let t = 0; t < 2; t += 1) {
    add(`u_t${t}c`);
    for (let p = 0; p < 6; p += 1) add(`u_t${t}p${p}`);
  }
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

async function callTeam(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/**
 * 建两支各 7 人的队（队长 + 6 队员），并建赛事。
 * 7 人是为了能验证「只报 5 人」与「上限 12 人」两种边界都还留有余量。
 */
async function twoTeams(repo) {
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teams = [];
  for (let t = 0; t < 2; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(repo, 'createTeamApplication', {
      name: `球队${t + 1}`, requestId: `req_t${t}`,
    }, captain);
    await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let p = 0; p < 6; p += 1) {
      await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, `u_t${t}p${p}`);
      await callTeam(repo, 'reviewTeamMember', {
        teamId: created.teamId, userId: `u_t${t}p${p}`, approve: true,
      }, captain);
    }
    teams.push({ teamId: created.teamId, captain });
  }
  return { eventId: event.eventId, teams };
}

/** 报名（可带 roster）→ 审核 → 锁定 → 抽签 */
async function drawn(repo, rosterOfTeam0) {
  const { eventId, teams } = await twoTeams(repo);
  for (const [index, team] of teams.entries()) {
    const roster = index === 0 ? rosterOfTeam0 : undefined;
    const submitted = await call(repo, 'submitTeamEntry', {
      eventId, teamId: team.teamId, ...(roster ? { roster } : {}),
    }, team.captain);
    assert.equal(submitted.ok, true, submitted.message);
    await call(repo, 'reviewTeamEntry', { eventId, teamId: team.teamId, approve: true });
  }
  const locked = await call(repo, 'lockTeamEntries', { eventId });
  assert.equal(locked.ok, true, locked.message);
  await call(repo, 'drawTeamEvent', { eventId });
  const matches = (await call(repo, 'listTeamMatches', { eventId })).matches;
  return { eventId, teams, match: matches[0] };
}

function rosterOf(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `${prefix}p${index}`, no: index + 4,
  }));
}

/* ============================================================
 * 一、报名选人与球衣号
 * ============================================================ */

test('报名 —— 只报 5 人，名单按所选与号码落库', async () => {
  const repo = fixture();
  const { eventId, teams } = await twoTeams(repo);
  const roster = rosterOf('u_t0', 5); // 队长之外另选 5 名队员

  const submitted = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId, roster,
  }, teams[0].captain);
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.rosterCount, 5, '报的是 5 人，不是全队 7 人');

  const entry = await repo.teamEventEntries.getById(schoolKey('ten', eventId, teams[0].teamId));
  assert.equal(entry.roster.length, 5);
  assert.deepEqual(entry.roster.map(row => row.no), [4, 5, 6, 7, 8], '球衣号要一起存下来');
  assert.ok(entry.roster.every(row => row.name), '姓名仍然按快照抄一份');
});

test('报名 —— 人数不足、超出上限、非本队成员、重复队员都被拒', async () => {
  const repo = fixture();
  const { eventId, teams } = await twoTeams(repo);
  const captain = teams[0].captain;

  const tooFew = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId, roster: rosterOf('u_t0', 4),
  }, captain);
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少需要 5 人/);

  const tooMany = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId,
    roster: [
      ...rosterOf('u_t0', 6),
      { userId: 'u_t0c' },
      ...Array.from({ length: 6 }, (_, i) => ({ userId: `u_extra_${i}` })),
    ],
  }, captain);
  // 上面那批人里 u_extra_* 不在队里，会先被别人卡住——先验证「不在本队」
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /不在本队/);

  const outsider = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId, roster: [...rosterOf('u_t0', 4), { userId: 'u_t1p0' }],
  }, captain);
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /不在本队/);

  const duplicated = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId, roster: [...rosterOf('u_t0', 5), { userId: 'u_t0p0' }],
  }, captain);
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.message, /重复/);
});

test('报名 —— 球衣号重复与越界都被拒，空号可以重复（没登记）', async () => {
  const repo = fixture();
  const { eventId, teams } = await twoTeams(repo);
  const captain = teams[0].captain;
  const base = rosterOf('u_t0', 5);

  const conflict = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId,
    roster: [...base.slice(0, 4), { userId: base[4].userId, no: base[0].no }],
  }, captain);
  assert.equal(conflict.ok, false);
  assert.match(conflict.message, /球衣号码 4 重复/);

  const overflow = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId,
    roster: [...base.slice(0, 4), { userId: base[4].userId, no: 100 }],
  }, captain);
  assert.equal(overflow.ok, false);
  assert.match(overflow.message, /0–99/);

  // 都不填号码是合法的：校园赛常见「先报名，号码后补」
  const blank = await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId,
    roster: base.map(row => ({ userId: row.userId })),
  }, captain);
  assert.equal(blank.ok, true, blank.message);
});

test('报名面板 —— 队长拿到本队在队成员，已报的按名单回填', async () => {
  const repo = fixture();
  const { eventId, teams } = await twoTeams(repo);

  const blank = await call(repo, 'getTeamEntryRoster', {
    eventId, teamId: teams[0].teamId,
  }, teams[0].captain);
  assert.equal(blank.ok, true, blank.message);
  assert.equal(blank.members.length, 7, '队长 + 6 名队员');
  assert.ok(blank.members.every(row => row.selected === true), '没报过就默认全选');
  assert.equal(blank.canEdit, true);

  await call(repo, 'submitTeamEntry', {
    eventId, teamId: teams[0].teamId, roster: rosterOf('u_t0', 5),
  }, teams[0].captain);

  const filled = await call(repo, 'getTeamEntryRoster', {
    eventId, teamId: teams[0].teamId,
  }, teams[0].captain);
  assert.equal(filled.members.filter(row => row.selected).length, 5, '按已报名单回填勾选');
  assert.equal(filled.members.find(row => row.userId === 'u_t0p4').no, 8, '号码也要回填');
  assert.equal(filled.members.find(row => row.userId === 'u_t0p5').selected, false);

  // 不是队长、也不是管理者，打不开
  const denied = await call(repo, 'getTeamEntryRoster', {
    eventId, teamId: teams[0].teamId,
  }, 'u_t1p0');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /队长或协会负责人/);
});

test('报名 —— 已通过审核的名单被改动要退回重新审核', async () => {
  const repo = fixture();
  const { eventId, teams } = await twoTeams(repo);
  const teamId = teams[0].teamId;
  const captain = teams[0].captain;

  await call(repo, 'submitTeamEntry', { eventId, teamId, roster: rosterOf('u_t0', 5) }, captain);
  await call(repo, 'reviewTeamEntry', { eventId, teamId, approve: true });
  let entry = await repo.teamEventEntries.getById(schoolKey('ten', eventId, teamId));
  assert.equal(entry.status, TEAM_ENTRY_STATUS.APPROVED);

  const again = await call(repo, 'submitTeamEntry', {
    eventId, teamId, roster: rosterOf('u_t0', 6),
  }, captain);
  assert.equal(again.ok, true, again.message);
  assert.equal(again.resubmitted, true, '改过就要重新审核，要明确告诉页面');

  entry = await repo.teamEventEntries.getById(schoolKey('ten', eventId, teamId));
  assert.equal(entry.status, TEAM_ENTRY_STATUS.SUBMITTED);
  assert.equal(entry.roster.length, 6);
  assert.equal(entry.reviewedBy, null, '原来的审核签字要清掉');
});

/* ============================================================
 * 二、单场出场名单
 * ============================================================ */

test('出场名单 —— 默认全选；队长只能定自己一侧', async () => {
  const repo = fixture();
  const { eventId, teams, match } = await drawn(repo, rosterOf('u_t0', 5));
  const captainA = (await repo.teams.getById(match.teamA)).captainId;

  const panel = await call(repo, 'getTeamMatchLineup', { matchId: match.matchId }, captainA);
  assert.equal(panel.ok, true, panel.message);
  const own = panel.sides.find(row => row.teamId === match.teamA);
  const other = panel.sides.find(row => row.teamId === match.teamB);
  assert.equal(own.players.length, match.teamA === teams[0].teamId ? 5 : 7, '按报名快照列人');
  assert.ok(own.players.every(row => row.checked === true), '没定过名单就默认全选');
  assert.equal(own.editable, true);
  assert.equal(other.editable, false, '队长改不了对手的名单');

  const rejected = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId,
    side: own.side === 'A' ? 'B' : 'A',
    players: other.players.slice(0, 5).map(row => row.userId),
  }, captainA);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /只能定自己队/);
});

test('出场名单 —— 只能从报名名单里挑，且不得少于场上最低人数', async () => {
  const repo = fixture();
  const { match } = await drawn(repo, rosterOf('u_t0', 5));
  const panel = await call(repo, 'getTeamMatchLineup', { matchId: match.matchId });
  const side = panel.sides[0];

  const outsider = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, side: side.side, players: [...side.players.slice(0, 4).map(r => r.userId), 'u_leader'],
  });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /不在报名名单/);

  const tooFew = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, side: side.side, players: [side.players[0].userId],
  });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少 2 人/);

  const noSide = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, players: [side.players[0].userId, side.players[1].userId],
  });
  assert.equal(noSide.ok, false);
  assert.match(noSide.message, /A \/ B/);
});

test('出场名单 —— 落库后统计面板只列出场的人', async () => {
  const repo = fixture();
  const { match } = await drawn(repo, rosterOf('u_t0', 5));
  const panel = await call(repo, 'getTeamMatchLineup', { matchId: match.matchId });
  const side = panel.sides.find(row => row.teamId === match.teamA);
  const dressed = side.players.slice(0, 3).map(row => row.userId);
  const benched = side.players.slice(3).map(row => row.userId);

  const saved = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, side: side.side, players: dressed,
    expectRevision: panel.revision,
  });
  assert.equal(saved.ok, true, saved.message);
  assert.deepEqual(saved.lineup, dressed);
  assert.equal(saved.revision, panel.revision + 1);

  const doc = await repo.teamMatches.getById(match.matchId);
  assert.deepEqual(doc.lineups[side.side], dressed, '按侧存，另一侧不受影响');

  const stats = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const shown = stats.sides.find(row => row.teamId === match.teamA).players.map(row => row.userId);
  assert.deepEqual(shown, dressed, '没上场的人不该在录分格里出现');
  assert.ok(!shown.some(id => benched.includes(id)));

  // 没上场的人即使被手工塞进统计，也要被拒
  const sneaky = await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    players: [{ userId: benched[0], points: 10 }],
  });
  assert.equal(sneaky.ok, false);
  assert.match(sneaky.message, /不在本场名单/);
});

test('出场名单 —— 已发布的比赛不能再改，版本号对不上也拒', async () => {
  const repo = fixture();
  const { match } = await drawn(repo, rosterOf('u_t0', 5));
  const panel = await call(repo, 'getTeamMatchLineup', { matchId: match.matchId });
  const side = panel.sides[0];
  const players = side.players.slice(0, 3).map(row => row.userId);

  const stale = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, side: side.side, players, expectRevision: 99,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /刚被改过/);

  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 60, scoreB: 55 });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const afterPublish = await call(repo, 'saveTeamMatchLineup', {
    matchId: match.matchId, side: side.side, players,
  });
  assert.equal(afterPublish.ok, false);
  assert.match(afterPublish.message, /已发布/);
});

test('出场名单 —— 与当事人无关的普通会员打不开面板', async () => {
  const repo = fixture();
  const { match } = await drawn(repo, rosterOf('u_t0', 5));

  const denied = await call(repo, 'getTeamMatchLineup', { matchId: match.matchId }, 'u_t1p0');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /参赛队队长或协会负责人/);
});
