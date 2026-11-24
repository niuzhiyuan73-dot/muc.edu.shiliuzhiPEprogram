/**
 * ELO 等级分算法
 * ============================================================
 * 这是整个排名体系的核心。它被设计为「纯函数模块」：
 *   - 不依赖微信 API、不读写数据库、不依赖当前时间
 *   - 输入相同的参数，永远返回相同的结果
 *
 * 这样设计的原因：
 *   1. 可以在 Node 里直接跑单元测试，不必启动微信开发者工具
 *   2. 云函数和前端可以复用同一份代码，杜绝「两处实现不一致」
 *   3. 出问题时可以精确定位是算法错还是数据错
 *
 * 【核心思想】
 * 战胜强手获得的分数多于战胜弱手，负于弱手损失的分数多于负于强手。
 * 因此分数反映的是「相对水平」，而不是单纯的胜场数。
 * ============================================================
 */

/**
 * 默认算法参数。所有数值都可以在调用时覆盖，便于运营期调参。
 * 这些数值与策划书第四章 4.1.2 节的设定一致。
 */
const DEFAULT_CONFIG = {
  /**
   * 男会员（以及性别未知者）的初始等级分。
   *
   * 【为什么是 1450 而不是 1000 / 1500】
   * 零和体系里池内平均分恒等于「各人起点分的加权平均」（见单打评分实验记录），
   * 起点定得比全池真实平均高多少，全体分数就整体虚高多少。俱乐部当前活跃
   * 会员的真实水平均值约 1390 分。实验（见 tools/singles-experiment.js 的
   * 「初始分扫描」）显示把男会员锚点从 1500 下调到 1450，整体系统偏差明显
   * 收窄，因此采用 1450。若沿用 1000，全池分数会被整体压低约 400 分，
   * 看起来人人都很弱。
   */
  initialRating: 1450,
  /**
   * 女会员的初始分比男会员低多少分。默认 150，即女会员从 1300 起步。
   *
   * 【为什么男女起点分不同】
   * 男女单打已合并成同一个池计算，而 ELO 只会在「跨性别的比赛」里转移
   * 分数。模拟实验显示：俱乐部里男女对打的比例只有约 25%，打满 20 周后
   * 等级分差距也只能还原真实差距的一部分。也就是说，若男女同起点，榜单
   * 会长期显示「男女水平差不多」，而事实并非如此。
   *
   * 让女会员从低 150 分起步，等于在入场时就把一部分已知的性别差异预先
   * 算进去，不必再等 ELO 慢慢收敛。真实差距约 171.5 分，取 150 已能覆盖
   * 大部分；实验（「性别起点差扫描」）显示 150 的还原度与整体误差都优于
   * 原来的 100。
   *
   * 若要关闭性别差异，把它设为 0 即可，全员立刻回到同一个起点。
   */
  genderInitialGap: 150,
  /**
   * 日常约球的 K 值，全员一律 16。
   *
   * 【为什么不再按人分段】
   * 这里原先分三段：新人（前 10 场）32、常规 24、高分段（≥2100）16。
   * 分段的本意是让新人快速收敛，代价是同一场球里两人的分数变动会差出
   * 一倍，且「谁被算作新人」会让结果随场次漂移。现改为一个常数：
   * 日常比赛对每个人一视同仁，跨场次、跨人群的分数变动都可直接比较。
   *
   * 注意这与「按前几场对手水平为新会员定初始分」是两回事——那套定级
   * （见 placementMatchCount / calculatePlacementRating）只决定一个人
   * 出场时从多少分起步，与每场用多大的 K 无关，因此不受本次改动影响。
   */
  kStandard: 16,
  /**
   * 新会员定级场次：按前几场的对手水平定出初始分。
   * 场次太少容易偶然定高定低，太多又让新人的分数长期失真，5 场是折中。
   */
  placementMatchCount: 5,
  /** 定级取整的步长：定出的分数向下取到该步长的整数倍 */
  placementStep: 50,
  /** ELO 公式中的分母系数，标准值为 400 */
  divisor: 400,
  /**
   * 赛事比赛的固定 K 值，按赛事等级取（决策 13）。
   *   一级 32 / 二级 24 / 三级 16（三级恰好等于日常 K）。
   *
   * 【为什么赛事要另给一套 K】
   * 赛事名次带来的实力变化比日常约球更可信，分数也该动得更果断。
   * 三级赛与日常同为 16，二级、一级逐级放大，体现「赛事越重要、
   * 对分数影响越大」。
   *
   * 【为什么是「固定」而不是随人变化】
   * 一场赛事里所有人按等级取同一个数字，名次对应的分数才可横向比较——
   * 这也是「名次分 × 等级倍数」那套算法在等级分这边的对称做法。
   */
  eventK: {
    1: 32,
    2: 24,
    3: 16,
  },
  /**
   * 是否为「零和」模式（默认开启）。
   * 开启后，A 队赢多少分，B 队就输多少分，俱乐部总分守恒。
   * 这对社团内部排名很重要：避免因四舍五入导致分数「凭空产生」。
   */
  zeroSum: true,
};

