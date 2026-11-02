/**
 * 协会空间：训练发布与报名的事务编排
 * ============================================================
 * 「训练」是协会内部的活动：负责人发布，本协会有效会员报名，开始前可取消。
 * 本阶段（P3）只做到「发布 / 编辑 / 取消 / 结束 / 报名 / 取消报名 / 管理移除 /
 * 名单读取」，**不含签到与积分**（签到是 P5，见规划 §12：计划未接积分前不得
 * 出现可用但不计分的「签到成功」入口，故本模块不暴露任何签到动作）。
 *
 * 【职责边界】
 * 本模块注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 权限在同目录 association-space-permission.js；小组限制的规范化与并集命中在
 * association-audience.js；稳定主键在 utils/school.js。
 *
 * 【资格怎么判（不能只看页面候选）】
 *   1. 基础资格 canParticipateInAssociation：有效平台账号 + 本校有效身份 +
 *      primarySchoolId 匹配 + 协会启用；
 *   2. 小组并集资格：对每个所选小组，按 scope + groupId + userId 的稳定键在
 *      事务内 getById 读关系（**不做整表查询**，事务内不允许），命中任一 active 即通过；
 *   3. 名额：capacity 为空即不限，否则 signupCount < capacity。
 *   最终资格 = 基础资格 AND 小组并集 AND 名额 AND 时间窗口。
 *
 * 【并发与幂等】
 *   · 报名 / 取消 / 移除都在事务内重读训练主记录，人数增减与训练 revision 同步；
 *   · 报名记录用 scope + trainingId + userId 的稳定主键，重复报名是幂等的；
 *   · 若命中小组成员限制，报名事务顺带更新所命中小组的 membershipRevision，
 *     与「移出组员」写同一主记录，形成冲突点（§9.2），避免移除与报名各改一半；
 *   · 发布用 requestId 派生稳定 trainingId，同编号重试返回同一条；
 *   · 编辑 / 取消 / 结束带 expectedRevision。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { loadColleges } = require('./college-directory.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
const {
  buildAudience, readAudience, audienceAllows, hitGroupIds, AUDIENCE_MODE,
} = require('./association-audience.js');
const { GROUP_MEMBER_STATUS } = require('./association-group-service.js');
const {
  schoolKey, belongsToSchoolScope, associationTrainingKey, trainingRegistrationKey,
  associationGroupMemberKey,
} = require('../utils/school.js');
const {
  TRAINING_STATUS, TRAINING_STATUS_LABEL, TRAINING_SIGNUP_STATUS,
} = require('../utils/constants.js');
// 签到状态与训练积分事实同源（training-points.js），避免两处各写一份状态机常量。
const { ATTENDANCE_STATUS } = require('./training-points.js');
// 积分事实一变就要推赛季代际并重算物化值（2026-10-29 第十三轮，见 season-points.js）。
// 单人事实（确认 / 撤销 / 移除）走增量：一条事实固定 ±1，直接在第 1 格上加减，
// 不重算——签到确认是高频动作，整份重算会把读放大搬到写路径。
const { applyTrainingFactDelta, bumpSeasonVersion, refreshAfterWrite } = require('./season-points.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TITLE_MIN = 2;
const TITLE_MAX = 30;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 100;
/** 人数上限的 UI 上限（§5.4）。超过即为无效，不是「不限」。 */
const CAPACITY_MAX = 1000;
/** 省略结束时间时的默认时长：2 小时 */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
/** 签到窗口相对开始时间的提前量：30 分钟（本阶段只落库，不开放签到） */
const CHECKIN_LEAD_MS = 30 * 60 * 1000;
const TRAINING_LIST_LIMIT = 20;
const TRAINING_LIST_MAX = 50;
const REGISTRATION_LIST_LIMIT = 20;
const REGISTRATION_LIST_MAX = 50;

/** 展示状态由服务器时间推导，不额外维护可漂移字段（§3.4）。 */
const TRAINING_STATE = Object.freeze({
  OPEN: 'open', ONGOING: 'ongoing', FINISHED: 'finished', CANCELED: 'canceled',
});
const TRAINING_STATE_LABEL = Object.freeze({
  open: '可报名', ongoing: '进行中', finished: '已结束', canceled: '已取消',
});
/** 签到状态的展示文案（页面直用）。 */
const ATTENDANCE_STATUS_LABEL = Object.freeze({
  not_submitted: '未签到', pending: '待确认', rejected: '已退回', confirmed: '签到成功',
});

const isTrainingDoc = doc => Boolean(doc && doc.title && doc.startAt && doc.status);
const iso = value => new Date(value).toISOString();
const displayName = actor => (actor ? (actor.nickName || actor.realName || actor._id) : '');

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/** 事务内为**任意用户**（不只是当前登录人）重建上下文，用于校验目标会员的资格。 */
const contextFor = (tx, ctx, actorId) => buildSchoolContext({
  repo: tx, actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/** 本人签到窗口：checkInOpenAt <= now <= checkInCloseAt（§6.2）。 */
const inCheckInWindow = (training, nowMs) => {
  const open = Date.parse(training.checkInOpenAt);
  const close = Date.parse(training.checkInCloseAt);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
  return nowMs >= open && nowMs <= close;
};

const trainingAuditKey = (trainingId, action, revision) =>
  schoolKey('atau', trainingId, action, String(revision));
const signupAuditKey = (registrationId, action, revision) =>
  schoolKey('trau', registrationId, action, String(revision));

/* --------------------------------------------------------------- 纯工具 */

/** 解析时间输入（ISO 串 / 时间戳 / Date）为毫秒；无效返回 null */
function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 归一可选文本；超长即拒绝 */
function text(value, max, { required = false, label = '内容' } = {}) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (required && !trimmed) return { ok: false, message: `请填写${label}` };
  if (trimmed.length > max) return { ok: false, message: `${label}最多 ${max} 个字` };
  return { ok: true, value: trimmed };
}

/** 人数上限：空/未传 = 不限（null）；否则必须是 1..CAPACITY_MAX 的整数 */
function normalizeCapacity(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, message: '人数上限需为正整数，留空表示不限' };
  }
  if (num > CAPACITY_MAX) return { ok: false, message: `人数上限最多 ${CAPACITY_MAX} 人` };
  return { ok: true, value: num };
}

