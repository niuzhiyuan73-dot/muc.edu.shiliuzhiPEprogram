/**
 * 学校维度：资料修改「昵称 / 头像」（迁移清单 M3-c）
 *
 * 守的是：
 *   1. 只改自己——改的是 ctx.actorId 指向的账号，补丁里塞别人的编号也改不到；
 *   2. 只改白名单的两样（nickName / avatarUrl），实名信息（真名 / 性别 / 学号 /
 *      学院）与角色 / 积分 / 状态等在补丁清洗阶段直接丢掉，复用旧栈纯规则
 *      `profile.js` 的 `buildProfilePatch`（同一把尺子）；
 *   3. 空补丁与非法昵称（过长 / 全空白 / 含换行）被拒；
 *   4. 未登录、账号平台停用一律拒绝。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { createSchoolHandlers } = require('../src/server/services/school-membership-service');

const NOW = new Date('2026-10-13T10:00:00Z');
const handlers = createSchoolHandlers({ claimKey: (schoolId, studentId) => `claim_${schoolId}_${studentId}` });

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

function fixture() {
  const seed = createSchoolDemoSeed();
  const member = seed.users.find(user => user._id === 'demo_muc_member');
  member.nickName = '原昵称';
  member.realName = '真名';
  member.role = 0;
  member.points = 100;
  return createSchoolMemoryRepo(seed);
}

test('资料：只改白名单两样，其余字段被丢弃', async () => {
  const repo = fixture();
  const res = await call(repo, 'updateSchoolProfile', { patch: {
    nickName: '新昵称', avatarUrl: 'https://cdn.example/a.png',
    // 下面这些都不在白名单里，应被无声丢掉。
    role: 2, points: 9999, realName: '假名', gender: 'F', _id: 'someone_else',
  } });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.account.nickName, '新昵称');
  assert.equal(res.account.avatarUrl, 'https://cdn.example/a.png');
  // 只回展示字段，不带 openId 等隐私。
  assert.deepEqual(Object.keys(res.account).sort(), ['avatarUrl', 'nickName', 'userId']);

  const stored = await repo.users.getById('demo_muc_member');
  assert.equal(stored.nickName, '新昵称');
  assert.equal(stored.avatarUrl, 'https://cdn.example/a.png');
  assert.equal(stored.role, 0);
  assert.equal(stored.points, 100);
  assert.equal(stored.realName, '真名');
  // 演示种子现在自带性别（榜单分池要用），补丁里的 gender 仍不在白名单、不生效
  assert.equal(stored.gender, 'M');

  // 只改头像也允许（部分补丁）。
  const avatarOnly = await call(repo, 'updateSchoolProfile', { patch: { avatarUrl: 'https://cdn.example/b.png' } });
  assert.equal(avatarOnly.ok, true, avatarOnly.message);
  assert.equal((await repo.users.getById('demo_muc_member')).nickName, '新昵称');
});

test('资料：空补丁与非法昵称被拒', async () => {
  const repo = fixture();

  const empty = await call(repo, 'updateSchoolProfile', { patch: {} });
  assert.equal(empty.ok, false);
  assert.match(empty.firstError, /没有要修改的内容/);

  const tooLong = await call(repo, 'updateSchoolProfile', { patch: { nickName: '一二三四五六七八九十十一十二十三' } });
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors.nickName);

  const blank = await call(repo, 'updateSchoolProfile', { patch: { nickName: '   ' } });
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.nickName);

  const newline = await call(repo, 'updateSchoolProfile', { patch: { nickName: 'a\nb' } });
  assert.equal(newline.ok, false);
  assert.ok(newline.errors.nickName);
});

test('资料：未登录与账号停用被拒', async () => {
  const repo = fixture();

  const anon = await call(repo, 'updateSchoolProfile', { patch: { nickName: 'x' } }, { actor: '' });
  assert.equal(anon.ok, false);
  assert.match(anon.message, /请先登录/);

  const disabled = { ...(await repo.users.getById('demo_muc_member')), platformStatus: 'disabled' };
  await repo.users.set('demo_muc_member', disabled);
  const res = await call(repo, 'updateSchoolProfile', { patch: { nickName: 'x' } });
  assert.equal(res.ok, false);
  assert.match(res.message, /找不到你的账号/);
});
