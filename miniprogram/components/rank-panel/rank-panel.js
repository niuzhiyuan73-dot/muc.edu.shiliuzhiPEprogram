/**
 * 排行榜面板（协会工作台的内嵌页签之一）
 * ============================================================
 * 原来是一个独立的 tabBar 页面。中间三个页签（排行榜 / 比赛 / 赛事）收进
 * 「协会工作台」之后，这一页变成一个自定义组件，由工作台按当前协会挂载。
 * 数据来源不随形态改变：取数与整形仍全在 services/rank-view.js。
 *
 * 【B4-a 起走学校维度】榜单改读 S2（association-space forScope →
 * getSchoolRanking），范围 = 当前浏览学校 + 当前协会。外校静态演示榜单
 * 不再作为真实查询成功的结果；无读取权限时清空旧榜单并展示服务端拒绝原因。
 *
 * 【只剩一个榜单类型】
 * 界面精简后去掉了「进步榜」，只剩等级分榜。项目（男单 / 女单 / 双打）
 * 仍可切换——男单榜与女单榜取自同一个单打池，分数可比。
 * 榜单列表只显示前 10 名，「我的排名」卡由视图模型按完整榜单算。
 *
 * 【为什么生命周期方法还叫 onLoad / onShow】
 * 组件没有页面的 onLoad / onShow，这里用 lifetimes.attached / pageLifetimes.show
 * 转调同名方法。这样逻辑体与页面时期一模一样，且测试（tests/page.test.js）能
 * 直接 instantiate 这个组件配置、调用 page.onLoad()。
 * ============================================================
 */

const { loadSchoolRankView, describeSearch } = require('../../services/rank-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const space = require('../../services/association-space');
const schoolSession = require('../../services/school-session');
const associationScope = require('../../services/association-scope');

Component({
  options: {
    // 组件默认样式隔离，app.wxss 里的 .card / .pool-tabs / .btn 等全局类进不来。
    // apply-shared 让全局与所在页面的样式渗入组件，本面板的样式仍不外泄。
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
    /** 切换项目时给个淡淡的反馈 */
    switching: false,
    // 视图模型，形状见 services/rank-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock: false,

    // ---------- 按名字筛选 ----------
    // 完整榜单留在 this.view 里，面板上只渲染筛选后的结果。这样每敲一个字
    // 都只是本地过一遍数组，不必重新拉数据——搜索框打字不该卡。
    /** 当前搜索词 */
    keyword: '',
    /** 正在显示的榜单行（已筛选） */
    rows: [],
    /** 是否处于搜索状态，用来切换文案口径 */
    searching: false,
    /** 榜单右上角的计数文案 */
    playerCountText: '',
    /** 筛选后一行都没有 */
    empty: false,
    /** 一行都没有时给的原因，可能是「没人打过」也可能是「搜不到」 */
    emptyNote: '',
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

    /**
     * 从别的页面切回时重算榜单：刚确认的比赛会改变名次。
     * 【为什么要 loaded 这道闸】attached 之后框架紧接着就会调一次 show，
     * 没有它首屏会被白刷两遍。loaded 只在首屏那次 refresh 落地后才置真，
     * 因此紧随其后的 onShow 会被挡掉，此后每次切回来都重算。
     */
    onShow() {
      if (!this.loaded || this.data.active === false) return undefined;
      return this.refresh();
    },

    /** 卸载后作废仍在途的请求，旧响应不得写回已离开的面板 */
    onUnload() {
      this.request = (this.request || 0) + 1;
    },

    /** 下拉刷新：数据都在内存里，重算一遍很快 */
    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /**
     * 重新装载整页数据。范围在开始时绑定：学校取当前浏览学校，协会取当前协会，
     * 异步等待后不重新读全局 scope（B4 与指南 §9 同一纪律）。
     * @returns {Promise<void>}
     */
    async refresh() {
      const request = this.request = (this.request || 0) + 1;
      const scope = { schoolId: schoolSession.getSchoolId() || 'muc', association: associationScope.getAssociation() };
      try {
        const view = await loadSchoolRankView(space.forScope(scope), { project: this.currentProject });
        if (request !== this.request) return;
        // 完整榜单另存一份。它不参与渲染，只当筛选的数据源。
        // 交给视图层的副本必须剥掉 allRows，否则这份完整榜仍会被序列化一次。
        this.view = view;
        const displayView = { ...view };
        delete displayView.allRows;
        this.setData({
          loading: false,
          error: '',
          switching: false,
          view: displayView,
          themeClass: currentThemeClass(),
        });
        // 切项目/榜单时保留搜索词：搜姓「张」的人，切到女单榜也该还是「张」
        this.applyKeyword(this.data.keyword);
      } catch (err) {
        if (request !== this.request) return;
        console.error('[rank] 加载失败', err);
        // 读取拒绝 / 网络异常后清空旧榜单：切学校时不能把上一所学校的名单留在屏上
        this.view = {};
        this.setData({
          loading: false,
          switching: false,
          view: {},
          error: err.message || '排行榜加载失败，请下拉重试',
          themeClass: currentThemeClass(),
        });
        this.applyKeyword(this.data.keyword);
      } finally {
        // 失败也置真：让后续 onShow 还能再试一次，否则一次抖动就再也不刷新了
        this.loaded = true;
      }
    },

    /**
     * 按搜索词重算面板要显示的榜单与文案。
     * 纯本地计算，不碰数据源，所以能跟着每一次输入即时调用。
     *
     * @param {string} keyword
     */
    applyKeyword(keyword) {
      const view = this.view || {};
      // 搜索在完整榜单里找（allRows），默认展示的才是截断后的前 10（rows）。
      // 只用 rows 当搜索源的话，前十之外的人永远搜不到。
      const search = describeSearch(view.allRows || [], keyword);
      const idle = !search.searching;

      this.setData({
        keyword: search.keyword,
        rows: idle ? view.rows || [] : search.rows,
        searching: search.searching,
        // 搜索时才问「找到几人」；不搜索时用视图模型算好的计数——
        // 它要交代「前 10 名 · 共 N 人」，光说榜上这 10 个人会少报总数
        playerCountText: search.searching
          ? search.countText
          : view.playerCountText || '',
        // 不搜索时回到「默认展示的前 10」的空态，而不是全量榜单的空态
        empty: idle ? Boolean(view.empty) : search.empty,
        emptyNote: idle ? view.emptyNote || '' : search.emptyNote,
      });
    },

    /** 搜索框输入 */
    onInputKeyword(event) {
      this.applyKeyword(event.detail.value);
    },

    /** 清空搜索。清空后回到完整榜单 */
    onClearKeyword() {
      this.applyKeyword('');
    },

    /** 切换项目 */
    onSwitchProject(event) {
      const { project } = event.currentTarget.dataset;
      if (!project || project === this.data.view.activeProject || this.data.switching) {
        return undefined;
      }

      this.currentProject = project;
      this.setData({ switching: true });
      return this.refresh();
    },

    /**
     * 点榜上的任何一行，去看这个人的完整战绩。
     * 这里不排除「我自己」——从榜单进自己主页看曲线，是很自然的动作。
     * 榜单行是 S2 的本校会员，编号可直接进个人主页。
     */
    onOpenMember(event) {
      const userId = event.currentTarget.dataset.userId;
      if (!userId) return;

      wx.navigateTo({ url: `/packageMember/member/member?userId=${encodeURIComponent(userId)}` });
    },
  },
});