/** 比赛结果常量：避免代码里出现魔法字符串 'A' / 'B' */
const WINNER = {
  TEAM_A: 'A',
  TEAM_B: 'B',
  DRAW: 'DRAW',
};

/**
 * 取某位会员的初始等级分。
 *
 * 【为什么要按性别取初始分】
 * 男女单打合并成一个池后，若人人都从同一个分数起步，性别之间的真实差距
 * 就只能靠「跨性别比赛」一分一分转移过去，收敛极慢（数据见
 * DEFAULT_CONFIG.genderInitialGap）。按性别给不同的起点，相当于入场时
 * 就先补上一部分已知差异。
 *
 * 【规则】
 *   - 女会员：initialRating - genderInitialGap（默认 1450 - 150 = 1300）
 *   - 其余  ：initialRating（默认 1450）
 *
 * 男会员走第二支。性别缺失或取值意外时同样走第二支——老数据、单元测试
 * 造的假会员大多没有 gender 字段，让它们自然落到默认值，新规则才不会
 * 把不相干的调用方一起弄崩。
 *
 * @param {string} [gender] 性别，'M' / 'F'
 * @param {Object} [config] 算法配置
 * @returns {number} 初始等级分
 *
 * @example
 * initialRatingFor('M');       // => 1450
 * initialRatingFor('F');       // => 1300
 * initialRatingFor(undefined); // => 1450
 */
function initialRatingFor(gender, config = DEFAULT_CONFIG) {
  const base = config.initialRating;
  const gap = Number.isFinite(config.genderInitialGap) ? config.genderInitialGap : 0;
  return gender === 'F' ? base - gap : base;
}

/**
 * 计算某位选手对某位对手的期望胜率。
 *
 * 公式：E = 1 / (1 + 10^((R_opp - R) / 400))
 *
 * 直觉理解：等级分每高出对手 400 分，期望胜率约为 10:1。
 *
 * @param {number} rating        自己的等级分
 * @param {number} opponentRating 对手的等级分
 * @param {number} [divisor=400] 分母系数
 * @returns {number} 期望胜率，区间 (0, 1)
 */
function expectedScore(rating, opponentRating, divisor = 400) {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / divisor));
}

/**
 * 赛事比赛的 K 值：按赛事等级查表，不看选手状态。
 *
 * 【为什么等级未知时退回常规 K 而不是抛错】
 * 历史赛事没有等级字段（种子数据即如此），调用方一律按三级补齐后再传进来；
 * 万一漏了，退回常规 K 让这场比赛按老规矩算，总好过整条回放中断。
 * 三级赛事的 K 本来就是 16，与日常 K 相等，所以这条兜底通常也不会
 * 改变结果。
 *
 * @param {number} level 赛事等级，取值见 constants.EVENT_LEVEL
 * @param {Object} [config] 算法配置
 * @returns {number} K 值
 */
function resolveEventKFactor(level, config = DEFAULT_CONFIG) {
  const table = config.eventK || {};
  // 等级可能是数字，也可能是数字字符串（表单 / JSON 往返常见）。两种都认；
  // 认不出才退回常规 K，否则一级赛会被静默按常规 K（16）计。
  const k = table[level] !== undefined ? table[level] : table[Number(level)];
  return Number.isFinite(k) ? k : config.kStandard;
}

/**
 * 求一队选手的等级分平均值。
 * 双打时用于计算队伍整体实力，单打时即为选手本人分数。
 *
 * @param {Array<{rating: number}>} team
 * @returns {number} 队伍平均等级分
 */
function teamAverageRating(team) {
  const sum = team.reduce((acc, p) => acc + p.rating, 0);
  return sum / team.length;
}

/**
 * 消除 JavaScript 的「负零」（-0）。
 *
 * 背景：Math.round(-0.4) 的结果是 -0 而不是 0。虽然 -0 在数值计算上等于 0，
 * 但它会一路传播到数据库和界面上，渲染时可能显示成 "-0 分"，影响观感。
 * 所有对外输出的分数变动都必须经过这个函数。
 *
 * @param {number} value
 * @returns {number} 保证不会返回 -0
 */
