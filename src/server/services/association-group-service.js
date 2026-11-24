/**
 * 协会空间：成员小组的事务编排
 * ============================================================
 * 「分组」是长期存在的协会成员小组（如「新手组」「校队组」），由空间管理者维护：
 * 建组、批量选入、本人退出、管理移除、归档、删除。它与赛事签表的「小组赛分组」无关，
 * 用独立的 associationGroups / associationGroupMembers 两个集合。
 *
 * 【职责边界】
 * 本模块注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 纯规则（权限、受众、成员搜索）在同目录的 association-space-permission.js /
 * association-audience.js / association-member.js，本模块只做事务与校验。
 *
 * 【并发与幂等怎么保证】
 *   · 每个写操作都在事务内重读上下文再判权，不信任页面打开时的旧权限快照；
 *   · 建组用「请求编号」派生的稳定 groupId：同 requestId 重试返回同一结果，不同
 *     payload 则拒绝，避免换一个编号就重复建组；
 *   · 「同范围不重名」写成对同一占位文档（nameClaim）的写冲突，而不是先查重再插入；
 *   · 成员关系用 scope + groupId + userId 的稳定主键，重复加入是幂等的，人数最多变一次；
 *   · 删除是**软删除**：仓储 forScope 只提供 list/getById/set/insert/update，本来也删不掉
 *     文档；而且历史活动与审计都按 groupId 指向这个组，物理删掉只会留下悬空引用。
 *     删除把组置为 deleted、结束组内 ACTIVE 关系、释放组名占位，并让后续一切读写把
 *     它当成「不存在」。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { checkUgcContent } = require('./ugc-safety.js');
const { loadColleges } = require('./college-directory.js');
const { canReadAssociationSpace, canManageAssociationSpace } = require('./association-space-permission.js');
const { runVersionedBatchJob } = require('./versioned-batch-job.js');
const { permissionLabelOf } = require('./school-permission.js');
const { maskPublicNickName } = require('../../shared/utils/privacy-mask.js');
const {
  schoolKey, schoolMemberKey, schoolRoleKey, schoolMembershipKey, belongsToSchoolScope,
  associationGroupKey, associationGroupMemberKey, associationGroupNameKey,
  SCHOOL_MEMBER_STATUS, PLATFORM_STATUS, schoolAssociationKey,
} = require('../../shared/utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/**
 * 单次请求最多 28 人；创建在一个事务内，添加按 20 人分批。
 *
 * 【为什么是 28】（第二十二轮 P3）
 * 建组事务的固定开销约 11 次（身份 6 + 幂等读 1 + 名称占用读写 2 + 组文档 1
 * + 审计 1），每人再 3 次（2 次资格读 + 1 次写）。30 人 = 101，正好越过
 * `TX_OPERATION_BUDGET`；28 人 = 95，留 5 次余量。要更多请先建空组再用
 * 「批量添加」（20 人一个事务）。
 */
const MAX_MEMBERS_PER_WRITE = 28;
/** 批量添加的外层上限：内部按 20 人一个事务分批，100 人 = 5 批。 */
const MAX_MEMBERS_PER_ADD = 100;
const MAX_NAME_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 300;
const GROUP_LIST_LIMIT = 50;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * 成员编号的形状：平台账号编号形如 `acc:<openid>`（也兼容历史 `u_…`）。
 * 限 64 是因为它会直接进 schoolKey 当 _id 的一段（2026-10-21 审查 P2-10）。
 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;

const GROUP_STATUS = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived', DELETED: 'deleted' });
const GROUP_MEMBER_STATUS = Object.freeze({ ACTIVE: 'active', LEFT: 'left', REMOVED: 'removed' });

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/** 组名占位/组/关系都按稳定键落库；审计键也走 schoolKey，保证不重复。 */
const auditKey = (groupId, action, revision) => schoolKey('agau', groupId, action, String(revision));
const isGroupDoc = doc => Boolean(doc && !doc.nameClaim && doc.name && doc.status);
/**
 * 「存在且可用」的小组。isGroupDoc 只看 status 是否为真值，而软删除后的组照样带着
 * status（'deleted'），所以要显式排掉 DELETED：不排掉的话，删掉的组会继续出现在列表里、
 * 继续可读可编辑——用户报的「删不掉」就会变成「删了还在」。
 */
