/**
 * 学校维度首页 BFF 聚合服务（协议 2，G4）
 * ============================================================
 * 将首页首屏原本 14~16 次云调用收敛为 1 次 `getSchoolHomeSummary`：
 *   1. 学校级公告（仅已发布、只读 1 次）；
 *   2. 各启用协会近期赛事（仅报名中/进行中、开赛时间升序）与赛事/比赛总数；
 *   3. 学校级概况（当前赛季编号 + 在册活跃会员数，只读 1 次）。
 *
 * 全程不调用任何 `.list()` 整表读：协会启用状态按主键并发点读，赛事/公告/
 * 团队赛事走受控 `listPage` / `homeSummary`，会员数走 `countDirectory`。
 */

const { allAssociations, isTeamSport } = require('../../shared/utils/associations.js');
const { schoolAssociationKey, schoolEventSignupKey, scopeKey } = require('../../shared/utils/school.js');
const {
  ANNOUNCEMENT_STATUS, EVENT_STATUS, EVENT_STATUS_LABEL,
  TEAM_EVENT_STATUS, TEAM_EVENT_STATUS_LABEL, SIGNUP_STATUS,
} = require('../../shared/utils/constants.js');
const { isSettled } = require('./season-points.js');

const ok = data => ({ ok: true, data });

