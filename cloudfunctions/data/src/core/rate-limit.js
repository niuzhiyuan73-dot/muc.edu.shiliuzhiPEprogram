/**
 * 账号级入口限流（协议 2）
 * ============================================================
 * 【为什么需要】（2026-10-21 审查 P0-3）
 * 读接口的门槛只是「本校在册会员」，而单个读接口一次要读 6~8 个集合
 * （buildSchoolContext 6 次点读 + 业务自身的整表读）。一个在册账号写个
 * 循环就能在几分钟内把全校每日读配额（官方 5 万次/天）打空——全校业务
 * 停摆，云开发还照常计费。这是本项目最现实的低成本 DoS。
 *
 * 【为什么放在进程内，而不是新建一个计数集合】
 * 1. 零额外成本：每次请求再写一次数据库来「计数」，等于给每个请求增加
 *    一次读写，把限流本身变成了放大器；
 * 2. 零部署负担：不用新建集合、不用配 TTL、不用改控制台；
 * 3. 攻击形态对得上：脚本刷接口是**持续高频**，云函数容器会热复用，
 *    落在同一实例上，进程内计数足以把它压下来。
 *
 * 【局限，必须知道】
 * 容器级而非全局：攻击者若被调度到多个实例，实际放行量是「阈值 × 实例数」。
 * 这是有意的取舍——它挡的是「一个学生好奇写个 for 循环」，不是分布式攻击。
 * 真要硬防，得在网关层或用一个持久化计数器（届时把 guardRate 换掉即可，
 * 调用点只认「返回 null 或 { message }」这一个约定）。
 *
 * 可用环境变量 RATE_LIMIT=off 关闭（压测、真机验收时用）。
 * ============================================================
 */

/** 统计窗口：固定 1 秒。允许窗口边界双倍突发，换来实现极简。 */
const WINDOW_MS = 1000;

/**
 * 阈值（每账号每秒）。
 *
 * 读 8：正常页面一次操作 1~3 个请求，连点也不会超；而脚本循环会被压到
 *       与真人同一量级；
 * 写 3：判球是最高频的写（一场 50 球），裁判手速也很难持续超过 3 次/秒；
 *       个人赛事报名、成员审核这类操作远低于此。
 */
const LIMITS = Object.freeze({ read: 8, write: 3 });

/**
 * 日预算（每账号每天，北京时间自然日）。
 *
 * 【为什么秒级阈值不够】（2026-10-27 第八轮审查 P1-2）
 * 秒级限流只压「瞬时速率」，压不住「持续低速」。读 8 次/秒 × 每次 6~8 次点读
 * ≈ 每秒 50 次读；官方每日读配额 5 万次，**一个账号循环十几分钟就能打空**，
 * 之后全校所有接口开始返回空列表（还会与读失败降级叠加，更难排查）。
 * 秒级阈值再往下压会误伤首屏（首页一次并发 6 个协会的请求就在同一秒），
 * 所以配额必须按「天」计，而不是把每秒阈值调到 1~2。
 *
 * 【数值怎么来的】
 * 5 万 / 每请求约 8 次读 ≈ 6000 个请求是理论上限。取 4000 留出余量：
 * 单个账号最多消耗约 3.2 万次读（64% 配额），刷不空全校。
 * 正常使用远低于此——一次页面操作 1~3 个请求，轮询另有豁免（见 POLL_ACTIONS）。
 * 写 1500：判球 10 场 = 500 次，加报名/审核仍有余量。
 *
 * 【为什么还是进程内】
 * 与秒级桶同一取舍：新增持久化计数器等于给每个请求加一次读写，把限流本身
 * 变成放大器。容器级是「挡住误用与好奇的循环」这一目标的合理成本；
 * 多实例会放大额度，这是已知局限（真正硬防要靠网关或持久化计数器）。
 */
const DAILY_LIMITS = Object.freeze({ read: 4000, write: 1500 });