function normalizeZero(value) {
  return value === 0 ? 0 : value;
}

/**
 * 校验传入的队伍数据是否合法。
 * 纯函数模块也需要防御性校验，因为数据来自用户输入。
 *
 * @param {Array} team
 * @param {string} label 队伍名称，用于错误提示
 * @throws {Error} 数据不合法时抛出
 */
function assertValidTeam(team, label) {
  if (!Array.isArray(team) || team.length === 0) {
    throw new Error(`${label}必须是非空数组`);
  }
  if (team.length > 2) {
    throw new Error(`${label}最多只能有 2 名选手，当前 ${team.length} 名`);
  }
  team.forEach((player, index) => {
    if (!player || typeof player !== 'object') {
      throw new Error(`${label}第 ${index + 1} 名选手数据缺失`);
    }
    if (typeof player.rating !== 'number' || !Number.isFinite(player.rating)) {
      throw new Error(`${label}第 ${index + 1} 名选手的 rating 必须是有效数字`);
    }
    if (typeof player.matchCount !== 'number' || player.matchCount < 0) {
      throw new Error(`${label}第 ${index + 1} 名选手的 matchCount 必须是非负数字`);
    }
  });
}

/**
 * 计算一场比赛的等级分变动。这是本模块的主入口。
 *
 * 【算法流程】
 *   1. 两队分别取平均分（双打的关键：用队伍平均分而非个人分）
 *   2. 用平均分代入 ELO 公式，得到双方的期望胜率
 *   3. 根据实际结果计算变动量：delta = K × (S - E)
 *   4. 若开启零和模式，强制 B 队变动 = -A 队变动，保证总分守恒
 *
 * @param {Object} params
 * @param {Array<{rating:number, matchCount:number, id?:string}>} params.teamA A 队选手
 * @param {Array<{rating:number, matchCount:number, id?:string}>} params.teamB B 队选手
 * @param {'A'|'B'|'DRAW'} params.winner 获胜方，DRAW 表示平局
 * @param {Object} [params.config] 可选的算法配置覆盖
 * @param {number} [params.eventLevel] 赛事等级。传了就走赛事的固定 K
 *        （见 resolveEventKFactor），不传则用全员统一的日常 K（kStandard）。
 * @returns {{
 *   teamA: Array<{before:number, delta:number, after:number, k:number}>,
 *   teamB: Array<{before:number, delta:number, after:number, k:number}>,
 *   expectedA: number,
 *   expectedB: number,
 *   winner: string
 * }}
 *
 * @example
 * // 单打：1200 分选手爆冷战胜 1400 分选手
 * const result = calculateMatchRatings({
 *   teamA: [{ rating: 1200, matchCount: 20 }],
 *   teamB: [{ rating: 1400, matchCount: 20 }],
 *   winner: 'A',
 * });
 * // result.teamA[0].delta ≈ +19   （以弱胜强，收益高）
 * // result.teamB[0].delta ≈ -19
 */
