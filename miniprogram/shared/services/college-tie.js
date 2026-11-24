/**
 * 学院赛大场 —— 首轮生成、大场状态、大场展示
 * ============================================================
 * 大场（tie）是「两个学院之间的一轮对抗」，小场（leg）是其中具体一项
 * 比赛（D15）。这个模块管大场这一层：
 *   1. 赛事级「开始」能不能点？（管理员 + 已抽签）
 *   2. 首轮有哪些大场？（由签表 slots 推出来）
 *   3. 这个大场能不能开始？（双方排阵齐，D38）
 *   4. 大场在页面上显示成什么样？
 *   5. 小场怎么建、录完分怎么把结果写回大场？（M4-1）
 *   6. 这个大场谁赢了？（两种算法 × 两套净胜口径，M4-5）
 *   7. 本轮打完后，下一轮谁对谁？（M4-6）
 *
 * 【为什么大场不生成在抽签那一刻】
 * 抽签只回答「谁在签表哪个位置」。真正开打要等管理员点赛事级「开始」
 * （D35）。把生成拆成两步，管理员抽完签还能停下来核一遍对阵；若抽签即
 * 生成，任何一个想改种子的人都会先得到一批已存在的大场。
 *
 * 【轮空为什么不产生大场】
 * 签表补齐到 2 的幂后会多出空位。轮空的一方不动手就进下一轮，没有对手
 * 可打，因此这里跳过任何一侧为空的签位——与个人赛 buildBracketMatches
 * 跳过轮空签位是同一口径。
 *
 * 【大场状态为什么自己一条线】
 * 赛事级「开始」只把整场推进到进行中；每个大场还要各自等双方排阵、
 * 各自开始（D38），因此大场有独立的 TIE_STATUS，不能只看赛事状态。
 *
 * 【小场为什么写进 matches 集合】
 * 小场要复用个人赛那条「录分 → 对手确认 → 计等级分」的通路（M4-3），
 * 而那条通路整个建在 matches 集合上。与其再造一套并行的录分链路，不如让
 * 小场也当一条 matches：用 competition='college' 标明归属，eventId 留空
 * 以免混进个人赛的赛事读路径。回放据此分流——单打小场照一级赛事计 ELO
 * （K=32），双打小场与弃权一概不计（D24/D25/D41）。
 *
 * 【净胜打平时为什么判「未决」而不是硬判一方】
 * 「打满比净胜」先按管理员选的口径比（胜场差 / 局分净胜），打平再比另一
 * 口径；两套都打平时不猜——大场判为未决、保持未结束，交由管理员处理。
 * 宁可让人看见「这场平了」，也不要让一个任意的 tie-break 悄悄决定晋级。
 *
 * 纯函数，不碰 wx、不碰数据源，可在 Node 里完整测试。
 * ============================================================
 */

const {
  COLLEGE_EVENT_STATUS,
  TIE_STATUS,
  TIE_STATUS_LABEL,
  DEFAULT_TIE_STATUS,
  LEG_DISCIPLINE_LABEL,
  BRACKET_STAGE,
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_COMPETITION,
  COLLEGE_LEG_FORMAT,
  TIE_ALGO,
  DEFAULT_TIE_ALGO,
  TIE_NET_MODE,
  DEFAULT_TIE_NET_MODE,
  DOUBLES_DISCIPLINES,
  EVENT_LEVEL,
  TEAM,
  courtNoTextOf,
} = require('../utils/constants.js');
const { canManageCollegeEvent } = require('./college-event.js');
const { collegeTieKey } = require('./college-draw.js');
const { planCourts } = require('./court.js');
const { getAssociation } = require('../utils/associations.js');
const { scoringOf } = require('../utils/match-format.js');
const { formatScore } = require('../utils/format.js');

/**
 * 学院赛小场该用哪套赛制。
 *
 * 【为什么不能继续写死 11 分制】
 * 石榴籽杯的项目就是协会（cup-home 直接读 activeAssociations），网球项目
 * 会自动出现在杯赛里。网球没有「11 分制一局」这种东西——一局恒定 4 分，
 * 硬按 11 分制生成小场，录分时 6:4 会被判「没人打到 11 分」，一场都录不进去。
 *
 * 【网球小场为什么用 4 局短盘 + 无占先】
 * 一个大场里通常有多场小项，标准盘（6 局、可能长到 7:5）会让赛程翻倍。
 * 团体赛用短盘是通行做法，配无占先把单场压到 20 分钟上下。
 *
 * @param {string} association 协会 id（缺省按常规 11 分制）
 * @returns {Object} 赛制对象
 */
