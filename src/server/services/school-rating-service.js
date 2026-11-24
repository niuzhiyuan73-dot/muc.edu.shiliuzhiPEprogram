/**
 * 学校维度：单场 Elo 结算服务（Elo 逐场结算改造）
 * ============================================================
 * 【这条链路取代什么】
 * 旧体系「按 scope 重放全部 matches 流水推导等级分」（replay.js 两遍回放）。
 * 改造后当前评级落库（member_ratings 集合），比赛**确认时在同一个事务里逐场
 * 结算**：点读全部参赛者的评级 → 纯函数算一次变动 → 写评级 + 范围序号 + 结算
 * 快照。历史分差以比赛上的结算快照为准，永不由当前评级反推。
 *
 * 【分工】
 *   · 上半部是**纯函数**：计分资格判定、赛前评级视图物化、结算快照与评级更新
 *     的组装。不碰仓储、不碰时钟——输入相同，输出永远相同，可以脱离数据库
 *     单测每一处数学与不变式；
 *   · 下半部 `settleMatchInTransaction` 是**事务读写**：在调用方开启的事务里
 *     点读评级与序号计数、惰性建档、计算并落盘。它绝不自己开嵌套事务；赛事
 *     推进等事务外副作用由调用方在事务成功后做（幂等推进，交接文档 §6 约束 7）。
 *
 * 【固定起评分，不再对手推导定级】
 * 新评级文档的起点分按性别取（男 1450 / 女 1300，见 elo.initialRatingFor），
 * 首次建档即冻结 startElo 与初始化来源；之后改性别、改默认初始分都**不会**
 * 重置已存在的评级。若会员档案带管理员预设的 initialElo（审核入口写入），
 * 仅在该会员本池**首次建档**时生效；出场后的调分属「当前评级调整」，不走这里。
 *
 * 【结算顺序】
 * settlementSeq 是学校/协会范围级递增序号，由 rating_counters 的一条计数文档
 * 在事务内原子分配——它决定 Elo 变化链的顺序。同范围确认因此在该文档上串行
 * 竞争，当前规模下可接受（实施取舍，交接文档 §4.2）。
 * **不计分比赛不占序号**：它不进 Elo 链，快照的 settlementSeq 为 null。
 *
 * 【补录旧比赛】
 * 按当前结算位置入链，不插历史、不改任何已结算快照；lastMatchTime 记录实际
 * 发生时间，补录旧日期不会把活跃时间倒退（lastSettledAt 单独记录结算时间）。
 * ============================================================
 */

const {
  ALL_RATING_POOLS, SETTLEMENT_STATUS, EXCLUSION_REASON,
  ALGORITHM_VERSION, MATCH_COMPETITION, MATCH_OUTCOME,
} = require('../../shared/utils/constants.js');
const {
  initialRatingFor, calculateMatchRatings, DEFAULT_CONFIG,
} = require('../../shared/utils/elo.js');
const {
  memberRatingKey, ratingSeqKey, belongsToSchoolScope, schoolScope, schoolMemberKey, SCHOOL_MEMBER_STATUS,
} = require('../../shared/utils/school.js');
const { allAssociations } = require('../../shared/utils/associations.js');
const { isDoublesDiscipline } = require('../../shared/services/college-tie.js');

/* ------------------------------------------------------------------ 纯函数 */

/** 校验有限数字；评级是金额式状态，NaN / Infinity 一律拒绝。 */
function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数字，收到：${String(value)}`);
  }
  return value;
}

/** 非负整数（场数 / 版本 / 序号用）。 */
function assertNonNegativeInt(value, label) {
  assertFiniteNumber(value, label);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数，收到：${String(value)}`);
  }
  return value;
}

/**
 * 评级文档的静态校验：已有评级损坏时**拒绝结算并报告**，
 * 不允许悄悄当作初始值覆盖（交接文档 §5.1）。
 */
function assertValidRatingDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('评级文档缺失');
  assertFiniteNumber(doc.elo, '评级 elo');
  assertFiniteNumber(doc.startElo, '评级 startElo');
  assertNonNegativeInt(doc.matchCount, '评级 matchCount');
  assertNonNegativeInt(doc.wins, '评级 wins');
  assertNonNegativeInt(doc.losses, '评级 losses');
  assertNonNegativeInt(doc.version || 0, '评级 version');
  return doc;
}

