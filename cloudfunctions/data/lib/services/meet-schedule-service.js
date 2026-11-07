/**
 * 运动会：赛程与裁判指派（B6）
 * ============================================================
 * 三条产品约束决定这一批的形状：
 *
 *   D53 报名结束后、赛程发布前，**时间与场地必须配齐**——缺一个就不许发布，
 *       并且要报出缺哪些项目，而不是一句「不完整」；
 *   裁判可以随时指派，但**没有裁判的场次不能开赛**；
 *   D55 本期**不做冲突检测**（同裁判同时段两场、选手撞场都不拦），只给提示。
 *
 * 【为什么冲突检测不做而不是「顺手做一下」】
 * 冲突检测要判「同一裁判同一时间段」「同一选手两场重叠」「同一场地重叠」，
 * 而选手重叠需要展开每条参赛名单——那是跨集合查询，事务内做不到，读放大也大。
 * 用户明确裁了「暂不做」，这里就诚实地不加：页面上仍会显示同时间同裁判的提示，
 * 但不阻断。若将来要做，必须补一份「场次 × 参与人」的索引，不能靠扫名单。
 *
 * 【裁判为什么必须是在册会员】
 * D59 要求可鉴权账号。这里取「本校在册会员 + 账号有效」，与参赛资格同一把尺子：
 * 外校账号、已退会、被停用的账号都不能被指派。
 * ============================================================
 */

const {
  MEET_STATUS, MEET_ENTRY_STATUS, meetSessionKey, meetJudgeKey, listAliveEvents,
} = require('../utils/meet-scope.js');
const { schoolMemberKey, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { MEET_SCORE_TYPE, getTemplate, HEAT_MODE } = require('./meet-event-catalog.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet, isChiefJudge } = require('./meet-permission.js');
const { loadColleges } = require('./college-directory.js');

const {
  touchEvent, liveMeet, scheduleRevisionOf, unchangedScheduleRevision,
} = require('./meet-consistency.js');
const { compareCode } = require('../utils/text-order.js');

// DTO 补 ok:true，与其余三域同形（见 meet-service.js 的说明）。
const ok = (data) => ({ ok: true, data: { ...data, ok: data.ok === undefined ? true : data.ok } });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const ROUND_LABEL = Object.freeze({ final: '决赛', heat: '预赛', rr: '循环赛' });

/** 裁判候选单页上限：与运动会其余分页接口同一档（20/50 系），不设「一次给完」。 */
const JUDGE_CANDIDATE_MAX = 100;
/** 赛制轮次用 `r1`、`r2`… 表示；`rf` 不单独存在，最后一轮仍记作 `r<总轮数>`。 */
const BRACKET_ROUND = /^[rg][1-9]$/;
const SESSION_STATUS = Object.freeze({ SCHEDULED: 'scheduled', RUNNING: 'running', FINISHED: 'finished' });
/** 成绩状态：与 meet-score-service 的 SCORE_STATE.SUBMITTED 同值（这里不反向依赖那个模块）。 */
const SCORE_SUBMITTED = 'submitted';
/**
 * 单事务最多使用 90 次读写，给仓储 100 次护栏留余量。
 * 上下文最多 5 读，m 名裁判资格 2m 读；每场 assignment 2m 次读写，
 * 加场次点读/写回及 touchEvent 点读/写回共 4 次。按 5 + 2m + n(2m+4) 分批。
 * 50 人连一个场次都无法放进同一事务，因此裁判也要切批（每批最多 20 人）。
 */
const JUDGE_OPERATION_BUDGET = 90;
const JUDGE_BATCH_SIZE = 20;

const isAliveMeet = (doc) => Boolean(doc && doc.status && doc.status !== MEET_STATUS.DELETED);
const toIso = (now) => (now instanceof Date ? now.toISOString() : String(now));

function textOf(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) return { ok: false, message: `${label}不超过 ${max} 个字` };
  return { ok: true, value: text };
}

/**
 * 场次时间：必填，但**不校验格式，也不与任何东西比较**。
 *
 * 开始时间在这里只承担「告知学生什么时候比」的作用，不参与任何业务判定
 * （不卡报名截止、不卡届次日期、不要求早于结束时间）。原先强制
 * `YYYY-MM-DDTHH:mm` 并校验先后，导致管理员改个场地都要先算好格式，
 * 属于没必要的门槛。这里只保留「不能为空、不能长到撑爆页面」两条。
 *
 * 能解析出时间就用于排序，解析不出就按主键排——时间填错不该让赛程页崩掉。
 */
function timeOf(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, message: `请填写${label}` };
  if (text.length > 40) return { ok: false, message: `${label}不超过 40 个字符` };
  const parsed = Date.parse(text.replace(' ', 'T').replace(/(\d{2}:\d{2})$/, '$1:00').concat('Z'));
  return { ok: true, value: text, time: Number.isFinite(parsed) ? parsed : null };
}

