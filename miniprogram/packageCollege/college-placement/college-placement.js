/**
 * 录入学院名次（M5-1）
 * ============================================================
 * 一场学院赛的最后一步：给参赛学院填名次，提交即结束赛事。
 * 取数与权限走学校维度（协议 2）：services/school-college-view.js 的
 * loadCollegePlacementView 把服务端 DTO 整成旧栈同形，名次校验在
 * services/college-event.js 的 validateCollegePlacements；写入由协会空间按
 * 当前身份执行。页面只做交互与 setData。
 *
 * 【为什么行是学院不是人】
 * 学院赛的名次只记给学院（D26）：学院进签表、大场套小场，个人打得再好
 * 也不单独排名。所以候选来自已通过审核的名单里的学院，一行一所学院。
 *
 * 【为什么提交即结束】
 * 与个人赛同一道理：名次是学院赛的句号。让赛事停在「已有名次但未结束」
 * 的中间态，页面就说不清它算不算打完，所以录入与结束合成一个动作。
 *
 * 【为什么失败关闭】
 * 名次直接决定学院赛的名次展示；没有管理权时一条学院名单都不下发。
 * ============================================================
 */

const { loadCollegePlacementView } = require('../../services/school-college-view.js');
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
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock: false,
    /** 提交中，防止连点 */
    submitting: false,
    /** 整体错误提示 */
    errorText: '',
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  /** 下拉刷新。会覆盖已填内容，只在用户明确下拉时触发 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
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
      console.error('[college-placement] 读取学校身份失败', err);
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
   * @returns {Promise<void>}
   */
  async refresh() {
    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();

    try {
      const view = await loadCollegePlacementView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      // 采纳装载器探测出的真实编号再用于写：query 在微信开发者工具 / 真机里是
      // 原样透传的（未解码），继续拿路由原值提交名次会被服务端答「学院赛不存在」
      // （见 utils/route-query.js）。解析只做一次，之后读写都用它。
      if (view.eventId) this.eventId = view.eventId;
      this.setData({ loading: false, error: '', view, errorText: '', themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[college-placement] 名次页加载失败', err);
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
   * 把已填的名次收成 [{ college, placement }]。
   * 空着的学院不录入——它可能没到场，不该被硬塞一个名次。
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
      results.push({ college: row.college, placement });
    }

    if (results.length === 0) {
      return { error: '请至少给一所学院录入名次', results: [] };
    }
    return { error: '', results };
  },

  /** 提交名次并结束赛事 */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (!this.data.view.canSubmit) return undefined;

    const collected = this.collectResults();
    if (collected.error) {
      this.setData({ errorText: collected.error });
      return undefined;
    }

    const scope = this.scope || this.currentScope();
    this.setData({ submitting: true, errorText: '' });
    try {
      const result = await space.forScope(scope)
        .finishCollegeEvent({ eventId: this.eventId, results: collected.results });

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
