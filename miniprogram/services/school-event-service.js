/**
 * 学校维度：个人赛事 —— 发布 / 报名 / 开赛 / 抽签 / 代签 / 结束（协议 2，M1）
 * ============================================================
 * 「个人赛事」是协会内部办的比赛：协会负责人以上发布，本协会有效会员报名。
 * 全生命周期一条线：
 *   发布 → 列表 → 详情 → 报名 → 取消报名
 *        → 抽签（生成签表与首轮比赛）→ 开赛 → 代签 → 录名次结束。
 * 抽签与推进的纯规则一字不改地复用旧栈（`event.js` / `draw.js` / `format-plan.js`，
 * 同一把尺子）；本模块只管**归属**与**权限来源**：
 *   · 主记录与生成的比赛都绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 旧栈 ROLE 由 S2 角色推导（见 school-actor.js），与比赛 / 实时比分同源。
 *
 * 【签表比赛的编号为什么不另包一层范围前缀】
 * 抽签生成的比赛编号是 `eventMatchKey(event._id, ...)`，而 eventId 本身已带
 * `schoolId + association`，因此它天然全局唯一、不可伪造，无需再裹一层范围键；
 * 且 format-plan 逐轮推进时按这个确定键找下一轮，包了反而对不上。比赛记录上
 * 仍写 schoolId / association，归属判定不放松。
 *
 * 【advanceSchoolEvent 是内部动作】
 * confirm / forfeit 之后补排下一轮由它负责（见 school-match-service）。它虽从
 * 本模块导出（供比赛服务调用），但入参是 (ctx, eventId) 而非 (payload, ctx)，
 * 被当成客户端 action 误调时首行即判空返回，不产生任何写入。
 *
 * 【与旧栈的区别】
 * 旧栈的赛事只按 `association` 分桶，没有 `schoolId`；本模块把每条主记录同时
 * 绑定 `schoolId + association`，主键由 `utils/school.js` 按范围生成，读写一律
 * 先过 `belongsToSchoolScope`，从入口堵死跨校串数据。
 *
 * 【职责边界】
 * 注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 表单校验复用旧栈纯规则 `event.js`（同一把尺子），不另抄一遍。
 *
 * 【并发与幂等】
 *   · 发布用 requestId 派生稳定 eventId，同编号重试返回同一条；
 *   · 报名用 scope + eventId + userId 的稳定主键，重复报名幂等；
 *   · 名额靠主记录上的 signupCount 计数（报名 / 取消在同一事务内增减），
 *     与训练同一口径，避免事务内整表查询。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { loadColleges } = require('./college-directory.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
// 角色 / 名单的推导收在 school-actor，两套栈只有一份口径。
const { buildDirectory, legacyActorOf, actorCollegeNameOf, actorDirectory, userDirectory } = require('./school-actor.js');
const {
  schoolKey, belongsToSchoolScope, schoolEventKey, schoolEventSignupKey,
  associationGroupMemberKey, schoolMemberKey,
} = require('../utils/school.js');
// 小组限制（受众范围）与训练共用同一套纯规则（B6）。
const { buildAudience, readAudience, audienceAllows } = require('./association-audience.js');
const { GROUP_MEMBER_STATUS } = require('./association-group-service.js');
const {
  EVENT_STATUS, EVENT_STATUS_LABEL, SIGNUP_STATUS, SIGNUP_STATUS_LABEL,
  MATCH_TYPE, MATCH_TYPE_LABEL, EVENT_LEVEL_LABEL, EVENT_FORMAT_LABEL,
  MATCH_STATUS, MATCH_COMPETITION,
  DEFAULT_EVENT_FORMAT, GENDER_LABEL, singleGenderOf, disciplineLabelOf,
} = require('../utils/constants.js');
// 表单校验与生命周期判定复用旧栈纯规则：赛事该怎么走，两套栈只有一份口径。
const {
  buildEventRecord, signupStateOf,
  canStartEvent, startBlockedReason, canDrawEvent, canCheckIn, canFinishEvent,
  buildCheckInPatch, validatePlacements,
} = require('./event.js');
const { planDraw, buildDrawRecord, canRedraw, drawnEntryCount } = require('./draw.js');
const { buildInitialMatches, buildPlannedDrafts, planStageMatches } = require('./format-plan.js');
const { defaultFormatOf } = require('../utils/associations.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const EVENT_LIST_LIMIT = 20;
const EVENT_LIST_MAX = 50;

// 抽签最多 44 场：6 次身份读 + 赛事读 + 每场读/写 + 赛事写 + 审计 = 97。
// 重抽也必须预留逐场重读；双打两人一队，分组赛按最坏的偶数组估算。
const { drawCapacityOf } = require('../utils/event-capacity.js');

const iso = value => new Date(value).toISOString();
const formatOf = doc => (doc && doc.format) || DEFAULT_EVENT_FORMAT;

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/**
 * 事务内重判身份与角色（2026-10-16 独立验收 F1/F2 的同类扫尾）。
 *
 * 【为什么每次写都要在事务里再问一遍「你还是你吗」】
 * 开赛 / 抽签 / 代签 / 录名次这些动作，权限都取自请求进入时的上下文；而账号被
 * 停用、学籍离校、协会角色被撤都可能发生在请求飞在路上的那一瞬。只在外层判一次，
 * 就会出现「读不了任何数据的人，却把赛事开了 / 把名次录了」。事务里重建上下文
 * （全是按主键点读，事务允许）再判一次，窗口就没了。
 *
 * @param {Object} tx 事务内仓储
 * @param {Object} ctx 外层上下文
 * @param {Object} dir buildDirectory 的结果（角色判定的静态部分）
 * @returns {Promise<{ok:boolean, message:string, actor:Object|null}>}
 */
async function freshActorGate(tx, ctx, dir) {
  const fresh = await freshContext(tx, ctx);
  if (!canReadAssociationSpace(fresh)) {
    return { ok: false, message: '账号已停用，或没有本协会的访问权限', actor: null };
  }
  return { ok: true, message: '', actor: legacyActorOf(fresh, dir) };
}

