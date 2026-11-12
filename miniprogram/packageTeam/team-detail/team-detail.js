/**
 * 组队：球队详情
 * ============================================================
 * 一页承担四种身份看到的不同内容，靠服务端下发的布尔量切换，页面不自己判权：
 *   · 路人：看名单 + 「申请加入」；
 *   · 队员：看名单 + 「退队」；
 *   · 队长：多出「审批入队」「转让队长」「归档球队」；
 *   · 协会负责人：与队长同权，可接管任何一支队。
 *
 * 所有动作都走服务端校验；页面上的按钮只是「让该看到的人看到」，
 * 不是权限本身（藏按钮挡不住直接调接口）。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');
const { teamSportStrategyFor } = require('../../utils/team-sport-rules.js');
const { safeRouteId } = require('../../utils/route-query.js');

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    teamId: '',
    /** 球队视图（含 canManage / isCaptain / canApply / membershipLabel） */
    team: null,
    /** 名单：队长与管理者能看到待审申请 */
    members: [],
    pendingCount: 0,
    /** 战绩（getTeamRecord）：总胜负 + 历届 + 近期；归档后照样能看 */
    record: null,
    recordSupported: true,
    /** 战绩单独失败不影响球员名单，所以错误只落在这一块 */
    recordError: '',
    /** 动作进行中，防连点 */
    busy: false,
    notice: '',
    noticeError: false,
    /** 院队：候选池与「添加队员」面板（普通球队恒为空、不渲染） */
    collegeTeam: null,
    canPickMembers: false,
    pickOpen: false,
    pickKeyword: '',
    picking: false,
    candidates: [],
    visibleCandidates: [],
    pickedCount: 0,
  },

  onLoad(query = {}) {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    this.scope = { schoolId, association: associationScope.getAssociation() };
    this.setData({
      themeClass: currentThemeClass(),
      teamId: safeRouteId(query.teamId),
    });
    return this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).getTeam({ teamId: this.data.teamId });
      if (!result.ok) {
        this.setData({ loading: false, error: result.message || '球队不存在',
          team: null, members: [], pendingCount: 0 });
        return undefined;
      }
      this.setData({
        loading: false,
        team: result.team,
        members: result.members || [],
        pendingCount: Number(result.pendingCount) || 0,
      });
      // 战绩与名单互不依赖：单独取，失败也不该把整页打成加载失败
      this.loadRecord();
      // 院队要额外拿候选池（本院会员），普通球队不需要
      this.loadCandidates(result.team);
      return undefined;
    } catch (err) {
      console.error('[team-detail] 加载失败', err);
      this.setData({ loading: false, error: '球队加载失败，请稍后重试',
        team: null, members: [], pendingCount: 0 });
      return undefined;
    }
  },

  /**
   * 取球队战绩。
   *
   * 只读、对所有人开放（包括归档球队）——「这支队往年打得怎么样」是公开事实，
   * 与「谁能改这支队的名单」是两件事。
   */
  async loadRecord() {
    if (teamSportStrategyFor(this.scope?.association)?.supportsMatchData === false) {
      this.setData({ recordSupported: false, record: null, recordError: '' });
      return;
    }
    try {
      const result = await space.forScope(this.scope).getTeamRecord({ teamId: this.data.teamId });
      if (!result || result.ok !== true) {
        this.setData({ record: null, recordError: (result && result.message) || '战绩加载失败' });
        return undefined;
      }
      this.setData({ record: result, recordError: '' });
      return undefined;
    } catch (err) {
      console.error('[team-detail] 战绩加载失败', err);
      this.setData({ record: null, recordError: '战绩加载失败，请稍后重试' });
      return undefined;
    }
  },

  /**
   * 院队候选池。
   *
   * 【为什么单独一次请求】
   * 普通球队打开详情不需要「全院会员」这份名单；只有院队的负责人挑人时才用得上。
   * 放在 getTeam 里一起下发，等于每次看任何一支队都要多查一遍会员与在册状态。
   */
  async loadCandidates(team) {
    if (!team || !team.isCollegeTeam) {
      this.setData({ collegeTeam: null, canPickMembers: false, candidates: [], visibleCandidates: [] });
      return undefined;
    }
    try {
      const result = await space.forScope(this.scope).getCollegeTeam({ teamId: this.data.teamId });
      if (!result || result.ok !== true) return undefined;
      const candidates = result.candidates || [];
      this.setData({
        collegeTeam: result.team,
        canPickMembers: Boolean(result.canPickMembers),
        candidates,
        visibleCandidates: this.filterCandidates(candidates, this.data.pickKeyword),
      });
      return undefined;
    } catch (err) {
      console.error('[team-detail] 候选池加载失败', err);
      return undefined;
    }
  },

  filterCandidates(candidates, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return candidates;
    return candidates.filter(row => String(row.name || '').toLowerCase().includes(kw));
  },

  onOpenPick() {
    this.setData({ pickOpen: true, pickKeyword: '', picking: false, pickedCount: 0,
      visibleCandidates: this.filterCandidates(this.data.candidates, '') });
  },

  onClosePick() {
    if (this.data.picking) return undefined;
    this.setData({ pickOpen: false, pickKeyword: '' });
    return undefined;
  },

  onPickKeyword(event) {
    const pickKeyword = String((event.detail && event.detail.value) || '');
    this.setData({ pickKeyword, visibleCandidates: this.filterCandidates(this.data.candidates, pickKeyword) });
  },

  /** 勾选/取消：只改本地候选（inTeam 表示已在队，不可再勾，要移除走名单里的「移出」） */
  onTogglePick(event) {
    const { userid } = event.currentTarget.dataset;
    const candidates = (this.data.candidates || []).map(row => (
      row.userId === userid ? { ...row, picked: !row.picked } : row
    ));
    this.setData({
      candidates,
      pickedCount: candidates.filter(row => row.picked).length,
      visibleCandidates: this.filterCandidates(candidates, this.data.pickKeyword),
    });
  },

  async onSavePick() {
    const picked = (this.data.candidates || []).filter(row => row.picked).map(row => row.userId);
    if (picked.length === 0) {
      this.setData({ notice: '还没有勾选队员', noticeError: true });
      return undefined;
    }
    this.setData({ picking: true });
    try {
      const result = await space.forScope(this.scope)
        .addCollegeTeamMembers({ teamId: this.data.teamId, userIds: picked });
      if (!result.ok) {
        this.setData({ picking: false, notice: result.message || '添加失败', noticeError: true });
        return undefined;
      }
      this.setData({ picking: false, pickOpen: false, pickKeyword: '', pickedCount: 0,
        notice: `已加入 ${result.added} 名队员`, noticeError: false });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-detail] 添加队员失败', err);
      this.setData({ picking: false, notice: '添加失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 负责人把队员移出学院队（成员自己退队走 onLeave） */
  onRemoveMember(event) {
    const { userid } = event.currentTarget.dataset;
    return this.run('removeCollegeTeamMember', { teamId: this.data.teamId, userId: userid }, '已移出学院队');
  },

  /** 统一的写动作包装：防连点 + 失败提示 + 成功后刷新 */
  async run(action, payload, successText) {
    if (this.data.busy) return undefined;
    this.setData({ busy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope)[action](payload);
      if (!result.ok) {
        this.setData({ busy: false, notice: result.message || '操作失败', noticeError: true });
        return undefined;
      }
      this.setData({ busy: false, notice: successText, noticeError: false });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error(`[team-detail] ${action} 失败`, err);
      this.setData({ busy: false, notice: '操作失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onApply() {
    return this.run('applyToJoinTeam', { teamId: this.data.teamId }, '已提交入队申请，等队长审批');
  },

  onApprove(event) {
    const { userid } = event.currentTarget.dataset;
    return this.run('reviewTeamMember', { teamId: this.data.teamId, userId: userid, approve: true }, '已通过入队申请');
  },

  onReject(event) {
    const { userid } = event.currentTarget.dataset;
    return this.run('reviewTeamMember', { teamId: this.data.teamId, userId: userid, approve: false }, '已拒绝该申请');
  },

  onLeave() {
    return this.run('leaveTeam', { teamId: this.data.teamId }, '已退队');
  },

  /** 转让队长：二次确认，避免误点把队长交出去 */
  onTransfer(event) {
    const { userid, name } = event.currentTarget.dataset;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
    return new Promise((resolve) => {
      wx.showModal({
        title: '转让队长',
        content: `确定把队长转给「${name}」吗？转让后你将变成普通队员。`,
        success: (res) => {
          if (!res.confirm) { resolve(undefined); return; }
          this.run('transferTeamCaptain', { teamId: this.data.teamId, userId: userid }, `已把队长转给 ${name}`)
            .then(resolve);
        },
        fail: () => resolve(undefined),
      });
    });
  },

  onArchive() {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
    return new Promise((resolve) => {
      wx.showModal({
        title: '归档球队',
        content: '归档后不再接受入队与报名，历史成绩仍可查询。确定归档吗？',
        success: (res) => {
          if (!res.confirm) { resolve(undefined); return; }
          this.run('archiveTeam', { teamId: this.data.teamId }, '球队已归档')
            .then(() => { if (typeof wx.navigateBack === 'function') wx.navigateBack(); resolve(undefined); });
        },
        fail: () => resolve(undefined),
      });
    });
  },
});
