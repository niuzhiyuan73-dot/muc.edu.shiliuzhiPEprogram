const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/association-group-service');
const { schoolMembershipKey, schoolMemberKey, associationGroupMemberKey } = require('../src/shared/utils/school');

const NOW = new Date('2026-10-13T10:00:00Z');

/** 在演示种子上补平台管理员、第三个民大会员，并给民大会员一个负责人身份。 */
function fixture({ leader = false } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  seed.users.push({ _id: 'demo_muc_other', openId: 'mock_openid_muc_other', nickName: '民大第三会员',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_other', 'muc'), userId: 'demo_muc_other',
    schoolId: 'muc', collegeId: 'c02', studentId: 'TEST003', status: 'active', simulated: true });
  if (leader) {
    seed.memberships.push({ _id: schoolMembershipKey('demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'leader', status: 'active' });
  }
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

async function createGroup(repo, fields = {}, actor = 'demo_muc_admin', schoolId = 'muc') {
  const result = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r1', ...fields }, actor, schoolId);
  assert.equal(result.ok, true, result.message);
  return result.group;
}

const revisionOf = async (repo, groupId) => (await repo.associationGroups.getById(groupId)).revision;
const countOf = async (repo, groupId) => (await repo.associationGroups.getById(groupId)).memberCount;
const repoGroups = async (repo) => (await repo.associationGroups.list()).filter(doc => !doc.nameClaim).length;

test('权限矩阵：只有学校管理员、协会负责人与平台管理员能建立小组', async () => {
  const plain = fixture();
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_muc_member')).ok,
    false, '普通会员不能建组');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_buaa_admin')).ok,
    false, '外校管理员不能在本校建组');
  assert.equal((await repoGroups(plain)), 0, '被拒时无写入');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' })).ok, true, '本校管理员可建组');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '平台组', requestId: 'r3' }, 'demo_platform_admin', 'buaa')).ok,
    true, '平台管理员可跨校建组');

  const led = fixture({ leader: true });
  assert.equal((await call(led, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_muc_member')).ok,
    true, '协会负责人可建组');
});

test('读取名录：本校会员与平台管理员可读，外校会员被拒绝', async () => {
  const repo = fixture();
  await createGroup(repo, { name: '新手组', requestId: 'r1' });
  assert.equal((await call(repo, 'listAssociationGroups', {}, 'demo_muc_member')).ok, true, '本校会员可读');
  const cross = await call(repo, 'listAssociationGroups', {}, 'demo_buaa_member', 'muc');
  assert.equal(cross.ok, false, '外校会员不可读别协会空间');
  assert.deepEqual(cross.groups, []);
  const asPlatform = await call(repo, 'listAssociationGroups', {}, 'demo_platform_admin', 'muc');
  assert.equal(asPlatform.ok, true, '平台管理员可跨校读');
});

test('建组幂等：同请求编号重试返回同一组，改内容则拒绝', async () => {
  const repo = fixture();
  const first = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const retry = await call(repo, 'createAssociationGroup',
    { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal(retry.ok, true);
  assert.equal(retry.group.groupId, first.groupId);
  assert.equal((await repo.associationGroups.list()).filter(doc => !doc.nameClaim).length, 1, '只落一组');
  const changed = await call(repo, 'createAssociationGroup', { name: '校队组', requestId: 'r1' });
  assert.equal(changed.ok, false, '同编号换内容被拒');
});

test('同范围不重名：同名不同请求编号被拒，换学校/协会则允许', async () => {
  const repo = fixture();
  await createGroup(repo, { name: '新手组', requestId: 'r1' });
  const dup = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r2' });
  assert.equal(dup.ok, false, '同范围同名被拒');
  const otherSchool = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r2' }, 'demo_buaa_admin', 'buaa');
  assert.equal(otherSchool.ok, true, '别校同名互不影响');
  const otherSport = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r3' }, 'demo_muc_admin', 'muc', 'tt');
  assert.equal(otherSport.ok, true, '同校别协会同名互不影响');
});

test('重命名释放旧名占位，旧名可被新组复用', async () => {
  const repo = fixture();
  const a = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  const b = await createGroup(repo, { name: '校队组', requestId: 'r2' });
  assert.equal((await call(repo, 'updateAssociationGroup',
    { groupId: a.groupId, name: '校队组', description: '', expectedRevision: await revisionOf(repo, a.groupId) })).ok,
    false, '改成已存在的名字被拒');
  assert.equal((await call(repo, 'updateAssociationGroup',
    { groupId: a.groupId, name: '精英组', description: '进阶', expectedRevision: await revisionOf(repo, a.groupId) })).ok,
    true, '改名成功');
  const reused = await createGroup(repo, { name: '新手组', requestId: 'r3' });
  assert.notEqual(reused.groupId, a.groupId, '旧名被释放后新组可用');
  assert.notEqual(b.groupId, reused.groupId);
});

test('成员增减幂等：重复加入/移除人数最多变一次', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal(await countOf(repo, group.groupId), 1);
  const again = await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_member'] });
  assert.equal(again.ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复加入不增加人数');
  const two = await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_other', 'demo_muc_other'] });
  assert.equal(two.ok, true);
  assert.equal(await countOf(repo, group.groupId), 2, '去重后只加一个');
  assert.equal((await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId: 'demo_muc_member' })).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1);
  assert.equal((await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId: 'demo_muc_member' })).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复移除不减少人数');
});

test('本人退出只影响自己，且重复退出幂等', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member', 'demo_muc_other'] });
  assert.equal(await countOf(repo, group.groupId), 2);
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1);
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复退出不影响别人');
  // 非组员的普通会员退出也不报错，只是无变化
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_buaa_member', 'buaa')).ok, false);
});

