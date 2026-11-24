/**
 * 协会空间：成员名录（成员页签的取数接口）
 * ============================================================
 * 只取 `schoolId` 范围内的**在册会员**（school_members.status === active 且
 * primarySchoolId 匹配），交给纯模块 association-member.js 做匹配、排序与分页。
 * 不复用跨校只读的 canReadSchool——外校人不能靠成员页把别校名单拉走。
 *
 * 【隐私口径】只下发 userId / nickName / realName / avatarUrl / collegeId /
 * collegeName / permissionLabel。realName 只参与搜索匹配、不作为主渲染字段；
 * 学号、手机号、OpenID、平台角色一律不下发（与 getSchoolMembers 一致）。
 * ============================================================
 */

const { normalizeKeyword } = require('./association-member.js');
const { loadColleges } = require('./college-directory.js');
const { canReadAssociationSpace } = require('./association-space-permission.js');
const { permissionLabelOf } = require('./school-permission.js');
const {
  schoolMemberKey, schoolRoleKey, schoolMembershipKey,
  SCHOOL_MEMBER_STATUS, PLATFORM_STATUS,
} = require('../../shared/utils/school.js');

const ok = data => ({ ok: true, data });
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function listAssociationMembers(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, members: [], nextCursor: '', hasMore: false,
      message: '没有读取本协会成员名录的权限' });
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, MAX_LIMIT) : DEFAULT_LIMIT;

  const keyword = normalizeKeyword(payload.keyword);
  if (keyword.length > 80 || (typeof payload.cursor === 'string' && payload.cursor.length > 1000)) {
    return ok({ ok: false, members: [], nextCursor: '', hasMore: false, message: '搜索关键词或游标过长' });
  }
  const scoped = ctx.repo.forScope(ctx);
  const [page, colleges] = await Promise.all([
    scoped.schoolMembers.listDirectoryPage({ keyword, cursor: payload.cursor, limit }), loadColleges(ctx),
  ]);
  const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
  page.members = page.members.map(member => ({ ...member, collegeName: collegeNameById.get(member.collegeId) || '' }));
  // 权限标签只为当前这一页补算。原来每行 2 次点读（校级角色 + 协会身份），
  // 一页 20 条就是 40 次 RPC——主键都由 userId 派生，正好整页批读各 1 次
  // （2026-10-22 H-5）。
  const roleKeys = page.members.map(member => schoolRoleKey(member.userId, ctx.schoolId));
  const membershipKeys = page.members.map(member => schoolMembershipKey(member.userId, ctx));
  const [roleDocs, membershipDocs] = await Promise.all([
    roleKeys.length ? scoped.schoolRoles.listByIds(roleKeys) : [],
    membershipKeys.length ? scoped.memberships.listByIds(membershipKeys) : [],
  ]);
  const roleById = new Map(roleDocs.map(doc => [doc._id, doc]));
  const membershipById = new Map(membershipDocs.map(doc => [doc._id, doc]));
  const members = page.members.map((member, index) => ({
    ...member,
    permissionLabel: permissionLabelOf(
      roleById.get(roleKeys[index]) || null,
      membershipById.get(membershipKeys[index]) || null,
    ),
  }));

  return ok({ ok: true, members, nextCursor: page.nextCursor, hasMore: page.hasMore,
    keyword: page.keyword, message: '' });
}

module.exports = { listAssociationMembers };
