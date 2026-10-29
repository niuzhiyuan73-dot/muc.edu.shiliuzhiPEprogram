/**
 * 学校维度：比赛记录 —— 录入 / 确认（即结算）/ 驳回 / 弃权 / 指派裁判（协议 2，M1）
 * ============================================================
 * 【确认即最终结算（Elo 逐场结算改造）】
 * confirmSchoolMatch 在确认的同一个事务里调用 school-rating-service 的
 * settleMatchInTransaction：参赛者评级落库并按当场比分逐场更新，比赛文档带上
 * 结算快照。已结算的比赛没有撤销入口（revokeSchoolMatch 已删除）；发现录错
 * 只能在确认前驳回。弃权（forfeitSchoolMatch）同样在事务里写「不计分」结算
 * 决定，保证每条 ACTIVE 记录都有可解释的结算快照。
 * ============================================================
 * 与旧栈 `match-record.js` 同一把尺子（权限判定与字段组装全部复用该纯模块），
 * 区别只在**归属**与**角色来源**：
 *   · 每条比赛记录同时绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 旧栈的 ROLE 数值由 S2 的校级 / 协会 / 学院角色推导（见 legacyRoleOf），
 *     学院代录的边界按「本学院有人上场」判定，与旧栈 involvesCollege 一致。
 *
 * 【签表晋级什么时候补排】
 * confirm / forfeit 在旧栈会触发 `advanceEvent` 排下一轮。本轮补排依赖抽签签表，
 * 由 `school-event-service.advanceSchoolEvent` 提供，确认 / 弃权生效后调用它
 * （「只补不覆盖」，见 format-plan.js）。日常约球没有 eventId，自然跳过。
 *
 * 【既有赛程比赛的补录】
 * 抽签排定的比赛（个人赛签表场次、学院赛小场）在库里已有主：补录只补比分与
 * 录入人，对阵 / 赛制 / 时间一律取自那条记录本身，绝不另立新记录（否则签表里
 * 写的是一组对阵、比赛页里却是另一组）。见 `submitScheduledMatch`，与旧栈
 * `submitMatch` 的 id 分支同一把尺子（`fillScheduledMatch`）。
 *
 * 【确认口径为什么分 mock / 云端】
 * 沿用旧栈：生产是「对手确认」，本地演示只有一个账号，mock 下放宽为「参与即可」。
 * 由 mock 端在 ctx 上打 `isMock: true`，云端不设该字段（默认严格）。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
// 角色 / 名单的推导收在 school-actor，两套栈只有一份口径。
const {
  legacyRoleOf, buildDirectory, recordOptions, recordDirOf, recordDirOfUsers, EMPTY_RECORD_DIR,
} = require('./school-actor.js');
const {
  schoolKey, schoolMemberKey, belongsToSchoolScope, schoolMatchKey, schoolLiveKey,
  pairCountKey, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS,
} = require('../utils/school.js');
const {
  MATCH_TYPE, MATCH_TYPE_LABEL,
  MATCH_STATUS, MATCH_STATUS_LABEL, MATCH_COMPETITION, MATCH_OUTCOME, EVENT_STATUS, ROLE,
} = require('../utils/constants.js');
const {
  canRecordScore, canConfirm, canConfirmIdentity, canAssignReferee, canForfeit, needsScore,
  isParticipant, buildMatchRecord, fillScheduledMatch, buildRefereePatch, buildForfeitPatch,
} = require('./match-record.js');
const { settleMatchInTransaction } = require('./school-rating-service.js');
const {
  seasonPairCounts, crossPairList, tallyPairUsage,
  findCappedPairs, pairCapMessage, isCasualMatch,
} = require('./rating-cap.js');
const { loadSeason } = require('./school-rank-service.js');
const { RATED_PAIR_LIMIT } = require('../utils/constants.js');
// 团队运动不得走个人录分：这是后端闸门，见 submitSchoolMatch 顶部。
const { isTeamSport } = require('../utils/associations.js');
const { liveScoreOf } = require('./live-score.js');
const { advanceSchoolEvent } = require('./school-event-service.js');
// 学院赛小场生效后的收尾：把结果写回大场、必要时排出下一轮（M2-c2）。
const { advanceCollegeAfterLeg } = require('./school-college-advance.js');
const { isListMatch, listFilter, encodeMatchCursor, decodeMatchCursor } = require('./match-list-query.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MATCH_LIST_LIMIT = 100;
/**
 * listSchoolMatches 的 limit 硬上限。数据库只取当前页、实时比分按页批读，
 * 仍须限制 DTO 数量以控制回包体积。与 MATCH_LIST_LIMIT 同值：默认即上限。
 */
const MATCH_LIST_MAX = 100;

const iso = value => new Date(value).toISOString();
const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});
const matchAuditKey = (matchId, action, revision) =>
  schoolKey('mau', matchId, action, String(revision));

const isMatchDoc = isListMatch;

/**
 * 交手名额的计数文档（每对每赛季一条）。
 * ============================================================
 * 为什么需要它（2026-10-16 独立验收 F3）：上限原先只按「事务外读到的整份台账」
 * 判断，两个并发请求拿到同一份「还差一场」的快照，各自都能通过；两边写的是
 * **不同的比赛文档**，谁也拦不住谁，最终 16 场 > 上限 15。
 * 计数文档就是给这一对准备的**共享冲突点**：提交时在同一事务里读它、加一、写回，
 * 于是并发的第二次要么在真库上写冲突重试、要么在内存仓储的串行事务队列里排队，
 * 重试后必然看见第一次的结果，闸门这才真的生效。
 *
 * 【懒初始化】
 * 文档不存在＝这一对在本赛季还没走过新口径（历史数据、规则生效前录的场次）。
 * 用事务外台账算出的用量做初值写进去；两个并发请求同时初始化时，谁先写谁赢，
 * 后到的那次要么冲突重试、要么（内存仓储）排队后直接读到。所以不必先跑批迁移。
 *
 * 【为什么释放时「没有文档就不建」】
 * 作废（撤销 / 驳回）要对称地把名额还回去。但这一场可能是新口径之前录的：
 * 那时台账里已经算过它、计数文档却还不存在。这时凭空写一条 count=0 会把台账里的
 * 占用抹掉；正确做法是不建——下次提交按台账懒初始化，自然会算上（作废的场次
 * 本来就不计入用量）。
 */

