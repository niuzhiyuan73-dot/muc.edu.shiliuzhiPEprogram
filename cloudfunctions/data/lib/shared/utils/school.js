/** S0/S1 学校模型。严格范围不兼容缺省学校；历史回填由迁移工具处理。 */
const { isKnownAssociation } = require('./associations.js');
const { sha256 } = require('./sha256.js');

const SCHOOL_STATUS = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });
const SCHOOL_MEMBER_STATUS = Object.freeze({
  PENDING: 'pending', ACTIVE: 'active', REJECTED: 'rejected', LEFT: 'left', DISABLED: 'disabled',
  // 转出：本人已转到另一所学校（历史记录仍留在原学校，见 school-membership-service 的转校一段）
  TRANSFERRED: 'transferred',
});
const PLATFORM_STATUS = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });
const PLATFORM_ROLE = Object.freeze({ MEMBER: 'member', ADMIN: 'admin' });
const SCHOOL_ROLE = Object.freeze({ ADMIN: 'admin' });
const LEGACY_SCHOOL_ID = 'muc';

/** 单个键字段的长度上限（见 schoolKey 里的说明）。 */
const MAX_KEY_PART_LENGTH = 200;

function requireSchoolId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id)) {
    throw new Error('必须提供有效的 schoolId');
  }
  return id;
}

function schoolScope(input = {}) {
  const schoolId = requireSchoolId(input.schoolId);
  if (!isKnownAssociation(input.association)) throw new Error('必须提供有效的 association');
  return Object.freeze({ schoolId, association: input.association });
}

function schoolKey(kind, ...parts) {
  if (!kind || parts.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('学校记录键缺少组成字段');
  }
  // 兜底上限：这些 component 最终会拼成数据库 _id。encodeURIComponent 对
  // 非 ASCII 会膨胀 3 倍，一条超长入参能把 _id 撑到 MB 级（2026-10-21 审查
  // P2-10）。正常入参远小于此（openId 约 28、组编号 31 位摘要、组名 ≤30 字）。
  if (parts.some((part) => part.length > MAX_KEY_PART_LENGTH)) {
    throw new Error('记录键字段过长');
  }
  return [kind, ...parts].map(encodeURIComponent).join(':');
}

/**
 * 把任意字符串折叠成固定长度（128 位 / 32 个十六进制字符）的确定性摘要。
 * 纯 JS，不依赖 Node 或云 SDK，miniprogram 与云端跑同一份。仅用于生成对外
 * 可见的短编号（如协会小组 _id 要能进 audienceGroupIds 受形态约束），
 * **不是**密码学散列，不得用于安全用途。
 */
function keyDigest(input) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < input.length; i += 1) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
    .map((word) => word.toString(16).padStart(8, '0')).join('');
}

