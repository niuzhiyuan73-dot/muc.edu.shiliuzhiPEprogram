/**
 * 赛制阶段派发器
 * ============================================================
 * 现在的抽签引擎原先只认单败淘汰：一轮打完排下一轮，决赛完就结束。
 * 循环赛、小组赛、双败淘汰、以及「小组打完接着淘汰」这样的复合赛制，
 * 若各写一套推进逻辑，分支很快就理不清了。
 *
 * 这里的做法是把任何一种赛制看成**有序的阶段序列**：
 *
 *   单败：淘汰
 *   循环：循环（单组）
 *   小组：分组循环 → 淘汰
 *   双败：胜者组 → 败者组 → 总决赛
 *   复合：分组循环 → （单败 / 双败）淘汰
 *
 * 于是「以上所有形式的复合」不是靠穷举组合，而是阶段序列自然串联的
 * 结果；加一种预设就是加一条分支。
 *
 * 【为什么读操作要能凭空重推】
 * 比赛记录只存「事实」，阶段该排到哪一轮是从事实推出来的。这样：
 *   - 断点续跑天然成立：中途关掉小程序，回来照着已有比赛接着推；
 *   - 管理员撤销一场，分数与名次随重放退回原样。
 * 因此本模块全部是纯函数：只读赛事、签表与比赛，产出「还缺哪些轮次」。
 *
 * 【重推推不掉的是什么】
 * 「还缺哪些轮次」只做增量补入（advance 是「只补不覆盖」，见 match-handlers），
 * 而写入侧没有删除。所以撤销撤得回分数，却撤不掉已经排下去的下一轮——它会
 * 顶着一个作废了的晋级者留在台账里。这由 findDependentMatches 在撤销前拦下：
 * 让管理员从后往前撤，签表才不会悬空。
 *
 * 【为什么名次也从这里推】
 * 循环赛的名次是算出来的，不是打出来的（淘汰赛恰恰相反）。名次页的
 * 预填值因此由 derivePlacements 给出，管理员再在上面微调。
 * ============================================================
 */

const {
  MATCH_STATUS,
  BRACKET_STAGE,
  EVENT_FORMAT,
  EVENT_BRONZE_MODE,
  EVENT_PLACEMENT_MODE,
  DEFAULT_PLACEMENT_MODE,
  GROUPED_FORMATS,
  DOUBLE_ELIM_FORMATS,
  DEFAULT_GF_RESET,
} = require('../utils/constants.js');
const { standardSeedOrder, bracketSizeOf } = require('../utils/bracket.js');
const { DEFAULT_FORMAT } = require('../utils/match-format.js');
const { computeStandings, allDecided, roundRobinRounds } = require('../utils/standings.js');
const {
  eventMatchKey,
  chunkPairs,
  buildRoundMatches,
  planNextRound,
  formatOf,
  normalizeAdvancePerGroup,
} = require('./draw.js');
const { withCourts } = require('./court.js');

/**
 * 抽签后生成第一批比赛。
 *
 * 单败淘汰一次把首轮摆好（后续轮次由 planStageMatches 逐轮补）；
 * 循环 / 小组赛只摆出每个小组的第一轮，其余轮次按「上一轮全打完」再排，
 * 免得一次把整张循环表的几十场都堆到界面上。
 *
 * @param {Object} event 赛事记录
 * @param {Object} draw 赛事的 draw 字段
 * @param {Object} [matchFormat] 比赛赛制（按协会取，见 associations.defaultFormatOf）
 * @returns {Array<Object>} 比赛草稿
 */
function buildInitialMatches(event, draw, matchFormat = DEFAULT_FORMAT) {
  if (!event || !event._id || !draw) return [];
  const format = formatOf(event);

  // 分组赛制：一次把每个小组的第 1 轮都摆出来。场号必须在**全部小组铺完之后**
  // 统一排（见 buildPlannedDrafts）——小组池是跨组共用的，逐组各排一次的话
  // 每个组都会从 1 号场重新数，A 组与 B 组的第一轮就撞号了
  const drafts =
    Array.isArray(draw.groups) && draw.groups.length > 0
      ? draw.groups.flatMap((item) => groupRoundDrafts(event, item, 1, matchFormat))
      : buildRoundMatches(event, {
          round: 1,
          // 双败的首轮长在「胜者组」上，单败长在主签表上：stage 决定它归哪一区
          stage: hasDoubleKnockout(format) ? BRACKET_STAGE.WINNERS : BRACKET_STAGE.MAIN,
          pairs: chunkPairs(Array.isArray(draw.slots) ? draw.slots : []),
          format: matchFormat,
        });

  return withCourts(drafts, event.courtCount);
}

/**
 * 把 planStageMatches 排出的各轮铺成比赛草稿，并统一排好场号。
 *
 * 【为什么场号要在这里统一排，而不是逐轮各排】
 * planStageMatches 返回的是「一批」轮次：小组赛里 A 组第 2 轮与 B 组第 2 轮
 * 会同时出现在这个数组里，而它们共用同一个场地池（见 court.poolKeyOf）。
 * 逐轮各调一次分配，两组都会从 1 号场重新数，同一批里就撞号了。所以先全部
 * 铺平、再整体分配——poolKeyOf 会按池归拢，不同轮次之间照样互不干扰。
 *
 * @param {Object} event 赛事记录（读 courtCount）
 * @param {Array<Object>} rounds planStageMatches 的 rounds
 * @returns {Array<Object>} 带 courtNo 的比赛草稿
 */
