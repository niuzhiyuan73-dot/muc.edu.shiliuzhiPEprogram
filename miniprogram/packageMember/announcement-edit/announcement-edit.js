const { withFormExperience } = require('../../templates/form-experience.js');
/**
 * 发布公告
 * ============================================================
 * 只做一件事：把一张填好的单子变成一条「已发布」的公告。
 * 内容校验与落库记录在 services/announcement.js（纯函数），发布本身走学校
 * 维度服务（association-space 的 forScope），这里负责交互与 setData。
 *
 * 【为什么独立成页而不是管理页里的一个弹层】
 * 标题、分类、正文、置顶四项，正文还要一大块输入区，弹层里挤不下；
 * 而且将来要支持「改草稿」时，带参数的独立页比弹层好扩展。
 *
 * 【没有发布权为什么不让进】
 * 用户可能绕过管理页直接从小程序码进来。填完再被拒，比一开始就说清楚
 * 糟得多，所以进来先判一道，不给表单。发布权给平台管理员与本校校级管理员
 * （会话布尔量 canManageSchool，与服务端 canPublishAnnouncement 同源）。
 *
 * 【为什么没有分类选择】
 * 公告只有一个通道，分类（通知 / 赛事 / 战报）已从界面移除，不再让人选一个
 * 不影响任何展示的字段。落库时固定填默认分类，兼容旧校验。
 *
 * 【requestId 是什么】
 * 学校维度发布接口按 requestId 派生稳定编号：同一次提交重试（网络重发、
 * 连点）落到同一条；改了内容却复用同号则被拒。所以每次提交现生成一个。
 * ============================================================
 */

const { TITLE_MAX, CONTENT_MAX, DEFAULT_CATEGORY } = require('../../services/announcement.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 生成一次提交的请求编号：时间戳 + 随机后缀，满足服务端的编号字符集要求 */
function nextRequestId() {
  return `pub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const { pageScope, toast } = require('../../utils/page-helpers.js');

Page(withFormExperience({
  data: {
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock: false,
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',

    /** 没有发布权时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /**
     * 分类已从界面移除（2026-10-18：公告只剩一个通道，只有管理员可发）。
     * 表单仍带一个固定的值，因为旧模块 validateAnnouncement 要求白名单内的分类；
     * 它不展示、不参与筛选，只作为历史字段落库。
     */
    /** 输入长度上限，交给 maxlength 属性 */
    titleMax: TITLE_MAX,
    contentMax: CONTENT_MAX,

    /** 表单本体（category 固定为默认档，见上面的说明） */
    form: { title: '', content: '', category: DEFAULT_CATEGORY, pinned: false },
    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',
  },

  async onLoad() {
    this.setData({ isMock: isMockNow() });
    const scope = this.currentScope();
    this.scope = scope;

    let session = null;
    try {
      session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
    } catch (err) {
      console.error('[announcement-edit] 读取学校身份失败', err);
    }

    // 发布权：平台管理员 + 本校校级管理员。会话的 canManageSchool 与
    // 服务端 canPublishAnnouncement 同源（平台管理员为真、校级管理员为真、
    // 协会/学院负责人为假）；再并上 isPlatformAdmin，避免演示账号切到外校只读
    // 时（readOnly 会清空 canManageSchool）把平台管理员也挡掉。
    const allowed = Boolean(session && (session.canManageSchool || session.isPlatformAdmin));
    this.setData({ blockReason: this.describeBlock(allowed, session), themeClass: currentThemeClass() });
  },

  /** 当前「学校 + 协会」范围。写操作复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /**
   * 不能发布的原因。能发布时返回空串。
   * 有没有在册学校身份（account）决定是「去登录」还是「没权限」——演示账号里
   * 没有停用的平台账号，拿 user 判不出「没有学校身份」。
   */
  describeBlock(allowed, session) {
    if (allowed) return '';
    return session && session.account
      ? '当前账号没有发布公告的权限，请联系管理员'
      : '请先登录后再发布公告';
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    return toast(title, icon);
  },

  /* ---------- 表单交互 ---------- */

  /**
   * 写入一个字段，并清掉它的旧错误。
   * 一律走这里，免得某个字段改了、错误提示却没跟着消失。
   */
  setField(key, value) {
    this.setData({
      form: { ...this.data.form, [key]: value },
      errors: { ...this.data.errors, [key]: '' },
      errorText: '',
    });
  },

  onInputTitle(event) {
    this.setField('title', event.detail.value);
  },

  onInputContent(event) {
    this.setField('content', event.detail.value);
  },

  onTogglePinned(event) {
    this.setField('pinned', Boolean(event.detail.value));
  },

  /* ---------- 提交 ---------- */

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason) return undefined;

    this.setData({ submitting: true, errors: {}, errorText: '' });
    const result = await space.forScope(this.scope || this.currentScope())
      .publishSchoolAnnouncement({ ...this.data.form, requestId: nextRequestId() });

    if (!result.ok) {
      this.setData({
        submitting: false,
        errors: result.errors || {},
        errorText: result.firstError || result.message || '发布失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已发布', 'success');
    // 退回管理页，onShow 会刷新，刚发的那条就在台账里
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
}));
