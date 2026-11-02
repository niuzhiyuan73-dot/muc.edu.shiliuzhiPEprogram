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
 * 写进 `schoolMembers` 会员行本身（字段 `seasonPoints` / `pointsAnchor`），
 * 不是另开一张积分表。理由是读端的形状：榜单与成绩页本来就要读会员行
 * （名字、学院、在册状态），积分长在行上等于**零额外读**；另建一张每人一行的
 * 表反而多一次整表读（人数越多越贵），且多一个集合、一套归属校验。
 *
 * 【正确性怎么保证：宁可慢，不可错】
 * 任何影响积分事实的写都会在同一事务里把 `seasons.version` +1（见写路径的
 * `bumpSeasonVersion`）。读取端先看 `pointsSettledVersion === version`：
 *   · 相等 → 直接用行上的物化值；
 *   · 不等（含首次上线、上次重算失败、并发写）→ **一律回退实时聚合**。
 * 因此物化最多让读变慢（回到改造前的样子），不会让读出错分。
 *
 * 【为什么重算不放在读取里】
 * 读请求写库会把「一次慢读」变成「一次慢读 + N 次写」，并发下还会互相覆盖。
 * 重算只由写路径（`refreshAfterWrite`）执行。
 *
 * 【为什么只写变化的人】
 * 一次结算若把所有行都重写一遍，就是几百次写。行上**不存版本号**（版本只在
 * 赛季文档上比一次），逐行比 `points` 与 `anchor`：分数没变、赛季没换的人
 * 一个字段都不写。0 分且从未物化过的行也不写——否则首次上线要写全校。
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
 * 「读 + 写」2 个操作，预算 100（见 cloud-repo 的 TX_OPERATION_BUDGET），
 * 取 30 行 = 60 操作，留足余量；100 行的人也只要 4 次往返。
 */
const TX_ROWS = 30;

/** 会员行上的三个物化字段。抽成常量，免得读写两头各写一份字符串。 */
const POINTS_FIELD = 'seasonPoints';
const ANCHOR_FIELD = 'pointsAnchor';
const UPDATED_FIELD = 'pointsUpdatedAt';

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

/** 物化值是否跟得上事实。 */
function isSettled(season) {
  return settledVersionOf(season) === seasonVersionOf(season);
}

