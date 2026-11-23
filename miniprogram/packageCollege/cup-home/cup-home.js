/**
 * 石榴籽杯（校级活动）
 * ============================================================
 * 学院赛整体迁入本栏目后的唯一入口。
 *
 * 【结构：项目就是杯赛】
 * 顶部项目来自协会注册表（匹克球 / 乒乓 / 羽球 / 网球 / 篮球 / 足球…），不是
 * 「一届杯赛的几个项目」——每个项目各自就是一个石榴籽杯。切换项目等于切换当前
 * 协会，下方列表就是该项目的学院赛。
 * 项目栏一屏只放三个，其余左滑：项目只会越加越多，全铺开会让页头随项目数量
 * 膨胀；但当前项目必须看得见，所以切换后按 id 把它 scroll-into-view 滚进来。
 *
 * 【一个搜索框，两样东西】
 * 关键词既匹配项目（本地算，命中即成行，点一下切过去），也匹配本项目里的赛事
 * （服务端按名称/场地过滤，跨分页）。理由见 wxml 顶部注释。
 *
 * 【不设届次】
 * 同一项目一年可以发起多次，列表按**发起时间**归档；年份只作为筛选条件，
 * 不做「第几届」的建模。因此这里没有 cupId，也不新建集合。
 *
 * 【权限沿用学院赛口径】
 * 发起、审核、抽签、开赛、结束、置顶都看读端下发的 canManage：
 * 校级管理员与本项目协会负责人（可多人）为真，其他项目负责人天然不在
 * 当前协会范围内，读端不会给他这个能力。
 * ============================================================
 */

const { activeAssociations, sportTypeOf, SPORT_TYPE } = require('../../utils/associations.js');
const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');
const { CUP_MODE, EVENT_FORMAT_LABEL } = require('../../utils/constants.js');

const PAGE_SIZE = 50;
/** 输入停顿多久才发请求：按住键盘连打时不至于每敲一个字都问一次服务端 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 团队赛事状态 → 杯赛页的四组。
 *
 * 球拍学院赛的状态本来就是 0–3；团队赛有七个字符串状态。页面只认四组，
 * 转换放在这一个表里，页面以下的代码（分组、筛选、标签）都不必知道具体状态名。
 * 新增状态忘了登记会落进「进行中」，并且有测试钉住枚举全集。
 */
const TEAM_STATUS_GROUP = {
  registration: 0,
  locked: 1,
  scheduled: 1,
  running: 2,
  finished: 3,
  canceled: 3,
  draft: 0,
};

/** 状态筛选项。value 用空串表示不限，其余是 COLLEGE_EVENT_STATUS 的数字值 */
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 0, label: '报名中' },
  { value: 1, label: '待开赛' },
  { value: 2, label: '进行中' },
  { value: 3, label: '已结束' },
];

