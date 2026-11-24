/**
 * 个人主页的行为层
 * ============================================================
 * 和 member-view.wxml / member-view.wxss 配套：
 *   .wxml 负责长什么样，.wxss 负责好不好看，这里负责怎么用。
 * 「我的」页、个人详情页与他人主页共用这一份，于是切项目、加载更多、
 * 点击对手跳转、重绘曲线这些逻辑都只写一次。
 *
 * 【为什么用工厂函数而不是直接导出一个对象】
 * 几个页面虽然几乎一样，但「看谁的数据」不同：
 *   我的页／个人详情页  永远看当前登录会员
 *   他人主页           看地址栏里的 userId
 * 这点差异通过参数传进来，其余全部共享。
 * ============================================================
 */

const { loadSchoolMemberView, DEFAULT_HISTORY_LIMIT } = require('../services/profile-view.js');
const { applyBranding, themeClassOf } = require('../services/branding.js');
const { activeAssociations } = require('../shared/utils/associations.js');
const scope = require('../services/association-scope.js');
const { renderEloChart } = require('../utils/chart-view.js');

/**
 * 创建一个个人主页的页面配置。
 *
 * @param {Object} [options]
 * @param {Function} [options.resolveUserId] (query) => userId，返回 undefined 表示看自己
 * @param {boolean} [options.localAssociation=false] 是否开启**页面局部**的协会切换。
 *        个人详情页与他人主页要开：页内切换只改本页展示、不写回全局；导航标题与
 *        主题色也随之按该协会套。默认按「页面对应用户比赛最多的协会」起（§11.1）。
 * @returns {Object} 可直接交给 Page() 的配置对象
 */
