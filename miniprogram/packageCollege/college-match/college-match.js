/**
 * 学院赛小场录分
 * ============================================================
 * 一场小场就是「某个大场里的第 N 项」。对阵、赛制、上场人都已由排阵锁定，
 * 本页只收一组局分，再按对手确认（M4-2）生效；管理员还可在这里记弃权（M4-7）。
 * 取数与整形走学校维度（协议 2）：services/school-college-view.js 的
 * loadCollegeMatchView 把服务端 DTO 整成旧栈同形；写入由协会空间按当前身份执行
 * （弃权走学院赛自成一档的 forfeitCollegeTieLeg，按学院记）。页面只做交互与 setData。
 *
 * 【为什么赛制写死 11 分制一局一胜】
 * COLLEGE_LEG_FORMAT 定的就是学院赛小场的赛制，不允许现场改——若这里能改，
 * 同一届学院赛的小场就会按不同分制计净胜，大场汇总失去可比性。
 *
 * 【为什么确认按钮要等录完分】
 * 抽签生成的小场没有比分、也没有胜方。没有胜方就确认，回放读到一个空 win
 * 会直接崩（见 match-record.needsScore）。所以只有录出胜方后才给确认入口。
 *
 * 【弃权为什么按学院点，而不是选「谁赢」】
 * 弃权改变的是大场走向：弃权方丢掉这一小项，对手拿分。让管理员直接选「谁赢」
 * 容易把弃权与胜场混为一谈，所以入口写成「XX 学院弃权」，胜方由数据层推。
 * ============================================================
 */

