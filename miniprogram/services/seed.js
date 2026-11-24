/**
 * 模拟数据种子生成器
 * ============================================================
 * 【核心思路：隐藏实力 + 胜负模拟】
 *
 * 不直接给每个人编一个等级分，而是：
 *   1. 先给每人一个「隐藏真实水平」（trueSkill），对外不展示
 *   2. 用真实水平之差算出各自的胜率，据此模拟比赛胜负
 *   3. 再用 ELO 算法从零开始逐场回放，让等级分自动「长出来」
 *
 * 这样做的价值：
 *   - 生成的等级分是真实的比赛结果推出来的，不是手编的，数据自洽
 *   - 可以反过来检验算法：等级分应当收敛到接近真实水平
 *   - 回放引擎与将来云端的计分逻辑是同一套，等于提前验证了生产代码
 *
 * 所有随机都走固定种子，保证每次生成的数据完全一致。
 * ============================================================
 */

const { createSeededRandom, randomInt, pick, shuffle } = require('../shared/utils/random.js');
// 标准种子排位表搬到工具层，正式抽签与这里的模拟数据共用同一份
const { standardSeedOrder } = require('../shared/utils/bracket.js');
// 比赛的确定性编号（轮次 + 阶段 + 签位）也只有一份，演示赛事的签表
// 必须与正式抽签用同一个键，否则「逐轮推进」会把它当成没排过而重复生成
const { eventMatchKey } = require('../shared/services/draw.js');
const {
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  MATCH_STATUS,
  MATCH_TYPE_TO_POOL,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  SIGNUP_STATUS,
  LEG_DISCIPLINE,
  ROLE,
} = require('../shared/utils/constants.js');
const { DEFAULT_FORMAT, gamesToWin } = require('../shared/utils/match-format.js');
// 场号必须用与正式抽签完全相同的分配函数算出来，不能在种子里手写：
// 手写的场号一旦与 planCourts 的算法分叉，界面上的「场地分配」表就会
// 与签表里的场号对不上，而这种不一致光看数据是看不出来的
const { withCourts } = require('../shared/services/court.js');

/** 默认随机种子。换一个数字就能得到一整套完全不同的模拟数据。 */
const DEFAULT_SEED = 20260901;

/** 数据起始日期（周一） */
const DEFAULT_START_DATE = '2026-04-06';

/**
 * 日常约球的赛制分布。
 *
 * 以 11 分制三局两胜为主——这是俱乐部最常用的打法；场地紧张时打一局
 * 定胜负，偶尔也换 15 分制。重复出现的项即代表出现频次更高。
 */
const CASUAL_FORMATS = [
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 1 },
  { gamePoints: 15, bestOf: 3 },
];

/** 常去的几个场地 */
const VENUES = [
  '学校体育馆 1 号场',
  '学校体育馆 2 号场',
  '学校体育馆 3 号场',
  '校门外匹克球场',
  '大学生活动中心',
];

/**
 * 公告种子数据。
 * ============================================================
 * week 表示第几周发布，与赛事安排对齐：赛前发报名通知，赛后发战报。
 * pinned 的公告在首页置顶——招新、规则变更这类信息必须让所有人看到，
 * 沉在列表里等于没发。
 *
 * 【为什么不写死日期】
 * 与赛事标题同理：发布日期由 baseDate 与 week 推导，改了起始日期，
 * 公告时间会自动跟着走，不会出现「公告日期在赛季开始之前」这种矛盾。
 * ============================================================
 */
const ANNOUNCEMENT_SEED = [
  {
    week: 0,
    category: '通知',
    pinned: true,
    title: '2026 春季学期开训通知',
    content:
      '本周起每周三、周五 18:00 在体育馆 1 号场常规训练，新老会员均可参加。请自备球拍，活动用球由俱乐部提供。',
  },
  {
    week: 3,
    category: '赛事',
    pinned: false,
    title: '男子单打赛报名开始',
    content:
      '本周六举行本赛季首场男子单打赛，11 分制三局两胜，取前八名。请在小程序内报名，名额有限。',
  },
  {
    week: 5,
    category: '赛事',
    pinned: false,
    title: '女子单打赛报名开始',
    content: '本周六举行女子单打赛，15 分制三局两胜。欢迎各位女会员踊跃参加。',
  },
  {
    week: 8,
    category: '战报',
    pinned: false,
    title: '首场单打赛战报',
    content:
      '男子、女子单打赛已结束，完整名次与分数变动已录入小程序「排行榜」，可在个人主页查看自己的逐场战绩。',
  },
  {
    week: 12,
    category: '通知',
    pinned: false,
    title: '等级分计算规则说明',
    content:
      '等级分采用 ELO 算法，单打与双打各自独立计分，互不影响。每场分数变动只取决于对手强弱：战胜强手加分多，负于弱手失分多。',
  },
  {
    week: 16,
    category: '战报',
    pinned: false,
    title: '双打赛战报',
    content:
      '双打赛不区分性别，男双、女双、混双同池竞技。本场名次已更新，双打分数与单打完全独立。',
  },
];

/**
 * 生成公告列表。
 *
 * @param {Date} baseDate 赛季起始时刻
 * @param {Array<Object>} [items] 公告种子，缺省用 ANNOUNCEMENT_SEED。
 *        各协会可用自己的一套（由调用方传入）。
 * @returns {Array<Object>} 按发布时间倒序（最新的在前）
 */
function buildAnnouncements(baseDate, items = ANNOUNCEMENT_SEED) {
  return items.map((item, index) => {
    const publishTime = addDays(baseDate, item.week * 7);
    // 公告在中午发布，与晚上的比赛时间错开，时间线上不会挤在一起
    publishTime.setHours(12, 0, 0, 0);
    return {
      _id: 'a' + String(index + 1).padStart(2, '0'),
      title: item.title,
      content: item.content,
      category: item.category,
      pinned: item.pinned,
      publishTime,
    };
  }).sort((a, b) => b.publishTime - a.publishTime);
}

