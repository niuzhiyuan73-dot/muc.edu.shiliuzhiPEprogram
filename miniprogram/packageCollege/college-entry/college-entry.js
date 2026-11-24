/**
 * 提交学院名单（学院负责人）
 * ============================================================
 * 学院负责人从本学院在册会员里勾选队员，凑够管理员设定的人数后提交。
 * 取数与整形走学校维度（协议 2）：services/school-college-view.js 把服务端
 * DTO 整成旧栈同形的视图模型；校验与组装在 services/college-entry.js（纯函数）；
 * 写入由协会空间按当前身份执行。页面只管交互与 setData。
 *
 * 【为什么名单页面只给学院负责人与管理员】
 * 名单是学院的报名凭据，普通会员既不提交也不审核。没有权限时整页顶掉，
 * 不给「填完再被拒」的机会——与发布赛事页同一处理。判权在服务端：赛事读端
 * 下发 submittableCollegeIds，视图层据它决定入口。
 *
 * 【重交为什么不做二次确认】
 * 同一赛事同一学院只有一份名单，重交覆盖旧的（D10）。管理员尚未审核时，
 * 学院负责人本来就需要改完再交；已通过 / 已退回时页面会显示状态与退回理由，
 * 让学院负责人知道为什么还要再交一次。
 *
 * 【学院从哪来】
 * 目标学院来自赛事的 submittableCollegeIds；学籍学院只在属于授权范围时作为默认项。
 * 多个学院可管理时显示选择器，提交始终携带目标 collegeId。
 * ============================================================
 */

const { loadCollegeEntryView } = require('../services/school-college-view.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

const { pageScope, toast } = require('../../utils/page-helpers.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 已勾选的队员编号。勾选状态以它为准，视图模型只作渲染初值 */
    memberIds: [],
    /** 备注（选填） */
    remark: '',
    selectorOpen: false,
    selectorScope: {},
    selectedMembers: [],
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    this.collegeId = query.collegeId || '';
    return this.refresh();
  },

  onUnload() { this.loadRequest = (this.loadRequest || 0) + 1; },

  /** 从审核页返回时刷新一次，刚被退回的名单状态才在页面上 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /**
   * 本次身份会话。读一次拿到操作者与本人学院编号：操作者用来把「去登录」与
   * 「没权限」分开，本人学院编号用来默认选中本学院。拿不到就按访客处理，
   * 绝不猜一个身份出来。
   */
  async readSession() {
    try {
      return await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
    } catch (err) {
      console.error('[college-entry] 读取学校身份失败', err);
      return null;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    return toast(title, icon);
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    const scope = this.currentScope();
    this.scope = scope;
    this.setData({ loading: true, error: '' });
    const session = await this.readSession();
    this.actorId = (session && session.user && session.user.userId) || null;
    if (request !== this.loadRequest) return;
    const preferredCollegeId = (session && session.account && session.account.collegeId) || '';

    try {
      const view = await loadCollegeEntryView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association,
        actorId: this.actorId, collegeId: this.collegeId, preferredCollegeId, pagedCandidates: true,
      });
      if (request !== this.loadRequest) return;
      // 采纳装载器探测出的真实编号再用于写：query 在微信开发者工具 / 真机里是
      // 原样透传的（未解码），继续拿路由原值提交会被服务端答「学院赛不存在」
      // （见 utils/route-query.js）。解析只做一次，之后读写与跳转都用它。
      if (view.eventId) this.eventId = view.eventId;
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        memberIds: view.existingMemberIds || [],
        selectedMembers: view.existingMembers || [],
        selectorScope: scope,
        selectorOpen: false,
        remark: view.remark,
        themeClass: currentThemeClass(),
      });
    } catch (err) {
      if (request !== this.loadRequest) return;
      console.error('[college-entry] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, view: {}, memberIds: [], error: '名单页加载失败，请返回重试', themeClass: currentThemeClass() });
    }
  },

  /* ---------- 交互 ---------- */
  onOpenSelector() { if (this.data.view.canSubmit && !this.data.submitting) this.setData({ selectorOpen: true }); },
  onCloseSelector() { this.setData({ selectorOpen: false }); },
  onConfirmSelector(event) {
    const selectedMembers = event.detail.members || [];
    this.setData({ selectorOpen: false, selectedMembers, memberIds: selectedMembers.map(row => row.userId),
      'view.selectedCount': selectedMembers.length });
  },

  onCollegeChange(event) {
    if (this.data.submitting) return;
    const college = (this.data.view.collegeOptions || [])[Number(event.detail.value)];
    if (!college) return;
    this.collegeId = college.collegeId;
    return this.refresh();
  },

  /** 勾选 / 取消勾选队员。checkbox-group 给出的就是全部已选项 */
  onToggleMember(event) {
    const memberIds = Array.isArray(event.detail.value) ? [...event.detail.value] : [];
    const picked = new Set(memberIds);
    this.setData({
      memberIds,
      'view.candidates': this.data.view.candidates.map((item) => ({
        ...item,
        checked: picked.has(item.memberId),
      })),
      'view.selectedCount': memberIds.length,
    });
  },

  onInputRemark(event) {
    this.setData({ remark: event.detail.value });
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.loading || this.data.submitting) return undefined;
    if (!this.data.view.canSubmit) return undefined;

    const scope = this.scope || this.currentScope();
    this.setData({ submitting: true });
    let result;
    try { result = await space.forScope(scope).submitCollegeEntry({
      eventId: this.eventId,
      collegeId: this.data.view.collegeId,
      college: this.data.view.college,
      memberIds: this.data.memberIds,
      remark: this.data.remark,
    }); } catch (error) {
      this.setData({ submitting: false });
      this.showToast(error.message || '提交失败，请重试');
      return;
    }

    if (!result || !result.ok) {
      this.setData({ submitting: false });
      this.showToast((result && (result.firstError || result.message)) || '提交失败');
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已提交，等待管理员审核', 'success');
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
});
