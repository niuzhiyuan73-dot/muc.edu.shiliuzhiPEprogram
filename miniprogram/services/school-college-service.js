/**
 * 学校维度：学院赛 —— 发布 / 名单 / 抽签 / 开赛 / 排阵 / 名次结束（协议 2，M2-a / M2-b / M2-c）
 * ============================================================
 * 学院赛与个人赛并行，是两套互不干扰的体系（D1）：学院赛不靠个人报名，而由
 * 学院负责人提交一份本学院名单（D10），管理员审核通过后进入抽签；抽签把已
 * 通过的学院排进签表，赛事级「开始」再铺出第一轮全部大场（D35 / D36）。
 *
 * 本模块只管**归属**与**权限来源**，规则一字不改复用旧栈纯模块
 * （`college-event.js` / `college-entry.js` / `college-draw.js` /
 * `college-tie.js`，同一把尺子）：
 *   · 学院赛主记录绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 名单按 `scope + eventId + collegeId` 稳定成键，跨校跨协会无法伪造；
 *   · 大场主键由签位决定（`college-tie.collegeTieKey`），重抽 / 重开按 _id
 *     覆盖，不堆出两批首轮；大场记录补 `schoolId + association`，跨校读不到；
 *   · 旧栈 ROLE 由 S2 角色推导（见 school-actor.js），与比赛 / 实时比分同源。
 *
 * 【学院目录：每校独立】
 * 旧栈把有效学院写死在全局 `COLLEGES`，且判权 / 校验都按学院**全名**。学校
 * 维度改为每校一份目录，对外主键用**稳定编号** `collegeId`（见 `collegeEntryKey`），
 * 显示与旧栈校验仍按全名。两者的互查收在 `school-actor.buildCollegeDirectory`，
 * 校验时把本校学院全名清单注入旧栈纯模块（`ctx.colleges`），不另抄一遍规则。
 *
 * 【名单：不删只改】
 * 提交后查得到、管理员退回也保留记录——同一「赛事 + 学院」只有一份，重复提交
 * 覆盖同一条（键稳定），谁在什么时候交过、为什么被退回，都有据可查。
 *
 * 【并发与幂等】
 *   · 发布用 requestId 派生稳定 eventId，同编号重试返回同一条，改内容则拒绝；
 *   · 提交 / 审核在同一事务内读改，键由范围派生，重复提交只改不重。
 *
 * 【职责边界】
 * 注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
// 展示与年份判定统一按东八区（云函数跑在 UTC）
const { displayYearOf } = require('../utils/format.js');
const { canReadAssociationSpace } = require('./association-space-permission.js');
// 学院目录（编号 ↔ 全名）与旧栈「账号」的推导收在 school-actor，两套栈只有一份口径。
const { buildCollegeDirectory, legacyActorOf } = require('./school-actor.js');
const { canSchoolAction } = require('./school-permission.js');
const {
  schoolKey, schoolMemberKey, belongsToSchoolScope, collegeEventKey, collegeEntryKey,
  collegeLineupKey, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS, associationGroupMemberKey,
} = require('../utils/school.js');
// 小组限制（受众范围，B6）：与训练 / 个人赛事共用同一套纯规则。
const { buildAudience, readAudience } = require('./association-audience.js');
const { GROUP_MEMBER_STATUS } = require('./association-group-service.js');
const {
  COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS,
  MATCH_STATUS, MATCH_OUTCOME, TEAM,
} = require('../utils/constants.js');
// 发布表单 / 状态文案 / 名次与名单的校验一律复用旧栈纯规则。
const {
  buildCollegeEventRecord, buildCollegeEventRow, canManageCollegeEvent, sortCollegeEvents,
  validateCollegePlacements, canFinishCollegeEvent,
} = require('./college-event.js');
const {
  buildCollegeEntryRecord, buildCollegeEntryRow, validateEntryReview, canSubmitCollegeEntry,
} = require('./college-entry.js');
// 抽签 / 大场 / 排阵：同样是旧栈纯模块，落位算法与个人赛同宗（utils/bracket.js）。
const { canDrawCollegeEvent, planCollegeDraw, buildCollegeDrawRecord } = require('./college-draw.js');
const {
  canStartCollegeEvent, firstRoundPairsOf, buildTiesForRound, buildTieRow,
  canStartTie, canAssignTieReferee, legMatchIdsOf, buildLegMatchDrafts, tieStatusOf,
} = require('./college-tie.js');
const { buildLineupRecord, buildLineupRow, canSubmitLineup } = require('./college-lineup.js');
const { canAssignReferee, buildRefereePatch } = require('./match-record.js');
const { REVIEW_ACTION } = require('./member-review.js');
// 弃权生效后把这一小项写回大场、必要时推进下一轮（与个人赛场次确认后同一条链路）。
const { advanceCollegeAfterLeg } = require('./school-college-advance.js');
// 小场弃权同样是终态：要落一份「不计分」结算决定（见 settleMatchInTransaction）
const { settleMatchInTransaction } = require('./school-rating-service.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const EVENT_LIST_LIMIT = 20;
const EVENT_LIST_MAX = 50;

const iso = value => new Date(value).toISOString();

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

/**
 * 事务内重判身份与角色（2026-10-16 独立验收 F1/F2 的同类扫尾，与个人赛同一口径）。
 *
 * 学院赛的写动作原先一律在事务**外**判一次 `canReadAssociationSpace(ctx)`，
 * 事务里用的还是外层推出来的 actor。账号被停用、学籍离校、学院 / 协会角色被撤
 * 都可能发生在请求飞在路上的那一瞬——那种情况下抽签、开赛、交名单、录名次
 * 都不该落库。事务里重建上下文再判一次（全是按主键点读，事务允许），窗口就没了。
 *
 * @param {Object} tx 事务内仓储
 * @param {Object} ctx 外层上下文
 * @param {Object} dir buildCollegeDirectory 的结果（角色判定的静态部分）
 * @returns {Promise<{ok:boolean, message:string, actor:Object|null}>}
 */
