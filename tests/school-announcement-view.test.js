/**
 * 学校维度公告视图模型的自检（协议 2）
 * ============================================================
 * 本文件由旧栈 announcement-view.test.js 迁移而来：协议 1 下线后，旧栈两个
 * 装载器被删除，而这两个 S2 装载器此前**没有任何测试**（页面一直在用，却
 * 无人守护），所以迁移不是「补一份等价文件」，而是把防泄漏与排序口径这两
 * 类守护真正落到 S2 上。
 *
 * 2026-10-18 口径变更：公告只由平台管理员 / 本校校级管理员发布，且是**学校级**
 * 的一条通道——协会标签与「通知 / 赛事 / 战报」分类标签都已从界面移除，
 * repo 里 announcements 也移进 SCHOOL_ONLY 档。于是「管理台账 5 条、公开列表
 * 12 条」这种对不上的情况不再可能：两边读的是同一份学校级列表。
 *
 * 最要紧的一条防线仍在最前面：没有管理权的人，一条已下架公告都不能看到。
 * ============================================================
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  loadSchoolAnnouncementListView,
  loadSchoolAnnouncementManageView,
} = require('../miniprogram/packageMember/services/announcement-view.js');
const schoolMock = require('../src/mock/school-mock.js');
const space = require('../miniprogram/services/association-space.js');
const scope = require('../miniprogram/services/association-scope.js');

/** 演示数据落在民大；公告是学校级的，协会只影响配色 */
const SCHOOL_ID = 'muc';
const PKB = { schoolId: SCHOOL_ID, association: 'pkb' };

/** 演示公告条数（见 school-seed 的 DEMO_SCHOOL_ANNOUNCEMENTS）：民大 5 条、北航 4 条 */
const COUNTS = { muc: 5, buaa: 4 };

const api = (association = 'pkb') => space.forScope({ schoolId: SCHOOL_ID, association });

/** 平台管理员：账号级身份，跨校可发；校级管理员只在本校可发（2026-10-18） */
beforeEach(() => {
  schoolMock.reset();
  schoolMock.setDemoActor('demo_platform_admin');
});

/* ============================================================
 * 一、公开列表
 * ============================================================ */

describe('学校公告公开列表 —— 本校一条通道，不分协会、不分分类', () => {
  test('不传协会也能取到本校全部公告，协会只决定配色', async () => {
    const view = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID });

    assert.strictEqual(view.total, COUNTS.muc);
    assert.strictEqual(view.rows.length, COUNTS.muc);
    assert.ok(view.themeClass.startsWith('assoc-'), '该带当前协会的主题类');
    assert.strictEqual(view.associationTabs, undefined, '协会标签已移除');
    assert.strictEqual(view.tabs, undefined, '分类标签已移除');
  });

  test('换协会看的是同一份公告——公告归学校，不归协会', async () => {
    const pkb = await loadSchoolAnnouncementListView(PKB);
    const tt = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID, association: 'tt' });

    assert.deepStrictEqual(tt.rows.map((row) => row.id), pkb.rows.map((row) => row.id));
    assert.strictEqual(tt.total, COUNTS.muc);
  });

  test('置顶的排最前，其余按发布时间倒序', async () => {
    const view = await loadSchoolAnnouncementListView(PKB);

    assert.strictEqual(view.rows[0].pinned, true);
    // 种子里的公告同一时刻发布，只断言置顶在前，不臆造其后的顺序
    assert.ok(view.rows.slice(1).every((row) => !row.pinned));
  });

  test('公开页绝不出现管理按钮', async () => {
    const view = await loadSchoolAnnouncementListView(PKB);
    assert.ok(view.rows.length > 0);
    // 即便当前身份是平台管理员，公开列表也恒不下发 canArchive
    for (const row of view.rows) assert.strictEqual(row.canArchive, false);
  });

  test('全部下架后公开列表空且空态有话说', async () => {
    const before = await loadSchoolAnnouncementListView(PKB);
    for (const row of before.rows) {
      await api().archiveSchoolAnnouncement({ announcementId: row.id });
    }

    const view = await loadSchoolAnnouncementListView(PKB);
    assert.strictEqual(view.visibleCount, 0);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.emptyText, /还没有发布公告/);
  });
});

