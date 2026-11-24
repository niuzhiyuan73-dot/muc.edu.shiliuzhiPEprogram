/**
 * 页面装配自检
 * ============================================================
 * 页面的问题（require 路径写错、字段名对不上、setData 漏了回调）
 * 在 Node 测试里原本是最难发现的一类——只有打开开发者工具点一遍才会暴露。
 * 但这些代码本身并不依赖真机，只要把 wx API 和 Page 构造函数补上，
 * 就能在 Node 里把整个生命周期跑一遍。
 *
 * 这里替小程序搭一个最小运行环境，然后真的去执行 onLoad / 切池 /
 * 加载更多 / 点击跳转，验证数据流是通的。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

/** 数据源门面。写接口会改内存，用例之间必须把缓存清干净 */
// 直接拿实现模块，是为了在个别用例里临时把某个接口换掉。
// 门面是「调用时才解析实现」，所以改这里的导出真的会作用到上面那层
const {
  ROLE,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_TYPE,
  USER_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  EVENT_PLACEMENT_MODE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  RATED_PAIR_LIMIT,
} = require('../src/shared/utils/constants.js');

/* ============================================================
 * 最小小程序运行环境
 * ============================================================ */

/** 记录所有被调用的 wx API，供断言检查 */
const calls = {
  navigations: [],
  tabSwitches: [],
  titles: [],
  pullDownStopped: 0,
  toasts: [],
  backCount: 0,
  // 弃权确认框的内容。默认一律「确认」，用例要测取消就把 modalConfirmed 置 false
  modals: [],
  modalConfirmed: true,
};

/** 供 canvas 使用的假 2d 上下文，只记录调用 */
function createFakeContext() {
  const record = () => () => {};
  const ctx = {
    clearRect: record(),
    beginPath: record(),
    closePath: record(),
    moveTo: record(),
    lineTo: record(),
    arc: record(),
    stroke: record(),
    fill: record(),
    fillText: record(),
    save: record(),
    restore: record(),
    setLineDash: record(),
    scale: record(),
    font: '',
    textAlign: '',
    textBaseline: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    globalAlpha: 1,
  };
  return ctx;
}

const canvas = {
  width: 0,
  height: 0,
  getContext: () => createFakeContext(),
};

/** 尺寸由页面样式决定，这里假定占满宽度 320px、高 160px */
const CANVAS_SIZE = { width: 320, height: 160 };
const PIXEL_RATIO = 2;

const query = {
  in: () => query,
  select: () => query,
  fields: () => query,
  exec: (callback) => callback([{ node: canvas, ...CANVAS_SIZE }]),
};

global.wx = {
  createSelectorQuery: () => query,
  getWindowInfo: () => ({ pixelRatio: PIXEL_RATIO }),
  setNavigationBarTitle: (options) => calls.titles.push(options.title),
  stopPullDownRefresh: () => {
    calls.pullDownStopped += 1;
  },
  navigateTo: (options) => calls.navigations.push(options.url),
  switchTab: (options) => calls.tabSwitches.push(options.url),
  // 比赛页与录入页靠轻提示告知结果，只记文案即可——图标类型不参与断言
  showToast: (options) => calls.toasts.push(options.title),
  // 录入成功后返回上一页。不补这个桩，页面会在提交的最后一步抛错，
  // 表现成「提交失败」，让人以为是数据层的问题
  navigateBack: () => {
    calls.backCount += 1;
  },
  // 弃权等破坏性操作先弹确认框。这里同步回调，用例不必自己造 Promise
  showModal: (options) => {
    calls.modals.push(options.content || options.title || '');
    const confirmed = calls.modalConfirmed !== false;
    if (typeof options.success === 'function') {
      options.success({ confirm: confirmed, cancel: !confirmed });
    }
  },
};

/**
 * 最小可用的 app 实例。
 * 页面通过 getApp() 读数据源与登录态，登录页还会往里写登录态，
 * 所以这里带的三个方法要和 app.js 的语义一致：内存与「缓存」同步更新。
 * B3 之后登录页改走 S2，这里补上统一会话写入（applySchoolSession）与
 * 演示身份切换（switchDemoActor）的最小实现。
 */
const appSession = require('../miniprogram/services/app-session.js');
const associationScope = require('../miniprogram/services/association-scope.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const schoolIdentity = require('../miniprogram/services/school-identity.js');

const app = {
  globalData: { dataSource: 'mock', userInfo: null },
  getUserInfo() {
    return this.globalData.userInfo;
  },
  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
  },
  clearUserInfo() {
    this.globalData.userInfo = null;
    appSession.clear();
  },
  getAssociation() {
    return associationScope.getAssociation();
  },
  isLoggedIn() {
    return Boolean(this.globalData.userInfo);
  },
  /** 与 app.js 同语义：统一会话 + 兼容视图一起落。 */
  applySchoolSession(dto) {
    appSession.apply(dto);
    this.setUserInfo(appSession.buildCompatUser(dto));
  },
  /** 与 app.js 同语义：切演示身份后刷新兼容视图（未登录则只切身份）。 */
  async switchDemoActor(id) {
    schoolIdentity.setDemoActor(id);
    if (!this.isLoggedIn()) return null;
    const api = schoolIdentity.forSchoolIdentity({
      schoolId: schoolSession.getSchoolId() || 'muc',
      association: this.getAssociation() || 'pkb',
    });
    const session = await api.getSchoolIdentitySession();
    if (session && session.user) this.applySchoolSession({ session, profile: null });
    return session || null;
  },
};

global.getApp = () => app;

/**
 * 收集所有 Page() 与 Component() 注册的配置。
 * 排行榜 / 比赛 / 赛事已从独立页面改成协会工作台里的面板组件，但它们的
 * 测试仍按老下标取用（rankConfig / matchConfig / eventsConfig）。这里让
 * Component() 也往同一个数组里 push，并且在下头保持着原来的 require 顺序，
 * 下标便原样不变——已有的 70 多处引用一行都不用改。
 */
/**
 * 按**文件路径**加载页面 / 组件配置。
 *
 * 【为什么不再用 registered[N]】
 * 原先靠「require 顺序」取下标：加一个页面必须追加在末尾，插在中间会让
 * 已有下标全部错位，而且错位不会报错——用例会「装成别的页面」继续跑，
 * 断言写得越像越容易骗过自己。改成按路径取名后，加页面不必动任何已有行。
 *
 * 组件与页面都走这一个函数：两者都是被 Page() / Component() 注册的配置。
 */
const registered = new Map();
let loadingFile = '';

global.Page = (config) => registered.set(loadingFile, config);
global.Component = (config) => registered.set(loadingFile, config);

function loadPage(relative) {
  loadingFile = relative;
  // 注册动作发生在 require 的那一刻，所以先设好 loadingFile 再引入
  require(`../miniprogram/${relative}`);
  const config = registered.get(relative);
  assert.ok(config, `页面没有调用 Page()：${relative}`);
  return config;
}

/**
 * 深拷贝页面初值。
 * structuredClone 遇到函数或特殊对象会抛错，退回到 JSON 一趟即可——
 * 页面初值里本来就只有普通数据。
 *
 * @param {Object} value
 * @returns {Object}
 */
function cloneData(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * 把页面 / 组件配置实例化成一个可用的对象。
 * 小程序的 Page 实例会把配置里的方法挂到 this 上，setData 则负责
 * 合并数据并触发重渲染——这里照着做一份最小实现。
 *
 * 组件配置（排行榜 / 比赛 / 赛事面板）把方法收在 methods 里，生命周期
 * （attached / show）只是转调同名的 onLoad / onShow 方法，所以这里把
 * methods 平铺到实例上即可，用例照旧调 page.onLoad() / page.onShow()。
 *
 * @param {Object} config
 * @returns {Object}
 */
function instantiate(config) {
  const page = {
    // 必须深拷贝：表单、错误提示这些都是嵌套对象，浅拷贝会让两个页面实例
    // 共用同一个 data.form，一条用例往里填的字会漏到另一条用例里
    data: cloneData(config.data),
    setData(patch, callback) {
      for (const [key, value] of Object.entries(patch)) {
        // 真机上 'form.realName' 这样的路径键会逐层写入；这里照着做，
        // 否则登录页的表单在测试里会全部堆到 data['form.realName'] 上
        const path = key.split('.');
        let target = this.data;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (target[path[i]] === null || typeof target[path[i]] !== 'object') {
            target[path[i]] = {};
          }
          target = target[path[i]];
        }
        target[path[path.length - 1]] = value;
      }
      // 真机上 setData 是异步的，回调在渲染后触发；
      // 测试里同步执行即可，反正我们只关心回调有没有被调用
      if (callback) callback();
    },
  };

  // 页面：方法直接挂在配置顶层；组件：方法收在 methods 里，平铺出来
  const source = config.methods ? config.methods : config;
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'function') {
      page[key] = source[key].bind(page);
    }
  }

  return page;
}

const indexConfig = loadPage('pages/index/index.js');
const profileConfig = loadPage('pages/profile/profile.js');
const memberConfig = loadPage('packageMember/member/member.js');
const rankConfig = loadPage('components/rank-panel/rank-panel.js');
const loginConfig = loadPage('pages/login/login.js');
const matchConfig = loadPage('components/match-panel/match-panel.js');
const matchEntryConfig = loadPage('packageEvent/match-entry/match-entry.js');
const memberReviewConfig = loadPage('packageMember/member-review/member-review.js');
const announcementsConfig = loadPage('packageMember/announcements/announcements.js');
const announcementManageConfig = loadPage('packageMember/announcement-manage/announcement-manage.js');
const announcementEditConfig = loadPage('packageMember/announcement-edit/announcement-edit.js');
const profileEditConfig = loadPage('packageMember/profile-edit/profile-edit.js');
const profileDetailConfig = loadPage('packageMember/profile-detail/profile-detail.js');
const eventsConfig = loadPage('components/events-panel/events-panel.js');
const eventDetailConfig = loadPage('packageEvent/event-detail/event-detail.js');
const eventEditConfig = loadPage('packageEvent/event-edit/event-edit.js');
const eventPlacementConfig = loadPage('packageEvent/event-placement/event-placement.js');
const collegeEventEditConfig = loadPage('packageCollege/college-event-edit/college-event-edit.js');
const collegeEntryConfig = loadPage('packageCollege/college-entry/college-entry.js');
const collegeEntryReviewConfig = loadPage('packageCollege/college-entry-review/college-entry-review.js');
const collegeEventDetailConfig = loadPage('packageCollege/college-event-detail/college-event-detail.js');
const collegeLineupConfig = loadPage('packageCollege/college-lineup/college-lineup.js');
const collegeMatchConfig = loadPage('packageCollege/college-match/college-match.js');
const collegePlacementConfig = loadPage('packageCollege/college-placement/college-placement.js');
const eventListConfig = loadPage('packageEvent/event-list/event-list.js');
const liveScoreConfig = loadPage('packageTeam/live-score/live-score.js');
const associationConfig = loadPage('pages/association/association.js');
const associationHomeConfig = loadPage('pages/association-home/association-home.js');
const spacePanelConfig = loadPage('components/association-space-panel/association-space-panel.js');
const cupHomeConfig = loadPage('packageCollege/cup-home/cup-home.js');
const teamListConfig = loadPage('packageTeam/team-list/team-list.js');
const teamDetailConfig = loadPage('packageTeam/team-detail/team-detail.js');
const teamEventListConfig = loadPage('packageTeam/team-event-list/team-event-list.js');
const teamEventDetailConfig = loadPage('packageTeam/team-event-detail/team-event-detail.js');

// 写接口（确认 / 撤销 / 录入）只改内存，跑完一条用例就得把内存退回种子状态，
// 否则上一条确认过的比赛会让下一条拿到的榜单与台账都不一样
// B3 之后登录页 / 首页还要读统一会话、学校范围与 S2 演示身份，一并复位。
beforeEach(() => {
  calls.modals.length = 0;
  calls.modalConfirmed = true;
  appSession.clear();
  schoolSession.reset();
  schoolMock.reset();
});

/** 每一条用例开始前把登录态清干净，避免互相串味 */
function resetSession() {
  app.globalData.userInfo = null;
}

/** 造一个「已登录」的会员对象，字段与 mock 数据源一致 */
function fakeMember(overrides = {}) {
  return {
    _id: 'u06',
    nickName: '赵明宇',
    avatarUrl: '',
    role: 0,
    status: 1,
    ...overrides,
  };
}

/**
 * 摆好登录态。
 * 「我的」页只在已登录时加载数据——它看的人就是本地会话里的那个，
 * 没有会话就一行都不查（否则云端会按 OpenID 把刚退出的账号答回来）。
 */
function loginAs(overrides) {
  app.globalData.userInfo = fakeMember(overrides);
  return app.globalData.userInfo;
}

/**
 * 演示数据里的两种管理者。
 * 发布 / 抽签 / 开始 / 结束赛事一律只有管理员能做；学院负责人比会员多的只是
 * 「代签到」与「录入比分」——普通会员（默认 u06）与线上一样被挡住。
 * 管理类动作要按对应身份登录，别再拿普通会员顶替。
 */
const STAFF = { role: 1, _id: 'u02', nickName: '张宇轩' };
const ADMIN = { role: 2, _id: 'u01', nickName: '巴特尔' };

/* ============================================================
 * 首页
 * ============================================================ */

test('首页 —— 访客只看得到公告，赛事与概况一概不取', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.dataSourceLabel, '本地模拟数据');
  assert.strictEqual(page.data.auth.loggedIn, false);
  // 个人分数已经收进排行榜与「我的」页，首页不再摆一份
  assert.strictEqual(page.data.view.scoreCard, undefined);
  // 游客只看得到公告（需求整理 §11.8）：赛事与概况都不取
  assert.ok(page.data.view.announcements.rows.length > 0, '访客能看公告');
  assert.deepStrictEqual(page.data.view.upcomingEvents, [], '访客看不到近期赛事');
  assert.strictEqual(page.data.view.summary, null, '访客看不到概况');
});

test('首页 —— 点登录引导跳到登录注册页', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

test('首页 —— 近期赛事只列报名中/进行中，按开赛时间升序且不超过三条', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  const rows = page.data.view.upcomingEvents;
  assert.ok(rows.length > 0, '种子里有报名中/进行中的赛事');
  assert.ok(rows.length <= 3, '首屏只放得下三条');

  // 已结束的赛事不进「近期」，否则历史赛事会把还能报名的挤下去
  for (const row of rows) {
    assert.ok(
      row.statusLabel === '报名中' || row.statusLabel === '进行中',
      `不该出现状态为 ${row.statusLabel} 的赛事`
    );
  }

  // 开赛时间升序：最近要打的排在最前面
  const times = rows.map((row) => new Date(row.timeText.replace(/-/g, '/')).getTime());
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), '按开赛时间升序');
});

test('首页 —— 一场近期赛事都没有时照常出卡，由模板写空态', async () => {
  resetSession();
  loginAs();
  // 干净台账（不挂演示内容）：没有报名中 / 进行中的赛事
  const schoolMock = require('../miniprogram/services/school-mock');
  const schoolSession = require('../miniprogram/services/school-session');
  schoolMock.reset({ withDemoContent: false });
  schoolSession.reset();

  const page = instantiate(indexConfig);
  await page.onLoad();
  assert.deepStrictEqual(page.data.view.upcomingEvents, [], '已结束/无赛事不算近期');

  // 复位演示内容，别影响后续用例
  schoolMock.reset();
  schoolSession.reset();
});

test('首页 —— 登录后近期赛事标出自己报没报', async () => {
  resetSession();
  const schoolMock = require('../miniprogram/services/school-mock');
  const schoolSession = require('../miniprogram/services/school-session');
  const space = require('../miniprogram/services/association-space.js');
  schoolSession.reset();
  schoolMock.reset();
  schoolMock.setDemoActor('u06');
  app.globalData.userInfo = fakeMember({ _id: 'u06' });

  // 演示内容扩容后报名中的赛事有 6 场，首页只展示最近的 3 场：
  // 先看首页取了哪一场，再给它报名，否则报了名的那场可能根本不在列表里。
  const page = instantiate(indexConfig);
  await page.onLoad();
  const target = page.data.view.upcomingEvents.find(row => row.eventKind === 'individual');
  assert.ok(target, '首页应有近期赛事');

  // 首页聚合了多个协会的赛事：报名要走这场赛事所属协会的空间
  const api = space.forScope({ schoolId: 'muc', association: target.association });
  const signed = await api.signUpSchoolEvent({ eventId: target.id });
  assert.strictEqual(signed.ok, true, `报名失败：${signed.message}`);

  await page.onLoad();
  const mine = page.data.view.upcomingEvents.find((row) => row.id === target.id);
  assert.ok(mine, '报名中的赛事在近期列表里');
  assert.strictEqual(mine.signedUp, true);
});

test('首页 —— 待审核的账号能登录，首页照常可看', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.isPending, true);
  assert.strictEqual(page.data.auth.canRecord, false);
  // 首页两块内容与登录状态无关，待审核账号也看得到
  assert.ok(page.data.view.announcements.rows.length > 0);
  assert.ok(Array.isArray(page.data.view.upcomingEvents));
});

test('首页 —— 点近期赛事的一条会进详情', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  const target = page.data.view.upcomingEvents[0].id;
  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: { eventId: target } } });
  assert.deepStrictEqual(calls.navigations, [
    `/packageEvent/event-detail/event-detail?eventId=${encodeURIComponent(target)}`,
  ], '赛事编号进 URL 前编码（编号含冒号等特殊字符）');

  // 没有编号的空白行不该乱跳
  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

test('首页 —— 公告与概况都有内容，数据里没有 undefined 或 NaN', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  // 本人聚合等待运动会种子就绪，学校名册还包含真实生成的运动会演示会员。
  const roster = await require('../miniprogram/services/association-space').forScope({ schoolId: 'muc', association: 'pkb' }).listSchoolMembers({});
  assert.strictEqual(page.data.view.summary.memberCount, roster.total);
  assert.ok(roster.total >= 28);
  assert.ok(page.data.view.summary.matchCount > 0);
  assert.ok(page.data.view.announcements.rows.length > 0);

  // 置顶公告排在最前面
  const rows = page.data.view.announcements.rows;
  assert.strictEqual(rows[0].pinned, true);

  // 把渲染用的视图模型压成字符串，扫一遍最常见的渲染事故。
  // 页面字段名写错时不会报错，只会安静地渲染出「undefined」。
  const text = JSON.stringify(page.data.view);
  assert.ok(!text.includes('undefined'), '视图数据里出现了 undefined');
  assert.ok(!text.includes('null'), '视图数据里出现了 null');
  assert.ok(!text.includes('NaN'), '视图数据里出现了 NaN');
});

test('首页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('首页 —— 可切换浏览的学校，切到外校进入只读', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  // 让模拟身份带本校学籍（民大），切走后才判得出「正在浏览外校」
  schoolMock.setDemoActor('demo_muc_member');
  try {
    resetSession();
    const page = instantiate(indexConfig);
    await page.onLoad();

    assert.ok(page.data.schoolList.length >= 2, '双校目录里至少两所学校');
    assert.strictEqual(page.data.schoolId, 'muc');
    assert.strictEqual(page.data.readOnlySchool, false);

    page.onSchoolChange({ detail: { schoolId: 'buaa' } });
    assert.strictEqual(page.data.schoolId, 'buaa');
    assert.strictEqual(page.data.schoolName, '北京航空航天大学');
    assert.strictEqual(page.data.readOnlySchool, true, '切到外校后进入只读');
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
});

test('首页 —— 切到北航得到真实空聚合，不再展示静态演示内容', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_member');
    resetSession();
    loginAs();
    const page = instantiate(indexConfig);
    await page.onLoad();

    // 本校（民大）展示 S2 跨协会聚合内容
    assert.ok(page.data.view.announcements.rows.length > 0, '民大有公告');

    // 切到北航：民大会员读不到北航协会空间，聚合为真实空态而不是演示内容
    await page.onSchoolChange({ detail: { schoolId: 'buaa' } });

    assert.strictEqual(page.data.schoolId, 'buaa');
    assert.deepStrictEqual(page.data.view.announcements.rows, [], '外校公告空态');
    assert.deepStrictEqual(page.data.view.upcomingEvents, [], '外校近期赛事空态');
    assert.strictEqual(page.data.view.summary, null, '读不到任何协会时不编概况数字');
    assert.strictEqual(page.data.view.loggedIn, true, '登录态仍保持');

    // 切回本校即还原民大聚合内容
    await page.onSchoolChange({ detail: { schoolId: 'muc' } });
    assert.ok(page.data.view.announcements.rows.length > 0, '切回本校公告回来');
    const roster = await require('../miniprogram/services/association-space').forScope({ schoolId: 'muc', association: 'pkb' }).listSchoolMembers({});
    assert.strictEqual(page.data.view.summary.memberCount, roster.total);
  } finally {
    fx.restore();
  }
});

test('排行榜 —— 切到无权访问的外校被拒并清空旧榜单', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(rankConfig);
    await page.onLoad();

    // 本校（民大）走 S2 真实榜单
    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.view.rows.length > 0);

    // 切到北航：民大会员没有北航排行榜读取权，被拒且不残留本校榜单
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    await page.refresh();

    assert.match(page.data.error, /没有读取/);
    assert.deepEqual(page.data.view, {}, '外校读取被拒后清除旧学校榜单');
    assert.deepEqual(page.data.rows, []);
  } finally {
    fx.restore();
  }
});

test('排行榜 —— 榜单读 S2 真实数据：北航有自己的流水，外校读不到', async () => {
  const fx = spaceFixture();
  try {
    // 北航演示会员读本校：看到的是真实流水（2026-10-16 起北航也有演示比赛）
    fx.to('demo_buaa_member');
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    const page = instantiate(rankConfig);
    await page.onLoad();

    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.view.rows.length > 0, '北航演示内容里男单有流水');
    assert.ok(page.data.view.rows.some(row => row.userId === 'demo_buaa_member'));
    assert.ok(page.data.view.me && page.data.view.me.rank > 0, '「我」在北航榜上有名次');

    // 换民大身份读北航：按范围隔离，读不到并清空旧榜单（不留上一份北航名单）
    fx.to('demo_muc_member');
    await page.refresh();
    assert.deepEqual(page.data.view, {}, '外校读不到北航榜单');
    assert.ok(page.data.error.length > 0, '给出读不到的原因');
  } finally {
    fx.restore();
  }
});

test('比赛页 —— 切到无权访问的外校清空比赛并关闭录入', async () => {
  const fx = schoolEventFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(matchConfig);
    await page.onLoad();
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    await page.refresh();
    assert.deepEqual(page.data.view.records, []);
    assert.equal(page.data.auth.canRecord, false);
    assert.match(page.data.entryHint, /有效身份/);
  } finally { fx.restore(); }
});

test('赛事页 —— 切到无权访问的外校清除旧赛事与积分榜', async () => {

  const fx = schoolEventFixture();
  try {
    await fx.publish();
    const page = instantiate(eventsConfig);
    await page.onLoad();
    assert.equal(page.data.view.events.length, 1);
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    await page.refresh();
    assert.match(page.data.error, /没有读取/);
    assert.deepEqual(page.data.view, {}, '外校读取被拒后清除旧学校数据');
    assert.deepEqual(page.data.rows, []);
  } finally { fx.restore(); }

});

test('外校访问 —— 已迁移面板按真实 S2 权限拒绝，不再展示静态演示内容', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_member');
    require('../miniprogram/services/school-session').setSchoolId('buaa');

    // 排行榜已接 S2：外校访问被拒，不展示静态演示榜单
    const rankPage = instantiate(rankConfig);
    await rankPage.onLoad();
    assert.match(rankPage.data.error, /没有读取/);
    assert.deepEqual(rankPage.data.view, {});

    // 比赛面板已接 S2，无外校有效身份时不返回内部台账。
    const matchPage = instantiate(matchConfig);
    await matchPage.onLoad();
    assert.deepEqual(matchPage.data.view.records, []);
    assert.equal(matchPage.data.auth.canRecord, false);

    // 已迁移的赛事面板读取真实 S2 权限，外校访问被拒，不再展示静态赛事。
    const eventsPage = instantiate(eventsConfig);
    await eventsPage.onLoad();
    assert.match(eventsPage.data.error, /没有读取/);
    assert.deepEqual(eventsPage.data.view, {});
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 我的页
 * ============================================================ */

test('我的页 —— 启动后处于加载态，数据来源标注为模拟数据', () => {
  const page = instantiate(profileConfig);
  assert.strictEqual(page.data.loading, true);
  assert.strictEqual(page.data.isMock, true);
  assert.deepStrictEqual(page.data.view, {}, '初值必须是空对象，WXML 展开才不会出错');
});

test('我的页 —— onLoad 之后渲染出全局头卡与跨协会聚合的荣誉', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
  // 等级分/项目分卡已移入个人详情页，这一页不再有
  assert.strictEqual(page.data.view.projectTabs, undefined, '「我的」不再摆等级分');
  assert.strictEqual(page.data.view.user.showPoints, false, '头卡不显示赛季积分标签');
  assert.ok(page.data.view.honors, '有跨协会聚合的荣誉');
});

test('我的页 —— 点头卡头像进个人详情页', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, ['/packageMember/profile-detail/profile-detail']);
});

test('我的页 —— 荣誉跨协会聚合：汇总数字等于各分组名次之和', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  const honors = page.data.view.honors;
  assert.ok(Array.isArray(honors.groups), '按协会分组');
  const summed = honors.groups.reduce((total, group) => total + group.records.length, 0);
  assert.strictEqual(summed, honors.summary.eventCount, '汇总参赛数 = 各分组记录数之和');
  assert.strictEqual(honors.total, honors.summary.eventCount);
  // 未参赛的协会不出现：分组里必须有记录，且都带协会标识
  for (const group of honors.groups) {
    assert.ok(group.associationId && group.associationName, '每组要标注所属协会');
    assert.ok(group.records.length > 0, '没有记录的协会不该建分组');
  }
  if (honors.total === 0) assert.strictEqual(honors.groups.length, 0);
});

test('我的页 —— 切换协会只改全局，本页内容不重取', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  const before = page.data.view;
  const globalBefore = associationScope.getAssociation();
  const target = globalBefore === 'tt' ? 'pkb' : 'tt';

  try {
    await page.onAssociationChange({ detail: { id: target } });
    // 内容对象没被整体替换，说明没有重新取数——「我的」是跨协会聚合的，不随切换变
    assert.strictEqual(page.data.view, before, '切协会不该重取本页内容');
    // 但全局当前协会确实改掉了（作用在中间三个界面）
    assert.strictEqual(associationScope.getAssociation(), target);
  } finally {
    // 全局协会是模块级单例，别把改动漏给后面的用例
    associationScope.setAssociation(globalBefore);
  }
});

test('我的页 —— 首页切了协会再回来，徽章跟着全局走（不再两张皮）', async () => {
  loginAs();
  const globalBefore = associationScope.getAssociation();
  associationScope.setAssociation('pkb');
  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(page.data.associationId, 'pkb', '首屏徽章是当前全局协会');

    // 模拟在首页把全局协会切到 tt，再切回「我的」tab——tab 切换只走 onShow。
    // 本页内容是跨协会聚合的、不随它变，会话指纹没变，refresh 会被跳过；
    // 若不在 onShow 里单独同步徽章，这里就会停在 pkb，与首页显示的两张皮。
    const viewBefore = page.data.view;
    associationScope.setAssociation('tt');
    await page.onShow();

    assert.strictEqual(page.data.associationId, 'tt', '徽章必须跟上全局协会');
    assert.strictEqual(page.data.view, viewBefore, '切协会不该重取本页内容');
  } finally {
    associationScope.setAssociation(globalBefore);
  }
});

test('我的页 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(profileConfig);
  await page.onLoad({});

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  // 不调用 stopPullDownRefresh 的话，转圈会一直停不下来
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('我的页 —— 访客看不到会员审核入口', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, false);
});

test('我的页 —— 待审核账号自己还没转正，同样没有审核入口', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, false);
});

test('我的页 —— 普通会员看不到任何管理入口', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  // 演示数据源不再放宽：普通会员与线上一样，管理入口一个都不给
  assert.strictEqual(page.data.reviewEntry.visible, false);
  assert.strictEqual(page.data.adminEntry.visible, false);
});

test('我的页 —— 管理员看到审核入口，点进去跳转审核页', async () => {
  // S2 会话能力来自 getSchoolIdentitySession：校管理员 canReview 为真
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_muc_admin', role: 2 });

    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.reviewEntry.visible, true);
    assert.ok(page.data.reviewEntry.hint, '入口卡上要写清楚点进去是干什么的');

    calls.navigations.length = 0;
    page.onGoReview();
    assert.deepStrictEqual(calls.navigations, ['/packageMember/member-review/member-review']);
  } finally {
    fx.restore();
  }
});

test('我的页 —— 学院负责人看不到审核入口：入会审核是俱乐部全局事务', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_college_leader');
    app.globalData.userInfo = fakeMember({ _id: 'demo_muc_college_leader', role: 1 });

    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.reviewEntry.visible, false);
  } finally {
    fx.restore();
  }
});

test('我的页 —— 退出登录后 onShow 会把审核入口收回去', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_muc_admin', role: 2 });

    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(page.data.reviewEntry.visible, true);

    app.globalData.userInfo = null;
    await page.onShow();
    assert.strictEqual(page.data.reviewEntry.visible, false, '权限没了，入口不能还挂着');
  } finally {
    fx.restore();
  }
});

test('我的页 —— 访客看不到公告管理入口', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.adminEntry.visible, false);
});

test('我的页 —— 平台管理员看到公告管理入口，点进去跳转公告管理页', async () => {
  // 公告管理权 = 平台管理员 + 本校校级管理员（2026-10-18 起校级管理员也能发）
  const fx = spaceFixture();
  try {
    fx.to('demo_platform_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_platform_admin', role: 2 });

    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.adminEntry.visible, true);
    assert.ok(page.data.adminEntry.hint, '入口卡上要写清楚点进去是干什么的');

    calls.navigations.length = 0;
    page.onGoAnnouncementsAdmin();
    assert.deepStrictEqual(calls.navigations, ['/packageMember/announcement-manage/announcement-manage']);
  } finally {
    fx.restore();
  }
});

test('我的页 —— 校管理员也看到公告管理入口：本校公告由校级管理员发', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_muc_admin', role: 2 });

    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.adminEntry.visible, true);
    assert.ok(page.data.adminEntry.hint, '入口卡上要写清楚点进去是干什么的');
  } finally {
    fx.restore();
  }
});

test('我的页 —— 协会负责人看不到公告管理入口：公告是全校事务', async () => {
  const fx = spaceFixture();
  const schoolSession = require('../miniprogram/services/school-session');
  try {
    // 切到北航范围，让「北航协会负责人」成为本校在册身份——否则测的就成了跨校只读
    schoolSession.setSchoolId('buaa');
    fx.to('demo_buaa_leader');
    app.globalData.userInfo = fakeMember({ _id: 'demo_buaa_leader', role: 1 });

    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.adminEntry.visible, false);
  } finally {
    fx.restore();
  }
});

test('我的页 —— 退出登录后 onShow 会把公告管理入口一并收回去', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_platform_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_platform_admin', role: 2 });

    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(page.data.adminEntry.visible, true);

    app.globalData.userInfo = null;
    await page.onShow();
    assert.strictEqual(page.data.adminEntry.visible, false, '权限没了，入口不能还挂着');
  } finally {
    fx.restore();
  }
});

