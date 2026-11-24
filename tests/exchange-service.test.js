const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/exchange-service');
const { schoolMemberKey } = require('../src/shared/utils/school');
const { EVENT_FORMAT_LABEL } = require('../src/shared/utils/constants');
const NOW = new Date('2026-10-13T10:00:00Z');
const form = { title: '民大北航交流赛', location: '模拟球场', startTime: '2026-11-01T10:00:00Z',
  participantSchoolIds: ['muc', 'buaa'], quota: 4, schoolQuotas: { muc: 2, buaa: 2 }, requestId: 'test1' };
function fixture() { return createSchoolMemoryRepo(createSchoolDemoSeed()); }
async function call(repo, action, payload = {}, actor = 'demo_muc_admin', schoolId = 'muc', now = NOW) {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association: 'pkb' }, now });
  return (await handlers[action](payload, ctx)).data;
}
async function create(repo, fields = {}) {
  const result = await call(repo, 'createExchangeEvent', { ...form, ...fields });
  assert.equal(result.ok, true, result.message);
  return result.event._id;
}
async function accept(repo, eventId) {
  return call(repo, 'respondExchangeInvitation', { eventId, decision: 'accepted' }, 'demo_buaa_admin', 'buaa');
}
const signup = (repo, eventId, actor = 'demo_muc_member', schoolId = 'muc') => call(repo, 'signUpExchangeEvent', { eventId }, actor, schoolId);
async function readyFour(repo, fields = {}) {
  const id = await create(repo, fields);
  await accept(repo, id);
  await signup(repo, id, 'demo_muc_member', 'muc');
  await signup(repo, id, 'demo_muc_admin', 'muc');
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  await signup(repo, id, 'demo_buaa_admin', 'buaa');
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, true);
  return id;
}
async function schoolOf(repo, eventId, userId) {
  const rows = await repo.exchangeSignups.listByEvent(eventId);
  return (rows.find(row => row.userId === userId) || {}).representedSchoolId;
}

test('host creates one canonical unrated singles event and guest school accepts', async () => {
  const repo = fixture();
  const id = await create(repo, { ratingPolicy: 'rated', matchType: 'doubles', schoolId: 'buaa' });
  assert.equal((await create(repo)), id);
  assert.equal((await repo.exchangeEvents.list()).length, 1);
  assert.equal((await call(repo, 'createExchangeEvent', { ...form, title: 'changed' })).ok, false);
  const record = await repo.exchangeEvents.getById(id);
  assert.equal(record.schoolId, 'muc');
  assert.equal(record.ratingPolicy, 'unrated');
  assert.equal(record.matchType, 'singles');
  assert.equal((await accept(repo, id)).ok, true);
  assert.equal((await call(repo, 'getExchangeEvents', {}, 'demo_buaa_member', 'buaa')).events[0]._id, id);
});

test('裁判候选：普通会员不能查；待接受学校不可查；详情只批读已指派裁判', async () => {
  const repo = fixture();
  const id = await create(repo);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_member', scope: { schoolId: 'muc', association: 'pkb' }, now: NOW });
  const originalScope = repo.forScope;
  repo.forScope = scope => {
    const result = originalScope(scope);
    result.schoolMembers.list = result.schoolMembers.listByStatus = () => { throw Error('详情不应查询名册'); };
    return result;
  };
  const before = (await handlers.getExchangeEvent({ eventId: id }, ctx)).data;
  assert.equal(before.ok, true);
  assert.deepEqual(before.referees, []);
  assert.equal((await call(repo, 'listExchangeRefereeCandidates', { eventId: id }, 'demo_muc_member')).ok, false);
  assert.equal((await call(repo, 'listExchangeRefereeCandidates', { eventId: id, schoolId: 'buaa' })).ok, false);
  await accept(repo, id);
  const pages = [];
  let cursor = '';
  do {
    const page = await call(repo, 'listExchangeRefereeCandidates', { eventId: id, schoolId: 'buaa', limit: 1, cursor });
    assert.equal(page.ok, true, page.message);
    assert.equal(page.members.length, 1);
    assert.deepEqual(Object.keys(page.members[0]).sort(), ['nickName', 'schoolId', 'schoolName', 'userId']);
    pages.push(...page.members);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(pages.map(row => row.userId)).size, pages.length);
  const found = await call(repo, 'listExchangeRefereeCandidates', { eventId: id, schoolId: 'buaa', keyword: pages[0].nickName });
  assert.ok(found.members.some(row => row.userId === pages[0].userId));
});

test('only school managers may create or accept invitations, members cannot see pending guest events', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'createExchangeEvent', form, 'demo_muc_member')).ok, false);
  const id = await create(repo);
  assert.equal((await call(repo, 'getExchangeEvent', { eventId: id }, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'accepted' }, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'accepted' })).ok, false);
  assert.equal((await call(repo, 'getExchangeEvent', { eventId: id }, 'demo_muc_admin', 'buaa')).ok, false);
});