/** 一场比赛涉及的无序对（按 key 去重；双打最多四对）。 */
const distinctPairs = record => {
  const seen = new Set();
  const out = [];
  for (const pair of crossPairList(record)) {
    if (seen.has(pair.key)) continue;
    seen.add(pair.key);
    out.push(pair);
  }
  return out;
};

/** 赛季分界点的键形态：与 rating-cap.countedMatches 用的是同一个值（空＝从未重置）。 */
const seasonStampOf = season => (season && season.resetTime ? iso(season.resetTime) : 'all');

/** 计数文档的键：范围 + 赛季分界点 + 两人编号。 */
const pairUsageKeyOf = (pair, ctx, season) => pairCountKey(pair.a, pair.b, seasonStampOf(season), ctx);

/**
 * 事务内复核并占用这一场的交手名额。名额已满时一个都不占（要么全占、要么全拒）。
 *
 * @param {Object} tx 事务内仓储
 * @param {Object} ctx 事务内 fresh 上下文（提供 schoolId / association / now）
 * @param {Object} record 待写入的比赛记录（buildMatchRecord 的产物）
 * @param {Object} options
 * @param {number} options.limit 每对每赛季上限
 * @param {Object} options.season 本范围赛季文档（决定键与是否已重置）
 * @param {Map<string,number>} options.seedUsage 事务外按台账算出的用量（懒初始化用）
 * @param {Function} [options.nameOf] 编号 → 昵称，供提示文案
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function occupyPairUsage(tx, ctx, record, options) {
  const { limit, season, seedUsage, nameOf = null } = options;
  // 只有「自行录入」的日常约球占名额；赛事 / 学院赛比赛有名次与赛程兜底，不设限
  if (!isCasualMatch(record)) return { ok: true, message: '' };
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true, message: '' };

  const pendingWrites = [];
  const usedByKey = new Map();
  for (const pair of distinctPairs(record)) {
    const id = pairUsageKeyOf(pair, ctx, season);
    const doc = await tx.pairCounts.getById(id);
    const used = doc ? Number(doc.count || 0)
      : Number((seedUsage && seedUsage.get(pair.key)) || 0);
    usedByKey.set(pair.key, used);
    pendingWrites.push({ id, doc, pair, used });
  }

  const capped = findCappedPairs(distinctPairs(record), usedByKey, { limit });
  if (!capped.ok) return { ok: false, message: pairCapMessage(capped.full, { limit, nameOf }) };

  const nowIso = iso(ctx.now);
  for (const item of pendingWrites) {
    // 先铺开已有文档再覆盖：预算置时写的 seededAt 之类的字段不该被占位写回抹掉，
    // 将来往这条文档上加新字段也不会因为少列一个键就消失。
    await tx.pairCounts.set(item.id, {
      ...(item.doc || {}),
      _id: item.id, schoolId: ctx.schoolId, association: ctx.association,
      seasonStamp: seasonStampOf(season), seasonNumber: Number(season && season.seasonNumber) || 1,
      pairKey: item.pair.key, users: [item.pair.a, item.pair.b],
      count: item.used + 1,
      revision: Number((item.doc && item.doc.revision) || 0) + 1,
      updatedAt: nowIso,
    });
  }
  return { ok: true, message: '' };
}

/** 作废一场「自行录入」的比赛时，把名额还回去（与 occupyPairUsage 对称）。 */
async function releasePairUsage(tx, ctx, record) {
  if (!isCasualMatch(record)) return;
  const season = await loadSeason(ctx);
  const nowIso = iso(ctx.now);
  for (const pair of distinctPairs(record)) {
    const id = pairUsageKeyOf(pair, ctx, season);
    const doc = await tx.pairCounts.getById(id);
    if (!doc) continue;
    await tx.pairCounts.set(id, {
      ...doc,
      count: Math.max(0, Number(doc.count || 0) - 1),
      revision: Number(doc.revision || 1) + 1,
      updatedAt: nowIso,
    });
  }
}

/** 编号 → 昵称（提示文案用）；拿不到就退回编号。 */
function nameResolverOf(dir) {
  const byId = new Map((dir && dir.members ? dir.members : []).map(user => [user._id, user.nickName || user.realName || user._id]));
  return id => byId.get(id) || id;
}

