/**
 * 防刷分：同一对会员每赛季计入等级分的场次上限
 * ============================================================
 * 【要解决什么】
 * 日常约球没有门槛，两个人可以一周内互录二十场。赢的那个的等级分会被
 * 同一份对阵反复推高——分数反映的不再是水平，而是约球次数。赛事刷不出来
 * （有名次、有赛程、有裁判），所以这条上限只管日常。
 *
 * 【规则】
 *   - 一对会员、一个赛季，最多 RATED_PAIR_LIMIT 场自行录入的比赛计入等级分；
 *   - 「自行录入」= 没有 eventId / collegeEventId / tieId（见 isCasualMatch）；
 *   - 双打按**跨队无序对**算：一队两人对对手两人，四组组合各记一场，
 *     且 (甲,乙) 与 (乙,甲) 是同一个人对，不重复计数；
 *   - 超限的场次**不让录入**（见 checkSubmitAllowed）。已经在册的（历史导入、
 *     直接改库、规则生效前录的）另有 findCappedMatchIds 兜底：留在台账里，
 *     但不进等级分、不进成绩公示与逐场战绩——与弃权同一路数。
 *
 * 【为什么是「整个赛季」】
 * 赛季分界点（season.resetTime）之前的场次属于上一个赛季，不占本赛季名额。
 * 从未开始过新赛季时，全部流水都算本赛季。等级分本身不随赛季重置，
 * 这里的计数却是按赛季重来的——两件事互不影响。
 *
 * 【为什么待确认的场次也要占名额】
 * 只数已生效的话，两个人可以连录 15 场等对手逐一确认，全部生效后上限就被
 * 绕过去了。因此提交即占名额，被驳回或撤销（REVOKED）才释放。
 *
 * 【为什么提交时挡一道，回放前还要再筛一道】
 * 提交时的闸门管的是「以后」：它拦得住新录的比赛，拦不住已经在库里的。
 * 历史成绩导入、控制台直接改库、以及本规则上线之前录下的场次，都会绕过
 * 闸门。回放前那道筛子（findCappedMatchIds）保证无论流水怎么来的，
 * 一对会员最多只有 15 场计入等级分。两道各管一段，缺一不可。
 *
 * 【为什么在回放之前算，而不是边回放边算】
 * 「哪些比赛算数」这一类判断全部集中在数据层（derive.js / mock.js 的
 * activeOnly），与 isEloEligibleMatch 并列。回放引擎只管拿到比赛算分数，
 * 不必知道防刷分这件事，改规则也不会碰算法代码。提交闸门同样落在数据层，
 * 前端算出来的数字只用于展示，不作数。
 *
 * 【纯函数】
 * 不碰 wx、不读数据库、不看当前时间；同样的输入永远给同样的输出。
 * 因此可以在 Node 里用字面量把每一条边界钉死。
 * ============================================================
 */

const { MATCH_STATUS, RATED_PAIR_LIMIT } = require('../../shared/utils/constants.js');
// 链序比较器独立成模块：旧回放引擎已删除，不得为了一个 comparator 保留整套回放（交接文档 §9.2）
const { compareMatchOrder } = require('./match-order.js');

/**
 * 一场比赛是不是「自行录入的」（日常约球）。
 *
 * 赛事比赛带 eventId，学院赛小场带 collegeEventId + tieId。三者全空才是
 * 会员自己录的日常球。这三种身份任一存在都说明它在某个组织框架内进行，
 * 有赛程与名次兜底，刷不出来，因此不设上限。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function isCasualMatch(match) {
  if (!match) return false;
  return !match.eventId && !match.collegeEventId && !match.tieId;
}

/**
 * 两个人对的无序键。甲乙与乙甲必须是同一个键，否则同一对会被算成两对。
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 一场比赛的跨队无序对。
 *
 * 单打（1 对 1）：一组。
 * 双打（2 对 2）：四组——甲丙、甲丁、乙丙、乙丁。
 *
 * 同队两人之间不算对：他们没交手，不会因为配合得好坏影响彼此的分数关系。
 *
 * @param {Object} match
 * @returns {string[]} 无序对键列表；队伍数据不完整时返回空数组
 */
function crossPairs(match) {
  return crossPairList(match).map((pair) => pair.key);
}