test('school quota is serialized across simultaneous registrations and cancel releases once', async () => {
  const repo = fixture();
  const id = await create(repo, { quota: 2, schoolQuotas: { muc: 1, buaa: 1 } });
  await accept(repo, id);
  const results = await Promise.all([signup(repo, id), signup(repo, id, 'demo_muc_admin')]);
  assert.equal(results.filter(row => row.ok).length, 1);
  const rows = await repo.exchangeSignups.listByEvent(id);
  const winner = rows[0].userId;
  assert.equal((await signup(repo, id, winner)).ok, true);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 1);
  const canceled = await Promise.all([1, 2].map(() => call(repo, 'cancelExchangeSignup', { eventId: id }, winner)));
  assert.equal(canceled.filter(row => row.ok).length, 1);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 0);
  assert.equal((await signup(repo, id, winner)).ok, true);
});

test('total quota is enforced independently of each school quota', async () => {
  const repo = fixture();
  const id = await create(repo, { quota: 2 });
  await accept(repo, id);
  const results = await Promise.all([signup(repo, id), signup(repo, id, 'demo_muc_admin'), signup(repo, id, 'demo_buaa_member', 'buaa')]);
  assert.equal(results.filter(row => row.ok).length, 2);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 2);
});

test('two-school roster locks once and freezes signup and cancellation', async () => {
  const repo = fixture();
  const id = await create(repo);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
  await accept(repo, id);
  await signup(repo, id);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id }, 'demo_buaa_admin', 'buaa')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, true);
  assert.equal((await signup(repo, id, 'demo_muc_admin')).ok, false);
  assert.equal((await call(repo, 'cancelExchangeSignup', { eventId: id }, 'demo_muc_member')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
});

test('roster and session projections do not expose student IDs or identity references', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  // 恰恰是「字段白名单」式的断言：多出任何字段都要在这里显式过一遍，
  // 免得某天顺手把 schoolMemberId / studentId 塞进名单投影。
  assert.deepEqual(Object.keys(detail.participants[0]).sort(),
    ['canCheckIn', 'canRemove', 'checkInTime', 'checkedIn', 'nickName',
      'representedSchoolId', 'schoolName', 'userId']);
  assert.equal(detail.participants[0].checkInTime, null, '未签到就是 null，不是 undefined');
  assert.equal(detail.event.fingerprint, undefined);
  assert.equal(detail.event.createdBy, undefined);
});

test('declined invitations cannot be changed or used to register', async () => {
  const repo = fixture();
  const id = await create(repo);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'declined' }, 'demo_buaa_admin', 'buaa')).ok, true);
  assert.equal((await accept(repo, id)).ok, false);
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
});

test('inactive participant is rejected at enrollment and checked again when roster locks', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  const memberId = schoolMemberKey('demo_buaa_member', 'buaa');
  const member = await repo.schoolMembers.getById(memberId);
  await repo.schoolMembers.set(memberId, { ...member, status: 'disabled' });
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
});

test('audit failure rolls back event creation, invitations and enrollment', async () => {
  const repo = fixture();
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => {
    tx.audit.append = async () => { throw new Error('injected'); };
    return fn(tx);
  });
  await assert.rejects(create(repo), /injected/);
  assert.equal((await repo.exchangeEvents.list()).length, 0);
  assert.equal((await repo.exchangeInvitations.list()).length, 0);
  repo.transaction = original;
  const id = await create(repo);
  repo.transaction = fn => original(async tx => { tx.audit.append = async () => { throw new Error('injected'); }; return fn(tx); });
  await assert.rejects(signup(repo, id), /injected/);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 0);
  assert.equal((await repo.exchangeSignups.listByEvent(id)).length, 0);
});

test('invalid dates, quotas and inactive schools are rejected without writes', async () => {
  const repo = fixture();
  for (const change of [ { quota: 1 }, { quota: 2.5 }, { schoolQuotas: { muc: 1, buaa: 1 } },
    { startTime: '2020-01-01' }, { participantSchoolIds: ['muc', 'muc'] }, { requestId: '' } ]) {
    assert.equal((await call(repo, 'createExchangeEvent', { ...form, ...change })).ok, false);
  }
  await repo.schools.set('buaa', { schoolId: 'buaa', status: 'disabled' });
  assert.equal((await call(repo, 'createExchangeEvent', form)).ok, false);
  assert.equal((await repo.exchangeEvents.list()).length, 0);
});

