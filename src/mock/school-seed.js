/** 独立的双校试点目录，不自动写入云端，也不接管现有页面。 */
const {
  COLLEGES, MATCH_TYPE, MATCH_STATUS, MATCH_COMPETITION, MATCH_OUTCOME,
  EVENT_STATUS, EVENT_LEVEL, ANNOUNCEMENT_STATUS, ANNOUNCEMENT_CATEGORIES, SIGNUP_STATUS,
  EVENT_FORMAT, EVENT_BRONZE_MODE, EVENT_PLACEMENT_MODE, DEFAULT_GF_RESET,
} = require('../shared/utils/constants.js');
const { allAssociations } = require('../shared/utils/associations.js');
const { createTeamDemoContent } = require('./team-demo.js');
const { createFootballDemoContent } = require('./football-demo.js');
const { createCollegeCupContent } = require('./college-cup-seed.js');
const {
  schoolAssociationKey, collegeKey, schoolMemberKey, schoolRoleKey,
  schoolMembershipKey, schoolEventKey, schoolEventSignupKey, schoolMatchKey,
  schoolAnnouncementKey, schoolKey, memberRatingKey,
} = require('../shared/utils/school.js');
// 演示比赛的评级与结算快照由**同一个纯结算内核**产出（Elo 逐场结算改造）：
// 与线上确认路径同一份纯函数，演示数据与真实数据从此不可能分叉。
const { materializeRatings, computeSettlement } = require('../server/services/school-rating-service.js');
// 记录组装复用旧栈纯规则模块（同一把尺子）——演示内容里的事件 / 比赛 / 公告
// 因此与页面点出来的形状一字不差，不会各写一份、慢慢分叉。
const { buildAnnouncementRecord } = require('../shared/services/announcement.js');
const { buildEventRecord } = require('../shared/services/event.js');
const { buildMatchRecord } = require('../shared/services/match-record.js');
const { buildSchoolApplication } = require('../server/services/school-member.js');
// 演示邀请赛的签表由**赛制引擎现算**（两个都是纯函数），与 drawExchangeEvent
// 走同一段代码；手写签表迟早与引擎分叉，演示数据一旦分叉就会误导人。
const { planExchangeDraw, planExchangeMatches } = require('../server/services/exchange-plan.js');
// 演示数据的时间锚点：四个种子文件共用同一份，见 demo-clock.js
const { DAY_MS, demoToday } = require('./demo-clock.js');
// 旧版演示会员（u01–u24）：演示比赛的参赛者绝大多数是他们，性别要从这里取。
// 【为什么必须取到】（2026-10-23 方案 A）评级文档现在冗余 gender / memberStatus，
// 榜单与个人主页的排名靠它筛项目。取不到性别就会落成空串，那批人从榜上消失。
const { MEMBER_SEED } = require('./seed.js');

const iso = value => new Date(value).toISOString();

function createSchoolSeed() {
  const schools = [
    { _id: 'muc', schoolId: 'muc', name: '中央民族大学', shortName: '民大', status: 'active', configVersion: 1 },
    { _id: 'buaa', schoolId: 'buaa', name: '北京航空航天大学', shortName: '北航', status: 'active', configVersion: 1, simulated: true },
  ];
  const schoolAssociations = schools.flatMap((school) => allAssociations().map((sport) => ({
    _id: schoolAssociationKey({ schoolId: school._id, association: sport.id }),
    schoolId: school._id, association: sport.id, name: `${school.name}${sport.sportName}协会`,
    status: 'active', simulated: school.simulated === true,
  })));
  // 北航学院仅为测试样本，不能作为真实学校组织目录直接上线。
  const colleges = schools.flatMap((school) =>
    (school._id === 'muc' ? COLLEGES : ['航空学院（模拟）', '计算机学院（模拟）', COLLEGES[0]])
      .map((name, index) => {
        const collegeId = `c${String(index + 1).padStart(2, '0')}`;
        return { _id: collegeKey(school._id, collegeId), schoolId: school._id, collegeId,
          name, status: 'active', simulated: school.simulated === true };
      })
  );
  return { schools, schoolAssociations, colleges };
}

/**
 * 双校演示账号。
 *
 * 【为什么北航要有一整套】
 * 演示「跨校差异」时，只切学校却没有对方学校的人可用，就演不出「对方学校的会员
 * 报名 / 被审核 / 有战绩」。所以北航与民大一样备齐：校管理员、普通会员（2～3 位，
 * 战绩各不相同）、学院负责人、协会负责人。
 *
 * 【性别为什么显式写】
 * 单打榜按性别分池（男单 / 女单），没有性别的人在两张榜上都会消失；
 * 学院赛排阵也要按小项性别筛人。演示账号必须带性别，榜单与排阵才有东西可看。
 */
const DEMO_ACCOUNTS = [
  { id: 'demo_muc_admin', schoolId: 'muc', nickName: '民大模拟管理员', gender: 'M', role: 'admin', collegeId: 'c01', studentId: 'TEST001' },
  { id: 'demo_muc_member', schoolId: 'muc', nickName: '民大模拟会员', gender: 'M', collegeId: 'c01', studentId: 'TEST002' },
  // 四校本账号的学号保持不变（既有用例拿 TEST001 / TEST002 演「学号已被占用」），
  // 新增账号从 TEST003 往后排。
  { id: 'demo_buaa_admin', schoolId: 'buaa', nickName: '北航模拟管理员', gender: 'M', role: 'admin', collegeId: 'c01', studentId: 'TEST001' },
  { id: 'demo_buaa_member', schoolId: 'buaa', nickName: '北航模拟会员', gender: 'M', collegeId: 'c01', studentId: 'TEST002' },
  // 北航扩充（2026-10-16）：会员二 / 三、学院负责人、协会负责人——跨校也有差异性
  { id: 'demo_buaa_member_2', schoolId: 'buaa', nickName: '北航模拟会员二', gender: 'M', collegeId: 'c02', studentId: 'TEST003' },
  { id: 'demo_buaa_member_3', schoolId: 'buaa', nickName: '北航模拟会员三', gender: 'F', collegeId: 'c02', studentId: 'TEST004' },
  { id: 'demo_buaa_college_leader', schoolId: 'buaa', nickName: '北航学院负责人', gender: 'M', collegeId: 'c01', studentId: 'TEST005',
    membership: { role: 'staff', collegeId: 'c01' } },
  { id: 'demo_buaa_leader', schoolId: 'buaa', nickName: '北航协会负责人', gender: 'M', collegeId: 'c01', studentId: 'TEST006',
    membership: { role: 'leader' } },
  // 民大扩充（2026-10-16）：北航有会员二 / 三，民大只有一位会员，两校人数不对称；
  // 跨校邀请赛演示因此凑不出「两校各两人」的四人签表。补一位民大会员二。
  //
  // 【为什么这一位还带着转校演示】
  // 另一位「民大模拟会员」要保持**干净**——演示时必须能当场走一遍「提交转校申请」；
  // 这一位则预置一条**已提交、待北航审批**的转校申请（见 demoTransferApplication），
  // 于是「北航管理员审批转校」也是一步直达，两条路径各有一个专属账号。
  { id: 'demo_muc_member_2', schoolId: 'muc', nickName: '民大模拟会员二', gender: 'F', collegeId: 'c01', studentId: 'TEST007' },
];