/** 展示状态：已取消 / 已结束按状态；其余按服务器时间推导 */
function trainingState(doc, nowMs) {
  if (doc.status === TRAINING_STATUS.CANCELED) return TRAINING_STATE.CANCELED;
  if (doc.status === TRAINING_STATUS.FINISHED) return TRAINING_STATE.FINISHED;
  const startMs = Date.parse(doc.startAt);
  const endMs = Date.parse(doc.endAt);
  if (nowMs < startMs) return TRAINING_STATE.OPEN;
  if (nowMs < endMs) return TRAINING_STATE.ONGOING;
  return TRAINING_STATE.FINISHED;
}

/** 训练摘要 DTO（列表与详情共用）。timeText 留给页面按本地时区渲染，这里只给原始 ISO。 */
function trainingSummary(doc, nowMs) {
  const state = trainingState(doc, nowMs);
  return {
    trainingId: doc._id,
    title: doc.title || '',
    description: doc.description || '',
    location: doc.location || '',
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    capacity: doc.capacity === null || doc.capacity === undefined ? null : Number(doc.capacity),
    signupCount: Number(doc.signupCount || 0),
    audienceMode: doc.audienceMode || AUDIENCE_MODE.ALL,
    audienceGroupIds: Array.isArray(doc.audienceGroupIds) ? doc.audienceGroupIds.slice() : [],
    status: doc.status,
    state,
    stateLabel: TRAINING_STATE_LABEL[state] || '',
    statusLabel: TRAINING_STATUS_LABEL[doc.status] || '',
    signupCloseAt: doc.signupCloseAt || null,
    checkInOpenAt: doc.checkInOpenAt || null,
    checkInCloseAt: doc.checkInCloseAt || null,
    revision: Number(doc.revision || 1),
  };
}

/** 有效报名数：只数 registered（取消/移除不占名额） */
function countRegistered(rows, trainingId) {
  return rows.filter(row => row.trainingId === trainingId &&
    row.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED).length;
}

/** 本人对某训练的一行报名状态（列表用，不下发隐私字段） */
function myRegistrationDTO(reg) {
  if (!reg) return null;
  const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
  return {
    signupStatus: reg.signupStatus,
    attendanceStatus: attendance,
    attendanceLabel: ATTENDANCE_STATUS_LABEL[attendance] || '',
    signedAt: reg.signedAt || null,
    canceledAt: reg.canceledAt || null,
    requestedAt: reg.requestedAt || null,
    confirmedAt: reg.confirmedAt || null,
    rejectionReason: reg.rejectionReason || '',
    revision: Number(reg.revision || 1),
  };
}

/* --------------------------------------------------- 小组成员关系的读写 */

/** 事务外：列某人当前 active 的小组 ID（用于详情页算报名资格说明） */
async function activeGroupIdsOf(repo, ctx, userId) {
  const rows = await repo.forScope(ctx).associationGroupMembers.list();
  return rows.filter(row => row.userId === userId && row.status === GROUP_MEMBER_STATUS.ACTIVE)
    .map(row => row.groupId);
}

/**
 * 事务内：按稳定键逐个读取所选小组的本人关系，返回命中的小组 ID。
 * 不做整表查询（事务内不允许），因此循环 getById。
 */
async function hitGroupsInTx(tx, ctx, userId, audience) {
  const normalized = readAudience(audience);
  if (normalized.audienceMode === AUDIENCE_MODE.ALL) return [];
  const hits = [];
  for (const groupId of normalized.audienceGroupIds) {
    const rel = await tx.associationGroupMembers.getById(associationGroupMemberKey(groupId, userId, ctx));
    if (rel && rel.status === GROUP_MEMBER_STATUS.ACTIVE) hits.push(groupId);
  }
  return hits;
}

/** 报名时同步提升命中小组的 membershipRevision，作为与「移出组员」的冲突点（§9.2） */
async function bumpHitGroups(tx, hitIds, nowIso) {
  for (const groupId of hitIds) {
    const group = await tx.associationGroups.getById(groupId);
    if (!group || group.status !== 'active') continue;
    await tx.associationGroups.set(group._id, {
      ...group,
      membershipRevision: Number(group.membershipRevision || 0) + 1,
      updatedAt: nowIso,
    });
  }
}

/* ------------------------------------------------------------------ 读 */

async function listTrainings(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, trainings: [], canManage: false, nextCursor: '', hasMore: false,
      message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  const nowMs = ctx.now.getTime();
  let rows = (await ctx.repo.forScope(ctx).associationTrainings.list()).filter(isTrainingDoc);
  if (typeof payload.state === 'string' && payload.state) {
    rows = rows.filter(row => trainingState(row, nowMs) === payload.state);
  }

  // 按开始时间升序（最近的排前，过往沉底），同刻按 ID 稳定排序，游标可复现。
  const sorted = rows.slice().sort((a, b) => {
    const sa = Date.parse(a.startAt);
    const sb = Date.parse(b.startAt);
    if (sa !== sb) return sa - sb;
    return a._id < b._id ? -1 : 1;
  });
  const after = typeof payload.cursor === 'string' ? payload.cursor : '';
  let start = 0;
  if (after) {
    const [startAt, id] = after.split('|').map(decodeURIComponent);
    start = sorted.findIndex(row => String(row.startAt || '') > startAt ||
      (String(row.startAt || '') === startAt && row._id > id));
    if (start < 0) start = sorted.length;
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, TRAINING_LIST_MAX) : TRAINING_LIST_LIMIT;
  const page = sorted.slice(start, start + limit);
  const hasMore = sorted.length > start + limit;
  const nextCursor = hasMore && page.length
    ? [encodeURIComponent(String(page[page.length - 1].startAt || '')),
      encodeURIComponent(page[page.length - 1]._id)].join('|')
    : '';

  return ok({ ok: true, canManage, hasMore, nextCursor,
    trainings: page.map(row => trainingSummary(row, nowMs)), message: '' });
}

