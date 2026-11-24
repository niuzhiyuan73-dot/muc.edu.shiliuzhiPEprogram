const { parseMeetTime } = require('./meet-time.js');
/**
 * 运动会报名主链（B5）
 * ============================================================
 * 学生提交参赛意向 → 学院部长从申请人里选人 → 按项目组别提交正式名单 →
 * 校管理员审核生效。四条裁决贯穿全文件：
 *
 *   D10 双层：意向不是正式报名，绝不占正式名额；
 *   D14 只能从已提交意向的人里选（部长不能凭空加人）；
 *   D16 学院取学籍快照，提交时冻结，客户端传什么都不采信；
 *   D25 一旦本院本项目提交了正式名单，该院该项目的意向入口关闭。
 *
 * 【为什么每个提交都要占「预占」而不是「已用」】
 * D21 要求校级审核。若提交时不预占，两个学院（或同一学院的两次提交）可以
 * 同时越过上限，等审核时才发现超额。所以提交即 pending+1，通过时 pending-1
 * 且 used+1，驳回/撤回只回退 pending。上限判断看 used+pending。
 *
 * 【为什么兼项要一份计数文档】
 * 云开发事务内不能查询，「这个人已经报了几个个人项目」无法用集合扫描回答。
 * 于是每人每届一份计数文档（在 claims 集合里以 kind='counter' 区分），
 * 提交时点读、写入时递增，并发提交会撞在同一份文档上，天然串行。
 *
 * 【为什么整院提交不是一次事务】
 * 一个学院可能报 120 个项目组别，单事务写不完（仓内预算 200 写）。
 * 本模块**按项目组别**提交：一次调用只写一个项目组别的一条名单，
 * 页面负责逐项调用并把失败项列出来——不做「整批要么全成」的假承诺。
 * ============================================================
 */

const {
  MEET_STATUS, MEET_INTEREST_STATUS, MEET_ENTRY_STATUS, MEET_ENTRY_MAX_MEMBERS,
  meetEventKey, meetInterestKey, meetEntryKey, meetQuotaKey, meetClaimKey,
  meetParticipantCounterKey, meetCollegeKey, listAliveEvents, meetEntrySlot,
} = require('../../shared/utils/meet-scope.js');
const { schoolMemberKey, collegeKey, SCHOOL_MEMBER_STATUS } = require('../../shared/utils/school.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const {
  meetReadable, canManageMeet, canLeadCollegeMeet, isActiveMeetLead,
} = require('./meet-permission.js');
const { meetCollegeLeadKey } = require('../../shared/utils/meet-scope.js');
const { countsTowardPersonalQuota } = require('../../shared/services/meet-measure.js');

// DTO 补 ok:true，与其余三域同形（见 meet-service.js 的说明）。
const ok = (data) => ({ ok: true, data: { ...data, ok: data.ok === undefined ? true : data.ok } });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 4.2 默认：个人项目每人最多 2 项（D35），团体与接力不计入 */
const PERSONAL_LIMIT = 2;

/**
 * 单条正式名单的人数上限 —— 数字本身在 `utils/meet-scope.js`，与
 * `meet-service.js` 配置侧共用一处（见那里的说明）。
 *
 * 【为什么必须有上限】（2026-10-22 第二轮审查 B-1）
 * 云数据库事务的操作预算约 100（`cloud-repo.js` 的 TX_OPERATION_BUDGET）。
 * 原实现在**事务内**按人做身份校验 + 声明 + 计数 + 意向四处读写：每人约 9 个
 * 操作，固定开销 ≈ 14，于是 `100 - 14` 只够 **9~10 人**。而配置侧允许把团体
 * 项目配到 200 人、模板里「入场式展示」默认就是 20 人 —— 管理员照默认值配一个
 * 20 人项目，学院部长点提交只会看到「事务读写总操作预算不足：请缩小本次处理
 * 范围」，这句话是给开发者看的，部长无从下手。
 *
 * 【现在为什么能到 20】（同批改动）
 * 把按人的三次点读（学籍 / 账号 / 意向）搬到事务外一次性取齐，事务内每人只剩
 * 2 个操作（声明读 + 声明写）；`team` 计数不再写（它只写不读，见写入循环的
 * 说明）；意向改「已选入」放到主事务之后独立提交。20 人 = 40 + 固定 19 ≈ 59
 * 个操作，留足余量。
 */

/**
 * 报名序号探测的最大次数。
 *
 * 撤回 / 驳回只改状态、不释放 `_id`（`releaseEntry`），所以连续号段可能被历史
 * 名单占满。原实现是 `while (await getById(key))` 无上限，占满时会一路探测到
 * 事务预算耗尽，最终报「事务读写总操作预算不足」——把"序号排满"这个真实原因
 * 完全掩盖掉（2026-10-22 第二轮审查 B-2）。
 */
const SLOT_PROBE_MAX = 50;

/**
 * 申请人池一次最多返回多少人。
 *
 * 这个页面是"学院部长从申请人里挑人"的选人器，一屏最多也就看几十个；
 * 而报名人数没有上限（同一学院可以给一个项目报几百人）。不封顶时，
 * 一次列表要把所有人的学籍与账号都读出来才凑得出一张表
 * （2026-10-22 第二轮审查 P-5）。
 */
const APPLICANT_POOL_MAX = 500;

const { touchEvent } = require('./meet-consistency.js');

const isActiveInterest = (doc) => Boolean(doc && doc.status === MEET_INTEREST_STATUS.PENDING);
/**
 * 可以进入正式名单的意向：待选拔，或已经被选入（后者用于给出「已报名」这种准确提示，
 * 而不是把它误报成「没交过意向」）。
 */