function calculateMatchRatings({ teamA, teamB, winner, config: userConfig, eventLevel }) {
  const config = { ...DEFAULT_CONFIG, ...(userConfig || {}) };

  assertValidTeam(teamA, 'A 队');
  assertValidTeam(teamB, 'B 队');

  if (!Object.values(WINNER).includes(winner)) {
    throw new Error(`winner 必须是 'A'、'B' 或 'DRAW'，收到：${winner}`);
  }

  // 第 1 步：队伍平均分。单打时即选手本人分数，双打时为两人平均。
  const avgA = teamAverageRating(teamA);
  const avgB = teamAverageRating(teamB);

  // 第 2 步：期望胜率。双方期望值之和恒为 1。
  const expectedA = expectedScore(avgA, avgB, config.divisor);
  const expectedB = 1 - expectedA;

  // 第 3 步：实际得分 S。胜 = 1，负 = 0，平 = 0.5。
  const actualA = winner === WINNER.TEAM_A ? 1 : winner === WINNER.TEAM_B ? 0 : 0.5;
  const actualB = 1 - actualA;

  // 第 4 步：K 值与变动量。
  // 赛事按等级取固定 K，日常比赛取全员统一的 kStandard——两种情况都是
  // 双方同一个数字，与选手的场次、分数无关（规则见 DEFAULT_CONFIG）。
  const isEvent = eventLevel !== null && eventLevel !== undefined;
  const k = isEvent ? resolveEventKFactor(eventLevel, config) : config.kStandard;

  const deltaA = normalizeZero(Math.round(k * (actualA - expectedA)));
  let deltaB = normalizeZero(Math.round(k * (actualB - expectedB)));

  // 零和修正：保证赢家的加分等于输家的减分，俱乐部总分不增不减。
  // 双方 K 相同时 deltaB 本应就是 -deltaA，这里显式取反是为了绕开
  // Math.round 在 .5 上的不对称（round(0.5)=1，round(-0.5)=-0）。
  // 两队人数通常相同，此时即 -deltaA；人数不等（历史脏数据 / 异常导入）时
  // 按人数比缩放，否则「A 队合计涨 deltaA、B 队合计跌 2×deltaA」，总分不守恒。
  if (config.zeroSum) {
    deltaB = normalizeZero(Math.round((-deltaA * teamA.length) / teamB.length));
  }

  /**
   * 把变动量应用到队伍中的每一位选手。
   * 注意：同队选手的 delta 完全相同（策划书 4.2 节的公平性要求），
   * 双方也共用同一个 K（第 4 步），所以直接闭包引用即可。
   */
  const applyDelta = (team, delta) =>
    team.map((player) => ({
      before: player.rating,
      delta,
      after: player.rating + delta,
      k,
    }));

  return {
    teamA: applyDelta(teamA, deltaA),
    teamB: applyDelta(teamB, deltaB),
    expectedA: Number(expectedA.toFixed(4)),
    expectedB: Number(expectedB.toFixed(4)),
    winner,
  };
}

/* ============================================================
 * 以下为「长周期」维护函数，不参与单场比赛计算
 * ============================================================ */

/**
 * 把分数向下取到步长的整数倍。1450 向下取 50 的倍数仍是 1450，1783 → 1750。
 *
 * @param {number} value
 * @param {number} [step=50]
 * @returns {number}
 */
function floorToStep(value, step = 50) {
  return Math.floor(value / step) * step;
}

/**
 * 按「前几场对手的水平」给新会员定级。
 *
 * 【规则】只看新会员的定级期（前 placementMatchCount 场）比赛：
 *   - 至少赢过一场：取「被他击败的对手中分数最高的那个」，向下取到 50 的整数倍
 *   - 一场没赢：  取「他对过的最低分对手」，向下取到 50 的整数倍，且不超过上限
 *
 * 【为什么用「赢过的最强者」而不是「所有对手的平均」】
 * 新会员的分数应当反映他能战胜什么水平的对手。赢过 1783 分的对手，
 * 说明他至少是 1783 分这个档次，向下取整只是保守一点；而平均分会
 * 被明显更弱的对手拉低，导致强者被低估。
 *
 * 【为什么一场没赢就有上限】
 * 全败的新人分数只能从他「输给谁」来推断，而输给弱手不能证明他强。
 * 因此取其最低分对手并向下取整，再用初始分封顶，避免全败者拿到
 * 偏高的入场分——那样他会在后续比赛里持续「送出」分数。
 *
 * @param {Object} params
 * @param {number[]} params.opponentRatings 定级期所有对手的分数（对局当时的分数）
 * @param {number[]} params.beatenRatings   定级期被该会员击败的对手分数
 * @param {number} [params.step=50]         取整步长
 * @param {number} [params.cap=1450]        全败时的分数上限
 * @returns {number|null} 定出的初始分；没有任何对手时返回 null
 */
function calculatePlacementRating({
  opponentRatings,
  beatenRatings,
  step = DEFAULT_CONFIG.placementStep,
  cap = DEFAULT_CONFIG.initialRating,
} = {}) {
  const opponents = (opponentRatings || []).filter(
    (r) => typeof r === 'number' && Number.isFinite(r)
  );
  const beaten = (beatenRatings || []).filter(
    (r) => typeof r === 'number' && Number.isFinite(r)
  );

  if (beaten.length > 0) {
    return normalizeZero(floorToStep(Math.max(...beaten), step));
  }

  if (opponents.length === 0) {
    return null;
  }

  return normalizeZero(Math.min(cap, floorToStep(Math.min(...opponents), step)));
}

module.exports = {
  DEFAULT_CONFIG,
  WINNER,
  initialRatingFor,
  expectedScore,
  resolveEventKFactor,
  teamAverageRating,
  normalizeZero,
  calculateMatchRatings,
  floorToStep,
  calculatePlacementRating,
};
