/**
 * 赛季积分的物化（2026-10-29 第十三轮：物化到会员行）
 * ============================================================
 * 【要解决什么】
 * 赛季积分是 `events`（已结束赛事的录取名次）+ `associationTrainings` +
 * `trainingRegistrations`（有效签到）三份数据的运行时聚合。聚合本身没错，
 * 问题在**读的频率**：榜单、赛事面板、成绩页每打开一次就把三份集合读回来重算。
 * 一个开了三年的协会是「几百场赛事 + 几百场训练 + 几千条签到」，而页面要的
 * 往往只是「前 10 名」或者「我这个人的分」。
 *
 * 【物化到哪里】
 * 写进 `schoolMembers` 会员行本身（字段 `seasonPointsByAssociation` /
 * `pointsAnchorByAssociation`），不是另开一张积分表。理由是读端的形状：榜单与
 * 成绩页本来就要读会员行（名字、学院、在册状态），积分长在行上等于**零额外读**；
 * 另建一张每人一行的表反而多一次整表读（人数越多越贵），且多一个集合、一套
 * 归属校验。
 *
 * 【为什么字段按协会分键，而不是一个 `seasonPoints` 数字】
 * 会员行是**学校级**的（`sm:<school>:<user>`，一人一行），而赛季积分是
 * 「学校 × 协会」口径（`seasons` 的主键含 association）。一个学校启用多个协会时，
 * 单个数字会被后写入的协会覆盖，读取端还会因为「本协会代际已对齐」而认账——
 * 甲协会的榜单显示乙协会的分。所以两个字段都是 map：`{ pkb: 22, tt: 82 }`，
 * 写只改自己那一个 key，读只取 `ctx.association` 那一个 key。
 *
 * 【兼容老数据：格式版本】
 * 上一版把分写在单字段 `seasonPoints` 上。`pointsSchemaVersion` 就是给这件事
 * 留的开关：没有这个版本号的赛季一律按「未物化」处理（回退实时聚合），
 * 下一次写动作重算时自动升到当前版本。**不要**用 `pointsSettledVersion` 兼任，
 * 它已经存在且会被旧数据带上，分辨不出格式。
 *
 * 【正确性怎么保证：宁可慢，不可错】
 * 任何影响积分事实的写都会在同一事务里把 `seasons.version` +1（见写路径的
 * `bumpSeasonVersion`）。读取端先看 `pointsSettledVersion === version`：
 *   · 相等 → 直接用行上的物化值；
 *   · 不等（含首次上线、上次重算失败、并发写）→ **一律回退实时聚合**。
 * 另外两条同源的保险：
 *   · 重算时只要有一行写失败，就**不**对齐代际（否则读端会信任半新半旧的值）；
 *   · 代际对齐只在「读到的 version 仍是本次快照」时才写（并发写会把它推高）。
 * 因此物化最多让读变慢（回到改造前的样子），不会让读出错分。
 *
 * 【为什么重算不放在读取里】
 * 读请求写库会把「一次慢读」变成「一次慢读 + N 次写」，并发下还会互相覆盖。
 * 重算只由写路径（`refreshAfterWrite`）执行。
 *
 * 【为什么只写变化的人】
 * 一次结算若把所有行都重写一遍，就是几百次写。行上**不存版本号**（版本只在
 * 赛季文档上比一次），逐行比本协会的 `points` 与 `anchor`：分数没变、赛季没换
 * 的人一个字段都不写。0 分且从未物化过的行也不写——否则首次上线要写全校。
 *
 * 【已知边界】
 * 会员行是在上一次重算之后才建出来的（离校又返校、审批刚通过），行上没有
 * 物化值，读到的是 0，直到下一次事实写入触发重算。换算口径：这类人要么
 * 本来就没分，要么分在别的学校（跨校积分事实留在原校区，见
 * school-membership-service）。下一次赛事结算或签到确认即自动对齐。
 * ============================================================
 */

