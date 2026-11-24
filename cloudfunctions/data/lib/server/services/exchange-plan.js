/**
 * S4 跨校邀请赛：抽签落位、签表推进与名次推导（支持全部赛制）
 * ============================================================
 * 【这一层只做「翻译」】
 * 邀请赛原先只有单打单败淘汰，于是自己写了一套走签表的代码。现在要支持
 * 与普通赛事同样的六种赛制（单败 / 循环 / 小组+淘汰 / 循环+淘汰 / 双败 /
 * 小组+双败），再各写一套就会和 `format-plan.js` 分叉——而那个模块正是
 * 全项目唯一的「赛制 → 有序阶段序列」派发器（单败 / 循环 / 小组 / 双败 /
 * 复合都由它推）。
 *
 * 所以这里改成**薄适配层**：
 *   - 抽签落位交给 `draw.js`（planGroupDraw / drawBracket，与校内同一套）；
 *   - 对阵推进交给 `format-plan.planStageMatches`（full 模式交出全量投影）；
 *   - 名次推导交给 `format-plan.derivePlacements`；
 *   - 撤销前的依赖自查交给 `format-plan.findDependentMatches`。
 *
 * 【两套记录形状为什么要翻译】
 * 通用引擎认的是普通赛事的比赛记录：编号由 `draw.eventMatchKey` 拼出、
 * 状态是数字 `MATCH_STATUS`、胜负记 'A' / 'B'、一方是 `teamA` 数组。
 * 而邀请赛的比赛记录是另一套（`exchange_matches` 集合）：编号带 `xm:`
 * 前缀、状态是 'pending' / 'active' 字符串、`winner` 直接记胜者 userId、
 * 一方是 `playerA`、还带代表学校与裁判。两者的存储契约都不想改，于是
 * 在中间加一层 `engineMatchOf`（跨校记录 → 引擎视角）与 `exchangeDraftOf`
 * （引擎对阵 → 跨校记录），只在这两个函数里做映射。
 *
 * 【为什么编号里要塞下阶段与小组】
 * 双败有胜者组 / 败者组 / 总决赛，小组赛有 A 组第 2 轮与 B 组第 2 轮——
 * 光靠「第几轮第几场」根本分不开。于是编号把 stage 与 group 一并编码；
 * 单败淘汰的编号因此也变了形（本轮无线上数据，安全）。轮空不生成比赛，
 * 与普通赛事同一条纪律。
 *
 * 【名次怎么来】
 * 单败由「输了第几轮」推、循环按积分表算、双败按淘汰轮次排——三套口径
 * 都在 `format-plan.derivePlacements` 里，这里只把结果转成纯对象。
 * ============================================================
 */

const { schoolKey } = require('../../shared/utils/school.js');
const { drawBracket } = require('../../shared/utils/bracket.js');
const { createSeededRandom } = require('../../shared/utils/random.js');
const {
  MATCH_STATUS,
  BRACKET_STAGE,
  EVENT_FORMAT,
  DEFAULT_EVENT_FORMAT,
  GROUPED_FORMATS,
  GROUP_COUNT_FORMATS,
  DOUBLE_ELIM_FORMATS,
} = require('../../shared/utils/constants.js');
const { eventMatchKey, planGroupDraw, normalizeGroupCount, normalizeAdvancePerGroup } = require('../../shared/services/draw.js');
const { planStageMatches, derivePlacements, findDependentMatches } = require('../../shared/services/format-plan.js');

/** 合法赛制集合（与普通赛事同一枚举） */
const VALID_FORMATS = Object.values(EVENT_FORMAT);

/**
 * 单场跨校比赛的记录键。
 *
 * 键里必须同时含阶段与小组：双败的「败者组第 2 轮第 1 场」与「胜者组第 2 轮
 * 第 1 场」是两场不同的比赛；小组赛的「第 1 组第 2 轮」与「第 2 组第 2 轮」
 * 也各是一张不同的桌子。键只由「位置」决定、不含人与时间，抽多少次都复算得出。
 *
 * @param {string} eventId
 * @param {number} round 轮次，从 1 起
 * @param {number} slot 该轮内的签位序号，从 0 起
 * @param {string} [stage] 见 constants.BRACKET_STAGE
 * @param {number} [group] 小组序号，从 0 起；不传表示无小组
 * @returns {string}
 */
