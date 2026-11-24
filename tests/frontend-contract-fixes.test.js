const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { loadPage, instantiate, withWx, withApi } = require('./helpers/page-harness');
const { pageFileOf } = require('./helpers/page-registry');
const mock = require('../miniprogram/services/school-mock');
const runtime = require('../miniprogram/services/runtime-mode');
const session = require('../miniprogram/services/school-session');
const association = require('../miniprogram/services/association-scope');
const identity = require('../miniprogram/services/school-identity');
const space = require('../miniprogram/services/association-space');
const announcementView = require('../miniprogram/services/announcement-view');
const meet = require('../miniprogram/services/meet');
const SCOPE = { schoolId: 'muc', association: 'pkb' };
const input = value => ({ detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function replace(object, key, fn, run) {
  const prior = object[key]; object[key] = fn;
  try { return await run(); } finally { object[key] = prior; }
}
beforeEach(() => {
  runtime.setDataSource('mock'); mock.reset(); session.reset();
  session.setSchoolId('muc'); association.setAssociation('pkb');
});

for (const decision of ['approve', 'reject']) test(`会员审核页：转校申请走专用接口${decision}，原校身份和目标申请按规则变化`, async () => {
  session.setSchoolId('buaa'); mock.setDemoActor('demo_buaa_admin');
  const page = instantiate(loadPage('member-review'));
  await page.onLoad();
  const row = page.data.view.rows.find(row => row.userId === 'demo_muc_member_2');
  assert.equal(row.transfer, true);
  assert.match(row.transferFromName, /民族/);
  if (decision === 'approve') {
    page.onOpenApprove(tap({ applicationId: row.userId, revision: row.revision }));
    assert.match(page.data.action.title, /转校/);
  } else {
    page.onOpenReject(tap({ applicationId: row.userId, revision: row.revision }));
    page.onInputReason(input('请核对转校资料'));
  }
  await page.onSubmitAction();
  assert.equal(page.data.actionError, '');
  assert.ok(!page.data.view.rows.some(item => item.userId === row.userId));
  mock.setDemoActor(row.userId);
  const target = await identity.forSchoolIdentity({ schoolId: 'buaa', association: 'pkb' }).getSchoolIdentitySession();
  assert.equal(target.user.primarySchoolId, decision === 'approve' ? 'buaa' : 'muc');
  assert.equal(target.account.status, decision === 'approve' ? 'active' : 'rejected');
  if (decision === 'reject') assert.equal(target.account.reviewReason, '请核对转校资料');
});

test('会员审核页：旧版本转校审核被拒，不能误走普通入会接口', async () => {
  session.setSchoolId('buaa'); mock.setDemoActor('demo_buaa_admin');
  const page = instantiate(loadPage('member-review')); await page.onLoad();
  const row = page.data.view.rows[0];
  await page.submitApprove(row.userId, row.revision - 1);
  assert.match(page.data.actionError, /版本|变化|刷新|过期/);
  assert.equal(page.data.view.rows[0].userId, row.userId);
});

test('权限页：选择管理B院，学籍A院保持不变；会话、名册显示管理学院且可撤销', async () => {
  mock.setDemoActor('demo_muc_admin');
  const page = instantiate(loadPage('school-identity')); await page.onLoad();
  const userId = 'demo_muc_member';
  const original = page.data.members.find(row => row.userId === userId).collegeId;
  page.chooseGrant(userId, 'collegeLeader', true);
  assert.ok(page.data.grantEditor);
  const index = page.data.colleges.findIndex(row => row.collegeId !== original);
  const target = page.data.colleges[index].collegeId;
  page.onGrantCollegeChange(input(index)); await page.onConfirmGrant();
  const member = page.data.members.find(row => row.userId === userId);
  assert.equal(member.collegeId, original);
  assert.equal(member.managedCollegeId, target);
  assert.ok(member.managedCollegeName);
  mock.setDemoActor(userId);
  const own = await identity.forSchoolIdentity(SCOPE).getSchoolIdentitySession();
  assert.equal(own.managedCollegeId, target);
  assert.equal(own.account.collegeId, original);
  mock.setDemoActor('demo_muc_admin');
  await page.submitGrant(userId, 'collegeLeader', false);
  assert.equal(page.data.members.find(row => row.userId === userId).managedCollegeId, '');
});

test('学院名单页：学籍A院、授权B院时默认B院并可实际提交；管理员可切换学院', async () => withWx(async () => {
  mock.setDemoActor('demo_muc_admin');
  const api = space.forScope(SCOPE);
  const grant = await identity.forSchoolIdentity(SCOPE).grantSchoolPermission({
    userId: 'demo_muc_member', permission: 'collegeLeader', make: true, collegeId: 'c02',
  });
  assert.equal(grant.ok, true);
  const created = await api.publishCollegeEvent({ requestId: 'frontend-college', title: '授权学院报名测试',
    legPlan: ['MS'], startTime: '2027-01-01T10:00:00Z', rosterMin: 1, rosterMax: 8, courtCount: 1 });
  assert.equal(created.ok, true, created.message);
  mock.setDemoActor('demo_muc_member');
  const page = instantiate(loadPage('college-entry'));
  await page.onLoad({ eventId: created.event.eventId });
  assert.equal(page.data.view.collegeId, 'c02');
  assert.equal(page.data.view.canSubmit, true);
  assert.deepEqual(page.data.view.candidates, [], '打开选择器前不读取全名单');
  const candidatePage = await api.listSchoolMembers({ page: true, collegeId: page.data.view.collegeId, limit: 20 });
  assert.ok(candidatePage.members.some(row => row.userId === 'u10'));
  assert.ok(candidatePage.members.every(row => row.collegeId === 'c02'));
  page.onToggleMember(input(['u10'])); await page.onSubmit();
  assert.equal(page.data.submitting, false);
  const entries = await api.listCollegeEntries({ eventId: created.event.eventId });
  assert.ok(entries.entries.some(row => row.memberIds.includes('u10')));
  await page.onLoad({ eventId: created.event.eventId, collegeId: 'c01' });
  assert.equal(page.data.view.canSubmit, false, '显式请求未获授权学院必须拒绝');
  assert.deepEqual(page.data.view.candidates, []);
  mock.setDemoActor('demo_muc_admin');
  await page.onLoad({ eventId: created.event.eventId });
  const index = page.data.view.collegeOptions.findIndex(row => row.collegeId === 'c03');
  await page.onCollegeChange(input(index));
  assert.equal(page.data.view.collegeId, 'c03');
  assert.equal(page.data.view.canSubmit, true);
}));

test('跨校页面：目录三校仍能选两校或三校、独立配额；网络重试复用请求号', async () => {
  const page = instantiate(loadPage('school-exchange'));
  page.data.loading = false; page.data.canCreate = true; page.data.date = '2027-01-01';
  page.data.schools = ['muc', 'buaa', 'third'].map(schoolId => ({ schoolId, name: schoolId }));
  page.data.schoolChoices = page.data.schools.map(row => ({ ...row, quota: '2', selected: false }));
  page.onSchoolSelection(input(['buaa']));
  assert.deepEqual(page.data.selectedSchoolIds, ['muc', 'buaa']);
  const calls = [];
  page.api = { createExchangeEvent: async payload => { calls.push(payload); throw new Error('网络暂不可用'); } };
  await page.onCreate(); await page.onCreate();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.deepEqual(calls[0].participantSchoolIds, ['muc', 'buaa']);
  page.onSchoolSelection(input(['buaa', 'third']));
  page.onSchoolQuota({ ...input('3'), currentTarget: { dataset: { schoolid: 'third' } } });
  await page.onCreate();
  assert.deepEqual(calls[2].schoolQuotas, { muc: 2, buaa: 2, third: 3 });
  assert.notEqual(calls[2].requestId, calls[0].requestId);
  page.data.quota = '128'; await page.onCreate();
  assert.equal(calls.length, 3, '各校配额不足时在页面拒绝');
  assert.match(page.data.error, /合计/);
});

test('跨校页面：主办校不能去除，超过八校拒绝；单校和非整数名额拒绝', async () => {
  const page = instantiate(loadPage('school-exchange'));
  page.data.canCreate = true;
  page.data.schools = ['muc', ...Array.from({ length: 8 }, (_, i) => `s${i}`)].map(schoolId => ({ schoolId }));
  page.data.schoolChoices = page.data.schools.map(row => ({ ...row, quota: '2' }));
  page.onSchoolSelection(input(['s0']));
  page.onSchoolSelection(input(page.data.schools.map(row => row.schoolId)));
  assert.match(page.data.error, /最多/);
  assert.deepEqual(page.data.selectedSchoolIds, ['muc', 's0']);
  page.onSchoolSelection(input([])); page.onCreate();
  assert.deepEqual(page.data.selectedSchoolIds, ['muc']);
  assert.match(page.data.error, /2 至 8/);
  page.onSchoolSelection(input(['s0']));
  page.onSchoolQuota({ ...input('1.5'), currentTarget: { dataset: { schoolid: 's0' } } });
  page.onCreate(); assert.match(page.data.error, /正整数/);
});

test('跨校三校表单实际写入服务端：主办校自动接受，两所受邀校待确认，配额保持独立', async () => {
  const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
  const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
  const { buildSchoolContext } = require('../src/server/services/school-context');
  const { schoolAssociationKey } = require('../src/shared/utils/school');
  const backend = require('../src/server/services/exchange-service');
  const seed = createSchoolDemoSeed();
  seed.schools.push({ _id: 'third', schoolId: 'third', name: '第三所大学', status: 'active' });
  seed.schoolAssociations.push({ _id: schoolAssociationKey({ schoolId: 'third', association: 'pkb' }),
    schoolId: 'third', association: 'pkb', status: 'active' });
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  const page = instantiate(loadPage('school-exchange'));
  page.data.loading = false; page.data.canCreate = true; page.data.date = '2027-01-01';
  page.data.schools = ['muc', 'buaa', 'third'].map(schoolId => ({ schoolId }));
  page.data.schoolChoices = page.data.schools.map((row, i) => ({ ...row, quota: String(i + 1) }));
  page.onSchoolSelection(input(['third', 'buaa']));
  let result;
  page.api = { createExchangeEvent: async payload => { result = (await backend.createExchangeEvent(payload, ctx)).data; return result; } };
  page.reload = async () => {};
  await page.onCreate();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.event.invitations, { buaa: 'pending', muc: 'accepted', third: 'pending' });
  assert.deepEqual(result.event.schoolQuotas, { buaa: 2, muc: 1, third: 3 });
});

const publicView = (ids, extra = {}) => ({ rows: ids.map(id => ({ id })), total: 3,
  visibleCount: ids.length, hasMore: false, nextCursor: '', ...extra });
test('公告页：续页去重、失败重试、刷新后旧续页及卸载回调均不回写', async () => {
  let pending, mode = 'first';
  await replace(announcementView, 'loadSchoolAnnouncementListView', async options => {
    if (mode === 'first') return publicView(['a'], { hasMore: true, nextCursor: 'one' });
    if (mode === 'fail') throw Error('离线');
    if (mode === 'next') { assert.equal(options.cursor, 'one'); return publicView(['a', 'b']); }
    return pending.promise;
  }, async () => {
    const page = instantiate(loadPage('announcements')); await page.onLoad();
    mode = 'fail'; await page.loadMore();
    assert.deepEqual(page.data.view.rows.map(row => row.id), ['a']);
    assert.equal(page.data.loadingMore, false); assert.match(page.data.moreError, /离线/);
    mode = 'next'; await page.loadMore();
    assert.deepEqual(page.data.view.rows.map(row => row.id), ['a', 'b']);
    mode = 'first'; await page.refresh();
    mode = 'pending'; pending = deferred(); const old = page.loadMore();
    mode = 'first'; await page.refresh();
    pending.resolve(publicView(['stale'])); await old;
    assert.deepEqual(page.data.view.rows.map(row => row.id), ['a']);
    mode = 'pending'; pending = deferred(); const late = page.loadMore();
    page.onUnload(); const snapshot = JSON.stringify(page.data);
    pending.resolve(publicView(['late'])); await late;
    assert.equal(JSON.stringify(page.data), snapshot);
  });
});

test('公告页：两次刷新逆序返回保留新数据，整页失败清旧数据', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  await replace(announcementView, 'loadSchoolAnnouncementListView', () => (++count === 1 ? first.promise : second.promise), async () => {
    const page = instantiate(loadPage('announcements'));
    const a = page.onLoad(), b = page.refresh();
    second.resolve(publicView(['new'])); await b;
    first.resolve(publicView(['old'])); await a;
    assert.equal(page.data.view.rows[0].id, 'new');
  });
  await replace(announcementView, 'loadSchoolAnnouncementListView', async () => { throw Error('offline'); }, async () => {
    const page = instantiate(loadPage('announcements')); page.data.view = publicView(['old']);
    await page.onLoad(); assert.deepEqual(page.data.view, {}); assert.ok(page.data.error);
  });
});

