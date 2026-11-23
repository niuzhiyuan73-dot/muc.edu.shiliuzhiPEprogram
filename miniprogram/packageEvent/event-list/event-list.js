/**
 * 全部赛事
 * ============================================================
 * 赛事页的「查看全部」落点，只保留个人赛事分支。
 *
 * 【学院赛分支已下线】
 * 学院赛整体迁入「石榴籽杯」，列表由 `pages/cup-home` 按项目承载。
 * 旧链接 `?type=college` 仍可能从聊天记录或收藏进入，这里直接重定向，
 * 不再维护第二套学院赛列表。
 *
 * 【为什么改成搜索 + 条件 + 分页】
 * 这一页曾经用 `listLimit: Infinity` 把协会全部历史赛事一次读齐、一次渲染。
 * 赛事一多，读取、传输和视图层节点会一起增长。现在按服务端已经支持的
 * `keyword / year / status / limit / offset` 分页取数，首屏只保留一页。
 * 续页与筛选共用请求令牌和查询键，旧响应不得追加进新列表。
 * ============================================================
 */

const { loadSchoolEventListView } = require('../../services/school-event-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const { EVENT_STATUS } = require('../../utils/constants.js');
const appSession = require('../../services/app-session.js');
// 赛事读取与置顶走同一 S2 范围。
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

const PAGE_SIZE = 20;
/** 输入停顿多久才发请求：连打多个字时只取最后一次条件 */
const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: EVENT_STATUS.SIGNUP, label: '报名中' },
  { value: EVENT_STATUS.ONGOING, label: '进行中' },
  { value: EVENT_STATUS.FINISHED, label: '已结束' },
];

/** 年份下拉：当年往前 6 年 + 全部年份 */
function buildYears(now = new Date()) {
  const current = now.getFullYear();
  const years = [{ value: '', label: '全部年份' }];
  for (let year = current; year > current - 6; year -= 1) {
    years.push({ value: String(year), label: `${year} 年` });
  }
  return years;
}

