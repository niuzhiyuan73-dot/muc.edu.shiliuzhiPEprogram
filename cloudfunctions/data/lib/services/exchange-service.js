/** S4 跨校邀请赛。独立集合，服务端强制不计校内分。2026-10-16 起支持与普通赛事同样的六种赛制。 */
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('./school-permission.js');
const { schoolKey, schoolAssociationKey, schoolMemberKey, PLATFORM_ROLE, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { planExchangeDraw, planExchangeMatches, changedExchangeMatches, placementsFromExchange } = require('./exchange-plan.js');
const { formatOf, normalizeGroupCount, normalizeAdvancePerGroup } = require('./draw.js');
const {
  EVENT_FORMAT, EVENT_FORMAT_LABEL, DEFAULT_EVENT_FORMAT,
  GROUP_COUNT_FORMATS, ADVANCE_FORMATS, KNOCKOUT_FORMATS, DOUBLE_ELIM_FORMATS,
  EVENT_BRONZE_MODE, EVENT_PLACEMENT_MODE, DEFAULT_BRONZE_MODE, DEFAULT_PLACEMENT_MODE,
  DEFAULT_GF_RESET, BRACKET_STAGE, stageOrder,
} = require('../utils/constants.js');

const FORMAT_VALUES = Object.values(EVENT_FORMAT);

/** 阶段文案（对阵列表用；与普通赛事同一套 BRACKET_STAGE） */
const STAGE_TEXT = {
  [BRACKET_STAGE.MAIN]: '正赛',
  [BRACKET_STAGE.BRONZE]: '三四名赛',
  [BRACKET_STAGE.GROUP]: '小组赛',
  [BRACKET_STAGE.WINNERS]: '胜者组',
  [BRACKET_STAGE.LOSERS]: '败者组',
  [BRACKET_STAGE.GRAND_FINAL]: '总决赛',
  [BRACKET_STAGE.PLACEMENT]: '排位赛',
};

/**
 * 赛制参数收敛。
 * 只保留该赛制真正用得到的字段，其余一律落缺省——免得「单败淘汰」的赛事
 * 里躺着一个幽灵般的 gfReset，日后没人说得清它当初为什么在那儿。
 *
 * @param {Object} payload 创建表单
 * @returns {Object} 可直接并进赛事记录的赛制字段
 */
function normalizeExchangeFormat(payload = {}) {
  const format = FORMAT_VALUES.includes(payload.format) ? payload.format : DEFAULT_EVENT_FORMAT;
  const config = {
    format,
    bronzeMode: DEFAULT_BRONZE_MODE,
    placementMode: DEFAULT_PLACEMENT_MODE,
    gfReset: DEFAULT_GF_RESET,
  };
  if (GROUP_COUNT_FORMATS.includes(format)) config.groupCount = normalizeGroupCount(payload.groupCount);
  if (ADVANCE_FORMATS.includes(format)) config.advancePerGroup = normalizeAdvancePerGroup(payload.advancePerGroup);
  if (KNOCKOUT_FORMATS.includes(format)) {
    config.bronzeMode = payload.bronzeMode === EVENT_BRONZE_MODE.PLAYOFF
      ? EVENT_BRONZE_MODE.PLAYOFF : EVENT_BRONZE_MODE.TIED;
    config.placementMode = payload.placementMode === EVENT_PLACEMENT_MODE.TOP8
      ? EVENT_PLACEMENT_MODE.TOP8 : EVENT_PLACEMENT_MODE.NONE;
  }
  if (DOUBLE_ELIM_FORMATS.includes(format)) {
    config.gfReset = payload.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(payload.gfReset);
  }
  return config;
}

const ok = data => ({ ok: true, data });
const refused = message => ({ ok: false, message });
const invitationKey = (eventId, schoolId) => schoolKey('xi', eventId, schoolId);
const signupKey = (eventId, userId) => schoolKey('xs', eventId, userId);
const freshContext = (repo, ctx) => buildSchoolContext({ repo, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
const manages = ctx => canSchoolAction(ctx, 'manageAssociation', ctx);
const participates = ctx => canSchoolAction(ctx, 'participate', ctx);
const eventMatches = (event, ctx) => event && event.eventScope === 'inter_school' &&
  event.ratingPolicy === 'unrated' && event.association === ctx.association &&
  Object.prototype.hasOwnProperty.call(event.invitations, ctx.schoolId);
const canSee = (event, ctx) => eventMatches(event, ctx) &&
  (manages(ctx) || event.invitations[ctx.schoolId] === 'accepted' && participates(ctx));
const isPlatformAdmin = ctx => Boolean(ctx.actor && ctx.actor.platformRole === PLATFORM_ROLE.ADMIN &&
  ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE);
// 抽签、指定裁判、名次确认：平台管理员或参赛双方的校管理员。
const managesExchange = (event, ctx) => Boolean(event && event.eventScope === 'inter_school' &&
  event.ratingPolicy === 'unrated' && event.association === ctx.association &&
  (isPlatformAdmin(ctx) || eventMatches(event, ctx) && manages(ctx)));
const managesParticipant = (event, ctx) => Boolean(eventMatches(event, ctx) && manages(ctx));
// 比分确认：管理员或双方校管理员；设了裁判则限裁判；未设裁判才轮到比赛双方。
const canScoreMatch = (event, match, ctx) => {
  if (!event || !match || event.eventScope !== 'inter_school' || event.ratingPolicy !== 'unrated' ||
      event.association !== ctx.association || !ctx.actor ||
      ctx.actor.platformStatus !== PLATFORM_STATUS.ACTIVE) return false;
  if (isPlatformAdmin(ctx) || managesParticipant(event, ctx)) return true;
  // 锁定名册不代表账号与学籍永远有效；录分与事务复核都必须使用当前身份。
  if (!eventMatches(event, ctx) || event.invitations[ctx.schoolId] !== 'accepted' || !participates(ctx)) return false;
  if (match.referee) return ctx.actorId === match.referee;
  return (ctx.actorId === match.playerA && ctx.schoolId === match.schoolA)
    || (ctx.actorId === match.playerB && ctx.schoolId === match.schoolB);
};
const summary = event => ({
  _id: event._id, schoolId: event.schoolId, association: event.association,
  title: event.title, location: event.location, startTime: event.startTime, status: event.status,
  schoolNames: event.schoolNames, participantSchoolIds: event.participantSchoolIds,
  invitations: event.invitations, quota: event.quota, schoolQuotas: event.schoolQuotas,
  signupCount: event.signupCount, schoolCounts: event.schoolCounts,
  ratingPolicy: 'unrated', eventScope: 'inter_school', matchType: 'singles',
  // 赛制与它的参数：读端据此在页面上展示「单败淘汰」「小组赛+淘汰」等
  format: formatOf(event), formatLabel: EVENT_FORMAT_LABEL[formatOf(event)] || '',
  groupCount: event.groupCount || 0, advancePerGroup: event.advancePerGroup || 0,
  bronzeMode: event.bronzeMode || DEFAULT_BRONZE_MODE,
  placementMode: event.placementMode || DEFAULT_PLACEMENT_MODE,
  gfReset: event.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(event.gfReset),
  draw: event.draw || null, results: event.results || [],
  canceledAt: event.canceledAt || null, canceledBy: event.canceledBy || '',
  cancelReason: event.cancelReason || '',
});
async function audit(tx, ctx, event, action) {
  await tx.audit.append({ _id: schoolKey('xa', event._id, String(event.revision)), action,
    eventId: event._id, schoolId: ctx.schoolId, actorId: ctx.actorId, at: ctx.now });
}

async function createExchangeEvent(payload = {}, ctx) {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const location = typeof payload.location === 'string' ? payload.location.trim() : '';
  const token = payload.requestId;
  const ids = payload.participantSchoolIds;
  if (!title || title.length > 80 || !location || location.length > 120) return ok(refused('请填写赛事名称和地点'));
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) return ok(refused('创建请求编号无效'));
  const start = new Date(payload.startTime);
  if (!Number.isFinite(start.getTime()) || start <= new Date(ctx.now)) return ok(refused('请选择未来的开赛时间'));
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length ||
      !ids.includes(ctx.schoolId) || ids.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id))) return ok(refused('请选择含主办校在内的 2 至 8 所学校'));
  const quota = payload.quota;
  const quotas = payload.schoolQuotas || {};
  if (!Number.isInteger(quota) || quota < 2 || quota > 128 || ids.some(id =>
    !Number.isInteger(quotas[id]) || quotas[id] < 1 || quotas[id] > quota) ||
    ids.reduce((sum, id) => sum + quotas[id], 0) < quota) return ok(refused('请设置有效的总名额和各校名额'));
  const schoolIds = [...ids].sort();
  const schoolQuotas = Object.fromEntries(schoolIds.map(id => [id, quotas[id]]));
  // 赛制进指纹：同一请求编号下改了赛制就该被拒绝，而不是静默沿用旧的那一场
  const formatConfig = normalizeExchangeFormat(payload);
  const fingerprint = JSON.stringify([title, location, start.toISOString(), schoolIds, quota, schoolQuotas, formatConfig]);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!manages(fresh)) return refused('只有本校管理员或协会负责人可以发起邀请赛');
    const id = schoolKey('xe', fresh.schoolId, fresh.association, fresh.actorId, token);
    const existing = await tx.exchangeEvents.getById(id);
    if (existing) return existing.fingerprint === fingerprint
      ? { ok: true, event: summary(existing), message: '' } : refused('请求编号已使用，请重新创建');
    const schoolNames = {};
    for (const schoolId of schoolIds) {
      const school = await tx.schools.getById(schoolId);
      const association = await tx.schoolAssociations.getById(schoolAssociationKey({ schoolId, association: fresh.association }));
      if (!school || school.schoolId !== schoolId || school.status !== 'active' || !association || association.status !== 'active' ||
          association.schoolId !== schoolId || association.association !== fresh.association) return refused('参与学校或项目未启用');
      schoolNames[schoolId] = school.name;
    }
    const event = { _id: id, schoolId: fresh.schoolId, association: fresh.association, title, location,
      startTime: start.toISOString(), participantSchoolIds: schoolIds, schoolNames, quota, schoolQuotas,
      invitations: Object.fromEntries(schoolIds.map(schoolId => [schoolId, schoolId === fresh.schoolId ? 'accepted' : 'pending'])),
      schoolCounts: Object.fromEntries(schoolIds.map(schoolId => [schoolId, 0])), signupCount: 0,
      status: 'signup', eventScope: 'inter_school', ratingPolicy: 'unrated', matchType: 'singles',
      // 赛制与参数（见 normalizeExchangeFormat）：项目仍固定单打，赛制可选
      ...formatConfig,
      revision: 1, fingerprint, createdBy: fresh.actorId, createdAt: fresh.now };
    await tx.exchangeEvents.set(id, event);
    for (const schoolId of schoolIds) await tx.exchangeInvitations.set(invitationKey(id, schoolId), {
      eventId: id, schoolId, association: fresh.association,
    });
    await audit(tx, fresh, event, 'createExchangeEvent');
    return { ok: true, event: summary(event), message: '' };
  });
  return ok(result);
}