test('公告管理续页：撤权时关闭整份台账，不能留旧下架记录', async () => {
  let count = 0;
  await replace(announcementView, 'loadSchoolAnnouncementManageView', async () => ++count === 1
    ? { ...publicView(['archived'], { hasMore: true, nextCursor: 'one' }), allowed: true }
    : { ...publicView([]), allowed: false, blockedText: '权限已失效' }, async () => {
    mock.setDemoActor('demo_muc_admin');
    const page = instantiate(loadPage('announcement-manage')); await page.onLoad(); await page.loadMore();
    assert.equal(page.data.view.allowed, false); assert.deepEqual(page.data.view.rows, []);
  });
});

test('运动会筛选：旧筛选响应与权限不能覆盖新筛选，失败响应也不能盖住新列表', async () => {
  const a = deferred(), b = deferred(); let count = 0;
  await replace(meet, 'forScope', () => ({ listSportsMeets: () => ++count === 1 ? a.promise : b.promise }), async () => {
    const page = instantiate(loadPage('meet-list'));
    const first = page.onLoad(); const second = page.onStatusChange(input(1));
    b.resolve({ ok: true, items: [{ meetId: 'new' }], total: 1, permissions: { canManage: false } }); await second;
    a.resolve({ ok: true, items: [{ meetId: 'old' }], total: 99, permissions: { canManage: true } }); await first;
    assert.equal(page.data.items[0].meetId, 'new'); assert.equal(page.data.canManage, false);
    assert.equal(page.data.loading, false);
  });
});

