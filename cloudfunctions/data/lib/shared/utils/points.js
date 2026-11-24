/**
 * 积分算法
 * ============================================================
 * 等级分（elo.js）回答「你有多强」，积分回答「你有多投入」。
 *
 * 【积分只来自赛事（决策 9、第四节）】
 * 日常约球不再产生任何积分，只影响等级分。理由是日常比赛场次多且随意，
 * 按场给分等于奖励「刷场次」，榜上排在前面的多半是最闲的人而非最投入的人。
 * 于是积分改成一件事结一次账：打一次赛事，按最终名次计一次分。
 *
 * 【名次分要乘等级倍数（2.1）】
 * 一级赛事的冠军 80 分，三级赛事的冠军只有 20 分。等级由管理员发布赛事
 * 时选定，倍数表见 constants.EVENT_LEVEL_MULTIPLIER。
 *
 * 【规则细节】
 *   - 参与分固定 2 分：来打了就有，鼓励参与（决策 12）。
 *   - 名次分按档位：1→20 / 2→14 / 3→10 / 4→7 / 5–8→4，未进八强为 0。
 *   - 双打赛事不计分（决策 3）。
 *   - 同一赛事打多轮，只按最终名次计一次，不逐轮累加（2.5）。
 * ============================================================
 */

const { EVENT_LEVEL_MULTIPLIER, DEFAULT_EVENT_LEVEL } = require('./constants.js');

/**
 * 默认积分规则。数值均可通过参数覆盖，便于运营期调整。
 */
const DEFAULT_POINT_CONFIG = {
  /** 完成一次赛事即得的参与分（决策 12） */
  eventParticipate: 2,
  /**
   * 名次档位基础分。未列出的名次为 0——那属于「未进八强」，
   * 只拿参与分（决策 10）。
   */
  placementBase: { 1: 20, 2: 14, 3: 10, 4: 7 },
  /** 八强（5–8 名）基础分 */
  quarterfinalBase: 4,
  /** 八强的最差名次。超过它就落在「未进八强」那一档 */
  quarterfinalMaxRank: 8,
};

/**
 * 名次 → 名次档位基础分（未乘等级倍数）。
 *
 * 5–8 名共用同一档，因为淘汰赛只产出「八强」这个粒度，不区分 5 到 8 名
 * 谁高谁低。名次非法（缺失、非正数）时返回 0。
 *
 * @param {number} placement 最终名次
 * @param {Object} [config] 积分配置
 * @returns {number} 基础分
 */
function placementBaseOf(placement, config = DEFAULT_POINT_CONFIG) {
  const rank = Number(placement);
  if (!Number.isFinite(rank) || rank < 1) return 0;
  // 名次必须落在整数上：4.5 这类小数既不在档位表里，也不该被当成「八强」
  // 发分（否则任何小数名次都会默默拿到 quarterfinalBase）。
  if (!Number.isInteger(rank)) return 0;

  const exact = config.placementBase[rank];
  if (typeof exact === 'number') return exact;
  return rank <= config.quarterfinalMaxRank ? config.quarterfinalBase : 0;
}

/**
 * 计算一次赛事带来的积分。
 *
 * 这是积分唯一的来源：日常比赛不再调用任何积分函数。
 *
 * @param {Object} params
 * @param {number} [params.placement] 最终名次（1 起）。缺失视为未进八强
 * @param {number} [params.level] 赛事等级（1/2/3），缺省三级
 * @param {boolean} [params.isDoubles] 是否双打赛事。双打不计分
 * @param {Object} [params.config] 可选配置覆盖
 * @returns {{participate:number, placementScore:number, multiplier:number, total:number}}
 *
 * @example
 * // 二级赛事的亚军：2（参与）+ 14 × 2 = 30 分
 * calculateEventPoints({ placement: 2, level: 2 }).total; // => 30
 */
function calculateEventPoints({
  placement,
  level = DEFAULT_EVENT_LEVEL,
  isDoubles = false,
  config: userConfig,
} = {}) {
  if (isDoubles) {
    return { participate: 0, placementScore: 0, multiplier: 0, total: 0 };
  }

  const config = { ...DEFAULT_POINT_CONFIG, ...(userConfig || {}) };
  const multiplier =
    EVENT_LEVEL_MULTIPLIER[level] || EVENT_LEVEL_MULTIPLIER[DEFAULT_EVENT_LEVEL];

  const participate = Number(config.eventParticipate) || 0;
  const placementScore = placementBaseOf(placement, config) * multiplier;

  return {
    participate,
    placementScore,
    multiplier,
    total: participate + placementScore,
  };
}

module.exports = {
  DEFAULT_POINT_CONFIG,
  placementBaseOf,
  calculateEventPoints,
};
