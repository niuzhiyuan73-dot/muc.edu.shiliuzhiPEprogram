const { loadPersonalSports, openSportsTarget, careerMilestonesOf } = require('../../templates/personal-sports-client');
const schoolSession = require('../../services/school-session');
const association = require('../../services/association-scope');
const { allAssociations, isKnownAssociation } = require('../../shared/utils/associations');
const { currentThemeClass } = require('../../services/branding');
const { formatDateTime } = require('../../shared/utils/format');
const TABS = [{ id: 'schedule', label: '我的赛程' }, { id: 'tasks', label: '我的待办' }, { id: 'passport', label: '运动护照' }];
const CAPTIONS = { schedule: '未来 90 天已排期安排；等待赛程单独标记。', tasks: '只显示当前有权限处理的事项，进入后仍会重新核验状态。', passport: '记录经确认或发布的事实。名单入选、报告收录和实际出场分别表述。' };
Page({
  data: { tab: 'schedule', tabs: TABS, project: '', projects: [{ id: '', label: '全部项目' },
    ...allAssociations().map(row => ({ id: row.id, label: row.sportName })), { id: 'meet', label: '运动会' }],
    themeClass: '', loading: true, updating: false, loadingMore: false, error: '', moreError: '', items: [],
    milestones: [],
    hasMore: false, nextCursor: '', focusMatchId: '', focusKey: '', asOfText: '', schoolName: '',
    caption: '按本人关系查询，包含未来 90 天已排期安排；等待赛程单独标记。' },
  onLoad(query = {}) {
    this.destroyed = false;
    const tab = TABS.some(row => row.id === query.tab) ? query.tab : 'schedule';
    if (isKnownAssociation(query.association)) association.setAssociation(query.association);
    this.setData({ tab, caption: CAPTIONS[tab], focusMatchId: query.matchId || '', focusKey: `${query.association || ''}:${query.matchId || ''}`, themeClass: currentThemeClass() });
    this.identity = this.identityKey();
    return this.refresh(false);
  },
  onShow() {
    if (!this.loaded) return;
    if (this.identity !== this.identityKey()) { this.identity = this.identityKey(); this.setData({ items: [], milestones: [], focusMatchId: '', nextCursor: '', loading: true }); }
    return this.refresh(false);
  },
  onUnload() { this.destroyed = true; this.request = (this.request || 0) + 1; },
  onPullDownRefresh() { return this.refresh(false).finally(() => { if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh(); }); },
  identityKey() {
    const app = typeof getApp === 'function' ? getApp() : null;
    const user = app?.getUserInfo ? app.getUserInfo() : app?.globalData?.userInfo;
    return JSON.stringify([schoolSession.getSchoolId() || 'muc', user?._id || user?.userId || '', user?.platformStatus || '']);
  },
  async refresh(append = false) {
    if (this.destroyed || append && (this.data.loadingMore || !this.data.hasMore)) return;
    const request = this.request = (this.request || 0) + 1, key = this.identityKey();
    this.setData({ error: '', moreError: '', loading: !append && !this.data.items.length,
      updating: !append && Boolean(this.data.items.length), loadingMore: append });
    try {
      const result = await loadPersonalSports(schoolSession.getSchoolId() || 'muc', {
        section: this.data.tab, project: this.data.project, cursor: append ? this.data.nextCursor : '', limit: 20 });
      if (this.destroyed || request !== this.request || key !== this.identityKey()) return;
      if (!result.ok) { const error = new Error(result.message || '读取失败，请重试'); error.resetRequired = result.resetRequired; throw error; }
      const rows = new Map((append ? this.data.items : []).map(row => [row.key, row]));
      for (const row of result.items || []) rows.set(row.key, row);
      const items = [...rows.values()];
      this.loaded = true;
      this.setData({ items,
        milestones: this.data.tab === 'passport' ? careerMilestonesOf(items) : [],
        hasMore: Boolean(result.hasMore), nextCursor: result.nextCursor || '',
        asOfText: result.asOf ? formatDateTime(result.asOf) : '', loading: false, updating: false, loadingMore: false });
    } catch (error) {
      if (this.destroyed || request !== this.request || key !== this.identityKey()) return;
      this.loaded = true;
      this.setData({ loading: false, updating: false, loadingMore: false,
        ...(append && !error.resetRequired ? { moreError: error.message || '续页失败，请重试' } : { error: error.message || '读取失败，请重试', items: [], milestones: [], nextCursor: '', hasMore: false, focusMatchId: '' }) });
    }
  },
  onTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!TABS.some(row => row.id === tab) || tab === this.data.tab) return;
    this.setData({ tab, items: [], milestones: [], nextCursor: '', hasMore: false, focusMatchId: '', loading: true,
      caption: CAPTIONS[tab] });
    return this.refresh(false);
  },
  onProject(event) {
    const project = event.currentTarget.dataset.project;
    if (!this.data.projects.some(row => row.id === project) || project === this.data.project) return;
    this.setData({ project, items: [], milestones: [], nextCursor: '', hasMore: false, loading: true, focusMatchId: '' });
    return this.refresh(false);
  },
  onOpen(event) {
    const row = this.data.items.find(item => item.key === event.currentTarget.dataset.key);
    if (!row) return;
    if (['personal_match', 'confirm_score'].includes(row.target.kind)) {
      association.setAssociation(row.target.association);
      this.setData({ focusMatchId: row.target.id, focusKey: `${row.target.association}:${row.target.id}`, themeClass: currentThemeClass() });
      if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 180 });
    } else openSportsTarget(row.target);
  },
  onCloseMatch() { this.setData({ focusMatchId: '' }); return this.refresh(false); },
  onRetry() { return this.refresh(false); },
  onMore() { return this.refresh(true); },
});
