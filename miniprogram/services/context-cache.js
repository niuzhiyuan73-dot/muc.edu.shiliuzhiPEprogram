/**
 * 身份上下文缓存（2026-10-23 H-10）
 * ============================================================
 * 【为什么要缓存】
 * `buildSchoolContext` 是**每个请求的必经之路**：它要点读学校、协会、账号，
 * 再点读这个人的名册 / 校级角色 / 协会身份——一共 6 次 RPC。而一个页面通常
 * 连发十几个请求（首页、榜单、名录各自要判一次权限），同一秒内这 6 份文档
 * 被反反复复读了十几遍。
 *
 * 这是大用户量复查里最后一个「数量级」杠杆：把 H-1/H-2/H-6 都修完之后，
 * 剩余读量的大头就是它（25 次函数调用 → 150 次读，全花在这里）。
 *
 * 【代价是什么，必须说清楚】
 * 缓存窗口内**撤权不生效**：管理员撤掉某人的协会负责人身份 / 停用账号 /
 * 把他转出学校，被撤权的人在 TTL 到期前仍能通过初判。
 *
 * 缓解有三层：
 *   1. **TTL 取 5 秒**（不是 30 秒也不是 5 分钟）：撤权是人工点击，5 秒的窗口
 *      在行政流程里不构成实质风险；而它已经能吃掉同一页面连发请求的绝大部分重复读。
 *   2. **写动作一律不缓存**（见 isReadAction）：写请求每次都是新鲜上下文。
 *   3. **写动作之后整体失效**（见 invalidateAll）：写请求可能改了别人的权限，
 *      而缓存里存的是别人的上下文，所以宁可全清。写动作的频率远低于读。
 *
 * 再加上项目本身的一道保险：**所有写路径的关键校验都在事务内用 freshContext
 * 重读一遍**（不复用这个缓存），所以即使初判放行，事务里仍会拦住越权写入。
 * 缓存只影响「初判」与「读展示」，不影响「写入的最终许可」。
 *
 * 【为什么不按用户精确失效】
 * 精确失效需要每个写接口告诉我们「改了谁」，改动面覆盖全部 handler，而且漏一处
 * 就是静默的越权窗口。全清的成本是「下一次读重建一次缓存」（6 次读），
 * 在 5 秒的时间尺度上可以忽略。等将来写动作真的变成热路径，再按 userId 精确失效。
 *
 * 【缓存里存的是什么】
 * 存的是仓储返回的**文档对象**（学校 / 协会 / 账号 / 名册 / 校级角色 / 协会身份）。
 * 调用方沿用项目既定纪律：只读不改，需要改就 spread 出新的。一旦有人就地改
 * `ctx.actor.xxx`，改的就是缓存里的那一份——下一个命中的人会读到被改过的数据。
 * 这条纪律本来就有（云端事务也要求），这里只是多了一个会被违反后静默生效的地方。
 * ============================================================
 */

/** 默认缓存窗口：5 秒。设 0 表示完全关闭（也用于测试）。 */
const DEFAULT_TTL_MS = 5000;

/** 单实例最多缓存多少条上下文。一条上下文 ≈ 6 个文档对象，500 条足够覆盖 5 秒内的并发。 */
const MAX_ENTRIES = 500;

/**
 * 读动作的命名前缀。
 *
 * 【为什么用白名单而不是黑名单】漏登记的后果不对称：
 *   · 新写的**读**动作忘了登记 → 只是没享受到缓存（性能差，但结果正确）；
 *   · 新写的**写**动作被误判成读 → 就是 5 秒的越权窗口（安全性问题）。
 * 所以「默认不缓存」是唯一安全的默认值。
 */
// 注意不能用 `\b`：`getSchoolRanking` 里 get 与 School 之间没有词边界（都是单词字符），
// `\b` 会让这条正则整体失效。
const READ_ACTION_PREFIX = /^(get|list|search|describe|query|preview|export)/i;

/**
 * 例外清单：名字像读、实际会写库的动作。
 *
 * 目前为空——项目里以 get/list 开头的接口都是纯读（懒初始化写库发生在事务内，
 * 且事务内走的是 freshContext，不经过这里）。**新增「名为读、实为写」的接口时，
 * 必须登记到这里**，否则会给它套上 5 秒的陈旧上下文。
 */
