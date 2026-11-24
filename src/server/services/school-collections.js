/**
 * 学校维度仓储的集合清单（两端唯一来源）。
 * ============================================================
 * 云端 `cloudfunctions/data/src/school-repository.js` 与本地模拟仓储
 * `miniprogram/services/school-memory-repo.js` 原先各自维护一份集合名数组，
 * 注释里互相写着「与另一端一致」，靠人工比对。清单一旦漂移，症状是
 * 「本地全绿、云端某集合没有范围校验 / 没有方法」——最危险的一类静默失败。
 *
 * 这里收口成一份：新增集合只改这里与 `repository.js` 的 COLLECTIONS，
 * 两端同时生效。`tools/sync-cloud-lib.js` 会把本文件镜像到云端 lib。
 */

/** 运动会集合清单（meet-scope 里的定义是范围键的一部分，这里只做再导出）。 */
const { MEET_COLLECTIONS } = require('../../shared/utils/meet-scope.js');

/** 只按 schoolId 判归属：学院目录 / 身份 / 校级角色 / 学院部长 / 全校公告。 */
const SCHOOL_ONLY = ['colleges', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', 'announcements'];

/** 带 eventId 的从属集合：按赛事取子集走条件查询，不整表读后内存过滤。 */
const EVENT_SCOPED = ['matches', 'eventSignups', 'collegeEntries', 'ties', 'lineups',
  'teamEventEntries', 'teamMatches', 'teamMatchStats'];

/** 需要注入 schoolId（+ association）归属、写入前复查的集合。 */
const SCOPED_COLLECTIONS = [
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  ...SCHOOL_ONLY, 'schoolAssociations', 'memberships',
  'matches', 'events', 'eventSignups', 'collegeEvents', 'collegeEntries',
  'ties', 'lineups', 'liveScores', 'seasons',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  'pairCounts', 'memberRatings', 'ratingCounters',
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
];

/** 顶层就挂在学校仓储上的集合（含运动会）；其余基础集合由各适配器补齐。 */
const SCHOOL_COLLECTIONS = ['schools', 'schoolAssociations', 'colleges', 'schoolMembers', 'schoolRoles',
  'studentIdClaims', 'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers', 'associationNotices', 'associationTrainings',
  'trainingRegistrations', 'pairCounts', 'memberRatings', 'ratingCounters',
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
  ...MEET_COLLECTIONS, 'sportsMeetCollegeLeads'];

/** 内存仓储要建 Map 的全部集合：上面两组 + 平台级账号与审计。 */
const ALL_COLLECTIONS = [...new Set([
  ...SCHOOL_COLLECTIONS, ...SCOPED_COLLECTIONS, 'users', 'auditLogs',
])];

module.exports = {
  SCHOOL_ONLY, EVENT_SCOPED, SCOPED_COLLECTIONS, SCHOOL_COLLECTIONS, ALL_COLLECTIONS,
};
