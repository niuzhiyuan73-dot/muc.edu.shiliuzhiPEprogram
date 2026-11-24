const { withDetailExperience } = require('../../templates/detail-experience');
/**
 * 运动会详情
 * ============================================================
 * 一个页面承载「基本信息 + 项目清单 + 按角色可见动作」，不新增一级标签（R02）。
 * 报名、赛程、总榜在后续批次往这里加区块，不另开栏目。
 *
 * 动作只在草稿期出现：发布报名之后改规则会影响已提交的报名（交接文档 §5.2）。
 * ============================================================
 */

const meet = require('../services/meet.js');
const { updateMeetPage } = require('../utils/meet-ui.js');
const session = require('../../services/school-session.js');

Page(withDetailExperience({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    meet: null,
    events: [],
    canManage: false,
    isDraft: false,
    isRegistration: false,
    /** 报名窗口已关（届次还在报名期，但时间过了）：显示「报名已截止」而不是报名按钮 */
    registrationClosed: false,
    /** 能不能进学院报名工作台：学院部长或管理员 */
    canLeadCollege: false,
    /** 补报窗口面板（D27）：管理员在报名截止后临时开一段时间 */
    lateOpen: false,
    lateStartDate: '',
    lateStartTime: '08:00',
    lateEndDate: '',
    lateEndTime: '20:00',
    interests: [],
    myEntries: [],
    pendingEntries: [],
    openAt: '',
    closeAt: '',
    // 成绩不再平铺在页面底部：点哪个项目取哪个项目，弹层里看
    resultsError: '',
    resultPopup: { visible: false, eventKey: '', title: '', loading: false, error: '', rounds: [] },
  },

  onLoad(options = {}) {
    this.unloaded = false;
    const meetId = String(options.meetId || '');
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId,
      openAt: this.today(),
      closeAt: this.daysLater(14),
    });
    return this.reload();
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    this.unloaded = true;
  },

  onPullDownRefresh() {
    const done = () => (typeof wx !== 'undefined' && wx.stopPullDownRefresh ? wx.stopPullDownRefresh() : null);
    return this.reload().then(done, done);
  },

  update(values) {
    updateMeetPage(this, values);
  },

  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },

  daysLater(days) {
    const date = new Date(Date.now() + days * 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  async reload() {
    this.update({ loading: true, error: '' });
    // 成绩缓存与「已出成绩」索引都随整页刷新作废：可能刚发布了新成绩
    this.resultCache = new Map();
    this.resultIndexLoaded = false;
    try {
      const result = await this.client().getSportsMeet({ meetId: this.data.meetId });
      const canManage = Boolean(result.permissions && result.permissions.canManage);
      // 报名期 = 届次在报名中 **且** 时间窗口还开着；只判状态会让截止后仍显示报名按钮
      const windowState = result.meet.registration || null;
      const inWindow = windowState ? Boolean(windowState.open) : true;
      const isRegistration = result.meet.status === 'registration' && inWindow;
      const registrationClosed = result.meet.status === 'registration' && !inWindow;
      this.update({
        loading: false,
        meet: result.meet,
        events: result.events,
        canManage,
        isDraft: result.meet.status === 'draft',
        isRegistration,
        registrationClosed,
        canLeadCollege: Boolean(result.permissions && result.permissions.canLeadCollege),
      });
      if (isRegistration) await this.loadParticipation();
      if (result.meet.status !== 'draft') await this.loadResultIndex();
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /**
   * 只取「哪些项目已发布成绩」的元数据，给项目清单打「已出成绩」标记。
   *
   * 不在这里取行：一届最多 120 个项目组别，一次全取会把整届成绩都塞进页面，
   * 也就是原先「全部平铺在底部」的来源。行改成点开某项目时才取（D79 只认已发布）。
   */
  async loadResultIndex() {
    if (this.resultIndexLoaded) return undefined;
    try {
      const meta = await this.client().listMeetPublishedResults({ metadataOnly: true });
      this.resultIndex = new Set((meta.items || []).map((row) => row.eventKey));
      this.resultIndexLoaded = true;
      this.update({
        resultsError: '',
        events: this.data.events.map((row) => ({ ...row, hasResult: this.resultIndex.has(row.eventKey) })),
      });
    } catch (err) {
      this.update({ resultsError: (err && err.message) || '成绩状态加载失败' });
    }
    return undefined;
  },

  groupLabelOf(group) {
    return group === 'male' ? '男子' : group === 'female' ? '女子' : '混合';
  },

  /** 点项目：弹层只看这一个项目的成绩（同项目再次点开命中缓存） */
  onOpenEventResult(event) {
    if (this.data.isDraft) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    const row = this.data.events.find((item) => item.eventKey === eventKey) || null;
    const cached = this.resultCache && this.resultCache.get(eventKey);
    this.update({
      resultPopup: {
        visible: true,
        eventKey,
        title: row ? `${row.name} · ${this.groupLabelOf(row.group)}` : '',
        loading: !cached,
        error: '',
        rounds: cached ? cached : [],
      },
    });
    if (cached) return undefined;
    return this.fetchEventResult(eventKey);
  },

  async fetchEventResult(eventKey) {
    const isStale = () => !this.data.resultPopup.visible || this.data.resultPopup.eventKey !== eventKey;
    try {
      const result = await this.client().getPublishedResults({ eventKey });
      const rounds = this.decorateRounds(result.rounds || []);
      this.resultCache = this.resultCache || new Map();
      this.resultCache.set(eventKey, rounds);
      // 连着点两个项目时，慢的那个响应不能盖掉后来的（按 eventKey 判活）
      if (isStale()) return undefined;
      this.update({ resultPopup: { ...this.data.resultPopup, loading: false, error: '', rounds } });
    } catch (err) {
      if (isStale()) return undefined;
      this.update({
        resultPopup: { ...this.data.resultPopup, loading: false, error: (err && err.message) || '成绩加载失败' },
      });
    }
    return undefined;
  },

  /**
   * 弹层里的场次整理：名次升序 + 同名场次补序号。
   *
   * 两个已知的接口口径差异，都在展示层收口：
   *   · `getPublishedResults` 的行**不按名次排**（只有列表接口排），这里补；
   *   · 预赛各组的 `roundLabel` 都叫「预赛」（advance-service 的 labelOf 只按轮次，
   *     不带组号），一次弹层里会出现两个「预赛」。同名场次按出现顺序补「第 N 场」。
   */
  decorateRounds(rounds) {
    const labelCount = new Map();
    for (const round of rounds) {
      const label = round.roundLabel || '';
      labelCount.set(label, (labelCount.get(label) || 0) + 1);
    }
    const seen = new Map();
    return rounds.map((round) => {
      const label = round.roundLabel || '';
      const total = labelCount.get(label) || 0;
      let displayLabel = label;
      if (total > 1) {
        const nth = (seen.get(label) || 0) + 1;
        seen.set(label, nth);
        displayLabel = `${label}（第 ${nth} 场）`;
      }
      return {
        ...round,
        roundLabel: displayLabel,
        items: (round.items || []).slice()
          .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99)),
      };
    });
  },

  onRetryEventResult() {
    const { eventKey } = this.data.resultPopup;
    if (!eventKey) return undefined;
    this.update({ resultPopup: { ...this.data.resultPopup, loading: true, error: '' } });
    return this.fetchEventResult(eventKey);
  },

  onCloseResult() {
    this.update({
      resultPopup: { visible: false, eventKey: '', title: '', loading: false, error: '', rounds: [] },
    });
  },

  /** 弹层内部点击不关闭（遮罩才关闭） */
  onStopBubble() { return undefined; },

  async onFinish() {
    if (this.data.busy) return;
    this.update({ busy: true });
    try {
      await this.client().finishSportsMeet({});
      await this.reload();
      this.update({ notice: '运动会已结束' });
    } catch (err) {
      this.update({ error: err.message || '结束失败' });
    } finally { this.update({ busy: false }); }
  },

  /** 报名期：我的意向/入选状态 + 管理员视角的待审队列 */
  async loadParticipation() {
    try {
      const mine = await this.client().getMyMeetParticipation({});
      // 把「我在这个项目上的状态」贴到项目行上：WXML 不能查表，只能读字段
      const byEvent = new Map(mine.interests.map((row) => [row.eventKey, row.status]));
      this.update({
        interests: mine.interests,
        myEntries: mine.entries,
        events: this.data.events.map((row) => ({
          ...row, myInterestStatus: byEvent.get(row.eventKey) || '',
        })),
      });
    } catch (err) {
      // 未提交过意向也会走到这里（服务端返回空列表），失败不影响主信息
      this.update({ interests: [], myEntries: [] });
    }
    if (!this.data.canManage) return;
    try {
      const all = await this.client().listMeetEntries({});
      this.update({ pendingEntries: all.items.filter((row) => row.status === 'pending_review') });
    } catch (err) {
      this.update({ pendingEntries: [] });
    }
  },

  /** 学生提交参赛意向（不占正式名额，D10） */
  async onInterest(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().submitMeetInterest({ eventKey });
      this.update({ busy: false, notice: '已提交参赛意向，等待学院选拔' });
      return this.loadParticipation();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  async onWithdrawInterest(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().withdrawMeetInterest({ eventKey });
      this.update({ busy: false, notice: '已撤回意向' });
      return this.loadParticipation();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤回失败' });
      return undefined;
    }
  },

  /** 管理员审核（B6 可自审：代报后本人审核也允许） */
  async onReview(event) {
    if (this.data.busy) return undefined;
    const { entryKey, decision } = event.currentTarget.dataset;
    if (!entryKey || !decision) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().reviewMeetEntry({ entryKey, decision });
      this.update({ busy: false, notice: decision === 'approve' ? '已通过' : '已驳回' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '审核失败' });
      return undefined;
    }
  },

  /** 学院总榜与我的荣誉（B8） */
  onOpenStanding() {
    return wx.navigateTo({ url: `/packageMeet/meet-standing/meet-standing?meetId=${this.data.meetId}` });
  },

  /** 赛程编排（管理员） */
  onOpenSchedule() {
    return wx.navigateTo({ url: `/packageMeet/meet-schedule/meet-schedule?meetId=${this.data.meetId}` });
  },

  /** 录分与发布（管理员/裁判） */
  onOpenScore() {
    return wx.navigateTo({ url: `/packageMeet/meet-score/meet-score?meetId=${this.data.meetId}` });
  },

  /** 学院部长入口 */
  onOpenCollege() {
    return wx.navigateTo({ url: `/packageMeet/meet-college/meet-college?meetId=${this.data.meetId}` });
  },

  /** 编辑草稿基本信息：复用创建向导的第一步（带 meetId 时预填并改为更新） */
  onOpenBasic() {
    return wx.navigateTo({ url: `/packageMeet/meet-setup/meet-setup?meetId=${this.data.meetId}&step=1` });
  },

  /** 展开/收起补报窗口面板 */
  onToggleLate() {
    const now = new Date();
    const date = (offset) => {
      const d = new Date(now.getTime() + offset * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    this.update({
      lateOpen: !this.data.lateOpen,
      lateStartDate: this.data.lateStartDate || date(0),
      lateEndDate: this.data.lateEndDate || date(1),
    });
  },

  onLateDate(event) {
    const field = event.currentTarget.dataset.field;
    if (field) this.update({ [field]: event.detail.value });
  },

  onLateTime(event) {
    const field = event.currentTarget.dataset.field;
    if (field) this.update({ [field]: event.detail.value });
  },

  /** 开补报窗口：仍由学院部长提交名单，这里只放开时间 */
  async onSubmitLateWindow() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().openMeetLateWindow({
        openAt: `${this.data.lateStartDate}T${this.data.lateStartTime}`,
        closeAt: `${this.data.lateEndDate}T${this.data.lateEndTime}`,
      });
      this.update({ busy: false, lateOpen: false, notice: '补报窗口已开放' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '开放失败' });
      return undefined;
    }
  },

  onOpenSetup() {
    return wx.navigateTo({ url: `/packageMeet/meet-setup/meet-setup?meetId=${this.data.meetId}` });
  },

  onOpenAtChange(event) {
    this.update({ openAt: event.detail.value });
  },

  onCloseAtChange(event) {
    this.update({ closeAt: event.detail.value });
  },

  /** 发布报名：必须已有项目（R04），窗口由服务端再校验一次 */
  async onPublish() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().publishMeetRegistration({
        openAt: `${this.data.openAt}T00:00`,
        closeAt: `${this.data.closeAt}T23:59`,
      });
      this.update({ busy: false, notice: '报名已发布' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
    }
  },

  async onDelete() {
    if (this.data.busy) return undefined;
    const confirm = typeof wx !== 'undefined' && wx.showModal
      ? await new Promise((resolve) => wx.showModal({
        title: '删除草稿',
        content: '删除后该届不再出现在列表里，确定继续？',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      }))
      : true;
    if (!confirm) return undefined;

    this.update({ busy: true, error: '' });
    try {
      await this.client().deleteSportsMeet({});
      this.update({ busy: false });
      return wx.navigateBack({ delta: 1 });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '删除失败' });
    }
  },
}, 'meet', 'reload'));
