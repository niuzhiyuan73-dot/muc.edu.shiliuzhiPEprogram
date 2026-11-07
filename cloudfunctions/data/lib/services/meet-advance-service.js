/**
 * 运动会：预赛分组、晋级推进与赛制签表（B8a）
 * ============================================================
 * 本模块解决两件事，都是「让系统自己算名次」而不是让管理员手填：
 *
 *   1. 数值型项目的预赛 → 决赛：抽签分组、发布各组成绩、按口径晋级；
 *   2. 胜负型项目（拔河等）：生成签表 / 循环赛对阵，记录每场胜负，
 *      由赛制推出最终名次。
 *
 * 【为什么一场比赛就是一条场次记录】
 * 赛程已经用 `sportsMeetSessions` 表达「什么时候、在哪、谁执裁」。签表里的
 * 每一场对阵同样是「什么时候、在哪、谁执裁，谁对谁」，只是多了对阵双方与
 * 胜负。复用它有三个直接好处：
 *   · 不用新增集合，也不用到四处注册点改集合清单；
 *   · 赛程页、裁判指派、开赛、录分全部自动适用，不需要为赛制另写一套；
 *   · 「场次 × 参与人」这份索引本来就要为预赛建，签表顺带就有了。
 * 若另建 `matches` 集合，等于把赛程拆成两套，页面与权限都要写两遍。
 *
 * 【签表所有轮次一次落库，不「打到哪建到哪」】
 * 16 支队是 15 条场次记录，一次写完毫无压力。好处是槽位重算可以做成纯函数：
 * 每次改胜负，从第 1 轮往后把「上一轮胜者」写进下一轮槽位，并顺手清掉
 * 「胜者已不在场上」的过期判定。若改成按需建场次，就要在事务里递归读写，
 * 一旦某一环漏清，后续轮次会带着一个已经被淘汰的人继续比赛。
 *
 * 【赛制只做单败与循环】
 * 见 meet-advance.js 顶部说明：双败与小组赛不是「加几十行」的量级，配置时
 * 直接拒绝，避免按单败跑出一个看似合理实则错误的名次。
 * ============================================================
 */

const { MEET_ENTRY_STATUS, meetSessionKey, listAliveEvents } = require('../utils/meet-scope.js');
const { createSeededRandom, shuffle } = require('../utils/random.js');
const { drawBracket, bracketSizeOf, standardSeedOrder } = require('../utils/bracket.js');
const { MEET_SCORE_TYPE, HEAT_MODE, getTemplate } = require('./meet-event-catalog.js');
const {
  ADVANCE_MODE, DEFAULT_LANE_COUNT, MEET_FORMAT, bracketTotalRounds, bracketRoundLabel,
  advanceFromHeats, bracketStandings, roundRobinRounds, roundRobinStandings,
  splitIntoGroups, assignLanes, groupStageStandings, groupKnockoutStandings,
} = require('./meet-advance.js');
const { freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet, canPublishMeetResult, isChiefJudge } = require('./meet-permission.js');

const { unchanged, liveMeet, publishedRowsOf, touchScheduleRevision } = require('./meet-consistency.js');
const { compareCode } = require('../utils/text-order.js');

// DTO 补 ok:true，与其余三域同形（见 meet-service.js 的说明）。
const ok = (data) => ({ ok: true, data: { ...data, ok: data.ok === undefined ? true : data.ok } });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });

/** 小组名称：1 → A 组。超过 26 组不可能出现（配置上限 8）。 */
function groupLabel(index) {
  return `${String.fromCharCode(64 + Number(index))} 组`;
}
const toIso = (now) => (now instanceof Date ? now.toISOString() : String(now));

/**
 * 组（枪）数上限，按分批模式分档。
 *
 * 分道项目按道数排：6 组 × 8 道 = 48 人，已是全校单项目的人数上限，再多就该加跑道
 * 而不是加组。不分道项目（长跑、次数、趣味）按人数排，上限放到 20——跳绳 200 人
 * 分 10 批、长跑 300 人分 20 组都是正常的，用 6 挡不住。
 */
const MAX_HEATS_LANE = 6;
const MAX_HEATS_CAPACITY = 20;

function approvedOf(entries, eventKey) {
  return entries
    .filter((doc) => doc.eventKey === eventKey && doc.status === MEET_ENTRY_STATUS.APPROVED)
    .sort((a, b) => compareCode(a._id, b._id));
}

/** 取一个可复现的随机种子：显式传入优先，否则用当前毫秒。落库后可供复核。 */
function seedOf(payload, now) {
  const given = Number(payload.seed);
  if (Number.isFinite(given) && given > 0) return Math.floor(given) % 2147483647;
  return Number(now instanceof Date ? now.getTime() : Date.now()) % 2147483647;
}

/**
 * 抽签分组：把报名的人按「每组人数＝跑道数」分到若干组／若干枪。
 *
 * 两种形态共用这一个动作：
 *   · rounds = 'heat_final'：分成 N 个预赛组，另建一个空的决赛场次等着晋级；
 *   · rounds = 'final'：所有人在预赛？不——分成 N **枪**决赛，各枪成绩合并排名，
 *     不晋级、不淘汰。学生运动会里 100 米报名 40 人，就是 7 枪跑完再总排名。
 *
 * 【组数为什么由报名人数算】
 * 管理员不该猜「分几组」：一组最多站几条跑道是场地决定的，报名人数是报名结束后
 * 才知道的。所以这里用 `ceil(人数 / 每组人数)` 直接算，管理员仍可用 heatCount
 * 显式覆盖（比如想少跑一枪、多站两个人）。
 *
 * @param {Object} payload { eventKey, heatCount?, seeds?, seed? }
 */
