const space = require('../../services/association-space');
const { fingerprintOf } = require('../../utils/fingerprint.js');
const associationScope = require('../../services/association-scope');
const schoolSession = require('../../services/school-session');
const { currentThemeClass } = require('../../services/branding');
const { LEGACY_SCHOOL_ID } = require('../../utils/school');
const { resolveRouteId } = require('../../utils/route-query');
const { createReportForm, reportPayload, coverageLabels } = require('../../utils/football-report-form');
const { normalizeFootballReport, normalizeSide, scoreText } = require('../../utils/football-report');
const { reportDifferences } = require('../../utils/interface-view');
const requestId = () => `fb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
Page({
  data: { loading: true, error: '', notice: '', busy: false, form: null, info: null, themeClass: '',
    kindLabels: ['正常完赛', '弃权判定', '中断待裁定'], coverageLabels,
    subLabels: ['未记录', '部分记录（依据赛后报告）', '完整摘要（依据赛后报告）'],
    sideIndex: 0, side: null, showExtra: false, showShootout: false, goalEditor: null, reportFolds: {}, reportDiff: {},
    goalTypes: ['普通进球', '比赛中点球', '直接任意球', '乌龙球'], audit: [], goalRows: [], preview: null },
  onLoad(options = {}) {
    this.unloaded = false;
    this.scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: associationScope.getAssociation() };
    this.matchId = options.matchId || ''; this.lineupOnly = options.lineup === '1';
    this.setData({ themeClass: currentThemeClass() }); return this.refresh();
  },
  async refresh() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      const resolved = await resolveRouteId(this.matchId, async matchId => {
        const data = await space.forScope(this.scope)[this.lineupOnly ? 'getTeamMatchLineup' : 'getTeamMatchStats']({ matchId });
        if (data?.ok) return data; this.failure = data?.message; return null;
      });
      if (this.unloaded || version !== this.loadVersion) return;
      if (!resolved.id || resolved.result.sportFormat !== 'football11') throw new Error(this.failure || '比赛不存在或不是足球赛事');
      this.matchId = resolved.id; const info = resolved.result;
      if (this.lineupOnly) {
        info.lineupOnly = true; info.rosters = {}; info.lineups = {}; info.lineupEditable = {};
        for (const side of info.sides) { info.rosters[side.side] = side.players; info.lineups[side.side] = side.lineup; info.lineupEditable[side.side] = side.editable; }
        info.canEdit = info.sides.some(side => side.editable);
      }
      const form = createReportForm(info); this.requests = {};
      this.setData({ loading: false, info, form, side: form.sides[this.data.sideIndex], audit: info.audit || [],
        preview: null, publishedText: info.publishedReport ? scoreText(info.publishedReport.result) : '尚未发布', notice: '' });
      this.updateGoalRows();
      this.updateStage();
      this.savedForm = fingerprintOf(this.data.form);
      this.updateReportExperience();
    } catch (e) { if (!this.unloaded && version === this.loadVersion) this.setData({ loading: false, info: null, form: null, error: e.message || '加载失败，请重试' }); }
  },
  onUnload() { this.unloaded = true; this.loadVersion = (this.loadVersion || 0) + 1; },
  onToggleSection(event) {
    const section = event.currentTarget.dataset.section;
    if (['result', 'roster'].includes(section)) this.setData({ reportFolds: { ...this.data.reportFolds, [section]: !this.data.reportFolds[section] } });
  },
  updateReportExperience() {
    if (!this.data.form || !this.data.info || this.lineupOnly) return;
    const info = this.data.info;
    const raw = reportPayload(this.data.form);
    const check = normalizeFootballReport(raw, info);
    const dirty = this.savedForm && fingerprintOf(this.data.form) !== this.savedForm;
    const names = Object.fromEntries(this.data.form.sides.flatMap(side => side.players).map(player => [player.userId, player.name]));
    this.setData({ editingState: dirty ? '有未提交改动' : '与已保存内容一致',
      submittedText: info.report ? scoreText(info.report.result) + (info.pending ? ' · 待审核' : ' · 已保存') : '尚未提交',
      validationText: check.ok ? '已通过当前报告字段校验；提交前仍需核对预览。' : check.message,
      reportDiff: dirty ? reportDifferences(info.report, check.ok ? check.value : raw, names) : reportDifferences(info.publishedReport, info.report, names),
      reportDiffTitle: dirty ? '当前编辑相对已提交的变化' : '已提交相对已发布的变化',
      ...(dirty ? { preview: null } : {}) });
  },
  updateStage() {
    const f = this.data.form; const info = this.data.info;
    const tied = f.regulationA !== '' && f.regulationB !== '' && Number(f.regulationA) === Number(f.regulationB);
    const knockout = info.format !== 'round_robin' && f.kindIndex === 0 && tied;
    const showExtra = knockout && info.rules.knockoutTieBreak === 'extra_time_penalties';
    const extraTied = f.extraTimeCompleted && f.extraA !== '' && f.extraB !== '' && Number(f.extraA) === Number(f.extraB);
    const showShootout = knockout && (!showExtra || extraTied);
    this.setData({ showExtra, showShootout,
      ...(!showExtra ? { 'form.extraA': '', 'form.extraB': '', 'form.extraTimeCompleted': false } : {}),
      ...(!showShootout ? { 'form.shootoutA': '', 'form.shootoutB': '', 'form.refereeConfirmed': false } : {}) });
    this.updateReportExperience();
  },
  onInput(event) {
    if (!this.data.info.canEdit || this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['regulationA', 'regulationB', 'halfA', 'halfB', 'extraA', 'extraB', 'shootoutA', 'shootoutB', 'awardedA', 'awardedB', 'note', 'reason'].includes(field)) return;
    this.setData({ [`form.${field}`]: event.detail.value }); this.updateStage();
  },
  onPick(event) {
    if (!this.data.info.canEdit || this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['kindIndex', 'forfeitIndex'].includes(field)) return;
    const value = Number(event.detail.value);
    this.setData({ [`form.${field}`]: value });
    if (field === 'forfeitIndex') this.setData({ 'form.awardedA': value ? '3' : '0', 'form.awardedB': value ? '0' : '3' });
    this.updateStage();
  },
  onSwitch(event) {
    if (!this.data.info.canEdit || this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['extraTimeCompleted', 'refereeConfirmed'].includes(field)) return;
    this.setData({ [`form.${field}`]: event.detail.value === true }); this.updateStage();
  },
  onSide(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (![0, 1].includes(index)) return;
    this.setData({ sideIndex: index, side: this.data.form.sides[index] });
  },
  changeSide(fn) {
    if (!this.data.info.canEdit || this.data.busy) return;
    if (this.lineupOnly && !this.data.info.lineupEditable[this.data.side.key]) return;
    const sides = JSON.parse(JSON.stringify(this.data.form.sides));
    fn(sides[this.data.sideIndex]); this.setData({ 'form.sides': sides, side: sides[this.data.sideIndex] });
    this.updateReportExperience();
  },
  onPlayerFlag(event) {
    const { userid, field } = event.currentTarget.dataset;
    this.changeSide(side => {
      const row = side.players.find(p => p.userId === userid);
      if (!row || !['selected', 'starter', 'appeared', 'goalkeeper'].includes(field)) return;
      row[field] = event.detail.value === true;
      if (field === 'starter' && row.starter) row.appeared = true;
      if (field === 'selected' && !row.selected) { row.starter = false; row.appeared = false; row.goalkeeper = false; }
    });
  },
  onQuickLineup() {
    this.changeSide(side => side.players.forEach((p, i) => { p.selected = i < this.data.info.rules.matchRosterMax;
      p.starter = i < 11 && p.selected; p.appeared = p.starter; p.goalkeeper = i === 0; }));
  },
  onPlayerStat(event) {
    const { userid, field } = event.currentTarget.dataset;
    this.changeSide(side => { const cell = side.players.find(p => p.userId === userid)?.cells.find(c => c.field === field);
      if (cell) cell.value = event.detail.value; });
  },
  onCoverage(event) {
    const field = event.currentTarget.dataset.field; const index = Number(event.detail.value);
    this.changeSide(side => { const cell = side.coverage.find(c => c.field === field); if (cell) cell.index = index; });
  },
  onSubStatus(event) { this.changeSide(side => { side.subIndex = Number(event.detail.value); }); },
  onSubInput(event) { this.changeSide(side => { const cell = side.subCells.find(c => c.field === event.currentTarget.dataset.field); if (cell) cell.value = event.detail.value; }); },
  onIncoming(event) { this.changeSide(side => { side.incomingIds = event.detail.value;
    side.players.forEach(p => { p.incoming = side.incomingIds.includes(p.userId); }); }); },
  onAddGoal() {
    if (!this.data.info.canEdit || this.data.busy) return;
    const players = this.data.side.players.filter(p => p.selected && p.appeared);
    if (!players.length) { this.setData({ notice: '先选择实际出场球员' }); return; }
    this.setData({ goalEditor: { side: this.data.side.key, players,
      scorerLabels: players.map(p => p.name), assistLabels: ['无助攻', ...players.map(p => p.name)],
      scorerIndex: 0, assistIndex: 0, typeIndex: 0, minute: '' } });
  },
  onGoalPick(event) {
    if (!['scorerIndex', 'assistIndex', 'typeIndex'].includes(event.currentTarget.dataset.field)) return;
    this.setData({ [`goalEditor.${event.currentTarget.dataset.field}`]: Number(event.detail.value) });
  },
  onGoalMinute(event) { this.setData({ 'goalEditor.minute': event.detail.value }); },
  onCancelGoal() { this.setData({ goalEditor: null }); },
  onSaveGoal() {
    const g = this.data.goalEditor; if (!g) return;
    const item = { side: g.side, scorerId: g.players[g.scorerIndex].userId,
      assistId: g.assistIndex ? g.players[g.assistIndex - 1].userId : null,
      type: ['normal', 'penalty', 'free_kick', 'own_goal'][g.typeIndex], minute: g.minute };
    if (item.assistId && (item.type !== 'normal' || item.assistId === item.scorerId)) { this.setData({ notice: '助攻不能给自己；仅普通进球可附助攻' }); return; }
    this.setData({ 'form.goalEvents': [...this.data.form.goalEvents, item], goalEditor: null });
    this.updateGoalRows();
  },
  onDeleteGoal(event) {
    if (!this.data.info.canEdit || this.data.busy) return;
    this.setData({ 'form.goalEvents': this.data.form.goalEvents.filter((_, i) => i !== Number(event.currentTarget.dataset.index)) });
    this.updateGoalRows();
  },
  updateGoalRows() {
    const names = new Map(this.data.form.sides.flatMap(s => s.players).map(p => [p.userId, p.name]));
    const types = { normal: '普通进球', penalty: '比赛中点球', free_kick: '直接任意球', own_goal: '乌龙' };
    this.setData({ goalRows: this.data.form.goalEvents.map(g => ({ description:
      `${g.side} 队 · ${names.get(g.scorerId) || '名单球员'} · ${types[g.type]}${g.minute !== '' && g.minute != null ? ` · ${g.minute} 分` : ''}${g.assistId ? ` · 助攻 ${names.get(g.assistId) || '名单球员'}` : ''}` })) });
    this.updateReportExperience();
  },
  async act(action, payload) {
    if (this.data.busy) return;
    const signature = fingerprintOf({ action, payload });
    this.requests = this.requests || {};
    const id = this.requests[signature] || (this.requests[signature] = requestId());
    this.setData({ busy: true, notice: '' });
    try {
      const response = await space.forScope(this.scope)[action]({ ...payload, matchId: this.matchId,
        expectRevision: this.data.info.revision, requestId: id });
      if (!response?.ok) { this.setData({ notice: response?.message || '操作失败，请刷新后重试' }); return; }
      await this.refresh(); this.setData({ notice: response.warnings?.length ? response.warnings.join('；') : '操作成功' });
    } catch (_) { this.setData({ notice: '请求未确认，可重试；重复请求不会再次生效' }); }
    finally { this.setData({ busy: false }); }
  },
  onSubmit() {
    if (!this.data.info.canEdit) return;
    const report = reportPayload(this.data.form);
    if (this.lineupOnly) {
      const key = this.data.side.key;
      const check = normalizeSide(report.sides[key], this.data.info.rosters[key], this.data.info.rules, false);
      if (!check.ok) { this.setData({ notice: check.message }); return; }
      return this.act('saveTeamMatchLineup', { side: key, lineup: report.sides[key] });
    }
    const check = normalizeFootballReport(report, this.data.info);
    if (!check.ok) { this.setData({ notice: check.message }); return; }
    const fingerprint = fingerprintOf({ report, reason: this.data.form.reason });
    if (this.data.preview?.fingerprint !== fingerprint) {
      this.setData({ preview: { fingerprint, scoreText: scoreText(check.value.result), warnings: check.warnings },
        notice: '请核对报告预览；确认后再次点击提交审核。' }); return;
    }
    return this.act('recordTeamMatch', { report, reason: this.data.form.reason });
  },
  onReview(event) {
    if (!this.data.info.canReview) return;
    const current = normalizeFootballReport(reportPayload(this.data.form), this.data.info);
    if (!current.ok || fingerprintOf(current.value) !== fingerprintOf(this.data.info.report)) {
      this.setData({ notice: '表单有未保存改动，请先保存报告或刷新后再审核。' }); return;
    }
    return this.act('publishTeamMatch', { approve: event.currentTarget.dataset.approve === 'true' });
  },
});