/** 比赛记录 DTO：数据 + 权限旗标，展示交给页面。 */
function matchSummary(doc, ctx, dir) {
  const options = recordOptions(ctx, dir);
  const self = ctx.actorId;
  const pending = doc.status === MATCH_STATUS.PENDING;
  return {
    matchId: doc._id,
    matchType: doc.matchType,
    matchTypeLabel: MATCH_TYPE_LABEL[doc.matchType] || '',
    pool: doc.pool,
    isDoubles: doc.matchType === MATCH_TYPE.DOUBLES,
    teamA: [...(doc.teamA || [])],
    teamB: [...(doc.teamB || [])],
    scoreA: [...(doc.scoreA || [])],
    scoreB: [...(doc.scoreB || [])],
    winner: doc.winner || '',
    gamePoints: doc.gamePoints,
    bestOf: doc.bestOf,
    // 网球三层计分的赛制字段。个人赛其余项目为缺省值（不写这些字段），
    // 展示端据 scoring 决定把比分读成「局」还是「盘」。
    scoring: doc.scoring || 'point',
    setGames: doc.setGames,
    tiebreakAt: doc.tiebreakAt,
    tiebreakPoints: doc.tiebreakPoints,
    noAd: doc.noAd === true,
    tiebreaks: Array.isArray(doc.tiebreaks) ? doc.tiebreaks.map((item) => ({ ...item })) : [],
    matchTime: doc.matchTime || null,
    location: doc.location || '',
    eventId: doc.eventId || null,
    competition: doc.competition || MATCH_COMPETITION.PERSONAL,
    // 学院赛小场专属：小项、所属大场与轮次、所属学院赛、对阵双方学院。个人赛这几项
    // 为空，展示端据 competition 分流（学院赛录分页用它们回查大场与赛事）。
    discipline: doc.discipline || '',
    tieId: doc.tieId || '',
    legNo: doc.legNo === undefined ? null : Number(doc.legNo),
    collegeEventId: doc.collegeEventId || '',
    collegeA: doc.collegeA || '',
    collegeB: doc.collegeB || '',
    // 比赛编排字段：签表、分组与场地展示共享同一契约，页面不必从别处反查。
    // 非签表生成（自由录入）的比赛这几项为空，展示端退化为「无轮次 / 无场号」。
    round: doc.round === undefined ? null : Number(doc.round),
    stage: doc.stage || '',
    group: doc.group === undefined ? null : Number(doc.group),
    slot: doc.slot === undefined ? null : Number(doc.slot),
    courtNo: doc.courtNo === undefined ? null : Number(doc.courtNo),
    status: doc.status,
    statusLabel: MATCH_STATUS_LABEL[doc.status] || '',
    action: doc.action || '',
    reason: doc.reason || '',
    outcome: doc.outcome || MATCH_OUTCOME.NORMAL,
    recorder: doc.recorder || '',
    referee: doc.referee || '',
    hasReferee: Boolean(String(doc.referee || '').trim()),
    isMine: Boolean(self && isParticipant(doc, self)),
    needsScore: needsScore(doc),
    canRecord: pending && needsScore(doc) && canRecordScore(doc, self, options),
    canSubmitScore: pending && canRecordScore(doc, self, options),
    confirmRelaxed: ctx.isMock === true && canConfirm(doc, self, { isMock: true, role: options.role }) &&
      !canConfirm(doc, self, { isMock: false, role: options.role }),
    canConfirm: canConfirm(doc, self, { isMock: ctx.isMock === true, role: options.role }),
    // 撤销已随 Elo 逐场结算改造取消：比赛一经确认即为最终结算，无撤销入口
    canForfeit: canForfeit(doc, self, self, { role: options.role }),
    canAssignReferee: canManageAssociationSpace(ctx) && canAssignReferee(doc),
    // 结算快照（已结算的计分/不计分比赛才有）：前端「已计分/不计分原因」展示用
    settlement: doc.settlement || null,
    revision: Number(doc.revision || 1),
  };
}

/* ------------------------------------------------------------------ 读 */

/**
 * 给比赛 DTO 补上实时比分（只有开过计分台的才有）。
 *
 * 【为什么读端要带 live】
 * 查看端首屏就得是实时值，不能「先 0:0 再跳」；页面据 `live` 判断哪几场要挂
 * 轮询取增量（见 live-watch）。轮询本身只回比分字段，这条是首帧的来源。
 * 实时态按 `matchId` 索引、随归属隔离——别校 / 别协会的读不到。
 */
async function withLive(summary, ctx) {
  const state = await ctx.repo.liveScores.getById(schoolLiveKey(summary.matchId, ctx));
  if (!state || !belongsToSchoolScope(state, ctx)) return summary;
  return { ...summary, live: liveScoreOf(state) };
}

async function listSchoolMatches(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, matches: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const limit = Number.isInteger(payload.limit) && payload.limit >= 0
    ? Math.min(payload.limit, MATCH_LIST_MAX) : MATCH_LIST_LIMIT;
  const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
  // 【游标统一成不透明字符串】（2026-10-29 第十一轮审计 P2-7）
  // 入参同时接受字符串（新口径，客户端原样回传）与 `{matchTime, id}` 对象
  // （内部调用 / 旧客户端），返回只有字符串。两套类型并存是上一版的问题：
  // 同名同义的 nextCursor 在比赛这一路是对象、其余列表是字符串，任何统一封装
  // 都会踩到 `[object Object]`。
  let cursor = null;
  const rawCursor = payload.cursor;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    const decoded = typeof rawCursor === 'string' ? decodeMatchCursor(rawCursor) : rawCursor;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
        || typeof decoded.id !== 'string' || !decoded.id || decoded.id.length > 512
        || typeof decoded.matchTime !== 'string' || decoded.matchTime.length > 32
        || !Number.isFinite(Date.parse(decoded.matchTime))
        || new Date(decoded.matchTime).toISOString() !== decoded.matchTime) {
      return ok(refused('比赛分页游标无效'));
    }
    cursor = { matchTime: decoded.matchTime, id: decoded.id };
  }
  if (cursor && offset > 0) return ok(refused('比赛分页游标无效'));
  const page = await ctx.repo.forScope(ctx).matches.listPage({
    filter: listFilter(payload), limit, offset, cursor,
  });
  // 【不再为一页比赛读全校名册】（2026-10-23 第三轮审查 X-3）
  // 原实现每次翻页都 `buildDirectory`：2000 人的学校 = 20（名册）+ 20（账号）+ 1
  // = 41 次 RPC，而首页六个协会各要一次，光目录就两百多次。
  // 真正用到的只有「这页参赛者属于哪个学院」——学院关系只参与**学院负责人**
  // 那一档的行级判定（管理员与参赛者本人在 canRecordScore 里更早返回），
  // 所以非学院负责人直接给空目录，学院负责人按这页的人批读学籍。
  const participants = [];
  for (const doc of page.rows) {
    for (const id of [...(doc.teamA || []), ...(doc.teamB || [])]) {
      if (typeof id === 'string' && id) participants.push(id);
    }
  }
  const dir = legacyRoleOf(ctx) === ROLE.STAFF
    ? await recordDirOfUsers(ctx, participants)
    : EMPTY_RECORD_DIR;
  const states = page.rows.length ? await ctx.repo.liveScores.listByIds(
    page.rows.map(doc => schoolLiveKey(doc._id, ctx))) : [];
  const byId = new Map(states.filter(state => belongsToSchoolScope(state, ctx)).map(state => [state._id, state]));
  const matches = page.rows.map(doc => {
    const summary = matchSummary(doc, ctx, dir);
    const state = byId.get(schoolLiveKey(doc._id, ctx));
    return state ? { ...summary, live: liveScoreOf(state) } : summary;
  });
  const last = page.rows[page.rows.length - 1];
  return ok({ ok: true, canManage: canManageAssociationSpace(ctx), matches,
    total: page.total, hasMore: page.hasMore, pendingCount: page.pendingCount,
    // 空串 = 没有下一页（与公告 / 成员 / 分组 / 训练同一口径）。
    nextCursor: page.hasMore && last ? encodeMatchCursor({ matchTime: last.matchTime, id: last._id }) : '',
    message: '' });
}

