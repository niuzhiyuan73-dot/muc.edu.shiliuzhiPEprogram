/**
 * 学院赛抽签 —— 学院进签表、手工指定种子、名单锁定
 * ============================================================
 * 学院赛的抽签与个人赛（services/draw.js）是两条链路，但落位算法同宗：
 * 都调 utils/bracket.js 的 drawBracket，只是「参赛者」从个人变成了学院。
 * 这个模块回答抽签这一步的问题：
 *   1. 现在能不能抽签？（管理员 + 报名中）
 *   2. 哪些学院进签表？（只收已通过的名单，D11）
 *   3. 种子怎么排？（管理员手工指定，D17）
 *   4. 签表长什么样、怎么落库？
 *
 * 【为什么种子只做手工】
 * 学院没有等级分。个人赛可以按 ELO / 积分自动排种子，学院赛没有这份数据，
 * 也不该拿院内个人的平均分去猜（那会把「学院实力」变成「尖子生实力」）。
 * D17 因此定死：种子由管理员按顺序点选，先点的排 1 号。
 *
 * 【抽签为什么等于锁定名单】
 * 抽签一落库，赛事就从「报名中」转「待开赛」。名单的提交权只看赛事是不是
 * 报名中（见 college-entry.canSubmitCollegeEntry），于是抽签之后名单自然
 * 不可再改——不需要在名单记录上另打一个 locked 标记，少一个可能与状态
 * 脱节的字段。
 *
 * 【为什么轮空也进 slots，但不生成大场】
 * drawBracket 会把人数补齐到 2 的幂，多出的位置为 null（轮空）。轮空者
 * 不动手就进下一轮，没有对手可打，因此 college-tie 生成首轮时会跳过这些
 * 签位；但 slots 仍原样留着，下一轮靠它 + 本轮胜者推演出来。
 *
 * 纯函数，不碰 wx、不碰数据源，可在 Node 里完整测试。
 * ============================================================
 */

const {
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  BRACKET_STAGE,
} = require('../utils/constants.js');
const { createSeededRandom } = require('../utils/random.js');
const { drawBracket } = require('../utils/bracket.js');
const { canManageCollegeEvent } = require('./college-event.js');

/* ============================================================
 * 权限与名单口径
 * ============================================================ */

/**
 * 能不能发起抽签。**仅管理员**，且赛事必须在「报名中」。
 *
 * 与发布学院赛同一门槛：抽签定的是整场赛事的对阵结构，一旦抽出，
 * 所有学院的对手就确定了，事后修改等于重排整场赛事。
 *
 * @param {Object|null} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canDrawCollegeEvent(event, actor, options = {}) {
  if (!event || event.status !== COLLEGE_EVENT_STATUS.SIGNUP) return false;
  return canManageCollegeEvent(actor, options);
}

/**
 * 已通过审核的学院列表（进签表的学院）。
 *
 * 【为什么只收已通过】
 * 待审核 / 已退回的名单还没得到管理员确认，若也能进签表，就会出现
 * 「抽完签才发现这份名单没通过」的尴尬。抽签只认 APPROVED。
 *
 * 结果去重并按全名排序：抽签的随机性只该来自 seedValue，输入顺序若随
 * 提交时间漂移，同一个 seedValue 复核出的签表就对不上。
 *
 * @param {Array<Object>} [entries] college_entries 记录
 * @returns {string[]}
 */
function approvedCollegesOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const colleges = list
    .filter((item) => item && item.status === COLLEGE_ENTRY_STATUS.APPROVED)
    .map((item) => String(item.college || '').trim())
    .filter(Boolean);
  return Array.from(new Set(colleges)).sort();
}

/* ============================================================
 * 校验与计划
 * ============================================================ */

/**
 * 校验一次抽签的输入。
 *
 * @param {Object} params
 * @param {Object|null} params.event
 * @param {Object|null} params.actor
 * @param {Array<Object>} [params.entries] 名单记录
 * @param {Array<string>} [params.seedColleges] 手工指定的种子学院（按 1 号、2 号…）
 * @returns {{ok:boolean, message:string, colleges:string[], seeds:string[]}}
 */