async function freshActorGate(tx, ctx, dir) {
  const fresh = await freshContext(tx, ctx);
  if (!canReadAssociationSpace(fresh)) {
    return { ok: false, message: '账号已停用，或没有本协会的访问权限', actor: null };
  }
  return { ok: true, message: '', actor: legacyActorOf(fresh, dir), ctx: fresh };
}

/**
 * 学院赛写动作的统一入口：先过事务内身份闸，再把重算出来的 actor 交给动作体。
 *
 * 【为什么包一层而不是每处抄一段】
 * 十来个写动作（交名单 / 审核 / 抽签 / 开赛 / 排阵 / 大场 / 弃权 / 名次 / 置顶）
 * 的事务体形状一致：进来先重判身份，再按角色走行级权限。抄十遍迟早漏一处，
 * 包一层之后「新写的动作忘了判身份」这件事在结构上就难发生——动作体拿到的
 * `actor` 天生是事务内重算的那一份。
 *
 * @param {Object} ctx 外层上下文
 * @param {Object} dir buildCollegeDirectory 的结果
 * @param {Function} work async (tx, actor) => 结果
 * @returns {Promise<Object>} 与仓储事务同形
 */
async function inTransaction(ctx, dir, work) {
  return ctx.repo.transaction(async tx => {
    const gate = await freshActorGate(tx, ctx, dir);
    if (!gate.ok) return refused(gate.message);
    return work(tx, gate.actor, gate.ctx);
  });
}

const collegeEventAuditKey = (eventId, action, revision) =>
  schoolKey('ceau', eventId, action, String(revision));
const collegeEntryAuditKey = (eventId, collegeId, action, revision) =>
  schoolKey('cenau', eventId, collegeId, action, String(revision));
const collegeTieAuditKey = (eventId, action, revision) =>
  schoolKey('ctau', eventId, action, String(revision));
const collegeLineupAuditKey = (tieId, collegeId, revision) =>
  schoolKey('clau', tieId, collegeId, String(revision));

/** 一条学院赛主记录。status 可以是 0（报名中，falsy），所以不能用真值判断。 */
const isCollegeEventDoc = doc => Boolean(doc && doc.title && typeof doc.status === 'number' && doc.startTime);

/** 一条大场记录：有双方学院与轮次即认。 */
const isCollegeTieDoc = doc => Boolean(doc && doc.eventId && doc.collegeA && doc.collegeB
  && typeof doc.round === 'number');

/** 一条学院赛小场（matches 里 competition='college' 的一条）：有大场与小项序号即认。 */
const isCollegeLegDoc = doc => Boolean(doc && doc.tieId && Array.isArray(doc.teamA)
  && Array.isArray(doc.teamB) && typeof doc.status === 'number');

/** 由规范化记录组装可落库的学院赛主记录：补范围、稳定主键、ISO 时间与版本。 */
function collegeEventDoc(record, eventId, ctx, fingerprint) {
  return {
    ...record,
    _id: eventId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    startTime: iso(record.startTime),
    publishTime: iso(record.publishTime),
    pinned: false,
    fingerprint,
    revision: 1,
    updatedAt: iso(record.publishTime),
  };
}

/** 幂等指纹：同编号重发同样的单子返回同一条，改过内容则拒绝。 */
const fingerprintOf = record => JSON.stringify([
  record.title, record.description, record.legPlan, record.allowMultiEntry,
  record.rosterMin, record.rosterMax, record.tieAlgo, record.tieNetMode,
  record.location, record.courtCount, new Date(record.startTime).getTime(),
  record.audienceMode || 'all', JSON.stringify(record.audienceGroupIds || []),
]);

/** 把学院编号解析成本校的全名；同时回退接受直接提交的全名。 */
function resolveCollege(payload = {}, dir) {
  const collegeId = String(payload.collegeId || '').trim()
    || dir.collegeIdByName(String(payload.college || '').trim());
  const college = dir.collegeNameById(collegeId) || String(payload.college || '').trim();
  return { collegeId, college };
}

/** 会员编号 → 档案的映射，供名单行显示姓名。 */
const memberMapOf = dir => new Map(dir.members.map(item => [item._id, item]));

/**
 * 本赛事「当前身份可替哪些学院提交名单」。
 * ============================================================
 * 把旧栈 `canSubmitCollegeEntry` 对本校每所学院各解一次：学院负责人只解得出
 * 本学院，管理员（与协会负责人）解得出全部——与旧栈详情页「两侧各解一次」
 * 同路数，不另写一份判权。赛事不在报名阶段时谁都不给出（抽签即锁名单，D13）。
 *
 * 结果用**稳定学院编号**（对外主键），页面据此默认选中 / 决定「提交名单」入口。
 *
 * @param {Object|null} event 学院赛记录
 * @param {Object} actor legacyActorOf 的结果（带旧栈可判的角色与学院）
 * @param {Object} dir buildCollegeDirectory 的结果
 * @returns {string[]} collegeId 列表
 */
function submittableCollegeIdsOf(event, actor, dir) {
  if (!event || event.status !== COLLEGE_EVENT_STATUS.SIGNUP) return [];
  return dir.colleges
    .filter(item => canSubmitCollegeEntry(event, actor, { college: item.name }))
    .map(item => item.collegeId);
}

