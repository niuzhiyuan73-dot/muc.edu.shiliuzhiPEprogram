const { withDetailExperience } = require('../../templates/detail-experience');
/**
 * 团队赛事：详情（报名 → 锁定 → 抽签 → 录分 → 发布 → 结算）
 * ============================================================
 * 一页承载一届赛事的全部操作，按状态显示该做的事：
 *
 *   报名中   → 审核报名、锁定名单
 *   已锁定   → 抽签
 *   赛程已发布/进行中 → 录分、发布、排下一轮
 *   全部打完 → 结算名次
 *
 * 【为什么不拆成多个页面】
 * 这几步是串联的，拆开后每一步都要重新取数、重新判断「上一步做完没有」，
 * 而用户往往是一路点下来。一页做完，状态只有一个来源。
 *
 * 【页面不判权】
 * 「能不能录这一场」由服务端在每场比赛上下发 `canRecord` / `canPublish`。
 * 页面只知道「显示哪些按钮」，真正拦人的是接口。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const { resolveRouteId } = require('../../utils/route-query.js');
const { watchLiveScores } = require('../../services/live-watch.js');
const statsDraft = require('../../services/stats-draft.js');

/** 统计指标：顺序即页面上的列顺序，label 给人看，max 只作提示 */
const STAT_FIELDS = [
  { field: 'points', label: '得分' },
  { field: 'rebounds', label: '篮板' },
  { field: 'assists', label: '助攻' },
  { field: 'steals', label: '抢断' },
  { field: 'blocks', label: '盖帽' },
  { field: 'turnovers', label: '失误' },
  { field: 'fouls', label: '犯规' },
];

/** 把摊平的统计行按节分组；基础模式（period 为 0）自成一组 */
function groupStatRows(rows, mode) {
  if (mode === 'detailed') {
    const byPeriod = new Map();
    rows.forEach((row) => {
      if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
      byPeriod.get(row.period).push(row);
    });
    return [...byPeriod.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([period, list]) => ({ period, rows: list }));
  }
  return [{ period: 0, rows }];
}

/**
 * ISO 时间 → 输入框里的 `YYYY-MM-DD HH:mm`（北京时间）。
 *
 * 服务端下发的是 ISO；输入框要的是人能改的字符串。两边都用固定的 +08，
 * 不读运行环境时区——否则本机与云函数会算出两个不同的时间。
 */