test('我的页 —— 赛季管理入口已移除，管理员也看不到', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ role: 2, _id: 'u01', nickName: '巴特尔' });

  const page = instantiate(profileConfig);
  await page.onLoad({});

  // 赛季更新改为在云控制台手动操作，小程序内不再提供入口
  assert.strictEqual(page.data.seasonEntry, undefined);
  assert.strictEqual(typeof page.onGoSeasonManage, 'undefined');
});

test('我的页 —— 已登录才给退出按钮，点了清登录态并回首页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.loggedIn, true, '登录了就该有退出按钮');

  calls.tabSwitches.length = 0;
  page.onLogout();

  assert.strictEqual(app.globalData.userInfo, null, '退出登录要把全局登录态清掉');
  assert.strictEqual(page.data.loggedIn, false);
  assert.deepStrictEqual(calls.tabSwitches, ['/pages/index/index'], '退出后回首页');
});

test('我的页 —— 未登录时不给退出按钮', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loggedIn, false);
});

test('我的页 —— 登录后切回本页会自动补取数据，不停在登录前那份空视图', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  // 这个页面实例是在未登录时建出来的：view 停在 {found:false}
  await page.onLoad({});
  assert.strictEqual(page.data.loggedIn, false);

  // 用户去登录页登录成功，再切回「我的」——tabBar 页只走 onShow，不重新 onLoad
  loginAs();
  await page.onShow();

  assert.strictEqual(page.data.loggedIn, true);
  assert.strictEqual(page.data.view.found, true, '登录后必须重新取数');
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('我的页 —— 登录后补取数据期间显示加载态，而不是「没有找到这位会员」', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.loading, false);

  loginAs();
  const pending = page.onShow();

  // 云端还没回来。此时 loading 若还是 false，模板就会拿登录前那份
  // {found:false} 去渲染「没有找到这位会员」——冷启动要等好几秒
  assert.strictEqual(page.data.loading, true, '取数期间要挂加载态');

  await pending;
  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.found, true);
});

test('我的页 —— 切回本页时登录态没变就不重复取数', async () => {
  resetSession();
  loginAs();

  // 切 tab 很频繁，每次都白跑一趟会话没有意义：指纹没变，视图对象就该原样
  const page = instantiate(profileConfig);
  await page.onLoad({});
  const before = page.data.view;

  await page.onShow();
  assert.strictEqual(page.data.view, before, '登录态没变，onShow 不该再取');
});

test('我的页 —— 退出后重新登录会重新取数，不把上一个人那份空视图留住', async () => {
  resetSession();
  loginAs();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.view.user.userId, 'u06');

  // 退出再登进来也走同一条路径
  page.onLogout();
  assert.strictEqual(page.data.loggedIn, false);

  loginAs();
  await page.onShow();
  assert.strictEqual(page.data.loggedIn, true);
  assert.strictEqual(page.data.view.found, true, '重新登录后要补取数据');
});

test('我的页 —— 未登录时不查数据，只给登录引导', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false, '不能一直挂在加载态');
  // 关键：数据源的 getCurrentUser 认的是 OpenID，退出登录后照样答得出是谁，
  // 所以未登录时必须什么都不查，否则「我的」页会继续显示刚退出的那个账号
  assert.strictEqual(page.data.view.found, false);

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

test('我的页 —— 服务端查无此人时清掉登录态，不把人困在「没有找到这位会员」', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  // 模拟「这台设备的微信号在服务端没有账号」：会话 user 为 null
  const schoolIdentity = require('../miniprogram/services/school-identity.js');
  schoolIdentity.simulateNewWechat('profile_ghost_1');

  try {
    calls.tabSwitches.length = 0;
    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.view.found, false);
    assert.strictEqual(page.data.loading, false, '不能一直挂在加载态');
    assert.strictEqual(page.data.loggedIn, false, '对不上的登录态要清掉');
    assert.strictEqual(app.globalData.userInfo, null, '全局登录态也要一并清掉');
    // 这一步不跳页：用户正站在「我的」上，原地换成登录引导即可
    assert.deepStrictEqual(calls.tabSwitches, [], '不要把人甩到别的页面去');
  } finally {
    schoolMock.reset();
  }
});

test('我的页 —— 加载失败时留着登录态，只提示重试', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  // 抛错是网络/云函数故障，与「查无此人」不是一回事：这时把人的登录态
  // 清掉，等于让他白白重新登录一次
  const schoolIdentity = require('../miniprogram/services/school-identity.js');
  const original = schoolIdentity.forSchoolIdentity;
  schoolIdentity.forSchoolIdentity = () => {
    throw new Error('云函数调用失败');
  };

  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.loading, false, '不能一直挂在加载态');
    assert.strictEqual(page.data.error.length > 0, true, '失败要给重试提示');
    assert.strictEqual(page.data.loggedIn, true, '登录态还留着');
    assert.ok(app.globalData.userInfo, '全局登录态不清');
  } finally {
    schoolIdentity.forSchoolIdentity = original;
  }
});

/* ============================================================
 * 个人详情（从「我的」页点头像进来）
 * ============================================================ */

test('个人详情 —— onLoad 之后渲染出当前会员的数据', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('个人详情 —— 曲线画到了 canvas 上，并按设备像素比做了缩放', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  canvas.width = 0;
  canvas.height = 0;

  await page.onLoad({});

  // 不乘 dpr 的话，曲线在手机上会糊成一片
  assert.strictEqual(canvas.width, CANVAS_SIZE.width * PIXEL_RATIO);
  assert.strictEqual(canvas.height, CANVAS_SIZE.height * PIXEL_RATIO);
});

test('个人详情 —— 切换项目后整页数据跟着换', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  await page.onSwitchProject({ currentTarget: { dataset: { project: 'men_singles' } } });

  assert.strictEqual(page.data.view.activeProject, 'men_singles');
  assert.strictEqual(page.data.switching, false, '切完要把淡出状态收回');
  assert.ok(page.data.view.history.length > 0);
  for (const row of page.data.view.history) {
    assert.strictEqual(row.poolLabel, '单打');
  }
});

test('个人详情 —— 重复点当前项目不做无谓的重新加载', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  const before = page.data.view;
  await page.onSwitchProject({
    currentTarget: { dataset: { project: page.data.view.activeProject } },
  });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('个人详情 —— 切项目时不整页替成加载态，别把刚看到的内容抹掉', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.view.hasProject, true);

  const pending = page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });
  assert.strictEqual(page.data.loading, false, '换项目不该把整页数据换成加载中');
  assert.strictEqual(page.data.switching, true, '但要给个切换中的反馈');

  await pending;
  assert.strictEqual(page.data.view.activeProject, 'doubles');
});

test('个人详情 —— 加载更多会扩大取数范围', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  const before = page.data.historyLimit;
  await page.onLoadMore();
  assert.strictEqual(page.data.historyLimit, before + 20);
});

test('个人详情 —— 是否还有更多战绩，按实际总场次判断', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  // 只取一场，这个池肯定不止一场
  page.data.historyLimit = 1;
  await page.onLoad({});
  assert.strictEqual(page.data.hasMore, true);

  // 上限放到远超总场次，再点「加载更多」就没意义了，按钮该消失
  page.data.historyLimit = 100000;
  await page.refresh();
  assert.strictEqual(page.data.hasMore, false);
});

test('个人详情 —— 点交锋记录里的人会跳到对方主页', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/packageMember/member/member?userId=u01']);
});

test('个人详情 —— 点到自己不会再跳一层', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u06' } } });
  assert.deepStrictEqual(calls.navigations, [], '自己的名字点了不该再开一个页面');
});

test('个人详情 —— 修改头像入口跳到编辑资料页', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileEdit();
  assert.deepStrictEqual(calls.navigations, ['/packageMember/profile-edit/profile-edit']);
});

test('个人详情 —— 详情页里再点头像不跳转', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, [], '已经在详情页了，不该再开一层');
});

test('个人详情 —— 页内默认本人比赛最多的协会，切换只改本页', async () => {
  loginAs(); // u06，比赛多在匹克球协会
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.switchValue, 'pkb', '默认落在本人比赛最多的协会');
  assert.strictEqual(page.data.showSwitch, true, '已登录且有多协会，给切换徽章');
  assert.ok(page.data.view.summary, '承接了「我的」移出的等级分');

  const globalBefore = associationScope.getAssociation();
  try {
    await page.onAssociationChange({ detail: { id: 'tt' } });
    assert.strictEqual(page.data.switchValue, 'tt');
    assert.strictEqual(associationScope.getAssociation(), globalBefore, '页内切换不写回全局');
  } finally {
    associationScope.setAssociation(globalBefore);
  }
});

/* ============================================================
 * 他人主页
 * ============================================================ */

test('他人主页 —— 按地址栏里的 userId 加载对应会员', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u01');
});

test('他人主页 —— 拿不到 userId 时退化成看自己，而不是白屏', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('他人主页 —— 查无此人时给出明确提示', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u99' });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.found, false);
  assert.strictEqual(page.data.hasMore, false);
});

test('他人主页 —— 导航栏按页内协会套品牌（标题 = 协会简称）', async () => {
  // u08 在学校维度只在乒乓球协会打过球（P10 后默认协会按 S2 台账算，
  // 见 tests/association-usage.test.js），页内默认落在 tt，标题随之是它的简称（§11.7）
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u08' });

  assert.strictEqual(page.data.switchValue, 'tt');
  assert.strictEqual(calls.titles[calls.titles.length - 1], '民大乒乓');
});

test('他人主页 —— 页内切换协会整页重取，但不写回全局', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u08' }); // 默认 tt
  const globalBefore = associationScope.getAssociation();

  try {
    await page.onAssociationChange({ detail: { id: 'pkb' } });
    assert.strictEqual(page.data.switchValue, 'pkb');
    assert.strictEqual(page.data.view.found, true);
    assert.strictEqual(associationScope.getAssociation(), globalBefore, '页内切换不写回全局');
  } finally {
    associationScope.setAssociation(globalBefore);
  }
});

test('他人主页 —— 头卡是共用的，但点头像不会跳走', async () => {
  // 头像跳详情只有「我的」页需要；看别人资料时点头像不该有任何反应
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, []);
});

test('他人主页 —— S2 个人主页不再提供任免 / 改分入口，权限统一走学校身份页', async () => {
  // 指定权限（校/协会/学院三档）统一由学校身份页 grantSchoolPermission 入口处理，
  // 个人主页读 S2，不再按旧栈 role 显示任免按钮（避免读 S2、写旧栈的混用）。
  // B8 收敛：入口卡片与写路径一并移除，处理函数不再存在。
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    app.globalData.userInfo = fakeMember({ _id: 'demo_muc_admin', role: 2 });
    const page = instantiate(memberConfig);
    await page.onLoad({ userId: 'u06' });

    assert.strictEqual(page.data.view.leader.visible, false);
    assert.strictEqual(page.data.view.associationLeader.visible, false);
    assert.strictEqual(page.data.view.currentElo.visible, false);
    assert.strictEqual(typeof page.onGrantPermission, 'undefined', '统一入口随写路径一起移除');
    assert.strictEqual(typeof page.onSetCollegeLeader, 'undefined');
    assert.strictEqual(typeof page.onEditCurrentElo, 'undefined');

    const after = await fx.spaceApi().getSchoolMemberProfile({ userId: 'u06' });
    assert.strictEqual(after.user.permissionLabel, '会员', 'u06 权限没被改动');
  } finally {
    fx.restore();
  }
});

test('他人主页 —— 普通会员看不到任免入口，也没有可点的按钮', async () => {
  loginAs({ _id: 'u06', role: 0 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u02' });

  assert.strictEqual(page.data.view.leader.visible, false);
  assert.strictEqual(page.data.view.associationLeader.visible, false);
  // 入口与写路径整体移除：没有任何可误触发的按钮
  assert.strictEqual(typeof page.onGrantPermission, 'undefined');
});

/* ============================================================
 * 排行榜
 * ============================================================ */

test('排行榜 —— 首屏加载后展示默认项目的等级分榜，且最多 10 行', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.activeBoardLabel, '等级分榜');
  assert.ok(page.data.view.rows.length > 0);
  assert.ok(page.data.view.rows.length <= 10, '等级榜只显示前 10 名');
});

test('排行榜 —— 切项目会换成对应的榜，且名次重新从 1 排起', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });

  assert.strictEqual(page.data.view.activeProject, 'doubles');
  assert.strictEqual(page.data.switching, false, '切完要把淡出状态收回来');
  assert.strictEqual(page.data.view.rows[0].rank, 1);
});

test('排行榜 —— 切到同一个项目不重复加载', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchProject({ currentTarget: { dataset: { project: page.data.view.activeProject } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('排行榜 —— 已经没有榜单类型切换了', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  // 进步榜被移除，页面不该再留着切榜单的入口
  assert.strictEqual(typeof page.onSwitchBoard, 'undefined');
  assert.strictEqual(page.data.view.boardTabs, undefined);
});

test('排行榜 —— 点榜上的人会跳到他的主页', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/packageMember/member/member?userId=u01']);
});

test('排行榜 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('排行榜 —— 首屏还没落地时 onShow 不重复取数', async () => {
  const page = instantiate(rankConfig);
  // 框架不 await onLoad，紧接着就会同步调一次 onShow；此时 loaded 还是假，
  // 应当被挡下，否则首屏白刷两遍
  const loading = page.onLoad();
  assert.strictEqual(page.onShow(), undefined);
  await loading;
});

test('排行榜 —— 从别的页面切回来会重算榜单', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();
  const before = page.data.view;

  // 刚确认的比赛会改名字次，切回来必须重取
  await page.onShow();
  assert.notStrictEqual(page.data.view, before, 'onShow 应当重新装载一份视图模型');
});

test('排行榜 —— 搜索框空着时就是榜单本身，计数与视图模型一致', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, page.data.view.rows.length);
  // 计数必须用完整榜单人数，不能只报榜上这（最多 10）行
  assert.strictEqual(page.data.playerCountText, page.data.view.playerCountText);
  assert.ok(page.data.playerCountText.includes(String(page.data.view.total)));
  assert.strictEqual(page.data.empty, false);
});

test('排行榜 —— 输入名字后只剩命中的人，名次保持不变', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.data.rows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });

  assert.strictEqual(page.data.searching, true);
  assert.ok(page.data.rows.length >= 1, '至少要搜到榜首本人');
  assert.ok(page.data.rows.every((row) => row.nickName.includes(target.nickName)));
  assert.strictEqual(page.data.playerCountText, `找到 ${page.data.rows.length} 人`);
  // 关键：搜索不是重新排名，被搜到的人名次不能变
  const sameRow = page.data.rows.find((row) => row.userId === target.userId);
  assert.strictEqual(sameRow.rank, target.rank);
});

test('排行榜 —— 搜不到时提示里带上搜索词，而不是笼统地说没人打过', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  page.onInputKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.empty, true);
  assert.strictEqual(page.data.rows.length, 0);
  assert.ok(page.data.emptyNote.includes('查无此人'), '要告诉用户是哪个词没搜到');
  assert.strictEqual(page.data.playerCountText, '找到 0 人');
});

test('排行榜 —— 清空搜索后回到完整榜单', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const total = page.data.rows.length;
  page.onInputKeyword({ detail: { value: '查无此人' } });
  page.onClearKeyword();

  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, total);
});

test('排行榜 —— 切换项目后搜索词保留，不悄悄回到全部', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.data.rows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });
  await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });

  assert.strictEqual(page.data.keyword, target.nickName, '切榜不该把搜索框清空');
  assert.strictEqual(page.data.searching, true);
});

test('排行榜 —— 搜索范围是全量榜单，前十之外的人也能搜到', async () => {
  const fx = rankBoardFixture();
  try {
    await fx.seedMenSingles();
    const page = instantiate(rankConfig);
    await page.onLoad();

    // 完整榜只留在实例上（不随 setData 序列化），搜索仍以它为准。
    const outside = page.view.allRows[10];
    assert.ok(outside, '要有前十之外的会员才能验证全量搜索');
    assert.ok(
      !page.data.rows.some((row) => row.userId === outside.userId),
      '默认榜单不该显示他'
    );

    page.onInputKeyword({ detail: { value: outside.nickName } });

    const hit = page.data.rows.find((row) => row.userId === outside.userId);
    assert.ok(hit, '前十之外的人必须能被搜到');
    assert.strictEqual(hit.rank, outside.rank, '搜索只是定位，不改名次');
    assert.ok(hit.rank > 10);
  } finally {
    fx.restore();
  }
});

test('排行榜 —— 用真实姓名也能搜到同一个人，展示的仍是昵称', async () => {
  // 种子里 u06：昵称「明宇」、真实姓名「赵明宇」。只按昵称搜时，
  // 输入「赵」查无此人——这正是用户反馈的问题。
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.view.allRows.find((row) => row.userId === 'u06');
  assert.ok(target, '种子里应当有这位会员');
  assert.strictEqual(target.nickName, '明宇');
  assert.strictEqual(target.realName, '赵明宇');

  page.onInputKeyword({ detail: { value: '赵' } });

  const hit = page.data.rows.find((row) => row.userId === 'u06');
  assert.ok(hit, '输入真名的姓也要能搜到人');
  assert.strictEqual(hit.rank, target.rank, '按真名搜同样不改名次');
  // 真实姓名只作为搜索依据，榜面上显示的一律是昵称
  assert.strictEqual(hit.nickName, '明宇');
});

test('排行榜 —— S2：默认演示身份在榜上标「我」，名次卡来自完整榜单', async () => {
  // 民大演示内容里 u06（默认演示身份）打了男单，榜上应有「我」标记与名次卡
  const page = instantiate(rankConfig);
  await page.onLoad();

  const mine = page.view.allRows.find((row) => row.isMe);
  assert.ok(mine, '默认身份 u06 应在男单榜上');
  assert.strictEqual(mine.userId, 'u06');
  assert.ok(page.data.view.me, '有「我」就该有名次卡');
  assert.strictEqual(page.data.view.me.rank, mine.rank);
  assert.strictEqual(page.data.view.me.total, page.data.view.total);
});

test('排行榜 —— S2：切协会后榜单按协会隔离，各读各的流水', async () => {
  const fx = spaceFixture();
  try {
    fx.to('u06');
    const page = instantiate(rankConfig);
    await page.onLoad();
    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.view.rows.length > 0, '匹克球协会（pkb）有演示流水');
    const pkbIds = page.data.view.rows.map(row => row.userId);
    assert.ok(pkbIds.includes('u03'));

    // 乒乓协会：读的是乒乓自己的流水（2026-10-16 起各协会都有演示内容），
    // 而不是沿用 pkb 的名单——u04 只在乒乓打球，u03 只在匹克球打球。
    require('../miniprogram/services/association-scope.js').setAssociation('tt');
    await page.refresh();

    assert.strictEqual(page.data.error, '');
    const ttIds = page.data.view.rows.map(row => row.userId);
    assert.ok(ttIds.length > 0, '乒乓协会也有自己的榜单');
    assert.ok(ttIds.includes('u04'), '乒乓负责人 u04 在乒乓榜上');
    assert.ok(!ttIds.includes('u03'), 'u03 只在匹克球协会有流水');
    assert.notDeepEqual(ttIds.slice().sort(), pkbIds.slice().sort(), '两张榜单不是同一份');

    // 羽球协会：同样是自己的流水，与乒乓不是同一张榜
    require('../miniprogram/services/association-scope.js').setAssociation('bd');
    await page.refresh();
    const bdIds = page.data.view.rows.map(row => row.userId);
    assert.ok(bdIds.length > 0, '羽球协会也有自己的男单榜');
    assert.notDeepEqual(bdIds.slice().sort(), ttIds.slice().sort(), '羽球与乒乓不是同一张榜');
  } finally {
    fx.restore();
  }
});

test('排行榜 —— S2：读失败清空旧榜单，恢复后能重新取到', async () => {
  const fx = spaceFixture();
  try {
    fx.to('u06');
    const page = instantiate(rankConfig);
    await page.onLoad();
    assert.ok(page.data.view.rows.length > 0);

    // 断一次读：面板给出明确错误并清空旧榜单
    const original = require('../miniprogram/services/association-space.js').forScope;
    require('../miniprogram/services/association-space.js').forScope = () => ({
      getSchoolRanking: async () => { throw new Error('读取超时'); },
    });
    try {
      await page.refresh();
      assert.match(page.data.error, /读取超时/);
      assert.deepEqual(page.data.view, {});
      assert.deepEqual(page.data.rows, []);
    } finally {
      require('../miniprogram/services/association-space.js').forScope = original;
    }

    // 恢复后重新装载，旧数据不残留
    await page.refresh();
    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.view.rows.length > 0);
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 赛事（赛季积分榜）
 * ============================================================ */

eventPanelTest('赛事页 —— 首屏加载后展示赛季积分榜', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.ok(page.data.view.rows.length > 0, '种子里有单打赛事，榜上不该空着');
  assert.ok(page.data.view.seasonText.length > 0);
});

eventPanelTest('赛事页 —— 榜上的人名次连续、积分从高到低', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const rows = page.data.view.rows;
  rows.forEach((row, index) => {
    assert.strictEqual(row.rank, index + 1);
    assert.ok(Number(row.valueText) > 0, '0 分的人不该出现在积分榜上');
  });
  const points = rows.map((row) => Number(row.valueText));
  assert.deepStrictEqual(points, [...points].sort((a, b) => b - a));
});

eventPanelTest('赛事页 —— 积分榜只列前 10 名，计数交代总人数', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, Math.min(10, page.data.view.total));
  assert.ok(page.data.rows.length <= 10, '积分榜只显示前 10 名');
  assert.strictEqual(page.data.playerCountText, page.data.view.playerCountText);
  assert.ok(page.data.playerCountText.includes(String(page.data.view.total)));
});

eventPanelTest('赛事页 —— 输入名字后只剩命中的人，名次保持不变', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const target = page.view.allRows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });

  assert.strictEqual(page.data.searching, true);
  assert.ok(page.data.rows.length >= 1, '至少要搜到榜首本人');
  assert.strictEqual(page.data.playerCountText, `找到 ${page.data.rows.length} 人`);
  const sameRow = page.data.rows.find((row) => row.userId === target.userId);
  assert.strictEqual(sameRow.rank, target.rank, '搜索只是定位，不改名次');
});

eventPanelTest('赛事页 —— 搜索范围是全量榜单，前十之外的人也能搜到', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const base = page.view.allRows[0];
  page.view = { ...page.view, allRows: Array.from({length:12}, (_,i)=>({ ...base,
    userId: 'search-'+i, nickName: '搜索会员'+i, realName:'姓名'+i, rank:i+1 })) };
  page.view.rows = page.view.allRows.slice(0,10);
  // 视图层副本不含 allRows；搜索仍从实例上的完整榜读取。
  const display = { ...page.view };
  delete display.allRows;
  page.setData({view:display});
  page.applyKeyword('');

  const outside = page.view.allRows[10];
  assert.ok(outside, '要有前十之外的会员才能验证全量搜索');
  assert.ok(
    !page.data.rows.some((row) => row.userId === outside.userId),
    '默认榜单不该显示他'
  );

  page.onInputKeyword({ detail: { value: outside.nickName } });

  const hit = page.data.rows.find((row) => row.userId === outside.userId);
  assert.ok(hit, '前十之外的人必须能被搜到');
  assert.strictEqual(hit.rank, outside.rank);
});

eventPanelTest('赛事页 —— 积分榜用真实姓名也能搜到同一个人', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const target = page.view.allRows.find((row) => row.userId === 'u06');
  assert.ok(target, '种子里应当有这位会员');
  assert.strictEqual(target.realName, '赵明宇');

  page.onInputKeyword({ detail: { value: '赵' } });

  const hit = page.data.rows.find((row) => row.userId === 'u06');
  assert.ok(hit, '输入真名的姓也要能搜到人');
  assert.strictEqual(hit.rank, target.rank);
  assert.strictEqual(hit.nickName, '明宇', '展示的仍是昵称');
});

eventPanelTest('赛事页 —— 搜不到时提示里带上搜索词，清空后回到默认榜', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const total = page.data.rows.length;
  page.onInputKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.empty, true);
  assert.strictEqual(page.data.rows.length, 0);
  assert.ok(page.data.emptyNote.includes('查无此人'), '要告诉用户是哪个词没搜到');
  assert.strictEqual(page.data.playerCountText, '找到 0 人');

  page.onClearKeyword();
  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, total);
});

eventPanelTest('赛事页 —— 点榜上的人会跳到他的主页', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/packageMember/member/member?userId=u01']);
});

eventPanelTest('赛事页 —— 点空白行不会乱跳', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

eventPanelTest('赛事页 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

eventPanelTest('赛事页 —— 加载失败时给出提示而不是白屏', async () => {
  const page = instantiate(eventsConfig);
  // 门面是「调用时解析实现」，改实现模块的导出就能让这次取数失败
  const space = require('../miniprogram/services/association-space');
  const original = space.forScope;
  space.forScope = (...args) => ({ ...original(...args), listSchoolEvents: async () => { throw new Error('模拟数据源故障'); } });

  try {
    await page.onLoad();
    assert.strictEqual(page.data.loading, false);
    assert.ok(page.data.error.length > 0, '失败要有文案，不能只剩一个空页面');
  } finally {
    space.forScope = original;
  }
});

/* ============================================================
 * 赛事闭环（列表 → 详情 → 发布 → 名次录入）
 * ============================================================ */


eventPanelTest('赛事页 —— 赛事列表把报名中、进行中的排在已结束之前', async (fx) => {

  const ongoingId = await fx.publish({ title: '进行中测试赛' });
  await fx.play(ongoingId, ['demo_muc_admin', 'demo_muc_member']);
  const created = await fx.publish({ title: '报名中测试赛' });
  const page = instantiate(eventListConfig);
  await page.onLoad({type:'event'});
  const rows=page.data.view.events;
  assert.ok(rows.find(row=>row.id===created && row.isSignup));
  assert.ok(rows.find(row=>row.id===ongoingId && row.isOngoing));
  const statuses=rows.map(row=>row.status);
  assert.deepEqual(statuses,[...statuses].sort((a,b)=>a-b));

});

eventPanelTest('赛事页 —— 点一场赛事跳到详情', async (fx) => {
  const eventId = await fx.publish();

  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: { eventId } } });
  assert.deepStrictEqual(calls.navigations, [
    `/packageEvent/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}`,
  ]);
});

eventPanelTest('赛事页 —— 点空白行不会乱跳', async () => {
  loginAs();
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

eventPanelTest('赛事页 —— 只有管理员才渲染发布入口', async (fx) => {

  for (const [id, allowed] of [['demo_muc_admin',true],['demo_muc_college_leader',false],['demo_muc_member',false]]) {
    fx.to(id);
    const page=instantiate(eventsConfig);
    await page.onLoad();
    assert.equal(page.data.view.canPublish,allowed);
  }
  fx.to('demo_applicant');
  const blocked=instantiate(eventsConfig);
  await blocked.onLoad();
  assert.match(blocked.data.error,/没有读取/);
  assert.ok(!blocked.data.view.canPublish);

});

test('赛事详情 —— 会员看得到赛事，报名前是「未报名」', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ quota: 8 });

    // 本协会有效会员：能读详情、能报名
    fx.to('demo_muc_member');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });

    assert.strictEqual(page.data.view.found, true);
    assert.strictEqual(page.data.view.event.isSignup, true);
    assert.strictEqual(page.data.view.event.canSignUp, true, '本协会会员可以报名');
    assert.strictEqual(page.data.view.event.mySignupLabel, '未报名');
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 报名成功后状态变为已报名、人数加一', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ quota: 8 });

    fx.to('demo_muc_member');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });
    assert.strictEqual(page.data.view.event.quotaText, '0/8 人');

    await page.onSignUp();

    assert.strictEqual(page.data.view.event.mySignupLabel, '已报名');
    assert.strictEqual(page.data.view.event.quotaText, '1/8 人');
    assert.strictEqual(page.data.view.hasSignups, true);
    assert.strictEqual(page.data.view.signupRows[0].isMe, true);
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 找不到的赛事给出提示而不是白屏', async () => {
  const fx = schoolEventFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId: 'no-such-event' });

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.view.found, false);
    assert.ok(page.data.view.notFoundText.length > 0);
  } finally {
    fx.restore();
  }
});

/**
 * 开发者工具 / 真机把 query 原样透传：`onLoad` 收到的仍是 `%3A` 形式的编码串。
 * 读路径早就做了候选探测，写路径没有——页面拿着编码串去报名，服务端按主键
 * 查不到，只能回「赛事不存在」（2026-10-16 用户实测）。这里锁住修复：
 * 装载器把命中的真实编号回传给页面，页面采纳后所有写操作都落在同一场赛事上。
 */
test('赛事详情 —— 未解码的 query（开发者工具透传）也能报名，页面持有真实编号', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ quota: 8 });
    const encoded = encodeURIComponent(eventId);
    assert.notStrictEqual(encoded, eventId, '前提：S2 编号含需要编码的字符（冒号）');

    fx.to('demo_muc_member');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId: encoded });

    assert.strictEqual(page.data.view.found, true, '未解码的 query 也要打得开这场赛事');
    assert.strictEqual(page.eventId, eventId, '页面必须采纳装载器解析出的真实编号');

    await page.onSignUp();
    assert.strictEqual(page.data.view.event.mySignupLabel, '已报名', '报名要落在真实的赛事主键上');
    assert.strictEqual(page.data.view.event.quotaText, '1/8 人');

    // 进名次页：已解码的编号只编码一次，不能二次编码（二次编码会让名次页也找不到赛事）
    calls.navigations.length = 0;
    page.onOpenPlacement();
    assert.deepStrictEqual(calls.navigations, [
      `/packageEvent/event-placement/event-placement?eventId=${encodeURIComponent(eventId)}`,
    ]);
  } finally {
    fx.restore();
  }
});