async function getTraining(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const training = await ctx.repo.associationTrainings.getById(payload.trainingId);
  if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return ok(refused('训练不存在'));

  const canManage = canManageAssociationSpace(ctx);
  const nowMs = ctx.now.getTime();
  const summary = trainingSummary(training, nowMs);
  const parts = canParticipateInAssociation(ctx);

  let registration = null;
  if (ctx.actorId) {
    registration = await ctx.repo.trainingRegistrations
      .getById(trainingRegistrationKey(training._id, ctx.actorId, ctx));
  }
  const registered = Boolean(registration && registration.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED);
  const attendance = registration ? (registration.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) : '';
  const state = summary.state;
  const full = training.capacity !== null && Number(training.signupCount || 0) >= Number(training.capacity);

  // 报名资格说明：逐条给出「不能报名的第一条原因」，供详情页原样展示。
  let registerNote = '';
  if (!parts) registerNote = '只有本协会有效会员可以报名';
  else if (state === TRAINING_STATE.CANCELED) registerNote = '训练已取消';
  else if (state !== TRAINING_STATE.OPEN) registerNote = '报名已截止';
  else if (registered) registerNote = '';
  else if (full) registerNote = '名额已满';
  else {
    const activeGroupIds = await activeGroupIdsOf(ctx.repo, ctx, ctx.actorId);
    if (!audienceAllows(training, activeGroupIds)) registerNote = '本次训练仅限指定小组成员报名';
  }
  const canRegister = parts && state === TRAINING_STATE.OPEN && !registered && !full &&
    !registerNote;
  const canCancel = registered && state === TRAINING_STATE.OPEN &&
    attendance !== ATTENDANCE_STATUS.PENDING && attendance !== ATTENDANCE_STATUS.CONFIRMED;

  // 本人签到：报名有效 + 会员资格仍在 + 训练未取消 + 处于签到窗口，
  // 且当前不是「待确认 / 已确认」（这两种状态只需等待或已成功）。
  const windowOpen = inCheckInWindow(training, nowMs);
  const canCheckIn = parts && registered && training.status === TRAINING_STATUS.PUBLISHED &&
    windowOpen &&
    (attendance === ATTENDANCE_STATUS.NOT_SUBMITTED || attendance === ATTENDANCE_STATUS.REJECTED);
  let checkInNote = '';
  if (registered) {
    if (attendance === ATTENDANCE_STATUS.CONFIRMED) checkInNote = '签到已确认';
    else if (attendance === ATTENDANCE_STATUS.PENDING) checkInNote = '已提交，等待负责人确认';
    else if (training.status !== TRAINING_STATUS.PUBLISHED) checkInNote = '训练已取消或已结束';
    else if (!parts) checkInNote = '已失去本协会会员身份，无法签到';
    else if (nowMs < Date.parse(training.checkInOpenAt)) checkInNote = '签到尚未开始';
    else if (nowMs > Date.parse(training.checkInCloseAt)) checkInNote = '签到已结束';
  }

  return ok({
    ok: true, canManage, training: summary, canParticipate: parts,
    myRegistration: myRegistrationDTO(registration),
    canRegister, canCancel, registerNote, canCheckIn, checkInNote, message: '',
  });
}