function createSchoolDemoSeed() {
  const seed = createSchoolSeed();
  seed.users = DEMO_ACCOUNTS.map((account) => ({
    // openId 沿用既有约定「mock_openid_ + 去掉 demo_ 前缀的编号」：
    // 云端入口与用例都按 openId 认人（mock_openid_muc_admin 等），不能改名。
    _id: account.id, openId: `mock_openid_${account.id.replace(/^demo_/, '')}`,
    nickName: account.nickName, gender: account.gender,
    platformStatus: 'active', platformRole: 'member',
    primarySchoolId: account.schoolId, simulated: true,
  }));
  seed.schoolMembers = DEMO_ACCOUNTS.map((account) => ({
    _id: schoolMemberKey(account.id, account.schoolId), userId: account.id,
    schoolId: account.schoolId, collegeId: account.collegeId, studentId: account.studentId,
    status: 'active', simulated: true,
  }));
  seed.schoolRoles = DEMO_ACCOUNTS.filter((account) => account.role === 'admin').map((account) => ({
    _id: schoolRoleKey(account.id, account.schoolId), userId: account.id,
    schoolId: account.schoolId, role: 'admin', status: 'active', simulated: true,
  }));
  // 协会身份：学院负责人（staff + collegeId）/ 协会负责人（leader）。
  // 与学校身份页授予的角色同形，页面判权走的仍是同一把尺子。
  seed.memberships = DEMO_ACCOUNTS.filter((account) => account.membership).map((account) => ({
    _id: schoolMembershipKey(account.id, { schoolId: account.schoolId, association: 'pkb' }),
    userId: account.id, schoolId: account.schoolId, association: 'pkb',
    role: account.membership.role,
    ...(account.membership.collegeId ? { collegeId: account.membership.collegeId } : {}),
    status: 'active', simulated: true,
  }));
  return seed;
}

/* ============================================================
 * 演示内容（公告 / 赛事 / 比赛 / 报名）—— 多范围，各有各的口味
 * ============================================================
 * 【为什么与目录种子分开】
 * createSchoolDemoSeed 只造「人」——学校、学院、会员、角色，被近二十个用例
 * 直接调用，形状一变就牵动一大片。演示内容单独成函数，谁要谁接：本地演示由
 * school-mock.reset() 默认挂上；需要干净台账的用例（如公告页夹具）用
 * reset({ withDemoContent: false }) 关掉。
 *
 * 【为什么按范围各造一份（2026-10-16 扩充）】
 * 只造民大匹克球时，切协会 / 切学校看到的还是同一批内容，容易被当成「切了没反应」。
 * 现在每个范围一份规格，三层差异性都落在数据上：
 *   · 不同协会：公告标题、分类、条数与赛事数量各不相同（民大匹克球 5 公告 / 3 赛事，
 *     乒乓 4 / 2，羽球 3 / 1）；
 *   · 不同演示账号：比赛分给不同会员，谁的战绩多、等级分高，切身份就看得出；
 *   · 跨校：北航也有整套账号与自己的公告 / 赛事 / 比赛，切到北航不再是空态。
 *
 * 【时间为什么钉死】
 * 用固定锚点而不是 Date.now()：同一份种子每次 reset 得到完全相同的内容，
 * 用例才能对着确切条数与名次断言。
 * ============================================================ */

/**
 * 演示内容的时间锚点：**当天 09:00（本地时区）**。
 *
 * 【为什么不再钉死一个日期（2026-10-20 修正）】
 * 原来这里是 `new Date('2026-03-01T09:00:00Z')`——一个写死的常量。问题在于
 * 赛事的**状态是存下来的字段**（有 results 即「已结束」，否则「报名中」），
 * 不是按当前时间算的；而首页「近期赛事」按开赛时间升序展示。锚点一旦过去，
 * 用户看到的就是一批「报名中」却开赛在半年前的赛事，逻辑上自相矛盾。
 * 实测 2026-10-20 时，种子里 24 场赛事没有一场开赛时间晚于当天。
 *
 * 锚点本身收敛在 `services/demo-clock.js`，四个种子文件共用同一份，
 * 免得像从前那样各写各的日期、各过各的期。这里只是转出一层，
 * 让本文件里的调用点不必改口径。
 *
 * 【需要绝对固定时间的用例】
 * 自己把 now 传进来（`createSchoolDemoContent({ now })`），不要依赖这个锚点。
 *
 * @returns {Date}
 */
const demoContentNow = demoToday;
/** 民大匹克球协会：既有用例（首页 / 榜单 / 公告）默认落在这里。 */
const DEMO_CONTENT_SCOPE = Object.freeze({ schoolId: 'muc', association: 'pkb' });
/** 发布者取自种子用户里已存在的账号，台账里「谁发的」才追溯得到。 */
const CONTENT_PUBLISHERS = Object.freeze({
  muc: Object.freeze({ _id: 'demo_muc_admin', nickName: '民大模拟管理员' }),
  buaa: Object.freeze({ _id: 'demo_buaa_admin', nickName: '北航模拟管理员' }),
});

/** 规格里出现的学校（去重）：公告按学校各造一份，不能按协会重复造。 */
const distinctSchoolsOf = (specs) => [...new Set(specs.map((spec) => spec.schoolId))];

/** 取构建结果里的记录；表单写错时把第一个错误抛出来，别把半截记录塞进种子。 */
function builtRecordOf(built, what) {
  if (!built.ok) throw new Error(`演示${what}构造失败：${built.firstError}`);
  return built.record;
}

/* ============================================================
 * 3 倍扩容（2026-10-20）
 * ============================================================
 * 演示数据要撑得起「多个项目、多个年份、不同赛制」的浏览：每个球拍项目的
 * 赛事数与比赛流水都补到基线的 3 倍，网球原先一场都没有，这里一并补齐。
 *
 * 【为什么用生成器补齐、而不是把 100 多条写死】
 * 手写表只保留「有性格」的基线（标题、名次、报名人数都是特定的），
 * 追加部分按确定的轮转规则生成：同一份种子每次 reset 结果一致（不用
 * Date.now），但选手、比分、时段各不相同——差异来自规则而不是随机。
 *
 * 【跨协会不混选手】
 * 榜单按「学校 + 协会」隔离，测试还守着「u03 只在匹克球榜、u04 只在乒乓榜」。
 * 所以每个项目各有参赛池，互不交叉；网球是新项目，池子独立。
 * ============================================================ */

/** 各项目的参赛池（民大种子会员 u01～u24，按项目分开） */
const RACKET_SCALE_POOLS = Object.freeze({
  pkb: Object.freeze({
    venue: '民大体育馆',
    men: Object.freeze(['u03', 'u05', 'u06', 'u07', 'u09', 'u10', 'u11', 'u01']),
    women: Object.freeze(['u14', 'u15', 'u16', 'u24']),
  }),
  tt: Object.freeze({
    venue: '民大乒乓球馆',
    men: Object.freeze(['u04', 'u08', 'u10', 'u11', 'u12', 'u13']),
    women: Object.freeze(['u22', 'u23']),
  }),
  bd: Object.freeze({
    venue: '民大羽毛球馆',
    men: Object.freeze(['u07', 'u11', 'u12', 'u13']),
    women: Object.freeze(['u19', 'u21', 'u22', 'u23']),
  }),
  tn: Object.freeze({
    venue: '民大网球场',
    men: Object.freeze(['u02', 'u05', 'u09', 'u13', 'u17', 'u18']),
    women: Object.freeze(['u14', 'u20', 'u24']),
  }),
});