const isPendingOrSelected = (doc) => Boolean(doc && (
  doc.status === MEET_INTEREST_STATUS.PENDING || doc.status === MEET_INTEREST_STATUS.SELECTED));
const isLiveEntry = (doc) => Boolean(doc && (
  doc.status === MEET_ENTRY_STATUS.PENDING_REVIEW || doc.status === MEET_ENTRY_STATUS.APPROVED));

function toIso(now) {
  return now instanceof Date ? now.toISOString() : String(now);
}

/**
 * 此刻允许报名吗？
 * 正常窗口：meet.status=registration 且 now 落在 registration 区间内。
 * 补报窗口（D27）：校管理员开的 lateWindow 覆盖同一判断，仍由部长提交。
 */
function registrationWindow(meet, now) {
  if (!meet || ['deleted', 'finished', 'draft'].includes(meet.status)) return { open: false, late: false };
  const at = now instanceof Date ? now.getTime() : parseMeetTime(now);
  const within = (window) => {
    if (!window || !window.openAt || !window.closeAt) return false;
    const open = parseMeetTime(window.openAt);
    const close = parseMeetTime(window.closeAt);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
    return at >= open && at <= close;
  };
  if (within(meet.lateWindow)) return { open: true, late: true };
  if (meet.status !== MEET_STATUS.REGISTRATION) return { open: false, late: false };
  return { open: within(meet.registration), late: false };
}

/** 该学院在本次项目组别上的额度（缺省视为 0/0） */
async function quotaOf(tx, meetId, eventKey, collegeId) {
  const doc = await tx.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, collegeId));
  return { used: Number((doc && doc.used) || 0), pending: Number((doc && doc.pending) || 0), doc };
}

/** 兼项计数（每人每届一份） */
async function counterOf(tx, meetId, userId) {
  const doc = await tx.sportsMeetParticipantClaims.getById(meetParticipantCounterKey(meetId, userId));
  return { personal: Number((doc && doc.personal) || 0), team: Number((doc && doc.team) || 0), doc };
}

/** 取学院部长（用于判定操作者能管哪个学院） */
async function leadOf(ctx, collegeId) {
  if (!collegeId) return null;
  return ctx.repo.sportsMeetCollegeLeads.getById(meetCollegeLeadKey(ctx.schoolId, collegeId));
}

/** 当前操作者在某届运动会里负责的学院：部长取授权学院，管理员可代报指定学院（D13）。 */
async function resolveCollege(ctx, payload) {
  const member = ctx.schoolMember;
  const ownCollege = member && member.collegeId ? member.collegeId : '';
  if (ownCollege) {
    const lead = await leadOf(ctx, ownCollege);
    if (isActiveMeetLead(lead) && lead.userId === ctx.actorId) {
      return { ok: true, collegeId: ownCollege, byAdmin: false };
    }
  }
  if (canManageMeet(ctx)) {
    const target = String(payload.collegeId || '').trim();
    if (!target) return { ok: false, message: '请指定要代报的学院' };
    return { ok: true, collegeId: target, byAdmin: true };
  }
  return { ok: false, message: '只有学院部长可以提交正式报名' };
}

/** 项目组别文档：必须属于本届 */
async function loadEvent(tx, ctx, eventKey) {
  const key = String(eventKey || '').trim();
  if (!key) return { ok: false, message: '请选择项目组别' };
  const doc = await tx.sportsMeetEvents.getById(key);
  if (!doc || doc.meetId !== ctx.meetId || doc.schoolId !== ctx.schoolId) {
    return { ok: false, message: '项目组别不存在或不属于本届运动会' };
  }
  return { ok: true, doc };
}

/**
 * 落下「本届学院范围」的一行（D82）。
 *
 * 【为什么报名动作要顺带写这个】
 * 决策文档 §8 把 sportsMeetColleges 定义为「本届学院范围及当届名称快照」，
 * 用来做两件事：总榜按参与范围展示（报了名就算参与，未得分显示 0），
 * 以及列表页按学院筛选。B9 整体验收时发现**没有任何服务写这个集合**——
 * 总榜因此只会显示原始学院编号，学院筛选也永远筛不出东西。
 *
 * 【为什么学院名要快照】
 * 学院改名不应让历史榜单跟着漂移（12.4）。所以这里存的是写入那一刻的
 * 学院名，之后 colleges 里怎么改都不影响已产生的榜单。
 *
 * 幂等：同一学院第二次报名不重写（保留首次快照时间）。
 */
async function touchCollegeScope(tx, { schoolId, meetId, collegeId, now }) {
  if (!collegeId) return;
  const key = meetCollegeKey(meetId, collegeId);
  const current = await tx.sportsMeetColleges.getById(key);
  if (current && current.schoolId === schoolId) return;
  const college = await tx.colleges.getById(collegeKey(schoolId, collegeId));
  await tx.sportsMeetColleges.set(key, {
    schoolId, meetId, collegeId,
    name: (college && college.name) || collegeId,
    at: now,
  });
}

/**
 * 事务外的候选人快照：按人取齐学籍、账号、意向。
 *
 * 【为什么要搬到事务外】（2026-10-22 第二轮审查 B-1）
 * 事务里每一次 `set` 都要先读归属（`school-repository.js` 的 buildScoped），
 * 所以"每人 3 次身份点读"其实是把事务预算直接吃掉 3/N。搬到事务外以后，
 * 事务内只留「声明占用」这一处真正需要原子性的判断（并发重复报名的唯一竞态）。
 *
 * 【为什么不改成「每人 3 次」以外的形态】（2026-10-26 第五轮审查 E）
 * 原注释写的是「受范围仓储没有 listByIds，只能点读」——账号与意向这两个前提已经
 * 不成立了，本轮改成批读：账号一次 `_.in`，意向按项目一次查询（`listByProject`）。
 * **学籍仍按人点读**：运动会上下文没有 association，`forScope` 进不去（schoolScope
 * 要求学校 + 协会），而顶层 `schoolMembers` 只有按校整表读的 `listBySchool`。
 * 换句话说，缺的是「学校级、按编号批读」的入口；补它要动仓储分层，留给运动会
 * 读放大专项（第五轮 B）一起做，不在本轮顺手加。
 *
 * 于是每次提交的读次数从 3N 降到 N + 2（N ≤ MEET_ENTRY_MAX_MEMBERS = 20）。
 *
 * @param {Object} ctx
 * @param {string} eventKey 项目组别编号
 * @param {Array<string>} userIds
 * @returns {Promise<Map<string,{userId:string,member:Object|null,user:Object|null,interest:Object|null}>>}
 */