test('registration closes at start time and ignores client supplied user or represented school', async () => {
  const repo = fixture();
  const id = await create(repo);
  const result = await call(repo, 'signUpExchangeEvent', { eventId: id, userId: 'demo_buaa_member', representedSchoolId: 'buaa' }, 'demo_muc_member');
  assert.equal(result.ok, true);
  const row = (await repo.exchangeSignups.listByEvent(id))[0];
  assert.equal(row.userId, 'demo_muc_member');
  assert.equal(row.representedSchoolId, 'muc');
  assert.equal((await call(repo, 'signUpExchangeEvent', { eventId: id }, 'demo_muc_admin', 'muc', new Date(form.startTime))).ok, false);
});

test('draw is limited to managers of both schools and only after the roster locks', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id })).ok, false, '报名未锁定不能抽签');
  await call(repo, 'lockExchangeRoster', { eventId: id });
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id }, 'demo_muc_member')).ok, false, '普通会员不能抽签');
  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 7 }, 'demo_buaa_admin', 'buaa');
  assert.equal(drawn.ok, true, drawn.message);
  const record = await repo.exchangeEvents.getById(id);
  assert.equal(record.status, 'drawn');
  assert.equal(record.draw.size, 2);
  assert.equal((await repo.exchangeMatches.listByEvent(id)).length, 1);
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.matches.length, 1);
  assert.equal(detail.matches[0].canScore, true, '主办方管理员可确认任意一场比分');
  assert.equal(detail.canConfirmRanking, false);
});

test('score confirmation by a player advances the bracket and rejects invalid results', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 3 });
  let rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal(rows.filter(row => row.round === 1).length, 2);
  assert.equal(rows.filter(row => row.round === 2).length, 0);
  const first = rows.filter(row => row.round === 1).sort((a, b) => a.slot - b.slot)[0];
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 5, scoreB: 5 },
    first.playerA, await schoolOf(repo, id, first.playerA))).ok, false, '淘汰赛不能打平');
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 11, scoreB: 'x' },
    first.playerA, await schoolOf(repo, id, first.playerA))).ok, false, '非法比分被拒绝');
  // 未指定裁判时，比赛双方可确认比分
  const scored = await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 11, scoreB: 4 },
    first.playerA, await schoolOf(repo, id, first.playerA));
  assert.equal(scored.ok, true, scored.message);
  rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal(rows.find(row => row._id === first._id).winner, first.playerA);
  const second = rows.filter(row => row.round === 1 && row._id !== first._id)[0];
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: second._id, scoreA: 9, scoreB: 11 },
    second.playerB, await schoolOf(repo, id, second.playerB));
  rows = await repo.exchangeMatches.listByEvent(id);
  const final = rows.find(row => row.round === 2);
  assert.ok(final, '两场半决赛结束后应生成决赛');
  assert.equal(final.status, 'pending');
  // 第三方会员既不是参赛者也不是管理员，不能填写比分
  await repo.users.set('extra', { _id: 'extra', openId: 'mock_openid_extra', nickName: '旁观会员',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
  await repo.schoolMembers.set(schoolMemberKey('extra', 'muc'), { _id: schoolMemberKey('extra', 'muc'),
    userId: 'extra', schoolId: 'muc', collegeId: 'c01', status: 'active' });
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: final._id, scoreA: 11, scoreB: 2 },
    'extra', 'muc')).ok, false);
});

test('an assigned referee blocks players and can confirm the score, and only managers may assign', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 5 });
  const rows = await repo.exchangeMatches.listByEvent(id);
  const match = rows.filter(row => row.round === 1).sort((a, b) => a.slot - b.slot)[0];
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_muc_member' },
    'demo_muc_member')).ok, false, '普通会员不能指定裁判');
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_applicant' })).ok, false,
    '非参赛学校有效会员不能当裁判');
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_muc_member' })).ok, true);
  assert.equal((await repo.exchangeMatches.getById(match._id)).referee, 'demo_muc_member');
  // 已设裁判：比赛双方不能自行确认
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: match._id, scoreA: 11, scoreB: 3 },
    match.playerA, await schoolOf(repo, id, match.playerA))).ok, false);
  // 裁判可以确认
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: match._id, scoreA: 11, scoreB: 3 },
    'demo_muc_member', 'muc')).ok, true);
  // 已生效的比赛不能再改派裁判
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_buaa_member' })).ok, false);
});

test('ranking is derived from confirmed results and confirmed only by managers', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 9 });
  let rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id })).ok, false, '还有比赛未确认不能定名次');
  for (const row of rows.filter(entry => entry.round === 1)) {
    await call(repo, 'submitExchangeScore', { eventId: id, matchId: row._id, scoreA: 11, scoreB: 6 });
  }
  rows = await repo.exchangeMatches.listByEvent(id);
  const final = rows.find(row => row.round === 2);
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: final._id, scoreA: 11, scoreB: 8 });
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id }, 'demo_muc_member')).ok, false, '普通会员不能确认名次');
  const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.event.status, 'finished');
  const placements = done.event.results.map(row => row.placement).sort((a, b) => a - b);
  assert.deepEqual(placements, [1, 2, 3, 3]);
  assert.equal(done.event.results.find(row => row.placement === 1).userId, final.playerA);
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id })).ok, false, '不能重复确认');
  // 名次只回传昵称、代表学校与用户标识
  assert.deepEqual(Object.keys(done.event.results[0]).sort(), ['nickName', 'placement', 'representedSchoolId', 'schoolName', 'userId']);
});

