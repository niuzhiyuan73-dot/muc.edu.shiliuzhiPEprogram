// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { schoolMemberKey, schoolRoleKey, schoolAssociationKey, collegeKey } = require('../miniprogram/utils/school');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push(...['new1', 'new2'].map(id => ({ _id: id, openId: id, platformStatus: 'active', platformRole: 'member' })));
  return createMemoryRepo(seed);
}
const request = (repo, action, payload = {}, openId = 'new1', schoolId = 'muc') => handleSchoolRequest({
  protocolVersion: 2, schoolId, association: 'pkb', action, payload,
}, { repo, openId, now: new Date('2026-10-13T12:00:00Z') });
const apply = (repo, user = 'new1', schoolId = 'muc', studentId = 'NEW001') => request(repo, 'applySchoolMembership', { collegeId: 'c01', studentId }, user, schoolId);
const review = (repo, user = 'new1', schoolId = 'muc', revision = 1) => request(repo, 'reviewSchoolMembership', {
  userId: user, decision: 'approve', revision,
}, `mock_openid_${schoolId}_admin`, schoolId);

test('application, local review, student claim, primary school and private read form a complete flow', async () => {
  const repo = fixture();
  const first = (await apply(repo)).data;
  assert.equal(first.ok, true);
  assert.equal(first.account.status, 'pending');
  assert.equal((await apply(repo)).data.account.revision, 1);
  const rows = (await request(repo, 'getSchoolApplications', {}, 'mock_openid_muc_admin')).data.applications;
  assert.equal(rows.length, 1);
  assert.equal((await review(repo)).data.ok, true);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'muc');
  assert.equal((await request(repo, 'getMySchoolMembership', { userId: 'new2' })).data.account.userId, 'new1');
  const claims = await repo.studentIdClaims.list();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].studentId, undefined);
  assert.ok(!claims[0]._id.includes('NEW001'));
  assert.equal((await review(repo)).data.ok, false);
});

test('same-school duplicate student IDs are denied, including pre-S2 active identities', async () => {
  const repo = fixture();
  await apply(repo, 'new1', 'muc', 'TEST001');
  assert.equal((await review(repo)).data.ok, false);
  await apply(repo, 'new1', 'muc', 'NEW001');
  assert.equal((await review(repo, 'new1', 'muc', 2)).data.ok, true);
  await apply(repo, 'new2');
  assert.equal((await review(repo, 'new2')).data.ok, false);
  assert.equal((await repo.users.getById('new2')).primarySchoolId, undefined);
});

test('identical student IDs are allowed in different schools', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new2', 'buaa');
  assert.equal((await review(repo)).data.ok, true);
  assert.equal((await review(repo, 'new2', 'buaa')).data.ok, true);
  assert.equal((await repo.studentIdClaims.list()).length, 2);
});

test('concurrent school approvals re-read primary identity before committing', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new1', 'buaa');
  const original = repo.transaction;
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) { injected = true; assert.equal((await review(repo, 'new1', 'buaa')).data.ok, true); }
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'buaa');
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'))).status, 'pending');
});

test('student claim protects approvals even when competitor commits after membership list read', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new2');
  const original = repo.transaction;
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) { injected = true; assert.equal((await review(repo, 'new2')).data.ok, true); }
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
  assert.equal((await repo.studentIdClaims.list()).length, 1);
});

test('audit failure rolls back approval, identity pointer and student claim', async () => {
  const repo = fixture();
  await apply(repo);
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => {
    tx.audit.append = async () => { throw new Error('injected audit failure'); };
    return fn(tx);
  });
  await assert.rejects(review(repo), /injected/);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, undefined);
  assert.equal((await repo.studentIdClaims.list()).length, 0);
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'))).status, 'pending');
  repo.transaction = original;
  assert.equal((await review(repo)).data.ok, true);
});

test('stale applications must be refreshed and rejection requires a reason', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new1', 'muc', 'NEW002');
  assert.equal((await review(repo)).data.ok, false);
  const payload = { userId: 'new1', decision: 'reject', revision: 2 };
  assert.equal((await request(repo, 'reviewSchoolMembership', payload, 'mock_openid_muc_admin')).data.ok, false);
  assert.equal((await request(repo, 'reviewSchoolMembership', { ...payload, reason: '信息需核实' }, 'mock_openid_muc_admin')).data.ok, true);
  assert.equal((await apply(repo)).data.account.revision, 4);
});

