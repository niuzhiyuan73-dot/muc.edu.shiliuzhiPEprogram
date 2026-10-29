/** 已迁移的学校业务使用的上下文；旧单校业务保持独立入口。 */
const {
  schoolScope, schoolAssociationKey, schoolMemberKey, schoolRoleKey, schoolMembershipKey,
} = require('../utils/school.js');
const contextCache = require('./context-cache.js');

/**
 * actorId 仅供已认证的内部事务重读使用，网络入口只能传微信 OPENID。
 *
 * 【action 参数为什么存在】（2026-10-23 H-10）
 * 只有「读动作」的上下文才允许走 5 秒缓存，而决定这件事的只有调用方知道
 * （`handleSchoolRequest` 手上的 `event.action`）。**不传 action 一律不缓存**——
 * 事务内的 `freshContext`、测试、模拟端因此天然拿不到陈旧数据。
 *
 * 缓存存的是 6 份文档（学校 / 协会 / 账号 / 名册 / 校级角色 / 协会身份），
 * `now` 不缓存：时间判定每次都要新鲜。
 */
async function buildSchoolContext({
  repo, openId = '', actorId = '', scope, now = new Date(), action = '',
}) {
  const target = schoolScope(scope);
  const cacheable = contextCache.isReadAction(action);
  const cacheKey = cacheable ? contextCache.keyOf(target, openId, actorId) : '';
  // 记下「这次读是几点开始的」：buildSchoolContext 要跨 3~5 次读库，期间若有写请求
  // 做了失效，这份结果是失效前的快照，不能写回缓存（见 context-cache.js 的 set）。
  let readStartedAt = 0;
  if (cacheable) {
    const cached = contextCache.get(cacheKey);
    if (cached) return Object.freeze({ repo, ...target, now, ...cached });
    readStartedAt = Date.now();
  }
  const [school, schoolAssociation, actor] = await Promise.all([
    repo.schools.getById(target.schoolId),
    repo.schoolAssociations.getById(schoolAssociationKey(target)),
    actorId ? repo.users.getById(actorId) : openId ? repo.users.getByOpenId(openId) : null,
  ]);
  // 【业务状态要带 code，别当基础设施故障】（2026-10-29 第十一轮审计 P2-6）
  // 这两句 throw 发生在处理器之前，入口只把它兜成「服务异常，请稍后再试」，
  // 而模拟端页面拿到的是原文案——同一个失败两种说法，且「没启用协会」这种
  // 配置问题被伪装成故障。带 code 之后入口按业务拒绝返回（见 school-request）。
  if (!school || school.schoolId !== target.schoolId || school.status !== 'active') {
    const err = new Error('学校不存在或已停用');
    err.code = 'SCHOOL_INACTIVE';
    throw err;
  }
  if (!schoolAssociation || schoolAssociation.schoolId !== target.schoolId ||
      schoolAssociation.association !== target.association || schoolAssociation.status !== 'active') {
    const err = new Error('该校尚未启用此协会');
    err.code = 'ASSOCIATION_DISABLED';
    throw err;
  }
  const [member, role, membership] = actor ? await Promise.all([
    repo.schoolMembers.getById(schoolMemberKey(actor._id, target.schoolId)),
    repo.schoolRoles.getById(schoolRoleKey(actor._id, target.schoolId)),
    repo.memberships.get(schoolMembershipKey(actor._id, target)),
  ]) : [null, null, null];
  const owned = (doc) => doc && doc.schoolId === target.schoolId && doc.userId === actor._id ? doc : null;
  // openId 供注册平台账号（M3-d）取用：尚无账号时只能凭微信身份开户，actorId 还不存在。
  // 云端按 OpenID 解析 actor；模拟端按 actorId 解析，回填该账号的 openId 以对齐语义。
  const resolvedOpenId = openId || (actor && actor.openId) || '';
  const docs = { actor, openId: resolvedOpenId, actorId: actor ? actor._id : '',
    school, schoolAssociation, schoolMember: owned(member), schoolRole: owned(role),
    membership: owned(membership) && membership.association === target.association ? membership : null };
  if (cacheable) contextCache.set(cacheKey, docs, readStartedAt);
  return Object.freeze({ repo, ...target, now, ...docs });
}

module.exports = { buildSchoolContext };