/* ============================================================
 * S4 剩余能力（2026-10-16）：签到 / 退赛 / 邀请撤回 / 取消赛事 / 比分撤销
 * ============================================================
 * 规则与普通赛事对齐：代签由管理员做、退赛只在报名阶段、比分撤销要求从最后一轮
 * 往前撤、赛事取消后一切写动作停止。
 */

test('签到：名单锁定后由管理员代签，重复签到幂等，不能替外校签', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  const before = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(before.participants.every(row => row.checkInTime === null), true);
  assert.equal(before.canCheckIn, true);
  // 民大管理员只能替民大的参赛者签到（和普通赛事一样，签到由管理员在场边做）
  const muc = before.participants.filter(row => row.representedSchoolId === 'muc');
  const buaa = before.participants.filter(row => row.representedSchoolId === 'buaa');
  assert.equal(muc.length > 0 && muc.every(row => row.canCheckIn === true), true);
  assert.equal(buaa.every(row => row.canCheckIn === false), true, '不能替外校签');

  const signed = await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_muc_member' });
  assert.equal(signed.ok, true, signed.message);
  const again = await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_muc_member' });
  assert.equal(again.ok, true, '重复签到幂等');
  // 签到落在赛事的 checkIns 上（userId → 时间），不再改写报名行：
  // 锁定之后参赛者只认名册快照，签到写回报名表会让「谁在名单上」出现两个答案。
  const afterCheckIn = await repo.exchangeEvents.getById(id);
  assert.deepEqual(Object.keys(afterCheckIn.checkIns), ['demo_muc_member'], '只记一次签到');
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.participants.filter(row => row.checkedIn).length, 1, '详情里只有一人已签到');

  // 民大管理员只能替民大的人签；普通会员不能替别人签
  assert.equal((await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_buaa_member' })).ok, false);
  assert.equal((await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_muc_admin' },
    'demo_muc_member', 'muc')).ok, false);
  // 北航管理员可以替本校的人签
  assert.equal((await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_buaa_member' },
    'demo_buaa_admin', 'buaa')).ok, true);
  // 名单锁定前不能签到（新建一场，别撞上上面那场的幂等编号）
  const early = await create(repo, { requestId: 'test_early_checkin' });
  await accept(repo, early);
  await signup(repo, early, 'demo_muc_member');
  assert.equal((await call(repo, 'checkInExchangeSignup', { eventId: early, userId: 'demo_muc_member' })).ok, false);
});