function collegeLegFormatOf(association) {
  try {
    const assoc = getAssociation(association);
    if (assoc && assoc.format && assoc.format.scoring === 'tennis') {
      return {
        scoring: 'tennis',
        bestOf: 1,
        setGames: 4,
        tiebreakAt: 4,
        tiebreakPoints: 7,
        noAd: true,
      };
    }
  } catch (err) {
    // 未知协会：按常规口径，绝不因为查不到就抛错——那会让整个大场开不了
  }
  return { ...COLLEGE_LEG_FORMAT };
}

/* ============================================================
 * 赛事级开始
 * ============================================================ */

/**
 * 能不能点赛事级「开始」。**仅管理员**，且赛事必须已抽签（待开赛）。
 *
 * 【为什么必须已抽签】
 * 不抽签就没有签表，生成不出首轮大场；先开赛后抽签也会让「进行中的
 * 赛事没有对手」成为可能。所以状态必须是 READY（D35）。
 *
 * @param {Object|null} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canStartCollegeEvent(event, actor, options = {}) {
  if (!event || event.status !== COLLEGE_EVENT_STATUS.READY) return false;
  return canManageCollegeEvent(actor, options);
}

/* ============================================================
 * 大场生成
 * ============================================================ */

/**
 * 把有序数组两两分组；落单的补 null。
 * @param {Array} list
 * @returns {Array<Array>}
 */
function chunkPairs(list) {
  const source = Array.isArray(list) ? list : [];
  const pairs = [];
  for (let i = 0; i < source.length; i += 2) {
    pairs.push([source[i], source[i + 1] === undefined ? null : source[i + 1]]);
  }
  return pairs;
}

/**
 * 由签表算出首轮对阵。
 * @param {Object} draw 学院赛的 draw 字段
 * @returns {Array<Array<string|null>>}
 */
function firstRoundPairsOf(draw) {
  const slots = draw && Array.isArray(draw.slots) ? draw.slots : [];
  return chunkPairs(slots);
}

/**
 * 某轮的大场草稿。
 *
 * 小项按赛事的 legPlan 预先铺好（legNo + discipline），比分与胜负留空，
 * 等 M4 录分时再填。这样详情页在还没开打时也能列出「第 1 场男单」。
 *
 * @param {Object} params
 * @param {Object} params.event 学院赛记录
 * @param {number} params.round 轮次，从 1 开始
 * @param {Array<Array<string|null>>} params.pairs 本轮对阵
 * @param {string} [params.stage] 见 constants.BRACKET_STAGE
 * @returns {Array<Object>} 大场草稿（每场都带确定性 _id）
 */
function buildTiesForRound({ event, round, pairs, stage = BRACKET_STAGE.MAIN } = {}) {
  if (!event || !event._id || !Array.isArray(pairs)) return [];
  const legPlan = Array.isArray(event.legPlan) ? event.legPlan : [];

  const ties = [];
  pairs.forEach((pair, slot) => {
    const collegeA = pair && pair[0];
    const collegeB = pair && pair[1];
    // 轮空：一侧为空，不生成大场；轮空者已记在 draw.byes 里
    if (!collegeA || !collegeB) return;

    ties.push({
      _id: collegeTieKey(event._id, round, slot, stage),
      eventId: event._id,
      round,
      stage,
      slot,
      collegeA,
      collegeB,
      legs: legPlan.map((discipline, index) => ({
        legNo: index + 1,
        discipline,
        matchId: '',
        winner: null,
        outcome: null,
      })),
      winner: null,
      status: DEFAULT_TIE_STATUS,
      // 大场裁判：指派的界面锚点，也是生成小场时的带入来源（§6.1）。
      // 空串 = 未指定，行为与没有这个字段完全一致
      referee: '',
      refereeAt: null,
      refereeBy: '',
      // 双方是否已提交本大场的出场安排（记录本身落 lineups 集合）
      lineupA: false,
      lineupB: false,
      startedAt: null,
      finishedAt: null,
      // 场号：一个大场占一块场地，同一轮内不重复（见 services/court.js）。
      // 在整轮铺完之后统一排——逐场各排一次的话每场都从 1 号场开始
      courtNo: 0,
    });
  });

  applyTieCourts(ties, event.courtCount);
  return ties;
}

