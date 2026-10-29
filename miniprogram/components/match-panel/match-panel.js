/**
 * 比赛面板（协会工作台的内嵌页签之一）
 * ============================================================
 * 原来是一个独立的 tabBar 页面。中间三个页签收进「协会工作台」之后，这一页
 * 变成一个自定义组件，由工作台按当前协会挂载。
 * 三件事：看比赛台账、确认对手录入的比分、驳回一场（确认后不可撤销）。
 * 取数适配在 services/school-match-view.js，权限由 S2 读端下发，面板只做渲染与交互
 * ——那一层不碰 wx API，因而权限规则能在 Node 里逐条测。
 *
 * 本人身份与行级能力来自 S2；读写和实时比分绑定同一学校 / 协会客户端。
 *
 * 【为什么不用 wx.showModal】
 * 驳回要填理由，而 showModal 的 editable 版本只能收一行文本、
 * 也没法做「不填不给提交」的校验。
 * 与其和模态框的脾气较劲，不如在面板内做一块面板，行为完全可控。
 *
 * 【onShow 为什么要带守卫】
 * attached 之后紧接着就会来一次 page show。若不加 this.loaded 判断，
 * 首屏会白算两遍。而带守卫又必须保留 onShow——从录入页 navigateBack
 * 回来时 attached 不会再触发，不刷新就看不到刚提交的那一场。
 *
 * 【实时比分的订阅怎么停】
 * 组件没有页面的 onHide / onUnload，改用 pageLifetimes.hide 与
 * lifetimes.detached 转调同名方法，停表逻辑与页面时期一致。
 * ============================================================
 */

const { loadSchoolMatchView } = require('../../services/school-match-view.js');
const space = require('../../services/association-space');
const schoolSession = require('../../services/school-session');
const associationScope = require('../../services/association-scope');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');

const { watchLiveScores } = require('../../services/live-watch.js');
const { applyLiveRows } = require('../../services/live-view.js');
const { isMock } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');

/** 驳回面板文案（撤销已随 Elo 逐场结算改造取消，只剩驳回一种作废动作） */
const ACTION_TEXT = {
  reject: {
    title: '驳回这场比分',
    hint: '驳回后这场成绩作废，不会计入等级分。请说明哪里不对。',
    placeholder: '例如：第二局比分录反了',
  },
};

/**
 * 首屏渲染多少场比赛，点一次「加载更多」再放这么多。
 *
 * 【为什么要分批】比赛流水一次取最近 100 场（match-view 的 DEFAULT_LIMIT），
 * 每场还要渲染双方队员名单，100 场就是上千个文本节点。首屏一次铺完，中低端
 * 安卓上会明显卡一下。分批只影响**界面渲染多少行**，`view.records` 仍是全量
 * ——实时比分更新（按 matchId 回填）和按 id 查记录都依赖它。
 *
 * 【为什么不用页面 onReachBottom】本组件挂在 association-home 里，滚动的是
 * 页面不是组件，组件收不到触底事件。为一个列表去改宿主页面的事件转发，改
 * 动面比收益大；面板内一个按钮就够，还能让用户自己决定要不要看更早的。
 */
const RENDER_STEP = 20;