const { schoolMemberKey, scopeKey } = require('../utils/school.js');
const { aggregatePoints } = require('./school-points-service.js');

/** 单批写入条数：与团队域批量入口同一档，避免一次请求里排几百个写。 */
const WRITE_BATCH = 20;

/**
 * 一个事务里最多写几行会员行。
 *
 * 【为什么按事务分批，而不是一行一个事务】一次结算要更新的人数可能上百
 * （176 人的双打签表就是 176 行）。一行一个事务在云开发上是「一行一次
 * 独立事务」：往返 100 多次，请求很容易撞到 3 秒超时。事务内每行是
 * 「读快照 + 读当前 + 写」3 个操作，预算 100（见 cloud-repo 的
 * TX_OPERATION_BUDGET），取 25 行 = 75 操作，留足余量。
 *
 * 【为什么每行要读两次】第一次读（`getById`）拿本事务快照，用来在
 * `seasonPointsByAssociation` 这份 map 上只改**本协会**那一个 key；第二次是
 * `update` 自己在事务内重读-合并。少读那一次就得用手上的旧 map 整份覆盖，
 * 卡在两个协会同时结算的窗口上会把对方刚写的分数抹掉——正是本轮要修的 P0。
 */
const TX_ROWS = 25;

/** 会员行上的物化字段。抽成常量，免得读写两头各写一份字符串。 */
// 按协会分键的积分：{ pkb: 22, tt: 82 }。**不能**退回单个数字，理由见文件头。
const POINTS_MAP_FIELD = 'seasonPointsByAssociation';
// 按协会分键的赛季锚点：与积分同一把尺子，跨赛季残留靠它识别。
const ANCHOR_MAP_FIELD = 'pointsAnchorByAssociation';
// 最后一次写入时间（与协会无关，只用于排查「这行是什么时候被写过」）。
const UPDATED_FIELD = 'pointsUpdatedAt';
// 这一格是第几代算出来的。读端拿它和 `seasons.pointsSettledVersion` 比：
// 有行落后就整份不可信（并发重算时慢的那份可能后落盘，见文件头）。
const VERSION_FIELD = 'pointsVersion';

/**
 * 物化格式版本。老数据（单字段 `seasonPoints`）没有它，读端一律按未物化处理。
 * 改字段结构时必须 +1，这是一次性的失效开关，不是计数器。
 */
const POINTS_SCHEMA = 2;

/** 赛季文档的写计数器（积分代际）。 */
function seasonVersionOf(season) {
  return Number(season && season.version) || 0;
}

/**
 * 物化值对应的代际。缺省 -1（从未结算）——**不能**缺省成 0：
 * 新赛季文档的 version 正好是 0，缺省 0 会让「从未物化」被误判成「已物化」，
 * 于是所有人读到 0 分。
 */
function settledVersionOf(season) {
  if (!season || season.pointsSettledVersion === undefined || season.pointsSettledVersion === null) return -1;
  return Number(season.pointsSettledVersion);
}

/** 赛季分界点（写进会员行，用于识别跨赛季的残留值）。 */
function anchorOf(season) {
  return season && season.resetTime ? String(season.resetTime) : '';
}

/**
 * 物化值是否跟得上事实。
 *
 * 两个条件缺一不可：格式版本对得上（老数据回退）、代际对得上（事实没变过）。
 */
function isSettled(season) {
  if (!season || Number(season.pointsSchemaVersion) !== POINTS_SCHEMA) return false;
  return settledVersionOf(season) === seasonVersionOf(season);
}

