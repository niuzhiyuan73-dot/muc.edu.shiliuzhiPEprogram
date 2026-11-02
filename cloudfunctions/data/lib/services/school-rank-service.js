/**
 * 学校维度：计分 / 赛季 / 排行榜（协议 2，M4）
 * ============================================================
 * 【Elo 逐场结算改造后的读取口径】
 * 等级分不再由比赛流水重放：当前评级落库在 member_ratings（确认比赛时
 * 逐场结算，见 school-rating-service），读取端直接**点读评级表**；个人
 * 历史与走势读比赛上的**结算快照**（settlement），绝不由当前评级反推。
 * 本模块只做「取数 + 组形状 + 判权」，一行计分逻辑都不重写。
 *
 *   评级      → member_ratings（缺档按性别展示值兜底，读请求不写库）
 *   积分      → school-points-service（赛事名次分 + 训练签到分，独立聚合）
 *   个人历史  → settlement.players（只取计分场；走势按结算序号连链）
 *   榜单排序  → buildProjectLeaderboard（纯模块）
 *   赛季权限  → canResetSeason（纯模块，与旧栈同一门槛）
 *
 * 【为什么不落排行榜快照】
 * 每次读 = 一次范围评级列表 + 一次范围比赛列表（只挑带快照的），数据量
 * 下这最快也最不会出错；云端真要上量时再加按范围的快照——那是性能优化，
 * 不影响这里的接口形状。
 *
 * 【赛季键为什么带学校与协会】
 * 赛季锚点 / 分界点 / 编号都是「每校每协会各一份」。若共用一个键，一个
 * 协会开新赛季会把另一个协会的分界一起改掉。键由 scopeKey 组成，天然隔离。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { loadColleges } = require('./college-directory.js');
const { legacyActorOf, legacyRoleOf, buildDirectory, actorDirectory } = require('./school-actor.js');
const { permissionOf, permissionLabelOf, canSchoolAction } = require('./school-permission.js');
const { displayRating } = require('./school-rating-service.js');
const { aggregatePoints, collectEventPointFacts, mountEventPointDeltas } = require('./school-points-service.js');
const { settledPointsOf, isSettled } = require('./season-points.js');
const { buildTrainingPointFacts } = require('./training-points.js');
const { buildProjectLeaderboard, percentileFromBoard } = require('../utils/leaderboard.js');
const { getPoolRating } = require('../utils/rating.js');
const {
  buildEventRecord, summarizeEvents, buildRatingHistory, buildHeadToHead,
  buildPartnerRecord, buildMatchHistory, summarizeForm,
} = require('../utils/stats.js');
const { isEventDoc } = require('./school-event-service.js');
const { canResetSeason } = require('./season.js');
const { formatElo, formatPercent } = require('../utils/format.js');
const {
  ALL_RATING_POOLS, ALL_RANK_PROJECTS, RANK_PROJECT_LABEL, RANK_PROJECT_CONFIG,
  USER_STATUS, SETTLEMENT_STATUS, MATCH_STATUS,
} = require('../utils/constants.js');
const {
  scopeKey, belongsToSchoolScope, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS,
  schoolMemberKey, schoolRoleKey, schoolMembershipKey, memberRatingKey,
} = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 榜单标题。与旧栈 rank-view.BOARD_LABEL 同一口径：只剩等级分这一把尺子。 */
const BOARD_LABEL = '等级分榜';

/** 榜单页最多展示多少名。与旧栈 rank-view.TOP_LIMIT 一致，是界面口径不是可调参数。 */
const TOP_LIMIT = 10;

/**
 * 一次取回多少行榜单（展示 10 行，其余供页面搜索）。
 *
 * 【为什么不是全量】（2026-10-23 方案 A 第 3 步）
 * `allRows` 原先整榜下发，页面搜索在它上面过滤。全量意味着把 2000 人的评级
 * 全部读回来——那正是这轮要消掉的读放大。50 行覆盖「找自己 / 找同学」的
 * 绝大多数场景，而「我」即使排在 50 名之外也会单独补一行（见 getSchoolRanking）。
 */
const RANK_SEARCH_LIMIT = 50;

/**
 * 个人主页最多回看该会员多少场比赛。
 *
 * 【为什么需要一个数】（2026-10-22 大用户量复查 H-2）
 * 走势 / 交锋 / 搭档 / 逐场战绩 / 近期状态全部只筛**这个人**的比赛。原来靠
 * `loadScopeView` 把本范围全部历史比赛读回来再筛——8000 场就是 80 页 RPC，
 * 而且随年限线性变慢（第 5 年打开一次要翻 400 页）。
 *
 * 500 场对「3 年 8000 场、2000 人」的学校是人均 4 场的 100 多倍，实际只有校队
 * 级别的重度选手会触到；触到时更早的场次不进走势与交锋统计——个人主页是
 * 战绩概览，不是完整档案。这条口径写在这里，将来要改就改这一个数。
 */
const PROFILE_MATCH_FETCH = 500;

/** 前三名的奖牌样式，其余为空串（与 rank-view.MEDALS 一致）。 */
const MEDALS = ['gold', 'silver', 'bronze'];

/** 名次对应的奖牌。 */
function medalOf(rank) {
  return MEDALS[rank - 1] || '';
}

/** 没有头像时用昵称首字占位。 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/** 「定级中」「不活跃」在等级分榜上有意义，其余状态不装饰。 */
function badgeOf(status) {
  if (status === 'provisional') return '定级中';
  if (status === 'inactive') return '不活跃';
  return '';
}

/**
 * 赛季文档在仓储里的键。一个范围一份，编号自带 schoolId 与 association，
 * 跨范围读不到也改不掉（与 ratingKey 同一路数，只是赛季是范围级单例）。
 *
 * @param {Object} ctx
 * @returns {string}
 */
function seasonKeyOf(ctx) {
  return scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
}

/**
 * 缺省赛季文档。仓储里还没有时用它顶上，读接口不必先写库就能工作。
 * @returns {Object}
 */
function defaultSeason(ctx) {
  return {
    _id: seasonKeyOf(ctx),
    schoolId: ctx.schoolId,
    association: ctx.association,
    anchorTime: null, // 赛季锚点，首次写入后钉死，不在本模块内改动
    resetTime: null, // 赛季分界点，null 表示从未开始过新赛季
    seasonNumber: 1, // 只有 resetSchoolSeason 能 +1
    version: 0, // 写计数器，留给将来的读缓存失效用
  };
}