async function listTrainingRegistrations(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const training = await ctx.repo.associationTrainings.getById(payload.trainingId);
  if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return ok(refused('训练不存在'));

  const canManage = canManageAssociationSpace(ctx);
  // 【按训练取报名，而不是读整个协会的台账】（2026-10-23 第三轮审查 X-8）
  // trainingRegistrations 只增不减：一个练了三年的协会是数千条 / 几十页 RPC，
  // 而这里只要这一场训练的那几十条。见仓储的 listByTraining。
  const all = await ctx.repo.forScope(ctx).trainingRegistrations.listByTraining(training._id);
  const registeredRows = all.filter(row => row.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED);

  // 普通会员只看有效报名名单（昵称 / 头像），不下发取消记录与任何隐私字段。
  if (!canManage) {
    // 账号按「已报名的人」批量取，别读全平台 users（2026-10-21 审查 P0-1）。
    const userById = new Map(
      (await ctx.repo.users.listByIds(registeredRows.map(row => row.userId)))
        .map(user => [user._id, user]),
    );
    const members = [];
    for (const row of registeredRows) {
      const user = userById.get(row.userId);
      members.push({ userId: row.userId, nickName: (user && user.nickName) || '会员',
        avatarUrl: (user && user.avatarUrl) || '', attendanceStatus: row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED });
    }
    return ok({ ok: true, canManage: false, hasMore: false, nextCursor: '', members,
      registrations: [], message: '' });
  }

  // 管理者：按筛选给全部记录，含取消 / 签到状态，可分页。
  let rows = all;
  const filter = typeof payload.filter === 'string' ? payload.filter : '';
  if (filter === 'registered' || filter === 'canceled') {
    rows = rows.filter(row => row.signupStatus === filter);
  } else if (filter) {
    rows = rows.filter(row => (row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) === filter);
  }
  const sorted = rows.slice().sort((a, b) => {
    const ta = String(a.signedAt || '');
    const tb = String(b.signedAt || '');
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a._id < b._id ? -1 : 1;
  });
  const after = typeof payload.cursor === 'string' ? payload.cursor : '';
  let start = 0;
  if (after) {
    const [signedAt, id] = after.split('|').map(decodeURIComponent);
    start = sorted.findIndex(row => String(row.signedAt || '') < signedAt ||
      (String(row.signedAt || '') === signedAt && row._id > id));
    if (start < 0) start = sorted.length;
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, REGISTRATION_LIST_MAX) : REGISTRATION_LIST_LIMIT;
  const page = sorted.slice(start, start + limit);
  const hasMore = sorted.length > start + limit;
  const nextCursor = hasMore && page.length
    ? [encodeURIComponent(String(page[page.length - 1].signedAt || '')),
      encodeURIComponent(page[page.length - 1]._id)].join('|')
    : '';

  const registrations = [];
  const colleges = await loadColleges(ctx);
  // 学院名走 Map（原先 find 在循环里，2026-10-21 审查 P2-7）。
  const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
  const collegeName = id => collegeNameById.get(id) || '';
  // 同理：账号与学校身份各取一次建索引，页面每条再逐条 getById 是 N+1。
  // 账号按当前页的人批量取，不读全平台 users（2026-10-21 审查 P0-1）；
  // 学籍也只取这一页的人（2026-10-23 第三轮 X-11 同型：为几十行读全校名册）。
  const userById = new Map(
    (await ctx.repo.users.listByIds(page.map(row => row.userId))).map(user => [user._id, user]),
  );
  const memberById = new Map((await ctx.repo.forScope(ctx).schoolMembers
    .listByIds(page.map(row => schoolKey('sm', ctx.schoolId, row.userId))))
    .filter(Boolean).map(row => [row._id, row]));
  for (const row of page) {
    const user = userById.get(row.userId);
    const member = memberById.get(schoolKey('sm', ctx.schoolId, row.userId));
    registrations.push({
      userId: row.userId,
      nickName: (user && user.nickName) || '会员',
      avatarUrl: (user && user.avatarUrl) || '',
      collegeName: collegeName(member && member.collegeId),
      signupStatus: row.signupStatus,
      attendanceStatus: row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED,
      attendanceLabel: ATTENDANCE_STATUS_LABEL[row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED] || '',
      signedAt: row.signedAt || null,
      requestedAt: row.requestedAt || null,
      confirmedAt: row.confirmedAt || null,
      rejectionReason: row.rejectionReason || '',
      canceledAt: row.canceledAt || null,
      cancelReason: row.cancelReason || '',
      revision: Number(row.revision || 1),
    });
  }
  return ok({ ok: true, canManage: true, hasMore, nextCursor, members: [], registrations, message: '' });
}

/* ------------------------------------------------- 训练表单校验与组装 */

/**
 * 校验发布 / 编辑共用的训练字段。返回规范化后的字段或第一条错误。
 * @param {Object} payload
 * @param {number} nowMs 服务器当前毫秒
 * @param {boolean} requireFuture 是否要求 startAt 严格在未来（发布时要求）
 */
function buildTrainingFields(payload, nowMs, requireFuture) {
  const title = text(payload.title, TITLE_MAX, { required: true, label: '训练标题' });
  if (!title.ok) return { ok: false, message: title.message };
  if (title.value.length < TITLE_MIN) return { ok: false, message: `训练标题至少 ${TITLE_MIN} 个字` };
  const description = text(payload.description, DESCRIPTION_MAX, { label: '训练说明' });
  if (!description.ok) return { ok: false, message: description.message };
  const location = text(payload.location, LOCATION_MAX, { required: true, label: '训练地点' });
  if (!location.ok) return { ok: false, message: location.message };

  const startMs = parseTime(payload.startAt);
  if (startMs === null) return { ok: false, message: '请填写有效的开始时间' };
  if (requireFuture && startMs <= nowMs) return { ok: false, message: '开始时间必须在未来' };
  let endMs = parseTime(payload.endAt);
  if (endMs === null) endMs = startMs + DEFAULT_DURATION_MS;
  if (endMs <= startMs) return { ok: false, message: '结束时间必须晚于开始时间' };

  const capacity = normalizeCapacity(payload.capacity);
  if (!capacity.ok) return { ok: false, message: capacity.message };

  const audience = buildAudience(payload);
  if (!audience.ok) return { ok: false, message: audience.message };

  return { ok: true, fields: {
    title: title.value, description: description.value, location: location.value,
    startMs, endMs, capacity: capacity.value,
    audienceMode: audience.audienceMode, audienceGroupIds: audience.audienceGroupIds,
  } };
}

/** 由规范化字段组装可落库的训练主记录 */
function buildTrainingDoc(fields, requestId, fresh, at) {
  const trainingId = associationTrainingKey(schoolKey('t', fresh.actorId, requestId), fresh);
  return {
    _id: trainingId, schoolId: fresh.schoolId, association: fresh.association,
    title: fields.title, description: fields.description,
    startAt: iso(fields.startMs), endAt: iso(fields.endMs), location: fields.location,
    capacity: fields.capacity,
    audienceMode: fields.audienceMode, audienceGroupIds: fields.audienceGroupIds,
    status: TRAINING_STATUS.PUBLISHED,
    signupCloseAt: iso(fields.startMs),
    checkInOpenAt: iso(fields.startMs - CHECKIN_LEAD_MS),
    checkInCloseAt: iso(fields.endMs),
    signupCount: 0, audienceLockedAt: null,
    canceledAt: null, canceledBy: '', cancelReason: '',
    fingerprint: JSON.stringify([fields.title, fields.description, fields.startMs, fields.endMs,
      fields.location, fields.capacity, fields.audienceMode, fields.audienceGroupIds]),
    createdBy: fresh.actorId, createdByName: displayName(fresh.actor),
    revision: 1, createdAt: at, updatedAt: at,
  };
}