/** 会员行上本协会的积分（缺字段按 0；脏值不往下传）。 */
function pointsOfRow(row, association) {
  const map = row && row[POINTS_MAP_FIELD];
  if (!map || typeof map !== 'object') return 0;
  const value = Number(map[String(association)]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 会员行上本协会的物化锚点（从未物化过是空串）。 */
function anchorOfRow(row, association) {
  const map = row && row[ANCHOR_MAP_FIELD];
  if (!map || typeof map !== 'object') return '';
  const value = map[String(association)];
  return typeof value === 'string' ? value : '';
}

/**
 * 读本协会赛季文档（不写库，缺省按「从未重置」处理）。
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function readSeason(ctx) {
  const id = scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
  const doc = await ctx.repo.seasons.getById(id);
  return doc && doc.schoolId === ctx.schoolId ? doc : { _id: id, schoolId: ctx.schoolId,
    association: ctx.association, resetTime: null, version: 0, pointsSettledVersion: -1 };
}

/**
 * 从**已经读出来的**会员行里取积分表（零额外读）。
 *
 * 这是读路径的主入口：榜单视图、成绩页都已经拿到会员行了，直接把这批行喂进来。
 * 未结算（或没有行）返回 null，调用方据此回退实时聚合。
 *
 * `association` 必须显式传：会员行是学校级的，行上按协会分键存放，
 * 漏传就会取到别的协会的分（本轮 P0）。
 *
 * @param {Object} season 赛季文档
 * @param {Array<Object>} rows 会员行（`schoolMembers` 文档）
 * @param {string} association 当前协会
 * @returns {Map<string, number>|null}
 */
function settledPointsOf(season, rows, association) {
  if (!isSettled(season) || !Array.isArray(rows)) return null;
  const generation = settledVersionOf(season);
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.userId !== 'string' || !row.userId) continue;
    // 行上的代际落后于场上的代际 = 有并发重算把旧快照写晚了。
    // 这时**整份**都不可信（同一批写入可能只是部分落后），一律回退实时聚合。
    // 没有这个字段的行是「从未物化过的 0 分」，不参与判断。
    const marked = row[VERSION_FIELD];
    if (marked !== undefined && marked !== null && Number(marked) !== generation) return null;
    map.set(row.userId, pointsOfRow(row, association));
  }
  return map;
}

/**
 * 重算本协会的赛季积分并写回会员行。
 *
 * 只会写「分数变了 / 换了赛季」的行（判据见文件头「为什么只写变化的人」）。
 * 最后把 `pointsSettledVersion` 对齐到本次读到的事实代际；若期间有别的写把
 * `version` 推高了，就不写这个标记（让下一次读继续回退实时），避免用旧快照
 * 冒充已结算。
 *
 * @param {Object} ctx
 * @param {{season?:Object}} [options] 调用方已读过赛季时可传入，省一次点读
 * @returns {Promise<{ok:boolean, version:number, written:number, cleared:number, failed:number, stale:boolean, total:number}>}
 */