/**
 * 给一轮的大场排场号，就地写入 `courtNo`。
 *
 * 【为什么排在大场而不是小场】
 * 一个大场只占一块场地：它的几个小项依次在同一块场地上打完，所以小项的
 * 场号就是大场的场号（由 buildLegDrafts 下推）。若按小场排，「同一轮次」
 * 的场次数会变成大场数 × 小项数，场地会凭空紧张好几倍。
 *
 * @param {Array<Object>} ties 同一轮的大场列表
 * @param {number} courtCount 赛事可用场地总数
 */
function applyTieCourts(ties, courtCount) {
  const plan = planCourts(ties, courtCount);
  ties.forEach((tie, index) => {
    tie.courtNo = plan[index].courtNo;
  });
}

/* ============================================================
 * 小场：归属、键与赛制（M4-1）
 * ============================================================ */

/**
 * 小项 → 个人赛的项目类型。
 *
 * 男单 / 女单记单打，男双 / 女双 / 混双记双打。这个映射决定两件事：
 * 回放进哪个等级分池（见 MATCH_TYPE_TO_POOL），以及要不要计个人 ELO
 * （双打类不计，D25）。
 *
 * @param {string} discipline
 * @returns {number} constants.MATCH_TYPE
 */
function disciplineToMatchType(discipline) {
  return isDoublesDiscipline(discipline) ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES;
}

/**
 * 这个小项是不是双打类。
 * 双打类只参与大场汇总，不产生个人 ELO，也不产生赛事积分（D25）。
 *
 * @param {string} discipline
 * @returns {boolean}
 */
function isDoublesDiscipline(discipline) {
  return DOUBLES_DISCIPLINES.includes(discipline);
}

/**
 * 小场的确定性主键：赛事 + 大场 + 小项序号唯一确定一场小场。
 *
 * 与个人赛的比赛编号同理，用确定性键而非随机值：重开大场时新小场会覆盖
 * 在同一批编号上，不会堆出两批首轮小场；也便于按大场一次性推出全部小场
 * 的编号。
 *
 * @param {string} eventId
 * @param {string} tieId
 * @param {number} legNo
 * @returns {string}
 */
function collegeLegKey(eventId, tieId, legNo) {
  return `l_${eventId}_${tieId}_${legNo}`;
}

/**
 * 从某学院本大场的排阵里取第 legNo 个小项的上场队员。
 * @param {Array<Object>} lineups 本赛事全部排阵
 * @param {string} tieId
 * @param {string} college
 * @param {number} legNo
 * @returns {string[]}
 */
function playersForLeg(lineups, tieId, college, legNo) {
  const lineup = (Array.isArray(lineups) ? lineups : []).find(
    (item) => item && item.tieId === tieId && item.college === college
  );
  const entries = lineup && Array.isArray(lineup.entries) ? lineup.entries : [];
  const row = entries.find((item) => Number(item.legNo) === Number(legNo));
  return row && Array.isArray(row.players) ? row.players.map((id) => String(id)) : [];
}

/**
 * 由大场与双方排阵，铺出该大场全部小场的比赛草稿（M4-1）。
 *
 * 草稿只填「谁打谁、打哪项、赛制是什么」，比分与胜负留空——等录分时
 * 再走 submitMatch 那条通路填。产出的形状与个人赛比赛记录一致，因此
 * 详情页、录分页、回放都能直接吃。
 *
 * 【为什么小场一律按一级赛事记 level】
 * 学院赛是校内最高规格的团体赛，单打小场照一级赛事口径计 ELO（K=32，
 * D24）。level 写在小场记录上而不是挂到个人赛的 events 里，回放就不必
 * 让学院赛混进个人赛事列表。
 *
 * @param {Object} params
 * @param {Object} params.event 学院赛
 * @param {Object} params.tie 大场
 * @param {Array<Object>} [params.lineups] 本赛事全部排阵
 * @param {Date|string} [params.now] 比赛时间，由调用方给
 * @param {string} [params.association] 所属协会 id，决定小场赛制（见 collegeLegFormatOf）
 * @returns {{ok:boolean, drafts:Array<Object>, message:string}}
 */