const DEFAULT_ANNOUNCEMENT_LIMIT = 2;
const DEFAULT_EVENT_LIMIT = 3;
const DEFAULT_EVENT_FETCH = 5;
const ANNOUNCEMENT_PAGE_LIMIT = 50;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function timeValue(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function canReadLocalSchool(ctx) {
  if (!ctx || !ctx.actor || ctx.actor.platformStatus !== 'active') return false;
  if (ctx.actor.platformRole === 'admin') return true;
  return Boolean(
    ctx.actor.primarySchoolId === ctx.schoolId
    && ctx.schoolMember
    && ctx.schoolMember.status === 'active'
  );
}

function displaySignupCount(doc) {
  const results = Array.isArray(doc.results) ? doc.results.length : 0;
  return Math.max(Number(doc.signupCount || 0), results);
}

function quotaTextOf(doc) {
  const count = displaySignupCount(doc);
  const quota = Number(doc.quota) || 0;
  return quota > 0 ? `${count}/${quota} 人` : `${count} 人`;
}

function isIndividualEventDoc(doc) {
  return Boolean(doc && doc.title && typeof doc.status === 'number' && doc.startTime);
}

function emptyResponse() {
  return {
    ok: true,
    announcements: { announcements: [], total: 0, hasMore: false },
    upcomingEvents: [],
    summary: null,
    message: '',
  };
}

/**
 * 首页 BFF 聚合入口。
 *
 * @param {Object} [payload] { announcementLimit?, eventLimit?, eventFetchLimit?, guest? }
 * @param {Object} ctx 学校级上下文（由 buildMeetContext 构建，含 school / actor / schoolMember）
 * @returns {Promise<Object>}
 */
async function getSchoolHomeSummary(payload = {}, ctx) {
  if (!ctx || !ctx.repo || !ctx.schoolId) return ok(emptyResponse());

  const announcementPageLimit = clampInt(payload.announcementFetchLimit, ANNOUNCEMENT_PAGE_LIMIT, 1, 50);
  const eventLimit = clampInt(payload.eventLimit, DEFAULT_EVENT_LIMIT, 1, 100);
  const eventFetchLimit = clampInt(payload.eventFetchLimit, Math.max(DEFAULT_EVENT_FETCH, Math.min(eventLimit, 20)), 1, 20);
  const isGuest = payload.guest === true || !ctx.actorId;

  // 游客允许看本校公告；已登录用户跨校只读浏览返回真实空聚合（不编数字）
  const allowAnnouncements = isGuest || canReadLocalSchool(ctx);
  if (!allowAnnouncements) return ok(emptyResponse());

  // 并发点读本校各协会启用状态（按主键 6 次点读，0 次 .list()）
  const associations = allAssociations();
  const assocDocs = await Promise.all(
    associations.map(assoc => ctx.repo.schoolAssociations.getById(
      schoolAssociationKey({ schoolId: ctx.schoolId, association: assoc.id }),
    )),
  );
  const enabledAssociations = associations.filter((assoc, index) => {
    const doc = assocDocs[index];
    return Boolean(doc && doc.schoolId === ctx.schoolId && doc.association === assoc.id && doc.status === 'active');
  });

  if (enabledAssociations.length === 0) return ok(emptyResponse());

  const primaryAssoc = enabledAssociations[0].id;
  const primaryScoped = ctx.repo.forScope({ schoolId: ctx.schoolId, association: primaryAssoc });

  // 1. 公告（学校级只读 1 次，仅已发布）
  let announcements = [];
  let annTotal = 0;
  let annHasMore = false;
  try {
    const annPage = await primaryScoped.announcements.listPage({
      limit: announcementPageLimit,
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
    });
    announcements = (annPage.rows || []).map(doc => ({
      announcementId: doc._id,
      title: doc.title || '（无标题）',
      content: doc.content || '',
      pinned: Boolean(doc.pinned),
      publishTime: doc.publishTime || null,
    }));
    annTotal = Number(annPage.total || 0);
    annHasMore = Boolean(annPage.hasMore);
  } catch (err) {
    console.warn(`[home-bff] 读取 ${ctx.schoolId} 公告失败`, err && err.message);
  }

  // 游客只看公告（§11.8）
  if (isGuest) {
    return ok({
      ok: true,
      announcements: { announcements, total: annTotal, hasMore: annHasMore },
      upcomingEvents: [],
      summary: null,
      message: '',
    });
  }

  // 2. 各启用协会并发取近期赛事 + 赛事/比赛总数（全走 listPage / homeSummary，0 次 .list()）
  const perAssoc = await Promise.all(enabledAssociations.map(async (assoc) => {
    const scope = { schoolId: ctx.schoolId, association: assoc.id };
    const scoped = ctx.repo.forScope(scope);
    try {
      if (isTeamSport(assoc.id)) {
        const page = await scoped.teamEvents.homeSummary({ limit: eventFetchLimit });
        const events = (page.events || []).map(event => ({
          eventId: event._id,
          eventKind: 'team',
          association: assoc.id,
          title: event.name || '',
          status: event.status,
          statusLabel: TEAM_EVENT_STATUS_LABEL[event.status] || '',
          startTime: event.startTime || '',
          location: event.location || '',
          isSignup: event.status === TEAM_EVENT_STATUS.REGISTRATION,
          isOngoing: [
            TEAM_EVENT_STATUS.LOCKED,
            TEAM_EVENT_STATUS.SCHEDULED,
            TEAM_EVENT_STATUS.RUNNING,
          ].includes(event.status),
          quotaText: '',
          mySignup: null,
        }));
        return {
          ok: true,
          events,
          eventTotal: Number(page.totalAll || 0),
          matchTotal: Number(page.matchTotal || 0),
        };
      }
      const [eventPage, matchPage] = await Promise.all([
        scoped.events.listPage({
          statuses: [EVENT_STATUS.SIGNUP, EVENT_STATUS.ONGOING],
          order: [
            { field: 'pinned', direction: 'desc' },
            { field: 'status', direction: 'asc' },
            { field: 'startTime', direction: 'asc' },
            { field: '_id', direction: 'asc' },
          ],
          limit: eventFetchLimit,
          offset: 0,
        }),
        scoped.matches.listPage({ filter: {}, limit: 0 }),
      ]);
      const docs = (eventPage.rows || []).filter(isIndividualEventDoc);
      const events = docs.map(doc => ({
        _doc: doc,
        eventId: doc._id,
        eventKind: 'individual',
        association: assoc.id,
        title: doc.title || '',
        statusLabel: EVENT_STATUS_LABEL[doc.status] || '',
        isSignup: doc.status === EVENT_STATUS.SIGNUP,
        isOngoing: doc.status === EVENT_STATUS.ONGOING,
        startTime: doc.startTime || null,
        location: doc.location || '',
        quotaText: quotaTextOf(doc),
        mySignup: null,
      }));
      return {
        ok: true,
        events,
        eventTotal: Number(eventPage.totalAll || 0),
        matchTotal: Number(matchPage.total || 0),
      };
    } catch (err) {
      console.warn(`[home-bff] 读取 ${ctx.schoolId}/${assoc.id} 失败`, err && err.message);
      return { ok: false, events: [], eventTotal: 0, matchTotal: 0 };
    }
  }));

  const readable = perAssoc.filter(item => item.ok);
  const mergedUpcoming = readable
    .flatMap(item => item.events)
    .filter(event => event.isSignup === true || event.isOngoing === true)
    .sort((a, b) => (timeValue(a.startTime) || Infinity) - (timeValue(b.startTime) || Infinity))
    .slice(0, eventLimit);

  // 仅为最终展示的 ≤ eventLimit 条个人赛点读当前用户的报名状态
  const individualTargets = mergedUpcoming.filter(item => item.eventKind === 'individual');
  const signupDocs = await Promise.all(
    individualTargets.map(item => ctx.repo.eventSignups.getById(
      schoolEventSignupKey(item.eventId, ctx.actorId, { schoolId: ctx.schoolId, association: item.association }),
    )),
  );
  const signupByEvent = new Map(individualTargets.map((item, idx) => [item.eventId, signupDocs[idx]]));

  const upcomingEvents = mergedUpcoming.map(item => {
    const out = { ...item };
    delete out._doc;
    if (out.eventKind === 'individual') {
      const signup = signupByEvent.get(out.eventId);
      const signed = Boolean(signup && signup.status !== SIGNUP_STATUS.CANCELED);
      out.mySignup = signup ? { signed } : null;
    }
    return out;
  });

  // 3. 学校级概况（赛季 + 活跃会员总数，只读 1 次）
  let summary = null;
  if (readable.length > 0) {
    let seasonNumber = 1;
    let memberCount = 0;
    try {
      const [seasonDoc, count] = await Promise.all([
        ctx.repo.seasons.getById(scopeKey({ schoolId: ctx.schoolId, association: primaryAssoc })),
        primaryScoped.schoolMembers.countDirectory({}),
      ]);
      const validSeason = seasonDoc && seasonDoc.schoolId === ctx.schoolId ? seasonDoc : null;
      seasonNumber = Number((validSeason && validSeason.seasonNumber) || 1);
      memberCount = Number(count || 0);
      // 仅用于引用检查避免 unused lint
      void isSettled;
    } catch (err) {
      console.warn(`[home-bff] 读取 ${ctx.schoolId} 概况失败`, err && err.message);
    }
    summary = {
      memberCount,
      matchCount: readable.reduce((sum, item) => sum + item.matchTotal, 0),
      eventCount: readable.reduce((sum, item) => sum + item.eventTotal, 0),
      seasonNumber,
    };
  }

  return ok({
    ok: true,
    announcements: { announcements, total: annTotal, hasMore: annHasMore },
    upcomingEvents,
    summary,
    message: '',
  });
}

module.exports = { getSchoolHomeSummary };
