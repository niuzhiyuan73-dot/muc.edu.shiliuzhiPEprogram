/**
 * 录分与成绩发布
 * ============================================================
 * 一个页面两种身份，因为它们是同一条链路的相邻两步：
 *   · 裁判：看到「我的任务」→ 点开场次 → 逐条录入 → 提交；
 *   · 管理员：按**场次**预览汇总（均值 / 缺分）→ 发布正式结果。
 *
 * 【为什么管理员必须先选场次】
 * 有预赛的项目有多个场次，每组分别发布。发布键按场次拆开（meetPublicationKey），
 * 所以页面也必须让管理员明确「发的是哪一组」。默认给决赛：他更可能是在收尾，
 * 而不是在发第一组预赛。
 *
 * 【胜负项目没有「录分」这一步】
 * 名次由签表/循环赛推出来。页面只提供「编排签表」与「这场谁赢」，不再有
 * 手填名次——手填与自动出表并存，迟早出现两套互相矛盾的名次。
 *
 * 画面上的判断都不重复服务端规则：缺几条分、能不能发布、谁的名次第几，
 * 一律以接口返回为准。页面只负责把「还差几条」「谁还没交」显示清楚。
 * ============================================================
 */

const meet = require('../services/meet.js');
const { updateMeetPage } = require('../utils/meet-ui.js');
const session = require('../../services/school-session.js');
const { withScoreDraftExperience } = require('../../templates/score-draft-experience.js');
const { routeIdCandidates } = require('../../utils/route-query.js');

/** 晋级口径的中文名（只用于显示，判定一律在服务端） */
const ADVANCE_LABEL = {
  per_heat: '每组前 N',
  overall: '总成绩前 N',
  hybrid: '混合晋级',
};