function buildLegMatchDrafts({ event = null, tie = null, lineups = [], now = null, association = '' } = {}) {
  if (!event || !tie) return { ok: false, drafts: [], message: '缺少赛事或大场' };

  const legs = Array.isArray(tie.legs) ? tie.legs : [];
  if (legs.length === 0) return { ok: false, drafts: [], message: '这场大场还没有小项' };

  // 赛制按协会定一次，整场小项共用：同一大场里两场球不该有两套规则
  const legFormat = collegeLegFormatOf(association);
  const isTennis = scoringOf(legFormat) === 'tennis';
  const formatFields = isTennis
    ? {
        scoring: 'tennis',
        bestOf: legFormat.bestOf,
        setGames: legFormat.setGames,
        tiebreakAt: legFormat.tiebreakAt,
        tiebreakPoints: legFormat.tiebreakPoints,
        noAd: legFormat.noAd === true,
      }
    : { gamePoints: legFormat.gamePoints, bestOf: legFormat.bestOf };

  const drafts = [];
  for (const leg of legs) {
    const need = isDoublesDiscipline(leg.discipline) ? 2 : 1;
    const teamA = playersForLeg(lineups, tie._id, tie.collegeA, leg.legNo);
    const teamB = playersForLeg(lineups, tie._id, tie.collegeB, leg.legNo);
    // 排阵不齐就不生成：D40 的「未排人不能开赛」在这里再兜一次底
    if (teamA.length < need || teamB.length < need) {
      return { ok: false, drafts: [], message: `第 ${leg.legNo} 场双方排阵不齐，不能开赛` };
    }

    const matchType = disciplineToMatchType(leg.discipline);
    drafts.push({
      _id: collegeLegKey(event._id, tie._id, leg.legNo),
      competition: MATCH_COMPETITION.COLLEGE,
      collegeEventId: event._id,
      tieId: tie._id,
      round: tie.round,
      stage: tie.stage,
      slot: tie.slot,
      legNo: leg.legNo,
      discipline: leg.discipline,
      matchType,
      pool: MATCH_TYPE_TO_POOL[matchType],
      teamA,
      teamB,
      // 两个学院名留着做展示与汇总，不必每次回查大场
      collegeA: tie.collegeA,
      collegeB: tie.collegeB,
      scoreA: [],
      scoreB: [],
      // 赛制随记录一起落库：脱离赛制就看不出 6:4 是「一盘」还是「一局」
      ...formatFields,
      winner: null,
      location: event.location || '',
      // 场号从大场下推：几个小项在同一块场地上依次打，与 referee 同一条路径
      courtNo: (tie && tie.courtNo) || 0,
      matchTime: now || null,
      recorder: '',
      // 个人赛的 eventId 留空：小场不计赛事积分，也不该混进个人赛的赛事读路径
      eventId: null,
      level: EVENT_LEVEL.FIRST,
      outcome: MATCH_OUTCOME.NORMAL,
      forfeitBy: '',
      status: MATCH_STATUS.PENDING,
      // 大场已指派裁判时带给小场：指派的界面在大场，权限判定在小场
      referee: (tie && tie.referee) || '',
      refereeAt: (tie && tie.refereeAt) || null,
      refereeBy: (tie && tie.refereeBy) || '',
    });
  }

  return { ok: true, drafts, message: '' };
}

/** 小场比分的可读文本，例如「11:9 11:9」/ 网球「6:4 7:6(3)」；没录分时给空串 */
function scoreTextOf(match) {
  const a = match && Array.isArray(match.scoreA) ? match.scoreA : [];
  const b = match && Array.isArray(match.scoreB) ? match.scoreB : [];
  if (a.length === 0 && b.length === 0) return '';
  // 网球走统一格式化：7:6 后面要带抢七小分，且两边元素数本来就一致
  if (match && match.scoring === 'tennis') return formatScore(a, b, match.tiebreaks);
  const games = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    games.push(`${a[i] === undefined ? 0 : a[i]}:${b[i] === undefined ? 0 : b[i]}`);
  }
  return games.join(' ');
}

