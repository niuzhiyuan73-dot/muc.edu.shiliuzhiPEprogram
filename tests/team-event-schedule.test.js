/**
 * 团队赛事 P1：单场赛程（时间 / 场地 / 裁判 / 记录员）与整轮顺延
 * ============================================================
 * 抽签只决定「谁跟谁打」，办赛还要回答「几点打、在哪打、谁吹、谁记」。
 * 这一组用例守四件事：
 *   · 指派的人必须真的能干活（本协会在册、账号可用），而不是只存在于通讯录；
 *   · 裁判不能执法自己队的比赛；记录员可以兼队长（校园赛就是这么干的）；
 *   · 改期不动比分、不动签表，且并发改同一场只有一次生效；
 *   · 整轮顺延只挪「还没打、有时间」的场次，已发布的跳过并如数上报。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/team-event-service');
const teamHandlers = require('../src/server/services/team-service');
const {
  schoolMemberKey, schoolMembershipKey,
} = require('../src/shared/utils/school');
const { TEAM_EVENT_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

/**
 * 建 N 支队、每队 roster 人。
 * 所有人都在 bk 有会籍——赛程指派要把「会员」与「只是有学籍」区分开，
 * 夹具里两者都齐，才能验证「不是本协会会员不能指派」。
 */
function fixtureFor(teamCount, roster) {
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
  for (let t = 0; t < teamCount; t += 1) {
    add(`u_t${t}c`);
    for (let p = 0; p < roster - 1; p += 1) add(`u_t${t}p${p}`);
  }
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  // 有学籍但没有本协会会籍的「隔壁协会同学」：指派时必须被挡
  seed.users.push({
    _id: 'u_outsider', openId: 'mock_openid_u_outsider', nickName: '场外人', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
  });
  seed.schoolMembers.push({
    _id: schoolMemberKey('u_outsider', 'muc'), userId: 'u_outsider', schoolId: 'muc',
    collegeId: 'c01', studentId: 'u_outsider', status: 'active', simulated: true,
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

/** 建队 → 报名 → 审核 → 锁定 → 抽签，返回赛事、球队与首场 */
async function drawnEvent(repo, { teamCount = 2, roster = 5 } = {}) {
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamIds = [];
  for (let t = 0; t < teamCount; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(repo, 'createTeamApplication', {
      name: `球队${t + 1}`, requestId: `req_t${t}`,
    }, captain);
    await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let p = 0; p < roster - 1; p += 1) {
      const memberId = `u_t${t}p${p}`;
      await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
      await callTeam(repo, 'reviewTeamMember', {
        teamId: created.teamId, userId: memberId, approve: true,
      }, captain);
    }
    await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: created.teamId }, captain);
    await call(repo, 'reviewTeamEntry', {
      eventId: event.eventId, teamId: created.teamId, approve: true,
    });
    teamIds.push(created.teamId);
  }
  const locked = await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  assert.equal(locked.ok, true, locked.message);
  await call(repo, 'drawTeamEvent', { eventId: event.eventId });
  const matches = (await call(repo, 'listTeamMatches', { eventId: event.eventId })).matches;
  return { eventId: event.eventId, teamIds, matches, match: matches[0] };
}

/* ============================================================
 * 一、候选名单
 * ============================================================ */

test('赛程面板 —— 管理者拿到本协会会员，裁判候选排除两队队长', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);

  const panel = await call(repo, 'getTeamMatchSchedule', { matchId: match.matchId });
  assert.equal(panel.ok, true, panel.message);
  assert.equal(panel.canEdit, true);
  assert.equal(panel.match.matchId, match.matchId);

  const ids = panel.recorders.map(row => row.userId);
  assert.ok(ids.includes('u_t0c'), '队长也能当记录员');
  assert.ok(!ids.includes('u_outsider'), '没有本协会会籍的人不在候选里');

  const captainIds = [
    (await repo.teams.getById(match.teamA)).captainId,
    (await repo.teams.getById(match.teamB)).captainId,
  ];
  captainIds.forEach((id) => {
    const row = panel.referees.find(item => item.userId === id);
    assert.ok(row, '队长仍在裁判名单里，只是不给选');
    assert.equal(row.disabled, true);
    assert.match(row.disabledReason, /队长/);
  });
});