async function candidateSnapshotOf(ctx, eventKey, userIds) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
    .filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return new Map();
  const [users, interests, members] = await Promise.all([
    ctx.repo.users.listByIds(ids),
    ctx.repo.forMeet({ schoolId: ctx.schoolId, meetId: ctx.meetId }).sportsMeetInterests.listByProject(eventKey),
    Promise.all(ids.map((userId) => ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)))),
  ]);
  const memberById = new Map(members.filter(Boolean).map((row) => [row.userId, row]));
  const userById = new Map(users.map((row) => [row._id, row]));
  const wanted = new Set(ids);
  const interestById = new Map();
  for (const row of interests) {
    if (row && wanted.has(row.userId)) interestById.set(row.userId, row);
  }
  return new Map(ids.map((userId) => [userId, {
    userId,
    member: memberById.get(userId) || null,
    user: userById.get(userId) || null,
    interest: interestById.get(userId) || null,
  }]));
}

/**
 * 把入选者的意向标成「已选入」。
 *
 * 【为什么独立成事务，而不是并进提交名单那一个】
 * 意向状态是**展示态**：名额占用靠 entry / quota，重复报名靠 claim，两者都在
 * 主事务里；意向只是让申请人池不再把这个人列成「待选」。为这个人多付 2 个
 * 事务操作会直接把 20 人名单顶出预算，所以拆到主事务之后，按 20 人一批提交。
 *
 * 【失败为什么不回滚】
 * 名单已经落库（claim 已占），此时因为"展示态没写上"就把整次提交判失败，
 * 会让部长重试时撞上「已在本项目报名」——比脏一个展示字段难解释得多。
 * 因此这里吞掉错误，只让申请人池多显示一条待选。
 *
 * @param {Object} ctx
 * @param {string} eventKey
 * @param {Array<string>} userIds
 * @param {string} entryKey 名单主键，用于回填到意向文档
 * @param {string} nowIso 写入时间（与主事务同一个 `now`，避免两处时间不一致）
 * @returns {Promise<void>}
 */
async function markInterestsSelected(ctx, eventKey, userIds, entryKey, nowIso) {
  const CHUNK = 20;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    await ctx.repo.transaction(async (tx) => {
      const pending = [];
      for (const userId of chunk) {
        const key = meetInterestKey(ctx.meetId, eventKey, userId);
        const interest = await tx.sportsMeetInterests.getById(key);
        if (!interest) continue;
        if (interest.status === MEET_INTEREST_STATUS.SELECTED && interest.entryKey === entryKey) continue;
        pending.push({ key, interest });
      }
      for (const { key, interest } of pending) {
        await tx.sportsMeetInterests.set(key, {
          ...interest, status: MEET_INTEREST_STATUS.SELECTED, entryKey, updatedAt: nowIso,
        });
      }
      return null;
    });
  }
}

/**
 * 把撤回/驳回名单里的成员意向落回「待选拔」。
 *
 * 【为什么也独立成事务】（2026-11-23 第 23 轮复验）
 * 20 人「多人协作组」在释放名单时，主事务已要读写额度、声明与兼项计数；
 * 再把 20 条意向的读与写塞进去，总数正好越过 100 次预算（读 49 / 写 52）。
 * 意向是**展示态**：名额、声明与计数才是权威事实。按提交侧同一套做法，
 * 拆到主事务之后按 20 人一批提交，主事务回落到约 60 次。
 *
 * 【失败为什么不回滚】
 * 名单已经撤回/驳回并已释放名额；此时把整次操作判失败，会让部长无法重试
 * （名单已不是待审/待撤状态）。失败只影响申请人池的展示，学生重新点一次
 * 「提交意向」即可把这条旧意向覆盖回待选拔。
 */
async function markInterestsPending(ctx, eventKey, userIds, nowIso) {
  const CHUNK = 20;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    await ctx.repo.transaction(async (tx) => {
      const pending = [];
      for (const userId of chunk) {
        const key = meetInterestKey(ctx.meetId, eventKey, userId);
        const interest = await tx.sportsMeetInterests.getById(key);
        if (!interest) continue;
        if (interest.status === MEET_INTEREST_STATUS.PENDING && !interest.entryKey) continue;
        pending.push({ key, interest });
      }
      for (const { key, interest } of pending) {
        // 驳回/撤回落回「待选拔」，该院该项目的意向入口随之重新打开（B5）
        await tx.sportsMeetInterests.set(key, {
          ...interest, status: MEET_INTEREST_STATUS.PENDING, entryKey: '', updatedAt: nowIso,
        });
      }
      return null;
    });
  }
}

// ---------------------------------------------------------------- 学生端

