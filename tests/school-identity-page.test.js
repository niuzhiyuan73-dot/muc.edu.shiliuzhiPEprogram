const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../miniprogram/services/runtime-mode');
const mock = require('../src/mock/school-mock.js');
const service = require('../miniprogram/services/school-identity');
const scope = require('../miniprogram/services/association-scope');

function page() {
  let definition;
  const prior = global.Page;
  global.Page = value => { definition = value; };
  const path = require.resolve('../miniprogram/packageMember/school-identity/school-identity');
  delete require.cache[path];
  try { require(path); } finally { global.Page = prior; }
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values); } };
}
const select = value => ({ detail: { value } });
const reviewEvent = decision => ({ currentTarget: { dataset: { userId: 'demo_applicant', decision } } });
/** 页面不再带体验身份切换器，用例直接设定身份后让页面重取（默认身份跟随 mock.js）。 */
async function switchActor(p, name) { mock.setDemoActor(name); await p.reload(); }
async function submit(p) {
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  await p.onApply();
}
beforeEach(() => { runtime.setDataSource('mock'); mock.reset(); scope.setAssociation('tt'); });

test('page supports Beihang application and local-admin approval without changing old association', async () => {
  mock.setDemoActor('demo_applicant');
  const p = page();
  await p.onLoad();
  assert.equal(p.data.canApply, true);
  await p.onSchoolChange(select(1));
  assert.equal(p.data.schoolName, '北京航空航天大学');
  await submit(p);
  assert.equal(p.data.statusText, '待审核');
  await switchActor(p, 'demo_muc_admin');
  assert.equal(p.data.canReview, false);
  assert.deepEqual(p.data.applications, []);
  await switchActor(p, 'demo_buaa_admin');
  assert.equal(p.data.canReview, true);
  // 待审列表里有两条：本用例刚提交的那条，加上演示种子预置的「民大会员二 → 北航」
  // 转校申请（2026-10-16 起，见 school-seed.demoTransferApplication）。两条同表，
  // 所以这里按 userId 取自己那条，而不是按下标。
  assert.equal(p.data.applications.length, 2);
  const mine = p.data.applications.find(row => row.userId === 'demo_applicant');
  assert.equal(mine.nickName, '模拟申请人');
  assert.ok(p.data.applications.some(row => row.userId === 'demo_muc_member_2' && row.transfer === true),
    '预置的转校待办也应出现在北航管理员的待审列表里');
  await p.onReview(reviewEvent('approve'));
  // 只审掉自己那条，预置的转校待办不受影响（各是各的申请）
  assert.deepEqual(p.data.applications.map(row => row.userId), ['demo_muc_member_2']);
  await switchActor(p, 'demo_applicant');
  assert.equal(p.data.statusText, '已通过');
  assert.equal(p.data.canApply, false);
  await p.onSchoolChange(select(0));
  assert.equal(p.data.canApply, false);
  assert.match(p.data.notice, /转校/);
  assert.equal(scope.getAssociation(), 'tt');
});

test('rejection requires a reason, returns it to applicant and allows resubmission', async () => {
  mock.setDemoActor('demo_applicant');
  const p = page();
  await p.onLoad();
  await submit(p);
  await switchActor(p, 'demo_muc_admin');
  await p.onReview(reviewEvent('reject'));
  assert.match(p.data.error, /理由/);
  p.onReasonInput({ currentTarget: { dataset: { userId: 'demo_applicant' } }, detail: { value: '请核实学号' } });
  await p.onReview(reviewEvent('reject'));
  await switchActor(p, 'demo_applicant');
  assert.equal(p.data.statusText, '已驳回');
  assert.equal(p.data.account.reviewReason, '请核实学号');
  await submit(p);
  assert.equal(p.data.statusText, '待审核');
  assert.equal(p.data.account.revision, 3);
});