test('赛程面板 —— 非管理者打不开，也改不了', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);

  const panel = await call(repo, 'getTeamMatchSchedule', { matchId: match.matchId }, 'u_t0c');
  assert.equal(panel.ok, false);
  assert.match(panel.message, /协会负责人/);

  const updated = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, location: '东体育馆',
  }, 'u_t0c');
  assert.equal(updated.ok, false);
  assert.match(updated.message, /协会负责人/);
});

/* ============================================================
 * 二、改期与场地
 * ============================================================ */

test('改期 —— 时间与场地落库，版本号 +1，比分局签表不动', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await drawnEvent(repo);

  const saved = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId,
    matchTime: '2026-10-21 14:30',
    location: '体育馆主馆',
    expectRevision: match.revision,
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.revision, match.revision + 1);
  assert.equal(saved.match.matchTimeText, '10-21 14:30', '按北京时间展示，不随时区漂移');
  assert.equal(saved.match.location, '体育馆主馆');

  const doc = await repo.teamMatches.getById(match.matchId);
  assert.equal(doc.matchTime, '2026-10-21T06:30:00.000Z');
  assert.equal(doc.status, match.status, '改期不改比赛状态');
  assert.equal(doc.scoreA, match.scoreA, '改期不动比分');

  const after = (await call(repo, 'getTeamEvent', { eventId })).matches
    .find(item => item.matchId === match.matchId);
  assert.equal(after.location, '体育馆主馆', '详情页随即看得到新场地');
});

test('改期 —— 时间格式不对、场地过长、空内容都被拒', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);

  const badTime = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, matchTime: '下周三下午',
  });
  assert.equal(badTime.ok, false);
  assert.match(badTime.message, /时间格式/);

  const longLocation = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, location: '东'.repeat(41),
  });
  assert.equal(longLocation.ok, false);
  assert.match(longLocation.message, /不超过 40 个字/);

  const empty = await call(repo, 'updateTeamMatchSchedule', { matchId: match.matchId });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /没有要修改/);

  // 清空时间是合法操作（还没排期的场次就该是空的）
  await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, matchTime: '2026-10-21 14:30',
  });
  const cleared = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, matchTime: '',
  });
  assert.equal(cleared.ok, true, cleared.message);
  assert.equal(cleared.match.matchTime, null);
  assert.equal(cleared.match.matchTimeText, '');
});

/* ============================================================
 * 三、裁判与记录员
 * ============================================================ */

test('指派 —— 非本协会会员不行，参赛队队长不能当裁判', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);
  const captainA = (await repo.teams.getById(match.teamA)).captainId;

  const outsider = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, recorderId: 'u_outsider',
  });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /不是本协会会员/);

  const selfJudge = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, refereeId: captainA,
  });
  assert.equal(selfJudge.ok, false);
  assert.match(selfJudge.message, /队长不能执法/);

  // 同一人当记录员是允许的：校园赛记录员常常就是队长本人
  const asRecorder = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, recorderId: captainA,
  });
  assert.equal(asRecorder.ok, true, asRecorder.message);
  assert.ok(asRecorder.match.recorderName, '记录员姓名要落到比赛上，页面不必再查一次');
});

test('指派 —— 记录员被指派后真的能录这一场', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);

  // 取一个既不管理、也不是队长的普通会员
  const recorderId = 'u_t0p0';
  const assigned = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, recorderId,
  });
  assert.equal(assigned.ok, true, assigned.message);

  const recorded = await call(repo, 'recordTeamMatch', {
    matchId: match.matchId, scoreA: 66, scoreB: 60,
  }, recorderId);
  assert.equal(recorded.ok, true, recorded.message);

  // 没被指派的普通会员仍然录不了
  const denied = await call(repo, 'recordTeamMatch', {
    matchId: match.matchId, scoreA: 60, scoreB: 66,
  }, 'u_t1p0');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /队长/);
});

