/**
 * 学院名单审核（管理员）
 * ============================================================
 * 把各学院提交的名单逐份过一遍：通过或退回。取数与整形走学校维度（协议 2）：
 * services/school-college-view.js 把服务端 DTO 整成旧栈同形；权限与校验在
 * services/college-entry.js（纯函数）；写入由协会空间按当前身份执行，页面只做
 * 渲染与交互。
 *
 * 【为什么退回要弹面板、通过不用】
 * 退回必须带理由（与入会审核同一条硬规则）：没有理由，学院只知道「没过」，
 * 不知道该改哪里，只能原样再交一遍。所以退回走面板、理由必填；通过则是
 * 「资料对得上」，点一下即可，不额外加一道点击。
 *
 * 【通过之后名单还能不能改】
 * 通过只表示这份名单有效，名单仍锁定在「报名中」——学院负责人可以继续改并重交，
 * 重交会退回「待审核」。真正锁死名单的是管理员抽签（状态转「待开赛」），
 * 那是下一页的事。因此这里不做「通过即锁定」的暗示。
 * ============================================================
 */

const { loadCollegeEntryReviewView } = require('../services/school-college-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
// 审核动作与入会审核共用同一套取值，直接复用，免得两处各写一份字符串
const { REVIEW_ACTION } = require('../../shared/services/member-review.js');
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
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock: false,
    /** 正在处理的名单编号，防止连点 */
    acting: '',
    /** 退回面板。open 为 false 时不渲染 */
    reject: { open: false, entryId: '', college: '' },
    /** 退回面板里填的理由 */
    reason: '',
    /** 面板内的错误提示 */
    actionError: '',
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  /** 从名单页返回时刷新一次，刚提交的名单才会出现在待审列表 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /**
   * 本次身份会话里的操作者编号，只用来把「去登录」与「没权限」分开。
   * 拿不到就按访客处理，绝不猜一个身份出来。
   */
  async currentActorId() {
    try {
      const session = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
      return (session && session.user && session.user.userId) || null;
    } catch (err) {
      console.error('[college-entry-review] 读取学校身份失败', err);
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
    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();
    this.actorId = actorId;

    try {
      const view = await loadCollegeEntryReviewView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      // 采纳装载器探测出的真实编号再用于写：query 在微信开发者工具 / 真机里是
      // 原样透传的（未解码），继续拿路由原值审核会被服务端答「学院赛不存在」
      // （见 utils/route-query.js）。解析只做一次，之后读写与跳转都用它。
      if (view.eventId) this.eventId = view.eventId;
      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[college-entry-review] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '名单审核页加载失败，请返回重试', themeClass: currentThemeClass() });
    }
  },

  /* ---------- 通过 ---------- */

  /**
   * 直接通过。名单没有额外的审核字段，不必再弹一个面板；
   * 后端仍会校验「是否管理员」「是否待审核」。
   */
  async onApprove(event) {
    const entryId = event.currentTarget.dataset.entryId;
    if (!entryId || this.data.acting) return undefined;
    // 学校维度的审核按「赛事 + 学院」定位，学院名从行上取（行按键稳定，不会串）
    const row = (this.data.view.rows || []).find((item) => item.entryId === entryId);
    if (!row) return undefined;

    this.setData({ acting: entryId });
    let result;
    try {
      result = await space.forScope(this.scope || this.currentScope()).reviewCollegeEntry({
        eventId: this.eventId, college: row.college, action: REVIEW_ACTION.APPROVE, reason: '',
      });
    } catch (err) {
      this.showToast((err && err.message) || '操作失败，请重试');
      return undefined;
    } finally {
      this.setData({ acting: '' });
    }

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '操作失败');
      return undefined;
    }

    this.showToast('已通过', 'success');
    return this.refresh();
  },

  /* ---------- 退回 ---------- */

  onOpenReject(event) {
    const { entryId, college } = event.currentTarget.dataset;
    if (!entryId) return;

    this.setData({ reject: { open: true, entryId, college: college || '' }, reason: '', actionError: '' });
  },

  onInputReason(event) {
    this.setData({ reason: event.detail.value, actionError: '' });
  },

  onCancelReject() {
    if (this.data.acting) return;
    this.setData({ reject: { open: false, entryId: '', college: '' }, reason: '', actionError: '' });
  },

  /** 提交退回。理由必填——没有理由的退回，学院无从改起 */
  async onSubmitReject() {
    if (this.data.acting) return undefined;

    const reason = String(this.data.reason || '').trim();
    if (!reason) {
      this.setData({ actionError: '请填写退回理由' });
      return undefined;
    }

    const { entryId, college } = this.data.reject;
    this.setData({ acting: entryId, actionError: '' });
    let result;
    try {
      result = await space.forScope(this.scope || this.currentScope()).reviewCollegeEntry({
        eventId: this.eventId, college, action: REVIEW_ACTION.REJECT, reason,
      });
    } catch (err) {
      this.setData({ actionError: (err && err.message) || '操作失败，请重试' });
      return undefined;
    } finally {
      this.setData({ acting: '' });
    }

    if (!result || !result.ok) {
      this.setData({ actionError: (result && (result.firstError || result.message)) || '操作失败' });
      return undefined;
    }

    this.setData({ reject: { open: false, entryId: '', college: '' }, reason: '' });
    this.showToast('已退回', 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