/**
 * 单次请求的「读成本点」（2026-10-29 第十一轮审计 P1-2）。
 *
 * 【为什么按天计次不够】日预算原本每次请求 +1，隐含假设「一次请求约 8 次读」
 * （4000 × 8 ≈ 3.2 万，占 5 万配额 64%）。但这个假设对最贵的那几个接口差了
 * 两个数量级：`listSchoolMembers` 平铺要读整校名册再批读全部账号（2000 人的
 * 学校约 2000 条文档 ≈ 20 次 RPC），`getSchoolRanking` / `listTeams` 也是整表读。
 * 也就是说，最该被拦的请求恰好是闸门最挡不住的——12 次就能打空全校日配额。
 *
 * 【为什么用「点」而不是直接数读取条数】入口拿不到本次请求的真实读条数
 * （要等读完之后才知道）。按动作给一个量级估值，足以把「重接口 × 高频」这条
 * 路径压下来；成本值偏保守（宁小勿大），避免误伤正常用户。
 *
 * 键是动作名；不在表里的一律 1 点（绝大多数读接口只点读几份文档）。
 */
const ACTION_READ_COST = Object.freeze({
  // 整校名册 + 全部账号：平铺模式最贵；countOnly / page 分支在 readCostOf 里降回 1
  listSchoolMembers: 40,
  // 榜单 / 积分 / 名册类全表读
  getSchoolRanking: 30,
  getSchoolMemberStats: 30,
  // 球队列表：teams + teamMembers 两份整表
  listTeams: 30,
  // 录分入口要读全校名册目录
  getSchoolMatchEntryContext: 20,
  getMySportsDashboard: 20,
  // 赛事 / 比赛 / 训练列表：整表读后内存筛选
  listSchoolEvents: 10,
  listCollegeEvents: 10,
  listSchoolMatches: 10,
  listTrainings: 10,
});

/**
 * **写动作附带的整表读**（2026-11-07 审查 P3）。
 *
 * 【为什么写动作也要记读成本】积分物化让几个写动作在事务外重算：赛事结算、
 * 取消训练要读「赛事 + 训练 + 全部签到 + 全部会员行」。这些读原本发生在每一次
 * 打开榜单，现在挪到了写请求里——按「写恒为 1 点」记账，读配额被吃掉却看不见，
 * 告警会一直滞后到配额打空。
 *
 * 【为什么是估值】入口拿不到真实读条数（要读完才知道）。这里给的是量级：
 * 结算 ≈ 几十页（签到与会员行随历史增长），增量维护 ≈ 两行读写。
 * 保守取值，避免误伤正常操作。
 */
const WRITE_READ_COST = Object.freeze({
  // 结算要重算：赛事 + 训练 + 全部签到 + 全部会员行，还带一批行写入
  finishSchoolEvent: 20,
  // 取消训练令整场签到失效，同样走整次重算
  cancelTraining: 20,
  // 三条单人事实走增量（正常只读写一行）；物化脏了才退回整次重算
  confirmTrainingCheckIn: 2,
  revokeTrainingCheckIn: 2,
  removeTrainingRegistration: 2,
  // 重置只推代际、不重算
  resetSchoolSeason: 1,
});

/**
 * 这一次请求该记几个成本点。
 *
 * `listSchoolMembers` 有两条便宜分支（只数 / 只取一页），它们各只花一次聚合或
 * 一次分页读；按动作一刀切会让首页概况被自己的成本表误伤，所以在这里降级。
 *
 * @param {string} action
 * @param {Object} [payload]
 * @returns {number} ≥ 1 的整数
 */
function readCostOf(action, payload) {
  const base = ACTION_READ_COST[action];
  if (!base) return 1;
  if (action === 'listSchoolMembers' && payload
    && (payload.countOnly === true || payload.page === true)) return 1;
  return base;
}

/**
 * 轮询动作：不计入日预算。
 *
 * 【为什么豁免】这类接口每 2 秒一拍，看一场一小时的比赛就是 1800 次请求；
 * 而它每次只花 1 次读（`_.in` 批读 + 上下文缓存），打不空配额。
 * 不豁免的话，正常观众会被日预算误封——那是把安全措施变成故障。
 * **新增轮询接口必须来这里登记**，否则它会被当普通读吃掉预算。
 */
const POLL_ACTIONS = new Set(['getSchoolLiveScores', 'getTeamLiveScores']);