async function refreshAssociationPoints(ctx, options = {}) {
  const scope = ctx.repo.forScope(ctx);
  const association = String(ctx.association);
  const season = options.season || await readSeason(ctx);
  const version = seasonVersionOf(season);
  const anchor = anchorOf(season);

  // 三份事实 + 会员行：一次重算就是「读全部事实、只写变化的人」。
  // 这笔读原来发生在**每一次**打开榜单/成绩页，现在挪到写路径（结算、签到确认）。
  const [events, trainings, registrations, rows] = await Promise.all([
    scope.events.list(),
    scope.associationTrainings.list(),
    scope.trainingRegistrations.list(),
    scope.schoolMembers.list(),
  ]);
  const pointsByUser = aggregatePoints({
    events,
    trainings,
    trainingRegistrations: registrations,
    resetTime: season.resetTime,
  });

  const nowIso = new Date(ctx.now || Date.now()).toISOString();
  const writes = [];
  for (const row of rows) {
    const userId = row && row.userId;
    if (typeof userId !== 'string' || !userId) continue;
    const current = pointsOfRow(row, association);
    const rowAnchor = anchorOfRow(row, association);
    const computed = Number(pointsByUser.get(userId)) || 0;
    const wanted = computed > 0 ? computed : 0;
    if (wanted === 0) {
      // 归零：只有「本协会本来有分」或「带着别的赛季锚点」的行才需要写。
      // 从未物化过的 0 分行一个都不写——否则首次上线要把全校会员写一遍。
      // 注意只看**本协会**这两个 key：别的协会的分与本协会无关，不能顺手清零。
      if (!(current > 0 || (rowAnchor && rowAnchor !== anchor))) continue;
    } else if (current === wanted && rowAnchor === anchor) {
      continue;
    }
    writes.push({ userId, points: wanted });
  }

  /**
   * 只改本协会的两个 key，其余协会原样保留。
   *
   * 【为什么必须在事务内按「当前行」算 map】update 的合并粒度是整字段：
   * 若用手上（可能几百毫秒前读到的）旧 map 整份写回，卡在另一个协会刚结算完
   * 的窗口上就会把对方那一格抹掉——这正是本轮要修的跨协会覆盖。
   */
  const patchFor = (row, points) => ({
    [POINTS_MAP_FIELD]: { ...((row && row[POINTS_MAP_FIELD]) || {}), [association]: points },
    [ANCHOR_MAP_FIELD]: { ...((row && row[ANCHOR_MAP_FIELD]) || {}), [association]: anchor },
    [VERSION_FIELD]: version,
    [UPDATED_FIELD]: nowIso,
  });

  let written = 0;
  let failed = 0;
  let skipped = 0;
  const canTransact = typeof ctx.repo.transaction === 'function';
  const step = canTransact ? TX_ROWS : WRITE_BATCH;
  for (let i = 0; i < writes.length; i += step) {
    const batch = writes.slice(i, i + step);
    if (canTransact) {
      // 一个事务写完这一批：每行「读快照 + update 的重读 + 写」= 3 个操作。
      // 中途失败只丢这一批，代际不会对齐——读取端会回退实时聚合，分数仍然
      // 正确，下一次写动作再补算（见下面 failed 的处理）。
      try {
        const done = await ctx.repo.transaction(async (tx) => {
          const scoped = tx.forScope(ctx);
          let count = 0;
          for (const item of batch) {
            const key = schoolMemberKey(item.userId, ctx.schoolId);
            const current = await scoped.schoolMembers.getById(key);
            // 行被并发删掉（转出）：没有可写的对象，也不算失败——他本来就不在榜上
            if (!current) continue;
            await scoped.schoolMembers.update(key, patchFor(current, item.points));
            count += 1;
          }
          return count;
        });
        written += done;
        skipped += batch.length - done;
      } catch (err) {
        failed += batch.length;
        console.error('[season-points] 会员行积分批量写入失败', batch.length, err && err.message);
      }
      continue;
    }
    await Promise.all(batch.map(async (item) => {
      const key = schoolMemberKey(item.userId, ctx.schoolId);
      try {
        const current = await scope.schoolMembers.getById(key);
        if (!current) { skipped += 1; return; }
        await scope.schoolMembers.update(key, patchFor(current, item.points));
        written += 1;
      } catch (err) {
        // 单行写失败（例如刚被转出、行已不存在）不该拖垮整次重算
        failed += 1;
        console.error('[season-points] 会员行积分写入失败', item.userId, err && err.message);
      }
    }));
  }

  // 收尾对齐代际：先重读赛季，version 变了就放弃（说明期间又有写，物化已过期）
  //
  // 【为什么用 update 而不是「读出来再整份 set」】整份 set 会把**这次读到的
  // version 一并写回**：若期间有并发写把 version 推高了，读-写之间那一小段
  // 就会把代际写回旧值，于是 `pointsSettledVersion === version` 成立——刚好
  // 把「已经过期」伪装成「已结算」。update 只写这一个字段，撞车交给事务冲突。
  //
  // 【为什么有失败就不写标记】只要有一行没写进去，行上就是「半新半旧」。
  // 此时对齐代际等于告诉读端「这份是准的」，读到的是旧分且不报错——
  // 2026-11-07 审查的 P1 就是这条路径。宁可让它退回实时聚合（慢，但对）。
  let stale = false;
  const id = scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
  const latestDoc = await ctx.repo.seasons.getById(id);
  const latest = latestDoc && latestDoc.schoolId === ctx.schoolId ? latestDoc : null;
  const latestVersion = latest ? seasonVersionOf(latest) : 0;
  if (latestVersion !== version || failed > 0) {
    stale = true;
  } else if (latest) {
    await scope.seasons.update(id, {
      pointsSettledVersion: version, pointsSchemaVersion: POINTS_SCHEMA,
    });
  } else {
    // 赛季文档还不存在（从未重置过的新协会）：此刻没有并发版本可丢，直接建
    await ctx.repo.seasons.set(id, {
      _id: id, schoolId: ctx.schoolId, association: ctx.association,
      resetTime: null, anchorTime: null, seasonNumber: 1, version: 0,
      pointsSettledVersion: version, pointsSchemaVersion: POINTS_SCHEMA, updatedAt: nowIso,
    });
  }
  return { ok: true, version, written, cleared: writes.filter(item => item.points === 0).length,
    failed, skipped, stale, total: pointsByUser.size };
}

