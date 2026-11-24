/**
 * 录入比赛成绩
 * ============================================================
 * 只做一件事：把一张填好的单子变成一条「待确认」的比赛记录。
 * 校验与组装在 services/match-record.js，表单的纯逻辑在
 * services/match-entry-view.js，这里负责取数、交互与 setData。
 *
 * 【为什么独立成页而不是比赛面板里的一个弹层】
 * 录入页要接收查询参数：带 matchId 进来是给抽签排出的比赛补分，不带则是新录一场。
 * 比赛板块收在「协会工作台」里，从这个普通页跳过来才带得上参数（tabBar 页面
 * 只能 switchTab、带不了参数）。将来还要接草稿、扫场地码，也只有普通页做得到。
 *
 * 【未登录为什么不能进来】
 * 录入要把当前用户写进 A 队第一格并作为 recorder（见 seed.js 的约定）。
 * 没有身份就没有 A 队，整张单子无从填起。所以这里也拦一道——
 * 用户可能绕过比赛页直接从小程序码进来。
 *
 * 选手名单来自 S2 本协会有效成员，录分权来自服务端能力。
 * ============================================================
 */

const { isMockNow } = require('../../services/runtime-mode.js');
const space = require('../../services/association-space');
const schoolSession = require('../../services/school-session');
const associationScope = require('../../services/association-scope');
const { recordOf, authOf } = require('../../services/school-match-view');
const {
  MATCH_TYPE_OPTIONS,
  formatOptionsOf,
  formatOfForm,
  formatTextOf,
  scoreUnitLabelOf,
  createForm,
  scheduledForm,
  resizeTeams,
  resizeScores,
  toScoreRows,
  winnerOf,
  toSubmitParams,
  buildPickerRows,
  pickerEmptyText,
} = require('../../services/match-entry-view.js');

const { MATCH_STATUS } = require('../../shared/utils/constants');
const { currentThemeClass } = require('../../services/branding.js');