function sessionSummary(doc) {
  return {
    sessionKey: doc._id,
    eventKey: doc.eventKey,
    round: doc.round,
    roundLabel: doc.roundLabel || ROUND_LABEL[doc.round] || doc.round,
    index: doc.index,
    startAt: doc.startAt,
    endAt: doc.endAt || '',
    venue: doc.venue || '',
    note: doc.note || '',
    status: doc.status,
    // 参赛人：预赛是分到本组的人，赛制项目是本场对阵双方。空数组表示「全项目」。
    entryKeys: Array.isArray(doc.entryKeys) ? doc.entryKeys : [],
    winnerEntryKey: doc.winnerEntryKey || '',
  };
}

const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });

/** 本届全部场次（按开始时间排序；无时间的排最后） */
async function listSessions(repo, ctx) {
  const docs = await repo.forMeet(scopeOf(ctx)).sportsMeetSessions.list();
  return docs
    .filter((doc) => doc.schoolId === ctx.schoolId && doc.meetId === ctx.meetId)
    // 重抽时旧场次被标成 voidedAt（仓储没有 remove）：读取端统一过滤，
    // 赛程页 / 录分任务 / 场次清单都不会看到已作废的场次。
    .filter((doc) => !doc.voidedAt)
    .sort((a, b) => {
      const ta = Number.isFinite(Date.parse(String(a.startAt || '').replace(' ', 'T')))
        ? Date.parse(String(a.startAt).replace(' ', 'T')) : Number.MAX_SAFE_INTEGER;
      const tb = Number.isFinite(Date.parse(String(b.startAt || '').replace(' ', 'T')))
        ? Date.parse(String(b.startAt).replace(' ', 'T')) : Number.MAX_SAFE_INTEGER;
      return ta - tb || compareCode(a._id, b._id);
    });
}

/**
 * 保存一个场次（同一项目组别 × 轮次 × 组次是唯一键，重复保存即覆盖）。
 *
 * @param {Object} payload { eventKey, round: 'final'|'heat', index, startAt, endAt, venue, note }
 */
async function saveMeetSession(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const round = String(payload.round || 'final');
  // 轮次三类：预赛 / 决赛（数值型项目的多轮），循环赛，以及淘汰赛的 r1…r9。
  // 淘汰赛轮次由编排自动生成，这里允许手工保存是为了改时间、场地与裁判，不是
  // 让管理员手工造对阵——对阵只能由签表算法落位。
  if (!ROUND_LABEL[round] && !BRACKET_ROUND.test(round)) {
    return refused('轮次只能是预赛、决赛、循环赛或淘汰赛轮次（r1–r9）');
  }
  const index = Number(payload.index === undefined ? 1 : payload.index);
  if (!Number.isInteger(index) || index < 1 || index > 99) return refused('组次应为 1–99 的整数');

  const start = timeOf(payload.startAt, '开始时间');
  if (!start.ok) return refused(start.message);
  // 结束时间选填，也不与开始时间比较：它同样是给人看的信息
  const end = payload.endAt ? timeOf(payload.endAt, '结束时间') : { ok: true, value: '' };
  if (!end.ok) return refused(end.message);

  const venue = textOf(payload.venue, 40, '场地');
  if (!venue.ok) return refused(venue.message);
  const note = textOf(payload.note, 100, '备注');
  if (!note.ok) return refused(note.message);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以编排赛程');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAliveMeet(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');

    const eventKey = String(payload.eventKey || '').trim();
    const event = await tx.sportsMeetEvents.getById(eventKey);
    if (!event || event.meetId !== fresh.meetId) return refused('项目组别不存在或不属于本届运动会');

    const key = meetSessionKey(fresh.meetId, eventKey, round, index);
    const current = await tx.sportsMeetSessions.getById(key);
    const now = toIso(fresh.now);
    // 先铺原文档再覆盖排期字段：裁判数与参赛人不是本动作的数据，
    // 若整份重写就会把 judgeCount 归零（开赛随即被判「没有裁判」），
    // 也会把抽签分好的对阵抹掉。改时间不该有这两种副作用。
    const doc = {
      ...(current || {}),
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey,
      round,
      index,
      startAt: start.value,
      endAt: end.value,
      venue: venue.value,
      note: note.value,
      status: current ? current.status : SESSION_STATUS.SCHEDULED,
      entryKeys: Array.isArray(current && current.entryKeys) ? current.entryKeys : [],
      roundLabel: (current && current.roundLabel) || ROUND_LABEL[round] || '',
      createdAt: current ? (current.createdAt || now) : now,
      updatedAt: now,
    };
    await touchEvent(tx, eventKey);
    await tx.sportsMeetSessions.set(key, doc);
    // 时间/场地属于「赛程面」，递增届次赛程版本；复用上面已读到的 meet，只多一次写。
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, scheduleRevision: scheduleRevisionOf(meet) + 1,
    });
    return ok({ session: sessionSummary(doc) });
  });
}