/**
 * 新建一份评级文档（惰性初始化，首次结算时随事务写入）。
 *
 * startElo 在建档那一刻冻结，并记下初始化来源留痕；此后改性别、改默认初始分
 * 都不重置这份文档。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.pool 池名，见 RATING_POOL
 * @param {Object} params.scope { schoolId, association }
 * @param {number} params.startElo 冻结的起点分
 * @param {string} [params.startSource] 'gender' | 'preset'，初始化来源留痕
 * @param {Date|string|number} [params.now]
 * @returns {Object} 可直接写入 member_ratings 的完整文档
 */
function buildRatingDoc({
  userId, pool, scope, startElo, startSource = 'gender',
  gender = '', memberStatus = SCHOOL_MEMBER_STATUS.ACTIVE, now = null,
}) {
  if (!ALL_RATING_POOLS.includes(pool)) throw new Error(`未知的评级池：${pool}`);
  if (!userId || typeof userId !== 'string') throw new Error('评级建档缺少用户编号');
  const s = schoolScope(scope);
  const start = assertFiniteNumber(startElo, '起点分');
  const at = now ? new Date(now).toISOString() : null;
  return {
    _id: memberRatingKey(userId, pool, scope),
    schoolId: s.schoolId,
    association: s.association,
    userId,
    pool,
    elo: start,
    startElo: start,
    // 初始化留痕：解释「这份评级的起点分是哪来的」，审计与核账用。
    startSource,
    // ── 以下两个是**冗余字段**，权威值在 users.gender / school_members.status ──
    //
    // 【为什么要冗余】（2026-10-23 成员档案物化评估 方案 A）
    // 榜单要按「项目（性别）」筛、要排除已退会的人，而这两个字段原本只存在
    // 另外两个集合里。数据库不能跨集合 join，榜单只能把 8000 条评级全读回来
    // 在内存里算（80 页 RPC）——冗余之后可以一条查询出前 10 名、一次计数出
    // 我的名次（约 3 个 RPC）。
    //
    // 【怎么保持一致】两个字段各有**唯一**的维护者，不做双向同步：
    //   · gender：结算与同步都写。结算路径本来就为算起点分点读了 users，
    //     顺手把 gender 带进文档（零额外读）；改档另走
    //     syncRatingProfileInTransaction。
    //   · memberStatus：**只在会籍变更路径写**，结算路径一概不动它。理由：
    //     结算含「补录旧比赛」，结算那一刻不代表此人当下在册，用它写状态会把
    //     已转出的人改回 active。会籍的 2 处写入点（入会通过、转校通过）都调
    //     syncRatingProfileInTransaction。
    //   两者仍可能与权威值分叉（历史文档缺字段、直接改库、脚本中断），以
    //   users.gender / school_members.status 为准重跑回填即可——回填是幂等的，
    //   tools/backfill-rating-profile.js 用的就是这条口径。
    gender: String(gender || ''),
    memberStatus,
    matchCount: 0,
    wins: 0,
    losses: 0,
    lastMatchTime: null,
    lastSettledAt: null,
    lastSettlementSeq: null,
    lastLedgerId: null,
    version: 0,
    algorithmVersion: ALGORITHM_VERSION,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 读端兜底：未建档的会员返回按性别的展示值，**不写库**
 * （读取请求不得偷偷建评级，交接文档 §4.1 / §5.4）。
 *
 * @param {Object|null} user 用户文档（取 gender）
 * @param {string} pool 池名
 * @returns {Object} 展示用评级形状（与评级文档同字段名）
 */
function displayRating(user, pool) {
  if (!ALL_RATING_POOLS.includes(pool)) throw new Error(`未知的评级池：${pool}`);
  const start = initialRatingFor(user && user.gender);
  return {
    elo: start,
    startElo: start,
    startSource: 'gender',
    matchCount: 0,
    wins: 0,
    losses: 0,
    lastMatchTime: null,
    lastSettledAt: null,
    lastSettlementSeq: null,
    lastLedgerId: null,
    version: 0,
  };
}

/**
 * 这场比赛确认生效后，是计分还是不计分？
 *
 * 口径与旧回放的 isEloEligibleMatch 完全一致（D41 / D25）：
 *   弃权         —— 不计（对阵照常推进，但不产生等级分）
 *   学院赛双打   —— 不计（只汇总大场）
 *   其余         —— 计
 * 状态不在这里判：本函数在「确认生效」的事务里调用，状态由调用方保证走向 ACTIVE。
 *
 * @param {Object} match
 * @returns {{rated:boolean, exclusionReason:string|null}}
 */
function decideSettlement(match) {
  if (!match) throw new Error('缺少比赛记录');
  if (match.outcome === MATCH_OUTCOME.FORFEIT) {
    return { rated: false, exclusionReason: EXCLUSION_REASON.FORFEIT };
  }
  if (match.competition === MATCH_COMPETITION.COLLEGE && isDoublesDiscipline(match.discipline)) {
    return { rated: false, exclusionReason: EXCLUSION_REASON.COLLEGE_DOUBLES };
  }
  return { rated: true, exclusionReason: null };
}

/**
 * 赛事等级的取值优先级：match.level > event.level > 无（日常 K）。
 * 与旧回放引擎（已删除）的 eventLevel 解析同一优先级，并写进快照留痕；
 * 不信任客户端提交的 level——event 必须是调用方在事务内点读到的赛事文档。
 *
 * @param {Object} match
 * @param {Object|null} event 赛事文档（无赛事的比赛传 null）
 * @returns {number|undefined} undefined = 日常 K
 */
function resolveEventLevel(match, event) {
  if (match.level !== undefined && match.level !== null) return match.level;
  if (event && event.level !== undefined && event.level !== null) return event.level;
  return undefined;
}

/** 一场比赛的全部参赛者（A 队在前），并校验人数与去重。 */
function participantsOf(match) {
  const teamA = Array.isArray(match.teamA) ? match.teamA : [];
  const teamB = Array.isArray(match.teamB) ? match.teamB : [];
  if (![teamA.length, teamB.length].every((n) => n === 1 || n === 2)) {
    throw new Error(`参赛人数不合法：A 队 ${teamA.length} 人、B 队 ${teamB.length} 人（各队 1 或 2 人）`);
  }
  if (teamA.length !== teamB.length) {
    throw new Error(`两队人数必须相同：A 队 ${teamA.length} 人、B 队 ${teamB.length} 人`);
  }
  const all = [...teamA, ...teamB];
  if (all.some((id) => !id || typeof id !== 'string')) throw new Error('参赛者编号缺失');
  if (new Set(all).size !== all.length) throw new Error('同一位会员不能同时出现在两队');
  return { teamA, teamB };
}

/**
 * 物化赛前评级视图：已有的严格校验后原样用，缺失的按起点分在内存里建档。
 * 调用方把这份 Map 传给 computeSettlement，并在结算后把内存新建的文档随事务
 * 写入——「点读全部评级，缺失按固定起点初始化」（交接文档 §6）。
 *
 * @param {Object} params
 * @param {string[]} params.userIds 全部参赛者（去重后）
 * @param {string} params.pool 本场评级池
 * @param {Object} params.scope { schoolId, association }
 * @param {Map<string,Object>} params.existingByUser userId → 事务内读到的评级文档（可缺）
 * @param {Map<string,Object>} [params.startEloByUser] userId → { startElo, startSource, gender }（建档用）
 * @param {Date|string|number} params.now
 * @returns {Map<string,Object>} userId → 参与本次结算的评级文档（含内存新建的）
 */
function materializeRatings({ userIds, pool, scope, existingByUser, startEloByUser, now }) {
  if (!ALL_RATING_POOLS.includes(pool)) throw new Error(`未知的评级池：${pool}`);
  const view = new Map();
  for (const userId of userIds) {
    const existing = existingByUser.get(userId);
    if (existing) {
      if (existing.pool !== pool) {
        throw new Error(`评级池不一致：文档 ${existing.pool}，比赛 ${pool}`);
      }
      view.set(userId, assertValidRatingDoc(existing));
      continue;
    }
    const preset = startEloByUser && startEloByUser.get(userId);
    const start = preset && preset.startElo !== undefined
      ? preset.startElo
      : initialRatingFor(preset && preset.gender);
    view.set(userId, buildRatingDoc({
      userId, pool, scope,
      startElo: start,
      startSource: preset && preset.startSource ? preset.startSource : 'gender',
      // 性别随建档一起冗余进来：调用方本来就为算起点分读过它，零额外读。
      gender: preset && preset.gender,
      now,
    }));
  }
  return view;
}

/** 快照里的单个参赛者条目。 */
function playerSnapshot(player, userId, side, pool, winner, versionBefore) {
  const isWin = winner === 'DRAW' ? null : winner === side;
  return {
    userId,
    side,
    pool,
    isWin,
    eloBefore: player.before,
    eloDelta: player.delta,
    eloAfter: player.after,
    ratingVersionBefore: versionBefore,
    ratingVersionAfter: versionBefore + 1,
  };
}

/**
 * 纯计算一场计分比赛的结算快照与各参赛者的评级文档更新。
 *
 * 「赛前的分」必须来自事务内点读到的评级（或惰性初始化的起点分），绝不用
 * 事务外的值算完直接覆盖数据库（交接文档 §6 约束 3）。同一选手并发两场时，
 * 后一个事务冲突重试后重读本函数，天然不会丢更新。
 *
 * @param {Object} params
 * @param {Object} params.match 比赛文档（终态：已带 winner 与 pool）
 * @param {number|undefined} params.eventLevel 赛事等级（undefined = 日常 K）
 * @param {Map<string,Object>} params.ratingsByUser userId → 赛前评级视图（materializeRatings 的产物）
 * @param {number} params.seq 范围结算序号（已由调用方原子分配）
 * @param {Date|string|number} params.settledAt 服务端结算时间（客户端不可指定）
 * @param {Object} [params.config] 传给 elo.calculateMatchRatings 的配置覆盖
 * @param {Map<string,{gender:string}>} [params.profileByUser] userId → 账号档案（刷新冗余 gender）
 * @returns {{settlement:Object, ratingDocs:Array<{userId, doc:Object}>}}
 */
function computeSettlement({
  match, eventLevel, ratingsByUser, seq, settledAt, config, profileByUser,
}) {
  const pool = match.pool;
  if (!ALL_RATING_POOLS.includes(pool)) throw new Error(`未知的评级池：${pool}`);
  const { teamA, teamB } = participantsOf(match);
  const winner = match.winner;
  if (!['A', 'B', 'DRAW'].includes(winner)) throw new Error(`比赛胜负不合法：${String(winner)}`);
  assertNonNegativeInt(seq, '结算序号');

  const teamInputs = (ids) => ids.map((userId) => {
    const doc = ratingsByUser.get(userId);
    if (!doc) throw new Error(`缺少赛前评级视图：${userId}`);
    return { rating: doc.elo, matchCount: doc.matchCount };
  });

  // ── 数学沿用：单场公式与旧引擎调用同一个 calculateMatchRatings ──
  const result = calculateMatchRatings({
    teamA: teamInputs(teamA),
    teamB: teamInputs(teamB),
    winner,
    config,
    eventLevel,
  });

  const settledAtIso = new Date(settledAt).toISOString();
  const players = [
    ...result.teamA.map((row, i) => playerSnapshot(row, teamA[i], 'A', pool, winner,
      ratingsByUser.get(teamA[i]).version || 0)),
    ...result.teamB.map((row, i) => playerSnapshot(row, teamB[i], 'B', pool, winner,
      ratingsByUser.get(teamB[i]).version || 0)),
  ];

  const settlement = {
    id: match._id, // 由比赛 ID 确定的稳定 ID
    status: SETTLEMENT_STATUS.RATED,
    exclusionReason: null,
    settledAt: settledAtIso,
    settlementSeq: seq,
    algorithmVersion: ALGORITHM_VERSION,
    // 快照里保存**实际采用**的参数：只存一个版本名不足以解释历史（交接文档 §5.2）。
    configSnapshot: {
      divisor: (config && config.divisor) || DEFAULT_CONFIG.divisor,
      k: result.teamA[0].k,
      zeroSum: config && config.zeroSum !== undefined ? config.zeroSum : DEFAULT_CONFIG.zeroSum,
      eventLevel: eventLevel === undefined ? null : eventLevel,
      initialRating: (config && config.initialRating) || DEFAULT_CONFIG.initialRating,
      genderInitialGap: (config && config.genderInitialGap) || DEFAULT_CONFIG.genderInitialGap,
    },
    pool,
    expectedA: result.expectedA,
    expectedB: result.expectedB,
    players,
  };

  // ── 评级文档更新：每池每场 version +1；双打四人各自进一版，其他池不动 ──
  const matchTimeIso = match.matchTime ? new Date(match.matchTime).toISOString() : null;
  const ratingDocs = players.map((p) => {
    const before = ratingsByUser.get(p.userId);
    const profile = profileByUser && profileByUser.get(p.userId);
    const isWin = p.isWin === true;
    const isDraw = p.isWin === null;
    // lastMatchTime 表示实际发生时间的最大值：补录旧比赛不能把活跃时间倒退
    // （lastSettledAt 记录的是服务端结算时间，两条时间轴不混用，交接文档 §4.2）。
    const lastMatchTime = matchTimeIso && (!before.lastMatchTime || matchTimeIso > before.lastMatchTime)
      ? matchTimeIso
      : before.lastMatchTime;
    return {
      userId: p.userId,
      doc: {
        ...before,
        elo: p.eloAfter,
        matchCount: before.matchCount + 1,
        wins: before.wins + (isWin ? 1 : 0),
        losses: before.losses + (isWin || isDraw ? 0 : 1),
        lastMatchTime,
        lastSettledAt: settledAtIso,
        lastSettlementSeq: seq,
        lastLedgerId: match._id,
        version: (before.version || 0) + 1,
        algorithmVersion: ALGORITHM_VERSION,
        // 冗余 gender 按账号**逐场刷新**：结算前已经点读过 users，这里是零成本。
        // 只在调用方给了档案时才覆盖，纯函数单测（不给 profileByUser）保持原值。
        // memberStatus 不在这里写——见 buildRatingDoc 里「怎么保持一致」。
        ...(profile && profile.gender !== undefined
          ? { gender: String(profile.gender || '') }
          : {}),
      },
    };
  });

  return { settlement, ratingDocs };
}

/**
 * 不计分比赛的「不计分」结算决定（交接文档 §4.3）：
 * 也落一份一次性快照并写明原因，避免后来修改规则让这场突然获得分数。
 * 不占结算序号（不进 Elo 链），不产生评级更新。
 *
 * @param {Object} params
 * @param {Object} params.match
 * @param {string} params.exclusionReason 见 EXCLUSION_REASON
 * @param {Date|string|number} params.settledAt
 * @returns {Object} settlement 快照
 */
function buildExcludedSettlement({ match, exclusionReason, settledAt }) {
  if (!Object.values(EXCLUSION_REASON).includes(exclusionReason)) {
    throw new Error(`未知的排除原因：${String(exclusionReason)}`);
  }
  return {
    id: match._id,
    status: SETTLEMENT_STATUS.EXCLUDED,
    exclusionReason,
    settledAt: new Date(settledAt).toISOString(),
    settlementSeq: null,
    algorithmVersion: ALGORITHM_VERSION,
    configSnapshot: null,
    pool: match.pool || null,
    expectedA: null,
    expectedB: null,
    players: [],
  };
}

/* ------------------------------------------------------------------ 事务读写 */

/**
 * 会员在某协会的预设初始分：新结构 `initialEloByAssoc` 优先，旧全局字段兜底。
 * 与 member-review 的 `resolvedInitialElo` 同一口径，但只保留这 5 行，
 * 避免把协议 1 的旧服务拉进评级结算路径。
 */
function presetInitialElo(member, association) {
  const map = member && member.initialEloByAssoc;
  if (map && association && Number.isFinite(map[association])) return map[association];
  if (member && Number.isFinite(member.initialElo)) return member.initialElo;
  return null;
}

/**
 * 在调用方开启的事务里结算一场比赛（交接文档 §6 的核心流程）。
 *
 * 职责边界：只写 **评级表 + 序号计数**，并返回结算快照；比赛文档（ACTIVE +
 * 快照）与审计由调用方在同一事务里写——这样 confirm / 弃权 / 其他终态路径
 * 可以共用同一个结算入口，而比赛状态的写法各路径自己管。
 *
 * 幂等：比赛已带结算快照时直接返回既有结果（同一个比赛 ID 只能结算一次，
 * 换请求 ID 也不行——防重不依赖请求 ID，交接文档 §6 约束 5）。
 *
 * @param {Object} tx 事务内仓储（顶层集合操作即可，归属自校验）
 * @param {Object} ctx { schoolId, association, actorId, now }
 * @param {Object} match 比赛文档（事务内按主键重读到的最新态）
 * @param {Object} [options]
 * @param {Object|null} [options.event] 所属赛事文档（事务内点读；决定赛事 K）
 * @param {Object} [options.config] 传给 elo 的配置覆盖（测试注入用）
 * @returns {Promise<{rated:boolean, alreadySettled:boolean, settlement:Object}>}
 */
async function settleMatchInTransaction(tx, ctx, match, options = {}) {
  if (!match || !match._id) throw new Error('缺少比赛记录');
  if (!belongsToSchoolScope(match, ctx)) throw new Error('比赛不属于当前学校或协会');

  // 已有最终结算：鉴权由调用方完成，这里只保证不加分、可重试取结果。
  if (match.settlement && match.settlement.id) {
    return {
      rated: match.settlement.status === SETTLEMENT_STATUS.RATED,
      alreadySettled: true,
      settlement: match.settlement,
    };
  }

  const decision = decideSettlement(match);
  if (!decision.rated) {
    return {
      rated: false,
      alreadySettled: false,
      settlement: buildExcludedSettlement({
        match, exclusionReason: decision.exclusionReason, settledAt: ctx.now,
      }),
    };
  }

  const pool = match.pool;
  const { teamA, teamB } = participantsOf(match);
  const userIds = [...new Set([...teamA, ...teamB])];

  // ── 点读参赛者档案：起点分（性别 + 管理员预设 initialElo，仅建档时生效）──
  // 同一趟点读同时收集 gender，供「刷新评级冗余字段」用，不额外读账号。
  const startEloByUser = new Map();
  const profileByUser = new Map();
  for (const userId of userIds) {
    const user = await tx.users.getById(userId);
    const gender = (user && user.gender) || '';
    // 管理员预设初始分按协会存在会员行上；旧账号仍可能只有 user.initialElo。
    const member = await tx.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId));
    const memberElo = presetInitialElo(member, ctx.association);
    const userElo = user && typeof user.initialElo === 'number' && Number.isFinite(user.initialElo)
      ? user.initialElo : null;
    const presetElo = Number.isFinite(memberElo) ? memberElo : userElo;
    const preset = Number.isFinite(presetElo)
      ? { startElo: presetElo, startSource: 'preset', gender }
      : { gender, startSource: 'gender' };
    startEloByUser.set(userId, preset);
    profileByUser.set(userId, { gender });
  }

  // ── 点读全部评级；缺失的按固定起点在内存里建档（随本事务一并写入）──
  const existingByUser = new Map();
  for (const userId of userIds) {
    const doc = await tx.memberRatings.getById(memberRatingKey(userId, pool, ctx));
    if (doc) existingByUser.set(userId, doc);
  }
  const ratingsByUser = materializeRatings({
    userIds, pool, scope: ctx, existingByUser, startEloByUser, now: ctx.now,
  });

  // ── 原子分配范围结算序号：计数文档就是同范围确认的共享冲突点 ──
  const counterId = ratingSeqKey(ctx);
  const counter = await tx.ratingCounters.getById(counterId);
  const seq = (counter ? assertNonNegativeInt(counter.seq, '结算序号计数') : 0) + 1;
  await tx.ratingCounters.set(counterId, {
    ...(counter || {}),
    _id: counterId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    seq,
    lastMatchId: match._id,
    updatedAt: new Date(ctx.now).toISOString(),
  });

  // ── 纯函数算一次赛前快照与分差，写回评级 ──
  const eventLevel = resolveEventLevel(match, options.event || null);
  const { settlement, ratingDocs } = computeSettlement({
    match, eventLevel, ratingsByUser, seq, settledAt: ctx.now, config: options.config, profileByUser,
  });
  for (const { doc } of ratingDocs) {
    await tx.memberRatings.set(doc._id, doc);
  }

  return { rated: true, alreadySettled: false, settlement };
}