function buildPlannedDrafts(event, rounds, matchFormat = DEFAULT_FORMAT) {
  const drafts = (Array.isArray(rounds) ? rounds : []).reduce(
    (all, roundPlan) => all.concat(buildRoundMatches(event, { ...roundPlan, format: roundPlan.format || matchFormat })),
    []
  );
  return withCourts(drafts, event && event.courtCount);
}

/** 该赛制的主淘汰阶段是不是双败 */
function hasDoubleKnockout(format) {
  return DOUBLE_ELIM_FORMATS.includes(format);
}

/**
 * 阶段的先后次序，供「撤销前的自查」判断谁排在谁后面。
 *
 * 【为什么小组赛单独给 0，且组内不比轮次深浅】
 * 小组循环的「轮次」只是把一张循环表切成几段，第 2 轮并不依赖第 1 轮的
 * 结果——撤掉第 1 轮的一场，不该连累第 2 轮里别人的比赛。淘汰阶段正相反：
 * 第 2 轮的人是第 1 轮打上来的，撤了第 1 轮，第 2 轮就悬空了。所以只有
 * 淘汰阶段才比轮次。
 *
 * 【为什么主签表 / 季军赛 / 排位赛同为 1，即「同一段时间线」】
 * 这三者共用同一套轮次编号：季军赛与排位赛都挂在第 r 轮的负者上、被排成
 * 第 r+1 轮，与「第 r 轮打完去排决赛」是同一个深度。给它们同一个 rank 再
 * 比轮次，才问得出正确的依赖：
 *   - 半决赛（主签表 r） vs 季军赛（r+1）：r+1 > r，挡 → 对，季军赛靠负者
 *   - 决赛（主签表 r+1） vs 季军赛（r+1）：同轮，不挡 → 对，决赛不靠季军赛
 * 若把季军赛另判为一个更晚的阶段，就会得出「决赛也靠季军赛」，把决赛一起
 * 锁死，结果是整张签表谁也撤不动。
 *
 * 【为什么败者组 / 总决赛另算】
 * 双败的败者组与胜者组交错推进（败者组某一轮接住胜者组某几轮掉下来的人），
 * 光看轮次比不出先后，只能整组排在胜者组之后；总决赛再排在最后。这里宁可
 * 保守——多拦一次只是让管理员多撤一场，漏拦却会留下一场打不了、也不该
 * 存在的比赛。
 */
const STAGE_ORDER = {
  [BRACKET_STAGE.GROUP]: 0,
  [BRACKET_STAGE.MAIN]: 1,
  [BRACKET_STAGE.WINNERS]: 1,
  [BRACKET_STAGE.BRONZE]: 1,
  [BRACKET_STAGE.PLACEMENT]: 1,
  [BRACKET_STAGE.LOSERS]: 2,
  [BRACKET_STAGE.GRAND_FINAL]: 3,
};

/**
 * 这场比赛属于哪张签表。个人赛记在 eventId 上；学院赛小场刻意把 eventId
 * 留空、改记 collegeEventId（见 college-tie.buildLegDrafts），两者各自成表。
 * @param {Object} match
 * @returns {string} 空串表示它不挂在任何签表上（日常约球）
 */
function bracketScope(match) {
  if (!match) return '';
  return match.eventId || match.collegeEventId || '';
}

/** 这场是不是「签表推出来的」：有签表、有轮次、有阶段。日常约球不是 */
function isBracketMatch(match) {
  return Boolean(
    match &&
      bracketScope(match) &&
      match.stage !== undefined &&
      STAGE_ORDER[match.stage] !== undefined &&
      match.round !== undefined &&
      match.round !== null &&
      Number.isFinite(Number(match.round))
  );
}

/**
 * 撤销前的自查：找出「已经排在这场比赛之后」的场次。
 *
 * 【为什么需要这道闸门】
 * 撤销已随逐场结算改造整体取消（确认即最终结算）。但签表不是
 * 算出来的，是**排出来**的：确认一场会经 advanceAfterConfirm 把下一轮落成
 * 真实的比赛记录，而写入侧只给 upsert / patch、没有删除（见 repository.js）。
 * 于是撤掉第 1 轮之后，第 2 轮那几场仍留在台账里，身上还带着「已经作废的
 * 那个人」：它不会被删掉，也不会被重排覆盖（advance 是「只补不覆盖」），
 * 只等着谁随手录个比分确认掉，凭空多出一场不该有的成绩。
 *
 * 本函数不动数据，只回答「撤不撤得动」：返回非空即表示后面还挂着场次。
 * 让管理员从后往前撤（先撤决赛、再撤半决赛），签表就始终自洽。
 *
 * @param {Object} params
 * @param {Object} params.match 准备撤销的那场
 * @param {Array<Object>} [params.matches] 台账里的全部比赛（本函数自己按签表分组）
 * @returns {Array<Object>} 挡在后面的场次；已作废的不算（从后往前撤时它们先走）
 */
