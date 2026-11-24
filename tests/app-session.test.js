/**
 * 启动时的会话校正（B3：登录与会话统一）
 * ============================================================
 * 旧版守的是一个真实踩过的坑：登录态在注册那一刻整份写进本地缓存，页面
 * 只读缓存、从不回查，后台审核通过后客户端永远停在「待审核」。
 *
 * B3 之后，启动校正不再走旧栈 login/getMember，而是统一走 S2 的
 * getSchoolIdentitySession：账号、学校身份、能力布尔量一次取齐，兼容用户
 * 对象由 app-session 单一适配器派生。这里守的是：
 *
 *   1. 启动用 S2 会话覆盖本地缓存（角色 / 状态 / 学校随之校正）；
 *   2. 服务端明确「没有这个账号」才清本地，故障保留缓存；
 *   3. mock 下按当前演示身份校正（改演示身份即换人）；
 *   4. 切换演示身份后登录态、兼容视图、浏览范围一起刷新（B3 §7.2.5）；
 *   5. 退出登录把统一会话与学校范围一起清掉。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const runtime = require('../miniprogram/services/runtime-mode.js');
const associationScope = require('../miniprogram/services/association-scope.js');
const appSession = require('../miniprogram/services/app-session.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const schoolMock = require('../src/mock/school-mock.js');
const { resolveAuthState } = require('../src/shared/services/auth.js');
// 原常量住在 protocol-1 mock.js（P10 删）；演示身份编号约定不变
const DEFAULT_CURRENT_USER_ID = 'u06';
const { defaultAssociationId } = require('../src/shared/utils/associations.js');
const { DATA_SOURCE, STORAGE_KEY, ROLE, USER_STATUS } = require('../src/shared/utils/constants.js');

/* ============================================================
 * 最小小程序运行环境
 * ============================================================ */

/** 假的 wx.setStorageSync / getStorageSync 后端 */
let storage = {};

/** wx.cloud.callFunction 的返回值（按 action 分发），以及被调用的次数与序列 */
let cloudResults = {};
let cloudCalls = 0;
let cloudActions = [];

global.wx = {
  getWindowInfo: () => ({
    statusBarHeight: 20,
    windowWidth: 375,
    windowHeight: 667,
    screenHeight: 667,
    safeArea: { bottom: 667 },
  }),
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value;
  },
  removeStorageSync: (key) => {
    delete storage[key];
  },
  cloud: {
    init: () => {},
    callFunction: async (options) => {
      cloudCalls += 1;
      cloudActions.push(options && options.data ? options.data.action : '');
      const result = cloudResults[options.data.action] || cloudResults['*'] || { ok: true, data: null };
      return { result };
    },
  },
};

/** 收集 app.js 注册的配置 */
let appConfig = null;
global.App = (config) => {
  appConfig = config;
};

require('../miniprogram/app.js');

/* ============================================================
 * 用例脚手架
 * ============================================================ */

/** 一名刚注册、还没通过审核的会员（旧栈缓存形状） */
function pendingMember() {
  return {
    _id: 'u_3f2a',
    nickName: '马小雨',
    realName: '马小雨',
    role: ROLE.MEMBER,
    status: USER_STATUS.PENDING,
  };
}

/** 组装一份 S2 会话（getSchoolIdentitySession 的返回形状） */
function sessionDto(overrides = {}) {
  return {
    user: {
      userId: 'u_3f2a',
      nickName: '马小雨',
      realName: '马小雨',
      gender: 'M',
      avatarUrl: '',
      primarySchoolId: 'muc',
      platformStatus: 'active',
    },
    account: { userId: 'u_3f2a', schoolId: 'muc', collegeId: 'c01', studentId: '2023001234', status: 'active' },
    permission: 'schoolAdmin',
    permissionLabel: '校级管理员',
    canManageCollege: true,
    isPlatformAdmin: false,
    canReview: true,
    canManageAssociation: true,
    readOnly: false,
    grants: [],
    message: '',
    ...overrides,
  };
}

/** 让 refreshSession 里的 await 链跑完（setImmediate 排在所有微任务之后） */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 模拟一次冷启动。
 *
 * @param {Object} params
 * @param {string} params.envId 环境 ID。空串即 mock 模式
 */
async function launch({ envId }) {
  appConfig.globalData = {
    dataSource: DATA_SOURCE.MOCK,
    cloudEnvId: envId,
    userInfo: null,
    systemInfo: null,
  };

  appConfig.onLaunch();
  // onLaunch 里 refreshSession 是故意不 await 的，这里补上等待
  await flush();
}