/**
 * 跨队对，连同两边的人是谁。
 *
 * 与 crossPairs 同源，只是多带回编号：要说出「你和谁已经打满」就得知道
 * 对子里是哪两个人，而从 '甲|乙' 这样的键里把编号切回来，一旦编号里含
 * 分隔符就会错。宁可从队伍数组直接取。
 *
 * @param {Object} match
 * @returns {Array<{key: string, a: string, b: string}>}
 */
function crossPairList(match) {
  const teamA = (match && match.teamA) || [];
  const teamB = (match && match.teamB) || [];
  const list = [];
  for (const a of teamA) {
    for (const b of teamB) {
      if (a === undefined || a === null || b === undefined || b === null) continue;
      list.push({ key: pairKey(String(a), String(b)), a: String(a), b: String(b) });
    }
  }
  return list;
}

/**
 * 挑出「占名额」的比赛，按回放同款顺序排好。
 *
 * 三条判据缺一不可：没被撤销（撤销即释放名额）、是日常约球（赛事不占名额）、
 * 落在本赛季（分界点之前的归上个赛季）。时间不可解析的直接跳过——录不进来
 * 的脏数据不该吃掉别人的名额。
 *
 * @param {Array<Object>} matches 全量比赛流水（含待确认与已撤销）
 * @param {string|Date|null} seasonStart 本赛季分界点
 * @returns {Array<Object>} 升序排列的新数组
 */
function countedMatches(matches, seasonStart) {
  if (!Array.isArray(matches) || matches.length === 0) return [];

  const startMs =
    seasonStart === null || seasonStart === undefined ? NaN : new Date(seasonStart).getTime();
  const hasSeasonStart = Number.isFinite(startMs);

  return matches
    .filter((match) => {
      if (!match || match.status === MATCH_STATUS.REVOKED) return false;
      if (!isCasualMatch(match)) return false;
      const timeMs = new Date(match.matchTime).getTime();
      if (!Number.isFinite(timeMs)) return false;
      if (hasSeasonStart && timeMs < startMs) return false;
      return crossPairs(match).length > 0;
    })
    .sort(compareMatchOrder);
}

/**
 * 本赛季每对会员已经打过的场次。
 *
 * 这是「名额用了多少」的唯一算法，提交闸门与录分页上显示的数字都取自它，
 * 因此面板里写「已交手 3 场」时，闸门数的也是 3。
 *
 * 会超过上限：历史导入或规则生效前录下的场次不会因为超限就消失，如实数
 * 出来（18 就是 18），由调用方决定怎么显示——把数字截到 15 反而藏了信息。
 *
 * @param {Array<Object>} matches 全量比赛流水
 * @param {Object} [options]
 * @param {string|Date|null} [options.seasonStart] 本赛季分界点；不传表示从未开始过新赛季
 * @returns {Map<string, number>} 无序对键 → 场次
 */
function tallyPairUsage(matches, { seasonStart = null } = {}) {
  const usage = new Map();
  for (const match of countedMatches(matches, seasonStart)) {
    // 同一场内不重复计：一队两人对对手两人，四组对两两不同，去重是给
    // 「同一人出现在两队」这种脏数据兜底，宁可少算不可多算
    for (const key of new Set(crossPairs(match))) {
      usage.set(key, (usage.get(key) || 0) + 1);
    }
  }
  return usage;
}

/**
 * 某位会员本赛季与每个人的交手场次。
 *
 * 只数「隔网相对」的场次——同队的搭档不算交手，那正是名额的算法
 * （见 tallyPairUsage）。录分页的选对手面板据此显示每个人后面的数字。
 *
 * @param {string} userId
 * @param {Array<Object>} matches 全量比赛流水
 * @param {Object} [options]
 * @param {string|Date|null} [options.seasonStart] 本赛季分界点
 * @returns {Object<string, number>} 对方编号 → 场次；一场没打的人不出现
 */
function seasonPairCounts(userId, matches, { seasonStart = null } = {}) {
  const counts = {};
  const me = userId === null || userId === undefined ? '' : String(userId);
  if (!me) return counts;

  for (const match of countedMatches(matches, seasonStart)) {
    const teamA = (match.teamA || []).map(String);
    const teamB = (match.teamB || []).map(String);
    const inA = teamA.includes(me);
    const inB = teamB.includes(me);
    // 不在场上，或两边都有我（脏数据）——都算不出「和谁交手」
    if (inA === inB) continue;
    for (const other of inA ? teamB : teamA) {
      if (other === me) continue;
      counts[other] = (counts[other] || 0) + 1;
    }
  }
  return counts;
}