/** 学生提交参赛意向（不占名额，D10） */
async function submitMeetInterest(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  if (!ctx.meetId) return refused('请指定运动会');
  if (!ctx.actorId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.schoolId !== fresh.schoolId || meet.status === MEET_STATUS.DELETED) {
      return refused('运动会不存在或已删除');
    }
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    const event = await loadEvent(tx, fresh, payload.eventKey);
    if (!event.ok) return refused(event.message);
    // 抽签之后不再收新意向：正式名单已提交不了，收进来只会堆一批永远处理不了的记录
    if (event.doc.heatDraw || event.doc.bracket) return refused('该项目已经抽签，报名已截止');

    // D17：没有本院学籍不能报名
    const member = fresh.schoolMember;
    if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE || !member.collegeId) {
      return refused('请先完善学院归属后再报名');
    }

    // D25：本院本项目已提交正式名单后，意向入口关闭
    const quota = await quotaOf(tx, fresh.meetId, event.doc._id, member.collegeId);
    if (quota.used + quota.pending > 0) return refused('本院该项目已提交正式名单，不能再提交意向');

    const key = meetInterestKey(fresh.meetId, event.doc._id, fresh.actorId);
    const current = await tx.sportsMeetInterests.getById(key);
    if (isActiveInterest(current)) {
      return ok({ interest: current, created: false }); // 重复提交幂等
    }

    const now = toIso(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey: event.doc._id,
      userId: fresh.actorId,
      collegeId: member.collegeId, // D16：提交时冻结学院
      status: MEET_INTEREST_STATUS.PENDING,
      createdAt: current ? (current.createdAt || now) : now,
      updatedAt: now,
    };
    await tx.sportsMeetInterests.set(key, doc);
    // D82：只要报名了一个人就算参与——本届学院范围从这里落下第一行
    await touchCollegeScope(tx, {
      schoolId: fresh.schoolId, meetId: fresh.meetId, collegeId: member.collegeId, now,
    });
    return ok({ interest: doc, created: true });
  });
}

/** 学生撤回意向（D19：正式入选前可撤回） */
async function withdrawMeetInterest(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  if (!ctx.meetId || !ctx.actorId) return refused('请指定运动会');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!meetReadable(fresh) || !fresh.actorId) return refused('请先登录');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.schoolId !== fresh.schoolId || meet.status === MEET_STATUS.DELETED) {
      return refused('运动会不存在或已删除');
    }
    if (meet.status === MEET_STATUS.FINISHED || meet.status === MEET_STATUS.ARCHIVED) {
      return refused('运动会已结束');
    }

    const event = await loadEvent(tx, fresh, payload.eventKey);
    if (!event.ok) return refused(event.message);

    const key = meetInterestKey(fresh.meetId, event.doc._id, fresh.actorId);
    const current = await tx.sportsMeetInterests.getById(key);
    // 先判「已入选」：这类意向状态是 selected，若先判 pending 会误报成「没有意向」
    if (current && current.entryKey) return refused('已被选入正式名单，请联系学院部长');
    if (!isActiveInterest(current)) return refused('没有可撤回的参赛意向');

    await tx.sportsMeetInterests.set(key, {
      ...current, status: MEET_INTEREST_STATUS.WITHDRAWN, updatedAt: toIso(fresh.now),
    });
    return ok({ eventKey: event.doc._id });
  });
}

/** 我的参与情况：意向状态 + 正式名单状态（页面区分「待选拔/已入选/已报名」） */
async function getMyMeetParticipation(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');

  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };
  const scoped = ctx.repo.forMeet(scope);
  // 按人下推（2026-10-23 第三轮 X-9）：一届的意向与名单是「项目 × 学院 × 名额」，
  // 报名旺季数千条 = 30~50 页 RPC，而这一页只显示本人的那几条。
  //
  // 取回后**不再**按 userId 复筛：这一层若还留着过滤，原语写错（比如漏掉 meetId）
  // 就会被它悄悄盖住，测试也就照不出来。
  const [interests, entries, events] = await Promise.all([
    scoped.sportsMeetInterests.listByUser(ctx.actorId),
    scoped.sportsMeetEntries.listByUser(ctx.actorId),
    listAliveEvents(scoped.sportsMeetEvents),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));
  const describe = (eventKey) => {
    const event = eventOf.get(eventKey);
    return event ? { name: event.name, group: event.group } : { name: '', group: '' };
  };

  const mine = interests.map((doc) => ({
    eventKey: doc.eventKey,
    ...describe(doc.eventKey),
    status: doc.status,
    collegeId: doc.collegeId,
  }));

  const joined = entries
    .filter((doc) => doc.status !== MEET_ENTRY_STATUS.WITHDRAWN)
    .map((doc) => ({
      entryKey: doc._id,
      eventKey: doc.eventKey,
      ...describe(doc.eventKey),
      status: doc.status,
      collegeId: doc.collegeId,
    }));

  return ok({ interests: mine, entries: joined });
}

// ---------------------------------------------------------------- 学院端

/**
 * 学院报名工作台：每个项目组别的「已报 / 上限 / 待审 / 意向人数」。
 * 只给部长或管理员；学生看不到别院进度。
 */
async function listMeetCollegeEvents(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const resolved = await resolveCollege(ctx, payload);
  if (!resolved.ok) return refused(resolved.message);
  const collegeId = resolved.collegeId;

  const [events, entries, interests] = await Promise.all([
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetInterests.list(),
  ]);

  const rows = events.map((event) => {
    const mine = entries.filter((row) => row.eventKey === event._id
      && row.collegeId === collegeId && row.status !== MEET_ENTRY_STATUS.WITHDRAWN);
    const applicants = interests.filter((doc) => doc.eventKey === event._id
      && doc.collegeId === collegeId && isActiveInterest(doc));
    return {
      eventKey: event._id,
      name: event.name,
      group: event.group,
      entryForm: event.entryForm,
      members: event.members,
      limit: event.perCollegeLimit,
      used: mine.filter((row) => row.status === MEET_ENTRY_STATUS.APPROVED).length,
      pending: mine.filter((row) => row.status === MEET_ENTRY_STATUS.PENDING_REVIEW).length,
      applicants: applicants.length,
      closed: mine.length > 0,
      scored: event.scored,
    };
  });

  return ok({ collegeId, byAdmin: resolved.byAdmin, items: rows });
}

