/**
 * B3：登录与会话统一的竞态与闭环
 * ============================================================
 * 守的是指南 §7.2.6 / §7.3 的场景：
 *
 *   1. A 的会话请求晚于 B 登录返回，不能把 A 的数据写回；
 *   2. 退出后晚到的请求不能恢复已退出状态；
 *   3. 提交中重复点击不重复开户 / 不重复申请；
 *   4. 登录成功后「我的学校」随之刷新（浏览外校时只读口径正确）；
 *   5. 兼容视图与 S2 写接口是同一个人（切换演示身份后不分裂）。
 * ============================================================
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../miniprogram/services/runtime-mode.js');
const appSession = require('../miniprogram/services/app-session.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const schoolMock = require('../src/mock/school-mock.js');
const schoolIdentity = require('../miniprogram/services/school-identity.js');
const { STORAGE_KEY, ROLE, USER_STATUS } = require('../src/shared/utils/constants.js');

/* ============================================================
 * 最小运行环境：真实 app.js + 登录页，同一个小程序内存
 * ============================================================ */

let storage = {};
global.wx = {
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667, screenHeight: 667, safeArea: { bottom: 667 } }),
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => { storage[key] = value; },
  removeStorageSync: (key) => { delete storage[key]; },
  switchTab: () => {},
};

let appInstance = null;
global.App = (config) => { appInstance = config; };

require('../miniprogram/app.js');

const pages = [];
global.Page = (config) => pages.push(config);
global.getApp = () => appInstance;

require('../miniprogram/pages/login/login.js');
const loginConfig = pages[0];

function makeApp() {
  const instance = {
    ...appInstance,
    globalData: { dataSource: 'mock', cloudEnvId: '', userInfo: null, systemInfo: null, association: '' },
  };
  global.getApp = () => instance;
  return instance;
}

function instantiate(config) {
  const page = {
    data: JSON.parse(JSON.stringify(config.data)),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const path = key.split('.');
        let target = this.data;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (target[path[i]] === null || typeof target[path[i]] !== 'object') target[path[i]] = {};
          target = target[path[i]];
        }
        target[path[path.length - 1]] = value;
      }
    },
  };
  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'function') page[key] = config[key].bind(page);
  }
  return page;
}