/**
 * 本大场「当前身份可为哪几侧排阵」。
 * ============================================================
 * 把旧栈 `canSubmitLineup` 对两侧各解一次，结果换成稳定学院编号（页面按编号
 * 跳转）。`canSubmitLineup` 只看大场状态、赛事是否进行中与学院归属，**不依赖
 * 排阵是否已交**；「已交 / 未交」由展示层另取名单读端补上，这里不必先读排阵。
 *
 * @param {Object} tie 大场记录
 * @param {Object} actor legacyActorOf 的结果
 * @param {Object|null} event 所属学院赛（判是否已开赛）
 * @param {Object} dir buildCollegeDirectory 的结果
 * @returns {string[]} collegeId 列表
 */
function lineupCollegeIdsOf(tie, actor, event, dir) {
  return [tie.collegeA, tie.collegeB]
    .filter(college => Boolean(college) && canSubmitLineup(tie, actor, { college, event }))
    .map(college => dir.collegeIdByName(college))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ 读 */

async function listCollegeEvents(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, events: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const canManage = canManageCollegeEvent(actor);
  // 审核权与发布权同一门槛（仅管理员），与具体哪一场无关，算一次即可。提交名单权
  // 按场判：学院负责人在报名中为真——列表据此把「提交名单」入口指到名单页
  // （与旧栈列表行同一口径，见 events-view.buildCollegeEventListRows）。
  const canReview = canManageCollegeEvent(actor);
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, EVENT_LIST_MAX) : EVENT_LIST_LIMIT;
  const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
  const status = typeof payload.status === 'number' ? payload.status : null;
  const keyword = typeof payload.keyword === 'string' ? payload.keyword.trim().slice(0, 40).toLowerCase() : '';
  const year = Number.isInteger(Number(payload.year)) && String(payload.year).trim() !== '' ? Number(payload.year) : null;

  const buildRow = doc => ({
    ...buildCollegeEventRow(doc, { actor }),
    canReview,
    canSubmit: !canReview && canSubmitCollegeEntry(doc, actor),
  });

  // ── 主路径下推：范围 + 状态 + 排序 + 分页交给数据库 ─────────────────────
  // 排序与 `sortCollegeEvents` 同口径：置顶 → 状态（报名中 0 < 待开赛 1 < 进行中 2
  // < 已结束 3，正好是数值升序）→ 开赛时间升序 → 编号升序。
  // 关键词要匹配 title/location（无可用索引）、年份要按东八区换算 publishTime，
  // 这两条仍回退内存，数据量是「本协会学院赛数」（2026-10-29 第十二轮审计）。
  if (!keyword && !year) {
    const page = await ctx.repo.forScope(ctx).collegeEvents.listPage({
      statuses: status === null ? null : [status],
      order: [
        { field: 'pinned', direction: 'desc' },
        { field: 'status', direction: 'asc' },
        { field: 'startTime', direction: 'asc' },
        { field: '_id', direction: 'asc' },
      ],
      limit,
      offset,
    });
    return ok({
      ok: true, canManage,
      total: page.total,
      hasMore: page.hasMore,
      nextOffset: offset + page.rows.length,
      events: page.rows.filter(isCollegeEventDoc).map(buildRow),
      message: '',
    });
  }

  // ── 回退：关键词 / 年份在内存里筛 ───────────────────────────────────────
  let rows = (await ctx.repo.forScope(ctx).collegeEvents.list()).filter(isCollegeEventDoc);
  if (status !== null) rows = rows.filter(row => row.status === status);
  // 关键词：按赛事名称 / 场地匹配，空串等于不筛选。
  //
  // 【为什么在服务端匹配，而不是页面拿到哪页就筛哪页】
  // 列表是分页的（一次 50 条）。前端只筛当前页，等于「搜到的只是这一页里的命中」，
  // 要一直点「加载更多」才可能翻到目标——那不是搜索，是碰运气。
  // 放在分页之前过滤，total / hasMore 也跟着变成筛选后的口径，翻页才连贯。
  if (keyword) {
    rows = rows.filter(row => [row.title, row.location]
      .some(value => String(value || '').toLowerCase().includes(keyword)));
  }
  // 石榴籽杯按「发起时间」归档：同一年发起的赛事归在一起，不设届次。
  // 用 publishTime 而不是 startTime——一场比赛可以提前很久发布、也可以跨年开赛。
  if (year !== null) {
    rows = rows.filter(row => {
      // 年份按东八区判（displayYearOf），不能用 getFullYear()：云函数跑在
      // UTC，跨年前后 8 小时内发起的赛事会被归到上一年，与本地结果不一致。
      return displayYearOf(row.publishTime || row.updatedAt) === year;
    });
  }

  const sorted = sortCollegeEvents(rows);
  const page = sorted.slice(offset, offset + limit);
  return ok({
    ok: true, canManage,
    total: sorted.length,
    hasMore: sorted.length > offset + page.length,
    nextOffset: offset + page.length,
    events: page.map(buildRow),
    message: '',
  });
}

async function getCollegeEvent(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));

  const doc = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('学院赛不存在'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  // 名单操作能力随赛事一起下发：详情页据此决定「提交名单」入口，名单页据此
  // 决定「能不能替本学院提交」与默认选中学院——判权仍在服务端（同一把尺子）。
  const submittableCollegeIds = submittableCollegeIdsOf(doc, actor, dir);
  return ok({
    ok: true,
    canManage: canManageCollegeEvent(actor),
    canSubmitEntry: submittableCollegeIds.length > 0,
    submittableCollegeIds,
    // 本校学院目录（编号 ↔ 全名）：名单页 / 排阵页拿到的是编号，展示要全名，视图层
    // 用它换算，免得再去别处取一次。只下发编号与名称，不含任何隐私字段。
    colleges: dir.colleges.map(item => ({ collegeId: item.collegeId, name: item.name })),
    // 详情才带 draw / currentRound / results（列表保持精简）：签表预览、轮次与名次
    // 行都靠它们整形；与个人赛详情「列表精简、详情带 draw / results」同一口径。
    event: {
      ...buildCollegeEventRow(doc, { actor }),
      draw: doc.draw || null,
      legPlan: Array.isArray(doc.legPlan) ? doc.legPlan.slice() : [],
      rosterMin: doc.rosterMin,
      rosterMax: doc.rosterMax,
      tieAlgo: doc.tieAlgo,
      tieNetMode: doc.tieNetMode,
      currentRound: Number(doc.currentRound) || 0,
      results: Array.isArray(doc.results) ? doc.results.slice() : [],
    },
    message: '',
  });
}