test('运动会续页：改关键词和卸载均丢弃在途结果，输入后不会一直忙碌', async () => {
  const pending = deferred();
  await replace(meet, 'forScope', () => ({ listSportsMeets: () => pending.promise }), async () => {
    const page = instantiate(loadPage('meet-list'));
    page.data.loading = false; page.data.items = [{ meetId: 'first' }]; page.data.hasMore = true;
    const loading = page.loadMore(); page.onKeywordInput(input('新赛季'));
    assert.equal(page.data.busy, false); assert.equal(page.data.loading, false);
    pending.resolve({ ok: true, items: [{ meetId: 'stale' }], total: 100 }); await loading;
    assert.equal(page.data.items.length, 1);
    page.data.hasMore = true; const late = deferred();
    meet.forScope = () => ({ listSportsMeets: () => late.promise });
    const request = page.loadMore(); page.onUnload(); const snapshot = JSON.stringify(page.data);
    late.resolve({ ok: true, items: [{ meetId: 'late' }], total: 100 }); await request;
    assert.equal(JSON.stringify(page.data), snapshot);
  });
});

test('赛事表单容量：单打88/双打176与服务端共用，上限外在本地阻止提交', async () => {
  await withApi({ publishSchoolEvent: () => { throw Error('不得提交超额表单'); } }, async calls => {
    const page = instantiate(loadPage('event-edit')); page.data.blockReason = '';
    assert.equal(page.data.capacity, 88);
    page.onInputQuota(input('89')); await page.onSubmit();
    assert.match(page.data.errors.quota, /88/); assert.equal(calls.length, 0);
    page.onPickMatchType(input(1)); assert.equal(page.data.capacity, 176);
    page.onInputQuota(input('177')); await page.onSubmit();
    assert.match(page.data.errors.quota, /176/); assert.equal(calls.length, 0);
  });
});