test('退赛：本人取消与管理员移除都只在报名阶段，且释放名额', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_muc_member');
  await signup(repo, id, 'demo_muc_admin');
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 3);

  // 管理员移除本校一位报名者：名额释放
  const removed = await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_muc_admin', reason: '临时有事' });
  assert.equal(removed.ok, true, removed.message);
  const after = await repo.exchangeEvents.getById(id);
  assert.equal(after.signupCount, 2);
  assert.equal(after.schoolCounts.muc, 1);
  const row = await repo.exchangeSignups.getById(require('../src/shared/utils/school')
    .schoolKey('xs', id, 'demo_muc_admin'));
  assert.equal(row.status, 'removed');
  assert.equal(row.removeReason, '临时有事');
  // 重复移除幂等；外校的人不能由本方管理员移除
  assert.equal((await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_muc_admin' })).ok, true);
  assert.equal((await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_buaa_member' })).ok, false);

  // 名单锁定后不能再退赛
  await call(repo, 'lockExchangeRoster', { eventId: id });
  assert.equal((await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_muc_member' })).ok, false);
  assert.equal((await call(repo, 'cancelExchangeSignup', { eventId: id }, 'demo_muc_member')).ok, false);
});

test('邀请撤回：主办方可撤未锁定的邀请，受邀校也能撤回自己那条，已有人报名要先清', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');

  // 该校已经有人报名：先拒绝
  assert.equal((await call(repo, 'withdrawExchangeInvitation', { eventId: id, schoolId: 'buaa' })).ok, false);
  // 移除报名只能由该校管理员做（跨校不管对方的人），再去撤回邀请
  assert.equal((await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_buaa_member' })).ok, false);
  await call(repo, 'removeExchangeSignup', { eventId: id, userId: 'demo_buaa_member' }, 'demo_buaa_admin', 'buaa');

  // 受邀校自己的管理员撤回自己那条
  const byGuest = await call(repo, 'withdrawExchangeInvitation', { eventId: id, schoolId: 'buaa' },
    'demo_buaa_admin', 'buaa');
  assert.equal(byGuest.ok, true, byGuest.message);
  assert.equal(byGuest.event.invitations.buaa, 'withdrawn');
  // 撤回后该校不能再报名
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);

  // 主办方可以撤回对另一校的邀请；主办校自己不能被撤回
  const other = await create(repo, { requestId: 'test2' });
  assert.equal((await call(repo, 'withdrawExchangeInvitation', { eventId: other, schoolId: 'muc' })).ok, false);
  // 名单锁定后不能再撤回
  const third = await create(repo, { requestId: 'test3' });
  await accept(repo, third);
  await signup(repo, third, 'demo_muc_member');
  await signup(repo, third, 'demo_buaa_member', 'buaa');
  await call(repo, 'lockExchangeRoster', { eventId: third });
  assert.equal((await call(repo, 'withdrawExchangeInvitation', { eventId: third, schoolId: 'buaa' })).ok, false);
});

test('取消赛事：主办方可取消，取消后报名 / 抽签 / 录分 / 名次全部停止', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  assert.equal((await call(repo, 'cancelExchangeEvent', { eventId: id, reason: '场地冲突' },
    'demo_buaa_admin', 'buaa')).ok, false, '受邀校不能取消整场赛事');

  const canceled = await call(repo, 'cancelExchangeEvent', { eventId: id, reason: '场地冲突' });
  assert.equal(canceled.ok, true, canceled.message);
  assert.equal(canceled.event.status, 'canceled');
  assert.equal((await repo.exchangeEvents.getById(id)).cancelReason, '场地冲突');

  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 3 });
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 3 })).ok, false, '取消后不能抽签');
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.canceled, true);
  assert.equal(detail.canDraw, false);
  assert.equal(detail.participants.every(row => row.canCheckIn === false), true);
  // 取消后再取消幂等
  assert.equal((await call(repo, 'cancelExchangeEvent', { eventId: id })).ok, true);
});

test('比分撤销已取消：已确认的交流赛比分不可退回待确认', async () => {
  // Elo 逐场结算改造：确认即最终结论，个人赛与交流赛同一规则。
  // 录错的处理口径：已结束的赛事以最终名次为准；进行中的赛事无撤销入口。
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 9 });
  const rows = await repo.exchangeMatches.listByEvent(id);
  const semis = rows.filter(row => row.round === 1).sort((a, b) => (a._id < b._id ? -1 : 1));
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: semis[0]._id, scoreA: 11, scoreB: 6 });

  const confirmed = await repo.exchangeMatches.getById(semis[0]._id);
  assert.equal(confirmed.status, 'active');
  assert.equal(typeof handlers.revokeExchangeScore, 'undefined', '撤销实现已删除');
  const actions = require('../src/shared/utils/school-actions.js');
  assert.equal(actions.SCHOOL_EXCHANGE_ACTIONS.includes('revokeExchangeScore'), false,
    '撤销动作已从协议 2 白名单移除');
  assert.equal((await repo.exchangeMatches.getById(semis[0]._id)).scoreA, 11, '比分未被清空');
});

test('失效身份在锁定名单时被清理并释放名额，仍够两校则照常锁定', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_muc_member');
  await signup(repo, id, 'demo_muc_admin');
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  await signup(repo, id, 'demo_buaa_admin', 'buaa');
  // 北航两位里的一位退学（学籍停用）
  const memberId = schoolMemberKey('demo_buaa_admin', 'buaa');
  const member = await repo.schoolMembers.getById(memberId);
  await repo.schoolMembers.set(memberId, { ...member, status: 'disabled' });

  const locked = await call(repo, 'lockExchangeRoster', { eventId: id });
  assert.equal(locked.ok, true, locked.message);
  const event = await repo.exchangeEvents.getById(id);
  assert.equal(event.signupCount, 3, '失效者不再占名额');
  assert.equal(event.schoolCounts.buaa, 1);
  assert.deepEqual(event.prunedSignups.map(row => row.userId), ['demo_buaa_admin']);
  // 报名行不再被改写：锁定是「产出一份名册」，不是对每条报名做状态迁移。
  // 失效者只是不进名册，历史报名记录保持原样（锁定后本来也不允许再改动）。
  const untouched = await repo.exchangeSignups.getById(require('../src/shared/utils/school')
    .schoolKey('xs', id, 'demo_buaa_admin'));
  assert.equal(untouched.status, 'signed', '报名行不应被改写');
  assert.deepEqual(event.roster.map(row => row.userId).sort(),
    ['demo_buaa_member', 'demo_muc_admin', 'demo_muc_member'], '名册里没有失效者');

  // 只剩一校有人时：清理后锁定被拒，并说明原因
  // （先把上一步停用的北航管理员学籍恢复——受邀校的邀请处理也要靠它）
  await repo.schoolMembers.set(memberId, member);
  const only = await create(repo, { requestId: 'test_only' });
  await accept(repo, only);
  await signup(repo, only, 'demo_muc_member');
  await signup(repo, only, 'demo_buaa_member', 'buaa');
  const buaaMember = schoolMemberKey('demo_buaa_member', 'buaa');
  const row = await repo.schoolMembers.getById(buaaMember);
  await repo.schoolMembers.set(buaaMember, { ...row, status: 'disabled' });
  const blocked = await call(repo, 'lockExchangeRoster', { eventId: only });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /两校/);
});