const schoolMemberKey = (userId, schoolId) => schoolKey('sm', requireSchoolId(schoolId), userId);
const schoolRoleKey = (userId, schoolId) => schoolKey('sr', requireSchoolId(schoolId), userId);
const schoolAssociationKey = (scope) => {
  const s = schoolScope(scope);
  return schoolKey('sa', s.schoolId, s.association);
};
const schoolMembershipKey = (userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('mb', s.schoolId, s.association, userId);
};
const collegeKey = (schoolId, collegeId) => schoolKey('co', requireSchoolId(schoolId), collegeId);
// 会员评级表（Elo 逐场结算）：每个「学校 + 协会 + 用户 + 池」一条。
//
// 【为什么键里有 pool】单打/双打是两个独立评级池，一场双打只动 doubles。
// 【为什么用户编号直接作为键的一段】与 schoolMemberKey 同一约定：userId 是
// 平台生成的安全标识（schoolAccountKey 产物），不含需要转义的任意输入，
// 键本身带分隔语义，少一层摘要就少一处「查不到自己」的排查成本。
const memberRatingKey = (userId, pool, scope) => {
  const s = schoolScope(scope);
  if (!userId || typeof userId !== 'string') throw new Error('评级键缺少用户编号');
  if (typeof pool !== 'string' || !pool) throw new Error('评级键缺少池名');
  return schoolKey('mr', s.schoolId, s.association, userId, pool);
};
// 结算序号计数：每个「学校 + 协会」一条，settlementSeq 从这里原子递增。
// 【为什么不含 pool】结算顺序是范围级的总分链口径：按「确认先后」给全范围
// 的比赛编号，图表与审计按同一条链读；分池编号反而让两条链对不上账。
const ratingSeqKey = (scope) => {
  const s = schoolScope(scope);
  return schoolKey('mrseq', s.schoolId, s.association);
};
// 团队运动（篮球/足球/排球）：球队与队员。
// 球队编号由「创建人 + 请求编号」派生，重试同一请求拿到同一个队，不会建出两个。
const teamKey = (seed, scope) => {
  const s = schoolScope(scope);
  if (typeof seed !== 'string' || !seed) throw new Error('球队键缺少种子');
  return schoolKey('tm', s.schoolId, s.association, keyDigest(seed));
};
// 队员关系：一队一人一条。teamId 已含学校与协会，这里不再重复。
const teamMemberKey = (teamId, userId) => schoolKey('tmm', teamId, userId);
// 学院代表队编号：由「学校 + 协会 + 学院」派生，一个学院在一个项目里恒定一条。
//
// 【为什么必须确定性】
// 院队是系统预置的常设队，不经过「创建」动作，也没有创建人可以当种子。用学院编号
// 当种子，任何请求随时能算出同一个 teamId：报名记录 `entryKey(赛事, 院队)` 因此
// 结构上就是「一院一届一条报名」，不需要额外去重，也不存在并发窗口。
const collegeTeamKey = (collegeId, scope) => {
  if (typeof collegeId !== 'string' || !collegeId) throw new Error('学院队键缺少学院编号');
  return teamKey(`college:${collegeId}`, scope);
};
const scopeKey = (scope) => {
  const s = schoolScope(scope);
  return schoolKey('scope', s.schoolId, s.association);
};
// 协会空间小组：_id 由服务端按 scope + 创建者 + 请求编号生成，翻不出别的学校/协会。
// 小组编号会作为 audienceGroupIds 对外提交，受 GROUP_ID_PATTERN（[A-Za-z0-9_-]{1,64}）
// 约束，而 schoolKey 复合键含 ':' 与 '%'。故这里保留同样的输入组成与幂等语义，只把
// 完整、规范化的复合键折叠成固定长度、URL 安全的摘要。schoolKey 仍是内部键工具，
// 其余记录的键规则不受影响。
const associationGroupKey = (groupId, scope) => {
  const s = schoolScope(scope);
  return `ag_${keyDigest(schoolKey('ag', s.schoolId, s.association, groupId))}`;
};
// 组内成员关系：scope + groupId + userId，稳定唯一，重复加入走同一键。
const associationGroupMemberKey = (groupId, userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('agm', s.schoolId, s.association, groupId, userId);
};
// 同范围组名占位键：把「组名不重名」变成对同一文档的写冲突，而不是先查重再插入。
const associationGroupNameKey = (name, scope) => {
  const s = schoolScope(scope);
  return schoolKey('agn', s.schoolId, s.association, name);
};
// 空间通知：_id 由服务端按 scope + 服务端生成的请求编号构成，翻不出别的学校/协会。
const associationNoticeKey = (noticeId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('an', s.schoolId, s.association, noticeId);
};
// 空间训练：_id 由服务端按 scope + 服务端生成的请求编号构成。
const associationTrainingKey = (trainingId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('at', s.schoolId, s.association, trainingId);
};
// 训练报名：scope + trainingId + userId，稳定唯一，重复报名走同一键，无法跨范围伪造。
const trainingRegistrationKey = (trainingId, userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('tr', s.schoolId, s.association, trainingId, userId);
};
// 个人赛事：_id 由服务端按 scope + 发布者 + 请求编号生成，翻不出别的学校/协会。
const schoolEventKey = (eventId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('sev', s.schoolId, s.association, eventId);
};
// 赛事报名：scope + eventId + userId，稳定唯一，重复报名走同一键，无法跨范围伪造。
const schoolEventSignupKey = (eventId, userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('sevsu', s.schoolId, s.association, eventId, userId);
};
// 比赛记录：_id 由服务端按 scope + 录入者 + 请求编号生成，翻不出别的学校/协会。
const schoolMatchKey = (matchId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('sm', s.schoolId, s.association, matchId);
};
// 实时比分：一场比赛恒一条，_id 由 scope + 比赛编号构成，跨范围读不到也写不进。
const schoolLiveKey = (matchId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('sls', s.schoolId, s.association, matchId);
};
// 学院赛：_id 由服务端按 scope + 发布者 + 请求编号生成，翻不出别的学校/协会。
const collegeEventKey = (eventId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('cev', s.schoolId, s.association, eventId);
};
// 学院赛名单：scope + eventId + collegeId，稳定唯一；重复提交覆盖同一条。
// 键用学院稳定编号（每校独立目录），而非可能重名的学院全名。
const collegeEntryKey = (eventId, collegeId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('cen', s.schoolId, s.association, eventId, collegeId);
};
// 学院赛排阵：scope + tieId + collegeId，同一大场同一学院恒一条，重复提交覆盖同一条。
// 同样用学院稳定编号而非全名，重名学院不会互相顶掉。
const collegeLineupKey = (tieId, collegeId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('cln', s.schoolId, s.association, tieId, collegeId);
};
// 交手名额计数：scope + 赛季分界点 + 两人编号（升序）。两人编号直接作为键的两段，
// 不用 '|' 拼接——键本身就带分隔语义，少一层转义就少一处能拼错的地方。
//
// 【为什么用「赛季分界点」而不是赛季序号当键】
// 名额算的是「本赛季」的场次，而「本赛季」在台账那边的定义就是
// `matchTime >= season.resetTime`（见 rating-cap.countedMatches）。计数文档的键
// 必须用同一个定义，两处才不可能分叉：重置赛季时 resetTime 变、键跟着变，
// 旧赛季的计数天然失效、不必迁移；从没重置过的范围用 'all'，与「从未开始过新赛季」
// 同义。分界点为空 / 非法时也归到 'all'，不会把不同赛季挤进同一个桶。
const pairCountKey = (a, b, seasonStamp, scope) => {
  const s = schoolScope(scope);
  const [first, second] = String(a) <= String(b) ? [a, b] : [b, a];
  const stamp = typeof seasonStamp === 'string' && seasonStamp ? seasonStamp : 'all';
  return schoolKey('pc', s.schoolId, s.association, stamp, first, second);
};
// 全校公告：_id 由服务端按 scope + 发布者 + 请求编号生成，翻不出别的学校/协会。
const schoolAnnouncementKey = (announcementId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('ann', s.schoolId, s.association, announcementId);
};
// 平台账号：_id 由微信 OpenID 派生，同一微信身份恒一条账号，重复注册走同一键。
// 账号级、不含学校/协会——换学校不改账号，学号与学院另由学校身份（schoolMember）登记。
const schoolAccountKey = (openId) => {
  if (typeof openId !== 'string' || !openId || openId.length > MAX_KEY_PART_LENGTH) {
    throw new Error('账号身份无效或过长');
  }
  // 160-bit SHA-256 prefix: stable for retries, no reversible OpenID in public IDs.
  return schoolKey('acc', sha256(openId).slice(0, 40));
};
function belongsToSchoolScope(doc, scope) {
  const s = schoolScope(scope);
  return Boolean(doc && doc.schoolId === s.schoolId && doc.association === s.association);
}

module.exports = {
  SCHOOL_STATUS, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS, PLATFORM_ROLE, SCHOOL_ROLE,
  LEGACY_SCHOOL_ID, requireSchoolId, schoolScope, schoolKey, schoolMemberKey,
  schoolRoleKey, schoolAssociationKey, schoolMembershipKey, collegeKey,
  scopeKey, belongsToSchoolScope,
  associationGroupKey, associationGroupMemberKey, associationGroupNameKey,
  associationNoticeKey, associationTrainingKey, trainingRegistrationKey,
  schoolEventKey, schoolEventSignupKey, schoolMatchKey, schoolLiveKey,
  collegeEventKey, collegeEntryKey, collegeLineupKey, schoolAnnouncementKey,
  schoolAccountKey, pairCountKey, memberRatingKey, ratingSeqKey,
  teamKey, teamMemberKey, collegeTeamKey,
};