/**
 * 会员种子数据。
 * trueSkill 是隐藏的真实水平，仅用于模拟比赛结果，不对外展示。
 * 数值参考业余匹克球爱好者的大致分布：新手 1100 上下，高手 1700 上下。
 *
 * 【nickName 与 realName 的分工】
 * realName 是注册时登记的实名，nickName 是展示用的昵称。界面上昵称在
 * 前、真名小一号缀在旁边（见 templates/member-view.wxml）。校园社团里
 * 昵称多半就是名字本身或名字的后两字，所以这里：
 *   三字姓名 → 昵称取后两字（张宇轩 → 宇轩）
 *   两字姓名 → 昵称与真名相同，头卡上不重复显示
 * 这样既演示了「昵称 + 真名」的展示，又不会被硬凑出来的花名弄得失真。
 *
 * 【男女之间为什么刻意留出差距】
 * 男女单打合并成一个池之后，男女分数可以直接比较，这时候如果两组人的
 * 真实水平完全一样，实验就观察不到任何差异，「合并计算会不会埋没女生」
 * 这类问题也无从回答。因此这里按真实校园社团的普遍情况设定：
 *   男队：均值约 1470，最高 1690
 *   女队：均值约 1300，最高 1500
 * 整体差距约 170 分，落在 150~200 分的预期区间内。这个差距只体现在
 * 隐藏的 trueSkill 上，等级分仍然要靠回放自己长出来。
 *
 * 【role 为什么不再是清一色的普通会员】
 * 权限判定只看角色（见 permission.canManage），种子里必须真的有学院负责人与
 * 管理员，否则本地演示里审核、发公告、发布赛事、赛季重置这些入口会
 * 一并消失，链路根本走不通。这里正好对应俱乐部的实际分工：
 *   巴特尔（u01）—— 会长，管得了全部
 *   张宇轩（u02）—— 学院负责人，权限以学院为界：本院代签到、本院名单与排阵
 * 学院负责人不是「小号管理员」：公告、入会审核、发布赛事、赛季重置这些俱乐部
 * 全局的「定盘子」事务都归管理员（见 permission.js 顶部注释）。本地要演示
 * 它们得切到 u01；切到 u02 只看得见签到与学院赛那几处。
 * 其余人 role 缺省为普通会员，界面不会给他们显示任何管理入口。
 */
const MEMBER_SEED = [
  { nickName: '巴特尔', realName: '巴特尔', gender: 'M', college: '体育学院', trueSkill: 1690, role: ROLE.ADMIN },
  { nickName: '宇轩', realName: '张宇轩', gender: 'M', college: '信息工程学院', trueSkill: 1655, role: ROLE.STAFF },
  { nickName: '思远', realName: '李思远', gender: 'M', college: '经济学院', trueSkill: 1620 },
  { nickName: '浩然', realName: '王浩然', gender: 'M', college: '管理学院', trueSkill: 1585 },
  { nickName: '子涵', realName: '刘子涵', gender: 'M', college: '理学院', trueSkill: 1550 },
  { nickName: '明宇', realName: '赵明宇', gender: 'M', college: '法学院', trueSkill: 1510 },
  { nickName: '俊杰', realName: '吴俊杰', gender: 'M', college: '历史文化学院', trueSkill: 1475 },
  { nickName: '凯文', realName: '郑凯文', gender: 'M', college: '信息工程学院', trueSkill: 1440 },
  { nickName: '伟豪', realName: '黄伟豪', gender: 'M', college: '生命与环境科学学院', trueSkill: 1405 },
  { nickName: '小龙', realName: '马小龙', gender: 'M', college: '民族学与社会学学院', trueSkill: 1365 },
  { nickName: '志强', realName: '高志强', gender: 'M', college: '体育学院', trueSkill: 1320 },
  { nickName: '天磊', realName: '谢天磊', gender: 'M', college: '教育学院', trueSkill: 1280 },
  { nickName: '曹阳', realName: '曹阳', gender: 'M', college: '外国语学院', trueSkill: 1235 },
  { nickName: '卓玛', realName: '卓玛', gender: 'F', college: '中国少数民族语言文学学院', trueSkill: 1500 },
  { nickName: '陈曦', realName: '陈曦', gender: 'F', college: '美术学院', trueSkill: 1455 },
  { nickName: '阿依古丽', realName: '阿依古丽·买买提', gender: 'F', college: '音乐学院', trueSkill: 1425 },
  { nickName: '雨桐', realName: '周雨桐', gender: 'F', college: '经济学院', trueSkill: 1385 },
  { nickName: '孙悦', realName: '孙悦', gender: 'F', college: '法学院', trueSkill: 1350 },
  { nickName: '林清', realName: '林清', gender: 'F', college: '哲学与宗教学院', trueSkill: 1300 },
  { nickName: '梦琪', realName: '徐梦琪', gender: 'F', college: '管理学院', trueSkill: 1255 },
  { nickName: '静怡', realName: '何静怡', gender: 'F', college: '教育学院', trueSkill: 1225 },
  // 以下会员在中途加入俱乐部。
  // 他们的初始分不走固定值，而是按「入会后前五场对手的水平」定出来，
  // 这样进步榜才有真实意义：可以衡量他们入会之后的涨分幅度。
  { nickName: '雨欣', realName: '罗雨欣', gender: 'F', college: '外国语学院', trueSkill: 1180, joinWeek: 5 },
  { nickName: '韩雪', realName: '韩雪', gender: 'F', college: '历史文化学院', trueSkill: 1140, joinWeek: 5 },
  { nickName: '紫琳', realName: '邓紫琳', gender: 'F', college: '民族学与社会学学院', trueSkill: 1085, joinWeek: 10 },
];