test('入组只收本协会在册会员，超员与非法清单直接拒绝', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_buaa_member'] })).ok,
    false, '外校会员不能入组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['ghost'] })).ok,
    false, '不存在的人不能入组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: [] })).ok,
    false, '空清单被拒');
  assert.equal((await call(repo, 'addAssociationGroupMembers',
    { groupId: group.groupId, memberIds: Array.from({ length: 51 }, (_, i) => `m${i}`) })).ok, false, '超过单次上限');
  assert.equal(await countOf(repo, group.groupId), 0, '拒绝时无写入');
});

test('归档后禁止编辑与增员，允许成员退出，归档本身幂等', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal((await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: await revisionOf(repo, group.groupId) })).ok, true);
  assert.equal((await repo.associationGroups.getById(group.groupId)).status, 'archived');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_other'] })).ok, false, '归档禁止增员');
  assert.equal((await call(repo, 'updateAssociationGroup', { groupId: group.groupId, name: '改名', description: '', expectedRevision: 9 })).ok, false, '归档禁止编辑');
  assert.equal((await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: 9 })).ok, true, '重复归档幂等');
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true, '归档仍可退出');
});

test('名单可见性：管理者与组员可见，非组员只看组信息', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const asManager = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_admin');
  assert.equal(asManager.canReadRoster, true);
  assert.deepEqual(asManager.members.map(row => row.userId), ['demo_muc_member']);
  assert.deepEqual(Object.keys(asManager.members[0]).sort(),
    ['collegeId', 'collegeName', 'nickName', 'permissionLabel', 'userId'], '成员字段脱敏');
  const asMember = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_member');
  assert.equal(asMember.canReadRoster, true, '组员可见名单');
  const asOutsider = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_other');
  assert.equal(asOutsider.canReadRoster, false, '非组员看不到名单');
  assert.deepEqual(asOutsider.members, []);
  assert.equal(asOutsider.group.name, '新手组', '组基本信息仍可见');
});

test('跨校跨协会隔离：别校/别协会读不到也改不了本组', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal((await call(repo, 'listAssociationGroups', {}, 'demo_buaa_admin', 'buaa')).groups.length, 0, '别校列表为空');
  // 同校别协会（乒乓球）能读自己的空间，但看不到本协会（匹克球）的小组——数据不串台。
  assert.deepEqual((await call(repo, 'listAssociationGroups', {}, 'demo_muc_admin', 'muc', 'tt')).groups, []);
  assert.equal((await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_buaa_admin', 'buaa')).ok,
    false, '外校读不到别校组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_buaa_member'] },
    'demo_buaa_admin', 'buaa')).ok, false, '外校不能改别校组');
});

test('并发：同名建组只成功一个，并发增员人数不丢更新', async () => {
  const repo = fixture();
  const both = await Promise.all([1, 2].map((n) => call(repo, 'createAssociationGroup', { name: '新手组', requestId: `r${n}` })));
  assert.equal(both.filter(row => row.ok).length, 1, '并发建同名只成功一个');
  const groupId = both.find(row => row.ok).group.groupId;

  const added = await Promise.all(['demo_muc_member', 'demo_muc_other'].map((userId) =>
    call(repo, 'addAssociationGroupMembers', { groupId, memberIds: [userId] })));
  assert.equal(added.filter(row => row.ok).length, 2);
  assert.equal(await countOf(repo, groupId), 2, '并发增员人数不丢更新');

  const sameTwice = await Promise.all([1, 2].map(() =>
    call(repo, 'addAssociationGroupMembers', { groupId, memberIds: ['demo_buaa_member'] })));
  assert.equal(sameTwice.every(row => row.ok === false), true, '不合格成员并发也被拒');
  assert.equal(await countOf(repo, groupId), 2);
});

