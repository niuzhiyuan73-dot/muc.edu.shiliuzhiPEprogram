// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

const NOW = new Date('2026-10-13T12:00:00Z');

function fixture() {
  return createMemoryRepo(createSchoolDemoSeed());
}

const request = (repo, action, payload = {}, openId = 'mock_openid_muc_admin', schoolId = 'muc', association = 'pkb') =>
  handleSchoolRequest({ protocolVersion: 2, schoolId, association, action, payload }, { repo, openId, now: NOW });

test('协议 2 入口先校验版本、动作与范围，再交给协会空间处理器', async () => {
  const repo = fixture();
  const badVersion = await handleSchoolRequest({ protocolVersion: 1, schoolId: 'muc', association: 'pkb',
    action: 'createAssociationGroup', payload: {} }, { repo, openId: 'mock_openid_muc_admin', now: NOW });
  assert.equal(badVersion.ok, false);
  assert.equal((await request(repo, 'notAnAction')).ok, false, '未注册动作被拒');
  const noScope = await handleSchoolRequest({ protocolVersion: 2, action: 'listAssociationGroups', payload: {} },
    { repo, openId: 'mock_openid_muc_admin', now: NOW });
  assert.equal(noScope.ok, false, '缺学校/协会被拒');
});

test('协会空间动作确已在协议 2 注册，云处理器与共享库接上', async () => {
  const repo = fixture();
  const created = await request(repo, 'createAssociationGroup', { name: '新手组', requestId: 'c1', memberIds: [] });
  assert.equal(created.ok, true, created.message || '');
  assert.equal(created.data.group.name, '新手组');
  const listed = await request(repo, 'listAssociationGroups', {}, 'mock_openid_muc_member');
  assert.equal(listed.ok, true);
  assert.equal(listed.data.groups.length, 1);
  assert.equal(listed.data.canManage, false, '普通会员不显示管理入口');
});

test('跨校隔离在网络入口就生效：别校看不到、改不了本协会小组', async () => {
  const repo = fixture();
  const created = await request(repo, 'createAssociationGroup', { name: '新手组', requestId: 'c1' });
  const groupId = created.data.group.groupId;

  const crossList = await request(repo, 'listAssociationGroups', {}, 'mock_openid_buaa_member', 'buaa');
  assert.equal(crossList.ok, true);
  assert.deepEqual(crossList.data.groups, [], '别校列表为空');

  const crossRead = await request(repo, 'getAssociationGroup', { groupId }, 'mock_openid_buaa_member', 'buaa');
  assert.equal(crossRead.data.ok, false, '外校读不到别校组');

  const crossWrite = await request(repo, 'addAssociationGroupMembers', { groupId, memberIds: ['demo_buaa_member'] },
    'mock_openid_buaa_member', 'buaa');
  assert.equal(crossWrite.data.ok, false, '外校不能改别校组');

  const otherSport = await request(repo, 'listAssociationGroups', {}, 'mock_openid_muc_admin', 'muc', 'tt');
  assert.deepEqual(otherSport.data.groups, [], '同校别协会看不到本协会小组');
});

test('成员名录只列本协会在册会员，字段脱敏', async () => {
  const repo = fixture();
  const asMember = await request(repo, 'listAssociationMembers', {}, 'mock_openid_muc_member');
  assert.equal(asMember.ok, true, asMember.message || '');
  const ids = asMember.data.members.map(row => row.userId).sort();
  // 民大在匹克球协会的在册会员。2026-10-16 为跨校邀请赛补了「民大会员二」
  // （四人签表要两校各两人），名录自然跟着多一位。
  assert.deepEqual(ids, ['demo_muc_admin', 'demo_muc_member', 'demo_muc_member_2'], '只列本校会员，不含北航');
  for (const row of asMember.data.members) {
    assert.deepEqual(Object.keys(row).sort(),
      ['avatarUrl', 'collegeId', 'collegeName', 'nickName', 'permissionLabel', 'realName', 'userId']);
  }

  const cross = await request(repo, 'listAssociationMembers', {}, 'mock_openid_buaa_member', 'muc');
  assert.equal(cross.data.ok, false, '外校拉不到别协会名录');
  assert.deepEqual(cross.data.members, []);

  const searched = await request(repo, 'listAssociationMembers', { keyword: '民大' }, 'mock_openid_muc_member');
  assert.equal(searched.data.members.length, 3, '关键词命中本协会会员');
});

/**
 * 名录页的权限标签按页批读（2026-10-22 大用户量复查 H-5）
 * ============================================================
 * 每一行都要显示权限标签，标签来自「校级角色 + 协会身份」两条文档。原先是每行
 * 各点读一次——一页 20 条就是 40 次 RPC，而这些主键全由 userId 派生，正好可以
 * 整页批读成 2 次。
 */
test('名录页的权限标签整页批读，不逐行点读', async () => {
  const repo = fixture();
  const originalForScope = repo.forScope;
  const calls = { roles: 0, memberships: 0, rolePoint: 0, membershipPoint: 0 };
  repo.forScope = (input) => {
    const scoped = originalForScope(input);
    for (const [key, counter] of [['schoolRoles', 'roles'], ['memberships', 'memberships']]) {
      const collection = scoped[key];
      const listByIds = collection.listByIds;
      collection.listByIds = (...args) => { calls[counter] += 1; return listByIds(...args); };
      const getById = collection.getById;
      collection.getById = (...args) => {
        calls[key === 'schoolRoles' ? 'rolePoint' : 'membershipPoint'] += 1;
        return getById(...args);
      };
    }
    return scoped;
  };
  let listed;
  try {
    listed = await request(repo, 'listAssociationMembers', { limit: 20 });
  } finally {
    repo.forScope = originalForScope;
  }
  assert.equal(listed.ok, true, listed.message || '');
  assert.ok(listed.data.members.length > 0, '名录得有内容，否则这条用例什么也没守住');
  assert.equal(calls.roles, 1, '校级角色一页只批读一次');
  assert.equal(calls.memberships, 1, '协会身份一页只批读一次');
  assert.equal(calls.rolePoint, 0, '不能逐行点读校级角色');
  assert.equal(calls.membershipPoint, 0, '不能逐行点读协会身份');
  // 标签本身仍要算对：管理员那一行不是空白
  assert.ok(listed.data.members.some(row => row.permissionLabel), '权限标签不能因为改批读而丢失');
});