function actorIdOf() {
  const dto = appSession.get();
  return (dto && dto.session && dto.session.user && dto.session.user.userId) || '';
}

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 已有列表时的后台刷新 */
    refreshing: false,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 视图模型，形状见 services/school-event-view.js 的 loadSchoolEventListView */
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock: false,
    /** 固定为全部赛事；保留字段是为了兼容旧模板与测试 */
    type: 'event',
    /** 导航栏与页内标题 */
    title: '全部赛事',
    /** 置顶 / 取消置顶进行中，防止连点 */
    pinning: false,
    /** 搜索与筛选 */
    keyword: '',
    years: buildYears(),
    yearIndex: 0,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    /** 分页 */
    busy: false,
    hasMore: false,
    nextOffset: 0,
    moreError: '',
    filtered: false,
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    // 学院赛已迁入石榴籽杯：旧链接不报错，直接换页
    if (query && query.type === 'college') {
      this.redirected = true;
      if (typeof wx !== 'undefined' && typeof wx.redirectTo === 'function') {
        wx.redirectTo({ url: '/packageCollege/cup-home/cup-home' });
      }
      return undefined;
    }
    if (typeof this.setData === 'function') this.setData({ isMock: isMockNow() });

    this.setData({ type: 'event', title: '全部赛事' });
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: '全部赛事' });
    }
    return this.refresh();
  },

  /** 从详情 / 发布页返回时刷新一次 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  onUnload() {
    this.loadRequest = (this.loadRequest || 0) + 1;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh();
      }
    });
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /** 当前筛选条件。关键字 / 年份为空时不要发空串，避免服务端把它当过滤值 */
  filters() {
    const year = this.data.years[this.data.yearIndex] || { value: '' };
    const status = this.data.statusOptions[this.data.statusIndex] || { value: '' };
    const out = {};
    const keyword = String(this.data.keyword || '').trim();
    if (keyword) out.keyword = keyword;
    if (year.value) out.year = year.value;
    if (status.value !== '') out.status = Number(status.value);
    return out;
  },

  /**
   * 重新装载第一页。已有列表时不清空，只显示一条「正在更新」；
   * 失败才清空旧数据，避免旧内容配新错误。
   */
  async refresh() {
    const scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: associationScope.getAssociation() };
    this.scope = scope;
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    const hasRows = Boolean(this.data.view && Array.isArray(this.data.view.events) && this.data.view.events.length);
    this.setData({
      loading: !hasRows,
      refreshing: hasRows,
      error: '',
      moreError: '',
      busy: false,
      filtered: Object.keys(this.filters()).length > 0,
    });
    try {
      const view = await loadSchoolEventListView({
        ...scope,
        ...this.filters(),
        actorId: actorIdOf(),
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (request !== this.loadRequest) return;
      this.loaded = true;
      this.setData({
        loading: false,
        refreshing: false,
        error: '',
        view,
        nextOffset: view.nextOffset || view.events.length,
        hasMore: Boolean(view.hasMoreEvents),
        moreError: '',
        themeClass: currentThemeClass(),
      });
    } catch (err) {
      if (request !== this.loadRequest) return;
      console.error('[event-list] 加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        refreshing: false,
        view: {},
        hasMore: false,
        nextOffset: 0,
        error: err.message || '列表加载失败，请下拉重试',
        themeClass: currentThemeClass(),
      });
    }
  },

  /** 续页。查询条件在发起时固定，筛选变化后旧响应直接丢弃。 */
  async loadMore() {
    if (this.data.loading || this.data.refreshing || this.data.busy || !this.data.hasMore) return undefined;
    const request = this.loadRequest;
    const key = JSON.stringify(this.filters());
    this.setData({ busy: true, moreError: '' });
    try {
      const view = await loadSchoolEventListView({
        ...this.scope,
        ...this.filters(),
        actorId: actorIdOf(),
        limit: PAGE_SIZE,
        offset: this.data.nextOffset,
      });
      if (request !== this.loadRequest || key !== JSON.stringify(this.filters())) return undefined;
      const rows = [...(this.data.view.events || []), ...(view.events || [])];
      this.setData({
        busy: false,
        hasMore: Boolean(view.hasMoreEvents),
        nextOffset: view.nextOffset || rows.length,
        view: { ...this.data.view, events: rows, hasEvents: rows.length > 0, eventTotal: view.eventTotal },
        moreError: '',
      });
    } catch (err) {
      if (request !== this.loadRequest || key !== JSON.stringify(this.filters())) return undefined;
      this.setData({ busy: false, moreError: err.message || '加载更多失败，请重试' });
    }
    return undefined;
  },

  /** 搜索框输入：先更新文案，停顿后再请求。 */
  onKeywordInput(event) {
    const keyword = event.detail.value;
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.refresh();
    }, SEARCH_DEBOUNCE_MS);
  },

  /** 键盘「搜索」：不等防抖，立即取数 */
  onSearchConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    return this.refresh();
  },

  onClearKeyword() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (!this.data.keyword) return this.refresh();
    this.setData({ keyword: '' });
    return this.refresh();
  },

  onPickYear(event) {
    this.setData({ yearIndex: Number(event.detail.value) });
    return this.refresh();
  },

  onPickStatus(event) {
    this.setData({ statusIndex: Number(event.detail.value) });
    return this.refresh();
  },

  onResetFilters() {
    this.setData({ keyword: '', yearIndex: 0, statusIndex: 0 });
    return this.refresh();
  },

  onLoadMore() {
    return this.loadMore();
  },

  /**
   * 置顶 / 取消置顶的共用流程：调用 S2 接口判权 → 提示 → 整页重载。
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

  /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
  onOpenPublish() {
    wx.navigateTo({ url: '/packageEvent/event-edit/event-edit' });
  },

  /** 点一场赛事，进详情 */
  onOpenEvent(event) {
    const eventId = event.currentTarget.dataset.eventId;
    if (!eventId) return;
    wx.navigateTo({ url: `/packageEvent/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}` });
  },
});
