/**
 * 个人战绩统计 单元测试
 *
 * 这些统计会直接出现在「我的」页面上给会员看，算错一次就会被人当场发现，
 * 所以重点验证：双打对手/搭档的拆解口径、时间倒序、以及在数据缺失时的健壮性。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  viewMatch,
  findPlayerMatches,
  createNameResolver,
  buildHeadToHead,
  buildPartnerRecord,
  buildMatchHistory,
  buildRatingHistory,
  buildEventRecord,
  summarizeEvents,
  summarizeForm,
} = require('../src/shared/utils/stats.js');

const { generateSeed } = require('../miniprogram/services/seed.js');
const { materializeRatings, computeSettlement, displayRating } = require('../src/server/services/school-rating-service.js');
const { memberRatingKey } = require('../src/shared/utils/school.js');
const { MATCH_TYPE, MATCH_STATUS, RATING_POOL } = require('../src/shared/utils/constants.js');

const day = (n) => new Date(`2026-05-${String(n).padStart(2, '0')}T18:00:00`);

/** 构造一场带 players 明细的比赛 */
function playedMatch({ id, teamA, teamB, winner, d, pool = RATING_POOL.DOUBLES, matchType = MATCH_TYPE.DOUBLES, deltas = {}, eventId = null }) {
  const players = [];
  const collect = (team, side) => {
    for (const userId of team) {
      players.push({
        userId,
        side,
        pool,
        isWin: winner === side,
        eloBefore: 1500,
        eloAfter: 1500 + (deltas[userId] || 0),
        eloDelta: deltas[userId] || 0,
        pointDelta: winner === side ? 3 : 1,
      });
    }
  };
  collect(teamA, 'A');
  collect(teamB, 'B');

  return {
    _id: id,
    matchType,
    pool,
    teamA,
    teamB,
    winner,
    scoreA: [11, 11],
    scoreB: [7, 9],
    matchTime: day(d),
    eventId,
    location: '学校体育馆 1 号场',
    players,
  };
}

describe('viewMatch —— 单场视角', () => {
  const match = playedMatch({
    id: 'm1',
    teamA: ['a', 'b'],
    teamB: ['c', 'd'],
    winner: 'A',
    d: 1,
    deltas: { a: 16, b: 16, c: -16, d: -16 },
  });

  test('拆出我方与对方，且不把自己算进搭档或对手', () => {
    const view = viewMatch(match, 'a');
    assert.deepEqual(view.partnerIds, ['b']);
    assert.deepEqual(view.opponentIds, ['c', 'd']);
  });

  test('在 B 队时搭档与对手同样正确', () => {
    const view = viewMatch(match, 'c');
    assert.equal(view.side, 'B');
    assert.equal(view.isWin, false);
    assert.deepEqual(view.partnerIds, ['d']);
    assert.deepEqual(view.opponentIds, ['a', 'b']);
  });

  test('比分统一成「我方 : 对方」，不必再关心 A/B', () => {
    assert.deepEqual(viewMatch(match, 'a').score, { mine: [11, 11], theirs: [7, 9] });
    assert.deepEqual(viewMatch(match, 'c').score, { mine: [7, 9], theirs: [11, 11] });
  });

  test('带出本场的分数与积分变动', () => {
    const view = viewMatch(match, 'a');
    assert.equal(view.eloBefore, 1500);
    assert.equal(view.eloAfter, 1516);
    assert.equal(view.eloDelta, 16);
    assert.equal(view.pointDelta, 3);
  });

  test('没参加这场比赛时返回 null', () => {
    assert.equal(viewMatch(match, 'ghost'), null);
  });

  test('没有 players 明细的老数据也能判断胜负', () => {
    const legacy = {
      _id: 'old',
      matchType: MATCH_TYPE.SINGLES,
      pool: RATING_POOL.SINGLES,
      teamA: ['a'],
      teamB: ['b'],
      winner: 'B',
      scoreA: [5],
      scoreB: [11],
      matchTime: day(1),
    };
    const view = viewMatch(legacy, 'a');
    assert.equal(view.isWin, false);
    assert.equal(view.eloDelta, null);
    assert.deepEqual(view.opponentIds, ['b']);
  });

  test('传入 null 时安全返回', () => {
    assert.equal(viewMatch(null, 'a'), null);
  });
});