test('authorization revoked after request context is rechecked inside approval transaction', async () => {
  const repo = fixture();
  await apply(repo);
  const original = repo.transaction;
  repo.transaction = async fn => {
    await repo.schoolRoles.set(schoolRoleKey('demo_muc_admin', 'muc'), {
      userId: 'demo_muc_admin', schoolId: 'muc', role: 'admin', status: 'disabled',
    });
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
});

test('cross-school readers, forged actors and legacy actions cannot use school protocol', async () => {
  const repo = fixture();
  await apply(repo);
  assert.equal((await request(repo, 'getSchoolApplications', { actorId: 'demo_muc_admin' }, 'new1')).data.ok, false);
  assert.equal((await request(repo, 'getSchoolApplications', {}, 'mock_openid_muc_admin', 'buaa')).data.ok, false);
  assert.equal((await request(repo, 'submitMatch')).ok, false);
  assert.equal((await request(repo, 'toString')).ok, false);
  assert.equal((await handleSchoolRequest({ action: 'applySchoolMembership' }, { repo, openId: 'new1' })).ok, false);
  assert.equal((await apply(repo, 'mock_openid_buaa_member', 'muc')).data.ok, false);
});

test('identity client binds school and protocol across interleaved requests', async () => {
  const { forSchoolIdentity } = require('../miniprogram/services/school-cloud');
  const calls = [];
  global.wx = { cloud: { callFunction: async ({ data }) => { calls.push(data); return { result: { ok: true, data: { ok: true } } }; } } };
  try {
    const input = { schoolId: 'muc', association: 'pkb' };
    const a = forSchoolIdentity(input);
    input.schoolId = 'buaa';
    const b = forSchoolIdentity(input);
    await Promise.all([a.getMySchoolMembership(), b.getMySchoolMembership()]);
    assert.deepEqual(calls.map(c => c.schoolId), ['muc', 'buaa']);
    assert.ok(calls.every(c => c.protocolVersion === 2));
  } finally { delete global.wx; }
});

test('school directory is public but exposes only names and IDs of the selected colleges', async () => {
  const repo = fixture();
  const result = (await request(repo, 'getSchoolDirectory', {}, '', 'buaa')).data;
  assert.equal(result.ok, true);
  assert.equal(result.schools.length, 2);
  assert.equal(result.colleges[0].name, '航空学院（模拟）');
  assert.deepEqual(Object.keys(result.schools[0]).sort(), ['name', 'schoolId', 'shortName']);
  assert.deepEqual(Object.keys(result.colleges[0]).sort(), ['collegeId', 'name']);
});

test('unified grant is tiered by identity and cross-school browsing is read-only', async () => {
  const repo = fixture();
  await repo.users.set('platformAdmin', { _id: 'platformAdmin', openId: 'openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin' });
  await apply(repo);
  await review(repo);
  const grant = (payload, openId = 'openid_platform_admin', schoolId = 'muc') =>
    request(repo, 'grantSchoolPermission', payload, openId, schoolId);
  const roster = (openId = 'mock_openid_muc_admin', schoolId = 'muc') =>
    request(repo, 'getSchoolMembers', {}, openId, schoolId);

  // 平台管理员三档全开；校管理员收窄到协会 / 学院两档
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'openid_platform_admin')).data
    .grants.map(g => g.permission), ['schoolAdmin', 'associationLeader', 'collegeLeader']);
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin')).data
    .grants.map(g => g.permission), ['associationLeader', 'collegeLeader']);

  assert.equal((await grant({ userId: 'new1', permission: 'associationLeader', make: true })).data.ok, true);
  let rows = (await roster()).data;
  assert.equal(rows.readOnly, false);
  assert.equal(rows.members.find(m => m.userId === 'new1').permissionLabel, '协会负责人');
  // 升任协会负责人后只剩学院一档可授
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'new1')).data
    .grants.map(g => g.permission), ['collegeLeader']);
  // 学院负责人须落到本校有效学院
  assert.equal((await grant({ userId: 'demo_muc_member', permission: 'collegeLeader', make: true }, 'mock_openid_muc_admin')).data.ok, false);
  assert.equal((await grant({ userId: 'demo_muc_member', permission: 'collegeLeader', make: true, collegeId: 'c01' }, 'mock_openid_muc_admin')).data.ok, true);
  rows = (await roster()).data;
  assert.equal(rows.members.find(m => m.userId === 'demo_muc_member').permission, 'collegeLeader');

  // 跨校只读：可读外校名单，但没有授权入口，也无法越权写入
  const remote = (await roster('mock_openid_muc_admin', 'buaa')).data;
  assert.equal(remote.readOnly, true);
  assert.deepEqual(remote.grants, []);
  assert.ok(remote.members.some(m => m.userId === 'demo_buaa_member'));
  // 第十七轮 P2-1：只读浏览者能看名单，但不该拿到外校的组织架构
  assert.ok(remote.members.every(m => !('permission' in m) && !('permissionLabel' in m)
    && !('managedCollegeId' in m) && !('managedCollegeName' in m)),
  '跨校名录不得下发权限档位与管辖学院');
  assert.equal((await grant({ userId: 'demo_buaa_member', permission: 'collegeLeader', make: true, collegeId: 'c01' }, 'mock_openid_muc_admin', 'buaa')).data.ok, false);
  // 不能给自己指定权限
  assert.equal((await grant({ userId: 'platformAdmin', permission: 'schoolAdmin', make: true })).data.ok, false);
});

