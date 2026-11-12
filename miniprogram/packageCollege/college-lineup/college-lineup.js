/**
 * 学院赛排阵（学院负责人）
 * ============================================================
 * 双方学院各交一份「本大场每个小项谁上」。取数与整形走学校维度（协议 2）：
 * services/school-college-view.js 的 loadCollegeLineupView 把服务端 DTO 整成
 * 旧栈同形，规则在 services/college-lineup.js（纯函数）；写入由协会空间按当前
 * 身份执行。页面只做交互与 setData。
 *
 * 【为什么默认值直接就是「已交 / 沿用上次」】
 * 学院负责人多半只在上一场的基础上换一两个人。若每次进页面都从空白开始，
 * 双打两个人要靠记忆重选一遍，既慢又容易点错。所以视图模型把默认值
 * 备好（own → carried → empty），页面照单渲染即可；用户改完再交。
 *
 * 【为什么超过人数上限在页面就拦】
 * 数据层一定会兜底（validateLineup），但等他点提交才报「最多 2 人」，
 * 中间那几次多余的点选就白费了。这里一超限就退回并提示，改动立等可见。
 *
 * 【为什么未排满不给提交按钮一点就过】
 * D40：不排人不给提交。按钮不置灰，是怕用户不知道差在哪；点下去由
 * 数据层给出「第 N 场还没排满 X 名队员」，比灰按钮更容易纠正。
 * ============================================================
 */

const { loadCollegeLineupView } = require('../../services/school-college-view.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');
const { safeRouteId } = require('../../utils/route-query.js');

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
    /** 视图模型，形状见 services/college-view.js */
    view: {},
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 tieId / eventId / college
   */
  onLoad(query = {}) {
    this.tieId = query.tieId || '';
    this.eventId = query.eventId || '';
    // 替哪一侧排阵：管理员与协会负责人两侧都进得来，由详情页指明；缺省取本人学院
    this.college = safeRouteId(query.college);
    return this.refresh();
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
  },

  /**
   * 本次身份会话。操作者编号用来把「去登录」与「没权限」分开；本人学院编号
   * 供未指定侧时默认替本学院排阵。拿不到就按访客处理，绝不猜一个身份出来。
   */
  async readSession() {
    try {
      return await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
    } catch (err) {
      console.error('[college-lineup] 读取学校身份失败', err);
      return null;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const scope = this.currentScope();
    this.scope = scope;
    const session = await this.readSession();
    const actorId = (session && session.user && session.user.userId) || null;
    const collegeId = (session && session.account && session.account.collegeId) || '';

    try {
      const view = await loadCollegeLineupView(this.tieId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
        eventId: this.eventId,
        // 路由里给了侧就按它，没给则回落到本人学院
        college: this.college,
        collegeId,
      });
      // 采纳装载器探测出的真实编号再用于写：query 在微信开发者工具 / 真机里是
      // 原样透传的（未解码），继续拿路由原值提交排阵会被服务端答「找不到这个大场」
      // （见 utils/route-query.js）。大场编号与它所属的赛事编号都要落回实例。
      if (view.tieId) this.tieId = view.tieId;
      if (view.eventId) this.eventId = view.eventId;
      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[college-lineup] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '排阵页加载失败，请返回重试',
        view: {}, themeClass: currentThemeClass() });
    }
  },

  /* ---------- 选人 ---------- */

  /**
   * 某小项的选人变化。checkbox-group 给出的就是该小项全部已选项。
   * 超过需要人数时整次改动作废并提示，不做「自动挤掉最早那个」——
   * 那样用户会看到别人莫名消失，不如让他自己先取消。
   */
  onTogglePlayer(event) {
    const legNo = Number(event.currentTarget.dataset.legNo);
    const picked = Array.isArray(event.detail.value) ? [...event.detail.value] : [];

    const legs = this.data.view.legs || [];
    const leg = legs.find((item) => Number(item.legNo) === legNo);
    if (!leg) return;

    if (picked.length > leg.need) {
      this.showToast(`第 ${legNo} 场最多只能排 ${leg.need} 名队员`);
      // 把勾选状态还原成改动前：setData 一个等值副本，强制重渲染
      this.setData({ 'view.legs': legs.map((item) => ({ ...item, options: item.options.map((o) => ({ ...o })) })) });
      return;
    }

    const chosen = new Set(picked);
    const names = leg.options.filter((o) => chosen.has(o.memberId)).map((o) => o.name);

    this.setData({
      'view.legs': legs.map((item) => {
        if (Number(item.legNo) !== legNo) return item;
        return {
          ...item,
          options: item.options.map((o) => ({ ...o, checked: chosen.has(o.memberId) })),
          pickedText: names.length > 0 ? names.join('、') : '未排人',
        };
      }),
    });
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (!this.data.view.canSubmit) return undefined;

    const view = this.data.view || {};
    const entries = (view.legs || []).map((leg) => ({
      legNo: leg.legNo,
      players: leg.options.filter((o) => o.checked).map((o) => o.memberId),
    }));

    this.setData({ submitting: true });
    const result = await space.forScope(this.scope || this.currentScope())
      .submitCollegeLineup({ tieId: this.tieId, college: view.college, entries });
    this.setData({ submitting: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '提交失败');
      return undefined;
    }

    this.showToast('排阵已提交', 'success');
    // 留在本页刷新一次：用户可以立刻核对刚交的阵容，要换替补就在原地改
    return this.refresh();
  },

  onBack() {
    wx.navigateBack();
  },
});