const isLiveGroupDoc = (doc, ctx) =>
  isGroupDoc(doc) && doc.status !== GROUP_STATUS.DELETED && belongsToSchoolScope(doc, ctx);

/** 规范化可选文本 */
const text = (value, max) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > max) return { ok: false, message: '填写内容过长' };
  return { ok: true, value: trimmed };
};

function normalizeMemberIds(input, max = MAX_MEMBERS_PER_WRITE) {
  if (input === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(input)) return { ok: false, message: '成员清单格式无效' };
  const ids = [];
  for (const id of input) {
    // 只判「非空字符串」不够：这些 id 会直接拼进 schoolKey 当 _id，
    // 而 encodeURIComponent 对非 ASCII 还会膨胀 3 倍。一条 1 MB 的 id 就能
    // 造出超长主键（30 条 = 近 90 MB 请求体），配合没有限流的读接口就是
    // 现成的资源耗尽手段（2026-10-21 审查 P2-10）。
    // 号段与 GROUP_ID_PATTERN 同一口径：平台账号编号形如 `acc:xxxx`。
    if (typeof id !== 'string' || !MEMBER_ID_PATTERN.test(id)) return { ok: false, message: '成员编号无效' };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > max) return { ok: false, message: `单次最多添加 ${max} 名成员` };
  return { ok: true, ids };
}

/**
 * 校验一组 userId 都是**本校本协会在册且合格**的会员。任何一个不合格即整体失败，
 * 不悄悄删人。
 * @returns {{ok:boolean, message:string}}
 */
async function assertEligibleMembers(tx, ctx, userIds) {
  // 事务内禁止 Promise.all 并发读：微信云开发事务要求串行 await。
  for (const userId of userIds) {
    const member = await tx.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId));
    const user = await tx.users.getById(userId);
    if (!member || member.userId !== userId || member.schoolId !== ctx.schoolId ||
        member.status !== SCHOOL_MEMBER_STATUS.ACTIVE ||
        !user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) {
      return { ok: false, message: '只能选择本协会在册会员' };
    }
  }
  return { ok: true, message: '' };
}

/** 组摘要 DTO（不含成员名单） */
function groupSummary(group, joined) {
  return {
    groupId: group._id, name: group.name, description: group.description || '',
    status: group.status, cleanupPending: Boolean(group.cleanupPending), memberCount: Number(group.memberCount || 0),
    revision: Number(group.revision || 1),
    createdAt: group.createdAt || null, updatedAt: group.updatedAt || null, joined: Boolean(joined),
  };
}

/**
 * 成员名录 DTO：昵称 + 学院 + 权限标签，不含学号 / 手机号 / OpenID。
 *
 * 【取数方式的两个阶段】
 * 1. 2026-10-17 审计 C5：从前是「每个成员 4 次 getById」，50 人的组就是 200 次
 *    RPC，云端 QPS 配额只有 30，风群并发直接触发限流。于是改成四张表各读一次
 *    建 Map —— RPC 从 4N 降到 4，但那 4 次里有两次是**整表读**（全校名册 /
 *    全校角色），学校到 2000 人就是 20 页以上。
 * 2. 2026-10-23 第三轮 X-11：改成「学院目录读一页 + 其余三张表按这批人的
 *    主键批读」。小组几十人就是几十个主键、一次 `_.in`，与学校规模无关。
 *
 * @param {Object} repo ctx.repo（读路径，不在事务里）
 * @param {Object} ctx
 * @param {Array<string>} userIds
 */