test('赛事容量：服务端超额返回字段级错误，报名限制原因完整进入详情视图', async () => {
  mock.setDemoActor('demo_muc_admin');
  const response = await space.forScope(SCOPE).publishSchoolEvent({ requestId: 'quota-field', title: '超大赛事',
    quota: 256, matchType: 1, level: 3, format: 'single_elim',
    bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
    startTime: '2027-01-01T10:00:00Z', courtCount: 1 });
  assert.equal(response.ok, false); assert.match(response.errors.quota, /88/);
  const { buildDetailView } = require('../miniprogram/services/school-event-view');
  const view = buildDetailView({ dto: { ok: true, event: { eventId: 'e', title: '赛事', status: 0 },
    signupNote: '本次赛事仅限指定小组成员报名' } });
  assert.equal(view.signupNote, '本次赛事仅限指定小组成员报名');
});

test('首页团队赛事导航：使用团队详情路由，编号只编码一次；个人赛事入口保留', async () => withWx(async ({ navigations }) => {
  const page = instantiate(loadPage('index')); page.switchTo = () => {};
  page.onOpenEvent(tap({ eventId: '队赛:一', association: 'fb', eventKind: 'team' }));
  page.onOpenEvent(tap({ eventId: '个人:一', association: 'tt', eventKind: 'individual' }));
  assert.equal(navigations[0], `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent('队赛:一')}`);
  assert.match(navigations[1], /packageEvent\/event-detail/);
}));

