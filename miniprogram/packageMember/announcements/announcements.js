const { withNoticeExpansion } = require('../../templates/notice-experience');
/**
 * 公告列表页
 * ============================================================
 * 首页公告栏只放得下三条，末尾那句「还有 N 条」原来点了没反应。这一页
 * 就是它该去的地方：**本校全部公告**，一个通道。
 *
 * 【为什么没有协会标签，也没有分类标签】
 * 2026-10-18 起公告只有管理员能发，发的是全校信息；协会维度（匹克球 / 乒乓 /
 * 羽毛球）与「通知 / 赛事 / 战报」分类都已从界面移除。repo 里 announcements
 * 也移进 SCHOOL_ONLY 档，一次查询拿到全校公告，不再逐协会各取一次——那样
 * 同一条公告会被重复显示三遍。
 *
 * 【为什么任何人都能看】
 * 公告本就是公开内容。取数在 services/announcement-view.js 的
 * loadSchoolAnnouncementListView，它给每一行恒下发 canArchive: false，
 * 于是管理按钮天然不会冒出来——公开页不需要、也不应该判权限。
 *
 * 【onShow 为什么不需要守卫】
 * 这一页没有下级页面（发布走的是另一页），返回时内容不会变，
 * 不必像比赛页那样在 onShow 里重刷。
 * ============================================================
 */

const { loadSchoolAnnouncementListView } = require('../../services/announcement-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

const { stopRefresh } = require('../../utils/page-helpers.js');

Page(withNoticeExpansion({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    loadingMore: false,
    moreError: '',
    /** 视图模型，形状见 services/announcement-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock: false,
  },

  /** 返回 Promise 是有意为之：测试需要句柄等首屏加载完 */
  onLoad() {
    this.unloaded = false;
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  onUnload() { this.unloaded = true; this.requestVersion = (this.requestVersion || 0) + 1; },
  currentScope() {
    return { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: associationScope.getAssociation() };
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    return stopRefresh();
  },

  /**
   * 重新装载整页数据。协会只用于配色，不影响取数。
   * @returns {Promise<void>}
   */
  async refresh() {
    const version = this.requestVersion = (this.requestVersion || 0) + 1;
    const scope = this.currentScope();
    this.scope = scope;
    this.setData({ loading: true, loadingMore: false, moreError: '', error: '' });
    try {
      const view = await loadSchoolAnnouncementListView(scope);
      if (this.unloaded || version !== this.requestVersion || JSON.stringify(scope) !== JSON.stringify(this.currentScope())) return;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      if (this.unloaded || version !== this.requestVersion) return;
      console.error('[announcements] 公告加载失败', err);
      this.setData({ loading: false, view: {}, error: '公告加载失败，请下拉重试' });
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.view.hasMore) return;
    const version = this.requestVersion;
    const scope = this.scope;
    const cursor = this.data.view.nextCursor;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      if (!cursor) throw new Error('分页信息失效，请下拉刷新');
      const page = await loadSchoolAnnouncementListView({ ...scope, cursor });
      if (this.unloaded || version !== this.requestVersion || JSON.stringify(scope) !== JSON.stringify(this.currentScope())) return;
      if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error('分页信息失效，请下拉刷新');
      const rows = Array.from(new Map(this.data.view.rows.concat(page.rows).map(row => [row.id, row])).values());
      this.setData({ view: { ...page, rows, visibleCount: rows.length }, loadingMore: false });
    } catch (error) {
      if (!this.unloaded && version === this.requestVersion) this.setData({ loadingMore: false, moreError: error.message || '加载失败，请重试' });
    }
  },
}));