/* ------------------------------------------------------------------ 写 */

async function publishTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const built = buildTrainingFields(payload, ctx.now.getTime(), true);
  if (!built.ok) return ok(refused(built.message));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布训练');
    const doc = buildTrainingDoc(built.fields, token, fresh, iso(fresh.now));
    const existing = await tx.associationTrainings.getById(doc._id);
    if (isTrainingDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, training: trainingSummary(existing, fresh.now.getTime()), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.associationTrainings.set(doc._id, doc);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'publishTraining', 1),
      action: 'publishTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: iso(fresh.now) });
    return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function updateTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新训练版本后重试'));
  }
  const built = buildTrainingFields(payload, ctx.now.getTime(), false);
  if (!built.ok) return ok(refused(built.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以编辑训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) return refused('已取消的训练不能再编辑');
    if (doc.revision !== payload.expectedRevision) return refused('训练已修改，请刷新后重试');

    const f = built.fields;
    const locked = Boolean(doc.audienceLockedAt) || Number(doc.signupCount || 0) > 0;
    const audienceUnchanged = f.audienceMode === doc.audienceMode &&
      JSON.stringify(f.audienceGroupIds) === JSON.stringify(Array.isArray(doc.audienceGroupIds) ? doc.audienceGroupIds : []);
    if (locked && (f.startMs !== Date.parse(doc.startAt) || f.endMs !== Date.parse(doc.endAt) || !audienceUnchanged)) {
      return refused('已有报名，开始时间、结束时间与小组范围不能再改');
    }
    if (!locked && f.startMs !== Date.parse(doc.startAt) && f.startMs <= fresh.now.getTime()) {
      return refused('开始时间必须在未来');
    }
    if (f.capacity !== null && f.capacity < Number(doc.signupCount || 0)) {
      return refused(`人数上限不能小于已报名人数（${Number(doc.signupCount || 0)}）`);
    }

    const nowMs = fresh.now.getTime();
    const nowIso = iso(fresh.now);
    const next = {
      ...doc,
      title: f.title, description: f.description, location: f.location,
      capacity: f.capacity, revision: doc.revision + 1, updatedAt: nowIso,
    };
    if (!locked) {
      next.startAt = iso(f.startMs);
      next.endAt = iso(f.endMs);
      next.signupCloseAt = iso(f.startMs);
      next.checkInOpenAt = iso(f.startMs - CHECKIN_LEAD_MS);
      next.checkInCloseAt = iso(f.endMs);
      next.audienceMode = f.audienceMode;
      next.audienceGroupIds = f.audienceGroupIds;
    }
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'updateTraining', next.revision),
      action: 'updateTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: nowIso });
    return { ok: true, training: trainingSummary(next, nowMs), message: '' };
  });
  return ok(result);
}

/** 取消训练：整体失效，保留记录留痕；对外不再接受报名（§6.1） */
async function cancelTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const reason = text(payload.reason, 200, { label: '取消原因' });
  if (!reason.ok) return ok(refused(reason.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以取消训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) {
      return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
    }
    const nowIso = iso(fresh.now);
    const next = { ...doc, status: TRAINING_STATUS.CANCELED, canceledAt: nowIso,
      canceledBy: fresh.actorId, cancelReason: reason.value,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'cancelTraining', next.revision),
      action: 'cancelTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, reason: reason.value, at: nowIso });
    // 取消训练会让本条训练下**所有**已确认签到失效（见 training-points.js）：
    // 积分事实批量消失，代际必须在同一事务里推。
    await bumpSeasonVersion(tx, fresh, fresh.now);
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  if (result && result.ok) await refreshAfterWrite(ctx);
  return ok(result);
}

