/**
 * 公告页的视图模型（学校维度 / 协议 2）
 * ============================================================
 * 两个装载器，对应两种页面：
 *   loadSchoolAnnouncementListView    公开列表：所有人可见，只看未下架的
 *   loadSchoolAnnouncementManageView  管理台账：有发布权才可见，含已下架
 *
 * 【为什么分成两个而不是一个带 flag 的】
 * 两者的取数口径（公开只给未下架 / 台账给全量）、空态文案、失败关闭的
 * 条件都不一样。合成一个会立刻退化成一堆 if，而且最危险的差别——
 * 「谁才看得到已下架的」——会藏在分支里，改错一处就把下架内容推给了
 * 公开列表。分开之后，每一条边界都摆在明面上。
 *
 * 【管理页为什么失败关闭】
 * 没有发布权时直接返回 rows: [] 与一句 blockedText，一条公告都不下发。
 * 是否已登录由页面传入（loggedIn），用来区分「去登录」与「没这个权限」——
 * 服务端只回答「能不能管」（canManage），回答不了「为什么不能管」。
 *
 * 【公开列表为什么不分权限】
 * 公告本就是公开内容，访客也能看。schoolAnnouncementRow 的 withManage 缺省
 * 为 false，公开列表恒不下发管理按钮——公开页不该因为看的人恰好是管理员
 * 就冒出下架按钮。
 *
 * 【公开列表为什么不再分协会与分类】
 * 2026-10-18 起公告只有管理员能发，发的是全校信息；协会维度与「通知 / 赛事 /
 * 战报」分类都已从界面移除。repo 里 announcements 也移进了 SCHOOL_ONLY 档，
 * 同一学校使用一份游标分页，不再逐协会各取一次（那样会把同一条公告重复
 * 显示三遍）。分类字段仍留在数据里，只是不再展示、不再参与筛选。
 * ============================================================
 */

const { ANNOUNCEMENT_STATUS } = require('../../shared/utils/constants.js');
const { activeAssociations } = require('../../shared/utils/associations.js');
const { formatDateTime } = require('../../shared/utils/format.js');
const { DEFAULT_CATEGORY } = require('../../shared/services/announcement.js');
const { brandOf } = require('../../services/branding.js');
const scope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');

/**
 * 学校维度公告摘要（school-announcement-service.announcementSummary）→ 页面行。
 *
 * 权限布尔量随 withManage 决定：公开列表恒不下发管理按钮（withManage 缺省 false），
 * 只有管理台账才照服务端判好的 canArchive 下发——公开页不该因为看的人恰好是
 * 管理员就冒出下架按钮。状态与文案由服务端算好，这里只做字段名与展示格式的适配。
 *
 * @param {Object} summary 服务端公告摘要
 * @param {boolean} [withManage] 是否下发管理按钮
 * @returns {Object}
 */
function schoolAnnouncementRow(summary, withManage = false) {
  return {
    id: summary.announcementId,
    title: summary.title || '（无标题）',
    content: summary.content || '',
    category: summary.category || DEFAULT_CATEGORY,
    pinned: Boolean(summary.pinned),
    publishText: summary.publishTime ? formatDateTime(summary.publishTime) : '',
    statusLabel: summary.statusLabel || '',
    archived: Boolean(summary.archived),
    publisherName: summary.publisherName || '',
    canArchive: Boolean(withManage && summary.canArchive),
  };
}

/**
 * 公开公告列表——**本校全部公告**，一个通道、不分协会、不分分类。
 *
 * 【返回值形状】
 *   themeClass     当前协会的主题类（只用于配色，不影响取数）
 *   rows           已发布公告，置顶优先 → 发布时间倒序
 *   total          公告总条数
 *   visibleCount   当前页条数；页面续读时累加，total 始终为服务端总数
 *   emptyText      一条都没有时的文案
 *
 * @param {Object} [options]
 * @param {string} options.schoolId 当前学校
 * @param {string} [options.association] 当前协会，仅用于主题配色
 * @returns {Promise<Object>}
 */
async function loadSchoolAnnouncementListView(options = {}) {
  const { schoolId, association } = options;
  // 协会在这里只决定配色与客户端绑定范围（公告按学校取，与协会无关）。
  // 全局当前协会可能尚未初始化（首屏、测试夹具），退回第一个启用协会，
  // 否则 schoolScope 会直接抛「必须提供有效的 association」。
  const current = association || scope.getAssociation() || (activeAssociations()[0] || {}).id;
  const api = space.forScope({ schoolId, association: current });
  // 显式只要「已发布」：listSchoolAnnouncements 对有管理权的人返回全量
  // （含已下架，供审计），而公开列表不该因为看的人恰好是管理员就把已下架的
  // 内容摆出来——范围由这里收口，不靠查看者身份碰巧不是管理员。
  const result = await api.listSchoolAnnouncements({ status: ANNOUNCEMENT_STATUS.PUBLISHED,
    ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.limit ? { limit: options.limit } : {}) });
  if (!result || result.ok === false) throw new Error((result && result.message) || '公告读取失败');
  // 服务端按置顶、时间、编号稳定排序，这里保持游标顺序。
  const rows = (result.announcements || []).map((summary) => schoolAnnouncementRow(summary));

  return {
    themeClass: brandOf(current).rootClass,
    rows,
    total: Number.isFinite(result.total) ? result.total : rows.length,
    hasMore: Boolean(result.hasMore),
    nextCursor: result.nextCursor || '',
    visibleCount: rows.length,
    emptyText: '还没有发布公告',
  };
}

/**
 * 公告管理台账——单「学校 + 协会」范围。
 *
 * 闸门来自服务端：`canManage` 为假时一条都不下发（尤其是已下架的）。
 * 是否已登录由页面传入，用来区分「去登录」与「没这个权限」——服务端只回答
 * 「能不能管」，回答不了「为什么不能管」。
 *
 * @param {Object} [options]
 * @param {string} options.schoolId 当前学校
 * @param {string} options.association 当前协会
 * @param {boolean} [options.loggedIn] 是否已登录
 * @returns {Promise<Object>}
 */
async function loadSchoolAnnouncementManageView(options = {}) {
  const { schoolId, association, loggedIn = false } = options;
  const api = space.forScope({ schoolId, association });
  const result = await api.listSchoolAnnouncements({
    ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.limit ? { limit: options.limit } : {}),
  });
  if (!result || (result.ok === false && result.code !== 'FORBIDDEN')) throw new Error((result && result.message) || '公告读取失败');

  if (!result.canManage) {
    return {
      allowed: false,
      blockedText: loggedIn
        ? '当前账号没有管理公告的权限，请联系管理员'
        : '请先登录后再管理公告',
      viewer: { userId: '', loggedIn },
      rows: [],
      total: 0,
      hasMore: false, nextCursor: '',
      publishedCount: 0,
      archivedCount: 0,
    };
  }

  const rows = (result.announcements || [])
    .map((summary) => schoolAnnouncementRow(summary, true));

  return {
    allowed: true,
    blockedText: '',
    viewer: { userId: '', loggedIn: true },
    rows,
    total: Number.isFinite(result.total) ? result.total : rows.length,
    hasMore: Boolean(result.hasMore), nextCursor: result.nextCursor || '',
    publishedCount: rows.filter((row) => !row.archived).length,
    archivedCount: rows.filter((row) => row.archived).length,
  };
}

module.exports = {
  schoolAnnouncementRow,
  loadSchoolAnnouncementListView,
  loadSchoolAnnouncementManageView,
};