async function drawMeetHeats(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const event = await ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey);
  // 三处都按本项目下推（2026-10-26 第五轮 B）：抽签只需要本项目的报名、
  // 本项目的发布快照与「本项目有没有录过分」。原来读一届全部，随项目数线性变慢。
  const [entries, publications, existingScores] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEntries.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetPublications.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetScores.listByProject(eventKey),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以抽签分组');
  if (event.heatDraw || existingScores.length > 0) return refused('该项目已经分组或录分，不能重复抽签覆盖名单');
  if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
    return refused('胜负项目不做分组，请用签表编排');
  }
  if (!['heat_final', 'final'].includes(event.rounds)) {
    return refused('请先设置该项目的轮次');
  }

  if (entries.some(row => row.eventKey === eventKey && row.status === 'pending_review')) return refused('该项目还有待审核名单，请先处理后再抽签');
  const approved = approvedOf(entries, eventKey);
  if (approved.length < 2) return refused('参赛记录不足 2 条，无法分组');
  if (publications.some((doc) => doc.eventKey === eventKey)) {
    return refused('该项目已有成绩发布，不能再重新分组');
  }

  // 分批口径按项目模板（Q1／Q3／Q4）：lane 按道数、capacity 按人数上限、
  // single 不分批。老数据只有 laneCount，按模板补 heatMode 后当每批人数用。
  const template = getTemplate(event.templateId);
  const heatMode = event.heatMode || (template && template.heatMode) || HEAT_MODE.CAPACITY;
  if (heatMode === HEAT_MODE.SINGLE) {
    return refused('该项目的成绩在一个场次内按顺序产生，不需要分组；请直接为场次填写时间与场地');
  }
  const heatCapacity = Number(event.heatCapacity) || Number(event.laneCount)
    || (template && template.heatCapacity) || DEFAULT_LANE_COUNT;
  const needed = Math.max(1, Math.ceil(approved.length / heatCapacity));
  const heatCount = Number(payload.heatCount === undefined ? needed : payload.heatCount);
  if (heatCount < needed || heatCount > approved.length) return refused(`每组最多 ${heatCapacity} 人，需要至少 ${needed} 组，且不能产生空组`);
  const maxHeats = heatMode === HEAT_MODE.LANE ? MAX_HEATS_LANE : MAX_HEATS_CAPACITY;
  if (!Number.isInteger(heatCount) || heatCount < 1 || heatCount > maxHeats) {
    return refused(`组（枪）数应为 1–${maxHeats} 的整数`);
  }

  // 决赛只有一个场次，容量就是每批人数（分道项目的跑道数）。预赛组数 ×
  // 每组晋级数超过它，决赛就跑不下了——用户反馈的真实场景：8 个跑道分
  // 4 组、每组晋级 3，凑出 12 人而决赛只有 8 道。
  // 在抽签这一刻挡下来：此时还没有场次，每组晋级数还改得动（真等晋级时
  // 才发现，场次已存在，改配置会被锁死）。
  if (event.rounds === 'heat_final' && event.advance) {
    const mode = event.advance.mode || ADVANCE_MODE.PER_HEAT;
    const count = Number(event.advance.count) || 0;
    const unit = heatMode === HEAT_MODE.LANE ? '跑道数' : '每组人数上限';
    if (mode === ADVANCE_MODE.PER_HEAT) {
      const nominal = count * heatCount;
      if (nominal > heatCapacity) {
        const advice = Math.floor(heatCapacity / heatCount);
        return refused(
          `预赛分 ${heatCount} 组 × 每组晋级 ${count} 人 = ${nominal} 人，`
          + `超过决赛${unit} ${heatCapacity} 人；请把每组晋级数降到 ${advice} 人或以下`,
        );
      }
    } else if (count > heatCapacity) {
      return refused(
        `晋级 ${count} 人超过决赛${unit} ${heatCapacity} 人，请调小晋级人数`,
      );
    }
  }

  const entryKeys = approved.map((doc) => doc._id);
  const seeds = (Array.isArray(payload.seeds) ? payload.seeds : [])
    .map((key) => String(key).trim())
    .filter((key) => entryKeys.includes(key));
  const seed = seedOf(payload, ctx.now);
  let buckets;
  try {
    // 同院尽量不同组（编排规则）：学院信息来自参赛记录的学籍快照
    const collegeOf = new Map(approved.map((doc) => [doc._id, doc.collegeId]));
    buckets = splitIntoGroups(entryKeys, heatCount, seeds, createSeededRandom(seed), collegeOf);
  } catch (err) {
    return refused((err && err.message) || '分组失败');
  }

  const isHeatFinal = event.rounds === 'heat_final';
  // 单枪决赛不叫「第 1 枪」，就叫决赛；多枪才需要区分
  const labelOf = (index) => (isHeatFinal
    ? '预赛'
    : (heatCount > 1 ? `决赛 第 ${index} 枪` : '决赛'));

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!await unchanged(tx, 'sportsMeetEvents', [event])) return refused('项目数据已变化，请刷新后重试');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以抽签分组');
    const now = toIso(fresh.now);

    for (let i = 1; i <= heatCount; i += 1) {
      const key = meetSessionKey(fresh.meetId, eventKey, isHeatFinal ? 'heat' : 'final', i);
      const current = await tx.sportsMeetSessions.getById(key);
      await tx.sportsMeetSessions.set(key, {
        ...(current || {}),
        schoolId: fresh.schoolId,
        meetId: fresh.meetId,
        eventKey,
        round: isHeatFinal ? 'heat' : 'final',
        index: i,
        roundLabel: labelOf(i),
        entryKeys: buckets[i - 1],
        // 重抽后同一个主键写回：把上一次的作废标记清掉，否则场次在读取端仍被过滤
        voidedAt: null,
        // 分道项目才记道次：1 号种子居中最优道，之后左右交替（Q7）。
        // 用对象而非 Map——要直接落库，Map 过不了 JSON 序列化。
        lanes: heatMode === HEAT_MODE.LANE ? assignLanes(buckets[i - 1]) : null,
        startAt: (current && current.startAt) || '',
        endAt: (current && current.endAt) || '',
        venue: (current && current.venue) || '',
        note: (current && current.note) || '',
        status: (current && current.status) || 'scheduled',
        createdAt: (current && current.createdAt) || now,
        updatedAt: now,
      });
    }

    // 预赛+决赛：决赛先建出来（还没定人），赛程才能一起排；参赛人由晋级动作填
    if (isHeatFinal) {
      const finalKey = meetSessionKey(fresh.meetId, eventKey, 'final', 1);
      const finalDoc = await tx.sportsMeetSessions.getById(finalKey);
      if (!finalDoc) {
        await tx.sportsMeetSessions.set(finalKey, {
          schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
          round: 'final', index: 1, roundLabel: '决赛', entryKeys: [],
          startAt: '', endAt: '', venue: '', note: '', status: 'scheduled',
          createdAt: now, updatedAt: now,
        });
      }
    }

    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent, revision: Number(currentEvent.revision || 0) + 1,
      heatDraw: { seed, heatCount, heatMode, heatCapacity, at: now },
      updatedAt: now,
    });
    // 抽签改了场次分组（参赛人），属于赛程面变更：递增届次赛程版本
    await touchScheduleRevision(tx, fresh.meetId);
    return ok({
      eventKey,
      seed,
      heatCount,
      heatMode,
      heatCapacity,
      laneCount: heatMode === HEAT_MODE.LANE ? heatCapacity : 0,
      rounds: event.rounds,
      heats: buckets.map((keys, index) => ({ index: index + 1, entryKeys: keys })),
    });
  });
}

