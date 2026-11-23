/**
 * 单场 Elo 结算服务（阶段 B）
 * ============================================================
 * 验证交接文档 §10 阶段 B 的五组要求：
 *   数学沿用、重复请求、共享选手并发、故障回滚、scope 隔离。
 * 断言的是业务结果与持久化事实（评级文档、序号计数、结算快照），
 * 不是实现细节。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const {
  decideSettlement, materializeRatings, computeSettlement, buildRatingDoc,
  displayRating, assertValidRatingDoc, buildExcludedSettlement,
  settleMatchInTransaction, participantsOf, resolveEventLevel,
} = require('../miniprogram/services/school-rating-service');
const { calculateMatchRatings, initialRatingFor } = require('../miniprogram/utils/elo');
const { memberRatingKey, ratingSeqKey, schoolMemberKey } = require('../miniprogram/utils/school');
const { RATING_POOL, SETTLEMENT_STATUS, EXCLUSION_REASON } = require('../miniprogram/utils/constants');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const NOW = new Date('2026-10-17T10:00:00Z');

/** 造一个内存仓储，预置两位男生（u01/u02）三位女生（u03–u05）。 */
function repo(seedUsers) {
  const users = ['u01', 'u02', 'u03', 'u04', 'u05'].map((id, i) => ({
    _id: id,
    gender: i < 2 ? 'M' : 'F',
    ...(seedUsers && seedUsers[id] ? seedUsers[id] : {}),
  }));
  return createSchoolMemoryRepo({ users });
}

/** 造一场单打 / 双打比赛文档（胜方已由比分推出）。 */
function matchDoc({ id, teamA, teamB, winner, pool = RATING_POOL.SINGLES, extra = {} }) {
  return {
    _id: id,
    ...SCOPE,
    matchType: pool === RATING_POOL.SINGLES ? 1 : 3,
    pool,
    teamA,
    teamB,
    scoreA: [11, 9],
    scoreB: [9, 11],
    winner,
    matchTime: '2026-10-16T02:00:00.000Z',
    status: 1,
    competition: 'personal',
    ...extra,
  };
}

/** 事务里结算并落比赛快照（模拟阶段 C 确认路径的最小闭环）。 */
async function settleWithMatch(repoRef, match, options = {}) {
  return repoRef.transaction(async (tx) => {
    const result = await settleMatchInTransaction(tx, { ...SCOPE, now: NOW }, match, options);
    if (!result.alreadySettled) {
      await tx.matches.set(match._id, { ...match, status: 1, settlement: result.settlement });
    }
    return result;
  });
}

const ratingOf = async (repoRef, userId, pool = RATING_POOL.SINGLES) =>
  repoRef.memberRatings.getById(memberRatingKey(userId, pool, SCOPE));
const counterOf = async (repoRef) => repoRef.ratingCounters.getById(ratingSeqKey(SCOPE));