/** 赛季分界点 → ISO 串（`listSince` 的入参）。无分界点返回 ''，表示不限时间。 */
function sinceIsoOf(season) {
  const raw = season && season.resetTime;
  if (!raw) return '';
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * 这场比赛涉及的每一对，本赛季已经用掉多少次名额。
 *
 * 【为什么要分两条路】（2026-10-22 第二轮审查 P-2）
 * 计数文档（pairCounts）是名额的权威数据：`occupyPairUsage` 事务内先点读它，
 * 读不到才用事务外的台账算初值（历史数据、规则生效前录的场次）。
 * 而原实现**无论文档在不在**都先把全量台账读一遍用于预判与初值——练了三年的
 * 协会，一次录分要翻上百页 RPC，绝大多数场次却根本用不到那份台账。
 *
 * 现在：先点读这场涉及的最多 4 对（双打 4 对）。全都有文档 ⇒ 直接用文档里的
 * count，一次台账都不读；只有缺文档时才回落到「本赛季台账」兜底。
 *
 * @param {Object} ctx
 * @param {Object} record 待写入的比赛记录
 * @param {Object} season 本范围赛季文档
 * @returns {Promise<Map<string,number>>} pairKey → 本赛季已用次数
 */
async function pairUsageOf(ctx, record, season) {
  if (!isCasualMatch(record)) return new Map();
  if (!Number.isFinite(RATED_PAIR_LIMIT) || RATED_PAIR_LIMIT <= 0) return new Map();
  const scoped = ctx.repo.forScope(ctx);
  const pairs = distinctPairs(record);
  const docs = await Promise.all(pairs.map(pair =>
    scoped.pairCounts.getById(pairUsageKeyOf(pair, ctx, season))));

  const usage = new Map();
  const missing = [];
  pairs.forEach((pair, index) => {
    const doc = docs[index];
    if (doc) usage.set(pair.key, Number(doc.count) || 0);
    else missing.push(pair);
  });
  if (missing.length === 0) return usage;

  const ledger = await scoped.matches.listSince(sinceIsoOf(season));
  const seeded = tallyPairUsage(ledger, { seasonStart: season.resetTime });
  for (const pair of missing) {
    if (seeded.has(pair.key)) usage.set(pair.key, seeded.get(pair.key));
  }
  return usage;
}

/** 录入页所需的本人、有效成员及本赛季交手次数；不暴露数字角色。 */
async function getSchoolMatchEntryContext(_payload, ctx) {
  const viewer = ctx.actor && ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE
    ? { userId: ctx.actorId, nickName: ctx.actor.nickName || '' } : null;
  if (!canReadAssociationSpace(ctx)) return ok({ ok: true, viewer, canRecord: false,
    members: [], pairInfo: null, seasonStart: null, message: viewer ? '当前账号没有本协会有效身份，暂时不能录入成绩' : '请先登录后再录入比赛成绩' });
  const [dir, season] = await Promise.all([buildDirectory(ctx), loadSeason(ctx)]);
  // 只取「本赛季 + 含本人」的场次：名额口径本来就按 resetTime 过滤，而下面的
  // seasonPairCounts 只对含本人的场次敏感——两件事一起下推，一个练了三年的协会
  // 从 30 页 RPC 降到 1~2 页，输出逐字不变（2026-10-23 第三轮 X-7）。
  const ledger = await ctx.repo.forScope(ctx).matches.listMineSince(ctx.actorId, sinceIsoOf(season));
  return ok({ ok: true, viewer, canRecord: canParticipateInAssociation(ctx),
    // 【为什么不下发 realName】（2026-10-23 第三轮审查 X-6）
    // 这里的门槛只是「本协会有效会员」（canParticipateInAssociation），而名单是
    // **全校在册会员**：一旦带上真名，任何刚入会的人打开一次录分页就能拿到
    // 「编号 ↔ 真实姓名」对照表（抓包即得）。选人只需要「认得是谁」，
    // 昵称加首字足够；真名留给管理侧的名录/审核接口（按角色发放）。
    members: dir.members.filter(user => user.platformStatus === PLATFORM_STATUS.ACTIVE).map(user => ({
      userId: user._id, nickName: user.nickName || '',
    })), seasonStart: season.resetTime || season.anchorTime || null,
    pairInfo: { counts: seasonPairCounts(ctx.actorId, ledger, { seasonStart: season.resetTime }), limit: RATED_PAIR_LIMIT }, message: '' });
}

async function getSchoolMatch(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));
  const doc = await ctx.repo.matches.getById(payload.matchId);
  if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('找不到这场比赛'));
  // 【2026-10-23 H-4】单场详情只需要「操作者学院 + 这两队选手的学院」：
  // 学院关系只在**学院负责人**那一档参与判定（管理员与参赛者本人在
  // canRecordScore 里更早就返回了），没必要为此读全院名册（2000 人 = 40 次 RPC）。
  const dir = legacyRoleOf(ctx) === ROLE.STAFF
    ? await recordDirOf(ctx, doc)
    : EMPTY_RECORD_DIR;
  const match = await withLive(matchSummary(doc, ctx, dir), ctx);
  if (payload.presentation === true) {
    const ids = [...new Set([...(doc.teamA || []).slice(0, 2), ...(doc.teamB || []).slice(0, 2), doc.referee].filter(Boolean))];
    const users = ids.length ? await ctx.repo.users.listByIds(ids) : [];
    return ok({ ok: true, match, viewer: { userId: ctx.actorId, nickName: ctx.actor.nickName || '' },
      members: users.map(user => ({ userId: user._id, nickName: user.nickName || '会员' })), message: '' });
  }
  return ok({ ok: true, match, message: '' });
}