test('录入名次 —— 未解码的 query 也能提交并结束赛事', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);

    fx.to('demo_muc_admin');
    const page = instantiate(eventPlacementConfig);
    // 开发者工具 / 真机：query 原样透传
    await page.onLoad({ eventId: encodeURIComponent(eventId) });

    assert.strictEqual(page.eventId, eventId, '名次页也要采纳真实编号');
    assert.strictEqual(page.data.view.canEdit, true);
    assert.strictEqual(page.data.view.rows.length, 2);

    page.data.view.rows.forEach((row, index) => page.onInputPlacement({
      currentTarget: { dataset: { index } }, detail: { value: String(index + 1) },
    }));
    await page.onSubmit();

    const finished = await fx.api().getSchoolEvent({ eventId });
    assert.strictEqual(finished.event.status, EVENT_STATUS.FINISHED, '名次录进的是同一场赛事');
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 开始赛事之后可以给报名者代签', async () => {
  const fx = schoolEventFixture();
  try {
    // 单打双打都要先抽签才能开赛，路线与真人一致：发布 → 两人报名 → 抽签 → 开赛
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);

    fx.to('demo_muc_admin');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });
    assert.strictEqual(page.data.view.event.isOngoing, true);

    const rowOf = (userId) => page.data.view.signupRows.find((row) => row.userId === userId);
    assert.strictEqual(rowOf('demo_muc_member').canCheckIn, true);
    await page.onCheckIn({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });

    assert.strictEqual(rowOf('demo_muc_member').checkedIn, true);
    assert.strictEqual(rowOf('demo_muc_member').canCheckIn, false);
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 管理员在签表上指派裁判，行上随即显示是谁执法', async () => {
  const fx = schoolEventFixture();
  try {
    // 2 人单打抽签后签表有一场待确认的比赛，正是可以指派裁判的场次
    const eventId = await fx.publish({ seedCount: 2 });
    fx.to('demo_muc_member');
    await fx.api().signUpSchoolEvent({ eventId });
    fx.to('demo_muc_admin');
    await fx.api().signUpSchoolEvent({ eventId });
    const drawn = await fx.api().drawSchoolEvent({ eventId, seedValue: 11 });
    assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });

    const row = page.data.view.bracketRows[0];
    assert.ok(row, '抽签后应当有一场签表比赛');
    assert.strictEqual(row.hasReferee, false);
    assert.strictEqual(row.canAssignReferee, true, '管理员在未生效的场次上可以指派');

    await page.onOpenReferee({ currentTarget: { dataset: { matchId: row.matchId } } });
    assert.strictEqual(page.data.referee.open, true);
    assert.ok(page.data.referee.rows.length > 0);

    calls.toasts.length = 0;
    await page.onPickReferee({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });

    const matches = (await fx.api().listSchoolMatches({ eventId })).matches;
    const ledgerRow = matches.find((item) => item.matchId === row.matchId);
    assert.strictEqual(ledgerRow.referee, 'demo_muc_member', '指派已经落库');

    assert.strictEqual(page.data.referee.open, false, '选完即关面板');
    const after = page.data.view.bracketRows[0];
    assert.strictEqual(after.hasReferee, true);
    assert.ok(after.refereeName, '签表行上要显示裁判名字');
    assert.ok(calls.toasts.some((text) => /已指派裁判/.test(text)));
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 普通会员在签表上看不到指派入口', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    fx.to('demo_muc_member');
    await fx.api().signUpSchoolEvent({ eventId });
    fx.to('demo_muc_admin');
    await fx.api().signUpSchoolEvent({ eventId });
    await fx.api().drawSchoolEvent({ eventId, seedValue: 11 });

    // 以参赛者身份看：能录分，但没有指派权
    fx.to('demo_muc_member');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });

    const row = page.data.view.bracketRows[0];
    assert.ok(row);
    assert.strictEqual(row.canAssignReferee, false);
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 单打没抽签就点开始赛事：不生效并提示先抽签', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    fx.to('demo_muc_member');
    await fx.api().signUpSchoolEvent({ eventId });

    fx.to('demo_muc_admin');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });
    // 按钮照常显示，点下去才拿到「请先抽签」——否则管理员不知道还差什么
    assert.strictEqual(page.data.view.event.canStart, true);

    calls.toasts.length = 0;
    await page.onStart();

    assert.strictEqual(page.data.view.event.isOngoing, false, '没抽签不该开始');
    assert.ok(
      calls.toasts.some((text) => /抽签/.test(text)),
      '要明确提示先抽签'
    );
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 手工指定种子：点抽签先弹面板，凑齐人数才真正落签', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedMode: SEED_MODE.MANUAL, seedCount: 2 });
    for (const id of ['demo_muc_member', 'demo_muc_admin']) {
      fx.to(id);
      await fx.api().signUpSchoolEvent({ eventId });
    }

    fx.to('demo_muc_admin');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });

    assert.strictEqual(page.data.view.event.isManualSeed, true);
    assert.strictEqual(page.data.view.manualSeedNeeded, 2, '选定 2 位种子');
    assert.strictEqual(page.data.view.seedCandidates.length, 2, '候选就是两位报名者');

    // 点「开始抽签」：先把点名面板开出来，不能直接按默认顺序抽
    await page.onDraw();
    assert.strictEqual(page.data.seedDialogOpen, true);
    assert.strictEqual(page.data.view.event.drawn, false, '还没点名，签不该落下来');

    // 只点一位就确定：挡下来，说清还差几位
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });
    assert.deepStrictEqual(page.data.seedPicked, ['demo_muc_member']);
    assert.strictEqual(
      page.data.seedRows.find((row) => row.userId === 'demo_muc_member').order, 1, '先点的排 1 号'
    );

    await page.onConfirmSeeds();
    assert.strictEqual(page.data.seedDialogOpen, true, '没凑齐不该关面板');
    assert.ok(page.data.seedError.includes('还需指定 1 位'));
    assert.strictEqual(page.data.view.event.drawn, false);

    // 再点一次已选的人＝取消，方便点错就地改
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });
    assert.deepStrictEqual(page.data.seedPicked, []);

    // 换成先点管理员、后点会员的顺序，凑齐后抽签
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_admin' } } });
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });
    assert.deepStrictEqual(page.data.seedPicked, ['demo_muc_admin', 'demo_muc_member']);
    await page.onConfirmSeeds();

    assert.strictEqual(page.data.seedDialogOpen, false);
    assert.strictEqual(page.data.view.event.drawn, true);
    assert.strictEqual(page.data.view.hasBracket, true);

    const dto = await fx.api().getSchoolEvent({ eventId });
    assert.deepStrictEqual(
      (dto.event.draw.seeds || []).slice().sort(),
      ['demo_muc_admin', 'demo_muc_member'],
      '落库的种子正是点名的那两位（顺序即 1 号、2 号）'
    );
    assert.strictEqual(dto.event.draw.drawCount, 1);
  } finally {
    fx.restore();
  }
});

test('赛事详情 —— 手工种子面板可以清空重选、点遮罩关掉', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedMode: SEED_MODE.MANUAL, seedCount: 2 });
    for (const id of ['demo_muc_member', 'demo_muc_admin']) {
      fx.to(id);
      await fx.api().signUpSchoolEvent({ eventId });
    }

    fx.to('demo_muc_admin');
    const page = instantiate(eventDetailConfig);
    await page.onLoad({ eventId });

    await page.onDraw();
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_member' } } });
    page.onToggleSeed({ currentTarget: { dataset: { userId: 'demo_muc_admin' } } });
    page.onClearSeeds();
    assert.deepStrictEqual(page.data.seedPicked, []);
    assert.deepStrictEqual(page.data.seedRows.map((row) => row.order), [0, 0]);

    page.onCloseSeedDialog();
    assert.strictEqual(page.data.seedDialogOpen, false);
    assert.deepStrictEqual(page.data.seedPicked, []);
    assert.strictEqual(page.data.view.event.drawn, false, '关掉面板什么都没抽');
  } finally {
    fx.restore();
  }
});

/**
 * 摆好发布赛事页的学校维度环境：民大 / 匹克球协会 / 重置过的内存仓储。
 * 发布权是「协会负责人及以上」，民大校管理员（demo_muc_admin）符合；
 * to() 换演示身份，api() 取协会空间客户端核对落库结果，restore() 归位。
 */
function eventEditFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const scope = require('../miniprogram/services/association-scope.js');
  const space = require('../miniprogram/services/association-space.js');
  schoolSession.reset();
  // 用例要自己按标题找刚发布的赛事，关掉演示内容免得赛事列表随它漂移。
  schoolMock.reset({ withDemoContent: false });
  // reset() 把浏览校清成空串；发布按校取数，这里显式摆成民大
  schoolSession.setSchoolId('muc');
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  return {
    to: (actor) => schoolMock.setDemoActor(actor),
    api: (association) => space.forScope({ schoolId: 'muc', association: association || 'pkb' }),
    restore() {
      scope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

test('发布赛事 —— 未登录时不给表单', async () => {
  const fx = eventEditFixture();
  try {
    // 有平台账号但没有学校身份的访客
    fx.to('demo_applicant');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    assert.match(page.data.blockReason, /登录/);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 没有发布权的会员被整页挡住', async () => {
  const fx = eventEditFixture();
  try {
    // 民大会员是在册会员，但不是协会负责人，操盘赛事的入口不给
    fx.to('demo_muc_member');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    assert.match(page.data.blockReason, /权限/);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 等级与三四名赛没选就提交，逐字段报错', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '秋季单打赛' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });

    const before = calls.backCount;
    await page.onSubmit();

    assert.ok(page.data.errors.level, '等级必须显式选择');
    assert.ok(page.data.errors.bronzeMode, '三四名赛方式必须显式选择');
    assert.ok(page.data.errorText.length > 0);
    assert.strictEqual(calls.backCount, before, '没通过校验不该退回');
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 填全后提交落库，并退回上一页', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '秋季单打赛' } });
    page.onPickLevel({ detail: { value: '1' } }); // 下拉第 2 项 = 二级赛事
    page.onPickBronzeMode({ detail: { value: '1' } }); // 下拉第 2 项 = 打三四名
    page.onPickSeedMode({ detail: { value: '1' } }); // 下拉第 2 项 = 按等级分
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputQuota({ detail: { value: '8' } });
    page.onInputCourtCount({ detail: { value: '4' } });

    const before = calls.backCount;
    await page.onSubmit();
    assert.strictEqual(calls.backCount, before + 1);

    const events = (await fx.api().listSchoolEvents({})).events;
    const created = events.find((item) => item.title === '秋季单打赛');
    assert.ok(created, '发布后赛事应在台账里');
    assert.strictEqual(created.level, EVENT_LEVEL.SECOND);
    assert.strictEqual(created.bronzeMode, EVENT_BRONZE_MODE.PLAYOFF);
    assert.strictEqual(created.seedMode, SEED_MODE.ELO);
    assert.strictEqual(created.seedCount, 8, '种子数量默认 8');
    assert.strictEqual(created.drawn, false, '创建时还没抽签');
    assert.strictEqual(created.status, EVENT_STATUS.SIGNUP);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 勾选小组后发布，落库带报名资格限制（B6 选择器）', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    // 先建一个小组，供表单勾选
    const createdGroup = await fx.api().createAssociationGroup({
      requestId: 'page_group_1', name: '精英组', memberIds: ['demo_muc_member'],
    });
    assert.strictEqual(createdGroup.ok, true, createdGroup.message);

    const page = instantiate(eventEditConfig);
    await page.onLoad();
    assert.ok(page.data.groups.length > 0, '表单加载小组清单');

    page.onInputTitle({ detail: { value: '小组限定赛' } });
    page.onPickLevel({ detail: { value: '0' } });
    page.onPickBronzeMode({ detail: { value: '0' } });
    page.onPickSeedMode({ detail: { value: '0' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputCourtCount({ detail: { value: '2' } });

    page.onPickAudience({ detail: { value: '1' } });
    assert.strictEqual(page.data.audienceIndex, 1);
    page.onToggleGroup({ currentTarget: { dataset: { groupId: createdGroup.group.groupId } } });
    assert.deepStrictEqual(page.data.selectedGroupIds, [createdGroup.group.groupId]);

    await page.onSubmit();

    const events = (await fx.api().listSchoolEvents({})).events;
    const created = events.find((item) => item.title === '小组限定赛');
    assert.ok(created, '发布后赛事应在台账里');
    assert.strictEqual(created.audienceMode, 'groups');
    assert.deepStrictEqual(created.audienceGroupIds, [createdGroup.group.groupId]);

    // 未勾选任何小组就选「仅限小组」：服务端拒绝（buildAudience 同一把尺子）
    const page2 = instantiate(eventEditConfig);
    await page2.onLoad();
    page2.onInputTitle({ detail: { value: '空组赛事' } });
    page2.onPickLevel({ detail: { value: '0' } });
    page2.onPickBronzeMode({ detail: { value: '0' } });
    page2.onPickSeedMode({ detail: { value: '0' } });
    page2.onPickDate({ detail: { value: '2026-06-11' } });
    page2.onPickTime({ detail: { value: '09:00' } });
    page2.onInputCourtCount({ detail: { value: '2' } });
    page2.onPickAudience({ detail: { value: '1' } });
    await page2.onSubmit();
    assert.match(page2.data.errorText, /至少选择一个小组/);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 选循环赛落库带上赛制，组数与出线人数留空、排位不启用', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '循环赛测试' } });
    page.onPickFormat({ detail: { value: '1' } }); // 下拉第 2 项 = 循环赛
    page.onPickLevel({ detail: { value: '1' } });
    page.onPickBronzeMode({ detail: { value: '1' } });
    page.onPickSeedMode({ detail: { value: '1' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputQuota({ detail: { value: '8' } });
    page.onInputCourtCount({ detail: { value: '4' } });

    await page.onSubmit();

    const created = (await fx.api().listSchoolEvents({})).events
      .find((item) => item.title === '循环赛测试');
    assert.ok(created, '循环赛赛事应当落库');
    assert.strictEqual(created.format, EVENT_FORMAT.ROUND_ROBIN);
    assert.strictEqual(created.groupCount, null, '循环赛恒为单组，不落组数');
    assert.strictEqual(created.advancePerGroup, null);
    assert.strictEqual(
      created.placementMode,
      EVENT_PLACEMENT_MODE.NONE,
      '循环赛没有淘汰阶段，倒三角排位不启用'
    );
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 小组赛可选出线人数，组数与出线人数一并落库', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '小组赛测试' } });
    page.onPickFormat({ detail: { value: '2' } }); // 下拉第 3 项 = 小组赛
    page.onPickGroupCount({ detail: { value: '0' } }); // 第 1 项 = 2 组
    page.onPickAdvance({ detail: { value: '1' } }); // 第 2 项 = 每组出线 2 人
    page.onPickLevel({ detail: { value: '1' } });
    page.onPickBronzeMode({ detail: { value: '1' } });
    page.onPickSeedMode({ detail: { value: '1' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputQuota({ detail: { value: '8' } });
    page.onInputCourtCount({ detail: { value: '4' } });

    await page.onSubmit();

    const created = (await fx.api().listSchoolEvents({})).events
      .find((item) => item.title === '小组赛测试');
    assert.ok(created, '小组赛赛事应当落库');
    assert.strictEqual(created.format, EVENT_FORMAT.GROUP_KNOCKOUT);
    assert.strictEqual(created.groupCount, 2);
    assert.strictEqual(created.advancePerGroup, 2);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 切到双打：赛制保留，种子来源去掉「按赛季积分」', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onPickFormat({ detail: { value: '2' } });
    assert.strictEqual(page.data.form.format, EVENT_FORMAT.GROUP_KNOCKOUT);

    // 单打下先选一个双打没有的来源，验证切换时会被清掉
    page.onPickSeedMode({ detail: { value: '2' } });
    assert.strictEqual(page.data.form.seedMode, SEED_MODE.POINTS);

    page.onPickMatchType({ detail: { value: '1' } }); // 双打

    // 双打与单打同步：赛制照常可选，不再被一刀收回单败
    assert.strictEqual(page.data.form.format, EVENT_FORMAT.GROUP_KNOCKOUT);
    assert.strictEqual(page.data.formatIndex, 2);

    // 来源只剩手工 / 等级分两项，「按赛季积分」不再出现
    assert.deepStrictEqual(page.data.seedModes, ['手工指定', '按等级分']);
    assert.strictEqual(page.data.seedModeIndex, 0);
    assert.strictEqual(page.data.form.seedMode, '', '原先选的按积分在双打下不合法，要清掉重选');
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 选双败淘汰：可关掉总决赛重赛，组数与三四名留空', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '双败测试' } });
    page.onPickFormat({ detail: { value: '4' } }); // 下拉第 5 项 = 双败淘汰
    page.onToggleGfReset({ detail: { value: false } });
    page.onPickLevel({ detail: { value: '1' } });
    page.onPickSeedMode({ detail: { value: '1' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputQuota({ detail: { value: '8' } });
    page.onInputCourtCount({ detail: { value: '4' } });

    await page.onSubmit();

    const created = (await fx.api().listSchoolEvents({})).events
      .find((item) => item.title === '双败测试');
    assert.ok(created, '双败赛事应当落库');
    assert.strictEqual(created.format, EVENT_FORMAT.DOUBLE_ELIM);
    assert.strictEqual(created.gfReset, false, '关掉重赛要落库');
    assert.strictEqual(created.groupCount, null, '双败不分组，不落组数');
    assert.strictEqual(created.advancePerGroup, null);
    assert.strictEqual(created.bronzeMode, null, '双败名次由败者组排出，没有三四名赛');
    assert.strictEqual(created.placementMode, EVENT_PLACEMENT_MODE.NONE);
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 小组赛+双败：出线人数不足 4 人时挡下不落库', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '双败人不够' } });
    page.onPickFormat({ detail: { value: '5' } }); // 下拉第 6 项 = 小组赛+双败
    page.onPickGroupCount({ detail: { value: '0' } }); // 2 组
    page.onPickAdvance({ detail: { value: '0' } }); // 每组出线 1 人 → 共 2 人
    page.onPickLevel({ detail: { value: '1' } });
    page.onPickSeedMode({ detail: { value: '1' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });

    await page.onSubmit();

    assert.ok(page.data.errors.advancePerGroup, '要给出线人数一条错误提示');
    const created = (await fx.api().listSchoolEvents({})).events
      .find((item) => item.title === '双败人不够');
    assert.strictEqual(created, undefined, '排不出败者组，不该落库');
  } finally {
    fx.restore();
  }
});

test('发布赛事 —— 小组赛+双败：2 组出线 2 人（共 4 人）正常落库', async () => {
  const fx = eventEditFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(eventEditConfig);
    await page.onLoad();

    page.onInputTitle({ detail: { value: '小组双败测试' } });
    page.onPickFormat({ detail: { value: '5' } });
    page.onPickGroupCount({ detail: { value: '0' } }); // 2 组
    page.onPickAdvance({ detail: { value: '1' } }); // 每组出线 2 人
    page.onPickLevel({ detail: { value: '1' } });
    page.onPickSeedMode({ detail: { value: '1' } });
    page.onPickDate({ detail: { value: '2026-06-10' } });
    page.onPickTime({ detail: { value: '09:00' } });
    page.onInputCourtCount({ detail: { value: '4' } });

    await page.onSubmit();

    const created = (await fx.api().listSchoolEvents({})).events
      .find((item) => item.title === '小组双败测试');
    assert.ok(created, '小组赛+双败应当落库');
    assert.strictEqual(created.format, EVENT_FORMAT.GROUP_DOUBLE_ELIM);
    assert.strictEqual(created.groupCount, 2);
    assert.strictEqual(created.advancePerGroup, 2);
    assert.strictEqual(created.gfReset, true, '重赛默认开启');
  } finally {
    fx.restore();
  }
});

/**
 * 学校维度个人赛夹具（名次页用例）。
 * 民大 + pkb 的干净台账（不带演示内容），演示身份可随手切换。
 * 与发布页用例的 eventEditFixture 同一套绑法：to() 换身份，api() 取空间客户端核对落库。
 *
 * 名次页已改接学校维度：读走 loadSchoolEventPlacementView，写走
 * finishSchoolEvent，两者都经 association-space。这里就用真的 schoolMock
 * 摆一场赛事，页面按当前演示身份取数——不必替任何门面打桩。
 */
function eventPanelTest(name, fn) {
  test(name, async () => {
    const fx = schoolEventFixture();
    require('../miniprogram/services/school-mock').reset();
    try {
      await fx.publish({ title: '列表测试一' });
      await fx.publish({ title: '列表测试二' });
      fx.to('demo_muc_admin');
      await fn(fx);
    } finally { fx.restore(); }
  });
}

/**
 * 校级赛事的页面夹具。
 *
 * @param {string} [associationId='pkb'] 协会作用域。网球要单独传 'tn'——
 *   赛事与比赛的默认赛制是从协会注册表取的（见 associations.defaultFormatOf）。
 */
function schoolEventFixture(associationId = 'pkb') {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const assocScope = require('../miniprogram/services/association-scope.js');
  const space = require('../miniprogram/services/association-space.js');
  schoolSession.reset();
  schoolMock.reset({ withDemoContent: false });
  schoolSession.setSchoolId('muc');
  const before = assocScope.getAssociation();
  assocScope.setAssociation(associationId);
  const api = () => space.forScope({ schoolId: 'muc', association: associationId });
  return {
    to: (actor) => schoolMock.setDemoActor(actor),
    api,
    /** 管理员发布一场单打，返回 eventId */
    async publish(overrides = {}) {
      schoolMock.setDemoActor('demo_muc_admin');
      const res = await api().publishSchoolEvent({
        requestId: `req_${Math.random().toString(36).slice(2, 10)}`,
        title: '名次页测试赛', description: '', matchType: MATCH_TYPE.SINGLES, level: EVENT_LEVEL.THIRD,
        format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: 'tied', seedMode: SEED_MODE.ELO, seedCount: 4,
        startTime: '2026-06-10T09:00:00', courtCount: 2, ...overrides,
      });
      assert.strictEqual(res.ok, true, `发布失败：${res.message}`);
      return res.event.eventId;
    },
    /** 让若干会员各自报名，随后管理员抽签、开赛——与真人路线一致 */
    async play(eventId, actorIds) {
      for (const id of actorIds) {
        schoolMock.setDemoActor(id);
        const r = await api().signUpSchoolEvent({ eventId });
        assert.strictEqual(r.ok, true, `报名失败（${id}）：${r.message}`);
      }
      schoolMock.setDemoActor('demo_muc_admin');
      const drawn = await api().drawSchoolEvent({ eventId, seedValue: 42 });
      assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);
      const started = await api().startSchoolEvent({ eventId });
      assert.strictEqual(started.ok, true, `开赛失败：${started.message}`);
      return drawn;
    },
    restore() {
      assocScope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

test('个人赛事 S2 闭环：列表进详情、实时计分、确认、名次结束后积分可见', async () => {
  const fx = schoolEventFixture();
  const queryFrom = url => Object.fromEntries(new URLSearchParams(url.split('?')[1]));
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    const list = instantiate(eventListConfig);
    await list.onLoad({ type: 'event' });
    assert.equal(list.data.view.events.length, 1);
    list.onOpenEvent({ currentTarget: { dataset: { eventId } } });
    const detail = instantiate(eventDetailConfig);
    await detail.onLoad(queryFrom(calls.navigations.at(-1)));
    assert.equal(detail.eventId, eventId);
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);
    await detail.refresh();
    const matches = await fx.api().listSchoolMatches({ eventId });
    const matchId = matches.matches[0].matchId;
    detail.onRecordMatch({ currentTarget: { dataset: { matchId } } });
    // 录分入口必须进「可手填比分」的录入页：实时计分只是这一页顶部的一个选项，
    // 很多场次由管理员照边裁报分补录，没有逐球过程
    const entryUrl = calls.navigations.at(-1);
    assert.ok(entryUrl.startsWith('/packageEvent/match-entry/match-entry?'), `录分入口跳错页：${entryUrl}`);
    assert.equal(queryFrom(entryUrl).matchId, matchId);
    // 录入页要真的能填：逐局比分输入仍在（不能只剩实时计分一条路）
    const entry = instantiate(matchEntryConfig);
    await entry.onLoad({ matchId });
    assert.equal(entry.data.blockReason, '', entry.data.blockReason);
    assert.equal(entry.data.scheduled, true);
    assert.ok(entry.data.scoreRows.length > 0, '签表比赛的录入页应保留逐局比分输入');
    // 从录入页走「实时计分」这条路：同编号进计分台，把逐球流程走完
    const score = instantiate(liveScoreConfig);
    await score.onLoad({ matchId });
    for (let i = 0; i < 22; i += 1) score.onScore({ currentTarget: { dataset: { side: 'A' } } });
    await score.queue;
    score.onFinish();
    await score.queue;
    await detail.onConfirmMatch({ currentTarget: { dataset: { matchId } } });
    assert.equal((await fx.api().getSchoolMatch({ matchId })).match.status, MATCH_STATUS.ACTIVE);
    detail.onOpenPlacement();
    const placement = instantiate(eventPlacementConfig);
    await placement.onLoad(queryFrom(calls.navigations.at(-1)));
    placement.data.view.rows.forEach((row, index) => placement.onInputPlacement({ currentTarget: { dataset: { index } }, detail: { value: String(index + 1) } }));
    await placement.onSubmit();
    assert.equal((await fx.api().getSchoolEvent({ eventId })).event.status, EVENT_STATUS.FINISHED);
    const panel = instantiate(eventsConfig);
    await panel.onLoad();
    assert.equal(panel.data.error, '');
    assert.equal(panel.data.view.events[0].isFinished, true);
    assert.equal(panel.view.allRows.length, 2);
    assert.ok(panel.view.allRows.every(row => Number(row.valueText) > 0), '名次积分必须进入 S2 回放');
    fx.to('demo_buaa_admin');
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    await panel.refresh();
    assert.equal(panel.data.error, '');
    assert.equal(panel.data.view.events.length, 0);
    assert.equal(panel.view.allRows.length, 0, '外校不可串赛事积分');
  } finally { fx.restore(); }
});

test('录入名次 —— 无管理权时整页挡住，不给名单', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish();

    // 普通会员（在册但非管理员）看这一页：allowed 为假，一条名单都不下发
    fx.to('demo_muc_member');
    const page = instantiate(eventPlacementConfig);
    await page.onLoad({ eventId });

    assert.strictEqual(page.data.view.allowed, false);
    assert.ok(page.data.view.blockedText.length > 0);
    assert.deepStrictEqual(page.data.view.rows, []);
  } finally {
    fx.restore();
  }
});

test('录入名次 —— 一个名次都没填就提交，给出提示', async () => {
  const fx = schoolEventFixture();
  try {
    // 单打双打都要先抽签，路线与真人一致：发布 → 两人报名 → 抽签 → 开赛
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);

    fx.to('demo_muc_admin');
    const page = instantiate(eventPlacementConfig);
    await page.onLoad({ eventId });
    assert.strictEqual(page.data.view.canEdit, true);

    await page.onSubmit();
    assert.ok(page.data.errorText.length > 0);
  } finally {
    fx.restore();
  }
});

test('录入名次 —— 提交后赛事结束、名次落定', async () => {
  const fx = schoolEventFixture();
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);

    fx.to('demo_muc_admin');
    const page = instantiate(eventPlacementConfig);
    await page.onLoad({ eventId });
    assert.strictEqual(page.data.view.rows.length, 2);

    // 不假设名次名单的先后次序，按页面给的顺序取人，再核对能对应上
    const first = page.data.view.rows[0].userId;
    const second = page.data.view.rows[1].userId;

    page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });
    page.onInputPlacement({ currentTarget: { dataset: { index: 1 } }, detail: { value: '2' } });

    const before = calls.backCount;
    await page.onSubmit();
    assert.strictEqual(calls.backCount, before + 1);

    const dto = await fx.api().getSchoolEvent({ eventId });
    assert.strictEqual(dto.event.status, EVENT_STATUS.FINISHED);
    assert.deepStrictEqual(
      dto.event.results.map((row) => ({ userId: row.userId, placement: row.placement })),
      [{ userId: first, placement: 1 }, { userId: second, placement: 2 }]
    );
  } finally {
    fx.restore();
  }
});

test('录入名次 —— 双打一行摊到两名成员（按队录入的落库口径）', () => {
  // 双打页面按队给行、提交时一行摊两人，是 collectResults 的纯逻辑；
  // 队伍行的展示（一行两人、名字顿号相连）由 school-event-view.test.js 覆盖。
  const page = instantiate(eventPlacementConfig);
  page.data.view = {
    rows: [
      { userId: 'demo_muc_member|demo_muc_member_2', userIds: ['demo_muc_member', 'demo_muc_member_2'], placementText: '1' },
      { userId: 'demo_muc_member_3|demo_muc_member_4', userIds: ['demo_muc_member_3', 'demo_muc_member_4'], placementText: '' },
    ],
  };

  const collected = page.collectResults();
  assert.strictEqual(collected.error, '');
  assert.deepStrictEqual(collected.results, [
    { userId: 'demo_muc_member', placement: 1 },
    { userId: 'demo_muc_member_2', placement: 1 },
  ]);
});

/* ============================================================
 * 登录 / 注册（B3：统一走学校维度 S2）
 * ============================================================ */

test('登录页 —— 未登录时停在入口，提供登录与注册两个选择', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  await page.onLoad();

  assert.strictEqual(page.data.step, 'entry');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(page.data.isMock, true);
});

test('登录页 —— 已登录时显示账号卡片，可退出登录', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(loginConfig);
  await page.onLoad();
  assert.strictEqual(page.data.existing.loggedIn, true);
  // S2 权威会话覆盖旧快照：u06 的昵称按账号真实值校正
  assert.strictEqual(page.data.existing.nickName, '明宇');
  assert.strictEqual(page.data.existing.statusLabel, '正常');

  page.onLogout();
  assert.strictEqual(app.globalData.userInfo, null, '退出登录要把全局登录态清掉');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(appSession.get(), null, '统一会话一并清掉');
});

test('登录页 —— 一键登录写入统一会话并回到首页', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  await page.onLoad();

  calls.tabSwitches.length = 0;
  await page.onLogin();

  assert.ok(app.globalData.userInfo, '登录态没有写进全局');
  assert.strictEqual(app.globalData.userInfo._id, 'u06', '默认演示身份是 u06');
  assert.strictEqual(appSession.get().session.user.userId, 'u06', '统一会话与兼容视图是同一个人');
  assert.strictEqual(page.data.submitting, false);
  assert.deepStrictEqual(calls.tabSwitches, ['/pages/index/index']);
});

test('登录页 —— 服务端没有这个账号时，引导去注册而不是让人干重试', async () => {
  resetSession();
  // 换台设备最常见的情形：这个微信身份在服务端还没有账号
  schoolIdentity.simulateNewWechat('no_account_1');

  const page = instantiate(loginConfig);
  await page.onLoad();

  calls.tabSwitches.length = 0;
  await page.onLogin();

  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual(app.globalData.userInfo, null, '没有账号就不该写入登录态');
  assert.match(page.data.errorText, /新会员注册/, '要告诉他下一步该点哪里');
  assert.deepStrictEqual(calls.tabSwitches, [], '没登录成功不能回首页');
});

test('登录页 —— 演示「模拟新微信号」把登录态清掉并进入无账号引导', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();
  const page = instantiate(loginConfig);
  await page.onLoad();
  assert.strictEqual(page.data.existing.loggedIn, true);

  await page.onSimulateNewWechat();

  assert.strictEqual(app.globalData.userInfo, null, '换微信身份等于换登录人');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(page.data.step, 'entry');
});

test('登录页 —— 表单校验不过时不提交，并逐字段报错', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();

  assert.strictEqual(page.data.step, 'profile');

  // 注册要走数据源，onSubmit 因此是异步的——不等它跑完，断言会跑在错误之前
  await page.onSubmit();

  // 一项都没填，四个必填字段都该有错误提示（学号 / 学院归学校身份，仍必填）
  assert.ok(page.data.errors.realName);
  assert.ok(page.data.errors.gender);
  assert.ok(page.data.errors.studentId);
  assert.ok(page.data.errors.college);
  assert.strictEqual(page.data.errorText, page.data.errors.realName);
  assert.strictEqual(page.data.step, 'profile', '校验失败不能跳到待审核');
  assert.strictEqual(app.globalData.userInfo, null, '校验失败不该写入登录态');
});

test('登录页 —— 填写完整后提交，申请落进 S2 数据源并停在待审核', async () => {
  resetSession();
  schoolIdentity.simulateNewWechat('newreg_1');
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();

  fillValidForm(page);
  await page.onSubmit();

  assert.strictEqual(page.data.step, 'pending');
  assert.strictEqual(page.data.pending.statusLabel, '待审核');
  assert.strictEqual(page.data.pending.realName, '马小雨');
  assert.ok(page.data.pending.studentId);
  assert.strictEqual(page.data.submitting, false, '提交完要把按钮解冻');

  assert.ok(app.globalData.userInfo, '注册后应把账号写进登录态');
  assert.strictEqual(app.globalData.userInfo.status, 0, '新账号的兼容状态是待审核');
  assert.strictEqual(page.data.existing.isPending, true);

  // 申请落在 S2：同一微信身份读得到自己的待审核学校身份
  const session = await schoolIdentity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' })
    .getSchoolIdentitySession();
  assert.strictEqual(session.account.status, 'pending', '学校身份申请应落在 S2');
  assert.strictEqual(session.account.studentId, '2023001234');
  assert.ok(session.user.userId, '平台账号已开通');
});

test('登录页 —— 已经有账号的人再提交，结果页不说「申请已提交」', async () => {
  resetSession();
  // 默认演示身份 u06 已有账号且学校身份正常：注册入口原样返回，不改写实名
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();
  fillValidForm(page);
  await page.onSubmit();

  assert.strictEqual(page.data.pending.title, '你已经是会员了');
  assert.strictEqual(page.data.pending.actionLabel, '进入首页');
  assert.strictEqual(page.data.pending.statusClass, 'tag-success', '已经是正常会员，不能再挂黄色的待审核标签');
  assert.strictEqual(app.globalData.userInfo._id, 'u06', '登录态是原有账号');
});

test('登录页 —— 真的待审核时结果页仍是「申请已提交」', () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();

  const described = page.describe({
    session: {
      user: { userId: 'acc_x', nickName: '马小雨', realName: '马小雨', gender: 'M', avatarUrl: '',
        primarySchoolId: 'muc', platformStatus: 'active' },
      account: { status: 'pending', studentId: '2023001234', collegeId: 'c01' },
      permission: '', permissionLabel: '会员', isPlatformAdmin: false,
    },
    profile: null,
    collegeName: '',
  });
  page.showPending(described);

  assert.strictEqual(page.data.pending.title, '申请已提交');
  assert.strictEqual(page.data.pending.actionLabel, '先随便逛逛');
  assert.strictEqual(page.data.pending.statusClass, 'tag-warning');
});

test('登录页 —— 已驳回的会员登录时明确告知，并给重新申请入口', async () => {
  resetSession();
  // 造一个「申请被驳回」的微信身份：先注册申请，再由管理员驳回
  schoolIdentity.simulateNewWechat('rejected_1');
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();
  fillValidForm(page);
  await page.onSubmit();
  assert.strictEqual(page.data.pending.statusLabel, '待审核');

  schoolMock.setDemoActor('demo_muc_admin');
  const adminApi = schoolIdentity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  const applications = await adminApi.getSchoolApplications();
  const row = applications.applications[0];
  await adminApi.reviewSchoolMembership({ userId: row.userId, decision: 'reject', revision: row.revision, reason: '请核实学号' });

  // 切回被驳回的微信身份重新进入登录页
  schoolIdentity.simulateNewWechat('rejected_1');
  const again = instantiate(loginConfig);
  await again.onLoad();
  await again.onLogin();

  assert.strictEqual(again.data.step, 'pending');
  assert.strictEqual(again.data.pending.title, '申请已被驳回');
  assert.strictEqual(again.data.existing.isRejected, true);
  assert.strictEqual(again.data.existing.needsApplication, true);
});

test('登录页 —— 待审核那一步也能退出登录，并退回入口', async () => {
  resetSession();
  schoolIdentity.simulateNewWechat('newreg_2');
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();
  fillValidForm(page);
  await page.onSubmit();
  assert.strictEqual(page.data.step, 'pending');

  // 待审核页上不给退出，人就被锁在这一屏了
  page.onLogout();
  assert.strictEqual(page.data.step, 'entry', '退出后应回到入口，不能停在待审核');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(app.globalData.userInfo, null);
});

test('登录页 —— 输入或选择学院会把该项的旧错误清掉', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  await page.onLoad();
  page.onGoRegister();
  await page.onSubmit();
  assert.ok(page.data.errors.realName);

  page.onInput({ currentTarget: { dataset: { field: 'realName' } }, detail: { value: '马小雨' } });
  assert.strictEqual(page.data.form.realName, '马小雨');
  assert.strictEqual(page.data.errors.realName, '');

  page.onPickCollege({ detail: { value: 0 } });
  assert.strictEqual(page.data.errors.college, '');
  assert.ok(page.data.form.collegeId);
  assert.ok(page.data.form.college, '学院全名跟着目录一起填上');
});

/** 往注册表单里填一份合法数据（学院候选来自 S2 学校目录） */
function fillValidForm(page) {
  const values = { realName: '马小雨', studentId: '2023001234' };
  for (const [field, value] of Object.entries(values)) {
    page.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  page.onPickGender({ detail: { value: 0 } }); // 下拉第 1 项 = 男
  page.onPickCollege({ detail: { value: 0 } }); // 目录第一所学院
}

/* ============================================================
 * 比赛页
 * ============================================================ */

/** 造一个「已登录且审核通过」的会员——录入要求这个身份 */
function activeMember(overrides = {}) {
  return fakeMember({ _id: 'u06', status: 1, ...overrides });
}

/**
 * 管理员。撤销是「改写已生效的账本」，只留给他。
 * 用的是种子里那位真管理员（u01 巴特尔）：写接口查的是台账里的角色，
 * 光把 userInfo 的 role 改大是骗不过门面的。
 */
function adminMember(overrides = {}) {
  return activeMember({ _id: ADMIN_ID, nickName: '巴特尔', role: ROLE.ADMIN, ...overrides });
}

/** 一场可以直接提交的单打：我 vs 对手，11 分制三局两胜 */
function pendingParams() {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: [ME],
    teamB: [RIVAL],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    // 排在种子最后一场（8 月 22 日）之后，必然落在最近一批里，
    // 不受比赛页默认条数截断的影响
    matchTime: '2026-09-01T10:00:00',
    location: '学校体育馆 1 号场',
  };
}

function schoolMatchTest(name, run) {
  test(name, async () => {
    const session = require('../miniprogram/services/school-session');
    const association = require('../miniprogram/services/association-scope');
    const oldScope = { schoolId: session.getSchoolId(), association: association.getAssociation() };
    session.setSchoolId('muc'); association.setAssociation('pkb');
    const fixture = require('./helpers/school-match-fixture').createMatchFixture(() => app.globalData.userInfo);
    try { await run(fixture); }
    finally { fixture.restore(); session.setSchoolId(oldScope.schoolId); association.setAssociation(oldScope.association); }
  });
}

test('普通比赛 S2：录入重试幂等、本人列表、对手确认、管理员撤销、跨校隔离', async () => {
  const fx = schoolEventFixture();
  try {
    fx.to('demo_muc_member');
    const entry = instantiate(matchEntryConfig);
    await entry.onLoad();
    assert.equal(entry.data.form.teamA[0], 'demo_muc_member');
    entry.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: 'demo_muc_admin' } } });
    for (const [side, value] of [['A', '11'], ['B', '7']]) for (const slot of [0, 1]) entry.onInputScore({ currentTarget: { dataset: { side, slot } }, detail: { value } });
    await entry.onSubmit();
    await entry.onSubmit();
    assert.equal(entry.data.errorText, '');
    let list = await fx.api().listSchoolMatches({});
    assert.equal(list.matches.length, 1, '网络重试不会新建第二场');
    const matchId = list.matches[0].matchId;
    const panel = instantiate(matchConfig);
    await panel.onLoad();
    assert.equal(panel.data.view.records[0].matchId, matchId);
    fx.to('demo_muc_admin');
    await panel.refresh();
    await panel.onConfirm({ currentTarget: { dataset: { matchId } } });
    const stored = (await fx.api().getSchoolMatch({ matchId })).match;
    assert.equal(stored.status, MATCH_STATUS.ACTIVE);
    assert.ok(stored.settlement, '确认即结算：比赛带结算快照');
    // 撤销已删除；确认前驳回仍在。这里用驳回验证同一块面板的写入恢复路径。
    const pending = await fx.api().submitSchoolMatch({ requestId: 'panel_reject_case',
      matchType: MATCH_TYPE.SINGLES, teamA: ['demo_muc_admin'], teamB: ['demo_muc_member'],
      scoreA: [11, 11], scoreB: [9, 7], gamePoints: 11, bestOf: 3, matchTime: '2026-09-02T10:00:00', location: '' });
    assert.equal(pending.ok, true, pending.message);
    panel.onOpenAction({ currentTarget: { dataset: { matchId: pending.match.matchId, kind: 'reject' } } });
    panel.onInputReason({ detail: { value: '比分有误' } });
    await panel.onSubmitAction();
    assert.equal((await fx.api().getSchoolMatch({ matchId: pending.match.matchId })).match.status, MATCH_STATUS.REVOKED);
    fx.to('demo_buaa_member');
    require('../miniprogram/services/school-session').setSchoolId('buaa');
    await panel.refresh();
    assert.deepEqual(panel.data.view.records, []);
    assert.equal(panel.data.auth.canRecord, true);
  } finally { fx.restore(); }
});