beforeEach(() => {
  storage = {};
  cloudCalls = 0;
  cloudActions = [];
  cloudResults = {};
  // 门面、统一会话、学校范围、S2 演示身份都是模块级单例，用例之间必须复位
  runtime.setDataSource(DATA_SOURCE.MOCK);
  appSession.clear();
  schoolSession.reset();
  schoolMock.reset();
  // 读请求节流器同样是模块级单例：本文件一连十几个用例各发 2~3 次请求，
  // 累计会越过 6/秒的窗口，下文那次 getSchoolIdentitySession 就得等 1 秒——
  // 而用例只 flush 一个 setImmediate 就断言。复位窗口，让每个用例从零开始。
  require('../miniprogram/services/request-pace.js').pacer.reset();
});

/* ============================================================
 * 兼容视图派生（单一适配入口）
 * ============================================================ */

test('buildCompatUser —— 由 S2 会话派生旧栈形状，能力档位映射角色', () => {
  const compat = appSession.buildCompatUser({ session: sessionDto() });
  assert.strictEqual(compat._id, 'u_3f2a');
  assert.strictEqual(compat.role, ROLE.ADMIN, '校管理员映射为管理员');
  assert.strictEqual(compat.status, USER_STATUS.ACTIVE);
  assert.strictEqual(compat.isGlobalAdmin, false);
  assert.strictEqual(compat.realName, '马小雨');
  assert.strictEqual(compat.studentId, '2023001234');

  // 平台管理员：账号级管理员，跨校也按管理员
  const platform = appSession.buildCompatUser({
    session: sessionDto({ permission: '', isPlatformAdmin: true }),
  });
  assert.strictEqual(platform.role, ROLE.ADMIN);
  assert.strictEqual(platform.isGlobalAdmin, true);

  // 学院负责人 → 学院职员；普通会员 → 会员
  assert.strictEqual(
    appSession.buildCompatUser({ session: sessionDto({ permission: 'collegeLeader' }) }).role,
    ROLE.STAFF
  );
  assert.strictEqual(
    appSession.buildCompatUser({ session: sessionDto({ permission: '' }) }).role,
    ROLE.MEMBER
  );

  // 无账号会话 → null；兼容角色只是展示，不该带 S2 之外的授权信息
  assert.strictEqual(appSession.buildCompatUser({ session: { user: null } }), null);
});

test('buildCompatUser —— 状态映射：无身份=待审核、驳回/停用=已禁用、离校=已离校', () => {
  const withStatus = (status) => appSession.buildCompatUser({ session: sessionDto({ account: { status } }) }).status;
  assert.strictEqual(withStatus('active'), USER_STATUS.ACTIVE);
  assert.strictEqual(withStatus('pending'), USER_STATUS.PENDING);
  assert.strictEqual(withStatus('rejected'), USER_STATUS.DISABLED, '已驳回与旧栈 rejectMember 同口径');
  assert.strictEqual(withStatus('left'), USER_STATUS.LEFT);
  assert.strictEqual(appSession.buildCompatUser({ session: sessionDto({ account: null }) }).status, USER_STATUS.PENDING);

  const disabled = appSession.buildCompatUser({
    session: sessionDto({ user: { ...sessionDto().user, platformStatus: 'disabled' } }),
  });
  assert.strictEqual(disabled.status, USER_STATUS.DISABLED);
});

/* ============================================================
 * 云端：启动校正走 S2 会话
 * ============================================================ */

test('启动时用 S2 会话覆盖本地缓存 —— 后台审核通过 / 提权后不必手动重新登录', async () => {
  // 本地缓存里是注册那一刻的快照：待审核、普通会员
  storage[STORAGE_KEY.USER_INFO] = pendingMember();
  cloudResults = { getSchoolIdentitySession: { ok: true, data: sessionDto() } };

  await launch({ envId: 'test-env' });

  assert.ok(
    cloudActions.filter((action) => action === 'getSchoolIdentitySession').length >= 1,
    '云端模式下启动应当回查 S2 会话'
  );
  assert.strictEqual(appConfig.globalData.userInfo.status, USER_STATUS.ACTIVE);
  assert.strictEqual(appConfig.globalData.userInfo.role, ROLE.ADMIN);

  // 缓存也要一起更新：只改内存的话，下次冷启动又退回旧状态
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO].status, USER_STATUS.ACTIVE);

  // 用户看得见的结果：不再被当成待审核，可以录成绩了
  const state = resolveAuthState(appConfig.globalData.userInfo);
  assert.strictEqual(state.isPending, false);
  assert.strictEqual(state.canRecord, true);
});