/**
 * 按已发布的预赛成绩推进到决赛。
 *
 * 必须「每组都发布」才能晋级：只发布第一组就晋级，等于让其余组的人凭空出局。
 * 晋级名单写进决赛场次的 `entryKeys`，之后决赛只在这些人之内比。
 *
 * @param {Object} payload { eventKey }
 */
async function advanceMeetEvent(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const event = await ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey);
  // 晋级只看本项目的报名/场次/快照/结果行/成绩（2026-10-26 第五轮 B）。
  const [entries, sessions, publications, rows, scores] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEntries.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetPublications.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetResultRows.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetScores.listByProject(eventKey),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以推进晋级');
  if (event.rounds !== 'heat_final') return refused('该项目没有预赛，不需要晋级');

  const heatSessions = sessions
    .filter((doc) => doc.eventKey === eventKey && doc.round === 'heat')
    .sort((a, b) => Number(a.index) - Number(b.index));
  if (heatSessions.length === 0) return refused('该项目还没有预赛分组，请先抽签');

  const missing = [];
  const heats = [];
  for (const session of heatSessions) {
    const publication = publications.find((doc) => doc.eventKey === eventKey
      && doc.sessionKey === session._id);
    if (!publication) {
      missing.push(`预赛第 ${session.index} 组`);
      continue;
    }
    // 明细索引可能还在写，这里按发布快照兜底（见 meet-consistency.publishedRowsOf）
    const items = publishedRowsOf(publication, rows);
    heats.push({
      index: Number(session.index),
      rows: items.map((row) => ({
        entryKey: row.entryKey, value: row.value, status: row.status,
      })),
    });
  }
  if (missing.length > 0) return refused(`请先发布以下场次成绩：${missing.join('、')}`);

  const advance = event.advance || { mode: ADVANCE_MODE.PER_HEAT, count: 1 };
  const computed = advanceFromHeats({
    heats, mode: advance.mode, count: advance.count, order: event.order,
  });
  if (!computed.ok) return refused(computed.message);
  if (computed.advanced.length < 2) return refused('有效晋级人数不足 2 人，无法组织决赛');

  const finalSession = sessions.find((doc) => doc.eventKey === eventKey && doc.round === 'final');
  if (finalSession && publications.some((doc) => doc.sessionKey === finalSession._id)) {
    return refused('决赛成绩已发布，不能再重新晋级');
  }
  // 参赛记录可能已被撤回（有人退赛），晋级名单只保留仍然通过审核的人
  const alive = new Set(approvedOf(entries, eventKey).map((doc) => doc._id));
  const advancedKeys = computed.advanced.map((row) => row.entryKey).filter((key) => alive.has(key));
  if (advancedKeys.length < 2) return refused('晋级名单里的人已撤回报名，无法组织决赛');

  // 同分全部晋级；额外道次由管理员安排备用跑道（2026-10-18 用户确认）。
  const template = getTemplate(event.templateId);
  const finalHeatMode = event.heatMode || (template && template.heatMode);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!await unchanged(tx, 'sportsMeetEvents', [event])) return refused('项目数据已变化，请刷新后重试');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以推进晋级');
    const now = toIso(fresh.now);
    if (!await unchanged(tx, 'sportsMeetPublications', publications.filter(row => row.eventKey === eventKey))) return refused('预赛成绩已变化，请刷新后重试');
    const finalKey = meetSessionKey(fresh.meetId, eventKey, 'final', 1);
    const current = await tx.sportsMeetSessions.getById(finalKey);
    if (scores.some(row => row.sessionKey === finalKey)) return refused('决赛已有录分，不能重新晋级');
    await tx.sportsMeetSessions.set(finalKey, {
      ...(current || {}),
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey,
      round: 'final',
      index: 1,
      roundLabel: '决赛',
      entryKeys: advancedKeys,
      lanes: finalHeatMode === HEAT_MODE.LANE ? assignLanes(advancedKeys) : null,
      startAt: (current && current.startAt) || '',
      endAt: (current && current.endAt) || '',
      venue: (current && current.venue) || '',
      note: (current && current.note) || '',
      status: (current && current.status) || 'scheduled',
      createdAt: (current && current.createdAt) || now,
      updatedAt: now,
    });
    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent, revision: Number(currentEvent.revision || 0) + 1,
      advanceResult: {
        at: now,
        mode: advance.mode,
        count: advance.count,
        entryKeys: advancedKeys,
        perHeat: computed.perHeat,
      },
      updatedAt: now,
    });
    // 晋级改了决赛场次的参赛人，属于赛程面变更
    await touchScheduleRevision(tx, fresh.meetId);
    return ok({
      eventKey,
      entryKeys: advancedKeys,
      advanced: computed.advanced,
      perHeat: computed.perHeat,
    });
  });
}

