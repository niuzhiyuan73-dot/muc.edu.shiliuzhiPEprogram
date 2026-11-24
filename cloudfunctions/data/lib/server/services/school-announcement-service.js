/**
 * 学校维度：公告 —— 发布 / 下架 / 列表（协议 2，M3-a）
 * ============================================================
 * 公告是发给全校（当前学校 + 协会）的「定盘子」信息：发出去就收不回来，还会顶在
 * 首页。旧栈因此把它收归**全局管理员**（见 `announcement.canPublish`）。本模块在
 * 学校维度下重新核对这条口径，只做**归属**与**权限来源**的适配，内容校验与
 * 落库规则一字不改复用旧栈纯模块（`announcement.js`，同一把尺子）：
 *   · 公告主记录只绑 `schoolId`（2026-10-18 起移到 repo 的 SCHOOL_ONLY 档），
 *     发布时仍记下当时所在协会仅作溯源，读取与下架都只看学校——公告是全校信息，
 *     不该因为发布时停在哪家协会而只在那家协会可见；
 *   · 发布权给**平台管理员**（跨校）与**本校校级管理员**（`canSchoolAction`
 *     的 `manageSchool`，见 canPublishAnnouncement）；协会负责人与学院负责人
 *     仍不能发——公告是发全校的，没有「某个协会的公告」这一说；
 *   · 内容校验、落库记录、排序全部复用旧栈（`validateAnnouncement` /
 *     `buildAnnouncementRecord`）；列表排序由仓储按置顶、时间、编号执行。
 *
 * 【为什么写进独立的 announcements 集合、按范围过滤】
 * 旧栈把公告盖一个 association 章供读路径过滤，且没有学校边界。学校维度把
 * 「学校 + 协会」都写进文档：同一用户在不同学校 / 协会的公告互不可见，跨校读不到、
 * 写不进。集合名与云端 `school-repository` 的 `SCOPED_COLLECTIONS` 里那一项一致。
 *
 * 【列表可见性】
 * 普通会员只见「已发布」；有管理权的人（平台管理员 / 校级管理员）可见全部
 * （含已下架），以便管理台账——与旧栈 `getAnnouncements`（只给未下架）与
 * `getAnnouncementRecords`（含下架）分成两条读端同理。
 *
 * 【并发与幂等】
 * 发布用 requestId 派生稳定编号：同编号重试返回同一条，改内容则拒绝；下架只改状态
 * 不删除（话已经发出去了，至少要留痕）。每次写操作都在事务内重读上下文再判权。
 *
 * 【职责边界】
 * 注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { canReadAssociationSpace } = require('./association-space-permission.js');
const { canSchoolAction } = require('./school-permission.js');
const { legacyActorOf } = require('./school-actor.js');
const { buildAnnouncementRecord } = require('../../shared/services/announcement.js');
const { checkUgcContent } = require('./ugc-safety.js');
const {
  schoolKey, schoolAnnouncementKey,
} = require('../../shared/utils/school.js');
const {
  ANNOUNCEMENT_STATUS, ANNOUNCEMENT_STATUS_LABEL, ANNOUNCEMENT_CATEGORIES,
} = require('../../shared/utils/constants.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** 公告列表一页条数与单页上限 */
const ANNOUNCEMENT_LIST_LIMIT = 20;
const ANNOUNCEMENT_LIST_MAX = 50;

const isAnnouncementDoc = doc => Boolean(doc && doc.title && doc.status);
const iso = value => new Date(value).toISOString();

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/** 审计键：同一次操作同一版本只留一条，重试不堆记录 */
const auditKey = (announcementId, action, revision) =>
  schoolKey('annau', announcementId, action, String(revision));

/**
 * 能不能发 / 管公告。**平台管理员 + 本校校级管理员**。
 *
 * 【口径变更（2026-10-18）】
 * 原先只有平台管理员能发（旧栈 `announcement.canPublish` 的「全局管理员」口径）。
 * 试用反馈：校级管理员连本校一条公告都发不了，而他们正是最该发通知的人
 * （赛程提醒、场地变更）。规则改为「平台管理员跨校可发 + 校级管理员在本校可发」，
 * 协会负责人 / 学院负责人仍然不能发——公告没有「某个协会的公告」这一说，
 * 发给全校的通知不该由局部角色决定（沿用 announcement.js 的原判定理由）。
 *
 * 判断落到 `canSchoolAction(ctx, 'manageSchool', ...)` 这一把尺子上：
 * 它内部先放行平台管理员，再要求本校在册身份 + `schoolRole.role === 'admin'`，
 * 且校验学校与协会都启用、资源归属与当前范围一致。写操作在事务内会重跑一次，
 * 跨校只读浏览（他人学校）拿不到本校在册身份，因此无法借入口越界发布。
 */
const canPublishAnnouncement = ctx =>
  canSchoolAction(ctx, 'manageSchool', { schoolId: ctx.schoolId, association: ctx.association });