describe('findPlayerMatches —— 筛选参赛记录', () => {
  test('只保留该会员参加过的比赛', () => {
    const matches = [
      playedMatch({ id: 'm1', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 1 }),
      playedMatch({ id: 'm2', teamA: ['c', 'd'], teamB: ['e', 'f'], winner: 'A', d: 2 }),
    ];
    assert.deepEqual(findPlayerMatches(matches, 'a').map((v) => v.matchId), ['m1']);
  });

  test('传入非数组时抛出错误', () => {
    assert.throws(() => findPlayerMatches(null, 'a'), /matches 必须是数组/);
  });
});

describe('createNameResolver —— 编号转昵称', () => {
  test('能查到昵称', () => {
    const resolve = createNameResolver([{ _id: 'a', nickName: '张三' }]);
    assert.equal(resolve('a'), '张三');
  });

  test('查不到时原样返回编号，而不是 undefined', () => {
    assert.equal(createNameResolver([])('ghost'), 'ghost');
  });

  test('缺少昵称字段时退回编号', () => {
    assert.equal(createNameResolver([{ _id: 'a' }])('a'), 'a');
  });

  test('传入 null 也不报错', () => {
    assert.equal(createNameResolver(null)('a'), 'a');
  });
});

describe('buildHeadToHead —— 交锋记录', () => {
  // a 与 c、d 交手两场，一胜一负
  const matches = [
    playedMatch({ id: 'm1', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 1 }),
    playedMatch({ id: 'm2', teamA: ['c', 'd'], teamB: ['a', 'b'], winner: 'A', d: 2 }),
  ];

  test('双打中两位对手各记一次', () => {
    const table = buildHeadToHead(matches, 'a');
    assert.deepEqual(table.map((r) => r.opponentId).sort(), ['c', 'd']);
    for (const row of table) assert.equal(row.matchCount, 2);
  });

  test('胜负统计正确', () => {
    const row = buildHeadToHead(matches, 'a')[0];
    assert.equal(row.wins, 1);
    assert.equal(row.losses, 1);
    assert.equal(row.winRate, 0.5);
  });

  test('累计与该对手交手时的分数变动', () => {
    const singles = [
      playedMatch({
        id: 's1', teamA: ['a'], teamB: ['b'], winner: 'A', d: 1,
        pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
        deltas: { a: 20, b: -20 },
      }),
      playedMatch({
        id: 's2', teamA: ['a'], teamB: ['b'], winner: 'B', d: 2,
        pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
        deltas: { a: -8, b: 8 },
      }),
    ];
    const row = buildHeadToHead(singles, 'a')[0];
    assert.equal(row.eloDeltaSum, 12); // +20 - 8
  });

  test('记录最近一次交手的时间', () => {
    const row = buildHeadToHead(matches, 'a')[0];
    assert.deepEqual(row.lastMatchTime, day(2));
  });

  test('可按最少场次过滤', () => {
    const withOneOff = [
      ...matches,
      playedMatch({ id: 'm3', teamA: ['a', 'b'], teamB: ['e', 'f'], winner: 'A', d: 3 }),
    ];
    const table = buildHeadToHead(withOneOff, 'a', { minMatches: 2 });
    assert.deepEqual(table.map((r) => r.opponentId).sort(), ['c', 'd']);
  });

  test('按交手场次降序排列', () => {
    const withOneOff = [
      ...matches,
      playedMatch({ id: 'm3', teamA: ['a', 'b'], teamB: ['e', 'f'], winner: 'A', d: 3 }),
    ];
    const table = buildHeadToHead(withOneOff, 'a');
    // 交手两次的 c、d 排在只交手一次的 e、f 前面
    assert.deepEqual(table.map((r) => r.matchCount), [2, 2, 1, 1]);
  });

  test('可以解析出对手昵称', () => {
    const nameOf = createNameResolver([
      { _id: 'c', nickName: '李四' },
      { _id: 'd', nickName: '王五' },
    ]);
    const table = buildHeadToHead(matches, 'a', { nameOf });
    assert.ok(table.every((r) => r.nickName !== r.opponentId));
  });

  test('没有参赛记录时返回空数组', () => {
    assert.deepEqual(buildHeadToHead(matches, 'ghost'), []);
  });

  test('不修改传入的数组', () => {
    const input = [...matches];
    buildHeadToHead(input, 'a');
    assert.deepEqual(input.map((m) => m._id), ['m1', 'm2']);
  });
});

