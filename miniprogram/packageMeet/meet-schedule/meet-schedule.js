/**
 * 赛程编排（管理员）
 * ============================================================
 * 这一页承担「报名截止后到比赛开始前」的全部编排工作，顺序就是页面上从上到下：
 *
 *   0. 派裁判（页面顶部）：先选项目与场次（可跨项目多选），再选裁判（可多人）。
 *      赛前最耗时的一步，且「整个上午的径赛都是同一批裁判」是常态，所以放在最上面。
 *   1. 定赛制：轮次（直接决赛 / 预赛+决赛）、每组人数（跑道数）、
 *      晋级人数或小组设置。**必须在报名截止后做**——分几组、分几枪是由实际
 *      报名人数除出来的，项目刚建好时人数还不知道。
 *   2. 分组/编排：径赛按跑道数自动均分（多枪决赛就是分几枪），
 *      胜负项目生成签表/循环赛。
 *   3. 排时间场地：时间是必填的告知信息，不做任何先后校验。
 *   4. 发布赛程。
 *
 * 【派裁判为什么是「先场次、后裁判」，且已派的人会自动带出】
 * 裁判是「派到场次上」的，先定范围才知道要显示谁；所选场次已有的裁判必须计入
 * 人数，否则面板永远显示「选裁判（0）人」，管理员会以为没派、再派一遍。候选列表
 * 里则把已选的人去掉——否则点一下只换来一句「已经选了」。
 *
 * 【为什么裁判不用 picker】
 * picker 的 range 是打开那一刻的快照：先搜索、再点开会拿到旧列表，
 * 必须关掉重开一次才对。改成「搜索框 + 直接列出候选人」，点谁就是谁。
 *
 * 【为什么开赛按钮要看名单长度】
 * 早期用计数 judgeCount，增删几次就会与真实指派表对不上。现在场次上维护
 * judgeIds 名单，页面按名单长度判断，服务端也用同一份名单。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');
const { showError, showNotice, updateMeetPage } = require('../../utils/meet-ui.js');

const ROUND_LABEL = { final: '决赛', heat: '预赛', rr: '循环赛' };
const ADVANCE_LABEL = { per_heat: '每组前 N', overall: '总成绩前 N', hybrid: '混合晋级' };
const FORMAT_LABEL = { single_elim: '单败淘汰', round_robin: '循环赛', group_knockout: '小组+淘汰' };

/** 在刷新后的列表里找回当前场次：重载后 current 必须换成本次数据的新对象 */
function sessionOf(items, eventKey, sessionKey) {
  const item = (items || []).find((row) => row.eventKey === eventKey);
  if (!item) return null;
  return (item.sessions || []).find((row) => row.sessionKey === sessionKey) || null;
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    canManage: false,
    items: [],
    judges: [],
    /** 本届总裁判（null = 未任命）：显示与撤销用 */
    chiefJudge: null,
    /** 总裁判候选面板：wx.showActionSheet 最多 6 项，成员一多就选不到人 */
    chiefOpen: false,
    chiefKeyword: '',
    chiefCandidates: [],
    // ---- 派裁判（顶部一块，跨项目 / 跨场次 / 多人）----
    // 旧版把批量指派挂在每个项目行里：一次只能派一个项目，而「所有径赛同一批裁判」
    // 才是常态；已派了几个人也不显示（选裁判永远是 0 人）。现在统一到顶部：
    // 先选项目与场次（可多选），再选裁判；所选场次已有的裁判自动带出并计入人数。
    assignOpen: false,
    assignKeyword: '',
    /** 可派场次的项目（只列已有场次的：没抽签 / 没排期的派不了） */
    assignTargets: [],
    /** 已选场次（sessionKey 数组） */
    assignSessionKeys: [],
    assignSessionCount: 0,
    assignEventCount: 0,
    assignEventState: {},
    /** 本次手动添加的裁判（不含带出的已有裁判） */
    assignPickedIds: [],
    /** 已选裁判 = 带出的已有裁判 + 手动添加 */
    assignJudgeIds: [],
    assignJudgeCount: 0,
    assignAssignedCount: 0,
    assignJudgeNames: {},
    assignCoverage: {},
    /** 候选池（当前搜索词的结果；候选列表会排除已选） */
    assignPool: [],
    assignCandidates: [],
    assignHasMore: false,
    assignSummaryText: '一次可派多个项目、多个场次',
    // 展开的行与它正在编辑的场次
    activeEventKey: '',
    editStartAt: '',
    editVenue: '',
    editRound: 'final',
    editIndex: 1,
    editSessionKey: '',
    // 时间用两个 picker 拼（日期 + 时分）：手输格式太容易错
    editDate: '',
    editTime: '',
    // 当前正在编辑的场次（含裁判名单）
    current: null,
    // 赛制编辑面板
    procedureEventKey: '',
    proc: {
      isVersus: false,
      rounds: 'final',
      laneCount: 6,
      advanceCount: 3,
      format: 'single_elim',
      groupCount: 2,
      advancePerGroup: 2,
    },
    advanceLabel: ADVANCE_LABEL,
    formatLabel: FORMAT_LABEL,
    advanceModes: [
      { value: 'per_heat', label: '每组前 N' },
      { value: 'overall', label: '总成绩前 N' },
      { value: 'hybrid', label: '混合晋级' },
    ],
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload();
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    this.unloaded = true;
    this.chiefSeq = (this.chiefSeq || 0) + 1;
    clearTimeout(this.candidateTimer);
    clearTimeout(this.chiefTimer);
    this.candidateTimer = null;
    this.chiefTimer = null;
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  /**
   * 赛制与分批摘要。
   *
   * 分批口径分三种，不能合并写：lane 按道数、capacity 按人数上限、
   * single 不分批。若一律写成「每组 N 人」，跳远会显示成「每组 0 人」，
   * 而 1500 米会显示成「每组 6 人」——这正是审查里的 C1/C2。
   */
  procedureLabelOf(item) {
    if (item.scoreType === 'versus') {
      const format = FORMAT_LABEL[item.format] || '单败淘汰';
      const groups = item.groups
        ? `（${item.groups.count} 组，每组出线 ${item.groups.advancePerGroup}）` : '';
      return `${format}${groups}`;
    }
    if (item.heatMode === 'single') return '单场 · 按顺序进行';
    const rounds = item.rounds === 'heat_final' ? '预赛+决赛' : '直接决赛';
    const capacity = item.heatCapacity || item.laneCount;
    if (!capacity) return rounds;
    const unit = item.heatMode === 'lane'
      ? `每组 ${capacity} 人（按道次）`
      : `每组最多 ${capacity} 人`;
    const advance = item.advance
      ? ` · ${ADVANCE_LABEL[item.advance.mode] || ''} ${item.advance.count}` : '';
    return `${rounds} · ${unit}${advance}`;
  },

  /**
   * 重新拉赛程。
   *
   * `keep` 用来指定「重载后仍停留在哪个场次」：指派/撤销裁判之后必须留在原地，
   * 否则用户每点一次就被弹回列表，看不到刚才的结果。
   */
  async reload(keep = {}) {
    this.update({ loading: true, error: '' });
    try {
      const schedule = await this.client().getMeetSchedule({});
      let pool = this.data.assignPool || [];
      let judges = this.data.judges || [];
      if (schedule.canManage) {
        const candidates = await this.client().listMeetJudgeCandidates({ keyword: this.data.assignKeyword });
        pool = candidates.items;
        judges = candidates.items;
        this.update({ assignHasMore: Boolean(candidates.hasMore) });
      }
      const items = schedule.items.map((item) => ({
        ...item,
        readyLabel: item.ready ? '已配齐' : '未配齐',
        procedureLabel: this.procedureLabelOf(item),
        // canDraw 由服务端给（它读的是兜底后的 heatMode，老数据也正确）
        sessions: (item.sessions || []).map((row) => ({
          ...row,
          roundLabel: row.roundLabel || ROUND_LABEL[row.round] || row.round,
          // 预赛要带上组号，否则四个 chip 全写「预赛」分不清；多枪的标签
          // 已经自带「第 N 枪」，不再重复
          displayLabel: row.round === 'heat'
            ? `预赛 第 ${row.index} 组`
            : (row.roundLabel || ROUND_LABEL[row.round] || row.round),
        })),
      }));

      const eventKey = keep.eventKey !== undefined ? keep.eventKey : this.data.activeEventKey;
      const sessionKey = keep.sessionKey !== undefined ? keep.sessionKey : this.data.editSessionKey;
      // 关键：用**刷新后的**场次对象替换 current，否则界面还显示指派前的 0 个裁判
      const current = sessionOf(items, eventKey, sessionKey);

      // 派裁判面板：项目清单换了之后，把已经不存在的场次从选择里剔掉再重算
      const assignTargets = this.assignTargetsOf(items);
      const aliveSessions = new Set();
      for (const row of assignTargets) for (const slot of row.sessions) aliveSessions.add(slot.sessionKey);
      const keptSessions = this.data.assignSessionKeys.filter((key) => aliveSessions.has(key));
      const assignState = this.assignStateOf(
        keptSessions, assignTargets, pool, this.data.assignPickedIds);

      this.update({
        loading: false,
        canManage: schedule.canManage,
        chiefJudge: schedule.chiefJudge || null,
        items,
        judges,
        assignPool: pool,
        ...assignState,
        activeEventKey: current ? eventKey : '',
        editSessionKey: current ? sessionKey : '',
        current,
        editStartAt: current ? current.startAt : '',
        editVenue: current ? current.venue : '',
        editRound: current ? current.round : 'final',
        editIndex: current ? current.index : 1,
        editDate: current ? this.dateOf(current.startAt) : '',
        editTime: current ? this.timeOf(current.startAt) : '',
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  dateOf(value) {
    const matched = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value || ''));
    return matched ? matched[1] : '';
  },

  timeOf(value) {
    const matched = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value || ''));
    return matched ? matched[2] : '';
  },

  /**
   * 可派裁判的项目：**只列已经有场次的**。
   *
   * 没抽签、没排期的项目在这里出现只会让人点了才被拒（服务端也拒绝空场次）。
   * 报名人数一并带上——分几组、要不要多派裁判都看这个数。
   */
  assignTargetsOf(items) {
    const groupLabelOf = (group) => (group === 'male' ? '男子' : group === 'female' ? '女子' : '混合');
    return (items || [])
      .filter((item) => (item.sessions || []).length > 0)
      .map((item) => ({
        eventKey: item.eventKey,
        name: item.name,
        groupLabel: groupLabelOf(item.group),
        entryText: `${item.entryCount || 0} ${item.entryUnit || '人'}`,
        pendingText: item.pendingCount ? `${item.pendingCount} 待审` : '',
        sessionCount: item.sessions.length,
        // 首个已排时间：让管理员一眼看出「这场到底排没排」
        timeText: (item.sessions.find((row) => row.startAt) || {}).startAt || '未排期',
        sessions: item.sessions.map((row) => ({
          sessionKey: row.sessionKey,
          label: row.displayLabel,
          timeText: row.startAt || '',
          assignedCount: (row.judges || []).length,
          judges: row.judges || [],
        })),
      }));
  },

  /**
   * 派裁判面板的派生状态（纯计算）。
   *
   * 【为什么「选裁判」要先把已有的人算进来】
   * 从前这个数字从 0 起算：下面明明已经派了 3 个人，面板仍显示「选裁判（0）人」，
   * 再选一个变成 1，提交完才知道这 3 个人早就在场上了。现在所选场次已有的裁判
   * **全部带出**并计入人数：3 人 → 再点一个就是 4 人。
   *
   * 【候选里为什么不再出现已选的人】
   * 已选的人列在上面的 chips 里，候选池仍然列出来只会让人重复点、再收到一句
   * 「已经选了」。候选 = 候选池 − 已选，点一下就是「新加一个人」。
   *
   * @param {string[]} sessionKeys 已选场次
   * @param {Array} targets assignTargetsOf 的结果
   * @param {Array} pool 当前搜索结果
   * @param {string[]} picked 手动添加的裁判（不含带出的）
   */
  assignStateOf(sessionKeys, targets, pool, picked) {
    const sessions = new Map();
    for (const row of targets || []) {
      for (const slot of row.sessions) sessions.set(slot.sessionKey, slot);
    }
    const keys = (sessionKeys || []).filter((key) => sessions.has(key));

    // 每个项目的勾选三态：全选 / 部分 / 未选
    const eventState = {};
    for (const row of targets || []) {
      const hit = row.sessions.filter((slot) => keys.includes(slot.sessionKey)).length;
      eventState[row.eventKey] = {
        all: hit > 0 && hit === row.sessions.length,
        some: hit > 0 && hit < row.sessions.length,
        count: hit,
      };
    }

    // 带出的已有裁判：所选场次上「在任」的裁判取并集
    const coverage = {};
    const names = {};
    for (const key of keys) {
      for (const judge of (sessions.get(key).judges || [])) {
        coverage[judge.judgeId] = (coverage[judge.judgeId] || 0) + 1;
        if (!names[judge.judgeId]) names[judge.judgeId] = judge.name || judge.judgeId;
      }
    }
    // 姓名以成员表为准（比场次里带的更新）
    for (const row of (pool || [])) names[row.userId] = row.name;

    const judgeIds = [...new Set([...Object.keys(coverage), ...(picked || [])])];
    const chosen = new Set(judgeIds);
    const candidates = (pool || [])
      .filter((row) => !chosen.has(row.userId))
      .map((row) => ({
        ...row,
        coveredText: coverage[row.userId] ? `已派 ${coverage[row.userId]}/${keys.length} 场` : '',
      }));

    const eventCount = Object.values(eventState).filter((row) => row.count > 0).length;
    return {
      assignTargets: targets || [],
      assignSessionKeys: keys,
      assignSessionCount: keys.length,
      assignEventCount: eventCount,
      assignEventState: eventState,
      assignJudgeIds: judgeIds,
      assignJudgeCount: judgeIds.length,
      assignAssignedCount: Object.keys(coverage).length,
      assignJudgeNames: names,
      assignCoverage: coverage,
      assignCandidates: candidates,
      assignSummaryText: keys.length
        ? `${eventCount} 个项目 · ${keys.length} 个场次 · ${judgeIds.length} 名裁判`
        : '一次可派多个项目、多个场次',
    };
  },

  // ---------- 赛制设置（报名截止后） ----------

  async onOpenProcedure(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.procedureEventKey === eventKey) {
      this.update({ procedureEventKey: '' });
      return;
    }
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    if (!item) return;
    this.update({
      procedureEventKey: eventKey,
      error: '',
      notice: '',
      proc: {
        isVersus: item.scoreType === 'versus',
        heatMode: item.heatMode || 'capacity',
        rounds: item.rounds || 'final',
        heatCapacity: item.heatCapacity || item.laneCount || 8,
        advanceCount: (item.advance && item.advance.count) || 3,
        advanceModeIndex: Math.max(0, this.data.advanceModes.findIndex(row => row.value === (item.advance && item.advance.mode))),
        format: item.format || 'single_elim',
        groupCount: (item.groups && item.groups.count) || 2,
        advancePerGroup: (item.groups && item.groups.advancePerGroup) || 2,
      },
    });
  },

  onProcPickRounds(event) {
    const rounds = String(event.currentTarget.dataset.rounds || 'final');
    this.update({ proc: { ...this.data.proc, rounds } });
  },

  onProcPickFormat(event) {
    const format = String(event.currentTarget.dataset.format || 'single_elim');
    this.update({ proc: { ...this.data.proc, format } });
  },

  onProcInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = Number(event.detail.value);
    if (!field || !Number.isFinite(value)) return;
    // 分道项目上限是跑道数（2–20）；不分道项目是每批人数，可以更大（2–50）
    const capacityRange = this.data.proc.heatMode === 'lane' ? [2, 20] : [2, 50];
    const limits = {
      heatCapacity: capacityRange,
      advanceCount: [1, 50], groupCount: [2, 8], advancePerGroup: [1, 4],
    };
    const range = limits[field];
    if (!range) return;
    const next = Math.max(range[0], Math.min(range[1], Math.trunc(value)));
    this.update({ proc: { ...this.data.proc, [field]: next } });
  },

  /* ---------- 派裁判（顶部一块） ---------- */

  /** 展开 / 收起派裁判面板；打开时按当前搜索词重取候选 */
  onToggleAssignPanel() {
    if (this.data.busy) return undefined;
    if (this.data.assignOpen) {
      this.update({ assignOpen: false });
      return undefined;
    }
    this.update({ assignOpen: true, error: '', notice: '' });
    return this.loadAssignCandidates(this.data.assignKeyword, false);
  },

  /** 从某个项目直接进面板：把这个项目的全部场次预设为已选 */
  onAssignForEvent(event) {
    if (this.data.busy) return undefined;
    const eventKey = (event.currentTarget.dataset.eventKey || '').trim();
    const row = this.data.assignTargets.find((item) => item.eventKey === eventKey);
    if (!row) {
      this.update({ error: '该项目还没有场次，先抽签分组并排好时间场地' });
      return undefined;
    }
    const keys = row.sessions.map((slot) => slot.sessionKey);
    const state = this.assignStateOf(keys, this.data.assignTargets, this.data.assignPool, []);
    this.update({ assignOpen: true, assignPickedIds: [], error: '', notice: '', ...state });
    if ((this.data.assignPool || []).length === 0) {
      return this.loadAssignCandidates(this.data.assignKeyword, false);
    }
    return undefined;
  },

  applyAssignSessions(keys) {
    const state = this.assignStateOf(
      keys, this.data.assignTargets, this.data.assignPool, this.data.assignPickedIds);
    this.update({ ...state, error: '', notice: '' });
  },

  /** 点项目行：全选 / 全不选该项目的场次（含预赛各组与决赛） */
  onToggleAssignEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    const row = this.data.assignTargets.find((item) => item.eventKey === eventKey);
    if (!row) return;
    const chosen = new Set(this.data.assignSessionKeys);
    const all = row.sessions.every((slot) => chosen.has(slot.sessionKey));
    for (const slot of row.sessions) {
      if (all) chosen.delete(slot.sessionKey);
      else chosen.add(slot.sessionKey);
    }
    this.applyAssignSessions([...chosen]);
  },

  /** 点场次 chip：只选这一场（预赛第 2 组、决赛等） */
  onToggleAssignSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    const chosen = new Set(this.data.assignSessionKeys);
    if (chosen.has(sessionKey)) chosen.delete(sessionKey);
    else chosen.add(sessionKey);
    this.applyAssignSessions([...chosen]);
  },

  onAssignAll() {
    const keys = [];
    for (const row of this.data.assignTargets) {
      for (const slot of row.sessions) keys.push(slot.sessionKey);
    }
    this.applyAssignSessions(keys);
    return undefined;
  },

  onAssignClear() {
    const state = this.assignStateOf([], this.data.assignTargets, this.data.assignPool, []);
    this.update({ ...state, assignPickedIds: [], error: '', notice: '' });
  },

  onAssignKeyword(event) {
    const assignKeyword = event.detail.value;
    this.update({ assignKeyword });
    clearTimeout(this.candidateTimer);
    this.candidateTimer = setTimeout(() => this.loadAssignCandidates(assignKeyword, false), 400);
  },

  onMoreAssignJudges() {
    return this.loadAssignCandidates(this.data.assignKeyword, true);
  },

  /**
   * 拉裁判候选并重算面板。
   *
   * append=true 接着上一页取，否则按新关键词从头取。用 requestId 判活：
   * 连着改两次关键词时，慢的那个响应不能盖掉后来的。
   */
  async loadAssignCandidates(keyword, append) {
    const previous = append ? this.data.assignPool : [];
    const requestId = (this.assignRequestId || 0) + 1;
    this.assignRequestId = requestId;
    try {
      const result = await this.client().listMeetJudgeCandidates({ keyword, offset: previous.length });
      if (this.unloaded || this.assignRequestId !== requestId
        || keyword !== this.data.assignKeyword) return undefined;
      const pool = previous.concat(result.items);
      const merged = new Map((this.data.judges || []).map((row) => [row.userId, row]));
      for (const row of result.items) merged.set(row.userId, row);
      const state = this.assignStateOf(
        this.data.assignSessionKeys, this.data.assignTargets, pool, this.data.assignPickedIds);
      this.update({
        ...state,
        assignPool: pool,
        judges: [...merged.values()],
        assignHasMore: Boolean(result.hasMore),
      });
    } catch (err) {
      this.update({ error: (err && err.message) || '搜索裁判失败' });
    }
    return undefined;
  },

  /** 点候选人 = 新加一个人。已选的不会出现在候选里，所以不会重复 */
  onToggleAssignJudge(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;
    if (this.data.assignCoverage[userId]) {
      // 已在所选场次里：保持不动，提示也不会再出现（候选已排除），这里只兜旧缓存
      return;
    }
    const picked = [...this.data.assignPickedIds, userId];
    const state = this.assignStateOf(
      this.data.assignSessionKeys, this.data.assignTargets, this.data.assignPool, picked);
    this.update({ ...state, assignPickedIds: picked });
  },

  /** chips 上的 ×：只撤掉本次「新加的人」；已有指派要在场次里点撤销 */
  onRemoveAssignJudge(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId || this.data.assignCoverage[userId]) return;
    const picked = this.data.assignPickedIds.filter((id) => id !== userId);
    const state = this.assignStateOf(
      this.data.assignSessionKeys, this.data.assignTargets, this.data.assignPool, picked);
    this.update({ ...state, assignPickedIds: picked });
  },

  async onSubmitAssign() {
    if (this.data.busy) return;
    const { assignSessionKeys, assignJudgeIds } = this.data;
    if (assignSessionKeys.length === 0) {
      this.update({ error: '请先选择要派裁判的项目或场次' });
      return;
    }
    if (assignJudgeIds.length === 0) {
      this.update({ error: '请选择裁判' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().assignMeetJudges({
        judgeIds: assignJudgeIds,
        sessionKeys: assignSessionKeys,
      });
      // 先清选择再重载：面板收起，场次里的裁判数与「已派」标记随之更新
      this.update({ assignSessionKeys: [], assignPickedIds: [] });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, assignOpen: false });
      const existed = result.existed ? `（${result.existed} 条原本已派）` : '';
      showNotice(`已派 ${result.judgeIds.length} 人到 ${result.sessionCount} 个场次${existed}`);
    } catch (err) {
      this.update({ busy: false });
      showError((err && err.message) || '指派失败');
    }
  },

  async onSaveProcedure() {
    if (this.data.busy) return;
    const eventKey = this.data.procedureEventKey;
    if (!eventKey) return;
    const { proc } = this.data;
    const payload = {
      eventKey,
      rounds: proc.rounds,
    };
    // 单场项目没有「每批人数」这个概念，传了也会被服务端按模板覆盖
    if (!proc.isVersus && proc.heatMode !== 'single') {
      payload.heatCapacity = proc.heatCapacity;
    }
    if (proc.isVersus) {
      payload.format = proc.format;
      if (proc.format === 'group_knockout') {
        payload.groups = { count: proc.groupCount, advancePerGroup: proc.advancePerGroup };
      }
    } else if (proc.rounds === 'heat_final') {
      payload.advance = { mode: this.data.advanceModes[proc.advanceModeIndex || 0].value, count: proc.advanceCount };
    }

    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().setMeetEventProcedure(payload);
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, procedureEventKey: '', notice: '赛制已保存' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '保存失败' });
    }
  },

  /** 抽签分组 / 分枪 / 编排签表 */
  async onDraw(event) {
    if (this.data.busy) return;
    const eventKey = event.currentTarget.dataset.eventKey;
    const versus = event.currentTarget.dataset.versus === 1 || event.currentTarget.dataset.versus === '1'
      || event.currentTarget.dataset.versus === true;
    if (!eventKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      if (versus) {
        const result = await this.client().drawMeetBracket({ eventKey });
        this.update({
          busy: false,
          notice: result.format === 'round_robin'
            ? `已生成 ${result.matches.length} 场循环赛`
            : `已生成 ${result.matches.length} 场对阵（共 ${result.totalRounds} 轮）`,
        });
      } else {
        const result = await this.client().drawMeetHeats({ eventKey });
        const sizes = result.heats.map((row) => row.entryKeys.length).join(' / ');
        this.update({
          busy: false,
          notice: result.rounds === 'heat_final'
            ? `已分 ${result.heats.length} 组预赛（人数 ${sizes}）`
            : `已分 ${result.heats.length} 枪（人数 ${sizes}）`,
        });
      }
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '编排失败' });
    }
  },

  // ---------- 场次排期与裁判 ----------

  onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', current: null, editSessionKey: '' });
      return;
    }
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    const first = item && item.sessions[0];
    this.pickSession(eventKey, first);
  },

  onPickSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    const item = this.data.items.find((row) => row.eventKey === this.data.activeEventKey);
    const target = item && item.sessions.find((row) => row.sessionKey === sessionKey);
    if (target) this.pickSession(this.data.activeEventKey, target);
  },

  pickSession(eventKey, s) {
    this.update({
      activeEventKey: eventKey || '',
      editSessionKey: (s && s.sessionKey) || '',
      editStartAt: (s && s.startAt) || '',
      editDate: s ? this.dateOf(s.startAt) : '',
      editTime: s ? this.timeOf(s.startAt) : '',
      editVenue: (s && s.venue) || '',
      editRound: (s && s.round) || 'final',
      editIndex: (s && s.index) || 1,
      current: s || null,
    });
  },

  onStartInput(event) {
    this.update({ editStartAt: event.detail.value });
  },

  onVenueInput(event) {
    this.update({ editVenue: event.detail.value });
  },

  onStartDateChange(event) {
    this.update({ editDate: event.detail.value });
    return this.composeStart();
  },

  onStartTimeChange(event) {
    this.update({ editTime: event.detail.value });
    return this.composeStart();
  },

  composeStart() {
    const { editDate, editTime } = this.data;
    if (!editDate || !editTime) return;
    this.update({ editStartAt: `${editDate} ${editTime}` });
  },

  async onSaveSession() {
    if (this.data.busy) return;
    const { activeEventKey, editStartAt, editVenue, editRound, editIndex } = this.data;
    if (!editStartAt) {
      this.update({ error: '请填写开始时间（可以选日期时间，也可以直接写）' });
      return;
    }
    if (!editVenue) {
      this.update({ error: '请填写场地' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().saveMeetSession({
        eventKey: activeEventKey,
        round: editRound,
        index: editIndex,
        startAt: editStartAt,
        venue: editVenue,
      });
      this.update({ busy: false, notice: '场次已保存' });
      return this.reload({ eventKey: activeEventKey, sessionKey: this.data.editSessionKey });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '保存失败' });
      return undefined;
    }
  },

  async onRemoveJudge(event) {
    if (this.data.busy) return;
    const { sessionKey, judgeId } = event.currentTarget.dataset;
    if (!sessionKey || !judgeId) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().removeMeetJudge({ sessionKey, judgeId });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey });
      this.update({ busy: false, notice: '已撤销指派' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
    }
  },

  async onStartSession(event) {
    if (this.data.busy) return;
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().startMeetEvent({ sessionKey });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey });
      this.update({ busy: false, notice: '已开赛' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '开赛失败' });
    }
  },

  async onPublishSchedule() {
    if (this.data.busy) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().publishMeetSchedule({});
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '赛程已发布' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
    }
  },

  onOpenScore() {
    return wx.navigateTo({ url: `/packageMeet/meet-score/meet-score?meetId=${this.data.meetId}` });
  },

  /* ---------- M3：重排与总裁判 ---------- */

  /**
   * 重抽本项目：清空分组 / 签表，让管理员改完赛制再抽一次。
   *
   * 为什么要有：组数、每组人数是现场才知道的准数（报名 37 人、按 32 人抽错很常见），
   * 原先抽错之后无路可走。服务端会拒绝「已发布成绩」或「已录分」的项目，页面先确认
   * 一次再发，避免误触把整组安排清掉。
   */
  async onResetDraw(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    if (!eventKey || !item) return undefined;

    const confirmed = typeof wx !== 'undefined' && wx.showModal
      ? await new Promise((resolve) => wx.showModal({
        title: '重新抽签',
        content: `将清空「${item.name}」的全部分组与排期，之后可改赛制再抽一次。已发布的成绩或已录的分数会让该操作被拒绝。`,
        confirmText: '重抽',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      }))
      : true;
    if (!confirmed) return undefined;

    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().resetMeetDraw({ eventKey });
      await this.reload({ eventKey: '', sessionKey: '' });
      this.update({ busy: false, notice: `已清空 ${result.clearedSessions} 个场次，可重新抽签` });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '重抽失败' });
    }
    return undefined;
  },

  /**
   * 打开总裁判候选面板。
   *
   * 不用 wx.showActionSheet：它最多 6 项，本校成员一多就选不到人（点「任命」
   * 直接没有反应）。改成可搜索的列表，与「指派裁判」同一套交互。
   */
  onOpenChief() {
    if (this.data.busy) return undefined;
    if (this.data.chiefOpen) {
      this.update({ chiefOpen: false });
      return undefined;
    }
    this.update({
      chiefOpen: true,
      chiefKeyword: '',
      chiefCandidates: (this.data.judges || []).slice(0, 20),
    });
    return undefined;
  },

  onChiefKeyword(event) {
    const chiefKeyword = event.detail.value;
    this.update({ chiefKeyword });
    if (this.chiefTimer) clearTimeout(this.chiefTimer);
    this.chiefTimer = setTimeout(async () => {
      this.chiefTimer = null;
      const seq = this.chiefSeq = (this.chiefSeq || 0) + 1;
      try {
        const result = await this.client().listMeetJudgeCandidates({ keyword: chiefKeyword });
        if (this.unloaded || seq !== this.chiefSeq) return;
        this.update({ chiefCandidates: (result.items || []).slice(0, 20) });
      } catch (err) {
        if (this.unloaded || seq !== this.chiefSeq) return;
        this.update({ chiefCandidates: [] });
      }
    }, 250);
  },

  onPickChief(event) {
    const userId = event.currentTarget.dataset.userId;
    if (userId) this.submitChiefJudge(userId);
  },

  async submitChiefJudge(userId) {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().appointMeetChiefJudge({ userId });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '已任命总裁判' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '任命失败' });
    }
  },

  async onRevokeChiefJudge() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().revokeMeetChiefJudge({});
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '已撤销总裁判' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
    }
    return undefined;
  },

  onProcAdvanceMode(event) {
    this.update({ proc: { ...this.data.proc, advanceModeIndex: Number(event.detail.value) } });
  },
});