const eventAuditKey = (eventId, action, revision) =>
  schoolKey('evau', eventId, action, String(revision));
const signupAuditKey = (eventId, actorId, action, revision) =>
  schoolKey('evsu', eventId, actorId, action, String(revision));

/** 一条赛事主记录。status 可以是 0（报名中，falsy），所以不能用真值判断。 */
const isEventDoc = doc => Boolean(doc && doc.title && typeof doc.status === 'number' && doc.startTime);

/** 有效报名数：已取消的不占名额。 */
const activeSignupCount = rows => (Array.isArray(rows) ? rows : [])
  .filter(row => row.status !== SIGNUP_STATUS.CANCELED).length;

/**
 * 由整份报名台账按赛事汇总：eventId → { seen, active }。
 * `seen` 记这场赛事在台账里有没有记录——有记录就以台账为准（哪怕全是取消），
 * 没有任何记录才回退主记录上的计数器（历史数据可能只留下了计数）。
 *
 * @param {Array<Object>} rows 本范围内的报名记录
 * @returns {Map<string, {seen: number, active: number}>}
 */
function tallySignups(rows) {
  const tally = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.eventId) continue;
    const item = tally.get(row.eventId) || { seen: 0, active: 0 };
    item.seen += 1;
    if (row.status !== SIGNUP_STATUS.CANCELED) item.active += 1;
    tally.set(row.eventId, item);
  }
  return tally;
}

/**
 * 展示用报名数：台账里有这场赛事就按台账算；没有台账（或列表页不传台账）时
 * 回退主记录计数器，并与已录名次人数取大（名次上的人必然报过名）。
 *
 * @param {Object} doc 赛事主记录
 * @param {Map<string, {seen: number, active: number}>} [tally] 单场报名台账统计；
 *   列表页不再查询报名集合，省略此参数，走计数器 + 名次兜底。
 * @returns {number}
 */
function displaySignupCount(doc, tally) {
  const item = tally && tally.get(doc._id);
  if (item && item.seen > 0) return item.active;
  const results = Array.isArray(doc.results) ? doc.results.length : 0;
  return Math.max(Number(doc.signupCount || 0), results);
}

/**
 * 名额判断用的「已占用数」：主记录计数与报名台账**取大**。
 *
 * 【为什么展示与名额用两个不同的数】
 * 展示要准（`displaySignupCount`，以台账为准，用户看的是「报了几个人」）；
 * 名额要稳——放人进来之前必须按最坏情况算：
 *   · 计数偏小（演示种子、早期导入只写了 0）：只看计数会**超员**，所以台账要算进来；
 *   · 计数偏大（历史数据里人退过、计数没跟上）：只看台账会放人进来，写端再拿
 *     「计数 + 1」落库，占用继续虚高，所以计数也要算进来。
 * 两者取大后，「页面能不能点报名」与「写接口收不收」用的是同一把尺子，
 * 不会出现「按钮能点、点下去被拒」或「页面说满了、接口却放行」的分叉。
 *
 * 台账是事务外读的快照，取大恰好补上它的陈旧：计数在事务内维护，是同一场
 * 赛事并发报名的串行点（写端还会把占用数回写主记录，见 signUpSchoolEvent）。
 *
 * @param {Object} doc 赛事主记录
 * @param {Map<string, {seen: number, active: number}>} tally tallySignups 的结果
 * @returns {number}
 */
function occupiedSignupCount(doc, tally) {
  const item = tally && tally.get(doc._id);
  const counted = item && item.seen > 0 ? item.active : 0;
  return Math.max(Number(doc.signupCount || 0), counted);
}

/** 报名记录 DTO（本人视角，不下发隐私字段）。 */
const signupDTO = row => (row ? {
  userId: row.userId,
  status: row.status,
  label: SIGNUP_STATUS_LABEL[row.status] || '',
  signTime: row.signTime || null,
  checkInTime: row.checkInTime || null,
  revision: Number(row.revision || 1),
} : null);

/**
 * 签表 DTO：只投影展示与重抽要用的字段，不透传整条库记录。
 * 名单列表（eventSummary）不带它——只有详情响应才下发。
 */
function drawDTO(draw) {
  if (!draw) return null;
  const groups = (draw.groups || []).map(group => ({
    group: group.group,
    entries: (group.entries || []).slice(),
  }));
  return {
    format: draw.format || null,
    seedMode: draw.seedMode || null,
    seedCount: Number(draw.seedCount || 0),
    seedValue: Number(draw.seedValue),
    drawCount: Number(draw.drawCount || 1),
    drawnAt: draw.drawnAt || null,
    drawnBy: draw.drawnBy || null,
    size: Number(draw.size || 0),
    slots: (draw.slots || []).slice(),
    seeds: (draw.seeds || []).slice(),
    byes: (draw.byes || []).slice(),
    groupCount: groups.length > 0 ? groups.length : null,
    groups,
  };
}

/** 名次 DTO：只保留「谁、第几名」两个字段，其余留库。 */
const resultsDTO = results => (Array.isArray(results) ? results : [])
  .map(row => ({ userId: row.userId, placement: Number(row.placement) }));

/**
 * 赛事摘要 DTO（列表与详情共用）。时间一律给原始 ISO，本地时区渲染交给页面。
 *
 * 列表使用事务维护的 signupCount；详情已经读取单场台账，允许传入台账计数，
 * 兼容历史计数偏差。没有台账时，展示人数还会用已录名次人数兜底。
 *
 * @param {Object} doc 赛事主记录
 * @param {Object|null} [mySignup] 当前登录人在本场的报名记录
 * @param {number|null} [signupCount] 读端按台账算出的有效报名数；不给则读主记录计数器
 */
