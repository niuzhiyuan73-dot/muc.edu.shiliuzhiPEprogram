const { withDetailExperience } = require('../../templates/detail-experience');
/**
 * 赛事详情
 * ============================================================
 * 一场赛事的全部动作都收在这一页：
 *   会员：报名 / 取消报名；
 *   管理：开始赛事 / 代签 / 抽签 / 指派裁判 / 进名次录入页 / 确认比赛。
 * 取数与权限判定走学校维度（协议 2）：读由 services/school-event-view.js 的
 * loadSchoolEventDetailView 把服务端 DTO 转成旧栈同形的视图模型，写走协会空间
 * 的学校维度接口。页面只做交互与 setData。
 *
 * 【为什么按钮由数据决定、不在这里判权限】
 * 视图模型已经把 canSignUp / canStart / canCheckIn / canFinish 算进每一行
 * （能力旗标来自服务端 DTO，经 school-event-view 原样注入既有构建器），
 * 页面照着渲染即可。页面里写 `user.role >= 1` 这种判断，Node 跑不了，
 * 等于没法测——与 announcement / season-manage 同一纪律。
 *
 * 【每次写操作后为什么整页重载】
 * 报名人数、签到状态、按钮可用性都会随之变化。局部改 setData 要维护
 * 一整套本地状态，越改越容易和真值分叉；重载一次数据都在内存里，很快。
 *
 * 【登录态从哪来】
 * 学校维度下没有旧栈那份客户端账号快照：读写都由协会空间按当前身份执行。
 * 页面只向身份接口问一次会话，用来把「去登录」与「没权限」分开；范围
 * （学校 + 协会）在进入时固定一次，之后每个请求都用这把范围，避免异步
 * 期间全局范围被切走。
 * ============================================================
 */

