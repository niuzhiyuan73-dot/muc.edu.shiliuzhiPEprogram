/**
 * 个人详情
 * ============================================================
 * 从「我的」页点自己的头像进来。等级分、赛季积分、分数走势、逐场战绩、
 * 交锋记录、搭档记录这些「随协会变化」的细账都收在这里，「我的」页只留
 * 全局身份与跨协会聚合的荣誉（§11.4 / §11.5）。
 *
 * 界面与交互全部来自 templates/member-view（profileDetailView），
 * 本文件只管：「看自己」（不传 userId）、页内协会切换、以及「修改头像」入口。
 * ============================================================
 */

const { createMemberPage } = require('../../templates/member-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');

// 页内切换协会：只切本页，默认「本人比赛最多的协会」，退出即失效（§11.1 / §11.5）
const memberPage = createMemberPage({ localAssociation: true });

Page({
  ...memberPage,
  data: {
    ...memberPage.data,
    /** 开发期在页脚标注数据来源，以免把演示数据当成真实成绩 */
    isMock: false,
  },

  /**
   * 首屏取一次数，取完打个标记，好让 onShow 分得清「第一次显示」与
   * 「从编辑页返回」——后者需要重取，前者不必。
   */
  async onLoad(query) {
    this.setData({ isMock: isMockNow() });
    await memberPage.onLoad.call(this, query);
    this.ready = true;
  },

  /**
   * 从编辑页返回时重取一次，头像/昵称改完立刻反映到头卡。
   * 首次显示不重复取，免得刚进页面就打两次请求。
   *
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    if (this.ready) return this.refresh();
    return undefined;
  },

  /** 修改头像与昵称，复用既有编辑页（实名信息只读） */
  onGoProfileEdit() {
    wx.navigateTo({ url: '/packageMember/profile-edit/profile-edit' });
  },
});