test('比赛面板 S2：读取失败清掉旧台账，写入异常解除提交状态', async () => {
  const fx = schoolEventFixture();
  const space = require('../miniprogram/services/association-space');
  const original = space.forScope;
  try {
    fx.to('demo_muc_admin');
    const panel = instantiate(matchConfig);
    await panel.onLoad();
    // 客户端不可变，用替代客户端模拟网络失败。
    panel.api = { rejectSchoolMatch: async () => { throw new Error('网络故障'); } };
    panel.onOpenAction({ currentTarget: { dataset: { matchId: 'missing', kind: 'reject' } } });
    panel.onInputReason({ detail: { value: '测试异常恢复' } });
    await panel.onSubmitAction();
    assert.equal(panel.data.acting, false);
    assert.match(panel.data.actionError, /网络故障/);
    space.forScope = () => ({ getSchoolMatchEntryContext: async () => { throw new Error('读取失败'); } });
    await panel.refresh();
    assert.deepEqual(panel.data.view, {});
    assert.equal(panel.data.auth.canRecord, false);
  } finally { space.forScope = original; fx.restore(); }
});

const ME = 'u06';
const RIVAL = 'u02';
/** 种子里的管理员（u01 巴特尔） */
const ADMIN_ID = 'u01';

schoolMatchTest('比赛页 —— 访客看不到台账，录入入口与空态都给登录引导', async (facade) => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.viewer.loggedIn, false);
  assert.strictEqual(page.data.auth.canRecord, false);
  assert.match(page.data.entryHint, /登录/);
  // 访客没有「自己的比赛」可言：台账不下发，空态引导去登录
  assert.deepStrictEqual(page.data.view.records, []);
  assert.strictEqual(page.data.view.needLogin, true);
  assert.match(page.data.view.emptyText, /登录/);
});

schoolMatchTest('比赛页 —— 访客点登录按钮跳到登录页', async (facade) => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

schoolMatchTest('比赛页 —— 登录后看到台账与自己的录入权限', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.loggedIn, true);
  assert.strictEqual(page.data.auth.canRecord, true);
  assert.strictEqual(page.data.view.viewer.loggedIn, true);
  assert.match(page.data.entryHint, /计入等级分/);
  assert.strictEqual(page.data.view.tabs.filter((item) => item.active).length, 1);
});

schoolMatchTest('比赛页 —— 默认落在「我的比赛」，页面上只列自己参加过的', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.activeTab, 'mine');
  assert.deepStrictEqual(
    page.data.view.tabs.map((item) => item.tab),
    ['mine', 'pending'],
    '只剩「我的比赛」与「待确认」两个标签，没有「全部比赛」'
  );
  assert.ok(page.data.view.records.length > 0);
  assert.ok(page.data.view.records.every((row) => row.isMine));
});

schoolMatchTest('比赛页 —— 重复点当前标签不做无谓的重新加载', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchTab({ currentTarget: { dataset: { tab: page.data.view.activeTab } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

schoolMatchTest('比赛页 —— 台账每场都带赛制文案，11 分制三局两胜渲染得出来', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  const rows = page.data.view.records;
  assert.ok(rows.some((row) => row.formatText === '11 分制 · 三局两胜'));
  for (const row of rows) {
    // 老数据没有赛制时是空串，由模板挡住，不能是 undefined
    if (row.formatText) assert.match(row.formatText, /^\d+ 分制 · (一局一胜|三局两胜|五局三胜)$/);
  }
});

schoolMatchTest('比赛页 —— 未登录时点录入只给提示，不进录入页', async (facade) => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.toasts.length = 0;
  calls.navigations.length = 0;
  page.onGoEntry();

  assert.deepStrictEqual(calls.navigations, [], '没有身份就不该进录入页');
  assert.ok(calls.toasts.some((text) => /登录/.test(text)));
});

schoolMatchTest('比赛页 —— 待审核账号不能录入，提示写明原因', async (facade) => {
  resetSession();
  // 本地注册的账号状态是待审核，能登录但还没通过实名核对
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.match(page.data.entryHint, /有效身份/);

  calls.toasts.length = 0;
  calls.navigations.length = 0;
  page.onGoEntry();

  assert.deepStrictEqual(calls.navigations, []);
  assert.ok(calls.toasts.some((text) => /有效身份/.test(text)));
});

schoolMatchTest('比赛页 —— 正常账号点录入跳到录入页', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoEntry();
  assert.deepStrictEqual(calls.navigations, ['/packageEvent/match-entry/match-entry']);
});

schoolMatchTest('比赛页 —— 点队名跳到该会员主页', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/packageMember/member/member?userId=u01']);
});

schoolMatchTest('比赛页 —— 确认后成绩计入等级分，待确认标签随即空掉', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  // 只有已生效的比赛才进回放集，多出一场即证明它已计入等级分
  const before = (await facade.getMatches()).length;

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'pending' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row, '刚提交的比赛应当出现在待确认里');
  assert.strictEqual(row.statusLabel, '待确认');
  assert.strictEqual(row.canConfirm, true);

  calls.toasts.length = 0;
  await page.onConfirm({ currentTarget: { dataset: { matchId: match._id } } });

  assert.strictEqual((await facade.getMatches()).length, before + 1);
  // 种子里演示赛事还留着两场没打的半决赛，它们仍会出现在待确认里；
  // 要断言的是「刚确认的那一场」已经退出了待确认
  assert.ok(
    !page.data.view.records.some((item) => item.matchId === match._id),
    '确认之后待确认里就不该再有它'
  );
  assert.ok(calls.toasts.some((text) => /已计入等级分/.test(text)));
});

schoolMatchTest('比赛页 —— 确认即最终结算：无撤销入口，重开面板也不会出现撤销文案', async (facade) => {
  resetSession();
  app.globalData.userInfo = adminMember();

  // 让管理员本人就在场上：这样「我参与的」一栏里找得到它
  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN_ID],
    teamB: [RIVAL],
  });
  await facade.confirmMatch(match._id, RIVAL);

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual('canRevoke' in row, false, '任何角色都没有撤销旗标');

  // 绕过界面直接构造撤销动作：面板没有对应文案，直接忽略
  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'revoke' } } });
  assert.strictEqual(page.data.action.open, false, '撤销动作不再打开任何面板');

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.ACTIVE, '成绩保持生效');
});

schoolMatchTest('比赛页 —— 撤销已取消：已结算比赛驳回也被拒，成绩原样生效', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  // ME 就是这一场的录入者
  const { match } = await facade.submitMatch(pendingParams());
  await facade.confirmMatch(match._id, ME);

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.canConfirm, false, '已结算的比赛不再给确认入口');

  // 已结算的比赛没有撤销，也没有驳回：写入端按「只有待确认可驳回」挡住
  const rejected = await facade.rejectMatch(match._id, '我自己录的，我想撤');
  assert.strictEqual(rejected.ok, false, '已生效比赛不能驳回');

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.ACTIVE, '被挡下就不该动到状态');
});

schoolMatchTest('比赛页 —— 驳回不填理由被拦下，比赛原样不动', async (facade) => {
  resetSession();
  app.globalData.userInfo = adminMember();

  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN_ID],
    teamB: [RIVAL],
  });

  const page = instantiate(matchConfig);
  await page.onLoad();

  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'reject' } } });
  await page.onSubmitAction();

  assert.strictEqual(page.data.actionError, '请填写理由');
  assert.strictEqual(page.data.action.open, true, '校验失败时面板不该关掉');
  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.PENDING, '没有理由就不能作废成绩');
});

schoolMatchTest('比赛页 —— 驳回把待确认比分作废，文案要说清是驳回', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());

  const page = instantiate(matchConfig);
  await page.onLoad();

  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'reject' } } });
  assert.strictEqual(page.data.action.title, '驳回这场比分');
  page.onInputReason({ detail: { value: '第二局比分录反了' } });
  await page.onSubmitAction();

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.REVOKED);
  assert.strictEqual(ledgerRow.action, 'reject');

  // 终态一样，靠 action 把文案区分开——为驳回单开枚举会波及所有判断
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });
  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.strictEqual(row.statusLabel, '已驳回');
});

schoolMatchTest('比赛页 —— 普通会员看不到指派裁判的入口', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  // 指派权只给管理员，页面这一层压根不该出现入口
  assert.strictEqual(row.canAssignReferee, false);
  assert.strictEqual(row.hasReferee, false);
});

schoolMatchTest('比赛页 —— 管理员在面板里指派裁判，落库并显示在那一行上', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);

  // 管理员自己也在场上，这场比赛才会出现在「我的比赛」里
  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN._id],
    actor: ADMIN._id,
  });

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row, '管理员作为参赛者应当看得到这场');
  assert.strictEqual(row.canAssignReferee, true, '还没生效的比赛才开指派入口');

  await page.onOpenReferee({ currentTarget: { dataset: { matchId: match._id } } });
  assert.strictEqual(page.data.referee.open, true);
  assert.ok(page.data.referee.rows.length > 0, '面板里应当有可选会员');

  calls.toasts.length = 0;
  await page.onPickReferee({ currentTarget: { dataset: { userId: RIVAL } } });

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.referee, RIVAL, '指派已经落库');
  assert.strictEqual((await facade.repo.matches.getById(match._id)).refereeBy, ADMIN._id, '谁派的要留痕');

  assert.strictEqual(page.data.referee.open, false, '选完即关面板');
  const after = page.data.view.records.find((item) => item.matchId === match._id);
  assert.strictEqual(after.hasReferee, true);
  assert.ok(after.refereeName, '行上要显示裁判名字');
  // 比赛还没生效，改派入口仍然开着
  assert.strictEqual(after.canAssignReferee, true);
  assert.ok(calls.toasts.some((text) => /已指派裁判/.test(text)));
});

schoolMatchTest('比赛页 —— 管理员可以撤下裁判，比赛回到「人人照旧」', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);

  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN._id],
    actor: ADMIN._id,
  });
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onOpenReferee({ currentTarget: { dataset: { matchId: match._id } } });
  assert.strictEqual(page.data.referee.hasReferee, true);

  calls.toasts.length = 0;
  await page.onClearReferee();

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.referee, '', '撤下即写空串');
  assert.ok(calls.toasts.some((text) => /已撤下裁判/.test(text)));
});

schoolMatchTest('比赛页 —— 裁判接管后，参赛者看到收口提示且确认按钮消失', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.hasReferee, true);
  assert.match(row.refereeNotice, /仅裁判与管理员可录分/);
  // 即便是参赛者本人，裁判接管后也不再能确认——这道闸门要一路传到视图模型
  assert.strictEqual(row.canConfirm, false);
});

schoolMatchTest('比赛页 —— 下拉刷新会收起刷新动画', async (facade) => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

/* ============================================================
 * 录入比赛成绩
 * ============================================================ */

/** 把一份可直接提交的单打表单填满：我 vs 对手，11 分制三局两胜 */
function fillSinglesForm(page) {
  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });
  const scores = [
    ['A', 0, '11'],
    ['B', 0, '9'],
    ['A', 1, '11'],
    ['B', 1, '7'],
  ];
  for (const [side, slot, value] of scores) {
    page.onInputScore({ currentTarget: { dataset: { side, slot } }, detail: { value } });
  }
}

schoolMatchTest('录入页 —— 首屏把 A 队第一格锁成自己，赛制默认 11 分制三局两胜', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.blockReason, '');
  assert.equal(page.data.members.length, (await facade.getMembers()).length, '选手名单来自 S2 在册会员');

  assert.strictEqual(page.data.form.matchType, MATCH_TYPE.SINGLES);
  assert.strictEqual(page.data.teamARows.length, 1);
  assert.strictEqual(page.data.teamARows[0].locked, true, '「我」这一格不给选');
  assert.strictEqual(page.data.teamARows[0].id, 'u06');
  assert.strictEqual(page.data.scoreRows.length, 3);
  assert.strictEqual(page.data.formatText, '11 分制 · 三局两胜');
  // 时间默认填今天与此刻：绝大多数比赛是刚打完就来录的
  assert.match(page.data.form.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(page.data.form.time, /^\d{2}:\d{2}$/);
});

schoolMatchTest('录入页 —— 未登录直接进来会被整页挡住，提交也无从谈起', async (facade) => {
  resetSession();
  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.data.blockReason, '请先登录后再录入比赛成绩');

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

schoolMatchTest('录入页 —— 切双打后两队各两格，自己仍锁在第一格', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });

  assert.strictEqual(page.data.form.matchType, MATCH_TYPE.DOUBLES);
  assert.strictEqual(page.data.teamARows.length, 2);
  assert.strictEqual(page.data.teamBRows.length, 2);
  assert.strictEqual(page.data.teamARows[0].locked, true);
  assert.strictEqual(page.data.teamARows[1].locked, false);
});

schoolMatchTest('录入页 —— 双打换回单打时多出来的队友被丢掉，自己留下', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });
  page.onPickMember({ currentTarget: { dataset: { side: 'A', slot: 1, id: RIVAL } } });
  assert.strictEqual(page.data.teamARows[1].id, RIVAL);

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.SINGLES } } });

  assert.strictEqual(page.data.teamARows.length, 1);
  assert.strictEqual(page.data.teamARows[0].id, 'u06');
});

schoolMatchTest('录入页 —— 点格子打开找人面板，默认列出全部会员', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  assert.strictEqual(page.data.pickerVisible, true);
  assert.strictEqual(page.data.pickerSide, 'B');
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
});

schoolMatchTest('录入页 —— 选对手时每个人后面带上本赛季已交手的场次', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.ok(page.pairInfo, '加载时应当取到交手场次');
  assert.strictEqual(page.pairInfo.limit, RATED_PAIR_LIMIT);

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  // 面板上的数字与服务端闸门同一份：行上的场次就是 pairInfo 里那个人对应的数字
  for (const row of page.data.pickerRows) {
    assert.strictEqual(row.pairCount, page.pairInfo.counts[row.id] || 0);
  }
  assert.ok(
    page.data.pickerRows.some((row) => row.pairCount > 0),
    '演示流水里当前会员应当已经和某些人打过球，否则这条测试验不出东西'
  );
});

schoolMatchTest('录入页 —— 选搭档时不带交手场次（名额只数隔网相对的人）', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });
  page.onOpenPicker({ currentTarget: { dataset: { side: 'A', slot: 1 } } });

  assert.strictEqual(page.data.pickerSide, 'A');
  assert.ok(
    page.data.pickerRows.every((row) => row.pairCount === 0),
    '搭档不算一对：在搭档面板上显示场次会让人以为「跟他搭档也占名额」'
  );
});

schoolMatchTest('录入页 —— 未登录时取不到交手场次，面板照常能开', async (facade) => {
  resetSession();
  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.pairInfo, null, '没有身份就没有「我本赛季」可言');
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
  assert.ok(page.data.pickerRows.every((row) => row.pairCount === 0));
});

schoolMatchTest('录入页 —— 面板里输入名字后只剩命中的人', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  const target = page.data.members[0];
  page.onInputPickerKeyword({ detail: { value: target.name } });

  assert.ok(page.data.pickerRows.length >= 1);
  assert.ok(page.data.pickerRows.every((row) => row.name.includes(target.name)));
  assert.strictEqual(page.data.pickerKeyword, target.name);
});

schoolMatchTest('录入页 —— 面板里搜不到时，提示带上搜索词', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  page.onInputPickerKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.pickerRows.length, 0);
  assert.ok(page.data.pickerEmptyText.includes('查无此人'));

  // 清空搜索后名单恢复
  page.onClearPickerKeyword();
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
});

schoolMatchTest('录入页 —— 点中一个人填进那一格，并收起面板清掉搜索词', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });
  page.onInputPickerKeyword({ detail: { value: '张' } });

  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });

  assert.strictEqual(page.data.teamBRows[0].id, RIVAL);
  assert.ok(page.data.teamBRows[0].name, '选完要能显示昵称');
  assert.strictEqual(page.data.pickerVisible, false);
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.deepStrictEqual(page.data.pickerRows, []);
});

schoolMatchTest('录入页 —— 收起面板不改动任何一格', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  page.onClosePicker();

  assert.strictEqual(page.data.pickerVisible, false);
  assert.strictEqual(page.data.teamBRows[0].id, '', '只是关掉面板，不能顺手把格子清空');
});

schoolMatchTest('录入页 —— 面板里会勾出这一格当前选中的人', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  const picked = page.data.pickerRows.find((row) => row.id === RIVAL);
  assert.strictEqual(picked.selected, true);
  assert.strictEqual(page.data.pickerRows.filter((row) => row.selected).length, 1);
});

schoolMatchTest('录入页 —— 换局制时比分输入行跟着变，已填的比分之一保留', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onInputScore({ currentTarget: { dataset: { side: 'A', slot: 0 } }, detail: { value: '11' } });
  // BEST_OF_OPTIONS = [1, 3, 5]，下标 2 是五局三胜
  page.onPickBestOf({ detail: { value: 2 } });

  assert.strictEqual(page.data.form.bestOf, 5);
  assert.strictEqual(page.data.scoreRows.length, 5, '五局三胜要有五行输入框');
  assert.strictEqual(page.data.scoreRows[0].a, '11', '改局制不该把已填的比分清掉');
});

schoolMatchTest('录入页 —— 换分制后赛制文案跟着变', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  // GAME_POINTS_OPTIONS = [11, 15, 21]，下标 1 是 15 分制
  page.onPickGamePoints({ detail: { value: 1 } });

  assert.strictEqual(page.data.form.gamePoints, 15);
  assert.strictEqual(page.data.formatText, '15 分制 · 三局两胜');
});

schoolMatchTest('录入页 —— 比分填完就实时预告谁赢，不用用户心算', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);

  // u06 的昵称是「明宇」，真名「赵明宇」只在「我的」页以小字并排显示
  assert.strictEqual(page.data.winnerText, '明宇 胜');
});

schoolMatchTest('录入页 —— 没选对手就提交，逐字段标红且不写台账', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();

  assert.ok(page.data.errors.teamB, '缺对手应当在 B 队上报错');
  assert.ok(page.data.errorText, '只标红不滚屏的话，用户可能找不到错在哪');
  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

schoolMatchTest('录入页 —— 比分没打完被拦下，提示具体是哪一局', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);
  // 11:10 是没打完的局：先到 11 分还要领先 2 分才算赢
  page.onInputScore({ currentTarget: { dataset: { side: 'B', slot: 0 } }, detail: { value: '10' } });

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();

  assert.ok(page.data.scoreErrors.length > 0);
  assert.match(page.data.errorText, /第 1 局/);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

schoolMatchTest('录入页 —— 提交成功后返回上一页，台账里多出一场待确认', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);
  const beforeRecords = await facade.getMatchRecords();
  // 演示赛事里本就留有待确认的场次，按编号找出「新增的这一场」才不会被它顶替
  const beforeIds = new Set(beforeRecords.map((item) => item._id));

  calls.toasts.length = 0;
  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual(page.data.errorText, '');
  assert.deepStrictEqual(calls.toasts, ['已提交，等待对手确认']);
  assert.strictEqual(calls.backCount, 1, '录完要退回比赛页，onShow 会刷新出这一场');

  const ledger = await facade.getMatchRecords();
  assert.strictEqual(ledger.length, beforeRecords.length + 1);

  // 录入一律先记「待确认」——成绩要对手确认后才生效
  const record = ledger.find((item) => !beforeIds.has(item._id));
  assert.ok(record, '新增的这一场应当在台账里');
  assert.strictEqual(record.status, MATCH_STATUS.PENDING);
  assert.strictEqual(record.recorder, 'u06');
  assert.strictEqual(record.pool, 'singles');
  assert.strictEqual(record.gamePoints, 11);
  assert.strictEqual(record.bestOf, 3);
  assert.deepStrictEqual(record.teamA, ['u06']);
  assert.deepStrictEqual(record.teamB, [RIVAL]);
  assert.strictEqual(record.winner, 'A');
});

schoolMatchTest('录入页 —— 取消直接返回，同样不写台账', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  const before = (await facade.getMatchRecords()).length;
  calls.backCount = 0;
  page.onCancel();

  assert.strictEqual(calls.backCount, 1);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

schoolMatchTest('录入页 —— 裁判接管后，参赛者整页被挡住且写明是谁执法', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  // 一场还没确认的比赛，被指派给 u02 执法；u06 是参赛者，管不着这一场
  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchEntryConfig);
  await page.onLoad({ matchId: match._id });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.referee.hasReferee, true);
  assert.ok(page.data.referee.name, '要把裁判的名字亮出来');
  assert.match(page.data.blockReason, /裁判执法/);
  // 挡住就不能提交，不能靠按钮拦
  calls.backCount = 0;
  await page.onSubmit();
  assert.strictEqual(calls.backCount, 0, '被挡住时不该有提交动作');
});

schoolMatchTest('录入页 —— 裁判本人与管理员仍可照常录入', async (facade) => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  // 裁判本人
  resetSession();
  app.globalData.userInfo = activeMember({ _id: RIVAL, role: 1, nickName: '张宇轩' });
  const asReferee = instantiate(matchEntryConfig);
  await asReferee.onLoad({ matchId: match._id });
  assert.strictEqual(asReferee.data.referee.hasReferee, true);
  assert.strictEqual(asReferee.data.blockReason, '', '裁判本人当然能录');
  assert.strictEqual(asReferee.data.scheduled, true);

  // 管理员兜底
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);
  const asAdmin = instantiate(matchEntryConfig);
  await asAdmin.onLoad({ matchId: match._id });
  assert.strictEqual(asAdmin.data.blockReason, '');
});

/* ============================================================
 * 会员审核（学校维度）
 * ============================================================ */

/**
 * 摆好会员审核页的学校维度环境：民大 / 匹克球协会 / 重置过的内存仓储。
 * 「模拟申请人」是一个没有学校归属、但有平台账号的账号，用来提交待审申请；
 * to() 换演示身份（民大管理员 / 民大会员），restore() 归位。
 */
function memberReviewFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const identity = require('../miniprogram/services/school-identity.js');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  schoolMock.reset();
  // reset() 把浏览校清成空串；审核按校取数，这里显式摆成民大
  schoolSession.setSchoolId('muc');
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  const api = () => identity.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  return {
    // 让申请人提交一条待审申请（进入本校待审核台账）
    apply: async (overrides = {}) => {
      schoolMock.setDemoActor('demo_applicant');
      return api().applySchoolMembership({ studentId: 'APP001', collegeId: 'c01', ...overrides });
    },
    to: (actor) => schoolMock.setDemoActor(actor),
    api,
    restore() {
      scope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

test('会员审核页 —— 没有审核权的人被整页挡住，一行申请人的资料都拿不到', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    // 民大会员是本校在册会员，但没有入会审核权
    fx.to('demo_muc_member');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.view.allowed, false);
    assert.deepStrictEqual(page.data.view.rows, [], '没权限就不该下发任何一行申请');
    assert.match(page.data.view.blockedText, /权限/);

    // 防泄漏不能只测 rows：整页数据里都不能出现申请人的学号
    const text = JSON.stringify(page.data.view);
    assert.ok(!text.includes('APP001'), '无权限者的页面数据里漏出了申请人的学号');
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 申请人自己没有审核权，也看不到台账', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    fx.to('demo_applicant');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, false);
    assert.deepStrictEqual(page.data.view.rows, [], '申请人看自己的台账也要走审核权这一关');
    assert.match(page.data.view.blockedText, /权限/);
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 校管理员看到待审申请，字段齐整', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, true);
    assert.strictEqual(page.data.view.rows.length, 1);
    assert.strictEqual(page.data.view.pendingCount, 1);
    // 学校维度只有一份待审台账，没有「已处理」标签页
    assert.strictEqual(page.data.view.tabs, undefined);

    const row = page.data.view.rows[0];
    assert.strictEqual(row.userId, 'demo_applicant');
    assert.strictEqual(row.applicationId, 'demo_applicant');
    assert.strictEqual(row.studentId, 'APP001');
    assert.strictEqual(row.college, '中华民族共同体学院');
    assert.strictEqual(row.statusLabel, '待审核');
    assert.strictEqual(row.canApprove, true);
    assert.strictEqual(row.canReject, true);
    assert.strictEqual(row.isSelf, false);

    const text = JSON.stringify(page.data.view);
    assert.ok(!text.includes('undefined'), '视图数据里出现了 undefined');
    assert.ok(!text.includes('NaN'), '视图数据里出现了 NaN');
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 通过后申请离开待审列表，申请人成为正式会员', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    const row = page.data.view.rows[0];
    calls.toasts.length = 0;
    await page.onOpenApprove({
      currentTarget: { dataset: { applicationId: row.applicationId, revision: row.revision } },
    });
    await page.onSubmitAction();

    assert.strictEqual(page.data.view.rows.length, 0, '处理过的申请不该还留在待审里');
    assert.ok(calls.toasts.some((text) => /已通过/.test(text)));

    // 通过的人立刻成为民大在册会员，名录里就能找到他
    fx.to('demo_applicant');
    const members = await fx.api().getSchoolMembers();
    assert.ok(members.members.some((item) => item.userId === 'demo_applicant'));
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 申请版本过期时被挡下，提示刷新', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    // 页面手里拿的是 rev 1
    const row = page.data.view.rows[0];
    assert.strictEqual(row.revision, 1);

    // 申请人改了学号重新提交，申请升到 rev 2（仍是待审）
    await fx.apply({ studentId: 'APP002' });
    fx.to('demo_muc_admin');

    await page.onOpenApprove({
      currentTarget: { dataset: { applicationId: row.applicationId, revision: row.revision } },
    });
    await page.onSubmitAction();

    assert.match(page.data.actionError, /刷新/);
    assert.strictEqual(page.data.action.open, true, '提交失败时面板不该关掉');
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 驳回必须填理由；理由留痕后申请离开待审列表', async () => {
  const fx = memberReviewFixture();
  try {
    await fx.apply();
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    const row = page.data.view.rows[0];
    await page.onOpenReject({
      currentTarget: { dataset: { applicationId: row.applicationId, revision: row.revision } },
    });

    // 没填理由不给提交，申请原样留在待审
    await page.onSubmitAction();
    assert.strictEqual(page.data.actionError, '请填写驳回理由');
    assert.strictEqual(page.data.action.open, true, '校验失败时面板不该关掉');

    page.onInputReason({ detail: { value: '学号与姓名对不上' } });
    calls.toasts.length = 0;
    await page.onSubmitAction();

    assert.strictEqual(page.data.view.rows.length, 0, '驳回的申请也该离开待审列表');
    assert.ok(calls.toasts.some((text) => /已驳回/.test(text)));

    // 被驳回的人不是在册会员，进不了名录
    fx.to('demo_applicant');
    const members = await fx.api().getSchoolMembers();
    assert.ok(!members.members.some((item) => item.userId === 'demo_applicant'));
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 没有待审申请时给一句空态文案', async () => {
  const fx = memberReviewFixture();
  try {
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, true);
    assert.deepStrictEqual(page.data.view.rows, []);
    assert.strictEqual(page.data.view.pendingCount, 0);
    assert.match(page.data.view.emptyText, /没有待审核/);
  } finally {
    fx.restore();
  }
});

test('会员审核页 —— 下拉刷新会收起刷新动画', async () => {
  const fx = memberReviewFixture();
  try {
    fx.to('demo_muc_admin');

    const page = instantiate(memberReviewConfig);
    await page.onLoad();

    calls.pullDownStopped = 0;
    await page.onPullDownRefresh();
    assert.strictEqual(calls.pullDownStopped, 1);
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 公告列表页
 * ============================================================ */

test('首页 —— 点公告卡片跳到公告列表页', async () => {
  resetSession();

  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoAnnouncements();
  assert.deepStrictEqual(calls.navigations, ['/packageMember/announcements/announcements']);
});

/**
 * 摆好公告页的学校维度演示环境：民大 / 匹克球协会 / 重置过的内存仓储。
 * 公告只能由平台管理员发布（发布权只在平台管理员），发布后 to() 换成读的人。
 */
function announcementFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const scope = require('../miniprogram/services/association-scope.js');
  const space = require('../miniprogram/services/association-space.js');
  schoolSession.reset();
  // 公告用例要自己摆几条再数条数，这里关掉演示内容，免得「一共几条」随它漂移。
  schoolMock.reset({ withDemoContent: false });
  // reset() 把浏览校清成空串；公告按校取数，这里显式摆成民大
  schoolSession.setSchoolId('muc');
  const before = scope.getAssociation();
  scope.setAssociation('pkb');

  let seq = 0;
  const publish = async (association, form) => {
    schoolMock.setDemoActor('demo_platform_admin');
    return space.forScope({ schoolId: 'muc', association })
      .publishSchoolAnnouncement({ ...form, requestId: `req-${(seq += 1)}` });
  };
  const seed = async (association, list) => {
    for (const form of list) await publish(association, form);
  };

  return {
    publish,
    seed,
    to: (actor) => schoolMock.setDemoActor(actor),
    api: (association) => space.forScope({ schoolId: 'muc', association }),
    restore() {
      scope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

/** 匹克球协会的公告种子（分类分布：通知 2 / 赛事 2 / 战报 2） */
const PKB_ANNOUNCEMENTS = [
  { title: '开训通知', content: '本周起常规训练。', category: '通知', pinned: true },
  { title: '男子单打赛报名', content: '本周六开赛。', category: '赛事', pinned: false },
  { title: '女子单打赛报名', content: '本周六开赛。', category: '赛事', pinned: false },
  { title: '首场单打赛战报', content: '名次已录入。', category: '战报', pinned: false },
  { title: '等级分计算规则说明', content: 'ELO 算法。', category: '通知', pinned: false },
  { title: '双打赛战报', content: '双打名次已更新。', category: '战报', pinned: false },
];
/** 乒乓协会的公告种子（4 条，用来验证切协会） */
const TT_ANNOUNCEMENTS = [
  { title: '乒乓开训通知', content: '周三训练。', category: '通知', pinned: true },
  { title: '乒乓团体赛报名', content: '下月开赛。', category: '赛事', pinned: false },
  { title: '场地调整通知', content: '改到二号馆。', category: '通知', pinned: false },
  { title: '乒乓团体赛战报', content: '名次已出。', category: '战报', pinned: false },
];

test('公告列表页 —— 本校成员能看本校全部公告，一个通道、绝无管理按钮', async () => {
  const fx = announcementFixture();
  try {
    // 两个「协会范围」发布出来的公告，2026-10-18 起都落在本校一个通道里
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    await fx.seed('tt', TT_ANNOUNCEMENTS);
    fx.to('demo_muc_member');

    const page = instantiate(announcementsConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    // 协会标签与分类标签都已移除
    assert.strictEqual(page.data.view.associationTabs, undefined);
    assert.strictEqual(page.data.view.tabs, undefined);
    // 公开列表 = 两批种子之和（同属本校），置顶的排最前
    assert.strictEqual(page.data.view.total, PKB_ANNOUNCEMENTS.length + TT_ANNOUNCEMENTS.length);
    assert.strictEqual(page.data.view.rows[0].pinned, true);
    for (const row of page.data.view.rows) assert.strictEqual(row.canArchive, false);
  } finally {
    fx.restore();
  }
});

test('公告列表页 —— 切协会看的是同一份公告（公告归学校，不归协会）', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    await fx.seed('tt', TT_ANNOUNCEMENTS);
    fx.to('demo_muc_member');

    const page = instantiate(announcementsConfig);
    await page.onLoad();
    const before = page.data.view.rows.map((row) => row.id);

    require('../miniprogram/services/association-scope.js').setAssociation('tt');
    await page.refresh.call(page);

    assert.deepStrictEqual(page.data.view.rows.map((row) => row.id), before, '换协会不该改变公告内容');
  } finally {
    fx.restore();
  }
});

test('公告列表页 —— 一条都没有时给空态文案', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(announcementsConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.visibleCount, 0);
    assert.match(page.data.view.emptyText, /还没有发布公告/);
  } finally {
    fx.restore();
  }
});

test('公告列表页 —— 下拉刷新会收起刷新动画', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(announcementsConfig);
    await page.onLoad();

    calls.pullDownStopped = 0;
    await page.onPullDownRefresh();
    assert.strictEqual(calls.pullDownStopped, 1);
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 公告管理页
 * ============================================================ */

test('公告管理页 —— 没有学校身份的访客被整页挡住，一条公告台账都拿不到', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_applicant');

    const page = instantiate(announcementManageConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, false);
    assert.deepStrictEqual(page.data.view.rows, []);
    assert.match(page.data.view.blockedText, /登录/);
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 普通会员被整页挡住：公告只由平台管理员与校级管理员管理', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_muc_member');

    const page = instantiate(announcementManageConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, false);
    assert.deepStrictEqual(page.data.view.rows, [], '普通会员不该拿到公告台账，尤其是已下架的');
    assert.match(page.data.view.blockedText, /权限/);
  } finally {
    fx.restore();
  }
});

test('发布公告页 —— 普通会员填不了表，整页只给一句提示', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(announcementEditConfig);
    await page.onLoad();

    assert.match(page.data.blockReason, /权限/);
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 校级管理员看到台账，也能进发布页填表（2026-10-18 放宽）', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_muc_admin');

    const manage = instantiate(announcementManageConfig);
    await manage.onLoad();
    assert.strictEqual(manage.data.view.allowed, true);
    assert.strictEqual(manage.data.view.total, 6);
    assert.strictEqual(manage.data.view.rows[0].canArchive, true);

    const edit = instantiate(announcementEditConfig);
    await edit.onLoad();
    assert.strictEqual(edit.data.blockReason, '', '校级管理员应拿到表单');
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 平台管理员看到台账', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_platform_admin');

    const page = instantiate(announcementManageConfig);
    await page.onLoad();

    assert.strictEqual(page.data.view.allowed, true);
    assert.strictEqual(page.data.view.total, 6);
    assert.strictEqual(page.data.view.publishedCount, 6);
    assert.strictEqual(page.data.view.archivedCount, 0);
    // 有发布权时每一行都给下架按钮
    assert.strictEqual(page.data.view.rows[0].canArchive, true);
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 下架后台账里仍在且不再给按钮，公开页少一条', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_platform_admin');

    const page = instantiate(announcementManageConfig);
    await page.onLoad();

    const target = page.data.view.rows[0].id;
    await page.onArchive({ currentTarget: { dataset: { id: target } } });

    assert.strictEqual(page.data.view.total, 6);
    assert.strictEqual(page.data.view.publishedCount, 5);
    assert.strictEqual(page.data.view.archivedCount, 1);

    const last = page.data.view.rows.find(row => row.id === target);
    assert.strictEqual(last.id, target);
    assert.strictEqual(last.archived, true);
    assert.strictEqual(last.canArchive, false);

    // 平台管理员视角仍含已下架；换成普通会员就少一条
    const adminView = await fx.api('pkb').listSchoolAnnouncements({});
    assert.strictEqual(adminView.announcements.length, 6);
    fx.to('demo_muc_member');
    const memberView = await fx.api('pkb').listSchoolAnnouncements({});
    assert.strictEqual(memberView.announcements.length, 5);
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 点发布跳到发布页', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_platform_admin');
    const page = instantiate(announcementManageConfig);
    await page.onLoad();

    calls.navigations.length = 0;
    page.onGoPublish();
    assert.deepStrictEqual(calls.navigations, ['/packageMember/announcement-edit/announcement-edit']);
  } finally {
    fx.restore();
  }
});

test('公告管理页 —— 从发布页返回时刷新台账', async () => {
  const fx = announcementFixture();
  try {
    await fx.seed('pkb', PKB_ANNOUNCEMENTS);
    fx.to('demo_platform_admin');

    const page = instantiate(announcementManageConfig);
    await page.onLoad();
    assert.strictEqual(page.data.view.total, 6);

    // 模拟在发布页里发了一条，返回时 onShow 应当把它带出来
    await fx.publish('pkb', { title: '临时通知', content: '明天停训一次。', category: '通知', pinned: false });
    await page.onShow();

    assert.strictEqual(page.data.view.total, 7);
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 发布公告页
 * ============================================================ */

test('发布公告页 —— 没有学校身份被整页挡住，表单都不给', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_applicant');
    const page = instantiate(announcementEditConfig);
    await page.onLoad();

    assert.match(page.data.blockReason, /登录/);
  } finally {
    fx.restore();
  }
});

test('发布公告页 —— 平台管理员能填表，填好后提交落进数据源并返回上一页', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_platform_admin');
    const page = instantiate(announcementEditConfig);
    await page.onLoad();
    assert.strictEqual(page.data.blockReason, '');

    page.onInputTitle({ detail: { value: '周末训练改到周六' } });
    page.onInputContent({ detail: { value: '因场地检修，本周训练顺延一天。' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.strictEqual(page.data.submitting, false);
    assert.deepStrictEqual(page.data.errors, {});
    assert.strictEqual(calls.backCount, 1);

    const view = await fx.api('pkb').listSchoolAnnouncements({});
    assert.ok(view.announcements.some((item) => item.title === '周末训练改到周六'));
  } finally {
    fx.restore();
  }
});

test('发布公告页 —— 标题为空时不提交，逐字段报错', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_platform_admin');
    const page = instantiate(announcementEditConfig);
    await page.onLoad();

    const before = (await fx.api('pkb').listSchoolAnnouncements({})).announcements.length;
    page.onInputContent({ detail: { value: '只有正文，没有标题。' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.ok(page.data.errors.title);
    assert.ok(page.data.errorText);
    assert.strictEqual(calls.backCount, 0);
    // 校验不过不许留下任何痕迹
    assert.strictEqual((await fx.api('pkb').listSchoolAnnouncements({})).announcements.length, before);
  } finally {
    fx.restore();
  }
});

test('发布公告页 —— 输入标题会把该项的旧错误清掉', async () => {
  const fx = announcementFixture();
  try {
    fx.to('demo_platform_admin');
    const page = instantiate(announcementEditConfig);
    await page.onLoad();

    await page.onSubmit();
    assert.ok(page.data.errors.title);

    page.onInputTitle({ detail: { value: '训练通知' } });
    assert.strictEqual(page.data.errors.title, '');
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 编辑资料页（学校维度）
 * ============================================================ */

/**
 * 摆好编辑资料页的学校维度环境：民大 / 匹克球协会 / 重置过的内存仓储。
 * to() 换演示身份，spaceApi() 拿协会空间客户端核对落库结果（会员档案在那边），
 * restore() 归位。
 */
function schoolProfileFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const space = require('../miniprogram/services/association-space.js');
  const assoc = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  schoolMock.reset();
  schoolSession.setSchoolId('muc');
  const before = assoc.getAssociation();
  assoc.setAssociation('pkb');
  return {
    to: (actor) => schoolMock.setDemoActor(actor),
    spaceApi: () => space.forScope({ schoolId: 'muc', association: 'pkb' }),
    restore() {
      assoc.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

test('编辑资料页 —— 已登录时填入当前昵称，学号只读展示', async () => {
  const fx = schoolProfileFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.blockReason, '');
    assert.strictEqual(page.data.form.nickName, '民大模拟会员');
    assert.strictEqual(page.data.avatarText, '民');
    // 自己的学号从学校身份取；姓名演示身份没填（留空由模板兜底成「—」），
    // 性别自 2026-10-16 起写进演示种子（榜单分池要用），这里显示「男」
    assert.strictEqual(page.data.studentId, 'TEST002');
    assert.strictEqual(page.data.realName, '');
    assert.strictEqual(page.data.genderText, '男');
  } finally {
    fx.restore();
  }
});

test('编辑资料页 —— 改昵称保存：落进数据源并返回上一页', async () => {
  const fx = schoolProfileFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    page.onInputNickname({ detail: { value: '小明' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.strictEqual(page.data.submitting, false);
    assert.deepStrictEqual(page.data.errors, {});
    assert.strictEqual(calls.backCount, 1);

    // 账号资料真的落库了：再读自己的会员档案，昵称已更新
    const me = await fx.spaceApi().getSchoolMember({ userId: 'demo_muc_member' });
    assert.strictEqual(me.ok, true);
    assert.strictEqual(me.member.nickName, '小明');
  } finally {
    fx.restore();
  }
});

test('编辑资料页 —— 昵称清空时不提交，逐字段报错且不返回', async () => {
  const fx = schoolProfileFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    page.onInputNickname({ detail: { value: '   ' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.ok(page.data.errors.nickName);
    assert.ok(page.data.errorText);
    assert.strictEqual(calls.backCount, 0);

    const me = await fx.spaceApi().getSchoolMember({ userId: 'demo_muc_member' });
    assert.strictEqual(me.member.nickName, '民大模拟会员');
  } finally {
    fx.restore();
  }
});

test('编辑资料页 —— 选择头像写入表单，本地模拟下原样保留临时路径', async () => {
  const fx = schoolProfileFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    await page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/abc.png' } });
    assert.strictEqual(page.data.form.avatarUrl, 'http://tmp/abc.png');
  } finally {
    fx.restore();
  }
});

test('编辑资料页 —— 输入昵称会把旧的错误提示清掉', async () => {
  const fx = schoolProfileFixture();
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    page.setData({ 'form.nickName': '' });
    await page.onSubmit();
    assert.ok(page.data.errors.nickName);

    page.onInputNickname({ detail: { value: '新昵称' } });
    assert.strictEqual(page.data.errors.nickName, '');
    assert.strictEqual(page.data.errorText, '');
  } finally {
    fx.restore();
  }
});

test('编辑资料页 —— 调用抛异常时也要给出提示并恢复按钮，不能点了没反应', async () => {
  const fx = schoolProfileFixture();
  const identity = require('../miniprogram/services/school-identity.js');
  const original = identity.forSchoolIdentity;
  try {
    fx.to('demo_muc_member');

    const page = instantiate(profileEditConfig);
    await page.onLoad();

    // 装载走的是真实现；只在保存这一步换成会抛错的客户端——
    // 模拟云端未部署新版（「未知的操作」）或网络断开
    identity.forSchoolIdentity = () => ({
      updateSchoolProfile: async () => { throw new Error('未知的操作：updateSchoolProfile'); },
    });
    page.onInputNickname({ detail: { value: '新名字' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.strictEqual(page.data.submitting, false, '按钮必须放回来');
    assert.ok(page.data.errorText);
    assert.strictEqual(calls.backCount, 0, '没保存成功就不能返回');
  } finally {
    identity.forSchoolIdentity = original;
    fx.restore();
  }
});

/* ============================================================
 * 「我的」页 —— 头像入口与改完后的回显
 * ============================================================ */

test('我的页 —— 未登录时不给个人数据，也不给编辑资料入口', async () => {
  resetSession();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loggedIn, false, '没登录就没有编辑入口');
  assert.strictEqual(page.data.view.found, false, '没登录也不该渲染别人的战绩');
});

test('我的页 —— 改完昵称返回后会重取数据，头卡显示新名字', async () => {
  resetSession();
  loginAs();
  const fx = spaceFixture();
  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(page.data.view.user.nickName, '明宇');

    // 模拟在编辑页里改了昵称：S2 资料接口更新，本地兼容登录态同步，再返回本页
    await require('../miniprogram/services/school-identity.js')
      .forSchoolIdentity({ schoolId: 'muc', association: 'pkb' })
      .updateSchoolProfile({ patch: { nickName: '改过的名字' } });
    app.globalData.userInfo = fakeMember({ nickName: '改过的名字' });

    await page.onShow();

    // 只比编号就不会重取，这一页会一直挂着旧名字
    assert.strictEqual(page.data.view.user.nickName, '改过的名字');
    assert.strictEqual(page.data.view.user.realName, '赵明宇');
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 学院赛 —— 发布（M2-2）
 * ============================================================ */


// 学院赛页面独立使用 S2 仓储和真实演示身份；每条测试恢复会话，避免影响旧栈用例。
const { createCollegeFixture, ADMIN: COLLEGE_ADMIN_ID, LEADER: COLLEGE_STAFF_ID,
  MEMBER: COLLEGE_MEMBER_ID } = require('./helpers/school-college-fixture');
const COLLEGE_ADMIN = { _id: COLLEGE_ADMIN_ID, role: 2 };
const COLLEGE_STAFF = { _id: COLLEGE_STAFF_ID, role: 1 };
let collegeFixture;
function collegeTest(name, fn) {
  test(name, async t => {
    collegeFixture = createCollegeFixture();
    try { await fn(t); } finally { collegeFixture.close(); resetSession(); }
  });
}
function loginCollegeAs(actor) {
  const id = actor && actor._id;
  const resolved = [COLLEGE_ADMIN_ID, COLLEGE_STAFF_ID].includes(id) ? id : COLLEGE_MEMBER_ID;
  collegeFixture.to(resolved);
  return loginAs({ ...actor, _id: resolved });
}
function logoutCollege() {
  collegeFixture.to('demo_applicant');
  resetSession();
}

collegeTest('发布学院赛 —— 只有管理员能进表单，学院负责人与会员被挡', async () => {
  loginCollegeAs(COLLEGE_ADMIN);
  const allowed = instantiate(collegeEventEditConfig);
  await allowed.onLoad();
  assert.strictEqual(allowed.data.blockReason, '', '管理员给表单');

  // 学院负责人管的是本学院临场事务，发布学院赛定的是整场规则，门槛收口到管理员
  loginCollegeAs(COLLEGE_STAFF);
  const staff = instantiate(collegeEventEditConfig);
  await staff.onLoad();
  assert.match(staff.data.blockReason, /没有发布学院赛的权限/);

  loginCollegeAs();
  const member = instantiate(collegeEventEditConfig);
  await member.onLoad();
  assert.match(member.data.blockReason, /没有发布学院赛的权限/);

  logoutCollege();
  const guest = instantiate(collegeEventEditConfig);
  await guest.onLoad();
  assert.match(guest.data.blockReason, /请先登录/);
});

collegeTest('发布学院赛 —— 填齐配置可发布，落库即报名中', async () => {
  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventEditConfig);
  await page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onInputDescription({ detail: { value: '各院限报一队' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputLocation({ detail: { value: '体育馆' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  // 默认先摆一项男单，点两次「+」依次补齐女单与男双，行号即出场顺序
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);
  page.onAddLeg();
  page.onAddLeg();
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS', 'MD']);
  assert.strictEqual(page.data.legRows.length, 3);

  // 把第 3 项改成混双，验证按行改项目
  page.onPickLeg({ currentTarget: { dataset: { row: 2 } }, detail: { value: '4' } });
  assert.strictEqual(page.data.legRows[2].label, '混双');
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS', 'XD']);

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.errorText, '', page.data.errorText);
  assert.strictEqual(calls.backCount, 1, '发布后返回上一页');

  const list = await collegeFixture.getCollegeEvents();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, '学院团体赛');
  assert.deepStrictEqual(list[0].legPlan, ['MS', 'WS', 'XD']);
  assert.strictEqual(list[0].status, COLLEGE_EVENT_STATUS.SIGNUP, '发布即报名中');
  // 人数留空取默认区间；算法默认打满比净胜
  assert.strictEqual(list[0].rosterMin, 4);
  assert.strictEqual(list[0].rosterMax, 20);
  assert.strictEqual(list[0].courtCount, 4);
  assert.strictEqual(list[0].tieAlgo, 'full_points');
  assert.strictEqual(list[0].tieNetMode, 'win_diff');
});

collegeTest('发布学院赛 —— 至少留一个小项：最后一个删不掉，空序列也进不了库', async () => {
  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventEditConfig);
  await page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });

  // 默认就一项，删不动
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);
  page.onRemoveLeg({ currentTarget: { dataset: { row: 0 } } });
  assert.deepStrictEqual(page.data.form.legPlan, ['MS'], '最后一个小项删不掉');
  assert.strictEqual(page.data.legRows.length, 1);

  // 加一项后可以删回去，但仍旧留一项
  page.onAddLeg();
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS']);
  page.onRemoveLeg({ currentTarget: { dataset: { row: 1 } } });
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);

  // 序列若被清空（例如从别处塞进来），服务端仍拦下且不落库
  page.setData({ form: { ...page.data.form, legPlan: [] } });
  await page.onSubmit();
  assert.match(page.data.errors.legPlan, /至少安排一个小项/);
  assert.strictEqual((await collegeFixture.getCollegeEvents()).length, 0, '校验不过不落库');
});

collegeTest('发布学院赛 —— 先到 N 场胜时不校验净胜口径', async () => {
  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventEditConfig);
  await page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onPickTieAlgo({ detail: { value: '1' } });
  page.onInputCourtCount({ detail: { value: '4' } });
  await page.onSubmit();

  const list = await collegeFixture.getCollegeEvents();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].tieAlgo, 'first_to_n');
  // 用不上净胜口径时记 null，读的时候不必判「这个字段有没有意义」
  assert.strictEqual(list[0].tieNetMode, null);
});

/* ============================================================
 * 学院赛 —— 名单提交（M2-3）与名单审核（M2-4）
 * ============================================================ */

/**
 * 学院赛用例围着这一所学院转：一男一女各一名，排阵才排得出男单 + 女单
 * （单一性别的学院凑不出阵，性别校验在数据层兜底）。
 *
 * S2 可切换的学院负责人属于 c02；u10（男）和 u24（女）可排单打。
 * 所有读写均走学校维度，角色权限从真实 S2 会话取得。
 */
const STAFF_COLLEGE = '民族学与社会学学院';
/** 民大 c02 匹克球协会学院负责人 */
const STAFF_ID = 'demo_muc_college_leader';

/**
 * 造一场「报名中」的学院赛。门槛是管理员，这里以管理员身份落库，
 * 用例想以谁的身份看，自己在 onLoad 前摆登录态即可。
 * 默认人数下限压到 1：演示数据里单个学院凑不满默认的 4 人。
 *
 * 每条用例由 collegeTest 重建 S2 种子，包含一致的学校身份与协会角色。
 */
async function publishTestCollegeEvent(overrides = {}) {
  const result = await collegeFixture.publishCollegeEvent(
    {
      title: '学院团体赛',
      legPlan: ['MS', 'WS'],
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
      courtCount: 4,
      ...overrides,
    },
    COLLEGE_ADMIN._id
  );
  assert.strictEqual(result.ok, true, `发布学院赛失败：${result.firstError}`);


  return result.record;
}

/* ============================================================
 * 石榴籽杯 —— 学院赛迁入校级活动后的唯一入口
 * ============================================================ */

collegeTest('石榴籽杯 —— 三个项目、默认项目列表与发起入口', async () => {
  const before = associationScope.getAssociation();
  try {
    await publishTestCollegeEvent({ title: '石榴籽杯匹克球赛' });
    loginCollegeAs(COLLEGE_ADMIN);
    const page = instantiate(cupHomeConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.loading, false);
    // 项目列表跟着启用协会走（按 N 个设计）：新增协会即多一个项目，不写死数量
    const { activeAssociations } = require('../src/shared/utils/associations.js');
    assert.strictEqual(page.data.projects.length, activeAssociations().length, '每个启用协会一个项目');
    assert.strictEqual(page.data.projectId, 'pkb', '默认落在当前协会');
    assert.ok(page.data.total >= 1);
    assert.strictEqual(page.data.canManage, true);
    assert.ok(page.data.groups.some(group => group.rows.some(row => row.title === '石榴籽杯匹克球赛')));

    calls.navigations.length = 0;
    page.onCreate();
    assert.deepStrictEqual(calls.navigations, [
      '/packageCollege/college-event-edit/college-event-edit?projectId=pkb',
    ]);
  } finally {
    associationScope.setAssociation(before);
  }
});

collegeTest('石榴籽杯 —— 切项目只显示该项目的学院赛', async () => {
  const before = associationScope.getAssociation();
  try {
    await publishTestCollegeEvent({ title: '匹克球学院赛' });
    loginCollegeAs(COLLEGE_ADMIN);
    const page = instantiate(cupHomeConfig);
    await page.onLoad({});

    await page.onPickProject({ currentTarget: { dataset: { id: 'tt' } } });
    assert.strictEqual(page.data.projectId, 'tt');
    assert.strictEqual(page.data.total, 0, '乒乓球项目还没有赛事');
    assert.deepStrictEqual(page.data.groups, []);

    await page.onPickProject({ currentTarget: { dataset: { id: 'pkb' } } });
    assert.ok(page.data.total >= 1, '切回匹克球仍能看到原赛事');
  } finally {
    associationScope.setAssociation(before);
  }
});

collegeTest('石榴籽杯 —— 普通会员可看，页面不给管理入口', async () => {
  const before = associationScope.getAssociation();
  try {
    await publishTestCollegeEvent();
    loginCollegeAs();
    const page = instantiate(cupHomeConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.canManage, false);
    assert.ok(page.data.total >= 1, '全校在册成员可读');
  } finally {
    associationScope.setAssociation(before);
  }
});

collegeTest('石榴籽杯 —— 点一场进详情', async () => {
  const before = associationScope.getAssociation();
  try {
    const event = await publishTestCollegeEvent();
    loginCollegeAs(COLLEGE_ADMIN);
    const page = instantiate(cupHomeConfig);
    await page.onLoad({});

    calls.navigations.length = 0;
    page.onOpenEvent({ currentTarget: { dataset: { eventId: event._id, canSubmit: false } } });
    assert.deepStrictEqual(calls.navigations, [
      `/packageCollege/college-event-detail/college-event-detail?eventId=${encodeURIComponent(event._id)}`,
    ]);
  } finally {
    associationScope.setAssociation(before);
  }
});

collegeTest('石榴籽杯 —— 年份筛选按发起时间归档', async () => {
  const before = associationScope.getAssociation();
  try {
    await publishTestCollegeEvent();
    loginCollegeAs(COLLEGE_ADMIN);
    const page = instantiate(cupHomeConfig);
    await page.onLoad({});

    const currentYear = String(new Date().getFullYear());
    const currentIndex = page.data.years.findIndex(year => year.value === currentYear);
    await page.onPickYear({ detail: { value: currentIndex } });
    assert.ok(page.data.total >= 1, '今年发起的赛事在当年可见');

    const lastYear = String(new Date().getFullYear() - 1);
    const lastIndex = page.data.years.findIndex(year => year.value === lastYear);
    await page.onPickYear({ detail: { value: lastIndex } });
    assert.strictEqual(page.data.total, 0, '去年没有赛事');
  } finally {
    associationScope.setAssociation(before);
  }
});

/** 取某学院在册会员的编号，用于拼一份合法名单 */
async function memberIdsOf(college) {
  const members = await collegeFixture.getMembers();
  return members.filter((member) => member.college === college && ['M', 'F'].includes(member.gender)).map((member) => member._id);
}

collegeTest('名单提交 —— 学院负责人只看得到本学院的候选，外院的人不在其中', async () => {
  const event = await publishTestCollegeEvent();
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEntryConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.canSubmit, true);
  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, STAFF_COLLEGE);
  assert.deepEqual(page.data.view.candidates, [], '打开选人前不取名单');
  const candidatePage = await require('../miniprogram/services/association-space').forScope(page.scope).listSchoolMembers({ page: true, collegeId: page.data.view.collegeId, limit: 20 });
  assert.ok(candidatePage.members.length > 0, '本院应有候选队员');

  const members = await collegeFixture.getMembers();
  const byId = new Map(members.map((member) => [member._id, member]));
  for (const candidate of candidatePage.members) {
    assert.strictEqual(byId.get(candidate.userId).college, STAFF_COLLEGE, '候选里不许混进外院的人');
  }
});

collegeTest('名单提交 —— 学院负责人提交本学院名单成功，落库为待审核', async () => {
  const event = await publishTestCollegeEvent();
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEntryConfig);
  await page.onLoad({ eventId: event._id });

  const candidatePage = await require('../miniprogram/services/association-space').forScope(page.scope).listSchoolMembers({ page: true, collegeId: page.data.view.collegeId, limit: 20 });
  const ids = candidatePage.members.map(candidate => candidate.userId);
  page.onToggleMember({ detail: { value: ids } });
  assert.strictEqual(page.data.view.selectedCount, ids.length, '勾选人数回写到视图模型');

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(calls.backCount, 1, '提交成功后返回上一页');
  const entries = await collegeFixture.getCollegeEntries(event._id);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].college, STAFF_COLLEGE);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.PENDING, '提交即待审核');
  assert.deepStrictEqual(
    entries[0].members.slice().sort(),
    ids.slice().sort(),
    '名单里的人就是勾选的人'
  );
});