/**
 * 发布赛程：每个项目组别都要有「带了时间与场地」的场次，缺一项就拒绝并列出。
 *
 * 【什么算「配齐」要按项目类型分开判】
 * 数值型直接决赛：那一场配齐即可。数值型预赛+决赛：**每一组预赛与决赛**都要配齐，
 * 只配第一组就发布，等于让后面几组没有时间场地。赛制项目：只需首轮（r1／循环赛）
 * 配齐——后面几轮要等上一轮出了胜负才存在，要求它们提前配齐是不可能的。
 *
 * 预赛还有一条前置：分组必须已经抽签（每个预赛场次都有参赛人）。没抽签就发布，
 * 首页会显示一排「预赛第 N 组 · 0 人」的空场次。
 *
 * 校验在事务外读一次（事务内不能查询），事务内只重读运动会状态与**赛程版本**再落库。
 * 赛程发布不是名额类操作，不存在「并发超卖」，这里接受一次读快照。
 *
 * 【为什么事务内不再逐条重读项目与场次】（2026-10-26 只读审查 P1-2）
 * 原先事务内对全届项目 + 全届场次做快照比对，操作数随规模线性增长：
 * 48 个项目组别各 1 个场次就是 96 次读，加身份复核与运动会读后 101 次，
 * 直接越过云端 100 次事务预算——规模越大越必然失败。现在改为比对届次级的
 * `scheduleRevision`（见 `meet-consistency.touchScheduleRevision`）：1 次读，
 * 与项目数、场次数无关；项目与场次的任何变化都会递增它，并发校验强度不降。
 */
async function publishMeetSchedule(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  const [events, sessions, snapshotMeet] = await Promise.all([
    listAliveEvents(ctx.repo.forMeet(scopeOf(ctx)).sportsMeetEvents),
    listSessions(ctx.repo, ctx),
    ctx.repo.sportsMeets.getById(ctx.meetId),
  ]);
  if (events.length === 0) return refused('本届还没有项目，无法发布赛程');

  const byEvent = new Map();
  for (const doc of sessions) {
    if (!byEvent.has(doc.eventKey)) byEvent.set(doc.eventKey, []);
    byEvent.get(doc.eventKey).push(doc);
  }

  const missing = [];
  const notDrawn = [];
  for (const event of events) {
    const own = byEvent.get(event._id) || [];
    // 赛制项目只要求「首轮」配齐：后续轮次要等上一轮出胜负才存在。
    // 小组+淘汰的首轮是小组赛（g1、g2…），淘汰赛那几轮此刻还是空的。
    const required = event.scoreType === MEET_SCORE_TYPE.VERSUS
      ? own.filter((doc) => (event.format === 'group_knockout'
        ? String(doc.round || '').startsWith('g')
        : (doc.round === 'r1' || doc.round === 'rr')))
      : own;// 数值型：所有场次都要配齐
    if (required.length === 0 || required.some((doc) => !doc.startAt || !doc.venue)) {
      missing.push(event.name);
      continue;
    }
    if (event.rounds === 'heat_final' && own.some((doc) => doc.round === 'heat'
      && !(Array.isArray(doc.entryKeys) && doc.entryKeys.length > 0))) {
      notDrawn.push(event.name);
    }
  }
  if (missing.length > 0) {
    return refused(`以下项目还没配齐时间与场地：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}`, { missing });
  }
  if (notDrawn.length > 0) {
    return refused(`以下项目的预赛还没抽签分组：${notDrawn.slice(0, 8).join('、')}`, { missing: notDrawn });
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以发布赛程');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAliveMeet(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status === MEET_STATUS.DRAFT) return refused('请先发布报名，再发布赛程');
    if (meet.status === MEET_STATUS.FINISHED) return refused('运动会已结束，不能重新发布赛程');
    if (!await unchangedScheduleRevision(tx, fresh.meetId, scheduleRevisionOf(snapshotMeet))) return refused('赛程已变化，请刷新后重试');

    const now = toIso(fresh.now);
    const next = {
      ...meet, status: meet.status === MEET_STATUS.RUNNING ? MEET_STATUS.RUNNING : MEET_STATUS.SCHEDULED, schedulePublishedAt: now, updatedAt: now,
      version: (meet.version || 1) + 1,
      // 发布本身也占一版：两次并发发布只有一个能落地，后到的必须刷新重试。
      scheduleRevision: scheduleRevisionOf(meet) + 1,
    };
    await tx.sportsMeets.set(fresh.meetId, next);
    return ok({ meet: { meetId: fresh.meetId, status: next.status } });
  });
}