async function describeMembers(repo, ctx, userIds) {
  // 【为什么改成按这批人批读】（2026-10-23 第三轮审查 X-11）
  // 原注释的取舍是「四张表各读一次，RPC 从 4N 降到 4」——那是 50 人规模下的
  // 正确算法；到 2000 人的学校，schoolMembers 一次就是 20 页，而一个小组只有
  // 几十人。现在：学院目录仍读一页（几十条，要拿编号→全名），其余三张表都按
  // 「这批人的主键」批读（每 100 个一批），总量与小组人数成正比，与学校规模无关。
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
    .filter(id => typeof id === 'string' && id))];
  const [colleges, members, roles, memberships] = await Promise.all([
    loadColleges(ctx, repo),
    ids.length ? repo.forScope(ctx).schoolMembers.listByIds(ids.map(id => schoolMemberKey(id, ctx.schoolId))) : [],
    ids.length ? repo.forScope(ctx).schoolRoles.listByIds(ids.map(id => schoolRoleKey(id, ctx.schoolId))) : [],
    ids.length ? repo.forScope(ctx).memberships.listByIds(ids.map(id => schoolMembershipKey(id, ctx))) : [],
  ]);
  // 账号按「这批成员」批量取：users 是平台级集合，list() 会把别校账号读进来，
  // 且随平台总用户数增长（2026-10-21 审查 P0-1）。
  const users = await repo.users.listByIds(userIds);
  // 学院名走 Map：原先是 colleges.find 放在循环里，O(成员数 × 学院数)
  // （2026-10-21 审查 P2-7，同函数其余三张表本来就用 Map）。
  const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
  const collegeName = id => collegeNameById.get(id) || '';
  const userById = new Map(users.map(user => [user._id, user]));
  const memberById = new Map(members.map(row => [row._id, row]));
  const roleById = new Map(roles.map(row => [row._id, row]));
  const membershipById = new Map(memberships.map(row => [row._id, row]));
  const seen = new Set();
  const out = [];
  const canSeeFullName = canManageAssociationSpace(ctx);
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const member = memberById.get(schoolMemberKey(userId, ctx.schoolId));
    const user = userById.get(userId) || {};
    out.push({
      userId,
      nickName: maskPublicNickName(user.nickName || '会员', user.realName, {
        canSeeFull: userId === ctx.actorId || canSeeFullName,
      }),
      collegeId: (member && member.collegeId) || '',
      collegeName: collegeName(member && member.collegeId),
      permissionLabel: permissionLabelOf(
        roleById.get(schoolRoleKey(userId, ctx.schoolId)),
        membershipById.get(schoolMembershipKey(userId, ctx)),
      ),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 读 */

async function listAssociationGroups(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, groups: [], canManage: false, nextCursor: '', hasMore: false,
      message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  const limit = Number.isInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, 99) : GROUP_LIST_LIMIT;
  const scoped = ctx.repo.forScope(ctx);
  const [pageResult, myRelations] = await Promise.all([
    scoped.associationGroups.listPage({
      canManage,
      cursor: typeof payload.cursor === 'string' ? payload.cursor : '',
      limit,
    }),
    scoped.associationGroupMembers.listByUser(ctx.actorId),
  ]);
  const mine = new Set((myRelations || [])
    .filter(row => row.userId === ctx.actorId && row.status === GROUP_MEMBER_STATUS.ACTIVE)
    .map(row => row.groupId));
  const rows = (pageResult.rows || []).filter(isGroupDoc);

  return ok({ ok: true, canManage, hasMore: Boolean(pageResult.hasMore), nextCursor: pageResult.nextCursor || '',
    groups: rows.map(group => ({ ...groupSummary(group, mine.has(group._id)),
      canReadRoster: !group.cleanupPending && (canManage || mine.has(group._id)) })), message: '' });
}

async function getAssociationGroup(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  const group = await ctx.repo.associationGroups.getById(payload.groupId);
  if (!isLiveGroupDoc(group, ctx)) return ok(refused('小组不存在'));

  // 名单只给组内成员与空间管理者看；普通非组员只看组基本信息。
  const relations = (await ctx.repo.forScope(ctx).associationGroupMembers.listByGroup(group._id))
    .filter(row => row.groupId === group._id);
  const joined = relations.some(row => row.userId === ctx.actorId && row.status === GROUP_MEMBER_STATUS.ACTIVE);
  const canManage = canManageAssociationSpace(ctx);
  const canReadRoster = canManage || joined;
  const members = canReadRoster
    ? await describeMembers(ctx.repo, ctx, relations.filter(row => row.status === GROUP_MEMBER_STATUS.ACTIVE).map(row => row.userId))
    : [];

  return ok({ ok: true, group: groupSummary(group, joined), members, canManage,
    canReadRoster, message: '' });
}

/* ------------------------------------------------------------------ 写 */

async function createAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const name = text(payload.name, MAX_NAME_LENGTH);
  if (!name.ok) return ok(refused(name.message));
  if (name.value.length < 2) return ok(refused('组名需 2～30 个字'));
  const description = text(payload.description, MAX_DESCRIPTION_LENGTH);
  if (!description.ok) return ok(refused(description.message));
  const ugc = await checkUgcContent({ name: name.value, description: description.value }, ctx);
  if (!ugc.ok) return ok(refused(ugc.message));
  const members = normalizeMemberIds(payload.memberIds);
  if (!members.ok) return ok(refused(members.message));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('创建请求编号无效'));

  const fingerprint = JSON.stringify([name.value, description.value, [...members.ids].sort()]);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以建立小组');
    const groupId = associationGroupKey(schoolKey('g', fresh.actorId, token), fresh);
    const existing = await tx.associationGroups.getById(groupId);
    // 同编号的旧组已被删除时不算「已存在」：请求编号由客户端生成、删除后表单仍在，
    // 用户再点一次创建是常事，此时要真的重建，而不是把一个删掉的组当幂等结果返回
    // （那会提示「已创建」但列表里什么都没有）。未删除的旧组仍按原来的幂等口径处理。
    const removedBefore = isGroupDoc(existing) && existing.status === GROUP_STATUS.DELETED;
    if (removedBefore && existing.cleanupPending) return refused('小组删除清理尚未完成，请先重试删除');
    if (isGroupDoc(existing) && !removedBefore) {
      return existing.fingerprint === fingerprint
        ? { ok: true, group: groupSummary(existing, members.ids.includes(fresh.actorId)), message: '' }
        : refused('请求编号已使用，请重新创建');
    }

    const eligible = await assertEligibleMembers(tx, fresh, members.ids);
    if (!eligible.ok) return refused(eligible.message);

    const claimId = associationGroupNameKey(name.value, fresh);
    const claim = await tx.associationGroups.getById(claimId);
    if (claim && claim.groupId && claim.groupId !== groupId) return refused('同范围已存在同名小组');

    const now = fresh.now;
    await tx.associationGroups.set(claimId, {
      _id: claimId, schoolId: fresh.schoolId, association: fresh.association,
      nameClaim: true, name: name.value, groupId, createdAt: now,
    });
    // 重建沿用同一主键时版本号接着旧文档往上走：审计键里带 revision
    // （schoolKey('agau', groupId, action, revision)），退回 1 会覆盖掉旧审计。
    const baseRevision = removedBefore ? Number(existing.revision || 1) : 0;
    const group = {
      _id: groupId, schoolId: fresh.schoolId, association: fresh.association,
      name: name.value, description: description.value, status: GROUP_STATUS.ACTIVE,
      memberCount: members.ids.length, membershipRevision: 1, revision: baseRevision + 1,
      fingerprint, createdBy: fresh.actorId, createdAt: now, updatedAt: now,
    };
    await tx.associationGroups.set(groupId, group);
    for (const userId of members.ids) {
      await tx.associationGroupMembers.set(associationGroupMemberKey(groupId, userId, fresh), {
        _id: associationGroupMemberKey(groupId, userId, fresh),
        schoolId: fresh.schoolId, association: fresh.association,
        groupId, userId, status: GROUP_MEMBER_STATUS.ACTIVE,
        joinedAt: now, addedBy: fresh.actorId,
      });
    }
    await tx.audit.append({ _id: auditKey(groupId, 'createAssociationGroup', group.revision),
      action: 'createAssociationGroup', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId, memberIds: members.ids, at: now });
    return { ok: true, group: groupSummary(group, members.ids.includes(fresh.actorId)), message: '' };
  });
  return ok(result);
}