/** 分组顺序：进行中的排在前面，已结束沉底 */
const STATUS_ORDER = [
  { status: 0, label: '报名中' },
  { status: 1, label: '待开赛' },
  { status: 2, label: '进行中' },
  { status: 3, label: '已结束' },
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
    busy: false,
    schoolId: '',
    themeClass: '',
    /** 各球类项目：{ id, sportName, shortName, name, glyph } */
    projects: [],
    projectId: '',
    projectName: '',
    /** 项目栏滚动定位：切换后把选中项滚进可视区，别把当前项目留在屏幕外 */
    projectAnchor: '',
    /** 搜索关键词：同时匹配项目与赛事（名称 / 场地） */
    keyword: '',
    /** 关键词命中的项目（本地匹配；点一下即切换项目） */
    projectMatches: [],
    /**
     * 当前项目是不是团队项目（篮球/足球）。
     * 团队项目的学院赛长在团队赛事上（按学院组队、一场一场打），
     * 球拍项目长在学院赛上（学院报名 → 小项 → 大场）。页面只按这个布尔量分派取数。
     */
    isTeamFeed: false,
    rows: [],
    groups: [],
    total: 0,
    offset: 0,
    hasMore: false,
    canManage: false,
    years: buildYears(),
    yearIndex: 0,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
  },

  onLoad(query = {}) {
    this.unloaded = false;
    this.loaded = false;
    this.rows = [];

    const projects = activeAssociations().map((assoc) => ({
      id: assoc.id,
      sportName: assoc.sportName,
      shortName: assoc.shortName || '',
      name: assoc.name || '',
      glyph: assoc.logoGlyph,
    }));
    const wanted = String(query.projectId || associationScope.getAssociation() || '');
    const current = projects.some((item) => item.id === wanted)
      ? wanted
      : (projects[0] ? projects[0].id : '');

    // 进入即把当前项目写成全局当前协会：发布页、详情页、名单页都按它取数，
    // 不必给七页各加一套「杯赛参数」。
    if (current) this.applyProject(current);

    this.update({
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      projects,
      projectId: current,
      projectName: this.sportNameOf(current, projects),
      projectAnchor: this.anchorOf(current),
      isTeamFeed: this.isTeamProject(current),
      themeClass: currentThemeClass(),
    });
    return this.reload();
  },

  onShow() {
    if (!this.loaded) return undefined;
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  onPullDownRefresh() {
    const done = () => (typeof wx !== 'undefined' && wx.stopPullDownRefresh ? wx.stopPullDownRefresh() : null);
    return this.reload().then(done, done);
  },

  update(values) {
    this.setData(values);
  },

  sportNameOf(id, projects) {
    const found = (projects || []).find((item) => item.id === id);
    return found ? found.sportName : '';
  },

  /**
   * 这个项目是不是团队项目（篮球/足球）。
   * 团队项目的学院赛按学院组队、一场一场打，取数与路由都落在团队赛事那一套上。
   */
  isTeamProject(id) {
    return Boolean(id) && sportTypeOf(id) === SPORT_TYPE.TEAM;
  },

  /** 项目栏的滚动锚点：scroll-into-view 认的是节点 id */
  anchorOf(id) {
    return id ? `proj-${id}` : '';
  },

  /**
   * 关键词命中的项目。
   *
   * 【为什么在本地算】
   * 项目清单来自 `utils/associations.js`，本来就在包里，不必为「搜项目」多跑一次
   * 服务端。赛事搜索才需要请求（要跨分页），两者互不阻塞：项目结果立刻出，
   * 赛事结果随请求回来再补上。
   *
   * 匹配项目名（篮球）、简称（民大篮球）、全称（中央民族大学篮球协会）与徽标字，
   * 输入「篮」也能命中——学校里的习惯叫法本来就长短不一。
   */
  projectMatchesOf(keyword, projectId) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    // 切换项目的当口，this.data.projectId 还是旧值，所以允许显式传入新选中的项目
    const currentId = projectId === undefined ? this.data.projectId : projectId;
    return (this.data.projects || [])
      .filter((item) => [item.sportName, item.shortName, item.name, item.glyph]
        .some((value) => String(value || '').toLowerCase().includes(kw)))
      .map((item) => ({ ...item, current: item.id === currentId }));
  },

  /**
   * 切换全局当前协会。
   * 优先走 app（它把结果同步进 globalData），测试环境回落到门面。
   */
  applyProject(id) {
    try {
      const app = getApp();
      if (app && typeof app.setAssociation === 'function') {
        app.setAssociation(id);
        return;
      }
    } catch (err) {
      // getApp 在 Node 测试里可能不存在，落到门面即可
    }
    associationScope.setAssociation(id);
  },

  client() {
    return space.forScope({
      schoolId: this.data.schoolId,
      association: this.data.projectId,
    });
  },

  /** 当前筛选条件 */
  query(extra = {}) {
    const status = this.data.statusOptions[this.data.statusIndex] || { value: '' };
    const year = this.data.years[this.data.yearIndex] || { value: '' };
    const keyword = String(this.data.keyword || '').trim();
    const payload = { limit: PAGE_SIZE, ...extra };
    if (status.value !== '') payload.status = Number(status.value);
    if (year.value) payload.year = year.value;
    if (keyword) payload.keyword = keyword;
    return payload;
  },

  /**
   * 按状态分组；空组不渲染，避免页面上出现一串空标题。
   *
   * 【搜索时为什么不再分组】
   * 「报名中 / 进行中 / 已结束」是浏览时的组织方式。带着关键词来时，人关心的是
   * 「这几个名字里哪个是我要找的」，再按状态切三段只会把命中结果拆散。搜索时
   * 聚成一组，把状态留在每行标签上。项目命中另起一组（见 wxml），与赛事结果并列。
   */
  groupOf(rows) {
    if (String(this.data.keyword || '').trim()) {
      return rows.length > 0 ? [{ status: 'search', label: '赛事结果', rows }] : [];
    }
    return STATUS_ORDER
      .map((item) => ({ ...item, rows: rows.filter((row) => row.status === item.status) }))
      .filter((item) => item.rows.length > 0);
  },

  /**
   * 重取第一页。
   *
   * 【silent 与请求令牌】
   * 边打字边搜时不能让整页回到「正在加载…」——那会把输入框一起换掉，键盘跟着收，
   * 一个字都打不完整。所以搜索走 silent：保留旧列表，直到新结果回来再换。
   * 令牌用来丢弃过期响应：连打三个字会发三次请求，先回的不一定是最后那个。
   */
  async reload(options = {}) {
    const silent = options && options.silent === true;
    const token = (this.requestToken || 0) + 1;
    this.requestToken = token;
    if (!this.data.projectId) {
      this.update({ loading: false, error: '这所学校还没有启用任何协会' });
      return undefined;
    }
    // 新查询一开始就释放续页锁：上一页的响应即使后到，也会被下面的令牌拦下。
    this.update(silent ? { busy: false, error: '' } : { loading: true, error: '', busy: false });
    this.rows = [];
    try {
      const payload = this.data.isTeamFeed ? this.teamQuery() : this.query({ offset: 0 });
      const action = this.data.isTeamFeed ? 'listTeamEvents' : 'listCollegeEvents';
      const result = await this.client()[action](payload);
      if (this.unloaded || token !== this.requestToken) return undefined;
      if (result && result.ok === false) throw new Error(result.message || '没有读取石榴籽杯的权限');
      const rows = this.data.isTeamFeed
        ? this.teamRowsOf(result.events || [])
        : this.collegeRowsOf(result.events || []);
      this.rows = rows;
      this.loaded = true;
      this.update({
        loading: false,
        error: '',
        rows,
        groups: this.groupOf(rows),
        total: this.data.isTeamFeed ? rows.length : (Number(result.total) || rows.length),
        offset: rows.length,
        hasMore: this.data.isTeamFeed ? false : Boolean(result.hasMore),
        canManage: Boolean(result.canManage),
        themeClass: currentThemeClass(),
      });
    } catch (err) {
      if (this.unloaded || token !== this.requestToken) return undefined;
      this.loaded = true;
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
    return undefined;
  },

  /** 团队赛事的查询条件：状态在页面内按归组筛，其余交给服务端 */
  teamQuery() {
    const year = this.data.years[this.data.yearIndex] || { value: '' };
    const keyword = String(this.data.keyword || '').trim();
    const payload = { cupMode: CUP_MODE.COLLEGE };
    if (year.value) payload.year = year.value;
    if (keyword) payload.keyword = keyword;
    return payload;
  },

  /** 球拍学院赛的列表行 → 统一行结构 */
  collegeRowsOf(rows) {
    return rows.map(row => ({
      ...row,
      kind: 'college',
      metaText: `${row.legPlanText} · 名单 ${row.rosterText}`,
      actionText: '交名单',
    }));
  },

  /**
   * 团队赛事 → 统一行结构。
   *
   * 状态归组与筛选都在这里做：一个项目一年也就几场学院赛，一次全取即可，
   * 不必为它再给列表接口加一套分页与状态参数。
   */
  teamRowsOf(events) {
    const statusFilter = (this.data.statusOptions[this.data.statusIndex] || { value: '' }).value;
    return events
      .map((event) => {
        const group = TEAM_STATUS_GROUP[event.status] === undefined ? 2 : TEAM_STATUS_GROUP[event.status];
        return {
          eventId: event.eventId,
          kind: 'team',
          title: event.name,
          pinned: false,
          status: group,
          statusLabel: event.statusLabel,
          isSignup: group === 0,
          isOngoing: group === 2,
          startTimeText: this.dateTextOf(event),
          location: event.location || '',
          // 团队学院赛的报名单位是学院：副信息说清赛制与已报名学院数
          metaText: `${EVENT_FORMAT_LABEL[event.format] || '赛制未定'} · 已报名 ${Number(event.entryCount) || 0} 院`,
          canSubmit: Boolean(event.canSubmit),
          actionText: '报名',
        };
      })
      .filter(row => statusFilter === '' || row.status === Number(statusFilter));
  },

  /** 团队赛事只下发 ISO 时间：展示文本在页面按 +08 拼（与学院赛行的「年-月-日」同粒度） */
  dateTextOf(event) {
    const at = Date.parse(event.createdAt || '');
    if (!Number.isFinite(at)) return '时间待定';
    const local = new Date(at + 8 * 3600000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  },

  async loadMore() {
    if (this.data.busy || !this.data.hasMore) return undefined;
    // 续页与首屏共用同一个请求令牌，并固定发起时的查询键。只要用户改了关键词、
    // 年份、状态或项目，旧续页就不能再往新列表里追加，也不能把 busy 锁死。
    const token = this.requestToken;
    const key = JSON.stringify(this.query());
    this.update({ busy: true });
    try {
      const result = await this.client().listCollegeEvents(this.query({ offset: this.data.offset }));
      if (this.unloaded || token !== this.requestToken || key !== JSON.stringify(this.query())) return undefined;
      if (result && result.ok === false) throw new Error(result.message || '加载失败');
      const rows = this.rows.concat(this.collegeRowsOf(result.events || []));
      this.rows = rows;
      this.update({
        busy: false,
        rows,
        groups: this.groupOf(rows),
        offset: rows.length,
        hasMore: Boolean(result.hasMore),
      });
    } catch (err) {
      if (!this.unloaded && token === this.requestToken && key === JSON.stringify(this.query())) {
        this.update({ busy: false, error: (err && err.message) || '加载失败' });
      }
    }
    return undefined;
  },

  onPickYear(event) {
    this.update({ yearIndex: Number(event.detail.value) });
    return this.reload();
  },

  onPickStatus(event) {
    this.update({ statusIndex: Number(event.detail.value) });
    return this.reload();
  },

  /** 输入即筛：项目结果立刻出，赛事请求停顿 SEARCH_DEBOUNCE_MS 后再发 */
  onKeywordInput(event) {
    const keyword = String((event.detail && event.detail.value) || '');
    this.update({ keyword, projectMatches: this.projectMatchesOf(keyword) });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (this.unloaded) return;
      this.reload({ silent: true });
    }, SEARCH_DEBOUNCE_MS);
  },

  /** 键盘「搜索」键：不等防抖，立刻按当前输入筛一次 */
  onKeywordConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    return this.reload({ silent: true });
  },

  onClearKeyword() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.update({ keyword: '', projectMatches: [] });
    return this.reload({ silent: true });
  },

  /**
   * 点搜索命中的项目：切过去，并把关键词清掉。
   *
   * 关键词在这里的语义是「项目名」，留着它去搜赛事只会得到零条——切换完就该
   * 落到这个项目的正常浏览态。
   */
  onPickMatchedProject(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return undefined;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.applyProject(id);
    this.update({
      keyword: '',
      projectMatches: [],
      projectId: id,
      projectName: this.sportNameOf(id, this.data.projects),
      projectAnchor: this.anchorOf(id),
      isTeamFeed: this.isTeamProject(id),
      themeClass: currentThemeClass(),
      rows: [],
      groups: [],
      total: 0,
      offset: 0,
      hasMore: false,
    });
    return this.reload();
  },

  onPickProject(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || id === this.data.projectId) return undefined;
    this.applyProject(id);
    this.update({
      projectId: id,
      projectName: this.sportNameOf(id, this.data.projects),
      projectAnchor: this.anchorOf(id),
      isTeamFeed: this.isTeamProject(id),
      themeClass: currentThemeClass(),
      // 项目变了，命中的项目行要重算「当前」标记；关键词保留，接着在新项目里搜赛事
      projectMatches: this.projectMatchesOf(this.data.keyword, id),
      rows: [],
      groups: [],
      total: 0,
      offset: 0,
      hasMore: false,
    });
    return this.reload();
  },

  /** 发起学院赛：属于当前项目，发布页不再选项目（避免一次发起落到两个项目） */
  /**
   * 发起学院赛：属于当前项目，发布页不再选项目（避免一次发起落到两个项目）。
   * 团队项目走团队建赛（篮球页内表单 / 足球表单组件），并带上杯赛标记，
   * 建出来的赛事只有院队能报名。
   */
  onCreate() {
    if (!this.data.projectId) return undefined;
    if (this.data.isTeamFeed) {
      return wx.navigateTo({
        url: `/packageTeam/team-event-list/team-event-list?create=1&cupMode=${CUP_MODE.COLLEGE}&projectId=${this.data.projectId}`,
      });
    }
    return wx.navigateTo({
      url: `/packageCollege/college-event-edit/college-event-edit?projectId=${this.data.projectId}`,
    });
  },

  /**
   * 点一场学院赛。
   * 球拍：学院负责人在报名中直接进本学院名单页，其余进详情。
   * 团队：一律进团队赛事详情——报名面板（挑人即入队）在那里。
   */
  onOpenEvent(event) {
    const { eventId, canSubmit, kind } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    if (kind === 'team') {
      return wx.navigateTo({
        url: `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent(eventId)}`,
      });
    }
    if (canSubmit) {
      return wx.navigateTo({ url: `/packageCollege/college-entry/college-entry?eventId=${encodeURIComponent(eventId)}` });
    }
    return wx.navigateTo({ url: `/packageCollege/college-event-detail/college-event-detail?eventId=${encodeURIComponent(eventId)}` });
  },
});