describe('buildPartnerRecord —— 搭档记录', () => {
  test('统计双打搭档的合作战绩', () => {
    const matches = [
      playedMatch({ id: 'm1', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 1 }),
      playedMatch({ id: 'm2', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'B', d: 2 }),
      playedMatch({ id: 'm3', teamA: ['a', 'e'], teamB: ['c', 'd'], winner: 'A', d: 3 }),
    ];
    const table = buildPartnerRecord(matches, 'a');
    const b = table.find((r) => r.partnerId === 'b');
    const e = table.find((r) => r.partnerId === 'e');
    assert.equal(b.matchCount, 2);
    assert.equal(b.winRate, 0.5);
    assert.equal(e.matchCount, 1);
    assert.equal(e.winRate, 1);
  });

  test('单打不产生搭档记录', () => {
    const singles = [
      playedMatch({
        id: 's1', teamA: ['a'], teamB: ['b'], winner: 'A', d: 1,
        pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
      }),
    ];
    assert.deepEqual(buildPartnerRecord(singles, 'a'), []);
  });

  test('按合作场次降序排列', () => {
    const matches = [
      playedMatch({ id: 'm1', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 1 }),
      playedMatch({ id: 'm2', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 2 }),
      playedMatch({ id: 'm3', teamA: ['a', 'e'], teamB: ['c', 'd'], winner: 'A', d: 3 }),
    ];
    assert.deepEqual(buildPartnerRecord(matches, 'a').map((r) => r.partnerId), ['b', 'e']);
  });
});

describe('buildMatchHistory —— 逐场明细', () => {
  const matches = [
    playedMatch({ id: 'm1', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 1 }),
    playedMatch({ id: 'm2', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'B', d: 5 }),
    playedMatch({
      id: 'm3', teamA: ['a'], teamB: ['c'], winner: 'A', d: 3,
      pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
    }),
  ];

  test('最近的排在最前面', () => {
    assert.deepEqual(buildMatchHistory(matches, 'a').map((h) => h.matchId), ['m2', 'm3', 'm1']);
  });

  test('附带搭档与对手的昵称', () => {
    const nameOf = createNameResolver([
      { _id: 'a', nickName: '我' },
      { _id: 'b', nickName: '队友' },
      { _id: 'c', nickName: '对手一' },
      { _id: 'd', nickName: '对手二' },
    ]);
    const [latest] = buildMatchHistory(matches, 'a', { nameOf });
    assert.deepEqual(latest.partnerNames, ['队友']);
    assert.deepEqual(latest.opponentNames, ['对手一', '对手二']);
  });

  test('支持限制条数', () => {
    assert.equal(buildMatchHistory(matches, 'a', { limit: 2 }).length, 2);
  });

  test('支持只看某个池', () => {
    const history = buildMatchHistory(matches, 'a', { pool: RATING_POOL.SINGLES });
    assert.deepEqual(history.map((h) => h.matchId), ['m3']);
  });

  test('不修改传入的数组顺序', () => {
    const input = [...matches];
    buildMatchHistory(input, 'a');
    assert.deepEqual(input.map((m) => m._id), ['m1', 'm2', 'm3']);
  });
});