/* ============================================================
 * 四、并发与状态
 * ============================================================ */

test('改期 —— 同一版本号并发提交，只有一次生效', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await drawnEvent(repo);

  const [first, second] = await Promise.all([
    call(repo, 'updateTeamMatchSchedule', {
      matchId: match.matchId, location: '主馆', expectRevision: match.revision,
    }),
    call(repo, 'updateTeamMatchSchedule', {
      matchId: match.matchId, location: '副馆', expectRevision: match.revision,
    }),
  ]);
  const winners = [first, second].filter(row => row.ok === true);
  const losers = [first, second].filter(row => row.ok !== true);
  assert.equal(winners.length, 1, '只能有一次成功');
  assert.match(losers[0].message, /刚被改过/);

  const doc = await repo.teamMatches.getById(match.matchId);
  assert.equal(doc.location, winners[0].match.location, '落库的是成功那一次');
  assert.equal(doc.revision, match.revision + 1, '只进了一版');
});

test('改期 —— 赛事结束后不再允许', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await drawnEvent(repo);
  const event = await repo.teamEvents.getById(eventId);
  await repo.teamEvents.set(eventId, { ...event, status: TEAM_EVENT_STATUS.FINISHED });

  const saved = await call(repo, 'updateTeamMatchSchedule', {
    matchId: match.matchId, location: '主馆',
  });
  assert.equal(saved.ok, false);
  assert.match(saved.message, /已结束/);
});

/* ============================================================
 * 五、整轮顺延
 * ============================================================ */

test('整轮顺延 —— 只挪未发布且有时间的场次，已发布的跳过并上报', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId, matches } = await drawnEvent(repo, { teamCount: 4 });
  assert.equal(matches.length, 2, '四队首轮两场');

  for (const row of matches) {
    await call(repo, 'updateTeamMatchSchedule', {
      matchId: row.matchId, matchTime: '2026-10-21 14:00',
    });
  }
  // 第一场打完并发布：它不该再被顺延
  await call(repo, 'recordTeamMatch', { matchId: matches[0].matchId, scoreA: 80, scoreB: 70 });
  await call(repo, 'publishTeamMatch', { matchId: matches[0].matchId, approve: true });

  const shifted = await call(repo, 'updateTeamRoundSchedule', {
    eventId, round: 1, shiftMinutes: 60,
  });
  assert.equal(shifted.ok, true, shifted.message);
  assert.equal(shifted.shifted, 1, '只挪了没打的那一场');
  assert.equal(shifted.skipped, 1, '已发布的如实上报，不静默跳过');

  const after = (await call(repo, 'listTeamMatches', { eventId })).matches;
  const played = after.find(row => row.matchId === matches[0].matchId);
  const pending = after.find(row => row.matchId === matches[1].matchId);
  assert.equal(played.matchTimeText, '10-21 14:00', '已发布的场次时间不动');
  assert.equal(pending.matchTimeText, '10-21 15:00');
});

test('整轮顺延 —— 分钟数越界、没有可挪的场次都拒绝', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await drawnEvent(repo, { teamCount: 4 });

  const tooMuch = await call(repo, 'updateTeamRoundSchedule', {
    eventId, round: 1, shiftMinutes: 600,
  });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.message, /最多顺延/);

  const zero = await call(repo, 'updateTeamRoundSchedule', { eventId, round: 1, shiftMinutes: 0 });
  assert.equal(zero.ok, false);

  // 谁都没排时间 → 没有可顺延的
  const nothing = await call(repo, 'updateTeamRoundSchedule', {
    eventId, round: 1, shiftMinutes: 30,
  });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /没有可顺延/);

  const noRound = await call(repo, 'updateTeamRoundSchedule', { eventId, round: 9, shiftMinutes: 30 });
  assert.equal(noRound.ok, false);
  assert.match(noRound.message, /还没有比赛/);
});