function findDependentMatches({ match, matches } = {}) {
  if (!isBracketMatch(match)) return [];
  const scope = bracketScope(match);
  const rank = STAGE_ORDER[match.stage];
  const round = Number(match.round);

  return (Array.isArray(matches) ? matches : []).filter((other) => {
    if (!isBracketMatch(other)) return false;
    if (other._id === match._id || bracketScope(other) !== scope) return false;
    // 已经作废的那几场不再挡路
    if (other.status === MATCH_STATUS.REVOKED) return false;

    const otherRank = STAGE_ORDER[other.stage];
    if (otherRank !== rank) return otherRank > rank;
    // 同阶段：只有淘汰阶段才论深浅，小组循环的各轮彼此独立
    return match.stage !== BRACKET_STAGE.GROUP && Number(other.round) > round;
  });
}

/**
 * 阶段派发：算出「还缺哪些轮次的比赛」。
 *
 * @param {Object} params
 * @param {Object} params.event 赛事记录
 * @param {Object} params.draw 赛事的 draw 字段
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛
 * @param {boolean} [params.full=false] 全量投影：交出「此刻应当存在」的全部轮次，
 *   而不只是「还缺哪几轮」。默认 false 保持逐轮补入的原行为（见 draw.planNextRound）。
 * @returns {{ok:boolean, rounds:Array<{group?:number, round:number, stage:string, pairs:Array<Array<string>>}>}}
 */
function planStageMatches({ event, draw, matches, full = false } = {}) {
  if (!event || !event._id || !draw) return { ok: false, rounds: [] };
  const list = Array.isArray(matches) ? matches : [];
  const format = formatOf(event);
  const gfReset = event.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(event.gfReset);

  // 纯循环赛：没有淘汰阶段，只有一组一组地排
  if (format === EVENT_FORMAT.ROUND_ROBIN) {
    const rounds = planGroupPhase(event, draw, list, full);
    return { ok: rounds.length > 0, rounds };
  }

  // 复合赛：先分组循环，全部小组打完后才转淘汰阶段
  if (GROUPED_FORMATS.includes(format)) {
    // 全量投影：小组轮次与淘汰阶段轮次要**并起来**交给调用方——小组打完之后
    // 小组那几轮仍然属于「此刻应当存在」，不能因为转段了就把它从投影里抹掉。
    if (full) {
      const groupRounds = planGroupPhase(event, draw, list, true);
      // 小组还没走完就别谈淘汰阶段。full 模式把「已排过的小组轮次」也交了出来，
      // 于是不再有「返回空」这个转段信号，只能另问一次非全量的口径。
      if (planGroupPhase(event, draw, list).length > 0) return { ok: true, rounds: groupRounds };
      const bracket = knockoutBracket(event, draw, list);
      if (!bracket) return { ok: groupRounds.length > 0, rounds: groupRounds };
      const knockout = hasDoubleKnockout(format)
        ? planDoubleElim({ event, bracket, matches: list, gfReset, full: true })
        : planSingleKnockout(event, bracket, list, true);
      return { ok: true, rounds: groupRounds.concat(knockout.rounds || []) };
    }

    // 逐轮补入：小组轮次非空就先只交小组；返回空才是「该转淘汰阶段了」的信号
    const groupRounds = planGroupPhase(event, draw, list);
    if (groupRounds.length > 0) return { ok: true, rounds: groupRounds };

    const bracket = knockoutBracket(event, draw, list);
    if (!bracket) return { ok: false, rounds: [] };

    return hasDoubleKnockout(format)
      ? planDoubleElim({ event, bracket, matches: list, gfReset })
      : planSingleKnockout(event, bracket, list);
  }

  // 纯双败淘汰
  if (hasDoubleKnockout(format)) {
    return planDoubleElim({ event, bracket: draw, matches: list, gfReset, full });
  }

  // 单败淘汰（兼容锚点；full 时交出全量投影，默认仍是逐轮补入）
  return planNextRound({
    eventId: event._id,
    draw,
    matches: list,
    bronzeMode: event.bronzeMode,
    placementMode: event.placementMode,
    includeExisting: full,
  });
}

/**
 * 小组出线后的单败淘汰：签表由小组结果推出，首轮要在这里补出来。
 *
 * @param {Object} event
 * @param {{size:number, slots:Array<string|null>}} bracket
 * @param {Array<Object>} list 已有比赛
 * @param {boolean} [full=false] 全量投影：已排过的淘汰轮次也交出（供改签表刷新）
 * @returns {{ok:boolean, rounds:Array<Object>}}
 */
function planSingleKnockout(event, bracket, list, full = false) {
  if (full) {
    // 全量投影直接走通用单败走法：首轮由签位给出，后续轮次逐轮推到位
    return planNextRound({
      eventId: event._id,
      draw: bracket,
      matches: list,
      bronzeMode: event.bronzeMode,
      placementMode: event.placementMode,
      includeExisting: true,
    });
  }
  const byId = new Set(list.map((match) => match && match._id));
  const firstPairs = chunkPairs(bracket.slots);
  const missingFirst = firstPairs.some(
    (pair, slot) =>
      pair[0] && pair[1] && !byId.has(eventMatchKey(event._id, 1, BRACKET_STAGE.MAIN, slot))
  );
  if (missingFirst) {
    return { ok: true, rounds: [{ round: 1, stage: BRACKET_STAGE.MAIN, pairs: firstPairs }] };
  }

  return planNextRound({
    eventId: event._id,
    draw: bracket,
    matches: list,
    bronzeMode: event.bronzeMode,
    placementMode: event.placementMode,
  });
}