function createMemberPage(options = {}) {
  const { resolveUserId, localAssociation = false } = options;

  return {
    data: {
      /** 首屏加载中 */
      loading: true,
      /** 加载失败时的提示 */
      error: '',
      /** 是否还有更早的战绩可以加载 */
      hasMore: false,
      /** 当前已加载多少场逐场战绩 */
      historyLimit: DEFAULT_HISTORY_LIMIT,
      /** 切项目时给个淡淡的反馈，避免点了没反应 */
      switching: false,
      /** 页内协会切换：徽章是否显示（仅局部分页、且已登录、且不止一个启用协会） */
      showSwitch: false,
      /** 切换徽章当前值：本页正在看的协会 id */
      switchValue: '',
      /** 页面根节点的协会主题类（本页按页内协会套色，见 §11.7） */
      themeClass: '',
      // 视图模型，形状见 services/profile-view.js。
      // 初值给空对象而不是 null，WXML 里的 {{...view}} 展开才不会出错。
      view: {},
    },

    /**
     * 返回 Promise 是有意为之：小程序并不关心 onLoad 的返回值，
     * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
     */
    onLoad(query) {
      this.userId = resolveUserId ? resolveUserId(query) : undefined;
      return this.refresh();
    },

    /** 下拉刷新：数据都在内存里，重算一遍很快 */
    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /**
     * 重新装载整页数据。
     * @returns {Promise<void>}
     */
    async refresh() {
      try {
        // 页内切换的协会：首屏按「页面对应用户比赛最多的协会」定一次，之后跟着用户点
        if (localAssociation && !this.associationResolved) {
          this.associationResolved = true;
          this.localAssociation = await this.defaultLocalAssociation();
        }
        const association = localAssociation ? this.localAssociation : undefined;

        // B4-c 起个人主页走学校维度：取数客户端一次绑定「浏览学校 + 页内协会」，
        // 异步等待后不重新读全局 scope。任免 / 改分入口统一收进学校身份页，
        // 本页不再按旧栈 role 判权限。
        const schoolSession = require('../services/school-session.js');
        const api = require('../services/association-space.js').forScope({
          schoolId: schoolSession.getSchoolId() || 'muc',
          association: association || scope.getAssociation(),
        });
        const view = await loadSchoolMemberView(api, {
          userId: this.userId,
          project: this.currentProject,
          historyLimit: this.data.historyLimit,
        });

        // 导航栏按当前页内协会套品牌（标题 + 主题色，见 §11.7）
        if (localAssociation) {
          applyBranding(association || scope.getAssociation());
        }

        this.setData(
          {
            loading: false,
            error: '',
            switching: false,
            view,
            showSwitch: localAssociation && this.canSwitchAssociation(),
            switchValue: association || '',
            // 页内协会决定整页配色：本页所属协会的主题类挂到根容器上
            themeClass: themeClassOf(association || scope.getAssociation()),
            // 拿「已加载条数」和「该项目总场次」比，而不是和 historyLimit 比：
            // 后者在总场次恰好等于上限时会多出一个点了没反应的「加载更多」
            hasMore: view.found && Boolean(view.summary) && view.history.length < view.summary.matchCount,
          },
          // 曲线必须等 canvas 渲染出来才能画，所以放在 setData 的回调里
          () => this.drawChart()
        );
      } catch (err) {
        console.error('[member] 加载失败', err);
        this.setData({
          loading: false,
          switching: false,
          error: '数据加载失败，请下拉重试',
        });
      }
    },

    /**
     * 本页默认看哪个协会：该页面对应用户「比赛最多的协会」（§11.1）。
     * 他人主页取被查看者，个人详情页取本人。算不出来就沿用全局当前协会。
     *
     * @returns {Promise<string>}
     */
    async defaultLocalAssociation() {
      const user = this.currentUser();
      const ownerId = this.userId || (user ? user._id : '');
      try {
        // 延迟取用：避开 member-view → association-usage → 门面的加载期环
        const { mostPlayedAssociation } = require('../services/association-usage.js');
        return await mostPlayedAssociation(ownerId);
      } catch (err) {
        console.error('[member] 计算默认协会失败，沿用全局', err);
        return scope.getAssociation();
      }
    },

    /** 页内切换徽章是否显示：只有登录用户、且启用协会不止一个时才给 */
    canSwitchAssociation() {
      return Boolean(this.currentUser()) && activeAssociations().length > 1;
    },

    /**
     * 页内切换协会（个人详情页 / 他人主页）。只改本页展示，**不写回全局**，
     * 退出即失效（§11.1）。整页数据按新协会重取。
     */
    onAssociationChange(event) {
      if (!localAssociation) return undefined;
      const id = event && event.detail ? event.detail.id : '';
      if (!id || id === this.localAssociation) return undefined;

      this.localAssociation = id;
      this.setData({ switching: true });
      return this.refresh();
    },

    /** 把当前项目的分数序列画成曲线 */
    drawChart() {
      const view = this.data.view;
      if (!view || !view.found || view.chart.empty) return;

      renderEloChart(this, {
        values: view.chart.values,
        // 参考线画在入池起点分上，一眼能看出总共涨了多少
        reference: view.chart.startElo,
      });
    },

    /** 切换项目（男单 / 女单 / 双打） */
    onSwitchProject(event) {
      const { project } = event.currentTarget.dataset;
      const shown = this.data.view.activeProject;
      if (!project || project === shown || this.data.switching) return undefined;

      this.currentProject = project;
      this.setData({ switching: true });
      return this.refresh();
    },

    /** 加载更早的战绩 */
    onLoadMore() {
      if (this.data.loading) return undefined;
      this.setData({ historyLimit: this.data.historyLimit + DEFAULT_HISTORY_LIMIT });
      return this.refresh();
    },

    /**
     * 点头卡头像。默认什么都不做——头卡是三个页面共用的，只有「我的」页
     * 需要它跳进个人详情；他人主页点头像不该有反应，详情页里再跳就是自己。
     * 留一个空实现，是为了免去「页面没绑这个方法」的告警。
     */
    onGoProfileDetail() {},

    /**
     * 读取全局登录态。与「我的」页同一套兜底：app 可能还没初始化好。
     * @returns {Object|null}
     */
    currentUser() {
      const app = getApp();
      if (!app) return null;
      if (typeof app.getUserInfo === 'function') return app.getUserInfo();
      return app.globalData ? app.globalData.userInfo : null;
    },

    /**
     * B8 收敛：个人主页的「任免学院 / 协会负责人」「手工改分」入口已移除——
     * 指定权限统一走学校身份页（grantSchoolPermission，能力来自服务器），
     * 改分收尾属 B5 遗留、未在个人主页开放。这里不再保留旧门面的写路径
     * （setCollegeLeader / setAssociationLeader / setMemberElo 走的是协议 1），
     * 模板里对应的入口卡片也一并移除。
     */

    /** 点交锋记录或搭档记录里的人，去看他的主页 */
    onOpenMember(event) {
      const userId = event.currentTarget.dataset.userId;
      const shown = this.data.view.user && this.data.view.user.userId;
      // 别为自己再开一层页面——那只会让人反复点进同一份数据
      if (!userId || userId === shown) return;

      wx.navigateTo({ url: `/packageMember/member/member?userId=${userId}` });
    },
  };
}

module.exports = { createMemberPage };
