/**
 * 会员审核页（学校维度）
 * ============================================================
 * 只做一件事：把等待审核的入会申请逐条过一遍，通过或驳回。
 * 取数与权限判定全在 services/school-member-review-view.js 的学校维度装载器，
 * 页面只做渲染与交互——那一层不碰 wx API，因而「谁能审谁」的规则能在 Node 里逐条测。
 * 数据按「当前学校 + 协会」取，审核写回也走同一范围（学校身份协议）。
 *
 * 【登录态不再由页面猜】
 * 旧栈里由页面把 getApp() 的登录态递进装载器，是为了绕开「mock 永远答 u06」。
 * 学校维度下，会话接口本身就会区分「账号有效 / 没这个权限」，装载器直接读会话，
 * 页面不再参与判权。
 *
 * 【通过为什么也要过一次面板】
 * 通过不可逆（批了就离开待审列表、申请人就此转正），所以先弹面板确认一句。
 * 旧栈面板里还有个「手工指定初始等级分」的选填框；学校维度这条链路暂不收
 * 初始分（等级分改由 M4 的回放 / 赛季链路管理），故面板里不再放输入框，只确认。
 *
 * 【驳回为什么必须填理由】
 * 资料有问题，必须留下问题是什么，否则申请人问起来谁也说不清当初为什么被拒。
 * 所以驳回同样走面板，但理由必填。
 *
 * 【onShow 为什么要带守卫】
 * onLoad 之后紧接着就会来一次 onShow。若不加 this.loaded 判断，首屏会
 * 白算两遍。带守卫又必须保留 onShow——从登录页 navigateBack 回来时
 * 登录态可能变了，不刷新就会拿着旧权限渲染。
 * ============================================================
 */

const { loadSchoolMemberReviewView } = require('../../services/school-member-review-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 通过面板的文案。通过即转正，不可逆。 */
const APPROVE_TEXT = {
  title: '通过这条入会申请',
  hint: '通过后 TA 即成为本校在册会员，可以报名、录入成绩、上榜。此操作不可撤销。',
  placeholder: '',
};

/** 驳回面板的文案。理由必填 */
const REJECT_TEXT = {
  title: '驳回这条入会申请',
  hint: '驳回后申请人无法使用本小程序，请说明资料哪里有出入。',
  placeholder: '例如：学号与姓名对不上',
};

const { pageScope, stopRefresh, toast } = require('../../utils/page-helpers.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 视图模型，形状见 services/school-member-review-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 开发期标注模拟数据 */
    isMock: false,
    /** 审核面板。mode 取 'approve' / 'reject'，决定面板里是确认还是理由框 */
    action: { open: false, mode: '', applicationId: '', revision: 0, title: '', hint: '', placeholder: '' },
    /** 驳回面板里填的理由 */
    reason: '',
    /** 提交中，防止连点 */
    acting: false,
    /** 面板内的错误提示 */
    actionError: '',
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  /** 从登录页返回时刷新一次，登录态变了权限也会跟着变 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** 当前「学校 + 协会」范围。审核写回复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    return stopRefresh();
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
    const scope = this.currentScope();
    this.scope = scope;

    try {
      // 能不能看、能看哪些行，全由视图模型判定；这里只把范围递进去
      const view = await loadSchoolMemberReviewView(scope);

      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[member-review] 会员审核页加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        error: '入会申请加载失败，请下拉重试',
        themeClass: currentThemeClass(),
      });
    }
  },

  /* ---------- 通过 / 驳回面板 ---------- */

  /**
   * 打开通过面板。
   * 通过不可逆（批了就离开待审列表），所以先弹面板确认一句。
   */
  onOpenApprove(event) {
    const { applicationId, revision } = event.currentTarget.dataset;
    if (!applicationId) return;

    const row = (this.data.view.rows || []).find(item => item.userId === applicationId);
    const text = row && row.transfer ? { ...APPROVE_TEXT, title: '通过转校申请',
      hint: `将其从${row.transferFromName || '原学校'}转入本校，原学校历史成绩保留。确认通过？` } : APPROVE_TEXT;
    this.setData({
      action: { open: true, mode: 'approve', applicationId, revision: Number(revision) || 0, ...text },
      reason: '',
      actionError: '',
    });
  },

  /** 打开驳回面板 */
  onOpenReject(event) {
    const { applicationId, revision } = event.currentTarget.dataset;
    if (!applicationId) return;
    const row = (this.data.view.rows || []).find(item => item.userId === applicationId);
    const text = row && row.transfer ? { ...REJECT_TEXT, title: '驳回转校申请',
      hint: '驳回后保留原学校身份，请说明转校资料需要补充的内容。' } : REJECT_TEXT;
    this.setData({
      action: { open: true, mode: 'reject', applicationId, revision: Number(revision) || 0, ...text },
      reason: '',
      actionError: '',
    });
  },

  onInputReason(event) {
    this.setData({ reason: event.detail.value, actionError: '' });
  },

  /** 关闭面板并清空输入框，取消与提交成功共用 */
  closeAction() {
    this.setData({
      action: { ...this.data.action, open: false },
      reason: '',
      actionError: '',
    });
  },

  onCancelAction() {
    if (this.data.acting) return;
    this.closeAction();
  },

  /**
   * 提交面板里的操作，通过 / 驳回按 mode 分流。
   *
   * 校验放在页面这一层（驳回理由必填），让用户点下按钮的当下就看到问题；
   * 后端仍会各自再校验一遍。
   */
  async onSubmitAction() {
    if (this.data.acting) return undefined;

    const { mode, applicationId, revision } = this.data.action;
    if (mode === 'reject') return this.submitReject(applicationId, revision);
    if (mode === 'approve') return this.submitApprove(applicationId, revision);
    return undefined;
  },

  /** 提交驳回。理由必填——没有理由的驳回事后说不清 */
  async submitReject(userId, revision) {
    const reason = String(this.data.reason || '').trim();
    if (!reason) {
      this.setData({ actionError: '请填写驳回理由' });
      return undefined;
    }
    return this.review(userId, revision, 'reject', reason, '已驳回');
  },

  /** 提交通过 */
  async submitApprove(userId, revision) {
    return this.review(userId, revision, 'approve', '', '已通过，该会员可以录入成绩了');
  },

  /**
   * 提交一次审核。编号 + 版本一起报上去，服务端据此挡住并发下的过期审核。
   * @param {string} userId 申请人编号
   * @param {number} revision 申请版本
   * @param {string} decision approve / reject
   * @param {string} reason 驳回理由（通过时为空串）
   * @param {string} successText 成功后的提示
   */
  async review(userId, revision, decision, reason, successText) {
    this.setData({ acting: true, actionError: '' });
    let result;
    try {
      const row = (this.data.view.rows || []).find(item => item.userId === userId);
      const api = identity.forSchoolIdentity(this.scope || this.currentScope());
      result = await api[row && row.transfer ? 'reviewSchoolTransfer' : 'reviewSchoolMembership']({ userId, decision, revision, reason });
      if (row && row.transfer && decision === 'approve') successText = '已通过转校申请';
    } catch (err) {
      this.setData({ acting: false, actionError: err.message || '操作失败' });
      return undefined;
    }
    this.setData({ acting: false });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.closeAction();
    this.showToast(successText, 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