test('服务端说这个微信身份没有账号时清掉本地会话，而不是留着一个幽灵登录态', async () => {
  storage[STORAGE_KEY.USER_INFO] = { ...pendingMember(), status: USER_STATUS.ACTIVE };
  // 接口正常返回，但会话里没有账号（session.user 为 null）
  cloudResults = { getSchoolIdentitySession: { ok: true, data: { ...sessionDto(), user: null, account: null } } };

  await launch({ envId: 'test-env' });

  assert.strictEqual(appConfig.globalData.userInfo, null);
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO], undefined, '本地缓存也要清掉');
  assert.strictEqual(appSession.get(), null, '统一会话一并清掉');
  assert.strictEqual(resolveAuthState(null).loggedIn, false);
});

test('云端故障时保留本地登录态，不因为一次抖动把人踢下线', async () => {
  const cached = pendingMember();
  storage[STORAGE_KEY.USER_INFO] = cached;
  // 顶层 ok:false 表示基础设施故障，school-cloud 会据此抛错
  cloudResults = { getSchoolIdentitySession: { ok: false, message: '数据库连接失败' } };

  await launch({ envId: 'test-env' });

  assert.ok(cloudCalls >= 1, '故障也得至少试过一次');
  assert.strictEqual(appConfig.globalData.userInfo, cached, '拉取失败应当沿用缓存');
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO], cached);
});

/* ============================================================
 * mock：启动校正按当前 S2 演示身份
 * ============================================================ */

test('mock 模式一次云端请求都不发，缓存里的旧角色被 S2 会话校正', async () => {
  // 登录快照是更早写下的「管理员」；S2 里当前演示身份 u06 只是普通会员。
  // 不回查的话，界面按快照判权限，会员会带着管理员的旧入口。
  storage[STORAGE_KEY.USER_INFO] = {
    _id: DEFAULT_CURRENT_USER_ID,
    nickName: '赵明宇',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
  };
  cloudResults = { getSchoolIdentitySession: { ok: true, data: sessionDto() } };

  await launch({ envId: '' });

  assert.strictEqual(cloudCalls, 0, 'mock 模式不该请求云端');
  const user = appConfig.globalData.userInfo;
  assert.strictEqual(user._id, DEFAULT_CURRENT_USER_ID);
  assert.strictEqual(user.role, ROLE.MEMBER, '角色应被 S2 会话里的实际档位覆盖');
  assert.strictEqual(user.isGlobalAdmin, false);
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO].role, ROLE.MEMBER, '缓存同步更新');
});