/** 公告 DTO：权限布尔量与文案在此算好，模板不写业务判断。 */
function announcementSummary(doc, canManage) {
  const archived = doc.status === ANNOUNCEMENT_STATUS.ARCHIVED;
  return {
    announcementId: doc._id,
    title: doc.title || '（无标题）',
    content: doc.content || '',
    category: doc.category || '',
    pinned: Boolean(doc.pinned),
    status: doc.status,
    statusLabel: ANNOUNCEMENT_STATUS_LABEL[doc.status] || '',
    publisherName: doc.publisherName || '',
    publishTime: doc.publishTime || null,
    archived,
    revision: Number(doc.revision || 1),
    // 已下架的没有再下架一次的道理；能发生效的只有「已发布」的那些。
    canArchive: Boolean(canManage && !archived),
  };
}

/* ------------------------------------------------------------------ 读 */

async function listSchoolAnnouncements(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, code: 'FORBIDDEN', announcements: [], canManage: false, categories: [],
      message: '没有读取协会空间的权限' });
  }
  const canManage = canPublishAnnouncement(ctx);
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, ANNOUNCEMENT_LIST_MAX) : ANNOUNCEMENT_LIST_LIMIT;
  const status = typeof payload.status === 'string' ? payload.status : '';
  const empty = { announcements: [], total: 0, hasMore: false, nextCursor: '',
    canManage, categories: ANNOUNCEMENT_CATEGORIES.slice() };
  if (!canManage && status && status !== ANNOUNCEMENT_STATUS.PUBLISHED) {
    return ok({ ok: true, ...empty, message: '' });
  }
  try {
    const page = await ctx.repo.forScope(ctx).announcements.listPage({
      status: canManage ? status : ANNOUNCEMENT_STATUS.PUBLISHED,
      category: typeof payload.category === 'string' ? payload.category : '',
      cursor: payload.cursor, limit,
    });
    return ok({ ok: true, ...empty, total: page.total, hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      announcements: page.rows.map(doc => announcementSummary(doc, canManage)), message: '' });
  } catch (error) {
    if (error.code === 'INVALID_CURSOR') return ok({ ok: false, ...empty, message: error.message });
    throw error;
  }
}

/* ------------------------------------------------------------------ 写 */

async function publishSchoolAnnouncement(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const actor = legacyActorOf(ctx, { actorCollege: '' });
  // 分类已从界面移除（公告只剩一个通道），但旧模块的校验仍要求白名单值，
  // 所以缺省补成第一档而不是让整条发布失败。
  const withCategory = {
    ...payload,
    category: payload.category || ANNOUNCEMENT_CATEGORIES[0],
  };
  const built = buildAnnouncementRecord(withCategory, { actor, now: ctx.now });
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors }));
  const { title, content, category, pinned } = built.record;
  const ugc = await checkUgcContent({ title, content }, ctx);
  if (!ugc.ok) return ok(refused(ugc.message));
  const fingerprint = JSON.stringify([title, content, category, pinned]);

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canPublishAnnouncement(fresh)) return refused('只有平台管理员或本校校级管理员可以发布公告');

    const announcementId = schoolAnnouncementKey(schoolKey('a', fresh.actorId, token), fresh);
    const existing = await tx.announcements.getById(announcementId);
    if (isAnnouncementDoc(existing)) {
      return existing.fingerprint === fingerprint
        ? { ok: true, announcement: announcementSummary(existing, true), message: '' }
        : refused('请求编号已使用，请重新发布');
    }

    const at = iso(fresh.now);
    const doc = {
      ...built.record,
      _id: announcementId,
      schoolId: fresh.schoolId,
      association: fresh.association,
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      publishTime: at,
      fingerprint,
      revision: 1,
      updatedAt: at,
    };
    await tx.announcements.set(announcementId, doc);
    await tx.audit.append({ _id: auditKey(announcementId, 'publishSchoolAnnouncement', 1),
      action: 'publishSchoolAnnouncement', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, announcementId, at });
    return { ok: true, announcement: announcementSummary(doc, true), message: '' };
  });
  return ok(result);
}

async function archiveSchoolAnnouncement(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.announcementId !== 'string' || !payload.announcementId) {
    return ok(refused('缺少公告编号'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canPublishAnnouncement(fresh)) return refused('只有平台管理员或本校校级管理员可以管理公告');

    const doc = await tx.announcements.getById(payload.announcementId);
    // 公告是**学校级**的：只要求同校，不再要求「当前协会一致」。
    // 否则管理员在民大匹克球协会页下架自己刚在乒乓球协会页发的通知会失败。
    if (!isAnnouncementDoc(doc) || doc.schoolId !== fresh.schoolId) return refused('找不到这条公告');
    if (doc.status === ANNOUNCEMENT_STATUS.ARCHIVED) return refused('这条公告已经下架了');

    const at = iso(fresh.now);
    const next = { ...doc, status: ANNOUNCEMENT_STATUS.ARCHIVED, archivedAt: at, archivedBy: fresh.actorId,
      revision: Number(doc.revision || 1) + 1, updatedAt: at };
    await tx.announcements.set(next._id, next);
    await tx.audit.append({ _id: auditKey(doc._id, 'archiveSchoolAnnouncement', next.revision),
      action: 'archiveSchoolAnnouncement', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, announcementId: doc._id, at });
    return { ok: true, announcement: announcementSummary(next, true), message: '' };
  });
  return ok(result);
}

module.exports = {
  ANNOUNCEMENT_LIST_LIMIT, ANNOUNCEMENT_LIST_MAX, isAnnouncementDoc,
  listSchoolAnnouncements, publishSchoolAnnouncement, archiveSchoolAnnouncement,
};