/**
 * 读本范围的赛季文档（缺省返回默认值，不写库）。
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function loadSeason(ctx) {
  const doc = await ctx.repo.seasons.getById(seasonKeyOf(ctx));
  if (!doc || !belongsToSchoolScope(doc, ctx)) return defaultSeason(ctx);
  return doc;
}

/**
 * 把本范围在册会员组装成回放引擎要的会员记录。
 *
 * 只有「正常在册 + 平台账号启用 + 归属本校」的人才进回放名单；离校者
 * （status !== active）不上榜，其历史流水仍会被回放按 roster 忽略。
 * 补 `status: ACTIVE` 供 leaderboard.isRankable 使用——旧栈会员记录带数字
 * status，S2 在册名单不带，缺了它所有人都被判成可上榜（虽然这里本就都
 * 是 active，但显式给出免得日后加离校名单时忘掉）。
 *
 * @param {Object} ctx
 * @returns {Promise<Array<Object>>}
 */
async function replayMembersOf(ctx) {
  return membersOfRows(ctx, await ctx.repo.forScope(ctx).schoolMembers.list());
}

/**
 * 已经读出来的会员行 → 榜单口径的会员视图。
 *
 * 与 `replayMembersOf` 分成两步，是为了让「积分物化在会员行上」这件事少读一次：
 * 榜单视图要拿这批行里的 `seasonPoints`（见 season-points.js），而它们本来
 * 就要读——先读行、再决定要不要读三份积分事实，比先猜再读省一轮。
 *
 * @param {Object} ctx
 * @param {Array<Object>} rows `schoolMembers` 文档
 * @returns {Promise<Array<Object>>}
 */
async function membersOfRows(ctx, rows) {
  const list = Array.isArray(rows) ? rows : [];
  // 账号按在册成员编号批量取：users 是平台级集合，list() 会连别校账号一起读，
  // 读量随平台总用户数增长（2026-10-21 审查 P0-1）。
  const users = await ctx.repo.users.listByIds(list.map(row => row.userId));
  const userById = new Map(users.map(user => [user._id, user]));
  return list
    .map(row => viewMemberOf(row, userById.get(row.userId), ctx.schoolId))
    .filter(Boolean);
}

/**
 * 一条学籍行 + 一份账号 → 榜单口径的会员行；不合格返回 null。
 *
 * 抽出来是为了让「整范围装载」与「按编号装载」用同一把尺子：曾经三处各写一份
 * 过滤条件，改一处漏两处就会出现「榜上有他、按人取却取不到」。
 */
function viewMemberOf(row, user, schoolId) {
  if (!row || row.status !== SCHOOL_MEMBER_STATUS.ACTIVE) return null;
  if (!user) return null;
  if (user.platformStatus !== PLATFORM_STATUS.ACTIVE) return null;
  if (user.primarySchoolId !== schoolId) return null;
  return { ...user, status: USER_STATUS.ACTIVE };
}

/**
 * 本范围的训练积分事实（P5 接入）：已确认的签到归一成事实。
 * 【Elo 逐场结算改造后】训练事实交给 school-points-service 统一聚合，
 * 这里保留导出供需要事实明细的调用方（测试）使用。
 *
 * @param {Object} ctx
 * @returns {Promise<Array<Object>>}
 */
async function trainingFactsOf(ctx) {
  const [trainings, registrations] = await Promise.all([
    ctx.repo.forScope(ctx).associationTrainings.list(),
    ctx.repo.forScope(ctx).trainingRegistrations.list(),
  ]);
  return buildTrainingPointFacts({ trainings, registrations });
}

/**
 * 从比赛文档里挑出「已生效、且带计分结算快照」的场次，按结算序号连成 Elo 链。
 *
 * 抽出来是因为两处要用：榜单/成绩的整范围视图（`loadScopeView`）与个人主页
 * 的「我参与的比赛」定向读取。两边必须同一个口径，否则个人主页的走势会和
 * 榜单对不上——这类分叉在数据层最难被发现。
 *
 * @param {Array<Object>} rows 比赛文档（任意子集）
 * @returns {Array<Object>} 已按 settlementSeq 升序、players 补好 pointDelta 槽位
 */
function ratedMatchesOf(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(match => match.status === MATCH_STATUS.ACTIVE && match.settlement
      && match.settlement.status === SETTLEMENT_STATUS.RATED)
    .map(match => ({
      ...match,
      // players 取自快照并补 pointDelta 槽位：赛事分挂载由 mountEventPointDeltas 完成
      players: (match.settlement.players || []).map(player => ({ ...player, pointDelta: 0 })),
    }))
    .sort((a, b) => Number(a.settlement.settlementSeq || 0) - Number(b.settlement.settlementSeq || 0));
}

/**
 * 装载本范围的读取视图：在册会员 + 落库评级 + 计分比赛 + 赛季积分。
 * ============================================================
 * 这是三个读接口（榜单 / 会员成绩 / 个人主页）共用的取数层，取代旧的
 * 旧的 replayScope——**不再有全量回放**：
 *   · 评级来自 member_ratings 列表（按 scope 查询一次），缺档的会员用
 *     displayRating 兜底（按性别的起点展示值，不写库）；
 *   · 计分比赛取带「计分结算快照」的已生效比赛，players 取自快照
 *     （赛前/赛后分是结算那一刻的事实），并按 settlementSeq 升序排列
 *     ——这正是 Elo 变化链的顺序；
 *   · 积分由 school-points-service 从赛事结果与训练事实独立聚合，
 *     赛事分按「结算序号最大的那场」挂载 pointDelta。
 *
 * @param {Object} ctx
 * @param {Object} [options]
 * @param {boolean} [options.needMatches=true] 是否需要比赛流水（见下）
 * @returns {Promise<{season:Object, members:Array<Object>, matches:Array<Object>, pointFacts:Array<Object>, events:Array<Object>}>}
 */