/* ============================================================
 * 双败淘汰
 * ============================================================
 * 双败的结构可以拆成三块，全部由已有比赛确定性重推：
 *
 *   胜者组（wb）：标准单败。第 r 轮的负者掉进败者组。
 *   败者组（lb）：奇数轮把败者组内部的两两消化掉，偶数轮接住胜者组
 *                 刚掉下来的人。共 2R−2 轮（R 为胜者组轮数）。
 *   总决赛（gf）：胜者组冠军 对 败者组冠军。开了重赛时，胜者组冠军
 *                 先记 1:0——若首场输给败者组冠军，加赛一场定冠军。
 *
 * 【为什么要一次走完，而不是分阶段各排各的】
 * 败者组每一轮的对阵都依赖上一轮结果与胜者组掉下来的人，任何一环没
 * 打完，后面就无从谈起。所以这里从头走一遍，遇到第一个「该排却没排」
 * 的轮次就停下来把它交给调用方，遇到「排了还没打完」就安静收手。
 * ============================================================ */

/**
 * 把一轮的对阵还原成胜负。
 *
 * 【轮空为什么要记一个「空负者」】
 * 签表补到 2 的幂，人数不满时首轮会出现空位。双败的败者组靠「每轮固定
 * 几个负者往下走」维持结构，若轮空不产生负者，败者组各轮人数就会对不
 * 上（第 2 轮该接住 2 个落败者，实际只掉下来 1 个）。所以这里把空位当成
 * 一个「幽灵选手」：它照样占一个负者位、照样往后传递，只是到算名次时
 * 统一滤掉（见 doubleElimPlacements）。这样 5 / 6 / 7 人也能排出正确的
 * 双败签表，而不必强求人数正好是 4 / 8 / 16。
 *
 * 缺记录时 missing 为真——这一轮就是「该排还没排」的那一轮。空位不产生
 * 比赛，因此不会让 missing 为真。
 *
 * @param {string} eventId
 * @param {number} round
 * @param {string} stage
 * @param {Array<Array<string|null>>} pairs
 * @param {Map<string, Object>} byId
 * @returns {{decided:boolean, missing:boolean, winners:Array<string|null>, losers:Array<string|null>}}
 */
function resolvePairs(eventId, round, stage, pairs, byId) {
  const winners = [];
  const losers = [];
  let decided = true;
  let missing = false;

  pairs.forEach((pair, slot) => {
    const a = pair && pair[0];
    const b = pair && pair[1];
    if (!a && !b) {
      // 空位对空位：幽灵之间的「比赛」，只用来占住结构上的一个位置
      winners.push(null);
      losers.push(null);
      return;
    }
    if (!a || !b) {
      // 一方轮空：在签的一方不战而胜；空位记为空负者，把幽灵顺下去
      winners.push(a || b);
      losers.push(null);
      return;
    }
    const match = byId.get(eventMatchKey(eventId, round, stage, slot));
    if (!match) {
      missing = true;
      decided = false;
      return;
    }
    if (match.status !== MATCH_STATUS.ACTIVE || !match.winner) {
      decided = false;
      return;
    }
    winners.push(match.winner === 'A' ? a : b);
    losers.push(match.winner === 'A' ? b : a);
  });

  return { decided, missing, winners, losers };
}

/**
 * 从头走一遍双败签表，返回当前状态。
 *
 * @param {Object} params
 * @param {string} params.eventId
 * @param {{size:number, slots:Array<string|null>}} params.bracket
 * @param {Array<Object>} [params.matches]
 * @param {boolean} [params.gfReset=true]
 * @returns {Object} 见函数内 state 结构
 */
