/**
 * 历史运动会记录（唯一一级标签）
 * ============================================================
 * R02：运动会栏目只有这一个一级标签。筹备中/报名中/进行中都在这里，
 * 用状态标识区分，进行中由服务端置顶（D01），不另开页签。
 *
 * 筛选维度按 D04：名称搜索、年份下拉、状态筛选；学院筛选留了入口，
 * 但只有在「本届学院范围」有数据时才有结果（B5 之后写入）。
 * ============================================================
 */

const meet = require('../services/meet.js');
const { updateMeetPage } = require('../utils/meet-ui.js');
const session = require('../../services/school-session.js');

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'registration', label: '报名中' },
  { value: 'scheduled', label: '赛程已发布' },
  { value: 'running', label: '进行中' },
  { value: 'finished', label: '已结束' },
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

Page({
  data: {
    loading: true,
    error: '',
    schoolId: '',
    keyword: '',
    years: buildYears(),
    yearIndex: 0,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    items: [],
    total: 0,
    offset: 0,
    hasMore: false,
    canManage: false,
    busy: false,
  },

  onLoad() {
    this.unloaded = false;
    this.update({ schoolId: session.getSchoolId() || 'muc' });
    return this.reload();
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    this.unloaded = true;
    this.queryVersion = (this.queryVersion || 0) + 1;
  },

  onPullDownRefresh() {
    const done = () => (typeof wx !== 'undefined' && wx.stopPullDownRefresh ? wx.stopPullDownRefresh() : null);
    return this.reload().then(done, done);
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId });
  },

  /** 按当前筛选条件取第一页 */
  async reload() {
    const version = this.queryVersion = (this.queryVersion || 0) + 1;
    const query = this.query({ offset: 0 });
    const key = JSON.stringify(this.query());
    this.update({ loading: true, busy: false, error: '', hasMore: false });
    try {
      const result = await this.client().listSportsMeets(query);
      if (this.unloaded || version !== this.queryVersion || key !== JSON.stringify(this.query())) return;
      if (result.ok === false) throw new Error(result.message || '加载失败');
      this.update({
        loading: false,
        items: result.items,
        total: result.total,
        offset: result.items.length,
        hasMore: result.items.length < result.total,
        canManage: Boolean(result.permissions && result.permissions.canManage),
      });
    } catch (err) {
      if (!this.unloaded && version === this.queryVersion && key === JSON.stringify(this.query())) {
        this.update({ loading: false, items: [], total: 0, offset: 0, hasMore: false, canManage: false, error: (err && err.message) || '加载失败' });
      }
    }
  },

  query(extra = {}) {
    const years = this.data.years[this.data.yearIndex] || { value: '' };
    const status = this.data.statusOptions[this.data.statusIndex] || { value: '' };
    return {
      keyword: this.data.keyword,
      year: years.value,
      status: status.value,
      limit: PAGE_SIZE,
      ...extra,
    };
  },

  async loadMore() {
    if (this.data.loading || this.data.busy || !this.data.hasMore) return;
    const version = this.queryVersion;
    const key = JSON.stringify(this.query());
    const query = this.query({ offset: this.data.offset });
    this.update({ busy: true });
    try {
      const result = await this.client().listSportsMeets(query);
      if (this.unloaded || version !== this.queryVersion || key !== JSON.stringify(this.query())) return;
      if (result.ok === false) throw new Error(result.message || '加载失败');
      const items = this.data.items.concat(result.items);
      this.update({
        items,
        offset: items.length,
        hasMore: items.length < result.total,
        busy: false,
      });
    } catch (err) {
      if (!this.unloaded && version === this.queryVersion && key === JSON.stringify(this.query())) this.update({ busy: false, error: (err && err.message) || '加载失败' });
    }
  },

  onKeywordInput(event) {
    this.queryVersion = (this.queryVersion || 0) + 1;
    this.update({ keyword: event.detail.value, loading: false, busy: false, hasMore: false });
  },

  onSearch() {
    return this.reload();
  },

  onYearChange(event) {
    this.update({ yearIndex: Number(event.detail.value) });
    return this.reload();
  },

  onStatusChange(event) {
    this.update({ statusIndex: Number(event.detail.value) });
    return this.reload();
  },

  onOpenMeet(event) {
    const meetId = event.currentTarget.dataset.meetId;
    if (!meetId) return undefined;
    return wx.navigateTo({ url: `/packageMeet/meet-detail/meet-detail?meetId=${meetId}` });
  },

  onCreate() {
    return wx.navigateTo({ url: '/packageMeet/meet-setup/meet-setup' });
  },
});
