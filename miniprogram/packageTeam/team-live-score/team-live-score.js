/** 篮球单人计分。点击先预览，按顺序逐笔保存；丢回执重发同一个操作编号。 */
const space = require('../../services/association-space.js');
const scopeService = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');
const { resolveRouteId } = require('../../utils/route-query.js');
const { currentThemeClass } = require('../../services/branding.js');
const { getDataSource } = require('../../services/runtime-mode.js');
const { applyBasketballOperation } = require('../../shared/utils/basketball-live.js');
const STAT_FIELDS = [
  { field: 'points', label: '得分' }, { field: 'rebounds', label: '篮板' },
  { field: 'assists', label: '助攻' }, { field: 'steals', label: '抢断' },
  { field: 'blocks', label: '盖帽' }, { field: 'turnovers', label: '失误' }, { field: 'fouls', label: '犯规' },
];
const isRecording = operation => ['score', 'stat'].includes(operation.type);

/**
 * 本机未同步操作的排队上限（2026-10-23 第三轮 X-15）。
 *
 * 【为什么要有上限】判球是「先入队、再逐条上报」的：断网时点多少下就排多少条，
 * 而每次 `render()` 都会把整条队列重放一遍（O(n²)），同时整队列写进本地存储。
 * 弱网拖久了会同时变慢、变大，且没有任何提示。上限取 200：正常一场球 60~120 个
 * 操作，超过这个量说明早就该联网了，继续堆只会让恢复更慢。
 */
const PENDING_MAX = 200;