/**
 * 按「上一轮胜者」重算每一轮的槽位。
 *
 * 纯函数：入参是全部场次（含 entryKeys 与 winnerEntryKey），返回需要改写的场次。
 * 从第 1 轮往后扫，所以「某个胜者被换掉」会顺着链条一路清干净——这正是
 * 手工递归最容易漏的地方（改了第一轮，第三轮还挂着一个已被淘汰的人）。
 *
 * 小组+淘汰多一段：小组赛全部结束后，把各出线队按标准种子位填进淘汰赛首轮。
 * 放在这里而不是另写一个动作，是为了让「判完最后一场小组赛」与「出线队就位」
 * 在同一次写入里完成，不会出现「小组打完了但签表还空着」的中间态。
 *
 * @param {Array} matches 全部对阵（含 stage / roundNo / groupIndex）
 * @param {Object|number} meta `{ totalRounds, format, groups, groupEntries }` 或直接给总轮数
 */
function recomputeBracket(matches, meta) {
  const info = typeof meta === 'number' ? { totalRounds: meta } : (meta || {});
  const totalRounds = Number(info.totalRounds) || 1;
  const format = info.format || MEET_FORMAT.SINGLE_ELIM;
  const groupsMeta = info.groups || null;
  const groupEntries = info.groupEntries || null;

  const groupMatches = matches.filter((match) => match.stage === 'group');
  const knockout = matches.filter((match) => match.stage !== 'group');

  // 小组+淘汰：出线队就位
  if (format === MEET_FORMAT.GROUP_KNOCKOUT && groupsMeta && groupEntries
    && groupMatches.length > 0) {
    const stage = groupStageStandings({ groups: groupEntries, matches: groupMatches });
    if (stage.complete) {
      const qualifiers = [];
      for (const key of Object.keys(groupEntries).sort((a, b) => Number(a) - Number(b))) {
        const index = Number(key);
        stage.rows
          .filter((row) => row.groupIndex === index && row.rank <= groupsMeta.advancePerGroup)
          .forEach((row) => qualifiers.push(row.entryKey));
      }
      const size = Math.pow(2, totalRounds);
      const order = standardSeedOrder(size);
      const round1 = knockout
        .filter((match) => match.roundNo === 1)
        .sort((a, b) => a.index - b.index);
      round1.forEach((match, position) => {
        const previousPair = JSON.stringify(match.entryKeys);
        // 标准种子位：位置 0 放 1 号种子对最低种子，强队不会在首轮相遇
        match.entryKeys[0] = qualifiers[order[position * 2] - 1] || null;
        match.entryKeys[1] = qualifiers[order[position * 2 + 1] - 1] || null;
        if (previousPair !== JSON.stringify(match.entryKeys) || (match.winnerEntryKey && !match.entryKeys.includes(match.winnerEntryKey))) {
          match.winnerEntryKey = '';
        }
        // 出线队不足签位时，对面是空位 → 直接晋级，不需要打
        const [a, b] = match.entryKeys;
        if (a && !b) match.winnerEntryKey = a;
        else if (b && !a) match.winnerEntryKey = b;
      });
    }
  }

  const byRound = new Map();
  for (const match of knockout) {
    if (!byRound.has(match.roundNo)) byRound.set(match.roundNo, new Map());
    byRound.get(match.roundNo).set(match.index, match);
  }
  const occupied = new Map();
  for (let roundNo = 1; roundNo <= totalRounds; roundNo += 1) {
    const current = byRound.get(roundNo) || new Map();
    for (const match of current.values()) {
      const [a, b] = match.entryKeys;
      const leftOccupied = roundNo === 1 ? Boolean(a) : Boolean(occupied.get((roundNo - 1) + ':' + (match.index * 2 - 1)));
      const rightOccupied = roundNo === 1 ? Boolean(b) : Boolean(occupied.get((roundNo - 1) + ':' + (match.index * 2)));
      occupied.set(roundNo + ':' + match.index, leftOccupied || rightOccupied);
      // 真正的空签位自动轮空；上一轮尚未打完产生的空位不能提前判胜。
      if (a && !rightOccupied) match.winnerEntryKey = a;
      else if (b && !leftOccupied) match.winnerEntryKey = b;
      else if (!leftOccupied && !rightOccupied) match.winnerEntryKey = '';

      const next = (byRound.get(roundNo + 1) || new Map()).get(Math.ceil(match.index / 2));
      if (!next) continue;
      const slot = match.index % 2 === 1 ? 0 : 1;
      const nextEntry = match.winnerEntryKey || null;
      if (next.entryKeys[slot] !== nextEntry) next.winnerEntryKey = '';
      next.entryKeys[slot] = nextEntry;
      // 上一轮的胜者变了：下一轮原先判出的胜者若已不在场上，判定作废
      if (next.winnerEntryKey && !next.entryKeys.includes(next.winnerEntryKey)) {
        next.winnerEntryKey = '';
      }
    }
  }
  return matches;
}