Page(withScoreDraftExperience({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    canManage: false,
    /** 能不能发布/更正成绩：管理员 + 本届总裁判（总裁判只发布，不编排） */
    canPublish: false,
    tasks: [],
    events: [],
    // 当前打开的录分场次
    activeSessionKey: '',
    scoreItems: [],
    drafts: {},
    scoringJudges: [],
    scoringJudgeIndex: 0,
    scoringJudgeId: '',
    // 同项目的全部场次（B9c：录分时在组/枪之间切换）
    eventSessions: [],
    sessionIndex: -1,
    canEnterSession: false,
    // 管理员预览
    activeEventKey: '',
    activeRoundKey: '',
    preview: null,
    voidKeys: [],
    // 胜负项目的签表
    bracket: null,
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload().then(() => {
      if (this.unloaded || !options.sessionKey || this.data.error) return;
      const sessions = [...this.data.tasks, ...this.data.events.flatMap(row => row.sessions || [])];
      const canonical = routeIdCandidates(options.sessionKey).find(key => sessions.some(row => row.sessionKey === key));
      if (canonical) return this.openSession(canonical);
      this.update({ error: '该裁判安排已变化，请刷新任务列表' });
    });
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    this.unloaded = true;
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  /**
   * 项目行补上视图要用的几个判断。
   *
   * 为什么不在 WXML 里算：模板里的 `filter`/`every` 既不可读也容易写错，
   * 而「预赛有没有抽签」是决定显示哪个按钮的关键，算错了管理员就点不到入口。
   */
  decorateEvent(item) {
    const sessions = item.sessions || [];
    const heats = sessions.filter((row) => row.round === 'heat');
    const finalSession = sessions.find((row) => row.round === 'final');
    return {
      ...item,
      groupLabel: item.group === 'male' ? '男子' : item.group === 'female' ? '女子' : '混合',
      heatCount: heats.length,
      heatDrawn: heats.length > 0 && heats.every((row) => (row.entryKeys || []).length > 0),
      // 直接决赛但分了多枪：成绩合并成一份，不需要按枪切换
      aggregated: item.scoreType !== 'versus' && item.rounds === 'final' && sessions.length > 1,
      finalCount: finalSession ? (finalSession.entryKeys || []).length : 0,
      advanceLabel: item.advance ? (ADVANCE_LABEL[item.advance.mode] || '') : '',
    };
  },

  async reload() {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    this.update({ loading: true, error: '' });
    try {
      const [tasks, schedule] = await Promise.all([
        this.client().getMyMeetJudgeTasks({}),
        this.client().getMeetSchedule({}),
      ]);
      if (this.unloaded || request !== this.loadRequest) return;
      this.update({
        loading: false,
        canManage: Boolean(schedule.canManage),
        canPublish: Boolean(schedule.canPublish),
        tasks: tasks.items,
        events: schedule.items.map((row) => this.decorateEvent(row)),
      });
    } catch (err) {
      if (this.unloaded || request !== this.loadRequest) return;
      this.update({ loading: false, tasks: [], events: [], canManage: false, canPublish: false,
        canEnterSession: false, error: (err && err.message) || '加载失败' });
    }
  },

  /**
   * 签表给 WXML 用之前先摊平：WXML 里不能做三元嵌套与数组下标运算，
   * 把「双方是谁、谁是胜者」算好再交给视图，模板才不会写成一团表达式。
   */
  decorateBracket(bracket) {
    if (!bracket) return null;
    return {
      ...bracket,
      matches: (bracket.matches || []).map((match) => ({
        ...match,
        decided: Boolean(match.winnerEntryKey),
        sides: (match.entryKeys || []).map((entryKey, index) => ({
          entryKey: entryKey || '',
          label: entryKey ? ((match.colleges && match.colleges[index]) || entryKey) : '待定',
          winner: Boolean(entryKey) && match.winnerEntryKey === entryKey,
        })),
      })),
    };
  },

  /** 重新拉赛程（抽签、晋级、判胜负之后场次会变） */
  async refreshEvents() {
    try {
      const schedule = await this.client().getMeetSchedule({});
      this.update({
        events: schedule.items.map((row) => this.decorateEvent(row)),
        canManage: Boolean(schedule.canManage),
      });
      return schedule.items;
    } catch (err) {
      this.update({ error: (err && err.message) || '刷新赛程失败' });
      return this.data.events;
    }
  },

  // ---------- 裁判：录分 ----------

  async onOpenSession(event) {
    if (this.data.busy) return;
    const sessionKey = event.currentTarget.dataset.sessionKey;
    return this.openSession(sessionKey);
  },

  async openSession(sessionKey, judgeId = '') {
    if (!sessionKey) return undefined;
    this.update({ busy: true, error: '', notice: '', activeEventKey: '', preview: null });
    try {
      let result = await this.client().getMeetSessionScores({ sessionKey, judgeId });
      const judges = (result.session && result.session.judges) || [];
      if (this.data.canManage && !judgeId && judges.length) {
        judgeId = judges[0].judgeId;
        result = await this.client().getMeetSessionScores({ sessionKey, judgeId });
      }
      this.update({
        busy: false,
        activeSessionKey: sessionKey,
        scoringJudges: judges,
        scoringJudgeId: judgeId,
        scoringJudgeIndex: Math.max(0, judges.findIndex(row => row.judgeId === judgeId)),
        scoreItems: result.items,
        canEnterSession: Boolean(result.canEnter),
        drafts: Object.fromEntries(result.items.map(row => [row.entryKey, row.myScore ? row.myScore.text : ''])),
        sessionJudgeNames: ((result.session && result.session.judges) || []).map(row => row.name).join('、') || '未指派',
      });
      if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({selector: '#meet-score-editor', duration: 200});
      return this.loadEventSessions(sessionKey, result.session && result.session.eventKey);
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '任务加载失败' });
      return undefined;
    }
  },

  /**
   * 同项目的场次清单。
   *
   * 预赛分组、多枪决赛都会产生多个场次，而它们通常属于同一批裁判。录完一场要能
   * 直接切下一场——退回任务列表再点一次，一个上午要多点几十次。
   */
  async loadEventSessions(sessionKey, eventKey) {
    if (!eventKey) return undefined;
    try {
      const list = await this.client().listMeetEventSessions({ eventKey });
      if (this.unloaded || this.data.activeSessionKey !== sessionKey) return;
      const items = (list.items || []).map((row) => ({
        ...row,
        displayLabel: row.round === 'heat'
          ? `预赛 第 ${row.index} 组`
          : (row.roundLabel || row.round),
      }));
      this.update({
        eventSessions: items,
        sessionIndex: items.findIndex((row) => row.sessionKey === sessionKey),
      });
    } catch (err) {
      if (this.unloaded || this.data.activeSessionKey !== sessionKey) return;
      this.update({ eventSessions: [], sessionIndex: -1 });
    }
    return undefined;
  },

  onPickScoreSession(event) {
    if (this.data.busy) return;
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey || sessionKey === this.data.activeSessionKey) return undefined;
    return this.openSession(sessionKey);
  },

  /** 下一场：录完这场直接过去 */
  onNextSession() {
    if (this.data.busy) return;
    const next = this.data.eventSessions[this.data.sessionIndex + 1];
    if (!next) return undefined;
    return this.openSession(next.sessionKey);
  },

  onPickScoringJudge(event) {
    const row = this.data.scoringJudges[Number(event.detail.value)];
    if (row && !this.data.busy) return this.openSession(this.data.activeSessionKey, row.judgeId);
  },

  onScoreInput(event) {
    const entryKey = event.currentTarget.dataset.entryKey;
    const drafts = { ...this.data.drafts, [entryKey]: event.detail.value };
    this.update({ drafts });
  },

  /** 录入并提交一条：先存草稿再提交，服务端两态分离（D66） */
  async onSubmitScore(event) {
    if (this.data.busy) return;
    const entryKey = event.currentTarget.dataset.entryKey;
    const rawText = (this.data.drafts[entryKey] || '').trim();
    if (!entryKey || !rawText) {
      this.update({ error: '请先填写成绩' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      const sessionKey = this.data.activeSessionKey;
      const judgeId = this.data.scoringJudgeId;
      await this.client().saveMeetJudgeScore({ sessionKey, entryKey, judgeId, rawText, allowResubmit: true });
      await this.client().submitMeetJudgeScore({ sessionKey, entryKey, judgeId });
      this.update({ busy: false, notice: '已提交' });
      const drafts = { ...this.data.drafts };
      await this.openSession(sessionKey, judgeId);
      if (this.data.activeSessionKey === sessionKey) this.update({ drafts });
      return undefined;
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  // ---------- 管理员：预览与发布 ----------

  async onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', activeRoundKey: '', preview: null, voidKeys: [], bracket: null });
      return;
    }
    this.update({ busy: true, error: '', notice: '', activeSessionKey: '', scoreItems: [], bracket: null });
    const item = this.data.events.find((row) => row.eventKey === eventKey);

    // 胜负项目：看签表，不预览分数
    if (item && item.scoreType === 'versus') {
      try {
        const bracket = await this.client().getMeetBracket({ eventKey });
        this.update({
          busy: false, activeEventKey: eventKey, bracket: this.decorateBracket(bracket),
          preview: null, voidKeys: [],
        });
      } catch (err) {
        this.update({ busy: false, error: (err && err.message) || '签表加载失败' });
      }
      return;
    }

    const sessions = (item && item.sessions) || [];
    if (sessions.length === 0) {
      this.update({ busy: false, activeEventKey: eventKey, error: '该项目还没有场次' });
      return;
    }
    // 默认挑决赛：管理员更可能在收尾，而不是在发第一组预赛
    const picked = sessions.find((row) => row.round === 'final') || sessions[0];
    await this.loadPreview(eventKey, picked.sessionKey);
  },

  async loadPreview(eventKey, sessionKey) {
    this.update({ busy: true, error: '' });
    try {
      const preview = await this.client().getMeetResultPreview({ eventKey, sessionKey });
      this.update({
        busy: false,
        activeEventKey: eventKey,
        activeRoundKey: sessionKey,
        preview,
        voidKeys: [],
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '预览失败' });
    }
  },

  /** 切换预赛组 / 决赛 */
  onPickRound(event) {
    const { eventKey, sessionKey } = event.currentTarget.dataset;
    if (!eventKey || !sessionKey) return;
    return this.loadPreview(eventKey, sessionKey);
  },

  onToggleVoid(event) {
    const entryKey = event.currentTarget.dataset.entryKey;
    const list = [...this.data.voidKeys];
    const index = list.indexOf(entryKey);
    if (index >= 0) list.splice(index, 1);
    else list.push(entryKey);
    this.update({ voidKeys: list });
  },

  async onPublish() {
    if (this.data.busy) return;
    const eventKey = this.data.activeEventKey;
    if (!eventKey) return;
    const sessionKey = this.data.activeRoundKey;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const payload = { eventKey, voidEntryKeys: this.data.voidKeys };
      // 胜负项目没有场次概念（整张签表一次发布），数值型必须指明场次
      if (sessionKey) payload.sessionKey = sessionKey;
      const result = await this.client().publishMeetResults(payload);
      const base = result.publication.official
        ? `已发布第 ${result.publication.version} 版`
        : `预赛成绩已发布第 ${result.publication.version} 版（不计学院分）`;
      this.update({ busy: false, notice: result.warning ? `${base}；${result.warning}` : base });
      if (sessionKey) await this.loadPreview(eventKey, sessionKey);
      return undefined;
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
      return undefined;
    }
  },

  async onPublishAll() {
    if (this.data.busy) return;
    this.update({ busy: true, error: '', notice: '' });
    const published = [];
    const failed = [];
    try {
      // 每个项目单独调用，避免整届评分放在单次云函数内超时或超过事务预算。
      const existing = await this.client().listMeetPublishedResults({ metadataOnly: true });
      const done = new Set((existing.items || []).flatMap(row => row.rounds.map(round => `${row.eventKey}|${round.sessionKey}`)));
      for (const item of this.data.events) {
        const targets = item.scoreType === 'versus' || item.rounds === 'final'
          ? [{ sessionKey: '', roundLabel: '全部' }]
          : item.sessions;
        if (!targets.length) failed.push(`${item.name}：还没有场次`);
        for (const target of targets) {
          if (target.sessionKey ? done.has(`${item.eventKey}|${target.sessionKey}`)
            : (existing.items || []).some(row => row.eventKey === item.eventKey && row.rounds.some(round => round.official))) continue;
          try {
            await this.client().publishMeetResults({ eventKey: item.eventKey, sessionKey: target.sessionKey });
            published.push(item.name);
          } catch (err) {
            failed.push(`${item.name} ${target.roundLabel || ''}：${err.message || '发布失败'}`);
          }
        }
      }
      this.update({ notice: `已发布 ${published.length} 份成绩`, error: failed.length ? `已发布 ${published.length} 份；以下未发布：\n${failed.join('\n')}` : '' });
    } catch (err) {
      this.update({ error: err.message || '读取发布状态失败' });
    } finally {
      this.update({ busy: false });
    }
  },

  // ---------- 管理员：晋级（分组/签表在赛程编排页完成） ----------

  async onAdvance(event) {
    if (this.data.busy) return;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().advanceMeetEvent({ eventKey });
      await this.refreshEvents();
      this.update({ busy: false, notice: `${result.entryKeys.length} 人晋级决赛` });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '晋级失败' });
    }
  },

  /** 判定一场胜负：把胜者写进签表，服务端自动往上推进 */
  async onSetWinner(event) {
    if (this.data.busy) return;
    const { sessionKey, entryKey } = event.currentTarget.dataset;
    if (!sessionKey || !entryKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const changed = await this.client().setMeetMatchWinner({ sessionKey, winnerEntryKey: entryKey });
      const bracket = await this.client().getMeetBracket({
        eventKey: this.data.activeEventKey,
      });
      await this.refreshEvents();
      this.update({ busy: false, bracket: this.decorateBracket(bracket), notice: changed.expanded ? '同分出线已扩充签表，请到赛程页安排新增场次的时间、场地和裁判' : '胜负已记录' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '判定失败' });
    }
  },
}));
