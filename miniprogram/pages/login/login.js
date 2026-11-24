/**
 * 登录 / 注册（B3：统一走学校维度 S2）
 * ============================================================
 * 三步走，全部在同一页面内切换，不做多页跳转：
 *
 *   entry   入口——微信一键登录（已有账号）或新会员注册
 *   profile 完善信息——姓名、性别（平台账号）+ 学号、学院（学校身份）
 *   pending 提交成功——展示「待审核 / 已通过 / 已驳回」状态
 *
 * 【数据源为什么换成 S2】
 * 旧流程把「登录」「注册」写进旧栈（login/getCurrentUser/registerMember），
 * 而学校维度的页面只认 S2 账号与身份。两套并写会造成「审核页看不到申请、
 * 录分页选不到人」的分裂。这里统一走：
 *
 *   · 一键登录   = getSchoolIdentitySession（凭微信身份取会话）
 *   · 新会员注册 = registerSchoolAccount（凭 OpenID 开平台账号）
 *                + applySchoolMembership（登记学号 / 学院，落学校身份申请）
 *
 * 平台账号（真名 / 性别，跨校不变）与学校身份（学号 / 学院，随学校走）分开，
 * 与迁移清单 §7 的口径一致；手机号学校维度不收，表单不再收集。
 *
 * 【为什么调用 wx.login 拿 code】
 * 云开发环境下，云函数会自动带上调用者的 OpenID，客户端不需要自己换 code；
 * 模拟端由 school-mock 的「当前微信身份」模拟同一件事。
 *
 * 【竞态防护】
 * 每次登录 / 提交都记一次序号；退出、重新加载或更新的请求到达后，旧响应
 * 一律作废（app-session 的 epoch 再挡一层跨入口的竞态）。
 * ============================================================
 */

const { ALL_GENDERS, GENDER_LABEL } = require('../../shared/utils/constants.js');
const { PROFILE_RULES, resolveAuthState } = require('../../shared/services/auth.js');
const { uploadAvatar } = require('../../services/avatar.js');
const identity = require('../../services/school-identity.js');
const appSession = require('../../services/app-session.js');
const associationScope = require('../../services/association-scope.js');
const runtime = require('../../services/runtime-mode.js');

/** 学校身份状态 → 界面文案（与 school-identity 页同口径） */
const STATUS_LABEL = {
  pending: '待审核', active: '正常', rejected: '已驳回', left: '已离校', disabled: '已停用', none: '未入会',
};

/** 取 auth.PROFILE_RULES 里某一条的 test（同一把尺子，不另写校验） */
const ruleOf = (field) => {
  const rule = PROFILE_RULES.find((item) => item.field === field);
  return rule ? rule.test : () => true;
};
const validStudentId = ruleOf('studentId');