async function respondExchangeInvitation(payload = {}, ctx) {
  if (!['accepted', 'declined'].includes(payload.decision)) return ok(refused('邀请决定无效'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || !manages(fresh) || event.schoolId === fresh.schoolId) return refused('没有此邀请的处理权限');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (event.invitations[fresh.schoolId] === payload.decision) return { ok: true, event: summary(event), message: '' };
    if (event.status !== 'signup' || event.invitations[fresh.schoolId] !== 'pending') return refused('邀请已处理或报名已锁定');
    const next = { ...event, invitations: { ...event.invitations, [fresh.schoolId]: payload.decision }, revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'respondExchangeInvitation');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function changeSignup(payload, ctx, cancel) {
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || !participates(fresh) || event.invitations[fresh.schoolId] !== 'accepted') return refused('仅已接受邀请学校的有效会员可以操作');
    if (event.status !== 'signup' || new Date(event.startTime) <= new Date(fresh.now)) return refused('报名已截止或名单已锁定');
    const id = signupKey(event._id, fresh.actorId);
    const previous = await tx.exchangeSignups.getById(id);
    if (previous && previous.representedSchoolId !== fresh.schoolId) return refused('不能变更本赛事代表学校');
    if (cancel && (!previous || previous.status !== 'signed')) return refused('没有可取消的报名');
    if (!cancel && previous && previous.status === 'signed') return { ok: true, event: summary(event), message: '' };
    if (!cancel && (event.signupCount >= event.quota || event.schoolCounts[fresh.schoolId] >= event.schoolQuotas[fresh.schoolId])) return refused('总名额或本校名额已满');
    const delta = cancel ? -1 : 1;
    const next = { ...event, signupCount: event.signupCount + delta,
      schoolCounts: { ...event.schoolCounts, [fresh.schoolId]: event.schoolCounts[fresh.schoolId] + delta }, revision: event.revision + 1 };
    await tx.exchangeSignups.set(id, { _id: id, eventId: event._id, schoolId: event.schoolId,
      association: event.association, userId: fresh.actorId, representedSchoolId: fresh.schoolId,
      schoolMemberId: fresh.schoolMember._id, nickName: fresh.actor.nickName || '参赛会员',
      schoolName: event.schoolNames[fresh.schoolId], status: cancel ? 'canceled' : 'signed', updatedAt: fresh.now });
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, cancel ? 'cancelExchangeSignup' : 'signUpExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}
const signUpExchangeEvent = (payload = {}, ctx) => changeSignup(payload, ctx, false);
const cancelExchangeSignup = (payload = {}, ctx) => changeSignup(payload, ctx, true);

/**
 * 管理员移除一位报名者（退赛处理）。
 * ============================================================
 * 与本人取消报名同一口径：**只在报名阶段**（名单锁定后名单就定了），
 * 释放总名额与本校名额，写审计；重复移除幂等。普通赛事里这条路对应
 * 「管理员把某人从报名名单里去掉」，因此参赛者的代表学校由服务端从报名
 * 记录读取，不接受客户端传学校。
 *
 * @param {Object} payload { eventId, userId, reason? }
 * @param {Object} ctx
 */
async function removeExchangeSignup(payload = {}, ctx) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请选择要移除的报名者'));
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 200) : '';
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以移除报名'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以移除报名');
    if (event.status !== 'signup') return refused('名单已锁定，不能再移除报名');
    const row = await tx.exchangeSignups.getById(signupKey(event._id, userId));
    if (!row || row.status !== 'signed') return { ok: true, event: summary(event), message: '' };
    if (!isPlatformAdmin(fresh) && row.representedSchoolId !== fresh.schoolId) {
      return refused('只能移除本校的报名者');
    }
    const next = { ...event,
      signupCount: Math.max(0, event.signupCount - 1),
      schoolCounts: { ...event.schoolCounts,
        [row.representedSchoolId]: Math.max(0, (event.schoolCounts[row.representedSchoolId] || 0) - 1) },
      revision: event.revision + 1 };
    await tx.exchangeSignups.set(row._id, { ...row, status: 'removed', removedBy: fresh.actorId,
      removedAt: fresh.now, removeReason: reason, revision: Number(row.revision || 1) + 1 });
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'removeExchangeSignup');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 代签：与普通赛事一样，由管理员在场边替参赛者签到（本人不自助签到）。
 * 只有「名单已锁定（ready / drawn）」到赛事结束之间可签，重复签到幂等。
 *
 * @param {Object} payload { eventId, userId }
 * @param {Object} ctx
 */
