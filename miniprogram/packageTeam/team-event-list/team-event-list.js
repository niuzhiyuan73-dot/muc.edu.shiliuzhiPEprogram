/**
 * 团队赛事：列表与建赛
 * ============================================================
 * 团队运动的「赛事」页签落地页。与个人赛的赛事页不同，这里一屏只关心三件事：
 *   1. 有哪些赛事、进行到哪一步；
 *   2. 协会负责人建赛（选赛制 + 规则预设，规则当场固化）；
 *   3. 点进去报名、抽签、录分。
 *
 * 【为什么建赛只给两个赛制】
 * 首版后端只支持单败淘汰与循环赛（小组赛要分组、组内循环、出线再接签表，
 * 少一层就排错）。这里不列出「小组赛+淘汰」，避免用户选了之后被后端拒绝。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');
const { RULE_PRESETS, DEFAULT_PRESET_KEY } = require('../../shared/utils/basketball-rules.js');
const { teamSportStrategyFor } = require('../../shared/utils/team-sport-rules.js');
const { CUP_MODE } = require('../../shared/utils/constants.js');

/** 首版支持的赛制：与 team-event-service 的 FORMATS 保持一致 */
const FORMAT_OPTIONS = [
  { value: 'single_elim', label: '单败淘汰' },
  { value: 'round_robin', label: '循环赛' },
];

const PRESET_OPTIONS = Object.keys(RULE_PRESETS).map(key => ({
  value: key,
  label: RULE_PRESETS[key].label,
}));

function nextRequestId() {
  return `tev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    /** 赛事行 */
    events: [],
    canManage: false,
    /** 建赛表单 */
    creating: false,
    isFootball: false,
    submitting: false,
    newName: '',
    formatOptions: FORMAT_OPTIONS,
    formatIndex: 0,
    presetOptions: PRESET_OPTIONS,
    presetIndex: Math.max(0, PRESET_OPTIONS.findIndex(item => item.value === DEFAULT_PRESET_KEY)),
    /** 单败淘汰是否加打 5–8 名排位（8 队及以上生效） */
    placementTop8: false,
    notice: '',
    noticeError: false,
    /**
     * 从石榴籽杯进来时是学院赛（cupMode=college）：建出来的赛事只接受院队报名。
     * 页面只负责把这个标记原样透传给建赛动作，规则、赛制与普通赛事完全一样。
     */
    cupMode: '',
    isCollegeCup: false,
  },

  onLoad(query = {}) {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    // 从杯赛页带项目进来时，先把它写成当前协会，避免沿用上一次留下的协会
    if (query.projectId) {
      try {
        const app = getApp();
        if (app && typeof app.setAssociation === 'function') app.setAssociation(String(query.projectId));
        else associationScope.setAssociation(String(query.projectId));
      } catch (err) {
        associationScope.setAssociation(String(query.projectId));
      }
    }
    const association = associationScope.getAssociation();
    this.scope = { schoolId, association };
    const cupMode = query.cupMode === CUP_MODE.COLLEGE ? CUP_MODE.COLLEGE : '';
    this.setData({ themeClass: currentThemeClass(),
      isFootball: teamSportStrategyFor(association)?.sportFormat === 'football11',
      cupMode,
      isCollegeCup: cupMode === CUP_MODE.COLLEGE });
    // create=1：从杯赛页「发起学院赛」直接落在建赛面板上，少点一次
    if (String(query.create || '') === '1') {
      this.setData({ creating: true });
    }
    return this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).listTeamEvents({});
      if (!result.ok) {
        this.setData({ loading: false, error: result.message || '赛事列表加载失败' });
        return undefined;
      }
      this.setData({
        loading: false,
        events: result.events || [],
        canManage: result.canManage === true,
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-list] 加载失败', err);
      this.setData({ loading: false, error: '赛事列表加载失败，请稍后重试' });
      return undefined;
    }
  },

  onOpenCreate() {
    this.setData({ creating: true, newName: '', placementTop8: false, notice: '', noticeError: false });
  },

  onCloseCreate() {
    if (this.data.submitting) return;
    this.setData({ creating: false, submitting: false });
  },

  onInputName(event) {
    this.setData({ newName: event.detail.value });
  },

  onPickFormat(event) {
    this.setData({ formatIndex: Number(event.detail.value) || 0 });
  },

  onPickPreset(event) {
    this.setData({ presetIndex: Number(event.detail.value) || 0 });
  },

  onTogglePlacement(event) {
    this.setData({ placementTop8: event.detail.value === true });
  },

  async onSubmitCreate() {
    if (this.data.isFootball) return undefined;
    if (this.data.submitting) return undefined;
    this.setData({ submitting: true, notice: '', noticeError: false });
    try {
      const format = FORMAT_OPTIONS[this.data.formatIndex] || FORMAT_OPTIONS[0];
      const preset = PRESET_OPTIONS[this.data.presetIndex] || PRESET_OPTIONS[0];
      const result = await space.forScope(this.scope).createTeamEvent({
        name: this.data.newName,
        format: format.value,
        presetKey: preset.value,
        requestId: nextRequestId(),
        ...(format.value === 'single_elim' && this.data.placementTop8 ? { placementMode: 'top8' } : {}),
        // 普通赛事不带这个字段：请求体里没有杯赛标记，才不会被误读成学院赛
        ...(this.data.cupMode ? { cupMode: this.data.cupMode } : {}),
      });
      if (!result.ok) {
        this.setData({ submitting: false, notice: result.message || '建赛失败', noticeError: true });
        return undefined;
      }
      this.setData({ submitting: false, creating: false, notice: '赛事已创建，可以开始收报名', noticeError: false });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-list] 建赛失败', err);
      this.setData({ submitting: false, notice: '建赛失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onOpenEvent(event) {
    const { eventid } = event.currentTarget.dataset;
    return wx.navigateTo({
      url: `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent(eventid)}`,
    });
  },

  async onFootballSubmit(event) {
    if (!this.data.isFootball || this.data.submitting) return;
    this.setData({ submitting: true, notice: '', noticeError: false });
    try {
      // 足球建赛走表单组件：detail 原样提交，杯赛标记在页面这一层补上
      const result = await space.forScope(this.scope).createTeamEvent({
        ...(event.detail || {}),
        ...(this.data.cupMode ? { cupMode: this.data.cupMode } : {}),
      });
      if (!result || !result.ok) {
        this.setData({ submitting: false, noticeError: true, notice: result?.message || '建赛失败' });
        return;
      }
      this.setData({ submitting: false, creating: false, noticeError: false, notice: '赛事已创建，可以开始收报名' });
      await this.refresh();
    } catch (error) {
      console.error('[team-event-list] 足球建赛失败', error);
      this.setData({ submitting: false, noticeError: true, notice: '建赛失败，请重试' });
    }
  },
});
