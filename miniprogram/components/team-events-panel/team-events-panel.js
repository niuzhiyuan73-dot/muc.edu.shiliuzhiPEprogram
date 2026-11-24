/**
 * 团队赛事面板（协会工作台的内嵌页签）
 * ============================================================
 * 与组队页签同一个道理：切到「赛事」就该看见这一届有哪些比赛在进行，
 * 而不是再点一次「进入团队赛事」。
 *
 * 面板只列赛事、进详情；建赛仍在团队赛事列表页里（要选赛制与规则快照，
 * 表单比一屏页签能容纳的多）。
 *
 * 【状态文案为什么在服务端】
 * 列表直接用 `event.statusLabel`。这里曾经把中文映射表用错（拿 status 值
 * 去查「状态 → 值」的表），界面上标出 `registration` / `finished`——
 * 这一类错只能靠「服务端给文案、页面不查表」来根治。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

const PANEL_LIMIT = 6;

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    active: { type: Boolean, value: true },
  },

  data: {
    loading: true,
    error: '',
    themeClass: '',
    events: [],
    total: 0,
    more: 0,
    canManage: false,
    emptyText: '还没有赛事。协会负责人建赛后，这里会列出报名与赛程',
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
    // 从建赛 / 详情页返回时刷新：刚建的赛事、刚发布的名次要立刻出现
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
        const result = await space.forScope(scope).listTeamEvents({});
        if (request !== this.loadRequest) return undefined;
        this.loaded = true;
        if (!result || result.ok !== true) {
          this.setData({ loading: false, error: (result && result.message) || '赛事加载失败', events: [] });
          return undefined;
        }
        const events = result.events || [];
        this.setData({
          loading: false,
          error: '',
          canManage: result.canManage === true,
          events: events.slice(0, PANEL_LIMIT),
          total: events.length,
          more: Math.max(0, events.length - PANEL_LIMIT),
        });
        return undefined;
      } catch (err) {
        if (request !== this.loadRequest) return undefined;
        this.loaded = true;
        console.error('[team-events-panel] 加载失败', err);
        this.setData({ loading: false, error: '赛事加载失败，请稍后重试', events: [] });
        return undefined;
      }
    },

    onOpenEvent(event) {
      const { eventid } = event.currentTarget.dataset;
      return wx.navigateTo({
        url: `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent(eventid)}`,
      });
    },

    /** 建赛与全部赛事都在列表页 */
    onOpenAll() {
      return wx.navigateTo({ url: '/packageTeam/team-event-list/team-event-list' });
    },
  },
});