Page({
  data: { loading: true, error: '', notice: '', themeClass: '', teamAName: 'A 队', teamBName: 'B 队',
    live: null, pendingCount: 0, controlsPending: false, saving: false, failed: false, submitted: false, storageError: false, allowDraw: false,
    activeSide: 'A', playerChoices: [], selectedUserId: '', selectedPlayerName: '', onlyPlayerPoints: false,
    view: 'main', totalsKind: 'players', totalsPage: 0, totalsPages: 1, periodPage: 0, periodPages: 1, shownPeriods: [],
    benchPage: 0, benchPages: 1, benchChoices: [], outId: '', inId: '', courtCount: 0,
    statButtons: [], playerTotals: [], teamDifferences: [], statFields: STAT_FIELDS, statScopeText: '', canDecreasePoints: false },

  onLoad(options = {}) {
    this.matchId = options.matchId || '';
    this.scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: scopeService.getAssociation() };
    this.pending = [];
    this.sequence = 0;
    this.destroyed = false;
    this.setData({ themeClass: currentThemeClass() });
    return this.load();
  },

  onShow() {
    if (typeof wx !== 'undefined' && wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: true });
  },
  onHide() {
    this.persist();
    if (typeof wx !== 'undefined' && wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: false });
  },
  onUnload() {
    this.persist();
    this.destroyed = true;
    if (typeof wx !== 'undefined' && wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: false });
  },
  patch(data) { if (!this.destroyed) this.setData(data); },
  api() { return space.forScope(this.scope); },

  async load() {
    this.patch({ loading: true, error: '' });
    try {
      let failure;
      const found = await resolveRouteId(this.matchId, async matchId => {
        const result = await this.api().startTeamLiveScore({ matchId });
        if (result && result.ok) return result;
        failure = result;
        return null;
      });
      if (this.destroyed) return;
      if (!found.id) {
        this.patch({ loading: false, error: (failure && failure.message) || '无法开启计分台' });
        return;
      }
      this.matchId = found.id;
      const result = found.result;
      this.confirmed = result.live;
      this.rosters = result.rosters || [];
      this.storageKey = `basketball-live:${getDataSource()}:${this.scope.schoolId}:${this.scope.association}:${result.actorId}:${this.matchId}`;
      if (!this.restored) {
        this.restored = true;
        try {
          const saved = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(this.storageKey) : null;
          if (saved && Array.isArray(saved.pending)) this.pending = saved.pending;
        } catch (err) { this.patch({ notice: '无法读取本机未同步操作' }); }
      }
      this.patch({ loading: false, teamAName: result.teamAName, teamBName: result.teamBName,
        allowDraw: result.allowDraw === true });
      this.render();
      await this.pump();
    } catch (err) {
      this.patch({ loading: false, error: '计分台加载失败，请重试' });
    }
  },

  persist() {
    if (!this.storageKey || typeof wx === 'undefined' || !wx.setStorageSync) return;
    try {
      wx.setStorageSync(this.storageKey, { pending: this.pending });
      this.patch({ storageError: false });
    } catch (err) { this.patch({ storageError: true }); }
  },

  render() {
    if (!this.confirmed) return;
    let live = { ...this.confirmed, periods: this.confirmed.periods.map(row => ({ ...row })) };
    // 撤销 / 换节只允许排空后发起；快速连点的加分则立即预览。
    this.pending.forEach(op => {
      if (isRecording(op) && !(op.expectRevision < this.confirmed.revision)) {
        try { live = applyBasketballOperation(live, op); }
        catch (err) { /* 服务端会返回具体错误，未确认操作继续保留供重试或放弃。 */ }
      }
    });
    this.patch({ live, submitted: this.confirmed.submitted,
      pendingCount: this.pending.length, controlsPending: this.pending.some(op => !isRecording(op)) });
    this.renderPlayers(live);
  },

  renderPlayers(live) {
    const side = this.data.activeSide;
    const roster = (this.rosters || []).find(item => item.side === side);
    const players = (roster && roster.players) || [];
    const courtIds = live.onCourt ? (live.onCourt[side] || []) : players.slice(0, 5).map(player => player.userId);
    const court = courtIds.map(id => players.find(player => player.userId === id)).filter(Boolean);
    const bench = players.filter(player => !courtIds.includes(player.userId));
    const selected = court.find(player => player.userId === this.data.selectedUserId);
    const rows = live.playerRows || [];
    const totalOf = (sideKey, userId, field) => {
      const values = rows.filter(row => row.side === sideKey && (!userId || row.userId === userId)
        && Number.isInteger(row[field]));
      return values.length ? values.reduce((sum, row) => sum + row[field], 0) : null;
    };
    const current = rows.find(row => row.side === side && selected && row.userId === selected.userId
      && row.period === (live.statMode === 'detailed' ? live.period : 0)) || {};
    this.patch({
      selectedUserId: selected ? selected.userId : '',
      selectedPlayerName: selected ? `${Number.isInteger(selected.no) ? selected.no + ' 号 · ' : ''}${selected.name}` : '',
      courtCount: court.length,
      playerChoices: court.map(player => ({ ...player, selected: player.userId === this.data.outId,
        label: `${Number.isInteger(player.no) ? player.no + ' 号 ' : ''}${player.name}` })),
      benchPages: Math.max(1, Math.ceil(bench.length / 5)),
      benchChoices: bench.slice(this.data.benchPage * 5, this.data.benchPage * 5 + 5).map(player => ({ ...player,
        selected: player.userId === this.data.inId,
        label: `${Number.isInteger(player.no) ? player.no + ' 号 ' : ''}${player.name}` })),
      statScopeText: live.statMode === 'detailed' ? `${live.periodLabel}统计` : '整场统计',
      canDecreasePoints: Number(current.points) > 0,
      statButtons: STAT_FIELDS.filter(item => item.field !== 'points').map(item => ({ ...item,
        valueText: Number.isInteger(current[item.field]) ? String(current[item.field]) : '—',
        canDecrease: Number(current[item.field]) > 0 })),
      totalsPages: Math.max(1, Math.ceil(players.length / 5)),
      periodPages: Math.max(1, Math.ceil(live.periods.length / 5)),
      shownPeriods: live.periods.slice(this.data.periodPage * 5, this.data.periodPage * 5 + 5),
      playerTotals: this.data.view === 'stats' ? players.slice(this.data.totalsPage * 5, this.data.totalsPage * 5 + 5).map(player => ({ ...player,
        cells: STAT_FIELDS.map(item => { const total = totalOf(side, player.userId, item.field);
          return { field: item.field, text: total === null ? '—' : String(total) }; }) })) : [],
      teamDifferences: ['A', 'B'].map(sideKey => {
        const total = totalOf(sideKey, '', 'points') || 0;
        const difference = live[`score${sideKey}`] - total;
        return { side: sideKey, name: sideKey === 'A' ? this.data.teamAName : this.data.teamBName,
          teamScore: live[`score${sideKey}`], playerScore: total,
          differenceText: difference === 0 ? '得分一致' : difference > 0
            ? `${difference} 分未归属` : `球员合计多 ${-difference} 分（允许保存）` };
      }),
    });
  },

  onSelectSide(event) {
    const side = event.currentTarget.dataset.side;
    if (!['A', 'B'].includes(side)) return;
    if (this.pending.length) return;
    this.patch({ activeSide: side, selectedUserId: '', totalsPage: 0, benchPage: 0, outId: '', inId: '' });
    this.renderPlayers(this.data.live);
  },
  onSelectPlayer(event) {
    if (this.pending.length || this.data.submitted || this.data.failed) return;
    const userId = event.currentTarget.dataset.userid;
    if (!this.data.playerChoices.some(player => player.userId === userId)) return;
    this.patch({ view: 'player', selectedUserId: userId, onlyPlayerPoints: false, notice: '' });
    this.renderPlayers(this.data.live);
  },
  onMain() {
    if (this.pending.length) return;
    this.patch({ view: 'main', selectedUserId: '', onlyPlayerPoints: false, notice: '', outId: '', inId: '' });
    this.renderPlayers(this.data.live);
  },
  onCancelPlayer() {
    if (this.data.view !== 'player') return;
    // 没有选择统计项时仅关闭面板，不生成任何计分请求。
    return this.onMain();
  },
  onOpenStats() {
    if (this.pending.length) return;
    this.patch({ view: 'stats', selectedUserId: '', totalsPage: 0, periodPage: 0 });
    this.renderPlayers(this.data.live);
  },
  onTotalsKind(event) { this.patch({ totalsKind: event.currentTarget.dataset.kind }); },
  onPage(event) {
    const key = event.currentTarget.dataset.kind;
    const keys = { totals: ['totalsPage', 'totalsPages'], bench: ['benchPage', 'benchPages'], period: ['periodPage', 'periodPages'] };
    if (!keys[key]) return;
    const [page, pages] = keys[key];
    const value = this.data[page] + Number(event.currentTarget.dataset.delta);
    if (!Number.isInteger(value) || value < 0 || value >= this.data[pages]) return;
    this.patch({ [page]: value });
    this.renderPlayers(this.data.live);
  },
  onOpenSubstitute() {
    if (this.pending.length || this.data.failed || this.data.submitted) return;
    this.patch({ view: 'substitute', selectedUserId: '', outId: '', inId: '', benchPage: 0 });
    this.renderPlayers(this.data.live);
  },
  onChooseOut(event) {
    if (this.pending.length) return;
    const outId = event.currentTarget.dataset.userid;
    if (!this.data.playerChoices.some(player => player.userId === outId)) return;
    this.patch({ outId }); this.renderPlayers(this.data.live);
  },
  onChooseIn(event) {
    if (this.pending.length) return;
    const inId = event.currentTarget.dataset.userid;
    if (!this.data.benchChoices.some(player => player.userId === inId)) return;
    this.patch({ inId }); this.renderPlayers(this.data.live);
  },
  onSubstitute() {
    if (this.data.view !== 'substitute' || this.pending.length || !this.data.outId || !this.data.inId) return;
    return this.enqueue({ type: 'substitute', side: this.data.activeSide, outId: this.data.outId, inId: this.data.inId });
  },
  onTogglePlayerOnly(event) { this.patch({ onlyPlayerPoints: event.detail.value === true }); },
  onPlayerScore(event) {
    if (!this.data.selectedUserId) { this.patch({ notice: '请先选择球员' }); return; }
    if (this.pending.length || this.data.view !== 'player') return;
    return this.enqueue({ type: 'score', side: this.data.activeSide, userId: this.data.selectedUserId,
      points: Number(event.currentTarget.dataset.points), playerOnly: this.data.onlyPlayerPoints });
  },
  onStat(event) {
    if (!this.data.selectedUserId) { this.patch({ notice: '请先选择球员' }); return; }
    if (this.pending.length || this.data.view !== 'player') return;
    return this.enqueue({ type: 'stat', side: this.data.activeSide, userId: this.data.selectedUserId,
      field: event.currentTarget.dataset.field, delta: Number(event.currentTarget.dataset.delta) });
  },

  enqueue(operation) {
    if (!this.confirmed || this.confirmed.submitted || this.data.failed) return;
    if (this.pending.some(op => !isRecording(op))) return;
    if (!isRecording(operation) && this.pending.length) return;
    // 队列上限：不设的话断网时长直接决定队列长度与本地存储体积（见 PENDING_MAX）
    if (this.pending.length >= PENDING_MAX) {
      this.patch({ notice: `本机还有 ${this.pending.length} 条操作未同步，请先联网后再继续计分` });
      return;
    }
    if (isRecording(operation)) {
      try { applyBasketballOperation(this.data.live, operation); }
      catch (err) { this.patch({ notice: err.message }); return; }
    }
    const operationId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}_${++this.sequence}`;
    if (['player', 'substitute'].includes(this.data.view)) this.returnOperationId = operationId;
    this.pending.push({ ...operation, operationId });
    this.persist();
    this.render();
    return this.pump();
  },

  async pump() {
    if (this.processing || this.destroyed || this.data.failed) return;
    this.processing = true;
    this.patch({ saving: this.pending.length > 0 });
    try {
      while (this.pending.length && !this.destroyed) {
        const op = this.pending[0];
        // 发送前持久化这次请求的版本。回执丢失后仍以相同编号、相同版本重试。
        if (!Number.isInteger(op.expectRevision)) op.expectRevision = this.confirmed.revision;
        this.persist();
        let result;
        try { result = await this.api().updateTeamLiveScore({ matchId: this.matchId, ...op }); }
        catch (err) { result = { ok: false, message: '网络未连通，操作尚未确认，请重试保存' }; }
        if (this.destroyed) return;
        if (!result || !result.ok) {
          this.patch({ failed: true, notice: (result && result.message) || '保存失败，请重试' });
          return;
        }
        this.confirmed = result.live;
        this.pending.shift();
        this.persist();
        this.patch({ notice: '', ...(this.returnOperationId === op.operationId
          ? { view: 'main', selectedUserId: '', outId: '', inId: '' } : {}) });
        if (this.returnOperationId === op.operationId) this.returnOperationId = '';
        this.render();
      }
    } finally {
      this.processing = false;
      this.patch({ saving: false });
    }
  },

  onScore(event) {
    if (this.data.view !== 'main') return;
    const { side, points } = event.currentTarget.dataset;
    const value = Number(points);
    if (!['A', 'B'].includes(side) || ![1, 2, 3].includes(value)) return;
    if (this.data.live && this.data.live[`score${side}`] + value > 299) {
      this.patch({ notice: '单队总分不能超过 299' });
      return;
    }
    return this.enqueue({ type: 'score', side, points: value });
  },
  onUndo() {
    if (this.pending.length || !this.data.live || !this.data.live.canUndo) return;
    return this.enqueue({ type: 'undo' });
  },
  onNextPeriod() {
    if (this.pending.length) return;
    return this.confirmAction('结束本节', '确认结束本节并进入下一节？平分结束常规时间后进入加时。',
      () => this.enqueue({ type: 'nextPeriod' }));
  },
  onFinish() {
    if (this.pending.length) return;
    const live = this.data.live;
    if (!live || live.period < live.regulationPeriods) return;
    if (live.scoreA === 0 && live.scoreB === 0) {
      this.patch({ notice: '0:0 不能提交为完赛比分' });
      return;
    }
    if (live.scoreA === live.scoreB && !this.data.allowDraw) {
      this.patch({ notice: '比分相同，请进入加时继续计分' });
      return;
    }
    return this.confirmAction('结束比赛', '当前比分将提交为待审核，发布后才计入正式成绩。',
      () => this.enqueue({ type: 'finish' }));
  },
  confirmAction(title, content, action) {
    if (typeof wx === 'undefined' || !wx.showModal) return action();
    wx.showModal({ title, content, success: result => { if (result.confirm && !this.destroyed) action(); } });
  },
  onRetry() { this.patch({ failed: false, notice: '' }); return this.pump(); },
  onReload() {
    if (this.processing) return;
    const reload = () => {
      this.pending = [];
      this.returnOperationId = '';
      this.persist();
      this.patch({ failed: false, notice: '', view: 'main', selectedUserId: '', outId: '', inId: '' });
      return this.load();
    };
    return this.pending.length
      ? this.confirmAction('重新载入', '将以已保存比分为准，放弃本机尚未同步的操作。确定继续吗？', reload)
      : reload();
  },
  onExit() {
    const leave = () => wx.navigateBack();
    if (this.pending.length) {
      this.persist();
      return this.confirmAction('仍有未同步操作', this.data.storageError
        ? '未同步操作无法保存在本机，建议先重试保存。仍要退出吗？'
        : '未同步操作已留在本机，再次进入可继续保存。确定退出吗？', leave);
    }
    return leave();
  },
});
