/**
 * 小程序入口文件
 * ============================================================
 * 职责：
 *   1. 初始化云开发环境（仅在使用云端数据源时需要）
 *   2. 提供全局数据与全局方法
 *   3. 处理全局错误与未捕获的 Promise 异常
 * ============================================================
 */

const { STORAGE_KEY, DATA_SOURCE } = require('./shared/utils/constants.js');
const { CLOUD_ENV_ID } = require('./config.js');
const { defaultAssociationId } = require('./shared/utils/associations.js');
const { LEGACY_SCHOOL_ID } = require('./shared/utils/school.js');
const runtime = require('./services/runtime-mode.js');
const associationScope = require('./services/association-scope.js');
const appSession = require('./services/app-session.js');
const privacy = require('./services/privacy.js');

App({
  /**
   * 全局数据。页面通过 getApp().globalData 访问。
   * 注意：globalData 仅在内存中，小程序被销毁后清空。
   * 需要持久化的数据请使用 wx.setStorageSync。
   */
  globalData: {
    /** 当前数据源模式：'mock' 或 'cloud' */
    dataSource: DATA_SOURCE.MOCK,

    /** 云开发环境 ID。来源见 config.js，启动时由 initDataSource 填入 */
    cloudEnvId: CLOUD_ENV_ID,

    /** 当前登录用户信息，未登录时为 null */
    userInfo: null,

    /** 系统信息（状态栏高度等），在 onLaunch 中采集 */
    systemInfo: null,

    /** 当前协会 id，启动时由 initAssociation 复位。空串表示尚未设定 */
    association: '',
  },

  onLaunch() {
    // 隐私授权桥要在任何页面渲染之前接好：用户第一次点「换头像」时，
    // 拦截回调必须已经有主，否则那次调用会静默失败（界面上就是点了没反应）
    this.initPrivacyBridge();
    this.initSystemInfo();
    this.initDataSource();
    // 协会要在任何数据读取之前定下来：refreshSession 要按它读会员台账
    this.initAssociation();
    this.restoreUserInfo();
    // 故意不 await：启动流程不该被一次网络往返拖住。校正结果落在
    // globalData 上，下一次页面 onShow 读全局登录态时就会体现出来。
    // 定协会排在后面串起来（不是并发）：当前协会是模块级单例，翻协会读要
    // 一个一个来，若与 refreshSession 的读并发，会互相读到对方切到的协会
    this.refreshSession().then(() => this.syncAssociationForUser());
  },

  /**
   * 采集设备与窗口信息。
   * 用于自定义导航栏、适配刘海屏等场景，后续页面会用到。
   */
  initSystemInfo() {
    try {
      const windowInfo = wx.getWindowInfo();
      const deviceInfo = wx.getDeviceInfo();
      this.globalData.systemInfo = {
        statusBarHeight: windowInfo.statusBarHeight,
        windowWidth: windowInfo.windowWidth,
        windowHeight: windowInfo.windowHeight,
        safeAreaBottom: windowInfo.screenHeight - windowInfo.safeArea.bottom,
        platform: deviceInfo.platform,
      };
    } catch (err) {
      console.error('[app] 获取系统信息失败', err);
    }
  },

  /**
   * 接上隐私授权桥（2026-10-21）。
   *
   * 【为什么必须有这一处】
   * 全项目调用的隐私接口只有一个：`<button open-type="chooseAvatar">`
   * （登录页与编辑资料页各一处）。用户**首次**点它时，微信不会直接给头像，
   * 而是先拦下这次调用，把「挂起凭证」交给 `onNeedPrivacyAuthorization`。
   * 没人接手这个回调，调用就悬着——用户看到的是按钮点下去毫无反应，
   * 既不报错也不弹框。这是最容易误判成「样式问题」的故障。
   *
   * 【为什么只登记、不弹窗】
   * 弹窗是界面，得画在用户看得见的页面上（`components/privacy-gate`）。
   * app 放不了 WXML，所以这里只把凭证转交出去，由组件在页面上接住。
   *
   * 【为什么用特性检测而不是基础库版本号】
   * `onNeedPrivacyAuthorization` 自 2.32.3 起提供。更早的基础库由平台
   * 自己兜底弹窗，页面不必插一手；直接判断函数是否存在，比比对版本号更准。
   */
  initPrivacyBridge() {
    if (!privacy.isSupported()) return;
    wx.onNeedPrivacyAuthorization((resolve) => {
      privacy.request(resolve);
    });
  },

  /**
   * 初始化数据源。
   *
   * 【设计意图】开发初期尚未申请 AppID / 开通云开发时，使用 mock 模式，
   * 全部功能依靠本地模拟数据即可完整跑通，便于界面开发与演示。
   * 拿到环境 ID 填进 config.js 之后，启动即走云端，业务代码无需任何改动。
   *
   * 【为什么要在这里调门面】数据源只有一个开关，就是门面的 setDataSource。
   * 早先这里只改 globalData.dataSource，而门面在模块加载时就把实现绑死了，
   * 于是「切到云端」这件事根本传不到取数路径上——开关看着有，其实没接线。
   * 现在云环境就绪与否在这里判定，判定结果亲手交给门面。
   *
   * 【失败为什么仍标记为 MOCK】环境 ID 填错或基础库太旧时，走云端会让每个
   * 页面都报「云函数调用失败」。这里保留 MOCK 状态是为了让启动流程继续、
   * 控制台留下明确错误；但 G2b 之后生产包不再内置 Mock/Seed，页面首次读数据
   * 会得到「请配置 CLOUD_ENV_ID」的明确报错，不会再退回一套可完整演示的假数据。
   *
   * 【init 为什么也包一层】init 在参数非法或基础库残缺时会同步抛错。若任它
   * 冒出去，onLaunch 会中断在 setDataSource 之前：门面停在默认的 mock，而
   * globalData 也来不及写——两边对不上，比老老实实退回 mock 更难查。
   */
  initDataSource() {
    const envId = this.globalData.cloudEnvId;
    let target = DATA_SOURCE.MOCK;

    if (envId) {
      if (!wx.cloud) {
        console.error('[app] 当前基础库不支持云开发，请升级至 2.2.3 以上');
      } else {
        try {
          wx.cloud.init({
            env: envId,
            // traceUser 会在云开发控制台的「用户管理」中记录访问用户
            traceUser: true,
          });
          target = DATA_SOURCE.CLOUD;
          console.info('[app] 云开发已初始化，环境：', envId);
        } catch (err) {
          console.error('[app] 云开发初始化失败，退回本地模拟数据', err);
        }
      }
    }

    runtime.setDataSource(target);
    this.globalData.dataSource = target;

    if (target === DATA_SOURCE.MOCK) {
      console.warn('[app] 当前为 MOCK 模式：Mock 数据已在 G2b 剥离出包，真机需在 config.js 填入 CLOUD_ENV_ID 走云端（测试环境由注入提供 Mock）');
    }
  },

  /**
   * 复位「当前协会」为兜底默认协会。
   *
   * 【为什么不读缓存】「我在哪个协会」不再跨启动保留——每次进小程序都按
   * 用户比赛最多的协会重算（见 syncAssociationForUser 与需求整理 §11.1），
   * 所以冷启动只先把一个确定的兜底协会定下来，好让 refreshSession 在任何
   * 数据读取之前有一个作用域可依。
   *
   * 【为什么必须在 refreshSession 之前】校正登录态要按当前协会去读会员台账；
   * 协会没定下来，读到的可能是另一份，校正结果就张冠李戴了。
   *
   * @returns {string} 设定后的协会 id；一个启用协会都没有时为空串
   */
  initAssociation() {
    const target = defaultAssociationId();
    // 一个启用协会都没有：保持未设定，由调用方据空串跳过业务（见 associations.js）
    if (!target) return '';
    return this.setAssociation(target);
  },

  /**
   * 按登录用户定「当前协会」（需求整理 §11.1）。
   *
   * 【默认取比赛最多的协会，不记忆上次选择】每次进小程序都重算：并列最多按
   * 注册表顺序取第一个；该用户无任何比赛（或未登录）回落 defaultAssociationId。
   * 因此这里既不读缓存、也不写缓存。
   *
   * 【为什么失败要吞掉】这只是「进入时落在哪个协会」，不是业务动作。算不出来
   * 就沿用 initAssociation 已经设好的兜底协会，绝不因此中断启动或把人踢出去。
   *
   * @returns {Promise<string>} 最终生效的协会 id
   */
  async syncAssociationForUser() {
    const user = this.getUserInfo();
    let target = '';
    try {
      // 延迟取用：与 refreshSession 里取 auth 一致，避开 app → 服务 → 门面的加载期环
      const { mostPlayedAssociation } = require('./services/association-usage.js');
      target = user ? await mostPlayedAssociation(user._id) : defaultAssociationId();
    } catch (err) {
      console.error('[app] 计算默认协会失败，沿用当前协会', err);
      return this.globalData.association;
    }

    if (target && target !== this.globalData.association) {
      try {
        // 用 applyAssociation 而非 setAssociation：这里要自己等角色重解落定（见下），
        // 不让 setAssociation 再甩一个不等的重解出去
        this.applyAssociation(target);
      } catch (err) {
        console.error('[app] 切换默认协会失败', err);
        return this.globalData.association;
      }
    }

    // 协会定了之后按**新协会**重解本人角色，并显式等它落定——否则首屏读到的
    // 还是 refreshSession 在切换前那个协会里解出的角色（见 refreshViewerRole）
    await this.refreshViewerRole();
    return this.globalData.association;
  },

  /**
   * 切换当前协会。写门面（决定后续读到哪份数据）并回写 globalData。
   * 不做持久化——协会每次启动重算，见 syncAssociationForUser。
   *
   * 切完异步重解本人角色（见 refreshViewerRole）：不阻塞切换本身，切换要立刻
   * 可见；角色校正随后到位，下次设页面读到的权限便是新协会的。
   *
   * @param {string} id 注册表里的已知协会 id
   * @returns {string} 设定后的 id
   * @throws {Error} 未知协会（由 association-scope 抛出）
   */
  setAssociation(id) {
    const next = this.applyAssociation(id);
    if (this.globalData.userInfo) this.refreshViewerRole();
    return next;
  },

  /**
   * 只写门面与 globalData，不动登录态。供 setAssociation（要重解角色）与
   * syncAssociationForUser（自己掌控重解时机）复用，免得同一句写两遍。
   *
   * @param {string} id
   * @returns {string} 设定后的 id
   * @throws {Error} 未知协会（由 association-scope 抛出）
   */
  applyAssociation(id) {
    const next = associationScope.setAssociation(id);
    this.globalData.association = next;
    return next;
  },

  /**
   * 当前协会 id。页面一律通过它读取；globalData 尚未填时回落到会话作用域（+默认）。
   * @returns {string}
   */
  getAssociation() {
    return this.globalData.association || associationScope.getAssociation();
  },

  /**
   * 从本地缓存恢复登录态。
   * 冷启动时避免用户重复授权，提升体验。
   */
  restoreUserInfo() {
    try {
      const cached = wx.getStorageSync(STORAGE_KEY.USER_INFO);
      if (cached && cached._id) {
        this.globalData.userInfo = cached;
      }
    } catch (err) {
      console.error('[app] 读取本地登录态失败', err);
    }
  },

  /**
   * 读取并校正统一会话（B3）。
   *
   * 【为什么从旧栈 login/getMember 换成 S2】
   * 登录态过去整份写在本地缓存，页面只读缓存、从不回查；而 S2 页面的身份与
   * 能力来自 getSchoolIdentitySession。两套并存时，「缓存里是管理员、S2 里是
   * 会员」的分裂状态会一直存在。这里统一以 S2 会话为准：账号、学校身份、
   * 能力布尔量一次取齐，兼容用户对象由 app-session 单一适配器派生。
   *
   * 【失败与「没有账号」分开处理】
   * 会话拉取失败（网络 / 云函数故障）保留本地缓存，不因一次抖动踢人；
   * 服务端明确回答「这个微信身份没有账号」（session.user 为 null）才清本地。
   *
   * 【为什么必须在刷新前绑定学校与协会】
   * 会话的能力按「学校 + 协会」解析，范围不固定时读到的身份可能张冠李戴。
   * 学校取当前浏览学校（缺省回落默认校），协会取当前协会。
   *
   * @returns {Promise<void>}
   */
  async refreshSession() {
    const cached = this.getUserInfo();
    if (!cached) return;

    const startEpoch = appSession.epochNow();
    let dto = null;
    try {
      dto = await this.loadSchoolSession();
    } catch (err) {
      console.error('[app] 校正登录态失败，继续沿用本地缓存', err);
      return;
    }
    // 拉取期间已有更新的会话写入（登录 / 退出 / 切换身份）：丢弃这次旧响应。
    if (appSession.epochNow() !== startEpoch) return;

    if (dto) this.applySchoolSession(dto);
    else this.clearUserInfo();
  },

  /**
   * 从 S2 取齐一份会话（B3）：平台账号 / 学校身份 / 能力布尔量，外加本协会
   * 会员档案（拿学院全名等展示字段）。档案读不到时降级为 null——兼容视图
   * 仍可用会话里的昵称 / 实名 / 性别兜底，不因此中断登录。
   *
   * 学校与协会在调用前绑定（一次操作开始时固定范围，异步等待后不再重读全局）。
   *
   * @returns {Promise<{session: Object, profile: Object|null}|null>}
   *   session.user 为 null（无账号 / 账号停用以外的「无账号」情形）时返回 null
   */
  async loadSchoolSession() {
    const schoolSession = require('./services/school-session.js');
    const identity = require('./services/school-identity.js');
    const space = require('./services/association-space.js');
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    const association = this.getAssociation() || defaultAssociationId();
    const session = await identity.forSchoolIdentity({ schoolId, association }).getSchoolIdentitySession();
    if (!session || !session.user) return null;
    let profile = null;
    try {
      const result = await space.forScope({ schoolId, association }).getSchoolMember({ userId: session.user.userId });
      profile = (result && result.member) || null;
    } catch (err) {
      console.warn('[app] 读取本人会员档案失败，兼容视图降级', err);
    }
    return { session, profile };
  },

  /**
   * 写入统一会话：app-session 落 DTO，「我的学校」随之更新，兼容用户对象
   * 写进 globalData 与本地缓存（未迁移页面仍从这两处读）。
   *
   * @param {Object} dto { session, profile? }
   * @returns {Object|null} 派生出的兼容用户对象
   */
  applySchoolSession(dto) {
    appSession.apply(dto);
    const compat = appSession.buildCompatUser(dto);
    const schoolSession = require('./services/school-session.js');
    if (dto && dto.session && dto.session.user) {
      schoolSession.setHomeSchoolId(dto.session.user.primarySchoolId || '');
    }
    this.setUserInfo(compat);
    return compat;
  },

  /**
   * 切换演示身份（仅本地模拟，B3 §7.2.5）。
   *
   * 【为什么不再只是 school-mock 的一个开关】
   * 过去切身份只改 mock 的 actorId，globalData.userInfo、学校会话、兼容视图
   * 全都原地不动——切完人后「按钮是管理员、提交是会员」的分裂随之而来。
   * 这里切完立即按新身份刷新统一会话：本人学校、当前浏览范围、成员状态、
   * 能力与兼容用户对象一起落定。
   *
   * 【未登录为什么不顺手自动登录】切换演示身份只是演示工具；登录与否仍由
   * 登录页决定。未登录时只校正「我的学校」（浏览范围跟着新身份走），不写登录态。
   *
   * @param {string} id 演示身份编号（school-identity.DEMO_ACTORS 之一）
   * @returns {Promise<Object|null>} 新身份的会话 DTO；无账号时为 null
   */
  async switchDemoActor(id) {
    const identity = require('./services/school-identity.js');
    if (!identity.isMockNow()) throw new Error('云端不可切换模拟身份');
    identity.setDemoActor(id);

    if (!this.isLoggedIn()) {
      // 访客：只校正浏览范围，不自动登录
      const schoolSession = require('./services/school-session.js');
      const dto = await this.loadSchoolSession();
      if (dto) schoolSession.setHomeSchoolId(dto.session.user.primarySchoolId || '');
      return dto;
    }

    const startEpoch = appSession.epochNow();
    const dto = await this.loadSchoolSession();
    if (appSession.epochNow() !== startEpoch) return dto; // 期间有更新的会话写入，丢弃
    if (dto) {
      this.applySchoolSession(dto);
      // 显式等协会校正落定：不 fire-and-forget，否则下一次切身份可能插进
      // 这条链的中间，把新身份的会话写进旧身份的收尾里。
      await this.syncAssociationForUser();
    } else {
      this.clearUserInfo();
    }
    return dto;
  },

  /**
   * 按**当前协会**重解登录者的有效能力并回写会话（B3）。
   *
   * 【为什么切协会后必须重解】协会角色是「协会内」的：同一个人在 A 协会可能
   * 只是普通会员、在 B 协会却是负责人。会话是按切换前那个协会解出的，不重解
   * 就会拿旧协会的能力判权限。这里不换人——只按同一微信身份在当前范围重新
   * 取会话，兼容角色 / 能力随之更新。
   *
   * @returns {Promise<void>}
   */
  async refreshViewerRole() {
    const cached = this.getUserInfo();
    if (!cached || !cached._id) return;
    const startEpoch = appSession.epochNow();
    try {
      const dto = await this.loadSchoolSession();
      if (appSession.epochNow() !== startEpoch) return; // 期间已有更新的会话写入
      if (!dto) return; // 拉取不到就沿用旧快照（与旧行为一致：不因回查为空踢人）
      this.applySchoolSession(dto);
    } catch (err) {
      console.error('[app] 切协会后刷新本人角色失败，沿用旧快照', err);
    }
  },

  /**
   * 保存登录态到内存与本地缓存。
   * @param {Object} userInfo 用户信息对象
   */
  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
    try {
      wx.setStorageSync(STORAGE_KEY.USER_INFO, userInfo);
    } catch (err) {
      console.error('[app] 写入本地登录态失败', err);
    }
  },

  /**
   * 当前登录会员，未登录时为 null。
   * 页面一律通过它读取登录态，不要去翻 wx.getStorageSync——
   * 内存与缓存的同步只发生在 setUserInfo / clearUserInfo 两处。
   * @returns {Object|null}
   */
  getUserInfo() {
    return this.globalData.userInfo || null;
  },

  /** 是否已登录 */
  isLoggedIn() {
    return Boolean(this.globalData.userInfo);
  },

  /**
   * 清除登录态。用户退出登录或账号被禁用时调用。
   *
   * 【为什么连会话与学校范围一起清】退出后若只清 userInfo，统一会话里还留着
   * 上一人的账号 / 能力，「我的学校」还指向上一个人的学校——再进任何页都可能
   * 看到旧管理入口或旧内部台账。这里三处一起复位（B3 §7.2.5）。
   */
  clearUserInfo() {
    this.globalData.userInfo = null;
    try {
      wx.removeStorageSync(STORAGE_KEY.USER_INFO);
      // 【首页快照也要清】（2026-10-23 第三轮 X-14）
      // 小程序存储按「小程序」而不是按微信账号隔离：同一台设备换号后，
      // 首屏会先用上一位用户的快照画一屏（最长 5 分钟），里面的「我报名了」
      // 等个人相关标记会张冠李戴。缓存键与 index.js 共用 STORAGE_KEY.HOME_VIEW。
      wx.removeStorageSync(STORAGE_KEY.HOME_VIEW);
    } catch (err) {
      console.error('[app] 清除本地登录态失败', err);
    }
    appSession.clear();
    require('./services/school-session.js').reset();
  },

  /**
   * 全局错误处理。
   * 上线后可在此处接入错误上报，便于发现线上问题。
   */
  onError(err) {
    console.error('[app] 未捕获的错误：', err);
  },

  /**
   * 未处理的 Promise 异常。
   * 云函数调用返回 Promise，若不 catch 会走到这里。
   */
  onUnhandledRejection({ reason }) {
    console.error('[app] 未处理的 Promise 异常：', reason);
  },
});