async function listCollegeEntries(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, entries: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const canManage = canManageCollegeEvent(actor);

  const all = await ctx.repo.forScope(ctx).collegeEntries.list();
  const rows = typeof payload.eventId === 'string' && payload.eventId
    ? all.filter(row => row.eventId === payload.eventId) : all;

  // 名单能否再改，取决于所属学院赛是否仍在报名阶段；取不到的赛事不传，行内 canEdit 自动为假。
  const event = typeof payload.eventId === 'string' && payload.eventId
    ? await ctx.repo.collegeEvents.getById(payload.eventId) : null;
  const eventDoc = isCollegeEventDoc(event) && belongsToSchoolScope(event, ctx) ? event : null;
  const members = memberMapOf(dir);

  return ok({
    ok: true, canManage,
    entries: rows
      .slice()
      .sort((a, b) => (a.college < b.college ? -1 : 1))
      .map(row => buildCollegeEntryRow(row, { actor, event: eventDoc, members })),
    message: '',
  });
}

async function listCollegeTies(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, ties: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);

  const all = (await ctx.repo.forScope(ctx).ties.list()).filter(isCollegeTieDoc);
  const rows = typeof payload.eventId === 'string' && payload.eventId
    ? all.filter(row => row.eventId === payload.eventId) : all;

  const sorted = rows.slice().sort(
    (a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)));

  // 排阵权按所属赛事判「是否进行中」，故先把本批大场牵涉到的赛事各取一次（去重，
  // 通常只有一场）。取不到的赛事按空处理：不给任何一侧开排阵口子。
  const eventIds = Array.from(new Set(sorted.map(tie => tie.eventId).filter(Boolean)));
  const events = new Map();
  for (const eventId of eventIds) {
    const doc = await ctx.repo.collegeEvents.getById(eventId);
    if (isCollegeEventDoc(doc) && belongsToSchoolScope(doc, ctx)) events.set(eventId, doc);
  }

  return ok({
    ok: true, canManage: canManageCollegeEvent(actor),
    // 逐场下发「可替哪几侧排阵」：学院负责人只解得出自己那一侧，管理员两侧都
    // 解得出。页面据 lineupCollegeIds 组装按钮文字与跳转，不自己判角色。
    ties: sorted.map(tie => ({
      ...buildTieRow(tie, { actor }),
      lineupCollegeIds: lineupCollegeIdsOf(tie, actor, events.get(tie.eventId) || null, dir),
    })),
    message: '',
  });
}

async function listCollegeLineups(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, lineups: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const members = memberMapOf(dir);

  // 带 eventId 时下推到查询（索引见 docs/数据库索引清单.md 的 lineups）；
  // 只带 tieId 时没有对应索引，只能取回赛后内存筛——调用方优先传 eventId。
  let rows = typeof payload.eventId === 'string' && payload.eventId
    ? await ctx.repo.forScope(ctx).lineups.listByEvent(payload.eventId)
    : await ctx.repo.forScope(ctx).lineups.list();
  if (typeof payload.tieId === 'string' && payload.tieId) {
    rows = rows.filter(row => row.tieId === payload.tieId);
  }

  return ok({
    ok: true, canManage: canManageCollegeEvent(actor),
    lineups: rows.map(row => buildLineupRow(row, { actor, members })),
    message: '',
  });
}

/* ------------------------------------------------------------------ 写 */

async function publishCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const built = buildCollegeEventRecord(payload, { actor, now: ctx.now });
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors }));
  // 小组限制（B6）：与训练 / 个人赛事同一把尺子；非法即拒绝，不静默降级为不限。
  const audience = buildAudience(payload);
  if (!audience.ok) return ok(refused(audience.message));
  built.record.audienceMode = audience.audienceMode;
  built.record.audienceGroupIds = audience.audienceGroupIds;

  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const fresh = await freshContext(tx, ctx);
    // 发布权与旧栈同一门槛：仅管理员（学院负责人 / 会员都不行）。
    if (!canManageCollegeEvent(legacyActorOf(fresh, dir))) return refused('只有管理员可以发布学院赛');

    const eventId = collegeEventKey(schoolKey('ce', fresh.actorId, token), fresh);
    const doc = collegeEventDoc(built.record, eventId, fresh, fingerprintOf(built.record));
    const existing = await tx.collegeEvents.getById(eventId);
    if (isCollegeEventDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, event: buildCollegeEventRow(existing, { actor }), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.collegeEvents.set(eventId, doc);
    await tx.audit.append({ _id: collegeEventAuditKey(eventId, 'publishCollegeEvent', 1),
      action: 'publishCollegeEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId, at: iso(fresh.now) });
    return { ok: true, event: buildCollegeEventRow(doc, { actor }), message: '' };
  });
  return ok(result);
}

