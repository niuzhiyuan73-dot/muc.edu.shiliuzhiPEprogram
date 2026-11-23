/**
 * 赛事面板（协会工作台的内嵌页签之一）
 * ============================================================
 * 原来是一个独立的 tabBar 页面。中间三个页签收进「协会工作台」之后，这一页
 * 变成一个自定义组件，由工作台按当前协会挂载。
 * 面板只做四件事：渲染、点人跳转、点赛事跳详情、按名字筛选积分榜。
 * 取数与整形全在 services/school-events-panel-view.js 里。
 *
 * 【这一面板现在有什么】
 *   1. 赛事列表：近期有哪些赛事、我报了哪一场，是赛事闭环的入口；
 *   2. 赛季积分榜：按本赛季积分排序，谁投入谁在前（决策 14），
 *      只展示前 10 名，其余靠搜索框定位。
 * 积分榜是「积分」这把尺子的展示面；「等级分」那把尺子是工作台里的「排行榜」页签。
 *
 * 身份与权限来自 S2 会话及读端能力，列表、积分和置顶使用相同学校 / 协会范围。
 * ============================================================
 */

const { loadSchoolEventsPanelView } = require('../../services/school-events-panel-view.js');
// 积分榜的搜索框与排行榜页是同一套逻辑，直接复用它的纯函数，
// 免得「怎么算命中、怎么拼文案」在两处各写一份、改一处漏一处。
const { describeSearch } = require('../../services/rank-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
// 两类赛事的读取与置顶均走同一 S2 范围。
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Component({
  options: {
    // app.wxss 的 .card / .tag / .rank-head 等全局类要渗进来
    styleIsolation: 'apply-shared',
  },

  properties: {
    active: { type: Boolean, value: true },
  },

  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在面板根节点上 */
    themeClass: '',
    // 视图模型，形状见 services/school-events-panel-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock: false,
    /** 当前是否在浏览外校（演示）赛事：为真时整页只读，隐藏发布 / 置顶入口 */
    demoSchool: false,
    /** 演示学校简称，供只读提示条显示 */
    demoSchoolName: '',

    // ---------- 积分榜按名字筛选 ----------
    // 完整榜留在 this.view 里，页面上只渲染筛选后的结果。与排行榜面板同一套：
    // 每敲一个字都只过一遍本地数组，不重新拉数据。
    /** 当前搜索词 */
    keyword: '',
    /** 正在显示的积分榜行（已筛选） */
    rows: [],
    /** 是否处于搜索状态，用来切换文案口径 */
    searching: false,
    /** 积分榜右上角的计数文案 */
    playerCountText: '',
    /** 筛选后一行都没有 */
    empty: false,
    /** 一行都没有时给的原因 */
    emptyNote: '',
    /** 置顶 / 取消置顶进行中，防止连点 */
    pinning: false,
  },

  lifetimes: {
    attached() {
      this.setData({ isMock: isMockNow() });
      this.onLoad();
    },
    detached() {
      if (typeof this.onUnload === 'function') this.onUnload();
    },
  },

  pageLifetimes: {
    show() {
      if (typeof this.onShow === 'function') this.onShow();
    },
    hide() {
      if (typeof this.onHide === 'function') this.onHide();
    },
  },

  methods: {
    /**
     * 返回 Promise 是有意为之：小程序不关心 onLoad 的返回值，
     * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
     */
    onLoad() {
      return this.refresh();
    },

    /** 从详情 / 发布页返回时刷新一次，刚报的名、刚发的赛事才在列表里 */
    onShow() {
      if (!this.loaded || this.data.active === false) return undefined;
      return this.refresh();
    },

    /** 下拉刷新：数据都在内存里，重算一遍很快 */
    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /**
     * 重新装载整页数据。
     * @returns {Promise<void>}
     */
    async refresh() {
      const scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: associationScope.getAssociation() };
      this.scope = scope;
      const request = this.loadRequest = (this.loadRequest || 0) + 1;
      try {
        const view = await loadSchoolEventsPanelView(scope);
        if (request !== this.loadRequest) return;
        this.loaded = true;
        // 整个视图模型另存一份。里面的完整榜 allRows 不参与渲染，
        // 只当筛选的数据源；交给视图层的副本剥掉它，避免整榜再被序列化一次。
        this.view = view;
        const displayView = { ...view };
        delete displayView.allRows;
        this.setData({
          loading: false,
          error: '',
          view: displayView,
          demoSchool: false,
          demoSchoolName: '',
          themeClass: currentThemeClass(),
        });
        // 重新装载后保留搜索词，重新算一遍要显示的行
        this.applyKeyword(this.data.keyword);
      } catch (err) {
        if (request !== this.loadRequest) return;
        console.error('[events] 加载失败', err);
        this.loaded = true;
        this.view = {};
        this.setData({
          loading: false,
          demoSchool: false,
          demoSchoolName: '',
          view: {}, rows: [], empty: true, playerCountText: '',
          error: err.message || '赛事页加载失败，请下拉重试',
          themeClass: currentThemeClass(),
        });
      }
    },

    /**
     * 按搜索词重算积分榜要显示的行与文案。
     * 纯本地计算，不碰数据源，所以能跟着每一次输入即时调用。
     *
     * @param {string} keyword
     */
    applyKeyword(keyword) {
      const view = this.view || {};
      // 搜索在完整榜（allRows）里找，默认展示的才是截断后的前 10（rows）。
      // 只用 rows 当搜索源的话，前十之外的人永远搜不到。
      const search = describeSearch(view.allRows || [], keyword);
      const idle = !search.searching;

      this.setData({
        keyword: search.keyword,
        rows: idle ? view.rows || [] : search.rows,
        searching: search.searching,
        playerCountText: search.searching
          ? search.countText
          : view.playerCountText || '',
        empty: idle ? Boolean(view.empty) : search.empty,
        emptyNote: idle ? view.emptyNote || '' : search.emptyNote,
      });
    },

    /** 搜索框输入 */
    onInputKeyword(event) {
      this.applyKeyword(event.detail.value);
    },

    /** 清空搜索。清空后回到默认展示的积分榜（前 10） */
    onClearKeyword() {
      this.applyKeyword('');
    },

    /** 轻提示。测试环境里可能没有这个 API */
    showToast(title, icon = 'none') {
      if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
        wx.showToast({ title, icon });
      }
    },

    /**
     * 置顶 / 取消置顶的共用流程：调用 S2 接口判权 → 提示 → 整页重载。
     * 两个列表共用一套，避免「赛事能置顶、学院赛漏了登录判断」这类偏差。
     *
     * @param {() => Promise<Object>} write 写接口
     * @param {string} successText 成功后的提示
     * @returns {Promise<void>}
     */
    async runPin(write, successText) {
      if (this.data.pinning) return undefined;

      this.setData({ pinning: true });
      let result;
      try { result = await write(); } catch (error) { result = { ok: false, message: error.message || '操作失败，请重试' }; }
      finally { this.setData({ pinning: false }); }

      if (!result || !result.ok) {
        this.showToast((result && (result.firstError || result.message)) || '操作失败');
        return undefined;
      }

      this.showToast(successText, 'success');
      return this.refresh();
    },

    /** 管理员置顶 / 取消置顶一场赛事 */
    onToggleEventPin(event) {
      const { eventId, pinned } = event.currentTarget.dataset;
      if (!eventId) return undefined;
      const next = !pinned;
      return this.runPin(
        () => space.forScope(this.scope).setSchoolEventPinned({ eventId, pinned: next }),
        next ? '已置顶' : '已取消置顶'
      );
    },

    /** 进「全部赛事」，看没被截断的完整列表 */
    onMoreEvents() {
      // 外校演示赛事没有对应的列表页（那是本校的），别把人引到本校去
      if (this.data.demoSchool) return undefined;
      wx.navigateTo({ url: '/packageEvent/event-list/event-list?type=event' });
    },

    /** 点榜上的任何一行，去看这个人的完整战绩 */
    onOpenMember(event) {
      // 外校演示榜单里的人没有本校账号，点进去只会是「查无此人」
      if (this.data.demoSchool) return undefined;
      const userId = event.currentTarget.dataset.userId;
      if (!userId) return;

      wx.navigateTo({ url: `/packageMember/member/member?userId=${userId}` });
    },

    /** 点一场赛事，进详情看报名名单或录入名次 */
    onOpenEvent(event) {
      // 外校演示赛事只读，没有可进的详情页
      if (this.data.demoSchool) return undefined;
      const eventId = event.currentTarget.dataset.eventId;
      if (!eventId) return;

      wx.navigateTo({ url: `/packageEvent/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}` });
    },

    /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
    onOpenPublish() {
      wx.navigateTo({ url: '/packageEvent/event-edit/event-edit' });
    },
  },
});