/**
 * 单条训练积分事实的增量维护（2026-10-29 第十三轮 P1）。
 * ============================================================
 * 【为什么需要它】确认签到是**高频道**动作：一场 50 人的训练要确认 50 次。
 * 每次确认都整份重算，等于 50 次「读全部赛事 + 训练 + 全部签到 + 全部会员行」，
 * 比改造前还贵——把读放大从读请求挪到了写请求，总量没变甚至更多。
 *
 * 但训练签到的积分口径是最简单的一种：一条事实固定 ±1，且归属赛季只看
 * `pointEffectiveAt`（确认时从 training.startAt 复制）。所以只要物化值是
 * 干净的（`pointsSettledVersion === version`），就能**精确地**在第 1 格上
 * 加减，不需要重算——数学上等价于重算后那个人那一格。
 *
 * 【什么时候必须退回整次重算】
 *   · 赛季还没物化（首次上线 / 重置后 / 上次重算失败）——行上的值不可信；
 *   · 行上锚点与当前赛季不一致（跨赛季残留、或会员行刚建）；
 *   · 会员行不存在（已转出）。
 * 三种情况都返回 `needsRefresh`，由调用方在事务外跑 `refreshAfterWrite`。
 *
 * 【为什么能安全地不用 bumpSeasonVersion】本函数在**同一个事务**里把
 * `version` 与 `pointsSettledVersion` 一起 +1：事实、行上的值、代际三者
 * 原子地同时前进，读取端不会看到「分变了但还说是已结算」的中间态。
 *
 * @param {Object} tx 事务仓储
 * @param {Object} ctx
 * @param {{userId:string, delta:number, effectiveAt:(string|null)}} params
 * @returns {Promise<{applied:boolean, needsRefresh:boolean}>}
 */