Page({
  data: {
    /** 当前步骤：entry / profile / pending */
    step: 'entry',
    /** 注册表单：平台账号（姓名 / 性别 / 昵称 / 头像）+ 学校身份（学号 / 学院） */
    form: {
      nickName: '',
      avatarUrl: '',
      realName: '',
      gender: '',
      studentId: '',
      collegeId: '',
    },
    /** 学院候选来自当前学校的目录：[{ collegeId, name }] */
    colleges: [],
    /** picker 选中项下标，-1 表示还没选 */
    collegeIndex: -1,
    /** 性别候选：值与文案一一对应，picker 只认下标 */
    genderOptions: ALL_GENDERS.map((value) => ({ value, label: GENDER_LABEL[value] })),
    /** 性别 picker 选中项下标，-1 表示还没选 */
    genderIndex: -1,
    /** 性别在输入框里的展示文案 */
    genderText: '',
    /** 各字段的错误提示 */
    errors: {},
    /** 整体错误提示（登录失败、申请被拒等） */
    errorText: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 已登录时展示的账号信息 */
    existing: { loggedIn: false },
    /** 提交成功后展示的身份信息 */
    pending: null,
    isMock: false,
  },

  /**
   * 进入页面：先用全局兼容登录态给入口一个即时画面（避免白屏等异步），
   * 再向 S2 取权威会话校正。返回 Promise 供测试等待首屏落定。
   */
  onLoad() {
    this.unloaded = false;
    this.sessionSeq = 0;
    // 数据源是「调用时取值」的开关，别在 data 初值里冻结一次性的快照
    this.setData({ isMock: runtime.isMockNow(), existing: this.describeCompat(this.currentUser()) });
    return this.loadSession();
  },

  onUnload() {
    this.unloaded = true;
    this.sessionSeq = (this.sessionSeq || 0) + 1;
  },

  /** 从全局登录态里取出当前会员（兼容视图，仅用于入口首帧） */
  currentUser() {
    const app = getApp();
    return app && app.globalData ? app.globalData.userInfo : null;
  },

  /** 身份客户端的绑定范围：学校取当前浏览学校（缺省默认校），协会取当前协会 */
  scope() {
    const schoolSession = require('../../services/school-session.js');
    const app = getApp();
    const association = (app && typeof app.getAssociation === 'function' && app.getAssociation())
      || associationScope.getAssociation() || 'pkb';
    return { schoolId: schoolSession.getSchoolId() || 'muc', association };
  },

  /** 从 S2 会话派生界面要的字段（B3：一个 describe，登录 / 待审核共用） */
  describe(dto) {
    const session = dto && dto.session;
    const user = session && session.user;
    if (!user) {
      return {
        loggedIn: false, status: null, statusLabel: '未登录', roleLabel: '',
        isActive: false, isPending: false, isRejected: false, isDisabled: false,
        needsApplication: false, canRecord: false,
        notice: '登录后可查看自己的等级分、排名与逐场战绩',
        nickName: '', avatarUrl: '', avatarText: '', realName: '', genderText: '',
        studentId: '', college: '',
      };
    }
    const account = session.account;
    const status = account ? account.status : 'none';
    const platformDisabled = user.platformStatus === 'disabled';
    const isActive = status === 'active' && !platformDisabled;
    const isPending = status === 'pending';
    const isRejected = status === 'rejected';
    const isDisabled = platformDisabled || status === 'disabled';
    const isLeft = status === 'left';
    const statusLabel = platformDisabled ? '账号已停用' : (STATUS_LABEL[status] || '身份状态待确认');
    const college = (dto.collegeName || '');

    let notice = '';
    if (isPending) notice = '学校身份正在审核，通过后即可参与活动、录入成绩';
    else if (isRejected) notice = '申请已被驳回，可修改后重新提交';
    else if (isDisabled) notice = '账号已停用，如有疑问请联系管理员';
    else if (isLeft) notice = '已离校：历史记录保留，不可再报名或录入';
    else if (status === 'none') notice = '账号已开通，申请学校身份后即可参与活动';

    const nickName = user.nickName || '';
    return {
      loggedIn: true,
      status, statusLabel,
      roleLabel: session.isPlatformAdmin ? '平台管理员' : (session.permissionLabel || '会员'),
      isActive, isPending, isRejected, isDisabled, isLeft,
      needsApplication: !platformDisabled && (status === 'none' || status === 'rejected'),
      canRecord: isActive,
      notice,
      nickName,
      avatarUrl: user.avatarUrl || '',
      avatarText: (nickName || '会').slice(0, 1),
      realName: user.realName || '',
      genderText: GENDER_LABEL[user.gender] || '',
      studentId: (account && account.studentId) || '',
      college,
    };
  },

  /** 由旧栈形状的兼容用户对象给入口首帧（登录态变化前的即时画面） */
  describeCompat(user) {
    const state = resolveAuthState(user);
    return {
      ...state,
      nickName: user ? user.nickName || '' : '',
      avatarUrl: user ? user.avatarUrl || '' : '',
      avatarText: user ? (user.nickName || '会').slice(0, 1) : '',
      isRejected: false, isLeft: false, needsApplication: false,
    };
  },

  /**
   * 向 S2 取权威会话与学校目录，校正入口卡片与学院候选。
   * @returns {Promise<void>}
   */
  async loadSession() {
    const seq = this.sessionSeq = (this.sessionSeq || 0) + 1;
    const startEpoch = appSession.epochNow();
    const api = identity.forSchoolIdentity(this.scope());
    try {
      const [directory, session] = await Promise.all([
        api.getSchoolDirectory(),
        api.getSchoolIdentitySession(),
      ]);
      if (seq !== this.sessionSeq || this.unloaded) return;
      // 加载期间已有更新的会话写入（登录 / 退出 / 切换身份）：这次旧响应作废
      if (appSession.epochNow() !== startEpoch) return;
      this.api = api;
      const colleges = (directory.colleges || []).map((row) => ({ collegeId: row.collegeId, name: row.name }));
      this.setData({ colleges });
      this.applySessionView(session);
    } catch (err) {
      if (seq !== this.sessionSeq || this.unloaded) return;
      console.error('[login] 读取会话失败', err);
      this.setData({ errorText: '网络异常，请稍后重试' });
    }
  },

  /**
   * 把 S2 会话渲染到入口。「平台账号存在」与「已登录」是两回事（B3 §7.2.2）：
   * 微信身份有账号但全局还是访客时，入口仍给一键登录，不能因此自认为已登录。
   */
  applySessionView(session) {
    const dto = { session, profile: null, collegeName: this.collegeNameOf(session) };
    if (this.currentUser()) {
      // 已在登录态：把 S2 权威会话同步进全局（角色 / 状态 / 学校随之校正）
      this.saveSession(dto);
    }
    const described = this.describe(dto);
    described.loggedIn = Boolean(this.currentUser());
    this.setData({ existing: described });
  },

  /** 学校身份里的学院编号 → 目录里的学院名 */
  collegeNameOf(session) {
    const account = session && session.account;
    if (!account || !account.collegeId) return '';
    const found = (this.data.colleges || []).find((row) => row.collegeId === account.collegeId);
    return found ? found.name : '';
  },

  /** 写入全局登录态：统一会话 + 兼容视图一起落（app.applySchoolSession） */
  saveSession(dto) {
    const app = getApp();
    if (!app) return;
    if (typeof app.applySchoolSession === 'function') {
      app.applySchoolSession(dto);
    } else if (typeof app.setUserInfo === 'function') {
      app.setUserInfo(appSession.buildCompatUser(dto));
    }
  },

  /** 回首页。switchTab 在测试环境里可能没有，做个保护 */
  goHome() {
    if (typeof wx !== 'undefined' && typeof wx.switchTab === 'function') {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  /* ---------- 入口步骤 ---------- */

  /** 微信一键登录（已有账号） */
  async onLogin() {
    if (this.data.submitting) return undefined;

    this.setData({ submitting: true, errorText: '' });
    const seq = this.sessionSeq = (this.sessionSeq || 0) + 1;
    const startEpoch = appSession.epochNow();
    try {
      const api = this.api || identity.forSchoolIdentity(this.scope());
      const session = await api.getSchoolIdentitySession();
      if (seq !== this.sessionSeq || this.unloaded) return undefined;
      // 登录期间有别的会话写入（重复登录 / 退出）：这次结果作废
      if (appSession.epochNow() !== startEpoch) {
        this.setData({ submitting: false });
        return undefined;
      }
      if (!session || !session.user) {
        // 这个微信身份没有账号：不是故障，是引导——他去注册就行
        this.setData({
          submitting: false,
          errorText: '这个微信号还没有账号，请点下面的「新会员注册」',
        });
        return undefined;
      }

      const dto = { session, profile: null, collegeName: this.collegeNameOf(session) };
      this.saveSession(dto);
      const described = this.describe(dto);
      this.setData({ submitting: false, existing: described });

      // 待审核 / 已驳回的账号登进来也没法录成绩，直接停在这一步把话说清楚；
      // 账号停用同样停下。只有正常身份才回首页。
      if (described.isPending || described.isRejected) {
        this.showPending(described);
        return undefined;
      }
      if (described.isDisabled || described.isLeft || described.needsApplication) return undefined;
      this.goHome();
      return undefined;
    } catch (err) {
      // 走到这里是接口真的抛了（断网、环境不可用），与「没有账号」不同，
      // 所以文案也不一样：这种情况重试是有意义的
      if (seq !== this.sessionSeq || this.unloaded) return undefined;
      console.error('[login] 登录失败', err);
      this.setData({ submitting: false, errorText: '网络异常，请稍后重试' });
      return undefined;
    }
  },

  /**
   * 退出登录，回到未登录状态。待审核那一步也能退出，所以必须把 step 一起
   * 退回入口——否则登录态已经清了，界面却还停在「申请已提交」，看着像没退掉。
   * 统一会话、兼容视图与浏览范围由 app.clearUserInfo 一起复位（B3）。
   */
  onLogout() {
    this.sessionSeq = (this.sessionSeq || 0) + 1;
    const app = getApp();
    if (app && typeof app.clearUserInfo === 'function') app.clearUserInfo();
    else if (app && app.globalData) app.globalData.userInfo = null;

    this.setData({ step: 'entry', existing: this.describeCompat(null), errorText: '', submitting: false });
  },

  /** 跳到注册表单 */
  onGoRegister() {
    this.setData({ step: 'profile', errorText: '' });
  },

  /** 从注册表单退回入口 */
  onBackToEntry() {
    this.setData({ step: 'entry', errors: {}, errorText: '' });
  },

  /**
   * 仅本地演示：模拟一台「新微信号」（尚无账号）的设备，用于演示注册闭环。
   * 换微信身份等于换登录人，先清掉现有登录态再切换，避免身份分裂。
   */
  async onSimulateNewWechat() {
    if (!identity.isMockNow()) return undefined;
    this.onLogout();
    identity.simulateNewWechat();
    this.setData({ errorText: '' });
    await this.loadSession();
    return undefined;
  },

  /* ---------- 表单步骤 ---------- */

  /**
   * 用户主动选择的头像。
   *
   * 选完立刻传云存储，换回一个 fileID。微信给的是会话级的临时文件，
   * 直接存进账号的话，重启小程序或者别人看你的主页就只能看到一张坏图。
   * 先挂本地路径是为了预览不用等上传。
   */
  async onChooseAvatar(event) {
    const tempPath = (event.detail && event.detail.avatarUrl) || '';
    if (!tempPath) return undefined;

    this.setData({ 'form.avatarUrl': tempPath });

    const uploaded = await uploadAvatar(tempPath);
    // 上传期间用户又选了一张，这次的结果就作废；上传失败（空串）也留着
    // 临时图继续预览，提交时还会再试一次
    if (uploaded && this.data.form.avatarUrl === tempPath) {
      this.setData({ 'form.avatarUrl': uploaded });
    }
    return undefined;
  },

  /** 通用输入处理：按 data-field 写回对应字段，并顺手清掉该字段的旧错误 */
  onInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;

    const patch = { [`form.${field}`]: event.detail.value };
    // 用户已经在改了，还挂着「请填写姓名」会很烦人
    if (this.data.errors[field]) patch[`errors.${field}`] = '';
    this.setData(patch);
  },

  /** 性别选择 */
  onPickGender(event) {
    const index = Number(event.detail.value);
    const option = this.data.genderOptions[index];
    if (!option) return;
    this.setData({
      genderIndex: index,
      genderText: option.label,
      'form.gender': option.value,
      'errors.gender': '',
    });
  },

  /** 学院选择：候选来自当前学校的目录（每校独立，编号入库） */
  onPickCollege(event) {
    const index = Number(event.detail.value);
    const college = this.data.colleges[index];
    if (!college) return;
    this.setData({
      collegeIndex: index,
      'form.collegeId': college.collegeId,
      'form.college': college.name,
      'errors.college': '',
    });
  },

  /**
   * 提交注册：平台账号 → 学校身份申请 → 会话回显，三步都用 S2 接口。
   *
   * 校验仍是同步的（auth.PROFILE_RULES 同一把尺子），异步的只是落库——
   * 所以提交期间挂上 submitting，既挡住连点，也让按钮显出「提交中」。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;

    // 先做同步表单校验：平台账号字段（姓名 / 性别）与学校身份字段（学号 / 学院）
    const errors = {};
    const form = this.data.form;
    const realName = String(form.realName || '').trim();
    const gender = String(form.gender || '').toUpperCase();
    const studentId = String(form.studentId || '').trim();
    if (!ruleOf('realName')(realName)) errors.realName = '请填写 2~15 个字的真实姓名（中文或字母）';
    if (!ALL_GENDERS.includes(gender)) errors.gender = '请选择性别';
    if (!validStudentId(studentId)) errors.studentId = '学号应为 6~12 位数字';
    if (!form.collegeId) errors.college = '请选择所属学院';
    if (Object.keys(errors).length > 0) {
      this.setData({ errors, errorText: errors.realName || errors.gender || errors.studentId || errors.college });
      return undefined;
    }

    this.setData({ submitting: true, errorText: '', errors: {} });
    const seq = this.sessionSeq = (this.sessionSeq || 0) + 1;
    const startEpoch = appSession.epochNow();
    try {
      // 选头像和点提交之间可能只隔几秒，那次上传未必跑完。这里再确保一次，
      // 免得把一个会话级的临时路径写进账号（已是 fileID 时它原样返回）
      const avatarUrl = await uploadAvatar(this.data.form.avatarUrl);
      const api = this.api || identity.forSchoolIdentity(this.scope());

      // 1. 平台账号：凭微信身份开户（已有账号原样返回，不改写实名）
      const registered = await api.registerSchoolAccount({ profile: {
        realName, gender, nickName: String(form.nickName || '').trim(), avatarUrl,
      } });
      if (!registered.ok) {
        this.setData({
          submitting: false,
          errors: { realName: registered.errors.realName || '', gender: registered.errors.gender || '' },
          errorText: registered.firstError || '注册失败，请重试',
        });
        return undefined;
      }

      // 2. 会话：看当前学校身份——已经是正常会员就不必再申请
      const session = await api.getSchoolIdentitySession();
      const status = session.account && session.account.status;
      if (status !== 'active' && status !== 'left' && status !== 'disabled') {
        // 3. 学校身份申请：登记学号与学院（待审核 / 已驳回可重新提交）
        const applied = await api.applySchoolMembership({ collegeId: form.collegeId, studentId });
        if (!applied.ok) {
          this.setData({ submitting: false, errorText: applied.message || '申请提交失败' });
          return undefined;
        }
      }

      const fresh = await api.getSchoolIdentitySession();
      if (seq !== this.sessionSeq || this.unloaded) return undefined;
      if (appSession.epochNow() !== startEpoch) {
        this.setData({ submitting: false });
        return undefined;
      }
      const dto = { session: fresh, profile: null, collegeName: this.collegeNameOf(fresh) };
      this.saveSession(dto);
      const described = this.describe(dto);
      this.setData({ submitting: false, errors: {}, existing: described });
      this.showPending(described);
      return undefined;
    } catch (err) {
      if (seq !== this.sessionSeq || this.unloaded) return undefined;
      console.error('[login] 注册失败', err);
      this.setData({ submitting: false, errorText: '网络异常，请稍后重试' });
      return undefined;
    }
  },

  /**
   * 展示提交结果。
   *
   * 【标题为什么不能写死成「申请已提交」】
   * 一个微信身份只对应一个账号；已经通过审核的会员再提交一次，服务端会把
   * 现有账号原样返回，学校身份也保持正常。这时还说「申请已提交」就是假话。
   * 所以标题按实际状态给（已驳回也有自己的说法），按钮文案也跟着变。
   */
  showPending(described) {
    const settled = described.isActive;
    let title = '申请已提交';
    let notice = described.notice || '学校身份正在审核，通过后即可参与活动、录入成绩';
    let actionLabel = '先随便逛逛';
    let statusClass = 'tag-warning';
    if (settled) {
      title = '你已经是会员了';
      notice = '这个微信号已经有账号，不必重复注册，直接进首页就行。';
      actionLabel = '进入首页';
      statusClass = 'tag-success';
    } else if (described.isRejected) {
      title = '申请已被驳回';
      notice = described.notice || '申请已被驳回，可修改后重新提交';
    } else if (described.isDisabled) {
      title = '账号已停用';
    }

    this.setData({
      step: 'pending',
      pending: {
        title,
        actionLabel,
        statusClass,
        nickName: described.nickName,
        realName: described.realName,
        genderText: described.genderText,
        studentId: described.studentId,
        college: described.college,
        statusLabel: described.statusLabel,
        notice,
      },
    });
  },

  /** 待审核页上先去看看别的 */
  onGoHome() {
    this.goHome();
  },
});