/** 各局得分求和，供「累计局分净胜」口径使用 */
function totalPoints(scores) {
  return (Array.isArray(scores) ? scores : []).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

/**
 * 由一场已录分的小场，算出写回 tie.legs[] 的那一条结果。
 *
 * 胜负从比赛记录的 'A'/'B' 换算成学院名——大场的其余部分（页面、汇总）
 * 一律认学院名，只有比赛记录里才用 A/B。
 *
 * @param {Object} tie 大场
 * @param {Object} match 小场（matches 记录）
 * @returns {Object} 写进 tie.legs[] 的一条
 */
function legResultOf(tie, match) {
  const source = match || {};
  const side = source.winner;
  const winner =
    side === TEAM.A
      ? (tie ? tie.collegeA : null)
      : side === TEAM.B
        ? (tie ? tie.collegeB : null)
        : null;

  return {
    legNo: source.legNo,
    discipline: source.discipline,
    matchId: source._id || '',
    winner,
    outcome: source.outcome || MATCH_OUTCOME.NORMAL,
    scoreText: scoreTextOf(source),
    pointsA: totalPoints(source.scoreA),
    pointsB: totalPoints(source.scoreB),
  };
}

/**
 * 这条比赛记录要不要进回放计个人 ELO（M4-3 / M4-4）。
 * 【Elo 逐场结算改造后】本函数只余数据集构建等旧口径使用；结算侧的计分判定
 * 在 school-rating-service.decideSettlement（同一口径：弃权 / 学院双打不计）。
 *
 *   个人赛       —— 计（caller 已筛过「已生效」，这里只再判弃权）
 *   学院赛单打   —— 计（照一级赛事 K=32，D24）
 *   学院赛双打   —— 不计（男双 / 女双 / 混双只汇总大场，D25）
 *   弃权         —— 不计（D41：对阵照常推进，但不产生等级分）
 *
 * 放在这里而不是回放引擎里，是因为「哪些比赛影响分数」的口径要与数据集
 * 构建共用一份；回放只负责按给定流水算分。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function isEloEligibleMatch(match) {
  if (!match) return false;
  if (match.status !== MATCH_STATUS.ACTIVE) return false;
  if (match.outcome === MATCH_OUTCOME.FORFEIT) return false;
  if (match.competition === MATCH_COMPETITION.COLLEGE) {
    return !isDoublesDiscipline(match.discipline);
  }
  return true;
}

/* ============================================================
 * 大场状态
 * ============================================================ */

/**
 * 由排阵提交情况推出大场状态。
 *
 * 已开始 / 已结束的维持原状——排阵再提交也不该把进行中的大场打回待开赛。
 * 未开始时，双方排阵齐即「待开赛」，否则「待排阵」。
 *
 * @param {Object|null} tie
 * @returns {number} 见 constants.TIE_STATUS
 */
function tieStatusOf(tie) {
  if (!tie) return DEFAULT_TIE_STATUS;
  if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) {
    return tie.status;
  }
  return tie.lineupA && tie.lineupB ? TIE_STATUS.READY : TIE_STATUS.PENDING_LINEUP;
}

/**
 * 能不能点该大场的「开始」。**仅管理员**，且双方排阵已齐（D38）。
 * @param {Object|null} tie
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canStartTie(tie, actor, options = {}) {
  if (!tie) return false;
  if (tieStatusOf(tie) !== TIE_STATUS.READY) return false;
  return canManageCollegeEvent(actor, options);
}

/** 大场状态文案；未知取值给「未知状态」而不是空白 */
function tieStatusLabelOf(tie) {
  return TIE_STATUS_LABEL[tieStatusOf(tie)] || '未知状态';
}

/**
 * 这个大场能不能指派 / 改派 / 取消裁判。
 *
 * 与比赛层不同，大场「进行中」仍可指派：小项比赛要到 startTie 才生成，
 * 而裁判本就是「录分之前」才指派（需求原文）。若把进行中也禁掉，学院赛
 * 就永远指派不了裁判。只有已结束（胜负已定）才锁死，不给「改历史」留口子。
 *
 * @param {Object|null} tie
 * @returns {boolean}
 */
