/** 集合查询在事务外进行，事务内点读版本，防止旧快照覆盖新成绩/报名。 */
function stableJson(doc) {
  return JSON.stringify(doc, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

async function unchanged(tx, collection, docs) {
  for (const doc of docs) {
    const current = await tx[collection].getById(doc._id);
    if (stableJson(current) !== stableJson(doc)) return false;
  }
  return true;
}

/**
 * 项目组别的「版本戳」是否仍是事务外读到的那个。
 *
 * 【为什么不用 unchanged 逐条比对】（2026-10-22 大用户量复查 W-0）
 * 发布成绩原来对报名、成绩、裁判指派逐条点读比对：一个 26 院满员的田径项目
 * 是 52 条报名 + 150 条裁判分，光校验就 200 多个操作，而云端事务预算约 100。
 * 结果不是「慢」，是**必然失败**。
 *
 * `event.revision` 是项目级的「任何变化」计数器，由 `touchEvent` 递增：
 * 报名提交／审核／撤回、抽签编排、场次修改、指派裁判、录分与提交，都会走
 * `touchEvent`。所以比一次 revision 就等价于逐条比对这些集合——
 * 而且更严（任何一个细节变了都会要求刷新，正是发布该有的语义）。
 *
 * **前提**：所有会改动「该项目报名／场次／裁判／成绩」的写路径都必须调
 * `touchEvent`。新增这类写路径时漏掉它，这里就会漏检——改那边时请一起看这里。
 *
 * @param {Object} tx 事务内的仓储
 * @param {Object} snapshot 事务外读到的项目文档
 * @returns {Promise<boolean>} true 表示期间没有任何变化
 */
async function unchangedEvent(tx, snapshot) {
  if (!snapshot) return false;
  const current = await tx.sportsMeetEvents.getById(snapshot._id);
  if (!current) return false;
  return Number(current.revision || 0) === Number(snapshot.revision || 0);
}

/** 项目变更同时推进届次内容版本，供收尾事务用常数次读取核对。 */
async function touchEvent(tx, eventKey) {
  const doc = await tx.sportsMeetEvents.getById(eventKey);
  if (doc) {
    await tx.sportsMeetEvents.set(eventKey, { ...doc, revision: Number(doc.revision || 0) + 1 });
    const meet = await tx.sportsMeets.getById(doc.meetId);
    if (meet) await tx.sportsMeets.set(doc.meetId, {
      ...meet, contentRevision: Number(meet.contentRevision || 0) + 1,
    });
  }
}

/**
 * 届次「赛程版本」：项目组别与场次的任何变化都递增它。
 *
 * 【为什么不逐条比对，以及它和 event.revision 的分工】（2026-10-26 只读审查 P1-2）
 * 发布赛程原先在事务内逐条重读**全届**项目与场次做快照比对：
 * 48 个项目组别 × (1 项目 + 1 场次) = 96 次读，加上身份复核与运动会读就已 101 次，
 * 越过云端 100 次事务预算——不是「慢」，是**必然发布失败**，而且规模越大越早触发。
 * `event.revision` 是**单项目**粒度（录分、裁判、报名都会碰它），发布要判的是
 * **赛程面**（时间、场地、轮次、分组、参赛人），所以需要届次级的一个版本戳：
 * 事务内只读一份运动会文档就能等价校验。
 *
 * **维护约定**：凡改动`赛程面`的写路径都要调 `touchScheduleRevision`——
 * 项目组别的新建/改赛制/删除，场次的时间、场地、轮次、分组与参赛人变更、抽签与重抽。
 * 只管成绩或裁判名单的写路径不必调（它们不影响「时间与场地是否配齐」的判定）。
 */
function scheduleRevisionOf(meet) {
  return Number((meet && meet.scheduleRevision) || 0);
}

/** 递增届次赛程版本（点读 + 写回，共 2 次操作）。必须在同一事务内、写完赛程数据之后调用。 */
async function touchScheduleRevision(tx, meetId) {
  if (!meetId) return 0;
  const meet = await tx.sportsMeets.getById(meetId);
  if (!meet) return 0;
  const next = scheduleRevisionOf(meet) + 1;
  await tx.sportsMeets.set(meetId, { ...meet, scheduleRevision: next });
  return next;
}

/** 事务内的赛程版本是否仍是事务外读到的那个（1 次读）。 */
async function unchangedScheduleRevision(tx, meetId, expected) {
  const current = await tx.sportsMeets.getById(meetId);
  return Boolean(current) && scheduleRevisionOf(current) === Number(expected || 0);
}

function liveMeet(ctx) {
  return Boolean(ctx.meet && ctx.meet.schoolId === ctx.schoolId && ctx.meet.status !== 'deleted');
}

// 重抽在场次上推进指派版本，原指派随之失效。旧数据的场次与指派都按版本 0 处理。
function isCurrentJudgeAssignment(session, assignment) {
  return Boolean(session && !session.voidedAt && assignment
    && (session.judgeAssignmentRevision || 0) === (assignment.judgeAssignmentRevision || 0));
}

/**
 * 某次发布的明细行：优先取派生索引，缺失时回落到发布快照里的 rows。
 *
 * 【为什么要有回落】（2026-10-22 大用户量复查 W-0）
 * 发布拆成了两段：
 *   · 事务内（原子）：发布文档（含全部行的 digest）+ 学院总榜；
 *   · 事务之后（分批）：结果行与荣誉这两张**派生索引**。
 * 这样事务的操作数与「报了几条」无关，52 条报名也不会撞预算。
 * 代价是发布成功后、明细写完前有一个很短的窗口——此时按版本号过滤会得到空列表，
 * 页面会显示「已发布但一条成绩都没有」。回落让这个窗口不可见：发布快照本身就是
 * 权威数据，派生索引只是加速读取的副本。
 *
 * @param {Object} publication 发布文档（`_id` + `version` + `rows`）
 * @param {Object[]} rows 该届的结果行全集（已按范围读出）
 * @returns {Object[]}
 */
function publishedRowsOf(publication, rows) {
  if (!publication) return [];
  const version = Number(publication.version) || 0;
  const hit = (Array.isArray(rows) ? rows : []).filter(
    (row) => row.publicationKey === publication._id && Number(row.version) === version,
  );
  if (!Array.isArray(publication.rows) || hit.length > 0 && hit.length === Number(publication.rowCount)) return hit;
  const digest = Array.isArray(publication.rows) ? publication.rows : [];
  return digest.map((row) => ({
    ...row,
    eventKey: publication.eventKey,
    publicationKey: publication._id,
    version,
  }));
}

module.exports = {
  unchanged, unchangedEvent, touchEvent, liveMeet, publishedRowsOf, isCurrentJudgeAssignment,
  scheduleRevisionOf, touchScheduleRevision, unchangedScheduleRevision,
};