function exchangeMatchKey(eventId, round, slot, stage, group) {
  const hasGroup = group !== undefined && group !== null && group !== '';
  const middle = hasGroup
    ? `g${group}_r${round}_${stage || BRACKET_STAGE.MAIN}`
    : `r${round}_${stage || BRACKET_STAGE.MAIN}`;
  return schoolKey('xm', eventId, middle, String(slot));
}

/** 阶段值收敛到已知枚举；缺省 / 非法一律按主赛处理（老记录无感） */
function stageOf(value) {
  return Object.values(BRACKET_STAGE).includes(value) ? value : BRACKET_STAGE.MAIN;
}

/** 跨校的字符串状态 → 通用引擎的数字状态 */
function numericStatus(status) {
  if (status === 'active') return MATCH_STATUS.ACTIVE;
  if (status === 'revoked') return MATCH_STATUS.REVOKED;
  return MATCH_STATUS.PENDING;
}

/**
 * 跨校比赛记录 → 通用赛制引擎认识的形状（纯投影，不落库）。
 *
 * 【为什么比分要折成一局】
 * 通用引擎按「逐局比分」算积分表；邀请赛只录一个整数比分（谁赢多少分）。
 * 把整数折成「一局」既保留了净胜分，也不必让邀请赛背上局制的复杂度。
 * 未录分时给空数组——`standings.tallyOf` 见到空数组会跳过，不会误算。
 *
 * @param {Object} match 跨校比赛记录
 * @returns {Object}
 */
function engineMatchOf(match) {
  const stage = stageOf(match.stage);
  const playerA = match.playerA || '';
  const playerB = match.playerB || '';
  const scored = Number.isInteger(match.scoreA) && Number.isInteger(match.scoreB);
  return {
    _id: eventMatchKey(match.eventId, match.round, stage, match.slot, match.group),
    eventId: match.eventId,
    round: match.round,
    stage,
    slot: match.slot,
    group: match.group,
    status: numericStatus(match.status),
    winner: match.winner ? (match.winner === playerA ? 'A' : 'B') : '',
    teamA: [playerA],
    teamB: [playerB],
    scoreA: scored ? [match.scoreA] : [],
    scoreB: scored ? [match.scoreB] : [],
    // 只用于把引擎的返回结果映射回真实记录编号
    __xid: match._id,
  };
}

/**
 * 引擎给的一对对阵 → 一场跨校比赛草稿。
 * 双方都要有才生成（轮空不生成比赛，与普通赛事同一纪律）。
 *
 * @param {Object} event 邀请赛记录（取 _id）
 * @param {Object} params
 * @returns {Object}
 */
function exchangeDraftOf(event, { round, stage, slot, group, playerA, playerB, entrantsById }) {
  const schoolOf = (userId) => {
    const row = entrantsById instanceof Map ? entrantsById.get(userId) : null;
    return (row && row.schoolId) || '';
  };
  const draft = {
    _id: exchangeMatchKey(event._id, round, slot, stage, group),
    eventId: event._id,
    round,
    stage,
    slot,
    playerA,
    playerB,
    schoolA: schoolOf(playerA),
    schoolB: schoolOf(playerB),
    scoreA: null,
    scoreB: null,
    winner: '',
    status: 'pending',
    referee: '',
    refereeAt: null,
    refereeBy: '',
    recordedBy: '',
    recordedAt: null,
    revision: 1,
  };
  if (group !== undefined && group !== null && group !== '') draft.group = group;
  return draft;
}

/**
 * 抽签落位：把报名者随机落进签表 / 分进小组。
 * 不设种子（跨校不混排两校校内 ELO），因此是纯随机；seedValue 落库备查。
 *
 * @param {Object} params
 * @param {Array<{userId:string}>} [params.entries]
 * @param {number} params.seedValue
 * @param {string} [params.format] 见 constants.EVENT_FORMAT
 * @param {number} [params.groupCount] 仅小组赛类赛制有意义
 * @param {number} [params.advancePerGroup] 仅出线类赛制有意义
 * @returns {{ok:true, draw:Object}|{ok:false, message:string}}
 */