/** 指派裁判：本校在册会员；同一场次同一人重复指派是幂等的 */
async function assignMeetJudge(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以指派裁判');

    const sessionKey = String(payload.sessionKey || '').trim();
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== fresh.meetId) return refused('场次不存在或不属于本届运动会');

    const judgeId = String(payload.judgeId || '').trim();
    if (!judgeId) return refused('请选择裁判');
    const member = await tx.schoolMembers.getById(schoolMemberKey(judgeId, fresh.schoolId));
    const judge = await tx.users.getById(judgeId);
    if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE
      || !judge || judge.platformStatus !== 'active' || judge.primarySchoolId !== fresh.schoolId) {
      return refused('只能指派本校在册且账号有效的成员担任裁判');
    }

    const key = meetJudgeKey(fresh.meetId, sessionKey, judgeId);
    const current = await tx.sportsMeetJudgeAssignments.getById(key);
    if (current && current.status === 'active') return ok({ assignment: current, created: false });

    const now = toIso(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      sessionKey,
      eventKey: session.eventKey,
      judgeId,
      status: 'active',
      assignedBy: fresh.actorId,
      assignedAt: current ? (current.assignedAt || now) : now,
      updatedAt: now,
    };
    await touchEvent(tx, session.eventKey);
    await tx.sportsMeetJudgeAssignments.set(key, doc);
    // 在场次文档上维护**裁判名单**（不是只维护一个计数）。
    // 计数会漂移：两个人同时指派时都读到 0、都写 1，实际却有两个裁判；
    // 反过来漏减一次就会出现「显示 2 人、实际没人」。名单去重后取长度，
    // 开赛判断在事务内点读这一个字段即可。
    const ids = Array.isArray(session.judgeIds) ? [...session.judgeIds] : [];
    if (!ids.includes(judgeId)) ids.push(judgeId);
    await tx.sportsMeetSessions.set(sessionKey, {
      ...session, judgeIds: ids, judgeCount: ids.length, updatedAt: now,
    });
    return ok({ assignment: doc, created: true });
  });
}

/**
 * 批量指派裁判。
 *
 * 【为什么需要它】
 * 学生运动会的常态是「连续几个项目同一批计时裁判」。逐个场次、逐个裁判地派，
 * 一个上午的赛程要几十次点击，漏派一场那场就开不了赛。
 *
 * 按裁判人数与场次数拆成多个事务，预算包含身份复核及全部读写。
 * 多事务之间不原子：失败时返回已完整完成的场次；当前批可能已指派部分裁判，
 * 重试通过 assignment 自然键跳过已完成指派。
 *
 * @param {Object} payload { judgeIds: string[], sessionKeys? | eventKey? | date? }
 *        scope 三选一：显式勾选的场次 / 某个项目的全部场次 / 某一天的全部场次
 */