function canAssignTieReferee(tie) {
  return Boolean(tie) && tie.status !== TIE_STATUS.FINISHED;
}

/**
 * 该大场已生成的小项比赛编号。
 *
 * 管理员在大场一次指派，要落到下面每一场小场（§6.1）——权限判定只读
 * 比赛记录自己的 `referee`，所以必须逐个写上。没生成比赛的小项跳过，
 * 等 startTie 时再从 tie.referee 带入。
 *
 * @param {Object|null} tie
 * @returns {Array<string>}
 */
function legMatchIdsOf(tie) {
  const legs = tie && Array.isArray(tie.legs) ? tie.legs : [];
  return legs.map((leg) => leg && leg.matchId).filter(Boolean);
}

/* ============================================================
 * 大场汇总（M4-5）
 * ============================================================ */

/**
 * 汇总一场大场的胜负。
 *
 * 【两种算法】
 *   先到 N 场胜（FIRST_TO_N）—— N = 小项数的一半向下取整再加一。有一方
 *     先赢够 N 场，大场立刻结束，剩下的小项不必再打。
 *   打满比净胜（FULL_POINTS）—— 全部小项打完，再按口径比净胜。
 *
 * 【两套净胜口径】
 *   小场胜场差（WIN_DIFF）—— 赢的小场数减输的小场数；
 *   累计局分净胜（POINT_DIFF）—— 把各小场的局分加总再比。
 *
 * 【净胜打平怎么办】
 * 先按管理员选的口径比，打平再比另一口径；两套都打平则 winnerSide 为
 * null 且 tied 为 true——大场判为未决，保持未结束，交管理员处理。不为了
 * 「总能出一个赢家」而硬造一个 tie-break，那会悄悄决定谁晋级。
 *
 * @param {Object} params
 * @param {Object} params.tie 大场（legs[] 里带 winner / pointsA / pointsB）
 * @param {Object} params.event 学院赛（决定算法与口径）
 * @returns {{
 *   ok:boolean, algo:string, netMode:string, legCount:number, decidedCount:number,
 *   undecided:Array<number>, winsA:number, winsB:number, pointsA:number, pointsB:number,
 *   netWin:number, netPoint:number, complete:boolean, winnerSide:'A'|'B'|null,
 *   winner:string|null, tied:boolean, reason:string
 * }}
 */