/**
 * 追加赛事：标题、开赛偏移、名额、是否已结束。
 *
 * 「已结束」的赛事必须有 results，且报名人数等于名次人数（见下方自检）；
 * 「报名中」的一律 2～6 人，且不写 u01 / u02（它们是管理员与学院负责人，
 * 报了名会改掉别的演示身份看到的「我报没报」）。
 */
const RACKET_SCALE_EVENTS = Object.freeze({
  pkb: Object.freeze([
    { title: '民大匹克球秋季联赛', startOffsetDays: -63, quota: 24, finished: true },
    { title: '民大匹克球院系对抗赛', startOffsetDays: -42, quota: 32, finished: true },
    { title: '民大匹克球混双公开赛', startOffsetDays: 19, quota: 24 },
    { title: '民大匹克球新生挑战赛', startOffsetDays: 5, quota: 16 },
    { title: '民大匹克球夜场积分赛', startOffsetDays: 12, quota: 16 },
    { title: '民大匹克球年终总决赛', startOffsetDays: 26, quota: 32 },
  ]),
  tt: Object.freeze([
    { title: '民大乒乓球院系团体赛', startOffsetDays: -49, quota: 16, finished: true },
    { title: '民大乒乓球双打邀请赛', startOffsetDays: 15, quota: 24 },
    { title: '民大乒乓球新生杯', startOffsetDays: 8, quota: 16 },
    { title: '民大乒乓球年终总决赛', startOffsetDays: 21, quota: 32 },
  ]),
  bd: Object.freeze([
    { title: '民大羽毛球院系联赛', startOffsetDays: -35, quota: 16, finished: true },
    { title: '民大羽毛球混双公开赛', startOffsetDays: 17, quota: 24 },
  ]),
  tn: Object.freeze([
    { title: '民大网球院系联赛', startOffsetDays: -56, quota: 16, finished: true },
    { title: '民大网球公开赛', startOffsetDays: 9, quota: 24 },
    { title: '民大网球双打挑战赛', startOffsetDays: 23, quota: 16 },
  ]),
});

/** 轮转取人：越界回绕，保证同一份种子每次得到同一组对阵 */
const pickOf = (list, index) => list[index % list.length];

/** 已结束赛事的四人名次：从参赛池里按顺序取，保证「报名 = 名次」 */
function scaledResultsOf(project, roundIndex, finished) {
  const pool = RACKET_SCALE_POOLS[project];
  if (!finished) return null;
  const ids = [pool.men[roundIndex % pool.men.length], pool.men[(roundIndex + 1) % pool.men.length],
    pool.women[roundIndex % pool.women.length], pool.men[(roundIndex + 2) % pool.men.length]];
  return [...new Set(ids)].slice(0, 4).map((userId, index) => ({ userId, placement: index + 1 }));
}

/** 追加赛事的报名名单：已结束的取名次本人，报名中的取 2～6 人 */
function scaledSignupsOf(project, event, results, seed) {
  if (results) return results.map(row => row.userId);
  const pool = RACKET_SCALE_POOLS[project];
  // u01 / u02 是管理员与学院负责人：给它们写报名会改掉别的演示身份的「我报没报」
  const men = pool.men.filter(userId => userId !== 'u01' && userId !== 'u02');
  const count = 2 + (seed % 4);
  return Array.from({ length: count }, (_, index) => men[(seed + index) % men.length]);
}

/** 生成追加比赛：单打为主、每七场一场双打、每五场一场女单 */
function buildScaledMatches(project, count) {
  const pool = RACKET_SCALE_POOLS[project];
  // u12 在基线里是「乒乓 3 场、羽球 3 场」的并列样本，用来演示「并列取注册表
  // 靠前的协会」。追加部分不能再给他加场次，否则并列被打破，那条规则就演示不出来了。
  const frozen = project === 'tt' || project === 'bd' ? new Set(['u12']) : new Set();
  const men = pool.men.filter(userId => !frozen.has(userId));
  const women = pool.women.filter(userId => !frozen.has(userId));
  const tennis = project === 'tn';
  const pointShapes = [
    { a: [11, 11], b: [6, 8] },
    { a: [11, 9, 11], b: [9, 11, 7] },
    { a: [9, 11, 11], b: [11, 6, 9] },
    { a: [12, 11], b: [10, 9] },
    { a: [13, 11], b: [11, 9] },
  ];
  const tennisShapes = [
    { a: [6, 6], b: [3, 4] },
    { a: [6, 4, 6], b: [4, 6, 3] },
  ];
  const shapes = tennis ? tennisShapes : pointShapes;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const shape = shapes[index % shapes.length];
    const rawId = `scale-${project}-m${index + 1}`;
    const ago = 1 + ((index * 3) % 20);
    if (index % 7 === 6) {
      // 双打要凑够四个人：男队不足四人时改用女队（羽球的男队池只有三人）
      const pairPool = men.length >= 4 ? men : women;
      const sides = pairPool.length >= 4
        ? {
          teamA: [pickOf(pairPool, index), pickOf(pairPool, index + 2)],
          teamB: [pickOf(pairPool, index + 1), pickOf(pairPool, index + 3)],
        }
        : { teamA: [pickOf(men, index)], teamB: [pickOf(men, index + 1)] };
      rows.push({
        rawId,
        ...sides,
        scoreA: shape.a, scoreB: shape.b, ago,
        ...(tennis ? { scoring: 'tennis' } : {}),
      });
    } else if (index % 5 === 4) {
      rows.push({
        rawId,
        teamA: [pickOf(women, index)],
        teamB: [pickOf(women, index + 1)],
        scoreA: shape.a, scoreB: shape.b, ago,
        ...(tennis ? { scoring: 'tennis' } : {}),
      });
    } else {
      rows.push({
        rawId,
        teamA: [pickOf(men, index)],
        // 对手错开一位：男队池只有三人时 index+3 会绕回自己
        teamB: [pickOf(men, index + 1)],
        scoreA: shape.a, scoreB: shape.b, ago,
        ...(tennis ? { scoring: 'tennis' } : {}),
      });
    }
  }
  return rows;
}

/** 把一个项目的规格补到 3 倍；北航保持原样（跨校样本不扩容，避免噪声） */
function scaledRacketSpec(spec) {
  const extraEvents = RACKET_SCALE_EVENTS[spec.association];
  if (spec.schoolId !== 'muc' || !extraEvents) return spec;
  const project = spec.association;
  const addedEvents = extraEvents.map((item, index) => {
    const results = scaledResultsOf(project, index, item.finished === true);
    return {
      rawId: `scale-${project}-e${index + 1}`,
      title: item.title,
      startOffsetDays: item.startOffsetDays,
      quota: item.quota,
      signups: scaledSignupsOf(project, item, results, index + 1),
      ...(results ? { results } : {}),
    };
  });
  const targetMatches = spec.matches.length * 3;
  const addedMatches = buildScaledMatches(project, targetMatches - spec.matches.length);
  return {
    ...spec,
    events: [...spec.events, ...addedEvents],
    matches: [...spec.matches, ...addedMatches],
  };
}