function eventSummary(doc, mySignup = null, signupCount = null) {
  const state = signupStateOf(mySignup);
  const count = Number.isFinite(signupCount) ? Number(signupCount) : Number(doc.signupCount || 0);
  const quota = Number(doc.quota) || 0;
  return {
    eventId: doc._id,
    title: doc.title || '',
    description: doc.description || '',
    matchType: doc.matchType,
    matchTypeLabel: MATCH_TYPE_LABEL[doc.matchType] || '',
    discipline: doc.discipline || '',
    disciplineLabel: disciplineLabelOf(doc.discipline),
    isDoubles: doc.matchType === MATCH_TYPE.DOUBLES,
    level: doc.level,
    levelLabel: EVENT_LEVEL_LABEL[doc.level] || '',
    format: formatOf(doc),
    formatLabel: EVENT_FORMAT_LABEL[formatOf(doc)] || '',
    bronzeMode: doc.bronzeMode || null,
    placementMode: doc.placementMode || null,
    // 小组参数与总决赛重赛只在对应赛制下有意义，其余赛制建记录时即落 null；
    // 原样透出（含 false），页面与用例才能核对「选了什么、落库成了什么」。
    groupCount: doc.groupCount === undefined ? null : doc.groupCount,
    advancePerGroup: doc.advancePerGroup === undefined ? null : doc.advancePerGroup,
    gfReset: doc.gfReset === undefined ? null : doc.gfReset,
    seedMode: doc.seedMode || '',
    seedCount: Number(doc.seedCount) || 0,
    location: doc.location || '',
    startTime: doc.startTime || null,
    courtCount: Number(doc.courtCount) || 0,
    quota,
    quotaText: quota > 0 ? `${count}/${quota} 人` : `${count} 人`,
    status: doc.status,
    statusLabel: EVENT_STATUS_LABEL[doc.status] || '',
    isSignup: doc.status === EVENT_STATUS.SIGNUP,
    isOngoing: doc.status === EVENT_STATUS.ONGOING,
    isFinished: doc.status === EVENT_STATUS.FINISHED,
    pinned: Boolean(doc.pinned),
    drawn: Boolean(doc.draw),
    // 小组限制（受众范围，B6）：旧赛事缺字段按「不限」兼容
    audienceMode: readAudience(doc).audienceMode,
    audienceGroupIds: readAudience(doc).audienceGroupIds,
    signupCount: count,
    publisherId: doc.publisherId || '',
    publisherName: doc.publisherName || '',
    revision: Number(doc.revision || 1),
    mySignup: state.status === null ? null : { ...state, ...signupDTO(mySignup) },
  };
}

/** 由规范化记录组装可落库的赛事主记录：补范围、稳定主键、ISO 时间与版本。 */
function eventDocFromRecord(record, eventId, ctx, fingerprint) {
  return {
    ...record,
    _id: eventId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    startTime: iso(record.startTime),
    publishTime: iso(record.publishTime),
    pinned: false,
    signupCount: 0,
    fingerprint,
    revision: 1,
    updatedAt: iso(record.publishTime),
  };
}

/** 幂等指纹：同编号重发同样的单子返回同一条，改过内容则拒绝。 */
const fingerprintOf = record => JSON.stringify([
  record.title, record.description, record.matchType, record.discipline,
  record.format, record.level, record.bronzeMode, record.placementMode,
  record.seedMode, record.seedCount, record.location, record.quota, record.courtCount,
  new Date(record.startTime).getTime(),
  record.audienceMode || 'all', JSON.stringify(record.audienceGroupIds || []),
]);

/* ------------------------------------------------------------------ 读 */

async function listSchoolEvents(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, events: [], canManage: false, total: 0, totalAll: 0, message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  // status 支持单个值或一组值：首页要同时取「报名中 + 进行中」两种状态。
  // 只接受数字，别把字符串拼进 includes 里——那会静默筛出空列表。
  const wanted = Array.isArray(payload.status)
    ? payload.status.filter(status => typeof status === 'number')
    : (typeof payload.status === 'number' ? [payload.status] : []);
  const keyword = String(payload.keyword == null ? '' : payload.keyword).trim().toLowerCase().slice(0, 40);
  const yearText = String(payload.year == null ? '' : payload.year);
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  // 默认「置顶 → 状态（报名中 > 进行中 > 已结束）→ 开赛时间倒序」。
  // 状态优先级与 EVENT_STATUS 的取值顺序一致（SIGNUP 0 < ONGOING 1 < FINISHED 2），
  // 所以这一档可以直接下推成 orderBy('status')。
  // order='asc' 只反转「开赛时间」这一档：首页要看「最近要打的几场」。
  const ascending = payload.order === 'asc';
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, EVENT_LIST_MAX) : EVENT_LIST_LIMIT;
  const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
  const scoped = ctx.repo.forScope(ctx);
  // 人数直接用赛事汇总；本人报名状态仅点读当前页，读量不随报名总数增长。
  const myId = ctx.actorId;
  const decorate = async (docs) => {
    // 「我报名了没」按**页**批读：一页 20 条原来是 20 次点读（2026-10-22 H-3）。
    // 编号由 (赛事, 我) 派生，不是客户端给的，但仍按 _id 取回来对一遍，
    // 免得派生规则将来变了、拿错文档还当成「已报名」。
    const signupKeys = myId ? docs.map(doc => schoolEventSignupKey(doc._id, myId, ctx)) : [];
    const signupById = new Map((signupKeys.length
      ? await scoped.eventSignups.listByIds(signupKeys)
      : []).map(doc => [doc._id, doc]));
    return docs.map((doc, index) => eventSummary(
      doc,
      myId ? (signupById.get(signupKeys[index]) || null) : null,
      displaySignupCount(doc),
    ));
  };

  // ── 主路径下推：范围 + 状态 + 排序 + 分页交给数据库 ─────────────────────
  // 无关键词、无年份时所有条件都能用索引表达，只取当前页（2026-10-29 第十二轮审计）。
  // 关键词要匹配 title/name/location 三个字段（云数据库没有可用于包含匹配的索引），
  // 年份要按东八区换算成区间——这两条仍回退内存，数据量是「本协会赛事数」。
  if (!keyword && !year) {
    const page = await scoped.events.listPage({
      statuses: wanted,
      order: [
        { field: 'pinned', direction: 'desc' },
        { field: 'status', direction: 'asc' },
        { field: 'startTime', direction: ascending ? 'asc' : 'desc' },
        { field: '_id', direction: 'asc' },
      ],
      limit,
      offset,
    });
    const docs = page.rows.filter(isEventDoc);
    return ok({
      ok: true, canManage,
      hasMore: page.hasMore,
      nextOffset: offset + page.rows.length,
      // total 是「过滤后」的条数（分页基准）；totalAll 是过滤前的总量，
      // 首页概况的「N 场赛事」用它——不能被「只看报名中」的筛选带偏。
      total: page.total,
      totalAll: page.totalAll,
      events: await decorate(docs),
      message: '',
    });
  }

  // ── 回退：关键词 / 年份在内存里筛 ───────────────────────────────────────
  const allRows = (await scoped.events.list()).filter(isEventDoc);
  const yearOf = (value) => {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return null;
    // 展示与筛选都以北京时间为准，避免云函数 UTC 把跨年夜晚间的赛事算到上一年。
    return new Date(time + 8 * 60 * 60 * 1000).getUTCFullYear();
  };
  const rows = allRows.filter((row) => {
    if (wanted.length > 0 && !wanted.includes(row.status)) return false;
    if (year && yearOf(row.startTime) !== year) return false;
    if (keyword) {
      const haystack = [row.title, row.name, row.location].map(value => String(value || '').toLowerCase()).join('\n');
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  const sorted = rows.slice().sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    const pri = row => (row.status === EVENT_STATUS.SIGNUP ? 0 : row.status === EVENT_STATUS.ONGOING ? 1 : 2);
    const byStatus = pri(a) - pri(b);
    if (byStatus !== 0) return byStatus;
    const ta = Date.parse(a.startTime) || 0;
    const tb = Date.parse(b.startTime) || 0;
    if (tb !== ta) return ascending ? ta - tb : tb - ta;
    return a._id === b._id ? 0 : (a._id < b._id ? -1 : 1);
  });
  const page = sorted.slice(offset, offset + limit);
  return ok({
    ok: true, canManage,
    hasMore: sorted.length > offset + page.length,
    nextOffset: offset + page.length,
    total: sorted.length,
    totalAll: allRows.length,
    events: await decorate(page),
    message: '',
  });
}