async function assignMeetJudges(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以指派裁判');

  const judgeIds = [...new Set((Array.isArray(payload.judgeIds) ? payload.judgeIds : [])
    .map((id) => String(id).trim())
    .filter(Boolean))];
  if (judgeIds.length === 0) return refused('请选择裁判');
  if (judgeIds.length > 50) return refused('一次最多指派 50 名裁判');

  const scope = scopeOf(ctx);
  const [events, sessions] = await Promise.all([
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    listSessions(ctx.repo, ctx),
  ]);
  const eventKeys = new Set(events.map((doc) => doc._id));

  // 目标场次：显式勾选 > 整个项目 > 某一天
  let targets = [];
  if (Array.isArray(payload.sessionKeys) && payload.sessionKeys.length > 0) {
    const wanted = new Set(payload.sessionKeys.map((key) => String(key).trim()).filter(Boolean));
    targets = sessions.filter((doc) => wanted.has(doc._id));
    if (targets.length === 0) return refused('勾选的场次不存在');
  } else if (payload.eventKey) {
    const eventKey = String(payload.eventKey).trim();
    if (!eventKeys.has(eventKey)) return refused('项目组别不存在');
    targets = sessions.filter((doc) => doc.eventKey === eventKey);
    if (targets.length === 0) return refused('该项目还没有场次，请先设置赛制并分组');
  } else if (payload.date) {
    // 开始时间是自由文本（只作告知），这里做前缀匹配，不要求严格格式
    const date = String(payload.date).trim();
    targets = sessions.filter((doc) => String(doc.startAt || '').startsWith(date));
    if (targets.length === 0) return refused(`${date} 没有已排期的场次`);
  } else {
    return refused('请指定要指派的场次范围（勾选场次 / 整个项目 / 某一天）');
  }

  // 裁判资格一次性校验完再动手：派到一半才发现有人不在册，会留下半套指派
  const members = await ctx.repo.schoolMembers.listBySchool(ctx.schoolId);
  const activeMember = new Map();
  for (const member of members) {
    if (member.status === SCHOOL_MEMBER_STATUS.ACTIVE) activeMember.set(member.userId, member);
  }
  const valid = [];
  for (const judgeId of judgeIds) {
    if (!activeMember.has(judgeId)) return refused(`「${judgeId}」不是本校在册成员`);
    const user = await ctx.repo.users.getById(judgeId);
    if (!user || user.platformStatus !== 'active' || user.primarySchoolId !== ctx.schoolId) return refused(`「${judgeId}」账号无效或不属于本校`);
    valid.push(judgeId);
  }

  const judgeBatches = [];
  for (let offset = 0; offset < valid.length; offset += JUDGE_BATCH_SIZE) {
    judgeBatches.push(valid.slice(offset, offset + JUDGE_BATCH_SIZE));
  }
  const maxJudges = judgeBatches[0].length;
  const perBatch = Math.max(1, Math.floor(
    (JUDGE_OPERATION_BUDGET - 5 - 2 * maxJudges) / (2 * maxJudges + 4)
  ));
  let created = 0;
  let existed = 0;
  const done = [];
  const partial = message => refused(
    `已完成 ${done.length} 个场次；${message}。当前批次可能已指派部分裁判，刷新后可重试，已完成指派不会重复。`,
    { completedSessions: [...done], created, existed }
  );
  for (let offset = 0; offset < targets.length; offset += perBatch) {
    const batch = targets.slice(offset, offset + perBatch);
    for (const judges of judgeBatches) {
      let result;
      try {
        result = await ctx.repo.transaction(async (tx) => {
          const fresh = await freshMeetContext(tx, ctx);
          if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
          if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以指派裁判');
          const now = toIso(fresh.now);
          // 必须在任何写入前完成整批校验；返回 refused 不会回滚之前已经写入的数据。
          for (const judgeId of judges) {
            const member = await tx.schoolMembers.getById(schoolMemberKey(judgeId, fresh.schoolId));
            const user = await tx.users.getById(judgeId);
            if (!member || member.status !== 'active' || !user || user.platformStatus !== 'active' || user.primarySchoolId !== fresh.schoolId) return refused('裁判资格已变化，请刷新后重试');
          }
          const currentSessions = [];
          for (const target of batch) {
            const current = await tx.sportsMeetSessions.getById(target._id);
            if (!current || current.voidedAt || current.meetId !== fresh.meetId || current.schoolId !== fresh.schoolId) return refused('场次已变化，请刷新后重试');
            currentSessions.push(current);
          }
          let batchCreated = 0;
          let batchExisted = 0;
          for (const current of currentSessions) {
            const ids = Array.isArray(current.judgeIds) ? [...current.judgeIds] : [];
            for (const judgeId of judges) {
              const key = meetJudgeKey(fresh.meetId, current._id, judgeId);
              const assignment = await tx.sportsMeetJudgeAssignments.getById(key);
              if (assignment && assignment.status === 'active') {
                batchExisted += 1;
                continue;
              }
              await tx.sportsMeetJudgeAssignments.set(key, {
                schoolId: fresh.schoolId,
                meetId: fresh.meetId,
                sessionKey: current._id,
                eventKey: current.eventKey,
                judgeId,
                status: 'active',
                assignedBy: fresh.actorId,
                assignedAt: assignment ? (assignment.assignedAt || now) : now,
                updatedAt: now,
              });
              if (!ids.includes(judgeId)) ids.push(judgeId);
              batchCreated += 1;
            }
            await touchEvent(tx, current.eventKey);
            await tx.sportsMeetSessions.set(current._id, {
              ...current, judgeIds: ids, judgeCount: ids.length, updatedAt: now,
            });
          }
          return ok({ created: batchCreated, existed: batchExisted });
        });
      } catch (error) {
        return partial(error.message || '指派失败');
      }
      if (!result.ok) return partial(result.message);
      created += result.data.created;
      existed += result.data.existed;
    }
    for (const session of batch) done.push(session._id);
  }

  return ok({
    judgeIds: valid,
    sessionCount: done.length,
    created,
    existed,
    sessions: done,
  });
}

/**
 * 场次的先后次序：预赛 → 小组赛 → 淘汰赛各轮 → 决赛 → 循环赛。
 *
 * 不能只按 index 排：预赛第 1 组、预赛第 2 组、决赛的 index 都是 1、2、1，
 * 按 index 排会把决赛插到中间。也不能按创建时间——决赛常在预赛之前建出来。
 */
function roundRankOf(doc) {
  const round = String((doc && doc.round) || '');
  if (round === 'heat') return 1;
  const group = /^g([1-9])$/.exec(round);
  if (group) return 2 + Number(group[1]) / 100;
  const bracket = /^r([1-9])$/.exec(round);
  if (bracket) return 3 + Number(bracket[1]) / 100;
  if (round === 'final') return 9;
  if (round === 'rr') return 50;
  return 99;
}

/**
 * 一个项目的全部场次（录分页的场次切换用）。
 *
 * 批量指派之后，同一项目的多个场次属于同一批裁判，需要能顺着切过去录分，
 * 而不是每录一场退回任务列表再点一次。这里只回场次清单，不回成绩。
 */
