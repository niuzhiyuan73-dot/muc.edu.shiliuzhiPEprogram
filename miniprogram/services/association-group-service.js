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
const { loadColleges } = require('./college-directory.js');
const { canReadAssociationSpace, canManageAssociationSpace } = require('./association-space-permission.js');
const { permissionLabelOf } = require('./school-permission.js');
const {
  schoolKey, schoolMemberKey, schoolRoleKey, schoolMembershipKey, belongsToSchoolScope,
  associationGroupKey, associationGroupMemberKey, associationGroupNameKey,
  SCHOOL_MEMBER_STATUS, PLATFORM_STATUS,
} = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/**
 * 单次创建/批量添加的成员上限。更多成员分批添加，不静默截断。
 *
 * 【为什么是 30，不是 50】（2026-10-21 云端容量对齐）
 * 建小组 / 批量加人都在**一个事务**里跑，每名成员约 3 次操作（1 写 + 2 读）。
 * 云开发事务总操作数上限约 100（见 cloud-repo.js 的 TX_OPERATION_BUDGET），
 * 50 人就是约 150 次——超出上限，本地内存仓储无此约束所以一直没暴露。
 * 30 人约 90 次，留出余量；要更多人就分几批加。
 */
const MAX_MEMBERS_PER_WRITE = 30;
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

function normalizeMemberIds(input) {
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
  if (ids.length > MAX_MEMBERS_PER_WRITE) return { ok: false, message: `单次最多添加 ${MAX_MEMBERS_PER_WRITE} 名成员` };
  return { ok: true, ids };
}

/**
 * 校验一组 userId 都是**本校本协会在册且合格**的会员。任何一个不合格即整体失败，
 * 不悄悄删人。
 * @returns {{ok:boolean, message:string}}
 */