/** 某项目组别的申请人（D14：只能从这里选人） */
async function getMeetApplicantPool(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const event = await loadEvent(ctx.repo.forMeet(scope), ctx, payload.eventKey);
  if (!event.ok) return refused(event.message);

  const resolved = await resolveCollege(ctx, payload);
  if (!resolved.ok) return refused(resolved.message);

  // 只取本项目的意向（2026-10-26 第五轮 B）：报名旺季一届意向数千条，
  // 而这里只要「本项目、本院、还有效」的那几条。
  const interests = (await ctx.repo.forMeet(scope).sportsMeetInterests.listByProject(event.doc._id))
    .filter((doc) => doc.collegeId === resolved.collegeId && isActiveInterest(doc))
    .slice(0, APPLICANT_POOL_MAX);

  // 【为什么不再逐人点读两次】（2026-10-22 第二轮审查 P-5）
  // 原实现 `Promise.all(interests.map(async ...))` 里每人两次 `getById`：
  // 热门项目（800 米、入场式）一个学院几百人报名就是上千次点读，`Promise.all`
  // 只是并发、不减少总量，读配额照付。
  // 现在：本院在册名单**一次范围读**（`listBySchool`），账号按这批人**批读**
  // （`users.listByIds`，每 100 个一批）。2000 人的学校从 2N 次降到约 25 次。
  const userIds = interests.map((doc) => doc.userId);
  const [roster, userRows] = await Promise.all([
    ctx.repo.schoolMembers.listBySchool(ctx.schoolId),
    userIds.length > 0 ? ctx.repo.users.listByIds(userIds) : [],
  ]);
  const memberByUser = new Map(roster.map((row) => [row.userId, row]));
  const userById = new Map(userRows.map((user) => [user._id, user]));

  const members = interests.map((doc) => {
    const user = userById.get(doc.userId);
    const member = memberByUser.get(doc.userId);
    return {
      userId: doc.userId,
      // 账号姓名在 nickName / realName 上；只读 name 会让整张申请人池都是「未命名」
      name: (user && (user.realName || user.nickName || user.name)) || '未命名',
      gender: (member && member.gender) || '',
    };
  });

  return ok({ collegeId: resolved.collegeId, event: { eventKey: event.doc._id, name: event.doc.name, group: event.doc.group, members: event.doc.members, entryForm: event.doc.entryForm }, items: members });
}

/**
 * 提交一条正式名单（一个项目组别一条）。
 *
 * 入参：`{ eventKey, userIds, collegeId? }`。collegeId 仅管理员代报时使用（D13）。
 */
