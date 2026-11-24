/**
 * 学校维度「编辑资料」装载器的自检（协议 2，M3-c 的页面配套）
 * ============================================================
 * 这一层管的是「从哪儿取自己、显示成什么」。守住三条：
 *   1. 拿不到会话（没有账号）时整页挡住，不留半张表单；
 *   2. 实名 / 性别来自会员档案，学号来自自己的学校身份，昵称 / 头像可改；
 *   3. 档案读不到（业务拒绝或直接抛错）时降级而不是打白——昵称仍可改。
 *
 * 身份与协会空间两个客户端都在这里被替换成假实现，用例只钉装载器本身的逻辑，
 * 不去碰内存仓储。
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../miniprogram/services/school-identity.js');
const space = require('../miniprogram/services/association-space.js');
const {
  LOGIN_BLOCK, avatarTextOf, loadSchoolProfileEditView, schoolProfilePatch,
} = require('../miniprogram/packageMember/services/school-profile-view.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/** 把身份与协会空间两个门面换成假实现，跑完恢复 */
async function withClients({ session, member, memberThrows }, run) {
  const idOrig = identity.forSchoolIdentity;
  const spOrig = space.forScope;
  identity.forSchoolIdentity = () => ({ getSchoolIdentitySession: async () => session });
  space.forScope = () => ({
    getSchoolMember: async () => {
      if (memberThrows) throw memberThrows;
      return member;
    },
  });
  try {
    return await run();
  } finally {
    identity.forSchoolIdentity = idOrig;
    space.forScope = spOrig;
  }
}

test('编辑资料装载器 —— 没有会话时整页挡住，不给表单', async () => {
  await withClients({ session: { user: null } }, async () => {
    const view = await loadSchoolProfileEditView(SCOPE);

    assert.equal(view.allowed, false);
    assert.equal(view.blockReason, LOGIN_BLOCK);
    assert.deepEqual(view.form, { nickName: '', avatarUrl: '' });
    assert.equal(view.realName, '');
    assert.equal(view.genderText, '');
    assert.equal(view.studentId, '');
  });
});

test('编辑资料装载器 —— 实名 / 性别来自会员档案，学号来自自己的学校身份', async () => {
  const member = {
    ok: true,
    member: { userId: 'u1', nickName: '小明', realName: '赵明宇', avatarUrl: 'https://x/a.png', gender: 'M' },
  };
  const session = { user: { userId: 'u1', nickName: '兜底昵称' }, account: { studentId: '20230006' } };

  await withClients({ session, member }, async () => {
    const view = await loadSchoolProfileEditView(SCOPE);

    assert.equal(view.allowed, true);
    assert.equal(view.blockReason, '');
    assert.deepEqual(view.form, { nickName: '小明', avatarUrl: 'https://x/a.png' });
    assert.equal(view.realName, '赵明宇');
    assert.equal(view.genderText, '男');
    assert.equal(view.studentId, '20230006');
    assert.equal(view.avatarText, '小');
    assert.equal(view.nicknameMax, 12);
  });
});

test('编辑资料装载器 —— 档案读不到时降级：昵称退回会话，实名留空', async () => {
  const session = { user: { userId: 'u1', nickName: '会话昵称' }, account: null };

  await withClients({ session, member: { ok: false, message: '没有权限' } }, async () => {
    const view = await loadSchoolProfileEditView(SCOPE);

    assert.equal(view.allowed, true, '没有档案也该能改昵称头像');
    assert.equal(view.form.nickName, '会话昵称');
    assert.equal(view.form.avatarUrl, '');
    assert.equal(view.realName, '');
    assert.equal(view.studentId, '');
  });
});

test('编辑资料装载器 —— 档案接口抛错时逃逸到调用方，由页面兜底', async () => {
  const session = { user: { userId: 'u1', nickName: '会话昵称' }, account: null };

  await withClients({ session, memberThrows: new Error('boom') }, async () => {
    await assert.rejects(() => loadSchoolProfileEditView(SCOPE), /boom/);
  });
});

test('补丁只挑可改的两项，缺字段兜成空串', () => {
  assert.deepEqual(
    schoolProfilePatch({ nickName: 'a', avatarUrl: 'b', role: 2, realName: '假名' }),
    { nickName: 'a', avatarUrl: 'b' }
  );
  assert.deepEqual(schoolProfilePatch({}), { nickName: '', avatarUrl: '' });
  assert.deepEqual(schoolProfilePatch(null), { nickName: '', avatarUrl: '' });
});

test('头像占位永远不是空的', () => {
  assert.equal(avatarTextOf('小明'), '小');
  assert.equal(avatarTextOf(''), '？');
  assert.equal(avatarTextOf(undefined), '？');
});