function planExchangeDraw({ entries, seedValue, format, groupCount, advancePerGroup } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const seed = Number(seedValue);
  if (!Number.isFinite(seed)) return { ok: false, message: '缺少随机种子值，无法抽签' };
  const fmt = VALID_FORMATS.includes(format) ? format : DEFAULT_EVENT_FORMAT;
  // 先按 userId 排序，落位只由种子值决定，与报名先后无关。
  const ids = list.map((entry) => entry.userId).sort();
  if (ids.length < 2) return { ok: false, message: '至少需要两名参赛者才能抽签' };

  // 循环 / 小组赛不摆签表，改成分组 + 圆桌排期
  if (GROUPED_FORMATS.includes(fmt)) {
    const count = GROUP_COUNT_FORMATS.includes(fmt) ? normalizeGroupCount(groupCount) : 1;
    const grouped = planGroupDraw({ entries: ids, seeds: [], groupCount: count, seedValue: seed });
    if (!grouped.ok) return { ok: false, message: grouped.firstError };
    if (fmt === EVENT_FORMAT.GROUP_DOUBLE_ELIM) {
      // 双败淘汰阶段至少 4 名出线者：2 个人排不出败者组
      const advance = normalizeAdvancePerGroup(advancePerGroup);
      const qualifiers = grouped.groups.reduce(
        (sum, item) => sum + Math.min(advance, (item.entries || []).length),
        0
      );
      if (qualifiers < 4) return { ok: false, message: '双败淘汰阶段至少需要 4 名出线者，请调整分组或出线人数' };
    }
    return {
      ok: true,
      draw: { seedValue: seed, format: fmt, size: 0, slots: [], byes: [], groups: grouped.groups },
    };
  }

  if (DOUBLE_ELIM_FORMATS.includes(fmt) && ids.length < 4) {
    return { ok: false, message: '双败淘汰至少需要 4 名参赛者' };
  }

  const drawn = drawBracket({ entries: ids, seeds: [], random: createSeededRandom(seed) });
  if (!drawn.ok) return { ok: false, message: drawn.firstError };
  return {
    ok: true,
    draw: { seedValue: seed, format: fmt, size: drawn.size, slots: drawn.slots, byes: drawn.byes },
  };
}

/**
 * 依当前比分推进赛程，返回「此刻应当存在的全部比赛」（全量投影）。
 *
 * 与普通赛事的逐轮补入不同，这里每次都交出完整的一份，由调用方与台账比对：
 * 缺的补上、对阵变了的刷新（已生效的比分一律不动）。这样才能覆盖
 * 「撤掉半决赛重录 → 已经存在的决赛要换人」这种改签表场景。
 *
 * @param {Object} params
 * @param {Object} params.event 邀请赛记录（含 format / bronzeMode 等赛制字段）
 * @param {Object} params.draw 赛事的 draw 字段
 * @param {Map} params.entrantsById userId → { userId, schoolId }
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛
 * @returns {{ok:boolean, matches:Array<Object>}}
 */
function planExchangeMatches({ event, draw, entrantsById, matches } = {}) {
  if (!event || !event._id || !draw) return { ok: false, matches: [] };
  const list = Array.isArray(matches) ? matches : [];
  const existingById = new Map(list.map((row) => [row && row._id, row]));
  const planned = planStageMatches({ event, draw, matches: list.map(engineMatchOf), full: true });

  const drafts = new Map();
  (planned.rounds || []).forEach((roundPlan) => {
    const pairs = Array.isArray(roundPlan.pairs) ? roundPlan.pairs : [];
    pairs.forEach((pair, slot) => {
      const playerA = pair && pair[0];
      const playerB = pair && pair[1];
      if (!playerA || !playerB) return;
      const draft = exchangeDraftOf(event, {
        round: roundPlan.round,
        stage: stageOf(roundPlan.stage),
        slot,
        group: roundPlan.group,
        playerA,
        playerB,
        entrantsById,
      });
      const existing = existingById.get(draft._id);
      if (!existing) {
        drafts.set(draft._id, draft);
        return;
      }
      // 已生效的比分是既成事实，一律不覆盖（撤销入口已经要求从后往前撤）
      if (existing.status === 'active') {
        drafts.set(draft._id, existing);
        return;
      }
      // 对阵没变：原样保留（状态、比分、裁判都还在），别把「待比赛」洗成新记录
      if (existing.playerA === draft.playerA && existing.playerB === draft.playerB && existing.status === draft.status) {
        drafts.set(draft._id, existing);
        return;
      }
      // 对阵换了人：刷新成待比赛，比分与裁判一并清掉（与普通赛事改签表同一口径）
      drafts.set(draft._id, { ...draft, revision: Number(existing.revision || 1) + 1 });
    });
  });
  return { ok: true, matches: [...drafts.values()] };
}

/**
 * 由已确认比分推出名次。名次口径按赛制分流（见 format-plan.derivePlacements）。
 *
 * @param {Object} params
 * @param {Object} params.event 邀请赛记录
 * @param {Object} params.draw 赛事的 draw 字段
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛
 * @returns {{ok:boolean, results:Array<{userId:string, placement:number}>, message:string}}
 */