async function submitMeetCollegeEntry(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const userIds = Array.isArray(payload.userIds) ? payload.userIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (userIds.length === 0) return refused('请选择参赛学生');
  if (new Set(userIds).size !== userIds.length) return refused('同一名学生不能重复选择');
  // 人数上限放在最前：它是配置层面的硬边界，先于任何一次数据库读就拒掉，
  // 免得"注定失败"的请求先花掉 3×N 次点读（见 MEET_ENTRY_MAX_MEMBERS）。
  if (userIds.length > MEET_ENTRY_MAX_MEMBERS) {
    return refused(`单条名单最多 ${MEET_ENTRY_MAX_MEMBERS} 人，当前 ${userIds.length} 人：请拆成多条提交，或让各学院分别报名`);
  }

  // 【判权在取数之前】（2026-10-23 第三轮审查 X-5）
  // 下面要按人做候选人快照（每人 3 次读，上限 20 人 ≈ 60 次），而「你是不是这个
  // 学院的部长」只依赖上下文与一条学院部长授权记录。原来这道判断放在事务里，
  // 等于任何登录账号都能先用 60 次读换一句「只有学院部长可以提交正式报名」。
  // 事务内仍会用 fresh 再判一次——这里只是提前拦掉注定失败的请求。
  const earlyCollege = await resolveCollege(ctx, payload);
  if (!earlyCollege.ok) return refused(earlyCollege.message);

  // 事务外先解析项目组别，只为拿到 eventKey 去拼意向主键；事务内还会再读一次，
  // 那一遍才是权威的「是否已抽签」判据。
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };
  const preEvent = await loadEvent(ctx.repo.forMeet(scope), ctx, payload.eventKey);
  if (!preEvent.ok) return refused(preEvent.message);
  // 按人的学籍 / 账号 / 意向一次性取齐（见 candidateSnapshotOf 的说明）。
  const snapshot = await candidateSnapshotOf(ctx, preEvent.doc._id, userIds);

  // 事务内的写入时间，供事务后的意向回写复用（两处时间必须一致）
  let writtenAt = '';
  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.schoolId !== fresh.schoolId || meet.status === MEET_STATUS.DELETED) {
      return refused('运动会不存在或已删除');
    }
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    const event = await loadEvent(tx, fresh, payload.eventKey);
    if (!event.ok) return refused(event.message);

    if (event.doc.heatDraw || event.doc.bracket) return refused('该项目已经抽签，请在抽签前完成正式报名');
    const resolved = await resolveCollege(fresh, payload);
    if (!resolved.ok) return refused(resolved.message);
    const collegeId = resolved.collegeId;

    // 人数：单人 1 人；多人协作组/队伍必须与创建时设定的人数一致（D39，无替补 D40）。
    // members = 0 表示「人数不限」（入场式展示这类项目），此时只要求至少 1 人。
    const expected = event.doc.entryForm === 'single' ? 1 : Number(event.doc.members || 0);
    if (expected > 0 && userIds.length !== expected) {
      return refused(`该项目每组需 ${expected} 人，当前选了 ${userIds.length} 人`);
    }

    // 成员资格：必须本学院在册，且提交过意向（D14／D16）。
    // 学籍 / 账号 / 意向取自事务外的快照（省事务预算），**声明（claim）仍在事务内
    // 点读**——它才是"同一项目组别只能报一次"的并发竞态防线，必须原子。
    for (const userId of userIds) {
      const row = snapshot.get(userId) || {};
      if (!row.member || row.member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) {
        return refused('名单包含非本校在册学生');
      }
      if (!row.user || row.user.platformStatus !== 'active' || row.user.primarySchoolId !== fresh.schoolId) return refused('名单包含账号已停用或已转校的学生');
      if (row.member.collegeId !== collegeId) return refused('名单包含其他学院的学生');
      // D37：同一项目组别只报一次。先判重、再判意向——否则重复提交会被
      // 「未提交意向」误导（入选后意向状态已变成 selected）。
      const claim = await tx.sportsMeetParticipantClaims.getById(meetClaimKey(fresh.meetId, event.doc._id, userId));
      if (claim && claim.status === 'active') return refused('名单中有学生已在本项目报名');
      if (!isPendingOrSelected(row.interest)) return refused('名单中有学生未提交参赛意向，不能直接选入');
    }

    // 额度（D29／D32）：used + pending 不能达到上限。
    // perCollegeLimit = 0 表示「不限」，跳过额度判断（展示类项目常常不限队数）。
    const quota = await quotaOf(tx, fresh.meetId, event.doc._id, collegeId);
    const cap = Number(event.doc.perCollegeLimit || 0);
    if (cap > 0 && quota.used + quota.pending >= cap) {
      return refused('本院该项目名额已满');
    }

    // 兼项（D35）：个人项与多人协作组计入个人额度，团体/接力不计
    const countsPersonal = countsTowardPersonalQuota(event.doc.entryForm);
    if (countsPersonal) {
      for (const userId of userIds) {
        const counter = await counterOf(tx, fresh.meetId, userId);
        if (counter.personal >= PERSONAL_LIMIT) return refused(`名单中有学生已达到个人项目 ${PERSONAL_LIMIT} 项上限`);
      }
    }

    let serial = Math.max(Number(quota.doc && quota.doc.lastSlot || 0), quota.used + quota.pending) + 1;
    let slot = meetEntrySlot(event.doc.entryForm, serial);
    let key = meetEntryKey(fresh.meetId, event.doc._id, collegeId, slot);
    // 序号探测必须有上限：撤回 / 驳回只改状态、不释放 _id，连续被占用的号段
    // 会让这个循环一路探测到事务预算耗尽，报错却是「预算不足」而非真实原因。
    for (let probes = 0; await tx.sportsMeetEntries.getById(key); probes += 1) {
      if (probes >= SLOT_PROBE_MAX) {
        return refused(`本院该项目报名序号已排满（连续 ${SLOT_PROBE_MAX} 个），请联系管理员处理`);
      }
      serial += 1;
      slot = meetEntrySlot(event.doc.entryForm, serial);
      key = meetEntryKey(fresh.meetId, event.doc._id, collegeId, slot);
    }
    const now = toIso(fresh.now);

    const entry = {
      _id: key, // 与主键一致：返回值要能直接拿去审核/撤回，而不是让页面再猜
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey: event.doc._id,
      collegeId,
      slot,
      userIds,
      members: userIds.length,
      status: MEET_ENTRY_STATUS.PENDING_REVIEW,
      submittedBy: fresh.actorId,
      submittedByAdmin: resolved.byAdmin,
      submittedAt: now,
      reviewedBy: '',
      reviewedAt: '',
      rejectReason: '',
      updatedAt: now,
    };
    const counters = new Map();
    if (countsPersonal) {
      for (const userId of userIds) {
        counters.set(userId, await counterOf(tx, fresh.meetId, userId));
      }
    }
    await touchEvent(tx, event.doc._id);
    await tx.sportsMeetEntries.set(key, entry);
    await tx.sportsMeetQuotaUsage.set(meetQuotaKey(fresh.meetId, event.doc._id, collegeId), {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: event.doc._id, collegeId,
      used: quota.used, pending: quota.pending + 1, lastSlot: serial, updatedAt: now,
    });

    for (const userId of userIds) {
      // 上一步的资格循环已经点读过同一个 key，事务读缓存命中，这里只计一次写。
      await tx.sportsMeetParticipantClaims.set(meetClaimKey(fresh.meetId, event.doc._id, userId), {
        kind: 'claim',
        schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: event.doc._id,
        userId, entryKey: key, collegeId, status: 'active', updatedAt: now,
      });
      // 兼项计数只对「计入个人额度」的项目组别维护。
      // 【为什么团体项不再写 team 计数】`team` 这个数**从未被任何地方读取**
      // （只有 personal 参与 PERSONAL_LIMIT 判定），却是每人 2 个事务操作，
      // 正好把 10~20 人的团体名单顶出预算。团体人数看 entry.userIds 即可。
      if (countsPersonal) {
        const counter = counters.get(userId);
        await tx.sportsMeetParticipantClaims.set(meetParticipantCounterKey(fresh.meetId, userId), {
          kind: 'counter',
          schoolId: fresh.schoolId, meetId: fresh.meetId, userId,
          personal: counter.personal + 1,
          team: counter.team,
          updatedAt: now,
        });
      }
    }

    // 正式名单也要落学院范围：代报路径下部长可能没交过意向，
    // 只靠意向 Hook 会漏掉「第一个动作就是提交名单」的学院。
    await touchCollegeScope(tx, {
      schoolId: fresh.schoolId, meetId: fresh.meetId, collegeId, now,
    });

    writtenAt = now;
    return ok({ entry, collegeId, byAdmin: resolved.byAdmin });
  });

  // 意向转「已选入」：展示态，独立事务、失败不回滚（见 markInterestsSelected）。
  if (result && result.ok && result.data && result.data.entry) {
    const applied = result.data;
    try {
      await markInterestsSelected(ctx, applied.entry.eventKey, userIds, applied.entry._id, writtenAt);
    } catch (err) {
      // 有意忽略：claim 已占用，名单事实成立；意向状态只影响申请人池的展示。
      console.warn('[meet] 意向状态回写失败', err && (err.message || err));
    }
    return ok({ entry: applied.entry, collegeId: applied.collegeId, byAdmin: applied.byAdmin });
  }
  return result;
}