const NON_CACHEABLE_ACTIONS = new Set([]);

const store = new Map();
let ttlMs = readTtl();
/** 最近一次「整体失效」的时间戳：`set` 用它判断这次读是不是失效前的旧快照。 */
let lastInvalidateAt = 0;
/** 按范围失效的时间戳：`prefix -> ts`，理由同上，粒度到「学校 + 协会」。 */
const scopeInvalidatedAt = new Map();
/**
 * 整体失效的代际号：每次 `invalidateAll` 自增。
 *
 * 【为什么还要一个号】（2026-10-29 第十一轮审计 P1-1）
 * `buildDirectory`（学校名册目录）缓存的不是「某个人的上下文」，而是一整所学校的
 * 在册名单，键里没有 openId —— 用 `lastInvalidateAt` 去比「这次读是不是失效前的
 * 快照」只能挡住时间先后，挡不住「同一个键换了内容」。代际号给这类**派生自全校
 * 数据**的缓存一个更直白的判据：代际变了就是整批作废，不必逐条推时间。
 *
 * 按范围失效（`invalidateScope`）**不**递增：它的适用面是「纯比赛类写」，那类
 * 动作不碰 schoolMembers / schoolRoles / memberships，名册目录不会变；若也递增，
 * 一场比赛 50 次判球就会让全校目录缓存连续作废，缓存对最热的计分台等于不存在。
 */
let generation = 0;

/**
 * 运行在 Node 里吗（云函数 / 单元测试）。
 *
 * 【为什么必须先判环境】（2026-10-23 真机崩溃）
 * 这个模块被 `school-context.js` require，而后者在小程序端也会被加载——
 * **小程序运行时没有 `process`**，直接写 `process.env` 会让整个页面在
 * `require` 阶段就抛 `ReferenceError: process is not defined`，首页白屏。
 * 本地测试全绿是因为测试跑在 Node 里，`process` 一直都在。
 */
function hasNodeProcess() {
  return typeof process !== 'undefined' && Boolean(process) && Boolean(process.env);
}

/**
 * 读 TTL。
 *
 * 三种环境：
 *   · **小程序运行时**（没有 process）→ 0。缓存只服务云函数入口，小程序端
 *     本来就不跑那条路径，关掉同时也杜绝了「读到 5 秒前权限」的可能；
 *   · **单元测试**（`--test` / `NODE_TEST_CONTEXT`）→ 0。测试用同一个 openId
 *     连打几十个请求（申请 → 审批 → 再申请…），每步都期望读到上一步刚写的
 *     数据，缓存会让它读到 5 秒前的快照，表现为间歇性断言失败；
 *   · **云函数** → 5 秒（`CONTEXT_CACHE_TTL_MS` 可覆盖，0 表示关闭）。
 *
 * 想验证缓存行为本身时，用 `__setTtlForTest(ms)` 显式打开。
 */
function readTtl() {
  if (!hasNodeProcess()) return 0;
  const env = process.env;
  const raw = env.CONTEXT_CACHE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const testing = Boolean(env.NODE_TEST_CONTEXT) || argv.includes('--test');
  return testing ? 0 : DEFAULT_TTL_MS;
}

/** 这个动作能不能用缓存。 */
function isReadAction(action) {
  if (ttlMs <= 0) return false;
  if (typeof action !== 'string' || !action) return false;
  if (NON_CACHEABLE_ACTIONS.has(action)) return false;
  return READ_ACTION_PREFIX.test(action);
}

/** 缓存键：一个范围 + 一个身份，就是一份上下文。 */
function keyOf(target, openId, actorId) {
  return `${target.schoolId}|${target.association}|${openId || ''}|${actorId || ''}`;
}

function get(key) {
  if (ttlMs <= 0) return null;
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.docs;
}