/** 把 Date 变成 picker 要的 2026-05-01 */
function toDateText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把 Date 变成 picker 要的 18:30 */
function toTimeText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const { toast } = require('../../utils/page-helpers.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 当前登录态 */
    auth: { loggedIn: false },
    isMock: false,

    /** 不能录入时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /**
     * 这一场的裁判情况。补录签表比赛时才有意义：
     *   hasReferee 有指定裁判就标出是谁；
     *   restricted 表示「本场已交给裁判，而你既不是裁判也不是管理员」，
     *   此时录分入口会被写入端拒下，页面上提前说清楚，别让人填完才被拒。
     */
    referee: { hasReferee: false, name: '', restricted: false },

    /**
     * 是否为「给签表里排定的比赛补录比分」。
     * 这种模式下对阵、赛制、时间、场地都来自那条记录，页面只收比分。
     */
    scheduled: false,

    /** 完整会员名单，供「找人面板」按名字搜索 */
    members: [],

    /** 赛季首日，用作日期选择器的下界 */
    seasonStart: '',

    /**
     * 赛制选项。按当前协会的计分体系生成：
     *   匹克球 / 乒乓 / 羽毛球 → 分制 + 局制；
     *   网球                   → 盘制 + 每盘局数（一局恒定 4 分，没有分制可调）。
     * 选项跟着协会走，页面不再 import 全局常量——否则网球会拿到三个用不上的分制。
     */
    formatOptions: formatOptionsOf(''),
    /** 是否网球（三层计分）：决定页面文案说「局」还是「盘」 */
    isTennis: false,
    /** 比分单元的叫法：局 / 盘 */
    scoreUnit: '局',

    /** 项目 / 分制 / 局制选项 */
    matchTypeOptions: MATCH_TYPE_OPTIONS,
    gamePointsLabels: [],
    bestOfLabels: [],
    setGamesLabels: [],
    /** picker 下标 */
    gamePointsIndex: 0,
    bestOfIndex: 0,
    setGamesIndex: 0,

    /** 表单本体 */
    form: {},
    /** A / B 队的渲染行（含 picker 下标与锁定标记） */
    teamARows: [],
    teamBRows: [],
    /** 比分输入行 */
    scoreRows: [],
    /** 赛制文案与实时推出来的胜方 */
    formatText: '',
    winnerText: '',

    // ---------- 找人面板 ----------
    // 原生 picker 只吃一个静态数组，几十个名字里没法搜；换成这个自建面板，
    // 点格子打开，边打字边筛，再点一下选中。
    /** 面板是否打开 */
    pickerHasMore: false, pickerCursor: '', pickerLoading: false, pickerError: '',
    pickerVisible: false,
    /** 正在给哪一队的哪一格选人 */
    pickerSide: '',
    pickerSlot: -1,
    /** 面板里的搜索词 */
    pickerKeyword: '',
    /** 面板里显示的名单（已筛选） */
    pickerRows: [],
    /** 面板里一个人都没搜到时给的解释 */
    pickerEmptyText: '',

    /** 逐字段的错误提示 */
    errors: {},
    /** 逐局比分的错误。数量与输入行对不上，单独放，别和字段错误挤在一起 */
    scoreErrors: [],
    /** 整体错误提示 */
    errorText: '',
  },

  /**
   * 返回 Promise 是有意为之：测试需要句柄等首屏加载完。
   * @returns {Promise<void>}
   */
  onLoad(query) {
    this.matchId = (query && query.matchId) || '';
    this.setData({ isMock: isMockNow() });
    return this.init();
  },

  /**
   * 回到本页时（例如从实时计分台返回）刷新签表补录的比分。
   * 计分台定稿会把比分写回原记录；不刷新，表单还停在计分前的空比分，
   * 再点提交就会把刚打完的实时结果覆盖掉。日常录入没有记录可刷，跳过。
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    if (!this.matchId || !this._loaded) return undefined;
    return this.refreshScheduled();
  },

  async refreshScheduled() {
    try {
      // presentation 会带回本场选手与裁判的昵称：首屏只取了一页名录，
      // 签表里的人可能不在这一页里，靠这份补齐 nameById。
      const result = await this.api.getSchoolMatch({ matchId: this.matchId, presentation: true });
      if (!result.ok) throw new Error(result.message || '找不到这场比赛');
      if (Array.isArray(result.members)) {
        const merged = new Map(Object.entries(this.nameById || {}));
        result.members.forEach(row => merged.set(row.userId, row.nickName || row.userId));
        this.nameById = Object.fromEntries(merged);
      }
      this.applyRecord(result.match);
    } catch (error) {
      this.setData({ blockReason: error.message || '比赛加载失败，请返回重试' });
    }
  },

  applyRecord(dto) {
    const name = this.nameOf(dto.referee) || dto.referee;
    const referee = { hasReferee: dto.hasReferee, name, restricted: dto.hasReferee && !dto.canSubmitScore };
    this.setData({ referee, blockReason: dto.canSubmitScore ? '' :
      (dto.status !== MATCH_STATUS.PENDING ? '这场比赛已生效或已作废，不能再录入比分' : dto.hasReferee ? '本场由 ' + name + ' 裁判执法，仅裁判与管理员可录入比分' : '这场不是你参加的比赛，无权录入成绩') });
    this.applyForm(scheduledForm(recordOf(dto)));
  },

  async init() {
    this.scope = { schoolId: schoolSession.getSchoolId() || 'muc', association: associationScope.getAssociation() };
    this.api = space.forScope(this.scope);
    // 赛制选项跟着协会走：网球是盘制 + 每盘局数，其余是分制 + 局制
    this.formatOptions = formatOptionsOf(this.scope.association);
    this.requestId = 'match_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    try {
      // 路由编号兼容（见 utils/route-query.js）：开发者工具把 query 原样透传，
      // 未解码的 matchId 直接查会「找不到这场比赛」，这里先探测出真实编号
      if (this.matchId) this.matchId = await this.resolveMatchId(this.matchId);
      // 只取一页（服务端上限 50）供面板首屏使用，不再把全校名录塞进 setData。
      // 搜索与继续翻页由 loadPickerMembers 按需拉取。
      const context = await this.api.getSchoolMatchEntryContext({ page: true, limit: 50 });
      if (!context.ok) throw new Error(context.message || '页面加载失败');
      this.context = context;
      const auth = authOf(context);
      this.pairInfo = context.pairInfo;
      this.nameById = Object.fromEntries(context.members.map(m => [m.userId, m.nickName || m.userId]));
      const seasonStart = context.seasonStart ? toDateText(new Date(context.seasonStart)) : '';
      this.setData({ loading: false, error: '', auth, scheduled: Boolean(this.matchId), seasonStart,
        members: context.members.map(m => ({ id: m.userId, name: m.nickName || m.userId, realName: m.realName })),
        formatOptions: this.formatOptions,
        isTennis: this.formatOptions.scoring === 'tennis',
        scoreUnit: this.formatOptions.scoring === 'tennis' ? '盘' : '局',
        gamePointsLabels: this.formatOptions.gamePointsLabels,
        bestOfLabels: this.formatOptions.bestOfLabels,
        setGamesLabels: this.formatOptions.setGamesLabels,
        blockReason: auth.canRecord ? '' : auth.notice || '当前账号暂时不能录入成绩', themeClass: currentThemeClass() });
      if (this.matchId) await this.refreshScheduled();
      else {
        const now = new Date();
        const form = createForm(context.viewer ? { _id: context.viewer.userId } : null, this.formatOptions);
        form.date = toDateText(now) < seasonStart ? seasonStart : toDateText(now);
        form.time = toTimeText(now);
        this.applyForm(form);
      }
      this._loaded = true;
    } catch (error) {
      this.setData({ loading: false, error: error.message || '页面加载失败，请返回重试', blockReason: '页面尚未加载，请重试' });
    }
  },

  /** 编号 → 昵称 */
  nameOf(userId) {
    if (!userId) return '';
    return (this.nameById && this.nameById[userId]) || '';
  },

  /**
   * 把路由里的 matchId 解析成真实编号：先原值、再解码值（见 utils/route-query.js）。
   * 全部未命中时返回原值，交由后续读取按「找不到」处理。
   */
  async resolveMatchId(raw) {
    const { routeIdCandidates } = require('../../utils/route-query.js');
    for (const id of routeIdCandidates(raw)) {
      // eslint-disable-next-line no-await-in-loop —— 候选最多两个
      const result = await this.api.getSchoolMatch({ matchId: id });
      if (result && result.ok) return id;
    }
    return raw;
  },

  /**
   * 写入表单并重算所有派生字段。
   * 一律走这里，免得某个字段改了、展示却没跟着更新。
   */
  applyForm(form, extra = {}) {
    // 补录签表比赛时两队的对阵都已排定，一格都不给改；日常录入则只锁
    // A 队第一格（那是登录者自己）
    const scheduled = Boolean(this.matchId);
    const rowsOf = (team, lockedFirst) =>
      (Array.isArray(team) ? team : []).map((id, slot) => {
        const selfSlot = lockedFirst && slot === 0;
        return {
          slot,
          id,
          name: this.nameOf(id),
          locked: scheduled || selfSlot,
          // 只有「这一格是我自己」才标「我」；签表锁定的格子不分身份
          lockLabel: !scheduled && selfSlot ? '我' : '',
        };
      });

    const winner = winnerOf(form.scoreA, form.scoreB, formatOfForm(form));
    const winnerTeam = winner === 'A' ? form.teamA : form.teamB;
    const winnerNames = (Array.isArray(winnerTeam) ? winnerTeam : [])
      .filter(Boolean)
      .map((id) => this.nameOf(id))
      .join('、');

    const options = this.formatOptions || formatOptionsOf('');
    const isTennis = form.scoring === 'tennis';
    // picker 要的是下标，不是值。取不到时退回 0——只有签表记录的赛制
    // 不在本协会选项里才会发生，而那种情况下 picker 本来就是只读的。
    const indexOf = (list, value) => {
      const at = (list || []).indexOf(value);
      return at < 0 ? 0 : at;
    };

    this.setData({
      form,
      teamARows: rowsOf(form.teamA, true),
      teamBRows: rowsOf(form.teamB, false),
      scoreRows: toScoreRows(form.scoreA, form.scoreB),
      scoreUnit: isTennis ? '盘' : '局',
      gamePointsIndex: indexOf(options.gamePointsOptions, form.gamePoints),
      bestOfIndex: indexOf(options.bestOfOptions, form.bestOf),
      setGamesIndex: indexOf(options.setGamesOptions, form.setGames),
      gamePointsText: options.gamePointsLabels[indexOf(options.gamePointsOptions, form.gamePoints)] || '',
      bestOfText: options.bestOfLabels[indexOf(options.bestOfOptions, form.bestOf)] || '',
      setGamesText: options.setGamesLabels[indexOf(options.setGamesOptions, form.setGames)] || '',
      formatText: formatTextOf(formatOfForm(form)),
      winnerText: winner ? `${winnerNames || (winner === 'A' ? 'A 队' : 'B 队')} 胜` : '',
      ...extra,
    });
  },

  /* ---------- 表单交互 ---------- */

  /** 切换单打 / 双打。队伍格子与比分行都要跟着变，已填内容尽量保留 */
  onPickMatchType(event) {
    const matchType = Number(event.currentTarget.dataset.value);
    const form = this.data.form;
    if (!matchType || matchType === form.matchType) return;

    // 换项目不重置比分：三局两胜单打改双打，刚填的比分照样算数
    this.applyForm({ ...form, matchType, ...resizeTeams(form, matchType) });
  },

  /* ---------- 找人面板 ---------- */

  /** 读某一格当前选的人，用作面板里的打勾标记 */
  selectedIdOf(side, slot) {
    const team = side === 'A' ? this.data.form.teamA : this.data.form.teamB;
    return (Array.isArray(team) ? team[Number(slot)] : '') || '';
  },

  /** 按搜索词重算面板里的名单。纯本地计算，跟着每次输入即时调用 */
  applyPickerKeyword(keyword) {
    const rows = buildPickerRows(
      this.pickerCandidates || this.data.members,
      keyword,
      this.selectedIdOf(this.data.pickerSide, this.data.pickerSlot),
      // 只有对手那一侧带场次：名额只数跨队相对的人，同队的搭档之间不算一对
      this.data.pickerSide === 'B' ? this.pairInfo : null
    );
    this.setData({
      pickerKeyword: String(keyword == null ? '' : keyword).trim(),
      pickerRows: rows,
      pickerEmptyText: pickerEmptyText(keyword),
    });
  },

  /** 点某一格，打开找人面板。A 队第 0 格是锁的，点不到这里 */
  onOpenPicker(event) {
    const { side, slot } = event.currentTarget.dataset;
    const index = Number(slot);

    this.setData({ pickerVisible: true, pickerSide: side, pickerSlot: index });
    this.applyPickerKeyword('');
    return this.loadPickerMembers(false);
  },

  /** 面板里输入搜索词 */
  onInputPickerKeyword(event) {
    this.applyPickerKeyword(event.detail.value);
    clearTimeout(this.pickerSearchTimer);
    this.pickerRequest = (this.pickerRequest || 0) + 1;
    this.pickerSearchTimer = setTimeout(() => this.loadPickerMembers(false), 250);
  },

  /** 清空面板里的搜索词 */
  onClearPickerKeyword() {
    clearTimeout(this.pickerSearchTimer);
    this.applyPickerKeyword('');
    return this.loadPickerMembers(false);
  },

  async loadPickerMembers(append = false) {
    if (!this.api || !this.data.pickerVisible || append && (this.data.pickerLoading || !this.data.pickerHasMore)) return;
    const request = this.pickerRequest = (this.pickerRequest || 0) + 1;
    const keyword = this.data.pickerKeyword;
    this.setData({ pickerLoading: true, pickerError: '' });
    try {
      const result = await this.api.listSchoolMembers({ page: true, keyword, limit: 50,
        cursor: append ? this.data.pickerCursor : '' });
      if (request !== this.pickerRequest || !this.data.pickerVisible) return;
      if (!result.ok) throw new Error(result.message || '成员读取失败');
      const incoming = (result.members || []).map(row => ({ id: row.userId, name: row.nickName || row.userId }));
      this.pickerCandidates = [...new Map([...(append ? this.pickerCandidates || [] : []), ...incoming].map(row => [row.id, row])).values()];
      const members = [...new Map([...this.data.members, ...incoming].map(row => [row.id, row])).values()];
      this.nameById = Object.fromEntries(members.map(row => [row.id, row.name]));
      this.setData({ members, pickerHasMore: Boolean(result.hasMore), pickerCursor: result.nextCursor || '', pickerLoading: false });
      this.applyPickerKeyword(keyword);
    } catch (error) {
      if (request === this.pickerRequest && this.data.pickerVisible) this.setData({ pickerLoading: false, pickerError: error.message || '成员读取失败，请重试' });
    }
  },
  onMorePicker() { return this.loadPickerMembers(true); },
  onRetryPicker() { return this.loadPickerMembers(false); },
  onUnload() { clearTimeout(this.pickerSearchTimer); this.pickerRequest = (this.pickerRequest || 0) + 1; },

  /** 在面板里点中一个人，填进那一格并收起面板 */
  onPickMember(event) {
    const { side, slot, id } = event.currentTarget.dataset;
    if (!id) return;

    const form = this.data.form;
    const team = side === 'A' ? [...form.teamA] : [...form.teamB];
    team[Number(slot)] = id;

    clearTimeout(this.pickerSearchTimer); this.pickerRequest = (this.pickerRequest || 0) + 1;
    this.setData({ pickerVisible: false, pickerKeyword: '', pickerRows: [], pickerEmptyText: '' });
    this.applyForm(side === 'A' ? { ...form, teamA: team } : { ...form, teamB: team });
  },

  /** 收起面板，不改动任何一格 */
  onClosePicker() {
    clearTimeout(this.pickerSearchTimer); this.pickerRequest = (this.pickerRequest || 0) + 1;
    this.setData({ pickerVisible: false, pickerKeyword: '', pickerRows: [], pickerEmptyText: '' });
  },

  /** 面板内层吞掉冒泡，免得点列表时连带把面板关掉 */
  noop() {},

  /** 填比分 */
  onInputScore(event) {
    const { side, slot } = event.currentTarget.dataset;
    const key = side === 'A' ? 'scoreA' : 'scoreB';
    const scores = [...this.data.form[key]];
    scores[Number(slot)] = event.detail.value;

    this.applyForm({ ...this.data.form, [key]: scores });
  },

  onPickGamePoints(event) {
    const options = this.formatOptions || formatOptionsOf('');
    const gamePoints = options.gamePointsOptions[Number(event.detail.value)];
    if (!gamePoints) return;
    this.applyForm({ ...this.data.form, gamePoints });
  },

  /** 换局制要把比分输入行的数量对齐，否则三局两胜改五局三胜时会缺两行 */
  onPickBestOf(event) {
    const options = this.formatOptions || formatOptionsOf('');
    const bestOf = options.bestOfOptions[Number(event.detail.value)];
    const form = this.data.form;
    if (!bestOf || bestOf === form.bestOf) return;

    this.applyForm({
      ...form,
      bestOf,
      scoreA: resizeScores(bestOf, form.scoreA),
      scoreB: resizeScores(bestOf, form.scoreB),
    });
  },

  /**
   * 网球换每盘局数（6 局标准盘 / 4 局短盘）。
   * 盘制不变，比分行的行数也不变——变的只是「一盘到几局算赢」。
   */
  onPickSetGames(event) {
    const options = this.formatOptions || formatOptionsOf('');
    const setGames = options.setGamesOptions[Number(event.detail.value)];
    if (!setGames) return;
    this.applyForm({
      ...this.data.form,
      setGames,
      tiebreakAt: setGames,
    });
  },

  /** 网球无占先开关：40:40 后下一分直接定胜负 */
  onToggleNoAd(event) {
    const noAd = Boolean(event.detail.value);
    this.applyForm({ ...this.data.form, noAd });
  },

  onPickDate(event) {
    this.applyForm({ ...this.data.form, date: event.detail.value });
  },

  onPickTime(event) {
    this.applyForm({ ...this.data.form, time: event.detail.value });
  },

  onInputLocation(event) {
    this.applyForm({ ...this.data.form, location: event.detail.value });
  },

  /* ---------- 提交 ---------- */

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason || this.data.loading || this.data.error) return undefined;

    const params = toSubmitParams(this.data.form);

    this.setData({ submitting: true, errors: {}, scoreErrors: [], errorText: '' });
    try {
      const result = this.matchId
        ? await this.api.submitSchoolMatch({ matchId: this.matchId, scoreA: params.scoreA, scoreB: params.scoreB })
        : await this.api.submitSchoolMatch({ ...params, requestId: this.requestId });
      if (!result.ok) {
        this.setData({
          submitting: false,
          errors: result.errors || {},
          scoreErrors: result.scoreErrors || [],
          // 逐局比分的错误不逐条挂在输入框上，用一条总提示兜底；
          // 否则用户可能只看到「校验失败」，却不知道是哪一局的问题
          errorText: result.firstError || (result.scoreErrors || [])[0] || result.message || '提交失败',
        });
        return undefined;
      }

      this.setData({ submitting: false });
      this.showToast('已提交，等待对手确认', 'success');
      // 退回比赛页，onShow 会刷新，刚提交的那场就在待确认里
      wx.navigateBack();
      return undefined;
    } catch (err) {
      console.error('[match-entry] 提交失败', err);
      this.setData({ submitting: false, errorText: '提交失败，请稍后重试' });
      return undefined;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    return toast(title, icon);
  },

  onCancel() {
    wx.navigateBack();
  },

  /**
   * 改用横屏计分台逐球计分。
   * 只有「给签表里排定的比赛补录」才有编号可带——日常约球还没生成比赛，
   * 没有实时台可开，所以入口在非 scheduled 时根本不出现。
   */
  onGoLiveScore() {
    if (!this.matchId) return;
    wx.navigateTo({ url: `/packageTeam/live-score/live-score?matchId=${encodeURIComponent(this.matchId)}` });
  },
});