test('建组校验：组名长度、请求编号与不存在的成员都会拒绝且不落库', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'createAssociationGroup', { name: 'x', requestId: 'r1' })).ok, false, '组名太短');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '组'.repeat(31), requestId: 'r1' })).ok, false, '组名太长');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'bad id!' })).ok, false, '编号非法');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r1', memberIds: ['ghost'] })).ok,
    false, '含不合格成员');
  assert.equal((await repo.associationGroups.list()).length, 0, '全部拒绝时无写入');
});

/* ------------------------------------------------------------------ 删除整个小组 */

test('复现用户现象：成员被移空的小组仍在列表里，但现在可以被删除', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '复现小组', requestId: 'repro', memberIds: ['demo_muc_member', 'demo_muc_other'] });
  for (const userId of ['demo_muc_member', 'demo_muc_other']) {
    assert.equal((await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId })).ok, true);
  }
  const emptied = await call(repo, 'getAssociationGroup', { groupId: group.groupId });
  assert.equal(emptied.group.memberCount, 0);
  assert.equal(emptied.group.status, 'active', '移空成员不等于删组——用户看到的正是这一条');
  assert.equal((await call(repo, 'listAssociationGroups', {})).groups.length, 1);

  const deleted = await call(repo, 'deleteAssociationGroup',
    { groupId: group.groupId, expectedRevision: await revisionOf(repo, group.groupId) });
  assert.equal(deleted.ok, true, deleted.message);
  assert.equal((await call(repo, 'listAssociationGroups', {})).groups.length, 0, '删得掉：列表里不再有这个空组');
});

test('删除小组：从列表消失、成员关系不再 ACTIVE、组名可重建、审计留痕', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member', 'demo_muc_other'] });
  const before = await revisionOf(repo, group.groupId);

  const deleted = await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: before });
  assert.equal(deleted.ok, true, deleted.message);
  assert.equal(deleted.deleted, true, '标记本次真的改了数据');

  // 软删除：文档还在，状态与留痕落地（仓储没有 remove，也不做物理删除）
  const doc = await repo.associationGroups.getById(group.groupId);
  assert.equal(doc.status, 'deleted');
  assert.equal(doc.revision, before + 1);
  assert.equal(doc.memberCount, 0);
  assert.equal(doc.deletedBy, 'demo_muc_admin');
  assert.ok(doc.deletedAt, '删除时间落库');

  // 读接口：列表不再列出，详情视为不存在
  assert.deepEqual((await call(repo, 'listAssociationGroups', {}, 'demo_muc_member')).groups, [], '列表里不再出现');
  const detail = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_member');
  assert.equal(detail.ok, false);
  assert.equal(detail.message, '小组不存在');

  // 成员关系全部结束，训练 / 赛事的限组资格随之失效
  const relations = (await repo.associationGroupMembers.list()).filter(row => row.groupId === group.groupId);
  assert.equal(relations.length, 2);
  assert.equal(relations.every(row => row.status === 'removed'), true, '不再有 ACTIVE 关系');
  assert.equal(relations.every(row => row.removedAt && row.removedBy === 'demo_muc_admin'), true, '移除留痕');

  // 组名占位释放：同名可以重建，且拿到新的组编号
  const rebuilt = await createGroup(repo, { name: '新手组', requestId: 'r2' });
  assert.notEqual(rebuilt.groupId, group.groupId);
  assert.deepEqual((await call(repo, 'listAssociationGroups', {})).groups.map(row => row.name), ['新手组']);

  const audits = (await repo.auditLogs.list()).filter(row => row.action === 'deleteAssociationGroup');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].groupId, group.groupId);
  assert.equal(audits[0].actorId, 'demo_muc_admin');
  assert.equal(audits[0].memberCount, 2);
});

test('删除小组：普通会员、外校管理员与版本不符都被拒，且不落库', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const rev = await revisionOf(repo, group.groupId);

  const asMember = await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: rev }, 'demo_muc_member');
  assert.equal(asMember.ok, false, '普通会员不能删除小组');
  assert.equal(asMember.message, '只有协会负责人及以上可以删除小组');
  assert.equal((await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: rev }, 'demo_buaa_admin')).ok,
    false, '外校管理员不能删本协会的组');
  assert.equal((await call(repo, 'deleteAssociationGroup', { groupId: group.groupId })).ok, false, '缺版本号被拒');
  assert.equal((await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: 0 })).ok, false, '版本号必须 ≥1');
  assert.equal((await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: rev + 3 })).ok,
    false, '版本不符被拒');
  assert.equal((await call(repo, 'deleteAssociationGroup', {})).ok, false, '缺少小组编号');
  assert.equal((await call(repo, 'deleteAssociationGroup', { expectedRevision: rev })).ok, false, '缺少小组编号');

  assert.equal((await repo.associationGroups.getById(group.groupId)).status, 'active', '全部被拒时无写入');
  assert.equal((await call(repo, 'listAssociationGroups', {})).groups.length, 1);
  assert.equal((await repo.auditLogs.list()).filter(row => row.action === 'deleteAssociationGroup').length, 0);
});