/* --------------------------------------------------------- 会籍 → 评级的同步 */

/**
 * 把会籍变更同步进评级表的两个冗余字段（2026-10-23 方案 A 的第 1 步）。
 *
 * 【为什么要有这一条】
 * `member_ratings` 里的 `gender` / `memberStatus` 是**物化的副本**，权威值在
 * `users.gender` / `school_members.status`。副本唯一的代价就是「变更时要跟上」，
 * 不跟上的后果是榜单把已转出的人算进排名、或把项目筛错。所以会籍的每条写入
 * 路径都要调一次这里。
 *
 * 【为什么不是一个一个池地算键】
 * 评级的键是「学校 + 协会 + 用户 + 池」，一个人在同一所学校最多 6 协会 × 4 池
 * = 24 条。调用方通常只知道「这个人在这所学校」，不知道他在哪几个协会有评级
 * 文档，因此默认扫全部协会、只写**已经存在**的文档——缺失的池不补建档，因为
 * 建档是结算的职责（惰性初始化，起点分要按当时的性别算）。
 *
 * 【事务预算】
 * 最坏 24 读；只有字段真的变了才写（首次回填后通常 0 写）。转校是低频路径，
 * 原校满配时约 48 个操作，加上转校自身的约 31 个仍在 100 以内。
 *
 * @param {Object} tx 事务内仓储
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.schoolId
 * @param {string[]|null} [params.associations] 只同步这些协会；null = 全部协会
 * @param {string} [params.gender] 不传则保留原值（只改状态时用）
 * @param {string} params.memberStatus 目标在册状态
 * @param {Date|string|number} [params.now]
 * @returns {Promise<{scanned:number, updated:number, missing:number, changed:string[]}>}
 */