function summarizeTie({ tie = null, event = null } = {}) {
  const legs = tie && Array.isArray(tie.legs) ? tie.legs : [];
  const algo = (event && event.tieAlgo) || DEFAULT_TIE_ALGO;
  const netMode = (event && event.tieNetMode) || DEFAULT_TIE_NET_MODE;
  const collegeA = tie ? tie.collegeA : '';
  const collegeB = tie ? tie.collegeB : '';

  let winsA = 0;
  let winsB = 0;
  let pointsA = 0;
  let pointsB = 0;
  const undecided = [];
  for (const leg of legs) {
    if (!leg) continue;
    if (leg.winner && leg.winner === collegeA) winsA += 1;
    else if (leg.winner && leg.winner === collegeB) winsB += 1;
    else undecided.push(leg.legNo);
    pointsA += Number(leg.pointsA) || 0;
    pointsB += Number(leg.pointsB) || 0;
  }

  const base = {
    ok: true,
    algo,
    netMode,
    legCount: legs.length,
    decidedCount: legs.length - undecided.length,
    undecided,
    winsA,
    winsB,
    pointsA,
    pointsB,
    netWin: winsA - winsB,
    netPoint: pointsA - pointsB,
  };
  // 封口：赢的一方给学院名与 A/B 两副面孔，调用方各取所需
  const decided = (side, reason) => ({
    ...base,
    complete: true,
    winnerSide: side,
    winner: side === TEAM.A ? collegeA : side === TEAM.B ? collegeB : null,
    tied: false,
    reason,
  });

  if (legs.length === 0) {
    return { ...base, complete: false, winnerSide: null, winner: null, tied: false, reason: '这场大场还没有小项' };
  }

  if (algo === TIE_ALGO.FIRST_TO_N) {
    const need = Math.floor(legs.length / 2) + 1;
    if (winsA >= need) return decided(TEAM.A, `${winsA}:${winsB}，先到 ${need} 场胜`);
    if (winsB >= need) return decided(TEAM.B, `${winsA}:${winsB}，先到 ${need} 场胜`);
    // 小项数为偶数时 need 是「过半」，平分（n/2 : n/2）时两边都到不了，
    // 且全部打完也永远等不到。此时不能再返回 complete:false（会卡在「进行中」
    // 让整条赛程推不动），而要如实判为未决，交管理员处理。
    if (legs.length % 2 === 0 && undecided.length === 0) {
      return {
        ...base,
        complete: true,
        winnerSide: null,
        winner: null,
        tied: true,
        reason: `${winsA}:${winsB}，小项平分、先到 ${need} 场胜无法判定，请管理员处理`,
      };
    }
    return {
      ...base,
      complete: false,
      winnerSide: null,
      winner: null,
      tied: false,
      reason: `先到 ${need} 场胜，当前 ${winsA}:${winsB}`,
    };
  }

  // 打满比净胜：先要求全部小项都分出胜负
  if (undecided.length > 0) {
    return {
      ...base,
      complete: false,
      winnerSide: null,
      winner: null,
      tied: false,
      reason: `还有 ${undecided.length} 个小项没打完`,
    };
  }

  const byPoints = netMode === TIE_NET_MODE.POINT_DIFF;
  const primary = byPoints ? base.netPoint : base.netWin;
  const fallback = byPoints ? base.netWin : base.netPoint;
  if (primary > 0) return decided(TEAM.A, '按净胜判定');
  if (primary < 0) return decided(TEAM.B, '按净胜判定');
  if (fallback > 0) return decided(TEAM.A, '净胜打平，按另一口径判定');
  if (fallback < 0) return decided(TEAM.B, '净胜打平，按另一口径判定');

  return {
    ...base,
    complete: true,
    winnerSide: null,
    winner: null,
    tied: true,
    reason: '两套净胜口径都打平，大场未决，请管理员处理',
  };
}

/**
 * 大场是否已经分出胜负、可以置为「已结束」。
 * 未决（净胜两套都平）不算——宁可停在「进行中」等管理员，也不记一个假胜者。
 *
 * @param {Object} params
 * @returns {boolean}
 */
function canFinishTie({ tie = null, event = null } = {}) {
  const summary = summarizeTie({ tie, event });
  return Boolean(summary.complete && summary.winnerSide);
}

/* ============================================================
 * 轮次推进（M4-6）
 * ============================================================ */

/** 某一轮的大场列表 */
function tiesOfRound(ties, round) {
  return (Array.isArray(ties) ? ties : []).filter(
    (tie) => tie && Number(tie.round) === Number(round)
  );
}

/**
 * 某一轮的参赛学院序列（含轮空留下的空档）。
 *
 * 第 1 轮就是签表 slots；之后每一轮由上轮各签位的胜者按原顺序拼成。
 * 轮空的一侧不动手就进下一轮，因此「只有一方」的签位直接取那一方。
 *
 * 递归到目标轮为止；上轮有未打完的签位时对应位置为 null——调用方应先
 * 用 isRoundComplete 确认本轮已结束。
 *
 * @param {Object} params
 * @param {Object} params.draw 学院赛的 draw
 * @param {Array<Object>} params.ties 本赛事全部大场
 * @param {number} params.round
 * @returns {Array<string|null>}
 */
function entrantsForRound({ draw = null, ties = [], round } = {}) {
  const target = Number(round);
  const slots = draw && Array.isArray(draw.slots) ? draw.slots : [];
  if (!Number.isFinite(target) || target <= 1) return slots.slice();

  const previous = entrantsForRound({ draw, ties, round: target - 1 });
  const pairs = chunkPairs(previous);
  const bySlot = new Map(
    tiesOfRound(ties, target - 1).map((tie) => [Number(tie.slot), tie])
  );

  return pairs.map((pair, slot) => {
    const [a, b] = pair;
    if (!a || !b) return a || b || null;
    const tie = bySlot.get(slot);
    return tie && tie.winner ? tie.winner : null;
  });
}

