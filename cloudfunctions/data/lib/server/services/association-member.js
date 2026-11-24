/**
 * 协会成员名录的搜索、排序与分页（纯函数）
 * ============================================================
 * 成员页签要在服务端做「输入即过滤 + 分页」，而不是把全量名单拉到客户端再
 * 隐藏。本模块提供匹配口径、稳定排序与游标编解码，页面和云端处理器共用同一份。
 *
 * 【匹配口径】
 * 昵称包含 或 真实姓名包含关键词；学号不参与（含学号会泄露「某人是否在册」）。
 * 先做 NFKC 归一 + 转小写再比对，全半角与大小写不再分叉。空串视为未过滤。
 *
 * 【排序口径（必须固定，否则「按一定顺序」无法复现）】
 *   1. 前缀命中优先：昵称或真名以关键词开头者排在前（搜「张」时「张宇轩」在「小张」前）；
 *   2. 同档内按昵称的稳定字典序（这里用 Unicode 码点比较，不依赖运行环境的
 *      区域设置），昵称相同再比真实姓名；
 *   3. 最后以 userId 升序做稳定键，避免同名且无前缀差异时顺序漂移。
 *
 * 【游标】
 * 游标把完整排序键编码进去，翻页时取「排序键大于游标」的记录，保证不重不漏。
 * 关键词变化时必须重置游标（游标里的前缀命中档位依赖关键词）。
 * ============================================================
 */

/** 归一化：全半角折叠 + 小写。用于匹配与比较。 */
function normalizeText(value) {
  const text = value == null ? '' : String(value);
  return typeof text.normalize === 'function' ? text.normalize('NFKC').toLowerCase() : text.toLowerCase();
}

/**
 * 关键词长度上限。
 *
 * 【为什么要截断】（2026-10-26 第四轮审查 P-13）
 * 关键词进云端后是聚合里的 `indexOfCP`——对每个人都做一次全串子串比较，
 * 成本与关键词长度成正比。正常姓名/昵称最长也就十几个字，客户端传一个
 * 几十 KB 的串既不可能是用户输入的，也不该让全校名册陪它比一遍。
 * 截断而不是报错：搜索框粘进一段长文本时，行为退化为「按前 32 字搜」，
 * 用户仍然能看懂结果。
 */
const KEYWORD_MAX = 32;

/**
 * 关键词归一化。空串表示未过滤。
 * @param {*} keyword
 * @returns {string}
 */
function normalizeKeyword(keyword) {
  return normalizeText(keyword).trim().slice(0, KEYWORD_MAX);
}

/** 昵称与真名归一后的两个字段 */
function nameFields(member) {
  return [normalizeText(member && member.nickName), normalizeText(member && member.realName)];
}

/**
 * 成员是否命中关键词。
 * @param {Object} member { nickName, realName }
 * @param {string} keyword 已归一化的关键词
 * @returns {boolean}
 */
function matchesKeyword(member, keyword) {
  if (!keyword) return true;
  return nameFields(member).some((name) => name.includes(keyword));
}

/** 是否前缀命中（0 档），用于排序优先级 */
function prefixRank(member, keyword) {
  if (!keyword) return 0;
  return nameFields(member).some((name) => name.startsWith(keyword)) ? 0 : 1;
}

/** 码点字典序比较（稳定、与运行环境 locale 无关） */
function codepointCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 计算一行的排序键：[前缀档位, 昵称, 真名, userId]。
 * @param {Object} member
 * @param {string} keyword 已归一化
 * @returns {Array} [number, string, string, string]
 */
function sortKey(member, keyword) {
  return [
    prefixRank(member, keyword),
    String((member && member.nickName) || ''),
    String((member && member.realName) || ''),
    String((member && member.userId) || ''),
  ];
}

/** 比较两个排序键 */
function compareKey(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return codepointCompare(a[1], b[1]) || codepointCompare(a[2], b[2]) || codepointCompare(a[3], b[3]);
}

/** 把排序键编成不透明游标（各段先 URL 编码，避免分隔符与内容冲突） */
function encodeCursor(key) {
  return key.map((part) => encodeURIComponent(String(part))).join('|');
}

/**
 * 解码游标；不合法（段数不对、前缀档位不是数字）时返回 null，调用方按首页处理。
 * @param {*} cursor
 * @returns {Array|null}
 */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const parts = cursor.split('|');
  if (parts.length !== 4) return null;
  let decoded;
  try {
    decoded = parts.map(decodeURIComponent);
  } catch (err) {
    return null;
  }
  const rank = Number(decoded[0]);
  if (rank !== 0 && rank !== 1) return null;
  return [rank, decoded[1], decoded[2], decoded[3]];
}

/**
 * 搜索并分页。
 *
 * @param {Array<Object>} members 本协会在册会员 DTO（含 userId/nickName/realName）
 * @param {Object} [query] { keyword, cursor, limit }
 * @returns {{members: Array<Object>, nextCursor: string, hasMore: boolean, keyword: string}}
 */
function searchMemberPage(members, query = {}) {
  const keyword = normalizeKeyword(query.keyword);
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : 20;
  const after = decodeCursor(query.cursor);

  const matched = (Array.isArray(members) ? members : [])
    .filter((member) => matchesKeyword(member, keyword))
    .map((member) => ({ member, key: sortKey(member, keyword) }))
    .sort((a, b) => compareKey(a.key, b.key));

  const remaining = after ? matched.filter((row) => compareKey(row.key, after) > 0) : matched;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  const nextCursor = hasMore && page.length ? encodeCursor(page[page.length - 1].key) : '';
  return { members: page.map((row) => row.member), nextCursor, hasMore, keyword };
}

module.exports = {
  normalizeText, normalizeKeyword, matchesKeyword, prefixRank,
  sortKey, compareKey, encodeCursor, decodeCursor, searchMemberPage,
};