async function applyTrainingFactDelta(tx, ctx, { userId, delta, effectiveAt } = {}) {
  const amount = Number(delta) || 0;
  if (typeof userId !== 'string' || !userId || amount === 0) {
    return { applied: false, needsRefresh: false };
  }
  const id = scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
  const doc = await tx.seasons.getById(id);
  const season = doc && doc.schoolId === ctx.schoolId ? doc : null;
  if (!season || !isSettled(season)) return { applied: false, needsRefresh: true };

  // 不在本赛季的事实不改变本赛季的分（与 factsInSeason 同一把尺子）
  const resetMs = season.resetTime ? new Date(season.resetTime).getTime() : NaN;
  if (Number.isFinite(resetMs)) {
    const atMs = new Date(effectiveAt).getTime();
    if (!Number.isFinite(atMs) || atMs < resetMs) return { applied: false, needsRefresh: false };
  }

  const anchor = anchorOf(season);
  const association = String(ctx.association);
  const key = schoolMemberKey(userId, ctx.schoolId);
  const row = await tx.schoolMembers.getById(key);
  if (!row || anchorOfRow(row, association) !== anchor) return { applied: false, needsRefresh: true };

  const nowIso = new Date(ctx.now || Date.now()).toISOString();
  const next = Math.max(0, pointsOfRow(row, association) + amount);
  await tx.schoolMembers.set(key, {
    ...row,
    // 只改本协会那两格，别的协会原样带回（会员行是学校级的，见文件头）
    [POINTS_MAP_FIELD]: { ...((row[POINTS_MAP_FIELD]) || {}), [association]: next },
    [ANCHOR_MAP_FIELD]: { ...((row[ANCHOR_MAP_FIELD]) || {}), [association]: anchor },
    [VERSION_FIELD]: seasonVersionOf(season) + 1,
    [UPDATED_FIELD]: nowIso,
  });
  const version = seasonVersionOf(season) + 1;
  await tx.seasons.set(id, {
    ...season, version, pointsSettledVersion: version,
    pointsSchemaVersion: POINTS_SCHEMA, updatedAt: nowIso,
  });
  return { applied: true, needsRefresh: false };
}

/**
 * 在事务内把赛季的积分代际 +1。
 *
 * 【为什么放在事务里】「事实变了」与「代际变了」必须原子：先写事实再单独推代际，
 * 中间失败就是「分变了但读取端还以为是物化的」。反过来先推代际再写事实失败，
 * 只是让读取端多跑一次实时聚合（慢，但不脏）。
 *
 * 【谁必须调用】任何改变积分事实的写：赛事结算（名次落库）、签到确认 / 撤销、
 * 取消训练、赛季重置。漏一处的后果是「读到旧分且不报错」——这是本机制唯一
 * 的错误面，改动积分口径时先搜这个函数名。
 *
 * @param {Object} tx 事务仓储
 * @param {Object} ctx
 * @param {Date} [now]
 * @returns {Promise<number>} 递增后的代际
 */
async function bumpSeasonVersion(tx, ctx, now = new Date()) {
  const id = scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
  const doc = await tx.seasons.getById(id);
  const base = doc && doc.schoolId === ctx.schoolId ? doc : {
    _id: id, schoolId: ctx.schoolId, association: ctx.association,
    anchorTime: null, resetTime: null, seasonNumber: 1, version: 0, pointsSettledVersion: -1,
  };
  const next = (Number(base.version) || 0) + 1;
  await tx.seasons.set(id, { ...base, version: next, updatedAt: now.toISOString() });
  return next;
}

/**
 * 写动作收尾：重算物化积分。
 *
 * 失败**不影响**主流程（事实已经写进库了），只记日志——读取端会因为代际不等而
 * 回退实时聚合，分数仍然正确。下一次写动作会再算一遍。
 *
 * @param {Object} ctx
 * @returns {Promise<Object|null>}
 */
async function refreshAfterWrite(ctx) {
  try {
    return await refreshAssociationPoints(ctx);
  } catch (err) {
    console.error('[season-points] 物化重算失败，读取端将回退实时聚合', err && err.message);
    return null;
  }
}

module.exports = {
  WRITE_BATCH,
  TX_ROWS,
  POINTS_SCHEMA,
  POINTS_MAP_FIELD,
  ANCHOR_MAP_FIELD,
  UPDATED_FIELD,
  VERSION_FIELD,
  seasonVersionOf,
  settledVersionOf,
  anchorOf,
  isSettled,
  pointsOfRow,
  anchorOfRow,
  readSeason,
  settledPointsOf,
  refreshAssociationPoints,
  applyTrainingFactDelta,
  bumpSeasonVersion,
  refreshAfterWrite,
};