/** 结束训练：必须已过结束时间；不自动批量确认任何 pending（§6.2） */
async function finishTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以结束训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) return refused('已取消的训练不能标记结束');
    if (doc.status === TRAINING_STATUS.FINISHED) {
      return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
    }
    if (fresh.now.getTime() < Date.parse(doc.endAt)) return refused('训练尚未结束，不能提前标记结束');
    const nowIso = iso(fresh.now);
    const next = { ...doc, status: TRAINING_STATUS.FINISHED, revision: doc.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'finishTraining', next.revision),
      action: 'finishTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: nowIso });
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function registerTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canParticipateInAssociation(fresh)) return refused('只有本协会有效会员可以报名');
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, fresh)) return refused('训练不存在');
    if (training.status !== TRAINING_STATUS.PUBLISHED) return refused('训练已取消或已结束，不能报名');
    if (!(fresh.now.getTime() < Date.parse(training.startAt))) return refused('报名已截止');

    const key = trainingRegistrationKey(training._id, userId, fresh);
    const existing = await tx.trainingRegistrations.getById(key);
    if (existing && existing.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, registration: myRegistrationDTO(existing),
        training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }

    const hits = await hitGroupsInTx(tx, fresh, userId, training);
    if (!audienceAllows(training, hits)) return refused('本次训练仅限指定小组成员报名');
    if (training.capacity !== null && training.capacity !== undefined &&
        Number(training.signupCount || 0) >= Number(training.capacity)) {
      return refused('名额已满');
    }

    const nowIso = iso(fresh.now);
    const registration = {
      _id: key, schoolId: fresh.schoolId, association: fresh.association,
      trainingId: training._id, userId,
      signupStatus: TRAINING_SIGNUP_STATUS.REGISTERED, signedAt: nowIso,
      canceledAt: null, canceledBy: '', cancelReason: '',
      eligibilitySnapshot: {
        audienceMode: readAudience(training).audienceMode,
        hitGroupIds: hitGroupIds(training, hits),
        audienceLockedAt: training.audienceLockedAt || null,
        capturedAt: nowIso,
      },
      attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED,
      requestedAt: null, confirmedAt: null, confirmedBy: '',
      rejectedAt: null, rejectedBy: '', rejectionReason: '',
      pointEffectiveAt: null, revision: 1,
    };
    await tx.trainingRegistrations.set(key, registration);
    await bumpHitGroups(tx, hitGroupIds(training, hits), nowIso);
    const next = { ...training, signupCount: Number(training.signupCount || 0) + 1,
      audienceLockedAt: training.audienceLockedAt || nowIso,
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'registerTraining', 1),
      action: 'registerTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: userId, trainingId: training._id, targetUserId: userId, at: nowIso });
    return { ok: true, registration: myRegistrationDTO(registration),
      training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function cancelTrainingRegistration(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const reason = text(payload.reason, 200, { label: '取消原因' });
  if (!reason.ok) return ok(refused(reason.message));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return refused('训练不存在');
    const key = trainingRegistrationKey(training._id, userId, ctx);
    const reg = await tx.trainingRegistrations.getById(key);
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, training: trainingSummary(training, ctx.now.getTime()), message: '' };
    }
    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    // 待确认 / 已确认不得直接取消报名（§6.1）
    if (attendance === ATTENDANCE_STATUS.PENDING || attendance === ATTENDANCE_STATUS.CONFIRMED) {
      return refused('已提交或已确认签到，不能直接取消报名');
    }
    if (training.status !== TRAINING_STATUS.PUBLISHED) return refused('训练已取消或已结束，不能取消报名');
    if (!(ctx.now.getTime() < Date.parse(training.startAt))) return refused('报名已截止，不能取消');

    const nowIso = iso(ctx.now);
    await tx.trainingRegistrations.set(key, { ...reg, signupStatus: TRAINING_SIGNUP_STATUS.CANCELED,
      canceledAt: nowIso, canceledBy: userId, cancelReason: reason.value, revision: reg.revision + 1 });
    const next = { ...training, signupCount: Math.max(0, Number(training.signupCount || 0) - 1),
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'cancelTrainingRegistration', reg.revision + 1),
      action: 'cancelTrainingRegistration', schoolId: ctx.schoolId, association: ctx.association,
      actorId: userId, trainingId: training._id, targetUserId: userId, reason: reason.value, at: nowIso });
    return { ok: true, training: trainingSummary(next, ctx.now.getTime()), message: '' };
  });
  return ok(result);
}

/** 管理移除报名：占位者按 registered 递减人数；pending/confirmed 一并撤销签到资格（§8.2） */
async function removeTrainingRegistration(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));
  const reason = text(payload.reason, 200, { label: '移除原因' });
  if (!reason.ok) return ok(refused(reason.message));
  let pointsChanged = false;
  let pointsNeedRefresh = false;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以移除报名');
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, fresh)) return refused('训练不存在');
    const key = trainingRegistrationKey(training._id, payload.userId, fresh);
    const reg = await tx.trainingRegistrations.getById(key);
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }
    const nowIso = iso(fresh.now);
    await tx.trainingRegistrations.set(key, { ...reg, signupStatus: TRAINING_SIGNUP_STATUS.CANCELED,
      canceledAt: nowIso, canceledBy: fresh.actorId, cancelReason: reason.value,
      attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED, pointEffectiveAt: null,
      revision: reg.revision + 1 });
    const next = { ...training, signupCount: Math.max(0, Number(training.signupCount || 0) - 1),
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'removeTrainingRegistration', reg.revision + 1),
      action: 'removeTrainingRegistration', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId,
      reason: reason.value, at: nowIso });
    // 移除「已确认签到」的报名才会撤掉一条积分事实；pending / 未提交的移除不动分，
    // 别为它们白跑一次重算。
    if ((reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) === ATTENDANCE_STATUS.CONFIRMED) {
      const settled = await applyTrainingFactDelta(tx, fresh, {
        userId: payload.userId, delta: -1,
        effectiveAt: reg.pointEffectiveAt || training.startAt,
      });
      pointsChanged = settled.applied;
      pointsNeedRefresh = settled.needsRefresh;
    }
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  if (result && result.ok && (pointsChanged || pointsNeedRefresh)) await refreshAfterWrite(ctx);
  return ok(result);
}

/* ------------------------------------------- 两步签到状态机（P5） */

/** 事务内读取训练与目标用户的报名；不存在时返回 { error }。 */
async function loadTrainingAndRegistration(tx, ctx, trainingId, userId) {
  const training = await tx.associationTrainings.getById(trainingId);
  if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) {
    return { error: refused('训练不存在') };
  }
  const key = trainingRegistrationKey(training._id, userId, ctx);
  const reg = await tx.trainingRegistrations.getById(key);
  return { training, reg, key };
}

/**
 * 本人提交签到：registered / not_submitted（或 rejected）→ registered / pending。
 * 提交成功只表示「待负责人确认」，**不加分**（§3.4、§6.1）。
 */
async function requestTrainingCheckIn(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canParticipateInAssociation(fresh)) return refused('只有本协会有效会员可以签到');
    const loaded = await loadTrainingAndRegistration(tx, fresh, payload.trainingId, userId);
    if (loaded.error) return loaded.error;
    const { training, reg, key } = loaded;
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) return refused('请先报名再签到');
    if (training.status === TRAINING_STATUS.CANCELED) return refused('训练已取消');
    if (training.status !== TRAINING_STATUS.PUBLISHED) return refused('训练已结束，不能再签到');

    const nowMs = fresh.now.getTime();
    if (!inCheckInWindow(training, nowMs)) {
      return refused(nowMs < Date.parse(training.checkInOpenAt) ? '签到尚未开始' : '签到已结束');
    }
    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    if (attendance === ATTENDANCE_STATUS.CONFIRMED) return refused('签到已确认');
    // 重复提交幂等：已是待确认就返回现状，不重复加版本、不重复写审计。
    if (attendance === ATTENDANCE_STATUS.PENDING) {
      return { ok: true, registration: myRegistrationDTO(reg),
        training: trainingSummary(training, nowMs), message: '' };
    }

    const nowIso = iso(fresh.now);
    const next = { ...reg, attendanceStatus: ATTENDANCE_STATUS.PENDING, requestedAt: nowIso,
      rejectedAt: null, rejectedBy: '', rejectionReason: '', revision: reg.revision + 1 };
    await tx.trainingRegistrations.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'requestTrainingCheckIn', next.revision),
      action: 'requestTrainingCheckIn', schoolId: fresh.schoolId, association: fresh.association,
      actorId: userId, trainingId: training._id, targetUserId: userId, at: nowIso });
    return { ok: true, registration: myRegistrationDTO(next),
      training: trainingSummary(training, nowMs), message: '' };
  });
  return ok(result);
}

