/**
 * 会员主页（看别人）
 * ============================================================
 * 与个人详情页共用同一套界面和行为，唯一区别是从地址栏取 userId。
 *
 * 【为什么单独做一个页面而不是给「我的」页传参】
 * 「我的」挂在 tabBar 上，而 tabBar 页面只能用 wx.switchTab 打开，
 * switchTab 不支持携带查询参数。想从排行榜点进某个人的主页，
 * 就必须有一个普通页面来承载。于是有了这个页面。
 *
 * 【为什么开页内协会切换】他人主页整页内容随页内切换（§11.6）：只想看这个人
 * 在不同协会的数据，不该牵动全局。导航标题与主题色随之按该协会套（§11.7）。
 *
 * 【为什么「设置身份」放在这一页】
 * B8 收敛时把任免入口从个人主页移走、统一到「学校身份」页，结果管理员在排行榜
 * 或成员名录里点开某个人之后无处可点——看到人却设不了身份。这里把入口放回被看
 * 的那个人身上：能力仍由服务端下发（会话 grants），写仍走 grantSchoolPermission，
 * 页面只负责把「点这个人 → 设这一档」接通。
 * ============================================================
 */

const { createMemberPage } = require('../../templates/member-view.js');
const identity = require('../../services/school-identity.js');
const scope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { LEGACY_SCHOOL_ID } = require('../../shared/utils/school.js');

/** 档位中文名：只用于按钮文案，档位清单仍以服务端 grants 为准 */
const PERMISSION_LABEL = {
  schoolAdmin: '校级管理员',
  associationLeader: '协会负责人',
  collegeLeader: '学院负责人',
};

const memberPage = createMemberPage({
  // 取不到 userId 时返回 undefined，行为退化成「看自己」，
  // 总比白屏好——正常路径下这个参数一定存在
  resolveUserId: (query) => (query && query.userId) || undefined,
  // 页内切换协会：整页（等级分/走势/交锋/搭档/赛事名次）随切换，不写回全局
  localAssociation: true,
});

Page({
  ...memberPage,

  data: {
    ...memberPage.data,
    /**
     * 设置身份的入口状态。三者都成立才显示：
     *   canGrant  服务端给了可授予档位（平台管理员三档 / 校级管理员两档 / 协会负责人一档）
     *   isTarget  看的是别人（不能给自己设权限）
     *   label     对方当前档位的中文名，直接展示在卡片上
     */
    identity: { canGrant: false, label: '', grants: [] },
  },

  /** 首屏先按模板取战绩，再补一次「能不能给这个人设身份」（两件事失败互不牵连） */
  async onLoad(query) {
    await memberPage.onLoad.call(this, query);
    this.ready = true;
    return this.loadIdentity();
  },

  /** 当前页正在看的「学校 + 协会」——与模板取数同一套兜底 */
  identityScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: this.localAssociation || scope.getAssociation(),
    };
  },

  /** 会话里的可授予档位 + 被看的人当前档位，一起决定要不要显示入口 */
  async loadIdentity() {
    const target = this.data.view && this.data.view.user;
    if (!target || !target.userId) return undefined;
    let session = null;
    try {
      session = await identity.forSchoolIdentity(this.identityScope()).getSchoolIdentitySession();
    } catch (err) {
      // 未登录 / 无读取权限：不显示入口即可，不该把整个主页拦住
      this.setData({ identity: { canGrant: false, label: '', grants: [] } });
      return undefined;
    }
    const viewerId = session && session.user ? session.user.userId : '';
    const grants = (session && session.grants) || [];
    const isTarget = Boolean(viewerId) && viewerId !== target.userId;
    this.setData({
      identity: {
        canGrant: Boolean(isTarget && grants.length && !session.readOnly),
        label: target.roleLabel || '会员',
        grants,
      },
    });
    return undefined;
  },

  /**
   * 点「设置身份」：按服务端给出的档位列选项，已持有则该档显示「取消」。
   *
   * 与服务端 grantSchoolPermission 同一套语义：不能给自己设、不能改平台管理员，
   * 这两条在服务端仍会再判一次，页面只是不把注定失败的选项摆出来。
   */
  onGrantIdentity() {
    const state = this.data.identity || {};
    const target = this.data.view && this.data.view.user;
    if (!state.canGrant || !target) return undefined;

    const options = [];
    for (const grant of state.grants) {
      // 学院负责人要落到本校有效学院；对方没登记学院时这一档无从指定
      if (grant.permission === 'collegeLeader' && !target.collegeId) continue;
      const holding = target.permission === grant.permission;
      const name = PERMISSION_LABEL[grant.permission] || grant.label;
      options.push({
        permission: grant.permission,
        make: !holding,
        label: holding ? `取消${name}` : `设为${name}`,
      });
    }
    if (!options.length) return undefined;

    // 测试环境没有 wx.showActionSheet：直接走首项，便于断言写入路径
    if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') {
      return this.submitIdentity(target, options[0]);
    }
    return wx.showActionSheet({
      itemList: options.map((option) => option.label),
      success: (res) => {
        const picked = options[res.tapIndex];
        if (picked) this.submitIdentity(target, picked);
      },
    });
  },

  /** 写入一次授权/取消。学院负责人要带对方所在学院，其余档位不带 */
  async submitIdentity(target, option) {
    if (this.submittingIdentity) return undefined;
    this.submittingIdentity = true;
    try {
      const api = identity.forSchoolIdentity(this.identityScope());
      const result = await api.grantSchoolPermission({
        userId: target.userId,
        permission: option.permission,
        make: option.make,
        collegeId: option.permission === 'collegeLeader' ? target.collegeId : '',
      });
      if (!result || result.ok === false) {
        if (wx.showToast) wx.showToast({ title: (result && result.message) || '设置失败', icon: 'none' });
        return undefined;
      }
      if (wx.showToast) wx.showToast({ title: option.make ? '已设置身份' : '已取消身份', icon: 'none' });
      // 重新取一次：对方的档位标签与「取消」选项都要跟着变
      await memberPage.refresh.call(this);
      return this.loadIdentity();
    } catch (err) {
      if (wx.showToast) wx.showToast({ title: (err && err.message) || '设置失败', icon: 'none' });
      return undefined;
    } finally {
      this.submittingIdentity = false;
    }
  },

  /** 从其它页返回时重取：对方的身份可能刚被别处改过 */
  onShow() {
    if (!this.ready) return undefined;
    memberPage.refresh.call(this);
    return this.loadIdentity();
  },
});