async function loadScopeView(ctx, options = {}) {
  const { needMatches = true, pointsFor = '', needPoints = true } = options;
  const season = await loadSeason(ctx);
  // 【为什么榜单可以不读 matches】（2026-10-21 审查 P0-2）
  // 榜单每行的 elo / 胜 / 负 / 出场数全部来自 member_ratings（Elo 逐场结算后
  // 已落库，见 extractPoolStats），积分来自 events + 训练事实。matches 只在
  // **个人主页的走势**里用得到（buildRatingHistory）。
  // 而 matches 是只增不减的最大集合：把它读回来只为两个不用的接口，等于
  // 第 5 年打开榜单要读 5 年的流水。榜单与成绩因此显式关掉它。
  // 训练报名：只算一个人的积分时按 userId 下推（个人主页）。
  // trainingRegistrations 是只增不减的集合，3000 条就是 30 页 RPC，而个人主页
  // 只用到这个人的几十条。注意**只有传了 pointsFor 的那个人的 points 可信**：
  // 其他人的训练积分会因为缺数据而偏低，所以这条路只给单人的读接口用。
  // 注意这里写成**惰性函数**：`needPoints: false` 时（榜单）一次都不该发出去。
  // 若先算出 Promise 再在三元里挑，查询在赋值那一刻就已经上路了。
  const registrationsOf = () => (pointsFor
    ? ctx.repo.forScope(ctx).trainingRegistrations.listByUser(pointsFor)
    : ctx.repo.forScope(ctx).trainingRegistrations.list());
  // 【为什么榜单连积分也不读】needPoints: false（2026-10-23 H-6 的第一步）
  // 榜单每行只有 elo / 胜负 / 出场数 / 昵称，**不用赛季积分**——积分是个人主页
  // 的事项。而积分要从 events + trainings + trainingRegistrations 三处聚合：
  // 只读不写也要 33 页 RPC（训练报名 30 + 赛事 2 + 训练 1）。
  // 传 false 时跳过这三处，`member.points` 保持 undefined（不是 0——0 会被
  // 页面当成「这个人是零分」，而实际是「这次没算」）。
  // 【积分物化在会员行上】（2026-10-29 第十三轮）
  // 赛季跟得上事实（`pointsSettledVersion === version`）时，积分就在榜单本来
  // 就要读的那批会员行的 `seasonPoints` 字段里——**零额外读**。
  // events / trainings / trainingRegistrations 只在这两种情况下才读：
  //   · 未结算（首次上线、刚写过库、并发写）→ 回退实时聚合；
  //   · `needMatches`（要算 pointFacts 把赛事分挂到比赛流水上）。
  const settled = needPoints && isSettled(season);
  const needEventRows = needMatches || (needPoints && !settled);
  const needPointRows = needPoints && !settled;
  const empty = Promise.resolve([]);
  const [memberRows, matches, ratingDocs, events, trainings, trainingRegistrations] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    needMatches ? ctx.repo.forScope(ctx).matches.list() : empty,
    ctx.repo.forScope(ctx).memberRatings.list(),
    needEventRows ? ctx.repo.forScope(ctx).events.list() : empty,
    needPointRows ? ctx.repo.forScope(ctx).associationTrainings.list() : empty,
    needPointRows ? registrationsOf() : empty,
  ]);
  const members = await membersOfRows(ctx, memberRows);
  const settledPoints = settled ? settledPointsOf(season, memberRows) : null;

  // ── 评级：按「userId|pool」建索引；缺档按性别兜底，读请求不写库 ──
  const ratingByKey = new Map(ratingDocs.map(doc => [`${doc.userId}|${doc.pool}`, doc]));
  const viewMembers = members.map((user) => ({
    ...user,
    ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
      const doc = ratingByKey.get(`${user._id}|${pool}`);
      acc[pool] = doc || displayRating(user, pool);
      return acc;
    }, {}),
  }));

  // ── 计分比赛：带「计分」结算快照的已生效比赛，按结算序号连成 Elo 链 ──
  const pointFacts = collectEventPointFacts({ events, resetTime: season.resetTime });
  const ratedMatches = ratedMatchesOf(matches);

  // ── 积分：独立聚合（赛事 + 训练），赛事分挂到各人最后一场 ──
  mountEventPointDeltas(ratedMatches, pointFacts);
  if (needPoints) {
    const pointsByUser = settledPoints || aggregatePoints({
      events,
      trainings,
      trainingRegistrations,
      resetTime: season.resetTime,
      members: viewMembers.map(m => ({ userId: m._id })),
    });
    for (const member of viewMembers) {
      member.points = pointsByUser.get(member._id) || 0;
    }
  }

  // events 一并带出：个人主页要按「我参加过的赛事」算荣誉，原先它自己又读了
  // 一遍同一份 events（整表读 × 2）。多回一个字段，调用方按需取。
  return { season, members: viewMembers, matches: ratedMatches, pointFacts, events };
}

/**
 * 个人主页需要的「赛事 / 训练事实 + 我这个人的赛季积分」。
 *
 * 【为什么不再借 loadScopeView】（2026-10-23 方案 A 第 4 步）
 * 个人主页只要**一个人**的积分与荣誉，而 loadScopeView 会顺带把全班名册与全部
 * 评级都物化出来——那 120 页当初就是为了「我在同项目排第几」的分母。分母改成
 * 聚合计数之后，这里就只剩三份小集合：赛事（2~3 页）、训练（1 页）、
 * 训练报名（按人下推，1 页）。
 *
 * `aggregatePoints` 的 `members` 是白名单，只传这一个人即可——不要传空数组，
 * 空数组等于「不限人」，会把全班积分都算一遍（虽然结果只取一个）。
 *
 * @param {Object} ctx
 * @param {string} userId
 * @returns {Promise<{season:Object, events:Array, pointFacts:Array, points:number}>}
 */
async function loadProfileFacts(ctx, userId) {
  const scopeRepo = ctx.repo.forScope(ctx);
  const season = await loadSeason(ctx);
  // 会员行与赛事并行读：行上带着物化积分（见 season-points.js），
  // 结算跟得上事实时就不必再读训练与签到。
  const [events, memberRows] = await Promise.all([
    scopeRepo.events.list(),
    scopeRepo.schoolMembers.listByIds([schoolMemberKey(userId, ctx.schoolId)]),
  ]);
  const pointFacts = collectEventPointFacts({ events, resetTime: season.resetTime });

  const settled = settledPointsOf(season, memberRows);
  // 结算跟得上、且这个人确实有会员行 → 直接用物化值
  if (settled && settled.has(userId)) {
    return { season, events, pointFacts, points: settled.get(userId) || 0 };
  }
  const [trainings, registrations] = await Promise.all([
    scopeRepo.associationTrainings.list(),
    scopeRepo.trainingRegistrations.listByUser(userId),
  ]);
  const pointsByUser = aggregatePoints({
    events,
    trainings,
    trainingRegistrations: registrations,
    resetTime: season.resetTime,
    members: [{ userId }],
  });
  return { season, events, pointFacts, points: pointsByUser.get(userId) || 0 };
}

/* ------------------------------------------------------------------ 排行榜 */

/**
 * 把某个项目的回放会员排成榜单行（形状与旧栈 rank-view.buildEloRows 一致）。
 *
 * 展示层只保留出场数 > 0 的人（见 rank-view 头部：否则榜首下挂一排起点分的
 * 僵尸账号），过滤后按现有次序重新编号。
 *
 * @param {Array<Object>} users 回放后的会员
 * @param {string} project 榜单项目
 * @param {string} myId 当前登录会员编号
 * @returns {Array<Object>}
 */
