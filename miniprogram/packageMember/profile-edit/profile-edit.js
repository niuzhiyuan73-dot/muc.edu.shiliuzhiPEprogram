/**
 * 编辑资料（学校维度）
 * ============================================================
 * 只开放昵称与头像两项。真实姓名、性别与学号是入会审核的依据，改不得——
 * 白名单写在 services/profile.js 的 EDITABLE_FIELDS 里，服务端还会再挡一道。
 *
 * 取数与判权全在 services/school-profile-view.js 的学校维度装载器：向身份接口
 * 问会话（我是谁），再向协会空间问自己的会员档案（实名 / 性别 / 学院 / 头像）。
 * 「能改的是谁、不能改的是什么」由服务端把关，页面只做交互与 setData。
 *
 * 头像选择沿用登录页那套微信官方写法（open-type="chooseAvatar" +
 * bindchooseavatar），选完立刻走 uploadAvatar 落云存储；本地模拟没有云存储
 * 可传，原路径返回即可。
 * ============================================================
 */

const { uploadAvatar } = require('../../services/avatar.js');
const { loadSchoolProfileEditView, schoolProfilePatch } = require('../../services/school-profile-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

const { pageScope, toast } = require('../../utils/page-helpers.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock: false,

    /** 没有登录态时的原因（或装载失败），非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 昵称长度上限，交给 maxlength 属性 */
    nicknameMax: 12,

    /** 可改的两项 */
    form: { nickName: '', avatarUrl: '' },
    /** 没有头像时用昵称首字兜底 */
    avatarText: '',

    /** 只读的实名信息，让用户看得到「改的是谁」 */
    realName: '',
    genderText: '',
    studentId: '',

    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏装载完。
   */
  onLoad() {
    this.setData({ isMock: isMockNow() });
    return this.refresh();
  },

  /** 当前「学校 + 协会」范围。保存时复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return pageScope();
  },

  /** 重新装载整页数据 */
  async refresh() {
    const scope = this.currentScope();
    this.scope = scope;
    try {
      const view = await loadSchoolProfileEditView(scope);
      this.setData({ loading: false, ...view, errorText: '' });
    } catch (err) {
      console.error('[profile-edit] 资料装载失败', err);
      this.setData({ loading: false, blockReason: '资料加载失败，请稍后重试' });
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    return toast(title, icon);
  },

  /* ---------- 表单交互 ---------- */

  onInputNickname(event) {
    this.setData({
      'form.nickName': event.detail.value,
      'errors.nickName': '',
      errorText: '',
    });
  },

  /**
   * 选头像。先拿临时路径顶上预览，再传云存储换回 fileID。
   * 上传期间用户又选了一张，这次的结果就作废；上传失败（空串）也留着
   * 临时图继续预览，提交时还会再试一次。
   */
  async onChooseAvatar(event) {
    const tempPath = (event.detail && event.detail.avatarUrl) || '';
    if (!tempPath) return undefined;

    this.setData({ 'form.avatarUrl': tempPath, errorText: '' });

    const uploaded = await uploadAvatar(tempPath);
    if (uploaded && this.data.form.avatarUrl === tempPath) {
      this.setData({ 'form.avatarUrl': uploaded });
    }
    return undefined;
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting || this.data.blockReason) return undefined;

    this.setData({ submitting: true, errors: {}, errorText: '' });

    // 云端调用是会失败的：网络断了、云函数还没更新（「未知的操作」）……
    // 不接住的话 submitting 会一直停在 true，页面看起来就是「点了没反应」，
    // 连个错都不报。这里统一收口，失败也要把按钮放回来。
    const result = await this.save();

    if (!result.ok) {
      this.setData({
        submitting: false,
        errors: result.errors || {},
        errorText: result.firstError || '保存失败',
      });
      this.showToast(result.firstError || '保存失败');
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已保存', 'success');
    wx.navigateBack();
    return undefined;
  },

  /**
   * 真正落库的一步。异常一律转成与业务失败同形的返回值，
   * 调用方只需看 ok / firstError，不必分两套分支。
   *
   * @returns {Promise<{ok:boolean, account:Object|null, errors:Object, firstError:string}>}
   */
  async save() {
    try {
      // 已经是 fileID 的话 uploadAvatar 原样返回，不会重复上传
      const hadAvatar = Boolean(String(this.data.form.avatarUrl || '').trim());
      const avatarUrl = await uploadAvatar(this.data.form.avatarUrl);
      if (hadAvatar && !avatarUrl) {
        return { ok: false, account: null, errors: {}, firstError: '头像上传失败，请检查网络后重试' };
      }
      const patch = schoolProfilePatch({ ...this.data.form, avatarUrl });
      const result = await identity.forSchoolIdentity(this.scope || this.currentScope())
        .updateSchoolProfile({ patch });
      return result && typeof result === 'object' ? result : { ok: false, firstError: '保存失败' };
    } catch (err) {
      console.error('[profile-edit] 保存资料失败', err);
      return { ok: false, account: null, errors: {}, firstError: '保存失败，请检查网络后重试' };
    }
  },

  onCancel() {
    wx.navigateBack();
  },
});