async function updateAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  const name = text(payload.name, MAX_NAME_LENGTH);
  if (!name.ok) return ok(refused(name.message));
  if (name.value.length < 2) return ok(refused('组名需 2～30 个字'));
  const description = text(payload.description, MAX_DESCRIPTION_LENGTH);
  if (!description.ok) return ok(refused(description.message));
  const ugc = await checkUgcContent({ name: name.value, description: description.value }, ctx);
  if (!ugc.ok) return ok(refused(ugc.message));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新小组版本后重试'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以编辑小组');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, fresh)) return refused('小组不存在');
    if (group.status !== GROUP_STATUS.ACTIVE) return refused('小组已归档，不能再编辑');
    if (group.revision !== payload.expectedRevision) return refused('小组已修改，请刷新后重试');
    if (group.name === name.value && group.description === description.value) {
      return { ok: true, group: groupSummary(group, false), message: '' };
    }

    const now = fresh.now;
    if (group.name !== name.value) {
      const claimId = associationGroupNameKey(name.value, fresh);
      const claim = await tx.associationGroups.getById(claimId);
      if (claim && claim.groupId && claim.groupId !== group._id) return refused('同范围已存在同名小组');
      // 释放旧名占位（置空 groupId），取得新名占位；同一事务内完成，重命名不产生重名窗口。
      const oldClaimId = associationGroupNameKey(group.name, fresh);
      const oldClaim = await tx.associationGroups.getById(oldClaimId);
      if (oldClaim && oldClaim.groupId === group._id) {
        await tx.associationGroups.set(oldClaimId, { ...oldClaim, groupId: '', releasedAt: now });
      }
      await tx.associationGroups.set(claimId, {
        _id: claimId, schoolId: fresh.schoolId, association: fresh.association,
        nameClaim: true, name: name.value, groupId: group._id, createdAt: now,
      });
    }
    const next = { ...group, name: name.value, description: description.value,
      revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);
    await tx.audit.append({ _id: auditKey(group._id, 'updateAssociationGroup', next.revision),
      action: 'updateAssociationGroup', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, at: now });
    return { ok: true, group: groupSummary(next, false), message: '' };
  });
  return ok(result);
}