/** 场次上的轮次号：`r3` → 3；循环赛统一记作 1（它不分轮次）。 */
function roundNoOf(session) {
  if (String((session && session.round) || '') === 'rr') return 1;
  const matched = /^r([1-9])$/.exec(String((session && session.round) || ''));
  return matched ? Number(matched[1]) : 0;
}

/** 小组赛场次的组号：`g2` → 2；不是小组赛返回 0。 */
function groupIndexOf(session) {
  const matched = /^g([1-9])$/.exec(String((session && session.round) || ''));
  return matched ? Number(matched[1]) : 0;
}

/** 场次属于哪一阶段：小组赛 / 淘汰赛（含循环赛）；其他返回空。 */
function stageOf(session) {
  if (groupIndexOf(session) > 0) return 'group';
  if (roundNoOf(session) > 0) return 'knockout';
  return '';
}

/** 把场次还原成纯函数要的对阵结构（小组赛与淘汰赛都在内）。 */
function matchesOf(sessions, eventKey) {
  return sessions
    .filter((doc) => doc.eventKey === eventKey && stageOf(doc))
    .map((doc) => ({
      sessionKey: doc._id,
      stage: stageOf(doc),
      roundNo: roundNoOf(doc),
      groupIndex: groupIndexOf(doc),
      index: Number(doc.index) || 1,
      roundLabel: doc.roundLabel || '',
      entryKeys: Array.isArray(doc.entryKeys) && doc.entryKeys.length === 2
        ? [...doc.entryKeys]
        : [null, null],
      winnerEntryKey: doc.winnerEntryKey || '',
    }))
    .sort((a, b) => a.roundNo - b.roundNo || a.groupIndex - b.groupIndex || a.index - b.index);
}

/**
 * 生成签表（单败）或全部对阵（循环赛）。
 *
 * @param {Object} payload { eventKey, seeds?, seed? }
 */