async function setSchoolEventPinned(payload = {}, ctx) {
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (typeof payload.pinned !== 'boolean') return ok(refused('置顶状态必须为布尔值'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('没有管理赛事的权限');
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('赛事不存在');
    if (Boolean(doc.pinned) === payload.pinned) return { ok: true, event: eventSummary(doc), message: '' };
    const next = { ...doc, pinned: payload.pinned, revision: Number(doc.revision || 1) + 1, updatedAt: iso(fresh.now) };
    await tx.events.set(doc._id, next);
    await tx.audit.append({ _id: eventAuditKey(doc._id, 'setSchoolEventPinned', next.revision),
      action: 'setSchoolEventPinned', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId: doc._id, pinned: next.pinned, at: iso(fresh.now) });
    return { ok: true, event: eventSummary(next), message: '' };
  }));
}

async function getSchoolEvent(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));

  const canManage = canManageAssociationSpace(ctx);
  const canParticipate = canParticipateInAssociation(ctx);
  const mySignup = ctx.actorId
    ? await ctx.repo.eventSignups.getById(schoolEventSignupKey(doc._id, ctx.actorId, ctx))
    : null;
  const signups = await ctx.repo.forScope(ctx).eventSignups.listByEvent(doc._id);

  const state = signupStateOf(mySignup);
  const tally = tallySignups(signups);
  // 展示人数以台账为准（真值）；「名额满没满、能不能报」按占用数（计数与台账取大）
  // 算——两者同一把尺子地取最坏情况，页面才不会出现「点了才被拒」或「说满了却放行」
  const shownCount = displaySignupCount(doc, tally);
  const occupied = occupiedSignupCount(doc, tally);
  const full = occupied >= drawCapacityOf(doc) || Number(doc.quota) > 0 && occupied >= Number(doc.quota);
  const genderLimit = singleGenderOf(doc.discipline);
  const genderOk = !genderLimit || (ctx.actor && ctx.actor.gender === genderLimit);
  // 小组限制（B6）：详情页也要算出「能不能报、为什么不能报」，与写入端同一把尺子。
  // 只查**我加入的组**：原来把整个协会的小组成员行读回来再筛自己那几行，
  // 读量随「组数 × 人数」增长（2026-10-22 H-3）。
  const groupRows = ctx.actorId
    ? await ctx.repo.forScope(ctx).associationGroupMembers.listByUser(ctx.actorId) : [];
  const myGroupIds = groupRows
    .filter((row) => row.userId === ctx.actorId && row.status === GROUP_MEMBER_STATUS.ACTIVE)
    .map((row) => row.groupId);
  const groupOk = audienceAllows(doc, myGroupIds);

  let signupNote = '';
  if (!canParticipate) signupNote = '只有本协会有效会员可以报名';
  else if (doc.status !== EVENT_STATUS.SIGNUP) signupNote = '报名已截止';
  else if (doc.draw) signupNote = '已抽签，报名名单已定';
  else if (!genderOk) signupNote = `本赛事为${disciplineLabelOf(doc.discipline)}，仅限${GENDER_LABEL[genderLimit]}会员报名`;
  else if (!groupOk) signupNote = '本次赛事仅限指定小组成员报名';
  else if (state.signed) signupNote = '';
  else if (full) signupNote = '名额已满';

  const canSignUp = canParticipate && doc.status === EVENT_STATUS.SIGNUP && !doc.draw &&
    genderOk && groupOk && !state.signed && !full;
  const canCancelSignup = doc.status === EVENT_STATUS.SIGNUP && !doc.draw &&
    Boolean(mySignup && mySignup.status === SIGNUP_STATUS.SIGNED);

  // 管理动作的按钮可见性由服务端算好，页面照着渲染。
  // 判据复用写入端同一把尺子（canStartEvent / canDrawEvent / canFinishEvent）；
  // 写入时仍会再校验一遍——能力只说明「这一刻理论上可不可以」，不是写入许可。
  //
  // 【2026-10-23 H-4】这里原先调 buildDirectory：只为拿操作者自己的学院名，
  // 却要读全校在册名单 + 这批人的账号（2000 人 = 40 次 RPC）。详情页是每场
  // 赛事都会打开的读接口，换成一个点读。
  const actorCollege = await actorCollegeNameOf(ctx);
  const actor = legacyActorOf(ctx, { actorCollege, managedCollegeName: actorCollege });

  return ok({
    ok: true, canManage, canParticipate,
    // 详情才带 draw / results（列表保持精简）；字段经投影，不透传整条库记录。
    event: {
      ...eventSummary(doc, mySignup, shownCount),
      draw: drawDTO(doc.draw),
      results: resultsDTO(doc.results),
    },
    mySignup: signupDTO(mySignup),
    signupCount: shownCount,
    capabilities: {
      canSignUp,
      canCancelSignup,
      canStart: canStartEvent(doc, actor),
      canDraw: canDrawEvent(doc, actor),
      canFinish: canFinishEvent(doc, actor),
    },
    signupNote, message: '',
  });
}

