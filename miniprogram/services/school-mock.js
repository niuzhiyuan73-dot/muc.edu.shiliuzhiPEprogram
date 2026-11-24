const { createSchoolDemoSeed, createSchoolDemoContent } = require('./school-seed.js');
const { createSchoolMemoryRepo } = require('./school-memory-repo.js');
const { createSchoolHandlers } = require('../../src/server/services/school-membership-service.js');
const personalSportsService = require('../../src/server/services/personal-sports-service.js');
const { buildSchoolContext } = require('../../src/server/services/school-context.js');
const { buildMeetContext } = require('../../src/server/services/meet-context.js');
const { meetRequestScope } = require('../shared/utils/meet-scope.js');
const {
  LEGACY_SCHOOL_ID, schoolScope, schoolKey,
  schoolMemberKey, schoolMembershipKey,
} = require('../shared/utils/school.js');
const { COLLEGES } = require('../shared/utils/constants.js');
const {
  SCHOOL_IDENTITY_ACTIONS, SCHOOL_SPACE_ACTIONS, SCHOOL_EXCHANGE_ACTIONS,
  SCHOOL_MEET_ACTIONS, pickActions,
} = require('../shared/utils/school-actions.js');
const { MEMBER_SEED } = require('./seed.js');
const exchange = require('../../src/server/services/exchange-service.js');
const groupService = require('../../src/server/services/association-group-service.js');
const memberService = require('../../src/server/services/association-member-service.js');
const noticeService = require('../../src/server/services/association-notice-service.js');
const trainingService = require('../../src/server/services/association-training-service.js');
const eventService = require('../../src/server/services/school-event-service.js');
const matchService = require('../../src/server/services/school-match-service.js');
const liveService = require('../../src/server/services/school-live-service.js');
const collegeService = require('../../src/server/services/school-college-service.js');
const announcementService = require('../../src/server/services/school-announcement-service.js');
const schoolMemberService = require('../../src/server/services/school-member-service.js');
const rankService = require('../../src/server/services/school-rank-service.js');
const teamService = require('../../src/server/services/team-service.js');
const teamEventService = require('../../src/server/services/team-event-service.js');
const meetService = require('../../src/server/services/meet-service.js');
const meetLeadService = require('../../src/server/services/meet-college-lead-service.js');
const meetRegistrationService = require('../../src/server/services/meet-registration-service.js');
const meetScheduleService = require('../../src/server/services/meet-schedule-service.js');
const meetScoreService = require('../../src/server/services/meet-score-service.js');
const meetAdvanceService = require('../../src/server/services/meet-advance-service.js');
const meetStandingService = require('../../src/server/services/meet-standing-service.js');
const { createMeetDemoRecords } = require('./meet-seed.js');

/**
 * 协会空间处理器集合。
 *
 * 【注册面按白名单收口，且与云端同一份清单】
 * 从前这里是「11 个 service 的所有导出函数」，于是 27 个内部辅助函数
 * （buildDirectory / isEventDoc / medalOf …）也成了可被调用的协议 2 action，
 * 云端与本地模拟**同时**放大攻击面。现在从 `../utils/school-actions.js`
 * 取白名单——那份文件被镜像到云端（tools/sync-cloud-lib.js），两侧读同一份，
 * 结构上不可能分叉。见 2026-10-16 只读审计 H1。
 */
const spaceHandlers = Object.freeze(pickActions([
  groupService, memberService, noticeService, trainingService, eventService, matchService,
  liveService, collegeService, announcementService, schoolMemberService, rankService,
  teamService, teamEventService,
], SCHOOL_SPACE_ACTIONS));

/** 跨校邀请赛处理器集合（同样按白名单收口）。 */
const exchangeHandlers = Object.freeze(pickActions([exchange], SCHOOL_EXCHANGE_ACTIONS));

/** 运动会处理器集合（学校级，请求不带协会；与云端 school-meet-handlers 同一份白名单）。 */
const meetHandlers = Object.freeze(
  pickActions([
    meetService, meetLeadService, meetRegistrationService, meetScheduleService, meetScoreService,
    meetAdvanceService,
    meetStandingService,
  ], SCHOOL_MEET_ACTIONS),
);