describe('纯函数：结算判定', () => {
  test('弃权不计分，学院赛双打不计分，其余计分', () => {
    assert.deepEqual(decideSettlement({ outcome: 'forfeit' }),
      { rated: false, exclusionReason: EXCLUSION_REASON.FORFEIT });
    assert.deepEqual(decideSettlement({ competition: 'college', discipline: 'MD' }),
      { rated: false, exclusionReason: EXCLUSION_REASON.COLLEGE_DOUBLES });
    assert.equal(decideSettlement({ competition: 'college', discipline: 'WD' }).rated, false);
    assert.equal(decideSettlement({ competition: 'college', discipline: 'XD' }).rated, false);
    // 学院赛单打照计（D24），个人赛单双打照计
    assert.equal(decideSettlement({ competition: 'college', discipline: 'MS' }).rated, true);
    assert.equal(decideSettlement({ competition: 'personal' }).rated, true);
    assert.equal(decideSettlement({}).rated, true);
  });

  test('赛事等级优先级：match.level > event.level > 日常', () => {
    assert.equal(resolveEventLevel({ level: 1 }, { level: 2 }), 1);
    assert.equal(resolveEventLevel({}, { level: 2 }), 2);
    assert.equal(resolveEventLevel({}, null), undefined);
    assert.equal(resolveEventLevel({}, {}), undefined);
  });

  test('不计分快照：写明原因、不占序号、无选手条目', () => {
    const snapshot = buildExcludedSettlement({
      match: { _id: 'm_x', pool: 'singles' },
      exclusionReason: EXCLUSION_REASON.FORFEIT,
      settledAt: NOW,
    });
    assert.equal(snapshot.status, SETTLEMENT_STATUS.EXCLUDED);
    assert.equal(snapshot.exclusionReason, EXCLUSION_REASON.FORFEIT);
    assert.equal(snapshot.settlementSeq, null);
    assert.deepEqual(snapshot.players, []);
    assert.equal(snapshot.id, 'm_x');
    assert.throws(() => buildExcludedSettlement({ match: {}, exclusionReason: 'bogus', settledAt: NOW }));
  });

  test('人数与去重校验：1v1 / 2v2 合法，其余拒绝', () => {
    assert.throws(() => participantsOf(matchDoc({ id: 'm', teamA: ['a', 'b'], teamB: ['c'], winner: 'A' })),
      /两队人数必须相同/);
    assert.throws(() => participantsOf(matchDoc({ id: 'm', teamA: ['a', 'b', 'c'], teamB: ['d', 'e', 'f'], winner: 'A' })),
      /参赛人数不合法/);
    assert.throws(() => participantsOf(matchDoc({ id: 'm', teamA: ['a'], teamB: ['a'], winner: 'A' })),
      /不能同时出现在两队/);
    assert.throws(() => participantsOf(matchDoc({ id: 'm', teamA: [''], teamB: ['b'], winner: 'A' })),
      /参赛者编号缺失/);
  });

  test('未知评级池一律拒绝（建档 / 物化 / 计算 / 兜底同口径）', () => {
    assert.throws(() => buildRatingDoc({ userId: 'u01', pool: 'chess', scope: SCOPE, startElo: 1450 }), /未知的评级池/);
    assert.throws(() => displayRating({}, 'chess'), /未知的评级池/);
    assert.throws(() => materializeRatings({
      userIds: ['u01'], pool: 'chess', scope: SCOPE, existingByUser: new Map(), now: NOW,
    }), /未知的评级池/);
  });
});