function buildRows(users, project, myId) {
  const board = buildProjectLeaderboard(users, project)
    .filter(row => (row.matchCount || 0) > 0)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const realNameById = new Map(users.map(user => [user._id, user.realName || '']));
  return board.map(row => ({
    userId: row._id,
    rank: row.rank,
    medal: medalOf(row.rank),
    isMe: Boolean(myId) && row._id === myId,
    nickName: row.nickName,
    // 只参与搜索，不渲染；页面上显示的一律是昵称
    // 下发但**不渲染**：只用于按真实姓名搜索。榜单里只有出场过的参赛者，
    // 与赛事公示名单同口径，不含未参赛会员（2026-10-21 评估后保留）。
    realName: realNameById.get(row._id) || '',
    avatarText: avatarOf(row.nickName),
    avatarUrl: row.avatarUrl || '',
    detailText: `${row.wins} 胜 ${row.losses} 负`,
    valueText: String(formatElo(row.elo)),
    valueClass: '',
    noteText: `胜率 ${formatPercent(row.winRate)}`,
    badge: badgeOf(row.status),
  }));
}

/**
 * 把评级文档拼成 `buildRows` 认识的「会员 + 评级」形状。
 *
 * 【为什么不在取数层就改名次】
 * 榜单的名次、徽章、胜率、定级中都由 buildRows 一处算。下推改造只换「取哪批
 * 数据」，不换「怎么算名次」——否则两条路径的口径迟早分叉，而这类分叉在榜单上
 * 表现为「同一个人昨天第 7、今天第 9」，最难被发现。
 *
 * 账号缺失时用空昵称占位：评级文档存在但账号被删属于脏数据，不该让整张榜报错。
 *
 * @param {Array<Object>} docs 评级文档（已按条件筛好）
 * @param {Map<string,Object>} userById userId → 账号
 * @returns {Array<Object>} 形如 replayMembersOf 的产物
 */
function membersFromRatingDocs(docs, userById) {
  return (Array.isArray(docs) ? docs : []).map((doc) => {
    const user = userById.get(doc.userId) || {};
    return {
      _id: doc.userId,
      nickName: user.nickName || '',
      realName: user.realName || '',
      avatarUrl: user.avatarUrl || '',
      gender: doc.gender || user.gender || '',
      // 查询已按在册状态筛过；显式给 active 供 isRankable 判定
      status: USER_STATUS.ACTIVE,
      ratings: {
        [doc.pool]: {
          elo: doc.elo,
          matchCount: doc.matchCount || 0,
          wins: doc.wins || 0,
          losses: doc.losses || 0,
          lastMatchTime: doc.lastMatchTime || null,
        },
      },
    };
  });
}

/**
 * 空视图。没有读权限时下发它——一行榜单都不带。
 * @param {string} activeProject
 * @param {string} activeProjectLabel
 * @returns {Object}
 */
function emptyRanking(activeProject, activeProjectLabel) {
  return {
    projectTabs: projectTabs(activeProject),
    activeProject,
    activeProjectLabel,
    activeBoardLabel: BOARD_LABEL,
    rows: [],
    allRows: [],
    total: 0,
    hasMore: false,
    empty: true,
    playerCountText: '',
    emptyNote: '',
    me: null,
    meHint: '',
  };
}

/** 项目标签页：每个项目一个标签，标出当前选中的那个。 */
function projectTabs(activeProject) {
  return ALL_RANK_PROJECTS.map(project => ({
    project,
    label: RANK_PROJECT_LABEL[project],
    active: project === activeProject,
  }));
}

/**
 * 取本范围的等级分榜。形状与旧栈 rank-view.loadRankView 一致（多一个
 * `schoolName`，与 school-demo.schoolRank 对齐）。
 *
 * 【2026-10-23 方案 A 第 3 步：取数从「全量回放」改为「条件下推」】
 * 原来无论榜单要多少行，都得把本范围的名册（20 页）+ 全部账号（20 页）+
 * 全部评级（80 页）读回来，在内存里按 elo 排。贵的根源不是排序，而是
 * **排序键与过滤键分居两个集合**（elo 在评级表，性别 / 在册状态在名册），
 * 数据库无法跨集合 join。把 gender 与 memberStatus 冗余进评级表之后，
 * 「本池 + 本项目性别 + 在册 + 按 elo 前 N」可以一条查询完成：
 *
 *   ① listTop       前 50 名（一页；同时充当搜索范围）
 *   ② countRanked   上榜总人数（聚合计数，不读文档）
 *   ③ listByUser    我在这几个池里的评级（点读，1 页）
 *   ④ users.listByIds 这 51 个人的昵称头像（1 批）
 *   ⑤ countRanked   比我高的人数 → 我的名次（榜外时）
 *   合计 ≈ 5 个 RPC，原为 120 页。
 *
 * 【名次仍由本地重算】数据库只按 elo + 胜场取「哪一批人」，名次用
 * buildRows 的完整比较器（elo → 胜率 → 胜场 → 时间 → 编号）算，口径与旧路径
 * 逐位一致——只有「第 50 与第 51 名 elo 完全相同」这一种情况可能取到不同的人。
 * 胜率是派生字段，不适合进索引，这也是它留在本地的原因。
 *
 * 【搜索范围变成前 50】`allRows` 原先下发全榜，页面搜索在它上面过滤。现在只给
 * 前 50 + 我自己：搜榜外的人会搜不到。这是有意的取舍——前 50 覆盖了「找我
 * 自己 / 找同学」绝大多数场景，而全量下发 2000 行本身也是流量负担。
 *
 * @param {Object} [payload] { project? }
 * @param {Object} ctx
 */