/* ============================================================
 * 更多赛制（2026-10-16）：与普通赛事同样的六种赛制
 * ============================================================
 * 邀请赛原先固定单打单败淘汰。现在抽签与推进都复用普通赛事的赛制引擎
 * （format-plan / draw / standings），这里逐条验证六种赛制都能从头走到尾、
 * 名次口径正确，且不影响原有单败淘汰的行为。
 */

/** 把该赛事此刻所有「待比赛」逐一判胜，直到不再有新对阵冒出来 */
async function playAll(repo, eventId, guard = 40) {
  const played = new Set();
  for (let i = 0; i < guard; i += 1) {
    const detail = await call(repo, 'getExchangeEvent', { eventId });
    const pending = detail.matches.filter(row => row.status === 'pending' && !played.has(row._id));
    if (pending.length === 0) return detail;
    for (const row of pending) {
      played.add(row._id);
      const scored = await call(repo, 'submitExchangeScore', { eventId, matchId: row._id, scoreA: 11, scoreB: 5 });
      assert.equal(scored.ok, true, `${row._id}: ${scored.message}`);
    }
  }
  throw new Error('赛程没有收敛，可能有对阵被反复生成');
}

test('赛制与参数随创建落库：非法赛制回落单败，只有用得到的参数才存', async () => {
  const repo = fixture();
  const rr = await create(repo, { requestId: 'fmt_rr', format: 'round_robin' });
  const rrRecord = await repo.exchangeEvents.getById(rr);
  assert.equal(rrRecord.format, 'round_robin');
  assert.equal(rrRecord.bronzeMode, 'tied', '循环赛不生成三四名赛');
  assert.equal(rrRecord.gfReset, true, '缺省重赛开');
  assert.equal(rrRecord.groupCount, undefined, '循环赛恒为单组，不留组数字段');

  const grouped = await create(repo, { requestId: 'fmt_gk', format: 'group_knockout', groupCount: 4, advancePerGroup: 1 });
  const groupedRecord = await repo.exchangeEvents.getById(grouped);
  assert.equal(groupedRecord.groupCount, 4);
  assert.equal(groupedRecord.advancePerGroup, 1);

  const fallback = await create(repo, { requestId: 'fmt_x', format: 'not_a_format' });
  assert.equal((await repo.exchangeEvents.getById(fallback)).format, 'single_elim');
  assert.equal((await call(repo, 'getExchangeEvents')).events.find(row => row._id === fallback).formatLabel, '单败淘汰');
});

test('双败淘汰：胜者组 / 败者组 / 总决赛走完，名次排到第 4', async () => {
  const repo = fixture();
  const id = await readyFour(repo, { format: 'double_elim' });
  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 11 });
  assert.equal(drawn.ok, true, drawn.message);
  const stages = new Set((await repo.exchangeMatches.listByEvent(id)).map(row => row.stage));
  assert.deepEqual([...stages], ['wb'], '首轮长在胜者组上');

  const detail = await playAll(repo, id);
  const all = await repo.exchangeMatches.listByEvent(id);
  assert.equal(all.filter(row => row.stage === 'wb').length, 3);
  assert.equal(all.filter(row => row.stage === 'lb').length, 2);
  assert.equal(all.filter(row => row.stage === 'gf').length, 1);
  assert.equal(detail.matches.every(row => row.status === 'active'), true);
  assert.equal(detail.canConfirmRanking, true);

  const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(done.ok, true, done.message);
  assert.deepEqual(done.event.results.map(row => row.placement).sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('循环赛：人人与所有人交手，打完才按积分表出名次', async () => {
  const repo = fixture();
  const id = await readyFour(repo, { format: 'round_robin' });
  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 13 });
  assert.equal(drawn.ok, true, drawn.message);
  // 一轮打完才放下一轮，所以刚开始只有一部分场次
  assert.equal((await repo.exchangeMatches.listByEvent(id)).length, 2);
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id })).ok, false, '没打完不能定名次');

  const detail = await playAll(repo, id);
  assert.equal(detail.matches.length, 6, '四人循环赛共 6 场');
  assert.equal(detail.matches.every(row => row.stage === 'group'), true);
  const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(done.ok, true, done.message);
  assert.deepEqual(done.event.results.map(row => row.placement).sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('小组赛+淘汰：小组打完后自动接上淘汰签表，名次含小组名次', async () => {
  const repo = fixture();
  const id = await readyFour(repo, { format: 'group_knockout', groupCount: 2, advancePerGroup: 2 });
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 17 })).ok, true);
  assert.equal((await repo.exchangeMatches.listByEvent(id)).every(row => row.stage === 'group' && row.group !== undefined), true);

  const detail = await playAll(repo, id);
  const stages = new Set(detail.matches.map(row => row.stage));
  assert.equal(stages.has('group'), true);
  assert.equal(stages.has('main'), true, '小组出线后应生成淘汰赛');
  assert.equal(detail.matches.some(row => row.groupText), true, '小组赛场次带组号');

  const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.event.results[0].placement, 1);
});