async function submitCollegeEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId, college } = resolveCollege(payload, dir);
  const members = memberMapOf(dir);

  const result = await inTransaction(ctx, dir, async (tx, actor, fresh) => {
    const doc = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('学院赛不存在');
    if (!canSchoolAction(fresh, 'manageCollege', { ...ctx, collegeId })) return refused('只能提交本学院的名单');

    // 校验复用旧栈纯规则：在册、同学院、人数上下限。有效学院清单取本校目录。
    const built = buildCollegeEntryRecord(
      { ...payload, college },
      { event: doc, actor, members: dir.members, colleges: dir.collegeNames, now: ctx.now });
    if (!built.ok) return refused(built.message);

    // 小组限制（B6-b / G08）：名单里**每一位**都须命中赛事限定的小组，
    // 仅一人不符合即整份提交失败；学院负责人本人入组不能替代选手资格。
    const audience = readAudience(doc);
    if (audience.audienceMode === 'groups') {
      for (const memberId of built.record.members) {
        let hit = false;
        for (const groupId of audience.audienceGroupIds) {
          const rel = await tx.associationGroupMembers.getById(
            associationGroupMemberKey(groupId, memberId, ctx));
          if (rel && rel.status === GROUP_MEMBER_STATUS.ACTIVE) { hit = true; break; }
        }
        if (!hit) return refused('名单中有成员不在赛事限定的小组内，请调整名单');
      }
    }

    const key = collegeEntryKey(doc._id, collegeId, ctx);
    const existing = await tx.collegeEntries.getById(key);
    const nowIso = iso(ctx.now);
    const entry = {
      ...built.record,
      _id: key,
      schoolId: ctx.schoolId,
      association: ctx.association,
      collegeId,
      submitTime: nowIso,
      revision: existing ? Number(existing.revision || 1) + 1 : 1,
      updatedAt: nowIso,
    };
    await tx.collegeEntries.set(key, entry);
    await tx.audit.append({ _id: collegeEntryAuditKey(doc._id, collegeId, 'submitCollegeEntry', entry.revision),
      action: 'submitCollegeEntry', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, collegeId, at: nowIso });
    return { ok: true, entry: buildCollegeEntryRow(entry, { actor, event: doc, members }), message: '' };
  });
  return ok(result);
}

async function reviewCollegeEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId } = resolveCollege(payload, dir);
  if (!collegeId) return ok(refused('请指定要审核的学院'));
  const members = memberMapOf(dir);

  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const doc = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('学院赛不存在');

    const key = collegeEntryKey(doc._id, collegeId, ctx);
    const entry = await tx.collegeEntries.getById(key);
    // 审核权与旧栈同一门槛：仅管理员；退回必须给理由。
    const checked = validateEntryReview(actor, entry, payload.action, payload.reason);
    if (!checked.ok) return refused(checked.message);

    const nowIso = iso(ctx.now);
    const next = {
      ...entry,
      status: checked.status,
      reviewedBy: ctx.actorId,
      reviewedAt: nowIso,
      reason: payload.action === REVIEW_ACTION.REJECT ? String(payload.reason || '').trim() : '',
      revision: Number(entry.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEntries.set(key, next);
    await tx.audit.append({ _id: collegeEntryAuditKey(doc._id, collegeId, `reviewCollegeEntry-${checked.status}`, next.revision),
      action: 'reviewCollegeEntry', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, collegeId, status: checked.status, at: nowIso });
    return { ok: true, entry: buildCollegeEntryRow(next, { actor, event: doc, members }), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------ 抽签 / 开赛 */

async function drawCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));

  // 抽签定的是整场对阵结构，与发布同一门槛：仅管理员，且赛事在报名中。
  if (!canDrawCollegeEvent(event, actor)) {
    return ok(refused(event.status !== COLLEGE_EVENT_STATUS.SIGNUP ? '只能在报名阶段抽签' : '只有管理员可以抽签'));
  }

  // 名单直读集合：只有已通过审核的学院才进签表（旧栈 approvedCollegesOf 同口径）。
  const entries = (await ctx.repo.forScope(ctx).collegeEntries.list())
    .filter(row => row.eventId === event._id);
  // seedValue 由调用方给（测试可复现）；没给就现取一个随机值并落库备查。
  // 只认「本身就是有限数字」的入参：`Number(null)===0`、`Number('')===0`，
  // 从前 null/空串会落成确定性种子 0，签位可被穷举复现（2026-10-17 审计 C6）。
  const seedValue = typeof payload.seedValue === 'number' && Number.isFinite(payload.seedValue)
    ? payload.seedValue : Math.floor(Math.random() * 0x7fffffff);

  const plan = planCollegeDraw({ event, actor, entries, seedColleges: payload.seedColleges, seedValue });
  if (!plan.ok) return ok(refused(plan.message));

  const draw = buildCollegeDrawRecord(plan, { drawnAt: ctx.now, drawnBy: ctx.actorId });
  const nowIso = iso(ctx.now);

  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    // 事务内复查状态：并发两次抽签只落一次。
    if (current.status !== COLLEGE_EVENT_STATUS.SIGNUP) return refused('只能在报名阶段抽签');
    // 事务内复查权限：请求飞在路上时被撤掉管理员角色，这一次抽签就不算数（F2 同类）
    if (!canDrawCollegeEvent(current, actor)) return refused('只有管理员可以抽签');

    // 抽签顺带锁定名单：status 转 READY，而名单提交权只看「是否报名中」，自然不可再改（D13）。
    const next = {
      ...current,
      draw,
      status: COLLEGE_EVENT_STATUS.READY,
      seedColleges: Array.isArray(draw.seeds) ? draw.seeds.slice() : [],
      revision: Number(current.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'drawCollegeEvent', next.revision),
      action: 'drawCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }), draw, message: '' };
  });
  return ok(result);
}