function walkDoubleElim({ eventId, bracket, matches, gfReset = DEFAULT_GF_RESET } = {}) {
  const byId = new Map((Array.isArray(matches) ? matches : []).map((m) => [m && m._id, m]));
  const slots = bracket && Array.isArray(bracket.slots) ? bracket.slots : [];
  const size = Number(bracket && bracket.size) || slots.length;
  const rounds = Math.round(Math.log2(size));
  const state = {
    size,
    rounds,
    wb: [],
    lb: [],
    gf: null,
    // 该排却没排的轮次，按先后顺序
    schedule: [],
    complete: false,
    champion: null,
    runnerUp: null,
    placements: null,
  };
  // 双败至少要 4 人（胜者组两轮）才谈得上「败者组」
  if (!(rounds >= 2)) return state;

  // ---------- 胜者组 ----------
  let entrants = slots.slice();
  for (let round = 1; round <= rounds; round += 1) {
    const pairs = chunkPairs(entrants);
    const res = resolvePairs(eventId, round, BRACKET_STAGE.WINNERS, pairs, byId);
    state.wb.push({ round, pairs, ...res });
    if (res.missing) {
      state.schedule.push({ round, stage: BRACKET_STAGE.WINNERS, pairs });
      return state;
    }
    if (!res.decided) return state;
    entrants = res.winners;
  }

  // ---------- 败者组 ----------
  const lbRounds = 2 * rounds - 2;
  let lbEntrants = state.wb[0].losers;
  for (let round = 1; round <= lbRounds; round += 1) {
    let pairs;
    if (round % 2 === 1) {
      // 奇数轮：败者组幸存者内部两两消化（第 1 轮则是胜者组首轮的负者）
      pairs = chunkPairs(lbEntrants);
    } else {
      // 偶数轮：胜者组该轮掉下来的人，与败者组幸存者一一对位
      const droppers = state.wb[round / 2].losers;
      pairs = lbEntrants.map((id, index) => [id, droppers[index] === undefined ? null : droppers[index]]);
    }
    const res = resolvePairs(eventId, round, BRACKET_STAGE.LOSERS, pairs, byId);
    state.lb.push({ round, pairs, ...res });
    if (res.missing) {
      state.schedule.push({ round, stage: BRACKET_STAGE.LOSERS, pairs });
      return state;
    }
    if (!res.decided) return state;
    lbEntrants = res.winners;
  }

  // ---------- 总决赛 ----------
  const wbChamp = state.wb[rounds - 1].winners[0];
  const lbChamp = state.lb[lbRounds - 1].winners[0];
  const gfPairs = [[wbChamp, lbChamp]];
  const gfRes = resolvePairs(eventId, 1, BRACKET_STAGE.GRAND_FINAL, gfPairs, byId);
  state.gf = { pairs: gfPairs, ...gfRes };
  if (gfRes.missing) {
    state.schedule.push({ round: 1, stage: BRACKET_STAGE.GRAND_FINAL, pairs: gfPairs });
    return state;
  }
  if (!gfRes.decided) return state;

  const firstWinner = gfRes.winners[0];
  if (firstWinner === wbChamp || !gfReset) {
    // 胜者组冠军赢下首场，或压根不开重赛：一场定胜负
    state.champion = firstWinner;
    state.runnerUp = firstWinner === wbChamp ? lbChamp : wbChamp;
  } else {
    // 败者组冠军赢了首场：加赛一场（胜者组冠军「先记 1:0」的等价实现）
    const resetPairs = [[wbChamp, lbChamp]];
    const resetRes = resolvePairs(eventId, 2, BRACKET_STAGE.GRAND_FINAL, resetPairs, byId);
    state.gf.reset = { pairs: resetPairs, ...resetRes };
    if (resetRes.missing) {
      state.schedule.push({ round: 2, stage: BRACKET_STAGE.GRAND_FINAL, pairs: resetPairs });
      return state;
    }
    if (!resetRes.decided) return state;
    const resetWinner = resetRes.winners[0];
    state.champion = resetWinner;
    state.runnerUp = resetWinner === wbChamp ? lbChamp : wbChamp;
  }

  state.placements = doubleElimPlacements(state);
  state.complete = true;
  return state;
}

/**
 * 双败的名次：冠军 1、亚军 2，其余按「在败者组第几轮被淘汰」从后往前排。
 *
 * 【为什么按淘汰轮次倒着排】
 * 越晚被淘汰名次越好。败者组最后一轮的负者是最接近决赛的人（第 3 名），
 * 再往前一轮的负者第 4，依此类推。双败里每个人恰好输两次才出局，因此
 * 这样排出来正好是不重不漏的 1..N。同一轮内的若干负者名次相邻。
 *
 * 轮空产生的「幽灵负者」（null）不是人，先滤掉再顺次编号——滤掉后名次
 * 天然连续，不需要再去补空洞。
 *
 * @param {Object} state walkDoubleElim 的状态
 * @returns {Map<string, number>}
 */
function doubleElimPlacements(state) {
  const placements = new Map();
  placements.set(state.champion, 1);
  placements.set(state.runnerUp, 2);
  const order = [];
  for (let index = state.lb.length - 1; index >= 0; index -= 1) {
    state.lb[index].losers.forEach((id) => {
      if (id) order.push(id);
    });
  }
  order.forEach((id, index) => placements.set(id, index + 3));
  return placements;
}

/**
 * 双败淘汰的阶段派发：只把「下一批该排的轮次」交出去。
 *
 * @param {Object} params
 * @param {Object} params.event
 * @param {{size:number, slots:Array<string|null>}} params.bracket
 * @param {Array<Object>} [params.matches]
 * @param {boolean} [params.gfReset]
 * @param {boolean} [params.full=false] 全量投影：把已经排过的胜者组 / 败者组 / 总决赛
 *   轮次也一并交出，而不只是「下一批该排的」。默认 false 保持原行为。
 * @returns {{ok:boolean, rounds:Array<Object>}}
 */
