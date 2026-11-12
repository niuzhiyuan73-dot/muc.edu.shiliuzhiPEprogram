/**
 * 学院赛演示场景（仅本地模拟数据源装载）
 * ============================================================
 * 模拟器的学院赛原本是空的：种子里一场都没有，得从「发布 → 收名单 →
 * 抽签 → 排阵 → 录分」一路点下来才能看到比赛的样子。这个模块把一条
 * 已经推进到半途的赛程直接装进数据源，开机打开学院赛页就能看到：
 *
 *   · 赛事「2026 院际匹克球团体赛」正在进行（16 所学院、团体单败）
 *   · 第一轮 16 进 8 已全部打完
 *   · 第二轮 八进四 已打完三场，只剩法学院那场停在「待排阵」
 *   · 演示账号 u06 赵明宇是法学院负责人，本人不参赛
 *
 * 【为什么不是手写一份静态快照】
 * 场景里的每一场比分、每一次晋级都应由真实的赛制规则推出来，才经得起
 * 后人改动规则后的复核。所以这里不落一份写死的 JSON，而是按真人操作
 * 顺序把同一批动作重放一遍（与 tests/college-demo.test.js 曾用过的脚本
 * 同源）。规则一变，装出来的场景跟着变，不会与赛制脱节。
 *
 * 【为什么全同步】
 * mock 的动作函数虽然都声明为 async，但函数体里没有任何 await（整个
 * mock.js 只有 resetSeason 一处 await），调用即完成全部写入，返回值只是
 * 一句已经落定的承诺。因此这里可以同步地把整条链路走完，无需在模块
 * 加载期引入异步时序——同步装好，第一次读到学院赛数据时它就一定在了。
 * 代价是拿不到那些 Promise 的返回值，所以每一步都从台账 store 回读结果，
 * 而不是依赖返回值。
 *
 * 【不进云函数镜像】
 * 这是 mock 专用的演示数据，云端没有对应概念，因此不在
 * tools/sync-cloud-lib.js 的 MANIFEST 里，也不会被镜像到 cloudfunctions。
 * ============================================================
 */

const { playersPerLeg } = require('./college-lineup.js');
const {
  USER_STATUS,
  LEG_DISCIPLINE,
  TIE_ALGO,
  TIE_NET_MODE,
  requiredGendersOf,
} = require('../utils/constants.js');

/** 种子里的管理员，全场规则性操作都由他做 */
const ADMIN_ID = 'u01';
/** 演示账号：赵明宇，本场被任命为法学院负责人 */
const LEADER_ID = 'u06';
const LAW_COLLEGE = '法学院';

/**
 * 演示当天临时注册的会员。
 *
 * 【为什么非补不可】
 * 种子里 15 所学院多数只有单一性别——理学院只有刘子涵一名男队员，美术学院
 * 只有陈曦一名女队员。而本场景每个大场要打男单 + 女单，排阵按小项校验性别，
 * 不补人就有学院（连文学院自己）排不出阵，整轮演示停在「待排阵」。
 * 给每所单性别学院补一名异性会员后，16 所学院都能真派出 MS + WS。
 *
 * 【为什么不直接往 MEMBER_SEED 里加】
 * 种子会员数是整季回放（ELO / 积分）随机序列的基准，往种子里加人会让所有
 * 既有测试的分数整体漂移。演示会员只在 mock 装载时注册，resetCache() 之后
 * 不复存在，跑回归的测试看不到他们。
 *
 * 【文学院为什么也在内】
 * 种子里只有 15 所学院有会员，文学院是补出来凑满 16 签位的那一所：先有
 * 顾清和（女），再补一名男队员，它才交得出名单、排得出阵。
 */
const DEMO_MEMBERS = [
  { realName: '顾清和', nickName: '清和', gender: 'F', college: '文学院', studentId: '20240099' },
  { realName: '周正阳', nickName: '正阳', gender: 'M', college: '文学院', studentId: '20240060' },
  { realName: '格根塔娜', nickName: '塔娜', gender: 'F', college: '体育学院', studentId: '20240051' },
  { realName: '苏日娜', nickName: '日娜', gender: 'F', college: '信息工程学院', studentId: '20240052' },
  { realName: '谭雨菲', nickName: '雨菲', gender: 'F', college: '理学院', studentId: '20240053' },
  { realName: '白晓棠', nickName: '晓棠', gender: 'F', college: '生命与环境科学学院', studentId: '20240054' },
  { realName: '石俊峰', nickName: '俊峰', gender: 'M', college: '法学院', studentId: '20240055' },
  { realName: '龙云飞', nickName: '云飞', gender: 'M', college: '中国少数民族语言文学学院', studentId: '20240056' },
  { realName: '陆文博', nickName: '文博', gender: 'M', college: '美术学院', studentId: '20240057' },
  { realName: '秦朗', nickName: '秦朗', gender: 'M', college: '音乐学院', studentId: '20240058' },
  { realName: '邵一鸣', nickName: '一鸣', gender: 'M', college: '哲学与宗教学院', studentId: '20240059' },
];