function set(key, docs, readAt) {
  if (ttlMs <= 0) return;
  // 【写回前先看这段时间有没有发生过失效】（2026-10-28 审计 2 C-1）
  // 读请求的路径是「get 未命中 → 3~5 次 await 读库 → set 写回」。若这中间有写请求做了
  // invalidateAll（比如管理员刚撤了某人的权），这次 set 就会把**失效前读到的旧身份**
  // 重新写进缓存，随后 TTL 内所有读都拿到旧权限——等于「清了也没清干净」。
  // 判断依据是「这次读是几点开始的」：晚于最近一次失效才允许写回；早于（含同一毫秒）
  // 说明读到的是失效前的快照，直接丢弃（下次读自然重建）。同一毫秒按「失效前」处理是
  // 有意保守——毫秒级分辨不出先后时，宁可多读一次，也不要留下旧权限。
  const startedAt = Number.isFinite(readAt) ? readAt : Date.now();
  if (startedAt <= lastInvalidateAt) return;
  for (const [prefix, invalidatedAt] of scopeInvalidatedAt) {
    if (startedAt <= invalidatedAt && key.startsWith(prefix)) return;
  }
  store.set(key, { docs, expiresAt: Date.now() + ttlMs });
  if (store.size <= MAX_ENTRIES) return;
  // 先清已经过期的，再按插入顺序淘汰——上下文是纯派生数据，丢掉随时可重建。
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

/** 整体失效：写动作执行后调用（原因见文件头「为什么不按用户精确失效」）。 */
function invalidateAll() {
  lastInvalidateAt = Date.now();
  generation += 1;
  scopeInvalidatedAt.clear();
  store.clear();
}

/**
 * 按范围失效：只清这一个「学校 + 协会」下的所有上下文。
 *
 * 【什么时候可以用它，什么时候不许】（2026-10-27 第八轮审查 P2-6）
 * 判球一次就是一次写，全清会把**所有用户**的上下文一起打掉：计分台一场 50 球
 * 期间，旁边的观众与别的协会的读请求全部命中不了缓存，等于缓存对热路径完全失效。
 *
 * 但「按范围清」只有在「这次写只可能改变本范围内的人」时才成立。所以调用方
 * 必须显式声明（见 school-request.js 的 SCOPE_ONLY_INVALIDATION）：目前只允许
 * **纯比赛/比分类**写动作——它们不碰 schoolMembers / schoolRoles / memberships，
 * 也就不会改变任何人的身份。撤权、审批、任免、变更学籍这些动作一律走全清。
 *
 * 拿不准就全清：多付几次读，不会错；清少了，就是一段撤权不生效的窗口。
 *
 * @param {string} schoolId
 * @param {string} association
 */
function invalidateScope(schoolId, association) {
  if (!schoolId) return invalidateAll();
  const prefix = `${schoolId}|${association || ''}|`;
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
  // 记下「这个范围是什么时候失效的」，供 set 判断「我这次读是不是失效前的快照」。
  // 只保留最近若干条，避免前缀表无界增长（前缀数 = 有写动作的范围数，量级很小）。
  scopeInvalidatedAt.set(prefix, Date.now());
  if (scopeInvalidatedAt.size > MAX_ENTRIES) {
    const cutoff = [...scopeInvalidatedAt.entries()].sort((a, b) => a[1] - b[1])
      .slice(0, scopeInvalidatedAt.size - MAX_ENTRIES);
    for (const [key] of cutoff) scopeInvalidatedAt.delete(key);
  }
}

/** 仅供诊断：当前窗口与缓存条数。 */
function stats() {
  return { ttlMs, size: store.size };
}

/**
 * 当前代际号。派生自全校数据的缓存（如 `buildDirectory`）在「读开始」与「写回」
 * 两端各取一次，两个值相同才允许写回或命中——见上面的 `generation` 说明。
 * @returns {number}
 */
function currentGeneration() {
  return generation;
}

/** 测试专用：显式设置窗口（0 = 关闭），并清空既有条目。 */
function __setTtlForTest(ms) {
  ttlMs = Number.isFinite(Number(ms)) && Number(ms) >= 0 ? Math.floor(Number(ms)) : 0;
  store.clear();
  lastInvalidateAt = 0;
  generation = 0;
  scopeInvalidatedAt.clear();
}

module.exports = {
  isReadAction, keyOf, get, set, invalidateAll, invalidateScope, stats, currentGeneration,
  __setTtlForTest, DEFAULT_TTL_MS,
};