function planDoubleElim({ event, bracket, matches, gfReset = DEFAULT_GF_RESET, full = false } = {}) {
  if (!event || !event._id || !bracket) return { ok: false, rounds: [] };
  const state = walkDoubleElim({ eventId: event._id, bracket, matches, gfReset });

  if (full) {
    // walkDoubleElim 已经把「走得到的每一轮」连同对阵一起算好（走到第一个没打完
    // 的轮次为止），这里只按阶段顺序把它们摊平成轮次列表。
    const rounds = [];
    state.wb.forEach((item) => rounds.push({ round: item.round, stage: BRACKET_STAGE.WINNERS, pairs: item.pairs }));
    state.lb.forEach((item) => rounds.push({ round: item.round, stage: BRACKET_STAGE.LOSERS, pairs: item.pairs }));
    if (state.gf) {
      rounds.push({ round: 1, stage: BRACKET_STAGE.GRAND_FINAL, pairs: state.gf.pairs });
      if (state.gf.reset) {
        rounds.push({ round: 2, stage: BRACKET_STAGE.GRAND_FINAL, pairs: state.gf.reset.pairs });
      }
    }
    return { ok: rounds.length > 0, rounds };
  }

  if (state.schedule.length === 0) return { ok: false, rounds: [] };
  return { ok: true, rounds: state.schedule };
}

/**
 * 循环赛 / 小组赛阶段：逐组推算还缺哪一轮。
 *
 * 【闸门为什么是「上一轮全部打完」】
 * 循环表的对局虽然提前就确定，但一轮没打完就冒下一轮，界面会同时铺开
 * 好几轮的比赛，签到与录分的人分不清先后。所以每组的第 r 轮只在第 r−1
 * 轮全部生效后才放出来。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @param {boolean} [full=false] 全量投影：已排过的小组轮次也一并交出
 * @returns {Array<Object>}
 */
function planGroupPhase(event, draw, matches, full = false) {
  const rounds = [];
  (Array.isArray(draw.groups) ? draw.groups : []).forEach((item) => {
    const schedule = scheduleOf(item);
    const byId = groupMatchIndex(matches, item.group);

    for (let index = 0; index < schedule.length; index += 1) {
      const roundNo = index + 1;
      const pairs = schedule[index];
      const allExist = pairs.every((pair, slot) =>
        byId.has(eventMatchKey(event._id, roundNo, BRACKET_STAGE.GROUP, slot, item.group))
      );

      if (!allExist) {
        const previousDone =
          index === 0 ||
          roundDecided(schedule[index - 1], roundNo - 1, byId, event._id, item.group);
        if (previousDone) {
          rounds.push({ group: item.group, round: roundNo, stage: BRACKET_STAGE.GROUP, pairs });
        }
        break;
      }

      // 全量投影：这一轮已经排过，但它同样属于「此刻应当存在」，照样交出
      if (full) rounds.push({ group: item.group, round: roundNo, stage: BRACKET_STAGE.GROUP, pairs });
      if (!roundDecided(pairs, roundNo, byId, event._id, item.group)) break;
    }
  });

  return rounds;
}

/**
 * 小组赛出线后的淘汰签表。
 *
 * 【跨组交叉怎么保证】
 * 出线者先按「组内名次优先、组号其次」排成一列（各组第 1 名在最前），
 * 再套标准种子排位表落位。这样同组两人第一轮必不相遇，且 A1 天然对上
 * 别组的第二档——正是「A1 对 B2」那种交叉。
 *
 * 签位不落库：小组一有风吹草动（改判一场），下一次调用就重推一遍，
 * 不会留下一张与结果对不上的旧签表。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @returns {{size:number, slots:Array<string|null>, qualifiers:string[], ranked:Array}|null}
 */
function knockoutBracket(event, draw, matches) {
  const groups = Array.isArray(draw.groups) ? draw.groups : [];
  if (groups.length === 0) return null;

  const advance = normalizeAdvancePerGroup(event.advancePerGroup);
  const ranked = [];

  for (const item of groups) {
    const groupMatches = (Array.isArray(matches) ? matches : []).filter(
      (match) => match && match.group === item.group
    );
    // 只要有一个小组没打完，出线名单就没定，淘汰签表无从谈起
    if (scheduleOf(item).length > 0 && !allDecided(groupMatches)) return null;
    ranked.push({
      group: item.group,
      rows: computeStandings({ entries: item.entries || [], matches: groupMatches }),
    });
  }

  const qualifiers = [];
  for (let rank = 0; rank < advance; rank += 1) {
    ranked.forEach((item) => {
      const row = item.rows[rank];
      if (row) qualifiers.push(row.id);
    });
  }
  if (qualifiers.length < 2) return null;

  const size = bracketSizeOf(qualifiers.length);
  const order = standardSeedOrder(size);
  const slots = order.map((rank) => qualifiers[rank - 1] || null);

  return { size, slots, qualifiers, ranked };
}

/**
 * 按赛制推导名次表（名次页预填用）。
 *
 * 【循环赛的名次是算出来的】
 * 淘汰赛的名次由「输了第几轮」决定，循环赛由积分表决定。两者口径不同，
 * 所以这里按赛制分支：循环 / 小组赛返回确定的名次；单败淘汰仍交给管理员
 * 手工录入（倒三角排位赛在场次上已经打出来了，名次在这里一并算好）。
 *
 * @param {Object} params
 * @param {Object} params.event
 * @param {Object} params.draw
 * @param {Array<Object>} [params.matches]
 * @returns {{ok:boolean, results:Array<{userId:string, placement:number}>, message:string}}
 */