/**
 * 本轮是不是全部打完了：该轮每一场大场都已结束且分出了胜负。
 * 该轮一场大场都没有（只可能出现在签表只剩一人时）不算「打完」。
 *
 * @param {Object} params
 * @returns {boolean}
 */
function isRoundComplete({ ties = [], round } = {}) {
  const list = tiesOfRound(ties, round);
  if (list.length === 0) return false;
  return list.every((tie) => tie.status === TIE_STATUS.FINISHED && Boolean(tie.winner));
}

/**
 * 本轮打完后，下一轮的对阵；还没打完、或只剩最后一个学院（冠军已定）
 * 时给空数组。
 *
 * @param {Object} params
 * @returns {Array<Array<string|null>>}
 */
function nextRoundPairsOf({ draw = null, ties = [], round } = {}) {
  if (!isRoundComplete({ ties, round })) return [];

  const entrants = entrantsForRound({ draw, ties, round: Number(round) + 1 });
  const present = entrants.filter(Boolean);
  // 只剩一个学院即冠军已定，没有下一轮
  if (present.length <= 1) return [];
  return chunkPairs(entrants);
}

/* ============================================================
 * 展示整形
 * ============================================================ */

/** 轮次文案：第 1 轮、第 2 轮…… */
function roundTextOf(round) {
  const value = Number(round);
  return Number.isFinite(value) && value > 0 ? `第 ${value} 轮` : '';
}

/**
 * 大场行整形。权限布尔量与文案在这里算好，模板不写业务判断。
 *
 * @param {Object} tie
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的人
 * @returns {Object}
 */
function buildTieRow(tie, ctx = {}) {
  const { actor = null } = ctx;
  const source = tie || {};
  const status = tieStatusOf(source);
  const legs = Array.isArray(source.legs) ? source.legs : [];

  return {
    tieId: source._id || '',
    eventId: source.eventId || '',
    round: source.round || 0,
    roundText: roundTextOf(source.round),
    slot: source.slot || 0,
    // 一个大场占一块场地，小项依次在同一块场地上打完（Q7），
    // 所以场号挂在大场这一层，不必逐个小项重复
    courtText: courtNoTextOf(source.courtNo),
    collegeA: source.collegeA || '',
    collegeB: source.collegeB || '',
    status,
    statusLabel: TIE_STATUS_LABEL[status] || '未知状态',
    isPendingLineup: status === TIE_STATUS.PENDING_LINEUP,
    isReady: status === TIE_STATUS.READY,
    isOngoing: status === TIE_STATUS.ONGOING,
    isFinished: status === TIE_STATUS.FINISHED,
    lineupASubmitted: Boolean(source.lineupA),
    lineupBSubmitted: Boolean(source.lineupB),
    referee: source.referee || '',
    refereeName: ctx.refereeName || '',
    canAssignReferee: canAssignTieReferee(source),
    winner: source.winner || null,
    legCount: legs.length,
    legRows: legs.map((leg) => ({
      legNo: leg.legNo,
      discipline: leg.discipline,
      disciplineLabel: LEG_DISCIPLINE_LABEL[leg.discipline] || leg.discipline || '',
      matchId: leg.matchId || '',
      // 还没录分的场次明确写「未录入」，模板不必再判空
      winner: leg.winner || null,
      outcomeText: leg.outcome === MATCH_OUTCOME.FORFEIT ? '弃权' : '',
      scoreText: leg.scoreText || '',
    })),
    canStart: canStartTie(source, actor),
  };
}

module.exports = {
  chunkPairs,
  firstRoundPairsOf,
  buildTiesForRound,
  disciplineToMatchType,
  isDoublesDiscipline,
  collegeLegKey,
  collegeLegFormatOf,
  buildLegMatchDrafts,
  scoreTextOf,
  totalPoints,
  legResultOf,
  isEloEligibleMatch,
  canStartCollegeEvent,
  tieStatusOf,
  canStartTie,
  tieStatusLabelOf,
  canAssignTieReferee,
  legMatchIdsOf,
  summarizeTie,
  canFinishTie,
  tiesOfRound,
  entrantsForRound,
  isRoundComplete,
  nextRoundPairsOf,
  roundTextOf,
  buildTieRow,
};