test('mock 模式改了「当前演示账号」，启动会把旧演示账号换成新那位', async () => {
  // 缓存里是上一次演示用的另一个种子会员（u03）；当前 S2 演示身份跟随
  // mock.js 的 DEFAULT_CURRENT_USER_ID（u06）。这正是切换演示身份要能换人的场合。
  const otherDemo = {
    _id: 'u03',
    nickName: '李思远',
    realName: '李思远',
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  assert.notStrictEqual(otherDemo._id, DEFAULT_CURRENT_USER_ID, '前提：缓存里不是当前演示账号');
  storage[STORAGE_KEY.USER_INFO] = otherDemo;

  await launch({ envId: '' });

  const user = appConfig.globalData.userInfo;
  assert.strictEqual(cloudCalls, 0, 'mock 模式不该请求云端');
  assert.strictEqual(user._id, DEFAULT_CURRENT_USER_ID, '应整体切到当前演示身份');
  assert.strictEqual(
    storage[STORAGE_KEY.USER_INFO]._id,
    DEFAULT_CURRENT_USER_ID,
    '缓存同步成新那位，下次冷启动才不会再退回旧的'
  );
});

test('mock 模式旧栈本地注册账号的残留缓存，被 S2 当前演示身份覆盖', async () => {
  // 旧流程 registerMember 写出的本地账号重启后不在 S2 里；B3 之后注册走 S2，
  // 不会再产生这种账号。残留缓存按「过期快照」处理：切到当前演示身份。
  const cached = pendingMember(); // _id 'u_3f2a'，S2 里不存在
  storage[STORAGE_KEY.USER_INFO] = cached;

  await launch({ envId: '' });

  const user = appConfig.globalData.userInfo;
  assert.strictEqual(user._id, DEFAULT_CURRENT_USER_ID, '残留缓存不应挡住当前演示身份');
  assert.strictEqual(user.status, USER_STATUS.ACTIVE);
});

test('本地没有登录态时不发起校正请求', async () => {
  await launch({ envId: 'test-env' });

  assert.strictEqual(cloudCalls, 0, '没登录就没有可校正的东西');
  assert.strictEqual(appConfig.globalData.userInfo, null);
  assert.strictEqual(appSession.get(), null);
});

/* ============================================================
 * 切换演示身份 / 退出（B3 §7.2.5 / §7.3）
 * ============================================================ */

test('切换演示身份后登录态、兼容视图与学校范围一起刷新', async () => {
  storage[STORAGE_KEY.USER_INFO] = {
    _id: DEFAULT_CURRENT_USER_ID,
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  await launch({ envId: '' });

  await appConfig.switchDemoActor('demo_muc_admin');

  const user = appConfig.globalData.userInfo;
  assert.strictEqual(user._id, 'demo_muc_admin', '兼容视图跟着新身份走');
  assert.strictEqual(user.role, ROLE.ADMIN, '校管理员的兼容角色是管理员');
  assert.strictEqual(schoolSession.getHomeSchoolId(), 'muc', '我的学校随新身份刷新');
  assert.strictEqual(appSession.get().session.user.userId, 'demo_muc_admin', '统一会话是同一份');
});

test('切换演示身份后学院负责人的兼容角色来自 S2 档位', async () => {
  storage[STORAGE_KEY.USER_INFO] = {
    _id: DEFAULT_CURRENT_USER_ID,
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  await launch({ envId: '' });

  await appConfig.switchDemoActor('demo_muc_college_leader');

  const user = appConfig.globalData.userInfo;
  assert.strictEqual(user._id, 'demo_muc_college_leader');
  assert.strictEqual(user.role, ROLE.STAFF, '学院负责人映射为学院职员');
  assert.ok(user.college, '兼容视图带上学院全名（排阵等展示要按它）');
});

test('访客切换演示身份不自动登录，只校正浏览范围', async () => {
  await launch({ envId: '' });

  await appConfig.switchDemoActor('demo_buaa_member');

  assert.strictEqual(appConfig.globalData.userInfo, null, '切换身份不等于登录');
  assert.strictEqual(schoolSession.getHomeSchoolId(), 'buaa', '浏览范围跟着新身份走');
});

test('退出登录把统一会话与学校范围一起清掉', async () => {
  storage[STORAGE_KEY.USER_INFO] = {
    _id: DEFAULT_CURRENT_USER_ID,
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  await launch({ envId: '' });
  assert.ok(appConfig.globalData.userInfo, '前提：已登录');
  assert.strictEqual(schoolSession.getHomeSchoolId(), 'muc');

  appConfig.clearUserInfo();

  assert.strictEqual(appConfig.globalData.userInfo, null);
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO], undefined);
  assert.strictEqual(appSession.get(), null, '统一会话清掉，旧能力不残留');
  assert.strictEqual(schoolSession.getHomeSchoolId(), '', '我的学校不复用上一人的');
  assert.strictEqual(schoolSession.getSchoolId(), '', '浏览学校不复用上一人的');
});

test('切换协会后按新协会重解能力 —— 学院/协会角色不跨协会', async () => {
  // 2026-10-18：旧种子给 u01–u24 落的那批管理角色已撤掉（权限只由演示身份切换器
  // 给出的账号承载），所以这里改用「学院负责人」演示身份：
  // demo_muc_college_leader 在 pkb 是 staff + c02，切到别的协会就是普通会员。
  // 守的仍是同一件事：登录快照里的角色是切协会之前写下的，切换后必须按新协会重解。
  appConfig.globalData = {
    dataSource: DATA_SOURCE.MOCK,
    cloudEnvId: '',
    userInfo: {
      _id: 'demo_muc_college_leader',
      nickName: '学院负责人',
      role: ROLE.MEMBER,
      status: USER_STATUS.ACTIVE,
    },
    systemInfo: null,
  };
  await appConfig.switchDemoActor('demo_muc_college_leader');
  assert.strictEqual(appConfig.globalData.userInfo._id, 'demo_muc_college_leader');

  appConfig.setAssociation('pkb');
  await flush();
  assert.strictEqual(appConfig.globalData.userInfo.role, ROLE.STAFF, 'pkb 里是学院负责人');

  appConfig.setAssociation('tt');
  await flush();
  assert.strictEqual(appConfig.globalData.userInfo.role, ROLE.MEMBER, 'tt 里只是普通会员');
  assert.strictEqual(appConfig.globalData.userInfo.isGlobalAdmin, false, '学院负责人不是全局管理员');

  appConfig.setAssociation('bd');
  await flush();
  assert.strictEqual(appConfig.globalData.userInfo.role, ROLE.MEMBER, 'bd 里也不带学院负责人身份');

  // 复位，别把协会状态漏给后续用例
  appConfig.setAssociation(defaultAssociationId());
});

/* ============================================================
 * 云开发初始化失败
 * ============================================================ */

test('wx.cloud.init 抛错时整份退回 mock，onLaunch 不中断', async () => {
  // 环境 ID 填错或基础库残缺时 init 会同步抛错。若任它冒出去，onLaunch
  // 会中断在 setDataSource 之前：门面停在默认 mock、globalData 没写，
  // 两边对不上。这里守住「抛错也退回 mock，且启动继续走完」。
  const originalInit = global.wx.cloud.init;
  global.wx.cloud.init = () => {
    throw new Error('invalid env');
  };
  try {
    await launch({ envId: 'bad-env' });

    assert.strictEqual(appConfig.globalData.dataSource, DATA_SOURCE.MOCK);
    assert.strictEqual(runtime.getDataSource(), DATA_SOURCE.MOCK);
    assert.strictEqual(cloudCalls, 0, '退回 mock 后不该再调云函数');
    // 启动流程走完了，后面的步骤（采集系统信息）没被跳过
    assert.ok(appConfig.globalData.systemInfo, 'onLaunch 不该中断在 initDataSource');
  } finally {
    global.wx.cloud.init = originalInit;
  }
});

test('基础库没有 wx.cloud 时退回 mock，不抛错', async () => {
  const originalCloud = global.wx.cloud;
  delete global.wx.cloud;
  try {
    await launch({ envId: 'test-env' });

    assert.strictEqual(appConfig.globalData.dataSource, DATA_SOURCE.MOCK);
    assert.strictEqual(runtime.getDataSource(), DATA_SOURCE.MOCK);
  } finally {
    global.wx.cloud = originalCloud;
  }
});

/* ============================================================
 * 当前协会的复位与切换
 * ============================================================
 * 需求整理 §11.1：每次进小程序，中间三个界面默认取「该用户比赛最多的协会」，
 * **不记忆**上次选择。所以协会既不读缓存、也不写缓存——冷启动先落到兜底默认，
 * 等登录态校正完再按本人比赛分布重算一次（见 app.syncAssociationForUser）。
 */

test('未登录时冷启动把协会复位到兜底默认，且不落盘', async () => {
  await launch({ envId: '' });

  assert.strictEqual(associationScope.getAssociation(), defaultAssociationId());
  assert.strictEqual(appConfig.globalData.association, defaultAssociationId());
  // 不记忆上次选择：协会不再持久化，本地不该多出 association 这个键
  assert.ok(!('association' in storage), '协会不该落盘');
});

test('已登录时按「比赛最多的协会」定默认，不认缓存里的旧协会', async () => {
  // 同一个人的登录快照；缓存里还留着别的协会——按 §11.1 应被忽略
  storage[STORAGE_KEY.USER_INFO] = {
    ...pendingMember(),
    _id: DEFAULT_CURRENT_USER_ID,
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  storage.association = 'bd';

  const { mostPlayedAssociation } = require('../miniprogram/services/association-usage.js');
  const expected = await mostPlayedAssociation(DEFAULT_CURRENT_USER_ID);

  await launch({ envId: '' });

  assert.strictEqual(associationScope.getAssociation(), expected, '默认取比赛最多的协会');
  assert.strictEqual(appConfig.globalData.association, expected);
  // 缓存里那条旧协会原封不动：既没读它，也没写回去
  assert.strictEqual(storage.association, 'bd');
});

test('setAssociation 切换会话、不写缓存，未知协会抛错', async () => {
  await launch({ envId: '' });

  const next = appConfig.setAssociation('bd');
  assert.strictEqual(next, 'bd');
  assert.strictEqual(associationScope.getAssociation(), 'bd');
  assert.strictEqual(appConfig.globalData.association, 'bd');
  // 不持久化：切换只在本次会话生效
  assert.ok(!('association' in storage), '协会不该落盘');

  assert.throws(() => appConfig.setAssociation('nope'), /未知的协会 id/);
  // 抛错后仍停在原协会，不落到半个态
  assert.strictEqual(associationScope.getAssociation(), 'bd');
});