/**
 * 负责人确认签到：pending → confirmed，并复制 `pointEffectiveAt = training.startAt`。
 *
 * 【确认时复核身份（§8.2 / T25）】目标若已失去本协会会员身份，**拒绝确认**并在
 * **同一事务**自动移除其报名、释放名额、写审计；不是「标记待处理」。
 * 【会员动作不可跳过（T08）】只有 pending 才能确认，not_submitted 一律拒绝。
 */
async function confirmTrainingCheckIn(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));
  let pointsNeedRefresh = false;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以确认签到');
    const loaded = await loadTrainingAndRegistration(tx, fresh, payload.trainingId, payload.userId);
    if (loaded.error) return loaded.error;
    const { training, reg, key } = loaded;
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) return refused('该成员没有有效报名');
    if (training.status === TRAINING_STATUS.CANCELED) return refused('训练已取消，不能确认签到');

    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    // 重复确认幂等：返回现状，不加版本、不写审计（§9.3）。
    if (attendance === ATTENDANCE_STATUS.CONFIRMED) {
      return { ok: true, registration: myRegistrationDTO(reg),
        training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }
    if (attendance !== ATTENDANCE_STATUS.PENDING) return refused('该成员尚未提交签到');
    if (fresh.now.getTime() < Date.parse(training.startAt)) return refused('训练尚未开始，不能确认签到');
    if (Number.isInteger(payload.expectedRevision) && payload.expectedRevision !== reg.revision) {
      return refused('签到状态已更新，请刷新后重试');
    }

    const nowIso = iso(fresh.now);

    // 目标身份复核：失效则拒绝确认，并自动移除其报名（同一事务）。
    const targetCtx = await contextFor(tx, fresh, payload.userId);
    if (!canParticipateInAssociation(targetCtx)) {
      const autoReason = '已失去本协会会员身份，确认时自动移除';
      await tx.trainingRegistrations.set(key, { ...reg, signupStatus: TRAINING_SIGNUP_STATUS.CANCELED,
        canceledAt: nowIso, canceledBy: fresh.actorId, cancelReason: autoReason,
        attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED, pointEffectiveAt: null,
        revision: reg.revision + 1 });
      const nextTraining = { ...training, signupCount: Math.max(0, Number(training.signupCount || 0) - 1),
        revision: training.revision + 1, updatedAt: nowIso };
      await tx.associationTrainings.set(nextTraining._id, nextTraining);
      await tx.audit.append({ _id: signupAuditKey(key, 'autoRemoveOnConfirm', reg.revision + 1),
        action: 'autoRemoveOnConfirm', schoolId: fresh.schoolId, association: fresh.association,
        actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId,
        reason: autoReason, at: nowIso });
      return refused('该成员已失去本协会会员身份，已自动移除其报名');
    }

    const next = { ...reg, attendanceStatus: ATTENDANCE_STATUS.CONFIRMED, confirmedAt: nowIso,
      confirmedBy: fresh.actorId, rejectedAt: null, rejectedBy: '', rejectionReason: '',
      pointEffectiveAt: training.startAt, revision: reg.revision + 1 };
    await tx.trainingRegistrations.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'confirmTrainingCheckIn', next.revision),
      action: 'confirmTrainingCheckIn', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId, at: nowIso });
    // 确认签到 = 多一条 +1 的训练积分事实：同一事务里增量加减（见 season-points.js），
    // 物化值不干净时才退回整次重算。
    const settled = await applyTrainingFactDelta(tx, fresh, {
      userId: payload.userId, delta: 1, effectiveAt: training.startAt,
    });
    pointsNeedRefresh = settled.needsRefresh;
    return { ok: true, registration: myRegistrationDTO(next),
      training: trainingSummary(training, fresh.now.getTime()), message: '' };
  });
  if (result && result.ok && pointsNeedRefresh) await refreshAfterWrite(ctx);
  return ok(result);
}