/**
 * 匿名桶的阈值（每「来源」每秒）。
 *
 * 【为什么要单独设，而且设得更严】
 * 没有 OPENID 的请求无法按人区分。2026-10-27 起按 `CLIENTIP` 分桶（此前全站
 * 共用一个桶，一个来源打满就让所有新用户卡在选校页）。拿不到 IP 时才退回共享桶。
 * 协议 2 只有两个动作允许匿名，正常用户根本走不到这里。
 */
const ANON_LIMITS = Object.freeze({ read: 3, write: 1 });

/**
 * 匿名桶的日预算（每来源每天）。
 *
 * 比登录账号更严：匿名面只有「选校目录」与「我是谁」，正常用户一天至多几十次。
 * 没有日预算时，3 次/秒 × 24 小时 = 25 万请求，同样能打空全校配额。
 */
const ANON_DAILY_LIMITS = Object.freeze({ read: 800, write: 200 });

/** 只读动作的命名约定：get / list / search 开头。其余（含未知动作）一律按写算。 */
const READ_ACTION = /^(get|list|search)/;

/** 桶键（openId 或 `anon:<ip>`）→ { sec, read, write }。每账号恒一条，不会无界增长。 */
const buckets = new Map();

/** 桶键 → { day, read, write }。日预算，跨天自动重置。 */
const daily = new Map();

/** 清理阈值：活跃账号超过这个数时才扫描一次过期桶，避免每请求都遍历。 */
const SWEEP_THRESHOLD = 20000;
const DAILY_SWEEP_THRESHOLD = 20000;
let lastSweepSec = -1;

const DAY_MS = 86400000;
/** 北京时间相对 UTC 的偏移：日预算按国内自然日切，与入口钉住的 TZ 一致。 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

function disabled() {
  return process.env.RATE_LIMIT === 'off' || process.env.NODE_ENV === 'test';
}

/** 这个动作算读还是算写。未知动作按写处理（严格优先）。 */
function kindOf(action) {
  return READ_ACTION.test(String(action || '')) ? 'read' : 'write';
}

/** 桶太多时清掉上一秒之前的（正常情况下 key 数 ≈ 活跃用户数，扫不了几次）。 */
function sweep(nowSec) {
  if (lastSweepSec === nowSec) return;
  lastSweepSec = nowSec;
  for (const [key, bucket] of buckets) {
    if (bucket.sec !== nowSec) buckets.delete(key);
  }
}

/** 北京时间自然日序号。 */
function dayOf(nowMs) {
  return Math.floor((nowMs + TZ_OFFSET_MS) / DAY_MS);
}

/** 日预算表膨胀时清掉往日的行（容器热复用数天才会走到）。 */
function sweepDaily(day) {
  if (daily.size <= DAILY_SWEEP_THRESHOLD) return;
  for (const [key, row] of daily) if (row.day !== day) daily.delete(key);
}

/**
 * 日预算判定。
 *
 * 轮询动作直接放行且**不计数**（见 POLL_ACTIONS：看一场比赛就是 1800 次请求，
 * 每次只 1 次读，计进来只会误封正常观众）。
 *
 * @param {string} key 桶键
 * @param {'read'|'write'} kind
 * @param {string} action
 * @param {number} nowMs
 * @param {boolean} anon 是否匿名桶（额度更严）
 * @param {number} [extraRead] 写动作附带的读成本点（见 WRITE_READ_COST）
 * @returns {null|{message:string, kind:string, limit:number, scope:string}}
 */