/* ============================================================
 * 二、管理台账的闸门
 * ============================================================ */

describe('学校公告管理视图 —— 防泄漏', () => {
  test('未登录拿不到任何公告，只拿到一句提示', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: false });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, [], '未登录竟然拿到了公告台账');
    assert.strictEqual(view.total, 0);
    assert.match(view.blockedText, /登录/);
  });

  test('已登录但没有管理身份（普通会员）：提示权限，而不是把台账交出去', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });

  test('学校管理员能拿到本校台账（2026-10-18 起公告归平台 + 校级管理员）', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.total, COUNTS.muc);
  });

  test('即便公告已被下架，无权者仍一条都看不到', async () => {
    const published = await api().listSchoolAnnouncements({});
    await api().archiveSchoolAnnouncement({ announcementId: published.announcements[0].announcementId });

    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.deepStrictEqual(view.rows, []);
  });
});

/* ============================================================
 * 三、管理台账的内容
 * ============================================================ */

describe('学校公告管理视图 —— 内容', () => {
  test('平台管理员看到本校全量，与公开列表条数一致', async () => {
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    const publicView = await loadSchoolAnnouncementListView(PKB);

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.total, COUNTS.muc);
    assert.strictEqual(view.publishedCount, COUNTS.muc);
    assert.strictEqual(view.archivedCount, 0);
    // 口径统一的关键：台账与公开列表读的是同一份学校级数据
    assert.strictEqual(view.total, publicView.total);
  });

  test('换协会进入台账，看到的仍是同一份本校公告', async () => {
    const pkb = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    const bd = await loadSchoolAnnouncementManageView({ schoolId: SCHOOL_ID, association: 'bd', loggedIn: true });

    assert.deepStrictEqual(bd.rows.map((row) => row.id), pkb.rows.map((row) => row.id));
  });

  test('新发的公告随即出现在台账里', async () => {
    await api().publishSchoolAnnouncement({
      requestId: 'view-test-publish',
      title: '临时通知',
      content: '明天停训一次。',
    });

    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.strictEqual(view.total, COUNTS.muc + 1);
    assert.strictEqual(view.publishedCount, COUNTS.muc + 1);

    const created = view.rows.find((row) => row.title === '临时通知');
    assert.ok(created, '新发的公告没进台账');
    assert.strictEqual(created.canArchive, true);
    // 不传分类也能发（界面已无分类），落库补默认档
    assert.strictEqual(created.category, '通知');
    // 置顶的仍在最前：排序口径是「置顶优先」，新发的不该把它顶下去
    assert.strictEqual(view.rows[0].pinned, true);
  });

  test('下架后：公开列表少一条，台账保持分页顺序、不再给按钮', async () => {
    const published = await api().listSchoolAnnouncements({});
    const target = published.announcements[0];
    await api().archiveSchoolAnnouncement({ announcementId: target.announcementId });

    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.strictEqual(view.total, COUNTS.muc);
    assert.strictEqual(view.publishedCount, COUNTS.muc - 1);
    assert.strictEqual(view.archivedCount, 1);

    const last = view.rows.find(row => row.id === target.announcementId);
    assert.strictEqual(last.id, target.announcementId);
    assert.strictEqual(last.archived, true);
    assert.strictEqual(last.statusLabel, '已下架');
    assert.strictEqual(last.canArchive, false);

    const publicView = await loadSchoolAnnouncementListView(PKB);
    assert.strictEqual(publicView.total, COUNTS.muc - 1);
    assert.ok(!publicView.rows.some((row) => row.id === target.announcementId), '下架的那条不该还在公开列表里');
  });

  test('每一行都不含 undefined / null / NaN', async () => {
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.ok(view.rows.length > 0);
    for (const row of view.rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.notStrictEqual(value, null, `${key} 是 null`);
        assert.notStrictEqual(value, undefined, `${key} 是 undefined`);
        if (typeof value === 'string') {
          assert.ok(!/undefined|NaN/.test(value), `${key} 渲染出了「${value}」`);
        }
      }
      assert.strictEqual(typeof row.archived, 'boolean');
      assert.strictEqual(typeof row.canArchive, 'boolean');
    }
  });
});