/**
 * 找出所有「超出对阵上限、不计入等级分」的比赛。
 *
 * 按回放同款顺序逐场推进（compareForReplay）：每一场先看它涉及的各对新名额
 * 是否还有剩余，还有就正常记账并扣名额，没有就判为超限。
 * 顺序必须与回放一致——否则「哪一场是被挤掉的那一场」会随排序抖动，
 * 同一天的先后会不稳定。
 *
 * 【什么时候用得上】
 * 提交闸门（checkSubmitAllowed）管的是「以后」；这个函数管「已经在库里的」。
 * 历史成绩导入、控制台直接改库、本规则上线前录下的场次，都绕过闸门，
 * 只能在这里筛掉。它就是「一对会员最多 15 场计入等级分」这条不变式的
 * 最后一道保证。
 *
 * 【双打为什么整场作废】
 * 四组对里只要有一组已经打满，这场就不能计分：一队的分数变动是四人共用
 * 同一个 delta（策划书 4.2 节的公平性要求），没法只给其中几对记账。
 * 与其造一个「半算半不算」的口径，不如整场不计——规则简单，解释得清。
 *
 * @param {Array<Object>} matches 全量比赛流水（含待确认与已撤销）
 * @param {Object} [options]
 * @param {string|Date|null} [options.seasonStart] 本赛季分界点；不传表示从未开始过新赛季
 * @param {number} [options.limit=RATED_PAIR_LIMIT] 每对每赛季的上限
 * @returns {Set<string>} 超限比赛的 _id 集合
 */
function findCappedMatchIds(matches, { seasonStart = null, limit = RATED_PAIR_LIMIT } = {}) {
  const capped = new Set();
  if (!Number.isFinite(limit) || limit <= 0) return capped;

  /** 无序对键 → 本赛季已占用的名额 */
  const used = new Map();

  for (const match of countedMatches(matches, seasonStart)) {
    // 与 tallyPairUsage 同一口径：同一场内同一对只占一个名额。脏数据里
    // 同一人出现在两队会让 crossPairs 产出重复键，不去重会多扣名额。
    const pairs = new Set(crossPairs(match));
    const exceeded = [...pairs].some((key) => (used.get(key) || 0) >= limit);
    if (exceeded) {
      capped.add(String(match._id));
      continue;
    }
    for (const key of pairs) used.set(key, (used.get(key) || 0) + 1);
  }

  return capped;
}

/**
 * 提交前的一道闸门：这场球还占得到名额吗。
 *
 * 一对会员打满上限之后，他们之间的比赛**不再让录入**。这是有意的选择——
 * 让比赛入账却不计分，会让「这场为什么没加分」变成一个没人解释得清的状态；
 * 当场拒掉，用户立刻知道该换对手。
 *
 * 【双打为什么整场拦下】
 * 四组对里只要有一组满额，这场就计不了分。既然计不了分，就没有理由让它
 * 入账——与 findCappedMatchIds 的整场作废同一口径。
 *
 * 【为什么用 ≥ 而不是 >】
 * 名额指「还能再打几场」。已打满 15 场（usage === 15）时第 16 场就该被拦，
 * 所以判据是 usage >= limit，不是 usage > limit。
 *
 * 【赛事比赛直接放行】
 * 这条上限只管日常约球（见 isCasualMatch）。赛事有名次、有赛程、有裁判，
 * 刷不出来，本来就不设限。调用方目前都走「按编号补录」那条路进来，压根
 * 到不了这里；这一句是让函数自己守住自己的规则——将来多一条调用路径时，
 * 不至于把一场决赛拦在「你和对手已经打了 15 场」上。
 *
 * @param {Object} match 待提交的记录（buildMatchRecord 的产物）
 * @param {Array<Object>} matches 已有流水（含待确认与已撤销）
 * @param {Object} [options]
 * @param {string|Date|null} [options.seasonStart] 本赛季分界点
 * @param {number} [options.limit=RATED_PAIR_LIMIT] 每对每赛季的上限
 * @param {Function} [options.nameOf] 编号 → 昵称，用来把话说清楚；不给就用编号
 * @returns {{ok: boolean, pairs: Array<{key: string, a: string, b: string}>, message: string}}
 *          ok 为 false 时 pairs 是已满额的那些对
 */