async function startCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));

  if (!canStartCollegeEvent(event, actor)) {
    return ok(refused(event.status !== COLLEGE_EVENT_STATUS.READY ? '还没有抽签，不能开始' : '只有管理员可以开始赛事'));
  }

  const ties = buildTiesForRound({ event, round: 1, pairs: firstRoundPairsOf(event.draw) });
  const nowIso = iso(ctx.now);

  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    // 事务内复查：并发的第二次「开始」不再覆盖首轮——只补不覆盖，免得冲掉其间已录的排阵 / 比分。
    if (current.status !== COLLEGE_EVENT_STATUS.READY) return refused('这场学院赛已经开始了');
    // 事务内复查权限：撤权之后不能再开赛（F2 同类）
    if (!canStartCollegeEvent(current, actor)) return refused('只有管理员可以开始赛事');

    const stored = [];
    for (const tie of ties) {
      const existing = await tx.ties.getById(tie._id);
      if (existing) { stored.push(existing); continue; }
      const doc = { ...tie, schoolId: ctx.schoolId, association: ctx.association,
        revision: 1, updatedAt: nowIso };
      await tx.ties.set(tie._id, doc);
      stored.push(doc);
    }

    const next = {
      ...current,
      status: COLLEGE_EVENT_STATUS.ONGOING,
      currentRound: 1,
      startedAt: nowIso,
      revision: Number(current.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'startCollegeEvent', next.revision),
      action: 'startCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }),
      ties: stored.map(tie => buildTieRow(tie, { actor })), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------ 排阵 / 开大场 / 名次 */

/** 裁判必须是本范围内正常在册的会员：查不到与状态不对分开报（与个人赛同一口径）。 */
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

/**
 * 学院赛已结束即为终态：大场与小场层面的写动作一律不许再动。
 *
 * 【为什么需要这道闸（2026-10-16 审计）】`forfeitCollegeTieLeg` 原先只校验大场自己的
 * 状态（ONGOING）与小项未定胜负，从不看所属学院赛——`finishCollegeEvent` 之后仍能
 * 记弃权，顺手把小场改成生效、大场改成结束，必要时还会按胜者**补排下一轮大场**。
 * 排阵 / 开大场 / 改派裁判三处同样只看大场。名次一旦录入即为对外口径，赛事必须只读。
 *
 * 内外各判一次：事务外先给一句人话，事务内用重读到的赛事状态复核（与判权同一套路）。
 *
 * @param {Object} repo 仓储（顶层或事务内，两者接口一致）
 * @param {string} eventId 学院赛编号
 * @returns {Promise<boolean>} 已结束返回 true
 */
async function collegeEventFinished(repo, eventId) {
  if (typeof eventId !== 'string' || !eventId) return false;
  const event = await repo.collegeEvents.getById(eventId);
  return Boolean(event && event.status === COLLEGE_EVENT_STATUS.FINISHED);
}

async function submitCollegeLineup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId, college } = resolveCollege(payload, dir);
  if (!collegeId) return ok(refused('学院无效'));

  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  const event = await ctx.repo.collegeEvents.getById(tie.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('找不到这场学院赛'));
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) return ok(refused('学院赛已结束，不能再改排阵'));

  // 排阵的人必须出自本学院已通过审核的名单（D37）；校验复用旧栈 college-lineup 纯规则。
  const entry = await ctx.repo.collegeEntries.getById(collegeEntryKey(tie.eventId, collegeId, ctx));
  const built = buildLineupRecord(
    { ...payload, college },
    { tie, event, actor, entry, now: ctx.now, carriedFrom: payload.carriedFrom, members: dir.members });
  if (!built.ok) return ok(refused(built.message));

  const key = collegeLineupKey(tie._id, collegeId, ctx);
  const side = college === tie.collegeA ? 'lineupA' : 'lineupB';
  const members = memberMapOf(dir);
  const nowIso = iso(ctx.now);

  const result = await inTransaction(ctx, dir, async (tx, actor, fresh) => {
    if (!canSchoolAction(fresh, 'manageCollege', { ...ctx, collegeId })) return refused('只能管理授权的本学院');
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    // 事务内复查：大场已开始 / 已结束就不能再改排阵。
    if (!canSubmitLineup(current, actor, { college, event })) return refused('大场已经开始，不能再改排阵');
    if (await collegeEventFinished(tx, current.eventId)) return refused('学院赛已结束，不能再改排阵');

    const existing = await tx.lineups.getById(key);
    const doc = {
      ...built.record,
      _id: key,
      schoolId: ctx.schoolId,
      association: ctx.association,
      collegeId,
      submitTime: nowIso,
      revision: existing ? Number(existing.revision || 1) + 1 : 1,
      updatedAt: nowIso,
    };
    await tx.lineups.set(key, doc);
    // 每次提交只翻自己那一侧，另一方不受影响（大场状态由 tieStatusOf 推出）。
    await tx.ties.set(payload.tieId, { ...current, [side]: true,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso });
    await tx.audit.append({ _id: collegeLineupAuditKey(payload.tieId, collegeId, doc.revision),
      action: 'submitCollegeLineup', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: tie.eventId, tieId: payload.tieId, collegeId, at: nowIso });
    return { ok: true, lineup: buildLineupRow(doc, { actor, members }), message: '' };
  });
  return ok(result);
}