/** 撤回/取消一条名单（截止前部长可改，D26；截止后需管理员窗口，D27） */
async function withdrawMeetCollegeEntry(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');

  let released = null;
  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const key = String(payload.entryKey || '').trim();
    if (!key) return refused('请指定要撤回的名单');
    const entry = await tx.sportsMeetEntries.getById(key);
    if (!entry || entry.meetId !== fresh.meetId || entry.schoolId !== fresh.schoolId) {
      return refused('名单不存在或不属于本届运动会');
    }
    if (!isLiveEntry(entry)) return refused('该名单已撤回或驳回');

    // 抽签之后正式名单已进入赛程，撤回会让签表与名单脱节；与提交侧同一道闸。
    const event = await tx.sportsMeetEvents.getById(entry.eventKey);
    if (event && (event.heatDraw || event.bracket)) return refused('该项目已抽签，名单不能再撤回');

    const resolved = await resolveCollege(fresh, { collegeId: entry.collegeId });
    if (!resolved.ok) return refused(resolved.message);
    if (resolved.collegeId !== entry.collegeId) return refused('只能撤回本学院的名单');

    const meet = await tx.sportsMeets.getById(fresh.meetId);
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    released = { eventKey: entry.eventKey, userIds: Array.isArray(entry.userIds) ? [...entry.userIds] : [] };
    await releaseEntry(tx, fresh, entry, MEET_ENTRY_STATUS.WITHDRAWN);
    return ok({ entryKey: key });
  });
  if (released && result && result.ok) {
    try {
      await markInterestsPending(ctx, released.eventKey, released.userIds, toIso(ctx.now));
    } catch (err) {
      // 名单与名额已释放；意向只是申请人池的展示态，失败不回滚（见 markInterestsPending）
      console.warn('[meet] 意向状态回写失败', err && (err.message || err));
    }
  }
  return result;
}

/**
 * 释放一条名单占用的额度、声明与兼项计数。
 * 撤回与驳回共用一份逻辑：两处各写一遍必然漏掉其中一项（最常见是漏减 personal）。
 *
 * 【意向状态不在这里写】（2026-11-23 第 23 轮复验）
 * 20 人「多人协作组」逐人读写意向会让本事务越过 100 次预算；意向是展示态，
 * 由调用方在主事务提交后走 `markInterestsPending` 分批回写。这里的额度、
 * 声明与计数仍是原子事实。
 */
