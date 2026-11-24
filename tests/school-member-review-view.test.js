/**
 * 学校维度会员审核视图模型的自检（协议 2，M3-b）
 * ============================================================
 * 这一层最要紧的还是一条防线：没有审核权的人，一行申请都不能看到。
 * 申请单上写着全体申请人的实名、学号、学院，泄漏一次就是一整批人的
 * 个人信息，所以「闸门」相关的用例排在最前面。
 *
 * 其余部分与旧栈 memeber-review-view 同一套路数：权限算进数据里
 * （canApprove / canReject），模板只照渲染按钮；渲染字段里不许出现
 * undefined / null / NaN。
 * ============================================================
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  PENDING_EMPTY, schoolApplicationRow, loadSchoolMemberReviewView,
} = require('../miniprogram/packageMember/services/school-member-review-view.js');
const schoolMock = require('../src/mock/school-mock.js');
const identity = require('../miniprogram/services/school-identity.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

const api = () => identity.forSchoolIdentity(SCOPE);

/** 每个用例前把学校维度内存重置，并让申请人提交一条待审申请 */
beforeEach(async () => {
  schoolMock.reset();
  schoolMock.setDemoActor('demo_applicant');
  await api().applySchoolMembership({ studentId: 'APP001', collegeId: 'c01' });
});

/* ============================================================
 * 一、闸门：没有审核权就一行都不给
 * ============================================================ */

describe('学校会员审核视图 —— 防泄漏', () => {
  test('有账号但没审核权的会员，一行申请都拿不到', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolMemberReviewView(SCOPE);

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, [], '没有审核权竟然拿到了申请数据');
    assert.strictEqual(view.pendingCount, 0);
    assert.match(view.blockedText, /权限/);
  });

  test('申请人自己也拿不到台账', async () => {
    schoolMock.setDemoActor('demo_applicant');
    const view = await loadSchoolMemberReviewView(SCOPE);

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
  });

  test('无权限时，整页数据里都不出现申请人的学号', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolMemberReviewView(SCOPE);

    assert.ok(!JSON.stringify(view).includes('APP001'), '无权限的数据里漏出了学号');
  });
});

/* ============================================================
 * 二、有权限时看到什么
 * ============================================================ */

describe('学校会员审核视图 —— 内容', () => {
  test('校管理员看到待审申请，字段齐整且没有「已处理」标签页', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const view = await loadSchoolMemberReviewView(SCOPE);

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.rows.length, 1);
    assert.strictEqual(view.pendingCount, 1);
    // 学校维度没有「已驳回」列表，故不摆标签页
    assert.strictEqual(view.tabs, undefined);
    assert.strictEqual(view.viewer.userId, 'demo_muc_admin');
    assert.strictEqual(view.viewer.loggedIn, true);
  });

  test('每一行都带上申请人资料与放行的两个按钮', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const view = await loadSchoolMemberReviewView(SCOPE);
    const row = view.rows[0];

    assert.strictEqual(row.userId, 'demo_applicant');
    assert.strictEqual(row.studentId, 'APP001');
    assert.strictEqual(row.college, '中华民族共同体学院');
    assert.strictEqual(row.statusLabel, '待审核');
    assert.strictEqual(row.canApprove, true);
    assert.strictEqual(row.canReject, true);
    assert.strictEqual(row.isSelf, false);
    assert.strictEqual(row.phone, undefined, '学校维度不下发手机号');
    assert.ok(row.appliedAtText);
  });

  test('处理掉唯一一条之后，空态有话说', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    await api().reviewSchoolMembership({ userId: 'demo_applicant', decision: 'approve', revision: 1, reason: '' });

    const view = await loadSchoolMemberReviewView(SCOPE);
    assert.strictEqual(view.rows.length, 0);
    assert.strictEqual(view.pendingCount, 0);
    assert.strictEqual(view.emptyText, PENDING_EMPTY);
  });
});

/* ============================================================
 * 三、行整形：权限算进数据里
 * ============================================================ */

describe('学校会员审核视图 —— 行整形', () => {
  const application = {
    userId: 'demo_applicant', revision: 2, nickName: '模拟申请人',
    realName: '张三', gender: 'M', studentId: 'APP001', collegeName: '中华民族共同体学院',
    appliedAt: '2026-10-13T10:00:00Z',
  };

  test('本人那条只留提示，不给按钮', () => {
    const row = schoolApplicationRow(application, { viewerId: 'demo_applicant', canManage: true });
    assert.strictEqual(row.isSelf, true);
    assert.strictEqual(row.canApprove, false);
    assert.strictEqual(row.canReject, false);
  });

  test('没有审核权时按钮一律不给', () => {
    const row = schoolApplicationRow(application, { viewerId: 'demo_muc_admin', canManage: false });
    assert.strictEqual(row.isSelf, false);
    assert.strictEqual(row.canApprove, false);
    assert.strictEqual(row.canReject, false);
  });

  test('昵称缺失时退回实名，再退回编号——绝不渲染出 undefined', () => {
    const noNick = schoolApplicationRow({ ...application, nickName: '' }, { viewerId: 'x', canManage: true });
    assert.strictEqual(noNick.nickName, '张三');

    const bare = schoolApplicationRow(
      { userId: 'demo_applicant', revision: 1 }, { viewerId: 'x', canManage: true });
    assert.strictEqual(bare.nickName, 'demo_applicant');
    assert.strictEqual(bare.genderText, '');
    assert.strictEqual(bare.college, '');
  });

  test('每一行都不含 undefined / null / NaN', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const view = await loadSchoolMemberReviewView(SCOPE);

    for (const row of view.rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.notStrictEqual(value, null, `${key} 是 null`);
        assert.notStrictEqual(value, undefined, `${key} 是 undefined`);
        if (typeof value === 'string') {
          assert.ok(!/undefined|NaN/.test(value), `${key} 渲染出了「${value}」`);
        }
      }
      assert.strictEqual(typeof row.canApprove, 'boolean');
      assert.strictEqual(typeof row.canReject, 'boolean');
      assert.strictEqual(typeof row.isSelf, 'boolean');
    }
  });
});