async function getSchoolRanking(payload = {}, ctx) {
  const activeProject = ALL_RANK_PROJECTS.includes(payload.project)
    ? payload.project
    : ALL_RANK_PROJECTS[0];
  const activeProjectLabel = RANK_PROJECT_LABEL[activeProject];

  // 闸门：没有读权限就到此为止，一行榜单都不发（与名录同口径）
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, schoolName: '', message: '没有读取本协会排行榜的权限',
      ...emptyRanking(activeProject, activeProjectLabel) });
  }

  const myId = ctx.actorId || '';
  const { pool, gender } = RANK_PROJECT_CONFIG[activeProject];
  const scopeRepo = ctx.repo.forScope(ctx);

  const topDocs = await scopeRepo.memberRatings.listTop({
    pool, gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE, limit: RANK_SEARCH_LIMIT,
  });
  // 【回填监控】只要这个池里还有**没有 memberStatus 字段**的文档，就整体回落旧路径。
  //
  // 为什么不能只看「新路径取到几条」：那样部分回填的学校会更危险——已经回填的
  // 人照常上榜，没回填的人被状态条件静默滤掉，榜单看起来正常但少了人。少人比
  // 空榜更难被发现。所以这里用一次 `exists(false)` 计数把「数据没准备好」与
  // 「真的没人打过」彻底分开：有残留就回落（慢但正确），并留痕催回填。
  const legacyCount = await scopeRepo.memberRatings.countRanked({
    pool, gender: null, memberStatus: null, missingProfile: true,
  });
  if (legacyCount > 0) {
    console.warn(`[rank] 本池还有 ${legacyCount} 条评级缺少 memberStatus（方案 A 回填未完成），榜单回落到全量路径`);
    return ok({
      ok: true,
      schoolName: (ctx.school && ctx.school.shortName) || '',
      message: '',
      ...(await rankingFromScopeView(ctx, activeProject, activeProjectLabel, myId)),
    });
  }

  const total = await scopeRepo.memberRatings.countRanked({
    pool, gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE,
  });

  // 我在本项目的那条评级：listByUser 一次取回全部池，再挑当前池。
  // 未回填的文档没有 memberStatus，按「在册」对待（与旧路径口径一致）。
  const myDocs = myId ? await scopeRepo.memberRatings.listByUser(myId) : [];
  const myDoc = myDocs.find(doc => doc.pool === pool) || null;
  const myEligible = Boolean(myDoc)
    && (myDoc.memberStatus === undefined || myDoc.memberStatus === SCHOOL_MEMBER_STATUS.ACTIVE)
    && (!gender || myDoc.gender === gender);

  const ids = [...new Set([...topDocs.map(doc => doc.userId), myId].filter(Boolean))];
  const userById = new Map((await ctx.repo.users.listByIds(ids)).map(user => [user._id, user]));

  const allRows = buildRows(membersFromRatingDocs(topDocs, userById), activeProject, myId);
  let myRow = allRows.find(row => row.isMe) || null;

  // 榜外也要给「我」一行：me 卡片要名次，搜索要能搜到自己。
  if (!myRow && myEligible && (myDoc.matchCount || 0) > 0) {
    const above = await scopeRepo.memberRatings.countRanked({
      pool, gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE, minElo: myDoc.elo,
    });
    const rank = above + 1;
    const meRows = buildRows(membersFromRatingDocs([myDoc], userById), activeProject, myId);
    if (meRows.length > 0) {
      myRow = { ...meRows[0], rank, medal: medalOf(rank) };
      allRows.push(myRow);
    }
  }

  const rows = allRows.slice(0, TOP_LIMIT);
  return ok({
    ok: true,
    schoolName: (ctx.school && ctx.school.shortName) || '',
    message: '',
    projectTabs: projectTabs(activeProject),
    activeProject,
    activeProjectLabel,
    activeBoardLabel: BOARD_LABEL,
    rows,
    allRows,
    total,
    hasMore: total > rows.length,
    empty: rows.length === 0,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: rows.length === 0 ? '这个项目还没有人打过' : '',
    me: myRow === null
      ? null
      : {
          rank: myRow.rank,
          total: Math.max(total, myRow.rank),
          beatText: `超过 ${formatPercent((Math.max(total, myRow.rank) - myRow.rank) / Math.max(total, myRow.rank))} 的会员`,
        },
    meHint: myRow !== null ? '' : '你还没有参加过这个项目',
  });
}

/**
 * 旧路径（全量回放）。只在「回填未完成」时兜底，正常情况下不该走到这里。
 *
 * 保留它而不是直接删掉：榜单不能因为一次数据迁移没跑完就变成空页——那会让
 * 用户以为数据丢了。代价是这个分支仍要读 120 页，所以它必须响（打日志）。
 *
 * @param {Object} ctx
 * @param {string} activeProject
 * @param {string} activeProjectLabel
 * @param {string} myId
 * @returns {Promise<Object>}
 */
async function rankingFromScopeView(ctx, activeProject, activeProjectLabel, myId) {
  const { members } = await loadScopeView(ctx, { needMatches: false, needPoints: false });
  const allRows = buildRows(members, activeProject, myId);
  const rows = allRows.slice(0, TOP_LIMIT);
  const total = allRows.length;
  const myRow = (myId && allRows.find(row => row.isMe)) || null;
  return {
    projectTabs: projectTabs(activeProject),
    activeProject,
    activeProjectLabel,
    activeBoardLabel: BOARD_LABEL,
    rows,
    allRows,
    total,
    hasMore: total > rows.length,
    empty: rows.length === 0,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: rows.length === 0 ? '这个项目还没有人打过' : '',
    me: myRow === null
      ? null
      : {
          rank: myRow.rank,
          total,
          beatText: `超过 ${formatPercent((total - myRow.rank) / total)} 的会员`,
        },
    meHint: myRow !== null ? '' : '你还没有参加过这个项目',
  };
}

/**
 * 指定会员的评级与赛季积分（供赛事名单 / 详情等展示端按人取数）。
 * ============================================================
 * 【为什么不从榜单反查】
 * 等级分榜会截断（只留前十）且过滤掉「没出过场」的人（见 buildRows），拿它当
 * 数据源会让榜外的报名者显示空白，甚至名次对不上。这里直接回放本范围流水，
 * 按编号取人——榜内榜外一个口径。
 *
 * 【与榜单同源】
 * 取数走 loadScopeView（与榜单同一份视图），因此这里给出的等级分与积分必然
 * 与榜单一致；评级已落库、读请求不写库。
 *
 * 【跨范围只读得到本范围的人】
 * loadScopeView 只装载 primarySchoolId 匹配本范围、且正常在册的会员，请求里
 * 夹带外校编号也取不到——隔离在取数层完成，不靠调用方自觉。
 *
 * @param {Object} [payload] { userIds?: string[] } 省略则返回本范围全部在册会员
 * @param {Object} ctx
 */