test('双败淘汰不满四人时拒绝抽签', async () => {
  const repo = fixture();
  const id = await create(repo, { format: 'double_elim' });
  await accept(repo, id);
  await signup(repo, id, 'demo_muc_member');
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, true);
  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 3 });
  assert.equal(drawn.ok, false);
  assert.match(drawn.message, /至少需要 4 名/);
});

test('六种赛制都能从创建走到确认名次：名次连续无空洞、第一名存在', async () => {
  // 这条是本批的「总闸门」：赛制规则全在通用引擎里，邀请赛只做形状翻译，
  // 所以六种赛制必须都能端到端走完，名次连续无空洞、无并列冲突。
  const cases = [
    ['single_elim', {}],
    ['round_robin', {}],
    ['group_knockout', { groupCount: 2, advancePerGroup: 2 }],
    ['round_robin_knockout', { advancePerGroup: 2 }],
    ['double_elim', {}],
    ['group_double_elim', { groupCount: 2, advancePerGroup: 2 }],
  ];
  for (const [format, fields] of cases) {
    const repo = fixture();
    const id = await readyFour(repo, { format, ...fields });
    assert.equal((await repo.exchangeEvents.getById(id)).format, format, `${format} 落库`);
    assert.equal((await call(repo, 'getExchangeEvents')).events.find(row => row._id === id).formatLabel,
      EVENT_FORMAT_LABEL[format], `${format} 中文名`);

    const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 7 });
    assert.equal(drawn.ok, true, `${format} 抽签：${drawn.message}`);
    const detail = await playAll(repo, id);
    assert.equal(detail.matches.length > 0, true, `${format} 排出了比赛`);
    assert.equal(detail.matches.every(row => row.status === 'active'), true, `${format} 全部确认比分`);
    assert.equal(detail.canConfirmRanking, true, `${format} 可确认名次`);

    const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
    assert.equal(done.ok, true, `${format} 确认名次：${done.message}`);
    const places = done.event.results.map(row => row.placement);
    assert.equal(places.length, 4, `${format} 四人都拿到名次`);
    assert.equal(Math.min(...places), 1, `${format} 有冠军`);
    const worst = Math.max(...places);
    assert.equal(worst <= 4, true, `${format} 名次不超出人数`);
    // 「连续无空洞」：1..worst 每一档都有人（单败的季军并列是既有口径，所以不要求互不重复）
    for (let value = 1; value <= worst; value += 1) {
      assert.equal(places.includes(value), true, `${format} 名次 ${value} 有人认领`);
    }
  }
});

/* ============================================================
 * 云端容量：锁名单的事务操作数必须与人头数无关（2026-10-21）
 * ============================================================
 * 云开发事务只支持单记录操作，单事务操作数上限约 100（未公示，社区实践值；
 * 见 cloudfunctions/data/src/adapters/cloud-repo.js 的 TX_OPERATION_BUDGET）。
 *
 * 旧实现逐条改写报名记录，事务操作数 ≈ 4N：跨校赛 200 人报名就是 800 次，
 * **功能直接不可用**。而本地测试长期只有 2~4 人，永远照不出来。
 *
 * 这组用例把「操作数与人数无关」钉住：2 人与 4 人两场，事务内读写次数必须
 * 完全相等，且总数是个位数。以后谁再往锁定路径里加逐人循环，这里立刻变红。
 * ============================================================ */

/**
 * 给事务对象套一层操作计数，口径与云端适配器一致（getById 算 1 读，
 * set/add 算 1 写）。forScope 这类返回子仓储的方法，返回的对象同样被计数。
 *
 * @param {Object} repo 仓储
 * @returns {{reads:number, writes:number}} 会被就地累加
 */