async function checkInExchangeSignup(payload = {}, ctx) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请选择要签到的参赛者'));
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以签到'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以签到');
    if (event.status !== 'ready' && event.status !== 'drawn') return refused('名单锁定后才能签到');
    // 签到只认名册快照：不在名册上的人（含锁定前被剔除的失效身份）一律签不了。
    const entrant = (Array.isArray(event.roster) ? event.roster : [])
      .find(row => row.userId === userId);
    if (!entrant) return refused('这位参赛者不在名单里');
    if (!isPlatformAdmin(fresh) && entrant.representedSchoolId !== fresh.schoolId) {
      return refused('只能为本校参赛者签到');
    }
    const checkIns = event.checkIns || {};
    if (checkIns[userId]) return { ok: true, event: summary(event), message: '' };
    // 一个人一条签到，写的仍是赛事这一个文档：操作数与人数无关。
    // revision 一起 +1，让并发的两次签到在云端撞上写冲突后重试，不会互相覆盖。
    const next = { ...event, checkIns: { ...checkIns, [userId]: fresh.now }, revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'checkInExchangeSignup');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 撤回邀请。
 * ============================================================
 * 主办方可以撤回对某校的邀请；受邀校自己的管理员也可以撤回（等价于「不参加了」，
 * 但它不是婉拒——婉拒是受邀校给主办方的答复，撤回是把这条邀请作废）。
 * 只在报名阶段可撤；该校已经有人报名时先拒绝，要求先把报名清掉——
 * 否则名额计数与参赛名单会对不上。
 *
 * @param {Object} payload { eventId, schoolId? } schoolId 缺省为操作者本校
 */
