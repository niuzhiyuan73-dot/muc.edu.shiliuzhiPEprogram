/**
 * 学院总榜与我的荣誉（B8）
 * ============================================================
 * 一页两件事：学院总榜 + 当前用户在这一届的个人荣誉。
 *
 * 分数不在页面现算：学院总分与荣誉都在**发布成绩的同一个事务里**累加
 * （见 meet-score-service 的 publishMeetResults），这里只读取与排序。
 * 页面要能区分三种状态：还没发布过正式成绩（空）、加载失败、有数据。
 *
 * 名次按竞赛排名（1,2,2,4）由服务端算好，页面不重排——两处各排一遍，
 * 迟早出现「总榜显示第 1、详情显示第 2」。
 * ============================================================
 */

const meet = require('../services/meet.js');
const { updateMeetPage } = require('../utils/meet-ui.js');
const session = require('../../services/school-session.js');

Page({
  data: {
    loading: true,
    error: '',
    schoolId: '',
    meetId: '',
    meetName: '',
    canManage: false,
    published: false,
    board: [],
    // 我的荣誉
    myTotal: 0,
    mySummary: { gold: 0, silver: 0, bronze: 0, points: 0 },
    myHonors: [],
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload();
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    this.unloaded = true;
  },

  onPullDownRefresh() {
    return this.reload().then(() => wx.stopPullDownRefresh());
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  async reload() {
    this.update({ loading: true, error: '' });
    try {
      const board = await this.client().getMeetStandings({ limit: 100 });
      this.update({
        loading: false,
        meetName: board.meetName || '',
        published: board.published,
        board: board.items,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '总榜加载失败' });
      return undefined;
    }
    // 荣誉单独 try：未参赛的人拿不到荣誉是常态，不该让整页报错
    try {
      const mine = await this.client().getMyMeetHonors({ limit: 50 });
      this.update({
        myTotal: mine.total,
        mySummary: mine.summary,
        myHonors: mine.items,
      });
    } catch (err) {
      this.update({ myTotal: 0, myHonors: [] });
    }
    return undefined;
  },

  onOpenDetail() {
    return wx.navigateTo({ url: `/packageMeet/meet-detail/meet-detail?meetId=${this.data.meetId}` });
  },
});
