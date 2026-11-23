const identity = require('../../services/school-identity.js');
const exchange = require('../../services/exchange.js');
const constants = require('../../utils/constants.js');
const STATE = { signup: '报名中', ready: '名单已锁定', drawn: '已抽签', finished: '名次已确认', canceled: '已取消' };
const INVITATION = { pending: '待确认', accepted: '已接受', declined: '已婉拒', withdrawn: '已撤回' };
const MATCH_STATUS = { pending: '待比赛', active: '已确认' };

/** 可选赛制：与普通赛事同一份枚举，次序从最常用（单败）到复合赛制 */
const FORMAT_OPTIONS = [
  constants.EVENT_FORMAT.SINGLE_ELIM,
  constants.EVENT_FORMAT.ROUND_ROBIN,
  constants.EVENT_FORMAT.GROUP_KNOCKOUT,
  constants.EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT,
  constants.EVENT_FORMAT.DOUBLE_ELIM,
  constants.EVENT_FORMAT.GROUP_DOUBLE_ELIM,
].map(value => ({ value, label: constants.EVENT_FORMAT_LABEL[value] }));

const BRONZE_OPTIONS = [
  { value: constants.EVENT_BRONZE_MODE.TIED, label: constants.EVENT_BRONZE_MODE_LABEL[constants.EVENT_BRONZE_MODE.TIED] },
  { value: constants.EVENT_BRONZE_MODE.PLAYOFF, label: constants.EVENT_BRONZE_MODE_LABEL[constants.EVENT_BRONZE_MODE.PLAYOFF] },
];