test('identity session exposes local review capability without disclosing global account fields', async () => {
  const repo = fixture();
  const local = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin')).data;
  assert.equal(local.canReview, true);
  // user 只含本人账号展示字段（B3：昵称 / 实名 / 性别 / 头像随账号走）与
  // primarySchoolId / platformStatus，不下发 openId / 学号占用等账号隐私。
  assert.deepEqual(Object.keys(local.user).sort(),
    ['avatarUrl', 'gender', 'nickName', 'platformStatus', 'primarySchoolId', 'realName', 'userId']);
  const remote = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin', 'buaa')).data;
  assert.equal(remote.canReview, false);
  assert.equal(remote.account, null);
  const guest = (await request(repo, 'getSchoolIdentitySession', {}, '')).data;
  assert.equal(guest.user, null);
  assert.equal(guest.canReview, false);
});

/* ============================================================
 * 转校（2026-10-16 用户口径：只需**转入学校**的校级管理员同意）
 * ============================================================ */

/** 让某人在某校成为正式会员：申请 + 由该校校管理员审批。 */
async function join(repo, user, schoolId, studentId) {
  await apply(repo, user, schoolId, studentId);
  const res = await request(repo, 'reviewSchoolMembership',
    { userId: user, decision: 'approve', revision: 1 }, `mock_openid_${schoolId}_admin`, schoolId);
  assert.equal(res.data.ok, true, res.data.message);
}

test('转校：申请落在目标学校待审，原学校管理员无权审批', async () => {
  const repo = fixture();
  // new1 已经在民大（原学校），现在要转到北航
  await join(repo, 'new1', 'muc', 'MUC001');
  const applied = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.account.status, 'pending');
  assert.equal(applied.account.transferFrom, 'muc', '申请上记下从哪转来');

  // 目标学校（北航）的待审台账里能看到它，并标明是转校、来自哪所学校
  const pending = (await request(repo, 'getSchoolApplications', {}, 'mock_openid_buaa_admin', 'buaa')).data.applications;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].transfer, true);
  assert.equal(pending[0].transferFromName, '中央民族大学');

  // 原学校（民大）的待审台账里没有这条：转校不需要原学校处理
  const fromSide = (await request(repo, 'getSchoolApplications', {}, 'mock_openid_muc_admin', 'muc')).data.applications;
  assert.deepEqual(fromSide, [], '原学校没有待办');

  // 原学校的校级管理员**不能**审批（用户口径：原学校不需要任何同意）
  const byOldSchool = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: applied.account.revision },
    'mock_openid_muc_admin', 'muc')).data;
  assert.equal(byOldSchool.ok, false, '原学校审批不了');
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'muc', '归属没有被改动');
});