async function listMeetEventSessions(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [events, sessions, assignments] = await Promise.all([
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    listSessions(ctx.repo, ctx),
    // 只取本项目的指派（2026-10-26 第五轮 B）：一届的指派是「场次 × 裁判数」，
    // 而这里只需要「我在这几场里算不算裁判」。
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.listByProject(eventKey),
  ]);
  const event = events.find((doc) => doc._id === eventKey);
  if (!event) return refused('项目组别不存在');

  const mine = new Set(assignments
    .filter((doc) => doc.status === 'active' && doc.judgeId === ctx.actorId)
    .map((doc) => doc.sessionKey));

  const items = sessions
    .filter((doc) => doc.eventKey === eventKey)
    .sort((a, b) => roundRankOf(a) - roundRankOf(b) || Number(a.index) - Number(b.index))
    .map((doc) => ({
      sessionKey: doc._id,
      round: doc.round,
      roundLabel: doc.roundLabel || ROUND_LABEL[doc.round] || doc.round,
      index: doc.index,
      startAt: doc.startAt || '',
      venue: doc.venue || '',
      entryCount: (Array.isArray(doc.entryKeys) ? doc.entryKeys : []).filter(Boolean).length,
      judgeIds: Array.isArray(doc.judgeIds) ? doc.judgeIds : [],
      assignedToMe: mine.has(doc._id),
      status: doc.status,
    }));

  return ok({
    event: {
      eventKey, name: event.name, group: event.group,
      rounds: event.rounds, heatMode: event.heatMode || '',
    },
    items,
  });
}

/** 移除裁判：保留记录（status=revoked），B7 会据此判断「已提交分数的裁判不可撤换」 */
async function removeMeetJudge(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');

  // 先查「这个裁判在本场次交没交成绩」：没交就不许撤（见下方 N4 说明）
  const submittedJudge = String(payload.judgeId || '').trim();
  const submittedSession = String(payload.sessionKey || '').trim();
  if (submittedJudge && submittedSession) {
    // 【只读本场次的成绩】（2026-10-23 第三轮审查 X-10）
    // 原来读的是**整届** sportsMeetScores：项目 × 场次 × 裁判数，一届数千条、
    // 几十页 RPC，只为判断「这一场这一位裁判交没交」。仓储已有 listBySession。
    const scores = await ctx.repo.forMeet(scopeOf(ctx)).sportsMeetScores.listBySession(submittedSession);
    const hasSubmitted = scores.some((doc) => doc.sessionKey === submittedSession
      && doc.judgeId === submittedJudge && doc.state === SCORE_SUBMITTED);
    if (!hasSubmitted) {
      return refused('只能撤换已提交成绩的裁判；未提交的裁判撤掉后，本场将永远凑不齐成绩');
    }
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以撤销指派');

    const sessionKey = String(payload.sessionKey || '').trim();
    const judgeId = String(payload.judgeId || '').trim();
    const key = meetJudgeKey(fresh.meetId, sessionKey, judgeId);
    const current = await tx.sportsMeetJudgeAssignments.getById(key);
    if (!current || current.status !== 'active') return refused('该裁判没有在任指派');

    // N4（已裁决）：只允许撤换**已提交成绩**的裁判。
    //
    // 分母按原始指派算：撤掉一个还没交分的裁判，这个场次就永远凑不齐「全员提交」，
    // 成绩再也汇总不出来。已提交的分数保留在库、继续参与汇总，这正是「已评分保留」。
    //
    // 事务内不能查询，所以在事务外读一次快照；本动作不是名额类操作，接受快照。
    const now = toIso(fresh.now);
    await tx.sportsMeetJudgeAssignments.set(key, {
      ...current, status: 'revoked', revokedBy: fresh.actorId, revokedAt: now, updatedAt: now,
    });
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (session) {
      await touchEvent(tx, session.eventKey);
      const ids = (Array.isArray(session.judgeIds) ? session.judgeIds : [])
        .filter((id) => id !== judgeId);
      await tx.sportsMeetSessions.set(sessionKey, {
        ...session, judgeIds: ids, judgeCount: ids.length, updatedAt: now,
      });
    }
    return ok({ sessionKey, judgeId });
  });
}

/**
 * 开赛：该场次至少 1 名有效裁判，否则拒绝（D53「不指定裁判的项目不能开赛」）。
 * 开赛后运动会进入「进行中」。
 */
async function startMeetEvent(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以开始比赛');

    const sessionKey = String(payload.sessionKey || '').trim();
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== fresh.meetId) return refused('场次不存在或不属于本届运动会');
    if (fresh.meet.status === MEET_STATUS.FINISHED) return refused('运动会已结束，不能重新开赛');
    if (!session.startAt || !session.venue) return refused('该场次还没配齐时间与场地');

    // 判「有没有裁判」只能点读场次文档——事务内不能查指派表。
    // 优先看名单（准确），老数据没有名单时退回计数。
    const judgeIds = Array.isArray(session.judgeIds) ? session.judgeIds : null;
    const judgeCount = judgeIds ? judgeIds.length : Number(session.judgeCount || 0);
    if (!(judgeCount > 0)) return refused('该场次还没有指派裁判，不能开赛');

    const now = toIso(fresh.now);
    await tx.sportsMeetSessions.set(sessionKey, {
      ...session, status: SESSION_STATUS.RUNNING, startedAt: now, updatedAt: now,
    });
    await touchEvent(tx, session.eventKey);
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (meet && meet.status !== MEET_STATUS.RUNNING) {
      await tx.sportsMeets.set(fresh.meetId, {
        ...meet, status: MEET_STATUS.RUNNING, updatedAt: now, version: (meet.version || 1) + 1,
      });
    }
    return ok({ sessionKey, status: SESSION_STATUS.RUNNING });
  });
}