function validateCollegeDraw({ event = null, actor = null, entries = [], seedColleges = [] } = {}) {
  if (!event) {
    return { ok: false, message: '找不到这场学院赛', colleges: [], seeds: [] };
  }
  if (!canDrawCollegeEvent(event, actor)) {
    if (event.status !== COLLEGE_EVENT_STATUS.SIGNUP) {
      return { ok: false, message: '只能在报名阶段抽签', colleges: [], seeds: [] };
    }
    return { ok: false, message: '只有管理员可以抽签', colleges: [], seeds: [] };
  }

  const colleges = approvedCollegesOf(entries);
  if (colleges.length < 2) {
    return { ok: false, message: '已通过审核的学院不足 2 个，无法抽签', colleges, seeds: [] };
  }

  const raw = Array.isArray(seedColleges) ? seedColleges : [];
  const seeds = Array.from(new Set(raw.map((name) => String(name || '').trim()).filter(Boolean)));
  if (seeds.length !== raw.filter((name) => String(name || '').trim()).length) {
    return { ok: false, message: '种子学院不能重复', colleges, seeds: [] };
  }
  if (seeds.some((name) => !colleges.includes(name))) {
    return { ok: false, message: '种子必须是已通过审核的学院之一', colleges, seeds: [] };
  }
  if (seeds.length > colleges.length) {
    return { ok: false, message: '种子学院数不能超过参赛学院数', colleges, seeds: [] };
  }

  return { ok: true, message: '', colleges, seeds };
}

/**
 * 计划一次学院赛抽签。纯函数，产出签表内容但不落库。
 *
 * @param {Object} params
 * @param {Object} params.event
 * @param {Object|null} params.actor
 * @param {Array<Object>} [params.entries] 名单记录
 * @param {Array<string>} [params.seedColleges] 手工种子（有序）
 * @param {number} params.seedValue 随机种子值（落库备查，可复核）
 * @returns {{ok:boolean, message:string, size:number, slots:Array<string|null>, byes:string[], pairs:Array<Array<string|null>>, seeds:string[], colleges:string[], seedValue:number|null}}
 */
function planCollegeDraw({ event, actor = null, entries = [], seedColleges = [], seedValue } = {}) {
  const checked = validateCollegeDraw({ event, actor, entries, seedColleges });
  if (!checked.ok) {
    return { ...emptyPlan(), message: checked.message };
  }

  const value = Number(seedValue);
  if (!Number.isFinite(value)) {
    return { ...emptyPlan(), message: '缺少随机种子值，无法抽签' };
  }

  const bracket = drawBracket({
    entries: checked.colleges,
    seeds: checked.seeds,
    random: createSeededRandom(value),
  });
  if (!bracket.ok) {
    return { ...emptyPlan(), message: bracket.firstError };
  }

  return {
    ok: true,
    message: '',
    size: bracket.size,
    slots: bracket.slots,
    byes: bracket.byes,
    pairs: bracket.pairs,
    seeds: bracket.seeds,
    colleges: checked.colleges,
    seedValue: value,
  };
}

/** 抽签失败的统一返回形状，字段齐全，读的时候不必判 undefined */
function emptyPlan() {
  return {
    ok: false,
    message: '',
    size: 0,
    slots: [],
    byes: [],
    pairs: [],
    seeds: [],
    colleges: [],
    seedValue: null,
  };
}

/**
 * 抽签落库的形状。
 *
 * 与算法分开：drawnAt / drawnBy 是台账信息，由调用方给，这一层不造时间
 * 也不认人（与 services/draw.js 的 buildDrawRecord 同一纪律）。
 *
 * @param {Object} plan planCollegeDraw 的返回值
 * @param {Object} [ctx]
 * @param {Date|string} [ctx.drawnAt]
 * @param {string} [ctx.drawnBy]
 * @returns {Object}
 */
function buildCollegeDrawRecord(plan, { drawnAt, drawnBy } = {}) {
  const source = plan || emptyPlan();
  return {
    seedValue: source.seedValue,
    drawnAt: drawnAt ? new Date(drawnAt) : null,
    drawnBy: drawnBy || '',
    size: source.size,
    slots: Array.isArray(source.slots) ? source.slots.slice() : [],
    seeds: Array.isArray(source.seeds) ? source.seeds.slice() : [],
    byes: Array.isArray(source.byes) ? source.byes.slice() : [],
  };
}

/* ============================================================
 * 主键
 * ============================================================ */

/**
 * 大场的确定性主键：签表位置唯一确定一场大场。
 *
 * 【为什么不随机生成】
 * 与个人赛的比赛编号同理：位置不变、坐在位置上的学院才变。用确定性键，
 * 重抽时新签表会覆盖在同一批编号上，不会堆出两批首轮大场。
 *
 * @param {string} eventId
 * @param {number} round 轮次，从 1 开始
 * @param {number} slot 该轮内的签位序号，从 0 开始
 * @param {string} [stage] 见 constants.BRACKET_STAGE，学院赛单败阶段固定 MAIN
 * @returns {string}
 */
function collegeTieKey(eventId, round, slot, stage = BRACKET_STAGE.MAIN) {
  return `t_${eventId}_${round}_${stage}_${slot}`;
}

module.exports = {
  canDrawCollegeEvent,
  approvedCollegesOf,
  validateCollegeDraw,
  planCollegeDraw,
  buildCollegeDrawRecord,
  collegeTieKey,
};
