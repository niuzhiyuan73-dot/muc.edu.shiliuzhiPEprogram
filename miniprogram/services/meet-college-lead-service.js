/**
 * 学院部长授权（B3）
 * ============================================================
 * 「学院部长」是运动会专用、学校级、一院一名的常设角色（D11／D12）。
 *
 * 【为什么不是改 membership.role】
 * 现有「学院负责人」= memberships.role === 'staff' 且带 collegeId，本质是**协会内**的
 * 身份。运动会不挂协会，若沿用：
 *   · 一个学院在本校三个协会各有一份 staff 记录，谁算负责人说不清；
 *   · 停用某协会会把人一起停掉；
 *   · 协会负责人（leader）按 manageCollege 口径天然能「管理学院」，等于绕过 R11。
 * 所以独立一份授权关系，主键是「学校 + 学院」，由存储层直接保证一院一条。
 *
 * 【一院一名怎么保证】
 * 不靠「先查有没有、再插入」——两个管理员同时任命会双成功。主键 `mtl:<学校>:<学院>`
 * 让第二次写入落在同一条文档上，读到的 active 记录必然只有一个 userId。
 * 换人必须先撤销：这比「静默覆盖」安全，也符合 D12 的确定性。
 *
 * 【撤权立即生效】
 * 每个写动作都在事务内重读授权记录（freshMeetContext + 点读 lead），不做缓存。
 * 撤销保留记录（status=revoked），不物理删除，便于事后解释「谁在任过」。
 * 注意：按 B3 的裁决，本模块**不写操作审计**（用户明确不要留痕），只保留授权记录本身。
 * ============================================================
 */

const { collegeKey, schoolMemberKey, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const {
  meetCollegeLeadKey, MEET_COLLEGE_LEAD_STATUS,
} = require('../utils/meet-scope.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { canManageMeet, isActiveMeetLead } = require('./meet-permission.js');
const { compareCode } = require('../utils/text-order.js');

// DTO 补 ok:true，与其余三域同形（见 meet-service.js 的说明）。
const ok = (data) => ({ ok: true, data: { ...data, ok: data.ok === undefined ? true : data.ok } });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const MAX_ID_LENGTH = 40;

/** 学院编号 / 用户编号：非空字符串，限制长度，不接受对象。 */
function idOf(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, message: `请填写${label}` };
  if (text.length > MAX_ID_LENGTH) return { ok: false, message: `${label}过长` };
  if (text.includes(':')) return { ok: false, message: `${label}格式不正确` };
  return { ok: true, value: text };
}

/** 对外只给必要字段：不把整条授权记录（含任命人）抛给页面。 */
function summaryOf(doc) {
  return {
    collegeId: doc.collegeId,
    userId: doc.userId,
    status: doc.status,
    grantedAt: doc.grantedAt || '',
    updatedAt: doc.updatedAt || '',
  };
}

/**
 * 任命学院部长。校级管理员及以上，仅本校；平台管理员可跨校（R03）。
 *
 * @param {{collegeId?:string,userId?:string}} payload
 * @param {Object} ctx 运动会上下文
 */
async function grantMeetCollegeLead(payload = {}, ctx) {
  if (!ctx.actorId) return refused('请先登录');
  const college = idOf(payload.collegeId, '学院');
  if (!college.ok) return refused(college.message);
  const user = idOf(payload.userId, '成员');
  if (!user.ok) return refused(user.message);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以任命学院部长');

    const collegeDoc = await tx.colleges.getById(collegeKey(fresh.schoolId, college.value));
    if (!collegeDoc || collegeDoc.schoolId !== fresh.schoolId || collegeDoc.status !== 'active') {
      return refused('学院不存在或已停用');
    }

    const member = await tx.schoolMembers.getById(schoolMemberKey(user.value, fresh.schoolId));
    if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE || member.collegeId !== college.value) {
      return refused('该成员不是本学院在册会员，请先完善其学院归属');
    }

    const key = meetCollegeLeadKey(fresh.schoolId, college.value);
    const current = await tx.sportsMeetCollegeLeads.getById(key);
    if (isActiveMeetLead(current)) {
      // 同一人重复任命是幂等的：管理员连点两次不该报错。
      if (current.userId === user.value) {
        return ok({ lead: summaryOf(current), created: false, message: '' });
      }
      return refused('该学院已有学院部长，请先撤销原任命');
    }

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      collegeId: college.value,
      userId: user.value,
      status: MEET_COLLEGE_LEAD_STATUS.ACTIVE,
      grantedBy: fresh.actorId,
      grantedAt: now,
      updatedAt: now,
      revokedBy: '',
      revokedAt: '',
      // 授权口径版本：将来若权限含义变化，可据此判断旧记录是否仍然适用。
      ruleVersion: 'meet-lead-v1',
    };
    await tx.sportsMeetCollegeLeads.set(key, doc);
    return ok({ lead: summaryOf(doc), created: true, message: '' });
  });
}

