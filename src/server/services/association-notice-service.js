/**
 * 协会空间：空间通知的事务编排
 * ============================================================
 * 「空间通知」是协会内部的公告：复用全局公告的**文本校验**（services/announcement.js
 * 的 validateAnnouncement）与分类白名单，但**不复用**旧的发布权、旧集合与旧读取端。
 * 它只存在于一个学校的一个协会内，写进独立的 association_notices 集合，绝不进
 * 首页公告栏 / 旧公告中心 / 全站公告数量（规划 §3.3、§5.3）。
 *
 * 【职责边界】
 * 本模块注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 权限判定在同目录 association-space-permission.js，文本校验复用 announcement.js。
 *
 * 【为什么要带发布人快照】
 * 通知列表要显示「谁发的」。发布时把昵称写进 createdByName，不在读取时再去查用户，
 * 免得列表一次翻页触发 N 次查库；同时用户后来改昵称也不至于把历史记录改写。
 *
 * 【排序与分页为什么用 ISO 串】
 * 排序键为「置顶优先 → 发布时间倒序 → ID 升序」（规划 §3.3）。时间统一持久化成
 * ISO 串（§5.1 允许），字典序即时间序，翻页游标按同一套键编码，保证不重不漏。
 *
 * 【幂等与并发】
 *   · 发布用 requestId 派生的稳定 noticeId：同 requestId 重试返回同一条，不同 payload
 *     则拒绝，避免换一个编号重复发一条；
 *   · 编辑 / 撤回带 expectedRevision，冲突即要求刷新；
 *   · 每次写操作都在事务内重读上下文再判权，不信任页面打开时的旧权限快照（§4.1）。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { canReadAssociationSpace, canManageAssociationSpace } = require('./association-space-permission.js');
const { validateAnnouncement } = require('../../shared/services/announcement.js');
const { checkUgcContent } = require('./ugc-safety.js');
const { schoolKey, belongsToSchoolScope, associationNoticeKey } = require('../../shared/utils/school.js');
const {
  ASSOCIATION_NOTICE_STATUS, ASSOCIATION_NOTICE_STATUS_LABEL,
} = require('../../shared/utils/constants.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** 通知列表一页条数与单页上限 */
const NOTICE_LIST_LIMIT = 20;
const NOTICE_LIST_MAX = 50;

const isNoticeDoc = doc => Boolean(doc && doc.title && doc.status);
const iso = value => new Date(value).toISOString();
const displayName = actor => (actor ? (actor.nickName || actor.realName || actor._id) : '');

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/** 审计键：同一次操作同一版本只留一条，重试不堆记录 */
const auditKey = (noticeId, action, revision) => schoolKey('anau', noticeId, action, String(revision));

/** 通知排序：置顶优先 → 发布时间倒序 → ID 升序（稳定，保证翻页可复现） */
function compareNotices(a, b) {
  const pa = a.pinned ? 1 : 0;
  const pb = b.pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;
  const ta = String(a.publishedAt || '');
  const tb = String(b.publishedAt || '');
  if (ta !== tb) return ta < tb ? 1 : -1;
  if (a._id === b._id) return 0;
  return a._id < b._id ? -1 : 1;
}

/** 通知 DTO：会员只见可读字段；管理端的可编辑/可撤回由入参 canManage 决定 */
function noticeSummary(doc, canManage) {
  const published = doc.status === ASSOCIATION_NOTICE_STATUS.PUBLISHED;
  return {
    noticeId: doc._id,
    title: doc.title || '',
    content: doc.content || '',
    category: doc.category || '',
    pinned: Boolean(doc.pinned),
    status: doc.status,
    statusLabel: ASSOCIATION_NOTICE_STATUS_LABEL[doc.status] || '',
    publisherName: doc.createdByName || '',
    publishedAt: doc.publishedAt || null,
    updatedAt: doc.updatedAt || null,
    revision: Number(doc.revision || 1),
    canEdit: Boolean(canManage && published),
    canWithdraw: Boolean(canManage && published),
  };
}

/* ------------------------------------------------------------------ 读 */

async function listAssociationNotices(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, notices: [], canManage: false, nextCursor: '', hasMore: false,
      message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, NOTICE_LIST_MAX) : NOTICE_LIST_LIMIT;
  const pageResult = await ctx.repo.forScope(ctx).associationNotices.listPage({
    canManage,
    cursor: typeof payload.cursor === 'string' ? payload.cursor : '',
    limit,
  });
  const page = (pageResult.rows || []).filter(isNoticeDoc);

  return ok({ ok: true, canManage, hasMore: Boolean(pageResult.hasMore), nextCursor: pageResult.nextCursor || '',
    notices: page.map(row => noticeSummary(row, canManage)), message: '' });
}