function placementsFromExchange({ event, draw, matches } = {}) {
  if (!event || !draw) return { ok: false, results: [], message: '还没有可推导的赛程' };
  const list = Array.isArray(matches) ? matches : [];
  // 收官闸门：凡「此刻应当存在」的比赛都必须已经确认，否则名次是半截的。
  // 这一道比逐条比对更严：小组赛还有轮次没排、双败还有落败者没打下来，
  // 都会在这里现形，而不必为每种赛制各写一条完成判据。
  const projected = planExchangeMatches({ event, draw, entrantsById: new Map(), matches: list });
  if (projected.matches.some((row) => row.status !== 'active')) {
    return { ok: false, results: [], message: '还有比赛未确认比分，名次尚未确定' };
  }
  const placed = derivePlacements({ event, draw, matches: list.map(engineMatchOf) });
  if (!placed.ok) return { ok: false, results: [], message: placed.message };
  return {
    ok: true,
    results: placed.results.map((row) => ({ userId: row.userId, placement: row.placement })),
    message: '',
  };
}

/**
 * 从「投影出的整张签表」里挑出**真正需要落库的场次**。
 *
 * 【为什么需要它】（2026-10-23 第三轮审查 X-1）
 * `planExchangeMatches({ full: true })` 交出的是「此刻应当存在的**全部**对阵」，
 * 而调用方（录分、撤销）每次都在事务里逐场 `getById` 一遍，只为判断要不要补写。
 * 签表越大，事务操作数线性增长：128 人单败在第 2 轮就有 96 场，
 * 加上事件读、本场读写与审计，直接越过云端 100 次操作的上限——
 * 表现为「抽签正常、第一轮正常，第二轮起每场录分都报服务异常」。
 *
 * 【为什么可以在事务外算差分】
 * 入参 `current` 是调用方**已经读到的**最新台账（`exchangeMatches.listByEvent`），
 * 且事务内还有一道 `event.revision / match.revision` 比对（变了就要求刷新重试）。
 * 既然台账版本没变，那么「不需要改的场次」在事务里也不会需要改——不必逐场重读。
 *
 * 【返回什么】
 *   · 台账里没有的编号 → 新对阵，要补写；
 *   · 台账里已生效（status = active）→ 既成事实，不动；
 *   · 对阵双方与状态都没变 → 不动；
 *   · 其余（换人 / 状态回退）→ 要刷新。
 *
 * 正常情况下一次录分只影响「本场 + 下一轮那一条」，与签表总规模无关。
 *
 * @param {Array<Object>} current 当前台账（含本次待写入的那场，即已合并 preview 的列表）
 * @param {Array<Object>} projected planExchangeMatches 产出的全量投影
 * @returns {Array<Object>} 需要落库的投影行
 */
function changedExchangeMatches(current, projected) {
  const byId = new Map((Array.isArray(current) ? current : [])
    .filter((row) => row && row._id)
    .map((row) => [row._id, row]));
  return (Array.isArray(projected) ? projected : []).filter((row) => {
    if (!row || !row._id) return false;
    const old = byId.get(row._id);
    if (!old) return true;
    // 已生效的比分是既成事实（撤销有专门入口，且要求从后往前撤）
    if (old.status === 'active') return false;
    return old.playerA !== row.playerA || old.playerB !== row.playerB || old.status !== row.status;
  });
}

/**
 * 撤销前的依赖自查：找出「已经排在这场比赛之后」的场次（返回真实记录编号）。
 *
 * 与普通赛事同一口径：撤掉前面一场，后面那几场还挂着已经作废的晋级者，
 * 必须要求管理员从最后一轮往前撤。这里只回答「谁挡在后面」，不动数据。
 *
 * @param {Object} params
 * @param {Object} params.match 准备撤销的那场（跨校记录）
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛（跨校记录）
 * @returns {string[]} 挡在后面的比赛编号
 */
function findExchangeDependents({ match, matches } = {}) {
  if (!match) return [];
  const list = Array.isArray(matches) ? matches : [];
  const engine = list.map(engineMatchOf);
  const target = engine.find((row) => row.__xid === match._id);
  if (!target) return [];
  return findDependentMatches({ match: target, matches: engine }).map((row) => row.__xid);
}

module.exports = {
  exchangeMatchKey,
  engineMatchOf,
  exchangeDraftOf,
  planExchangeDraw,
  planExchangeMatches,
  changedExchangeMatches,
  placementsFromExchange,
  findExchangeDependents,
};