/**
 * 某场赛事的报名名单（含展示所需的会员字段）。
 * ============================================================
 * 【为什么是独立读端，而不是让客户端拉全校名录自己拼】
 * 名单要的昵称 / 学院只有服务端一次读齐最省，也最不容易把别处的隐私字段
 * 顺带漏出去；且「谁能看这份名单」与赛事读取同一条锁（本协会有效会员）。
 *
 * 【不下发的字段】
 * 学号、手机号一律不带（与名录同一隐私口径）；等级分与赛季积分也不在这里——
 * 那是计分服务的读端（school-rank-service.getSchoolMemberStats），
 * 避免任何一个读端被撑成全量快照。
 *
 * 【代签到能力为什么挂在记录上】
 * 「能不能替这位会员签到」取决于赛事状态、操作者角色与目标学院（见 event.canCheckIn），
 * 是逐条报名的判断，因此放在每一行 signups 上，而不是赛事级的 capabilities。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 */
async function listSchoolEventSignups(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: false, signups: [], message: '没有读取协会空间的权限' });
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));

  // 【2026-10-23 H-4】原先靠 buildDirectory 拿「全校会员 + 学院改名表」，
  // 而这一页只显示本场赛事的报名者。改成：报名台账 → 按这批人批读账号
  // （1 次 RPC）→ 学院目录（1 页，26 条）。
  const [ledger, actorCollege, colleges] = await Promise.all([
    ctx.repo.forScope(ctx).eventSignups.listByEvent(doc._id),
    actorCollegeNameOf(ctx),
    loadColleges(ctx),
  ]);
  const actor = legacyActorOf(ctx, { actorCollege, managedCollegeName: actorCollege });
  const rows = ledger
    .filter(row => row.status !== SIGNUP_STATUS.CANCELED)
    .sort((a, b) => (String(a.signTime || '') < String(b.signTime || '') ? -1 : 1));
  const signupUsers = await ctx.repo.users.listByIds(rows.map(row => row.userId));
  const memberById = new Map(signupUsers.map(member => [member._id, member]));
  const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
  // 报名者的学院取自名册（权威值），不是账号上的历史字段
  const memberRows = await Promise.all(rows.map(row =>
    ctx.repo.schoolMembers.getById(schoolMemberKey(row.userId, ctx.schoolId))));
  const collegeIdByUser = new Map();
  memberRows.forEach((row, index) => {
    if (row && row.collegeId) collegeIdByUser.set(rows[index].userId, row.collegeId);
  });
  const collegeOf = userId => collegeNameById.get(collegeIdByUser.get(userId)) || '';

  const signups = rows.map(row => {
    const member = memberById.get(row.userId) || {};
    const college = collegeOf(row.userId);
    return {
      userId: row.userId,
      nickName: member.nickName || row.userId,
      realName: member.realName || '',
      avatarUrl: member.avatarUrl || '',
      gender: member.gender || '',
      college,
      status: row.status,
      statusLabel: SIGNUP_STATUS_LABEL[row.status] || '',
      signTime: row.signTime || null,
      checkInTime: row.checkInTime || null,
      canCheckIn: canCheckIn(doc, actor, { target: { college } }),
    };
  });
  return ok({ ok: true, signups, message: '' });
}

/* ------------------------------------------------------------------ 写 */

async function publishSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const built = buildEventRecord(payload, { actor: ctx.actor, now: ctx.now });
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors }));
  const capacity = drawCapacityOf(built.record);
  if (Number(built.record.quota) > capacity) {
    const message = `本赛制最多支持 ${capacity} 人，请缩小名额`;
    return ok(refused(message, { errors: { quota: message } }));
  }
  // 小组限制（B6）：与训练同一把尺子校验；非法即拒绝，不静默降级为不限。
  const audience = buildAudience(payload);
  if (!audience.ok) return ok(refused(audience.message));
  built.record.audienceMode = audience.audienceMode;
  built.record.audienceGroupIds = audience.audienceGroupIds;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布赛事');
    const eventId = schoolEventKey(schoolKey('e', fresh.actorId, token), fresh);
    const doc = eventDocFromRecord(built.record, eventId, fresh, fingerprintOf(built.record));
    const existing = await tx.events.getById(eventId);
    if (isEventDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, event: eventSummary(existing), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.events.set(eventId, doc);
    await tx.audit.append({ _id: eventAuditKey(eventId, 'publishEvent', 1),
      action: 'publishEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId, at: iso(fresh.now) });
    return { ok: true, event: eventSummary(doc), message: '' };
  });
  return ok(result);
}

