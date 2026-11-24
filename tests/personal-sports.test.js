const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context');
const { getMySportsDashboard } = require('../src/server/services/personal-sports-service');
const { queryPlan, SOURCES } = require('../src/server/services/personal-sports-query');
const { readPersonalSportsPage } = require('../cloudfunctions/data/src/adapters/personal-sports-page');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
const { schoolMemberKey, schoolMembershipKey, schoolRoleKey } = require('../src/shared/utils/school');
const { meetPublicationKey } = require('../src/shared/utils/meet-scope');
const NOW = new Date('2026-10-28T00:00:00.000Z');
const AT = '2026-10-29T02:00:00.000Z';
const patch = async (collection, id, changes) => collection.set(id, { ...await collection.getById(id), ...changes });
const SCOPE = { schoolId: 'muc', association: 'pkb' };
const BASKET = { schoolId: 'muc', association: 'bk' };
const personal = (id, extra = {}) => ({ _id: id, ...SCOPE, teamA: ['u'], teamB: ['v'], status: 0, winner: '', matchTime: AT, ...extra });
function fixture(extra = {}, factory = createSchoolMemoryRepo) {
  const seed = createSchoolSeed();
  seed.users = ['u', 'v', 'r'].map(_id => ({ _id, openId: `openid_${_id}`, nickName: `昵称${_id}`, realName: '保密真名', phone: '保密电话', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' }));
  seed.schoolMembers = seed.users.map(user => ({ _id: schoolMemberKey(user._id, 'muc'), schoolId: 'muc', userId: user._id, collegeId: 'A', status: 'active', studentId: '保密学号' }));
  Object.assign(seed, extra);
  const repo = factory(seed);
  return { repo, async call(payload = {}, actorId = 'u', now = NOW, schoolId = 'muc') {
    const ctx = await buildMeetContext({ repo, actorId, scope: { schoolId }, now });
    return (await getMySportsDashboard(payload, ctx)).data;
  } };
}
const teamEvent = (status = 'scheduled') => ({ _id: 'te', ...BASKET, name: '篮球联赛', status, startTime: AT });
const teamMatch = (id, extra = {}) => ({ _id: id, ...BASKET, eventId: 'te', teamA: 't1', teamB: 't2', matchTime: AT, status: 'scheduled', sportFormat: 'basketball5', ...extra });
const meetDocs = () => ({ sportsMeets: [{ _id: 'meet', schoolId: 'muc', name: '校运会', status: 'scheduled' }],
  sportsMeetEvents: [{ _id: 'ev', schoolId: 'muc', meetId: 'meet', name: '100米', rounds: 'heat_final', status: 'active' }],
  sportsMeetSessions: [{ _id: 'slot', schoolId: 'muc', meetId: 'meet', eventKey: 'ev', startAt: AT, entryKeys: ['entry'], status: 'scheduled' }],
  sportsMeetEntries: [{ _id: 'entry', schoolId: 'muc', meetId: 'meet', eventKey: 'ev', userIds: ['u'], status: 'approved' }],
  sportsMeetJudgeAssignments: [{ _id: 'judge', schoolId: 'muc', meetId: 'meet', eventKey: 'ev', sessionKey: 'slot', judgeId: 'u', status: 'active' }] });

for (const [name, factory] of [['演示仓储', createSchoolMemoryRepo], ['云端仓储契约', createMemoryRepo]]) {
  test(`${name}：个人赛程只含本人关系；忽略伪造用户；不回传学号、真名、电话或完整名单`, async () => {
    const f = fixture({ matches: [personal('own'), personal('other', { teamA: ['r'] }), personal('foreign', { schoolId: 'buaa' }), personal('deleted', { status: 2 })] }, factory);
    const result = await f.call({ section: 'schedule', userId: 'r' });
    assert.equal(result.ok, true); assert.deepEqual(result.items.map(row => row.key), ['schedule:personal:own']);
    assert.match(result.items[0].opponents, /昵称u/);
    assert.doesNotMatch(JSON.stringify(result), /保密|studentId|realName|phone|teamA|teamB|roster/);
  });
  test(`${name}：球队参赛与裁判/记录员任务按真实场次去重，合并角色，排除同赛事其他球队`, async () => {
    const f = fixture({ teamEvents: [teamEvent()], teamEventEntries: [{ _id: 'entry', ...BASKET, eventId: 'te', teamId: 't1', status: 'locked', roster: [{ userId: 'u' }] }],
      teamMatches: [teamMatch('both', { refereeId: 'u', recorderId: 'u' }), teamMatch('others', { teamA: 't3', teamB: 't4' })] }, factory);
    const result = await f.call({ section: 'schedule', project: 'bk', limit: 1 });
    assert.equal(result.items.length, 1); assert.equal(result.hasMore, false);
    assert.deepEqual(result.items[0].roles.sort(), ['参赛名单', '裁判', '记录员'].sort());
  });
  test(`${name}：运动会本人报名和执裁合并，作废后消失，重抽后只显示新指派`, async () => {
    const f = fixture(meetDocs(), factory);
    const first = await f.call({ section: 'schedule', project: 'meet' });
    assert.equal(first.items.length, 1); assert.deepEqual(first.items[0].roles.sort(), ['参赛', '裁判'].sort());
    await patch(f.repo.sportsMeetSessions, 'slot', { voidedAt: NOW.toISOString() });
    assert.equal((await f.call({ section: 'schedule', project: 'meet' })).items.length, 0);
    await patch(f.repo.sportsMeetSessions, 'slot', { voidedAt: null, judgeAssignmentRevision: 1 });
    const redrawn = await f.call({ section: 'schedule', project: 'meet' });
    assert.deepEqual(redrawn.items[0].roles, ['参赛']);
    await patch(f.repo.sportsMeetJudgeAssignments, 'judge', { judgeAssignmentRevision: 1 });
    const reassigned = await f.call({ section: 'schedule', project: 'meet' });
    assert.deepEqual(reassigned.items[0].roles.sort(), ['参赛', '裁判'].sort());
  });
  test(`${name}：事务中拒绝聚合读取`, async () => {
    await assert.rejects(fixture({}, factory).repo.transaction(tx => tx.personalSports.readPage('personalSchedule', { schoolId: 'muc', userId: 'u' }, { asOf: NOW.toISOString() })), /事务/);
  });
}

test('真实云端协议入口按OPENID确定本人，停用账号/外校浏览均拒绝且要求清空旧列表', async () => {
  const f = fixture({ matches: [personal('m')] }, createMemoryRepo);
  const request = { protocolVersion: 2, action: 'getMySportsDashboard', schoolId: 'muc', association: 'pkb', payload: { section: 'schedule', userId: 'v' } };
  const first = await handleSchoolRequest(request, { repo: f.repo, openId: 'openid_u', now: NOW });
  assert.equal(first.data.ok, true); assert.equal(first.data.items.length, 1);
  await patch(f.repo.users, 'u', { platformStatus: 'disabled' });
  const denied = await handleSchoolRequest(request, { repo: f.repo, openId: 'openid_u', now: NOW });
  assert.equal(denied.data.ok, false); assert.equal(denied.data.resetRequired, true);
  assert.equal((await f.call({}, 'v', NOW, 'buaa')).ok, false);
});

test('赛程90天窗口、进行中优先、已撤销/过期/无日期场次过滤；未排期报名明确标记', async () => {
  const f = fixture({ matches: [personal('future'), personal('past', { matchTime: '2026-10-27T00:00:00.000Z' }), personal('far', { matchTime: '2027-10-29T00:00:00.000Z' }), personal('undated', { matchTime: '' }), personal('live', { matchTime: '2026-10-27T00:00:00.000Z' })],
    liveScores: [{ _id: 'l', ...SCOPE, matchId: 'live', status: 'live' }],
    events: [{ _id: 'waiting', ...SCOPE, title: '待抽签赛事', status: 0 }],
    eventSignups: [{ _id: 'su', ...SCOPE, eventId: 'waiting', userId: 'u', status: 1 }] });
  const result = await f.call({ section: 'schedule' });
  assert.deepEqual(result.items.map(row => row.state), ['进行中', '已排期', '等待赛程']);
  assert.equal(result.items[1].timeText, '10月29日 10:00'); assert.equal(result.items[2].timeText, '时间待定');
});

test('学院已排阵小场使用学院赛归属和结束状态，不能被当成无父赛事的日常比赛', async () => {
  const f = fixture({ matches: [personal('leg', { collegeEventId: 'ce' })], collegeEvents: [{ _id: 'ce', ...SCOPE, title: '学院杯', status: 2 }] });
  assert.equal((await f.call({ section: 'schedule' })).items[0].title, '学院杯');
  await patch(f.repo.collegeEvents, 'ce', { status: 3 });
  assert.equal((await f.call({ section: 'schedule' })).items.length, 0);
});

test('同时间跨来源分页无重复和遗漏，续页游标绑定本人、分区、筛选、权限和30分钟有效期', async () => {
  const f = fixture({ matches: ['a', 'b', 'c'].map(id => personal(id)), ...meetDocs() });
  let cursor = '', keys = [], pages = 0;
  do {
    const r = await f.call({ section: 'schedule', limit: 1, cursor });
    assert.equal(r.ok, true); keys.push(...r.items.map(row => row.key)); cursor = r.nextCursor; pages++;
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(keys.length, 4); assert.equal(new Set(keys).size, 4);
  const first = await f.call({ section: 'schedule', limit: 1 });
  for (const [payload, actor, date] of [ [{ section: 'passport' }, 'u', NOW], [{ section: 'schedule', project: 'meet' }, 'u', NOW], [{ section: 'schedule' }, 'v', NOW], [{ section: 'schedule' }, 'u', new Date(NOW.getTime() + 31 * 60000)] ]) {
    const rejected = await f.call({ ...payload, cursor: first.nextCursor }, actor, date);
    assert.equal(rejected.ok, false); assert.equal(rejected.resetRequired, true);
  }
  await f.repo.schoolRoles.set(schoolRoleKey('u', 'muc'), { schoolId: 'muc', userId: 'u', role: 'admin', status: 'active' });
  assert.equal((await f.call({ section: 'schedule', cursor: first.nextCursor })).ok, false);
});

test('待确认比分复用正式确认规则：录入者不能自己确认，指定裁判后只给该裁判任务', async () => {
  const f = fixture({ matches: [personal('m', { winner: 'A', scoreA: [11, 11], scoreB: [1, 2], recorder: 'u', revision: 3 })] });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
  assert.equal((await f.call({ section: 'tasks' }, 'v')).items[0].target.kind, 'confirm_score');
  await patch(f.repo.matches, 'm', { referee: 'r' });
  assert.equal((await f.call({ section: 'tasks' }, 'v')).items.length, 0);
  assert.equal((await f.call({ section: 'tasks' }, 'r')).items.length, 1);
});

test('学院退回待办按授权学院B而非学籍学院A；普通会员没有审核及退回管理任务', async () => {
  const f = fixture({ collegeEvents: [{ _id: 'ce', ...SCOPE, title: '学院杯', status: 0 }], collegeEntries: ['A', 'B'].map(collegeId => ({ _id: collegeId, ...SCOPE, eventId: 'ce', collegeId, status: 2, updatedAt: AT })),
    memberships: [{ _id: schoolMembershipKey('u', SCOPE), ...SCOPE, userId: 'u', role: 'staff', collegeId: 'B', status: 'active' }] });
  const result = await f.call({ section: 'tasks' });
  assert.deepEqual(result.items.map(row => row.target.collegeId), ['B']);
  assert.equal((await f.call({ section: 'tasks' }, 'v')).items.length, 0);
  await patch(f.repo.memberships, schoolMembershipKey('u', SCOPE), { status: 'revoked' });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
});

test('球队退回待办要求当前队长且有效队员；离队或报名结束即消失', async () => {
  const f = fixture({ teams: [{ _id: 't1', ...BASKET, captainId: 'u', status: 'active' }], teamMembers: [{ _id: 'tm', ...BASKET, teamId: 't1', userId: 'u', status: 'active' }], teamEvents: [teamEvent('registration')],
    teamEventEntries: [{ _id: 'en', ...BASKET, eventId: 'te', teamId: 't1', status: 'rejected', reason: '请补名单', updatedAt: AT }] });
  assert.equal((await f.call({ section: 'tasks' })).items[0].subtitle, '请补名单');
  await patch(f.repo.teamMembers, 'tm', { status: 'left' });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
});

test('裁判草稿待办要求该场指派仍有效；另一场的指派不能借权；已发布后普通裁判不再有提交任务', async () => {
  const docs = meetDocs();
  docs.sportsMeetScores = [{ _id: 'score', schoolId: 'muc', meetId: 'meet', eventKey: 'ev', sessionKey: 'slot', judgeId: 'u', state: 'draft', updatedAt: AT }];
  const f = fixture(docs);
  assert.equal((await f.call({ section: 'tasks' })).items[0].target.sessionKey, 'slot');
  await patch(f.repo.sportsMeetJudgeAssignments, 'judge', { sessionKey: 'other-slot' });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
  await patch(f.repo.sportsMeetJudgeAssignments, 'judge', { sessionKey: 'slot' });
  await f.repo.sportsMeetPublications.set(meetPublicationKey('meet', 'ev', 'slot'), { schoolId: 'muc', meetId: 'meet', eventKey: 'ev', status: 'published' });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
});

test('护照只用已确认比分、已发布名次和当前发布版本；不将分组前三名显示为正式荣誉', async () => {
  const publicationKey = meetPublicationKey('meet', 'ev', 'slot');
  const f = fixture({ ...meetDocs(), matches: [personal('confirmed', { status: 1, winner: 'A', scoreA: [11], scoreB: [2] }), personal('pending', { winner: 'A' })],
    events: [{ _id: 'honor', ...SCOPE, title: '单打杯', status: 2, finishedAt: AT, results: [{ userId: 'u', placement: 2 }, { userId: 'v', placement: 1 }] }],
    sportsMeetPublications: [{ _id: publicationKey, schoolId: 'muc', meetId: 'meet', eventKey: 'ev', status: 'published', version: 2, official: false, publishedAt: AT,
      rows: [{ entryKey: 'entry', userIds: ['u'], status: 'result', rank: 1 }] }],
    sportsMeetResultRows: [1, 2].map(version => ({ _id: `result${version}`, schoolId: 'muc', meetId: 'meet', eventKey: 'ev', publicationKey, userIds: ['u'], status: 'result', version, rank: 1 })) });
  const result = await f.call({ section: 'passport' });
  assert.equal(result.items.length, 3); assert.ok(!result.items.some(row => row.key.includes('pending') || row.key.includes('result1')));
  assert.equal(result.items.find(row => row.association === 'meet').honor, false);
  assert.equal(result.items.find(row => row.proof === '已发布个人名次').honor, true);
  assert.doesNotMatch(JSON.stringify(result), /成长值|经验值|总积分/);
});

test('护照名单入选与报告收录分别表述；未结束球队赛事不冒充归档经历，草稿统计不入护照', async () => {
  const f = fixture({ teamEvents: [teamEvent('finished')], teamMatches: [teamMatch('published', { status: 'published' })],
    teamEventEntries: [{ _id: 'entry', ...BASKET, eventId: 'te', teamId: 't1', status: 'locked', roster: [{ userId: 'u' }] }],
    teamMatchStats: [{ _id: 'stat', ...BASKET, eventId: 'te', matchId: 'published', published: { rows: [{ userId: 'u' }] }, players: [{ userId: 'v' }] }] });
  const result = await f.call({ section: 'passport' });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.some(row => /未据此推定实际出场/.test(row.subtitle)));
  assert.ok(result.items.some(row => row.proof === '已发布比赛报告收录'));
  assert.equal((await f.call({ section: 'passport' }, 'v')).items.length, 0);
  await patch(f.repo.teamEvents, 'te', { status: 'scheduled' });
  assert.equal((await f.call({ section: 'passport' })).items.length, 1);
});

test('仓储故障向调用方暴露；畸形游标明确拒绝；非法首条记录不阻断后续翻页', async () => {
  const f = fixture({ matches: [personal('a', { teamA: ['u', 'v', 'r'] }), personal('b')] });
  const first = await f.call({ section: 'schedule', limit: 1 });
  assert.equal(first.items.length, 0); assert.equal(first.hasMore, true);
  assert.equal((await f.call({ section: 'schedule', limit: 1, cursor: first.nextCursor })).items.length, 1);
  assert.equal((await f.call({ section: 'schedule', cursor: '%bad' })).ok, false);
  assert.equal((await f.call({ section: 'schedule', cursor: 'null' })).ok, false);
  f.repo.personalSports.readPage = async () => { throw new Error('数据库读取失败'); };
  await assert.rejects(f.call({ section: 'schedule' }), /数据库读取失败/);
});

test('学校管理员待办只返回通用审核提醒，普通会员不读取申请集合', async () => {
  const f = fixture({ schoolRoles: [{ _id: schoolRoleKey('u', 'muc'), schoolId: 'muc', userId: 'u', role: 'admin', status: 'active' }],
    schoolMembers: [ { _id: schoolMemberKey('u', 'muc'), schoolId: 'muc', userId: 'u', status: 'active' }, { _id: 'pending', schoolId: 'muc', userId: 'candidate', status: 'pending', realName: '保密申请', studentId: 'SECRET' }] });
  const r = await f.call({ section: 'tasks' });
  assert.equal(r.items[0].target.kind, 'school_identity'); assert.doesNotMatch(JSON.stringify(r), /SECRET|candidate|保密申请/);
  const sources = [];
  const prior = f.repo.personalSports.readPage; f.repo.personalSports.readPage = (...args) => { sources.push(args[0]); return prior(...args); };
  await patch(f.repo.schoolRoles, schoolRoleKey('u', 'muc'), { status: 'revoked' });
  await f.call({ section: 'tasks' }); assert.ok(!sources.includes('membershipReview')); assert.ok(!sources.includes('reviewReport'));
});

test('云数据库聚合契约：每个来源先限定学校/本人或授权，再关联；去重、限量和字段投影在数据库执行', async () => {
  const auth = { schoolId: 'muc', userId: 'u', associations: ['pkb', 'bk'], managedAssociations: ['bk'], collegeScopes: [{ association: 'pkb', collegeId: 'B' }], canReviewMembers: true };
  for (const source of Object.values(SOURCES).flat()) {
    const trace = [];
    const supported = new Set(['eq', 'neq', 'in', 'and', 'or', 'ifNull', 'gte', 'lte', 'size', 'cond', 'first', 'concat']);
    const aggregate = new Proxy({}, { get: (_obj, op) => supported.has(op)
      ? args => ({ [`$${String(op)}`]: args }) : undefined });
    const api = new Proxy({}, { get: (_obj, method) => method === 'end' ? async () => ({ list: [{ _id: 'one' }, { _id: 'two' }] }) : value => { trace.push([method, value]); return api; } });
    const db = { collection: name => { assert.ok(name); return { aggregate: () => api }; } };
    const result = await readPersonalSportsPage(db, { aggregate }, source, auth, { asOf: NOW.toISOString(), limit: 1 });
    assert.equal(trace[0][0], 'match'); assert.equal(trace[0][1].schoolId, 'muc', source);
    assert.equal(result.rows.length, 1); assert.equal(result.hasMore, true);
    assert.ok(trace.findIndex(row => row[0] === 'group') < trace.findIndex(row => row[0] === 'limit'));
    assert.equal(trace.find(row => row[0] === 'limit')[1], 2);
    assert.equal(trace.at(-1)[0], 'project'); assert.ok(!trace.at(-1)[1].roster); assert.ok(!trace.at(-1)[1].published);
    assert.ok(!JSON.stringify(trace).includes('undefined'));
  }
  assert.throws(() => queryPlan('personalSchedule', {}, {}), /范围/);
});

test('已结束赛事的足球报告更正仍可审核；普通会员和已撤权管理员不获得审核待办', async () => {
  const f = fixture({ teamEvents: [teamEvent('finished')], teamMatches: [teamMatch('correction', { status: 'published', footballDraft: { secret: 'draft' }, recordedAt: AT })],
    schoolRoles: [{ _id: schoolRoleKey('u', 'muc'), schoolId: 'muc', userId: 'u', role: 'admin', status: 'active' }] });
  assert.equal((await f.call({ section: 'tasks' })).items[0].state, '待审核报告');
  assert.equal((await f.call({ section: 'tasks' }, 'v')).items.length, 0);
  await patch(f.repo.schoolRoles, schoolRoleKey('u', 'muc'), { status: 'revoked' });
  assert.equal((await f.call({ section: 'tasks' })).items.length, 0);
});

test('大列表每来源最多30行、最终最多30张卡；不批读全校账号且额外一行真实给出hasMore', async () => {
  const f = fixture({ matches: [...Array.from({ length: 101 }, (_, i) => personal(`own${String(i).padStart(3, '0')}`)),
    ...Array.from({ length: 1001 }, (_, i) => personal(`unrelated${i}`, { teamA: ['v'], teamB: ['r'] }))] });
  const prior = f.repo.personalSports.readPage, rows = [], users = [];
  f.repo.personalSports.readPage = async (...args) => { const page = await prior(...args); rows.push(page.rows.length); return page; };
  const byIds = f.repo.users.listByIds; f.repo.users.listByIds = ids => { users.push(...ids); return byIds(ids); };
  const result = await f.call({ section: 'schedule', limit: 999 });
  assert.equal(result.items.length, 30); assert.equal(result.hasMore, true); assert.ok(rows.every(count => count <= 30));
  assert.deepEqual(users.sort(), ['u', 'v']);
});

test('排序时间用实际字段：actedAt 与 hubEvent.finishedAt', () => {
  const auth = { schoolId: 'muc', association: 'pkb', userId: 'u' };
  const query = { asOf: '2026-10-29T00:00:00.000Z' };
  const confirm = JSON.stringify(queryPlan('confirmScore', auth, query));
  assert.match(confirm, /\$actedAt/, '确认比分应按 actedAt 排序');
  assert.doesNotMatch(confirm, /\$recordTime/, '不能再引用不存在的 recordTime');
  const college = JSON.stringify(queryPlan('collegeExperience', auth, query));
  assert.match(college, /\$hubEvent\.finishedAt/, '学院赛经历应按 finishedAt 排序');
  assert.doesNotMatch(college, /\$hubEvent\.finishTime/, '不能再引用不存在的 finishTime');
});