describe('buildRatingHistory —— 分数曲线', () => {
  const matches = [
    playedMatch({
      id: 's1', teamA: ['a'], teamB: ['b'], winner: 'A', d: 3,
      pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
      deltas: { a: 16, b: -16 },
    }),
    playedMatch({
      id: 's2', teamA: ['a'], teamB: ['b'], winner: 'A', d: 1,
      pool: RATING_POOL.SINGLES, matchType: MATCH_TYPE.SINGLES,
      deltas: { a: 12, b: -12 },
    }),
    playedMatch({ id: 'dm', teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', d: 2 }),
  ];

  test('按时间升序排列（画折线图必须如此）', () => {
    const curve = buildRatingHistory(matches, 'a', RATING_POOL.SINGLES);
    assert.deepEqual(curve.map((p) => p.matchId), ['s2', 's1']);
  });

  test('只包含指定池的比赛', () => {
    assert.equal(buildRatingHistory(matches, 'a', RATING_POOL.DOUBLES).length, 1);
  });

  test('每个点带着赛前分、赛后分与变动量', () => {
    const [point] = buildRatingHistory(matches, 'a', RATING_POOL.SINGLES);
    assert.equal(point.eloBefore, 1500);
    assert.equal(point.eloAfter, 1512);
    assert.equal(point.eloDelta, 12);
    assert.equal(point.isWin, true);
  });

  test('缺少分数明细的比赛会被跳过', () => {
    const legacy = {
      _id: 'old',
      matchType: MATCH_TYPE.SINGLES,
      pool: RATING_POOL.SINGLES,
      teamA: ['a'],
      teamB: ['b'],
      winner: 'A',
      scoreA: [11],
      scoreB: [5],
      matchTime: day(9),
    };
    const curve = buildRatingHistory([...matches, legacy], 'a', RATING_POOL.SINGLES);
    assert.ok(!curve.some((p) => p.matchId === 'old'));
  });

  test('传入未知的池时抛出错误', () => {
    assert.throws(() => buildRatingHistory(matches, 'a', 'mixed_doubles'), /未知的等级分池/);
  });
});

describe('buildEventRecord —— 赛事名次', () => {
  const events = [
    {
      _id: 'e01',
      title: '4月男子单打赛',
      matchType: MATCH_TYPE.SINGLES,
      pool: RATING_POOL.SINGLES,
      location: '学校体育馆 1 号场',
      startTime: day(1),
      results: [
        { userId: 'a', placement: 1 },
        { userId: 'b', placement: 2 },
        { userId: 'c', placement: 3 },
        { userId: 'd', placement: 3 },
        { userId: 'e', placement: 5 },
      ],
    },
    {
      _id: 'e02',
      title: '5月双打赛',
      matchType: MATCH_TYPE.DOUBLES,
      pool: RATING_POOL.DOUBLES,
      startTime: day(20),
      results: [
        { userId: 'a', placement: 3 },
        { userId: 'b', placement: 1 },
      ],
    },
    {
      _id: 'e03',
      title: '6月男子单打赛',
      matchType: MATCH_TYPE.SINGLES,
      pool: RATING_POOL.SINGLES,
      startTime: day(25),
      results: [{ userId: 'z', placement: 1 }],
    },
  ];

  test('只保留该会员参加过的赛事', () => {
    assert.deepEqual(buildEventRecord(events, 'a').map((r) => r.eventId), ['e02', 'e01']);
  });

  test('最近的赛事排在最前面', () => {
    assert.deepEqual(buildEventRecord(events, 'b').map((r) => r.eventId), ['e02', 'e01']);
  });

  test('带出名次与参赛规模', () => {
    const [latest] = buildEventRecord(events, 'a');
    assert.equal(latest.placement, 3);
    assert.equal(latest.participantCount, 2);
    assert.equal(latest.title, '5月双打赛');
  });

  test('没参加任何赛事时返回空数组', () => {
    assert.deepEqual(buildEventRecord(events, 'ghost'), []);
  });

  test('传入 null 时安全返回', () => {
    assert.deepEqual(buildEventRecord(null, 'a'), []);
  });
});

describe('summarizeEvents —— 名次汇总', () => {
  test('统计参赛数、冠军数与前三数', () => {
    const records = [
      { placement: 1 }, { placement: 3 }, { placement: 2 }, { placement: 5 },
    ];
    assert.deepEqual(summarizeEvents(records), {
      eventCount: 4,
      championCount: 1,
      topThreeCount: 3,
      bestPlacement: 1,
    });
  });

  test('最佳名次取最小值', () => {
    assert.equal(summarizeEvents([{ placement: 5 }, { placement: 3 }]).bestPlacement, 3);
  });

  test('空列表时最佳名次为 null 而不是 Infinity', () => {
    assert.deepEqual(summarizeEvents([]), {
      eventCount: 0,
      championCount: 0,
      topThreeCount: 0,
      bestPlacement: null,
    });
  });

  test('传入非数组时安全返回', () => {
    assert.equal(summarizeEvents(null).eventCount, 0);
  });
});

describe('summarizeForm —— 近期状态', () => {
  const build = (...results) =>
    results.map((isWin, i) =>
      playedMatch({
        id: 'f' + i,
        teamA: isWin ? ['a'] : ['b'],
        teamB: isWin ? ['b'] : ['a'],
        winner: isWin ? 'A' : 'A',
        d: i + 1,
        pool: RATING_POOL.SINGLES,
        matchType: MATCH_TYPE.SINGLES,
      })
    );

  test('按时间倒序取最近若干场', () => {
    const matches = build(true, false, true);
    // 三场时间分别为 1、2、3 号，倒序即 第3场(胜)、第2场(负)、第1场(胜)
    const form = summarizeForm(matches, 'a', { limit: 3 });
    assert.deepEqual(form.results, [true, false, true]);
  });

  test('默认取最近 5 场', () => {
    const matches = build(true, true, true, true, true, true, true);
    assert.equal(summarizeForm(matches, 'a').results.length, 5);
  });

  test('统计近期胜负场数', () => {
    const matches = build(true, true, false, true, false);
    const form = summarizeForm(matches, 'a', { limit: 5 });
    assert.equal(form.wins, 3);
    assert.equal(form.losses, 2);
  });

  test('当前连胜从最近一场开始数，遇负即停', () => {
    const matches = build(true, false, false, true, true);
    // 倒序：第5场(胜)、第4场(胜)、第3场(负)  → 连胜 2
    assert.equal(summarizeForm(matches, 'a', { limit: 5 }).streak, 2);
  });

  test('最近一场失利时连胜为 0', () => {
    // build 的入参按时间先后排列，最后一个参数才是最「近」的一场
    const matches = build(true, true, false);
    assert.equal(summarizeForm(matches, 'a', { limit: 5 }).streak, 0);
  });

  test('连胜超过 limit 时不被截断：7 连胜配 limit=5 仍是 7', () => {
    const matches = build(true, true, true, true, true, true, true);
    const form = summarizeForm(matches, 'a', { limit: 5 });
    assert.equal(form.results.length, 5, '展示序列仍只取最近 5 场');
    assert.equal(form.streak, 7, '连胜要数到底，不能只在截断后的序列里数');
  });
});

describe('统计真实模拟数据 —— 端到端', () => {
  const seed = generateSeed({ weeks: 8, casualPerWeek: 10 });
  // 逐场结算内核只吃已分出胜负的比赛（旧回放同口径）
  const SCOPE = { schoolId: 'muc', association: 'pkb' };
  const ordered = seed.matches
    .filter((m) => m.status !== MATCH_STATUS.PENDING && m.winner)
    .sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));
  const ratings = new Map();
  let seq = 0;
  const settledMatches = ordered.map((match) => {
    seq += 1;
    const userIds = [...new Set([...match.teamA, ...match.teamB])];
    const existingByUser = new Map();
    const startEloByUser = new Map();
    for (const userId of userIds) {
      const key = memberRatingKey(userId, match.pool, SCOPE);
      const current = ratings.get(key);
      if (current) existingByUser.set(userId, current);
      else {
        const member = seed.members.find((m) => m._id === userId);
        startEloByUser.set(userId, { gender: member && member.gender });
      }
    }
    const view = materializeRatings({
      userIds, pool: match.pool, scope: SCOPE, existingByUser, startEloByUser, now: match.matchTime,
    });
    const { settlement, ratingDocs } = computeSettlement({
      match, eventLevel: undefined, ratingsByUser: view, seq, settledAt: match.matchTime,
    });
    for (const { doc } of ratingDocs) ratings.set(doc._id, doc);
    return { ...match, settlement, players: settlement.players.map((p) => ({ ...p, pointDelta: 0 })) };
  });
  // 视图会员：评级表（缺档 displayRating 兜底），与 school-rank-service.loadScopeView 同构
  const users = seed.members.map((member) => ({
    ...member,
    status: 1,
    points: 0,
    ratings: ['singles', 'doubles'].reduce((acc, pool) => {
      acc[pool] = ratings.get(memberRatingKey(member._id, pool, SCOPE)) || displayRating(member, pool);
      return acc;
    }, {}),
  }));
  const target = users[0];
  const matches = settledMatches;
  const nameOf = createNameResolver(users);

  test('每位会员的逐场明细条数等于其总场次', () => {
    for (const user of users.slice(0, 5)) {
      const history = buildMatchHistory(matches, user._id);
      const total = [
        RATING_POOL.SINGLES,
        RATING_POOL.DOUBLES,
      ].reduce((sum, pool) => sum + history.filter((h) => h.pool === pool).length, 0);
      assert.equal(history.length, total);
    }
  });

  test('交锋记录里不会把自己列为对手', () => {
    const table = buildHeadToHead(matches, target._id, { nameOf });
    assert.ok(!table.some((r) => r.opponentId === target._id));
  });

  test('每个对手的胜负之和等于交手场次', () => {
    const table = buildHeadToHead(matches, target._id, { nameOf });
    for (const row of table) {
      assert.equal(row.wins + row.losses, row.matchCount);
    }
  });

  test('每个池的胜场数与该池的历史胜负一致', () => {
    for (const pool of [RATING_POOL.SINGLES, RATING_POOL.DOUBLES]) {
      const wins = buildMatchHistory(matches, target._id, { pool }).filter((h) => h.isWin).length;
      const recorded = target.ratings[pool].wins;
      assert.equal(wins, recorded, `${pool} 的胜场数对不上`);
    }
  });
});