async function getSchoolMemberStats(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: false, members: [], message: '没有读取本协会成绩的权限' });
  const wanted = new Set((Array.isArray(payload.userIds) ? payload.userIds : [])
    .filter(id => typeof id === 'string' && id));
  // 只要评级计数（启动时选默认协会用）：不算赛季积分，也不读赛事/训练/训练报名。
  // 没有指定人时这个开关没有意义（全量列表本来就要算积分），直接拒绝，别让它变成
  // 「静默返回一堆没有 points 的行」。
  const ratingsOnly = payload.ratingsOnly === true;
  if (ratingsOnly && wanted.size === 0) {
    return ok({ ok: false, members: [], message: '按人读取评级时必须指定会员编号' });
  }

  // 【指定人就按编号点读，不要整表读】（2026-10-26 只读审查 P2-6）
  // 原实现先 loadScopeView 把全范围名册、账号、评级、赛事、训练、训练报名整表
  // 读回来，最后才按 userIds 过滤——查一个人也读全校一千多条。
  // 现在：学籍与评级按确定性主键批读，训练报名按人下推，积分只在需要时才算。
  if (wanted.size > 0) {
    return ok({ ok: true, members: await statsOfMembers(ctx, [...wanted], { ratingsOnly }), message: '' });
  }

  // ── 只要前 N 名 + 我自己（赛事面板的积分榜）────────────────────────────
  // 【为什么需要这条分支】（2026-10-29 第十二轮审计）
  // 面板只显示前 10 与「我」，原先却要服务端把全校每个会员的评级与积分整份下发，
  // 前端再 `buildPointsRows` 全量排序。2000 人的协会就是 2000 行 JSON 过一遍网络
  // 与一次全量排序，只为取前十。这条分支在服务端排序后只回前 N 与「我」。
  //
  // 排序与前端 `buildPointsRows` 逐字同口径：积分降序，同分按编号升序。前端那份
  // 排行榜的次级判据（胜率 / 胜场 / 最近比赛）在积分榜这里拿不到（成员行不带
  // lastMatchTime），实际不参与比较，所以这里不需要复制整套 buildLeaderboard。
  const top = Number.isInteger(payload.top) && payload.top > 0 ? Math.min(payload.top, 50) : 0;
  if (top > 0) {
    const { members } = await loadScopeView(ctx, { needMatches: false });
    // 离校不过滤：面板原先把 status 硬写成 ACTIVE 再交给 buildPointsRows，
    // 这里保持同一口径，避免「同一个榜在面板与排行榜上人数不同」。
    const rows = members.map(member => memberStatsRow(member))
      .filter(row => Number(row.points) > 0)
      .sort((a, b) => (b.points - a.points)
        || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    const total = rows.length;
    const mine = rows.findIndex(row => row.userId === ctx.actorId);
    return ok({
      ok: true,
      top: rows.slice(0, top).map((row, index) => ({ ...row, rank: index + 1 })),
      me: mine >= 0 ? { ...rows[mine], rank: mine + 1 } : null,
      total,
      message: '',
    });
  }

  // 成绩同榜单：评级已落库，不需要读比赛流水。
  const { members } = await loadScopeView(ctx, { needMatches: false });
  return ok({ ok: true, members: members.map(member => memberStatsRow(member)), message: '' });
}

/** 一个会员行的对外形状（评级四池 + 赛季积分）。全量与按编号两条路共用。 */
function memberStatsRow(member) {
  return {
    userId: member._id,
    nickName: member.nickName || '',
    realName: member.realName || '',
    avatarUrl: member.avatarUrl || '',
    points: Number(member.points || 0),
    ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
      const rating = getPoolRating(member, pool);
      acc[pool] = {
        elo: Number(rating.elo),
        matchCount: Number(rating.matchCount || 0),
        wins: Number(rating.wins || 0),
        losses: Number(rating.losses || 0),
      };
      return acc;
    }, {}),
  };
}

/**
 * 指定这几个人的评级与（可选）赛季积分。
 *
 * 读取量只与「人数 × 池数」有关，与全校会员数无关：
 *   · 学籍：`schoolMembers.listByIds` 按确定性主键批读（1 次）
 *   · 账号：`users.listByIds`（1 次，平台级集合不整表读）
 *   · 评级：按 `memberRatingKey` 逐池批读（1 次，人数 × 池数条）
 *   · 积分：仅在需要时才算，训练报名按人下推（每人 1 次）
 *
 * @param {Object} ctx
 * @param {string[]} userIds
 * @param {{ratingsOnly:boolean}} options
 * @returns {Promise<Array<Object>>}
 */
async function statsOfMembers(ctx, userIds, { ratingsOnly }) {
  const scope = ctx.repo.forScope(ctx);
  const ratingKeys = userIds.flatMap(userId => ALL_RATING_POOLS.map(pool => memberRatingKey(userId, pool, ctx)));
  const [memberRows, users, ratingDocs] = await Promise.all([
    scope.schoolMembers.listByIds(userIds.map(userId => schoolMemberKey(userId, ctx.schoolId))),
    ctx.repo.users.listByIds(userIds),
    scope.memberRatings.listByIds(ratingKeys),
  ]);
  const userById = new Map(users.map(user => [user._id, user]));
  const ratingByKey = new Map(ratingDocs.map(doc => [`${doc.userId}|${doc.pool}`, doc]));

  const members = (Array.isArray(memberRows) ? memberRows : [])
    .map(row => viewMemberOf(row, userById.get(row.userId), ctx.schoolId))
    .filter(Boolean)
    .map(member => ({
      ...member,
      ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
        acc[pool] = ratingByKey.get(`${member._id}|${pool}`) || displayRating(member, pool);
        return acc;
      }, {}),
    }));

  if (ratingsOnly || members.length === 0) return members.map(member => memberStatsRow(member));

  // 【物化优先】（2026-10-29 第十三轮）：积分就在上面那批会员行里，跟得上事实
  // 时**一次额外读都不发**；只有脏了才回退「读三份事实 + 按人下推签到」。
  const season = await loadSeason(ctx);
  let pointsByUser = settledPointsOf(season, memberRows);
  if (!pointsByUser) {
    const [events, trainings, registrations] = await Promise.all([
      scope.events.list(),
      scope.associationTrainings.list(),
      // 只增不减的集合：按人下推，只回这几个人自己的签到记录
      Promise.all(userIds.map(userId => scope.trainingRegistrations.listByUser(userId)))
        .then(rows => rows.flat()),
    ]);
    pointsByUser = aggregatePoints({
      events,
      trainings,
      trainingRegistrations: registrations,
      resetTime: season.resetTime,
      members: members.map(member => ({ userId: member._id })),
    });
  }
  for (const member of members) member.points = pointsByUser.get(member._id) || 0;
  return members.map(member => memberStatsRow(member));
}

/**
 * 指定会员在本范围的赛事名次（「我的」页荣誉与个人详情页共用的读端，B4-c）。
 * ============================================================
 * 【为什么是独立读端】
 * 赛事列表 DTO（eventSummary）刻意保持精简、不带 results；名次是另一类
 * 展示需求（荣誉汇总 + 分组列表）。这里只读本范围已结束赛事的结果，复用
 * 旧栈纯构建器 buildEventRecord / summarizeEvents（同一把尺子），只回
 * 展示字段，不把报名、抽签、内部状态透出去。
 *
 * @param {Object} [payload] { userId } 看谁的名次；本协会成绩读权限持有者可用
 * @param {Object} ctx
 */
async function getSchoolMemberHonors(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成绩的权限'));
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return ok(refused('缺少会员编号'));
  const events = (await ctx.repo.forScope(ctx).events.list()).filter(isEventDoc);
  const records = buildEventRecord(events, userId).map((row) => ({
    eventId: row.eventId,
    title: row.title || '',
    startTime: row.startTime || '',
    placement: Number(row.placement),
    participantCount: Number(row.participantCount),
  }));
  return ok({ ok: true, honors: { summary: summarizeEvents(records), records }, message: '' });
}

/* ------------------------------------------------------------------ 赛季 */

