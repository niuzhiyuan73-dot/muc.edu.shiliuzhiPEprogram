/**
 * 学校维度：会员档案 / 名录（协议 2，M3-b）
 * ============================================================
 * 旧栈 `getMembers` / `getMember` 的学校维度对应物：一次取齐本校**在册会员**的
 * 展示档案，供赛事报名、比赛录入、学院赛名单等页面的选手选择器使用（即 M1-d
 * 页面改接所需的「会员档案」）。
 *
 * 【与协会空间名录的区别】
 * 协会空间的 `listAssociationMembers` 是「成员页签」的取数口：关键字搜索 + 游标
 * 分页，只给当前页补权限标签（默认 20 / 上限 50）。这里要的是旧栈 `getMembers`
 * 那种**一次取齐的平铺名单**，并附带 `gender`（性别项目报名、单打榜过滤都要用），
 * 默认保持平铺契约；新选人弹层传 `page:true` 时复用数据库目录的搜索与游标分页，
 * 只返回 userId / nickName / realName / avatarUrl / collegeId，不补权限标签。
 *
 * 【隐私口径】只下发 userId / nickName / realName / avatarUrl / gender /
 * collegeId / collegeName。学号、手机号、OpenID、平台角色一律不下发（与
 * getSchoolMembers / listAssociationMembers 一致）。
 *
 * 【读权限】与协会空间同一把锁（canReadAssociationSpace）：本协会有效会员或空间
 * 管理者（含平台管理员）。外校人不能靠名录把别校名单拉走。
 *
 * 【与会员审核的分工】会员审核（入会申请 → 通过 / 驳回）由
 * `school-membership-service` 的 `getSchoolApplications` / `reviewSchoolMembership`
 * 覆盖，本模块只负责审核通过后的**会员档案读取**。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { loadColleges } = require('./college-directory.js');
const { schoolMemberKey, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS } = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 会员档案一行的对外形状：隐私字段（学号 / 手机号 / OpenID / 平台角色）一律不下发。 */
function memberRow(user, member, collegeName) {
  return {
    userId: user._id,
    // 逐层兜底，绝不渲染出 undefined
    nickName: user.nickName || user.realName || user._id,
    realName: user.realName || '',
    avatarUrl: user.avatarUrl || '',
    gender: user.gender || '',
    collegeId: member.collegeId || '',
    collegeName: collegeName(member.collegeId),
  };
}

/** 一次按编号批读的上限：只服务「把这一页/这一场涉及的人换成姓名」，不是选人候选。 */
const MEMBER_IDS_MAX = 200;

/**
 * 本校在册会员名录。默认平铺；`page:true` 按关键词与游标取页；
 * `userIds` 只取这些人；`countOnly` 只回数字。
 *
 * 【为什么要有 userIds 模式】（2026-10-29 第十二轮审计）
 * 赛事详情、大场详情、实时计分、学院赛名单这些页面只做一件事：把手上那几十个
 * userId 换成姓名。它们原先调平铺模式，等于为了几十个人读全校名录 + 全部账号。
 * 批读模式只发 2~3 次 RPC（学籍 / 账号 / 学院目录缓存）。
 *
 * @param {Object} [payload] { collegeId?, page?, keyword?, cursor?, limit?, userIds?, countOnly? }
 * @param {Object} ctx
 */