test('审核待办：两处页面保留hasMore并显示本批提示，非模拟只读学校不标为演示', async () => {
  const reviewView = require('../miniprogram/services/school-member-review-view');
  await replace(identity, 'forSchoolIdentity', () => ({
    getSchoolIdentitySession: async () => ({ ok: true, canReview: true, user: { userId: 'admin' } }),
    getSchoolApplications: async () => ({ ok: true, applications: [], hasMore: true }),
    getSchoolDirectory: async () => ({ ok: true, schools: [{ schoolId: 'muc', name: '民大' }], colleges: [] }),
    getSchoolMembers: async () => ({ ok: true, members: [], grants: [] }),
  }), async () => {
    const view = await reviewView.loadSchoolMemberReviewView(SCOPE); assert.equal(view.hasMore, true);
    const page = instantiate(loadPage('school-identity')); await page.onLoad(); assert.equal(page.data.applicationsHasMore, true);
  });
  const memberWxml = readFileSync(pageFileOf('member-review', '.wxml'), 'utf8');
  assert.match(memberWxml, /view\.hasMore/);
  assert.match(readFileSync(pageFileOf('school-identity', '.wxml'), 'utf8'), /applicationsHasMore/);
  assert.doesNotMatch(readFileSync(pageFileOf('association', '.wxml'), 'utf8'), /外校.*演示|演示.*只读/);
  assert.match(readFileSync(pageFileOf('event-detail', '.wxml'), 'utf8'), /view\.signupNote/);
} );