async function startCollegeTie(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  const event = await ctx.repo.collegeEvents.getById(tie.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('找不到这场学院赛'));
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) return ok(refused('学院赛已结束，不能再开大场'));

  if (!canStartTie(tie, actor)) {
    if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) return ok(refused('这个大场已经开始'));
    if (!(tie.lineupA && tie.lineupB)) return ok(refused('双方排阵还没交齐，不能开始'));
    return ok(refused('只有管理员可以开始大场'));
  }

  // 排阵在事务外一次取全（事务内不允许整表查询）；小场草稿按排阵铺出。
  // 按赛事下推（2026-10-26 第四轮审查 P-11）：原来读全协会所有学院的排阵再筛本届。
  const lineups = await ctx.repo.forScope(ctx).lineups.listByEvent(tie.eventId);
  const built = buildLegMatchDrafts({ event, tie, lineups, now: ctx.now, association: ctx.association });
  if (!built.ok) return ok(refused(built.message));

  const byLegNo = new Map(built.drafts.map(draft => [Number(draft.legNo), draft._id]));
  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map(leg => ({
    ...leg, matchId: byLegNo.get(Number(leg.legNo)) || leg.matchId || '',
  }));
  const nowIso = iso(ctx.now);

  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    if (tieStatusOf(current) !== TIE_STATUS.READY) return refused('这个大场已经开始');
    // 事务内复查权限：撤权之后不能再开大场（F2 同类）
    if (!canStartTie(current, actor)) return refused('只有管理员可以开始大场');
    if (await collegeEventFinished(tx, current.eventId)) return refused('学院赛已结束，不能再开大场');

    for (const draft of built.drafts) {
      const existing = await tx.matches.getById(draft._id);
      // 重开同一大场：编号相同，只补不覆盖，免得冲掉已录的比分。
      if (existing) continue;
      await tx.matches.set(draft._id, { ...draft, _id: draft._id, schoolId: ctx.schoolId,
        association: ctx.association, matchTime: nowIso, createdAt: nowIso, revision: 1, updatedAt: nowIso });
    }
    const next = { ...current, status: TIE_STATUS.ONGOING, startedAt: nowIso, legs,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.ties.set(payload.tieId, next);
    await tx.audit.append({ _id: collegeTieAuditKey(payload.tieId, 'startCollegeTie', next.revision),
      action: 'startCollegeTie', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: current.eventId, tieId: payload.tieId, at: nowIso });
    return { ok: true, tie: buildTieRow(next, { actor }), message: '' };
  });
  return ok(result);
}

async function assignCollegeTieReferee(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  if (!canManageCollegeEvent(actor)) return ok(refused('只有管理员可以指派裁判'));

  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  if (!canAssignTieReferee(tie)) return ok(refused('这个大场已经结束，不能再改派裁判'));
  if (await collegeEventFinished(ctx.repo, tie.eventId)) return ok(refused('学院赛已结束，不能再改派裁判'));

  const refereeId = String(payload.refereeId || '').trim();
  const nowIso = iso(ctx.now);
  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    if (!canAssignTieReferee(current)) return refused('这个大场已经结束，不能再改派裁判');
    // 事务内复查权限：撤权之后不能再改派裁判（F2 同类）
    if (!canManageCollegeEvent(actor)) return refused('只有管理员可以指派裁判');
    if (await collegeEventFinished(tx, current.eventId)) return refused('学院赛已结束，不能再改派裁判');
    if (refereeId) {
      const rejection = await refereeRejection(tx, ctx, refereeId);
      if (rejection) return refused(rejection);
    }

    const patch = buildRefereePatch(refereeId, { actorId: ctx.actorId, now: ctx.now });
    // 一次指派 = 写大场 + 写它下面所有能改派的小场（权限判定只读小场自己的 referee）。
    for (const legId of legMatchIdsOf(current)) {
      const leg = await tx.matches.getById(legId);
      if (!leg || !canAssignReferee(leg)) continue;
      await tx.matches.set(legId, { ...leg, ...patch,
        revision: Number(leg.revision || 1) + 1, updatedAt: nowIso });
    }
    const next = { ...current, ...patch, refereeAt: nowIso,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.ties.set(payload.tieId, next);
    await tx.audit.append({ _id: collegeTieAuditKey(payload.tieId, 'assignCollegeTieReferee', next.revision),
      action: 'assignCollegeTieReferee', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: current.eventId, tieId: payload.tieId, refereeId, at: nowIso });
    return { ok: true, tie: buildTieRow(next, { actor }), message: '' };
  });
  return ok(result);
}

async function finishCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) return ok(refused('这场学院赛已经结束了'));
  if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) return ok(refused('学院赛还没开始，不能录入名次'));
  if (!canFinishCollegeEvent(event, actor)) return ok(refused('只有管理员可以录入名次'));

  // 只能给「已通过审核」的学院记名次，挡住手滑写进来的学院名。
  const entries = (await ctx.repo.forScope(ctx).collegeEntries.list())
    .filter(row => row.eventId === event._id && row.status === COLLEGE_ENTRY_STATUS.APPROVED);
  const checked = validateCollegePlacements(payload.results, { colleges: entries.map(row => row.college) });
  if (!checked.ok) return ok(refused(checked.firstError));

  const nowIso = iso(ctx.now);
  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    if (current.status !== COLLEGE_EVENT_STATUS.ONGOING) return refused('这场学院赛已经结束了');
    // 事务内复查权限：撤权之后不能再录名次（F2 同类）
    if (!canFinishCollegeEvent(current, actor)) return refused('只有管理员可以录入名次');

    const next = { ...current, status: COLLEGE_EVENT_STATUS.FINISHED, results: checked.results,
      finishedAt: nowIso, revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'finishCollegeEvent', next.revision),
      action: 'finishCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }), results: next.results, message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------ 弃权 */

/**
 * 管理员记一次学院赛小场弃权（M4-7）。
 * ============================================================
 * 与旧栈 `recordForfeit`（mock.js / 云端 college-handlers）同一把尺子：**仅管理员**，
 * 且大场已开始；弃权方丢掉这一小项、对手拿下，且不计 ELO（outcome=forfeit，回放据
 * 此排除）。与个人赛弃权不同的一点：**弃权的是学院、不是个人编号**，所以这里收的是
 * `collegeId`（或全名），而不是 userId——`school-match-service.forfeitSchoolMatch` 明确
 * 把学院赛挡在门外（见其 canForfeit），学院赛弃权自成一档，故在此单列。
 *
 * 【为什么写回大场要单独一步】
 * 小场生效只是「这一项有结果了」；大场胜者与下一轮晋级要靠 `advanceCollegeAfterLeg`
 * 把结果写回大场、必要时铺出下一轮（与个人赛场次确认后同一条链路），不能只改小场。
 *
 * @param {Object} payload { tieId, legNo, collegeId?/college? }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, tie, message}
 */