async function drawMeetBracket(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, sessions] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.listByProject(eventKey),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以编排赛制');
  if (event.scoreType !== MEET_SCORE_TYPE.VERSUS) {
    return refused('只有胜负项目需要签表；数值型项目请用预赛分组');
  }

  if (entries.some(row => row.eventKey === eventKey && row.status === 'pending_review')) return refused('该项目还有待审核名单，请先处理后再抽签');
  const approved = approvedOf(entries, eventKey);
  if (approved.length < 2) return refused('参赛队伍不足 2 支，无法编排赛制');
  const existing = matchesOf(sessions, eventKey);
  if (event.bracket || existing.some((match) => match.winnerEntryKey)) {
    return refused('签表已经开赛，不能重新编排');
  }

  const format = event.format || MEET_FORMAT.SINGLE_ELIM;
  const entryKeys = approved.map((doc) => doc._id);
  const seeds = (Array.isArray(payload.seeds) ? payload.seeds : [])
    .map((key) => String(key).trim())
    .filter((key) => entryKeys.includes(key));
  const seed = seedOf(payload, ctx.now);

  let matches = [];
  let totalRounds = 1;
  let size = entryKeys.length;
  // 小组+淘汰的分组结果要写进 event.bracket（供后续判胜负时重算），
  // 所以声明在分支之外，不能只在分支里 const。
  let groupEntries = null;

  if (format === MEET_FORMAT.ROUND_ROBIN) {
    const rounds = roundRobinRounds(entryKeys);
    totalRounds = Math.max(1, rounds.length);
    size = entryKeys.length;
    let index = 0;
    rounds.forEach((pairs, roundIndex) => {
      for (const [a, b] of pairs) {
        index += 1;
        matches.push({
          roundNo: 1,
          index,
          entryKeys: [a, b],
          winnerEntryKey: '',
          roundLabel: `循环赛 第 ${roundIndex + 1} 轮`,
        });
      }
    });
  } else if (format === MEET_FORMAT.GROUP_KNOCKOUT) {
    // 小组+淘汰：先分组打循环，每组前 N 出线，再打单败。
    // 小组数与出线数在创建项目时就定好（event.groups），这里只负责落位。
    const groupCount = Number((event.groups && event.groups.count) || 2);
    if (groupCount * 2 > approved.length) return refused('每个小组至少需要两支队伍，请减少小组数');
    const advancePerGroup = Number((event.groups && event.groups.advancePerGroup) || 2);
    const collegeOf = new Map(approved.map((doc) => [doc._id, doc.collegeId]));
    const buckets = splitIntoGroups(entryKeys, groupCount, seeds, createSeededRandom(seed), collegeOf);
    groupEntries = {};
    buckets.forEach((keys, index) => { groupEntries[index + 1] = keys; });

    let matchIndex = 0;
    for (let group = 1; group <= groupCount; group += 1) {
      const rounds = roundRobinRounds(groupEntries[group] || []);
      rounds.forEach((pairs, roundIndex) => {
        for (const [a, b] of pairs) {
          matchIndex += 1;
          matches.push({
            roundNo: 1,
            groupIndex: group,
            stage: 'group',
            index: matchIndex,
            entryKeys: [a, b],
            winnerEntryKey: '',
            roundLabel: `${groupLabel(group)} 第 ${roundIndex + 1} 轮`,
          });
        }
      });
      matchIndex = 0; // 组内序号从 1 起，场次键用 g<组号> + 序号
    }

    // 淘汰赛签位按「小组数 × 每组出线数」准备，出线队由 recomputeBracket 填
    const slots = groupCount * advancePerGroup;
    size = bracketSizeOf(slots);
    totalRounds = bracketTotalRounds(size);
    for (let roundNo = 1; roundNo <= totalRounds; roundNo += 1) {
      const count = size / Math.pow(2, roundNo);
      for (let index = 1; index <= count; index += 1) {
        matches.push({
          roundNo,
          stage: 'knockout',
          index,
          entryKeys: [null, null],
          winnerEntryKey: '',
          roundLabel: bracketRoundLabel(roundNo, totalRounds),
        });
      }
    }
    recomputeBracket(matches, {
      totalRounds, format, groups: { count: groupCount, advancePerGroup }, groupEntries,
    });
  } else {
    let draw;
    try {
      draw = drawBracket({ entries: entryKeys, seeds, random: createSeededRandom(seed) });
    } catch (err) {
      return refused((err && err.message) || '抽签失败');
    }
    if (!draw.ok) return refused(draw.firstError || '抽签失败');
    size = draw.size;
    totalRounds = bracketTotalRounds(size);
    for (let roundNo = 1; roundNo <= totalRounds; roundNo += 1) {
      const count = size / Math.pow(2, roundNo);
      for (let index = 1; index <= count; index += 1) {
        const pair = roundNo === 1 ? draw.pairs[index - 1] : [null, null];
        matches.push({
          roundNo,
          stage: 'knockout',
          index,
          entryKeys: [pair[0], pair[1]],
          winnerEntryKey: '',
          roundLabel: bracketRoundLabel(roundNo, totalRounds),
        });
      }
    }
    // 首轮轮空直接判胜：一方是空位，不需要比赛
    for (const match of matches.filter((row) => row.roundNo === 1)) {
      const [a, b] = match.entryKeys;
      if (a && !b) match.winnerEntryKey = a;
      else if (b && !a) match.winnerEntryKey = b;
    }
    recomputeBracket(matches, totalRounds);
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!await unchanged(tx, 'sportsMeetEvents', [event])) return refused('项目数据已变化，请刷新后重试');
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以编排赛制');
    const now = toIso(fresh.now);

    for (const match of matches) {
      const round = match.stage === 'group'
        ? `g${match.groupIndex}`
        : (format === MEET_FORMAT.ROUND_ROBIN ? 'rr' : `r${match.roundNo}`);
      const key = meetSessionKey(fresh.meetId, eventKey, round, match.index);
      const current = await tx.sportsMeetSessions.getById(key);
      await tx.sportsMeetSessions.set(key, {
        ...(current || {}),
        schoolId: fresh.schoolId,
        meetId: fresh.meetId,
        eventKey,
        round,
        index: match.index,
        roundLabel: match.roundLabel,
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
        // 见 drawMeetHeats：重抽时同一主键复活
        voidedAt: null,
        startAt: (current && current.startAt) || '',
        endAt: (current && current.endAt) || '',
        venue: (current && current.venue) || '',
        note: (current && current.note) || '',
        status: (current && current.status) || 'scheduled',
        createdAt: (current && current.createdAt) || now,
        updatedAt: now,
      });
    }

    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent, revision: Number(currentEvent.revision || 0) + 1,
      bracket: {
        format,
        size,
        totalRounds,
        seed,
        drawnAt: now,
        groups: format === MEET_FORMAT.GROUP_KNOCKOUT
          ? { count: Number((event.groups && event.groups.count) || 2),
            advancePerGroup: Number((event.groups && event.groups.advancePerGroup) || 2) }
          : null,
        groupEntries: format === MEET_FORMAT.GROUP_KNOCKOUT ? groupEntries : null,
      },
      updatedAt: now,
    });
    // 编排新建/重排了整轮场次，属于赛程面变更
    await touchScheduleRevision(tx, fresh.meetId);
    return ok({
      eventKey,
      format,
      size,
      totalRounds,
      seed,
      matches: matches.map((match) => ({
        roundNo: match.roundNo,
        index: match.index,
        roundLabel: match.roundLabel,
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
        // 见 drawMeetHeats：重抽时同一主键复活
        voidedAt: null,
      })),
    });
  });
}

/**
 * 记录一场对阵的胜负，并顺着签表把胜者推上去。
 *
 * @param {Object} payload { sessionKey, winnerEntryKey }，winnerEntryKey 传空表示撤销判定
 */