Page({
  data: {
    loading: true, busy: false, error: '', notice: '', schoolId: 'muc', schoolName: '中央民族大学',
    schoolIndex: 0, schools: [], actors: [], actorIndex: 0, actorName: '',
    canCreate: false, events: [], detail: null, scoreDraft: {},
    schoolChoices: [], selectedSchoolIds: [],
    refereePicker: null,
    title: '民大北航单打交流赛', location: '模拟球场', date: '', time: '18:00', quota: '4', schoolQuota: '2',
    // 赛制与它的参数：默认单败淘汰（与历史口径一致），其余选项按赛制显隐
    formats: FORMAT_OPTIONS, formatIndex: 0, format: constants.DEFAULT_EVENT_FORMAT,
    formatLabel: constants.EVENT_FORMAT_LABEL[constants.DEFAULT_EVENT_FORMAT],
    groupCountOptions: constants.GROUP_CONFIG.COUNT_OPTIONS, groupCountIndex: 0,
    groupCount: constants.DEFAULT_GROUP_COUNT,
    advanceOptions: constants.GROUP_CONFIG.ADVANCE_OPTIONS, advanceIndex: 1,
    advancePerGroup: constants.DEFAULT_ADVANCE_PER_GROUP,
    bronzeOptions: BRONZE_OPTIONS, bronzeIndex: 0, bronzeMode: constants.DEFAULT_BRONZE_MODE,
    bronzeLabel: constants.EVENT_BRONZE_MODE_LABEL[constants.DEFAULT_BRONZE_MODE],
    gfReset: constants.DEFAULT_GF_RESET,
    showGroupCount: false, showAdvance: false, showBronze: true, showGfReset: false,
    /**
     * 当前是否本地模拟数据。只影响两处展示口径：
     *   · 顶部那行「本地模拟体验」提示（云端不写，否则真实赛事被说成演示）；
     *   · 「切换体验身份」下拉——云端没有演示身份这回事（getDemoActors 返回空数组），
     *     留一个空下拉比不显示更糟。
     * 进不进得去、能不能操作，一律由页面自身的权限与状态决定，不看这个字段。
     */
    isMock: identity.isMockNow(),
  },
  onLoad() {
    const tomorrow = new Date(Date.now() + 86400000);
    this.setData({ date: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}` });
    this.unloaded = false;
    return this.reload();
  },
  onUnload() { this.unloaded = true; this.sequence = (this.sequence || 0) + 1; this.refereeSequence = (this.refereeSequence || 0) + 1; },
  update(values) { if (!this.unloaded) this.setData(values); },

  /**
   * 按赛制显隐参数项。
   * 组数只对小组赛类赛制有意义、每组出线只对带淘汰的赛制有意义、三四名只长在
   * 单败主签表上、总决赛重赛只对双败有意义——隐藏无关项比让管理员填一堆无用字段好。
   */
  applyFormat(format) {
    const formatIndex = FORMAT_OPTIONS.findIndex(option => option.value === format);
    this.update({
      format, formatIndex: formatIndex < 0 ? 0 : formatIndex,
      formatLabel: constants.EVENT_FORMAT_LABEL[format] || '',
      showGroupCount: constants.GROUP_COUNT_FORMATS.includes(format),
      showAdvance: constants.ADVANCE_FORMATS.includes(format),
      showBronze: constants.KNOCKOUT_FORMATS.includes(format),
      showGfReset: constants.DOUBLE_ELIM_FORMATS.includes(format),
    });
  },
  async reload(eventId = '') {
    this.refereeSequence = (this.refereeSequence || 0) + 1;
    const seq = this.sequence = (this.sequence || 0) + 1;
    this.update({ loading: true, error: '', events: [], detail: null, canCreate: false, refereePicker: null });
    try {
      // 2026-10-16 起云端也已接入（协议 2 注册了邀请赛动作），门面按数据源自己选，
      // 页面不再拦「非模拟模式」——否则云环境一上线，这里就成了唯一的死路。
      const target = { schoolId: this.data.schoolId, association: 'pkb' };
      const sessionApi = identity.forSchoolIdentity(target);
      const api = exchange.forScope(target);
      const [directory, session] = await Promise.all([sessionApi.getSchoolDirectory(), sessionApi.getSchoolIdentitySession()]);
      if (!directory.ok || !session.ok) throw new Error(directory.message || session.message);
      const result = await api.getExchangeEvents();
      let detail = null;
      if (eventId && result.ok) {
        const response = await api.getExchangeEvent({ eventId });
        if (response.ok) detail = this.describeDetail(response, target.schoolId);
      }
      if (seq !== this.sequence || this.unloaded) return;
      this.api = api;
      const actors = identity.getDemoActors();
      // 当前演示身份未必在这份体验身份清单里（默认身份跟随 mock.js 的演示账号），
      // 找不到就落到第一项，别让下拉 value 变成 -1。云端 actors 为空数组，
      // actorIndex/actorName 取到 0 / ''，配合模板上的 wx:if 整条下拉不渲染。
      const found = actors.findIndex(actor => actor.id === identity.getDemoActor());
      const actorIndex = found >= 0 ? found : 0;
      const schoolIndex = Math.max(0, directory.schools.findIndex(school => school.schoolId === target.schoolId));
      const currentSchool = directory.schools[schoolIndex];
      if (!currentSchool) throw new Error('学校目录为空，请稍后重试');
      const previous = new Map((this.data.schoolChoices || []).map(row => [row.schoolId, row]));
      const selected = this.data.selectedSchoolIds.length ? this.data.selectedSchoolIds
        : directory.schools.filter(row => row.schoolId !== target.schoolId).slice(0, 1).map(row => row.schoolId);
      const selectedSchoolIds = [...new Set([target.schoolId, ...selected])].filter(id => directory.schools.some(row => row.schoolId === id));
      this.update({ schools: directory.schools, schoolIndex, schoolName: currentSchool.name,
        selectedSchoolIds,
        schoolChoices: directory.schools.map(row => ({ ...row, selected: selectedSchoolIds.includes(row.schoolId),
          host: row.schoolId === target.schoolId, quota: previous.get(row.schoolId)?.quota || this.data.schoolQuota })),
        actors, actorIndex, actorName: (actors[actorIndex] && actors[actorIndex].label) || '',
        isMock: identity.isMockNow(),
        canCreate: session.canManageAssociation, detail, scoreDraft: {},
        events: (result.events || []).map(event => ({ ...event, statusText: STATE[event.status],
          invitationText: INVITATION[event.invitations[target.schoolId]] })),
        notice: result.ok ? '' : result.message,
      });
    } catch (err) {
      if (seq === this.sequence) this.update({ error: err.message || '读取失败，请刷新重试' });
    } finally { if (seq === this.sequence) this.update({ loading: false }); }
  },
  describeDetail(response, schoolId) {
    const event = response.event;
    const canceled = response.canceled === true || event.status === 'canceled';
    return { ...response, statusText: STATE[event.status], canceled,
      canLock: !canceled && response.canManage && event.status === 'signup',
      schools: event.participantSchoolIds.map(id => ({ id, name: event.schoolNames[id],
        status: INVITATION[event.invitations[id]], count: event.schoolCounts[id], quota: event.schoolQuotas[id],
        // 撤回邀请：报名阶段、不是主办校自己、该校还没人报名时才能撤
        canWithdraw: Boolean(response.canWithdrawInvitation) && id !== event.schoolId &&
          (event.schoolCounts[id] || 0) === 0 &&
          ['pending', 'accepted'].includes(event.invitations[id]),
      })),
      invitationText: INVITATION[event.invitations[schoolId]],
      results: (event.results || []).slice(),
      participants: (response.participants || []).map(row => ({ ...row,
        checkInText: row.checkInTime ? '已签到' : '未签到' })),
      matches: (response.matches || []).map(match => ({ ...match, statusText: MATCH_STATUS[match.status],
        scoreText: match.status === 'active' ? `${match.scoreA}:${match.scoreB}` : '未开始' })),
    };
  },

  /** 破坏性动作的二次确认：与协会空间面板同一写法，测试环境放行 */
  confirmAction(content, title = '请确认') {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') { resolve(true); return; }
      wx.showModal({ title, content, success: res => resolve(Boolean(res.confirm)), fail: () => resolve(false) });
    });
  },
  onSchoolChange(event) {
    if (this.data.busy) return;
    const school = this.data.schools[Number(event.detail.value)];
    if (!school) return;
    this.update({ schoolId: school.schoolId, notice: '', selectedSchoolIds: [], schoolChoices: [] });
    this.requestId = '';
    return this.reload();
  },
  onActorChange(event) {
    if (this.data.busy) return;
    const actor = this.data.actors[Number(event.detail.value)];
    if (!actor) return;
    // 切换演示身份统一经 app（B3）：登录态、兼容视图与浏览范围跟着新身份
    // 一起刷新，避免「按钮是管理员、提交是会员」的分裂。测试环境没有 app
    // 实例时退回只切 mock 身份。
    const app = typeof getApp === 'function' ? getApp() : null;
    const switched = app && typeof app.switchDemoActor === 'function'
      ? app.switchDemoActor(actor.id).catch(err => { this.update({ error: err.message || '切换身份失败' }); })
      : Promise.resolve(identity.setDemoActor(actor.id));
    this.requestId = '';
    return switched.then(() => this.reload(this.data.detail && this.data.detail.event._id || ''));
  },
  onField(event) {
    if (this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['title', 'location', 'date', 'time', 'quota', 'schoolQuota'].includes(field)) return;
    this.update({ [field]: event.detail.value });
    this.requestId = '';
  },
  onFormatChange(event) {
    if (this.data.busy) return;
    const option = FORMAT_OPTIONS[Number(event.detail.value)];
    if (!option) return;
    this.requestId = '';
    this.applyFormat(option.value);
  },
  onGroupCountChange(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    const value = this.data.groupCountOptions[index];
    if (!value) return;
    this.requestId = '';
    this.update({ groupCountIndex: index, groupCount: value });
  },
  onAdvanceChange(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    const value = this.data.advanceOptions[index];
    if (!value) return;
    this.requestId = '';
    this.update({ advanceIndex: index, advancePerGroup: value });
  },
  onBronzeChange(event) {
    if (this.data.busy) return;
    const option = BRONZE_OPTIONS[Number(event.detail.value)];
    if (!option) return;
    this.requestId = '';
    this.update({ bronzeIndex: Number(event.detail.value), bronzeMode: option.value, bronzeLabel: option.label });
  },
  onGfResetChange(event) {
    if (this.data.busy) return;
    this.requestId = '';
    this.update({ gfReset: Boolean(event.detail.value) });
  },
  onOpen(event) {
    if (!this.data.busy) return this.reload(event.currentTarget.dataset.id);
  },
  onRefresh() { if (!this.data.busy) return this.reload(this.data.detail && this.data.detail.event._id || ''); },
  async write(action) {
    if (this.data.loading || this.data.busy || !this.api) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await action(this.api);
      if (!result.ok) throw new Error(result.message || '操作失败');
      await this.reload(result.event._id);
      this.update({ notice: '操作成功' });
    } catch (err) { this.update({ error: err.message || '操作失败，请重试' }); }
    finally { this.update({ busy: false }); }
  },
  async onCreate() {
    if (!this.data.canCreate) return;
    const schoolIds = this.data.selectedSchoolIds;
    if (schoolIds.length < 2 || schoolIds.length > 8 || !schoolIds.includes(this.data.schoolId)) {
      this.update({ error: '请选择含主办校在内的 2 至 8 所学校' }); return;
    }
    const quota = Number(this.data.quota);
    const schoolQuotas = Object.fromEntries(this.data.schoolChoices.filter(row => schoolIds.includes(row.schoolId))
      .map(row => [row.schoolId, Number(row.quota)]));
    if (!Number.isInteger(quota) || quota < 2 || quota > 128 || schoolIds.some(id => !Number.isInteger(schoolQuotas[id])
      || schoolQuotas[id] < 1 || schoolQuotas[id] > quota) || Object.values(schoolQuotas).reduce((sum, n) => sum + n, 0) < quota) {
      this.update({ error: '总名额须为 2 至 128 人，各校名额须为正整数且合计不少于总名额' }); return;
    }
    const start = new Date(`${this.data.date}T${this.data.time}:00`);
    if (!Number.isFinite(start.getTime())) { this.update({ error: '请选择有效时间' }); return; }
    if (typeof wx !== 'undefined' && wx.showModal) {
      if (this.createConfirming || this.data.busy) return;
      this.createConfirming = true;
      const fingerprint = JSON.stringify([this.data.schoolId, this.data.selectedSchoolIds, this.data.schoolChoices, this.data.title, this.data.location, this.data.date, this.data.time, this.data.format, this.data.quota, this.data.groupCount, this.data.advancePerGroup, this.data.bronzeMode, this.data.gfReset]);
      const summary = this.data.schoolChoices.filter(row => schoolIds.includes(row.schoolId)).map(row => row.name + ' ' + row.quota + ' 人').join('；');
      const confirmed = await new Promise(resolve => wx.showModal({ title: '核对交流赛邀请', content: this.data.title + '\n' + this.data.date + ' ' + this.data.time + ' · ' + this.data.location + '\n' + this.data.formatLabel + ' · 总名额 ' + quota + ' 人\n' + summary,
        success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
      this.createConfirming = false;
      if (!confirmed || fingerprint !== JSON.stringify([this.data.schoolId, this.data.selectedSchoolIds, this.data.schoolChoices, this.data.title, this.data.location, this.data.date, this.data.time, this.data.format, this.data.quota, this.data.groupCount, this.data.advancePerGroup, this.data.bronzeMode, this.data.gfReset])) return;
    }
    this.requestId = this.requestId || `create_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return this.write(api => api.createExchangeEvent({ requestId: this.requestId, title: this.data.title,
      location: this.data.location, startTime: start.toISOString(), participantSchoolIds: schoolIds,
      quota, schoolQuotas,
      // 赛制与参数：服务端只保留该赛制真正用得到的字段（见 normalizeExchangeFormat）
      format: this.data.format, groupCount: Number(this.data.groupCount),
      advancePerGroup: Number(this.data.advancePerGroup), bronzeMode: this.data.bronzeMode,
      gfReset: Boolean(this.data.gfReset),
    }));
  },
  onSchoolSelection(event) {
    if (this.data.busy) return;
    const ids = [...new Set([this.data.schoolId, ...(event.detail.value || [])])]
      .filter(id => this.data.schools.some(row => row.schoolId === id));
    if (ids.length > 8) { this.update({ error: '一次最多邀请 8 所学校' }); return; }
    this.requestId = '';
    this.update({ selectedSchoolIds: ids, error: '', schoolChoices: this.data.schoolChoices.map(row => ({ ...row, selected: ids.includes(row.schoolId) })) });
  },
  onSchoolQuota(event) {
    if (this.data.busy) return;
    this.requestId = '';
    const id = event.currentTarget.dataset.schoolid;
    this.update({ schoolChoices: this.data.schoolChoices.map(row => row.schoolId === id ? { ...row, quota: event.detail.value } : row) });
  },
  onRespond(event) {
    if (!this.data.detail || !this.data.detail.canRespond) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.respondExchangeInvitation({ eventId, decision: event.currentTarget.dataset.decision }));
  },
  onSignup() {
    if (!this.data.detail || !this.data.detail.canSignup) return;
    const { signed, event } = this.data.detail;
    return this.write(api => signed ? api.cancelExchangeSignup({ eventId: event._id }) : api.signUpExchangeEvent({ eventId: event._id }));
  },
  onLock() {
    if (!this.data.detail || !this.data.detail.canManage) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.lockExchangeRoster({ eventId }));
  },
  onDraw() {
    if (!this.data.detail || !this.data.detail.canDraw) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.drawExchangeEvent({ eventId }));
  },
  onOpenReferee(event) {
    const detail = this.data.detail;
    const matchId = event.currentTarget.dataset.matchid;
    if (!detail || !(detail.matches || []).some(m => m._id === matchId && m.canAssignReferee)) return;
    const schools = detail.schools.filter(s => detail.event.invitations[s.id] === 'accepted');
    if (!schools.length) return;
    this.update({ refereePicker: { matchId, schools, schoolIndex: 0, keyword: '', rows: [], cursor: '', hasMore: false } });
    return this.loadReferees(false);
  },
  async loadReferees(append = false) {
    const picker = this.data.refereePicker;
    if (!picker || append && !picker.hasMore) return;
    const seq = this.refereeSequence = (this.refereeSequence || 0) + 1;
    this.update({ 'refereePicker.loading': true, 'refereePicker.error': '' });
    try {
      const result = await this.api.listExchangeRefereeCandidates({ eventId: this.data.detail.event._id,
        schoolId: picker.schools[picker.schoolIndex].id, keyword: picker.keyword,
        cursor: append ? picker.cursor : '', limit: 20 });
      if (seq !== this.refereeSequence || this.unloaded) return;
      if (!result.ok) throw new Error(result.message);
      this.update({ 'refereePicker.rows': append ? [...picker.rows, ...result.members] : result.members,
        'refereePicker.cursor': result.nextCursor, 'refereePicker.hasMore': result.hasMore });
    } catch (error) {
      if (seq === this.refereeSequence) this.update({ 'refereePicker.error': error.message || '候选读取失败',
        'refereePicker.rows': [], 'refereePicker.hasMore': false });
    } finally { if (seq === this.refereeSequence) this.update({ 'refereePicker.loading': false }); }
  },
  onRefereeSchool(event) {
    this.update({ 'refereePicker.schoolIndex': Number(event.detail.value), 'refereePicker.rows': [] });
    return this.loadReferees(false);
  },
  onRefereeKeyword(event) {
    this.refereeSequence = (this.refereeSequence || 0) + 1;
    this.update({ 'refereePicker.keyword': event.detail.value, 'refereePicker.rows': [],
      'refereePicker.cursor': '', 'refereePicker.hasMore': false, 'refereePicker.loading': false });
  },
  onSearchReferees() { return this.loadReferees(false); },
  onMoreReferees() { if (!this.data.refereePicker.loading) return this.loadReferees(true); },
  onCloseReferee() { this.refereeSequence = (this.refereeSequence || 0) + 1; this.update({ refereePicker: null }); },
  onRefereeChange(event) {
    if (this.data.busy || !this.data.detail) return;
    const picker = this.data.refereePicker;
    if (!picker) return;
    const referee = picker.rows.find(row => row.userId === event.currentTarget.dataset.userid);
    if (!referee) return;
    const matchId = picker.matchId;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.assignExchangeReferee({ eventId, matchId, refereeId: referee.userId }));
  },
  onScoreInput(event) {
    if (this.data.busy) return;
    const { matchid, side } = event.currentTarget.dataset;
    if (!matchid || !['a', 'b'].includes(side)) return;
    const scoreDraft = { ...this.data.scoreDraft };
    scoreDraft[matchid] = { a: '', b: '', ...(scoreDraft[matchid] || {}), [side]: event.detail.value };
    this.update({ scoreDraft });
  },
  onSubmitScore(event) {
    if (this.data.busy || !this.data.detail) return;
    const matchId = event.currentTarget.dataset.matchid;
    const row = this.data.scoreDraft[matchId] || {};
    const scoreA = Number(row.a);
    const scoreB = Number(row.b);
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      this.update({ error: '请填写双方比分' });
      return;
    }
    const eventId = this.data.detail.event._id;
    return this.write(api => api.submitExchangeScore({ eventId, matchId, scoreA, scoreB }));
  },
  onConfirmRanking() {
    if (!this.data.detail || !this.data.detail.canConfirmRanking) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.confirmExchangeRanking({ eventId }));
  },

  /* ---------- S4 剩余能力（2026-10-16）：签到 / 退赛 / 撤回邀请 / 取消 / 撤销比分 ---------- */

  /** 代签：管理员在场边替参赛者签到（与普通赛事同一口径，本人不自助签到） */
  onCheckIn(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const userId = event.currentTarget.dataset.userid;
    if (!userId) return;
    return this.write(api => api.checkInExchangeSignup({ eventId: detail.event._id, userId }));
  },

  /** 移除报名者（退赛处理）：只在报名阶段，需二次确认 */
  onRemoveSignup(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const userId = event.currentTarget.dataset.userid;
    if (!userId) return;
    return this.confirmAction('移除后该名额会释放，确定移除这位报名者吗？', '移除报名')
      .then(confirmed => (confirmed
        ? this.write(api => api.removeExchangeSignup({ eventId: detail.event._id, userId }))
        : undefined));
  },

  /** 撤回对某校的邀请（主办方撤别人、受邀校撤自己那一条） */
  onWithdrawInvitation(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const schoolId = event.currentTarget.dataset.schoolid;
    if (!schoolId) return;
    return this.confirmAction('撤回后该校不能再报名，确定撤回邀请吗？', '撤回邀请')
      .then(confirmed => (confirmed
        ? this.write(api => api.withdrawExchangeInvitation({ eventId: detail.event._id, schoolId }))
        : undefined));
  },

  /** 取消整场赛事：主办校管理员或平台管理员 */
  onCancelEvent() {
    const { detail } = this.data;
    if (this.data.busy || !detail || !detail.canCancel) return;
    return this.confirmAction('取消后不能再报名、抽签与录入比分，已确认的比分作为历史保留。确定取消吗？', '取消赛事')
      .then(confirmed => (confirmed
        ? this.write(api => api.cancelExchangeEvent({ eventId: detail.event._id }))
        : undefined));
  },

  // 撤销比分已随 Elo 逐场结算改造取消：已确认的比分不可撤销（个人赛与交流赛同规则）
});
