const space = require('../../services/association-space');
const schoolSession = require('../../services/school-session');
const associationScope = require('../../services/association-scope');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school');
const { currentThemeClass } = require('../../services/branding');
const { teamProfileView } = require('../../utils/team-profile-view');
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { association: { type: String, value: '' }, active: { type: Boolean, value: false, observer(value) {
    if (value && this.loaded) return this.refresh();
    return undefined;
  } } },
  data: { loading: true, error: '', themeClass: '', profile: null },
  lifetimes: { attached() { return this.refresh(); }, detached() { this.loadRequest = (this.loadRequest || 0) + 1; } },
  pageLifetimes: { show() { if (this.loaded && this.properties.active) return this.refresh(); return undefined; } },
  methods: {
    async refresh() {
      const request = (this.loadRequest || 0) + 1; this.loadRequest = request;
      const scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: this.properties.association || associationScope.getAssociation() };
      this.setData({ loading: true, error: '', themeClass: currentThemeClass() });
      try {
        const result = await space.forScope(scope).getMyTeamProfile({});
        if (request !== this.loadRequest) return;
        this.loaded = true;
        if (!result?.ok) { this.setData({ loading: false, profile: null, error: result?.message || '团队成绩加载失败' }); return; }
        this.setData({ loading: false, profile: teamProfileView(result) });
      } catch (_) { if (request === this.loadRequest) this.setData({ loading: false, profile: null, error: '团队成绩加载失败，请重试' }); }
    },
    onPullDownRefresh() { return this.refresh().finally(() => { if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh(); }); },
    onOpenTeam(event) { return wx.navigateTo({ url: `/packageTeam/team-detail/team-detail?teamId=${encodeURIComponent(event.currentTarget.dataset.teamid)}` }); },
    onOpenEvent(event) { return wx.navigateTo({ url: `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent(event.currentTarget.dataset.eventid)}` }); },
  },
});