/** 撤销学院部长。撤销后旧部长立即失去写权限，已提交名单不删除（D28）。 */
async function revokeMeetCollegeLead(payload = {}, ctx) {
  if (!ctx.actorId) return refused('请先登录');
  const college = idOf(payload.collegeId, '学院');
  if (!college.ok) return refused(college.message);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以撤销学院部长');

    const key = meetCollegeLeadKey(fresh.schoolId, college.value);
    const current = await tx.sportsMeetCollegeLeads.getById(key);
    if (!current || current.schoolId !== fresh.schoolId) return refused('该学院没有任职记录');
    if (!isActiveMeetLead(current)) return refused('该学院当前没有在任的学院部长');

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const next = {
      ...current,
      status: MEET_COLLEGE_LEAD_STATUS.REVOKED,
      revokedBy: fresh.actorId,
      revokedAt: now,
      updatedAt: now,
    };
    await tx.sportsMeetCollegeLeads.set(key, next);
    return ok({ lead: summaryOf(next), message: '' });
  });
}

/** 本校全部学院部长（管理端用），附带学院名；只读、分页由页面负责。 */
async function listMeetCollegeLeads(payload = {}, ctx) {
  const fresh = await buildMeetContext({
    repo: ctx.repo, actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId, meetId: ctx.meetId }, now: ctx.now,
  });
  if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以查看学院部长名单');

  const [leads, colleges] = await Promise.all([
    ctx.repo.sportsMeetCollegeLeads.listBySchool(fresh.schoolId),
    ctx.repo.colleges.listBySchool(fresh.schoolId),
  ]);
  const nameOf = new Map(colleges.map((doc) => [doc.collegeId, doc.name]));
  const active = leads.filter((doc) => doc.schoolId === fresh.schoolId && isActiveMeetLead(doc));
  // 姓名一并给出：页面上只显示 userId 时，管理员根本看不出这位部长是谁
  const personName = new Map();
  for (const doc of active) {
    const user = await ctx.repo.users.getById(doc.userId);
    personName.set(doc.userId, (user && (user.realName || user.nickName)) || doc.userId);
  }
  const items = active
    .map((doc) => ({
      ...summaryOf(doc),
      name: personName.get(doc.userId) || doc.userId,
      collegeName: nameOf.get(doc.collegeId) || doc.collegeId,
    }))
    .sort((a, b) => compareCode(a.collegeId, b.collegeId));
  return ok({ items, message: '' });
}

/**
 * 我当前是不是某个学院的学院部长（页面首屏用）。
 * 返回 collegeId 与 collegeName；不是部长时 collegeId 为空串，不当作错误。
 */
async function getMyMeetCollegeLead(payload = {}, ctx) {
  if (!ctx.actorId) return ok({ collegeId: '', collegeName: '', message: '' });
  const fresh = await buildMeetContext({
    repo: ctx.repo, actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId, meetId: ctx.meetId }, now: ctx.now,
  });
  const [leads, colleges] = await Promise.all([
    ctx.repo.sportsMeetCollegeLeads.listBySchool(fresh.schoolId),
    ctx.repo.colleges.listBySchool(fresh.schoolId),
  ]);
  const mine = leads.find((doc) => doc.schoolId === fresh.schoolId
    && isActiveMeetLead(doc) && doc.userId === fresh.actorId);
  if (!mine) return ok({ collegeId: '', collegeName: '', message: '' });

  const college = colleges.find((doc) => doc.collegeId === mine.collegeId);
  return ok({
    collegeId: mine.collegeId,
    collegeName: college ? college.name : mine.collegeId,
    message: '',
  });
}

module.exports = {
  grantMeetCollegeLead,
  revokeMeetCollegeLead,
  listMeetCollegeLeads,
  getMyMeetCollegeLead,
};