async function setMeetMatchWinner(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const sessionKey = String(payload.sessionKey || '').trim();
  if (!sessionKey) return refused('请指定场次');
  // 【判权在取数之前】（2026-10-23 第三轮审查 X-5）：下面要读整届场次与项目，
  // 先答「你有没有资格」，别让未授权请求先花掉一次整表读。
  if (!canPublishMeetResult(ctx)) return refused('只有校级管理员及以上或本届总裁判可以判定胜负');
  const scope = scopeOf(ctx);

  const [session, events] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetSessions.getById(sessionKey),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
  ]);
  if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');
  // 签表只在**同一项目**内推演（2026-10-26 第五轮 B）：原来读一届全部场次，
  // 只为算出本项目那几场的前后手。eventKey 来自刚点读的场次，不信任入参。
  const sessions = await ctx.repo.forMeet(scope).sportsMeetSessions.listByProject(session.eventKey);
  if (!session.entryKeys || !session.entryKeys.some(Boolean)) {
    return refused('该场次还没有对阵双方');
  }
  const winner = String(payload.winnerEntryKey || '').trim();
  if (winner && !session.entryKeys.includes(winner)) return refused('胜者必须是本场的参赛方');

  const event = events.find((row) => row._id === session.eventKey);
  if (!event || event.scoreType !== MEET_SCORE_TYPE.VERSUS) return refused('该场次不是胜负项目的对阵');
  const bracket = event.bracket || null;
  const format = (bracket && bracket.format) || event.format || MEET_FORMAT.SINGLE_ELIM;
  let totalRounds = bracket ? Number(bracket.totalRounds) || 1 : 1;

  const matches = matchesOf(sessions, session.eventKey);
  const target = matches.find((match) => match.sessionKey === sessionKey);
  if (!target) return refused('该场次不属于任何签表轮次');
  target.winnerEntryKey = winner;
  let expandedSize = 0;
  if (format === MEET_FORMAT.GROUP_KNOCKOUT && bracket && bracket.groups) {
    const stage = groupStageStandings({groups: bracket.groupEntries, matches: matches.filter(row => row.stage === 'group')});
    if (stage.complete) {
      const count = stage.rows.filter(row => row.rank <= bracket.groups.advancePerGroup).length;
      const requiredSize = bracketSizeOf(count);
      if (requiredSize > Math.pow(2, totalRounds)) {
        // 同分全部出线时扩充签表，不能把超出预留签位的人静默丢掉。
        if (matches.some(row => row.stage !== 'group' && row.winnerEntryKey && row.entryKeys.every(Boolean))) return refused('更正会增加出线名额，请先清空淘汰赛胜负后重试');
        expandedSize = requiredSize;
        totalRounds = bracketTotalRounds(requiredSize);
        for (let roundNo = 1; roundNo <= totalRounds; roundNo += 1) {
          for (let index = 1; index <= requiredSize / Math.pow(2, roundNo); index += 1) {
            const round = 'r' + roundNo;
            const key = meetSessionKey(ctx.meetId, event._id, round, index);
            let match = matches.find(row => row.sessionKey === key);
            if (!match) {
              match = {sessionKey:key, stage:'knockout', roundNo, index, entryKeys:[null,null], winnerEntryKey:''};
              matches.push(match);
            }
            match.roundLabel = bracketRoundLabel(roundNo,totalRounds);
          }
        }
      }
    }
  }
  // 循环赛各场相互独立，没有「往上推」这回事；单败与小组+淘汰都要重算
  if (format !== MEET_FORMAT.ROUND_ROBIN) {
    recomputeBracket(matches, {
      totalRounds, format, groups: bracket && bracket.groups, groupEntries: bracket && bracket.groupEntries,
    });
  }

  const changed = [];
  for (const match of matches) {
    const previous = sessions.find((row) => row._id === match.sessionKey);
    const before = previous || {};
    const sameEntry = JSON.stringify(before.entryKeys || []) === JSON.stringify(match.entryKeys);
    if (!expandedSize && sameEntry && (before.winnerEntryKey || '') === match.winnerEntryKey) continue;
    changed.push(match);
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!await unchanged(tx, 'sportsMeetEvents', [event])) return refused('项目数据已变化，请刷新后重试');
    if (!canPublishMeetResult(fresh)) return refused('只有校级管理员及以上或本届总裁判可以判定胜负');
    const now = toIso(fresh.now);
    for (const match of changed) {
      const current = await tx.sportsMeetSessions.getById(match.sessionKey);
      await tx.sportsMeetSessions.set(match.sessionKey, {
        ...(current || {}),
        schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: event._id,
        round: match.stage === 'group' ? 'g' + match.groupIndex : (format === MEET_FORMAT.ROUND_ROBIN ? 'rr' : 'r' + match.roundNo),
        index: match.index, roundLabel: match.roundLabel,
        startAt: (current && current.startAt) || '', venue: (current && current.venue) || '',
        status: (current && current.status) || 'scheduled',
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
        // 见 drawMeetHeats：重抽时同一主键复活
        voidedAt: null,
        updatedAt: now,
      });
    }
    const champion = format === MEET_FORMAT.ROUND_ROBIN
      ? ''
      : (matches.find((match) => match.stage !== 'group'
        && match.roundNo === totalRounds && match.winnerEntryKey) || {}).winnerEntryKey || '';
    const currentEvent = await tx.sportsMeetEvents.getById(session.eventKey);
    await tx.sportsMeetEvents.set(session.eventKey, {
      ...currentEvent, revision: Number(currentEvent.revision || 0) + 1,
      ...(expandedSize ? {bracket:{...currentEvent.bracket, size:expandedSize, totalRounds}} : {}),
      championEntryKey: champion, updatedAt: now,
    });
    // 后续轮次的参赛人随胜负重排，属于赛程面变更
    await touchScheduleRevision(tx, fresh.meetId);
    return ok({
      sessionKey: sessionKey,
      winnerEntryKey: winner,
      championEntryKey: champion,
      changed: changed.length,
      expanded: Boolean(expandedSize),
    });
  });
}

/**
 * 赛制视图：签表/对阵、各自胜负、当前名次（未决出时给出还差几场）。
 *
 * @param {Object} payload { eventKey }
 */
