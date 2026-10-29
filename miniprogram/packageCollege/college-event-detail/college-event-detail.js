const { withDetailExperience } = require('../../templates/detail-experience');
/**
 * 学院赛详情（报名中抽签 → 待开赛开赛 → 进行中打大场）
 * ============================================================
 * 取数与整形走学校维度（协议 2）：services/school-college-view.js 的
 * loadCollegeEventDetailView 把服务端 DTO 整成旧栈同形，权限与规则在
 * college-draw.js / college-tie.js / college-lineup.js（纯函数）；写入由协会
 * 空间按当前身份执行。页面只做渲染与交互。
 *
 * 【为什么抽签、开赛、大场同页】
 * 三件事在时间上首尾相接，状态一推，该出现的入口自然就换了一批（见视图
 * 模型里的注释）。分成三个页面，管理员每走一步都要回上一页再点进来。
 * 名单审核仍留在独立的审核页，从本页给一个入口。
 *
 * 【种子的交互口径】
 * 按顺序点选：先点的排 1 号，再点一次取消。这是 D17 定死的手工指定，
 * 学院没有等级分，不拿院内个人的平均分去猜「学院实力」。种子的合法性
 * （必须来自已通过名单、不能重复）由 college-draw.js 兜底，页面只维护
 * 点击顺序。
 * ============================================================
 */