async function assertEligibleMembers(tx, ctx, userIds) {
  for (const userId of userIds) {
    const [member, user] = await Promise.all([
      tx.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)),
      tx.users.getById(userId),
    ]);
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
    status: group.status, memberCount: Number(group.memberCount || 0),
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
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const member = memberById.get(schoolMemberKey(userId, ctx.schoolId));
    out.push({
      userId,
      nickName: (userById.get(userId) || {}).nickName || '会员',
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
  // 已删除的组不再出现：删掉一个组之后列表必须立刻少一条，否则用户看到的
  // 仍然是一个点不开、改不动、也删不掉的幽灵卡片。
  const rows = (await ctx.repo.forScope(ctx).associationGroups.list())
    .filter(row => isGroupDoc(row) && row.status !== GROUP_STATUS.DELETED);
  const mine = new Set((await ctx.repo.forScope(ctx).associationGroupMembers.list())
    .filter(row => row.userId === ctx.actorId && row.status === GROUP_MEMBER_STATUS.ACTIVE)
    .map(row => row.groupId));

  const sorted = rows.slice().sort((a, b) =>
    ((a.createdAt || '') < (b.createdAt || '') ? -1 : (a.createdAt || '') > (b.createdAt || '') ? 1 : 0)
    || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const after = typeof payload.cursor === 'string' ? payload.cursor : '';
  let start = 0;
  if (after) {
    const [createdAt, id] = after.split('|').map(decodeURIComponent);
    start = sorted.findIndex(row => String(row.createdAt || '') > createdAt ||
      (String(row.createdAt || '') === createdAt && row._id > id));
    if (start < 0) start = sorted.length;
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, 100) : GROUP_LIST_LIMIT;
  const page = sorted.slice(start, start + limit);
  const hasMore = sorted.length > start + limit;
  const nextCursor = hasMore && page.length
    ? [encodeURIComponent(String(page[page.length - 1].createdAt || '')), encodeURIComponent(page[page.length - 1]._id)].join('|')
    : '';

  return ok({ ok: true, canManage, hasMore, nextCursor,
    groups: page.map(group => ({ ...groupSummary(group, mine.has(group._id)),
      canReadRoster: canManage || mine.has(group._id) })), message: '' });
}

async function getAssociationGroup(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  const group = await ctx.repo.associationGroups.getById(payload.groupId);
  if (!isLiveGroupDoc(group, ctx)) return ok(refused('小组不存在'));

  // 名单只给组内成员与空间管理者看；普通非组员只看组基本信息。
  const relations = (await ctx.repo.forScope(ctx).associationGroupMembers.list())
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
  const members = normalizeMemberIds(payload.memberIds);
  if (!members.ok) return ok(refused(members.message));
  if (members.ids.length === 0) return ok(refused('请选择要加入的成员'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以添加成员');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isLiveGroupDoc(group, fresh)) return refused('小组不存在');
    if (group.status !== GROUP_STATUS.ACTIVE) return refused('小组已归档，不能再添加成员');
    const eligible = await assertEligibleMembers(tx, fresh, members.ids);
    if (!eligible.ok) return refused(eligible.message);

    const now = fresh.now;
    let added = 0;
    for (const userId of members.ids) {
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
    return { ok: true, group: groupSummary(next, false), message: '' };
  });
  return ok(result);
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

/**
 * 删除整个小组（软删除）。用户报的就是这个缺口：把成员全部移出之后小组仍然挂在
 * 列表上，没有任何入口能把组本身去掉。
 *
 * 【为什么是软删除而不是物理删除】
 *   本仓储 forScope 只有 list/getById/set/insert/update，没有 remove；而且历史活动、
 *   训练报名与审计都按 groupId 指向这个组，物理删掉只会留下一堆悬空引用。因此与项目
 *   其余部分同一口径：状态 + 审计留痕，文档保留。
 *
 * 【删掉一个组要动三处】
 *   1. 组文档：status='deleted' + deletedAt/deletedBy，版本号 +1（乐观锁口径与
 *      update / archive 一致，expectedRevision 不符说明有人改过，要求刷新后重试）；
 *   2. 组内成员关系：全部 ACTIVE → REMOVED。删组之后这些关系不再表示「在组里」，
 *      训练 / 赛事的限组报名资格也随之失效（它们只认 ACTIVE 关系）；
 *   3. 组名占位：把 nameClaim 文档的 groupId 置空 + releasedAt，让同名小组可以重建；
 *      不释放的话用户会撞上「同范围已存在同名小组」，而那个组早就看不见了。
 *
 * 【幂等】
 *   小组不存在 / 不属于本范围 / 已被删除，一律返回 ok（deleted:false）而不是报错：
 *   目标态就是「没有这个组」，重复点击、超时重试、并发第二次删除都不该看到失败。
 *   代价是调用方分不清「刚删掉」和「本来就没有」，故返回值用 deleted 标记本次是否
 *   真的改了数据。归档的小组同样允许删除——用户正是删不掉才来报的。
 *
 * 【并发】
 *   仓储约定事务内不能列出集合，成员关系清单只能在事务外先读。这里靠 expectedRevision
 *   兜底：任何成员增减都会推进 revision（见 add / remove / leave），所以「读完清单之后
 *   有人被加进来」必然在事务内因版本不符被拒，不会留下一条属于已删除小组的 ACTIVE 关系。
 */
async function deleteAssociationGroup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.groupId !== 'string' || !payload.groupId) return ok(refused('缺少小组编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新小组版本后重试'));
  }

  const relations = await ctx.repo.forScope(ctx).associationGroupMembers.list();

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以删除小组');
    const group = await tx.associationGroups.getById(payload.groupId);
    if (!isGroupDoc(group) || !belongsToSchoolScope(group, fresh)) {
      return { ok: true, groupId: payload.groupId, deleted: false, message: '' };
    }
    if (group.status === GROUP_STATUS.DELETED) {
      return { ok: true, groupId: group._id, deleted: false, message: '' };
    }
    if (group.revision !== payload.expectedRevision) return refused('小组已修改，请刷新后重试');

    const now = fresh.now;
    const removedMemberIds = [];
    for (const relation of relations) {
      if (relation.groupId !== group._id || relation.status !== GROUP_MEMBER_STATUS.ACTIVE) continue;
      const key = associationGroupMemberKey(group._id, relation.userId, fresh);
      // 事务内重读：清单是事务外读的，期间状态可能已变，只翻仍然是 ACTIVE 的那些。
      const current = await tx.associationGroupMembers.getById(key);
      if (!current || current.status !== GROUP_MEMBER_STATUS.ACTIVE) continue;
      await tx.associationGroupMembers.set(key, { ...current, status: GROUP_MEMBER_STATUS.REMOVED,
        removedAt: now, removedBy: fresh.actorId });
      removedMemberIds.push(relation.userId);
    }

    const next = { ...group, status: GROUP_STATUS.DELETED, memberCount: 0,
      deletedAt: now, deletedBy: fresh.actorId, revision: group.revision + 1, updatedAt: now };
    await tx.associationGroups.set(next._id, next);

    const claimId = associationGroupNameKey(group.name, fresh);
    const claim = await tx.associationGroups.getById(claimId);
    if (claim && claim.groupId === group._id) {
      await tx.associationGroups.set(claimId, { ...claim, groupId: '', releasedAt: now });
    }

    await tx.audit.append({ _id: auditKey(group._id, 'deleteAssociationGroup', next.revision),
      action: 'deleteAssociationGroup', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, groupId: group._id, removedMemberIds, at: now });
    return { ok: true, groupId: group._id, deleted: true, message: '' };
  });
  return ok(result);
}

module.exports = {
  GROUP_STATUS, GROUP_MEMBER_STATUS, MAX_MEMBERS_PER_WRITE,
  listAssociationGroups, getAssociationGroup, createAssociationGroup, updateAssociationGroup,
  addAssociationGroupMembers, removeAssociationGroupMember, leaveAssociationGroup,
  archiveAssociationGroup, deleteAssociationGroup,
};