function fillValidForm(page) {
  for (const [field, value] of Object.entries({ realName: '马小雨', studentId: '2023001234' })) {
    page.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  page.onPickGender({ detail: { value: 0 } });
  page.onPickCollege({ detail: { value: 0 } });
}

/** 给第 n 次 getSchoolIdentitySession 调用加一道闸门，用于造「慢请求」。 */
function gateSessionCall(identityModule, callIndex) {
  const original = identityModule.forSchoolIdentity;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  identityModule.forSchoolIdentity = (scope) => {
    const api = original(scope);
    return {
      ...api,
      getSchoolIdentitySession: async () => {
        calls += 1;
        if (calls === callIndex) await gate;
        return api.getSchoolIdentitySession();
      },
    };
  };
  return {
    release: () => release(),
    restore: () => { identityModule.forSchoolIdentity = original; },
  };
}

beforeEach(() => {
  storage = {};
  runtime.setDataSource('mock');
  appSession.clear();
  schoolSession.reset();
  schoolMock.reset();
  makeApp();
});

test('慢登录响应不覆盖更新的会话 —— A 晚到不能把 A 的数据写回', async () => {
  const app = makeApp();
  const gate = gateSessionCall(schoolIdentity, 2); // 第 2 次会话读取（onLogin）慢
  const page = instantiate(loginConfig);
  await page.onLoad(); // 第 1 次会话读取，快

  const slow = page.onLogin(); // 第 2 次：被闸门挡住，目标身份是 u06
  // B：期间切换演示身份并用另一页完成登录（u01）
  schoolMock.setDemoActor('u01');
  const pageB = instantiate(loginConfig);
  await pageB.onLoad();
  await pageB.onLogin();

  assert.strictEqual(app.globalData.userInfo._id, 'u01', 'B 登录先行落定');

  gate.release();
  await slow;

  assert.strictEqual(app.globalData.userInfo._id, 'u01', 'A 的旧响应不得覆盖 B');
  assert.strictEqual(appSession.get().session.user.userId, 'u01', '统一会话也没有回退');
  gate.restore();
});

test('退出后晚到的登录响应不能恢复已退出状态', async () => {
  const app = makeApp();
  const gate = gateSessionCall(schoolIdentity, 2);
  const page = instantiate(loginConfig);
  await page.onLoad();

  const slow = page.onLogin();
  // 请求悬着的时候用户点了退出
  page.onLogout();
  assert.strictEqual(app.globalData.userInfo, null, '退出立即生效');

  gate.release();
  await slow;

  assert.strictEqual(app.globalData.userInfo, null, '晚到的登录响应不得恢复登录态');
  assert.strictEqual(page.data.step, 'entry', '界面停在入口');
  assert.strictEqual(page.data.submitting, false, '提交态也被释放');
  gate.restore();
});

test('提交中重复点击不重复开户、不重复申请', async () => {
  schoolIdentity.simulateNewWechat('dup_submit_1');
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();
  fillValidForm(page);

  const first = page.onSubmit();
  const second = page.onSubmit(); // submitting 期间直接返回

  await Promise.all([first, second]);

  const api = schoolIdentity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  const session = await api.getSchoolIdentitySession();
  assert.strictEqual(session.account.status, 'pending');
  // 只申请了一次：同一学校身份只该有一条记录（revision 不再被连点顶上去）
  assert.strictEqual(session.account.revision, 1, '重复点击不能把申请版本顶高');
  assert.strictEqual(page.data.submitting, false);
});

test('登录成功刷新「我的学校」——浏览外校时只读口径正确', async () => {
  const app = makeApp();
  // 模拟正在浏览北航：登录后「我的学校」应回到民大，浏览校保持只读
  schoolSession.setSchoolId('buaa');
  const page = instantiate(loginConfig);
  await page.onLoad();
  await page.onLogin();

  assert.strictEqual(app.globalData.userInfo._id, 'u06');
  assert.strictEqual(schoolSession.getHomeSchoolId(), 'muc', '我的学校来自账号的 primarySchoolId');
  assert.strictEqual(schoolSession.getSchoolId(), 'buaa', '浏览范围不因登录被悄悄改掉');
  assert.strictEqual(schoolSession.isReadOnly(), true, '浏览外校是只读');
});

test('切换演示身份后兼容视图与 S2 写接口是同一个人', async () => {
  const app = makeApp();
  // 登录为 u06（默认演示身份）
  const page = instantiate(loginConfig);
  await page.onLoad();
  await page.onLogin();
  assert.strictEqual(app.globalData.userInfo._id, 'u06');

  // 切到校管理员：兼容视图与 S2 actor 一起变
  await app.switchDemoActor('demo_muc_admin');

  assert.strictEqual(app.globalData.userInfo._id, 'demo_muc_admin', '兼容视图跟着切');
  assert.strictEqual(app.globalData.userInfo.role, ROLE.ADMIN, '兼容角色来自 S2 档位');
  const spaceSession = await schoolIdentity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' })
    .getSchoolIdentitySession();
  assert.strictEqual(spaceSession.user.userId, 'demo_muc_admin', '写接口与兼容视图同一个人');
  assert.strictEqual(appSession.get().session.user.userId, 'demo_muc_admin', '统一会话一致');
});

test('注册闭环：新微信号开户 + 申请，兼容登录态是待审核', async () => {
  const app = makeApp();
  schoolIdentity.simulateNewWechat('e2e_new_1');

  const page = instantiate(loginConfig);
  await page.onLoad();
  assert.strictEqual(page.data.existing.loggedIn, false);
  page.onGoRegister();
  fillValidForm(page);
  await page.onSubmit();

  assert.strictEqual(page.data.step, 'pending');
  assert.strictEqual(page.data.pending.statusLabel, '待审核');
  assert.strictEqual(app.globalData.userInfo._id, appSession.get().session.user.userId, '登录态=统一会话');
  assert.strictEqual(app.globalData.userInfo.status, USER_STATUS.PENDING);
  assert.strictEqual(app.globalData.userInfo.role, ROLE.MEMBER);

  // 审核通过后，重新进入登录页就能看到「正常」
  const applicantId = appSession.get().session.user.userId;
  schoolMock.setDemoActor('demo_muc_admin');
  const adminApi = schoolIdentity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  const { applications } = await adminApi.getSchoolApplications();
  assert.strictEqual(applications.length, 1);
  await adminApi.reviewSchoolMembership({
    userId: applicantId, decision: 'approve', revision: applications[0].revision,
  });

  schoolIdentity.simulateNewWechat('e2e_new_1');
  const again = instantiate(loginConfig);
  await again.onLoad();
  await again.onLogin();
  assert.strictEqual(again.data.existing.isActive, true);
  assert.strictEqual(app.globalData.userInfo.status, USER_STATUS.ACTIVE);
});
