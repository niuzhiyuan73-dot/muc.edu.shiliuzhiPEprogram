/**
 * 学校维度首页装载器（B4-b）
 * ============================================================
 * 首页自上而下两块内容：公告 + 近期赛事，以及登录后的概况数字。
 * 学校维度下这两块都按「当前浏览学校」取数，**跨该校的协会聚合**：
 *
 *   · 公告  —— 学校级 listSchoolAnnouncements 一份，只展示已发布；
 *   · 赛事  —— 按运动类型取个人赛或团队摘要，合并近期赛事、按开赛时间升序；
 *   · 概况  —— 会员数（学校级，取一份）、比赛数 / 赛事数（按协会相加）、赛季编号。
 *
 * 每个协会单独建客户端、单独容错：某协会未启用 / 无读取权限时跳过该协会，
 * 不把整页拖垮；一个协会都读不到时给真实空态（游客与跨校只读浏览同理），
 * 不再用外校静态演示内容顶替（指南 §8）。
 *
 * 【读量约束】（2026-10-22 大用户量复查 H-1）
 * 首页是全校最热的入口，必须假设「每次打开都可能乘以全校在线人数」：
 *   · 每个协会**一次**赛事查询，只取最近要开的几条（不循环取完）；
 *   · 会员数与赛季是学校级的一份数字，**只读一次**（原先按 6 个协会各读一遍，
 *     每遍都是全校名单 + 该校全部账号）；
 *   · 公告是学校级一条通道，只取一次。
 * 改这个文件时请守住这三条——任何「按协会重复读一份学校级数据」都是 6 倍放大。
 *
 * 游客（无 viewerId）只看公告（需求整理 §11.8），赛事与概况不取。
 * ============================================================
 */

const { allAssociations, getAssociation, isTeamSport } = require('../utils/associations.js');
const { formatDate, formatDateTime } = require('../utils/format.js');
const { ANNOUNCEMENT_STATUS } = require('../utils/constants.js');

/** 首页默认展示的公告与赛事条数。太多会把首屏撑得很长。 */
const DEFAULT_ANNOUNCEMENT_LIMIT = 2;
const DEFAULT_EVENT_LIMIT = 3;

/** 公告首页最多取一页，完整列表由公告页继续翻页。 */
const PAGE_LIMIT = 50;