test('转校：目标学校通过后，归属切换、原校身份转出、历史留在原校', async () => {
  const repo = fixture();
  await join(repo, 'new1', 'muc', 'MUC001');
  // 原校给他一个协会负责人身份与一场历史比赛，验证转校后的处理
  await request(repo, 'grantSchoolPermission',
    { userId: 'new1', permission: 'associationLeader', make: true },
    'mock_openid_muc_admin', 'muc');
  await repo.matches.insert({
    _id: 'legacy_match', schoolId: 'muc', association: 'pkb', matchType: 1, pool: 'singles',
    teamA: ['new1'], teamB: ['demo_muc_member'], scoreA: [11], scoreB: [5], winner: 'A',
    status: 1, matchTime: '2026-10-01T10:00:00.000Z', gamePoints: 11, bestOf: 1,
  });
  // 审计读端不在这个仓储里，就在事务里把写进去的条目收下来
  const audits = [];
  const originalTransaction = repo.transaction.bind(repo);
  repo.transaction = fn => originalTransaction(async tx => {
    const append = tx.audit.append.bind(tx.audit);
    tx.audit.append = async entry => { audits.push(entry); return append(entry); };
    return fn(tx);
  });

  const applied = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;

  // 只有目标学校（北航）的管理员能通过
  const approved = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: applied.account.revision },
    'mock_openid_buaa_admin', 'buaa')).data;
  assert.equal(approved.ok, true, approved.message);

  // 账号归属与两侧身份
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'buaa');
  const target = await repo.schoolMembers.getById(schoolMemberKey('new1', 'buaa'));
  assert.equal(target.status, 'active');
  assert.equal(target.transferredFrom, 'muc', '新身份记下从哪转来');
  const source = await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'));
  assert.equal(source.status, 'transferred', '原校身份转出');
  assert.equal(source.transferredTo, 'buaa');

  // 原校的校级角色 / 协会身份停用；新学校从普通会员起步（权限要重新指定）
  const oldRole = await repo.schoolRoles.getById(schoolRoleKey('new1', 'muc'));
  assert.ok(!oldRole || oldRole.status !== 'active');
  const { schoolMembershipKey } = require('../miniprogram/utils/school');
  const oldMembership = await repo.memberships.get(schoolMembershipKey('new1', { schoolId: 'muc', association: 'pkb' }));
  assert.equal(oldMembership.status, 'revoked');

  // 历史记录仍在原学校范围内：比赛没有被搬走，也没有被改
  const legacy = await repo.matches.getById('legacy_match');
  assert.equal(legacy.schoolId, 'muc');
  assert.equal(legacy.teamA[0], 'new1');

  // 两侧各有一条审计：目标校的审批 + 原校的转出备案
  assert.ok(audits.some(row => row.action === 'reviewSchoolTransfer' && row.schoolId === 'buaa'));
  assert.ok(audits.some(row => row.action === 'transferSchoolOut' && row.schoolId === 'muc'));

  // 转校成功后，本人在新学校是正式会员；想回原校要走同样的流程
  const session = (await request(repo, 'getSchoolIdentitySession', {}, 'new1', 'buaa')).data;
  assert.equal(session.account.status, 'active');
  const back = (await request(repo, 'applySchoolMembership',
    { collegeId: 'c01', studentId: 'MUC002' }, 'new1', 'muc')).data;
  assert.equal(back.ok, false, '已有其他学校身份时不能直接入会');
  assert.match(back.message, /转校/);
});

test('转校：驳回 / 撤回都留在原校；重复申请幂等；学号被占拒绝', async () => {
  const repo = fixture();
  await join(repo, 'new1', 'muc', 'MUC001');
  const first = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
  // 幂等：同样内容再提交返回同一条
  const again = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
  assert.equal(again.account.revision, first.account.revision);

  // 驳回：申请人仍在原校
  const rejected = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'reject', reason: '材料不全', revision: first.account.revision },
    'mock_openid_buaa_admin', 'buaa')).data;
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'muc');
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'))).status, 'active');

  // 重新申请后可自行撤回
  const second = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA002' }, 'new1', 'buaa')).data;
  assert.equal(second.ok, true, second.message);
  const canceled = (await request(repo, 'cancelSchoolTransfer', {}, 'new1', 'buaa')).data;
  assert.equal(canceled.ok, true, canceled.message);
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'buaa'))).status, 'rejected');

  // 目标学校学号已被占用：审批时拒绝
  await join(repo, 'new2', 'buaa', 'BUAA003');
  const third = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA003' }, 'new1', 'buaa')).data;
  assert.equal(third.ok, true, third.message);
  const blocked = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: third.account.revision },
    'mock_openid_buaa_admin', 'buaa')).data;
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /学号/);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'muc');
});