/**
 * 把这场比赛涉及的计数文档预置出来（幂等，只写初值不占位）。
 *
 * 【为什么必须在事务之前建】（2026-10-22 第二轮审查 B-3）
 * 两个人同时给同一对录「本赛季第一场」时，两个事务里都读不到计数文档，于是
 * 各自用台账算出的**同一个初值**去加一，写成 `count = seed + 1` —— 少记一场，
 * 每对每赛季的上限被悄悄放宽（等级分是零和的，这种偏差事后看不出来）。
 *
 * 预置之后事务内一定读到同一份文档：后一个请求读到的就是前一个刚写下的值，
 * 递增落在同一行上；即便云端因写冲突回滚重试，重读到的也是对方的成果。
 *
 * 【为什么写的是 seed 而不是 seed+1】
 * 预置只是"把懒初始化提前"，不代表占位：提交若被名额闸门拒掉、或事务失败，
 * 这条文档停在初值即可，下一次提交读到它照样算得对。重复预置也幂等。
 *
 * @param {Object} ctx
 * @param {Object} record 待写入的比赛记录
 * @param {Object} season 本范围赛季文档
 * @param {Map<string,number>} usage pairKey → 本赛季已用次数（见 pairUsageOf）
 * @returns {Promise<void>}
 */
async function ensurePairCounters(ctx, record, season, usage) {
  if (!isCasualMatch(record)) return;
  if (!Number.isFinite(RATED_PAIR_LIMIT) || RATED_PAIR_LIMIT <= 0) return;
  const pairs = distinctPairs(record);
  if (pairs.length === 0) return;

  const scoped = ctx.repo.forScope(ctx);
  // 一次事务写完这几对（双打最多 4 对）：省得每对单开一个事务
  await scoped.transaction(async (tx) => {
    for (const pair of pairs) {
      const id = pairUsageKeyOf(pair, ctx, season);
      const existing = await tx.pairCounts.getById(id);
      if (existing) continue;
      await tx.pairCounts.set(id, {
        _id: id,
        schoolId: ctx.schoolId,
        association: ctx.association,
        seasonStamp: seasonStampOf(season),
        seasonNumber: Number(season && season.seasonNumber) || 1,
        pairKey: pair.key,
        users: [pair.a, pair.b],
        count: Number(usage.get(pair.key) || 0),
        revision: 1,
        seededAt: iso(ctx.now),
        updatedAt: iso(ctx.now),
      });
    }
    return null;
  });
}

/* ------------------------------------------------------------------ 写 */

async function submitSchoolMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));

  // 团队运动（篮球/足球/排球）没有「个人录分」这条路：一场 5v5 既不是单打也
  // 不是双打，写进 matches 会污染个人 Elo 与评级表。后端在这里硬拒，不靠前端
  // 藏入口——藏按钮挡不住直接调接口（见 docs/篮球协会-需求与实施规划.md §7）。
  if (isTeamSport(ctx.association)) {
    return ok(refused('该协会为团队项目，比赛成绩请在球队赛事中录入'));
  }

  const dir = await buildDirectory(ctx);

  // 既有赛程比赛（个人赛签表 / 学院赛小场）的补录：只补比分，对阵 / 赛制 / 时间
  // 一律取自那条记录本身，走独立通路、不另立新记录（见 submitScheduledMatch）。
  if (payload.matchId) return ok(await submitScheduledMatch(payload, ctx, dir));

  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('录入请求编号无效'));

  // 新比赛的阵容按「在册 **且** 账号可用」校验（2026-10-16 独立验收 F4）：
  // 与录分页可选名单同一口径，改请求体直接传停用会员的编号也不会被收下。
  const roster = dir.activeMemberIds;
  const built = buildMatchRecord(
    { ...payload, recorder: ctx.actorId },
    { members: roster, now: ctx.now }
  );
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors, scoreErrors: built.scoreErrors }));

  const nameOf = nameResolverOf(dir);
  // 事务外的预判只为了「明显不行就别进事务」；真正管用的是事务内那一遍（见下）
  if (!canRecordScore(built.record, ctx.actorId, recordOptions(ctx, dir))) {
    return ok(refused('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩'));
  }

  // 防刷分闸门：预判与初值共用同一份「每对已用次数」（见 pairUsageOf）。
  // 只有计数文档缺失（历史数据）时才读本赛季台账。
  const season = await loadSeason(ctx);
  const pairUsage = await pairUsageOf(ctx, built.record, season);
  // 把计数文档预置到事务之前：两个并发请求才不会各自拿同一个初值各加一次
  // （见 ensurePairCounters）。预置失败不致命——事务内会回退到 seedUsage。
  try {
    await ensurePairCounters(ctx, built.record, season, pairUsage);
  } catch (err) {
    console.warn('[match] 名额计数预置失败，回退到台账初值', err && (err.message || err));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('没有读取协会空间的权限');
    // 【录分资格必须在事务内按最新身份重判】2026-10-16 独立验收 F2：
    // 预检查用的是请求进入时的上下文，管理员在这之后被撤权，这一笔仍会写进去。
    // 角色、学院都取事务内重读到的身份（见 recordOptions）。
    if (!canRecordScore(built.record, fresh.actorId, recordOptions(fresh, dir))) {
      return refused('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩');
    }
    const matchId = schoolMatchKey(schoolKey('m', fresh.actorId, token), fresh);
    const existing = await tx.matches.getById(matchId);
    if (isMatchDoc(existing)) {
      return existing.fingerprint === fingerprintOf(built.record)
        ? { ok: true, match: matchSummary(existing, fresh, dir), message: '' }
        : refused('请求编号已使用，请重新录入');
    }
    const freshSeason = await loadSeason(fresh);
    // 一对会员本赛季打满上限后不再让录：先按同一份用量判一次（一句人话），
    // 再按事务内的计数文档复核并占位——后者才是并发下真正管用的那一道。
    const capped = findCappedPairs(distinctPairs(built.record), pairUsage, { limit: RATED_PAIR_LIMIT });
    if (!capped.ok) return refused(pairCapMessage(capped.full, { limit: RATED_PAIR_LIMIT, nameOf }));
    // 赛季在事务外/事务内若跨过了重置点，旧赛季的用量不能当成新赛季的初值
    const seedUsage = seasonStampOf(freshSeason) === seasonStampOf(season) ? pairUsage : new Map();
    const occupied = await occupyPairUsage(tx, fresh, built.record, {
      limit: RATED_PAIR_LIMIT, season: freshSeason, seedUsage, nameOf,
    });
    if (!occupied.ok) return refused(occupied.message);

    const doc = matchDocFromRecord(built.record, matchId, fresh, fingerprintOf(built.record));
    await tx.matches.set(matchId, doc);
    await tx.audit.append({ _id: matchAuditKey(matchId, 'submitMatch', 1),
      action: 'submitMatch', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId, at: iso(fresh.now) });
    return { ok: true, match: matchSummary(doc, fresh, dir), message: '' };
  });
  return ok(result);
}