/** 赛程：按项目组别分组，附带每个场次的裁判 */
async function getMeetSchedule(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const isAdmin = canManageMeet(ctx);
  const scope = scopeOf(ctx);

  const [meet, events, sessions, assignments, entries] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    listSessions(ctx.repo, ctx),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
    // 名额是排赛程的前提（分几组、分几枪都要看人数），管理员也该一眼看到
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
  ]);
  if (!isAliveMeet(meet) || meet.schoolId !== ctx.schoolId) return refused('运动会不存在或已删除');
  if (meet.status === MEET_STATUS.DRAFT && !isAdmin) return refused('运动会尚未发布');

  const judgesOf = new Map();
  for (const row of assignments.filter((doc) => doc.status === 'active')) {
    const list = judgesOf.get(row.sessionKey) || [];
    list.push(row.judgeId);
    judgesOf.set(row.sessionKey, list);
  }
  // 裁判姓名：场次文档上只有 judgeIds 名单（要落库、开赛要判长度），姓名在这里
  // 解析一次带上页面。页面若直接显示 ID，管理员就看不到自己派了谁——用户反馈。
  //
  // 【为什么批读而不是逐个 getById】（2026-10-22 第二轮审查 P-4）
  // 一场运动会 40 个项目 × 每项 2~3 名裁判，逐条 `await` 就是 60~120 次**串行**
  // RPC，赛程页光解析姓名就要等一两秒。`users.listByIds` 每 100 个一批，通常
  // 1 次往返就够。
  const allJudgeIds = new Set();
  for (const list of judgesOf.values()) for (const judgeId of list) allJudgeIds.add(judgeId);
  const judgeIds = [...allJudgeIds];
  const judgeUsers = judgeIds.length > 0 ? await ctx.repo.users.listByIds(judgeIds) : [];
  const judgeUserById = new Map(judgeUsers.map(user => [user._id, user]));
  const judgeNames = new Map(judgeIds.map((judgeId) => {
    const user = judgeUserById.get(judgeId);
    return [judgeId, (user && (user.realName || user.nickName)) || judgeId];
  }));
  const judgesSummary = (sessionKey) => (judgesOf.get(sessionKey) || [])
    .map((judgeId) => ({ judgeId, name: judgeNames.get(judgeId) || judgeId }));

  // 每个项目已通过 / 待审的参赛记录数。赛事侧的「报名多少人」说的就是这一对数：
  // 意向不占名额（D10），只有正式 entry 才算数。
  const entryCounts = new Map();
  for (const doc of entries) {
    if (!doc || !doc.eventKey) continue;
    const row = entryCounts.get(doc.eventKey) || { approved: 0, pending: 0 };
    if (doc.status === MEET_ENTRY_STATUS.APPROVED) row.approved += 1;
    else if (doc.status === MEET_ENTRY_STATUS.PENDING_REVIEW) row.pending += 1;
    entryCounts.set(doc.eventKey, row);
  }
  const entryUnitOf = (form) => (form === 'team' ? '队' : form === 'group' ? '组' : '人');

  const items = events.map((event) => {
    const own = sessions.filter((doc) => doc.eventKey === event._id);
    const counted = entryCounts.get(event._id) || { approved: 0, pending: 0 };
    // 老数据没有 heatMode／heatCapacity：按模板补。不补的话页面会把长跑显示成
    // 「每批 6 人」，也会把跳远的「抽签分组」按钮点亮——点了才报错。
    const template = getTemplate(event.templateId);
    const heatMode = event.heatMode || (template && template.heatMode) || '';
    const heatCapacity = Number(event.heatCapacity) || Number(event.laneCount)
      || (template && template.heatCapacity) || 0;
    return {
      eventKey: event._id,
      name: event.name,
      group: event.group,
      // 录分页要据此决定显示「场次切换」「抽签分预赛」还是「签表」，
      // 所以把成绩类型与赛制一起带出来，页面不用再猜。
      scoreType: event.scoreType,
      rounds: event.rounds,
      format: event.format || '',
      groups: event.groups || null,
      // 分批口径：lane 按道数、capacity 按人数上限、single 不分批。
      // 页面据此决定「抽签分组」按钮是否出现、每组人数怎么称呼。
      heatMode,
      heatCapacity,
      // 单场项目（田赛、评分展示）没有分组这一步
      canDraw: event.scoreType !== MEET_SCORE_TYPE.VERSUS && heatMode !== HEAT_MODE.SINGLE,
      laneCount: Number(event.laneCount) || 0,
      advance: event.advance || null,
      scored: event.scored,
      // 报名口径：entryForm 决定「人 / 组 / 队」，approved 是正式名单，pending 待审
      entryForm: event.entryForm || 'single',
      entryCount: counted.approved,
      pendingCount: counted.pending,
      entryUnit: entryUnitOf(event.entryForm),
      ready: own.some((doc) => doc.startAt && doc.venue),
      sessions: own.map((doc) => ({
        ...sessionSummary(doc),
        judgeIds: judgesOf.get(doc._id) || [],
        // 已选裁判（姓名版）：撤销按钮按 judgeId 指回来，名单长度供页面计数
        judges: judgesSummary(doc._id),
        judgeCount: (judgesOf.get(doc._id) || []).length,
        // D55：不做冲突检测，只把「同时间同裁判」标出来提示
        warning: (judgesOf.get(doc._id) || []).length === 0 ? '未指派裁判' : '',
      })),
    };
  });

  return ok({
    meet: { meetId: meet._id, status: meet.status, name: meet.name },
    // 发布/更正/判定胜负的资格（管理员 + 本届总裁判），与「能不能编排」分开：
    // 总裁判不编排赛程，但要能在录分页发布成绩。
    canPublish: isAdmin || isChiefJudge(ctx, meet),
    // 本届总裁判（未任命为 null）：赛程页据此显示「现任：某某」与撤销入口
    chiefJudge: meet.chiefJudge || null,
    items,
    canManage: isAdmin,
  });
}

