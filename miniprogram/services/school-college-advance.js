/**
 * 学校维度：学院赛小场出结果后的大场推进（协议 2，M2-c2）
 * ============================================================
 * 与云端 `core/college-advance.js` 同一把尺子，只把数据边界换成 S2 仓储：
 *   · 大场是 `ties` 里带 `schoolId + association` 的记录（见 school-college-service）；
 *   · 小场是 `matches` 里 `competition = college`、带 `tieId + legNo` 的记录；
 *   · 汇总 / 晋级全部复用纯模块 `college-tie.js`（legResultOf / summarizeTie /
 *     nextRoundPairsOf / buildTiesForRound），一行规则都不重写。
 *
 * 【为什么不进处理器注册表】这里没有对应 action——它是 confirm / forfeit
 * 收尾时调用的内部步骤。混进处理器模块的公开导出里，客户端就能凭函数名直接调它
 * （参数对不上，只会得到一个难查的报错）。云端为此单列一个 core 文件，此处同。
 *
 * 【为什么下一轮在事务之间算】S2 仓储与云端同一条纪律：事务内禁止整表查询。所以
 * 「取本赛事全部大场 → 推下一轮对阵」放在两次事务之间：第一次事务把小场结果写回
 * 大场，事务外算出下一轮对阵，第二次事务「只补不覆盖」地插入。多算一次是安全的。
 *
 * 【为什么小场写回要在事务内重读大场】`legs` 是整份数组的一次整体写入。若拿事务外
 * 的快照去算，同一大场两场小项几乎同时确认时，后写的会把先写的冲掉——大场永远差
 * 一场，晋级名单也排不出来。重读后在事务里合并，两次写入才串成一条链。
 * ============================================================
 */

const { legResultOf, summarizeTie, nextRoundPairsOf, buildTiesForRound } = require('./college-tie.js');
const { belongsToSchoolScope } = require('../utils/school.js');
const { TIE_STATUS, MATCH_COMPETITION, COLLEGE_EVENT_STATUS } = require('../utils/constants.js');

const iso = value => new Date(value).toISOString();
const isLegMatch = doc => Boolean(doc && doc.competition === MATCH_COMPETITION.COLLEGE && doc.tieId);
const belongsTo = (doc, ctx) => Boolean(doc) && belongsToSchoolScope(doc, ctx);

/**
 * 小场有了结果之后：写回大场、定出大场胜负，并在本轮打完时排出下一轮。
 *
 * 只在比赛确认（confirmSchoolMatch）或记弃权（forfeitSchoolMatch）之后调用，
 * 此时台账已是最终态；小场经 `submitScheduledMatch` 补录、对手确认后转 ACTIVE。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 刚生效的小场记录（matches 原始文档）
 * @returns {Promise<{tiePatch:Object, nextTies:Array}|null>}
 */
async function advanceCollegeAfterLeg(ctx, legMatch) {
  if (!isLegMatch(legMatch)) return null;

  // 先取一次只为拿 eventId；小项本身要在事务里重读（见文件头注）。
  const snapshot = await ctx.repo.ties.getById(legMatch.tieId);
  if (!belongsTo(snapshot, ctx)) return null;
  const event = await ctx.repo.collegeEvents.getById(snapshot.eventId);
  if (!belongsTo(event, ctx) || event.status === COLLEGE_EVENT_STATUS.FINISHED) return null;

  let tiePatch = null;
  await ctx.repo.transaction(async tx => {
    const freshEvent = await tx.collegeEvents.getById(snapshot.eventId);
    if (!belongsTo(freshEvent, ctx) || freshEvent.status === COLLEGE_EVENT_STATUS.FINISHED) return;
    const tie = await tx.ties.getById(legMatch.tieId);
    if (!tie) return;

    const legs = (Array.isArray(tie.legs) ? tie.legs : []).map(leg =>
      Number(leg.legNo) === Number(legMatch.legNo) ? { ...leg, ...legResultOf(tie, legMatch) } : leg);
    const summary = summarizeTie({ tie: { ...tie, legs }, event });

    tiePatch = { legs };
    // 未决（净胜两套都平）不算结束：留在进行中等管理员处理，不记假胜者
    if (summary.complete && summary.winnerSide) {
      tiePatch.status = TIE_STATUS.FINISHED;
      tiePatch.winner = summary.winner;
      tiePatch.finishedAt = ctx.now;
    }
    await tx.ties.set(tie._id, { ...tie, ...tiePatch,
      revision: Number(tie.revision || 1) + 1, updatedAt: iso(ctx.now) });
  });

  if (!tiePatch || !tiePatch.winner) return { tiePatch: tiePatch || {}, nextTies: [] };

  // 下一轮的对阵要在事务外算（事务里不能按赛事条件读大场）。插入仍走「只补不覆盖」，
  // 所以这里多算一次是安全的。
  const allTies = (await ctx.repo.forScope(ctx).ties.list())
    .filter(item => item.eventId === snapshot.eventId);
  const merged = allTies.map(item => (item._id === snapshot._id ? { ...item, ...tiePatch } : item));
  const pairs = nextRoundPairsOf({ draw: event.draw, ties: merged, round: snapshot.round });
  const drafts = pairs.length > 0
    ? buildTiesForRound({ event, round: Number(snapshot.round) + 1, pairs })
    : [];

  const nextTies = [];
  if (drafts.length > 0) {
    const nowIso = iso(ctx.now);
    await ctx.repo.transaction(async tx => {
      for (const draft of drafts) {
        const existing = await tx.ties.getById(draft._id);
        if (existing) continue; // 排过的轮次不覆盖
        const doc = { ...draft, schoolId: ctx.schoolId, association: ctx.association,
          revision: 1, updatedAt: nowIso };
        await tx.ties.set(draft._id, doc);
        nextTies.push(doc);
      }
    });
  }

  return { tiePatch, nextTies };
}

module.exports = { advanceCollegeAfterLeg };