/** 批量选入成员：重复添加是幂等的，人数最多变一次 */
async function addAssociationGroupMembers(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  const members = normalizeMemberIds(payload.memberIds, MAX_MEMBERS_PER_ADD);
  if (!members.ok) return ok(refused(members.message));
  if (!members.ids.length) return ok(refused('请选择要加入的成员'));
  let added = 0, result;
  // 添加每人四次操作，20 人一批可留出身份、组版本和审计的固定开销。
  for (let offset = 0; offset < members.ids.length; offset += 20) {
    try { result = await addGroupMemberBatch(payload, ctx, members.ids.slice(offset, offset + 20)); }
    catch (error) { return ok(refused('已添加 ' + added + ' 人；添加未完成，请重试，已加入成员不会重复添加', { added, partial: added > 0 })); }
    if (!result.ok) return ok(refused('已添加 ' + added + ' 人；' + result.message, { added, partial: added > 0 }));
    added += result.added || 0;
  }
  return ok({ ...result, added });
}

async function addGroupMemberBatch(payload, ctx, ids) {
  return ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以添加成员');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, fresh)) return refused('小组不存在');
    if (group.status !== GROUP_STATUS.ACTIVE) return refused('小组已归档，不能再添加成员');
    const eligible = await assertEligibleMembers(tx, fresh, ids);
    if (!eligible.ok) return refused(eligible.message);

    const now = fresh.now;
    let added = 0;
    for (const userId of ids) {
      const key = associationGroupMemberKey(group._id, userId, fresh);
      const previous = await tx.associationGroupMembers.getById(key);
      if (previous && previous.status === GROUP_MEMBER_STATUS.ACTIVE) continue;
      await tx.associationGroupMembers.set(key, {
        _id: key, schoolId: fresh.schoolId, association: fresh.association,
        groupId: group._id, userId, status: GROUP_MEMBER_STATUS.ACTIVE,
        joinedAt: now, addedBy: fresh.actorId,
      });
      added += 1;
    }
    if (added === 0) return { ok: true, group: groupSummary(group, false), message: '' };
    const next = { ...group, memberCount: Number(group.memberCount || 0) + added,
      membershipRevision: Number(group.membershipRevision || 0) + 1,
      revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);
    await tx.audit.append({ _id: auditKey(group._id, 'addAssociationGroupMembers', next.revision),
      action: 'addAssociationGroupMembers', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, added, at: now });
    return { ok: true, added, group: groupSummary(next, false), message: '' };
  });
}