function derivePlacements({ event, draw, matches } = {}) {
  if (!event || !draw) {
    return { ok: false, results: [], message: '还没有可推导的赛程' };
  }
  const list = Array.isArray(matches) ? matches : [];
  const format = formatOf(event);

  if (format === EVENT_FORMAT.ROUND_ROBIN) {
    const item = (draw.groups || [])[0];
    if (!item) return { ok: false, results: [], message: '还没有分组信息' };
    const groupMatches = list.filter((match) => match && match.group === item.group);
    // 【单人组为什么直接算已定】（第十八轮审查 P3）
    // `allDecided([])` 为 false（「一场都没打」不能算打完），而单人循环赛本来就没有
    // 可打的比赛，于是名次永远推不出来。只有「参赛者不超过 1 人」才跳过这道闸门；
    // 三人组零比赛仍然按「还没打完」处理（不要把空台账当成已完赛）。
    const entryCount = Array.isArray(item.entries) ? item.entries.length : 0;
    if (entryCount > 1 && !allDecided(groupMatches)) {
      return { ok: false, results: [], message: '循环赛还没打完，名次尚未确定' };
    }
    const rows = computeStandings({ entries: item.entries || [], matches: groupMatches });
    return { ok: true, results: rows.map((row) => ({ userId: row.id, placement: row.rank })), message: '' };
  }

  if (GROUPED_FORMATS.includes(format)) {
    return deriveGroupedPlacements(event, draw, list);
  }

  if (hasDoubleKnockout(format)) {
    const gfReset = event.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(event.gfReset);
    const state = walkDoubleElim({ eventId: event._id, bracket: draw, matches: list, gfReset });
    if (!state.complete || !state.placements) {
      return { ok: false, results: [], message: '比赛还没打完，名次尚未确定' };
    }
    return { ok: true, results: sortedResults(state.placements), message: '' };
  }

  if (format === EVENT_FORMAT.SINGLE_ELIM) {
    const placements = placementsFromBracket(event, draw, list);
    if (!placements) {
      return { ok: false, results: [], message: '比赛还没打完，名次尚未确定' };
    }
    const results = Array.from(placements, ([userId, placement]) => ({ userId, placement }));
    results.sort((a, b) => a.placement - b.placement);
    return { ok: true, results, message: '' };
  }

  return { ok: false, results: [], message: '该赛制的名次请手工录入' };
}

/**
 * 小组赛 + 淘汰：出线者按淘汰成绩、未出线者按小组名次续排。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @returns {{ok:boolean, results:Array<Object>, message:string}}
 */
function deriveGroupedPlacements(event, draw, matches) {
  const bracket = knockoutBracket(event, draw, matches);
  if (!bracket) {
    return { ok: false, results: [], message: '小组赛还没打完，名次尚未确定' };
  }

  let knockout;
  if (hasDoubleKnockout(formatOf(event))) {
    const gfReset = event.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(event.gfReset);
    const state = walkDoubleElim({ eventId: event._id, bracket, matches, gfReset });
    knockout = state.complete ? state.placements : null;
  } else {
    knockout = placementsFromBracket(event, bracket, matches);
  }
  if (!knockout) {
    return { ok: false, results: [], message: '淘汰赛还没打完，名次尚未确定' };
  }

  const advance = normalizeAdvancePerGroup(event.advancePerGroup);
  const results = [];
  knockout.forEach((placement, userId) => results.push({ userId, placement }));

  // 未出线者：组内名次越靠前，总名次越靠前；同名义次按组号定序
  const rest = [];
  bracket.ranked.forEach((item) => {
    item.rows.forEach((row, index) => {
      if (index + 1 > advance) rest.push({ userId: row.id, rank: index + 1, group: item.group });
    });
  });
  rest.sort((a, b) => a.rank - b.rank || a.group - b.group);

  let next = bracket.qualifiers.length + 1;
  rest.forEach((item) => {
    results.push({ userId: item.userId, placement: next });
    next += 1;
  });

  results.sort((a, b) => a.placement - b.placement);
  return { ok: true, results, message: '' };
}

/**
 * 从淘汰签表逐轮推算每个人的名次。
 *
 * 并列口径：半决赛负者在「打三四名」时分成 3 / 4，并列季军时同为 3；
 * 八强负者在开了排位赛时分出 5–8，否则并列第 5。这与 points.js 的
 * 档位表一一对应（5–8 名同档），所以并列不会让积分算错。
 *
 * 任何一场该定而未定（含季军赛、排位赛）就返回 null——名次表宁可
 * 晚一点出，也不能出一个半截的。
 *
 * @param {Object} event
 * @param {{size:number, slots:Array<string|null>}} bracket
 * @param {Array<Object>} matches
 * @returns {Map<string, number>|null}
 */