test('转校：同时开出的两份申请，第二份必须判为陈旧并作废（不留两份有效会籍）', async () => {
  // 演示种子只有民大与北航两所，这里补第三所目标学校，用于「A→B、A→C 同时申请」
  const seed = createSchoolDemoSeed();
  seed.users.push(
    { _id: 'new1', openId: 'new1', platformStatus: 'active', platformRole: 'member' },
    { _id: 'admin_3', openId: 'mock_openid_buaa2_admin', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'buaa2' },
  );
  seed.schools.push({ _id: 'buaa2', schoolId: 'buaa2', name: '第二目标学校', shortName: '二校', status: 'active', configVersion: 1 });
  seed.schoolAssociations.push({
    _id: schoolAssociationKey({ schoolId: 'buaa2', association: 'pkb' }),
    schoolId: 'buaa2', association: 'pkb', name: '第二目标学校匹克球协会', status: 'active',
  });
  seed.colleges.push({
    _id: collegeKey('buaa2', 'c01'), schoolId: 'buaa2', collegeId: 'c01', name: '二校学院', status: 'active',
  });
  seed.schoolMembers.push({
    _id: schoolMemberKey('admin_3', 'buaa2'), schoolId: 'buaa2', userId: 'admin_3',
    collegeId: 'c01', studentId: 'A3001', status: 'active',
  });
  seed.schoolRoles.push({
    _id: schoolRoleKey('admin_3', 'buaa2'), schoolId: 'buaa2', userId: 'admin_3', role: 'admin', status: 'active',
  });
  const repo = createMemoryRepo(seed);
  await join(repo, 'new1', 'muc', 'MUC001');

  // 同时开 A→B 与 A→C 两份转校申请（目标学校不同，各自一条待审身份行）
  const toB = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
  assert.equal(toB.ok, true, toB.message);
  const toC = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA2_001' }, 'new1', 'buaa2')).data;
  assert.equal(toC.ok, true, toC.message);

  // 先批 B：归属切到 B
  const approvedB = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: toB.account.revision },
    'mock_openid_buaa_admin', 'buaa')).data;
  assert.equal(approvedB.ok, true, approvedB.message);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'buaa');

  // 再批 C：申请里写的是「从 muc 转来」，但本人已归属 buaa —— 必须拒绝
  const approvedC = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: toC.account.revision },
    'mock_openid_buaa2_admin', 'buaa2')).data;
  assert.equal(approvedC.ok, false, '陈旧申请不能被批，否则会留下两份有效会籍');
  assert.match(approvedC.message, /所属学校已变化/);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'buaa', '归属不能被第二份申请改走');

  // C 侧没有留下有效身份；那条申请已被作废（不再挂在待办里点了就报错）
  const atC = await repo.schoolMembers.getById(schoolMemberKey('new1', 'buaa2'));
  assert.equal(atC.status, 'rejected');
  assert.match(atC.reviewReason, /作废/);

  // 原校身份仍是一次性的 transferred，没有被第二份申请重新处理
  const atA = await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'));
  assert.equal(atA.status, 'transferred');
  // B 侧只有一条有效会籍，没有被 C 的申请叠加出第二份
  const atB = await repo.schoolMembers.getById(schoolMemberKey('new1', 'buaa'));
  assert.equal(atB.status, 'active');

  // 重新提交（来源已变成 buaa）就能正常审批
  const retry = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA2_002' }, 'new1', 'buaa2')).data;
  assert.equal(retry.ok, true, retry.message);
  assert.equal(retry.account.transferFrom, 'buaa', '新申请记的是当前归属学校');
});