/** 负责人退回签到：pending → rejected，必须给出原因；会员可在窗口内重新提交（§6.1）。 */
async function rejectTrainingCheckIn(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));
  const reason = text(payload.reason, 200, { required: true, label: '退回原因' });
  if (!reason.ok) return ok(refused(reason.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以退回签到');
    const loaded = await loadTrainingAndRegistration(tx, fresh, payload.trainingId, payload.userId);
    if (loaded.error) return loaded.error;
    const { training, reg, key } = loaded;
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) return refused('该成员没有有效报名');
    if (training.status === TRAINING_STATUS.CANCELED) return refused('训练已取消，不能退回签到');
    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    if (attendance === ATTENDANCE_STATUS.REJECTED) {
      return { ok: true, registration: myRegistrationDTO(reg),
        training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }
    if (attendance !== ATTENDANCE_STATUS.PENDING) return refused('只能退回「待确认」的签到');
    if (Number.isInteger(payload.expectedRevision) && payload.expectedRevision !== reg.revision) {
      return refused('签到状态已更新，请刷新后重试');
    }

    const nowIso = iso(fresh.now);
    const next = { ...reg, attendanceStatus: ATTENDANCE_STATUS.REJECTED, rejectedAt: nowIso,
      rejectedBy: fresh.actorId, rejectionReason: reason.value, revision: reg.revision + 1 };
    await tx.trainingRegistrations.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'rejectTrainingCheckIn', next.revision),
      action: 'rejectTrainingCheckIn', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId,
      reason: reason.value, at: nowIso });
    return { ok: true, registration: myRegistrationDTO(next),
      training: trainingSummary(training, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

/**
 * 负责人撤销确认：confirmed → pending，必须给出原因；撤销即令对应训练积分资格失效
 * （事实只在 confirmed 时成立，回到 pending 后不再计分，见 training-points.js）。
 */
async function revokeTrainingCheckIn(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));
  let pointsNeedRefresh = false;
  const reason = text(payload.reason, 200, { required: true, label: '撤销原因' });
  if (!reason.ok) return ok(refused(reason.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以撤销确认');
    const loaded = await loadTrainingAndRegistration(tx, fresh, payload.trainingId, payload.userId);
    if (loaded.error) return loaded.error;
    const { training, reg, key } = loaded;
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) return refused('该成员没有有效报名');
    if (training.status === TRAINING_STATUS.CANCELED) return refused('训练已取消，不能撤销确认');
    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    if (attendance !== ATTENDANCE_STATUS.CONFIRMED) return refused('只能撤销「已确认」的签到');
    if (Number.isInteger(payload.expectedRevision) && payload.expectedRevision !== reg.revision) {
      return refused('签到状态已更新，请刷新后重试');
    }

    const nowIso = iso(fresh.now);
    const next = { ...reg, attendanceStatus: ATTENDANCE_STATUS.PENDING, confirmedAt: null,
      confirmedBy: '', pointEffectiveAt: null, rejectedAt: null, rejectedBy: '',
      rejectionReason: '', revision: reg.revision + 1 };
    await tx.trainingRegistrations.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'revokeTrainingCheckIn', next.revision),
      action: 'revokeTrainingCheckIn', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId,
      reason: reason.value, at: nowIso });
    // 撤销确认 = 撤回一条训练积分事实：同一事务里 −1，物化值不干净时退回整次重算。
    const settled = await applyTrainingFactDelta(tx, fresh, {
      userId: payload.userId, delta: -1, effectiveAt: training.startAt,
    });
    pointsNeedRefresh = settled.needsRefresh;
    return { ok: true, registration: myRegistrationDTO(next),
      training: trainingSummary(training, fresh.now.getTime()), message: '' };
  });
  if (result && result.ok && pointsNeedRefresh) await refreshAfterWrite(ctx);
  return ok(result);
}

/**
 * 赛季重置：把本范围上一赛季尚未确认的 pending 签到自动退回（§6.3 第 1 条）。
 * 返回被退回的条数。
 *
 * 【接入状态（2026-10-17 只读审计 C10 校正）】
 * 产品口径 T15 已定「赛季重置时未确认签到自动退回」，本函数是该口径的实现，
 * 并有 tests/training-checkin.test.js 的 T15 用例守着行为。但 **resetSchoolSeason
 * 当前并不调用它**——注释从前写的「调用位置：赛季重置流程」是过期表述，别据此
 * 以为它已经在跑。接入前有两个已知缺口要先解决：
 *   1. 原子性：内存仓储的 forScope().list() 不允许在事务内调用，本函数目前是
 *      「事务外扫描 + 逐条写」——真库上中途失败会留下退了一半的状态；
 *      接入时应改为「事务外取 id 清单 → 事务内按 id 批量写」。
 *   2. 归属：退回写入 actorId 'system'，审计链上看不到是哪个管理员触发的重置。
 *
 * @param {Object} repo 仓储
 * @param {Object} ctx 固定 scope 的上下文（actorId 可为 system）
 * @param {string} [reason]
 * @returns {Promise<number>} 被退回的签到条数
 */
async function returnPendingOnSeasonReset(repo, ctx, reason = '赛季已重置，未确认自动退回') {
  const nowIso = iso(ctx.now);
  const rows = (await repo.forScope(ctx).trainingRegistrations.list())
    .filter(reg => reg.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED &&
      (reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) === ATTENDANCE_STATUS.PENDING);
  for (const reg of rows) {
    await repo.trainingRegistrations.set(reg._id, { ...reg,
      attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED, rejectedAt: nowIso, rejectedBy: 'system',
      rejectionReason: reason, revision: reg.revision + 1 });
    await repo.audit.append({ _id: signupAuditKey(reg._id, 'seasonResetReturn', reg.revision + 1),
      action: 'seasonResetReturn', schoolId: ctx.schoolId, association: ctx.association,
      actorId: 'system', trainingId: reg.trainingId, targetUserId: reg.userId, reason, at: nowIso });
  }
  return rows.length;
}

module.exports = {
  TITLE_MIN, TITLE_MAX, DESCRIPTION_MAX, LOCATION_MAX, CAPACITY_MAX,
  DEFAULT_DURATION_MS, CHECKIN_LEAD_MS,
  TRAINING_STATE, TRAINING_STATE_LABEL, ATTENDANCE_STATUS, ATTENDANCE_STATUS_LABEL,
  parseTime, normalizeCapacity, trainingState, countRegistered,
  listTrainings, getTraining, listTrainingRegistrations,
  publishTraining, updateTraining, cancelTraining, finishTraining,
  registerTraining, cancelTrainingRegistration, removeTrainingRegistration,
  requestTrainingCheckIn, confirmTrainingCheckIn, rejectTrainingCheckIn, revokeTrainingCheckIn,
  returnPendingOnSeasonReset,
};
