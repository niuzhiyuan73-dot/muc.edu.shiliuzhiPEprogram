/**
 * 录入名次
 * ============================================================
 * 一场赛事的最后一步：给参赛者填名次，提交即结束赛事。
 * 取数与权限判定走学校维度（协议 2）：视图模型 services/school-event-view.js
 * 把服务端 DTO 转成旧栈同形的数据，名次校验在 services/event.js，页面只做
 * 交互与 setData。
 *
 * 【为什么名次录入与签到不在一页】
 * 签到在赛事当天做，人来一个点一个，要的是快；名次在赛后做，要对着成绩
 * 仔细填，还要判「打三四名」的名次成不成对。两件事的节奏与风险都不同，
 * 分开两页，各自把事情说清楚。
 *
 * 【为什么提交即结束】
 * 名次是积分的唯一依据（决策 9）。让赛事停在「已有名次但未结束」的中间态，
 * 积分就不知道该不该算，会出现「名次录了、榜上却没分」的怪象。所以录入
 * 与结束合成一个动作，落库那一刻名次与积分同时定下来。
 *
 * 【没有管理权为什么不让进】
 * 名次直接换成积分，一个错字就凭空多出一位参赛者。所以失败关闭：
 * 服务端的 canManage 为假时一条名单都不下发（见 school-event-view）。
 *
 * 【登录态从哪来】
 * 学校维度下没有旧栈那份客户端账号快照：读写都由协会空间按当前身份执行，
 * 页面只向身份接口问一次会话，用来把「去登录」与「没权限」两句提示分开。
 * 范围（学校 + 协会）在进入时固定一次，之后每个请求都用这把范围。
 * ============================================================
 */

const { loadSchoolEventPlacementView } = require('../../services/school-event-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

const { pageScope, stopRefresh, toast } = require('../../utils/page-helpers.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 视图模型，形状见 services/events-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock: false,
    /** 提交中，防止连点 */
    submitting: false,
    /** 整体错误提示 */
    errorText: '',
  },

  /** 返回 Promise 让测试能等待首屏加载完。
   *
   * `this.eventId` 初值是路由 query 原样（开发者工具里仍是未解码的 %3A 形式）；
   * 装载成功后换成探测出的真实编号，提交（结束赛事）才落在同一场赛事上。
   */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /**
   * 本次身份会话里的操作者编号，只用来把「去登录」与「没权限」分开。
   * 拿不到（没有账号，或身份接口报错）就按访客处理，绝不猜一个身份出来。
   */
  async currentActorId() {
    try {
      const session = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
      return (session && session.user && session.user.userId) || null;
    } catch (err) {
      console.error('[event-placement] 读取学校身份失败', err);
      return null;
    }
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
   * 会覆盖已填的名次——所以只在下拉刷新与首次进入时调用。
   *
   * 装载器回传的 `eventId` 是探测命中的真实编号（路由 query 在开发者工具 /
   * 真机上原样透传，仍是未解码值），采纳它，提交时才不会「赛事不存在」。
   * @returns {Promise<void>}
   */
  async refresh() {
    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();

    try {
      const view = await loadSchoolEventPlacementView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      if (view.eventId) this.eventId = view.eventId;
      this.setData({ loading: false, error: '', view, errorText: '', themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[event-placement] 名次页加载失败', err);
      this.setData({ loading: false, error: '名次录入页加载失败，请下拉重试', themeClass: currentThemeClass() });
    }
  },

  /**
   * 改写某一行已填的名次。
   * 整块重写 rows 而不是用 rows[0].x 这样的路径键：路径键的写法在测试环境
   * 里跑不通，而整块替换两边行为一致。
   */
  onInputPlacement(event) {
    const index = Number(event.currentTarget.dataset.index);
    const rows = (this.data.view.rows || []).slice();
    if (!rows[index]) return;

    rows[index] = { ...rows[index], placementText: event.detail.value };
    this.setData({ view: { ...this.data.view, rows }, errorText: '' });
  },

  /**
   * 把已填的名次收成 [{ userId, placement }]。
   * 空着的人不录入——他可能报了名却没到场，不该被硬塞一个名次。
   *
   * 【双打为什么一行摊成两条】
   * 名次页在双打下按队伍给行（一人填一次就够），但名次最终要记在每个人
   * 头上（两人的名次相同），后续积分才按人结算。所以这里把一行的名次
   * 摊到该队两名成员，页面看到的是一行，落库的是两条。
   *
   * @returns {{error:string, results:Array<Object>}}
   */
  collectResults() {
    const rows = (this.data.view && this.data.view.rows) || [];
    const results = [];

    for (const row of rows) {
      const raw = row.placementText;
      const text = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!text) continue;

      const placement = Number(text);
      if (!Number.isInteger(placement) || placement < 1) {
        return { error: '名次必须是不小于 1 的整数', results: [] };
      }
      // 单打的行只有 userId；双打的行带 userIds（两人），逐人落下同名次
      const members =
        Array.isArray(row.userIds) && row.userIds.length > 0 ? row.userIds : [row.userId];
      for (const userId of members) {
        results.push({ userId, placement });
      }
    }

    if (results.length === 0) {
      return { error: '请至少给一位参赛者录入名次', results: [] };
    }
    return { error: '', results };
  },

  /** 提交名次并结束赛事。能否录入由服务端 capability（view.canEdit）决定 */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (!this.data.view.canEdit) return undefined;

    const collected = this.collectResults();
    if (collected.error) {
      this.setData({ errorText: collected.error });
      return undefined;
    }

    this.setData({ submitting: true, errorText: '' });
    try {
      const result = await space.forScope(this.scope || this.currentScope())
        .finishSchoolEvent({ eventId: this.eventId, results: collected.results });

      if (!result || !result.ok) {
        this.setData({
          errorText: (result && (result.firstError || result.message)) || '录入失败',
        });
        return undefined;
      }

      this.showToast('名次已录入，赛事结束', 'success');
      wx.navigateBack();
      return undefined;
    } catch (err) {
      this.setData({ errorText: (err && err.message) || '录入失败，请重试' });
      return undefined;
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 放弃录入，回详情页 */
  onCancel() {
    wx.navigateBack();
  },
});