const DEMO_ACTORS = Object.freeze([
  { id: 'demo_applicant', label: '模拟申请人' },
  { id: 'demo_muc_admin', label: '民大校管理员' },
  { id: 'demo_buaa_admin', label: '北航校管理员' },
  { id: 'demo_muc_member', label: '民大会员' },
  { id: 'demo_buaa_member', label: '北航会员' },
  // 平台管理员排在最后，以免挪动既有演示身份的下标（页面与用例都按下标选择）。
  { id: 'demo_platform_admin', label: '平台管理员' },
  // 学院负责人（民大 c02）：演示「只替本学院交名单 / 排阵」的边界，同样追加在末尾。
  { id: 'demo_muc_college_leader', label: '民大学院负责人' },
  // 北航扩充（2026-10-16）：跨校也要有差异性——会员二 / 三、学院负责人、协会负责人。
  // 一律追加在末尾：页面与用例按**下标**选演示身份，重排会打乱既有演示。
  { id: 'demo_buaa_member_2', label: '北航会员二' },
  { id: 'demo_buaa_member_3', label: '北航会员三' },
  { id: 'demo_buaa_college_leader', label: '北航学院负责人' },
  { id: 'demo_buaa_leader', label: '北航协会负责人' },
  // 民大会员二（2026-10-16）：北航有会员二 / 三，民大只有一位会员，跨校邀请赛
  // 演示凑不出「两校各两人」的四人签表。这一位同时携带一条**待北航审批的转校
  // 申请**（见 school-seed.demoTransferApplication），另一位「民大会员」保持干净，
  // 专门用来当场演示「提交转校申请」。同样追加在末尾，不动既有下标。
  { id: 'demo_muc_member_2', label: '民大会员二' },
  // 运动会演示裁判（B9）：张裁判——演示「我的任务」逐场录分。
  // 同追加在末尾：页面与用例按**下标**选演示身份，重排会打乱既有演示。
  { id: 'm_j1', label: '张裁判（运动会演示）' },
]);

/**
 * 把旧版演示账号（u01–u24）接进学校维度。
 *
 * 【为什么需要】
 * 旧版账号（`seed.js`）只在旧台账里存在；学校维度的页面（协会空间 / 学校身份）
 * 与它们互不相识。这里把这批账号一次性登记成**民大**的在册会员，作为演示数据
 * 里的人（赛事报名名单、比赛对阵、排行榜都靠他们撑起来）。
 *
 * 【2026-10-18 起不再给它们任何管理角色】
 * 从前 u01 被落成校管理员、ASSOC_ROLE_SEED 里的负责人被落成协会 leader/staff，
 * 于是「谁能管」有两个来源：一是演示身份切换器（DEMO_ACTORS 里的 demo_muc_admin
 * 等），二是这批旧种子角色。结果是成员列表里同时出现两个管理员、切换身份改了
 * 权限却仍被旧角色放行。现在权限只有**一个**来源：账号级角色（schoolRoles）与
 * 协会 membership，而带角色的账号都由切换器给出、在 DEMO_ACTORS 里列得出来。
 * 旧账号只保留「在册会员」身份，和普通同学一样。
 *
 * @param {Object} seed createSchoolDemoSeed() 产出的种子（会被就地补写）
 */
function attachLegacyMembers(seed) {
  const collegeIdOf = new Map(COLLEGES.map((name, index) => [name, `c${String(index + 1).padStart(2, '0')}`]));
  const legacy = MEMBER_SEED.map((item, index) => ({ item, userId: `u${String(index + 1).padStart(2, '0')}` }));
  seed.users = seed.users.concat(legacy.map(({ item, userId }) => ({
    _id: userId, openId: `mock_openid_${userId}`, nickName: item.nickName, realName: item.realName,
    gender: item.gender || '', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: LEGACY_SCHOOL_ID, simulated: true,
  })));
  seed.schoolMembers = seed.schoolMembers.concat(legacy.map(({ item, userId }, index) => ({
    _id: schoolMemberKey(userId, LEGACY_SCHOOL_ID), userId, schoolId: LEGACY_SCHOOL_ID,
    collegeId: collegeIdOf.get(item.college) || '', studentId: '2023' + String(index + 1).padStart(4, '0'),
    status: 'active', simulated: true,
  })));
}

/**
 * 学校维度的默认演示身份：u06（原 protocol-1 mock.js 的
 * DEFAULT_CURRENT_USER_ID，P10 删 mock.js 后常量落在这里，取值不变——
 * 既有用例与文档都按这个编号约定）。
 * 从前这里默认是 S2 的「普通访客」demo_applicant（无学校归属），演示
 * u01–u24 时协会空间会被判成无权限；旧版账号接入学校维度后，身份直接由
 * 这一个常量决定，改编号即换人。
 */
function defaultActorId() {
  return 'u06';
}

let actorId = DEMO_ACTORS[0].id;
/**
 * 运动会演示数据的装载进度。
 *
 * 【为什么是异步的】
 * 演示届不是手写的文档，而是**驱动真实服务链路**跑出来的（见 meet-seed.js）——
 * 报名、抽签、录分、发布、更正全都走一遍，记录才与服务端口径一致。服务调用
 * 全是异步，reset() 却是同步的，所以这里「点发起火、不等待」：装载承诺挂在
 * 模块级变量上，forMeet 的每个动作先 await 它再执行。装载失败只记日志——
 * 运动会接口退回「本届为空」，不拖垮身份 / 空间 / 交流另外三面。
 */
