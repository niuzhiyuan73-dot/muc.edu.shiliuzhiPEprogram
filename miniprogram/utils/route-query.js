/**
 * 路由 query 里的编号解析
 * ============================================================
 * 跳转方一律 `encodeURIComponent(eventId)` 拼 URL（S2 编号含 `:`，学院赛编号
 * 还可能出现 `%`）。但**接收方拿到的值是否已解码，取决于运行环境**：
 *   · Node 测试替身（URLSearchParams）会解码一次；
 *   · 微信开发者工具 / 真机把 query 值**原样透传**（仍是 `%3A` 形式）。
 *
 * 于是同一个 `sev:muc:pkb:spring-cup`，一边解得出来、一边查不到——页面就报
 * 「这场赛事不存在或已被删除」（2026-10-16 用户实测：民大春季杯）。
 *
 * 【为什么不能无条件 decodeURIComponent】
 * `schoolKey` 复合键本身含 `%`（各段 encodeURIComponent 后再拼接），
 * 编号里合法地存在 `%25` 这类字符。对「已经解码过」的值再解一次会把编号改坏，
 * 因此这里给的是**候选序列**：先原值，再解码值，由调用方按序探测，谁先命中用谁。
 * ============================================================
 */

/**
 * 一个路由编号的候选值（按尝试顺序）。
 * 不含 `%` 时只有一个候选（无需探测）；含 `%` 时给 [原值, 解码值]，
 * 既兼容「未解码」环境，也不会改坏本身含 `%` 的编号。
 *
 * @param {*} value query 里的原始值
 * @returns {string[]} 去重后的候选，可能为空数组
 */
function routeIdCandidates(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return [];
  if (!raw.includes('%')) return [raw];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    return [raw]; // 非法百分号序列：当普通字符串处理
  }
  return decoded === raw ? [raw] : [raw, decoded];
}

/**
 * 依次探测候选编号，返回第一个命中者。
 *
 * @param {*} value query 里的原始值
 * @param {Function} probe (id) => Promise<*>；命中返回真值，未命中返回假值
 * @returns {Promise<{id: string, result: *}>} 全部未命中时 { id: '', result: null }
 */
async function resolveRouteId(value, probe) {
  for (const id of routeIdCandidates(value)) {
    // eslint-disable-next-line no-await-in-loop —— 候选最多两个，串行探测更省一次请求
    const result = await probe(id);
    if (result) return { id, result };
  }
  return { id: '', result: null };
}

/**
 * 安全解析**单个普通参数**（学院名、关键词等）：解码成功用解码值，
 * 畸形百分号序列回退原值，不让 URIError 把 onLoad 打断成白屏。
 *
 * 【边界】复合编号（含 `%25` 的 schoolKey / 赛事编号）仍要用
 * `routeIdCandidates` / `resolveRouteId` 按候选探测，并把命中的真实编号回传
 * 页面实例；这里取解码值只是保持与原先 `decodeURIComponent` 一致的行为，
 * 不替代探测。触发条件：若出现「已解码且本身含 %」的编号查不到，改为探测。
 *
 * @param {*} value query 里的原始值
 * @returns {string} 解码值或原值
 */
function safeRouteId(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw || !raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
}

module.exports = { routeIdCandidates, resolveRouteId, safeRouteId };