async function withdrawExchangeInvitation(payload = {}, ctx) {
  const schoolId = String(payload.schoolId || ctx.schoolId || '').trim();
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以撤回邀请'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以撤回邀请');
    // 主办方可以撤任意受邀校；受邀校只能撤自己那一条
    const isOrganizer = event.schoolId === fresh.schoolId || isPlatformAdmin(fresh);
    if (!isOrganizer && schoolId !== fresh.schoolId) return refused('只能撤回本校的邀请');
    if (!Object.prototype.hasOwnProperty.call(event.invitations, schoolId)) return refused('该学校不在这场邀请赛里');
    if (event.schoolId === schoolId) return refused('主办学校不能撤回自己的邀请');
    if (event.status !== 'signup') return refused('名单已锁定，不能再撤回邀请');
    if ((event.schoolCounts[schoolId] || 0) > 0) return refused('该校已有人报名，请先移除报名再撤回邀请');
    if (event.invitations[schoolId] === 'withdrawn') return { ok: true, event: summary(event), message: '' };
    const next = { ...event, invitations: { ...event.invitations, [schoolId]: 'withdrawn' },
      revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'withdrawExchangeInvitation');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 取消整场邀请赛（主办方或平台管理员）。
 * 报名中 / 待开赛 / 已抽签都可取消；结束后不能再取消（名次已定）。
 * 取消后一切写动作停止（报名、抽签、录分、名次确认各自复核状态），
 * 已确认的比分与名单保留作为历史。
 *
 * @param {Object} payload { eventId, reason? }
 */