/**
 * 演示用的「按协会的角色」登记表。
 * ============================================================
 * 【为什么需要它】
 * MEMBER_SEED 是一份**全局名单**：它只声明「账号本身」的角色，装不下
 * 「一人在不同协会担任不同身份」这件事。而协会角色（学院负责人 / 协会
 * 负责人）本就是「某人在某协会里」的身份——同一个人可以在匹克球当协会
 * 负责人、在乒乓球只是普通会员。这张表把演示账号在各协会的身份补齐，
 * 由本地模拟数据在装配每个协会的会员名单时按协会盖上（见 mock.js 的
 * ASSOC_ROLE_SEED 用法与 patchAccount）。
 *
 * 【结构】association id → { 会员编号: ROLE }
 *   取值见 constants.ROLE：ADMIN = 协会负责人，STAFF = 学院负责人。
 *   未登记的协会 / 会员落回 MEMBER_SEED 里的角色或普通会员。
 *
 * 【与 MEMBER_SEED 里 u01 / u02 的分工】
 *   · u01 巴特尔的 ADMIN 是**全局管理员**（写在账号上），在每个协会都是
 *     管理员，本表不再登记。
 *   · u02 张宇轩的 STAFF 只在默认协会（pkb）成立，由 mock.js 的
 *     scopeSeedRoles 负责，本表也不重复登记。
 *
 * 【演示账号一览】（编号 → 身份，详见 docs/mock演示账号.md）
 *   u01 巴特尔  全局管理员（各协会皆是）
 *   u04 王浩然  tt 协会负责人 + bd 学院负责人  —— 本协会负责人 + 另一协会学院负责人
 *   u05 刘子涵  pkb 学院负责人
 *   u06 赵明宇  普通会员（默认登录种子）
 *   u07 吴俊杰  bd 协会负责人
 *   u08 郑凯文  tt 学院负责人
 *   u09 黄伟豪  pkb 协会负责人                —— 本协会负责人
 *   u10 马小龙  pkb + tt 学院负责人            —— 两个协会的学院负责人
 *   u11 高志强  bd 学院负责人
 * 另：u02 张宇轩的 pkb 学院负责人身份见 MEMBER_SEED（只在默认协会成立）。
 *
 * 【为什么 pkb 的角色落在 u05 / u09 / u10】
 * 端到端测试在默认协会（pkb）里挑「经济学院 / 管理学院」等学院的普通会员
 * 当无权限夹具（见 tests/referee.test.js）。若把 pkb 的负责人落在这些学院
 * 的种子会员头上，夹具里的人会突然变成管理员，令「普通会员录不了分」这类
 * 断言失真。故 pkb 的角色一律取「理学院 / 生命与环境科学学院 / 民族学与
 * 社会学学院」这几位不在夹具里的会员。tt / bd 的角色只在切到那两个协会时
 * 才显形，不参与默认协会的用例，落在谁头上都无妨。
 *
 * 【注意】每个「人 × 协会」只能有一个角色：协会负责人（ADMIN）的权限本
 * 就涵盖学院负责人（STAFF），故二者不能在同一个协会里并存。演示需求里
 * 「本协会负责人同时是本协会学院负责人」即由 u09 这种协会负责人承担。
 */
const ASSOC_ROLE_SEED = {
  pkb: { u09: ROLE.ADMIN, u05: ROLE.STAFF, u10: ROLE.STAFF },
  tt: { u04: ROLE.ADMIN, u08: ROLE.STAFF, u10: ROLE.STAFF },
  bd: { u07: ROLE.ADMIN, u04: ROLE.STAFF, u11: ROLE.STAFF },
};

/**
 * 单打对局中「男女对打」的占比。
 *
 * 【为什么一定要留出男女对打】
 * 男女单打合并成一个池，只有真的产生过男女之间的对局，两条分数才在
 * 同一把尺子上量过。若单打永远同性对打，男榜和女榜虽然共用池子，
 * 实际上仍是两个互不相通的封闭系统，分数不可比——那还不如分成两个池。
 *
 * 取四分之一：既能保证每个人隔一段时间就会碰到异性对手，又不至于让
 * 对局构成过于失真（现实中大多数时候还是同性之间约球）。
 */
const SINGLES_MIXED_RATIO = 0.25;

/** 赛事名称里的性别前缀 */
const GENDER_LABEL = {
  M: '男子',
  F: '女子',
};

const DAY_MS = 86400000;

/**
 * 在基准日期上增加天数。
 * @param {Date} base
 * @param {number} days
 * @returns {Date}
 */