function checkSubmitAllowed(match, matches, options = {}) {
  const {
    seasonStart = null,
    limit = RATED_PAIR_LIMIT,
    nameOf = null,
  } = options;

  const allow = { ok: true, pairs: [], message: '' };
  if (!match) return allow;
  if (!isCasualMatch(match)) return allow;
  if (!Number.isFinite(limit) || limit <= 0) return allow;

  const usage = tallyPairUsage(matches, { seasonStart });
  const capped = findCappedPairs(crossPairList(match), usage, { limit });
  if (capped.ok) return allow;

  return { ok: false, pairs: capped.full, message: pairCapMessage(capped.full, { limit, nameOf }) };
}

/** 取某个无序对键的已用场次；Map 与普通对象都认（计数文档读回来是对象）。 */
function usedCountOf(used, key) {
  if (used instanceof Map) return Number(used.get(key)) || 0;
  if (used && typeof used === 'object') return Number(used[key]) || 0;
  return 0;
}

/**
 * 一场比赛涉及的每一对里，哪些已经用满名额。
 *
 * 【为什么单独抽出来】
 * 提交闸门原先只认「整份台账算出来的用量」——那是在事务外读的快照，两个并发
 * 录分各自都能从同一份快照通过（见 school-match-service 里 pairCounts 一段）。
 * 现在闸门在事务内还要拿**计数文档**再判一次，判的就是同一件事：每对已用几场、
 * 是否到顶。两处共用本函数，避免「事务外说满了、事务内说没满」这种各判各的。
 *
 * @param {Array<{key:string,a:string,b:string}>} pairs 待判的对（可含重复，内部去重）
 * @param {Map<string,number>|Object} used 无序对键 → 已用场次
 * @param {Object} [options]
 * @param {number} [options.limit=RATED_PAIR_LIMIT]
 * @returns {{ok:boolean, full:Array<{key:string,a:string,b:string,count:number}>}}
 *          ok 为 false 时 full 是已满额的那些对（按发现顺序，已去重）
 */
function findCappedPairs(pairs, used, options = {}) {
  const limit = options.limit === undefined ? RATED_PAIR_LIMIT : options.limit;
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true, full: [] };

  const seen = new Set();
  const full = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!pair || !pair.key || seen.has(pair.key)) continue;
    seen.add(pair.key);
    const count = usedCountOf(used, pair.key);
    if (count >= limit) full.push({ key: pair.key, a: pair.a, b: pair.b, count });
  }
  return { ok: full.length === 0, full };
}

/**
 * 满额提示文案。事务外闸门与事务内复核共用，两处说的话一模一样。
 *
 * @param {Array<{a:string,b:string,count:number}>} full 已满额的对
 * @param {Object} [options]
 * @param {number} [options.limit=RATED_PAIR_LIMIT]
 * @param {Function} [options.nameOf] 编号 → 昵称；不给就用编号
 * @returns {string}
 */
function pairCapMessage(full, options = {}) {
  const limit = options.limit === undefined ? RATED_PAIR_LIMIT : options.limit;
  const nameOf = options.nameOf;
  const list = Array.isArray(full) ? full : [];
  if (list.length === 0) return '';
  const name = (id) => (typeof nameOf === 'function' ? nameOf(id) || id : id);

  // 只报第一对：一场双打最多两组对满额，全报出来是一句读不完的话
  const first = list[0];
  const extra = list.length > 1 ? `（另有 ${list.length - 1} 对也已满额）` : '';
  return `本赛季 ${name(first.a)} 与 ${name(first.b)} 已经打了 ${first.count} 场，` +
    `达到上限（${limit} 场），这场比赛不能再录入${extra}。` +
    '请换一位对手，或等下个赛季。';
}

module.exports = {
  isCasualMatch,
  pairKey,
  crossPairs,
  crossPairList,
  countedMatches,
  tallyPairUsage,
  seasonPairCounts,
  findCappedMatchIds,
  checkSubmitAllowed,
  findCappedPairs,
  pairCapMessage,
};