async function cancelExchangeEvent(payload = {}, ctx) {
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 200) : '';
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!snapshot || !eventMatches(snapshot, ctx) && !isPlatformAdmin(ctx)) return ok(refused('赛事不存在或没有访问权限'));
  const isOrganizer = isPlatformAdmin(ctx) || (snapshot.schoolId === ctx.schoolId && manages(ctx));
  if (!isOrganizer) return ok(refused('只有主办学校的管理员可以取消赛事'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!event || event.eventScope !== 'inter_school') return refused('赛事不存在');
    if (!(isPlatformAdmin(fresh) || (event.schoolId === fresh.schoolId && manages(fresh)))) {
      return refused('只有主办学校的管理员可以取消赛事');
    }
    if (event.status === 'canceled') return { ok: true, event: summary(event), message: '' };
    if (event.status === 'finished') return refused('赛事已结束，不能再取消');
    const next = { ...event, status: 'canceled', canceledAt: fresh.now,
      canceledBy: fresh.actorId, cancelReason: reason, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'cancelExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 【撤销比分已取消】
 * 跨校邀请赛的已确认比分同样不可撤销（Elo 逐场结算改造：确认即最终结论，
 * 个人赛与交流赛同一规则）。原 revokeExchangeScore 已删除；比分录错时的
 * 处理口径：已结束的赛事以最终名次为准，进行中的赛事由裁判/管理员按实际
 * 重录——不再提供把已确认比分退回待确认的入口。
 *
 * @param {Object} payload { eventId, reason? }
 */
/**
 * 锁名前复查：报名者此刻还能不能代表这个学校参赛。
 *
 * 【为什么放在事务外】（2026-10-21 云端容量改造）
 * 每人要读会员、用户、学校三张表。原实现把这段读放在事务里，于是事务操作数
 * 随人数线性增长（3 读 + 1 写 / 人），200 人报名就是 800 次——超出云开发事务
 * 总操作数上限（约 100）整整 8 倍，**跨校赛根本锁不上名单**。
 * 现在这段只在事务外按主键读（不占事务预算），事务里只留「版本比对 + 一次写」。
 *
 * @param {Object} repo 仓储
 * @param {Array<Object>} signups 状态为 signed 的报名行
 * @returns {Promise<{roster:Array<Object>, pruned:Array<Object>}>}
 */
async function reviewEntrants(repo, signups) {
  const roster = [];
  const pruned = [];
  for (const row of signups) {
    const [member, user, school] = await Promise.all([
      repo.schoolMembers.getById(row.schoolMemberId),
      repo.users.getById(row.userId),
      repo.schools.getById(row.representedSchoolId),
    ]);
    const valid = member && member.userId === row.userId && member.schoolId === row.representedSchoolId &&
      member.status === 'active' && user && user.platformStatus === 'active' &&
      user.primarySchoolId === row.representedSchoolId && school && school.status === 'active';
    if (!valid) {
      pruned.push({ userId: row.userId, representedSchoolId: row.representedSchoolId });
      continue;
    }
    // 名册条目带齐下游要用的四样：身份、代表学校、昵称、校名。
    // 抽签 / 录分 / 名次 / 签到从此只读这份名册，不再回查报名表。
    roster.push({
      userId: row.userId,
      representedSchoolId: row.representedSchoolId,
      schoolId: row.representedSchoolId,
      schoolMemberId: row.schoolMemberId,
      nickName: row.nickName || '',
      schoolName: row.schoolName || '',
    });
  }
  return { roster, pruned };
}

/**
 * 锁定报名名单 —— 产出一份**名册快照**。
 *
 * 【为什么是快照，而不是把每条报名改成 locked】（2026-10-21）
 * 原实现逐条改报名状态，事务操作数 ≈ 4N。云开发事务总操作数上限约 100，
 * 跨校邀请赛按 200 人报名算就是 800 次，功能直接不可用；而本地测试只有
 * 2~4 人，永远照不出来。
 *
 * 语义上本来也该是快照：「锁定」是一次**事件**，产出的是「这一场谁上场」的
 * 名册，不是对 N 条报名记录的状态迁移。锁定之后抽签、录分、名次、签到全部
 * 读这份名册，报名表退化为历史流水。
 *
 * 现在的操作数是**常数**：读赛事 1 + 写赛事 1 + 审计 1~2，与人多人少无关。
 *
 * 【身份复查没有丢】
 * 退学 / 转校 / 停用的报名者仍在锁定前剔除（见 reviewEntrants），只是这段读
 * 移到了事务外；剔除结果记进 prunedSignups 供追溯。报名行本身不再改写——
 * 锁定后本来就不允许再报名或移除，历史保持原样。
 */
async function lockExchangeRoster(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!eventMatches(snapshot, ctx) || snapshot.schoolId !== ctx.schoolId || !manages(ctx)) return ok(refused('只有主办学校可以锁定名单'));
  if (snapshot.status !== 'signup') return ok(refused('名单已锁定'));
  const signups = (await ctx.repo.exchangeSignups.listByEvent(snapshot._id)).filter(row => row.status === 'signed');
  const reviewed = await reviewEntrants(ctx.repo, signups);
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || event.schoolId !== fresh.schoolId || !manages(fresh)) return refused('只有主办学校可以锁定名单');
    if (event.status !== 'signup') return refused('名单已锁定');
    // 复查期间可能有人报名或退出：版本不一致就要求重来，避免锁进一份过期名册。
    if (event.revision !== snapshot.revision) return refused('报名名单已变化，请刷新后重试');
    if (Object.values(event.invitations).some(value => value === 'pending')) return refused('请等待受邀学校处理邀请');
    if (signups.length !== event.signupCount) return refused('报名计数不一致，请联系管理员');

    const { roster, pruned } = reviewed;
    if (roster.length < 2 || new Set(roster.map(row => row.representedSchoolId)).size < 2) {
      return refused(pruned.length
        ? '清理失效身份后不足两校各一名参赛者，请补充报名'
        : '至少需要两校各有一名参赛者');
    }
    // 名额计数按名册重算，与锁定后的权威来源保持一致
    const schoolCounts = {};
    for (const row of roster) {
      schoolCounts[row.representedSchoolId] = (schoolCounts[row.representedSchoolId] || 0) + 1;
    }
    const next = { ...event, status: 'ready', lockedAt: fresh.now, lockedBy: fresh.actorId,
      roster,        // 名册快照：锁定之后唯一的参赛者来源
      checkIns: {},  // 签到表 userId → 时间；逐人一条，仍只写这一个文档
      signupCount: roster.length,
      schoolCounts,
      prunedSignups: pruned,
      revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'lockExchangeRoster');
    if (pruned.length > 0) await audit(tx, fresh, next, 'pruneInvalidExchangeSignups');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 名册快照 → 参赛者。
 *
 * 锁定之后唯一的来源是 `event.roster`（见 lockExchangeRoster），不再回查报名表：
 * 报名表在锁定后不会变化，回查既多一次读，也让「谁在名单上」有两个答案。
 *
 * @param {Object} event 赛事文档
 * @returns {{rows: Array<Object>, map: Map<string, {userId:string, schoolId:string}>}}
 */
function entrantsOf(event) {
  const rows = Array.isArray(event.roster) ? event.roster : [];
  return { rows, map: new Map(rows.map(row => [row.userId, { userId: row.userId, schoolId: row.representedSchoolId }])) };
}

async function drawExchangeEvent(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以抽签'));
  if (snapshot.status === 'canceled') return ok(refused('赛事已取消'));
  if (snapshot.status === 'signup') return ok(refused('请先锁定报名名单'));
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再抽签'));
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  if (existing.some(match => match.status === 'active')) return ok(refused('已有比赛确认生效，不能再抽签'));
  const { rows, map } = entrantsOf(snapshot);
  if (rows.length < 2) return ok(refused('至少需要两名参赛者才能抽签'));
  // 种子只认「本身就是有限数字」的入参：Number(null)===0、Number('')===0，
  // 从前 null/空串会落成确定性种子，跨校签位可被穷举复现（2026-10-17 审计 C6）。
  const seedValue = typeof payload.seedValue === 'number' && Number.isFinite(payload.seedValue)
    ? payload.seedValue : ctx.now.getTime();
  const planned = planExchangeDraw({ entries: rows, seedValue, format: formatOf(snapshot),
    groupCount: snapshot.groupCount, advancePerGroup: snapshot.advancePerGroup });
  if (!planned.ok) return ok(refused(planned.message));
  // 重抽时按当前签表整体重算，旧对阵的残留记录不会被投影出来。
  const built = planExchangeMatches({ event: snapshot, draw: planned.draw, entrantsById: map, matches: [] });
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以抽签');
    if (event.status !== 'ready' && event.status !== 'drawn') return refused('当前状态不能抽签');
    if (event.revision !== snapshot.revision) return refused('赛事已变化，请刷新后重试');
    const next = { ...event, status: 'drawn',
      draw: { ...planned.draw, createdAt: fresh.now, createdBy: fresh.actorId }, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    for (const match of built.matches) {
      await tx.exchangeMatches.set(match._id, { ...match, schoolId: event.schoolId, association: event.association });
    }
    await audit(tx, fresh, next, 'drawExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function assignExchangeReferee(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以指定裁判'));
  const match = await ctx.repo.exchangeMatches.getById(payload.matchId);
  if (!match || match.eventId !== snapshot._id) return ok(refused('比赛不存在'));
  if (match.status !== 'pending') return ok(refused('比赛已确认比分，不能再改派裁判'));
  const refereeId = typeof payload.refereeId === 'string' ? payload.refereeId.trim() : '';
  let memberId = '';
  if (refereeId) {
    // 【只点读参赛校那几份学籍】（2026-10-26 第五轮审查 C）
    // 原先是 `ctx.repo.schoolMembers.list()`——那是**基础仓储**的 list()，条件是空对象，
    // 等于把全平台所有学校的名册读回来再挑一个 userId。跨校赛事只关心参赛校，
    // 而学籍主键是确定性的（`sm:<schoolId>:<userId>`），逐个点读就够。
    const schools = (snapshot.participantSchoolIds || []).filter(id => snapshot.invitations[id] === 'accepted');
    const candidates = await Promise.all(schools.map(schoolId => ctx.repo
      .forScope({ schoolId, association: ctx.association })
      .schoolMembers.getById(schoolMemberKey(refereeId, schoolId))));
    const found = candidates.find(row => row && row.userId === refereeId
      && row.status === SCHOOL_MEMBER_STATUS.ACTIVE && schools.includes(row.schoolId));
    if (!found) return ok(refused('裁判必须是参赛学校的有效会员'));
    memberId = found._id;
  }
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以指定裁判');
    if (event.status === 'canceled') return refused('赛事已取消');
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!current || current.eventId !== event._id) return refused('比赛不存在');
    if (current.status !== 'pending') return refused('比赛已确认比分，不能再改派裁判');
    if (event.revision !== snapshot.revision || current.revision !== match.revision) return refused('赛事已变化，请刷新后重试');
    if (memberId) {
      const member = await tx.schoolMembers.getById(memberId);
      if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE || member.userId !== refereeId ||
          !event.participantSchoolIds.includes(member.schoolId) || event.invitations[member.schoolId] !== 'accepted') return refused('裁判身份已失效，请重新选择');
      const user = await tx.users.getById(refereeId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== member.schoolId) return refused('裁判账号已失效，请重新选择');
    }
    const next = { ...current, referee: refereeId, refereeAt: fresh.now, refereeBy: fresh.actorId, revision: current.revision + 1 };
    await tx.exchangeMatches.set(next._id, next);
    const nextEvent = { ...event, revision: event.revision + 1 };
    await tx.exchangeEvents.set(nextEvent._id, nextEvent);
    await audit(tx, fresh, nextEvent, 'assignExchangeReferee');
    return { ok: true, event: summary(nextEvent), message: '' };
  }));
}