/**
 * 既有赛程比赛的补录（带 matchId）：个人赛签表场次与学院赛小场都走这条。
 * ============================================================
 * 抽签已把「谁打谁、第几轮、哪个签位」定死，补录只该补比分与录入人——对阵 /
 * 赛制 / 时间全部取自那条待确认记录（`fillScheduledMatch` 只收比分、不改阵容），
 * 与旧栈 `submitMatch` 的 id 分支、云端 `submitScheduledMatch` 是同一把尺子。
 * 录分权限同样复用 `canRecordScore`：场上的人、本学院有人上场的负责人、管理员。
 *
 * 【为什么不另立记录】赛程比赛在签表 / 大场里占着位置，另立一条会让签表与比赛页
 * 各认一份，签表就自相矛盾了（见 fillScheduledMatch 头注）。
 * 【为什么不用 requestId 键】这条记录的编号本身就是稳定键；待确认时重复补录是
 * 允许的（改错比分），确认生效后由 `fillScheduledMatch` 挡下（非「待确认」）。
 * 【比赛时间为什么回填 doc.matchTime】签表钉死的时间不因补录而变，原样保留 ISO
 * 字符串，避免把 Date 对象写进库（各处按字符串解析）。
 *
 * @param {Object} payload { matchId, scoreA, scoreB }
 * @param {Object} ctx
 * @param {Object} dir buildDirectory 的结果（权限判定与阵容校验共用）
 * @returns {Promise<Object>} {ok, match, message}
 */
async function submitScheduledMatch(payload, ctx, dir) {
  return ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('没有读取协会空间的权限');
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('找不到这场比赛');
    if (!canRecordScore(doc, fresh.actorId, recordOptions(fresh, dir))) {
      return refused('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩');
    }

    const filled = fillScheduledMatch(doc, { scoreA: payload.scoreA, scoreB: payload.scoreB }, {
      // 【为什么不传名单】对阵由抽签钉死，参赛者是既成事实，这里只补比分。
      // 若拿「当前可用会员」去校验，一方事后被平台停用就会把对手永久卡在
      // 「录不了分」上——2026-10-16 用户定的口径：已排定的赛程照常录分，
      // F4 那条「停用选手不得进新比赛」只管新比赛与新阵容。
      // 时间下界不设（与日常约球同口径，S2 赛季锚点归 M4）。
      now: fresh.now, recorder: fresh.actorId,
    });
    if (!filled.ok) {
      return refused(filled.firstError, { errors: filled.errors, scoreErrors: filled.scoreErrors });
    }

    const nowIso = iso(fresh.now);
    const next = {
      ...doc, ...filled.patch,
      // 赛程时间由签表钉死，补录不改；范围与版本显式盖回。
      matchTime: doc.matchTime,
      schoolId: fresh.schoolId, association: fresh.association,
      status: MATCH_STATUS.PENDING, action: 'submit', actor: fresh.actorId, actedAt: nowIso,
      revision: Number(doc.revision || 1) + 1,
    };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'submitScheduledMatch', next.revision),
      action: 'submitScheduledMatch', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId: doc._id, at: nowIso });
    return { ok: true, match: matchSummary(next, fresh, dir), message: '' };
  });
}

async function confirmSchoolMatch(payload = {}, ctx) {
  const result = await transition(payload, ctx, {
    action: 'confirm',
    auditAction: 'confirmMatch',
    message: '你无权确认这场比赛',
    // 确认资格与状态解耦（canConfirmIdentity）：待确认时正常盖章；已结算时
    // 凭同一资格返回既有结算结果（确认响应丢失后的重试，§6 约束 6）。
    allow: (doc, opts) => canConfirmIdentity(doc, ctx.actorId, opts),
    requireWinner: true,
    settle: true,
    patch: () => ({ status: MATCH_STATUS.ACTIVE }),
  });
  const resolved = await advanceAfterResolved(ctx, result.data);
  return ok(await advanceCollegeAfterResolved(ctx, resolved));
}

/** 一场签表比赛确认 / 弃权生效后补排下一轮；日常约球（无 eventId）跳过。 */
async function advanceAfterResolved(ctx, result) {
  if (result && result.ok && result.match && result.match.eventId) {
    await advanceSchoolEvent(ctx, result.match.eventId);
  }
  return result;
}

/**
 * 学院赛小场生效后的收尾：把结果写回大场、定出大场胜负，并在本轮打完时排出下一轮。
 * 走的是与个人赛不同的一条链路（小场 `eventId` 留空，`advanceAfterResolved` 会跳过）。
 * 按编号重读一次原始文档再交给 `advanceCollegeAfterLeg`——推进读的是台账最终态。
 */
