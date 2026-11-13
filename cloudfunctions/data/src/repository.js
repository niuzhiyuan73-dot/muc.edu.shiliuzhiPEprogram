/**
 * 仓储接口约定
 * ============================================================
 * 业务逻辑（src/core/*）只认识这个接口，不认识微信云数据库。好处有二：
 *   1. 单元测试可以塞一个内存实现进去，不需要云环境、不需要凭据；
 *   2. 将来换数据库（云开发 → 自建）只改 adapters/ 一个文件。
 *
 * 【接口形状】
 *   repo.users.list()                   → Promise<Array<Object>>
 *   repo.users.getById(id)              → Promise<Object|null>
 *   repo.users.getByOpenId(openId)      → Promise<Object|null>
 *   repo.users.set(id, doc)             → Promise<void>   按 _id 整体写入（upsert）
 *   repo.matches.list()                 → Promise<Array<Object>>
 *   repo.matches.listByEvent(eid)       → Promise<Array<Object>>
 *   repo.matches.getById(id)            → Promise<Object|null>
 *   repo.matches.insert(doc)            → Promise<Object>  doc 必须自带 _id
 *   repo.matches.update(id, patch)      → Promise<void>    只改给定字段
 *   repo.events.list()                  → Promise<Array<Object>>
 *   repo.events.getById(id)             → Promise<Object|null>
 *   repo.events.insert(doc)             → Promise<Object>  doc 必须自带 _id
 *   repo.events.update(id, patch)       → Promise<void>    只改给定字段
 *   repo.eventSignups.list()            → Promise<Array<Object>>
 *   repo.eventSignups.listByEvent(eid)  → Promise<Array<Object>>
 *   repo.eventSignups.getById(id)       → Promise<Object|null>
 *   repo.eventSignups.insert(doc)       → Promise<Object>
 *   repo.eventSignups.update(id, patch) → Promise<void>
 *   repo.collegeEvents.list()           → Promise<Array<Object>>
 *   repo.collegeEvents.getById(id)      → Promise<Object|null>
 *   repo.collegeEvents.insert(doc)      → Promise<Object>  doc 必须自带 _id
 *   repo.collegeEvents.update(id, patch)→ Promise<void>
 *   repo.collegeEntries.list()          → Promise<Array<Object>>
 *   repo.collegeEntries.listByEvent(eid)→ Promise<Array<Object>>
 *   repo.collegeEntries.getById(id)     → Promise<Object|null>
 *   repo.collegeEntries.insert(doc)     → Promise<Object>
 *   repo.collegeEntries.update(id, patch)→ Promise<void>
 *   repo.ties.list()                    → Promise<Array<Object>>
 *   repo.ties.listByEvent(eid)          → Promise<Array<Object>>
 *   repo.ties.getById(id)               → Promise<Object|null>
 *   repo.ties.insert(doc)               → Promise<Object>  doc 必须自带 _id
 *   repo.ties.update(id, patch)         → Promise<void>
 *   repo.lineups.list()                 → Promise<Array<Object>>
 *   repo.lineups.listByEvent(eid)       → Promise<Array<Object>>
 *   repo.lineups.getById(id)            → Promise<Object|null>
 *   repo.lineups.insert(doc)            → Promise<Object>  doc 必须自带 _id
 *   repo.lineups.update(id, patch)      → Promise<void>
 *   repo.liveScores.getById(id)         → Promise<Object|null>  实时比分，_id = 'ls_' + matchId
 *   repo.liveScores.insert(doc)         → Promise<Object>  doc 必须自带 _id
 *   repo.liveScores.update(id, patch)   → Promise<void>
 *   repo.announcements.list()           → Promise<Array<Object>>
 *   repo.announcements.getById(id)      → Promise<Object|null>
 *   repo.announcements.insert(doc)      → Promise<Object>
 *   repo.announcements.update(id, patch)→ Promise<void>
 *   repo.memberships.list()             → Promise<Array<Object>>  按协会的高配角色行（无行=普通会员）
 *   repo.memberships.listByUser(uid)    → Promise<Array<Object>>
 *   repo.memberships.get(id)            → Promise<Object|null>    _id = mb_<md5(userId|assoc)>
 *   repo.memberships.set(id, doc)       → Promise<void>           按 _id 整体写入（upsert）
 *   repo.memberships.remove(id)         → Promise<void>
 *   repo.seasons.get(id)                → Promise<Object|null>
 *   repo.seasons.set(id, doc)           → Promise<void>
 *   repo.transaction(fn)                → Promise<*>       fn(txRepo)，抛错则整体回滚
 *   repo.audit.append(entry)            → Promise<void>
 *
 * 【S1 学校基础，S2 再逐处理器接入】
 *   repo.forScope({ schoolId, association }) → 固定范围仓储
 *     .matches / events / schoolMembers / ... → list / getById / insert / set / update
 *     .transaction(fn)                  → 回调仍为同范围仓储
 *   repo.<collection>.listByScope(scope) → 数据库条件查询，自动分页
 *   schools / schoolAssociations / colleges / schoolMembers / schoolRoles
 *   新集合提供 getById / set / list。
 *   范围仓储保护数据归属，不替代身份权限与父资源业务校验。
 *
 * 【每个集合都必须齐 getById / set / list 三件套】
 *   学校维度的服务只依赖注入的 repo，并且要与本地模拟仓储
 *   （miniprogram/services/school-memory-repo.js）**互换使用**——同一份业务代码
 *   两边都要跑通。因此每个集合都缺一不可，`set(id, doc)` 的语义是「按 _id 整体
 *   写入（upsert）」，与模拟仓储一致（insert / update 是云端额外的便捷形态，
 *   模拟仓储没有，业务代码不得依赖）。
 *
 *   这条不变式有历史教训：云端适配器当初只给一部分集合补了 set，而共享服务写得
 *   最多的是 `ctx.repo.transaction(tx => tx.events.set(...))`，于是同一个动作在本地
 *   mock 全绿、在云端抛 `tx.X.set is not a function`（被兜成「服务异常」）。
 *   2026-10-16 审计发现后补齐，并由 tests/cloud-repo-contract.test.js 持续守护。
 *
 * 【为什么写操作只给 set / update 两种形态】
 * 微信云开发的事务里，集合查询受限而 doc(id) 的读写稳定可靠。把写操作
 * 收敛成「按主键整体写」和「按主键改字段」，事务里就不必做集合查询，
 * 也就能安全地用事务隔离读写。去重靠把自然键直接当成 _id，而不是靠查询。
 * ============================================================
 */