function toInputTime(value) {
  if (!value) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`
    + ` ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`;
}
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/**
 * 轮次的名字。
 *
 * 季军赛与决赛是同一轮的两场不同比赛，靠 `stage` 区分——只看轮次会把
 * 它们塞进同一个分组，标题写成「决赛」却挂着两场。
 */
function roundLabelOf(round, totalRounds, format, stage) {
  if (stage === 'bronze') return '季军赛';
  if (format === 'round_robin') return `第 ${round} 轮`;
  if (totalRounds && round === totalRounds) return '决赛';
  if (totalRounds && round === totalRounds - 1) return '半决赛';
  return `第 ${round} 轮`;
}

Page(withDetailExperience({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    eventId: '',
    event: null,
    entries: [],
    /** 我能替哪几支队报名（服务端算，已报过的不在里面） */
    submitCandidates: [],
    /** 报名面板的身份文案：{ mode: college_staff|school_admin|member|free, hint } */
    entryPanel: { mode: 'free', hint: '' },
    /** 按轮次分组的赛程：[{ round, label, matches: [] }] */
    rounds: [],
    table: [],
    placements: [],
    canManage: false,
    supportsMatchData: true,
    isFootball: false,
    /** 当前要录分的那一场 */
    recording: null,
    scoreA: '',
    scoreB: '',
    overtime: false,
    /** 弃权：0 正常完赛 / 1 A 队弃权 / 2 B 队弃权 */
    forfeitIndex: 0,
    forfeitLabels: ['正常完赛', 'A 队弃权', 'B 队弃权'],
    busy: false,
    /** 个人统计录入面板：{ matchId, title, mode, periods, revision } */
    statsEditing: null,
    /** 摊平后的统计行：{ key, sideIndex, userId, name, period?, points?, ... } */
    statRows: [],
    /** 按节分组的渲染结构：[{ period, rows: [] }]；period 为 0 表示基础模式 */
    statGroups: [],
    statsBusy: false,
    /** 统计审核条：{ matchId, canReview, needReview, pending } */
    statsReview: null,
    /** 本地草稿提示：恢复成功 / 版本冲突。只说明本机状态，不代表服务端已保存 */
    statsDraftNote: '',
    statsDraftError: false,
    /** 赛程浮层：{ matchId, title, revision, matchTime, location, referees, recorders, ... } */
    scheduleEditing: null,
    /** 整轮顺延浮层：{ round, stage, label, minutes } */
    shiftEditing: null,
    /** 报名选人浮层：{ teamId, teamName, min, max, members: [{ userId, name, noText, checked }] } */
    entryEditing: null,
    /** 出场名单浮层：{ matchId, revision, sides: [{ side, teamName, editable }], activeIndex } */
    lineupEditing: null,
    /** 当前编辑的那一侧的球员（摊平，模板不写下标路径） */
    lineupPlayers: [],
    scheduleBusy: false,
    /** 统计指标列（顺序即页面列顺序） */
    statFields: STAT_FIELDS,
    /** 球员数据榜 */
    playerStats: [],
    playerStatsError: '',
    footballAssists: [],
    footballCoverage: '',
    rankingEditing: null,
    notice: '',
    noticeError: false,
  },

  onLoad(options = {}) {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    this.scope = { schoolId, association: associationScope.getAssociation() };
    this.setData({ themeClass: currentThemeClass(), eventId: options.eventId || '' });
    return this.refresh();
  },

  onShow() {
    this.hidden = false;
    if (this.liveSubscription) this.liveSubscription.resume();
    if (this.footballVisited) { this.footballVisited = false; return this.refresh(); }
  },
  onHide() {
    this.hidden = true;
    if (this.liveSubscription) this.liveSubscription.pause();
  },
  onUnload() {
    clearTimeout(this.schedulePeopleTimer); this.schedulePeopleRequest = (this.schedulePeopleRequest || 0) + 1;
    this.destroyed = true;
    // 与刷新序号配合：离开页面后所有在途读取都不得再 setData 或重新订阅比分。
    this.refreshSeq = (this.refreshSeq || 0) + 1;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.persistDraft();
    if (this.liveSubscription) this.liveSubscription();
  },

  watchScores(matches) {
    if (this.data.event && this.data.event.supportsLiveScore === false) {
      if (this.liveSubscription) this.liveSubscription();
      this.liveSubscription = null;
      return;
    }
    const ids = matches.filter(match => ['scheduled', 'live'].includes(match.status)).map(match => match.matchId);
    this.liveSubscription = watchLiveScores(ids, scores => {
      if (this.destroyed) return;
      const byId = new Map(scores.map(score => [score.matchId, score]));
      this.setData({ rounds: this.data.rounds.map(round => ({ ...round,
        matches: round.matches.map(match => {
          const score = byId.get(match.matchId);
          return score ? { ...match, live: score.live, status: score.status,
            statusLabel: score.statusLabel, scoreText: score.scoreText, revision: score.revision,
            scoreA: score.scoreA, scoreB: score.scoreB, overtime: score.overtime,
            forfeit: score.forfeit, winner: score.winner } : match;
        }),
      })) });
    }, { fetch: async matchIds => {
      const scores = [];
      for (let i = 0; i < matchIds.length; i += 50) {
        const result = await space.forScope(this.scope).getTeamLiveScores({ matchIds: matchIds.slice(i, i + 50) });
        if (!result || !result.ok) throw new Error('比分暂时无法更新');
        scores.push(...result.scores);
      }
      return scores;
    } });
    if (this.hidden) this.liveSubscription.pause();
  },

  onOpenLiveScore(event) {
    if (this.data.event && this.data.event.supportsLiveScore === false) return;
    const { matchid } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/packageTeam/team-live-score/team-live-score?matchId=${encodeURIComponent(matchid)}` });
  },

  /** 取详情。所有动作做完都回到这里，页面状态永远只有一个来源 */
  async refresh() {
    if (!this.data.eventId) {
      this.setData({ loading: false, error: '缺少赛事编号' });
      return undefined;
    }
    const seq = this.refreshSeq = (this.refreshSeq || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      // 路由里的编号可能是「未解码」的：跳转方一律 `encodeURIComponent(事件编号)`，
      // 而微信开发者工具 / 真机把 query 原样透传（`tev%3Amuc...`），服务端因此
      // 查不到这场比赛，页面显示「赛事不存在」。探测出真实编号后写回 data，
      // 后续录分 / 抽签 / 改赛程都用它（见 utils/route-query.js）。
      const client = space.forScope(this.scope);
      let failure = null;
      const resolved = await resolveRouteId(this.data.eventId, async (candidate) => {
        const response = await client.getTeamEvent({ eventId: candidate });
        if (response && response.ok === true) return response;
        failure = response;
        return null;
      });
      // 两次刷新重叠、或页面已退出时，旧响应不得写回，也不得重新挂比分订阅。
      if (this.destroyed || seq !== this.refreshSeq) return undefined;
      if (!resolved.id) {
        this.setData({
          loading: false,
          error: (failure && failure.message) || '赛事不存在，或不在本协会',
        });
        return undefined;
      }
      if (resolved.id !== this.data.eventId) this.setData({ eventId: resolved.id });
      const result = resolved.result;
      const event = result.event;
      const totalRounds = event.draw && event.draw.size
        ? Math.round(Math.log2(event.draw.size))
        : 0;
      const grouped = [];
      (result.matches || []).forEach((match) => {
        // 分组键必须带上 stage：决赛与季军赛同轮次不同场
        const key = `${match.round}|${match.stage}`;
        let bucket = grouped.find(item => item.key === key);
        if (!bucket) {
          bucket = {
            key,
            round: match.round,
            stage: match.stage,
            label: roundLabelOf(match.round, totalRounds, event.format, match.stage),
            matches: [],
          };
          grouped.push(bucket);
        }
        bucket.matches.push(match);
        bucket.canShift = event.canManage === true && ['scheduled', 'running'].includes(event.status)
          && bucket.matches.some(row => row.status === 'scheduled' && row.matchTime);
      });
      this.setData({
        loading: false,
        event,
        supportsMatchData: event.supportsMatchData !== false,
        isFootball: event.sportFormat === 'football11',
        entries: result.entries || [],
        submitCandidates: result.submitCandidates || [],
        // 报名面板的身份文案由服务端给（学院负责人 / 校管代报 / 普通会员），模板不判权
        entryPanel: result.entryPanel || { mode: 'free', hint: '' },
        rounds: grouped,
        table: result.table || [],
        placements: result.placements || [],
        footballByes: (event.draw?.byes || []).map(id => (result.entries || []).find(row => row.teamId === id)?.teamName || id),
        canManage: event.canManage === true,
      });
      if (event.supportsMatchData !== false) this.onLoadPlayerStats(seq);
      else this.setData({ playerStats: [], playerStatsError: '' });
      this.watchScores(result.matches || []);
      return undefined;
    } catch (err) {
      if (this.destroyed || seq !== this.refreshSeq) return undefined;
      console.error('[team-event-detail] 加载失败', err);
      this.setData({ loading: false, error: '赛事加载失败，请稍后重试' });
      return undefined;
    }
  },

  /** 统一处理「调接口 → 提示 → 刷新」，避免每个动作复制一遍 */
  async run(action, payload, successText) {
    if (this.data.busy) return undefined;
    this.setData({ busy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope)[action](payload);
      if (!result || result.ok !== true) {
        this.setData({
          busy: false,
          notice: (result && result.message) || '操作失败',
          noticeError: true,
        });
        return result;
      }
      this.setData({ busy: false, notice: successText || '', noticeError: false });
      await this.refresh();
      return result;
    } catch (err) {
      console.error(`[team-event-detail] ${action} 失败`, err);
      this.setData({ busy: false, notice: '操作失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /* ---------------- 报名 ---------------- */

  onApproveEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    return this.run('reviewTeamEntry', { eventId: this.data.eventId, teamId: teamid, approve: true }, '已通过');
  },

  onRejectEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    return this.run('reviewTeamEntry', { eventId: this.data.eventId, teamId: teamid, approve: false }, '已退回');
  },

  /** 队长为本队报名：先选人再提交（管理者也能替任何一队补报） */
  async onSubmitEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    this.setData({ notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).getTeamEntryRoster({
        eventId: this.data.eventId,
        teamId: teamid,
      });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '名单加载失败', noticeError: true });
        return undefined;
      }
      if (result.canEdit !== true) {
        this.setData({ notice: '当前不能修改这份名单（已锁定或赛事已开始）', noticeError: true });
        return undefined;
      }
      this.setData({
        entryEditing: {
          teamId: teamid,
          teamName: result.team.name,
          min: Number(result.event.entryMin) || 5,
          max: Number(result.event.entryMax) || 12,
          status: result.status,
          selectedCount: (result.members || []).filter(row => row.selected === true).length,
          members: (result.members || []).map(row => ({
            userId: row.userId,
            name: row.name,
            // 输入框要字符串：null 直接绑到 input 上会显示成「null」
            noText: Number.isInteger(row.no) ? String(row.no) : '',
            checked: row.selected === true,
          })),
        },
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 报名名单加载失败', err);
      this.setData({ notice: '名单加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onCloseEntry() {
    this.setData({ entryEditing: null, busy: false });
  },

  onToggleEntryMember(event) {
    const { userid } = event.currentTarget.dataset;
    const members = (this.data.entryEditing.members || []).map(row => (
      row.userId === userid ? { ...row, checked: !row.checked } : row
    ));
    this.setData({
      'entryEditing.members': members,
      'entryEditing.selectedCount': members.filter(row => row.checked).length,
    });
  },

  onInputJersey(event) {
    const { userid } = event.currentTarget.dataset;
    const value = event.detail.value;
    const members = (this.data.entryEditing.members || []).map(row => (
      row.userId === userid ? { ...row, noText: value } : row
    ));
    this.setData({ 'entryEditing.members': members });
  },

  async onSaveEntry() {
    const editing = this.data.entryEditing;
    if (!editing || this.data.busy) return undefined;
    const chosen = editing.members.filter(row => row.checked);
    if (chosen.length < editing.min) {
      this.setData({
        notice: `报名至少需要 ${editing.min} 人，当前选了 ${chosen.length} 人`,
        noticeError: true,
      });
      return undefined;
    }
    const result = await this.run('submitTeamEntry', {
      eventId: this.data.eventId,
      teamId: editing.teamId,
      roster: chosen.map(row => ({ userId: row.userId, no: row.noText })),
    }, '已提交报名，等协会负责人审核');
    if (!result || result.ok !== true) return result;
    // 关面板 + 提示合并成一次 setData。分支里只覆盖「有话说」的情形，
    // 没有命中时不碰 notice，保持原来「不主动清空旧提示」的行为
    const patch = { entryEditing: null };
    if (result.resubmitted === true) {
      patch.notice = '名单已更新，需要协会负责人重新审核';
      patch.noticeError = false;
    } else if (Number(result.rosterCount) > 0) {
      patch.notice = `已报名 ${result.rosterCount} 人，等协会负责人审核`;
      patch.noticeError = false;
    }
    this.setData(patch);
    return result;
  },

  /* ---------------- 单场出场名单 ---------------- */

  /**
   * 打开出场名单浮层。
   *
   * 两侧的球员先按「谁可以编辑」落到默认那一侧：队长进来就停在自己队，
   * 管理员停在 A 侧。换边只是切换显示，勾选状态跟着走。
   */
  async onOpenLineup(event) {
    const { matchid } = event.currentTarget.dataset;
    this.setData({ notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).getTeamMatchLineup({ matchId: matchid });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '出场名单加载失败', noticeError: true });
        return undefined;
      }
      const sides = (result.sides || []).map(row => ({
        side: row.side,
        teamName: row.teamName,
        editable: row.editable === true,
      }));
      this.lineupBySide = (result.sides || []).map(row => ({
        side: row.side,
        players: (row.players || []).map(player => ({
          userId: player.userId,
          name: player.name,
          no: Number.isInteger(player.no) ? player.no : null,
          checked: player.checked === true,
        })),
      }));
      const activeIndex = Math.max(0, sides.findIndex(row => row.editable));
      this.setData({
        lineupEditing: {
          matchId: matchid,
          revision: Number(result.revision) || 0,
          minOnCourt: Number(result.minOnCourt) || 2,
          sides,
          activeIndex,
        },
        lineupPlayers: (this.lineupBySide[activeIndex] || {}).players || [],
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 出场名单加载失败', err);
      this.setData({ notice: '出场名单加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onCloseLineup() {
    this.lineupBySide = null;
    this.setData({ lineupEditing: null, lineupPlayers: [], busy: false });
  },

  onSwitchLineupSide(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    const entry = (this.lineupBySide || [])[index] || { players: [] };
    this.setData({
      'lineupEditing.activeIndex': index,
      lineupPlayers: entry.players || [],
    });
  },

  onToggleLineupPlayer(event) {
    const { userid } = event.currentTarget.dataset;
    const editing = this.data.lineupEditing;
    if (!editing) return;
    const index = editing.activeIndex;
    const entry = (this.lineupBySide || [])[index];
    if (!entry) return;
    entry.players = entry.players.map(row => (
      row.userId === userid ? { ...row, checked: !row.checked } : row
    ));
    this.setData({ lineupPlayers: entry.players });
  },

  async onSaveLineup() {
    const editing = this.data.lineupEditing;
    if (!editing || this.data.busy) return undefined;
    const index = editing.activeIndex;
    const entry = (this.lineupBySide || [])[index];
    const side = (editing.sides[index] || {}).side;
    if (!entry || !side) return undefined;
    if (!(editing.sides[index] || {}).editable) {
      this.setData({ notice: '只能定自己队的出场名单', noticeError: true });
      return undefined;
    }
    const players = entry.players.filter(row => row.checked).map(row => row.userId);
    if (players.length < editing.minOnCourt) {
      this.setData({
        notice: `出场名单至少 ${editing.minOnCourt} 人（场上不足即判负）`,
        noticeError: true,
      });
      return undefined;
    }

    this.setData({ busy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).saveTeamMatchLineup({
        matchId: editing.matchId,
        side,
        players,
        expectRevision: editing.revision,
      });
      if (!result || result.ok !== true) {
        this.setData({
          busy: false,
          notice: (result && result.message) || '保存失败',
          noticeError: true,
        });
        return undefined;
      }
      this.lineupBySide = null;
      this.setData({
        busy: false, lineupEditing: null, lineupPlayers: [], notice: '出场名单已保存', noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 出场名单保存失败', err);
      this.setData({ busy: false, notice: '保存失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /* ---------------- 赛程：时间 / 场地 / 裁判 / 记录员 ---------------- */

  onLock() {
    return this.run('lockTeamEntries', { eventId: this.data.eventId }, '名单已锁定，接下来可以抽签');
  },

  /* ---------------- 赛程 ---------------- */

  onDraw() {
    return this.run('drawTeamEvent', { eventId: this.data.eventId }, '已抽签并生成赛程');
  },

  onAdvance() {
    return this.run('advanceTeamRound', { eventId: this.data.eventId }, '已排出下一轮');
  },

  onSettle() {
    if (this.data.isFootball && this.data.event.format === 'round_robin' && this.data.table.some(row => row.rank === null)) {
      const groups = [];
      for (const row of this.data.table.filter(r => r.rank === null)) {
        let group = groups.find(g => g.tieKey === row.tieKey);
        if (!group) { group = { tieKey: row.tieKey, rows: [], reason: '' }; groups.push(group); }
        group.rows.push({ teamId: row.teamId, name: row.teamName, order: '' });
      }
      this.setData({ rankingEditing: groups }); return;
    }
    return this.run('settleTeamEvent', { eventId: this.data.eventId }, '名次已结算');
  },
  onRankingInput(event) {
    const { group, index, field } = event.currentTarget.dataset;
    if (field === 'reason') this.setData({ [`rankingEditing[${group}].reason`]: event.detail.value });
    else this.setData({ [`rankingEditing[${group}].rows[${index}].order`]: event.detail.value });
  },
  onCloseRanking() { this.setData({ rankingEditing: null }); },
  async onConfirmRanking() {
    const rankingDecisions = [];
    for (const group of this.data.rankingEditing || []) {
      const orders = group.rows.map(row => Number(row.order));
      if (!group.reason.trim() || new Set(orders).size !== orders.length || orders.some(n => !Number.isInteger(n) || n < 1 || n > orders.length)) {
        this.setData({ notice: '请填写每组抽签理由及不重复的组内顺序（1 起）', noticeError: true }); return;
      }
      rankingDecisions.push({ tieKey: group.tieKey, reason: group.reason,
        teamIds: group.rows.slice().sort((a, b) => Number(a.order) - Number(b.order)).map(row => row.teamId) });
    }
    const result = await this.run('settleTeamEvent', { eventId: this.data.eventId, rankingDecisions }, '抽签结果已记录，名次已结算');
    if (result?.ok) this.setData({ rankingEditing: null });
  },
  onOpenFootball(event) {
    const { matchid, lineup } = event.currentTarget.dataset;
    this.footballVisited = true;
    return wx.navigateTo({ url: `/packageTeam/football-match/football-match?matchId=${encodeURIComponent(matchid)}${lineup ? '&lineup=1' : ''}` });
  },

  /* ---------------- 个人统计 ---------------- */

  /**
   * 打开统计面板。
   *
   * 名单必须问服务端要：它是「锁定那一刻的快照」，不是球队现在的成员表。
   * 按节模式下把「节 × 人」摊平成一张平表，再按节分组渲染——WXML 的
   * 表达式能力有限，能摊平就不要嵌套两层 wx:for 取值。
   */
  async onOpenStats(event) {
    const { matchid } = event.currentTarget.dataset;
    const match = this.data.rounds.flatMap(round => round.matches).find(row => row.matchId === matchid);
    if (match && match.status === 'live') return this.onOpenLiveScore(event);
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.setData({ notice: '', noticeError: false, statsDraftNote: '', statsDraftError: false });
    try {
      const result = await space.forScope(this.scope).getTeamMatchStats({ matchId: matchid });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '统计加载失败', noticeError: true });
        return undefined;
      }
      if (result.canEdit !== true) {
        this.setData({ notice: '这场已结束或你没有录入权限', noticeError: true });
        return undefined;
      }
      const editing = {
        matchId: matchid,
        title: `${result.match.teamAName} vs ${result.match.teamBName}`,
        mode: result.statPolicy,
        periods: Number(result.periods) || 4,
        // 版本号取两侧工作副本的较大值：两侧总是一起写，正常情况下相等。
        // 保存时带上它，服务端据此判断「打开面板之后有没有人改过」。
        revision: (result.sides || []).reduce((max, side) => Math.max(max, side.revision || 0), 0),
        needReview: result.needReview === true,
      };
      const rows = [];
      (result.sides || []).forEach((side, sideIndex) => {
        const saved = side.rows || [];
        // key 必须带上节次：同一个人在第 1 节和第 2 节是两行，撞键会串数据
        const blankOf = (userId, name, period) => ({
          key: period ? `${sideIndex}-${userId}-${period}` : `${sideIndex}-${userId}`,
          sideIndex, userId, name,
          points: '', rebounds: '', assists: '', steals: '', blocks: '', turnovers: '', fouls: '',
        });
        if (editing.mode === 'detailed') {
          // 按节：一节一张小表，每个人在每个节里都有自己的一行
          for (let period = 1; period <= editing.periods; period += 1) {
            (side.players || []).forEach((player) => {
              const hit = saved.find(row => row.period === period && row.userId === player.userId) || {};
              const row = blankOf(player.userId, player.name, period);
              row.period = period;
              STAT_FIELDS.forEach(({ field }) => {
                row[field] = hit[field] === null || hit[field] === undefined ? '' : String(hit[field]);
              });
              rows.push(row);
            });
          }
        } else {
          const savedPlayers = side.players || [];
          (side.players || []).forEach((player) => {
            const hit = savedPlayers.find(item => item.userId === player.userId) || {};
            const row = blankOf(player.userId, player.name, 0);
            STAT_FIELDS.forEach(({ field }) => {
              row[field] = hit[field] === null || hit[field] === undefined ? '' : String(hit[field]);
            });
            rows.push(row);
          });
        }
      });
      // 只恢复与当前 revision 一致的本地草稿；服务端版本已经变化时保留服务端
      // 当前值，并明确提示，不静默覆盖别人的修改。
      const draftKey = this.statsDraftKey(matchid);
      const draft = statsDraft.load(draftKey);
      const restored = statsDraft.merge(rows, draft, STAT_FIELDS.map(item => item.field), editing.revision);
      const draftNote = restored.conflict
        ? `检测到本机草稿（版本 ${draft.revision}），但这场已被更新到版本 ${editing.revision}，草稿未自动恢复`
        : restored.restored ? '已恢复本机未提交的统计草稿，请核对后保存' : '';
      this.rememberStatLayout(restored.rows, editing.mode);
      this.setData({
        statsEditing: editing,
        statRows: restored.rows,
        statGroups: groupStatRows(restored.rows, editing.mode),
        statsDraftNote: draftNote,
        statsDraftError: restored.conflict,
        statsReview: {
          matchId: matchid,
          canReview: result.canReview === true,
          needReview: result.needReview === true,
          pending: (result.sides || []).some(side => side.pendingReview === true),
        },
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计加载失败', err);
      this.setData({ notice: '统计加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 本场草稿键：学校 + 协会 + 场次 + 当前账号，避免换账号或换场串数据 */
  statsDraftKey(matchId) {
    return statsDraft.keyOf({
      schoolId: this.scope && this.scope.schoolId,
      association: this.scope && this.scope.association,
      matchId,
    });
  },

  /** 记住每个 key 在平表与分组结构中的位置，供单字段路径更新使用 */
  rememberStatLayout(rows, mode) {
    const rowIndex = new Map();
    const groupIndex = new Map();
    (rows || []).forEach((row, index) => rowIndex.set(row.key, index));
    const groups = groupStatRows(rows || [], mode);
    groups.forEach((group, gi) => {
      (group.rows || []).forEach((row, ri) => groupIndex.set(row.key, { group: gi, row: ri }));
    });
    this.statRowIndex = rowIndex;
    this.statGroupIndex = groupIndex;
  },

  /** 输入停顿后再落盘，避免每敲一个数字都写一次本地存储 */
  scheduleDraftSave() {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.persistDraft();
    }, 400);
  },

  /** 立即把当前尚未提交的输入写入本地。只存键与指标，不复制姓名等资料。 */
  persistDraft() {
    const editing = this.data.statsEditing;
    if (!editing) return false;
    const fields = STAT_FIELDS.map(item => item.field);
    const rows = (this.data.statRows || [])
      .map((row) => {
        const out = { key: row.key, period: row.period || 0 };
        let filled = false;
        fields.forEach((field) => {
          out[field] = row[field] == null ? '' : String(row[field]);
          if (out[field] !== '') filled = true;
        });
        return filled ? out : null;
      })
      .filter(Boolean);
    const key = this.statsDraftKey(editing.matchId);
    if (rows.length === 0) {
      statsDraft.clear(key);
      return false;
    }
    return statsDraft.save(key, { revision: editing.revision, mode: editing.mode, rows });
  },

  onCloseStats() {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    // 取消不是丢弃：把已输入内容留在本机，下次打开且版本未变时恢复。
    this.persistDraft();
    this.setData({
      statsEditing: null, statRows: [], statGroups: [], statsBusy: false, statsReview: null,
      statsDraftNote: '', statsDraftError: false,
    });
  },

  /**
   * 改一个格子：只更新该字段在平表与分组结构里的路径。
   * 复用同一份渲染数据，避免按节模式下每次按键都重建整张表。
   */
  onInputStat(event) {
    const key = event.currentTarget.dataset.key;
    const field = event.currentTarget.dataset.field;
    if (!key || !field) return;
    const index = this.statRowIndex ? this.statRowIndex.get(key) : undefined;
    if (index === undefined) {
      // 兼容异常布局（如热更新后旧表仍在）：退回整表重建，至少不丢输入。
      const rows = this.data.statRows.map((row) => (
        row.key === key ? { ...row, [field]: event.detail.value } : row
      ));
      this.rememberStatLayout(rows, this.data.statsEditing.mode);
      this.setData({ statRows: rows, statGroups: groupStatRows(rows, this.data.statsEditing.mode) });
      this.scheduleDraftSave();
      return;
    }
    const patch = { [`statRows[${index}].${field}`]: event.detail.value };
    const position = this.statGroupIndex ? this.statGroupIndex.get(key) : null;
    if (position) patch[`statGroups[${position.group}].rows[${position.row}].${field}`] = event.detail.value;
    this.setData(patch);
    this.scheduleDraftSave();
  },

  async onSaveStats() {
    const editing = this.data.statsEditing;
    if (!editing || this.data.statsBusy) return undefined;
    const filled = this.data.statRows.filter(row => STAT_FIELDS.some(({ field }) => row[field] !== ''));
    if (filled.length === 0) {
      this.setData({ notice: '还没填任何统计', noticeError: true });
      return undefined;
    }

    const players = filled.map(row => {
      const out = { userId: row.userId };
      STAT_FIELDS.forEach(({ field }) => { out[field] = row[field]; });
      if (editing.mode === 'detailed') out.period = row.period;
      return out;
    });

    this.setData({ statsBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).saveTeamMatchStats({
        matchId: editing.matchId,
        mode: editing.mode,
        expectRevision: editing.revision,
        ...(editing.mode === 'detailed' ? { rows: players } : { players }),
      });
      if (!result || result.ok !== true) {
        this.setData({
          statsBusy: false,
          notice: (result && result.message) || '保存失败',
          noticeError: true,
        });
        return undefined;
      }
      const warnings = result.warnings || [];
      // 已发布比赛的统计改动只是「待审核」版本：说清楚它还没对外生效，
      // 否则保存成功会让人以为榜单已经变了
      const doneText = result.needReview === true
        ? '统计已保存，等协会负责人审核后对外生效'
        : '统计已保存';
      if (this.draftTimer) {
        clearTimeout(this.draftTimer);
        this.draftTimer = null;
      }
      // 服务端已接收这一版，本地草稿完成使命；留着会在下次打开时误导成“未保存”。
      statsDraft.clear(this.statsDraftKey(editing.matchId));
      this.statRowIndex = null;
      this.statGroupIndex = null;
      this.setData({
        statsBusy: false,
        statsEditing: null,
        statRows: [],
        statGroups: [],
        statsReview: null,
        statsDraftNote: '',
        statsDraftError: false,
        notice: warnings.length > 0 ? warnings.join('；') : doneText,
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计保存失败', err);
      this.setData({ statsBusy: false, notice: '保存失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 通过 / 退回统计的新版本（只有协会管理员能看到这两个按钮） */
  async onReviewStats(event) {
    const review = this.data.statsReview;
    if (!review || this.data.statsBusy) return undefined;
    const approve = event.currentTarget.dataset.approve === true
      || event.currentTarget.dataset.approve === 'true';
    this.setData({ statsBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).reviewTeamMatchStats({
        matchId: review.matchId,
        approve,
      });
      if (!result || result.ok !== true) {
        this.setData({
          statsBusy: false,
          notice: (result && result.message) || '审核失败',
          noticeError: true,
        });
        return undefined;
      }
      if (this.draftTimer) {
        clearTimeout(this.draftTimer);
        this.draftTimer = null;
      }
      statsDraft.clear(this.statsDraftKey(review.matchId));
      this.statRowIndex = null;
      this.statGroupIndex = null;
      this.setData({
        statsBusy: false,
        statsEditing: null,
        statRows: [],
        statGroups: [],
        statsReview: null,
        statsDraftNote: '',
        statsDraftError: false,
        notice: approve ? '统计已通过，榜单已更新' : '统计已退回，对外仍是上一版',
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计审核失败', err);
      this.setData({ statsBusy: false, notice: '审核失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 球员数据榜：赛事页底部一块，只算已发布的比赛 */
  async onLoadPlayerStats(seq = this.refreshSeq) {
    try {
      const result = await space.forScope(this.scope).getTeamEventPlayerStats({
        eventId: this.data.eventId,
      });
      if (this.destroyed || seq !== this.refreshSeq) return undefined;
      if (!result || result.ok !== true) {
        this.setData({ playerStats: [], playerStatsError: (result && result.message) || '' });
        return undefined;
      }
      this.setData({ playerStats: result.players || [], playerStatsError: '',
        footballAssists: result.assists || [], footballCoverage: result.coverageText || '' });
      return undefined;
    } catch (err) {
      if (this.destroyed || seq !== this.refreshSeq) return undefined;
      console.error('[team-event-detail] 球员榜加载失败', err);
      this.setData({ playerStats: [], playerStatsError: '球员数据加载失败' });
      return undefined;
    }
  },

  /* ---------------- 赛程：时间 / 场地 / 裁判 / 记录员 ---------------- */

  /**
   * 打开单场赛程浮层。
   *
   * 候选名单必须问服务端要：裁判不能是这两支队的队长、记录员必须是本协会会员，
   * 这些规则页面推不出来。这里只把「可选的人」铺成选择器，选完把编号传回去。
   */
  async onOpenSchedule(event) {
    const { matchid } = event.currentTarget.dataset;
    this.setData({ notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).getTeamMatchSchedule({ matchId: matchid });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '赛程加载失败', noticeError: true });
        return undefined;
      }
      if (result.canEdit !== true) {
        this.setData({ notice: '这场已结束或已取消，不能再改赛程', noticeError: true });
        return undefined;
      }
      // 裁判候选里排除「不能执法」的人；记录员不受这条限制
      const referees = (result.referees || []).filter(row => !row.disabled);
      const recorders = (result.recorders || []).filter(row => !row.disabled);
      const indexOf = (list, userId) => {
        const at = list.findIndex(row => row.userId === userId);
        return at < 0 ? 0 : at + 1;
      };
      this.setData({
        scheduleEditing: {
          matchId: matchid,
          title: `${result.match.teamAName} vs ${result.match.teamBName}`,
          revision: result.match.revision,
          matchTime: toInputTime(result.match.matchTime),
          location: result.match.location || '',
          durationMinutes: result.match.durationMinutes || '',
          requestId: `fb_schedule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          referees,
          recorders, peopleKeyword: '', peopleCursor: result.nextCursor || '', peopleHasMore: Boolean(result.hasMore), peopleLoading: false, peopleError: '',
          refereeIndex: indexOf(referees, result.match.refereeId),
          recorderIndex: indexOf(recorders, result.match.recorderId),
          refereeLabels: ['不指派', ...referees.map(row => row.name)],
          recorderLabels: ['不指派', ...recorders.map(row => row.name)],
        },
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 赛程加载失败', err);
      this.setData({ notice: '赛程加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onCloseSchedule() {
    clearTimeout(this.schedulePeopleTimer); this.schedulePeopleRequest = (this.schedulePeopleRequest || 0) + 1;
    this.setData({ scheduleEditing: null, scheduleBusy: false });
  },

  onSearchSchedulePeople(event) {
    if (!this.data.scheduleEditing) return;
    this.setData({ 'scheduleEditing.peopleKeyword': event.detail.value });
    clearTimeout(this.schedulePeopleTimer);
    this.schedulePeopleRequest = (this.schedulePeopleRequest || 0) + 1;
    this.schedulePeopleTimer = setTimeout(() => this.loadSchedulePeople(false), 250);
  },
  onMoreSchedulePeople() { return this.loadSchedulePeople(true); },
  onRetrySchedulePeople() { return this.loadSchedulePeople(false); },
  async loadSchedulePeople(append = false) {
    const editing = this.data.scheduleEditing;
    if (!editing || this.data.scheduleBusy || append && (editing.peopleLoading || !editing.peopleHasMore)) return;
    const request = this.schedulePeopleRequest = (this.schedulePeopleRequest || 0) + 1;
    this.setData({ 'scheduleEditing.peopleLoading': true, 'scheduleEditing.peopleError': '' });
    try {
      const result = await space.forScope(this.scope).getTeamMatchSchedule({ matchId: editing.matchId,
        keyword: editing.peopleKeyword || '', cursor: append ? editing.peopleCursor : '' });
      if (request !== this.schedulePeopleRequest || !this.data.scheduleEditing) return;
      if (!result.ok) throw new Error(result.message || '候选读取失败');
      const current = this.data.scheduleEditing, patch = {};
      for (const [list, field] of [['referees', 'referee'], ['recorders', 'recorder']]) {
        const selected = current[list][current[field + 'Index'] - 1];
        const prior = append ? current[list] : selected ? [selected] : [];
        const rows = [...new Map([...prior, ...(result[list] || []).filter(row => !row.disabled)].map(row => [row.userId, row])).values()];
        patch['scheduleEditing.' + list] = rows;
        patch['scheduleEditing.' + field + 'Labels'] = ['不指派', ...rows.map(row => row.name)];
        patch['scheduleEditing.' + field + 'Index'] = selected ? rows.findIndex(row => row.userId === selected.userId) + 1 : 0;
      }
      Object.assign(patch, { 'scheduleEditing.peopleLoading': false, 'scheduleEditing.peopleHasMore': Boolean(result.hasMore),
        'scheduleEditing.peopleCursor': result.nextCursor || '' });
      this.setData(patch);
    } catch (error) {
      if (request === this.schedulePeopleRequest && this.data.scheduleEditing) this.setData({ 'scheduleEditing.peopleLoading': false,
        'scheduleEditing.peopleError': error.message || '候选读取失败，请重试' });
    }
  },

  onInputSchedule(event) {
    if (this.data.scheduleBusy) return;
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    // 字段值与足球的幂等键合并成一次 setData：两次写的是同一个对象的两条路径，
    // 分两次发就是白多一趟跨线程通信
    const patch = { [`scheduleEditing.${field}`]: event.detail.value };
    if (this.data.isFootball) patch['scheduleEditing.requestId'] = `fb_schedule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.setData(patch);
  },

  onPickSchedulePerson(event) {
    if (this.data.scheduleBusy) return;
    const role = event.currentTarget.dataset.role;
    const index = Number(event.detail.value) || 0;
    const patch = role === 'referee'
      ? { 'scheduleEditing.refereeIndex': index }
      : { 'scheduleEditing.recorderIndex': index };
    if (this.data.isFootball) patch['scheduleEditing.requestId'] = `fb_schedule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.setData(patch);
  },

  async onSubmitSchedule() {
    const editing = this.data.scheduleEditing;
    if (!editing || this.data.scheduleBusy) return undefined;
    const refereeId = editing.refereeIndex > 0
      ? (editing.referees[editing.refereeIndex - 1] || {}).userId || ''
      : '';
    const recorderId = editing.recorderIndex > 0
      ? (editing.recorders[editing.recorderIndex - 1] || {}).userId || ''
      : '';

    this.setData({ scheduleBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).updateTeamMatchSchedule({
        matchId: editing.matchId,
        matchTime: editing.matchTime,
        location: editing.location,
        refereeId,
        recorderId,
        // 版本号来自打开浮层那一刻：期间有人改过就拒绝，不覆盖
        expectRevision: editing.revision,
        ...(this.data.isFootball ? { requestId: editing.requestId, durationMinutes: Number(editing.durationMinutes) } : {}),
      });
      if (!result || result.ok !== true) {
        this.setData({
          scheduleBusy: false,
          notice: (result && result.message) || '保存失败',
          noticeError: true,
        });
        return undefined;
      }
      this.setData({
        scheduleBusy: false, scheduleEditing: null, notice: '赛程已更新', noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 赛程保存失败', err);
      this.setData({ scheduleBusy: false, notice: '保存失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 整轮顺延：一场雨把整轮往后挪，不必逐场改 */
  onOpenShift(event) {
    const { round, stage, label } = event.currentTarget.dataset;
    this.setData({
      shiftEditing: {
        round: Number(round) || 1,
        stage: stage || '',
        label: label || `第 ${round} 轮`,
        minutes: '30',
        revision: this.data.event?.revision,
        requestId: `fb_shift_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      },
      notice: '',
      noticeError: false,
    });
  },

  onCloseShift() {
    this.setData({ shiftEditing: null, scheduleBusy: false });
  },

  onInputShift(event) {
    if (this.data.scheduleBusy) return;
    const patch = { 'shiftEditing.minutes': event.detail.value };
    if (this.data.isFootball) patch['shiftEditing.requestId'] = `fb_shift_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.setData(patch);
  },

  async onSubmitShift() {
    const editing = this.data.shiftEditing;
    if (!editing || this.data.scheduleBusy) return undefined;
    this.setData({ scheduleBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).updateTeamRoundSchedule({
        eventId: this.data.eventId,
        round: editing.round,
        stage: editing.stage,
        shiftMinutes: Number(editing.minutes),
        ...(this.data.isFootball ? { requestId: editing.requestId, expectRevision: editing.revision } : {}),
      });
      if (!result || result.ok !== true) {
        this.setData({
          scheduleBusy: false,
          notice: (result && result.message) || '顺延失败',
          noticeError: true,
        });
        return undefined;
      }
      const skipped = Number(result.skipped) || 0;
      this.setData({
        scheduleBusy: false,
        shiftEditing: null,
        notice: `已顺延 ${result.shifted} 场${skipped > 0 ? `，跳过 ${skipped} 场（已发布或没有开赛时间）` : ''}`,
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 整轮顺延失败', err);
      this.setData({ scheduleBusy: false, notice: '顺延失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /* ---------------- 录分 ---------------- */

  onOpenRecord(event) {
    const { matchid } = event.currentTarget.dataset;
    let target = null;
    this.data.rounds.forEach((bucket) => {
      const found = bucket.matches.find(item => item.matchId === matchid);
      if (found) target = found;
    });
    if (!target) return undefined;
    this.setData({
      recording: target,
      scoreA: target.scoreA === null ? '' : String(target.scoreA),
      scoreB: target.scoreB === null ? '' : String(target.scoreB),
      overtime: target.overtime === true,
      forfeitIndex: target.forfeit === 'A' ? 1 : (target.forfeit === 'B' ? 2 : 0),
      // 页面上用队名而不是「A 队 / B 队」，裁判看的是队名
      forfeitLabels: ['正常完赛', `${target.teamAName} 弃权`, `${target.teamBName} 弃权`],
      notice: '',
      noticeError: false,
    });
    return undefined;
  },

  onCloseRecord() {
    this.setData({ recording: null, scoreA: '', scoreB: '', overtime: false, forfeitIndex: 0 });
  },

  onInputScore(event) {
    const side = event.currentTarget.dataset.side;
    const value = event.detail.value;
    this.setData(side === 'A' ? { scoreA: value } : { scoreB: value });
  },

  onToggleOvertime(event) {
    this.setData({ overtime: event.detail.value === true });
  },

  /**
   * 选弃权方：自动把比分填成 20:0（FIBA 口径：弃权方 0 分、对手 20 分胜）。
   * 填进去而不是锁死——有的赛事按实际比分记，改一下就行。
   */
  onPickForfeit(event) {
    const index = Number(event.detail.value) || 0;
    if (index === 1) {
      this.setData({ forfeitIndex: 1, scoreA: '0', scoreB: '20', overtime: false });
    } else if (index === 2) {
      this.setData({ forfeitIndex: 2, scoreA: '20', scoreB: '0', overtime: false });
    } else {
      this.setData({ forfeitIndex: 0 });
    }
  },

  async onSubmitScore() {
    if (!this.data.recording || this.data.busy) return undefined;
    const forfeit = this.data.forfeitIndex === 1 ? 'A' : (this.data.forfeitIndex === 2 ? 'B' : null);
    const result = await this.run('recordTeamMatch', {
      matchId: this.data.recording.matchId,
      scoreA: this.data.scoreA,
      scoreB: this.data.scoreB,
      overtime: this.data.overtime,
      forfeit,
      // 版本号来自打开浮层时的赛程快照：期间若有人先提交，服务端会拒绝而不是覆盖
      expectRevision: this.data.recording.revision,
    }, '已提交，等协会负责人发布');
    if (!result || result.ok !== true) return result;
    this.setData({ recording: null, scoreA: '', scoreB: '', overtime: false });
    // 服务端可能带回「个人合计与球队得分不符」这类提醒，别吞掉
    const warnings = result.warnings || [];
    if (warnings.length > 0) {
      this.setData({ notice: warnings.join('；'), noticeError: false });
    }
    return result;
  },

  /** 在已加载的赛程里按编号找一场：发布要带它的版本号，不能只带编号 */
  matchOf(matchId) {
    let target = null;
    this.data.rounds.forEach((bucket) => {
      const found = bucket.matches.find(item => item.matchId === matchId);
      if (found) target = found;
    });
    return target;
  },

  onPublish(event) {
    const { matchid } = event.currentTarget.dataset;
    const target = this.matchOf(matchid);
    return this.run('publishTeamMatch', {
      matchId: matchid, approve: true, expectRevision: target && target.revision,
    }, '成绩已发布');
  },

  onRejectScore(event) {
    const { matchid } = event.currentTarget.dataset;
    const target = this.matchOf(matchid);
    return this.run('publishTeamMatch', {
      matchId: matchid, approve: false, expectRevision: target && target.revision,
    }, '已驳回，请让队长重新录');
  },
}, 'team', 'refresh'));