const { loadCollegeEventDetailView, buildSeedRows } = require('../../services/school-college-view.js');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');
const { watchLiveScores } = require('../../services/live-watch.js');
const { applyLiveTies } = require('../../services/live-view.js');
const { isMock } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Page(withDetailExperience({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 正在处理的按钮标识（tieId 或固定动作名），防止连点 */
    acting: '',
    /** 已点选的种子学院（按点击顺序） */
    seeds: [],
    /** 抽签面板里渲染的行：学院 + 是否种子 + 种子序号文案 */
    seedRows: [],

    /**
     * 指派大场裁判面板。入口由视图模型的 canAssignReferee 控制，页面不自己判角色。
     * 与赛事详情页的小场面板同一套，管理员在两处用起来一致。
     */
    referee: {
      open: false,
      tieId: '',
      hasReferee: false,
      selectedId: '',
      keyword: '',
      rows: [],
      emptyText: '',
      /** 候选是否还有下一页（2026-10-29 第十二轮审计：列表按页取，不再拉全校名录） */
      hasMore: false,
      loading: false,
    },
    /** 指派提交中，防止连点 */
    refereeActing: false,
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    // 在途请求的失效标志与请求序号（见 refresh）：离开页面后迟到的响应
    // 不许再 setData，更不许重新起一条轮询。
    this.destroyed = false;
    this.visible = true;
    this.refreshSeq = 0;
    return this.refresh();
  },

  /** 从排阵页 / 审核页返回时刷新一次，刚交的排阵与刚通过的名单才在页面上 */
  onShow() {
    this.visible = true;
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 离开本页就停表，不再空转；回到前台时 onShow 会重新订阅 */
  onHide() {
    this.visible = false;
    if (this.liveHandle) this.liveHandle.pause();
  },

  onUnload() {
    // 【销毁必须让在途请求失效】（2026-10-26 只读审查 P2-8）
    // 原先只清理已有订阅：刷新请求还在路上，回来后照样 setData 并调
    // syncLiveWatch —— 订阅是单例，它会把**当前页面**的轮询顶掉。
    this.destroyed = true;
    this.visible = false;
    if (this.liveHandle) {
      this.liveHandle();
      this.liveHandle = null;
    }
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
  },

  /**
   * 本次身份会话里的操作者编号，只用来把「去登录」与「没权限」分开。
   * 拿不到就按访客处理，绝不猜一个身份出来。
   */
  async currentActorId() {
    try {
      const session = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
      return (session && session.user && session.user.userId) || null;
    } catch (err) {
      console.error('[college-event-detail] 读取学校身份失败', err);
      return null;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 重新装载整页数据。种子的已选状态是页面交互态，刷新时保留——
   * 但只在学院仍有效时保留，避免已取消的种子留在列表里。
   * @returns {Promise<void>}
   */
  async refresh() {
    // 请求序号：只有最后一次发起的刷新可以回写（2026-10-26 P2-8）
    const seq = (this.refreshSeq || 0) + 1;
    this.refreshSeq = seq;
    const stale = () => this.destroyed || seq !== this.refreshSeq;

    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();
    if (stale()) return;

    try {
      const view = await loadCollegeEventDetailView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      if (stale()) return;
      // 采纳装载器探测出的真实编号再用于写与跳转：query 在微信开发者工具 / 真机里
      // 是原样透传的（未解码），继续拿路由原值抽签 / 开赛会被服务端答
      // 「学院赛不存在」（见 utils/route-query.js）。解析只做一次，跳转只编码一次。
      if (view.eventId) this.eventId = view.eventId;
      const approved = view.approvedColleges || [];
      const seeds = (this.data.seeds || []).filter((name) => approved.includes(name));
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        seeds,
        seedRows: buildSeedRows(approved, seeds),
        themeClass: currentThemeClass(),
      });
      // 首屏若已有正在计分的小场（读接口已带上 live），才挂轮询取增量
      this.syncLiveWatch();
    } catch (err) {
      if (stale()) return;
      console.error('[college-event-detail] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '学院赛详情页加载失败，请返回重试', themeClass: currentThemeClass() });
    }
  },

  /* ---------- 实时比分 ---------- */

  /**
   * 值得轮询的小场编号：只取正在逐球计分、且还没结束的那些。
   * 大场行里的 legRows 才是真正带 matchId 的一层，逐层摊平后过滤。
   */
  liveIds() {
    const ties = (this.data.view && this.data.view.ties) || [];
    const ids = [];
    for (const tie of ties) {
      for (const leg of (tie && tie.legRows) || []) {
        if (leg && leg.liveActive && !(leg.live && leg.live.finished)) ids.push(leg.matchId);
      }
    }
    return ids;
  },

  /**
   * 重新订阅实时比分。名单随刷新而变，每次刷新都重订一次即可
   * ——适配器会先停旧表，天然完成重订阅。
   */
  syncLiveWatch() {
    if (this.liveHandle) this.liveHandle();
    // 只有「活着且可见」的页面才允许起轮询：订阅是单例，已销毁的旧页面
    // 起表会把当前页面的表顶掉（2026-10-26 P2-8）。
    if (this.destroyed || this.visible === false) {
      this.liveHandle = null;
      return;
    }
    const scope = this.scope || this.currentScope();
    this.liveHandle = watchLiveScores(this.liveIds(), (views) => {
      if (this.destroyed) return;
      this.setData({ 'view.ties': applyLiveTies(this.data.view.ties || [], views) });
    }, {
      // 取数换成学校维度：旧栈门面按旧台账取数，与学校维度的比赛不是同一份数据
      fetch: async (ids) => {
        const res = await space.forScope(scope).getSchoolLiveScores({ matchIds: ids });
        return (res && res.scores) || [];
      },
    });
  },

  /* ---------- 抽签 ---------- */

  /**
   * 点选 / 取消种子。勾选顺序即种子序号，再点一次从序列里去掉。
   */
  onToggleSeed(event) {
    const college = event.currentTarget.dataset.college;
    if (!college) return;

    const seeds = [...(this.data.seeds || [])];
    const index = seeds.indexOf(college);
    if (index >= 0) seeds.splice(index, 1);
    else seeds.push(college);

    this.setData({
      seeds,
      seedRows: buildSeedRows(this.data.view.approvedColleges || [], seeds),
    });
  },

  async onDraw() {
    if (this.data.acting) return undefined;

    this.setData({ acting: 'draw' });
    // 抽签结果必须可复核：随机值取此刻时间戳并落库，同一个值重跑得同一张签表
    const result = await space.forScope(this.scope || this.currentScope())
      .drawCollegeEvent({ eventId: this.eventId, seedColleges: this.data.seeds, seedValue: Date.now() });
    this.setData({ acting: '' });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '抽签失败');
      return undefined;
    }

    this.showToast('抽签完成，名单已锁定', 'success');
    return this.refresh();
  },

  /* ---------- 开赛 ---------- */

  async onStartEvent() {
    if (this.data.acting) return undefined;

    this.setData({ acting: 'startEvent' });
    const result = await space.forScope(this.scope || this.currentScope())
      .startCollegeEvent({ eventId: this.eventId });
    this.setData({ acting: '' });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '开始失败');
      return undefined;
    }

    this.showToast('赛事已开始，请各学院提交排阵', 'success');
    return this.refresh();
  },

  /** 大场级「开始」：双方排阵齐才能点，后端会再校验一次 */
  async onStartTie(event) {
    const tieId = event.currentTarget.dataset.tieId;
    if (!tieId || this.data.acting) return undefined;

    this.setData({ acting: tieId });
    const result = await space.forScope(this.scope || this.currentScope())
      .startCollegeTie({ tieId });
    this.setData({ acting: '' });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '开始失败');
      return undefined;
    }

    this.showToast('大场已开始', 'success');
    return this.refresh();
  },

  /* ---------- 指派大场裁判 ---------- */

  /**
   * 取会员名单，供面板筛选。
   * 只取一次并缓存在实例上：面板可能被反复打开，名单在一次会话里不会变。
   */
  /**
   * 取一页候选裁判。
   *
   * 【为什么改成按页取】（2026-10-29 第十二轮审计）
   * 原先是 `listSchoolMembers({})` 一次拉全校在册名录再本地筛选：2000 人的学校
   * 就是 2000 行 JSON + 40 次 RPC，只为点开一个「指派裁判」面板。现在走分页接口
   * （服务端已按关键词过滤），输入时带关键词重新取第一页，「加载更多」续读。
   */
  async loadPickerPage(keyword, append) {
    const api = space.forScope(this.scope || this.currentScope());
    const res = await api.listSchoolMembers({
      page: true,
      keyword,
      limit: 50,
      cursor: append ? (this.pickerCursor || '') : '',
    });
    const rows = ((res && res.members) || []).map((member) => ({
      id: member.userId,
      name: member.nickName || member.realName || member.userId,
      realName: member.realName || '',
    }));
    this.pickerCursor = (res && res.nextCursor) || '';
    return { rows, hasMore: Boolean(res && res.hasMore), ok: Boolean(res && res.ok) };
  },

  /** 按关键字刷新面板列表（输入有防抖，见 onInputRefereeKeyword） */
  async applyRefereeKeyword(keyword, append = false) {
    this.setData({ 'referee.loading': true });
    const page = await this.loadPickerPage(keyword, append);
    if (!page.ok) {
      this.setData({ 'referee.loading': false, 'referee.rows': append ? this.data.referee.rows : [],
        'referee.hasMore': false, 'referee.emptyText': '候选读取失败，请重试' });
      return;
    }
    const merged = append
      ? [...this.data.referee.rows, ...buildPickerRows(page.rows, '', this.data.referee.selectedId)]
      : buildPickerRows(page.rows, '', this.data.referee.selectedId);
    const seen = new Set();
    const rows = merged.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)));
    this.setData({
      'referee.keyword': keyword,
      'referee.rows': rows,
      'referee.hasMore': page.hasMore,
      'referee.loading': false,
      'referee.emptyText': pickerEmptyText(keyword),
    });
  },

  /** 打开指派面板。当前是谁当头一版勾出来 */
  async onOpenReferee(event) {
    const tieId = event.currentTarget.dataset.tieId;
    if (!tieId) return undefined;

    const record = (this.data.view.ties || []).find((item) => item.tieId === tieId);
    const selectedId = (record && record.referee) || '';
    this.pickerCursor = '';
    const page = await this.loadPickerPage('', false);

    this.setData({
      referee: {
        open: true,
        tieId,
        hasReferee: Boolean(record && record.referee),
        selectedId,
        keyword: '',
        rows: buildPickerRows(page.rows, '', selectedId),
        hasMore: page.hasMore,
        loading: false,
        emptyText: pickerEmptyText(''),
      },
    });
    return undefined;
  },

  /** 续读下一页候选 */
  onMoreReferee() {
    if (this.data.referee.loading || !this.data.referee.hasMore) return undefined;
    return this.applyRefereeKeyword(this.data.referee.keyword, true);
  },

  /** 输入防抖 250ms：分页接口按关键词回源，逐字发请求会把接口打满 */
  onInputRefereeKeyword(event) {
    const keyword = String(event.detail.value || '').slice(0, 32);
    this.setData({ 'referee.keyword': keyword });
    if (this.refereeTimer) clearTimeout(this.refereeTimer);
    this.refereeTimer = setTimeout(() => {
      this.refereeTimer = null;
      this.applyRefereeKeyword(keyword);
    }, 250);
    return undefined;
  },

  onCancelReferee() {
    if (this.data.refereeActing) return;
    if (this.refereeTimer) { clearTimeout(this.refereeTimer); this.refereeTimer = null; }
    this.setData({ referee: { ...this.data.referee, open: false } });
  },

  /** 撤下裁判：传空串，大场随即回到「各小场各自为政」的口径 */
  onClearReferee() {
    return this.assignReferee('');
  },

  /** 选中某位会员当裁判。点「当前」那位等于不改派，直接关掉面板 */
  onPickReferee(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId || userId === this.data.referee.selectedId) {
      this.setData({ referee: { ...this.data.referee, open: false } });
      return undefined;
    }
    return this.assignReferee(userId);
  },

  /**
   * 落库一次指派。
   * 写入端会再校验一遍（仅管理员、大场未结束、此人正常在册），这里的校验
   * 只为了少跑一趟：点错了当场就能看到原因。指派的裁判会铺到本大场还没
   * 开打的各小场上。
   */
  async assignReferee(refereeId) {
    if (this.data.refereeActing) return undefined;

    const { tieId } = this.data.referee;
    if (!tieId) return undefined;

    this.setData({ refereeActing: true });
    const result = await space.forScope(this.scope || this.currentScope())
      .assignCollegeTieReferee({ tieId, refereeId });
    this.setData({ refereeActing: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '指派失败');
      return undefined;
    }

    this.setData({ referee: { ...this.data.referee, open: false } });
    this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
    return this.refresh();
  },

  /* ---------- 跳转 ---------- */

  /** 去本大场的排阵页。college 指明替哪一侧排（管理员/协会负责人两侧都能进） */
  onOpenLineup(event) {
    const { tieId, college } = event.currentTarget.dataset;
    if (!tieId) return;

    const collegeParam = college ? `&college=${encodeURIComponent(college)}` : '';
    wx.navigateTo({
      url: `/packageCollege/college-lineup/college-lineup?tieId=${encodeURIComponent(tieId)}&eventId=${encodeURIComponent(this.eventId)}${collegeParam}`,
    });
  },

  /** 去某个小项的录分页（参赛者 / 学院负责人 / 管理员） */
  onOpenMatch(event) {
    const { matchId } = event.currentTarget.dataset;
    if (!matchId) return;

    wx.navigateTo({ url: `/packageCollege/college-match/college-match?matchId=${encodeURIComponent(matchId)}` });
  },

  /** 去名单审核页（管理员） */
  onOpenReview() {
    wx.navigateTo({ url: `/packageCollege/college-entry-review/college-entry-review?eventId=${encodeURIComponent(this.eventId)}` });
  },

  /** 去本学院名单提交页（学院负责人） */
  onOpenEntry() {
    wx.navigateTo({ url: `/packageCollege/college-entry/college-entry?eventId=${encodeURIComponent(this.eventId)}` });
  },

  /** 去学院名次录入页（管理员）。提交后赛事即结束 */
  onOpenPlacement() {
    wx.navigateTo({
      url: `/packageCollege/college-placement/college-placement?eventId=${encodeURIComponent(this.eventId)}`,
    });
  },

  onBack() {
    wx.navigateBack();
  },

  /** 吞掉面板内层的冒泡，免得点名单时把面板一起关掉 */
  noop() {},
}, 'college', 'refresh'));