const { loadCollegeMatchView } = require('../../services/school-college-view.js');
const { winnerOf, toScoreRows } = require('../../services/match-entry-view.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

const { pageScope, toast } = require('../../utils/page-helpers.js');

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
    /** 正在处理的按钮标识，防止连点 */
    acting: '',
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 比分输入行 */
    scoreRows: [],
    /** 实时推出来的胜方文案 */
    winnerText: '',
    /** 待提交的比分 */
    form: { scoreA: [''], scoreB: [''] },
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 matchId
   */
  onLoad(query = {}) {
    this.matchId = query.matchId || '';
    return this.refresh();
  },

  /** 从详情页返回时刷新一次，刚录的分与刚确认的结果才在页面上 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 当前「学校 + 协会」范围。读写复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /**
   * 本次身份会话里的操作者编号，只用来把「去登录」与「没权限」分开。
   * 拿不到就按访客处理，绝不猜一个身份出来。
   */
  async currentActorId() {
    try {
      const session = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .getSchoolIdentitySession();
      return (session && session.user && session.user.userId) || null;
    } catch (err) {
      console.error('[college-match] 读取学校身份失败', err);
      return null;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    return toast(title, icon);
  },

  /**
   * 装载整页数据，并把记录里已有的比分回填到输入框。
   * @returns {Promise<void>}
   */
  async refresh() {
    const scope = this.currentScope();
    this.scope = scope;
    const actorId = await this.currentActorId();

    try {
      const view = await loadCollegeMatchView(this.matchId, {
        schoolId: scope.schoolId, association: scope.association, actorId,
      });
      // 采纳装载器探测出的真实编号再用于写与跳转：query 在微信开发者工具 / 真机里
      // 是原样透传的（未解码），继续拿路由原值录分 / 确认 / 撤销会被服务端答
      // 「这场比赛不存在」（见 utils/route-query.js）。跳转只编码一次。
      if (view.matchId) this.matchId = view.matchId;
      // 赛制行数由视图模型定（bestOf），旧的比分按行对齐，缺的补空串
      const bestOf = view.bestOf || 1;
      const scoreA = [];
      const scoreB = [];
      for (let i = 0; i < bestOf; i += 1) {
        scoreA.push(view.scoreA[i] === undefined || view.scoreA[i] === null ? '' : view.scoreA[i]);
        scoreB.push(view.scoreB[i] === undefined || view.scoreB[i] === null ? '' : view.scoreB[i]);
      }
      this.loaded = true;
      this.setData({ loading: false, error: '', view, form: { scoreA, scoreB }, themeClass: currentThemeClass() }, () =>
        this.applyScores()
      );
    } catch (err) {
      console.error('[college-match] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '小场录分页加载失败，请返回重试', themeClass: currentThemeClass() });
    }
  },

  /** 按当前比分推胜方并刷新展示。比分一变就要走这里 */
  applyScores() {
    const { scoreA, scoreB } = this.data.form;
    const { gamePoints, bestOf, collegeA, collegeB } = this.data.view || {};
    const winner = winnerOf(scoreA, scoreB, gamePoints, bestOf);
    const winnerText =
      winner === 'A' ? `${collegeA || 'A 队'} 胜` : winner === 'B' ? `${collegeB || 'B 队'} 胜` : '';
    this.setData({ scoreRows: toScoreRows(scoreA, scoreB), winnerText });
  },

  /* ---------- 录分 ---------- */

  onInputScore(event) {
    const { side, slot } = event.currentTarget.dataset;
    const key = side === 'A' ? 'scoreA' : 'scoreB';
    const scores = [...this.data.form[key]];
    scores[Number(slot)] = event.detail.value;

    this.setData({ form: { ...this.data.form, [key]: scores } }, () => this.applyScores());
  },

  async onSubmit() {
    if (this.data.submitting || !this.data.view.canRecord) return undefined;

    const { scoreA, scoreB } = this.data.form;
    this.setData({ submitting: true });
    let result;
    try {
      result = await space.forScope(this.scope || this.currentScope())
        .submitSchoolMatch({ matchId: this.matchId, scoreA, scoreB });
    } catch (err) {
      this.showToast((err && err.message) || '提交失败，请重试');
      return undefined;
    } finally {
      this.setData({ submitting: false });
    }

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || (result.scoreErrors || [])[0] || result.message)) || '提交失败');
      return undefined;
    }

    this.showToast('已录入，等待对手确认', 'success');
    return this.refresh();
  },

  /* ---------- 确认 ---------- */

  async onConfirm() {
    if (this.data.acting || !this.data.view.canConfirm) return undefined;

    // 确认即最终结算：核对 + 不可撤销提示（交接文档 §4.3）
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认生效',
        content: '确认后成绩立即生效并计入等级分，之后不可撤销、不可修改。确定确认吗？',
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return undefined;

    this.setData({ acting: 'confirm' });
    let result;
    try {
      result = await space.forScope(this.scope || this.currentScope())
        .confirmSchoolMatch({ matchId: this.matchId });
    } catch (err) {
      this.showToast((err && err.message) || '确认失败，请重试');
      return undefined;
    } finally {
      this.setData({ acting: '' });
    }

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '确认失败');
      return undefined;
    }

    this.showToast('已确认，成绩已生效', 'success');
    return this.refresh();
  },

  // 撤销已随 Elo 逐场结算改造取消（确认即最终结算），onRevoke 一并移除

  /* ---------- 弃权（管理员） ---------- */

  async onForfeit(event) {
    const college = event.currentTarget.dataset.college;
    if (!college || this.data.acting || !this.data.view.canForfeit) return undefined;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '记录弃权',
        content: `确认由「${college}」弃权？对手将直接拿到这一小项，且不计个人等级分。`,
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return undefined;

    this.setData({ acting: 'forfeit' });
    let result;
    try {
      // 学院赛弃权按学院记：走自成一档的 forfeitCollegeTieLeg（个人赛那条路明确挡学院赛）
      result = await space.forScope(this.scope || this.currentScope())
        .forfeitCollegeTieLeg({ tieId: this.data.view.tieId, legNo: this.data.view.legNo, college });
    } catch (err) {
      this.showToast((err && err.message) || '记录弃权失败，请重试');
      return undefined;
    } finally {
      this.setData({ acting: '' });
    }

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '记录弃权失败');
      return undefined;
    }

    this.showToast('已记录弃权', 'success');
    return this.refresh();
  },

  onBack() {
    wx.navigateBack();
  },

  /** 改用横屏计分台逐球计分。小项已有比赛编号，直接带过去 */
  onGoLiveScore() {
    if (!this.matchId) return;
    wx.navigateTo({ url: `/packageTeam/live-score/live-score?matchId=${encodeURIComponent(this.matchId)}` });
  },
});