/** 时间字段转毫秒。非法值一律当 0 沉底，绝不产生 NaN 比较 */
function timeValue(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** 还能参加（报名中）或正在进行的赛事才算「近期」 */
function isUpcomingEvent(event) {
  if (!event) return false;
  return event.isSignup === true || event.isOngoing === true;
}

/**
 * 按开赛时间升序（最近要打的在前）排序并截断。
 * @param {Array<Object>} rows
 * @param {number} limit
 * @returns {Array<Object>}
 */
function sortUpcoming(rows, limit) {
  return rows
    .filter(isUpcomingEvent)
    .sort((a, b) => (timeValue(a.startTime) || Infinity) - (timeValue(b.startTime) || Infinity))
    .slice(0, limit);
}

/**
 * 整形一条公告。
 *
 * 公告是**学校级**的一条通道（2026-10-18 起只有管理员能发），不再标注「属于哪个
 * 协会」，也不再带分类标签——首页与公告页看到的是同一份列表。
 */
function announcementRow(item) {
  return {
    id: item.announcementId,
    title: item.title || '',
    content: item.content || '',
    pinned: Boolean(item.pinned),
    dateText: formatDate(item.publishTime),
  };
}

/** 整形一条近期赛事（字段供 index.wxml 的赛事卡直接渲染）。 */
function eventRow(event, assoc) {
  return {
    id: event.eventId,
    eventKind: event.eventKind || 'individual',
    title: event.title || event.name || '',
    statusLabel: event.statusLabel || '',
    isOngoing: Boolean(event.isOngoing),
    timeText: event.startTime ? formatDateTime(event.startTime) : '时间待定',
    dateText: event.startTime ? formatDate(event.startTime) : '',
    clockText: event.startTime ? formatDateTime(event.startTime).slice(-5) : '',
    location: event.location || '',
    quotaText: event.quotaText || '',
    signedUp: Boolean(event.mySignup && event.mySignup.signed),
    association: assoc.id,
    associationName: assoc.shortName,
    associationGlyph: assoc.logoGlyph,
  };
}

/**
 * 取本校公告首页（服务端每页限量 50、无 offset，首页展示只需第一页）。
 * 公告集合是学校级的，**只取一次**——按协会各取一次会把同一条公告重复三遍。
 * 读不到时抛错，由调用方退化成「暂无公告」。
 */
async function collectAnnouncements(api) {
  const page = await api.listSchoolAnnouncements({ limit: PAGE_LIMIT, status: ANNOUNCEMENT_STATUS.PUBLISHED });
  if (!page.ok) throw new Error(page.message || '公告读取失败');
  return { announcements: page.announcements || [], total: page.total, hasMore: Boolean(page.hasMore) };
}

/**
 * 首页每个协会最多取几条赛事。
 *
 * 【为什么不再循环取完】（2026-10-22 大用户量复查 H-1）
 * 原实现对每个协会 `collectEvents` 循环翻页取**全部**赛事，而首页只展示 3 条。
 * 服务端排序是「置顶 → 状态（报名中 > 进行中 > 已结束）→ 时间」，再带上
 * status=[0,1] 与 order=asc，前面几条就是「最近要开的几场」——取 5 条足够
 * 跨协会合并出首页的 3 条。一个协会有 200 场赛事时，这一步从 2 页 RPC 降到 1 次。
 */
const HOME_EVENT_FETCH = 5;

/** 首页「近期赛事」只关心这两个状态：报名中 0、进行中 1（已结束不出现） */
const UPCOMING_EVENT_STATUS = [0, 1];

/**
 * 一次聚合：遍历客户端注册表里的协会，逐个建绑定范围客户端并取数。
 * 单协会读失败（未启用 / 无权限）跳过，不拖垮整页。
 *
 * 【两轮而不是一轮】（2026-10-22 大用户量复查 H-1）
 * 会员数与赛季是**学校级**的同一份数字：原先按 6 个协会各读一遍，每读一遍
 * 都是「全校在册名单 + 该校全部账号」（2000 人的学校约 41 次 RPC），首页开一次
 * 就是 250 次读。现在它们从协会循环里拎出来，等第一轮知道「哪些协会可读」之后
 * 只读一次——多一轮 RTT，省掉 5 份重复。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.viewerId 当前登录人编号；空串即访客
 * @param {number} [options.announcementLimit]
 * @param {number} [options.eventLimit]
 * @param {Object} [options.client] 协会空间门面（测试可注入替身）
 * @returns {Promise<Object>} 首页视图模型
 */
async function loadSchoolHomeView(options = {}) {
  const schoolId = options.schoolId || '';
  const viewerId = options.viewerId || '';
  const announcementLimit = Number.isInteger(options.announcementLimit)
    ? options.announcementLimit : DEFAULT_ANNOUNCEMENT_LIMIT;
  const eventLimit = Number.isInteger(options.eventLimit) ? options.eventLimit : DEFAULT_EVENT_LIMIT;
  const client = options.client || require('./association-space.js');

  // 公告：学校级一条通道，只取一次（按协会各取一次会把同一条公告重复三遍）
  const primaryAssociation = (allAssociations()[0] || {}).id || '';
  const announcementApi = client.forScope({ schoolId, association: primaryAssociation });
  let announcementPage = { announcements: [], hasMore: false };
  try {
    announcementPage = await collectAnnouncements(announcementApi);
  } catch (err) {
    // 公告读不到不该拖垮赛事与概况：首页公告退化成「暂无公告」
    console.warn(`[home] 读取 ${schoolId} 公告失败`, err);
  }
  // 服务端已按置顶优先 + 时间倒序排好，这里不再重排
  const announcementDocs = announcementPage.announcements.map((item) => announcementRow(item));
  const announcementsHasMore = announcementPage.hasMore;

  // 第一轮：每个协会一次调用，取「最近要开的几场」与「比赛总数」
  const perAssociation = await Promise.all(allAssociations().map(async (assoc) => {
    const api = client.forScope({ schoolId, association: assoc.id });
    try {
      let events = [];
      let matchTotal = 0;
      let eventTotal = 0;
      if (viewerId) {
        const [page, matches] = isTeamSport(assoc.id)
          ? [await api.listTeamEvents({ home: true, limit: HOME_EVENT_FETCH }), null]
          : await Promise.all([
          api.listSchoolEvents({
            limit: HOME_EVENT_FETCH, offset: 0, status: UPCOMING_EVENT_STATUS, order: 'asc',
          }),
          api.listSchoolMatches({ limit: 1 }),
        ]);
        if (!page || page.ok === false) throw new Error((page && page.message) || '赛事读取失败');
        events = page.events || [];
        // totalAll 是「不看状态筛选」的赛事总量：概况里的「N 场赛事」用它，
        // 不能被「只看近期」的筛选带偏成个位数。
        eventTotal = Number(page.totalAll || 0) || events.length;
        matchTotal = Number(isTeamSport(assoc.id) ? page.matchTotal || 0 : (matches && matches.total) || 0);
      }
      return { assoc: getAssociation(assoc.id), events, matchTotal, eventTotal };
    } catch (err) {
      // 该校未启用此协会 / 无读取权限：该协会视为空，不冒充成功
      console.warn(`[home] 读取 ${schoolId}/${assoc.id} 首页数据失败`, err);
      return { assoc: null, events: [], matchTotal: 0, eventTotal: 0 };
    }
  }));

  const readable = perAssociation.filter((row) => row.assoc !== null);

  // 第二轮：会员数与赛季（学校级，任何可读协会读到的都是同一份）
  let memberCount = 0;
  let seasonText = '';
  if (viewerId && readable.length > 0) {
    const api = client.forScope({ schoolId, association: readable[0].assoc.id });
    try {
      const [season, members] = await Promise.all([
        api.getSchoolSeason(),
        // 【只取数字】（2026-10-29 第十一轮审计 P2-3）
        // 概况里只需要「本校会员数」。原先调平铺名录：读完全部学籍 + 批读全部账号，
        // 2000 人的学校就是 2000 条文档 + 20 批 RPC，只为 members.length。
        // countOnly 走同一套目录过滤的聚合计数，一次 RPC 返回数字。
        api.listSchoolMembers({ countOnly: true }),
      ]);
      seasonText = `第 ${Number((season && season.season && season.seasonNumber) || 1)} 赛季`;
      memberCount = Number((members && members.total) || 0);
    } catch (err) {
      // 概况数字读不到就留空：宁可少一行数字，也不要编一个
      console.warn(`[home] 读取 ${schoolId} 概况失败`, err);
    }
  }

  // 近期赛事聚合：报名中 / 进行中，开赛时间升序。筛选在整形前做——
  // eventRow 只带展示字段（isOngoing），isSignup 判据来自原始 DTO。
  const upcomingEvents = viewerId
    ? sortUpcoming(
      readable.flatMap((row) => row.events.map((event) => ({ ...event, __assoc: row.assoc }))),
      eventLimit
    ).map((event) => eventRow(event, event.__assoc))
    : [];

  // 概况：会员数取第一份（学校级，不按协会相加）；比赛 / 赛事按协会相加。
  // 一个协会都读不到时概况给 null（与访客同口径），不编数字。
  let summary = null;
  if (viewerId && readable.length > 0) {
    summary = {
      memberCount,
      matchCount: readable.reduce((sum, row) => sum + row.matchTotal, 0),
      eventCount: readable.reduce((sum, row) => sum + row.eventTotal, 0),
      seasonText,
    };
  }

  return {
    loggedIn: Boolean(viewerId),
    announcements: {
      rows: announcementDocs.slice(0, announcementLimit),
      total: Number.isFinite(announcementPage.total) ? announcementPage.total : announcementDocs.length,
      hasMore: announcementsHasMore || announcementDocs.length > announcementLimit,
    },
    upcomingEvents,
    summary,
  };
}

module.exports = {
  DEFAULT_ANNOUNCEMENT_LIMIT,
  DEFAULT_EVENT_LIMIT,
  PAGE_LIMIT,
  timeValue,
  isUpcomingEvent,
  sortUpcoming,
  announcementRow,
  eventRow,
  loadSchoolHomeView,
};