/**
 * 把学院赛演示场景装进数据源。
 *
 * 纯同步：调用返回时台账已就位。中间任何一步凑不齐（例如种子被改到
 * 凑不出 16 所学院）就安全地停下，留给调用方一个可用的部分场景，绝不抛。
 *
 * @param {Object} deps
 * @param {Function} deps.load 数据源内部的 load()，同步取回当前缓存（含 members）
 * @param {Object} deps.actions mock 的动作函数（只为产生写入，返回值一律忽略）
 * @param {Object} deps.stores 台账：collegeStore / matchStore / userStore
 * @param {Object} [deps.options] 场景的主题，用来贴合装载它的协会：
 *        title 赛事名、location 场地。缺省即默认协会的「匹克球」那套，
 *        这样默认协会的演示数据逐字节不变；其余协会由 mock 传自己的项目进来。
 * @returns {Object|null} 装好的赛事记录；中途放弃时返回 null
 */
function installCollegeDemo(deps) {
  const { load, actions, stores, options = {} } = deps;
  const { collegeStore, matchStore, userStore } = stores;
  // 默认协会（不传 options）沿用原文案，保持既有测试与界面对齐
  const demoTitle = options.title || '2026 院际匹克球团体赛';
  const demoLocation = options.location || '学校体育馆';

  /** 当前在册会员（每次回读，因为前面的写入会重建缓存） */
  const members = () => load().members;

  /** 某学院可以上场的会员（在册、且不是学院负责人——学院负责人不参赛） */
  const rosterMembersOf = (college) =>
    members().filter(
      (member) =>
        member.college === college &&
        member.status === USER_STATUS.ACTIVE &&
        member._id !== LEADER_ID
    );

  /** 某学院可以上场的会员编号 */
  const rosterIdsOf = (college) => rosterMembersOf(college).map((member) => member._id);

  /** 替某学院排阵的人：法学院的名单交给学院负责人，其余学院由管理员代劳 */
  const lineupActorOf = (college) => (college === LAW_COLLEGE ? LEADER_ID : ADMIN_ID);

  /**
   * 按各小项要求的性别从名单里挑人。
   *
   * 【为什么不能再按下标轮着取】
   * 旧写法 `ids[i % len]` 的 i 在每个小项内部都从 0 重新数，单打又只取 1 人，
   * 于是男单、女单派了同一个人——这正是要修的 bug 在演示里的样子。现在按
   * 真相源 requiredGendersOf 逐位取：男单取男、女单取女、混双一男一女。
   *
   * 【为什么同一小项内不重复、跨小项允许兼项】
   * 一个人不能在同一小项里占两个位置（双打无人搭档）；跨小项兼项由赛事
   * allowMultiEntry 决定，本场景开着，所以两场单打可以派上最合适的人。
   *
   * @param {Array<Object>} roster 该学院可上场会员
   * @param {Array<Object>} legs 大场的小项
   * @returns {Array<Object>|null} 凑不齐任何一项所需性别时返回 null，由调用方整场放弃
   */
  const lineupEntries = (roster, legs) => {
    const rows = [];
    for (const leg of legs) {
      const required = requiredGendersOf(leg.discipline);
      // 未知小项（真相源里没有）：退回按人数取前几个
      const need = required ? required.length : playersPerLeg(leg.discipline);
      const genders = required || new Array(need).fill('');

      const players = [];
      const used = new Set();
      for (const gender of genders) {
        const pick = roster.find(
          (member) => !used.has(member._id) && (!gender || member.gender === gender)
        );
        if (!pick) return null;
        used.add(pick._id);
        players.push(pick._id);
      }
      rows.push({ legNo: leg.legNo, players });
    }
    return rows;
  };

  /** 取某大场里某场小场刚生成的比赛记录（从本地台账回读） */
  const legMatchOf = (tie, legNo) => {
    const leg = tie.legs.find((item) => Number(item.legNo) === Number(legNo));
    if (!leg) return null;
    return matchStore.listSubmitted().find((match) => match._id === leg.matchId) || null;
  };

  /** 录一场 11:5 的比分并由对手确认生效 */
  const settleLeg = (tie, legNo, winnerIsA) => {
    const match = legMatchOf(tie, legNo);
    if (!match) return;
    const winnerId = winnerIsA ? match.teamA[0] : match.teamB[0];
    const loserId = winnerIsA ? match.teamB[0] : match.teamA[0];
    actions.submitMatch({
      id: match._id,
      scoreA: winnerIsA ? ['11'] : ['5'],
      scoreB: winnerIsA ? ['5'] : ['11'],
      actor: winnerId,
    });
    actions.confirmMatch(match._id, loserId);
  };

  /** 打完一场大场：双方排阵 → 管理员开始 → 逐小项录分确认 */
  const playTie = (tie, winCollege) => {
    for (const college of [tie.collegeA, tie.collegeB]) {
      const entries = lineupEntries(rosterMembersOf(college), tie.legs);
      // 凑不齐（名单为空，或某一小项缺所需性别）就整场放弃，
      // 避免只排一半留下畸形大场
      if (!entries) return;
      actions.submitLineup(
        { tieId: tie._id, college, entries },
        lineupActorOf(college)
      );
    }
    actions.startTie(tie._id, ADMIN_ID);

    const started = collegeStore.findTie(tie._id);
    if (!started) return;
    const winIsA = tie.collegeA === winCollege;
    for (const leg of started.legs) settleLeg(started, leg.legNo, winIsA);
  };

  // 1. 补齐会员：第 16 所学院（文学院）与各单性别学院的异性队员
  //    （注册 → 管理员审核通过；全部是当天演示用的临时会员）
  //
  // 注册时刻逐条加一秒：mock 的 buildAccount 在无 openId 时用
  // `local_${now.getTime()}` 当 _id，同一时刻注册的多个人会撞成同一个账号、
  // 后一条把前一条覆盖掉。错开时间才拿得到 11 份互不相同的记录。
  const registerBase = new Date('2026-08-01T09:00:00').getTime();
  for (let index = 0; index < DEMO_MEMBERS.length; index += 1) {
    const profile = DEMO_MEMBERS[index];
    actions.registerMember(profile, { now: new Date(registerBase + index * 1000) });
    const account = userStore
      .listAccounts()
      .find((item) => item.studentId === profile.studentId);
    if (!account) return null;
    actions.approveMember(account._id, ADMIN_ID);
  }

  // 2. 任命赵明宇为法学院负责人（本人不参赛，见 rosterIdsOf 的排除）
  actions.setCollegeLeader(LEADER_ID, ADMIN_ID, true);

  // 3. 发布学院赛：团体单败，一场大场打男单 + 女单
  actions.publishCollegeEvent(
    {
      title: demoTitle,
      description: '16 所学院单败淘汰；当前进度：16 进 8 已打完，八进四进行中',
      legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
      allowMultiEntry: true,
      // 一场大场要打男单 + 女单，名单至少要 1 男 1 女才排得出阵
      rosterMin: 2,
      rosterMax: 20,
      tieAlgo: TIE_ALGO.FULL_POINTS,
      tieNetMode: TIE_NET_MODE.WIN_DIFF,
      startTime: '2026-09-20T09:00:00',
      location: demoLocation,
      // 八进四那一轮有 4 个大场，正好摆得下 4 块场地
      courtCount: 4,
    },
    ADMIN_ID
  );
  const event = collegeStore.listEvents().slice(-1)[0];
  if (!event) return null;

  // 4. 16 所学院交名单（学院负责人本人不进名单）→ 管理员逐份审核通过
  const colleges = Array.from(new Set(members().map((member) => member.college))).sort();
  for (const college of colleges) {
    const memberIds = rosterIdsOf(college);
    if (!memberIds.length) return event;
    actions.submitCollegeEntry({ eventId: event._id, college, memberIds }, ADMIN_ID);
  }
  for (const entry of collegeStore.listEntries(event._id)) {
    actions.reviewCollegeEntry(entry._id, 'approve', '', ADMIN_ID);
  }

  // 5. 抽签（名单就此锁定）→ 赛事级开始，生成首轮 8 场
  actions.drawCollegeEvent(event._id, ADMIN_ID, { seedValue: 20260920 });
  actions.startCollegeEvent(event._id, ADMIN_ID);
  const round1 = collegeStore
    .listTies(event._id)
    .filter((tie) => Number(tie.round) === 1);
  if (round1.length !== 8) return event;

  // 6. 打完 16 进 8，法学院所在的那场让法学院赢
  for (const tie of round1) playTie(tie, LAW_COLLEGE);

  // 7. 八进四：打掉不含法学院的三场，把法学院那场留成「待排阵」
  const round2 = collegeStore
    .listTies(event._id)
    .filter((tie) => Number(tie.round) === 2);
  const lawTie = round2.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );
  for (const tie of round2) {
    if (lawTie && tie._id === lawTie._id) continue;
    playTie(tie, tie.collegeA);
  }

  return collegeStore.findEvent(event._id);
}

module.exports = { installCollegeDemo };