async function listSchoolMembers(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, members: [], total: 0, message: '没有读取本协会成员名录的权限' });
  }
  const scoped = ctx.repo.forScope(ctx);
  const filterCollegeId = typeof payload.collegeId === 'string' && payload.collegeId ? payload.collegeId : '';
  // 【只数不取】（2026-10-29 第十一轮审计 P2-3/P2-9）
  // 首页概况只要一个「本校会员数」，原先也走平铺分支：读完全部学籍 + 批读全部账号
  // 再返回 N 行 JSON，只为 `members.length`。这里换成同一套过滤的聚合计数，
  // 一次 RPC 返回数字，口径与分页/平铺逐字一致（都走目录过滤）。
  if (payload.countOnly === true) {
    const total = await scoped.schoolMembers.countDirectory({ collegeId: filterCollegeId,
      keyword: payload.keyword });
    return ok({ ok: true, members: [], total: Number(total) || 0, message: '' });
  }
  // 按编号批读：只取这几个人（页面已经有名单，只是缺姓名）
  if (Array.isArray(payload.userIds) && payload.userIds.length > 0) {
    const ids = [...new Set(payload.userIds
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim()))];
    if (ids.length > MEMBER_IDS_MAX) {
      return ok({ ok: false, members: [], total: 0,
        message: `一次最多读取 ${MEMBER_IDS_MAX} 名会员` });
    }
    const [rows, users, colleges] = await Promise.all([
      scoped.schoolMembers.listByIds(ids.map(id => schoolMemberKey(id, ctx.schoolId))),
      ctx.repo.users.listByIds(ids),
      loadColleges(ctx),
    ]);
    const userById = new Map(users.map(user => [user._id, user]));
    const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
    const members = [];
    for (const row of rows) {
      if (!row || row.status !== SCHOOL_MEMBER_STATUS.ACTIVE) continue;
      if (filterCollegeId && row.collegeId !== filterCollegeId) continue;
      const user = userById.get(row.userId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) continue;
      members.push(memberRow(user, row, id => nameByCollegeId.get(id) || ''));
    }
    members.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return ok({ ok: true, members, total: members.length, message: '' });
  }
  // 选人弹层按需取页；保留旧调用方的平铺返回契约。
  if (payload.page === true) {
    const page = await scoped.schoolMembers.listDirectoryPage({ collegeId: filterCollegeId,
      keyword: payload.keyword, cursor: payload.cursor,
      limit: Number.isInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, 50) : 20 });
    return ok({ ok: true, ...page, message: '' });
  }
  const rows = [];
  let afterId = '';
  do {
    const page = await scoped.schoolMembers.listByStatus(SCHOOL_MEMBER_STATUS.ACTIVE,
      { collegeId: filterCollegeId, afterId, limit: 200 });
    rows.push(...page.rows);
    afterId = page.hasMore && page.rows.length ? page.rows[page.rows.length - 1]._id : '';
  } while (afterId);
  const colleges = await loadColleges(ctx);
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  const collegeName = id => nameByCollegeId.get(id) || '';

  // 名录要按 userId 补昵称 / 头像。**按这批会员的编号批量取**，而不是
  // 「读全平台 users 再建索引」：users 是平台级集合（不带 schoolId），list()
  // 会把别校账号也读进来，读量随平台总用户数增长。本校 200 人只需 2 次 RPC。
  // （2026-10-21 审查 P0-1；此前这里写的是「一次取齐本校账号」，与实际不符。）
  const userById = new Map(
    (await ctx.repo.users.listByIds(rows.map(row => row.userId))).map(user => [user._id, user]),
  );

  const members = [];
  for (const row of rows) {
    if (row.status !== SCHOOL_MEMBER_STATUS.ACTIVE) continue;
    if (filterCollegeId && row.collegeId !== filterCollegeId) continue;
    const user = userById.get(row.userId);
    // 平台停用账号、或已归属别校的用户不进本校本册。
    if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) continue;
    members.push(memberRow(user, row, collegeName));
  }
  // 按编号稳定排序；调用方要按学院/姓名排再自排即可。
  members.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return ok({ ok: true, members, total: members.length, message: '' });
}

/**
 * 单个会员档案。仅供名录读权限持有者查看。
 * @param {Object} payload { userId }
 * @param {Object} ctx
 */
async function getSchoolMember(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成员名录的权限'));
  const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
  if (!userId) return ok(refused('缺少会员编号'));
  // 长度先在这里挡：userId 会拼进 `schoolMembers` 的 _id（schoolKey），超过上限时
  // schoolKey 会抛「记录键字段过长」，被入口兜成「服务异常」——一次脏请求就是一条
  // 错误日志 + 一句用户看不懂的提示（2026-10-28 审计 2 B-3）。账号编号本身远短于 128。
  if (userId.length > 128) return ok(refused('会员编号格式不正确'));

  const [member, user] = await Promise.all([
    ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)),
    ctx.repo.users.getById(userId),
  ]);
  if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) return ok(refused('找不到这位会员'));
  if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) {
    return ok(refused('找不到这位会员'));
  }
  const colleges = await loadColleges(ctx);
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  return ok({ ok: true, member: memberRow(user, member, id => nameByCollegeId.get(id) || ''), message: '' });
}

module.exports = { listSchoolMembers, getSchoolMember };