collegeTest('名单提交 —— 普通会员与未入会账号都被挡在名单页外', async () => {
  const event = await publishTestCollegeEvent();

  // 普通会员：有账号但管不了任何学院
  loginCollegeAs();
  const member = instantiate(collegeEntryConfig);
  await member.onLoad({ eventId: event._id });
  assert.strictEqual(member.data.view.canSubmit, false);
  assert.match(member.data.view.blockReason, /只能提交本学院的名单/);

  // S2 模拟申请人已有平台账号，但尚未入会，读端拒绝读取。
  logoutCollege();
  const guest = instantiate(collegeEntryConfig);
  await guest.onLoad({ eventId: event._id });
  assert.match(guest.data.view.blockReason, /没有读取协会空间的权限/);
});

collegeTest('名单提交 —— 名单混入外院队员被数据层拒下，不落库', async () => {
  const event = await publishTestCollegeEvent();
  const members = await collegeFixture.getMembers();
  const outsider = members.find((member) => member.college !== STAFF_COLLEGE && member.status === USER_STATUS.ACTIVE);
  assert.ok(outsider, '演示数据里应有一个外院会员');
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const result = await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: [outsider._id] },
    STAFF_ID
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不属于本学院/);
  assert.strictEqual((await collegeFixture.getCollegeEntries(event._id)).length, 0, '校验不过不落库');
});

collegeTest('名单提交 —— 学院负责人替别的学院提交被拒', async () => {
  const event = await publishTestCollegeEvent();
  const members = await collegeFixture.getMembers();
  const otherCollege = members.find((member) => member.college !== STAFF_COLLEGE).college;
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const result = await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: otherCollege, memberIds: [] },
    STAFF_ID
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.message, /只能提交本学院的名单/);
});

collegeTest('名单提交 —— 人数不在上下限内会被数据层拒下', async () => {
  // 演示数据里每个学院恰好两人，把区间定成 1–1 就能同时卡住两端
  const event = await publishTestCollegeEvent({ rosterMin: 1, rosterMax: 1 });
  const ids = await memberIdsOf(STAFF_COLLEGE);
  assert.ok(ids.length >= 2, '演示数据里本院至少两人');

  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const args = { eventId: event._id, college: STAFF_COLLEGE };

  const justRight = await collegeFixture.submitCollegeEntry({ ...args, memberIds: ids.slice(0, 1) }, STAFF_ID);
  assert.strictEqual(justRight.ok, true, '刚好落在区间内可以提交');

  const tooMany = await collegeFixture.submitCollegeEntry({ ...args, memberIds: ids.slice(0, 2) }, STAFF_ID);
  assert.strictEqual(tooMany.ok, false);
  assert.match(tooMany.message, /最多 1 人/);

  // 下限同样由数据层把关：另开一场要求至少两人
  const strict = await publishTestCollegeEvent({ rosterMin: 2, rosterMax: 2 });
  const tooFew = await collegeFixture.submitCollegeEntry(
    { eventId: strict._id, college: STAFF_COLLEGE, memberIds: ids.slice(0, 1) },
    STAFF_ID
  );
  assert.strictEqual(tooFew.ok, false);
  assert.match(tooFew.message, /至少 2 人/);
});

collegeTest('石榴籽杯 —— 一场赛事按身份去不同的页', async () => {
  const before = associationScope.getAssociation();
  try {
    const event = await publishTestCollegeEvent();

    // 管理员：进详情页（抽签、开赛、大场与审核入口都在那里）
    loginCollegeAs(COLLEGE_ADMIN);
    const admin = instantiate(cupHomeConfig);
    await admin.onLoad({});
    const adminRow = admin.data.rows.find(row => row.eventId === event._id);
    assert.ok(adminRow, '管理员能在杯赛列表看到这场');
    assert.strictEqual(adminRow.canSubmit, false);

    calls.navigations.length = 0;
    admin.onOpenEvent({ currentTarget: { dataset: { eventId: event._id, canSubmit: false } } });
    assert.deepStrictEqual(calls.navigations, [
      `/packageCollege/college-event-detail/college-event-detail?eventId=${encodeURIComponent(event._id)}`,
    ]);

    // 学院负责人：报名中直接进本学院的名单页
    loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
    const staff = instantiate(cupHomeConfig);
    await staff.onLoad({});
    const staffRow = staff.data.rows.find(row => row.eventId === event._id);
    assert.strictEqual(staffRow.canSubmit, true);

    calls.navigations.length = 0;
    staff.onOpenEvent({ currentTarget: { dataset: { eventId: event._id, canSubmit: true } } });
    assert.deepStrictEqual(calls.navigations, [
      `/packageCollege/college-entry/college-entry?eventId=${encodeURIComponent(event._id)}`,
    ]);

    // 普通会员：进详情页看签表与对阵
    loginCollegeAs();
    const member = instantiate(cupHomeConfig);
    await member.onLoad({});
    const memberRow = member.data.rows.find(row => row.eventId === event._id);
    assert.strictEqual(memberRow.canSubmit, false);

    calls.navigations.length = 0;
    member.onOpenEvent({ currentTarget: { dataset: { eventId: event._id, canSubmit: false } } });
    assert.deepStrictEqual(calls.navigations, [
      `/packageCollege/college-event-detail/college-event-detail?eventId=${encodeURIComponent(event._id)}`,
    ]);
  } finally {
    associationScope.setAssociation(before);
  }
});

collegeTest('名单审核 —— 只有管理员能进，学院负责人被挡', async () => {
  const event = await publishTestCollegeEvent();

  loginCollegeAs(COLLEGE_ADMIN);
  const admin = instantiate(collegeEntryReviewConfig);
  await admin.onLoad({ eventId: event._id });
  assert.strictEqual(admin.data.view.canReview, true);
  assert.strictEqual(admin.data.view.blockReason, '');

  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEntryReviewConfig);
  await staff.onLoad({ eventId: event._id });
  assert.match(staff.data.view.blockReason, /只有管理员/);
});

collegeTest('名单审核 —— 通过后状态变为已通过', async () => {
  const event = await publishTestCollegeEvent();
  const ids = await memberIdsOf(STAFF_COLLEGE);
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: ids },
    STAFF_ID
  );

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEntryReviewConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.pendingCount, 1);
  const { entryId } = page.data.view.rows[0];

  await page.onApprove({ currentTarget: { dataset: { entryId } } });

  assert.strictEqual(page.data.view.pendingCount, 0);
  assert.strictEqual(page.data.view.rows[0].statusLabel, '已通过');
  const entries = await collegeFixture.getCollegeEntries(event._id);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.APPROVED);
});

collegeTest('名单审核 —— 退回必须填理由，填了才生效', async () => {
  const event = await publishTestCollegeEvent();
  const ids = await memberIdsOf(STAFF_COLLEGE);
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: ids },
    STAFF_ID
  );

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEntryReviewConfig);
  await page.onLoad({ eventId: event._id });
  const { entryId } = page.data.view.rows[0];

  page.onOpenReject({ currentTarget: { dataset: { entryId, college: STAFF_COLLEGE } } });
  assert.strictEqual(page.data.reject.open, true);

  // 没填理由：挡下，名单仍是待审核
  await page.onSubmitReject();
  assert.match(page.data.actionError, /请填写退回理由/);
  assert.strictEqual((await collegeFixture.getCollegeEntries(event._id))[0].status, COLLEGE_ENTRY_STATUS.PENDING);

  // 填了理由：退回生效，理由留在记录上
  page.onInputReason({ detail: { value: '名单人数不足' } });
  await page.onSubmitReject();

  assert.strictEqual(page.data.reject.open, false);
  const entries = await collegeFixture.getCollegeEntries(event._id);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.RETURNED);
  assert.strictEqual(entries[0].reason, '名单人数不足');
  assert.strictEqual(page.data.view.rows[0].statusLabel, '已退回');
});

/* ============================================================
 * 学院赛详情 / 排阵 / 大场开始
 * ============================================================ */

/** 历史文化学院 —— 演示数据里的另一所参赛学院（同样一男一女） */
const OTHER_COLLEGE = '历史文化学院';

/**
 * 造一场两院参赛、已抽签并已开始的学院赛。
 * 路线与管理员实际操作一致：交名单 → 审核通过 → 抽签 → 开始赛事。
 *
 * @returns {Promise<{event:Object, ties:Array<Object>}>}
 */
async function startTestCollegeEvent() {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });

  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    COLLEGE_ADMIN._id
  );

  for (const entry of await collegeFixture.getCollegeEntries(event._id)) {
    await collegeFixture.reviewCollegeEntry(entry._id, 'approve', '', COLLEGE_ADMIN._id);
  }

  const drawn = await collegeFixture.drawCollegeEvent(event._id, COLLEGE_ADMIN._id, { seedValue: 42 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await collegeFixture.startCollegeEvent(event._id, COLLEGE_ADMIN._id);
  assert.strictEqual(started.ok, true, `开始赛事失败：${started.message}`);
  return { event: drawn.record, ties: started.ties };
}

collegeTest('学院赛详情 —— 未入会账号整页挡住', async () => {
  const event = await publishTestCollegeEvent();
  logoutCollege();

  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.match(page.data.view.blockReason, /没有读取协会空间的权限/);
});

collegeTest('学院赛详情 —— 管理员点选种子并抽签，名单就此锁定', async () => {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    COLLEGE_ADMIN._id
  );
  for (const entry of await collegeFixture.getCollegeEntries(event._id)) {
    await collegeFixture.reviewCollegeEntry(entry._id, 'approve', '', COLLEGE_ADMIN._id);
  }

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.canManage, true, '管理员应看到抽签入口');
  assert.strictEqual(page.data.view.hasApprovedColleges, true);
  assert.strictEqual(page.data.seedRows.length, 2);

  // 点两下同一所学院：先选中，再取消
  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  assert.deepStrictEqual(page.data.seeds, [OTHER_COLLEGE]);
  assert.strictEqual(page.data.seedRows.find((row) => row.college === OTHER_COLLEGE).seedOrderText, '种子 1');

  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  assert.deepStrictEqual(page.data.seeds, []);

  // 按顺序指定两个种子，抽签落库
  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  page.onToggleSeed({ currentTarget: { dataset: { college: STAFF_COLLEGE } } });
  await page.onDraw();

  assert.strictEqual(page.data.view.hasDraw, true);
  assert.strictEqual(page.data.view.isReady, true, '抽签后转「待开赛」，名单锁定');
  assert.strictEqual(page.data.view.canStartEvent, true);

  const saved = await collegeFixture.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.READY);
  assert.deepStrictEqual(saved.draw.seeds, [OTHER_COLLEGE, STAFF_COLLEGE]);
});

collegeTest('学院赛详情 —— 学院负责人报名中能从详情页进名单页', async () => {
  const event = await publishTestCollegeEvent();
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.canSubmitEntry, true);
  assert.strictEqual(page.data.view.canManage, false, '学院负责人不该看到抽签入口');

  calls.navigations.length = 0;
  page.onOpenEntry();
  assert.deepStrictEqual(calls.navigations, [`/packageCollege/college-entry/college-entry?eventId=${encodeURIComponent(event._id)}`]);
});

collegeTest('学院赛详情 —— 开始赛事生成首轮大场，双方排阵齐后可开始大场', async () => {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await collegeFixture.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    COLLEGE_ADMIN._id
  );
  for (const entry of await collegeFixture.getCollegeEntries(event._id)) {
    await collegeFixture.reviewCollegeEntry(entry._id, 'approve', '', COLLEGE_ADMIN._id);
  }
  await collegeFixture.drawCollegeEvent(event._id, COLLEGE_ADMIN._id, { seedValue: 42 });

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });
  assert.strictEqual(page.data.view.canStartEvent, true);

  await page.onStartEvent();

  assert.strictEqual(page.data.view.isOngoing, true);
  assert.strictEqual(page.data.view.hasTies, true);
  const tieRow = page.data.view.ties[0];
  assert.strictEqual(tieRow.isPendingLineup, true, '刚生成的大场在等双方排阵');
  assert.strictEqual(tieRow.canStart, false, '排阵没齐不能开始');
  assert.strictEqual(tieRow.legRows.length, 2, '小项按赛事配置铺好');
});

collegeTest('排阵页 —— 未入会与非本大场的学院都被挡住', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  logoutCollege();
  const anon = instantiate(collegeLineupConfig);
  await anon.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(anon.data.view.blockReason, /没有读取协会空间的权限/);

  // 用一所没进这场大场的学院登录：看不到也排不了
  loginCollegeAs({ role: 1, _id: 'u05', college: '经济学院' });
  const outsider = instantiate(collegeLineupConfig);
  await outsider.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(outsider.data.view.blockReason, /不在本大场的参赛学院内/);
});

collegeTest('排阵页 —— 学院负责人按默认值排人并提交，A 侧标记为已排阵', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, STAFF_COLLEGE);
  assert.strictEqual(page.data.view.hasLineup, false);
  // 演示数据里两所学院各两人，单打各需一人
  assert.deepStrictEqual(page.data.view.legs.map((leg) => leg.need), [1, 1]);

  const ids = await memberIdsOf(STAFF_COLLEGE);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 2 } }, detail: { value: [ids[1]] } });

  await page.onSubmit();

  assert.strictEqual(page.data.view.hasLineup, true, '提交后本场有我方排阵');
  assert.match(page.data.view.carryHint, /已提交过本场排阵/);

  const lineups = await collegeFixture.getCollegeLineups(event._id);
  assert.strictEqual(lineups.length, 1);
  assert.strictEqual(lineups[0].college, STAFF_COLLEGE);
  assert.deepStrictEqual(lineups[0].entries.map((row) => row.players), [[ids[0]], [ids[1]]]);

  // 该大场的对应一侧被翻开
  const saved = (await collegeFixture.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const mySide = STAFF_COLLEGE === tie.collegeA ? saved.lineupA : saved.lineupB;
  assert.strictEqual(mySide, true);
});

collegeTest('排阵页 —— 超过小项人数上限时撤回过多的点选并提示', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  const ids = await memberIdsOf(STAFF_COLLEGE);
  calls.toasts.length = 0;
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: ids } });

  assert.match(calls.toasts[0], /第 1 场最多只能排 1 名队员/);
  assert.strictEqual(page.data.view.legs[0].pickedText, '未排人', '超限整次改动作废');
});

collegeTest('排阵页 —— 有人没排满时提交被数据层拒下', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  const ids = await memberIdsOf(STAFF_COLLEGE);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });

  calls.toasts.length = 0;
  await page.onSubmit();

  assert.match(calls.toasts[0], /第 2 场还没排满 1 名队员/);
  assert.strictEqual((await collegeFixture.getCollegeLineups(event._id)).length, 0, '没排满不落库');
});

collegeTest('大场开始 —— 双方排阵齐后管理员才能点开始', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  // 一人排一半：大场起始仍是待排阵，管理员点不动
  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );

  loginCollegeAs(COLLEGE_ADMIN);
  const partial = instantiate(collegeEventDetailConfig);
  await partial.onLoad({ eventId: event._id });
  assert.strictEqual(partial.data.view.ties[0].canStart, false, '只交了一方，不能开');
  assert.match(partial.data.view.ties[0].statusLabel, /待排阵/);

  // 另一方也交齐
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    COLLEGE_ADMIN._id
  );

  await partial.refresh();
  const readyRow = partial.data.view.ties[0];
  assert.strictEqual(readyRow.statusLabel, '待开赛');
  assert.strictEqual(readyRow.lineupASubmitted, true);
  assert.strictEqual(readyRow.lineupBSubmitted, true);
  assert.strictEqual(readyRow.canStart, true);

  await partial.onStartTie({ currentTarget: { dataset: { tieId: tie._id } } });

  assert.match(partial.data.view.ties[0].statusLabel, /进行中/);
});

collegeTest('学院赛详情 —— 管理员在大场上指派裁判，铺到还没开打的小场', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  const referee = (await collegeFixture.getMembers()).find((member) => member._id === STAFF_ID);
  assert.ok(referee, '拿一位在册会员当裁判');

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  const before = page.data.view.ties[0];
  assert.strictEqual(before.referee, '', '还没指派');
  assert.strictEqual(before.canAssignReferee, true, '管理员在未结束的大场上可以指派');

  calls.toasts.length = 0;
  await page.onOpenReferee({ currentTarget: { dataset: { tieId: tie._id } } });
  assert.strictEqual(page.data.referee.open, true);
  assert.strictEqual(page.data.referee.tieId, tie._id);
  assert.ok(page.data.referee.rows.length > 0, '面板里摆出在册会员');

  await page.onPickReferee({ currentTarget: { dataset: { userId: STAFF_ID } } });

  assert.strictEqual(page.data.referee.open, false, '指派后收起面板');
  assert.match(calls.toasts.join('|'), /已指派裁判/);

  const after = page.data.view.ties[0];
  assert.strictEqual(after.referee, STAFF_ID, '指派已落库并回到页面上');
  assert.strictEqual(after.refereeName, referee.nickName, '页面显示裁判的名字而不是编号');

  const saved = (await collegeFixture.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  assert.strictEqual(saved.referee, STAFF_ID, '大场这一层记下了裁判');

  // 开打后生成的小场要带上大场的裁判：权限判定在小场，不能等到录分时再回头问大场
  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    COLLEGE_ADMIN._id
  );
  await collegeFixture.startTie(tie._id, COLLEGE_ADMIN._id);

  const started = (await collegeFixture.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const ledger = await collegeFixture.getMatchRecords();
  for (const leg of started.legs) {
    const match = ledger.find((item) => item._id === leg.matchId);
    assert.ok(match, '小场已经生成');
    assert.strictEqual(match.referee, STAFF_ID, '小场跟着大场指派到了裁判');
  }
});

collegeTest('学院赛详情 —— 只有管理员看得到指派裁判入口', async () => {
  const { event } = await startTestCollegeEvent();

  // 学院负责人：管得了本学院名单，但派不了裁判
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEventDetailConfig);
  await staff.onLoad({ eventId: event._id });
  assert.strictEqual(staff.data.view.ties[0].canAssignReferee, false);

  // 普通会员：同样不给入口
  loginCollegeAs(activeMember());
  const member = instantiate(collegeEventDetailConfig);
  await member.onLoad({ eventId: event._id });
  assert.strictEqual(member.data.view.ties[0].canAssignReferee, false);
});

collegeTest('学院赛详情 —— 管理员能替两侧排阵，学院负责人只拿到本侧', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  // 管理员：本人学院（体育学院）并不在这两侧，仍应两侧各给一个排阵入口
  loginCollegeAs(COLLEGE_ADMIN);
  const admin = instantiate(collegeEventDetailConfig);
  await admin.onLoad({ eventId: event._id });

  const adminRow = admin.data.view.ties.find((row) => row.tieId === tie._id);
  assert.strictEqual(adminRow.canSubmitLineup, true, '管理员该能看到排阵入口');
  assert.deepStrictEqual(
    adminRow.lineupActions.map((action) => action.college),
    [tie.collegeA, tie.collegeB],
    '两侧各一个入口'
  );
  assert.deepStrictEqual(
    adminRow.lineupActions.map((action) => action.side),
    ['A', 'B']
  );
  assert.match(adminRow.lineupActions[0].label, /提交 A 侧排阵/);

  // 点某一侧的按钮：跳排阵页时把那一侧学院带上
  calls.navigations.length = 0;
  admin.onOpenLineup({ currentTarget: { dataset: { tieId: tie._id, college: tie.collegeB } } });
  assert.deepStrictEqual(calls.navigations, [
    `/packageCollege/college-lineup/college-lineup?tieId=${encodeURIComponent(tie._id)}&eventId=${encodeURIComponent(event._id)}&college=${encodeURIComponent(tie.collegeB)}`,
  ]);

  // 学院负责人：只解得出自己那一侧，入口只有一个
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEventDetailConfig);
  await staff.onLoad({ eventId: event._id });
  const staffRow = staff.data.view.ties.find((row) => row.tieId === tie._id);
  assert.strictEqual(staffRow.lineupActions.length, 1, '学院负责人只管自己那一侧');
  assert.strictEqual(staffRow.lineupActions[0].college, STAFF_COLLEGE);
});

collegeTest('排阵页 —— 管理员带 college 参数替任一方排阵', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  const sideCollege = STAFF_COLLEGE;
  loginCollegeAs(COLLEGE_ADMIN);

  // 不带 college：管理员本人学院不在大场内，被挡住（这正是要修的旧行为）
  const noParam = instantiate(collegeLineupConfig);
  await noParam.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(noParam.data.view.blockReason, /不在本大场的参赛学院内/);

  // 带 college：替该侧排阵，进得去
  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id, college: sideCollege });
  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, sideCollege);
  assert.strictEqual(page.data.view.canSubmit, true);

  // 能真正提交：数据层按编号回查，管理员替任一方兜底是允许的
  const ids = await memberIdsOf(sideCollege);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 2 } }, detail: { value: [ids[1]] } });
  await page.onSubmit();

  const lineups = await collegeFixture.getCollegeLineups(event._id);
  assert.strictEqual(lineups.length, 1);
  assert.strictEqual(lineups[0].college, sideCollege, '排阵落在指定的那一侧学院名下');
});

collegeTest('学院赛小场录分 —— 大场指派的裁判亮在小场页上，别人的录入随之收口', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await collegeFixture.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    COLLEGE_ADMIN._id
  );
  await collegeFixture.startTie(tie._id, COLLEGE_ADMIN._id);

  const started = (await collegeFixture.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const matchId = started.legs[0].matchId;
  assert.ok(matchId, '大场开打后小场才生成');

  const assigned = await collegeFixture.assignTieReferee(tie._id, STAFF_ID, COLLEGE_ADMIN._id);
  assert.strictEqual(assigned.ok, true, assigned.message);
  const referee = (await collegeFixture.getMembers()).find((member) => member._id === STAFF_ID);

  // 场上别的人：看得到谁执法，录不了分
  loginCollegeAs(activeMember());
  const outsider = instantiate(collegeMatchConfig);
  await outsider.onLoad({ matchId });
  assert.strictEqual(outsider.data.view.hasReferee, true);
  assert.strictEqual(outsider.data.view.refereeName, referee.nickName);
  assert.strictEqual(outsider.data.view.canRecord, false, '裁判接管后旁人不能录分');
  assert.match(outsider.data.view.refereeNotice, /仅裁判与管理员可录入比分/);

  // 裁判本人：照常录入，不必再对自己重复一遍限制
  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const self = instantiate(collegeMatchConfig);
  await self.onLoad({ matchId });
  assert.strictEqual(self.data.view.canRecord, true);
  assert.strictEqual(self.data.view.refereeRestricted, false);
  assert.strictEqual(self.data.view.refereeNotice, '');
});

collegeTest('学院赛 S2 闭环 —— 页面发布、列表、名单审核、排阵、录分确认、名次回显', async () => {
  loginCollegeAs(COLLEGE_ADMIN);
  const publish = instantiate(collegeEventEditConfig);
  await publish.onLoad();
  publish.onInputTitle({ detail: { value: '学院赛闭环验收' } });
  publish.onPickDate({ detail: { value: '2026-11-01' } });
  publish.onPickTime({ detail: { value: '09:00' } });
  publish.onInputCourtCount({ detail: { value: '4' } });
  publish.setData({ form: { ...publish.data.form, legPlan: ['MS', 'WS'], rosterMin: 1, rosterMax: 20 } });
  await publish.onSubmit();
  assert.equal(publish.data.errorText, '');

  const list = instantiate(cupHomeConfig);
  await list.onLoad({});
  assert.equal(list.data.rows.length, 1);
  const eventId = list.data.rows[0].eventId;
  calls.navigations.length = 0;
  list.onOpenEvent({ currentTarget: { dataset: { eventId, canSubmit: false } } });
  const route = new URL(calls.navigations[0], 'https://miniprogram.local');
  assert.equal(route.pathname, '/packageCollege/college-event-detail/college-event-detail');
  const detail = instantiate(collegeEventDetailConfig);
  await detail.onLoad({ eventId: route.searchParams.get('eventId') });
  assert.equal(detail.data.view.title, '学院赛闭环验收');

  loginCollegeAs(COLLEGE_STAFF);
  const entry = instantiate(collegeEntryConfig);
  await entry.onLoad({ eventId });
  entry.onToggleMember({ detail: { value: await memberIdsOf(STAFF_COLLEGE) } });
  await entry.onSubmit();
  assert.equal((await collegeFixture.getCollegeEntries(eventId))[0].status, COLLEGE_ENTRY_STATUS.PENDING);
  assert.equal((await collegeFixture.submitCollegeEntry({ eventId, college: OTHER_COLLEGE,
    memberIds: await memberIdsOf(OTHER_COLLEGE) }, COLLEGE_ADMIN_ID)).ok, true);

  loginCollegeAs(COLLEGE_ADMIN);
  const review = instantiate(collegeEntryReviewConfig);
  await review.onLoad({ eventId });
  for (const row of review.data.view.rows.slice()) {
    await review.onApprove({ currentTarget: { dataset: { entryId: row.entryId } } });
  }
  assert.equal(review.data.view.pendingCount, 0);
  await detail.refresh();
  await detail.onDraw();
  await detail.onStartEvent();
  const tie = detail.data.view.ties[0];
  assert.ok(tie.tieId);
  for (const college of [STAFF_COLLEGE, OTHER_COLLEGE]) {
    loginCollegeAs(college === STAFF_COLLEGE ? COLLEGE_STAFF : COLLEGE_ADMIN);
    const lineup = instantiate(collegeLineupConfig);
    await lineup.onLoad({ eventId, tieId: tie.tieId, college });
    assert.equal(lineup.data.view.canSubmit, true);
    for (const leg of lineup.data.view.legs) {
      const ids = await memberIdsOf(college);
      lineup.onTogglePlayer({ currentTarget: { dataset: { legNo: leg.legNo } },
        detail: { value: [ids[leg.legNo - 1]] } });
    }
    await lineup.onSubmit();
    assert.equal(lineup.data.view.hasLineup, true);
  }
  loginCollegeAs(COLLEGE_ADMIN);
  await detail.refresh();
  await detail.onStartTie({ currentTarget: { dataset: { tieId: tie.tieId } } });
  for (const leg of detail.data.view.ties[0].legRows) {
    const match = instantiate(collegeMatchConfig);
    await match.onLoad({ matchId: leg.matchId });
    assert.equal(match.data.view.canRecord, true);
    const wins = Math.floor(match.data.view.bestOf / 2) + 1;
    for (let slot = 0; slot < wins; slot += 1) {
      match.onInputScore({ currentTarget: { dataset: { side: 'A', slot } }, detail: { value: String(match.data.view.gamePoints) } });
      match.onInputScore({ currentTarget: { dataset: { side: 'B', slot } }, detail: { value: '3' } });
    }
    await match.onSubmit();
    assert.equal(match.data.view.canConfirm, true, calls.toasts.at(-1));
    await match.onConfirm();
    assert.equal(match.data.view.status, MATCH_STATUS.ACTIVE, calls.toasts.at(-1));
  }
  await detail.refresh();
  assert.equal(detail.data.view.ties[0].winner, tie.collegeA);
  const placement = instantiate(collegePlacementConfig);
  await placement.onLoad({ eventId });
  for (const [index, row] of placement.data.view.rows.entries()) {
    placement.onInputPlacement({ currentTarget: { dataset: { index } },
      detail: { value: row.college === tie.collegeA ? '1' : '2' } });
  }
  await placement.onSubmit();
  await detail.refresh();
  await list.onShow();
  assert.equal(detail.data.view.isFinished, true);
  assert.equal(detail.data.view.resultRows[0].college, tie.collegeA);
  // 杯赛列表重载后仍是「已结束」：同项目一次赛事结束不会把列表冲掉
  assert.equal(list.data.groups.flatMap(group => group.rows)[0].isFinished, true);
});

/* ============================================================
 * 学院赛 —— 路由编号（未解码 query）
 * ============================================================
 * 跳转方一律 encodeURIComponent 拼 URL，而微信开发者工具 / 真机把 query **原样
 * 透传**（仍是 %3A 形式），Node 测试替身（URLSearchParams）才会解码一次——所以
 * 传 `event._id` 的既有用例一直是绿的，真机上却「赛事不存在」（2026-10-16 实测）。
 * 这里一律传 encodeURIComponent 之后的值，模拟未解码的那一端：页面必须采纳装载器
 * 探测出的真实编号，否则写在页面实例上的还是路由原值（见 utils/route-query.js）。
 */

/**
 * 交齐两侧排阵并开打，返回这场大场生成的小场编号。
 * 与真人路线一致：排阵 → 大场开始；小场是开打那一刻才铺出来的。
 *
 * @param {Object} event
 * @param {Object} tie
 * @returns {Promise<Array<string>>}
 */