/**
 * 个人主页的全部数据（B4-c 的取数口）：卡片 + 项目 + 走势 / 交锋 / 搭档 /
 * 逐场战绩 / 近期状态 + 本范围赛事荣誉。
 * ============================================================
 * 【为什么一次取齐】个人页的七个板块（走势、交锋、搭档、荣誉、逐场……）全部
 * 依赖同一份「本范围回放后的流水」，客户端逐块取会重放七遍，还容易各拿一份
 * 时点不一致的数据。这里回放一次，七个纯构建器（utils/stats.js，同一把尺子）
 * 各取所需。
 *
 * 【口径】流水用计等级分的场次（与榜单一致：isEloEligibleMatch + 防刷分上限），
 * 所以逐场战绩与等级分榜的走势严格一致；已撤销 / 待确认的比赛不进个人战绩。
 * 项目 / 名次口径与旧栈 getMyProjects 一致（出场过的项目、分池、分性别）。
 *
 * @param {Object} [payload] { userId?, historyLimit? } 不传 userId 即本人
 * @param {Object} ctx
 */
async function getSchoolMemberProfile(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成绩的权限'));
  const userId = typeof payload.userId === 'string' && payload.userId ? payload.userId.trim() : ctx.actorId;
  if (!userId) return ok(refused('缺少会员编号'));
  // 同 getSchoolMember：userId 会拼进 _id，超长会让 schoolKey 抛错并被兜成「服务异常」
  // （2026-10-28 审计 2 B-3）。
  if (userId.length > 128) return ok(refused('会员编号格式不正确'));
  const historyLimit = Number.isInteger(payload.historyLimit) && payload.historyLimit > 0
    ? Math.min(payload.historyLimit, 200) : 20;

  // 【取数为什么长这样】（2026-10-23 方案 A 第 4 步，接 H-2 的剩余项）
  // 上一轮已经把「比赛」与「训练报名」按人下推，剩下的 120 页全在**排名**：
  // 「我在同项目排第几」要拿全范围评级（80 页）+ 名册（40 页）当分母。
  // 方案 A 之后这件事变成两次聚合计数：
  //   · 比我高的人数 + 1 = 名次     · 同条件下的总人数 = 分母
  // 都不读文档。个人主页因此不再需要「全班花名册」这个中间物。
  const scopeRepo = ctx.repo.forScope(ctx);
  const [userDoc, memberDoc, role, membership, colleges, myRatingDocs, residual] = await Promise.all([
    ctx.repo.users.getById(userId),
    ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)),
    ctx.repo.schoolRoles.getById(schoolRoleKey(userId, ctx.schoolId)),
    ctx.repo.memberships.get(schoolMembershipKey(userId, ctx)),
    loadColleges(ctx),
    scopeRepo.memberRatings.listByUser(userId),
    // 回填监控（与榜单同一把尺子）：只要有评级文档缺 memberStatus，分母就会偏小，
    // 名次会虚高。这时退回旧的全量口径，慢但正确。
    scopeRepo.memberRatings.countRanked({ pool: null, missingProfile: true }),
  ]);
  // 口径与旧路径一致：本人账号可用、本校在册、归属本校（三者缺一就是「没有这位会员」）
  if (!userDoc || userDoc.platformStatus !== PLATFORM_STATUS.ACTIVE
      || !memberDoc || memberDoc.status !== SCHOOL_MEMBER_STATUS.ACTIVE
      || userDoc.primarySchoolId !== ctx.schoolId) {
    return ok({ ok: false, found: false, message: '没有找到这位会员' });
  }

  // 只读「我参与过的」比赛，并按与整范围视图同一口径连成 Elo 链
  const myMatches = await scopeRepo.matches.listPage({ filter: { userId }, limit: PROFILE_MATCH_FETCH });
  const matches = ratedMatchesOf(myMatches.rows);

  // 积分与荣誉所需的赛事 / 训练事实：整表但量级小（events 2~3 页、训练 1 页），
  // 训练报名按人下推。赛事分要挂到「我」的最后一场上，故在拿到 matches 之后做。
  const facts = await loadProfileFacts(ctx, userId);
  mountEventPointDeltas(matches, facts.pointFacts);

  // 把账号与本人评级拼成「会员」形状：下游（getPoolRating / projects）都吃这个结构。
  const ratingByPool = new Map(myRatingDocs.map(doc => [doc.pool, doc]));
  const member = {
    ...userDoc,
    status: USER_STATUS.ACTIVE,
    points: facts.points,
    ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
      acc[pool] = ratingByPool.get(pool) || displayRating(userDoc, pool);
      return acc;
    }, {}),
  };
  const events = facts.events;

  // 榜外名次的兜底口径：回填未完成时用全量榜单重算（懒加载，正常情况下不读）
  let legacyMembers = null;
  const membersForBoard = async () => {
    if (!legacyMembers) {
      legacyMembers = (await loadScopeView(ctx, { needMatches: false, needPoints: false })).members;
    }
    return legacyMembers;
  };

  const collegeName = id => (colleges.find(row => row.collegeId === id) || {}).name || '';
  // 交锋 / 搭档 / 逐场都要对手昵称。原来从「全班名册」里 find（依赖那 40 页读），
  // 现在只按这几百场比赛里出现过的对手批读一次——通常几十人，1 页内。
  const opponentIds = new Set();
  for (const match of matches) {
    for (const player of (match.players || [])) {
      if (player.userId && player.userId !== userId) opponentIds.add(player.userId);
    }
  }
  const opponents = opponentIds.size > 0 ? await ctx.repo.users.listByIds([...opponentIds]) : [];
  const nameById = new Map(opponents.map(user => [user._id, user.nickName || user._id]));
  const nameOf = id => nameById.get(id) || id;

  // 项目（与旧栈 getMyProjects 同口径）：出场过的、按性别过滤的单打 + 双打
  const projects = [];
  for (const project of ALL_RANK_PROJECTS) {
    const { pool, gender } = RANK_PROJECT_CONFIG[project];
    if (gender && member.gender !== gender) continue;
    const bucket = getPoolRating(member, pool);
    if (!bucket || bucket.matchCount === 0) continue;
    let rank = null;
    let total = 0;
    let beatPercent = 0;
    if (residual > 0) {
      // 回填未完成：分母不可信，退回内存榜
      const board = buildProjectLeaderboard(await membersForBoard(), project);
      const stats = percentileFromBoard(board, userId);
      rank = stats ? stats.rank : null;
      total = stats ? stats.total : board.length;
      beatPercent = stats ? stats.beatPercent : 0;
    } else {
      total = await scopeRepo.memberRatings.countRanked({
        pool, gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE,
      });
      const above = await scopeRepo.memberRatings.countRanked({
        pool, gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE, minElo: bucket.elo,
      });
      rank = total > 0 ? above + 1 : null;
      // 分母用 total（第 1 名显示「超过 99%」与 percentileFromBoard 同口径）
      beatPercent = total > 0 ? Number((((total - rank) / total) * 100).toFixed(1)) : 0;
    }
    projects.push({
      project, pool, label: RANK_PROJECT_LABEL[project],
      elo: bucket.elo, startElo: bucket.startElo, delta: bucket.elo - bucket.startElo,
      matchCount: bucket.matchCount, wins: bucket.wins, losses: bucket.losses,
      rank, total, beatPercent,
    });
  }
  projects.sort((a, b) => b.matchCount - a.matchCount);
  const active = projects[0] || null;
  const poolFilter = active ? active.pool : null;

  const ratingHistory = active ? buildRatingHistory(matches, userId, active.pool, { order: "settlement" }) : [];
  const headToHead = buildHeadToHead(matches, userId, { nameOf, pool: poolFilter });
  const partners = buildPartnerRecord(matches, userId, { nameOf, pool: poolFilter });
  const history = buildMatchHistory(matches, userId, { nameOf, pool: poolFilter, limit: historyLimit });
  const form = summarizeForm(matches, userId, { limit: 5 });
  const eventRecords = buildEventRecord(events.filter(isEventDoc), userId);

  return ok({
    ok: true, found: true, message: '',
    // 本人账号 / 档案展示字段；权限档只作展示，服务端写路径另行判权。
    user: {
      userId,
      nickName: member.nickName || '',
      realName: member.realName || '',
      avatarUrl: member.avatarUrl || '',
      gender: member.gender || '',
      collegeId: (memberDoc && memberDoc.collegeId) || '',
      college: collegeName((memberDoc && memberDoc.collegeId) || ''),
      ...(userId === ctx.actorId || canSchoolAction(ctx, 'reviewMembers', ctx)
        ? { studentId: (memberDoc && memberDoc.studentId) || '' } : {}),
      points: Number(member.points || 0),
      permissionLabel: permissionLabelOf(role, membership),
      // 权限档位的机器可读值（schoolAdmin / associationLeader / collegeLeader / 空）：
      // 他人主页的「设置身份」要判断对方当前已经是哪一档，才能给出「取消」而不是重复授予。
      permission: permissionOf(role, membership),
      role: legacyRoleOf({ schoolRole: role, membership, actor: member, isPlatformAdmin: member.platformRole === 'admin' }),
    },
    projects,
    active: active ? active.project : null,
    ratingHistory,
    headToHead,
    partners,
    history,
    form,
    honors: {
      summary: summarizeEvents(eventRecords),
      records: eventRecords.map(row => ({
        eventId: row.eventId, title: row.title || '', startTime: row.startTime || '',
        placement: Number(row.placement), participantCount: Number(row.participantCount),
      })),
    },
  });
}