let meetDemoReady = Promise.resolve();

/**
 * 把运动会演示记录并进仓储。
 *
 * 与 withDemoContent 同进退：要干净台账的用例（数条数的夹具）传
 * `{ withDemoContent: false }`，运动会演示数据一并跳过。
 */
async function loadMeetDemo(targetRepo) {
  const records = await createMeetDemoRecords();
  for (const [key, docs] of Object.entries(records)) {
    for (const doc of docs) await targetRepo[key].set(doc._id, doc);
  }
}
/**
 * 模拟的「当前微信身份」OpenID（B3）。真实设备上 OpenID 由微信给出，换设备即换
 * OpenID；模拟端把它做成一个可变状态：默认空串，客户端按 actorId 解析（与从前
 * 行为一致）。`simulateNewWechat` 把它拨到一个尚无账号的新 OpenID，从而演示
 * 「新微信号注册 → 开通平台账号 → 申请学校身份」的完整链路——这是旧栈
 * `registerMember` 的 S2 对应路径。
 */
let wechatOpenId = '';
let repo;
const handlers = Object.freeze(pickActions([
  createSchoolHandlers({ claimKey: (schoolId, studentId) => schoolKey('demo-claim', schoolId, studentId) }),
  personalSportsService,
], SCHOOL_IDENTITY_ACTIONS));
/**
 * 重置学校维度内存仓储。
 *
 * 默认连同**各学校各协会的演示内容**（公告 / 赛事 / 比赛 / 赛事报名）一起挂上，
 * 协会空间与排行榜一进去就有东西可看。需要干净台账的用例（如公告页夹具要先自己
 * 摆几条再数条数）传 `{ withDemoContent: false }` 关掉——演示内容与业务数据
 * 混在一起数，会让「一共几条」这类断言随演示内容的多寡漂移。
 *
 * @param {Object} [options]
 * @param {boolean} [options.withDemoContent=true] 是否挂演示内容
 */
function reset(options = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_applicant', openId: 'mock_openid_applicant', nickName: '模拟申请人',
    platformStatus: 'active', platformRole: 'member', simulated: true });
  // 平台管理员：账号级身份，可跨校读、跨校指定权限；不带 primarySchoolId，不占某校身份。
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin', nickName: '平台管理员',
    platformStatus: 'active', platformRole: 'admin', simulated: true });
  // 学院负责人演示身份：民大 c02（民族学与社会学学院）在册会员 + pkb 的 staff 角色。
  // 旧种子带的管理角色已全部撤掉（见 attachLegacyMembers 的说明），要演示
  // 「只替本学院交名单 / 排阵」只能靠这个显式落 collegeId 的账号。
  //
  // 【为什么落在 c02 而不是演示账号扎堆的 c01】
  // c01（中华民族共同体学院）只有三个演示账号，且都没写性别；学院赛排阵要按小项
  // 性别筛人（男单只列男队员），落在 c01 会一所学院也排不出阵。c02 有 u10（男）与
  // u24（女）各一名，正好能把「本学院交名单 → 排阵（男单 + 女单）→ 提交」整条链
  // 演示通。学院负责人是「某校某学院某协会」的身份，学校身份、会员记录与协会
  // membership 三处的 collegeId 必须一致（下列三行同落 'c02'）。
  seed.users.push({ _id: 'demo_muc_college_leader', openId: 'mock_openid_college_leader',
    nickName: '学院负责人', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: LEGACY_SCHOOL_ID, simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_college_leader', LEGACY_SCHOOL_ID),
    userId: 'demo_muc_college_leader', schoolId: LEGACY_SCHOOL_ID, collegeId: 'c02',
    studentId: 'demo-college-leader', status: 'active', simulated: true });
  seed.memberships.push({ _id: schoolMembershipKey('demo_muc_college_leader', { schoolId: LEGACY_SCHOOL_ID, association: 'pkb' }),
    userId: 'demo_muc_college_leader', schoolId: LEGACY_SCHOOL_ID, association: 'pkb',
    role: 'staff', collegeId: 'c02', status: 'active', simulated: true });
  attachLegacyMembers(seed);
  if (options.withDemoContent !== false) {
    const content = createSchoolDemoContent();
    for (const key of Object.keys(content)) seed[key] = (seed[key] || []).concat(content[key]);
  }
  repo = createSchoolMemoryRepo(seed);
  actorId = defaultActorId();
  wechatOpenId = '';
  meetDemoReady = options.withDemoContent === false
    ? Promise.resolve()
    : loadMeetDemo(repo).catch((err) => {
      // 演示数据装载失败不该让另外三面也用不了：记下来，运动会接口按空数据走。
      console.error('运动会演示数据装载失败', err);
    });
}
reset();
/** 旧版演示账号编号（u01–u24）也已接入 S2，可作演示身份切换（B3）。 */
const LEGACY_ACTOR_IDS = Object.freeze(MEMBER_SEED.map((_, index) => `u${String(index + 1).padStart(2, '0')}`));
const isValidActor = (id) => DEMO_ACTORS.some((actor) => actor.id === id) || LEGACY_ACTOR_IDS.includes(id);