/** 我的裁判任务：只返回指派给我的场次 */
async function getMyMeetJudgeTasks(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');
  const scope = scopeOf(ctx);

  const [sessions, assignments, events] = await Promise.all([
    listSessions(ctx.repo, ctx),
    // 只要「指派给我的」（2026-10-26 第五轮 B）：`listByJudge` 是现成的下推原语，
    // 原来读一届全部指派（场次 × 裁判数）再按 judgeId 过滤。
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.listByJudge(ctx.actorId),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));
  const mine = new Set(assignments
    .filter((doc) => doc.status === 'active' && doc.judgeId === ctx.actorId)
    .map((doc) => doc.sessionKey));

  const items = sessions
    .filter((doc) => mine.has(doc._id))
    .map((doc) => {
      const event = eventOf.get(doc.eventKey);
      return {
        ...sessionSummary(doc),
        name: event ? event.name : '',
        group: event ? event.group : '',
      };
    });

  return ok({ items });
}

/**
 * 可指派为裁判的本校成员（D59）。
 *
 * 页面不该让管理员手输 userId：那既容易错，也绕过了「在册」判断。
 * 这里只列本校在册且账号有效的成员，姓名一并给出。
 *
 * 【读法】（2026-10-29 第十一轮审计 P2-5）
 * 原先是「全校名册整表 + 每名成员一次 `users.getById`」，2000 人的学校就是
 * 2000 次点读，而 `offset` 切在全部读完之后——翻页一点也省不下来。改成
 * `users.listByIds`（每 100 一批）后是 20 次；学院目录走 `loadColleges` 的
 * 60 秒缓存（它是字典，业务代码零写入点）。`limit` 也从 payload 取并夹上限，
 * 不再写死 100 而把调用方的分页参数静默丢掉。
 */
async function listMeetJudgeCandidates(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以指派裁判');

  const keyword = String(payload.keyword || '').trim();
  const members = await ctx.repo.schoolMembers.listBySchool(ctx.schoolId);
  const active = members.filter((doc) => doc.status === SCHOOL_MEMBER_STATUS.ACTIVE);
  const users = active.length
    ? await ctx.repo.users.listByIds(active.map(member => member.userId))
    : [];
  const userById = new Map(users.map(user => [user._id, user]));
  const colleges = new Map((await loadColleges(ctx)).map(row => [row.collegeId, row]));
  const items = [];
  for (const member of active) {
    const user = userById.get(member.userId);
    if (!user || user.platformStatus !== 'active' || user.primarySchoolId !== ctx.schoolId) continue;
    // 账号上的姓名是 nickName / realName，不是 name。只读 name 会让所有人
    // 都显示「未命名」——管理员根本无从挑选。
    const realName = user.realName || '';
    const nickName = user.nickName || '';
    const name = realName || nickName || '未命名';
    const collegeId = member.collegeId || '';
    const college = colleges.get(collegeId);
    const haystack = `${name}${realName}${nickName}${collegeId}${(college && college.name) || ''}`;
    if (keyword && !haystack.includes(keyword)) continue;
    items.push({
      userId: member.userId, name, realName, nickName,
      collegeId, collegeName: (college && college.name) || '',
    });
  }
  items.sort((a, b) => String(a.collegeName).localeCompare(String(b.collegeName))
    || String(a.name).localeCompare(String(b.name)));
  const offset = Math.max(0, Math.trunc(Number(payload.offset) || 0));
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, JUDGE_CANDIDATE_MAX) : JUDGE_CANDIDATE_MAX;
  const page = items.slice(offset, offset + limit);
  return ok({ items: page, total: items.length, hasMore: offset + page.length < items.length,
    nextOffset: offset + page.length });
}

module.exports = {
  listMeetJudgeCandidates,
  assignMeetJudges,
  listMeetEventSessions,
  saveMeetSession,
  publishMeetSchedule,
  assignMeetJudge,
  removeMeetJudge,
  startMeetEvent,
  getMeetSchedule,
  getMyMeetJudgeTasks,
  SESSION_STATUS,
};