async function forfeitCollegeTieLeg(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  if (!canManageCollegeEvent(actor)) return ok(refused('只有管理员可以记录弃权'));

  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  if (tie.status === TIE_STATUS.FINISHED) return ok(refused('这个大场已经结束'));
  if (tie.status !== TIE_STATUS.ONGOING) return ok(refused('大场还没开始，不能记弃权'));
  if (await collegeEventFinished(ctx.repo, tie.eventId)) return ok(refused('学院赛已结束，不能再记弃权'));

  const legNo = Number(payload.legNo);
  const leg = (Array.isArray(tie.legs) ? tie.legs : []).find(item => Number(item.legNo) === legNo);
  if (!leg) return ok(refused('找不到这个小项'));
  if (!leg.matchId) return ok(refused('这个小项还没有生成比赛'));
  if (leg.winner) return ok(refused('这个小项已经有结果了'));

  const { college } = resolveCollege(payload, dir);
  if (college !== tie.collegeA && college !== tie.collegeB) {
    return ok(refused('弃权的必须是本大场的参赛学院'));
  }

  const nowIso = iso(ctx.now);
  const result = await inTransaction(ctx, dir, async (tx, actor) => {
    const match = await tx.matches.getById(leg.matchId);
    if (!isCollegeLegDoc(match) || !belongsToSchoolScope(match, ctx)) return refused('找不到这个小项的比赛');
    if (match.status === MATCH_STATUS.ACTIVE) return refused('这个小项已经生效，不能再记弃权');
    if (await collegeEventFinished(tx, tie.eventId)) return refused('学院赛已结束，不能再记弃权');
    // 事务内复查权限：撤权之后不能再记录弃权（F2 同类）
    if (!canManageCollegeEvent(actor)) return refused('只有管理员可以记录弃权');

    // 站在 A 边的人弃权，就是 B 边获胜（与个人赛 buildForfeitPatch 同一换算）。
    const winner = college === tie.collegeA ? TEAM.B : TEAM.A;
    const candidate = {
      ...match,
      outcome: MATCH_OUTCOME.FORFEIT,
      forfeitBy: college,
      winner,
      scoreA: [],
      scoreB: [],
      recorder: ctx.actorId,
      status: MATCH_STATUS.ACTIVE,
      action: 'forfeit',
      actor: ctx.actorId,
      actedAt: nowIso,
    };
    // 弃权是终态封口：落一份「不计分」结算决定（forfeit），别让 ACTIVE 小场
    // 缺结算快照——学院赛单打计分、双打不计分的口径就靠快照里的排除原因解释。
    const { settlement } = await settleMatchInTransaction(tx, ctx, candidate, {});
    const next = {
      ...candidate,
      settlement,
      revision: Number(match.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.matches.set(match._id, next);
    await tx.audit.append({ _id: collegeTieAuditKey(tie.eventId, 'forfeitCollegeTieLeg', next.revision),
      action: 'forfeitCollegeTieLeg', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: tie.eventId, tieId: payload.tieId, legNo, at: nowIso });
    return { ok: true, legMatch: next, message: '' };
  });
  if (!result.ok) return ok(result);

  // 小场生效后写回大场（可能顺带排出下一轮）。
  await advanceCollegeAfterLeg(ctx, result.legMatch);
  const updated = await ctx.repo.ties.getById(payload.tieId);
  return ok({ ok: true, tie: buildTieRow(updated || tie, { actor }), message: '' });
}

/* ------------------------------------------------------------ 置顶 */

/**
 * 置顶 / 取消置顶一场学院赛（仅管理员，与发布同一门槛）。
 * ============================================================
 * 列表页把置顶的学院赛排在最前，与个人赛、公告同一口径。旧栈里置顶落在
 * `collegeStore`，学校维度把学院赛主记录搬进 S2，置顶也必须写回同一条主记录，
 * 否则列表按 S2 读、置顶按旧栈写，两处各说各话（置顶点了没反应）。
 *
 * 置顶与赛事进行到哪一步无关，也不进任何回放缓存——改完直接读台账即可。
 *
 * @param {Object} payload { eventId, pinned }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, event, message}
 */
async function setCollegeEventPinned(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId, scope: ctx, now: ctx.now });
    const actor = legacyActorOf(fresh, dir);
    if (!canReadAssociationSpace(fresh) || !canManageCollegeEvent(actor)) {
      return refused('当前账号没有管理学院赛的权限');
    }
    const event = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, fresh)) return refused('找不到这场学院赛');
    const nowIso = iso(fresh.now);
    const next = { ...event, pinned: Boolean(payload.pinned),
      revision: Number(event.revision || 1) + 1, updatedAt: nowIso };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'setCollegeEventPinned', next.revision),
      action: 'setCollegeEventPinned', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId: payload.eventId, pinned: next.pinned, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }), message: '' };
  }));
}

module.exports = {
  EVENT_LIST_LIMIT, EVENT_LIST_MAX,
  isCollegeEventDoc, isCollegeTieDoc,
  listCollegeEvents, getCollegeEvent, publishCollegeEvent, setCollegeEventPinned,
  listCollegeEntries, submitCollegeEntry, reviewCollegeEntry,
  listCollegeTies, drawCollegeEvent, startCollegeEvent,
  listCollegeLineups, submitCollegeLineup, startCollegeTie,
  assignCollegeTieReferee, finishCollegeEvent, forfeitCollegeTieLeg,
};