function setDemoActor(id) {
  if (!isValidActor(id)) throw new Error('未知模拟身份');
  actorId = id;
  // 演示身份与微信身份只认一个：切回 actor 演示时清掉「新微信号」模拟，
  // 否则两个身份来源并存，写接口与展示会各认一个人。
  wechatOpenId = '';
}
/**
 * 模拟一台「换了新微信号」的设备：把当前微信身份拨到一个尚无账号的 OpenID。
 * 之后身份 / 空间 / 交流客户端都按这个 OpenID 解析（actorId 清空），注册走
 * `registerSchoolAccount` 凭 OpenID 开户，与云端语义一致。
 * @param {string} [openId] 指定 OpenID（测试用）；缺省生成一个不重复的
 * @returns {string} 生效的模拟 OpenID
 */
function simulateNewWechat(openId) {
  wechatOpenId = typeof openId === 'string' && openId ? openId
    : `mock_openid_new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  actorId = '';
  return wechatOpenId;
}
/**
 * 创建身份客户端时绑定的解析入口：有模拟微信身份就按 OpenID（新设备），
 * 否则按演示 actorId（既有演示账号）。两者在同一处收敛，避免身份 / 空间 /
 * 交流三套客户端各认一个人。
 */
function actorBinding() {
  return wechatOpenId ? { actorId: '', openId: wechatOpenId } : { actorId, openId: '' };
}
function forSchoolIdentity(input) {
  const scope = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async payload => {
    if (name === 'getMySportsDashboard') await meetDemoReady;
    const ctx = name === 'getMySportsDashboard'
      ? { ...await buildMeetContext({ repo: boundRepo, ...binding, scope: { schoolId: scope.schoolId } }), isMock: true }
      : await buildSchoolContext({ repo: boundRepo, ...binding, scope });
    const result = await handler(payload || {}, ctx);
    // 失败按值返回（{ok:false, message}），与云端 school-request 的 acceptResult 同形。
    // 从前这里 throw，于是同一个「没权限」在四组门面里表现不一：页面得同时写
    // try/catch 与 if (!result.ok) 才不漏（2026-10-28 第十轮只读审计 P1）。
    return result.ok ? result.data : result;
  }])));
}
module.exports = { forSchoolIdentity, setDemoActor, getDemoActor: () => actorId, simulateNewWechat, DEMO_ACTORS, reset };
function forExchange(input) {
  const target = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(exchangeHandlers).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, ...binding, scope: target });
    const result = await handler(payload || {}, ctx);
    return result.ok ? result.data : result;
  }])));
}
module.exports.forExchange = forExchange;

function forAssociationSpace(input) {
  const target = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(spaceHandlers).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, ...binding, scope: target });
    // isMock 供比赛「对手确认」等口径在本地演示时放宽（见 school-match-service）。
    const result = await handler(payload || {}, Object.freeze({ ...ctx, isMock: true }));
    return result.ok ? result.data : result;
  }])));
}
module.exports.forAssociationSpace = forAssociationSpace;

function forMeet(input) {
  const scope = meetRequestScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(meetHandlers).map(([name, handler]) => [name, async payload => {
    // 演示数据就绪前，运动会动作一律等待——否则「届列表」会先返回空，
    // 用户看到一届都没有，其实只是种子还没跑完。
    await meetDemoReady;
    const ctx = await buildMeetContext({ repo: boundRepo, ...binding, scope });
    const result = await handler(payload || {}, ctx);
    // 与云端 forMeet 的 throwOnRefused 对齐：运动会页面按「失败进 catch」写的，
    // 这里保持抛出，双端表现才一致（理由见 school-cloud.js 那段说明）。
    // 顶层 ok:false 与 data.ok:false 两种形态都转成异常。
    if (result.ok === false) throw new Error(result.message || '操作失败');
    const data = result.data;
    if (data && data.ok === false) throw new Error(data.message || '操作失败');
    return data;
  }])));
}
module.exports.forMeet = forMeet;