async function releaseEntry(tx, ctx, entry, nextStatus) {
  const userIds = entry.userIds || [];
  const quota = await quotaOf(tx, ctx.meetId, entry.eventKey, entry.collegeId);
  const event = await tx.sportsMeetEvents.getById(entry.eventKey);
  const personal = event ? countsTowardPersonalQuota(event.entryForm) : true;
  const counters = new Map();
  if (personal) {
    for (const userId of userIds) counters.set(userId, await counterOf(tx, ctx.meetId, userId));
  }

  await touchEvent(tx, entry.eventKey);
  const now = toIso(ctx.now);
  await tx.sportsMeetEntries.set(entry._id, {
    ...entry, status: nextStatus, updatedAt: now,
  });

  const wasApproved = entry.status === MEET_ENTRY_STATUS.APPROVED;
  await tx.sportsMeetQuotaUsage.set(meetQuotaKey(ctx.meetId, entry.eventKey, entry.collegeId), {
    schoolId: ctx.schoolId, meetId: ctx.meetId, eventKey: entry.eventKey, collegeId: entry.collegeId,
    lastSlot: Number(quota.doc && quota.doc.lastSlot || 0),
    used: Math.max(0, quota.used - (wasApproved ? 1 : 0)),
    pending: Math.max(0, quota.pending - (wasApproved ? 0 : 1)),
    updatedAt: now,
  });

  for (const userId of userIds) {
    await tx.sportsMeetParticipantClaims.set(meetClaimKey(ctx.meetId, entry.eventKey, userId), {
      kind: 'claim', schoolId: ctx.schoolId, meetId: ctx.meetId, eventKey: entry.eventKey,
      userId, entryKey: entry._id, collegeId: entry.collegeId, status: 'released', updatedAt: now,
    });
    if (personal) {
      const counter = counters.get(userId);
      await tx.sportsMeetParticipantClaims.set(meetParticipantCounterKey(ctx.meetId, userId), {
        kind: 'counter', schoolId: ctx.schoolId, meetId: ctx.meetId, userId,
        personal: Math.max(0, counter.personal - 1),
        team: counter.team,
        updatedAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------- 管理员端

/** 审核：通过则 pending→used；驳回则释放（D21／D26／B5） */
async function reviewMeetEntry(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const decision = String(payload.decision || '');
  if (!['approve', 'reject'].includes(decision)) return refused('请选择通过或驳回');

  let released = null;
  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以审核名单');
    if (!fresh.meet || ['deleted','finished'].includes(fresh.meet.status)) return refused('运动会已结束或不存在，不能审核名单');

    const key = String(payload.entryKey || '').trim();
    const entry = await tx.sportsMeetEntries.getById(key);
    if (!entry || entry.meetId !== fresh.meetId || entry.schoolId !== fresh.schoolId) {
      return refused('名单不存在或不属于本届运动会');
    }
    if (entry.status !== MEET_ENTRY_STATUS.PENDING_REVIEW) return refused('该名单不在待审核状态');

    const now = toIso(fresh.now);
    if (decision === 'reject') {
      released = { eventKey: entry.eventKey, userIds: Array.isArray(entry.userIds) ? [...entry.userIds] : [] };
      await releaseEntry(tx, fresh, entry, MEET_ENTRY_STATUS.REJECTED);
      const rejected = await tx.sportsMeetEntries.getById(key);
      await tx.sportsMeetEntries.set(key, {
        ...rejected, rejectReason: String(payload.reason || '').slice(0, 100), reviewedBy: fresh.actorId, reviewedAt: now,
      });
      return ok({ entryKey: key, status: MEET_ENTRY_STATUS.REJECTED });
    }

    await touchEvent(tx, entry.eventKey);
    const quota = await quotaOf(tx, fresh.meetId, entry.eventKey, entry.collegeId);
    await tx.sportsMeetQuotaUsage.set(meetQuotaKey(fresh.meetId, entry.eventKey, entry.collegeId), {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: entry.eventKey, collegeId: entry.collegeId,
      lastSlot: Number(quota.doc && quota.doc.lastSlot || 0),
      used: quota.used + 1, pending: Math.max(0, quota.pending - 1), updatedAt: now,
    });
    await tx.sportsMeetEntries.set(key, {
      ...entry, status: MEET_ENTRY_STATUS.APPROVED, reviewedBy: fresh.actorId, reviewedAt: now, updatedAt: now,
    });
    return ok({ entryKey: key, status: MEET_ENTRY_STATUS.APPROVED });
  });
  if (released && result && result.ok) {
    try {
      await markInterestsPending(ctx, released.eventKey, released.userIds, toIso(ctx.now));
    } catch (err) {
      // 名单与名额已释放；意向只是申请人池的展示态，失败不回滚（见 markInterestsPending）
      console.warn('[meet] 意向状态回写失败', err && (err.message || err));
    }
  }
  return result;
}

/** 管理员开补报窗口（D27）：覆盖报名时间判断，仍由部长提交 */
async function openMeetLateWindow(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以开放补报');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.status === MEET_STATUS.DELETED) return refused('运动会不存在或已删除');
    if (meet.status === MEET_STATUS.DRAFT) return refused('运动会尚未发布报名，不能开放补报');
    if (meet.status === MEET_STATUS.FINISHED || meet.status === MEET_STATUS.ARCHIVED) {
      return refused('运动会已结束，不能开放补报');
    }

    const openAt = String(payload.openAt || '').trim();
    const closeAt = String(payload.closeAt || '').trim();
    if (!openAt || !closeAt) return refused('请填写补报窗口的开始与结束时间');
    if (!Number.isFinite(parseMeetTime(openAt)) || !Number.isFinite(parseMeetTime(closeAt))) return refused('请填写有效的补报开始与结束时间');
    if (parseMeetTime(closeAt) <= parseMeetTime(openAt)) return refused('补报结束必须晚于开始');

    const now = toIso(fresh.now);
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, lateWindow: { openAt, closeAt, openedBy: fresh.actorId, openedAt: now }, updatedAt: now,
    });
    return ok({ lateWindow: { openAt, closeAt } });
  });
}

/** 名单列表：管理员看全届进度；部长只看本院 */
async function listMeetEntries(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };
  const isAdmin = canManageMeet(ctx);
  if (!isAdmin) {
    const resolved = await resolveCollege(ctx, payload);
    if (!resolved.ok) return refused(resolved.message);
    payload = { ...payload, collegeId: resolved.collegeId };
  }
  const collegeId = isAdmin ? String(payload.collegeId || '').trim() : payload.collegeId;

  const [entries, events] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));

  const items = entries
    .filter((doc) => (collegeId ? doc.collegeId === collegeId : true))
    .filter((doc) => doc.status !== MEET_ENTRY_STATUS.WITHDRAWN)
    .map((doc) => {
      const event = eventOf.get(doc.eventKey);
      return {
        entryKey: doc._id,
        eventKey: doc.eventKey,
        name: event ? event.name : '',
        group: event ? event.group : '',
        collegeId: doc.collegeId,
        slot: doc.slot,
        userIds: doc.userIds,
        members: doc.members,
        status: doc.status,
        submittedByAdmin: Boolean(doc.submittedByAdmin),
        submittedAt: doc.submittedAt,
      };
    });

  // 名单可能上百条（一个学院一届的全部项目），按页返回并明确 hasMore，
  // 页面不必靠数组长度猜「是不是被截断了」。
  const total = items.length;
  const offset = Math.max(0, Number(payload.offset) || 0);
  // 默认 500 保持「一次能看全」的旧行为；超过时靠 hasMore 续读。
  const limit = Math.min(500, Math.max(1, Number(payload.limit) || 500));
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  return ok({ total, offset, limit, hasMore, nextOffset: hasMore ? offset + page.length : null, items: page });
}

module.exports = {
  registrationWindow,
  submitMeetInterest,
  withdrawMeetInterest,
  getMyMeetParticipation,
  listMeetCollegeEvents,
  getMeetApplicantPool,
  submitMeetCollegeEntry,
  withdrawMeetCollegeEntry,
  reviewMeetEntry,
  openMeetLateWindow,
  listMeetEntries,
};