async function advanceCollegeAfterResolved(ctx, result) {
  if (!result || !result.ok || !result.match) return result;
  if (result.match.competition !== MATCH_COMPETITION.COLLEGE) return result;
  const doc = await ctx.repo.matches.getById(result.match.matchId);
  if (doc) await advanceCollegeAfterLeg(ctx, doc);
  return result;
}

/**
 * 父赛事已进终态时，比赛记录不可再改。
 *
 * 【为什么需要这道闸（2026-10-16 审计）】confirm / reject / forfeit 原先
 * 只看比赛自身的状态，不看父赛事。于是「赛事已结束、名次已公布」之后，
 *   · 还能把 PENDING 的比赛确认生效 —— 收尾的 `advanceSchoolEvent` 会在**已结束**
 *     的赛事上再补排一轮（凭空多出一场决赛）；
 *   · 还能把比赛驳回 / 弃权 —— 而对外公布的 results 纹丝不动。
 * 名次是唯一对外口径，赛事结束就该只读；要更正得走赛事修订，不是偷偷改比赛。
 *
 * 日常约球没有 eventId，自然跳过（它们不受任何赛事约束）；学院赛小场的
 * eventId 留空，其父赛事是大场/学院赛，闸门在 school-college-service 那侧。
 *
 * @param {Object} tx 事务内仓储
 * @param {Object} doc 比赛记录
 * @returns {Promise<string>} 非空即为拒绝理由
 */
async function finishedEventBlocker(tx, doc) {
  if (typeof doc.eventId !== 'string' || !doc.eventId) return '';
  const event = await tx.events.getById(doc.eventId);
  if (!event || event.status !== EVENT_STATUS.FINISHED) return '';
  return '赛事已结束，比赛记录不可再改';
}

async function rejectSchoolMatch(payload = {}, ctx) {
  const reason = String(payload.reason || '').trim();
  if (!reason) return ok(refused('请填写驳回理由'));
  return transition(payload, ctx, {
    action: 'reject',
    auditAction: 'rejectMatch',
    message: '你无权驳回这场比赛',
    // 与 confirm 同源的资格判断；待确认状态由 requirePending 单独闸（已结算的
    // 比赛走到这里只会得到「只有待确认的比赛可以驳回」，而不是误导性的无权限）。
    allow: (doc, opts) => canConfirmIdentity(doc, ctx.actorId, opts),
    requirePending: true,
    patch: () => ({ status: MATCH_STATUS.REVOKED, reason }),
  });
}

/**
 * confirm / reject 共用的状态机：取记录 → 判权 →（结算）→ 写状态 + 审计。
 *
 * 【为什么要拿事务内的 fresh 重判身份与角色】2026-10-16 独立验收 F1：
 * 原先只判「记录归属 + 行级权限」，而行级权限用的角色取自请求进入时的上下文；
 * 一个已被停用的账号（platformStatus !== active）读不了任何数据，却仍能把
 * 比赛确认成生效。现在事务内先过「账号 / 学籍 / 学校协会有效」这道闸，
 * 再用重读到的角色重算行级权限——请求飞在路上时被停用、被撤权都不算数。
 *
 * 【spec.settle —— 确认即结算】
 * 置位时在同一个事务里调 `settleMatchInTransaction`：点读全部参赛者评级与
 * 范围序号计数，算出结算快照，随比赛文档一并落盘。赛事等级在事务内点读
 * 赛事文档决定（match.level > event.level > 日常 K），不信任客户端 level。
 * 比赛已带结算快照时（确认响应丢失后的重试）直接返回既有结果，不加分、
 * 不重复结算——防重不依赖请求 ID，换一个请求 ID 也只能结算一次。
 *
 * 【spec.precondition】留给个别动作的事务内复查，返回非空字符串即拒绝；
 * 放在权限判定之后，先答复「你有没有资格」再谈「做不做得动」。
 */
async function transition(payload, ctx, spec) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));

  // 【2026-10-26 第六轮 D】只要「这场比赛的两队选手 + 操作者」的学院关系。
  // 原来读全校名册 + 全量账号（2000 人 40 次 RPC），而一场比赛最多涉及 4 个人。
  // 这里多一次比赛点读是为了拿到参赛者编号——事务内仍会重读一次做权限判定。
  const snapshot = await ctx.repo.forScope(ctx).matches.getById(payload.matchId);
  const dir = await recordDirOf(ctx, snapshot);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号已停用，或没有本协会的访问权限');
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('找不到这场比赛');
    // mock 放宽只影响演示：isMock 由 mock 端打在 ctx 上，这里原样带进事务
    const allowOptions = { isMock: ctx.isMock === true, ...recordOptions(fresh, dir) };
    if (!spec.allow(doc, allowOptions)) return refused(spec.message);
    // 已有最终结算：有权限的重试返回既有结果（资格已在上一步核过），不加分
    if (spec.settle && doc.settlement && doc.settlement.id) {
      return { ok: true, match: matchSummary(doc, fresh, dir), message: '' };
    }
    if (spec.requirePending && doc.status !== MATCH_STATUS.PENDING) {
      return refused('只有待确认的比赛可以驳回');
    }
    if (spec.requireWinner && !doc.winner) {
      return refused('这场比赛还没有比分，请先录入成绩');
    }
    // 先答复「你有没有资格」，再谈「赛事还让不让改」（与下面 precondition 同序）。
    const terminal = await finishedEventBlocker(tx, doc);
    if (terminal) return refused(terminal);

    const nowIso = iso(ctx.now);
    // 确认即结算：评级、序号计数与比赛状态在**同一个事务**里落盘；
    // 任何一步失败整体回滚，不会出现「分涨了比赛没生效」或反过来。
    let settlement = null;
    if (spec.settle) {
      const event = doc.eventId ? await tx.events.getById(doc.eventId) : null;
      settlement = (await settleMatchInTransaction(tx, fresh, doc, { event })).settlement;
    }
    const patch = { ...spec.patch(), action: spec.action, actor: ctx.actorId, actedAt: nowIso };
    const next = { ...doc, ...patch, revision: doc.revision + 1 };
    if (settlement) next.settlement = settlement;
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, spec.auditAction, next.revision),
      action: spec.auditAction, schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, matchId: doc._id, at: nowIso });
    // 作废即把「自行录入」的交手名额还回去（与提交时的占用对称）。
    // 已作废的场次本就不计入用量（见 rating-cap.countedMatches）。
    if (next.status === MATCH_STATUS.REVOKED && doc.status !== MATCH_STATUS.REVOKED) {
      await releasePairUsage(tx, fresh, next);
    }
    return { ok: true, match: matchSummary(next, fresh, dir), message: '' };
  });
  return ok(result);
}