function placementsFromBracket(event, bracket, matches) {
  const eventId = event._id;
  const byId = new Map((Array.isArray(matches) ? matches : []).map((match) => [match && match._id, match]));
  const slots = Array.isArray(bracket.slots) ? bracket.slots : [];
  const size = Number(bracket.size) || slots.length;
  const totalRounds = Math.round(Math.log2(size));
  if (totalRounds < 1) return null;

  const placements = new Map();
  const decided = (key) => {
    const match = byId.get(key);
    return match && match.status === MATCH_STATUS.ACTIVE && match.winner ? match : null;
  };

  let entrants = slots.slice();

  for (let round = 1; round <= totalRounds; round += 1) {
    const pairs = chunkPairs(entrants);
    const winners = [];
    const losers = [];
    let complete = true;

    pairs.forEach((pair, slot) => {
      const a = pair[0];
      const b = pair[1];
      if (!a && !b) return;
      if (!a || !b) {
        winners.push(a || b);
        return;
      }
      const match = decided(eventMatchKey(eventId, round, BRACKET_STAGE.MAIN, slot));
      if (!match) {
        complete = false;
        return;
      }
      winners.push(match.winner === 'A' ? a : b);
      losers.push(match.winner === 'A' ? b : a);
    });

    if (!complete) return null;

    if (round === totalRounds) {
      placements.set(winners[0], 1);
      placements.set(losers[0], 2);
      break;
    }

    // 半决赛的两名负者
    if (round === totalRounds - 1 && losers.length === 2) {
      const [x, y] = losers;
      if (event.bronzeMode === EVENT_BRONZE_MODE.PLAYOFF) {
        const bronze = decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.BRONZE, 0));
        if (!bronze) return null;
        placements.set(bronze.winner === 'A' ? x : y, 3);
        placements.set(bronze.winner === 'A' ? y : x, 4);
      } else {
        placements.set(x, 3);
        placements.set(y, 3);
      }
      entrants = winners;
      continue;
    }

    // 八强战的四名负者
    if (losers.length === 4) {
      if (event.placementMode === EVENT_PLACEMENT_MODE.TOP8) {
        const first = [
          decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.PLACEMENT, 0)),
          decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.PLACEMENT, 1)),
        ];
        const finals = [
          decided(eventMatchKey(eventId, round + 2, BRACKET_STAGE.PLACEMENT, 0)),
          decided(eventMatchKey(eventId, round + 2, BRACKET_STAGE.PLACEMENT, 1)),
        ];
        if (first.some((match) => !match) || finals.some((match) => !match)) return null;
        // 排位半决的两场：胜者去争 5/6，负者去争 7/8
        const upper = [0, 1].map((slot) =>
          first[slot].winner === 'A' ? losers[slot * 2] : losers[slot * 2 + 1]
        );
        const lower = [0, 1].map((slot) =>
          first[slot].winner === 'A' ? losers[slot * 2 + 1] : losers[slot * 2]
        );
        assignments(finals[0], upper, placements, 5, 6);
        assignments(finals[1], lower, placements, 7, 8);
      } else {
        losers.forEach((id) => placements.set(id, 5));
      }
      entrants = winners;
      continue;
    }

    // 更早轮次的负者：并列在 2^k + 1 名（与 5–8 同档的旧口径一致）
    const base = Math.pow(2, totalRounds - round) + 1;
    losers.forEach((id) => placements.set(id, base));
    entrants = winners;
  }

  return placements;
}

/** 把 Map<userId, placement> 转成按名次排好的 results */
function sortedResults(placements) {
  return Array.from(placements, ([userId, placement]) => ({ userId, placement })).sort(
    (a, b) => a.placement - b.placement
  );
}

/** 把一场排位赛的胜者与负者分别写到两个名次上 */
function assignments(match, pair, placements, winnerPlacement, loserPlacement) {
  placements.set(match.winner === 'A' ? pair[0] : pair[1], winnerPlacement);
  placements.set(match.winner === 'A' ? pair[1] : pair[0], loserPlacement);
}

/* ------------------------------------------------------------
 * 小组辅助
 * ---------------------------------------------------------- */

/** 某组已有的比赛，按编号索引 */
function groupMatchIndex(matches, group) {
  return new Map(
    (Array.isArray(matches) ? matches : [])
      .filter((match) => match && match.group === group)
      .map((match) => [match._id, match])
  );
}

/** 一组某轮是否全部生效并分出胜负 */
function roundDecided(pairs, roundNo, byId, eventId, group) {
  return pairs.every((pair, slot) => {
    const match = byId.get(eventMatchKey(eventId, roundNo, BRACKET_STAGE.GROUP, slot, group));
    return Boolean(match && match.status === MATCH_STATUS.ACTIVE && match.winner);
  });
}

/** 从 draw 的分组条目重排该组全部轮次（确定性，无需落库） */
function scheduleOf(item) {
  return roundRobinRounds(item.entries || []);
}

/** 某组某一轮的比赛草稿 */
function groupRoundDrafts(event, item, roundNo, matchFormat = DEFAULT_FORMAT) {
  const schedule = scheduleOf(item);
  const pairs = schedule[roundNo - 1];
  if (!pairs) return [];
  return buildRoundMatches(event, {
    round: roundNo,
    stage: BRACKET_STAGE.GROUP,
    pairs,
    format: matchFormat,
    group: item.group,
  });
}

module.exports = {
  buildInitialMatches,
  buildPlannedDrafts,
  planStageMatches,
  findDependentMatches,
  planGroupPhase,
  planSingleKnockout,
  knockoutBracket,
  derivePlacements,
  placementsFromBracket,
  hasDoubleKnockout,
  planDoubleElim,
  walkDoubleElim,
  doubleElimPlacements,
  sortedResults,
};