async function submitExchangeScore(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  const match = await ctx.repo.exchangeMatches.getById(payload.matchId);
  if (!snapshot || !match || match.eventId !== snapshot._id) return ok(refused('比赛不存在'));
  if (!snapshot.draw) return ok(refused('请先抽签'));
  // 终态不可变（2026-10-16 审计）：名次一旦确认（status='finished'），
  // event.results 就是对外唯一口径，比分台账不能事后被改写——否则「公布的冠军」
  // 与「台账里的冠军」会静默分叉。要更正得走赛事修订，不是改比分。
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再改比分'));
  if (snapshot.status === 'canceled') return ok(refused('赛事已取消'));
  if (!canScoreMatch(snapshot, match, ctx)) return ok(refused('没有比分确认权限'));
  if (match.status !== 'pending') return ok(refused('这场比赛已确认比分'));
  if (!match.playerA || !match.playerB) return ok(refused('对阵尚未确定'));
  const scoreA = payload.scoreA;
  const scoreB = payload.scoreB;
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 ||
      scoreA > 99 || scoreB > 99) return ok(refused('请填写有效的比分'));
  if (scoreA === scoreB) return ok(refused('淘汰赛不能打平'));
  const { map } = entrantsOf(snapshot);
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const preview = { ...match, scoreA, scoreB, winner: scoreA > scoreB ? match.playerA : match.playerB, status: 'active' };
  const ledger = existing.map(row => row._id === match._id ? preview : row);
  const built = planExchangeMatches({ event: snapshot, draw: snapshot.draw, entrantsById: map, matches: ledger });
  // 【只写「真的变了」的场次】（2026-10-23 第三轮审查 X-1）
  // 原实现在事务里对**整张签表**逐场 getById，只为判断要不要补写。128 人单败
  // 到第 2 轮就有 96 场，加上事件读、本场读写与审计即越过云端 100 次操作上限，
  // 表现为「抽签与第一轮正常、第二轮起每场录分都报服务异常」。
  // 台账在事务外已读到、事务内还有 revision 比对兜并发，因此差分可以提前算：
  // 一次录分通常只影响「本场 + 下一轮那一条」。
  const changed = changedExchangeMatches(ledger, built.matches);
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!current || !event || current.eventId !== event._id) return refused('比赛不存在');
    if (!canScoreMatch(event, current, fresh)) return refused('没有比分确认权限');
    if (event.status === 'finished') return refused('赛事已结束，不能再改比分');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (current.status !== 'pending') return refused('这场比赛已确认比分');
    if (event.revision !== snapshot.revision || current.revision !== match.revision) return refused('赛事已变化，请刷新后重试');
    const scored = { ...current, scoreA, scoreB, winner: scoreA > scoreB ? current.playerA : current.playerB,
      status: 'active', recordedBy: fresh.actorId, recordedAt: fresh.now, revision: current.revision + 1 };
    await tx.exchangeMatches.set(scored._id, scored);
    // 把「此刻应当存在」的比赛补齐 / 刷新：新确定的对阵补进来；撤销后重录导致的
    // 换人（待确认 / 已撤销的下一轮）按新对阵刷新。已生效的比分不动。
    // 遍历的是**差分**（changed），不是整张签表，见上方 X-1 的说明。
    for (const row of changed) {
      const clash = await tx.exchangeMatches.getById(row._id);
      if (!clash) {
        await tx.exchangeMatches.set(row._id, { ...row, schoolId: event.schoolId, association: event.association });
        continue;
      }
      if (clash.status === 'active') continue;
      if (clash.playerA === row.playerA && clash.playerB === row.playerB && clash.status === row.status) continue;
      await tx.exchangeMatches.set(row._id, { ...clash, playerA: row.playerA, playerB: row.playerB,
        schoolA: row.schoolA, schoolB: row.schoolB, scoreA: null, scoreB: null, winner: '',
        status: 'pending', revision: Number(clash.revision || 1) + 1 });
    }
    const nextEvent = { ...event, revision: event.revision + 1 };
    await tx.exchangeEvents.set(nextEvent._id, nextEvent);
    await audit(tx, fresh, nextEvent, 'submitExchangeScore');
    return { ok: true, event: summary(nextEvent), message: '' };
  }));
}