/** 管理移除成员：幂等，人数最多减一次 */
async function removeAssociationGroupMember(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以移除成员');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, fresh)) return refused('小组不存在');
    const key = associationGroupMemberKey(group._id, payload.userId, fresh);
    const previous = await tx.associationGroupMembers.getById(key);
    if (!previous || previous.status !== GROUP_MEMBER_STATUS.ACTIVE) {
      return { ok: true, group: groupSummary(group, false), message: '' };
    }
    const now = fresh.now;
    await tx.associationGroupMembers.set(key, { ...previous, status: GROUP_MEMBER_STATUS.REMOVED,
      removedAt: now, removedBy: fresh.actorId });
    const next = { ...group, memberCount: Math.max(0, Number(group.memberCount || 0) - 1),
      membershipRevision: Number(group.membershipRevision || 0) + 1,
      revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);
    await tx.audit.append({ _id: auditKey(group._id, 'removeAssociationGroupMember', next.revision),
      action: 'removeAssociationGroupMember', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, targetUserId: payload.userId, at: now });
    return { ok: true, group: groupSummary(next, false), message: '' };
  });
  return ok(result);
}

/**
 * 本人退出小组。userId 一律取当前登录身份，不能退别人；即使后来失去会员身份，
 * 只要账号可登录且关系属于本人也允许退出（但不因此获得读/报名/重新入组权）。
 */
async function leaveAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, ctx)) return refused('小组不存在');
    const key = associationGroupMemberKey(group._id, userId, ctx);
    const previous = await tx.associationGroupMembers.getById(key);
    if (!previous || previous.status !== GROUP_MEMBER_STATUS.ACTIVE) {
      return { ok: true, group: groupSummary(group, false), message: '' };
    }
    const now = ctx.now;
    await tx.associationGroupMembers.set(key, { ...previous, status: GROUP_MEMBER_STATUS.LEFT,
      leftAt: now, leftBy: userId });
    const next = { ...group, memberCount: Math.max(0, Number(group.memberCount || 0) - 1),
      membershipRevision: Number(group.membershipRevision || 0) + 1,
      revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);
    await tx.audit.append({ _id: auditKey(group._id, 'leaveAssociationGroup', next.revision),
      action: 'leaveAssociationGroup', schoolId: ctx.schoolId, association: ctx.association,
      actorId: userId, groupId: group._id, at: now });
    return { ok: true, group: groupSummary(next, false), message: '' };
  });
  return ok(result);
}

/** 归档小组：不可新选入活动、不可新增组员；保留关系，允许成员退出与管理者移除 */
async function archiveAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新小组版本后重试'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以归档小组');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, fresh)) return refused('小组不存在');
    if (group.status === GROUP_STATUS.ARCHIVED) return { ok: true, group: groupSummary(group, false), message: '' };
    if (group.revision !== payload.expectedRevision) return refused('小组已修改，请刷新后重试');
    const now = fresh.now;
    const next = { ...group, status: GROUP_STATUS.ARCHIVED, archivedAt: now, archivedBy: fresh.actorId,
      revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);
    await tx.audit.append({ _id: auditKey(group._id, 'archiveAssociationGroup', next.revision),
      action: 'archiveAssociationGroup', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, at: now });
    return { ok: true, group: groupSummary(next, false), message: '' };
  });
  return ok(result);
}