async function signUpSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = ctx.actorId;

  // 本场赛事的报名台账快照：事务内不能列集合，而名额判断必须把「计数与台账分叉」
  // 的情形一并算上（见 occupiedSignupCount）。快照在事务外读，取大时刚好补它的陈旧。
  const ledgerRows = await ctx.repo.forScope(ctx).eventSignups.listByEvent(payload.eventId);
  const ledgerTally = tallySignups(ledgerRows);

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canParticipateInAssociation(fresh)) return refused('只有本协会有效会员可以报名');
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('赛事不存在');
    if (doc.status !== EVENT_STATUS.SIGNUP) return refused('报名已经截止了');
    if (doc.draw) return refused('已抽签，报名名单已定');

    const genderLimit = singleGenderOf(doc.discipline);
    if (genderLimit && (!fresh.actor || fresh.actor.gender !== genderLimit)) {
      return refused(`本赛事为${disciplineLabelOf(doc.discipline)}，仅限${GENDER_LABEL[genderLimit]}会员报名`);
    }

    const key = schoolEventSignupKey(doc._id, userId, fresh);
    const existing = await tx.eventSignups.getById(key);
    if (existing && existing.status !== SIGNUP_STATUS.CANCELED) {
      return { ok: true, signup: signupDTO(existing), event: eventSummary(doc, existing), message: '' };
    }
    // 名额：占用数 = 主记录计数与台账取大（与详情页「能不能报」同一把尺子），
    // 落库时把占用数回写主记录——分叉的历史数据就此收敛，不会越用越偏
    const occupied = occupiedSignupCount(doc, ledgerTally);
    if (occupied >= drawCapacityOf(doc)) return refused(`本赛制最多支持 ${drawCapacityOf(doc)} 人，名额已满`);
    if (Number(doc.quota) > 0 && occupied >= Number(doc.quota)) {
      return refused('名额已满');
    }

    // 小组限制（B6）：报名当下必须命中至少一个选中小组；已报上的不因事后退组失效（G05）
    const audience = readAudience(doc);
    if (audience.audienceMode === 'groups') {
      const hits = [];
      for (const groupId of audience.audienceGroupIds) {
        const rel = await tx.associationGroupMembers.getById(associationGroupMemberKey(groupId, userId, fresh));
        if (rel && rel.status === GROUP_MEMBER_STATUS.ACTIVE) hits.push(groupId);
      }
      if (hits.length === 0) return refused('本次赛事仅限指定小组成员报名');
    }

    const nowIso = iso(fresh.now);
    const signup = existing
      ? { ...existing, status: SIGNUP_STATUS.SIGNED, signTime: nowIso, checkInTime: null,
        actorId: userId, cancelTime: null, revision: existing.revision + 1 }
      : { _id: key, schoolId: fresh.schoolId, association: fresh.association,
        eventId: doc._id, userId, status: SIGNUP_STATUS.SIGNED, signTime: nowIso,
        checkInTime: null, actorId: userId, cancelTime: null, revision: 1 };
    await tx.eventSignups.set(key, signup);
    // 占用数（而不是旧计数）加一后回写：计数偏小的历史数据会在下一次报名时被
    // 修正到与台账一致，页面人数与名额判断从此同源
    const next = { ...doc, signupCount: occupied + 1,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'signUpEvent', next.revision - 1),
      action: 'signUpEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: userId, eventId: doc._id, targetUserId: userId, at: nowIso });
    // 回给页面的「几人」仍按台账（快照里这场赛事的有效报名 + 这位刚报上的人），
    // 与详情页展示同一口径；计数只作名额水位，不拿来当展示值
    const ledgerActive = (ledgerTally.get(doc._id) || { active: 0 }).active;
    return { ok: true, signup: signupDTO(signup),
      event: eventSummary(next, signup, ledgerActive + 1), message: '' };
  });
  return ok(result);
}

async function cancelSchoolEventSignup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    const key = schoolEventSignupKey(doc._id, userId, ctx);
    const reg = await tx.eventSignups.getById(key);
    if (!reg || reg.status === SIGNUP_STATUS.CANCELED) {
      return { ok: true, event: eventSummary(doc, reg), message: '' };
    }
    if (doc.status !== EVENT_STATUS.SIGNUP || doc.draw) return refused('报名已经截止，不能取消');

    const nowIso = iso(ctx.now);
    const canceled = { ...reg, status: SIGNUP_STATUS.CANCELED, cancelTime: nowIso,
      revision: reg.revision + 1 };
    await tx.eventSignups.set(key, canceled);
    // 取消是「计数 − 1」而不是「按台账重算」：事务内读不到台账，而按事务外的快照
    // 重算会把并发报名的水位抹掉（宁可少放一个人进来，也不能超员）。计数因此只当
    // 名额水位及列表汇总，详情仍可按单场台账展示（见 displaySignupCount）。
    const next = { ...doc, signupCount: Math.max(0, Number(doc.signupCount || 0) - 1),
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'cancelSignupEvent', canceled.revision),
      action: 'cancelSignupEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: userId, eventId: doc._id, targetUserId: userId, at: nowIso });
    return { ok: true, event: eventSummary(next, canceled), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------- 生命周期 */

/**
 * 由抽签 / 推进产出的比赛草稿组装可落库的比赛记录。
 * 草稿的 _id 已是确定性签位键（含范围化的 eventId），此处只补范围与初始状态。
 */
function scopedMatchDoc(draft, ctx, action) {
  return {
    ...draft,
    schoolId: ctx.schoolId,
    association: ctx.association,
    competition: MATCH_COMPETITION.PERSONAL,
    status: MATCH_STATUS.PENDING,
    action,
    actor: ctx.actorId,
    actedAt: iso(ctx.now),
    revision: 1,
  };
}

/**
 * 开始赛事（报名中 → 进行中）。开始后才能代签与录名次。
 * 与旧栈 mock.startEvent 同一口径：仅管理员；未抽签则拦下并说明原因。
 */
async function startSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  // 【2026-10-26 第六轮 D】目录只进身份闸，而 legacyActorOf 从目录里唯一取的就是
  // actorCollege。原来为此读全校名册 + 全量账号（2000 人的学校 40 次 RPC），
  // 现在一次点读学院名。
  const dir = await actorDirectory(ctx);
  const result = await ctx.repo.transaction(async tx => {
    const gate = await freshActorGate(tx, ctx, dir);
    if (!gate.ok) return refused(gate.message);
    const actor = gate.actor;
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canStartEvent(doc, actor)) {
      return refused(doc.status !== EVENT_STATUS.SIGNUP
        ? '这场赛事已经开始了' : '只有协会负责人及以上可以开始赛事');
    }
    // 未抽签就没有任何比赛可打，先抽签再开赛（与旧栈 startBlockedReason 同一句提示）。
    const blocked = startBlockedReason(doc);
    if (blocked) return refused(blocked);

    const nowIso = iso(ctx.now);
    const next = { ...doc, status: EVENT_STATUS.ONGOING, action: 'start',
      actor: ctx.actorId, actedAt: nowIso, revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(doc._id, 'startEvent', next.revision),
      action: 'startEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, at: nowIso });
    return { ok: true, event: eventSummary(next), message: '' };
  });
  return ok(result);
}