async function startTieMatches(event, tie) {
  for (const college of [STAFF_COLLEGE, OTHER_COLLEGE]) {
    const ids = await memberIdsOf(college);
    await collegeFixture.submitLineup(
      {
        tieId: tie._id,
        college,
        entries: [{ legNo: 1, players: [ids[0]] }, { legNo: 2, players: [ids[1]] }],
      },
      college === STAFF_COLLEGE ? STAFF_ID : COLLEGE_ADMIN._id
    );
  }
  const started = await collegeFixture.startTie(tie._id, COLLEGE_ADMIN._id);
  assert.strictEqual(started.ok, true, started.message);
  const saved = (await collegeFixture.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  return saved.legs.map((leg) => leg.matchId);
}

collegeTest('学院赛详情 —— 未解码 query 下采纳真实编号，抽签与开赛都成功', async () => {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });
  for (const college of [STAFF_COLLEGE, OTHER_COLLEGE]) {
    await collegeFixture.submitCollegeEntry(
      { eventId: event._id, college, memberIds: await memberIdsOf(college) },
      college === STAFF_COLLEGE ? STAFF_ID : COLLEGE_ADMIN._id
    );
  }
  for (const entry of await collegeFixture.getCollegeEntries(event._id)) {
    await collegeFixture.reviewCollegeEntry(entry._id, 'approve', '', COLLEGE_ADMIN._id);
  }

  // 未解码环境：跳转方编码一次，接收方拿到的就是这串 %3A 形式的值
  const routeEventId = encodeURIComponent(event._id);
  assert.notStrictEqual(routeEventId, event._id, '演示编号含 %3A，这条用例才守得住未解码环境');

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: routeEventId });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.eventId, event._id, '页面要采纳装载器探测出的真实编号');

  // 写操作一：抽签
  calls.toasts.length = 0;
  await page.onDraw();
  assert.strictEqual(page.data.view.isReady, true, calls.toasts.join('|'));
  assert.strictEqual((await collegeFixture.getCollegeEvent(event._id)).status, COLLEGE_EVENT_STATUS.READY);

  // 写操作二：开赛
  calls.toasts.length = 0;
  await page.onStartEvent();
  assert.strictEqual(page.data.view.isOngoing, true, calls.toasts.join('|'));
  assert.ok(page.data.view.ties.length > 0, '开赛后铺出首轮大场');

  // 跳转只编码一次，带的是真实编号
  calls.navigations.length = 0;
  page.onOpenReview();
  assert.deepStrictEqual(calls.navigations, [
    `/packageCollege/college-entry-review/college-entry-review?eventId=${encodeURIComponent(event._id)}`,
  ]);
});

collegeTest('学院赛排阵 —— 未解码 query 下采纳真实大场编号，提交排阵成功', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  const routeTieId = encodeURIComponent(tie._id);
  assert.notStrictEqual(routeTieId, tie._id);

  loginCollegeAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: routeTieId, eventId: encodeURIComponent(event._id) });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.tieId, tie._id, '页面要采纳装载器探测出的真实大场编号');
  assert.strictEqual(page.eventId, event._id, '赛事编号也要落回实例');

  const ids = await memberIdsOf(STAFF_COLLEGE);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 2 } }, detail: { value: [ids[1]] } });

  calls.toasts.length = 0;
  await page.onSubmit();
  assert.match(calls.toasts.join('|'), /排阵已提交/);

  const lineups = await collegeFixture.getCollegeLineups(event._id);
  assert.strictEqual(lineups.length, 1, '排阵照真实大场编号落库');
  assert.strictEqual(lineups[0].college, STAFF_COLLEGE);
});

collegeTest('学院赛小场录分 —— 未解码 query 下采纳真实小场编号，录分与确认都成功', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const [matchId] = await startTieMatches(event, ties[0]);
  assert.ok(matchId, '大场开打后小场才生成');
  const routeMatchId = encodeURIComponent(matchId);
  assert.notStrictEqual(routeMatchId, matchId);

  loginCollegeAs(COLLEGE_ADMIN);
  const page = instantiate(collegeMatchConfig);
  await page.onLoad({ matchId: routeMatchId });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.matchId, matchId, '页面要采纳装载器探测出的真实小场编号');
  assert.strictEqual(page.data.view.canRecord, true);

  // 写操作一：录分
  const wins = Math.floor(page.data.view.bestOf / 2) + 1;
  for (let slot = 0; slot < wins; slot += 1) {
    page.onInputScore({
      currentTarget: { dataset: { side: 'A', slot } },
      detail: { value: String(page.data.view.gamePoints) },
    });
    page.onInputScore({ currentTarget: { dataset: { side: 'B', slot } }, detail: { value: '3' } });
  }
  calls.toasts.length = 0;
  await page.onSubmit();
  assert.strictEqual(page.data.view.canConfirm, true, calls.toasts.join('|'));

  // 写操作二：确认生效
  await page.onConfirm();
  assert.strictEqual(page.data.view.status, MATCH_STATUS.ACTIVE, calls.toasts.join('|'));

  // 去计分台：只编码一次，带真实编号
  calls.navigations.length = 0;
  page.onGoLiveScore();
  assert.deepStrictEqual(calls.navigations, [
    `/packageTeam/live-score/live-score?matchId=${encodeURIComponent(matchId)}`,
  ]);
});

collegeTest('学院赛 S2 隔离 —— 跨校跨协会不可读写，本院负责人不能替对方排阵', async () => {
  const { event, ties } = await startTestCollegeEvent();
  for (const scope of [{ schoolId: 'buaa', association: 'pkb' }, { schoolId: 'muc', association: 'tt' }]) {
    const api = collegeFixture.api('demo_platform_admin', scope);
    const list = await api.listCollegeEvents({});
    assert.equal(list.ok, true);
    assert.deepEqual(list.events, []);
    assert.equal((await api.getCollegeEvent({ eventId: event._id })).ok, false);
    assert.equal((await api.setCollegeEventPinned({ eventId: event._id, pinned: true })).ok, false);
    assert.equal((await api.startCollegeTie({ tieId: ties[0]._id })).ok, false);
  }
  const ids = await memberIdsOf(OTHER_COLLEGE);
  const denied = await collegeFixture.submitLineup({ tieId: ties[0]._id, college: OTHER_COLLEGE,
    entries: [{ legNo: 1, players: [ids[0]] }, { legNo: 2, players: [ids[1]] }] }, COLLEGE_STAFF_ID);
  assert.equal(denied.ok, false);
  assert.deepEqual(await collegeFixture.getCollegeLineups(event._id), []);
  assert.equal((await collegeFixture.getCollegeEvent(event._id)).pinned, false);
});

collegeTest('学院赛 S2 访客 —— 无 actor 的视图不显示名单、排阵或管理入口', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const view = require('../miniprogram/services/school-college-view');
  const options = { ...collegeFixture.scope, actorId: null, eventId: event._id };
  for (const result of [await view.loadCollegeEntryView(event._id, options),
    await view.loadCollegeEventDetailView(event._id, options),
    await view.loadCollegeLineupView(ties[0]._id, options)]) {
    assert.match(result.blockReason, /请先登录/);
    assert.ok(!result.canSubmit && !result.canManage);
  }
});

/* ============================================================
 * 个人赛弃权（M5-3）入口
 * ============================================================ */

/**
 * 造一场进行中的 4 人单败赛事，返回首轮其中一场。
 * 路线与真人一致：发布 → 报名 → 抽签 → 开赛。
 */
async function scheduledSinglesMatch() {
  const members = await facade.getMembers();
  const players = members.slice(0, 4).map((member) => member._id);

  const published = await facade.publishEvent(
    {
      title: '弃权入口自检赛',
      description: 'M5-3 页面入口',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      seedMode: SEED_MODE.ELO,
      seedCount: 4,
      startTime: '2026-05-20T09:00:00',
      location: '学校体育馆',
      quota: 4,
      courtCount: 4,
    },
    ADMIN._id
  );
  assert.strictEqual(published.ok, true, `发布赛事失败：${published.firstError}`);

  const eventId = published.record._id;
  for (const userId of players) {
    await facade.signUpEvent(eventId, userId);
  }
  await facade.drawEvent(eventId, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(eventId, ADMIN._id);

  const matches = await facade.getMatchRecords({ eventId });
  return { eventId, players, match: matches.filter((item) => item.round === 1)[0] };
}

for (const confirmed of [true, false]) {
  test('比赛页 S2 —— 弃权确认=' + confirmed + '，按选择更新原签表记录', async () => {
    const fx = schoolEventFixture();
    try {
      const eventId = await fx.publish({ seedCount: 2 });
      await fx.play(eventId, ['demo_muc_admin', 'demo_muc_member']);
      const match = (await fx.api().listSchoolMatches({ eventId })).matches[0];
      fx.to(match.teamA[0]);
      const page = instantiate(matchConfig);
      await page.onLoad();
      assert.equal(page.data.view.records.find(row => row.matchId === match.matchId).canForfeit, true);
      calls.modalConfirmed = confirmed;
      await page.onForfeit({ currentTarget: { dataset: { matchId: match.matchId } } });
      const after = (await fx.api().getSchoolMatch({ matchId: match.matchId })).match;
      assert.equal(after.status, confirmed ? MATCH_STATUS.ACTIVE : MATCH_STATUS.PENDING);
      if (confirmed) { assert.equal(after.outcome, MATCH_OUTCOME.FORFEIT); assert.equal(after.winner, 'B'); }
      else assert.equal(after.revision, match.revision);
    } finally { calls.modalConfirmed = true; fx.restore(); }
  });
}

/* ============================================================
 * 学院名次录入页（M5-1）
 * ============================================================ */

collegeTest('学院名次页 —— 管理员填名次并提交，赛事随即结束', async () => {
  const { event } = await startTestCollegeEvent();
  loginCollegeAs(COLLEGE_ADMIN);

  const page = instantiate(collegePlacementConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.canSubmit, true);
  assert.strictEqual(page.data.view.hasRows, true);
  assert.strictEqual(page.data.view.rows.length, 2, '两所已通过名单的学院各一行');

  const [first, second] = page.data.view.rows.map((row) => row.college);
  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });
  page.onInputPlacement({ currentTarget: { dataset: { index: 1 } }, detail: { value: '2' } });

  calls.toasts.length = 0;
  const backsBefore = calls.backCount;
  await page.onSubmit();

  const saved = await collegeFixture.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(saved.results, [
    { college: first, placement: 1 },
    { college: second, placement: 2 },
  ]);
  assert.ok(calls.toasts.some((text) => /名次已录入/.test(text)));
  assert.strictEqual(calls.backCount, backsBefore + 1, '提交完回详情页');
});

collegeTest('学院名次页 —— 名次不是正整数时挡下，赛事不结束', async () => {
  const { event } = await startTestCollegeEvent();
  loginCollegeAs(COLLEGE_ADMIN);

  const page = instantiate(collegePlacementConfig);
  await page.onLoad({ eventId: event._id });
  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1.5' } });

  await page.onSubmit();

  assert.match(page.data.errorText, /整数/);
  assert.strictEqual(
    (await collegeFixture.getCollegeEvent(event._id)).status,
    COLLEGE_EVENT_STATUS.ONGOING,
    '校验不过时不能结束赛事'
  );
});

collegeTest('学院名次页 —— 学院负责人与会员整页挡住，一条学院名单都不下发', async () => {
  const { event } = await startTestCollegeEvent();

  for (const actor of [{ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE }, { role: 0, _id: 'u06' }]) {
    loginCollegeAs(actor);
    const page = instantiate(collegePlacementConfig);
    await page.onLoad({ eventId: event._id });

    assert.strictEqual(page.data.view.canSubmit, false);
    assert.match(page.data.view.blockReason, /只有管理员/);
    assert.deepStrictEqual(page.data.view.rows, [], '没有录入资格就不给名单');
  }
});

/* ============================================================
 * 赛事列表改版：近 3 条 + 查看全部 + 置顶
 * ============================================================ */

eventPanelTest('赛事页 —— 列表只摆近 3 条，「查看全部」入口指向完整列表页', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const view = page.data.view;
  assert.strictEqual(view.events.length, 3, '赛事列表默认只摆 3 条');
  assert.strictEqual(view.hasMoreEvents, true, '演示数据里的赛事多于 3 场');
  assert.ok(view.eventTotal > 3);

  calls.navigations.length = 0;
  page.onMoreEvents();
  assert.deepStrictEqual(calls.navigations, ['/packageEvent/event-list/event-list?type=event']);
});

eventPanelTest('赛事页 —— 管理员点「置顶」把赛事提到最前，普通会员看不到按钮', async (fx) => {

  const page=instantiate(eventsConfig);
  await page.onLoad();
  const target=page.data.view.events[2];
  assert.equal(target.canPin,true);
  await page.onToggleEventPin({currentTarget:{dataset:{eventId:target.id,pinned:false}}});
  assert.equal(page.data.view.events[0].id,target.id);
  assert.equal(page.data.view.events[0].pinned,true);
  fx.to('demo_muc_member');
  await page.refresh();
  assert.ok(page.data.view.events.every(row=>!row.canPin));
  const denied=await fx.api().setSchoolEventPinned({eventId:target.id,pinned:false});
  assert.equal(denied.ok,false);

});

eventPanelTest('全部赛事页 —— 不截断地列出全部赛事，管理员可在页内置顶', async (fx) => {

  const allEvents=await fx.api().listSchoolEvents({limit:50});
  const page=instantiate(eventListConfig);
  await page.onLoad({type:'event'});
  assert.equal(page.data.error,'');
  assert.equal(page.data.view.events.length,allEvents.events.length);
  assert.equal(page.data.view.hasMoreEvents,false);
  const target=page.data.view.events[1];
  assert.equal(target.canPin,true);
  await page.onToggleEventPin({currentTarget:{dataset:{eventId:target.id,pinned:false}}});
  assert.equal(page.data.view.events[0].id,target.id);

});

/* ============================================================
 * 实时计分台（横屏）
 * ============================================================
 * 页面的职责是把「点一下」变成一次判球，再把实时态画出来；算分与判权
 * 都不在这里——判球规则在 services/live-score.js，读写与录分权走学校维度。
 * 用例重点看四件事：没身份 / 没入会时挡住、点一下加一分、打满两局能定稿
 * 并退回、已生效的比赛不再让计分。
 *
 * 比赛与名单都取自 S2 协会空间，所以每条用例先摆一场「两人报名 → 抽签 →
 * 开赛」留下的待确认单打（见 liveScoreMatch）。演示环境里民大只有
 * demo_muc_admin / demo_muc_member 两个可切换身份，凑不出第三个人来验
 * 「非参赛者」，故「无权计分」改由「比赛已生效」这一条真实路径覆盖。
 * ============================================================ */

/** 推一球并把这一球发完（页面把请求排在串行队列里） */
async function tap(page, side) {
  page.onScore({ currentTarget: { dataset: { side } } });
  await page.queue;
}

/**
 * 摆一场待确认的 S2 单打（两人报名 → 抽签 → 开赛），返回比赛编号。
 * 与真人路线一致，开赛后签表里就有一场「待确认」的比赛。
 */
async function liveScoreMatch(fx) {
  const eventId = await fx.publish({ seedCount: 2 });
  await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);
  const res = await fx.api().listSchoolMatches({ eventId });
  const row = (res.matches || []).find((item) => item.status === MATCH_STATUS.PENDING);
  assert.ok(row, '开赛后应当有一场待确认的比赛');
  return row.matchId;
}

test('实时计分台 —— 未登录不开台', async () => {
  const fx = schoolEventFixture();
  // 演示环境里每个账号都有一个平台身份，「未登录」只能靠换掉身份接口来模拟：
  // 问不到人时页面就该把人挡在登录这一步（见 live-score.currentActorId）。
  const identityModule = require('../miniprogram/services/school-identity.js');
  const original = identityModule.forSchoolIdentity;
  try {
    const matchId = await liveScoreMatch(fx);
    identityModule.forSchoolIdentity = () => ({ getSchoolIdentitySession: async () => ({ user: null }) });

    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId });

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.blockReason, '请先登录后再计分');
  } finally {
    identityModule.forSchoolIdentity = original;
    fx.restore();
  }
});

test('实时计分台 —— 未入会的人取不到名录，挡在计分台外', async () => {
  const fx = schoolEventFixture();
  try {
    const matchId = await liveScoreMatch(fx);
    // 模拟申请人有平台账号但没有民大会籍：名录读不到，计分台自然也不该开
    fx.to('demo_applicant');

    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId });

    assert.strictEqual(page.data.error, '');
    assert.match(page.data.blockReason, /权限/);
  } finally {
    fx.restore();
  }
});

test('实时计分台 —— 找不到的比赛给出提示而不是白屏', async () => {
  const fx = schoolEventFixture();
  try {
    fx.to('demo_muc_member');
    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId: 'no-such-match' });

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.blockReason, '');
    assert.strictEqual(page.data.error, '这场比赛不存在，或已被删除');
  } finally {
    fx.restore();
  }
});

test('实时计分台 —— 管理员开台，逐球计分与撤销', async () => {
  const fx = schoolEventFixture();
  try {
    const matchId = await liveScoreMatch(fx);
    fx.to('demo_muc_admin');

    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId });

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.blockReason, '');
    assert.strictEqual(page.data.view.pointsTextA, '0', '开台从 0:0 起');
    assert.strictEqual(page.data.canUndo, false, '还没判球，没什么可撤');

    await tap(page, 'A');
    await tap(page, 'A');
    await tap(page, 'B');
    assert.strictEqual(page.data.view.pointsTextA, '2');
    assert.strictEqual(page.data.view.pointsTextB, '1');
    assert.strictEqual(page.data.view.leading, 'A', '领先方要能高亮出来');
    assert.strictEqual(page.data.canUndo, true);

    page.onUndo();
    await page.queue;
    assert.strictEqual(page.data.view.pointsTextB, '0', '撤销弹掉最后一球');
    assert.strictEqual(page.data.view.pointsTextA, '2');
  } finally {
    fx.restore();
  }
});

test('实时计分台 —— 打满两局可定稿，定稿后退回上一页', async () => {
  const fx = schoolEventFixture();
  try {
    const matchId = await liveScoreMatch(fx);
    fx.to('demo_muc_admin');

    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId });

    // 11 分制三局两胜：连拿两局（各 11:0）即分出胜负
    for (let i = 0; i < 22; i += 1) {
      page.onScore({ currentTarget: { dataset: { side: 'A' } } });
    }
    await page.queue;

    assert.strictEqual(page.data.view.gamesText, '2 : 0');
    assert.strictEqual(page.data.view.finished, true);
    assert.strictEqual(page.data.canFinish, true);

    const backBefore = calls.backCount;
    page.onFinish();
    await page.queue;

    assert.strictEqual(calls.backCount, backBefore + 1, '定稿后退回上一页等确认');
    const found = await fx.api().getSchoolMatch({ matchId });
    assert.deepStrictEqual(found.match.scoreA, [11, 11], '定稿把打完的局写成正式比分');
    assert.deepStrictEqual(found.match.scoreB, [0, 0]);
    assert.strictEqual(found.match.status, MATCH_STATUS.PENDING, '定稿只到待确认，确认权仍在裁判 / 对手手上');
  } finally {
    fx.restore();
  }
});

test('实时计分台 —— 已生效的比赛不再给计分', async () => {
  const fx = schoolEventFixture();
  try {
    const matchId = await liveScoreMatch(fx);
    fx.to('demo_muc_admin');

    // 让这一场走完「开台 → 连拿两局 → 定稿 → 确认」，落到已生效
    const api = fx.api();
    await api.startSchoolLiveScore({ matchId });
    for (let i = 0; i < 22; i += 1) {
      await api.recordSchoolRally({ matchId, side: 'A', rallyId: `seed-${i}` });
    }
    await api.finishSchoolLiveScore({ matchId });
    const confirmed = await api.confirmSchoolMatch({ matchId });
    assert.strictEqual(confirmed.ok, true, `确认失败：${confirmed.message}`);

    fx.to('demo_muc_member');
    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId });

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.blockReason, '这场比赛已生效或已作废，不能再计分');
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 赛季管理
 * ============================================================
 * 页面已从「我的」移除，赛季更新改为在云控制台手动操作；
 * 云端 resetSeason 能力与 mock 数据源的行为仍由 season-reset.test.js 覆盖。
 * ============================================================ */

/* ============================================================
 * 协会页 与 协会工作台
 * ============================================================
 * 中间三个页签（排行榜 / 比赛 / 赛事）收进了「协会工作台」：协会页列出协会，
 * 点一个进工作台，在工作台里按页签切换。排行榜 / 比赛 / 赛事本身的行为仍由
 * 上面那些用例覆盖（它们现在装在组件里，测试按老下标取用）。
 * ============================================================ */

test('协会页 —— 列出本校的协会，当前全局协会标为「当前」', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  try {
    const page = instantiate(associationConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.readOnlySchool, false);
    // 本校清单来自注册表：断言与注册表同序同量，新增协会不必再改这里
    const { activeAssociations } = require('../src/shared/utils/associations.js');
    assert.deepStrictEqual(
      page.data.associations.map((item) => item.name),
      activeAssociations().map((assoc) => assoc.shortName)
    );
    assert.deepStrictEqual(
      page.data.associations.filter((item) => item.active).map((item) => item.id),
      ['pkb'],
      '当前全局协会那一个才标「当前」'
    );
    // 每张卡片必须带自己的主题类，否则图标底色会继承页面的中性红——
    // 四个协会全变成同一个红色，正是这个字段漏挂时的表现
    assert.deepStrictEqual(
      page.data.associations.map((item) => item.themeClass),
      page.data.associations.map((item) => `assoc-${item.id}`),
      '每个协会卡片各挂自己的主题类'
    );
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('协会页 —— 点某个协会：写全局协会并进它的工作台', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  try {
    const page = instantiate(associationConfig);
    await page.onLoad();

    calls.navigations.length = 0;
    page.onChooseAssociation({ currentTarget: { dataset: { association: 'tt' } } });

    assert.strictEqual(scope.getAssociation(), 'tt', '全局当前协会改成了点中的那个');
    assert.deepStrictEqual(
      calls.navigations,
      ['/pages/association-home/association-home?association=tt&tab=space'],
      '进工作台，默认落在协会空间'
    );
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('协会页 —— 切到北航列出它的演示协会，并标只读', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  schoolMock.setDemoActor('demo_muc_member');
  try {
    // 只读 = 浏览的学校 ≠ 我的学校，故两处都要摆好
    schoolSession.setHomeSchoolId('muc');
    schoolSession.setSchoolId('buaa');
    const page = instantiate(associationConfig);
    await page.onLoad();

    assert.strictEqual(page.data.readOnlySchool, true);
    assert.strictEqual(page.data.schoolName, '北航');
    // 外校清单来自演示数据（schoolAssociations）：直接与之比对，演示桶加协会即可
    const demo = require('../miniprogram/services/school-demo.js').schoolAssociations('buaa');
    assert.deepStrictEqual(
      page.data.associations.map((item) => item.name),
      demo.map((item) => item.name)
    );
    assert.ok(page.data.associations.some((item) => item.id === 'tn'), '演示数据也带网球协会');
    assert.ok(page.data.associations.every((item) => Boolean(item.glyph)), '每个协会都带文字徽标');
    // 演示协会用的是注册表 id，主题类照样能对上（北航的卡片也是分色的）
    assert.deepStrictEqual(
      page.data.associations.map((item) => item.themeClass),
      page.data.associations.map((item) => `assoc-${item.id}`),
      '演示协会卡片也各挂自己的主题类'
    );
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
});

test('工作台 —— 带协会与页签进来：定协会、定页签、只挂当前面板', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  try {
    const page = instantiate(associationHomeConfig);
    page.onLoad({ association: 'tt', tab: 'events' });

    assert.strictEqual(scope.getAssociation(), 'tt', '把查询参数里的协会写回全局');
    assert.strictEqual(page.data.associationId, 'tt');
    assert.strictEqual(page.data.associationName, '民大乒乓');
    assert.strictEqual(page.data.activeTab, 'events');
    assert.deepStrictEqual(page.data.mounted, { space: false, rank: false, match: false, events: true });
    assert.deepStrictEqual(
      page.data.tabs.filter((item) => item.active).map((item) => item.tab),
      ['events']
    );
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('工作台 —— 不带参数时用全局协会，默认落在协会空间', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  scope.setAssociation('bd');
  try {
    const page = instantiate(associationHomeConfig);
    page.onLoad();

    assert.strictEqual(page.data.associationId, 'bd');
    assert.strictEqual(page.data.activeTab, 'space');
    assert.deepStrictEqual(page.data.mounted, { space: true, rank: false, match: false, events: false });
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('工作台 —— 切页签懒挂载，挂过的切回来仍保持挂载', async () => {
  const page = instantiate(associationHomeConfig);
  page.onLoad({ tab: 'rank' });

  page.onSwitchTab({ currentTarget: { dataset: { tab: 'match' } } });
  assert.strictEqual(page.data.activeTab, 'match');
  assert.strictEqual(page.data.mounted.match, true, '首次切到比赛才把它挂上');

  page.onSwitchTab({ currentTarget: { dataset: { tab: 'rank' } } });
  assert.strictEqual(page.data.activeTab, 'rank');
  assert.strictEqual(page.data.mounted.match, true, '挂过的面板保持挂载，来回切不丢状态');
});

test('工作台 —— 非法协会 / 非法页签参数回落到默认值', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  try {
    const page = instantiate(associationHomeConfig);
    page.onLoad({ association: '不存在', tab: '不存在' });

    assert.strictEqual(page.data.associationId, 'pkb', '非法协会回落到全局协会');
    assert.strictEqual(page.data.activeTab, 'space', '非法页签回落到协会空间');
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('首页 —— 「看全部赛事」跳进工作台的赛事页签', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoEvents();
  assert.deepStrictEqual(
    calls.navigations,
    ['/pages/association-home/association-home?tab=events']
  );
});

/* ============================================================
 * 协会空间面板（工作台的第一个页签）
 * ============================================================ */

/**
 * 摆好协会空间的演示环境：民大、匹克球协会、重置过的内存仓储。
 * 返回的 to() 用来切换演示身份（会员 / 校管理员），restore() 归位。
 */
function spaceFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  schoolMock.reset();
  // reset() 把浏览校清成空串；协会空间要按校取数，这里显式摆成民大
  schoolSession.setSchoolId('muc');
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  return {
    to: (actor) => schoolMock.setDemoActor(actor),
    spaceApi: () => require('../miniprogram/services/association-space.js')
      .forScope({ schoolId: 'muc', association: 'pkb' }),
    restore() {
      scope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

/**
 * 排行榜全量搜索夹具：干净台账 + 12 位男会员各打一场并确认，男单榜超过 10 人，
 * 用于验证「默认只显示前 10，搜索覆盖完整榜单」。
 */
function rankBoardFixture() {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  const scope = require('../miniprogram/services/association-scope.js');
  const space = require('../miniprogram/services/association-space.js');
  schoolSession.reset();
  schoolMock.reset({ withDemoContent: false });
  schoolSession.setSchoolId('muc');
  const before = scope.getAssociation();
  scope.setAssociation('pkb');
  const api = () => space.forScope({ schoolId: 'muc', association: 'pkb' });
  let sequence = 0;
  return {
    to: (actor) => schoolMock.setDemoActor(actor),
    /** 12 位男会员各与 u01 打一场并确认（mock 放宽为参与即可确认） */
    async seedMenSingles() {
      const men = ['u02', 'u03', 'u04', 'u05', 'u06', 'u07', 'u08', 'u09', 'u10', 'u11', 'u12', 'u13'];
      for (const id of men) {
        schoolMock.setDemoActor(id);
        const submitted = await api().submitSchoolMatch({
          requestId: `rank_fx_${++sequence}`,
          matchType: MATCH_TYPE.SINGLES, teamA: [id], teamB: ['u01'],
          scoreA: [11], scoreB: [9], gamePoints: 11, bestOf: 1,
          matchTime: `2026-06-${String((sequence % 27) + 1).padStart(2, '0')}T19:00:00`,
        });
        assert.strictEqual(submitted.ok, true, `录入失败：${submitted.message}`);
        schoolMock.setDemoActor('u01');
        const confirmed = await api().confirmSchoolMatch({ matchId: submitted.match.matchId });
        assert.strictEqual(confirmed.ok, true, `确认失败：${confirmed.message}`);
      }
    },
    restore() {
      scope.setAssociation(before);
      schoolMock.setDemoActor('demo_applicant');
      schoolMock.reset();
      schoolSession.reset();
    },
  };
}

test('协会空间 —— 首屏默认落在训练页签，标题带学校与协会', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_member');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.activeSub, 'training');
    assert.deepStrictEqual(page.data.mountedSub, { group: false, notice: false, training: true, member: false });
    assert.strictEqual(page.data.spaceTitle, '民大·匹克球');
    assert.strictEqual(page.data.canManage, false, '普通会员不能管理小组');
    assert.deepStrictEqual(page.data.groups, []);
    assert.ok(page.data.roster.length > 0, '建组候选来自本协会在册会员');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 无权限身份：给说明与去学校身份页的入口，而不是打白整块面板', async () => {
  const fx = spaceFixture();
  // 「普通访客」（demo_applicant）没有学校归属，读不到协会空间
  fx.to('demo_applicant');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();

    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.noAccess, true, '没有读取权时进入无权限态');
    assert.strictEqual(page.data.error, '', '无权限不是加载失败，不应落进 error（否则整块面板被打白）');
    assert.ok(page.data.noAccessNote, '给出服务端返回的说明');
    assert.strictEqual(page.data.canGoIdentity, true, '提供去学校身份页的入口');
    assert.deepStrictEqual(page.data.groups, []);
    assert.strictEqual(page.data.activeSub, 'training', '无权限也不影响页签初值');

    calls.navigations.length = 0;
    page.onGoSchoolIdentity();
    assert.deepStrictEqual(calls.navigations, ['/packageMember/school-identity/school-identity']);
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 成员页签首次切过去才拉取，关键字可过滤', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_member');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    assert.deepStrictEqual(page.data.members, [], '没切过去就不拉成员');

    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'member' } } });
    assert.strictEqual(page.data.activeSub, 'member');
    assert.strictEqual(page.data.mountedSub.member, true);
    const total = page.data.members.length;
    assert.ok(total > 0, '切过去后拿到在册会员');

    await page.onInputKeyword({ detail: { value: '一定不存在的人' } });
    assert.deepStrictEqual(page.data.members, []);
    assert.strictEqual(page.data.memberEmptyNote, '没有找到匹配的成员');

    await page.onClearKeyword();
    assert.strictEqual(page.data.members.length, total);
    assert.strictEqual(page.data.searching, false);
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 点成员行进入个人主页', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_member');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'member' } } });
    const first = page.data.members[0].userId;

    calls.navigations.length = 0;
    page.onOpenMember({ currentTarget: { dataset: { userid: first } } });
    assert.deepStrictEqual(calls.navigations, [`/packageMember/member/member?userId=${first}`]);
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 管理者可建组并批量选人，建好后出现在列表', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_admin');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    assert.strictEqual(page.data.canManage, true);

    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    page.onToggleCreate();
    assert.strictEqual(page.data.showCreate, true);

    page.onField({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '新手一组' } });
    page.onField({ currentTarget: { dataset: { field: 'description' } }, detail: { value: '练基础' } });

    const pick = page.data.roster[0].userId;
    page.onTogglePick({ currentTarget: { dataset: { userid: pick } } });
    assert.deepStrictEqual(page.data.selectedMemberIds, [pick]);

    await page.onCreateGroup();

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.notice, '小组已创建');
    assert.strictEqual(page.data.groups.length, 1);
    assert.strictEqual(page.data.groups[0].name, '新手一组');
    assert.strictEqual(page.data.groups[0].memberCount, 1);
    assert.strictEqual(page.data.groups[0].joined, false, '建组人不自动入组');
  } finally {
    fx.restore();
  }
});

/**
 * 建组选人的搜索（2026-10-16 用户要求：成员多了以后只能从列表里翻，要能按名字找）。
 * 守三件事：关键词交给服务端（昵称或真实姓名都能搜到）、换词/翻页不丢已选的人、
 * 已选的人即使不在当前结果里也能取消。
 */