/* ------------------------------------------------------------------ 赛季 */

/**
 * 读本范围的赛季状态。任何有读权限的会员都能看。
 * @param {Object} [payload]
 * @param {Object} ctx
 */
async function getSchoolSeason(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会赛季的权限'));
  const season = await loadSeason(ctx);
  return ok({
    ok: true,
    message: '',
    season: {
      seasonNumber: Number(season.seasonNumber || 1),
      anchorTime: season.anchorTime || null,
      resetTime: season.resetTime || null,
      version: Number(season.version || 0),
    },
  });
}

/**
 * 开始新赛季：写下分界点，赛季编号 +1。
 *
 * 【权限】与旧栈同一门槛（canResetSeason → canManage({minRole: ADMIN})）：
 * 平台管理员、校管理员、协会负责人可开新赛季，普通会员与学院负责人不行。
 *
 * 【只做两件事】记分界时间、编号 +1。等级分不参与重置，跨赛季连续累计；
 * 分界点之前的赛事 / 训练积分不计入本赛季（回放据此过滤）。锚点已定则不动。
 *
 * @param {Object} [payload] { resetTime? }
 * @param {Object} ctx
 */
async function resetSchoolSeason(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  // 【2026-10-26 第六轮 D】目录只喂给 legacyActorOf（它只取 actorCollege），
  // 不再为一次「能不能重置赛季」读全校名册。
  const dir = await actorDirectory(ctx);
  if (!canResetSeason(legacyActorOf(ctx, dir))) return ok(refused('只有管理员可以开始新赛季'));

  // 分界点由客户端传入，但必须是个能解析的时间。NaN 会顺着 resetTime 流进
  // 积分切分与交手名额计数，报错点离现场很远（2026-10-17 只读审计 C6）。
  // 校验放在事务外：明显非法的请求不必占一个事务。
  const requested = payload.resetTime === undefined || payload.resetTime === null
    ? null : new Date(payload.resetTime);
  if (requested && !Number.isFinite(requested.getTime())) {
    return ok(refused('赛季分界时间无效'));
  }

  const id = seasonKeyOf(ctx);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await require('./school-context.js').buildSchoolContext({
      repo: tx, actorId: ctx.actorId, scope: ctx, now: ctx.now,
    });
    if (!canReadAssociationSpace(fresh) || !canResetSeason(legacyActorOf(fresh, dir))) {
      return refused('只有当前有效的管理员可以开始新赛季');
    }
    const existing = await tx.seasons.getById(id);
    const base = existing && belongsToSchoolScope(existing, ctx) ? existing : defaultSeason(ctx);
    const resetTime = requested || ctx.now;
    const next = {
      ...base,
      _id: id,
      schoolId: ctx.schoolId,
      association: ctx.association,
      anchorTime: base.anchorTime || null,
      resetTime,
      seasonNumber: Number(base.seasonNumber || 1) + 1,
      version: Number(base.version || 0) + 1,
      updatedAt: new Date(ctx.now),
    };
    await tx.seasons.set(id, next);
    return {
      ok: true,
      message: '',
      season: {
        seasonNumber: next.seasonNumber,
        anchorTime: next.anchorTime,
        resetTime: next.resetTime,
        version: next.version,
      },
    };
  });
  // 重置**不做**即时重算（2026-10-29 第十三轮）：代际已经 +1，读取端从此回退实时
  // 聚合，分数正确；而此刻重算要把全校会员行按「旧分 → 0」逐行写一遍，等于用
  // 几百次写换一次读。下一次结算/签到确认会顺手把旧分与旧锚点清掉。
  return ok(result);
}

module.exports = {
  BOARD_LABEL,
  TOP_LIMIT,
  medalOf,
  badgeOf,
  defaultSeason,
  loadSeason,
  seasonKeyOf,
  buildRows,
  getSchoolRanking,
  getSchoolMemberStats,
  getSchoolMemberHonors,
  getSchoolMemberProfile,
  getSchoolSeason,
  resetSchoolSeason,
};