/**
 * 抽签 / 重抽：算出签表与首轮比赛，落库。
 * 抽签只是报名阶段的管理动作；已有比赛确认生效后禁止重抽（分数已发出去）。
 * 重抽覆盖同一批签位编号（确定性键），不会堆出两批首轮。
 */
async function drawSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const scoped = ctx.repo.forScope(ctx);
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));
  if (!canDrawEvent(doc, actor)) {
    return ok(refused(doc.status !== EVENT_STATUS.SIGNUP
      ? '只能在报名阶段抽签' : '只有协会负责人及以上可以抽签'));
  }

  const signups = await scoped.eventSignups.listByEvent(doc._id);
  if (new Set(signups.filter(row => row.status !== SIGNUP_STATUS.CANCELED).map(row => row.userId)).size > drawCapacityOf(doc)) {
    return ok(refused(`本赛制最多支持 ${drawCapacityOf(doc)} 人，请缩小报名名单后抽签`));
  }
  const existing = await scoped.matches.listByEvent(doc._id);
  if (doc.draw && !canRedraw(existing)) return ok(refused('该赛事已有比赛确认生效，不能再重抽'));

  // 抽签种子：只认「调用方显式给的有限数字」（客户端传 Date.now() 供复核），
  // 其余一律服务端现取。从前 `Number(payload.seedValue)` 会把 null/''/true
  // 变成 0/1——传 null 即得确定性种子，签位可被本地穷举后复现（审计 C6）。
  const value = typeof payload.seedValue === 'number' && Number.isFinite(payload.seedValue)
    ? payload.seedValue : Date.now();
  const plan = planDraw({ event: doc, signups, members: dir.members,
    seedValue: value, manualOrder: payload.manualOrder });
  if (!plan.ok) return ok(refused(plan.message));

  const draw = buildDrawRecord(plan, {
    drawnAt: ctx.now, drawnBy: ctx.actorId,
    drawCount: (doc.draw && doc.draw.drawCount ? doc.draw.drawCount : 0) + 1,
  });
  const drafts = buildInitialMatches(doc, draw, defaultFormatOf(ctx.association)).map(draft => scopedMatchDoc(draft, ctx, 'draw'));
  const snapshots = new Map(existing.map(match => [match._id, match]));
  const matchIds = [...new Set([...snapshots.keys(), ...drafts.map(match => match._id)])];
  if (10 + matchIds.length + drafts.length > 100) return ok(refused('抽签场次超过单次处理容量，请缩小报名名单'));
  // 场号在 buildInitialMatches 内已由 court.js 统一排好，结果落库备查。

  const result = await ctx.repo.transaction(async tx => {
    const gate = await freshActorGate(tx, ctx, dir);
    if (!gate.ok) return refused(gate.message);
    const fresh = await tx.events.getById(payload.eventId);
    if (!isEventDoc(fresh) || !belongsToSchoolScope(fresh, ctx)) return refused('赛事不存在');
    if (!canDrawEvent(fresh, gate.actor)) return refused('只能在报名阶段抽签');
    if (fresh.revision !== doc.revision) return refused('赛事或报名刚被改过，请刷新后重新抽签');
    for (const id of matchIds) {
      const current = await tx.matches.getById(id);
      const snapshot = snapshots.get(id);
      if (current && (!belongsToSchoolScope(current, ctx) || current.status === MATCH_STATUS.ACTIVE || current.settlement)) {
        return refused('该赛事已有比赛确认生效，不能再重抽');
      }
      if (Boolean(current) !== Boolean(snapshot) || current &&
        (current.revision !== snapshot.revision || current.status !== snapshot.status)) {
        return refused('比赛刚被改过，请刷新后重新抽签');
      }
    }

    const nowIso = iso(ctx.now);
    for (const draft of drafts) {
      await tx.matches.set(draft._id, { ...draft, revision: Number(snapshots.get(draft._id)?.revision || 0) + 1 });
    }
    const next = { ...fresh, draw, action: 'draw', actor: ctx.actorId,
      actedAt: nowIso, revision: fresh.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(fresh._id, 'drawEvent', next.revision),
      action: 'drawEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: fresh._id, at: nowIso });
    return { ok: true, event: eventSummary(next), draw,
      matchIds: drafts.map(draft => draft._id), message: '' };
  });
  return ok(result);
}

/**
 * 代签（管理端）：把某位报名者的报名记录置为已签到。
 * 只有进行中的赛事可签；学院负责人只能签本学院的人，管理员不限。
 */