describe('纯计算：数学沿用（与旧引擎同一公式）', () => {
  /**
   * 以 calculateMatchRatings 为「标准答案」，用同样的赛前分直接算一遍，
   * 断言新结算内核给出的每份评级更新与它逐项相等。
   */
  function runPair({ teamA, teamB, winner, eventLevel, seeds, pool = RATING_POOL.SINGLES }) {
    const match = matchDoc({ id: 'm_test', teamA, teamB, winner, pool });
    const existing = new Map(Object.entries(seeds).map(([id, s]) => [id,
      buildRatingDoc({ userId: id, pool, scope: SCOPE, startElo: s.elo, now: NOW })]));
    const view = materializeRatings({ userIds: [...teamA, ...teamB], pool, scope: SCOPE, existingByUser: existing, now: NOW });
    const { settlement, ratingDocs } = computeSettlement({
      match, eventLevel, ratingsByUser: view, seq: 1, settledAt: NOW,
    });
    const expected = calculateMatchRatings({
      teamA: teamA.map((id) => ({ rating: seeds[id].elo, matchCount: 0 })),
      teamB: teamB.map((id) => ({ rating: seeds[id].elo, matchCount: 0 })),
      winner,
      eventLevel,
    });
    return { settlement, ratingDocs, expected, teamA, teamB };
  }

  test('单打：同分与强弱胜负的 delta 与旧引擎完全一致', () => {
    const seeds = { a: { elo: 1450 }, b: { elo: 1450 } };
    const { settlement, ratingDocs, expected } = runPair({ teamA: ['a'], teamB: ['b'], winner: 'A', seeds });
    assert.equal(ratingDocs.find((r) => r.userId === 'a').doc.elo - 1450, expected.teamA[0].delta);
    assert.equal(ratingDocs.find((r) => r.userId === 'b').doc.elo - 1450, expected.teamB[0].delta);
    assert.equal(ratingDocs.find((r) => r.userId === 'a').doc.elo - 1450,
      -(ratingDocs.find((r) => r.userId === 'b').doc.elo - 1450), '零和');
    assert.equal(settlement.expectedA, expected.expectedA);

    const weak = { a: { elo: 1200 }, b: { elo: 1400 } };
    const upset = runPair({ teamA: ['a'], teamB: ['b'], winner: 'A', seeds: weak });
    assert.equal(upset.ratingDocs.find((r) => r.userId === 'a').doc.elo - 1200, upset.expected.teamA[0].delta);
    assert.ok(upset.ratingDocs.find((r) => r.userId === 'a').doc.elo - 1200 > 0, '以弱胜强收益为正');
  });

  test('双打：按队伍平均分计算，四人各自进一版，队伍 delta 零和', () => {
    const seeds = { a: { elo: 1500 }, b: { elo: 1300 }, c: { elo: 1450 }, d: { elo: 1450 } };
    const { settlement, ratingDocs, expected } = runPair({
      teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'B', seeds, pool: RATING_POOL.DOUBLES,
    });
    // ratingDocs 顺序与 players 一致：前两条 A 队、后两条 B 队
    ratingDocs.forEach((r, index) => {
      const side = index < 2 ? expected.teamA : expected.teamB;
      assert.equal(r.doc.elo - seeds[r.userId].elo, side[0].delta, `${r.userId} 的 delta`);
    });
    assert.equal(settlement.players.length, 4);
    assert.ok(settlement.players.every((p) => p.ratingVersionBefore === 0 && p.ratingVersionAfter === 1));
    assert.equal(settlement.players.reduce((acc, p) => acc + p.eloDelta, 0), 0, '零和');
  });

  test('赛事 K：一级 32 / 二级 24 / 三级与日常 16，且写进快照', () => {
    const seeds = { a: { elo: 1450 }, b: { elo: 1300 } };
    for (const [level, expectedK] of [[1, 32], [2, 24], [3, 16], [undefined, 16]]) {
      const { settlement } = runPair({ teamA: ['a'], teamB: ['b'], winner: 'A', seeds, eventLevel: level });
      assert.equal(settlement.configSnapshot.k, expectedK, `level=${level}`);
      assert.equal(settlement.configSnapshot.eventLevel, level === undefined ? null : level);
    }
  });

  test('快照结构：稳定 ID、结算序号、算法版本、参数快照与胜负标记齐全', () => {
    const seeds = { a: { elo: 1450 }, b: { elo: 1300 } };
    const { settlement } = runPair({ teamA: ['a'], teamB: ['b'], winner: 'A', seeds });
    assert.equal(settlement.id, 'm_test');
    assert.equal(settlement.status, SETTLEMENT_STATUS.RATED);
    assert.equal(settlement.algorithmVersion, 'elo-v2');
    assert.equal(settlement.settlementSeq, 1);
    assert.equal(settlement.pool, RATING_POOL.SINGLES);
    assert.ok(settlement.configSnapshot.divisor);
    assert.ok(settlement.players.every((p) => p.pool === RATING_POOL.SINGLES));
    assert.deepEqual(settlement.players.map((p) => p.isWin), [true, false]);
  });
});

describe('评级文档：初始化与冻结', () => {
  test('建档冻结 startElo 并记录来源', () => {
    const doc = buildRatingDoc({ userId: 'u01', pool: RATING_POOL.SINGLES, scope: SCOPE, startElo: 1450, now: NOW });
    assert.equal(doc.startElo, 1450);
    assert.equal(doc.elo, 1450);
    assert.equal(doc.startSource, 'gender');
    assert.equal(doc.version, 0);
    assert.equal(doc._id, memberRatingKey('u01', RATING_POOL.SINGLES, SCOPE));
    assertValidRatingDoc(doc);
  });

  test('displayRating 只读兜底，未出场用户返回性别起点且无副作用', () => {
    const male = displayRating({ gender: 'M' }, RATING_POOL.SINGLES);
    const female = displayRating({ gender: 'F' }, RATING_POOL.DOUBLES);
    assert.equal(male.elo, 1450);
    assert.equal(female.elo, 1300);
    assert.equal(female.startElo, initialRatingFor('F'));
    assert.equal(male.matchCount, 0);
  });

  test('已有评级损坏（非有限数）时拒绝结算', () => {
    assert.throws(() => assertValidRatingDoc({ elo: NaN, startElo: 1450, matchCount: 0, wins: 0, losses: 0 }), /有限数字/);
    assert.throws(() => assertValidRatingDoc({ elo: 1500, startElo: 'x', matchCount: 0, wins: 0, losses: 0 }), /startElo/);
    assert.throws(() => assertValidRatingDoc({ elo: 1500, startElo: 1450, matchCount: -1, wins: 0, losses: 0 }), /matchCount/);
  });
});