async function confirmExchangeRanking(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以确认名次'));
  if (!snapshot.draw) return ok(refused('请先抽签'));
  if (snapshot.status === 'finished') return ok(refused('名次已确认'));
  const { rows } = entrantsOf(snapshot);
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const placed = placementsFromExchange({ event: snapshot, draw: snapshot.draw, matches: existing });
  if (!placed.ok) return ok(refused(placed.message));
  const byUser = new Map(rows.map(row => [row.userId, row]));
  const results = placed.results.map(row => {
    const entrant = byUser.get(row.userId) || {};
    return { userId: row.userId, placement: row.placement, nickName: entrant.nickName || '',
      representedSchoolId: entrant.representedSchoolId || '', schoolName: entrant.schoolName || snapshot.schoolNames[entrant.representedSchoolId] || '' };
  });
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以确认名次');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (event.status !== 'drawn') return refused('当前状态不能确认名次');
    if (event.revision !== snapshot.revision) return refused('赛事已变化，请刷新后重试');
    const next = { ...event, status: 'finished', results,
      finishedAt: fresh.now, finishedBy: fresh.actorId, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'confirmExchangeRanking');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function getExchangeEvents(_payload, ctx) {
  if (!manages(ctx) && !participates(ctx)) return ok({ ...refused('请使用本校有效身份查看邀请赛'), events: [] });
  const invitations = await ctx.repo.exchangeInvitations.listByScope(ctx);
  const events = [];
  for (const invitation of invitations) {
    const event = await ctx.repo.exchangeEvents.getById(invitation.eventId);
    if (canSee(event, ctx)) events.push(summary(event));
  }
  return ok({ ok: true, events: events.sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0)), message: '' });
}

/** 管理员按已接受邀请的学校搜索裁判；每次只返回一页。 */
async function listExchangeRefereeCandidates(payload = {}, ctx) {
  const event = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!canSee(event, ctx) || !managesExchange(event, ctx)) return ok(refused('只有赛事管理者可以查询裁判候选'));
  const schoolId = typeof payload.schoolId === 'string' ? payload.schoolId : ctx.schoolId;
  if (!(event.participantSchoolIds || []).includes(schoolId) || event.invitations[schoolId] !== 'accepted') {
    return ok(refused('只能查询已接受邀请的参赛学校'));
  }
  const limit = Math.max(1, Math.min(Number(payload.limit) || 20, 50));
  const page = await ctx.repo.forScope({ schoolId, association: event.association }).schoolMembers
    .listDirectoryPage({ keyword: payload.keyword, cursor: payload.cursor, limit });
  return ok({ ok: true, ...page, members: page.members.map(row => ({ userId: row.userId,
    nickName: row.nickName || row.realName || row.userId, schoolId, schoolName: event.schoolNames[schoolId] || '' })), message: '' });
}