async function checkInSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请指定要签到的会员'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  // 【2026-10-26 第六轮 D】只要「目标会员 + 操作者」两个人的学院。
  // 这里**不能**用 actorDirectory：那会给别人的学院空串，而「目标学院为空」
  // 在 canCheckIn 里等同于「未指定目标」直接放行——学院边界会被绕过。
  const dir = await userDirectory(ctx, [userId]);
  // 始终带上目标学院，避免「未指定目标」的短路把学院边界放行（见 event.canCheckIn）。
  const target = { college: dir.collegeOf(userId) };

  const result = await ctx.repo.transaction(async tx => {
    const gate = await freshActorGate(tx, ctx, dir);
    if (!gate.ok) return refused(gate.message);
    const actor = gate.actor;
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canCheckIn(doc, actor, { target })) {
      return refused(doc.status !== EVENT_STATUS.ONGOING
        ? '只有进行中的赛事可以签到' : '你无权为这位会员签到');
    }

    const key = schoolEventSignupKey(doc._id, userId, ctx);
    const signup = await tx.eventSignups.getById(key);
    const built = buildCheckInPatch(signup, actor, { now: ctx.now });
    if (!built.ok) return refused(built.message);

    const nowIso = iso(ctx.now);
    const next = { ...signup, ...built.patch, checkInTime: nowIso, revision: signup.revision + 1 };
    await tx.eventSignups.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'checkInEvent', next.revision),
      action: 'checkInEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, targetUserId: userId, at: nowIso });
    return { ok: true, signup: signupDTO(next), message: '' };
  });
  return ok(result);
}

/**
 * 录入名次并结束赛事（进行中 → 已结束）。仅管理员。
 * 名次必须落在实际报名者身上，且按赛制的成对规则校验（validatePlacements）。
 */
async function finishSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  // 【2026-10-26 第六轮 D】目录只进身份闸，而 legacyActorOf 从目录里唯一取的就是
  // actorCollege。原来为此读全校名册 + 全量账号（2000 人的学校 40 次 RPC），
  // 现在一次点读学院名。
  const dir = await actorDirectory(ctx);
  const signups = await ctx.repo.forScope(ctx).eventSignups.listByEvent(payload.eventId);

  const result = await ctx.repo.transaction(async tx => {
    const gate = await freshActorGate(tx, ctx, dir);
    if (!gate.ok) return refused(gate.message);
    const actor = gate.actor;
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canFinishEvent(doc, actor)) {
      return refused(doc.status !== EVENT_STATUS.ONGOING
        ? '只有进行中的赛事可以录入名次' : '只有协会负责人及以上可以录入名次');
    }

    const validUsers = new Set(signups
      .filter(row => row.status !== SIGNUP_STATUS.CANCELED).map(row => row.userId));
    const entryCount = drawnEntryCount(doc.draw) || validUsers.size;
    const checked = validatePlacements(payload.results, {
      bronzeMode: doc.bronzeMode, entryCount, format: doc.format, matchType: doc.matchType,
    });
    if (!checked.ok) return refused(checked.firstError, { errors: checked.errors });
    if (checked.results.some(row => !validUsers.has(row.userId))) {
      return refused('名次里出现了没有报名这场赛事的会员');
    }

    const nowIso = iso(ctx.now);
    const next = { ...doc, status: EVENT_STATUS.FINISHED, results: checked.results,
      action: 'finish', actor: ctx.actorId, finishedAt: nowIso, actedAt: nowIso,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(doc._id, 'finishEvent', next.revision),
      action: 'finishEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, at: nowIso });
    return { ok: true, event: eventSummary(next), results: checked.results, message: '' };
  });
  return ok(result);
}

/**
 * 签表推进（内部动作，非客户端入口）：一轮全部打完 / 有弃权后，把下一轮补排出来。
 * 「只补不覆盖」——已有编号（含待确认）一律跳过，绝不抹掉已录的比分。
 * 由 school-match-service 在 confirm / forfeit 生效后调用。
 *
 * @param {Object} ctx
 * @param {string} eventId
 * @returns {Promise<{ok:boolean, inserted:number}>}
 */
async function advanceSchoolEvent(ctx, eventId) {
  // 误当成客户端 action 调用时（payload 顶到 ctx 位）在此立刻收手。
  if (!ctx || !ctx.repo || typeof eventId !== 'string' || !eventId) {
    return { ok: true, inserted: 0 };
  }
  const doc = await ctx.repo.events.getById(eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx) || !doc.draw) {
    return { ok: true, inserted: 0 };
  }

  const matches = await ctx.repo.forScope(ctx).matches.listByEvent(eventId);
  const plan = planStageMatches({ event: doc, draw: doc.draw, matches });
  if (!plan.ok) return { ok: true, inserted: 0 };

  const taken = new Set(matches.map(row => row._id));
  const drafts = buildPlannedDrafts(doc, plan.rounds, defaultFormatOf(ctx.association))
    .filter(draft => !taken.has(draft._id))
    .map(draft => scopedMatchDoc(draft, ctx, 'advance'));
  if (drafts.length === 0) return { ok: true, inserted: 0 };

  await ctx.repo.transaction(async tx => {
    for (const draft of drafts) {
      // 并发下两次确认可能同时推进：已有编号就不再写。
      const existing = await tx.matches.getById(draft._id);
      if (existing) continue;
      await tx.matches.set(draft._id, draft);
    }
  });
  return { ok: true, inserted: drafts.length };
}

module.exports = {
  EVENT_LIST_LIMIT, EVENT_LIST_MAX,
  isEventDoc, eventSummary, activeSignupCount, displaySignupCount, occupiedSignupCount, tallySignups,
  listSchoolEvents, getSchoolEvent, listSchoolEventSignups, publishSchoolEvent, setSchoolEventPinned,
  signUpSchoolEvent, cancelSchoolEventSignup,
  startSchoolEvent, drawSchoolEvent, checkInSchoolEvent, finishSchoolEvent,
  // 内部动作：供 school-match-service 在 confirm / forfeit 后补排下一轮。
  advanceSchoolEvent,
};