describe('事务结算（内存仓储）', () => {
  test('首场初始化：男 1450 / 女 1300，快照与计数全部落盘', async () => {
    const repoRef = repo();
    const m = matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' });
    const result = await settleWithMatch(repoRef, m);

    assert.equal(result.rated, true);
    const a = await ratingOf(repoRef, 'u01');
    const b = await ratingOf(repoRef, 'u03');
    assert.equal(a.startElo, 1450);
    assert.equal(b.startElo, 1300);
    assert.equal(a.startSource, 'gender');
    assert.equal(a.matchCount, 1);
    assert.equal(a.wins, 1);
    assert.equal(b.losses, 1);
    assert.equal(a.version, 1);
    assert.equal(a.lastSettlementSeq, 1);
    assert.equal(a.lastLedgerId, 'm1');
    assert.equal(a.lastMatchTime, '2026-10-16T02:00:00.000Z');
    assert.ok(a.lastSettledAt);

    const counter = await counterOf(repoRef);
    assert.equal(counter.seq, 1);

    // 比赛文档带上结算快照，快照的赛后分与评级表一致
    const stored = await repoRef.matches.getById('m1');
    assert.equal(stored.settlement.status, SETTLEMENT_STATUS.RATED);
    const pa = stored.settlement.players.find((p) => p.userId === 'u01');
    assert.equal(pa.eloAfter, a.elo);
    assert.equal(pa.eloAfter - pa.eloBefore, pa.eloDelta);
  });

  test('startElo 首建档冻结：其后改性别不重置已存在的评级', async () => {
    const repoRef = repo();
    await settleWithMatch(repoRef, matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' }));
    // 事后把 u03 改成男生：已存在的评级不许被重置
    await repoRef.users.set('u03', { _id: 'u03', gender: 'M' });
    const before = (await ratingOf(repoRef, 'u03')).elo;
    await settleWithMatch(repoRef, matchDoc({ id: 'm2', teamA: ['u03'], teamB: ['u01'], winner: 'B' }));
    const after = await ratingOf(repoRef, 'u03');
    assert.equal(after.startElo, 1300, 'startElo 冻结在首次建档');
    assert.equal(after.matchCount, 2);
    assert.ok(after.elo !== 1450, 'elo 继续演进而不是回到默认起点');
    assert.ok(after.elo !== before, '第二场确实改变了分数');
  });

  test('管理员预设 initialElo 只在首次建档生效', async () => {
    const repoRef = repo({ u01: { initialElo: 1600 } });
    await settleWithMatch(repoRef, matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' }));
    const doc = await ratingOf(repoRef, 'u01');
    assert.equal(doc.startElo, 1600);
    assert.equal(doc.startSource, 'preset');
  });

  test('池隔离：双打结算不建也不动单打评级，反之亦然', async () => {
    const repoRef = repo();
    await settleWithMatch(repoRef, matchDoc({
      id: 'd1', teamA: ['u01', 'u02'], teamB: ['u03', 'u04'], winner: 'A', pool: RATING_POOL.DOUBLES,
    }));
    assert.equal(await ratingOf(repoRef, 'u01', RATING_POOL.SINGLES), null, '单打评级文档不存在');
    const doubles = await ratingOf(repoRef, 'u01', RATING_POOL.DOUBLES);
    assert.equal(doubles.matchCount, 1);
    // 再打单打：双打文档纹丝不动
    await settleWithMatch(repoRef, matchDoc({ id: 's1', teamA: ['u01'], teamB: ['u03'], winner: 'B' }));
    const doublesAfter = await ratingOf(repoRef, 'u01', RATING_POOL.DOUBLES);
    assert.equal(doublesAfter.version, doubles.version);
    assert.equal(doublesAfter.elo, doubles.elo);
    assert.equal(doublesAfter.lastLedgerId, 'd1');
  });

  test('scope 隔离：跨协会各自建账；跨范围比赛直接拒绝', async () => {
    const repoRef = repo();
    const tt = { schoolId: 'muc', association: 'tt' };
    await repoRef.transaction(async (tx) => {
      await settleMatchInTransaction(tx, { ...tt, now: NOW }, {
        _id: 't1', ...tt, pool: RATING_POOL.SINGLES, teamA: ['u01'], teamB: ['u03'], winner: 'A',
        matchTime: '2026-10-16T02:00:00.000Z',
      }, {});
    });
    const pkbDoc = await repoRef.memberRatings.getById(memberRatingKey('u01', RATING_POOL.SINGLES, SCOPE));
    const ttDoc = await repoRef.memberRatings.getById(memberRatingKey('u01', RATING_POOL.SINGLES, tt));
    assert.equal(pkbDoc, null);
    assert.equal(ttDoc.association, 'tt');
    // 两个范围的序号计数互不串
    assert.equal((await repoRef.ratingCounters.getById(ratingSeqKey(tt))).seq, 1);

    await assert.rejects(
      repoRef.transaction(async (tx) => settleMatchInTransaction(tx, { ...SCOPE, now: NOW }, {
        _id: 'x1', schoolId: 'buaa', association: 'pkb', pool: RATING_POOL.SINGLES,
        teamA: ['u01'], teamB: ['u03'], winner: 'A', matchTime: '2026-10-16T02:00:00.000Z',
      }, {})),
      /不属于当前学校或协会/,
    );
  });

  test('重复结算：同一比赛只结算一次，重试返回既有结果且不再加分', async () => {
    const repoRef = repo();
    const m = matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' });
    await settleWithMatch(repoRef, m);
    const firstDoc = await ratingOf(repoRef, 'u01');
    const firstCounter = await counterOf(repoRef);

    // 重试必须从**库里**带快照的比赛发起——与「确认响应丢失后重试」同一形态
    const stored = await repoRef.matches.getById('m1');
    const again = await settleWithMatch(repoRef, stored);
    assert.equal(again.alreadySettled, true, '已带结算快照的比赛直接返回既有结果');
    assert.equal(again.settlement.settlementSeq, 1);

    const secondDoc = await ratingOf(repoRef, 'u01');
    assert.equal(secondDoc.elo, firstDoc.elo, '分数没有再变');
    assert.equal(secondDoc.matchCount, 1, '场数没有再加');
    assert.equal((await counterOf(repoRef)).seq, firstCounter.seq, '序号没有再耗');
  });

  test('共享选手并发确认两场：两场都入账，终态唯一且无丢失更新', async () => {
    const repoRef = repo();
    const m1 = matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' });
    const m2 = matchDoc({ id: 'm2', teamA: ['u01'], teamB: ['u02'], winner: 'B' });

    await Promise.all([
      settleWithMatch(repoRef, m1),
      settleWithMatch(repoRef, m2),
    ]);

    const u01 = await ratingOf(repoRef, 'u01');
    assert.equal(u01.matchCount, 2, '两场都入账');
    assert.equal(u01.version, 2);
    assert.ok([1, 2].includes(u01.lastSettlementSeq));
    const counter = await counterOf(repoRef);
    assert.equal(counter.seq, 2);
    assert.equal((await ratingOf(repoRef, 'u03')).matchCount, 1);
    assert.equal((await ratingOf(repoRef, 'u02')).matchCount, 1);

    // 终态 elo 与串行次序无关（delta 相加可交换）：按两种次序独立重算对照
    const d1 = calculateMatchRatings({
      teamA: [{ rating: 1450, matchCount: 0 }], teamB: [{ rating: 1300, matchCount: 0 }], winner: 'A',
    }).teamA[0].delta;
    const d2 = calculateMatchRatings({
      teamA: [{ rating: 1450, matchCount: 1 }], teamB: [{ rating: 1450, matchCount: 0 }], winner: 'B',
    }).teamA[0].delta;
    assert.equal(u01.elo, 1450 + d1 + d2, '两场的 delta 都没有被丢掉');
  });

  test('无共同用户的两场并发确认仍获得唯一递增序号', async () => {
    const repoRef = repo();
    await Promise.all([
      settleWithMatch(repoRef, matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u02'], winner: 'A' })),
      settleWithMatch(repoRef, matchDoc({ id: 'm2', teamA: ['u03'], teamB: ['u04'], winner: 'B' })),
    ]);
    const counter = await counterOf(repoRef);
    assert.equal(counter.seq, 2);
    const a = await ratingOf(repoRef, 'u01');
    const c = await ratingOf(repoRef, 'u03');
    assert.notEqual(a.lastSettlementSeq, c.lastSettlementSeq, '序号唯一');
    assert.deepEqual([a.lastSettlementSeq, c.lastSettlementSeq].sort(), [1, 2]);
  });

  test('故障回滚：事务中途抛错，评级 / 序号 / 比赛全部回滚', async () => {
    const repoRef = repo();
    const m = matchDoc({
      id: 'm1', teamA: ['u01', 'u02'], teamB: ['u03', 'u04'], winner: 'A', pool: RATING_POOL.DOUBLES,
    });
    await assert.rejects(repoRef.transaction(async (tx) => {
      const result = await settleMatchInTransaction(tx, { ...SCOPE, now: NOW }, m, {});
      assert.equal(result.rated, true);
      throw new Error('注入的故障：写第四名评级时炸了');
    }), /注入的故障/);

    for (const id of ['u01', 'u02', 'u03', 'u04']) {
      assert.equal(await ratingOf(repoRef, id, RATING_POOL.DOUBLES), null, `${id} 的评级没有留下半份`);
    }
    assert.equal(await counterOf(repoRef), null, '序号计数也回滚');
    assert.equal(await repoRef.matches.getById('m1'), null, '比赛文档没写');
  });

  test('弃权路径：不计分、不占序号、不建评级，但快照写明原因', async () => {
    const repoRef = repo();
    const m = matchDoc({
      id: 'f1', teamA: ['u01'], teamB: ['u03'], winner: 'B',
      extra: { outcome: 'forfeit', scoreA: [], scoreB: [] },
    });
    const result = await settleWithMatch(repoRef, m);
    assert.equal(result.rated, false);
    assert.equal(result.settlement.status, SETTLEMENT_STATUS.EXCLUDED);
    assert.equal(result.settlement.exclusionReason, EXCLUSION_REASON.FORFEIT);
    assert.equal(await ratingOf(repoRef, 'u01'), null);
    assert.equal(await counterOf(repoRef), null, '不计分不消耗序号');
  });

  test('补录旧比赛：按当前序号入链，lastMatchTime 不倒退，旧快照不动', async () => {
    const repoRef = repo();
    await settleWithMatch(repoRef, matchDoc({
      id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A',
      extra: { matchTime: '2026-10-16T02:00:00.000Z' },
    }));
    // 补录一场更早日期的比赛
    await settleWithMatch(repoRef, matchDoc({
      id: 'm2', teamA: ['u01'], teamB: ['u02'], winner: 'A',
      extra: { matchTime: '2026-10-01T02:00:00.000Z' },
    }));
    const u01 = await ratingOf(repoRef, 'u01');
    assert.equal(u01.lastMatchTime, '2026-10-16T02:00:00.000Z', '活跃时间没有倒退');
    assert.equal(u01.lastSettlementSeq, 2, '补录按当前结算位置入链');
    const stored = await repoRef.matches.getById('m1');
    assert.equal(stored.settlement.settlementSeq, 1, '已结算快照不被补录改写');
  });
});

test('管理员按协会设置的 initialEloByAssoc 优先于旧的全局 initialElo', async () => {
  const repoRef = repo({ u01: { initialElo: 1600 } });
  const key = schoolMemberKey('u01', 'muc');
  await repoRef.schoolMembers.set(key, { _id: key, schoolId: 'muc', userId: 'u01',
    initialEloByAssoc: { pkb: 1700 } });
  await settleWithMatch(repoRef, matchDoc({ id: 'm1', teamA: ['u01'], teamB: ['u03'], winner: 'A' }));
  const doc = await ratingOf(repoRef, 'u01');
  assert.equal(doc.startElo, 1700);
  assert.equal(doc.startSource, 'preset');
});