/** 会员行上的积分（缺字段按 0；脏值不往下传）。 */
function pointsOfRow(row) {
  const value = Number(row && row[POINTS_FIELD]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 会员行上的物化锚点（从未物化过是空串）。 */
function anchorOfRow(row) {
  return row && typeof row[ANCHOR_FIELD] === 'string' ? row[ANCHOR_FIELD] : '';
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
 * @param {Object} season 赛季文档
 * @param {Array<Object>} rows 会员行（`schoolMembers` 文档）
 * @returns {Map<string, number>|null}
 */
function settledPointsOf(season, rows) {
  if (!isSettled(season) || !Array.isArray(rows)) return null;
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.userId !== 'string' || !row.userId) continue;
    map.set(row.userId, pointsOfRow(row));
  }
  return map;
}

/**
 * 只取「这几个人」的物化积分（按主键批读，不整表读）。
 *
 * 个人主页、单人成绩这类只关心一个人的场景用它。返回值有两种「没有」：
 *   · `null` → 赛季未结算，调用方回退实时聚合；
 *   · Map 里查不到这个 userId → 这个人没有会员行（已转出），同样回退。
 *
 * @param {Object} ctx
 * @param {Object} season
 * @param {string[]} userIds
 * @returns {Promise<Map<string, number>|null>}
 */
async function settledPointsFor(ctx, season, userIds) {
  if (!isSettled(season)) return null;
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter(id => typeof id === 'string' && id))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.repo.forScope(ctx).schoolMembers
    .listByIds(ids.map(id => schoolMemberKey(id, ctx.schoolId)));
  return settledPointsOf(season, Array.isArray(rows) ? rows : []);
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
    const current = pointsOfRow(row);
    const rowAnchor = anchorOfRow(row);
    const computed = Number(pointsByUser.get(userId)) || 0;
    const wanted = computed > 0 ? computed : 0;
    if (wanted === 0) {
      // 归零：只有「本来有分」或「带着别的赛季锚点」的行才需要写。
      // 从未物化过的 0 分行一个都不写——否则首次上线要把全校会员写一遍。
      if (!(current > 0 || (rowAnchor && rowAnchor !== anchor))) continue;
    } else if (current === wanted && rowAnchor === anchor) {
      continue;
    }
    writes.push({ userId, points: wanted });
  }

  let written = 0;
  let failed = 0;
  const patchOf = (item) => ({
    // 用 update（读-合并-写）而不是 set：会员行同时承载学籍、学院、状态，
    // 整行覆盖会把并发的学籍变更抹掉。
    [POINTS_FIELD]: item.points,
    [ANCHOR_FIELD]: anchor,
    [UPDATED_FIELD]: nowIso,
  });
  const canTransact = typeof ctx.repo.transaction === 'function';
  for (let i = 0; i < writes.length; i += (canTransact ? TX_ROWS : WRITE_BATCH)) {
    const step = canTransact ? TX_ROWS : WRITE_BATCH;
    const batch = writes.slice(i, i + step);
    if (canTransact) {
      // 一个事务写完这一批：行数是「每人 2 个操作」，不会撞事务预算。
      // 中途失败只丢这一批，`pointsSettledVersion` 因此不会对齐——读取端会
      // 回退实时聚合，分数仍然正确，下一次写动作再补算。
      try {
        await ctx.repo.transaction(async (tx) => {
          const scoped = tx.forScope(ctx);
          for (const item of batch) {
            await scoped.schoolMembers.update(schoolMemberKey(item.userId, ctx.schoolId), patchOf(item));
          }
        });
        written += batch.length;
      } catch (err) {
        failed += batch.length;
        console.error('[season-points] 会员行积分批量写入失败', batch.length, err && err.message);
      }
      continue;
    }
    await Promise.all(batch.map(async (item) => {
      try {
        await scope.schoolMembers.update(schoolMemberKey(item.userId, ctx.schoolId), patchOf(item));
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
  let stale = false;
  const id = scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
  const latestDoc = await ctx.repo.seasons.getById(id);
  const latest = latestDoc && latestDoc.schoolId === ctx.schoolId ? latestDoc : null;
  const latestVersion = latest ? seasonVersionOf(latest) : 0;
  if (latestVersion !== version) {
    stale = true;
  } else if (latest) {
    await scope.seasons.update(id, { pointsSettledVersion: version });
  } else {
    // 赛季文档还不存在（从未重置过的新协会）：此刻没有并发版本可丢，直接建
    await ctx.repo.seasons.set(id, {
      _id: id, schoolId: ctx.schoolId, association: ctx.association,
      resetTime: null, anchorTime: null, seasonNumber: 1, version: 0,
      pointsSettledVersion: version, updatedAt: nowIso,
    });
  }
  return { ok: true, version, written, cleared: writes.filter(item => item.points === 0).length,
    failed, stale, total: pointsByUser.size };
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
  const key = schoolMemberKey(userId, ctx.schoolId);
  const row = await tx.schoolMembers.getById(key);
  if (!row || anchorOfRow(row) !== anchor) return { applied: false, needsRefresh: true };

  const nowIso = new Date(ctx.now || Date.now()).toISOString();
  const next = Math.max(0, pointsOfRow(row) + amount);
  await tx.schoolMembers.set(key, {
    ...row, [POINTS_FIELD]: next, [ANCHOR_FIELD]: anchor, [UPDATED_FIELD]: nowIso,
  });
  const version = seasonVersionOf(season) + 1;
  await tx.seasons.set(id, {
    ...season, version, pointsSettledVersion: version, updatedAt: nowIso,
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
  POINTS_FIELD,
  ANCHOR_FIELD,
  UPDATED_FIELD,
  seasonVersionOf,
  settledVersionOf,
  anchorOf,
  isSettled,
  pointsOfRow,
  anchorOfRow,
  readSeason,
  settledPointsOf,
  settledPointsFor,
  refreshAssociationPoints,
  applyTrainingFactDelta,
  bumpSeasonVersion,
  refreshAfterWrite,
};