function guardDaily(key, kind, action, nowMs, anon, cost = 1, extraRead = 0) {
  if (POLL_ACTIONS.has(action)) return null;
  const day = dayOf(nowMs);
  const limit = (anon ? ANON_DAILY_LIMITS : DAILY_LIMITS)[kind];
  const readLimit = (anon ? ANON_DAILY_LIMITS : DAILY_LIMITS).read;
  let row = daily.get(key);
  if (!row || row.day !== day) {
    sweepDaily(day);
    row = { day, read: 0, write: 0 };
    daily.set(key, row);
  }
  // 先把读成本记上（读动作按成本表，写动作按它附带的整表读）。
  const readCost = (kind === 'read' ? Math.max(1, Math.floor(cost) || 1) : 0)
    + Math.max(0, Math.floor(extraRead) || 0);
  if (readCost > 0) {
    row.read += readCost;
    if (row.read > readLimit) {
      return {
        message: kind === 'write'
          ? '今日读取配额已用尽（结算等操作会附带大量读取），请明天再试'
          : '今日使用次数已达上限，请明天再试',
        kind: 'read',
        limit: readLimit,
        scope: 'day',
      };
    }
  }
  // 写动作的「次数」恒为 1：真正的成本在事务预算与上面的读成本里。
  if (kind === 'write') row.write += 1;
  if (row[kind] > limit) {
    return {
      message: kind === 'write'
        ? '今日操作次数已达上限，请明天再试'
        : '今日使用次数已达上限，请明天再试',
      kind,
      limit,
      scope: 'day',
    };
  }
  return null;
}

/**
 * 记一次请求并按阈值判定：先看秒级速率，再看当日预算。
 *
 * 顺序不能反：先判秒级，被秒级拒掉的请求**不会**计入日预算，否则一次连点
 * 就能把一天的额度提前吃掉。
 *
 * @param {string} openId 微信 OPENID；空串表示匿名
 * @param {string} action 协议 2 的动作名
 * @param {number} [nowMs] 当前毫秒时间戳，仅供测试注入（生产用 Date.now()）
 * @param {{clientIp?:string}} [meta] 匿名桶的区分依据（`getWXContext().CLIENTIP`）
 * @returns {null|{ message:string, kind:string, limit:number }} null 表示放行
 */
function guardRate(openId, action, nowMs = Date.now(), meta = {}) {
  if (disabled()) return null;

  const kind = kindOf(action);
  // 成本点只作用于日预算（秒级仍按「次」控频率）；调用方不传就按动作表算。
  const cost = kind === 'read'
    ? (Number.isFinite(meta.cost) && meta.cost > 0 ? meta.cost : readCostOf(action, meta.payload))
    : 1;
  // 写动作也可能带着整表读（物化重算），照实记到读预算里，见 WRITE_READ_COST。
  const extraRead = kind === 'write' ? (WRITE_READ_COST[action] || 0) : 0;
  const nowSec = Math.floor(nowMs / WINDOW_MS);
  // 没有 OPENID ⇒ 按来源（CLIENTIP）分桶，拿不到 IP 时退回全站共享桶。
  const anon = !openId;
  const clientIp = typeof meta.clientIp === 'string' ? meta.clientIp.trim() : '';
  const key = anon ? (clientIp ? `anon:${clientIp}` : 'anon') : openId;
  const limit = (anon ? ANON_LIMITS : LIMITS)[kind];

  let bucket = buckets.get(key);
  if (!bucket || bucket.sec !== nowSec) {
    sweep(nowSec);
    // 全部是本窗口的有效桶时拒绝新增身份，不淘汰仍有效的桶，避免额度重置。
    if (!bucket && buckets.size >= SWEEP_THRESHOLD) {
      return { message: '服务繁忙，请稍后再试', kind, limit };
    }
    bucket = { sec: nowSec, read: 0, write: 0 };
    buckets.set(key, bucket);
  }
  bucket[kind] += 1;

  if (bucket[kind] > limit) {
    sweep(nowSec);
    return {
      message: kind === 'write' ? '操作过于频繁，请稍后再试' : '请求过于频繁，请稍后再试',
      kind,
      limit,
    };
  }
  return guardDaily(key, kind, action, nowMs, anon, cost, extraRead);
}

/** 仅供测试：清空计数，避免用例之间互相影响。 */
function resetRateLimit() {
  buckets.clear();
  daily.clear();
  lastSweepSec = -1;
}

module.exports = {
  guardRate, resetRateLimit, kindOf, readCostOf, ACTION_READ_COST,
  LIMITS, ANON_LIMITS, DAILY_LIMITS, ANON_DAILY_LIMITS, POLL_ACTIONS, dayOf, WRITE_READ_COST,
};