/** 先原子关闭小组并释放名称，再按组分页清理关系；失败后同一删除请求可继续。 */
async function deleteAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) return ok(refused('请刷新小组版本后重试'));
  const closed = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以删除小组');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isGroupDoc(group) || !belongsToSchoolScope(group, fresh)) return { ok: true, deleted: false };
    if (group.status === GROUP_STATUS.DELETED) return { ok: true, deleted: false, group };
    if (group.revision !== payload.expectedRevision) return refused('小组已修改，请刷新后重试');
    const now = fresh.now;
    const claimId = associationGroupNameKey(group.name, fresh);
    const claim = await tx.associationGroups.getById(claimId);
    const next = { ...group, status: GROUP_STATUS.DELETED, memberCount: 0, cleanupPending: true,
      deletedAt: now, deletedBy: fresh.actorId, revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(group._id, next);
    if (claim && claim.groupId === group._id) await tx.associationGroups.set(claimId, { ...claim, groupId: '', releasedAt: now });
    // 名单资格快照要能感知分批清理期间的删除；配置行已由 freshContext 点读。
    await tx.schoolAssociations.set(schoolAssociationKey(fresh), { ...fresh.schoolAssociation,
      groupDeletionRevision: Number(fresh.schoolAssociation.groupDeletionRevision || 0) + 1 });
    await tx.audit.append({ _id: auditKey(group._id, 'deleteAssociationGroup', next.revision),
      action: 'deleteAssociationGroup', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, memberCount: group.memberCount, at: now });
    return { ok: true, deleted: true, group: next };
  });
  if (!closed.ok) return ok(closed);
  const group = closed.group;
  if (!group || !group.cleanupPending) return ok({ ok: true, groupId: payload.groupId, deleted: closed.deleted, message: '' });
  try {
    let cursor = '';
    do {
      const page = await ctx.repo.forScope(ctx).associationGroupMembers.listGroupPage({ groupId: group._id, cursor });
      const rowsToClean = page.rows.length > 0 ? page.rows : [null];
      const job = await runVersionedBatchJob({
        items: rowsToClean,
        opsPerItem: 2,
        fixedOps: 9,
        maxOpsPerBatch: 60,
        runBatch: async ({ slice, isLast }) => {
          const rows = slice.filter(Boolean);
          const result = await ctx.repo.transaction(async tx => {
            const fresh = await freshContext(tx, ctx);
            if (!canManageAssociationSpace(fresh)) return refused('当前已无删除权限');
            const current = await tx.associationGroups.getById(group._id);
            if (!current || current.status !== GROUP_STATUS.DELETED || current.revision !== group.revision) return refused('小组状态已变化');
            const relations = [];
            for (const row of rows) {
              relations.push({ id: row._id, relation: await tx.associationGroupMembers.getById(row._id) });
            }
            for (const { id, relation } of relations) {
              if (relation && relation.status === GROUP_MEMBER_STATUS.ACTIVE) await tx.associationGroupMembers.set(id,
                { ...relation, status: GROUP_MEMBER_STATUS.REMOVED, removedAt: fresh.now, removedBy: fresh.actorId });
            }
            if (isLast && !page.hasMore) await tx.associationGroups.set(group._id, { ...current, cleanupPending: false });
            return { ok: true };
          });
          return result.ok ? { ok: true, written: rows.length } : { ok: false, stale: true, message: result.message };
        },
      });
      if (!job.ok) return ok(refused('小组已关闭；' + job.message + '，恢复权限后可重试删除以完成清理', { cleanupPending: true }));
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) { return ok(refused('小组已关闭，成员清理未完成，请重试删除', { cleanupPending: true })); }
  return ok({ ok: true, groupId: group._id, deleted: closed.deleted, message: '' });
}

module.exports = {
  GROUP_STATUS, GROUP_MEMBER_STATUS, MAX_MEMBERS_PER_WRITE,
  listAssociationGroups, getAssociationGroup, createAssociationGroup, updateAssociationGroup,
  addAssociationGroupMembers, removeAssociationGroupMember, leaveAssociationGroup,
  archiveAssociationGroup, deleteAssociationGroup,
};
