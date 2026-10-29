/**
 * 运动会上下文（B3）
 * ============================================================
 * 与 `buildSchoolContext` 并列，但**不带协会**。
 *
 * 【为什么不复用学校上下文】
 * `buildSchoolContext` 会强制要求「该校已启用该协会」并解析 memberships。
 * 运动会是学校级栏目，若借道协会：
 *   · 停用匹克球协会会让运动会整体不可用；
 *   · 权限判断会落到 memberships.role 上，等于把「协会负责人」当成「学院报名负责人」，
 *     而交接文档 §7.2 明确说这是最容易出错的地方（manageCollege 过宽）。
 * 所以这里只解析四样东西：学校、账号、学籍、校级角色。协会与 membership 一概不读，
 * 结构上就不可能把运动会挂到某个协会上。
 *
 * 【meetId 为什么可选】
 * 学院部长授权是常设角色（一院一条，跨届有效），授权动作没有「本届」可言；
 * 而报名、排程、录分必须有届。所以 meetId 允许缺省，由各动作自己要求：
 * 需要届的动作在入口检查 `ctx.meetId`，不需要的不检查。
 * ============================================================
 */

const { schoolMemberKey, schoolRoleKey } = require('../utils/school.js');
const contextCache = require('./context-cache.js');

/**
 * 组装运动会上下文。
 *
 * @param {Object} options
 * @param {Object} options.repo 仓储（可以是事务仓储）
 * @param {string} [options.openId] 网络入口只传 OPENID
 * @param {string} [options.actorId] 仅限已认证的内部事务重读
 * @param {{schoolId:string, meetId?:string}} options.scope
 * @param {Date} [options.now]
 * @param {string} [options.action] 只有读动作才允许走缓存（见 context-cache）
 */
async function buildMeetContext({
  repo, openId = '', actorId = '', scope, now = new Date(), action = '',
}) {
  const schoolId = String((scope && scope.schoolId) || '').trim();
  const meetId = String((scope && scope.meetId) || '').trim();
  if (!schoolId) throw new Error('运动会接口缺少学校');

  // 与学校上下文同一套缓存规则（2026-10-23 H-10）：运动会也要读学校、账号、
  // 名册、校级角色、届次——一个页面连发几个请求就是几十次重复读。
  // key 加 `meet|` 前缀，避免与同期同校的协会上下文串味。
  const cacheable = contextCache.isReadAction(action);
  const cacheKey = cacheable
    ? `meet|${contextCache.keyOf({ schoolId, association: meetId }, openId, actorId)}`
    : '';
  // 记下「这次读是几点开始的」，供 set 判断期间是否发生过失效（见 context-cache.js）。
  let readStartedAt = 0;
  if (cacheable) {
    const cached = contextCache.get(cacheKey);
    if (cached) return Object.freeze({ repo, schoolId, meetId, now, ...cached });
    readStartedAt = Date.now();
  }

  const [school, actor] = await Promise.all([
    repo.schools.getById(schoolId),
    actorId ? repo.users.getById(actorId) : openId ? repo.users.getByOpenId(openId) : null,
  ]);
  if (!school || school.schoolId !== schoolId || school.status !== 'active') {
    // 与 school-context 同一口径：带 code，由入口转成业务拒绝（第十一轮 P2-6）
    const err = new Error('学校不存在或已停用');
    err.code = 'SCHOOL_INACTIVE';
    throw err;
  }

  const [member, role, meet] = actor
    ? await Promise.all([
      repo.schoolMembers.getById(schoolMemberKey(actor._id, schoolId)),
      repo.schoolRoles.getById(schoolRoleKey(actor._id, schoolId)),
      meetId ? repo.sportsMeets.getById(meetId) : null,
    ])
    : [null, null, meetId ? repo.sportsMeets.getById(meetId) : null];

  const owned = (doc) => (doc && doc.schoolId === schoolId && doc.userId === actor._id ? doc : null);
  const docs = {
    actor,
    openId: openId || (actor && actor.openId) || '',
    actorId: actor ? actor._id : '',
    school,
    schoolMember: owned(member),
    schoolRole: owned(role),
    // 不属于本届或不属于本校的记录一律当「不存在」，不让越界数据进入上下文。
    meet: meet && meet.schoolId === schoolId ? meet : null,
  };
  if (cacheable) contextCache.set(cacheKey, docs, readStartedAt);
  return Object.freeze({ repo, schoolId, meetId, now, ...docs });
}

/** 事务内重读上下文：权限必须在写入的同一事务里再判一次。 */
function freshMeetContext(tx, ctx) {
  return buildMeetContext({
    repo: tx,
    actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId, meetId: ctx.meetId },
    now: ctx.now,
  });
}

module.exports = { buildMeetContext, freshMeetContext };