async function getExchangeEvent(payload = {}, ctx) {
  const event = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!canSee(event, ctx)) return ok(refused('赛事不存在或没有访问权限'));
  // 参赛者来源分两段，别混：
  //   · 已锁定 → 只认名册快照（锁定后报名表不再变化，也不再有权威）
  //   · 报名中 → 读报名表，页面要靠它显示「已报名」和当前名单
  // 签到时间挂在赛事的 checkIns 上（userId → 时间），与名册同一个文档。
  const locked = event.status !== 'signup';
  const checkIns = event.checkIns || {};
  const rows = locked
    ? (Array.isArray(event.roster) ? event.roster : [])
      .map(row => ({ ...row, checkInTime: checkIns[row.userId] || null }))
    : (await ctx.repo.exchangeSignups.listByEvent(event._id)).filter(row => row.status === 'signed');
  const byUser = new Map(rows.map(row => [row.userId, row]));
  const canManage = managesExchange(event, ctx);
  const existingMatches = await ctx.repo.exchangeMatches.listByEvent(event._id);
  // 全量投影：把「此刻应当存在的比赛」摆出来（含还未确定的对阵槽位之外的已定对阵）。
  // 展示用；名次确认用的是台账里已经确认的那份（见下 placement）。
  const matches = event.draw
    ? planExchangeMatches({ event, draw: event.draw, entrantsById: byUser, matches: existingMatches }).matches
    : [];
  // 名次能不能确认，由赛制自己的收官判据说了算（单败看决赛、循环看积分表、双败看总决赛）
  const placement = event.draw
    ? placementsFromExchange({ event, draw: event.draw, matches: existingMatches })
    : { ok: false, message: '' };
  // 详情仅补齐已经分配的裁判姓名，观众不会触发候选名册查询。
  const refereeIds = [...new Set(matches.map(match => match.referee).filter(Boolean))];
  const names = new Map((await ctx.repo.users.listByIds(refereeIds))
    .map(user => [user._id, user.nickName || user.realName || '']));
  const referees = refereeIds.map(userId => ({ userId, nickName: names.get(userId) || '' }));
  const canceled = event.status === 'canceled';
  const isOrganizer = isPlatformAdmin(ctx) || (event.schoolId === ctx.schoolId && manages(ctx));
  // 签到：名单锁定后到结束前，管理员替参赛者签（与普通赛事的代签同一口径）
  const canCheckIn = !canceled && (event.status === 'ready' || event.status === 'drawn') && managesExchange(event, ctx);
  return ok({ ok: true, event: summary(event), participants: rows.map(row => ({
    userId: row.userId, nickName: row.nickName, representedSchoolId: row.representedSchoolId, schoolName: row.schoolName,
    checkInTime: row.checkInTime || null, checkedIn: Boolean(row.checkInTime),
    canCheckIn: canCheckIn && (isPlatformAdmin(ctx) || row.representedSchoolId === ctx.schoolId),
    canRemove: !canceled && event.status === 'signup' && managesExchange(event, ctx) &&
      (isPlatformAdmin(ctx) || row.representedSchoolId === ctx.schoolId),
  })), referees, canManage, canRespond: event.schoolId !== ctx.schoolId && event.invitations[ctx.schoolId] === 'pending' && manages(ctx),
    canSignup: !canceled && participates(ctx) && event.invitations[ctx.schoolId] === 'accepted' && event.status === 'signup' && new Date(event.startTime) > new Date(ctx.now),
    signed: rows.some(row => row.userId === ctx.actorId),
    canceled, canCheckIn,
    canCancel: !canceled && event.status !== 'finished' && isOrganizer,
    canWithdrawInvitation: !canceled && event.status === 'signup' && Boolean(canManage),
    canDraw: !canceled && canManage && (event.status === 'ready' || event.status === 'drawn') &&
      !matches.some(match => match.status === 'active'),
    canConfirmRanking: !canceled && canManage && event.status === 'drawn' && Boolean(placement.ok),
    rankingHint: canceled || placement.ok ? '' : (placement.message || ''),
    matches: matches
      // 展示次序：先按阶段（小组赛 → 主赛 / 胜者组 → 败者组 → 季军赛 / 总决赛 / 排位），
      // 同阶段再按轮次与签位。双败的交错推进因此也读得顺。
      .slice()
      .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.round - b.round || a.slot - b.slot)
      .map(match => ({
      _id: match._id, round: match.round, slot: match.slot, status: match.status,
      stage: match.stage || BRACKET_STAGE.MAIN, stageText: STAGE_TEXT[match.stage || BRACKET_STAGE.MAIN] || '',
      group: match.group === undefined ? null : match.group,
      groupText: match.group === undefined || match.group === null ? '' : `第 ${match.group + 1} 组 · `,
      nameA: (byUser.get(match.playerA) || {}).nickName || '', nameB: (byUser.get(match.playerB) || {}).nickName || '',
      schoolNameA: event.schoolNames[match.schoolA] || '', schoolNameB: event.schoolNames[match.schoolB] || '',
      scoreA: match.scoreA, scoreB: match.scoreB, winner: match.winner,
      referee: match.referee || '', refereeName: names.get(match.referee) || '',
      canAssignReferee: !canceled && canManage && match.status === 'pending',
      canScore: !canceled && match.status === 'pending' && canScoreMatch(event, match, ctx),
      // canRevoke 已随撤销取消移除：已确认的交流赛比分不可撤销
    })),
    message: '' });
}

module.exports = { createExchangeEvent, respondExchangeInvitation, signUpExchangeEvent,
  cancelExchangeSignup, removeExchangeSignup, checkInExchangeSignup, withdrawExchangeInvitation,
  cancelExchangeEvent,
  lockExchangeRoster, drawExchangeEvent, assignExchangeReferee,
  submitExchangeScore, confirmExchangeRanking, getExchangeEvents, getExchangeEvent, listExchangeRefereeCandidates };