async function forfeitSchoolMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));
  const forfeitBy = String(payload.forfeitBy || ctx.actorId).trim();

  // 【2026-10-26 第六轮 D】下面只用目录的 `role`，而 role 来自 legacyRoleOf(ctx)、
  // 与目录无关。原来为它读全校名册 + 全量账号，纯浪费。
  const dir = EMPTY_RECORD_DIR;
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    // 与 confirm / revoke 同一道闸：停用账号、失效学籍都不能借弃权改成绩（F1 同类）
    if (!canReadAssociationSpace(fresh)) return refused('账号已停用，或没有本协会的访问权限');
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('找不到这场比赛');
    if (!canForfeit(doc, forfeitBy, fresh.actorId, { role: recordOptions(fresh, dir).role })) {
      return refused('你无权记录这次弃权');
    }
    // 弃权会改胜负与等级分，同样受「赛事已结束即只读」约束（见 finishedEventBlocker）
    const terminal = await finishedEventBlocker(tx, doc);
    if (terminal) return refused(terminal);

    const nowIso = iso(ctx.now);
    const patch = buildForfeitPatch(doc, forfeitBy, { actorId: fresh.actorId, now: fresh.now });
    const candidate = { ...doc, ...patch, actedAt: nowIso };
    // 弃权是终态封口：也要落一份「不计分」结算决定（forfeit），否则 ACTIVE
    // 记录缺结算快照，读端无法解释「这场为什么不算分」（交接文档 §6 约束 10）。
    const { settlement } = await settleMatchInTransaction(tx, fresh, candidate, {});
    const next = { ...candidate, settlement, revision: doc.revision + 1 };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'forfeitMatch', next.revision),
      action: 'forfeitMatch', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId: doc._id, targetUserId: forfeitBy, at: nowIso });
    return { ok: true, match: matchSummary(next, fresh, dir), message: '' };
  });
  const resolved = await advanceAfterResolved(ctx, result);
  return ok(await advanceCollegeAfterResolved(ctx, resolved));
}

async function assignSchoolMatchReferee(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));

  const refereeId = String(payload.refereeId || '').trim();
  // 【2026-10-26 第六轮 D】matchSummary 只需要这场比赛的参赛者学院，用 recordDirOf 点读。
  const snapshot = await ctx.repo.forScope(ctx).matches.getById(payload.matchId);
  const dir = await recordDirOf(ctx, snapshot);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    // 指派裁判是管理动作：事务内按最新身份重判（请求期间被撤权不予放行，F1/F2 同类）
    if (!canManageAssociationSpace(fresh)) return refused('只有管理员可以指派裁判');
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('找不到这场比赛');
    if (!canAssignReferee(doc)) return refused('这场比赛已生效或已作废，不能再改派裁判');

    if (refereeId) {
      const refusal = await refereeRejection(tx, fresh, refereeId);
      if (refusal) return refused(refusal);
    }
    const nowIso = iso(fresh.now);
    const patch = buildRefereePatch(refereeId, { actorId: fresh.actorId, now: fresh.now });
    const next = { ...doc, ...patch, refereeAt: nowIso, revision: doc.revision + 1 };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'assignMatchReferee', next.revision),
      action: 'assignMatchReferee', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId: doc._id, refereeId, at: nowIso });
    return { ok: true, match: matchSummary(next, fresh, dir), message: '' };
  });
  return ok(result);
}

/** 裁判必须是本范围正常在册的会员：查不到与状态不对分开报。 */
async function refereeRejection(tx, ctx, refereeId) {
  const user = await tx.users.getById(refereeId);
  if (!user) return '找不到这位会员';
  const member = await tx.schoolMembers.getById(schoolMemberKey(refereeId, ctx.schoolId));
  if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE ||
    user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) {
    return '该会员不是正常在册状态，不能担任裁判';
  }
  return '';
}

/** 由规范化记录组装可落库的比赛记录：补范围、稳定主键、ISO 时间与版本。 */
function matchDocFromRecord(record, matchId, ctx, fingerprint) {
  return {
    ...record,
    _id: matchId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    competition: MATCH_COMPETITION.PERSONAL,
    status: MATCH_STATUS.PENDING,
    action: 'submit',
    actor: ctx.actorId,
    actedAt: iso(ctx.now),
    matchTime: iso(record.matchTime),
    fingerprint,
    revision: 1,
  };
}

const fingerprintOf = record => JSON.stringify([
  record.matchType, record.teamA, record.teamB, record.scoreA, record.scoreB,
  record.gamePoints, record.bestOf, record.location, new Date(record.matchTime).getTime(),
  // 网球赛制字段也进指纹：同一比分在两种盘制下不是同一场比赛，
  // 漏进去会让「同 requestId 补发」把改过赛制的记录当成重复请求放过去
  record.scoring || '', record.setGames || 0, record.tiebreakAt || 0,
  record.tiebreakPoints || 0, record.noAd === true, record.tiebreaks || [],
]);

module.exports = {
  MATCH_LIST_LIMIT, legacyRoleOf, isMatchDoc, matchSummary,
  buildDirectory, recordOptions,
  listSchoolMatches, getSchoolMatch, getSchoolMatchEntryContext, submitSchoolMatch,
  // 撤销（revokeSchoolMatch）已随 Elo 逐场结算改造取消：确认即最终结算
  confirmSchoolMatch, rejectSchoolMatch,
  forfeitSchoolMatch, assignSchoolMatchReferee,
};
