/**
 * 排行榜页的展示辅助（P10 合并批之后的形态）
 * ============================================================
 * 【取数已经在服务端】协议 1 时代的 `loadRankView` 自己在客户端做
 * 「取台账 → 过滤 → 整形 → 算文案」，一整套纯构建器（rankProjectBoard /
 * buildEloRows / medalOf / badgeOf / avatarOf）都长在这里。学校维度（S2）
 * 把这一整套搬到了服务端 `school-rank-service.getSchoolRanking`（同形，
 * 多一个 schoolName），客户端只剩 `loadSchoolRankView` 这一个薄调用。
 * 因此那些纯构建器随协议 1 一并删除，等价覆盖建在
 * `tests/school-rank.test.js` 的「榜单展示形状」一组里。
 *
 * 【这里还剩什么】只剩**页面侧**两件服务端管不了的事：
 *   · describeSearch / filterRows / normalizeKeyword —— 搜索框的筛选与计数文案。
 *     它在 `view.allRows`（完整榜单）上跑，所以能搜到前十之外的人；
 *     两个组件（rank-panel / events-panel）都在用。
 *   · TOP_LIMIT —— 界面截断口径。服务端也有一份同值常量，这里保留是给
 *     页面与测试当契约值用。
 *
 * 【为什么榜单只展示前 10 名、名次却要在完整榜单上算】
 * 榜单是给人一个「谁最强」的印象，不是完整名册。但**「我的排名」卡不能被
 * 截断**——一个排第 20 的人如果既不在列表里、又拿不到自己的名次，这个页面
 * 就对他毫无用处。所以名次始终在完整榜单上算，前 10 只是显示层的截断。
 * ============================================================
 */

const { formatPercent } = require('../shared/utils/format.js');

/**
 * 等级榜最多展示多少名。
 * 写死而不是做成配置：这是「界面精简」定下的口径，不是一个可调参数。
 */
const TOP_LIMIT = 10;

/**
 * 归一化搜索词：去掉首尾空白，再转小写。
 *
 * 中文没有大小写，但昵称里可能夹着英文或字母（如「Leo」），
 * 统一转小写才能做到「搜 leo 也能找到 Leo」。
 *
 * @param {string} keyword
 * @returns {string} 归一化后的搜索词，空串表示不筛选
 */
function normalizeKeyword(keyword) {
  return String(keyword == null ? '' : keyword).trim().toLowerCase();
}

/**
 * 按名字筛选榜单行：昵称与真实姓名都参与匹配。
 *
 * 【为什么两个名字都要看】
 * 榜单上显示的是昵称，但昵称是各人自己起的，往往只用了名字的一部分
 * （真实姓名「赵明宇」，昵称可能就叫「明宇」）。只按昵称搜，输入「赵」
 * 就找不到这个人——可用户脑子里想的正是真名。两个都匹配，才能做到
 * 「输入赵或明宇都能找到同一个人」。命中后显示的仍是昵称，真实姓名
 * 只作为搜索依据，不上榜面。
 *
 * 【为什么只筛不重新编号】
 * 搜索不是重新排名。搜「张」时张三仍是第 8 名，不该因为前面的人被滤掉
 * 就变成第 1 名——那会让人误以为他的实力涨了。名次是榜单上的绝对坐标，
 * 搜索只决定「看不看得见」，不决定「排第几」。
 *
 * 【搜索范围是全量，展示默认只给前 10】
 * 列表默认截断到前 10 是为了精简，但「想找某个人」是另一回事：排行榜
 * 页面的搜索框就是为了定位到具体的人，只在前 10 里搜等于查不到大多数人。
 * 所以页面搜索时喂进来的是 allRows（完整榜单），默认展示的才是 rows。
 *
 * @param {Array<Object>} rows 待筛选的榜单行（页面搜索时传完整榜单）
 * @param {string} keyword 搜索词
 * @returns {Array<Object>} 命中的行，原顺序、原名次
 */
function filterRows(rows, keyword) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = normalizeKeyword(keyword);
  if (!needle) return list;
  return list.filter((row) =>
    [row.nickName, row.realName].some((name) =>
      String(name || '').toLowerCase().includes(needle)
    )
  );
}

/**
 * 把筛选结果拼成页面要显示的字段。
 *
 * 页面上的搜索框每敲一个字都会调用它，所以它必须同步、且不碰数据源——
 * 绝不能每次输入都重新拉一遍榜单。
 *
 * @param {Array<Object>} allRows 待筛选的榜单行（搜索时给完整榜单）
 * @param {string} keyword 搜索词
 * @returns {Object} { keyword, rows, searching, countText, empty, emptyNote }
 */
function describeSearch(allRows, keyword) {
  const text = String(keyword == null ? '' : keyword).trim();
  const rows = filterRows(allRows, text);
  const searching = text !== '';
  const total = Array.isArray(allRows) ? allRows.length : 0;

  return {
    keyword: text,
    rows,
    searching,
    // 搜索时问的是「找到几个」，正常浏览问的是「几个上榜」，两种语境问法不同
    countText: searching ? `找到 ${rows.length} 人` : `${rows.length} 人上榜`,
    empty: rows.length === 0,
    emptyNote: searching
      ? `没有名字含「${text}」的会员`
      : total === 0
      ? '这个项目还没有人打过'
      : '',
  };
}

/**
 * 学校维度的榜单装载器（B4-a）。
 *
 * 取数走绑定范围的 S2 客户端（association-space forScope 的 getSchoolRanking）：
 * 服务端返回的形状与旧栈 loadRankView 一致（多 schoolName），纯整形仍在
 * school-rank-service 里完成，这里只做「调用 + 失败上抛」。无读取权限时
 * 客户端抛错，由页面清空旧榜单并展示拒绝原因——不再用外校静态演示榜单
 * 掩盖访问拒绝（指南 §8）。
 *
 * @param {Object} api 绑定学校 / 协会的协会空间客户端
 * @param {Object} [options]
 * @param {string} [options.project] 榜单项目，非法或未传时退回第一个项目
 * @returns {Promise<Object>}
 */
async function loadSchoolRankView(api, options = {}) {
  const result = await api.getSchoolRanking({ project: options.project });
  if (!result.ok) throw new Error(result.message || '排行榜读取失败');
  return result;
}

module.exports = {
  TOP_LIMIT,
  normalizeKeyword,
  filterRows,
  describeSearch,
  loadSchoolRankView,
};