async function getMeetBracket(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, sessions] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.listByProject(eventKey),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (event.scoreType !== MEET_SCORE_TYPE.VERSUS) return refused('该项目不是胜负项目');

  const approved = approvedOf(entries, eventKey);
  const entryKeys = approved.map((doc) => doc._id);
  const bracket = event.bracket || null;
  const format = (bracket && bracket.format) || event.format || MEET_FORMAT.SINGLE_ELIM;
  const totalRounds = bracket ? Number(bracket.totalRounds) || 1 : 1;
  const matches = matchesOf(sessions, eventKey);

  const collegeOf = new Map(approved.map((doc) => [doc._id, doc.collegeId]));
  const groupMatches = matches.filter((match) => match.stage === 'group');
  const knockoutMatches = matches.filter((match) => match.stage !== 'group');

  let rows;
  if (format === MEET_FORMAT.ROUND_ROBIN) {
    rows = roundRobinStandings({ entries: entryKeys, matches });
  } else if (format === MEET_FORMAT.GROUP_KNOCKOUT) {
    rows = groupKnockoutStandings({
      entries: entryKeys,
      groupEntries: (bracket && bracket.groupEntries) || {},
      advancePerGroup: (bracket && bracket.groups && bracket.groups.advancePerGroup) || 1,
      groupMatches,
      knockoutMatches,
      totalRounds,
    });
  } else {
    rows = bracketStandings({ entries: entryKeys, totalRounds, matches: knockoutMatches });
  }

  const groupStage = format === MEET_FORMAT.GROUP_KNOCKOUT && bracket
    ? groupStageStandings({ groups: bracket.groupEntries || {}, matches: groupMatches })
    : null;

  return ok({
    event: { eventKey, name: event.name, group: event.group, format, scored: event.scored },
    drawn: Boolean(bracket),
    totalRounds,
    groupStage: groupStage ? {
      complete: groupStage.complete,
      groups: Object.keys(bracket.groupEntries || {})
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => ({
          index: Number(key),
          label: `${String.fromCharCode(64 + Number(key))} 组`,
          entries: bracket.groupEntries[key].map((entryKey) => ({
            entryKey, collegeId: collegeOf.get(entryKey) || '',
          })),
          rows: groupStage.rows.filter((row) => row.groupIndex === Number(key)),
        })),
    } : null,
    championEntryKey: (bracket && event.championEntryKey) || '',
    matches: matches.map((match) => ({
      sessionKey: match.sessionKey,
      stage: match.stage,
      roundNo: match.roundNo,
      groupIndex: match.groupIndex,
      roundLabel: match.roundLabel || bracketRoundLabel(match.roundNo, totalRounds),
      index: match.index,
      entryKeys: match.entryKeys,
      colleges: match.entryKeys.map((key) => (key ? collegeOf.get(key) || '' : '')),
      winnerEntryKey: match.winnerEntryKey,
    })),
    complete: Boolean(rows.ok),
    message: rows.ok ? '' : rows.message,
    standings: rows.ok
      ? rows.rows.map((row) => ({ ...row, collegeId: collegeOf.get(row.entryKey) || '' }))
      : [],
  });
}

/**
 * 重抽：清空本项目的分组/签表，让管理员改完赛制再抽一次（M3）。
 *
 * 【为什么要这个动作】
 * 组数、每组人数、跑道数都是现场才知道准数的（临时发现报名 37 人、按 32 人抽了）。
 * 原先抽错之后无路可走：`setMeetEventProcedure` 拒绝改结构还提示「请先删除场次」，
 * 而没有删除场次的动作——管理员只能改库。
 *
 * 【谁能重抽】
 * 校级管理员及以上，或本届在任总裁判（与发布成绩同一档：他们最常发现抽错）。
 *
 * 【为什么不是真删】
 * 仓储只提供 set，没有 remove；直接把文档抹掉需要两边适配器一起改，收益不如风险。
 * 这里把场次标成 `voidedAt`：读取端（赛程页 / 任务列表 / 场次清单）统一过滤，
 * 重新抽签时同一个主键写回并把 `voidedAt` 清空，等于原地复活。
 *
 * 【什么情况下不许重抽】
 * 该项目已有成绩发布，或已有裁判录过分：重排会让已录的成绩对不上人。
 */
async function resetMeetDraw(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const [meet, event, sessions, publications, scores] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    // 重抽前的「有没有分过组 / 录过分」只看本项目（2026-10-26 第五轮 B）
    ctx.repo.forMeet(scope).sportsMeetSessions.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetPublications.listByProject(eventKey),
    ctx.repo.forMeet(scope).sportsMeetScores.listByProject(eventKey),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx) && !isChiefJudge(ctx, meet)) {
    return refused('只有校级管理员及以上或本届总裁判可以重排');
  }

  const own = sessions.filter((doc) => doc.eventKey === eventKey && !doc.voidedAt);
  if (own.length === 0) return refused('该项目还没有场次，先抽签');
  if (publications.some((doc) => doc.eventKey === eventKey)) {
    return refused('该项目已经发布过成绩，不能再重排');
  }
  if (scores.some((row) => row.eventKey === eventKey)) {
    return refused('该项目已有裁判录分，不能再重排');
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    if (!currentEvent) return refused('项目组别不存在或不属于本届运动会');
    if (!canManageMeet(fresh) && !isChiefJudge(fresh, await tx.sportsMeets.getById(fresh.meetId))) {
      return refused('只有校级管理员及以上或本届总裁判可以重排');
    }
    const now = toIso(fresh.now);

    for (const doc of own) {
      await tx.sportsMeetSessions.set(doc._id, {
        ...doc,
        entryKeys: [],
        winnerEntryKey: '',
        // 场次上原有的时间/场地/裁判一并作废：重抽后分组变了，原来的安排已无意义
        startAt: '', endAt: '', venue: '',
        status: 'scheduled',
        voidedAt: now,
        updatedAt: now,
      });
    }
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent,
      heatDraw: null,
      bracket: null,
      revision: Number(currentEvent.revision || 0) + 1,
      updatedAt: now,
    });
    // 重排清了时间、场地与分组，属于赛程面变更
    await touchScheduleRevision(tx, fresh.meetId);
    return ok({ eventKey, clearedSessions: own.length });
  });
}

module.exports = {
  drawMeetHeats,
  resetMeetDraw,
  advanceMeetEvent,
  drawMeetBracket,
  setMeetMatchWinner,
  getMeetBracket,
  // 纯函数导出：测试直接断言槽位重算与对阵生成
  recomputeBracket,
  roundNoOf,
  matchesOf,
};