async function syncRatingProfileInTransaction(tx, {
  userId, schoolId, associations = null, gender, memberStatus, now = null,
}) {
  if (!userId || typeof userId !== 'string') throw new Error('评级档案同步缺少用户编号');
  if (!Object.values(SCHOOL_MEMBER_STATUS).includes(memberStatus)) {
    throw new Error(`未知的在册状态：${String(memberStatus)}`);
  }
  const list = Array.isArray(associations) && associations.length
    ? associations
    : allAssociations().map(sport => sport.id);
  const syncedAt = now === null || now === undefined ? null : new Date(now).toISOString();
  const changed = [];
  let scanned = 0;
  let missing = 0;
  for (const association of list) {
    const scope = { schoolId, association };
    for (const pool of ALL_RATING_POOLS) {
      const id = memberRatingKey(userId, pool, scope);
      scanned += 1;
      // 顺序点读而非整表扫：转校/入会都是低频路径，且这里只关心这一个人。
      const doc = await tx.memberRatings.getById(id);
      if (!doc) { missing += 1; continue; }
      const nextGender = gender === undefined ? (doc.gender || '') : String(gender || '');
      if (doc.gender === nextGender && doc.memberStatus === memberStatus) continue;
      await tx.memberRatings.set(id, {
        ...doc, gender: nextGender, memberStatus, profileSyncedAt: syncedAt,
      });
      changed.push(id);
    }
  }
  return { scanned, updated: changed.length, missing, changed };
}

module.exports = {
  // 纯函数
  assertFiniteNumber,
  assertNonNegativeInt,
  assertValidRatingDoc,
  buildRatingDoc,
  displayRating,
  decideSettlement,
  resolveEventLevel,
  participantsOf,
  materializeRatings,
  computeSettlement,
  buildExcludedSettlement,
  // 事务读写
  settleMatchInTransaction,
  syncRatingProfileInTransaction,
};