const { loadSchoolEventDetailView } = require('../../services/school-event-view.js');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');
const { watchLiveScores } = require('../../services/live-watch.js');
const { applyLiveRows } = require('../../services/live-view.js');
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
    /** 视图模型，形状见 services/events-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 写操作进行中，防止连点 */
    acting: false,
    /** 签表展示方式：chart 横向晋级泳道 / list 逐场明细（默认图形，可回退） */
    bracketMode: 'chart',

    /** 「手工指定种子」面板是否打开 */
    seedDialogOpen: false,
    /** 已按顺序点选的种子编号，下标即 1 号、2 号…… */
    seedPicked: [],
    /** 候选名单 + 已选序号，供模板渲染（order 为 0 表示未选） */
    seedRows: [],
    /** 点选过程中的提示（选满了、还差几位） */
    seedError: '',

    /**
     * 指派裁判面板。入口由视图模型的 canAssignReferee 控制，页面不自己判角色。
     * 与比赛页同一套面板，管理员在两处用起来一致。
     */
    referee: {
      open: false,
      matchId: '',
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
   * 返回 Promise 让测试能等待首屏加载完。
   *
   * `this.eventId` 初值是路由 query 原样（可能未解码）；装载成功后会被换成
   * 探测出的真实编号（见 refresh），页面不再自己解码，避免二义性。
   */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
    // 在途请求的失效标志与请求序号（见 refresh）：离开页面后迟到的响应
    // 不许再 setData，更不许重新起一条轮询。
    this.destroyed = false;
    this.visible = true;
    this.refreshSeq = 0;
    return this.refresh();
  },

  /** 从名次录入页返回时刷新一次，刚录的名次才在页面上 */
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
    // 原先只清理已有的订阅：刷新请求还在路上，回来后照样 setData 并调
    // syncLiveWatch —— 而订阅是单例，它会把**当前页面**的轮询顶掉，
    // 结果是旧页面在后台空转、新页面的比分停更。
    this.destroyed = true;
    this.visible = false;
    if (this.liveHandle) {
      this.liveHandle();
      this.liveHandle = null;
    }
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
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
   * 拿不到（没有账号，或身份接口报错）就按访客处理，绝不猜一个身份出来。
   */
  async currentActorId() {
    try {
      const session = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
      return (session && session.user && session.user.userId) || null;
    } catch (err) {
      console.error('[event-detail] 读取学校身份失败', err);
      return null;
    }
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 二次确认。测试环境里没有 wx.showModal，直接放行——
   * 测试要验证的是「确认之后做了什么」，不是弹窗本身。
   */
  confirm(content, title = '请确认') {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(true);
        return;
      }
      wx.showModal({
        title,
        content,
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 重新装载整页数据。
   *
   * 【为什么要采纳视图里的 eventId】
   * 路由 query 的值是否已解码取决于运行环境：开发者工具 / 真机把 query 原样
   * 透传，`onLoad` 收到的是 `sev%3Amuc%3Apkb%3Aspring-cup`。装载器（见
   * school-event-view）会探测出真实编号再读；写接口没有这层探测，页面若继续
   * 用路由原值去报名 / 开赛 / 抽签，服务端按主键查不到，只能回「赛事不存在」
   * ——这正是用户实测「点报名显示赛事不存在」的原因。所以每次装载后都把真实
   * 编号落回实例，之后的读写与跳转统一用它。
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    // 请求序号：只有「最后一次发起的刷新」可以回写。页面已销毁、或期间又发起了
    // 新的刷新时，旧响应到此为止——不回写、不订阅（2026-10-26 P2-8）。
    const seq = (this.refreshSeq || 0) + 1;
    this.refreshSeq = seq;
    const stale = () => this.destroyed || seq !== this.refreshSeq;

    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();
    if (stale()) return;
    this.actorId = actorId;

    try {
      const view = await loadSchoolEventDetailView(this.eventId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      if (stale()) return;
      if (view.eventId) this.eventId = view.eventId;
      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
      // 首屏若已有正在计分的场次（读接口已带上 live），才挂轮询取增量
      this.syncLiveWatch();
    } catch (err) {
      if (stale()) return;
      console.error('[event-detail] 赛事详情加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '赛事详情加载失败，请下拉重试', themeClass: currentThemeClass() });
    }
  },

  /* ---------- 实时比分 ---------- */

  /**
   * 值得轮询的比赛编号：只有正在逐球计分、且还没结束的那几场。
   * 空数组交给适配器 = 一张表都不启，也就一次请求都不发。
   */
  liveIds() {
    const rows = (this.data.view && this.data.view.bracketRows) || [];
    return rows
      .filter((row) => row.liveActive && !(row.live && row.live.finished))
      .map((row) => row.matchId);
  },

  /**
   * 重新订阅实时比分。签表随刷新而变，每次刷新都重订一次即可
   * ——适配器会先停旧表，天然完成重订阅。
   *
   * 【取数为什么要换成学校维度】
   * 旧栈门面按旧台账取数，与学校维度的比赛不是同一份数据。这里传一个走
   * 协会空间的取数器：`getSchoolLiveScores` 的返回是 `{ok, scores}`，摊平后
   * 仍是「给一组编号、回一组比分视图」，适配器一视同仁。
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
      this.setData({ 'view.bracketRows': applyLiveRows(this.data.view.bracketRows || [], views) });
    }, {
      fetch: async (ids) => {
        const res = await space.forScope(scope).getSchoolLiveScores({ matchIds: ids });
        return (res && res.scores) || [];
      },
    });
  },

  /**
   * 写操作的统一收口：调接口 → 提示 → 整页刷新。
   * 身份由协会空间按当前会话提供，页面递不出别人的身份；未登录时服务端
   * 会拒（「请先登录」），页面照原样提示。
   *
   * @param {() => Promise<Object>} write 写接口
   * @param {string} successText 成功后的提示
   * @returns {Promise<void>}
   */
  async runWrite(write, successText) {
    if (this.data.acting) return undefined;

    this.setData({ acting: true });
    const result = await write();
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '操作失败');
      return undefined;
    }

    this.showToast(successText, 'success');
    return this.refresh();
  },

  /** 报名这一场 */
  onSignUp() {
    return this.runWrite(
      () => space.forScope(this.scope || this.currentScope()).signUpSchoolEvent({ eventId: this.eventId }),
      '报名成功'
    );
  },

  /** 取消报名 */
  onCancelSignup() {
    return this.runWrite(
      () => space.forScope(this.scope || this.currentScope()).cancelSchoolEventSignup({ eventId: this.eventId }),
      '已取消报名'
    );
  },

  /** 开始赛事。报名会在这一刻截止，先确认一道 */
  async onStart() {
    const confirmed = await this.confirm('开始后报名就截止了，确定现在开始这场赛事吗？', '开始赛事');
    if (!confirmed) return undefined;
    return this.runWrite(
      () => space.forScope(this.scope || this.currentScope()).startSchoolEvent({ eventId: this.eventId }),
      '赛事已开始'
    );
  },

  /** 代某位会员签到。只有学院负责人以上能点，按钮与否由视图模型决定 */
  onCheckIn(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return undefined;
    return this.runWrite(
      () => space.forScope(this.scope || this.currentScope()).checkInSchoolEvent({ eventId: this.eventId, userId }),
      '已签到'
    );
  },

  /**
   * 抽签 / 重抽。
   *
   * 手工指定种子的赛事不能直接抽：还缺一份「谁是 1 号种子」的名单，得先
   * 打开面板让管理员点名，凑齐了再走真正抽签那一步（见 onConfirmSeeds）。
   * 按等级分 / 赛季积分排的，算法自己排得出来，这里直接确认即可。
   */
  async onDraw() {
    if (this.data.acting) return undefined;

    if (this.data.view.event.isManualSeed) {
      this.openSeedDialog();
      return undefined;
    }

    return this.runDraw(undefined);
  },

  /**
   * 确认之后真正落库的一步。
   *
   * 【为什么随机值取此刻的时间戳并落库】
   * 决策 4.4：抽签结果必须可复核。把 seedValue 一并存进 draw 字段后，
   * 任何人拿同一个值重跑就能得到同一张签表。这里只负责给一个值。
   *
   * @param {string[]|undefined} manualOrder 手工指定的种子顺序，其余模式传 undefined
   */
  async runDraw(manualOrder) {
    const times = this.data.view.event.drawCount || 0;
    const confirmed = await this.confirm(
      times
        ? '重抽会作废现有签表与其中未确认的比赛，确定重抽吗？'
        : '抽签后名单会锁定，报名随即截止。确定开始抽签吗？',
      times ? '重新抽签' : '开始抽签'
    );
    if (!confirmed) return undefined;

    this.setData({ acting: true });
    const result = await space.forScope(this.scope || this.currentScope())
      .drawSchoolEvent({ eventId: this.eventId, seedValue: Date.now(), manualOrder });
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && result.message) || '抽签失败');
      return undefined;
    }

    this.showToast(times ? '已重新抽签' : '抽签完成', 'success');
    return this.refresh();
  },

  /* ---------- 手工指定种子 ---------- */

  /** 把候选名单与已选顺序拼成模板要的行：order 为 0 表示未选 */
  buildSeedRows(picked) {
    const candidates = this.data.view.seedCandidates || [];
    return candidates.map((item) => {
      const at = picked.indexOf(item.userId);
      return {
        userId: item.userId,
        nickName: item.nickName,
        avatarText: item.avatarText,
        avatarUrl: item.avatarUrl || '',
        order: at >= 0 ? at + 1 : 0,
      };
    });
  },

  /** 面板里的空操作：挡住点击穿透，点面板本身不该关掉它 */
  noop() {},

  openSeedDialog() {
    this.setData({
      seedDialogOpen: true,
      seedPicked: [],
      seedRows: this.buildSeedRows([]),
      seedError: '',
    });
  },

  onCloseSeedDialog() {
    this.setData({ seedDialogOpen: false, seedPicked: [], seedRows: [], seedError: '' });
  },

  /**
   * 点选 / 取消一位种子。
   *
   * 【为什么按点击先后排号，而不是点完再排】
   * 决策 9.4：1 号种子是谁由管理员定，等级分高不见得就要排第一。
   * 所以先点的是 1 号、后点的是 2 号，顺序本身就是输入。
   */
  onToggleSeed(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return undefined;

    const picked = this.data.seedPicked.slice();
    const at = picked.indexOf(userId);

    // 再点一次已选的人＝取消，方便点错了就地改
    if (at >= 0) {
      picked.splice(at, 1);
      this.setData({ seedPicked: picked, seedRows: this.buildSeedRows(picked), seedError: '' });
      return undefined;
    }

    const needed = this.data.view.manualSeedNeeded || 0;
    if (picked.length >= needed) {
      this.setData({ seedError: `一共只需指定 ${needed} ${this.data.view.seedUnit || '位种子'}` });
      return undefined;
    }

    picked.push(userId);
    this.setData({ seedPicked: picked, seedRows: this.buildSeedRows(picked), seedError: '' });
    return undefined;
  },

  /** 清空重选 */
  onClearSeeds() {
    this.setData({ seedPicked: [], seedRows: this.buildSeedRows([]), seedError: '' });
  },

  /** 点名完毕，开始抽签 */
  async onConfirmSeeds() {
    const needed = this.data.view.manualSeedNeeded || 0;
    const picked = this.data.seedPicked;
    if (picked.length !== needed) {
      const short = needed - picked.length;
      this.setData({ seedError: `还需指定 ${short} ${this.data.view.seedUnit || '位种子'}` });
      return undefined;
    }

    // 先收起面板，抽签失败时再来一次不必重新点名
    this.setData({ seedDialogOpen: false, seedRows: [], seedError: '' });
    return this.runDraw(picked.slice());
  },

  /**
   * 给抽签排出的比赛录分：进录入页（带上这一场编号）。
   *
   * 这一页同时提供两条路：顶部「实时计分」进横屏逐球计分台，下面直接填逐局比分。
   * 不能直接跳计分台——很多场次是边裁口头报分、由管理员补录，没有逐球过程；
   * 只有实时计分一条路时，这类场次就没法录了（用户反馈）。
   */
  /** 在「晋级之路」与逐场列表之间切换；不重新取数，两种视图共用同一份行数据 */
  onToggleBracketMode(event) {
    const mode = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.mode : '';
    if (!['chart', 'list'].includes(mode) || mode === this.data.bracketMode) return;
    this.setData({ bracketMode: mode });
  },

  onRecordMatch(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return;
    wx.navigateTo({ url: `/packageEvent/match-entry/match-entry?matchId=${encodeURIComponent(matchId)}` });
  },

  /** 确认一场已录分的比赛，成绩随即计入等级分 */
  onConfirmMatch(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return undefined;
    return this.runWrite(
      () => space.forScope(this.scope || this.currentScope()).confirmSchoolMatch({ matchId }),
      '已确认，成绩已计入等级分'
    );
  },

  /* ---------- 指派裁判 ---------- */

  /**
   * 取本校在册会员名录，供面板筛选。
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
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return undefined;

    const record = (this.data.view.bracketRows || []).find((item) => item.matchId === matchId);
    const selectedId = (record && record.referee) || '';
    this.pickerCursor = '';
    const page = await this.loadPickerPage('', false);

    this.setData({
      referee: {
        open: true,
        matchId,
        hasReferee: Boolean(record && record.hasReferee),
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

  /** 撤下裁判：传空串，比赛随即回到「人人照旧」的口径 */
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
   * 写入端会再校验一遍（仅管理员、比赛未生效、此人正常在册），这里的
   * 校验只为了少跑一趟：点错了当场就能看到原因。
   */
  async assignReferee(refereeId) {
    if (this.data.refereeActing) return undefined;

    const { matchId } = this.data.referee;
    if (!matchId) return undefined;

    this.setData({ refereeActing: true });
    const result = await space.forScope(this.scope || this.currentScope())
      .assignSchoolMatchReferee({ matchId, refereeId });
    this.setData({ refereeActing: false });

    if (!result.ok) {
      this.showToast(result.message || '指派失败');
      return undefined;
    }

    this.setData({ referee: { ...this.data.referee, open: false } });
    this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
    return this.refresh();
  },

  /** 进名次录入页。this.eventId 已是解析后的真实编号，这里只编码一次 */
  onOpenPlacement() {
    wx.navigateTo({ url: `/packageEvent/event-placement/event-placement?eventId=${encodeURIComponent(this.eventId)}` });
  },

  /** 点名单上的人，去看他的主页 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/packageMember/member/member?userId=${userId}` });
  },
}, 'personal', 'refresh'));