test('身份 session discloses the actor own permission tier and college-manage ability', async () => {
  const repo = fixture();
  const session = (openId, schoolId = 'muc') =>
    request(repo, 'getSchoolIdentitySession', {}, openId, schoolId).then(res => res.data);

  // 校管理员：校级档，能管本校任意学院（含自己的）
  const admin = await session('mock_openid_muc_admin');
  assert.equal(admin.permission, 'schoolAdmin');
  assert.equal(admin.permissionLabel, '校级管理员');
  assert.equal(admin.canManageCollege, true);

  // 普通会员：无权限档，展示标签退回「会员」，也管不了学院
  const member = await session('mock_openid_muc_member');
  assert.equal(member.permission, '');
  assert.equal(member.permissionLabel, '会员');
  assert.equal(member.canManageCollege, false);

  // 授予学院负责人后：档位与「管得动本学院」同时为真——这正是旧栈会话里
  // 无从分辨、页面推不出来的那一档
  await request(repo, 'grantSchoolPermission',
    { userId: 'demo_muc_member', permission: 'collegeLeader', make: true, collegeId: 'c01' },
    'mock_openid_muc_admin', 'muc');
  const leader = await session('mock_openid_muc_member');
  assert.equal(leader.permission, 'collegeLeader');
  assert.equal(leader.permissionLabel, '学院负责人');
  assert.equal(leader.canManageCollege, true);

  // 跨校只读与访客：不下发权限档，也管不了任何学院
  const remote = await session('mock_openid_muc_admin', 'buaa');
  assert.equal(remote.permission, '');
  assert.equal(remote.permissionLabel, '');
  assert.equal(remote.canManageCollege, false);

  const guest = await session('');
  assert.equal(guest.permission, '');
  assert.equal(guest.canManageCollege, false);
});

/* ============================================================
 * 转校与球队：人走了就不能再挂在校队名单里
 * ============================================================
 * 转校原先只改 school_members 与 memberships，球队是另一套表。留下的人行
 * 会被报名人数算进去、被锁定名单拍进快照，等于让不属于本校的人上场。
 * 这条用例把「转校 → 原学校球队清理」整条链路走一遍。
 * ============================================================ */

test('转校通过后，原学校球队里的队员行自动转为「已离队」', async () => {
  const repo = fixture();
  await apply(repo);
  assert.equal((await review(repo)).data.ok, true);

  // 直接铺一支原学校的篮球队，new1 是队长
  const teamId = 'tm_detach_demo';
  const teamScope = { schoolId: 'muc', association: 'bk' };
  await repo.forScope(teamScope).teams.set(teamId, {
    _id: teamId, schoolId: 'muc', association: 'bk', name: '热浪队',
    captainId: 'new1', status: 'active', createdAt: '2026-10-13T00:00:00Z',
  });
  await repo.forScope(teamScope).teamMembers.set(`${teamId}_new1`, {
    _id: `${teamId}_new1`, schoolId: 'muc', association: 'bk',
    teamId, userId: 'new1', role: 'captain', status: 'active', joinedAt: '2026-10-13T00:00:00Z',
  });

  const applied = (await request(repo, 'applySchoolTransfer',
    { collegeId: 'c01', studentId: 'BUAA001' }, 'new1', 'buaa')).data;
  const approved = (await request(repo, 'reviewSchoolTransfer',
    { userId: 'new1', decision: 'approve', revision: applied.account.revision },
    'mock_openid_buaa_admin', 'buaa')).data;

  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.teams.detached, 1, '应当摘掉一条队员行');

  const row = await repo.forScope(teamScope).teamMembers.getById(`${teamId}_new1`);
  assert.equal(row.status, 'left');
  assert.ok(row.leftAt);

  // 队里一个人都不剩 → 球队归档，不留一支没有队长的活队
  const team = await repo.forScope(teamScope).teams.getById(teamId);
  assert.equal(team.status, 'archived');
});

test('未登录只放行两个公开动作，其余一律要求登录', async () => {
  const repo = fixture();

  // 公开：选校/选院目录、未登录时的 guest 会话（登录页启动就要用）
  assert.equal((await request(repo, 'getSchoolDirectory', {}, '')).data.ok, true);
  assert.equal((await request(repo, 'getSchoolIdentitySession', {}, '')).data.ok, true);

  // 其余一律拒绝。这条规则的意义是「收窄匿名攻击面」：协议 2 的每个动作都要
  // 按 OPENID 解析账号，没有它只会白读「学校 + 协会」两条记录再把权限判死。
  // 新增公开接口必须显式登记到 school-request.js 的 ANON_ACTIONS，否则默认拒绝。
  const guarded = ['getSchoolMembers', 'getSchoolApplications', 'getSchoolRanking',
    'listSchoolEvents', 'applySchoolMembership'];
  for (const action of guarded) {
    const res = await request(repo, action, {}, '');
    assert.equal(res.ok, false, `${action} 未登录应被拒`);
    assert.match(res.message, /请先登录/, `${action} 应给出「请先登录」而不是别的错`);
  }
});