/** 网球原先没有演示内容：三场赛事 + 十八场流水，与其他球拍项目同量级 */
function tennisSpec() {
  const project = 'tn';
  const events = RACKET_SCALE_EVENTS.tn.map((item, index) => {
    const results = scaledResultsOf(project, index, item.finished === true);
    return {
      rawId: `scale-tn-e${index + 1}`,
      title: item.title,
      startOffsetDays: item.startOffsetDays,
      quota: item.quota,
      signups: scaledSignupsOf(project, item, results, index + 1),
      ...(results ? { results } : {}),
    };
  });
  return {
    schoolId: 'muc', association: 'tn', venue: RACKET_SCALE_POOLS.tn.venue,
    events, matches: buildScaledMatches(project, 18),
  };
}

/** 手写基线：标题、名次、报名人数都是特定的；追加部分由上面的生成器补到 3 倍。 */
const BASE_DEMO_SPECS = Object.freeze([
  {
    schoolId: 'muc', association: 'pkb', venue: '民大体育馆',
    events: [
      // 报名（signups）：报名中的赛事给 2～6 人，取本范围流水里出现过的会员；
      // 已结束赛事的 signups 必须覆盖 results——名次页与详情页的姓名全靠这条链，
      // 名单为空时构建器只能拿 results 里的编号当昵称显示。
      { rawId: 'open-singles', title: '民大男单公开赛', startOffsetDays: 7, quota: 16,
        signups: ['u03', 'u05', 'u09', 'u10', 'u11'] },
      { rawId: 'spring-cup', title: '民大春季杯男单赛', startOffsetDays: -14, quota: 16,
        signups: ['u03', 'u05', 'u06', 'u07'],
        results: [
          { userId: 'u03', placement: 1 }, { userId: 'u05', placement: 2 },
          { userId: 'u06', placement: 3 }, { userId: 'u07', placement: 4 },
        ] },
      { rawId: 'doubles-challenge', title: '民大匹克球双打挑战赛', startOffsetDays: 14, quota: 24,
        signups: ['u07', 'u11', 'u14', 'u15'] },
    ],
    matches: [
      // 男单：八位会员各打若干场（谁的战绩厚，切身份就看得出）
      { rawId: 'ms-1', teamA: ['u03'], teamB: ['u06'], scoreA: [11, 11], scoreB: [8, 9], ago: 6 },
      { rawId: 'ms-2', teamA: ['u05'], teamB: ['u07'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 6 },
      { rawId: 'ms-3', teamA: ['u01'], teamB: ['u09'], scoreA: [11, 6, 11], scoreB: [9, 11, 7], ago: 5 },
      { rawId: 'ms-4', teamA: ['u03'], teamB: ['u05'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 5 },
      { rawId: 'ms-5', teamA: ['u06'], teamB: ['u07'], scoreA: [11, 11], scoreB: [7, 6], ago: 5 },
      { rawId: 'ms-6', teamA: ['u09'], teamB: ['u10'], scoreA: [11, 9, 13], scoreB: [9, 11, 11], ago: 4 },
      { rawId: 'ms-7', teamA: ['u01'], teamB: ['u11'], scoreA: [11, 11], scoreB: [5, 8], ago: 4 },
      { rawId: 'ms-8', teamA: ['u06'], teamB: ['u10'], scoreA: [12, 11], scoreB: [10, 9], ago: 3 },
      // 女单：三位女会员
      { rawId: 'ws-1', teamA: ['u14'], teamB: ['u15'], scoreA: [11, 11], scoreB: [6, 8], ago: 3 },
      { rawId: 'ws-2', teamA: ['u15'], teamB: ['u16'], scoreA: [11, 9, 11], scoreB: [8, 11, 6], ago: 3 },
      { rawId: 'ws-3', teamA: ['u16'], teamB: ['u24'], scoreA: [11, 7, 11], scoreB: [9, 11, 8], ago: 2 },
      // 双打：三场，男女各半
      { rawId: 'md-1', teamA: ['u03', 'u05'], teamB: ['u06', 'u07'], scoreA: [11, 11], scoreB: [9, 7], ago: 2 },
      { rawId: 'md-2', teamA: ['u01', 'u09'], teamB: ['u10', 'u11'], scoreA: [11, 8, 11], scoreB: [8, 11, 6], ago: 2 },
      { rawId: 'md-3', teamA: ['u14', 'u15'], teamB: ['u16', 'u24'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 1 },
    ],
  },
  {
    schoolId: 'muc', association: 'tt', venue: '民大乒乓球馆',
    events: [
      { rawId: 'tt-points-cup', title: '民大乒乓球单打积分赛', startOffsetDays: 10, quota: 32,
        signups: ['u04', 'u08', 'u12', 'u22', 'u23'] },
      { rawId: 'tt-spring-league', title: '民大乒乓球春季联赛', startOffsetDays: -20, quota: 16,
        signups: ['u04', 'u08', 'u10', 'u11'],
        results: [
          { userId: 'u04', placement: 1 }, { userId: 'u08', placement: 2 },
          { userId: 'u10', placement: 3 }, { userId: 'u11', placement: 4 },
        ] },
    ],
    matches: [
      { rawId: 'tt-ms-1', teamA: ['u04'], teamB: ['u08'], scoreA: [11, 11], scoreB: [7, 9], ago: 7 },
      { rawId: 'tt-ms-2', teamA: ['u10'], teamB: ['u11'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 7 },
      { rawId: 'tt-ms-3', teamA: ['u12'], teamB: ['u13'], scoreA: [11, 11], scoreB: [9, 6], ago: 6 },
      { rawId: 'tt-ms-4', teamA: ['u08'], teamB: ['u12'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 6 },
      { rawId: 'tt-ms-5', teamA: ['u04'], teamB: ['u11'], scoreA: [11, 11], scoreB: [6, 8], ago: 5 },
      { rawId: 'tt-ws-1', teamA: ['u22'], teamB: ['u23'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 5 },
      { rawId: 'tt-md-1', teamA: ['u04', 'u12'], teamB: ['u08', 'u13'], scoreA: [11, 11], scoreB: [9, 8], ago: 4 },
      { rawId: 'tt-md-2', teamA: ['u22', 'u23'], teamB: ['u10', 'u11'], scoreA: [11, 7, 11], scoreB: [7, 11, 9], ago: 3 },
    ],
  },
  {
    schoolId: 'muc', association: 'bd', venue: '民大羽毛球馆',
    events: [
      { rawId: 'bd-doubles-invite', title: '民大羽毛球双打邀请赛', startOffsetDays: 21, quota: 32,
        signups: ['u07', 'u12', 'u19', 'u21'] },
    ],
    matches: [
      { rawId: 'bd-ms-1', teamA: ['u07'], teamB: ['u11'], scoreA: [11, 11], scoreB: [8, 6], ago: 8 },
      { rawId: 'bd-ms-2', teamA: ['u12'], teamB: ['u13'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 8 },
      { rawId: 'bd-ms-3', teamA: ['u07'], teamB: ['u12'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 6 },
      { rawId: 'bd-ws-1', teamA: ['u19'], teamB: ['u21'], scoreA: [11, 11], scoreB: [7, 9], ago: 6 },
      { rawId: 'bd-md-1', teamA: ['u07', 'u11'], teamB: ['u12', 'u13'], scoreA: [11, 11], scoreB: [9, 7], ago: 4 },
      { rawId: 'bd-md-2', teamA: ['u19', 'u21'], teamB: ['u22', 'u23'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 3 },
    ],
  },
  {
    schoolId: 'buaa', association: 'pkb', venue: '北航学院路体育馆',
    events: [
      { rawId: 'buaa-freshman', title: '北航新生杯匹克球赛', startOffsetDays: 9, quota: 32,
        signups: ['demo_buaa_member', 'demo_buaa_member_2', 'demo_buaa_member_3', 'demo_buaa_leader'] },
      { rawId: 'buaa-friendlies', title: '北航院系匹克球友谊赛', startOffsetDays: -12, quota: 16,
        signups: ['demo_buaa_member', 'demo_buaa_member_2', 'demo_buaa_admin', 'demo_buaa_member_3'],
        results: [
          { userId: 'demo_buaa_member', placement: 1 }, { userId: 'demo_buaa_member_2', placement: 2 },
          { userId: 'demo_buaa_admin', placement: 3 }, { userId: 'demo_buaa_member_3', placement: 4 },
        ] },
    ],
    matches: [
      { rawId: 'buaa-ms-1', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_member_2'], scoreA: [11, 11], scoreB: [9, 7], ago: 6 },
      { rawId: 'buaa-ms-2', teamA: ['demo_buaa_admin'], teamB: ['demo_buaa_leader'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 6 },
      { rawId: 'buaa-ms-3', teamA: ['demo_buaa_member_2'], teamB: ['demo_buaa_member_3'], scoreA: [11, 11], scoreB: [6, 8], ago: 5 },
      { rawId: 'buaa-ms-4', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_college_leader'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 5 },
      { rawId: 'buaa-ms-5', teamA: ['demo_buaa_member_2'], teamB: ['demo_buaa_leader'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 4 },
      { rawId: 'buaa-ms-6', teamA: ['demo_buaa_member_3'], teamB: ['demo_buaa_member'], scoreA: [11, 11], scoreB: [9, 7], ago: 3 },
      { rawId: 'buaa-md-1', teamA: ['demo_buaa_member', 'demo_buaa_member_2'], teamB: ['demo_buaa_admin', 'demo_buaa_leader'], scoreA: [11, 11], scoreB: [8, 9], ago: 2 },
      { rawId: 'buaa-md-2', teamA: ['demo_buaa_member_3', 'demo_buaa_college_leader'], teamB: ['demo_buaa_member', 'demo_buaa_member_2'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 1 },
    ],
  },
  {
    schoolId: 'buaa', association: 'tt', venue: '北航沙河校区乒乓球室',
    events: [
      { rawId: 'buaa-tt-cup', title: '北航乒乓球公开赛', startOffsetDays: 15, quota: 24,
        signups: ['demo_buaa_member', 'demo_buaa_leader', 'demo_buaa_admin', 'demo_buaa_member_2'] },
    ],
    matches: [
      { rawId: 'buaa-tt-1', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_leader'], scoreA: [11, 11], scoreB: [8, 6], ago: 7 },
      { rawId: 'buaa-tt-2', teamA: ['demo_buaa_admin'], teamB: ['demo_buaa_member_2'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 5 },
      { rawId: 'buaa-tt-3', teamA: ['demo_buaa_member', 'demo_buaa_admin'], teamB: ['demo_buaa_leader', 'demo_buaa_member_2'], scoreA: [11, 7, 11], scoreB: [7, 11, 9], ago: 2 },
    ],
  },
]);

/** 实际使用的规格：基线 ×3（民大四个球拍项目）+ 网球整套 */
const DEMO_CONTENT_SPECS = Object.freeze([
  ...BASE_DEMO_SPECS.map(scaledRacketSpec),
  tennisSpec(),
]);

/**
 * 演示公告：**按学校一份**。
 *
 * 2026-10-18 起公告只有平台/校级管理员能发，且是全校一个通道——协会维度与
 * 「通知 / 赛事 / 战报」分类都已从界面移除。旧种子按协会各写一份（匹克球 5 条、
 * 乒乓 4 条、羽毛球 3 条），看起来像协会负责人还在发通知，也让「管理台账 5 条、
 * 公开列表 12 条」对不上。这里改成每个学校一份、由该校管理员署名的通知。
 */
const DEMO_SCHOOL_ANNOUNCEMENTS = Object.freeze({
  muc: [
    { rawId: 'muc-registration', title: '第 59 届田径运动会报名开启', content: '报名截止前由各学院部长提交正式名单，逾期不再受理。', category: '通知', pinned: true },
    { rawId: 'muc-court-check', title: '体育馆场地检修通知', content: '本周四 1 号场地面翻新，训练请改用 2、3 号场。', category: '通知', pinned: false },
    { rawId: 'muc-training-plan', title: '秋季学期训练安排', content: '各协会的训练时段已排定，可在协会空间查看具体时间。', category: '通知', pinned: false },
    { rawId: 'muc-team-trial', title: '校队选拔报名开始', content: '面向全校在册学生，选拔分为技术与体能两项。', category: '赛事', pinned: false },
    { rawId: 'muc-injury-talk', title: '运动伤害防护讲座', content: '下周三 19:00 在体育馆会议室，校医院医生主讲。', category: '通知', pinned: false },
  ],
  buaa: [
    { rawId: 'buaa-welcome', title: '北航秋季体育活动月启动', content: '各协会活动安排已发布，欢迎报名参加。', category: '通知', pinned: true },
    { rawId: 'buaa-court-open', title: '学院路体育馆开放时间调整', content: '工作日 18:00–22:00 开放，周末全天开放。', category: '通知', pinned: false },
    { rawId: 'buaa-freshman', title: '新生杯各项赛事报名', content: '各院系限报 4 人，报名请通过学院部长提交。', category: '赛事', pinned: false },
    { rawId: 'buaa-team-notice', title: '校队集训名单公示', content: '名单已在校队公告栏公示，请入选同学按时参加集训。', category: '通知', pinned: false },
  ],
});

function demoAnnouncementDocs(schoolId, now) {
  // 公告只有管理员能发、且是**学校级**的一条通道：演示种子按学校各一份，
  // 不再按协会分桶。协会字段仍写当前默认协会，仅作溯源（读取只看学校）。
  const scope = { schoolId, association: DEMO_CONTENT_SCOPE.association };
  const at = iso(now);
  const publisher = CONTENT_PUBLISHERS[schoolId] || CONTENT_PUBLISHERS.muc;
  return (DEMO_SCHOOL_ANNOUNCEMENTS[schoolId] || []).map(({ rawId, ...form }) => {
    const withCategory = { ...form, category: form.category || ANNOUNCEMENT_CATEGORIES[0] };
    return {
      ...builtRecordOf(buildAnnouncementRecord(withCategory, { actor: publisher, now }), '公告'),
      _id: schoolAnnouncementKey(rawId, scope),
      schoolId, association: scope.association,
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      publishTime: at,
      fingerprint: JSON.stringify([withCategory.title, withCategory.content, withCategory.category, Boolean(withCategory.pinned)]),
      revision: 1,
      updatedAt: at,
    };
  });
}

/**
 * 一场演示赛事的报名名单规格。
 *
 * 【为什么没有报名记录也要能造赛事】
 * 历史规格缺 `signups` 时按「没人报名」处理，赛事本身照常成立——报名记录是
 * 另一张表，不该反过来把赛事卡住。
 */
const signupsOf = item => (Array.isArray(item.signups) ? item.signups : []);

/** 某范围的个人赛事：一条报名中、按规格可带已结束（含名次）的。 */
function demoEventDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  const at = iso(now);
  const publisher = CONTENT_PUBLISHERS[spec.schoolId] || CONTENT_PUBLISHERS.muc;
  const base = {
    description: '协会常规个人赛', matchType: MATCH_TYPE.SINGLES, level: EVENT_LEVEL.THIRD,
    format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
    courtCount: 2, location: spec.venue,
  };
  return spec.events.map((item) => {
    const form = {
      ...base, title: item.title, quota: item.quota || 16,
      startTime: new Date(now.getTime() + item.startOffsetDays * DAY_MS),
    };
    const extra = item.results
      ? { status: EVENT_STATUS.FINISHED, finishedAt: at, results: item.results }
      : {};
    const record = {
      ...builtRecordOf(buildEventRecord(form, { actor: publisher, now }), '赛事'), ...extra,
    };
    return {
      ...record,
      _id: schoolEventKey(item.rawId, scope),
      schoolId: scope.schoolId, association: scope.association,
      startTime: iso(record.startTime),
      publishTime: iso(record.publishTime),
      pinned: Boolean(item.pinned),
      // 人数与报名记录同源：写死 0 会让列表出现「四个名次、0 人」这种自相矛盾的画面，
      // 而读端一旦在台账里找到本场报名就只认台账，主记录上的计数只是个影子。
      signupCount: signupsOf(item).length,
      fingerprint: JSON.stringify([record.title, record.matchType, record.level, record.startTime]),
      revision: 1, updatedAt: at,
    };
  });
}

/**
 * 某范围的报名记录：逐条对应赛事规格里的 `signups`。
 *
 * 【为什么必须有这张表（2026-10-16 用户实测）】
 * 详情页 / 名次页的姓名走「报名名单 → 会员档案」这条链：名单为空时，名次行
 * 取不到档案，只能把 `results` 里的 userId 当昵称显示——用户看到的「名次里
 * 全是 u03 / u05」正是这一步回退。所以**已结束赛事的报名记录与名次同源**：
 * results 里出现的每个人，规格的 signups 里都必须有，人数也应等于名次人数。
 *
 * 【为什么一律落「已报名」】
 * 签到是赛事当天的动作（进行中的赛事才让代签），种子里预置签到态会让
 * 「谁能替谁签到」的演示失去可操作的对象；因此 checkInTime 一律为 null。
 *
 * 【时间为什么钉在锚点上】
 * 与公告 / 赛事 / 比赛同一条纪律：只从 DEMO_CONTENT_NOW 加固定偏移取时间，
 * 不用 Date.now()，同一份种子每次 reset 得到一模一样的记录。报名时间一律排在
 * 开赛之前（已结束的赛事排在开赛日之前，报名中的赛事排在锚点当日之前）。
 */
function demoSignupDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  return spec.events.flatMap((item) => {
    const eventId = schoolEventKey(item.rawId, scope);
    // 开赛在锚点之后的（报名中），报到锚点当天为止；已结束的报到开赛日为止。
    const latest = Math.min(now.getTime() + item.startOffsetDays * DAY_MS, now.getTime());
    const rows = signupsOf(item);
    return rows.map((userId, index) => ({
      _id: schoolEventSignupKey(eventId, userId, scope),
      schoolId: scope.schoolId, association: scope.association,
      eventId, userId,
      status: SIGNUP_STATUS.SIGNED,
      // 按规格顺序由早到晚排：名单读出来与名次表同序（第一个人在名次里也排在最前）。
      signTime: iso(new Date(latest - (rows.length - index) * DAY_MS)),
      checkInTime: null, actorId: userId, cancelTime: null, revision: 1,
    }));
  });
}

/**
 * 某范围的比赛流水：单打 / 双打混排，分给不同演示账号。
 * 谁的战绩厚、等级分高，切演示身份进个人页与榜单就看得出。
 *
 * 【Elo 逐场结算改造后：种子比赛经**同一个纯结算内核**逐场结算】
 * 读取端不再回放流水，演示种子里的已生效比赛必须自带评级与结算快照——
 * 否则榜单 / 个人页全是空态。这里按比赛发生时间升序（即演示里的「确认顺序」）
 * 逐场调用 materializeRatings + computeSettlement（与线上确认路径同一份纯函数），
 * 评级文档随种子一并产出（content.memberRatings），结算快照直接附在比赛上。
 * 起评分按性别取（男 1450 / 女 1300），与管理预设 initialElo 无关——演示账号
 * 不走审核入口。
 */
function demoGenderOf(userId) {
  const account = DEMO_ACCOUNT_BY_ID.get(userId);
  if (account) return account.gender;
  // 旧版演示会员按编号对应 MEMBER_SEED 的下标（u01 → 第 1 条），
  // 与 school-mock 的 attachLegacyMembers 同一套映射。
  const matched = /^u(\d+)$/.exec(String(userId || ''));
  if (!matched) return undefined;
  const row = MEMBER_SEED[Number(matched[1]) - 1];
  return row ? row.gender : undefined;
}

/**
 * 结算一批演示比赛（同一范围）。
 * @param {Array<Object>} docs 已组装的比赛文档（原地附 settlement）
 * @param {Object} scope { schoolId, association }
 * @param {Map} settleState 范围级结算状态：scopeKey -> { seq, ratings: Map }
 * @param {Map} ratingAccumulator 全部演示范围的评级文档汇总（键 = ratingKey）
 */
function settleDemoMatchDocs(docs, scope, settleState, ratingAccumulator) {
  const stateKey = `${scope.schoolId}|${scope.association}`;
  const state = settleState.get(stateKey) || { seq: 0, ratings: new Map() };
  settleState.set(stateKey, state);
  const chronological = [...docs]
    .sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime)
      || (String(a._id) < String(b._id) ? -1 : 1));
  for (const doc of chronological) {
    if (doc.status !== MATCH_STATUS.ACTIVE || doc.outcome !== MATCH_OUTCOME.NORMAL) continue;
    state.seq += 1;
    const userIds = [...new Set([...doc.teamA, ...doc.teamB])];
    const existingByUser = new Map();
    const startEloByUser = new Map();
    for (const userId of userIds) {
      const key = memberRatingKey(userId, doc.pool, scope);
      const current = state.ratings.get(key) || ratingAccumulator.get(key) || null;
      if (current) existingByUser.set(userId, current);
      else startEloByUser.set(userId, { gender: demoGenderOf(userId) });
    }
    const view = materializeRatings({
      userIds, pool: doc.pool, scope, existingByUser, startEloByUser, now: doc.matchTime,
    });
    const { settlement, ratingDocs } = computeSettlement({
      match: doc, eventLevel: undefined, ratingsByUser: view, seq: state.seq,
      settledAt: doc.matchTime,
    });
    doc.settlement = settlement;
    for (const { doc: ratingDoc } of ratingDocs) {
      state.ratings.set(ratingDoc._id, ratingDoc);
      ratingAccumulator.set(ratingDoc._id, ratingDoc);
    }
  }
}

function demoMatchDocs(spec, now, settleState, ratingAccumulator) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  const at = iso(now);
  const docs = spec.matches.map((item) => {
    const matchTime = new Date(now.getTime() - item.ago * DAY_MS);
    // 网球是三层赛制（盘 / 局 / 抢七），其余项目是「每局几分」；种子按项目给对形状，
    // 否则网球历史记录会被读成 11:9 的乒乓球比分。
    const format = item.scoring === 'tennis'
      ? { scoring: 'tennis', setGames: 6, bestOf: 3, tiebreakAt: 6, tiebreakPoints: 7, noAd: true }
      : { gamePoints: 11, bestOf: 3 };
    const record = builtRecordOf(buildMatchRecord({
      matchType: item.teamA.length === 2 ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES,
      teamA: item.teamA, teamB: item.teamB, scoreA: item.scoreA, scoreB: item.scoreB,
      ...format, matchTime, location: spec.venue, recorder: item.teamA[0],
    }), '比赛');
    return {
      ...record,
      _id: schoolMatchKey(item.rawId, scope),
      schoolId: scope.schoolId, association: scope.association,
      competition: MATCH_COMPETITION.PERSONAL, status: MATCH_STATUS.ACTIVE, outcome: MATCH_OUTCOME.NORMAL,
      matchTime: iso(matchTime),
      action: 'seed', actor: 'demo-seed', actedAt: at, revision: 1,
    };
  });
  settleDemoMatchDocs(docs, scope, settleState, ratingAccumulator);
  return docs;
}

/* ============================================================
 * 跨校邀请赛演示（2026-10-16）：一进页面就有赛事可看、可操作
 * ============================================================
 * 【为什么要预置】
 * 邀请赛原先只能靠演示者自己「创建 → 邀请 → 报名 → 锁定 → 抽签」把整条链
 * 摆一遍，页面初始永远是空的。这里直接落两场，覆盖两个最有代表性的状态：
 *   · 报名中（单败淘汰）：两校各一人已报名，可演报名 / 取消 / 移出 /
 *     撤回邀请 / 锁定名单；
 *   · 已抽签（小组赛+淘汰）：四人小组赛已排期，可演录分 → 淘汰赛出来 →
 *     录分 → 确认名次，顺带把新加的赛制也演示到。
 *
 * 【开赛时间为什么钉在 2030】
 * 报名与锁定都拿**真实当前时间**与 startTime 比大小（见 changeSignup 与
 * lockExchangeRoster 的入口条件）。种子统一的时间锚点 DEMO_CONTENT_NOW 是
 * 2026-03-01，照它加偏移得到的开赛时间早就过期，报名一定被拒。所以这两场
 * 用固定但远在未来（2030）的开赛时间：既让报名走得通，又仍是常量而不是
 * Date.now()——同一份种子每次 reset 结果完全一致。
 *
 * 【对阵为什么现算而不是手写】
 * draw 与 matches 调 exchange-plan 的 planExchangeDraw / planExchangeMatches
 * 现算（两个都是纯函数），与云端 drawExchangeEvent 走同一段代码。手写签表
 * 迟早与引擎分叉，而演示数据一旦分叉最误导人。
 * ============================================================ */

/** 演示邀请赛的开赛时间：固定常量，且远在任何可预见的「当前时间」之后 */
const EXCHANGE_DEMO_START = '2030-03-01T10:00:00Z';
const EXCHANGE_DEMO_START_LATER = '2030-03-08T10:00:00Z';
/** 演示签表的随机种子：固定值，签位每次 reset 完全一样 */
const DEMO_EXCHANGE_SEED = 20261016;

/** 参赛者一律取已在册的演示账号，读端才按昵称显示得出人 */
const EXCHANGE_DEMO_ENTRANTS = Object.freeze({
  open: Object.freeze([
    Object.freeze({ userId: 'demo_muc_member', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_buaa_member', schoolId: 'buaa' }),
  ]),
  drawn: Object.freeze([
    Object.freeze({ userId: 'demo_muc_admin', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_muc_member_2', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_buaa_member', schoolId: 'buaa' }),
    Object.freeze({ userId: 'demo_buaa_member_2', schoolId: 'buaa' }),
  ]),
});

const DEMO_ACCOUNT_BY_ID = new Map(DEMO_ACCOUNTS.map(account => [account.id, account]));

/** 两场演示邀请赛的赛事 / 邀请索引 / 报名 / 对阵四张表 */
function demoExchangeDocs(now, schoolNames) {
  const at = iso(now);
  const participantSchoolIds = ['buaa', 'muc'];
  const base = {
    schoolId: 'muc', association: 'pkb', participantSchoolIds, schoolNames,
    quota: 4, schoolQuotas: { buaa: 2, muc: 2 },
    eventScope: 'inter_school', ratingPolicy: 'unrated', matchType: 'singles',
    createdBy: 'demo_muc_admin', createdAt: at,
  };
  const events = [];
  const invitations = [];
  const signups = [];
  const matches = [];
  // 邀请索引与报名记录的键、字段都照 exchange-service 的写入原样复刻，
  // 少一个字段读端就会当它不存在（例如报名少了 nickName，对阵里只剩编号）。
  const invitationOf = (eventId, schoolId) => ({ _id: schoolKey('xi', eventId, schoolId),
    eventId, schoolId, association: 'pkb' });
  const signupOf = (event, entrant) => {
    const account = DEMO_ACCOUNT_BY_ID.get(entrant.userId) || {};
    return { _id: schoolKey('xs', event._id, entrant.userId),
      eventId: event._id, schoolId: event.schoolId, association: 'pkb',
      userId: entrant.userId, representedSchoolId: entrant.schoolId,
      schoolMemberId: schoolMemberKey(entrant.userId, entrant.schoolId),
      nickName: account.nickName || entrant.userId,
      schoolName: schoolNames[entrant.schoolId] || entrant.schoolId,
      status: 'signed', updatedAt: at, revision: 1 };
  };

  // 1) 报名中：两校各一人，等齐了就能锁定名单
  const openId = schoolKey('xe', 'muc', 'pkb', 'demo-seed', 'invite-open');
  const openEvent = { ...base, _id: openId, title: '民大北航匹克球交流赛（报名中）',
    location: '民大体育馆', startTime: EXCHANGE_DEMO_START, status: 'signup',
    invitations: { buaa: 'accepted', muc: 'accepted' },
    schoolCounts: { buaa: 1, muc: 1 }, signupCount: 2,
    format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: EVENT_BRONZE_MODE.TIED,
    placementMode: EVENT_PLACEMENT_MODE.NONE, gfReset: DEFAULT_GF_RESET,
    fingerprint: JSON.stringify([openId]), revision: 1 };
  events.push(openEvent);
  for (const schoolId of participantSchoolIds) invitations.push(invitationOf(openId, schoolId));
  for (const entrant of EXCHANGE_DEMO_ENTRANTS.open) signups.push(signupOf(openEvent, entrant));

  // 2) 已抽签：小组赛 + 淘汰。签表与对阵由赛制引擎现算，与云端抽签同一段代码
  const drawnId = schoolKey('xe', 'muc', 'pkb', 'demo-seed', 'invite-drawn');
  const entrants = EXCHANGE_DEMO_ENTRANTS.drawn;
  const drawnEvent = { ...base, _id: drawnId, title: '民大北航匹克球邀请赛（已抽签）',
    location: '民大体育馆', startTime: EXCHANGE_DEMO_START_LATER, status: 'drawn',
    invitations: { buaa: 'accepted', muc: 'accepted' },
    schoolCounts: { buaa: 2, muc: 2 }, signupCount: entrants.length,
    format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2, advancePerGroup: 1,
    bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.NONE,
    gfReset: DEFAULT_GF_RESET, fingerprint: JSON.stringify([drawnId]), revision: 2 };
  const planned = planExchangeDraw({ entries: entrants.map(row => ({ userId: row.userId })),
    seedValue: DEMO_EXCHANGE_SEED, format: drawnEvent.format,
    groupCount: drawnEvent.groupCount, advancePerGroup: drawnEvent.advancePerGroup });
  if (!planned.ok) throw new Error(`演示邀请赛签表构造失败：${planned.message}`);
  drawnEvent.draw = { ...planned.draw, createdAt: at, createdBy: 'demo_muc_admin' };
  const entrantsById = new Map(entrants.map(row => [row.userId,
    { userId: row.userId, schoolId: row.schoolId }]));
  const built = planExchangeMatches({ event: drawnEvent, draw: drawnEvent.draw, entrantsById, matches: [] });
  for (const match of built.matches) {
    matches.push({ ...match, schoolId: drawnEvent.schoolId, association: drawnEvent.association });
  }
  events.push(drawnEvent);
  for (const schoolId of participantSchoolIds) invitations.push(invitationOf(drawnId, schoolId));
  for (const entrant of entrants) signups.push(signupOf(drawnEvent, entrant));
  // 名册快照：已锁定（这里表现为「已抽签」）的赛事，参赛者只认这份名册。
  // 演示数据不带上它，详情页的参赛者一栏会是空的。
  drawnEvent.roster = signups
    .filter(row => row.eventId === drawnId)
    .map(row => ({
      userId: row.userId,
      representedSchoolId: row.representedSchoolId,
      schoolId: row.representedSchoolId,
      schoolMemberId: row.schoolMemberId,
      nickName: row.nickName,
      schoolName: row.schoolName,
    }));
  drawnEvent.checkIns = {};

  return { events, invitations, signups, matches };
}

/**
 * 转校演示：预置一条「已提交、待转入学校审批」的转校申请。
 *
 * 【为什么需要一个专属账号】
 * 「提交转校申请」与「审批转校申请」是两条不同的演示路径，共用一个账号就只能
 * 二选一：申请一旦提交，那个账号再点进去看到的是「已提交，等待审核」，演示
 * 「当场提交一份申请」就无从下手。于是分成两位民大会员：
 *   · demo_muc_member    —— 干净的会员，用来当场演示提交转校申请；
 *   · demo_muc_member_2  —— 本函数预置了一条待北航审批的申请。
 * 申请只落在北航那一侧（schoolId: 'buaa'），账号归属仍在民大，与
 * applySchoolTransfer 的落库形状一致，因此北航管理员一进「学校身份」就能审。
 */
function demoTransferApplication(now) {
  return {
    ...buildSchoolApplication({
      userId: 'demo_muc_member_2',
      school: { schoolId: 'buaa', status: 'active', name: '北京航空航天大学' },
      college: { collegeId: 'c01', schoolId: 'buaa', status: 'active', name: '航空学院（模拟）' },
      studentId: 'TEST007', now,
    }),
    transferFrom: 'muc', revision: 1,
  };
}

/**
 * 全部演示内容：旧栈的公告 / 赛事 / 比赛 / 报名四批之外，再挂跨校邀请赛
 * （赛事 / 邀请索引 / 报名 / 对阵四表）与一条待审转校申请。
 * 由 school-mock.reset() 默认挂进内存仓储，供协会空间、排行榜、学校身份与
 * 跨校邀请赛四处演示。
 *
 * 【为什么报名记录由本函数一起产出】
 * 报名要与赛事同一次 reset 落库：分成两处造，早晚出现「赛事在、名单不在」的
 * 半截演示（名次里全是编号）。school-mock.reset() 按 content 的键名整批挂表，
 * 新增 exchangeEvents / schoolMembers 等键不需要它改一行代码。
 *
 * @param {Object} [options]
 * @param {Date|string|number} [options.now] 时间锚点，缺省取「当天 09:00」
 *   （见 demoContentNow）。需要绝对固定日期的用例显式传它。
 * @returns {{announcements: Array<Object>, events: Array<Object>, matches: Array<Object>,
 *   eventSignups: Array<Object>, exchangeEvents: Array<Object>,
 *   exchangeInvitations: Array<Object>, exchangeSignups: Array<Object>,
 *   exchangeMatches: Array<Object>, schoolMembers: Array<Object>}}
 */
function createSchoolDemoContent(options = {}) {
  const now = options.now ? new Date(options.now) : demoContentNow();
  const content = { announcements: [], events: [], matches: [], eventSignups: [] };
  // 结算状态与评级文档在一次内容构建内累积：同范围的比赛共享一条结算链
  // （settlementSeq 连续），跨范围各持一份；评级文档随 content.memberRatings
  // 一起落种子，读取端「评级落库」因此对演示数据同样成立。
  const settleState = new Map();
  const ratingAccumulator = new Map();
  for (const schoolId of distinctSchoolsOf(DEMO_CONTENT_SPECS)) {
    content.announcements.push(...demoAnnouncementDocs(schoolId, now));
  }
  for (const spec of DEMO_CONTENT_SPECS) {
    content.events.push(...demoEventDocs(spec, now));
    content.matches.push(...demoMatchDocs(spec, now, settleState, ratingAccumulator));
    content.eventSignups.push(...demoSignupDocs(spec, now));
  }
  content.memberRatings = [...ratingAccumulator.values()];
  const schoolNames = Object.fromEntries(createSchoolSeed().schools.map(row => [row._id, row.name]));
  const exchange = demoExchangeDocs(now, schoolNames);
  content.exchangeEvents = exchange.events;
  content.exchangeInvitations = exchange.invitations;
  content.exchangeSignups = exchange.signups;
  content.exchangeMatches = exchange.matches;
  // 待审转校申请挂在 schoolMembers 上（与真实落库同一张表），reset() 会追加到已有会员之后
  content.schoolMembers = [demoTransferApplication(now)];
  // 团队运动（篮球）的演示内容：一支打完的淘汰赛 + 一支报名中的赛事。
  // 只造民大篮球——切到别的协会仍是空态，才看得出「这个协会没有球队」。
  Object.assign(content, createTeamDemoContent());
  // 足球各集合追加，不能覆盖既有篮球球队/报名/角色。
  for (const [key, rows] of Object.entries(createFootballDemoContent())) {
    content[key] = [...(content[key] || []), ...rows];
  }
  // 石榴籽杯：每项目两届历史 + 匹克球 / 篮球各一届进行中（球拍走学院赛，团队走学院赛制的团队赛事）
  for (const [key, rows] of Object.entries(createCollegeCupContent())) {
    content[key] = [...(content[key] || []), ...rows];
  }
  return content;
}

module.exports = { createSchoolSeed, createSchoolDemoSeed, createSchoolDemoContent, DEMO_ACCOUNTS, DEMO_CONTENT_SPECS };
