/**
 * 组队面板（协会工作台的内嵌页签）
 * ============================================================
 * 以前「组队」页签只是一张入口卡：点「进入组队」跳到球队列表页。可组队页签
 * 本身就是「看有哪些队、我在哪支队」，多一次跳转只多一次等待——切到页签
 * 就该看见列表。
 *
 * 面板只做「看」与「进详情」；建队、审批、入队申请仍在球队列表 / 详情页里，
 * 那是另一个完整流程，不适合塞进一屏页签。
 *
 * 【为什么在面板里自己取数】
 * 与 events-panel / match-panel 同一套：面板 attached 时按当前学校 + 协会
 * 取一次，页签切走用 hidden 收起、不销毁，回来时不重复请求。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

/** 页签里只露前几支队，更多去列表页看 */
const PANEL_LIMIT = 6;

Component({
  options: {
    // app.wxss 的 .card / .btn / .tag 等全局类要渗进来
    styleIsolation: 'apply-shared',
  },

  properties: {
    active: { type: Boolean, value: true },
  },

  data: {
    loading: true,
    error: '',
    themeClass: '',
    teams: [],
    total: 0,
    /** 超过上限时提示「还有 N 支」 */
    more: 0,
    emptyText: '还没有球队。协会负责人审核通过建队申请后，这里就会出现',
  },

  lifetimes: {
    attached() {
      this.loadRequest = 0;
      this.onLoad();
    },
    detached() {
      // 卸载后作废在途请求：否则 await 回来的 setData 会打到已销毁的组件上。
      this.loadRequest = (this.loadRequest || 0) + 1;
      this.loaded = false;
    },
  },

  pageLifetimes: {
    // 从建队 / 详情页返回时刷新：刚建的队、刚加入的队要立刻出现
    show() {
      if (!this.loaded || this.data.active === false) return undefined;
      return this.refresh();
    },
  },

  methods: {
    onLoad() {
      return this.refresh();
    },

    onPullDownRefresh() {
      return this.refresh().then(() => {
        if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
          wx.stopPullDownRefresh();
        }
      });
    },

    async refresh() {
      const scope = {
        schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
        association: associationScope.getAssociation(),
      };
      const request = (this.loadRequest || 0) + 1;
      this.loadRequest = request;
      this.setData({ themeClass: currentThemeClass() });
      try {
        const result = await space.forScope(scope).listTeams({});
        if (request !== this.loadRequest) return undefined;
        this.loaded = true;
        if (!result || result.ok !== true) {
          this.setData({ loading: false, error: (result && result.message) || '球队加载失败', teams: [] });
          return undefined;
        }
        const teams = result.teams || [];
        this.setData({
          loading: false,
          error: '',
          teams: teams.slice(0, PANEL_LIMIT),
          total: teams.length,
          more: Math.max(0, teams.length - PANEL_LIMIT),
        });
        return undefined;
      } catch (err) {
        if (request !== this.loadRequest) return undefined;
        this.loaded = true;
        console.error('[team-panel] 加载失败', err);
        this.setData({ loading: false, error: '球队加载失败，请稍后重试', teams: [] });
        return undefined;
      }
    },

    onOpenTeam(event) {
      const { teamid } = event.currentTarget.dataset;
      return wx.navigateTo({ url: `/packageTeam/team-detail/team-detail?teamId=${encodeURIComponent(teamid)}` });
    },

    /** 建队 / 全部球队 / 我的球队，都在列表页里 */
    onOpenAll() {
      return wx.navigateTo({ url: '/packageTeam/team-list/team-list' });
    },
  },
});