test('duplicate clicks submit once and source scope is locked while writing', async () => {
  mock.setDemoActor('demo_applicant');
  const p = page();
  await p.onLoad();
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  const original = p.api;
  let release;
  let calls = 0;
  p.api = { ...original, applySchoolMembership: async fields => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return original.applySchoolMembership(fields);
  } };
  const pending = p.onApply();
  await p.onApply();
  await p.onSchoolChange(select(1));
  assert.equal(p.data.schoolId, 'muc');
  release();
  await pending;
  assert.equal(calls, 1);
  assert.equal(p.data.statusText, '待审核');
  assert.equal(p.data.submitting, false);
});

test('failed write releases button state and retains editable form', async () => {
  mock.setDemoActor('demo_applicant');
  const p = page();
  await p.onLoad();
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  p.api = { applySchoolMembership: async () => { throw new Error('offline'); } };
  await p.onApply();
  assert.equal(p.data.error, 'offline');
  assert.equal(p.data.submitting, false);
  assert.equal(p.data.studentId, 'NEW003');
  assert.equal(p.data.canApply, true);
});

test('older responses and unloaded page do not overwrite the latest scope', async () => {
  const p = page();
  await p.onLoad();
  const original = service.forSchoolIdentity;
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  service.forSchoolIdentity = target => {
    const api = original(target);
    return target.schoolId === 'muc' ? { ...api, getSchoolIdentitySession: async () => {
      await delayed;
      return api.getSchoolIdentitySession();
    } } : api;
  };
  try {
    const stale = p.reload();
    await p.onSchoolChange(select(1));
    release();
    await stale;
    assert.equal(p.data.schoolId, 'buaa');
    assert.equal(p.data.schoolName, '北京航空航天大学');
    const pending = p.reload();
    p.onUnload();
    const saved = JSON.stringify(p.data);
    await pending;
    assert.equal(JSON.stringify(p.data), saved);
  } finally { service.forSchoolIdentity = original; }
});

test('demo client binds actor at creation and serializes competing approvals', async () => {
  mock.setDemoActor('demo_applicant');
  const applicant = mock.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  await applicant.applySchoolMembership({ collegeId: 'c01', studentId: 'NEW100' });
  mock.setDemoActor('demo_muc_admin');
  const admin = mock.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  assert.equal((await applicant.getSchoolIdentitySession()).user.userId, 'demo_applicant');
  const results = await Promise.all([1, 2].map(() => admin.reviewSchoolMembership({ userId: 'demo_applicant', revision: 1, decision: 'approve' })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await applicant.getMySchoolMembership()).account.status, 'active');
});

test('cloud mode hides demo controls and prevents demo actor selection', async () => {
  runtime.setDataSource('cloud');
  assert.deepEqual(service.getDemoActors(), []);
  assert.throws(() => service.setDemoActor('demo_muc_admin'));
  runtime.setDataSource('mock');
});

test('unified grant entry lets a school admin assign an association role', async () => {
  const p = page();
  await p.onLoad();
  await switchActor(p, 'demo_muc_admin'); // 民大校管理员
  assert.deepEqual(p.data.grants.map(g => g.permission), ['associationLeader', 'collegeLeader']);
  assert.ok(p.data.members.some(m => m.userId === 'demo_muc_member'));
  await p.onGrant({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });
  const member = p.data.members.find(m => m.userId === 'demo_muc_member');
  assert.equal(member.permission, 'associationLeader');
  assert.equal(member.permissionLabel, '协会负责人');
});

test('platform admin sees all three grants and cross-school browsing stays read-only', async () => {
  const p = page();
  await p.onLoad();
  await switchActor(p, 'demo_platform_admin'); // 平台管理员
  assert.deepEqual(p.data.grants.map(g => g.permission), ['schoolAdmin', 'associationLeader', 'collegeLeader']);
  assert.equal(p.data.readOnly, false);
  await switchActor(p, 'demo_muc_admin'); // 民大校管理员
  await p.onSchoolChange(select(1)); // 切到北航
  assert.equal(p.data.readOnly, true);
  assert.deepEqual(p.data.grants, []);
  assert.ok(p.data.members.some(m => m.userId === 'demo_buaa_member'));
});