function countTransactionOps(repo) {
  const stats = { reads: 0, writes: 0 };
  const isCollection = value => value && typeof value === 'object' && typeof value.getById === 'function';
  const spyCollections = target => new Proxy(target, {
    get(object, method) {
      const value = object[method];
      if (typeof value !== 'function') return value;
      if (/^(getById|get|list|listBy[A-Za-z]+)$/.test(method)) {
        return (...args) => { stats.reads += 1; return value.apply(object, args); };
      }
      if (/^(set|insert|update|remove|add)$/.test(method)) {
        return (...args) => { stats.writes += 1; return value.apply(object, args); };
      }
      return value.bind(object);
    },
  });
  const spyRepo = target => new Proxy(target, {
    get(object, key) {
      const value = object[key];
      if (isCollection(value)) return spyCollections(value);
      if (typeof value === 'function') {
        return (...args) => {
          const out = value.apply(object, args);
          // forScope / forMeet 返回的子仓储继续计数；Promise 与方法返回值原样放行
          if (out && typeof out === 'object' && typeof out.then !== 'function' && !isCollection(out)) {
            return spyRepo(out);
          }
          return out;
        };
      }
      return value;
    },
  });
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => fn(spyRepo(tx)));
  return stats;
}

/** 造一场「已接受邀请 + 若干人报名」的赛事，尚未锁定 */
async function signedUp(repo, entrants, requestId) {
  const id = await create(repo, { requestId, quota: 12, schoolQuotas: { muc: 6, buaa: 6 } });
  await accept(repo, id);
  for (const [actor, schoolId] of entrants) await signup(repo, id, actor, schoolId);
  return id;
}

test('锁名单的事务操作数与人头数无关（云端 100 次上限下仍能锁）', async () => {
  const pair = [['demo_muc_member', 'muc'], ['demo_buaa_member', 'buaa']];
  const quad = [...pair, ['demo_muc_admin', 'muc'], ['demo_buaa_admin', 'buaa']];

  const two = fixture();
  const twoId = await signedUp(two, pair, 'ops_two');
  const twoOps = countTransactionOps(two);
  assert.equal((await call(two, 'lockExchangeRoster', { eventId: twoId })).ok, true);

  const four = fixture();
  const fourId = await signedUp(four, quad, 'ops_four');
  const fourOps = countTransactionOps(four);
  assert.equal((await call(four, 'lockExchangeRoster', { eventId: fourId })).ok, true);

  assert.equal(fourOps.reads, twoOps.reads, '人头翻倍，事务内读取次数必须不变');
  assert.equal(fourOps.writes, twoOps.writes, '人头翻倍，事务内写入次数必须不变');
  assert.ok(twoOps.reads + twoOps.writes <= 10,
    `锁名单应在个位数操作内完成，实际 读${twoOps.reads} 写${twoOps.writes}`);
});

test('锁定后名册是唯一参赛者来源：抽签与详情都读它', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  const event = await repo.exchangeEvents.getById(id);
  assert.equal(event.roster.length, 4, '名册应记下四名参赛者');
  assert.deepEqual(event.checkIns, {}, '锁定瞬间还没有人签到');

  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.participants.length, 4);
  assert.deepEqual(
    detail.participants.map(row => row.userId).sort(),
    event.roster.map(row => row.userId).sort(),
    '详情里的参赛者必须与名册一一对应',
  );
});

test('跨校详情与指定裁判只按参赛校读名册（2026-10-26 第五轮审查 C）', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 5 });
  const rows = await repo.exchangeMatches.listByEvent(id);
  const match = rows.filter(row => row.round === 1).sort((a, b) => a.slot - b.slot)[0];

  // 记下每个被打开的范围：改造前的实现走的是基础仓储 list()（条件为空 = 全平台），
  // 根本不经过 forScope，所以「参与本次读取的学校集合」这条断言它能挡得住。
  const scopes = [];
  const rawForScope = repo.forScope.bind(repo);
  repo.forScope = (input) => { scopes.push(input.schoolId); return rawForScope(input); };

  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.ok, true, detail.message);
  assert.deepEqual(detail.referees, [], '未指派裁判时详情不包含候选名册');
  const candidates = await call(repo, 'listExchangeRefereeCandidates', { eventId: id, schoolId: 'muc' });
  assert.equal(candidates.ok, true, candidates.message);
  assert.ok(candidates.members.length > 0);
  assert.ok(candidates.members.every(row => row.schoolId === 'muc'), '候选只来自请求的参赛校');

  const assigned = await call(repo, 'assignExchangeReferee',
    { eventId: id, matchId: match._id, refereeId: 'demo_muc_member' });
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal((await repo.exchangeMatches.getById(match._id)).referee, 'demo_muc_member');
  assert.ok(scopes.every(schoolId => ['muc', 'buaa'].includes(schoolId)),
    `只允许打开参赛校的范围，实际 ${[...new Set(scopes)].join(', ')}`);
});