Component({
  properties: {
    focusMatchId: { type: String, value: '', observer() {
      if (!this.loaded) return;
      this.suspend();
      this.setData({ loading: true, view: {}, visibleRecords: [] });
      this.refresh();
    } },
    active: { type: Boolean, value: true, observer(value) {
      if (!value) this.suspend();
      else if (!this.hidden && this.loaded) this.refresh();
    } },
  },
  options: {
    // app.wxss 的 .card / .pool-tabs / .btn / .sheet 等全局类要渗进来
    styleIsolation: 'apply-shared',
  },

  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在面板根节点上 */
    themeClass: '',
    /** 切标签时给个淡淡的反馈，避免点了没反应 */
    switching: false,
    /** 视图模型，形状见 services/match-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /**
     * 界面当前渲染的记录窗口（view.records 的前若干条）。
     * 单独存一份是为了让 WXML 只遍历这一份：WXML 里调不了 slice()，
     * 只能由 JS 算好再交给视图层。
     */
    visibleRecords: [],
    /** 窗口之外是否还有记录（控制「加载更多」按钮） */
    visibleHasMore: false,
    /** 当前窗口大小，点「加载更多」时按 RENDER_STEP 递增 */
    renderLimit: RENDER_STEP,
    /** 当前登录态（能否录入取决于 auth.canRecord） */
    auth: { loggedIn: false },
    /** 录入按钮上方的说明。不能录入时，把原因写在这里 */
    entryHint: '',
    /** 开发期标注模拟数据 */
    isMock,
    /** 当前是否在浏览外校（演示）比赛：为真时整页只读，隐藏录入口 */
    demoSchool: false,
    /** 演示学校简称，供只读提示条显示 */
    demoSchoolName: '',
    /** 驳回面板 */
    action: { open: false, matchId: '', kind: "reject", title: '', hint: '', placeholder: '' },
    /** 面板里填的理由 */
    reason: '',
    /** 提交中，防止连点 */
    acting: false,
    /** 面板内的错误提示 */
    actionError: '',
    /**
     * 指派裁判面板。只给管理员用，但面板不自己判角色——入口由视图模型的
     * canAssignReferee 控制，这里只管面板本身的状态。
     */
    referee: {
      open: false,
      matchId: '',
      hasReferee: false,
      selectedId: '',
      keyword: '',
      rows: [],
      emptyText: '',
    },
    /** 指派提交中，防止连点 */
    refereeActing: false,
  },

  lifetimes: {
    attached() {
      this.onLoad();
    },
    detached() {
      if (typeof this.onUnload === 'function') this.onUnload();
    },
  },

  pageLifetimes: {
    show() {
      if (typeof this.onShow === 'function') this.onShow();
    },
    hide() {
      if (typeof this.onHide === 'function') this.onHide();
    },
  },

  methods: {
    onToggleMatchMenu(event) {
      const matchId = event.currentTarget.dataset.matchId;
      if (!(this.data.visibleRecords || []).some(row => row.matchId === matchId)) return;
      this.setData({ openMenuMatchId: this.data.openMenuMatchId === matchId ? '' : matchId });
    },
    /**
     * 返回 Promise 是有意为之：小程序不关心返回值，
     * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
     */
    onLoad() {
      return this.refresh();
    },

    /** 从录入页返回时刷新一次，刚提交的比赛才能立刻出现在待确认里 */
    onShow() {
      this.hidden = false;
      if (!this.loaded || this.data.active === false) return undefined;
      return this.refresh();
    },

    /** 离开面板就停表，不再空转；回到前台时 onShow 会重新订阅 */
    onHide() {
      this.hidden = true;
      this.suspend();
    },

    suspend() {
      clearTimeout(this.refereeSearchTimer);
      this.request = (this.request || 0) + 1;
      if (this.liveHandle) { this.liveHandle(); this.liveHandle = null; }
    },

    onUnload() {
      clearTimeout(this.refereeSearchTimer);
      this.hidden = true;
      this.request = (this.request || 0) + 1;
      if (this.liveHandle) {
        this.liveHandle();
        this.liveHandle = null;
      }
    },

    /** 下拉刷新 */
    onPullDownRefresh() {
      return this.refresh().then(() => this.stopPullDown());
    },

    currentUser() { return this.viewer ? { _id: this.viewer.userId } : null; },

    async write(action, payload) {
      try { return await this.api[action](payload); }
      catch (error) { return { ok: false, message: error.message || '操作失败，请重试' }; }
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
     * 重新装载整页数据。
     * @returns {Promise<void>}
     */
    async refresh() {
      if (this.hidden || this.data.active === false) return;
      const request = this.request = (this.request || 0) + 1;
      if (this.liveHandle) { this.liveHandle(); this.liveHandle = null; }
      const scope = { schoolId: schoolSession.getSchoolId() || 'muc', association: associationScope.getAssociation() };
      const api = space.forScope(scope);
      this.api = api;
      this.members = null;
      this.setData({ action: { ...this.data.action, open: false }, referee: { ...this.data.referee, open: false } });
      try {
        const view = await loadSchoolMatchView(api, this.currentTab, { matchId: this.data.focusMatchId });
        if (request !== this.request) return;
        this.viewer = view.context.viewer;
        this.members = view.context.members.map(m => ({ id: m.userId, name: m.nickName || m.userId, realName: m.realName }));
        // 【成员名单不进视图层】（2026-10-29 第十一轮审计 P3）
        // `view.context` 带着**全校**在册成员（2000 人的学校就是 2000 行对象），
        // 而模板一处都没用到它——只有 `this.members` 这张 id→姓名表需要。整份塞进
        // setData 等于每次刷新都跨线程搬一次全量名册，白白拖慢首屏。这里保留
        // viewer/canRecord 等标量，把 members 清空；续页要用的原件存在实例属性上，
        // 不进 data（组件重渲染不需要它）。
        this.viewContext = view.context || null;
        this.loaded = true;
        const records = view.records || [];
        const viewForData = { ...view, context: { ...view.context, members: [] } };
        this.setData({
          loading: false, error: '', switching: false, view: viewForData, auth: view.auth,
          entryHint: this.describeEntry(view.auth), demoSchool: false, demoSchoolName: '', themeClass: currentThemeClass(),
          // 换标签 / 下拉刷新后回到第一屏：用户这一段要看的是「最近发生了什么」，
          // 不该记住上次翻到第几屏
          renderLimit: RENDER_STEP,
          visibleRecords: records.slice(0, RENDER_STEP),
          // 服务端还有下一页时也要露出「加载更多」，否则 100 条之后到此为止
          visibleHasMore: records.length > RENDER_STEP || Boolean(view.nextCursor),
        });
        this.syncLiveWatch();
      } catch (error) {
        if (request !== this.request) return;
        this.viewer = null;
        // 上下文跟着清：否则换协会/换学校失败后，续页会拿着上一份名册去解析姓名
        this.viewContext = null;
        this.loaded = true;
        this.setData({ loading: false, switching: false, view: {}, auth: { loggedIn: false, canRecord: false },
          error: error.message || '比赛数据加载失败，请下拉重试', themeClass: currentThemeClass(),
          // 清空榜单时窗口也要跟着清：否则上一所学校的记录会留在屏幕上
          renderLimit: RENDER_STEP, visibleRecords: [], visibleHasMore: false });
      }
    },

    /* ---------- 实时比分 ---------- */

    /**
     * 值得轮询的比赛编号：只有正在逐球计分、且还没结束的那几场。
     * 空数组交给适配器 = 一张表都不启，也就一次请求都不发。
     */
    liveIds() {
      const records = (this.data.view && this.data.view.records) || [];
      return records
        .filter((row) => row.liveActive && !(row.live && row.live.finished))
        .map((row) => row.matchId);
    },

    /**
     * 重新订阅实时比分。名单随刷新而变，每次刷新都重订一次即可
     * ——适配器会先停旧表，天然完成重订阅。
     */
    syncLiveWatch() {
      if (this.hidden || this.data.active === false) return;
      if (this.liveHandle) this.liveHandle();
      const api = this.api;
      const request = this.request;
      this.liveHandle = watchLiveScores(this.liveIds(), (views) => {
        if (this.hidden || this.data.active === false || request !== this.request) return;
        const next = applyLiveRows(this.data.view.records || [], views);
        // 窗口里的那几条也要跟着更新：比分变了，屏上得立刻看到
        this.setData({ 'view.records': next, visibleRecords: next.slice(0, this.data.renderLimit) });
      }, { fetch: async ids => { const result = await api.getSchoolLiveScores({ matchIds: ids }); if (!result.ok) throw new Error(result.message); return result.scores; } });
    },

    /**
     * 录入按钮上方的说明。
     * 三种情况各说各的：能录、登录了但不能录（待审核 / 被禁用）、没登录。
     * 比笼统写一句「暂不可录入」有用得多。
     */
    describeEntry(auth) {
      if (auth.canRecord) return '打完了？把比分记下来，对手确认后计入等级分';
      if (auth.loggedIn) return auth.notice || '当前账号暂时不能录入成绩';
      return '登录后才能录入比赛成绩';
    },

    /**
     * 放出下一屏记录。
     * 本地窗口没放完时只扩大渲染窗口（省的是 DOM，不是请求）；本地放完但服务端
     * 还有下一页时，按 nextCursor 续读（2026-10-29 第十一轮审计 P2-7）。
     *
     * 【为什么要有第二步】上一步只解决「一次别铺太多 DOM」，而服务端第一页原本
     * 固定 100 条、`hasMore` 无人消费——第 101 场起静默消失。现在把游标接上，
     * 「加载更多」到底时继续向服务端要。
     */
    async onShowMore() {
      const all = (this.data.view && this.data.view.records) || [];
      const limit = this.data.renderLimit + RENDER_STEP;
      const nextCursor = (this.data.view && this.data.view.nextCursor) || '';
      if (limit >= all.length && nextCursor) {
        if (this.moreLoading) return undefined;
        this.moreLoading = true;
        try {
          // 复用上一页的上下文：续页不该再为「姓名映射」把全校名录读一遍
          const view = await loadSchoolMatchView(this.api, this.currentTab, {
            cursor: nextCursor, context: this.viewContext,
          });
          const merged = [...all, ...(view.records || [])];
          this.setData({
            'view.records': merged,
            'view.nextCursor': view.nextCursor || '',
            'view.hasMore': Boolean(view.hasMore),
            renderLimit: limit,
            visibleRecords: merged.slice(0, limit),
            visibleHasMore: merged.length > limit || Boolean(view.nextCursor),
          });
        } catch (error) {
          this.showToast(error.message || '加载更多失败，请重试');
        } finally {
          this.moreLoading = false;
        }
        return undefined;
      }
      this.setData({
        renderLimit: limit,
        visibleRecords: all.slice(0, limit),
        visibleHasMore: all.length > limit || Boolean(nextCursor),
      });
      return undefined;
    },

    /* ---------- 标签与入口 ---------- */

    /** 切换标签（全部 / 我参与的 / 待确认） */
    onSwitchTab(event) {
      const { tab } = event.currentTarget.dataset;
      if (!tab || tab === this.data.view.activeTab || this.data.switching) return undefined;

      this.currentTab = tab;
      this.setData({ switching: true });
      return this.refresh();
    },

    /**
     * 去录入页。
     * 未登录、或账号还在待审核，都不该进录入页——那里需要选中自己当选手，
     * 没有身份就没法录。宁可在这里拦住并说清楚原因，也不要进去之后报错。
     */
    onGoEntry() {
      if (this.data.demoSchool) return undefined;
      const auth = this.data.auth;
      if (!auth.loggedIn) {
        this.showToast('请先登录后再录入成绩');
        return;
      }
      if (!auth.canRecord) {
        this.showToast(auth.notice || '当前账号暂时不能录入成绩');
        return;
      }

      wx.navigateTo({ url: '/packageEvent/match-entry/match-entry' });
    },

    /** 访客的空态里给一个登录入口——没有身份就没有「自己的比赛」 */
    onGoLogin() {
      wx.navigateTo({ url: '/pages/login/login' });
    },

    /** 点队名去看这位会员的主页 */
    onOpenMember(event) {
      // 外校演示比赛里的选手没有本校账号，点进去只会是「查无此人」
      if (this.data.demoSchool) return undefined;
      const userId = event.currentTarget.dataset.userId;
      if (!userId) return;
      wx.navigateTo({ url: `/packageMember/member/member?userId=${encodeURIComponent(userId)}` });
    },

    /**
     * 给抽签排出的比赛录分。
     * 这类比赛已经在签表里占好位置，只需补上比分，所以带着编号进录入页，
     * 由那一页把比分写回原记录，而不是另立一条新比赛。
     */
    onRecordMatch(event) {
      const matchId = event.currentTarget.dataset.matchId;
      if (!matchId) return;
      wx.navigateTo({ url: `/packageEvent/match-entry/match-entry?matchId=${encodeURIComponent(matchId)}` });
    },

    /* ---------- 确认 ---------- */

    /** 确认对手录入的比分，成绩随即计入等级分 */
    async onConfirm(event) {
      const matchId = event.currentTarget.dataset.matchId;
      const user = this.currentUser();
      if (!matchId) return undefined;
      if (!user) {
        this.showToast('请先登录后再确认比分');
        return undefined;
      }
      // 确认即最终结算：先核对结果、把「不可撤销」说在前面，再落库
      // （交接文档 §4.3：确认前必须有可见的结果核对与不可撤销提示）。
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '确认比分',
          content: '确认后成绩立即生效并计入等级分，之后不可撤销、不可修改。确定确认吗？',
          success: (res) => resolve(Boolean(res && res.confirm)),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return undefined;

      const result = await this.write('confirmSchoolMatch', { matchId });
      if (!result.ok) {
        this.showToast(result.message || '确认失败');
        return undefined;
      }

      this.showToast('已确认，成绩已计入等级分', 'success');
      return this.refresh();
    },

    /* ---------- 弃权 ---------- */

    /**
     * 本人自选弃权（D41）。
     *
     * 弃权是不可逆的：对手直接晋级，且这一场不计个人等级分。所以先弹一个
     * 确认框把后果说清楚，再落库。管理员在场上时由同一入口执行。
     */
    async onForfeit(event) {
      const matchId = event.currentTarget.dataset.matchId;
      const user = this.currentUser();
      if (!matchId || this.data.acting) return undefined;
      if (!user) {
        this.showToast('请先登录后再弃权');
        return undefined;
      }
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;

      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '确认弃权',
          content: '弃权后对手直接晋级，且这一场不计个人等级分。确定弃权吗？',
          success: (res) => resolve(Boolean(res && res.confirm)),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return undefined;

      this.setData({ acting: true });
      const result = await this.write('forfeitSchoolMatch', { matchId, forfeitBy: user._id });
      this.setData({ acting: false });

      if (!result.ok) {
        this.showToast(result.message || '弃权失败');
        return undefined;
      }

      this.showToast('已弃权，对手晋级', 'success');
      return this.refresh();
    },

    /* ---------- 驳回面板 ---------- */

    /** 打开驳回面板 */
    onOpenAction(event) {
      const { matchId, kind } = event.currentTarget.dataset;
      const text = ACTION_TEXT[kind];
      if (!matchId || !text) return;

      this.setData({
        action: { open: true, matchId, kind, ...text },
        reason: '',
        actionError: '',
      });
    },

    onInputReason(event) {
      this.setData({ reason: event.detail.value, actionError: '' });
    },

    onCancelAction() {
      if (this.data.acting) return;
      this.setData({ action: { ...this.data.action, open: false }, reason: '', actionError: '' });
    },

    /**
     * 提交驳回。
     * 理由必填——没有理由的驳回，事后谁也说不清当初为什么拒。
     * 校验放在这里而不是只靠后端：让用户在点下按钮的当下就看到问题。
     * （撤销已随 Elo 逐场结算改造取消：确认即最终结算，这里只剩驳回。）
     */
    async onSubmitAction() {
      if (this.data.acting) return undefined;

      const { matchId } = this.data.action;
      const reason = String(this.data.reason || '').trim();
      const user = this.currentUser();

      if (!reason) {
        this.setData({ actionError: '请填写理由' });
        return undefined;
      }
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      this.setData({ acting: true, actionError: '' });
      const result = await this.write('rejectSchoolMatch', { matchId, reason });
      this.setData({ acting: false });

      if (!result.ok) {
        this.setData({ actionError: result.message || '操作失败' });
        return undefined;
      }

      this.setData({ action: { ...this.data.action, open: false }, reason: '' });
      this.showToast('已驳回', 'success');
      return this.refresh();
    },

    /* ---------- 指派裁判 ---------- */

    /**
     * 取会员名单，供面板筛选。
     * 只取一次并缓存在实例上：面板可能被反复打开，名单在一次会话里不会变。
     * 名字优先用昵称（面板上显示的），真实姓名只参与搜索匹配。
     */
    async pickerMembers() { return this.members || []; },

    /** 按关键字刷新面板列表 */
    async applyRefereeKeyword(keyword) {
      if (this.data.focusMatchId) return this.loadFocusedReferees(keyword);
      const members = await this.pickerMembers();
      this.setData({
        'referee.keyword': keyword,
        'referee.rows': buildPickerRows(members, keyword, this.data.referee.selectedId),
        'referee.emptyText': pickerEmptyText(keyword),
      });
    },

    /** 打开指派面板。当前是谁当头一版勾出来 */
    async onOpenReferee(event) {
      const matchId = event.currentTarget.dataset.matchId;
      if (!matchId) return undefined;

      const record = (this.data.view.records || []).find((item) => item.matchId === matchId);
      const selectedId = (record && record.referee) || '';
      if (this.data.focusMatchId) {
        this.setData({ referee: { open: true, matchId, hasReferee: Boolean(record && record.hasReferee),
          selectedId, keyword: '', rows: [], loading: true, hasMore: false, nextCursor: '', error: '' } });
        return this.loadFocusedReferees('');
      }
      const members = await this.pickerMembers();
      const rows = buildPickerRows(members, '', selectedId);

      this.setData({
        referee: {
          open: true,
          matchId,
          hasReferee: Boolean(record && record.hasReferee),
          selectedId,
          keyword: '',
          rows,
          emptyText: pickerEmptyText(''),
        },
      });
    },

    onInputRefereeKeyword(event) {
      if (this.data.focusMatchId) {
        clearTimeout(this.refereeSearchTimer);
        this.refereePageVersion = (this.refereePageVersion || 0) + 1;
        const keyword = String(event.detail.value || '').slice(0, 32);
        this.setData({ 'referee.keyword': keyword, 'referee.rows': [], 'referee.hasMore': false });
        const request = this.request;
        this.refereeSearchTimer = setTimeout(() => {
          if (request === this.request && this.data.referee.open) this.loadFocusedReferees(keyword);
        }, 250);
        return;
      }
      return this.applyRefereeKeyword(event.detail.value);
    },

    async loadFocusedReferees(keyword, append = false) {
      const version = this.refereePageVersion = (this.refereePageVersion || 0) + 1;
      const request = this.request;
      this.setData({ 'referee.loading': true, 'referee.error': '' });
      try {
        const page = await this.api.listSchoolMembers({ page: true, keyword, limit: 20,
          cursor: append ? this.data.referee.nextCursor : '' });
        if (version !== this.refereePageVersion || request !== this.request || !this.data.referee.open) return;
        if (!page.ok) throw new Error(page.message || '候选读取失败');
        const rows = buildPickerRows((page.members || []).map(row => ({ id: row.userId, name: row.nickName || '会员' })), '', this.data.referee.selectedId);
        this.setData({ 'referee.rows': append ? [...this.data.referee.rows, ...rows] : rows, 'referee.loading': false,
          'referee.hasMore': Boolean(page.hasMore), 'referee.nextCursor': page.nextCursor || '', 'referee.emptyText': pickerEmptyText(keyword) });
      } catch (error) {
        if (version === this.refereePageVersion && request === this.request && this.data.referee.open) this.setData({ 'referee.loading': false, 'referee.error': error.message || '候选读取失败，请重试' });
      }
    },
    onMoreFocusedReferees() {
      if (this.data.referee.loading) return;
      return this.loadFocusedReferees(this.data.referee.keyword, Boolean(this.data.referee.rows.length));
    },

    onCancelReferee() {
      if (this.data.refereeActing) return;
      clearTimeout(this.refereeSearchTimer);
      this.refereePageVersion = (this.refereePageVersion || 0) + 1;
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
      const user = this.currentUser();
      if (!matchId) return undefined;
      if (!user) {
        this.showToast('请先登录后再指派裁判');
        return undefined;
      }

      this.setData({ refereeActing: true });
      const result = await this.write('assignSchoolMatchReferee', { matchId, refereeId });
      this.setData({ refereeActing: false });

      if (!result.ok) {
        this.showToast(result.message || '指派失败');
        return undefined;
      }

      this.setData({ referee: { ...this.data.referee, open: false } });
      this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
      return this.refresh();
    },

    /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
    noop() {},
  },
});