test('删除小组：重复删除与查无此组都幂等，不重复写审计', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const rev = await revisionOf(repo, group.groupId);
  const first = await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: rev });
  assert.equal(first.ok, true);
  assert.equal(first.deleted, true);

  const again = await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: rev });
  assert.equal(again.ok, true, '重复删除返回成功');
  assert.equal(again.deleted, false, '第二次没有可删的东西');
  assert.equal((await repo.associationGroups.getById(group.groupId)).revision, rev + 1, '重复删除不再改版本');

  const ghost = await call(repo, 'deleteAssociationGroup', { groupId: 'ag_ghost', expectedRevision: 1 });
  assert.equal(ghost.ok, true, '查无此组也返回成功（超时重试 / 并发第二次点击）');
  assert.equal(ghost.deleted, false);
  assert.equal((await repo.auditLogs.list()).filter(row => row.action === 'deleteAssociationGroup').length, 1, '幂等重复不重复写审计');
});

test('已删除组不能再编辑 / 归档 / 加人 / 移人 / 退组', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: await revisionOf(repo, group.groupId) });

  assert.equal((await call(repo, 'updateAssociationGroup',
    { groupId: group.groupId, name: '改个名', description: '', expectedRevision: 9 })).ok, false, '不能再编辑');
  assert.equal((await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: 9 })).ok, false, '不能再归档');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_other'] })).ok,
    false, '不能再加人');
  const removed = await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId: 'demo_muc_member' });
  assert.equal(removed.ok, false, '不能再移人');
  assert.equal(removed.message, '小组不存在');
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, false, '组员也退不了一个已删掉的组');

  const key = associationGroupMemberKey(group.groupId, 'demo_muc_member', { schoolId: 'muc', association: 'pkb' });
  const relation = await repo.associationGroupMembers.getById(key);
  assert.equal(relation.status, 'removed', '上面的调用没有把关系改回去');
  const doc = await repo.associationGroups.getById(group.groupId);
  assert.equal(doc.status, 'deleted');
  assert.equal(doc.memberCount, 0);
});

test('归档的小组同样可以删除', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: await revisionOf(repo, group.groupId) });
  const archived = await repo.associationGroups.getById(group.groupId);
  assert.equal(archived.status, 'archived');

  const deleted = await call(repo, 'deleteAssociationGroup', { groupId: group.groupId, expectedRevision: archived.revision });
  assert.equal(deleted.ok, true, deleted.message);
  assert.equal(deleted.deleted, true);
  assert.equal((await repo.associationGroups.getById(group.groupId)).status, 'deleted');
  assert.deepEqual((await call(repo, 'listAssociationGroups', {})).groups, []);
});

test('建组 → 删除 → 同一请求编号再建：真的重建，而不是返回已删除的组', async () => {
  const repo = fixture();
  const first = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  await call(repo, 'deleteAssociationGroup', { groupId: first.groupId, expectedRevision: await revisionOf(repo, first.groupId) });

  const rebuilt = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  assert.equal(rebuilt.groupId, first.groupId, '同编号沿用同一主键');
  assert.equal(rebuilt.status, 'active');
  assert.equal(rebuilt.revision, 3, '版本号接着已删除文档往上走：审计键含版本号，不能回退到 1');
  assert.equal((await call(repo, 'listAssociationGroups', {})).groups.length, 1, '列表里是一个可用的组');

  const creates = (await repo.auditLogs.list()).filter(row => row.action === 'createAssociationGroup');
  assert.equal(creates.length, 2, '两次建组各留一条审计，后一条没有覆盖前一条');
});

test('小组名单按人批读，不为几十人读全校名册（第三轮 X-11）', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { memberIds: ['demo_muc_member', 'demo_muc_other'] });

  // 2000 人的学校，schoolMembers.list() 一次就是 20 页；而小组只有两个人。
  let rosterReads = 0;
  const rawForScope = repo.forScope;
  repo.forScope = (input) => {
    const surface = rawForScope(input);
    const original = surface.schoolMembers.list;
    surface.schoolMembers.list = (...args) => { rosterReads += 1; return original.apply(surface.schoolMembers, args); };
    return surface;
  };
  try {
    const detail = await call(repo, 'getAssociationGroup', { groupId: group.groupId });
    assert.equal(detail.ok, true, detail.message);
    assert.equal(detail.members.length, 2, '成员仍要解析出来');
    assert.ok(detail.members.every((row) => row.nickName && row.nickName !== '会员'),
      '昵称/学院/权限标签不能因为改批读而丢');
  } finally {
    repo.forScope = rawForScope;
  }
  assert.equal(rosterReads, 0, `小组名单不该读全校名册（实际 ${rosterReads} 次）`);
});