async function getAssociationNotice(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.noticeId !== 'string' || !payload.noticeId) return ok(refused('缺少通知编号'));
  const doc = await ctx.repo.associationNotices.getById(payload.noticeId);
  if (!isNoticeDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('通知不存在'));
  const canManage = canManageAssociationSpace(ctx);
  // 撤回后会员直达也不可读；管理者仍可打开查看（§3.3、N02）。
  if (!canManage && doc.status !== ASSOCIATION_NOTICE_STATUS.PUBLISHED) return ok(refused('通知不存在'));
  return ok({ ok: true, notice: noticeSummary(doc, canManage), canManage, message: '' });
}

/* ------------------------------------------------------------------ 写 */

async function publishAssociationNotice(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const validation = validateAnnouncement(payload);
  if (!validation.ok) return ok(refused(validation.firstError));
  const { title, content, category, pinned } = validation.draft;
  const ugc = await checkUgcContent({ title, content }, ctx);
  if (!ugc.ok) return ok(refused(ugc.message));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));
  const fingerprint = JSON.stringify([title, content, category, pinned]);

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布通知');
    const noticeId = associationNoticeKey(schoolKey('n', fresh.actorId, token), fresh);
    const existing = await tx.associationNotices.getById(noticeId);
    if (isNoticeDoc(existing)) {
      return existing.fingerprint === fingerprint
        ? { ok: true, notice: noticeSummary(existing, true), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    const at = iso(fresh.now);
    const doc = {
      _id: noticeId, schoolId: fresh.schoolId, association: fresh.association,
      title, content, category, pinned,
      status: ASSOCIATION_NOTICE_STATUS.PUBLISHED,
      publishedAt: at, withdrawnAt: null, withdrawnBy: '',
      createdBy: fresh.actorId, createdByName: displayName(fresh.actor),
      fingerprint, revision: 1, createdAt: at, updatedAt: at,
    };
    await tx.associationNotices.set(noticeId, doc);
    await tx.audit.append({ _id: auditKey(noticeId, 'publishAssociationNotice', 1),
      action: 'publishAssociationNotice', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, noticeId, at });
    return { ok: true, notice: noticeSummary(doc, true), message: '' };
  });
  return ok(result);
}

async function updateAssociationNotice(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.noticeId !== 'string' || !payload.noticeId) return ok(refused('缺少通知编号'));
  const validation = validateAnnouncement(payload);
  if (!validation.ok) return ok(refused(validation.firstError));
  const { title, content, category, pinned } = validation.draft;
  const ugc = await checkUgcContent({ title, content }, ctx);
  if (!ugc.ok) return ok(refused(ugc.message));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新通知版本后重试'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以编辑通知');
    const doc = await tx.associationNotices.getById(payload.noticeId);
    if (!isNoticeDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('通知不存在');
    if (doc.status !== ASSOCIATION_NOTICE_STATUS.PUBLISHED) return refused('已撤回的通知不能再编辑');
    if (doc.revision !== payload.expectedRevision) return refused('通知已修改，请刷新后重试');
    if (doc.title === title && doc.content === content && doc.category === category &&
        Boolean(doc.pinned) === pinned) {
      return { ok: true, notice: noticeSummary(doc, true), message: '' };
    }
    const at = iso(fresh.now);
    const next = { ...doc, title, content, category, pinned, revision: doc.revision + 1, updatedAt: at };
    await tx.associationNotices.set(next._id, next);
    await tx.audit.append({ _id: auditKey(doc._id, 'updateAssociationNotice', next.revision),
      action: 'updateAssociationNotice', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, noticeId: doc._id, at });
    return { ok: true, notice: noticeSummary(next, true), message: '' };
  });
  return ok(result);
}

async function withdrawAssociationNotice(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.noticeId !== 'string' || !payload.noticeId) return ok(refused('缺少通知编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新通知版本后重试'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以撤回通知');
    const doc = await tx.associationNotices.getById(payload.noticeId);
    if (!isNoticeDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('通知不存在');
    if (doc.status === ASSOCIATION_NOTICE_STATUS.WITHDRAWN) {
      return { ok: true, notice: noticeSummary(doc, true), message: '' };
    }
    if (doc.revision !== payload.expectedRevision) return refused('通知已修改，请刷新后重试');
    const at = iso(fresh.now);
    const next = { ...doc, status: ASSOCIATION_NOTICE_STATUS.WITHDRAWN,
      withdrawnAt: at, withdrawnBy: fresh.actorId, revision: doc.revision + 1, updatedAt: at };
    await tx.associationNotices.set(next._id, next);
    await tx.audit.append({ _id: auditKey(doc._id, 'withdrawAssociationNotice', next.revision),
      action: 'withdrawAssociationNotice', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, noticeId: doc._id, at });
    return { ok: true, notice: noticeSummary(next, true), message: '' };
  });
  return ok(result);
}

module.exports = {
  NOTICE_LIST_LIMIT, NOTICE_LIST_MAX, compareNotices,
  listAssociationNotices, getAssociationNotice,
  publishAssociationNotice, updateAssociationNotice, withdrawAssociationNotice,
};
