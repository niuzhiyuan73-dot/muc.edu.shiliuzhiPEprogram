/**
 * 我的球队与团队成绩
 * ============================================================
 * 篮球这类团队运动里，个人成绩不是「我的等级分」，而是：
 *   我在哪支队 → 打过哪几届 → 拿过什么名次 → 累计什么数据。
 *
 * 【为什么单开一页，而不是塞进个人主页】
 * 个人主页是按球拍运动建的：拿手项目、等级分、赛季积分、交锋/搭档记录，
 * 全部围绕「我这个人」。团队运动的成绩挂在球队与赛事上，硬塞进去会出现
 * 「等级分 0」这种既不对也没法解释的格子。两套分开，各自说自己的话。
 *
 * 【页面不算数】
 * 场次、胜负、名次、累计数据全由服务端算好（`getMyTeamProfile`），
 * 这里只负责摆出来。页面自己数一遍，两边迟早对不上。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');
const { getSportAdapter } = require('../../shared/sports/registry.js');
const { teamProfileView } = require('../../utils/team-profile-view');

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    /** 服务端下发的整份档案：teams / events / honors / statEvents / totals */
    profile: null,
    /** 累计表里排在前面的几个指标（按页面列顺序） */
    statFields: [
      { field: 'points', label: '得分' },
      { field: 'rebounds', label: '篮板' },
      { field: 'assists', label: '助攻' },
    ],
  },

  onLoad() {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    this.scope = { schoolId, association: associationScope.getAssociation() };
    this.setData({ themeClass: currentThemeClass() });
    return this.refresh();
  },

  /** 从球队详情返回时重取：刚打完的比分可能已发布 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** json 已开启 enablePullDownRefresh：必须给出处理器，否则下拉后动画不会收起 */
  async onPullDownRefresh() {
    try {
      await this.refresh();
    } finally {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh();
    }
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).getMyTeamProfile({});
      if (!result || result.ok !== true) {
        this.setData({ loading: false, error: (result && result.message) || '团队成绩加载失败' });
        return undefined;
      }
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        profile: teamProfileView(result),
        isFootball: getSportAdapter(result.sportFormat)?.view.eventFormMode === 'football',
      });
      return undefined;
    } catch (err) {
      console.error('[my-team-profile] 加载失败', err);
      this.setData({ loading: false, error: '团队成绩加载失败，请下拉重试' });
      return undefined;
    }
  },

  onOpenTeam(event) {
    const { teamid } = event.currentTarget.dataset;
    return wx.navigateTo({ url: `/packageTeam/team-detail/team-detail?teamId=${encodeURIComponent(teamid)}` });
  },

  onOpenEvent(event) {
    const { eventid } = event.currentTarget.dataset;
    return wx.navigateTo({
      url: `/packageTeam/team-event-detail/team-event-detail?eventId=${encodeURIComponent(eventid)}`,
    });
  },
});