const { COLLECTION } = require('../lib/utils/constants.js');

/** 逻辑名 → 集合名。集合名集中在 utils/constants.js 定义，便于迁移。 */
const COLLECTIONS = {
  schools: COLLECTION.SCHOOLS,
  schoolAssociations: COLLECTION.SCHOOL_ASSOCIATIONS,
  colleges: COLLECTION.COLLEGES,
  schoolMembers: COLLECTION.SCHOOL_MEMBERS,
  schoolRoles: COLLECTION.SCHOOL_ROLES,
  studentIdClaims: COLLECTION.STUDENT_ID_CLAIMS,
  exchangeEvents: COLLECTION.EXCHANGE_EVENTS,
  exchangeInvitations: COLLECTION.EXCHANGE_INVITATIONS,
  exchangeSignups: COLLECTION.EXCHANGE_SIGNUPS,
  exchangeMatches: COLLECTION.EXCHANGE_MATCHES,
  users: COLLECTION.USERS,
  matches: COLLECTION.MATCHES,
  events: COLLECTION.EVENTS,
  eventSignups: COLLECTION.EVENT_SIGNUPS,
  collegeEvents: COLLECTION.COLLEGE_EVENTS,
  collegeEntries: COLLECTION.COLLEGE_ENTRIES,
  ties: COLLECTION.TIES,
  lineups: COLLECTION.COLLEGE_LINEUPS,
  liveScores: COLLECTION.LIVE_SCORES,
  announcements: COLLECTION.ANNOUNCEMENTS,
  memberships: COLLECTION.MEMBERSHIPS,
  associationGroups: COLLECTION.ASSOCIATION_GROUPS,
  associationGroupMembers: COLLECTION.ASSOCIATION_GROUP_MEMBERS,
  associationNotices: COLLECTION.ASSOCIATION_NOTICES,
  associationTrainings: COLLECTION.ASSOCIATION_TRAININGS,
  trainingRegistrations: COLLECTION.TRAINING_REGISTRATIONS,
  pairCounts: COLLECTION.PAIR_COUNTS,
  memberRatings: COLLECTION.MEMBER_RATINGS,
  ratingCounters: COLLECTION.RATING_COUNTERS,
  seasons: COLLECTION.SEASONS,
  auditLogs: COLLECTION.AUDIT_LOGS,
  // 团队运动（篮球/足球/排球）：与个人赛彻底分开，见 utils/constants.js 的 TEAMS 一段。
  teams: COLLECTION.TEAMS,
  teamMembers: COLLECTION.TEAM_MEMBERS,
  teamEvents: COLLECTION.TEAM_EVENTS,
  teamEventEntries: COLLECTION.TEAM_EVENT_ENTRIES,
  teamMatches: COLLECTION.TEAM_MATCHES,
  teamMatchStats: COLLECTION.TEAM_MATCH_STATS,
  // 运动会：14 个集合均为「学校 + 运动会」双维度归属（无协会），
  // 由 school-repository.js 的 forMeet 校验写入范围。
  sportsMeets: COLLECTION.SPORTS_MEETS,
  sportsMeetEvents: COLLECTION.SPORTS_MEET_EVENTS,
  sportsMeetColleges: COLLECTION.SPORTS_MEET_COLLEGES,
  sportsMeetInterests: COLLECTION.SPORTS_MEET_INTERESTS,
  sportsMeetEntries: COLLECTION.SPORTS_MEET_ENTRIES,
  sportsMeetSessions: COLLECTION.SPORTS_MEET_SESSIONS,
  sportsMeetJudgeAssignments: COLLECTION.SPORTS_MEET_JUDGE_ASSIGNMENTS,
  sportsMeetScores: COLLECTION.SPORTS_MEET_SCORES,
  sportsMeetPublications: COLLECTION.SPORTS_MEET_PUBLICATIONS,
  sportsMeetResultRows: COLLECTION.SPORTS_MEET_RESULT_ROWS,
  sportsMeetQuotaUsage: COLLECTION.SPORTS_MEET_QUOTA_USAGE,
  sportsMeetStandings: COLLECTION.SPORTS_MEET_STANDINGS,
  sportsMeetHonors: COLLECTION.SPORTS_MEET_HONORS,
  sportsMeetParticipantClaims: COLLECTION.SPORTS_MEET_PARTICIPANT_CLAIMS,
  // 学院部长授权：学校级、一院一条，不属于任何一届运动会。
  sportsMeetCollegeLeads: COLLECTION.SPORTS_MEET_COLLEGE_LEADS,
};

module.exports = { COLLECTIONS };