function addDays(base, days) {
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * 校验某场赛事的候选人数是否够用。
 *
 * 中途入会的会员在早期周次尚未加入，若人数不足，slice 会静默生成出
 * 残缺的对阵表（比如 8 人赛事只排出 3 场），回放时才发现就晚了。
 * 因此在生成阶段直接抛错，让问题立刻暴露。
 *
 * @param {Array<Object>} candidates 候选会员
 * @param {number} needed 需要的名额
 * @param {string} title 赛事名称，用于错误提示
 * @throws {Error} 人数不足时抛出
 */
function assertEnough(candidates, needed, title) {
  if (candidates.length < needed) {
    throw new Error(
      `「${title}」需要 ${needed} 名会员，但当时只有 ${candidates.length} 名可用`
    );
  }
}

/**
 * 计算 A 战胜 B 的概率。
 *
 * 用与 ELO 相同的 400 分刻度，含义是「实力高 400 分者胜率约 10:1」。
 * 这里作用于隐藏真实水平，而不是当前等级分——这正是模拟的关键：
 * 等级分是对真实水平的「估计」，而比赛结果由真实水平决定。
 *
 * @param {number} skillA A 的真实水平
 * @param {number} skillB B 的真实水平
 * @returns {number} A 的获胜概率
 */
function winProbability(skillA, skillB) {
  return 1 / (1 + Math.pow(10, (skillB - skillA) / 400));
}

/**
 * 生成一局的比分。
 *
 * @param {Function} random
 * @param {number} winnerWinProb 胜方的胜率，越接近 1 分差越大
 * @param {number} [gamePoints=11] 该局的目标分（11 / 15 / 21）
 * @returns {{winner:number, loser:number}}
 */
function generateGameScore(random, winnerWinProb, gamePoints = 11) {
  // dominance: 0 表示势均力敌，1 表示碾压
  const dominance = Math.min(1, Math.abs(winnerWinProb - 0.5) * 2);

  // 平分线：11 分制是 10，15 分制是 14，21 分制是 20。
  // 到了这条线就必须净胜 2 分，且不封顶。
  const deuceLine = gamePoints - 1;

  // 败方得分：碾压时约为平分线的三成，势均力敌时贴着平分线
  let loser = Math.round(deuceLine - dominance * deuceLine * 0.7 + (random() - 0.5) * 2);
  loser = Math.max(1, Math.min(deuceLine, loser));

  // 匹克球规则：先到目标分且领先 2 分获胜；平分之后一路加上去
  const winner = loser >= deuceLine ? loser + 2 : gamePoints;
  return { winner, loser };
}

/**
 * 生成一场比赛的逐局比分。
 *
 * 【为什么要把决胜局固定放在最后】
 * 输赢是先定的，比分要反过来「讲得通」。曾经的写法是随机挑一局让败方赢，
 * 结果会出现「胜方先赢两局、第三局却还在打」这种根本不可能发生的比分
 * （642 场里错了 100 场）。正确的构造是：
 *   先摆好「胜方 need-1 局 + 败方若干局」，打乱，最后再补上决胜局。
 * 这样无论怎么打乱，比赛都是在胜方拿到第 need 局时恰好结束。
 *
 * @param {Function} random
 * @param {boolean} teamAWins A 队是否获胜
 * @param {number} probA A 队的胜率
 * @param {Object} [format] 赛制 { gamePoints, bestOf }
 * @returns {{scoreA:number[], scoreB:number[]}}
 */
function generateMatchScore(random, teamAWins, probA, format = DEFAULT_FORMAT) {
  const { gamePoints, bestOf } = format;
  const need = gamesToWin(bestOf);

  const winnerProb = teamAWins ? probA : 1 - probA;
  // 势均力敌时败方更可能抢下一局
  const closeness = 1 - Math.min(1, Math.abs(winnerProb - 0.5) * 2);
  // 败方最多抢下 need-1 局，再多赢的就是败方了
  const maxLoserGames = need - 1;
  const loserTakesGames = maxLoserGames > 0 && random() < closeness * 0.65;
  const loserGames = loserTakesGames ? randomInt(random, 1, maxLoserGames) : 0;

  const order = shuffle(random, [
    ...Array(need - 1).fill(teamAWins),
    ...Array(loserGames).fill(!teamAWins),
  ]);
  order.push(teamAWins); // 决胜局由胜方拿下

  const scoreA = [];
  const scoreB = [];
  for (const aWinsGame of order) {
    const { winner, loser } = generateGameScore(random, winnerProb, gamePoints);
    scoreA.push(aWinsGame ? winner : loser);
    scoreB.push(aWinsGame ? loser : winner);
  }

  return { scoreA, scoreB };
}

/**
 * 把一场对局的信息组装成比赛记录。
 *
 * @param {Object} params
 * @param {number} [params.round] 赛事轮次，从 1 开始；日常约球不传
 * @param {string} [params.stage] 见 constants.BRACKET_STAGE
 * @param {number} [params.slot] 该轮内的签位序号，从 0 开始
 * @returns {Object} 比赛记录（不含等级分变动，那由回放引擎填入）
 */
function buildMatch({ id, matchType, teamA, teamB, teamAWins, probA, matchTime, recorder, eventId, random, location, round, stage, slot, format = DEFAULT_FORMAT }) {
  const { scoreA, scoreB } = generateMatchScore(random, teamAWins, probA, format);

  return {
    _id: id,
    matchType,
    pool: MATCH_TYPE_TO_POOL[matchType],
    teamA,
    teamB,
    scoreA,
    scoreB,
    // 赛制必须跟着比分一起存：脱离赛制就看不出 11:9 到底是打完没有，
    // 一场 21 分制的比赛和一局 11 分制的比赛，同样的数字含义完全不同
    gamePoints: format.gamePoints,
    bestOf: format.bestOf,
    winner: teamAWins ? 'A' : 'B',
    location: location || pick(random, VENUES),
    matchTime,
    recorder: recorder || teamA[0],
    status: MATCH_STATUS.ACTIVE,
    eventId: eventId || null,
    // 轮次 / 阶段 / 签位只有赛事对局才写：签表要靠它们排出「八进四、半决赛、
    // 决赛」这些轮次名，日常约球没有轮次可言，不能凭空捏一个
    ...(Number.isFinite(round)
      ? { round, stage: stage || BRACKET_STAGE.MAIN, slot: Number(slot) || 0 }
      : {}),
  };
}

/**
 * 模拟一场对局，返回胜方与双方胜率。
 *
 * @param {Function} random
 * @param {number} skillA A 队平均真实水平
 * @param {number} skillB B 队平均真实水平
 * @returns {{teamAWins:boolean, probA:number}}
 */
function simulateOutcome(random, skillA, skillB) {
  const probA = winProbability(skillA, skillB);
  return { teamAWins: random() < probA, probA };
}

/**
 * 运行单败淘汰赛。
 *
 * 采用标准种子排位（1 对 8、4 对 5、2 对 7、3 对 6），
 * 让高水平选手在早期轮次避开彼此，符合真实赛事编排习惯。
 *
 * @param {Object} params
 * @param {Array<Object>} params.entries 参赛条目，每项 { key, players:[userId], skill }
 * @param {Function} params.random
 * @param {Date} params.startTime 赛事开始时间
 * @param {number} params.matchType 比赛类型
 * @param {string} params.eventId 所属赛事编号
 * @param {Object} [params.format] 该赛事采用的赛制
 * @returns {{matches:Array, placements:Object}} placements 为 { 条目key: 名次 }
 */
function simulateBracket({ entries, random, startTime, matchType, eventId, format = DEFAULT_FORMAT }) {
  const seeded = [...entries].sort((a, b) => b.skill - a.skill);
  const totalRounds = Math.log2(seeded.length);

  if (!Number.isInteger(totalRounds)) {
    throw new Error('淘汰赛参赛条目数必须是 2 的幂次，当前为 ' + seeded.length);
  }

  const matches = [];
  const placements = {};
  // 按标准种子顺序重新摆放，而不是简单地按实力两两相邻
  let roundEntries = standardSeedOrder(seeded.length).map((seed) => seeded[seed - 1]);
  let matchCounter = 0;

  for (let round = 0; round < totalRounds; round += 1) {
    const nextRound = [];

    for (let i = 0; i < roundEntries.length; i += 2) {
      const a = roundEntries[i];
      const b = roundEntries[i + 1];
      const { teamAWins, probA } = simulateOutcome(random, a.skill, b.skill);
      const winnerEntry = teamAWins ? a : b;
      const loserEntry = teamAWins ? b : a;

      matches.push(
        buildMatch({
          id: `${eventId}-m${matchCounter}`,
          matchType,
          teamA: a.players,
          teamB: b.players,
          teamAWins,
          probA,
          // 同一轮次内错开时间，越靠后的轮次日期越晚
          matchTime: addDays(startTime, round),
          recorder: a.players[0],
          eventId,
          // 轮次从 1 起，签位是这一轮里的第几场——签表靠这两个字段排序、
          // 取名（八进四 / 半决赛 / 决赛），缺了它们轮次名就会变成 undefined
          round: round + 1,
          stage: BRACKET_STAGE.MAIN,
          slot: i / 2,
          format,
          random,
        })
      );
      matchCounter += 1;

      // 名次公式：第 r 轮出局者名次为 2^(总轮数-r-1) + 1
      placements[loserEntry.key] = Math.pow(2, totalRounds - round - 1) + 1;
      nextRound.push(winnerEntry);
    }

    roundEntries = nextRound;
  }

  // 最后一轮的胜者即冠军
  if (roundEntries.length === 1) {
    placements[roundEntries[0].key] = 1;
  }

  return { matches, placements };
}

/**
 * 生成全部模拟数据。
 *
 * 【为什么场次要给到这个量级】
 * ELO 收敛得比直觉慢得多，且收敛速度与 K 成正比：每场只挪 K×(S−E) 分。
 * 日常 K 统一为 16 后，一个人在某池里要打上几十场分数才贴近真实水平；
 * 只打七八场的话，所有人都会挤在初始分附近，榜单看不出任何区分度。
 * 所以这里按「每周 30 场、持续 20 周」的强度生成，让每位会员在每个池里
 * 都能积累约 30 场——实测各池首尾差距仍有 150 分上下，足够排出名次。
 *
 * @param {Object} [options]
 * @param {number} [options.seed] 随机种子，换数字即可得到一整套新数据
 * @param {string} [options.startDate] 起始日期
 * @param {number} [options.weeks=20] 模拟周数
 * @param {number} [options.casualPerWeek=30] 每周约球场次
 * @param {number} [options.mixedRatio] 单打里男女对打的占比，默认值见 SINGLES_MIXED_RATIO。
 *        单独开这个口子是为了做「混打比例 → 男女分数可比性」的对照实验：
 *        把比例调到 0 就能看到两个性别组各自封闭时会是什么结果。
 * @param {Array<Object>} [options.eventPlan] 赛事编排，缺省用内置那一套。
 *        各协会可用自己的编排错开赛事构成（由调用方传入）。
 * @param {string} [options.eventTitlePrefix] 赛事标题前缀，用来标注归属协会。
 *        默认协会留空，标题仍由实际月份推导（见下方赛事段落）。
 * @param {Array<Object>} [options.announcements] 公告种子，缺省用 ANNOUNCEMENT_SEED。
 * @returns {{members:Array, matches:Array, events:Array, meta:Object}}
 */
function generateSeed(options = {}) {
  const {
    seed = DEFAULT_SEED,
    startDate = DEFAULT_START_DATE,
    weeks = 20,
    casualPerWeek = 30,
    mixedRatio = SINGLES_MIXED_RATIO,
    eventPlan: eventPlanOption = null,
    eventTitlePrefix = '',
    announcements: announcementSeed = null,
  } = options;

  const random = createSeededRandom(seed);
  const baseDate = new Date(startDate + 'T18:00:00');
  // 赛事标题的协会前缀（默认协会为空串，标题逐字节不变）
  const titlePrefix = eventTitlePrefix;

  // ---------- 1. 会员 ----------
  const members = MEMBER_SEED.map((item, index) => ({
    _id: 'u' + String(index + 1).padStart(2, '0'),
    // 昵称在前，真名缀在旁边——两者的分工见 MEMBER_SEED 的说明
    nickName: item.nickName,
    realName: item.realName,
    // 学号是实名信息，不可修改；这里按序号编一个稳定的号码供演示
    studentId: '2023' + String(index + 1).padStart(4, '0'),
    gender: item.gender,
    college: item.college,
    avatarUrl: '',
    points: 0,
    // 缺省即普通会员；学院负责人与管理员在 MEMBER_SEED 里点名
    role: item.role || ROLE.MEMBER,
    status: 1,
    joinDate: addDays(baseDate, (item.joinWeek || 0) * 7),
    // 以下两个字段仅供模拟使用，回放结束时会被剔除，不进入对外数据
    trueSkill: item.trueSkill,
    joinWeek: item.joinWeek || 0,
  }));

  const byId = {};
  for (const m of members) {
    byId[m._id] = m;
  }

  const men = members.filter((m) => m.gender === 'M');
  const women = members.filter((m) => m.gender === 'F');

  /**
   * 截至第 week 周时已经入会的会员。
   *
   * 中途入会的人不能出现在入会之前的比赛里，否则会产生
   * 「人还没入会就有战绩」这种自相矛盾的数据。
   *
   * @param {number} week 周序号（从 0 开始）
   * @param {Array<Object>} [pool] 可选的候选分组，默认全体会员
   * @returns {Array<Object>} 该周可参加比赛的会员
   */
  const activeAt = (week, pool) => (pool || members).filter((m) => m.joinWeek <= week);

  const matches = [];
  let matchSeq = 0;
  const nextMatchId = () => 'm' + String((matchSeq += 1)).padStart(3, '0');

  /** 计算一组选手的平均真实水平 */
  const avgSkill = (ids) => ids.reduce((s, id) => s + byId[id].trueSkill, 0) / ids.length;

  // ---------- 2. 每周日常约球 ----------
  for (let week = 0; week < weeks; week += 1) {
    for (let i = 0; i < casualPerWeek; i += 1) {
      // 每天安排若干场，时间分散在一周内
      const day = week * 7 + randomInt(random, 0, 5);
      // 起始时刻就是 18:00，约球时间必须落在 18 点及以后。
      // 若允许 17 点，第 w 周第一天的 17:xx 会排到起始时刻之前，
      // 按「距起始时刻过了几周」折算就成了第 w-1 周，于是当晚刚入会的人
      // 会出现在入会前的比赛里——测试里那条「入会前不得出场」正是这么挂的。
      const hour = randomInt(random, 18, 21);
      const matchTime = new Date(addDays(baseDate, day).setHours(hour, randomInt(random, 0, 59)));

      // 双打最受欢迎，其余都是单打。
      // 单打不再拆成「男单 / 女单」两种比赛类型——合并成一个池之后，
      // 区分只在「谁和谁打」上体现，不再影响分数的归属。
      const matchType = random() < 0.45 ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES;

      let teamA;
      let teamB;

      if (matchType === MATCH_TYPE.DOUBLES) {
        // 双打：四名随机会员，不分性别
        const four = shuffle(random, activeAt(week)).slice(0, 4);
        teamA = [four[0]._id, four[1]._id];
        teamB = [four[2]._id, four[3]._id];
      } else {
        // 单打：同性对打为主，留四分之一给男女对打
        const menNow = activeAt(week, men);
        const womenNow = activeAt(week, women);

        let two;
        if (random() < mixedRatio) {
          two = [pick(random, menNow), pick(random, womenNow)];
        } else {
          // 同性对打时按两组的人数分配场次，否则人少的一组会「吃不饱」，
          // 分数永远定不下来，男榜女榜的可比性也就无从谈起。
          const menShare = menNow.length / (menNow.length + womenNow.length);
          const group = random() < menShare ? menNow : womenNow;
          two = shuffle(random, group).slice(0, 2);
        }

        teamA = [two[0]._id];
        teamB = [two[1]._id];
      }

      const { teamAWins, probA } = simulateOutcome(random, avgSkill(teamA), avgSkill(teamB));

      matches.push(
        buildMatch({
          id: nextMatchId(),
          matchType,
          teamA,
          teamB,
          teamAWins,
          probA,
          matchTime,
          recorder: teamA[0],
          eventId: null,
          format: pick(random, CASUAL_FORMATS),
          random,
        })
      );
    }
  }

  // ---------- 3. 赛事（单败淘汰） ----------
  // 六场赛事刻意用满三种分制和三种局制：赛事是赛制最容易被改来改去的地方，
  // 让模拟数据先覆盖全，界面上「11 分制 · 三局两胜」这类文案才有各种样本可看。
  //
  // 单打赛事仍然分男子组和女子组：分数池合并了，但比赛本身还是分组的，
  // 就像现实中的校赛——同一个池只是让两个组的名次能放在一起比较。
  // discipline 是「赛事限什么性别」的正式声明（不限则为 null）。它不只是
  // 标题里的一个字：报名与上场都按它拦人。双打两场保持不限——双打同样
  // 分男双 / 女双 / 混双，但这套演示数据沿用「一个双打池」的既有口径。
  // courtCount 是这场赛事的可用场地总数，故意在几场之间取了不同的值：
  // 8 人签表第 1 轮有 4 场，给 4 块场地就是「一人一块」的理想情况，给 2 块
  // 就得排第二批（同一批内仍然不重号，见 services/court.js）。两种情形都要
  // 有样本，验收时才知道分批那条分支到底走不走得通。
  // 默认协会用内置那一套；其余协会可在 flavor 里给自己的编排（由调用方传入），把赛事月份与项目拉开，不至于每个
  // 协会的赛事页看上去都是同一份。不传则逐字节照旧。
  const eventPlan = eventPlanOption || [
    { week: 3, matchType: MATCH_TYPE.SINGLES, gender: 'M', discipline: LEG_DISCIPLINE.MS, size: 8, courtCount: 4, format: { gamePoints: 11, bestOf: 3 } },
    { week: 5, matchType: MATCH_TYPE.SINGLES, gender: 'F', discipline: LEG_DISCIPLINE.WS, size: 8, courtCount: 2, format: { gamePoints: 15, bestOf: 3 } },
    { week: 7, matchType: MATCH_TYPE.DOUBLES, size: 8, courtCount: 4, format: { gamePoints: 11, bestOf: 5 } },
    { week: 11, matchType: MATCH_TYPE.SINGLES, gender: 'M', discipline: LEG_DISCIPLINE.MS, size: 8, courtCount: 3, format: { gamePoints: 21, bestOf: 1 } },
    { week: 12, matchType: MATCH_TYPE.SINGLES, gender: 'F', discipline: LEG_DISCIPLINE.WS, size: 8, courtCount: 2, format: { gamePoints: 15, bestOf: 5 } },
    { week: 15, matchType: MATCH_TYPE.DOUBLES, size: 8, courtCount: 4, format: { gamePoints: 21, bestOf: 3 } },
  ];

  const events = [];

  eventPlan.forEach((plan, eventIndex) => {
    const eventId = 'e' + String(eventIndex + 1).padStart(2, '0');
    const startTime = addDays(baseDate, plan.week * 7);
    // 赛事名由实际日期推导，而不是写死「五月」「六月」。
    // 这样改了起始日期或周次安排，标题也会自动跟着对，不会名不副实。
    const scope = plan.gender ? GENDER_LABEL[plan.gender] : '';
    // titlePrefix 默认空串：默认协会的标题形如「九月男子单打赛」逐字节不变；
    // 其余协会带上自己的前缀（如「乒乓球·九月男子单打赛」），一眼认得出归属
    const title = `${titlePrefix}${startTime.getMonth() + 1}月${scope}${MATCH_TYPE_LABEL[plan.matchType]}赛`;

    // 挑选参赛者：单打按组别挑人，双打从全体中抽签组队
    let entries;
    if (plan.matchType === MATCH_TYPE.DOUBLES) {
      // 双打需要 2 × size 名会员两两组队
      const candidates = shuffle(random, activeAt(plan.week));
      assertEnough(candidates, plan.size * 2, title);
      entries = [];
      for (let i = 0; i < plan.size; i += 1) {
        const players = [candidates[i * 2]._id, candidates[i * 2 + 1]._id];
        entries.push({ key: players.join('+'), players, skill: avgSkill(players) });
      }
    } else {
      const group = plan.gender === 'M' ? men : women;
      const candidates = shuffle(random, activeAt(plan.week, group));
      assertEnough(candidates, plan.size, title);
      entries = candidates.slice(0, plan.size).map((m) => ({
        key: m._id,
        players: [m._id],
        skill: m.trueSkill,
      }));
    }

    const { matches: eventMatches, placements } = simulateBracket({
      entries,
      random,
      startTime,
      matchType: plan.matchType,
      eventId,
      format: plan.format,
    });

    // 把名次摊平到每位参赛者身上
    const results = [];
    for (const entry of entries) {
      for (const userId of entry.players) {
        results.push({ userId, placement: placements[entry.key] });
      }
    }

    matches.push(...withCourts(eventMatches, plan.courtCount));
    events.push({
      _id: eventId,
      title,
      description: '俱乐部常规赛事，单败淘汰制，取胜者晋级',
      matchType: plan.matchType,
      // 赛事限什么性别（null 即不限）。报名与上场校验都读它
      discipline: plan.discipline || null,
      pool: MATCH_TYPE_TO_POOL[plan.matchType],
      location: '学校体育馆 1 号场',
      courtCount: plan.courtCount,
      startTime,
      endTime: addDays(startTime, 1),
      // quota 一律按「人数」计。双打 8 支队伍即 16 人，
      // 这样 results.length 恒等于 quota，界面直接显示「16/16」即可，
      // 不必再区分项目类型做换算。
      quota: results.length,
      status: 2, // 已结束
      results,
    });
  });

  // ---------- 4. 一场「进行中」的赛事（演示用） ----------
  // 上面六场都已结束，赛事页的「进行中」一栏必然是空的：抽签、逐轮推进、
  // 半决赛待打这条链路在界面上根本走不到。这里补一场已经开赛的赛事：
  // 八人报名且已签到、四场八进四刚刚打完、u06 已进四强但半决赛还没开打，
  // 让演示与人工验收有活数据可用。
  //
  // 【为什么排在所有取随机数的地方之后】
  // 它不参与名次模拟（没有 results），比赛由这里显式补上。若把取随机数的
  // 语句插到中间，后面每一次 random() 都会错位，这场补数据就会把前面几百场球
  // 全部改写——那不是「补一场」，是「换一套」。
  //
  // 【为什么是 weeks + 2 而不是更靠后】
  // 开赛日必须落在「现在」之前：签表里的半决赛还要现场录分，而录入校验
  // 明确拒绝晚于当下的比赛时间；同时它又得排在所有已结束赛事之后。加两周
  // 正好落在这两端之间。标题里的月份由实际开赛日推导（各协会起始日期不同，
  // 月份也随之不同），不会名不副实。
  const openWeek = weeks + 2;
  const openStart = addDays(baseDate, openWeek * 7);
  const openSize = 8;
  const openEvent = {
    _id: 'e' + String(eventPlan.length + 1).padStart(2, '0'),
    title: `${titlePrefix}${openStart.getMonth() + 1}月男子单打赛`,
    description: '俱乐部常规赛事，单败淘汰制，取胜者晋级',
    matchType: MATCH_TYPE.SINGLES,
    discipline: LEG_DISCIPLINE.MS,
    pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
    location: '学校体育馆 1 号场',
    // 这场是演示的主角：八进四正好 4 场对 4 块场地，一人一块；半决赛 2 场
    // 用 1、2 号场。点进赛事详情就能看到「场地分配」表按场号分好组
    courtCount: 4,
    startTime: openStart,
    endTime: addDays(openStart, 1),
    // 名额按人数计，与已结束的赛事同一口径
    quota: openSize,
    status: EVENT_STATUS.ONGOING,
    // 名次要到决赛结束才有；results 留空，回放也就不会给它发积分
    results: [],
    level: EVENT_LEVEL.SECOND,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    // 按等级分排种子，抽签一步到位；手工指定请现场新发一场体验
    seedMode: SEED_MODE.ELO,
    seedCount: 4,
  };
  events.push(openEvent);

  // 八位参赛者：固定把演示账号 u06 放进来，其余从当周在册男会员里补齐。
  // u06 是「我」的默认身份，演示时点开赛事详情就能看到自己进了四强。
  const openPool = [byId.u06].concat(
    activeAt(openWeek, men).filter((member) => member._id !== 'u06')
  );
  assertEnough(openPool, openSize, openEvent.title);
  const openEntries = openPool.slice(0, openSize);

  // 与正式抽签同一套标准种子排位：先按真实水平定种子，再摆到签位上
  const openSeeded = [...openEntries].sort((a, b) => b.trueSkill - a.trueSkill);
  const openSlots = standardSeedOrder(openSize).map((seed) => openSeeded[seed - 1]);

  const openFormat = DEFAULT_FORMAT;
  const openMatches = [];
  const qfWinners = [];

  // 四场八进四：刚打完，比分明细齐全，胜者进四强
  for (let slot = 0; slot < openSize / 2; slot += 1) {
    const a = openSlots[slot * 2];
    const b = openSlots[slot * 2 + 1];
    // u06 所在一侧必胜——演示要的是「我进了四强」，不能让随机数把他淘汰
    const teamAWins = a._id === 'u06' ? true : b._id === 'u06' ? false : a.trueSkill >= b.trueSkill;
    const { scoreA, scoreB } = generateMatchScore(
      random,
      teamAWins,
      winProbability(a.trueSkill, b.trueSkill),
      openFormat
    );
    openMatches.push({
      _id: eventMatchKey(openEvent._id, 1, BRACKET_STAGE.MAIN, slot),
      matchType: MATCH_TYPE.SINGLES,
      pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
      teamA: [a._id],
      teamB: [b._id],
      scoreA,
      scoreB,
      gamePoints: openFormat.gamePoints,
      bestOf: openFormat.bestOf,
      winner: teamAWins ? 'A' : 'B',
      location: openEvent.location,
      matchTime: openStart,
      recorder: a._id,
      status: MATCH_STATUS.ACTIVE,
      eventId: openEvent._id,
      round: 1,
      stage: BRACKET_STAGE.MAIN,
      slot,
    });
    qfWinners.push(teamAWins ? a : b);
  }

  // 两场半决赛：签表已排好、人也已就位，但一场都还没打——比分留空、胜者未知，
  // 状态留 PENDING。回放引擎只认「已生效」的比赛，这两场因此不进等级分。
  for (let slot = 0; slot < qfWinners.length / 2; slot += 1) {
    const a = qfWinners[slot * 2];
    const b = qfWinners[slot * 2 + 1];
    openMatches.push({
      _id: eventMatchKey(openEvent._id, 2, BRACKET_STAGE.MAIN, slot),
      matchType: MATCH_TYPE.SINGLES,
      pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
      teamA: [a._id],
      teamB: [b._id],
      scoreA: [],
      scoreB: [],
      gamePoints: openFormat.gamePoints,
      bestOf: openFormat.bestOf,
      winner: null,
      location: openEvent.location,
      matchTime: addDays(openStart, 1),
      recorder: null,
      status: MATCH_STATUS.PENDING,
      eventId: openEvent._id,
      round: 2,
      stage: BRACKET_STAGE.MAIN,
      slot,
    });
  }

  // 抽签记录：签表页靠 draw.size 推出总轮次，缺了它轮次名会算不出来
  openEvent.draw = {
    seedMode: SEED_MODE.ELO,
    seedCount: 4,
    seedValue: openStart.getTime(),
    drawnAt: new Date(addDays(baseDate, openWeek * 7 - 7).setHours(12, 0, 0, 0)),
    drawnBy: 'u01',
    drawCount: 1,
    size: openSize,
    slots: openSlots.map((member) => member._id),
    seeds: openSeeded.slice(0, 4).map((member) => member._id),
    byes: [],
  };

  // 统一走与正式抽签同一个分配函数：八进四 4 场拿 1~4 号场，半决赛 2 场
  // 拿 1、2 号场（轮次不同即不同池，可以复用场号）
  matches.push(...withCourts(openMatches, openEvent.courtCount));

  // 八人已报名且已签到：名单、状态与「已报 8/8」都对得上
  const openSignups = openEntries.map((member, index) => ({
    eventId: openEvent._id,
    userId: member._id,
    status: SIGNUP_STATUS.CHECKED_IN,
    // 报名时间排在开赛前一周，与真实的报名节奏一致；最晚的一位也在当天中午
    signTime: new Date(addDays(baseDate, openWeek * 7 - 7 + index).setHours(12, 0, 0, 0)),
    // 签到在开赛当天开场前一小时，晚于任何一位的报名时间
    checkInTime: new Date(addDays(baseDate, openWeek * 7).setHours(17, 0, 0, 0)),
    actorId: member._id,
  }));

  // 全部对局按时间升序排列，回放引擎依赖这个顺序
  matches.sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));

  return {
    members,
    matches,
    events,
    signups: openSignups,
    announcements: buildAnnouncements(baseDate, announcementSeed || ANNOUNCEMENT_SEED),
    meta: {
      seed,
      weeks,
      generatedAt: baseDate,
      memberCount: members.length,
      matchCount: matches.length,
      eventCount: events.length,
    },
  };
}

module.exports = {
  DEFAULT_SEED,
  MEMBER_SEED,
  ASSOC_ROLE_SEED,
  VENUES,
  ANNOUNCEMENT_SEED,
  buildAnnouncements,
  winProbability,
  generateGameScore,
  generateMatchScore,
  simulateBracket,
  generateSeed,
};