test('协会空间 —— 建组选人可搜索：按昵称或姓名找人、换词不丢已选、已选可取消', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_admin');
  try {
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    await page.onToggleCreate();
    assert.ok(page.data.roster.length > 0, '打开表单就有候选（无关键词的第一页）');
    assert.strictEqual(page.data.groupKeyword, '');

    // 按真实姓名里的一个字搜：命中的是张宇轩，且他的昵称「宇轩」也在结果里
    await page.onInputGroupKeyword({ detail: { value: '张' } });
    assert.ok(page.data.roster.length > 0, '「张」要搜得到人');
    assert.ok(page.data.roster.every((row) => `${row.nickName}${row.realName}`.includes('张')), '结果都命中关键词');
    const zhang = page.data.roster.find((row) => row.userId === 'u02');
    assert.ok(zhang, '张宇轩（u02）在结果里');
    assert.strictEqual(page.data.groupEmptyNote, '');

    // 选一个人，再换关键词：他不在新结果里了，但已选清单不能跟着丢
    await page.onTogglePick({ currentTarget: { dataset: { userid: zhang.userId } } });
    assert.deepStrictEqual(page.data.selectedMemberIds, [zhang.userId]);
    assert.deepStrictEqual(page.data.selectedMembers, [{ userId: zhang.userId, nickName: zhang.nickName }]);

    await page.onInputGroupKeyword({ detail: { value: '思远' } });
    const siyuan = page.data.roster[0];
    assert.ok(siyuan && siyuan.userId === 'u03', '「思远」命中李思远（u03）');
    assert.ok(!page.data.roster.some((row) => row.userId === zhang.userId), '换词后旧候选不在列表里');
    assert.deepStrictEqual(page.data.selectedMemberIds, [zhang.userId], '换关键词不能把已选的人丢掉');
    assert.strictEqual(page.data.selectedMembers[0].nickName, zhang.nickName, '已选那一行仍显示得出名字');

    // 再选一个（跨关键词选人），建组时两个人都在
    await page.onTogglePick({ currentTarget: { dataset: { userid: siyuan.userId } } });
    assert.deepStrictEqual(page.data.selectedMemberIds, [zhang.userId, siyuan.userId]);
    page.onField({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '搜索建组' } });
    await page.onCreateGroup();
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.groups.length, 1);
    assert.strictEqual(page.data.groups[0].memberCount, 2, '跨关键词选的两个人一起入组');

    // 点「已选」小卡片＝取消，不必把人再搜回来
    await page.onTogglePick({ currentTarget: { dataset: { userid: zhang.userId } } });
    assert.deepStrictEqual(page.data.selectedMemberIds, [siyuan.userId]);

    // 搜不到人时给一句说明，而不是空白列表
    await page.onInputGroupKeyword({ detail: { value: '一定不存在的人' } });
    assert.deepStrictEqual(page.data.roster, []);
    assert.strictEqual(page.data.groupEmptyNote, '没有找到匹配的成员');

    // 清空搜索回到完整第一页
    await page.onClearGroupKeyword();
    assert.strictEqual(page.data.groupKeyword, '');
    assert.ok(page.data.roster.length > 0, '清空关键词后回到候选名单');

    // 「加载更多」接在当前列表后面，并把游标带上去；没有下一页时一次请求都不发
    const payloads = [];
    page.api = {
      listAssociationMembers: async (payload) => {
        payloads.push(payload);
        return { ok: true, members: [{ userId: 'u99', nickName: '分页会员', realName: '' }],
          nextCursor: '', hasMore: false, keyword: payload.keyword };
      },
    };
    page.setData({ groupHasMore: true, groupCursor: 'cursor-1' });
    const before = page.data.roster.length;
    await page.onLoadMoreGroupRoster();
    assert.strictEqual(page.data.roster.length, before + 1, '「加载更多」是接在后面，不是替换');
    assert.strictEqual(page.data.roster[before].userId, 'u99');
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].keyword, '', '翻页沿用当前关键词');
    assert.strictEqual(payloads[0].cursor, 'cursor-1', '翻页带上上一页的游标');
    assert.ok(payloads[0].limit > 0);
    assert.strictEqual(page.data.groupHasMore, false);
    payloads.length = 0;
    await page.onLoadMoreGroupRoster();
    assert.deepStrictEqual(payloads, [], '没有下一页就不再请求');

    // Node 里没有模板渲染器：搜索框与「加载更多」只能落到模板上验
    const fs = require('node:fs');
    const path = require('node:path');
    const wxml = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'components',
      'association-space-panel', 'association-space-panel.wxml'), 'utf8');
    assert.match(wxml, /bindinput="onInputGroupKeyword"/, '建组表单里要有搜索框');
    assert.match(wxml, /bindtap="onLoadMoreGroupRoster"/, '还有下一页时要有「加载更多」');
    assert.match(wxml, /placeholder="输入昵称或姓名找人"/, '搜索框要说清搜什么');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 组员本人退出；管理者随后可归档', async () => {
  const fx = spaceFixture();
  try {
    // 先以校管理员身份直接建一个含「民大会员」的小组
    fx.to('demo_muc_admin');
    const created = await fx.spaceApi().createAssociationGroup({
      requestId: 'ag_page_leave_1', name: '混双训练组', description: '',
      memberIds: ['demo_muc_member'],
    });
    assert.strictEqual(created.ok, true);
    const groupId = created.group.groupId;

    // 组员进面板：能看到自己已加入，退出后人数归零
    fx.to('demo_muc_member');
    const memberPage = instantiate(spacePanelConfig);
    await memberPage.onLoad();
    await memberPage.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    const mine = memberPage.data.groups.find((row) => row.groupId === groupId);
    assert.ok(mine && mine.joined, '组员能看到自己已加入');

    await memberPage.onLeaveGroup({ currentTarget: { dataset: { groupid: groupId } } });
    const afterLeave = memberPage.data.groups.find((row) => row.groupId === groupId);
    assert.strictEqual(afterLeave.joined, false);
    assert.strictEqual(afterLeave.memberCount, 0);

    // 管理者进面板：归档后该组标为已归档
    fx.to('demo_muc_admin');
    const adminPage = instantiate(spacePanelConfig);
    await adminPage.onLoad();
    await adminPage.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    const before = adminPage.data.groups.find((row) => row.groupId === groupId);

    await adminPage.onArchiveGroup({
      currentTarget: { dataset: { groupid: groupId, revision: before.revision } },
    });
    assert.strictEqual(adminPage.data.notice, '小组已归档');
    const archived = adminPage.data.groups.find((row) => row.groupId === groupId);
    assert.strictEqual(archived.archived, true);
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 管理者可删除整个小组，删除后列表里不再有它', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_admin');
  try {
    const created = await fx.spaceApi().createAssociationGroup({
      requestId: 'ag_page_delete_1', name: '待删除组', description: '', memberIds: ['demo_muc_member'],
    });
    assert.strictEqual(created.ok, true);
    const groupId = created.group.groupId;

    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    await page.onToggleGroupDetail({ currentTarget: { dataset: { groupid: groupId } } });
    assert.strictEqual(page.data.openGroupId, groupId, '先展开名单，用来验证删除会把展开态一起收掉');
    const before = page.data.groups.find((row) => row.groupId === groupId);

    calls.modals.length = 0;
    await page.onDeleteGroup({ currentTarget: { dataset: { groupid: groupId, revision: before.revision } } });

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.notice, '小组已删除');
    assert.strictEqual(calls.modals.length, 1, '删除是不可逆动作，先弹一次确认');
    assert.ok(calls.modals[0].includes('历史活动记录保留'), '确认文案讲清历史记录保留');
    assert.strictEqual(page.data.groups.some((row) => row.groupId === groupId), false, '列表刷新后该组消失');
    assert.strictEqual(page.data.openGroupId, '', '不残留展开的名单');
    assert.strictEqual(page.data.detailMembers.length, 0);
    assert.strictEqual(page.data.editingId, '');

    // 重复点击 / 超时重试：服务端幂等，页面照旧提示成功，不再多弹一次决定
    calls.modals.length = 0;
    await page.onDeleteGroup({ currentTarget: { dataset: { groupid: groupId, revision: before.revision } } });
    assert.strictEqual(page.data.notice, '小组已删除');
    assert.strictEqual(page.data.error, '');

    // 取消确认时不调用接口
    const second = await fx.spaceApi().createAssociationGroup({
      requestId: 'ag_page_delete_2', name: '再建一个组', description: '', memberIds: [],
    });
    await page.onLoad();
    const keep = page.data.groups.find((row) => row.groupId === second.group.groupId);
    calls.modalConfirmed = false;
    await page.onDeleteGroup({ currentTarget: { dataset: { groupid: keep.groupId, revision: keep.revision } } });
    assert.strictEqual(page.data.groups.some((row) => row.groupId === keep.groupId), true, '取消确认后组还在');
    calls.modalConfirmed = true;

    // 普通会员：canManage 为假，模板里由 canManage 门控的删除按钮不会渲染
    fx.to('demo_muc_member');
    const memberPage = instantiate(spacePanelConfig);
    await memberPage.onLoad();
    await memberPage.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    assert.strictEqual(memberPage.data.canManage, false, '会员没有管理权，删除按钮不出现');
    assert.deepStrictEqual(memberPage.data.groups.map((row) => row.groupId), [second.group.groupId],
      '删掉的组对会员也不再可见');

    // Node 里没有模板渲染器，「按钮是否出现」只能落到模板门控上验：
    // 删除按钮必须由 canManage 管着，而且不能把归档的组排除在外（用户就是删不掉才来报的）。
    const wxml = require('node:fs').readFileSync(require('node:path').join(__dirname, '..',
      'miniprogram', 'components', 'association-space-panel', 'association-space-panel.wxml'), 'utf8');
    const at = wxml.indexOf('onDeleteGroup');
    assert.ok(at > 0, '模板里要有删除入口');
    const tag = wxml.slice(wxml.lastIndexOf('<button', at), wxml.indexOf('>', at) + 1);
    assert.match(tag, /wx:if="\{\{canManage\}\}"/, '删除按钮由管理权门控');
    assert.doesNotMatch(tag, /archived/, '归档的小组也要能删');
  } finally {
    calls.modalConfirmed = true;
    fx.restore();
  }
});

test('协会空间 —— 管理者可改组名，提交带版本号', async () => {
  const fx = spaceFixture();
  fx.to('demo_muc_admin');
  try {
    const created = await fx.spaceApi().createAssociationGroup({
      requestId: 'ag_page_edit_1', name: '旧组名', description: '旧说明', memberIds: [],
    });
    assert.strictEqual(created.ok, true);
    const groupId = created.group.groupId;

    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    const before = page.data.groups.find((row) => row.groupId === groupId);

    page.onToggleEdit({ currentTarget: { dataset: { groupid: groupId, revision: before.revision } } });
    assert.strictEqual(page.data.editingId, groupId);
    assert.strictEqual(page.data.groupForm.name, '旧组名');

    page.onField({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '新组名' } });
    await page.onSaveEdit();

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.notice, '小组已更新');
    assert.strictEqual(page.data.editingId, '');
    const after = page.data.groups.find((row) => row.groupId === groupId);
    assert.strictEqual(after.name, '新组名');
    assert.ok(after.revision > before.revision, '版本号自增');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 通知页签：负责人可发布并撤回，会员只读且看不到撤回件', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'notice' } } });
    assert.strictEqual(page.data.activeSub, 'notice');
    assert.strictEqual(page.data.mountedSub.notice, true);
    assert.strictEqual(page.data.notices.length, 0, '初始没有空间通知');

    page.onToggleNoticeCreate();
    assert.strictEqual(page.data.showNoticeCreate, true);
    page.onNoticeField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '空间通知一' } });
    page.onNoticeField({ currentTarget: { dataset: { field: 'content' } }, detail: { value: '这是协会内部通知' } });
    await page.onCreateNotice();

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.notice, '通知已发布');
    assert.strictEqual(page.data.notices.length, 1);
    assert.strictEqual(page.data.notices[0].title, '空间通知一');
    assert.strictEqual(page.data.notices[0].canEdit, true, '负责人可编辑');

    const noticeId = page.data.notices[0].noticeId;
    await page.onWithdrawNotice({ currentTarget: { dataset: { noticeid: noticeId, revision: page.data.notices[0].revision } } });
    assert.strictEqual(page.data.notice, '通知已撤回');
    assert.strictEqual(page.data.notices[0].withdrawn, true, '负责人仍可见撤回件以便审计');

    // 普通会员只读：没有发布入口，撤回的通知对会员不可见
    fx.to('demo_muc_member');
    const memberPage = instantiate(spacePanelConfig);
    await memberPage.onLoad();
    await memberPage.onSwitchSub({ currentTarget: { dataset: { sub: 'notice' } } });
    assert.strictEqual(memberPage.data.canManage, false, '会员不能管理通知');
    assert.strictEqual(memberPage.data.notices.length, 0, '撤回的通知对会员不可见');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 表单校验失败只就地报错，不打白整块面板', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'notice' } } });

    // 标题留空直接发布：应当拒绝，但错误只出现在页签下方
    page.onToggleNoticeCreate();
    await page.onCreateNotice();

    assert.ok(page.data.error, '校验失败要给出就地错误文案');
    assert.strictEqual(page.data.loadError, '', '这不是加载失败，不能触发整块面板的错误态');
    assert.strictEqual(page.data.noAccess, false);
    assert.strictEqual(page.data.showNoticeCreate, true, '面板结构还在，发布表单没有被清掉');
    assert.strictEqual(page.data.activeSub, 'notice', '页签没有被重置');

    // 切到别的页签，上一条错误不应跟着漂过去
    await page.onSwitchSub({ currentTarget: { dataset: { sub: 'group' } } });
    assert.strictEqual(page.data.error, '', '换页签后清掉旧的表单错误');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 训练页签：负责人发布，会员报名与取消，状态可筛选', async () => {
  const fx = spaceFixture();
  try {
    fx.to('demo_muc_admin');
    const page = instantiate(spacePanelConfig);
    await page.onLoad();
    assert.strictEqual(page.data.activeSub, 'training', '训练是默认页签');
    assert.strictEqual(page.trainingLoaded, true, '首屏即拉取训练');
    assert.strictEqual(page.data.trainings.length, 0);

    page.onToggleTrainingCreate();
    assert.strictEqual(page.data.showTrainingCreate, true);
    page.onTrainingField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '周末训练' } });
    page.onTrainingField({ currentTarget: { dataset: { field: 'location' } }, detail: { value: '综合体育馆' } });
    await page.onCreateTraining();

    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.notice, '训练已发布');
    assert.strictEqual(page.data.trainings.length, 1);
    assert.strictEqual(page.data.trainings[0].state, 'open');
    const trainingId = page.data.trainings[0].trainingId;

    // 会员报名：详情里可报名，报名后名单增加，可再取消
    fx.to('demo_muc_member');
    const memberPage = instantiate(spacePanelConfig);
    await memberPage.onLoad();
    await memberPage.onToggleTrainingDetail({ currentTarget: { dataset: { trainingid: trainingId } } });
    assert.ok(memberPage.data.trainingDetail, '详情已拉到');
    assert.strictEqual(memberPage.data.trainingDetail.canRegister, true,
      memberPage.data.trainingDetail.registerNote);

    await memberPage.onRegisterTraining();
    assert.strictEqual(memberPage.data.notice, '报名成功');
    assert.strictEqual(memberPage.data.trainingDetail.training.signupCount, 1);
    assert.strictEqual(memberPage.data.trainingDetail.canCancel, true);
    assert.strictEqual(memberPage.data.trainingRoster.length, 1);

    await memberPage.onCancelRegistration();
    assert.strictEqual(memberPage.data.notice, '已取消报名');
    assert.strictEqual(memberPage.data.trainingDetail.training.signupCount, 0);

    // 状态筛选：这条是「可报名」，切到「已取消」筛选后列表为空
    await memberPage.onTrainingFilter({ currentTarget: { dataset: { key: 'canceled' } } });
    assert.strictEqual(memberPage.data.trainingFilter, 'canceled');
    assert.strictEqual(memberPage.data.trainings.length, 0, '已取消筛选下没有训练');
  } finally {
    fx.restore();
  }
});

test('协会空间 —— 训练签到：本人提交，负责人确认 / 退回（须填原因）', async () => {
  const fx = spaceFixture();
  try {
    // 签到窗口由训练时间决定，页面用例不便摆时钟，这里用桩 api 直接驱动面板行为。
    fx.to('demo_muc_member');
    const memberPage = instantiate(spacePanelConfig);
    await memberPage.onLoad();
    const memberCalls = [];
    memberPage.api = {
      ...memberPage.api,
      getTraining: async () => ({ ok: true, canManage: false, canCheckIn: true, checkInNote: '',
        training: { trainingId: 't1', title: '周末训练', description: '', signupCount: 1 },
        myRegistration: { signupStatus: 'registered', attendanceStatus: 'not_submitted' }, message: '' }),
      listTrainingRegistrations: async () => ({ ok: true, canManage: false, members: [] }),
      requestTrainingCheckIn: async (payload) => {
        memberCalls.push(payload);
        return { ok: true, registration: { attendanceStatus: 'pending' } };
      },
    };
    memberPage.setData({ openTrainingId: 't1' });
    await memberPage.loadTrainingDetail('t1');
    assert.strictEqual(memberPage.data.trainingDetail.canCheckIn, true);

    await memberPage.onRequestCheckIn();
    assert.deepStrictEqual(memberCalls, [{ trainingId: 't1' }], '本人签到只提交自己的训练编号');
    assert.strictEqual(memberPage.data.notice, '已提交签到，等待负责人确认');

    // 负责人：名单里一行「待确认」→ 可确认、可退回（退回须填原因）
    fx.to('demo_muc_admin');
    const adminPage = instantiate(spacePanelConfig);
    await adminPage.onLoad();
    const adminCalls = [];
    adminPage.api = {
      ...adminPage.api,
      getTraining: async () => ({ ok: true, canManage: true, canCheckIn: false, checkInNote: '',
        training: { trainingId: 't1', title: '周末训练', description: '', signupCount: 1 },
        myRegistration: null, message: '' }),
      listTrainingRegistrations: async () => ({ ok: true, canManage: true, members: [], registrations: [
        { userId: 'demo_muc_member', nickName: '会员', collegeName: '', signupStatus: 'registered',
          attendanceStatus: 'pending', attendanceLabel: '待确认', revision: 2 },
      ] }),
      confirmTrainingCheckIn: async (payload) => { adminCalls.push(['confirm', payload]); return { ok: true }; },
      rejectTrainingCheckIn: async (payload) => { adminCalls.push(['reject', payload]); return { ok: true }; },
      revokeTrainingCheckIn: async (payload) => { adminCalls.push(['revoke', payload]); return { ok: true }; },
    };
    adminPage.setData({ openTrainingId: 't1' });
    await adminPage.loadTrainingDetail('t1');
    const row = adminPage.data.trainingRoster[0];
    assert.strictEqual(row.canApprove, true, '待确认行出现确认 / 退回入口');
    assert.strictEqual(row.canRevoke, false, '未确认不能撤销');

    await adminPage.onConfirmCheckIn({ currentTarget: { dataset: { userid: 'demo_muc_member', revision: 2 } } });
    assert.deepStrictEqual(adminCalls[0], ['confirm',
      { trainingId: 't1', userId: 'demo_muc_member', expectedRevision: 2 }]);

    adminPage.onStartApproval({ currentTarget: { dataset: { userid: 'demo_muc_member', kind: 'reject' } } });
    assert.deepStrictEqual(adminPage.data.approvalAction, { userId: 'demo_muc_member', kind: 'reject' });
    await adminPage.onSubmitApproval();
    assert.ok(adminPage.data.error, '未填原因给出就地错误');
    assert.strictEqual(adminCalls.length, 1, '没填原因不调用退回接口');

    adminPage.onApprovalReason({ detail: { value: '未到场' } });
    await adminPage.onSubmitApproval();
    assert.deepStrictEqual(adminCalls[1], ['reject',
      { trainingId: 't1', userId: 'demo_muc_member', reason: '未到场' }]);
    assert.strictEqual(adminPage.data.approvalAction, null, '提交后收起原因输入');
    assert.strictEqual(adminPage.data.notice, '已退回该签到');
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 网球计分台（协会级赛事，端到端）
 * ============================================================
 * 与上面的匹克球计分台同一条路径，只是协会换成网球：赛事默认赛制从注册表取
 * （一盘决胜 · 6 局 · 带占先），计分台要按「分 → 局 → 盘」三层推进，
 * 定稿时写回的是盘比分而不是局比分。
 * ============================================================ */

test('实时计分台 —— 网球协会：4 分一局、6 局一盘，一盘打完可定稿', async () => {
  const fx = schoolEventFixture('tn');
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);
    const res = await fx.api().listSchoolMatches({ eventId });
    const row = (res.matches || []).find((item) => item.status === MATCH_STATUS.PENDING);
    assert.ok(row, '开赛后应当有一场待确认的比赛');

    // 赛制在抽签时就按协会落库了，不是录入时才临时补
    const detail = await fx.api().getSchoolMatch({ matchId: row.matchId });
    assert.strictEqual(detail.match.scoring, 'tennis');
    assert.strictEqual(detail.match.setGames, 6);
    assert.strictEqual(detail.match.gamePoints, undefined);

    fx.to('demo_muc_admin');
    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId: row.matchId });

    assert.strictEqual(page.data.error, '', page.data.error);
    assert.strictEqual(page.data.formatText, '一盘决胜 · 每盘 6 局（6:6 抢七）');
    assert.strictEqual(page.data.view.pointsTextA, '0', '网球开局是 0，不是 15');
    assert.strictEqual(page.data.view.gameIndexText, '第 1 盘');
    assert.strictEqual(page.data.view.setsText, '0 : 0');

    // 同一侧连拿 3 分：15 → 30 → 40
    for (let i = 0; i < 3; i += 1) page.onScore({ currentTarget: { dataset: { side: 'A' } } });
    await page.queue;
    assert.strictEqual(page.data.view.pointsTextA, '40');
    assert.strictEqual(page.data.view.gamesText, '0 : 0', '还没拿局，局分不动');

    // 第 4 分拿下这一局
    page.onScore({ currentTarget: { dataset: { side: 'A' } } });
    await page.queue;
    assert.strictEqual(page.data.view.gamesText, '1 : 0');
    assert.strictEqual(page.data.view.pointsTextA, '0', '新的一局从 0 起');

    // 再连拿 5 局 → 6:0 拿下这一盘，一盘决胜即整场结束
    for (let i = 0; i < 20; i += 1) page.onScore({ currentTarget: { dataset: { side: 'A' } } });
    await page.queue;
    assert.strictEqual(page.data.view.setsText, '1 : 0');
    assert.strictEqual(page.data.view.finished, true);
    assert.strictEqual(page.data.canFinish, true);

    page.onFinish();
    await page.queue;

    const found = await fx.api().getSchoolMatch({ matchId: row.matchId });
    assert.deepStrictEqual(found.match.scoreA, [6], '定稿写回的是盘比分，不是局比分');
    assert.deepStrictEqual(found.match.scoreB, [0]);
    assert.strictEqual(found.match.status, MATCH_STATUS.PENDING, '定稿只到待确认');
  } finally {
    fx.restore();
  }
});

test('实时计分台 —— 网球抢七：4:4 不算抢七，6:6 才进，抢七分数按原始数字显示', async () => {
  const fx = schoolEventFixture('tn');
  try {
    const eventId = await fx.publish({ seedCount: 2 });
    await fx.play(eventId, ['demo_muc_member', 'demo_muc_admin']);
    const res = await fx.api().listSchoolMatches({ eventId });
    const row = (res.matches || []).find((item) => item.status === MATCH_STATUS.PENDING);

    // 走接口铺分：每局 4 分定胜负（无占先之外的常规规则），交替拿局
    const api = fx.api();
    await api.startSchoolLiveScore({ matchId: row.matchId });
    let rally = 0;
    const feed = async (side, times) => {
      for (let i = 0; i < times; i += 1) {
        rally += 1;
        const out = await api.recordSchoolRally({ matchId: row.matchId, side, rallyId: `r-${rally}` });
        assert.strictEqual(out.ok, true, out.message);
      }
    };

    // 4:4：标准盘还没到抢七
    for (let g = 0; g < 4; g += 1) {
      await feed('A', 4);
      await feed('B', 4);
    }
    fx.to('demo_muc_admin');
    const page = instantiate(liveScoreConfig);
    await page.onLoad({ matchId: row.matchId });
    assert.strictEqual(page.data.view.gamesText, '4 : 4');
    assert.strictEqual(page.data.view.tiebreakText, '', '标准盘 4:4 不抢七，6:6 才是');
    assert.strictEqual(page.data.view.finished, false);

    // 再各拿两局 → 6:6，进抢七
    for (let g = 0; g < 2; g += 1) {
      await feed('A', 4);
      await feed('B', 4);
    }
    await page.onLoad({ matchId: row.matchId });
    assert.strictEqual(page.data.view.gamesText, '6 : 6');
    assert.strictEqual(page.data.view.tiebreakText, '抢七');
    assert.strictEqual(page.data.view.finished, false, '抢七没打完，整场不算结束');

    // 抢七里比分是原始数字（不是 15/30/40），先拿 1 分
    await feed('A', 1);
    await page.onLoad({ matchId: row.matchId });
    assert.strictEqual(page.data.view.pointsTextA, '1');
    assert.strictEqual(page.data.view.pointsTextB, '0');

    // 连拿 7 分 → 抢七 7:0，这一盘 7:6，一盘决胜即整场结束
    await feed('A', 6);
    await page.onLoad({ matchId: row.matchId });
    assert.strictEqual(page.data.view.finished, true);
    assert.strictEqual(page.data.view.setsText, '1 : 0');

    page.onFinish();
    await page.queue;
    const found = await fx.api().getSchoolMatch({ matchId: row.matchId });
    assert.deepStrictEqual(found.match.scoreA, [7], '抢七赢下来的盘记 7:6');
    assert.deepStrictEqual(found.match.scoreB, [6]);
    assert.deepStrictEqual(
      found.match.tiebreaks,
      [{ setIndex: 0, a: 7, b: 0 }],
      '抢七小分单独存一份，用来还原 7:6(0) 的括号'
    );
  } finally {
    fx.restore();
  }
});

test('录入页 —— 网球协会日常约球：盘制与每盘局数可选，提交落库带网球赛制', async () => {
  const fx = schoolEventFixture('tn');
  try {
    fx.to('demo_muc_member');
    const entry = instantiate(matchEntryConfig);
    await entry.onLoad();

    assert.strictEqual(entry.data.blockReason, '', entry.data.blockReason);
    assert.strictEqual(entry.data.isTennis, true);
    assert.strictEqual(entry.data.scoreUnit, '盘');
    assert.deepStrictEqual(entry.data.gamePointsLabels, [], '网球页面不该冒出「11/15/21 分制」');
    assert.strictEqual(entry.data.bestOfText, '一盘决胜');
    assert.strictEqual(entry.data.setGamesText, '6 局（标准盘）');
    assert.strictEqual(entry.data.scoreRows.length, 1, '一盘决胜只要一行比分');

    // 换三盘两胜 → 比分行跟着扩到三行
    entry.onPickBestOf({ detail: { value: 1 } });
    assert.strictEqual(entry.data.form.bestOf, 3);
    assert.strictEqual(entry.data.scoreRows.length, 3);

    // 换 4 局短盘：tiebreakAt 要跟着走，否则 4:4 永远不会进抢七
    entry.onPickSetGames({ detail: { value: 1 } });
    assert.strictEqual(entry.data.form.setGames, 4);
    assert.strictEqual(entry.data.form.tiebreakAt, 4);
    entry.onToggleNoAd({ detail: { value: true } });
    assert.strictEqual(entry.data.form.noAd, true);
    assert.strictEqual(entry.data.formatText, '三盘两胜 · 每盘 4 局短盘（4:4 抢七） · 无占先');

    // 选对手，填满三盘：5:3 / 3:5 / 5:4（第四盘靠抢七才有的比分）
    entry.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: 'demo_muc_admin' } } });
    const fill = (side, values) => values.forEach((value, slot) => {
      entry.onInputScore({ currentTarget: { dataset: { side, slot } }, detail: { value: String(value) } });
    });
    fill('A', [5, 3, 5]);
    fill('B', [3, 5, 4]);
    assert.ok(entry.data.winnerText, '填完三盘就该判出胜方');

    await entry.onSubmit();
    assert.strictEqual(entry.data.errorText, '');

    const list = await fx.api().listSchoolMatches({});
    assert.strictEqual(list.matches.length, 1);
    const found = await fx.api().getSchoolMatch({ matchId: list.matches[0].matchId });
    assert.deepStrictEqual(found.match.scoreA, [5, 3, 5]);
    assert.deepStrictEqual(found.match.scoreB, [3, 5, 4]);
    assert.strictEqual(found.match.winner, 'A');
    assert.strictEqual(found.match.scoring, 'tennis');
    assert.strictEqual(found.match.setGames, 4);
    assert.strictEqual(found.match.tiebreakAt, 4);
    assert.strictEqual(found.match.noAd, true);
    assert.strictEqual(found.match.gamePoints, undefined, '网球记录不落 gamePoints');
    assert.strictEqual(found.match.status, MATCH_STATUS.PENDING);
  } finally {
    fx.restore();
  }
});

/* ============================================================
 * 团队运动（篮球）：工作台页签与后端闸门
 * ============================================================
 * 篮球不提供排行榜与个人比赛入口，页签由注册表能力生成；同时个人赛录分
 * 必须被后端拒绝——「藏按钮」挡不住直接调接口，而一场 5v5 写进 matches
 * 会污染个人 Elo 与评级表。
 * ============================================================ */

test('工作台 —— 篮球提供协会空间、组队、我的球队、赛事，没有排行榜与比赛', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const scope = require('../miniprogram/services/association-scope.js');
  schoolSession.reset();
  const before = scope.getAssociation();
  try {
    const page = instantiate(associationHomeConfig);
    page.onLoad({ association: 'bk' });

    assert.strictEqual(page.data.associationId, 'bk');
    assert.strictEqual(page.data.associationName, '民大篮球');
    assert.deepStrictEqual(
      page.data.tabs.map((item) => item.tab),
      ['space', 'teams', 'myTeams', 'events'],
      '团队运动不该出现排行榜与个人比赛页签'
    );
    assert.deepStrictEqual(
      page.data.tabs.filter((item) => item.active).map((item) => item.tab),
      ['space'],
      '默认落在协会空间'
    );
    assert.deepStrictEqual(page.data.mounted, { space: true, teams: false, myTeams: false, events: false });

    // 旧链接带着该协会不提供的页签（tab=match）时不白屏，回落到第一个可用页签
    const stale = instantiate(associationHomeConfig);
    stale.onLoad({ association: 'bk', tab: 'match' });
    assert.strictEqual(stale.data.activeTab, 'space');
  } finally {
    scope.setAssociation(before);
    schoolSession.reset();
  }
});

test('个人赛录分 —— 团队运动协会直接拒绝，不写 matches', async () => {
  const fx = schoolEventFixture('bk');
  try {
    fx.to('demo_muc_admin');
    const out = await fx.api().submitSchoolMatch({
      matchType: MATCH_TYPE.SINGLES,
      teamA: ['demo_muc_member'],
      teamB: ['demo_muc_admin'],
      scoreA: ['11', '11'],
      scoreB: ['9', '7'],
      gamePoints: 11,
      bestOf: 3,
      matchTime: '2026-06-10T09:00:00',
      requestId: 'req_bk_guard_1',
    });

    assert.strictEqual(out.ok, false);
    assert.match(out.message, /团队项目/);
    const list = await fx.api().listSchoolMatches({});
    assert.strictEqual(list.matches.length, 0, '被拒的录分不该留下比赛记录');
  } finally {
    fx.restore();
  }
});
