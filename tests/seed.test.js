/**
 * 模拟数据生成器 单元测试
 *
 * 重点验证生成的流水「讲得通」：时间有序、人不会在入会前出场、
 * 比分符合匹克球规则、赛事名次覆盖全部参赛者。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SEED,
  MEMBER_SEED,
  generateSeed,
  generateGameScore,
  generateMatchScore,
  winProbability,
  simulateBracket,
} = require('../src/mock/seed.js');

const { createSeededRandom } = require('../src/shared/utils/random.js');
// 种子里的场号必须与这个分配函数算出来的完全一致，测试直接重算一遍比对
const { planCourts } = require('../src/shared/services/court.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  RATING_POOL,
  EVENT_STATUS,
  SIGNUP_STATUS,
  COURT_LIMITS,
} = require('../src/shared/utils/constants.js');
const {
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  BEST_OF_LABEL,
  gamesToWin,
  validateMatchScore,
} = require('../src/shared/utils/match-format.js');

/** 生成一份较小规模的数据，加快测试速度 */
const smallSeed = (options = {}) => generateSeed({ weeks: 4, casualPerWeek: 6, ...options });

/**
 * 取已结束的赛事。
 * 种子里会留一场「进行中」的赛事供演示用，它没有名次、也没打完，
 * 因此凡是「赛事应当有完整结果」的断言都必须先把它排除在外。
 */
const finishedOf = (data) => data.events.filter((event) => event.status === EVENT_STATUS.FINISHED);

/**
 * 已经打完的比赛。
 * 演示赛事里的半决赛排好了签位却还没开打，状态是「待确认」：没有比分、
 * 没有胜方，凡是要核对比分自洽的断言都得跳过它们。
 */
const playedOf = (data) => data.matches.filter((match) => match.status !== MATCH_STATUS.PENDING);

describe('generateSeed —— 可复现性', () => {
  test('相同种子生成的数据完全一致', () => {
    const a = smallSeed();
    const b = smallSeed();
    assert.deepEqual(a.matches, b.matches);
    assert.deepEqual(a.members, b.members);
    assert.deepEqual(a.events, b.events);
  });

  test('不同种子生成不同的比赛流水', () => {
    const a = smallSeed({ seed: 1 });
    const b = smallSeed({ seed: 2 });
    assert.notDeepEqual(a.matches, b.matches);
  });

  test('默认种子是一个固定值，不随时间变化', () => {
    assert.equal(typeof DEFAULT_SEED, 'number');
    const data = generateSeed({ weeks: 1, casualPerWeek: 1 });
    assert.equal(data.meta.seed, DEFAULT_SEED);
  });
});

describe('generateSeed —— 会员数据', () => {
  test('会员数量与种子名单一致', () => {
    const data = smallSeed();
    assert.equal(data.members.length, MEMBER_SEED.length);
  });

  test('会员编号唯一且连续', () => {
    const data = smallSeed();
    const ids = data.members.map((m) => m._id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], 'u01');
  });

  test('每场比赛的参赛者都能在会员名单里找到', () => {
    const data = smallSeed();
    const ids = new Set(data.members.map((m) => m._id));
    for (const match of data.matches) {
      for (const id of [...match.teamA, ...match.teamB]) {
        assert.ok(ids.has(id), `比赛 ${match._id} 引用了不存在的会员 ${id}`);
      }
    }
  });

  test('每位会员都带合法的性别字段，且与种子名单一致', () => {
    const data = smallSeed();
    for (let i = 0; i < data.members.length; i += 1) {
      assert.ok(
        data.members[i].gender === 'M' || data.members[i].gender === 'F',
        `会员 ${data.members[i].nickName} 的性别 ${data.members[i].gender} 不合法`
      );
      assert.equal(data.members[i].gender, MEMBER_SEED[i].gender);
    }
    // 男女都有人，否则「合并成一个单打池」的设定失去了比较对象
    assert.ok(data.members.some((m) => m.gender === 'M'));
    assert.ok(data.members.some((m) => m.gender === 'F'));
  });
});

describe('generateSeed —— 入会时间的约束', () => {
  test('会员不会出现在入会之前的比赛里', () => {
    // 这是模拟数据最容易出洋相的地方：一个第 10 周才入会的人，
    // 却在第 2 周就有了战绩，一眼就能看穿数据是编的。
    const data = generateSeed();
    const joinWeek = {};
    for (const member of data.members) joinWeek[member._id] = member.joinWeek;

    const base = new Date('2026-04-06T18:00:00');
    const WEEK_MS = 7 * 86400000;

    let violations = 0;
    for (const match of data.matches) {
      const week = Math.floor((new Date(match.matchTime) - base) / WEEK_MS);
      for (const id of [...match.teamA, ...match.teamB]) {
        if (joinWeek[id] > week) violations += 1;
      }
    }
    assert.equal(violations, 0);
  });

  test('中途入会者的 joinDate 与其 joinWeek 一致', () => {
    const data = smallSeed();
    const base = new Date('2026-04-06T18:00:00').getTime();
    for (const member of data.members) {
      const weeks = (new Date(member.joinDate).getTime() - base) / (7 * 86400000);
      assert.equal(weeks, member.joinWeek, `${member.nickName} 的入会日期与周次不符`);
    }
  });

  test('确实存在中途入会的会员（否则上述约束等于没测）', () => {
    const data = generateSeed();
    assert.ok(data.members.some((m) => m.joinWeek > 0));
  });
});

describe('generateSeed —— 比赛流水的自洽性', () => {
  test('全部比赛按时间升序排列', () => {
    const data = generateSeed();
    for (let i = 1; i < data.matches.length; i += 1) {
      assert.ok(
        new Date(data.matches[i - 1].matchTime) <= new Date(data.matches[i].matchTime),
        `第 ${i} 场比赛的时间早于前一场`
      );
    }
  });

  test('比赛编号唯一', () => {
    const data = generateSeed();
    const ids = data.matches.map((m) => m._id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('单打队伍 1 人、双打队伍 2 人', () => {
    const data = generateSeed();
    for (const match of data.matches) {
      const expected =
        match.matchType === MATCH_TYPE.DOUBLES ? 2 : 1;
      assert.equal(match.teamA.length, expected);
      assert.equal(match.teamB.length, expected);
    }
  });

  test('双打不区分性别（男双、女双、混双都在同一个池里）', () => {
    const data = smallSeed();
    const gender = {};
    for (const member of data.members) gender[member._id] = member.gender;

    let mixed = 0;
    for (const match of data.matches) {
      if (match.matchType !== MATCH_TYPE.DOUBLES) continue;
      const side = [...match.teamA, ...match.teamB].map((id) => gender[id]);
      if (new Set(side).size > 1) mixed += 1;
    }
    assert.ok(mixed > 0, '整份数据里一场混双都没有，不符合双打不分性别的设定');
  });

  test('单打既同性对打也有男女对打（否则男榜女榜不可比）', () => {
    // 男女单打合并成一个池后，必须真的产生过男女之间的对局，
    // 两条分数才在同一把尺子上量过，否则两个榜仍然是封闭系统。
    const data = generateSeed();
    const gender = {};
    for (const member of data.members) gender[member._id] = member.gender;

    let same = 0;
    let mixed = 0;
    for (const match of data.matches) {
      if (match.matchType !== MATCH_TYPE.SINGLES) continue;
      if (gender[match.teamA[0]] === gender[match.teamB[0]]) same += 1;
      else mixed += 1;
    }
    assert.ok(same > 0, '一整季没有同性单打，不符合现实');
    assert.ok(mixed > 0, '一整季没有男女对打的单打，男榜女榜无法比较');
  });

  test('比赛类型映射到正确的等级分池', () => {
    // 男女单打已合并成同一个单打池，比赛类型只剩单打和双打两种
    const data = smallSeed();
    const expected = {
      [MATCH_TYPE.SINGLES]: RATING_POOL.SINGLES,
      [MATCH_TYPE.DOUBLES]: RATING_POOL.DOUBLES,
    };
    for (const match of data.matches) {
      assert.equal(match.pool, expected[match.matchType]);
    }
  });

  test('比赛要么已生效，要么是演示赛事里排好签却还没打的场次', () => {
    const data = smallSeed();
    for (const match of data.matches) {
      assert.ok(
        match.status === MATCH_STATUS.ACTIVE || match.status === MATCH_STATUS.PENDING,
        `比赛 ${match._id} 的状态 ${match.status} 不合法`
      );
      // 待确认的只能是演示赛事里尚未开打的那几场：有轮次、有对阵，但没比分
      if (match.status === MATCH_STATUS.PENDING) {
        assert.ok(match.eventId, '待确认的比赛应当属于某场赛事');
        assert.ok(Number.isFinite(match.round), '待确认的比赛也应带轮次，签表才排得出');
        assert.equal(match.scoreA.length, 0);
        assert.equal(match.scoreB.length, 0);
        assert.equal(match.winner, null);
      }
    }
  });

  test('日常约球不属于任何赛事，赛事对局带有 eventId', () => {
    const data = smallSeed();
    const eventMatches = data.matches.filter((m) => m.eventId);
    assert.ok(eventMatches.length > 0);
    assert.ok(data.matches.some((m) => m.eventId === null));
  });
});

describe('generateSeed —— 比分与胜负一致', () => {
  test('winner 字段与比分指向同一方', () => {
    const data = generateSeed();
    for (const match of playedOf(data)) {
      const aGames = match.scoreA.filter((s, i) => s > match.scoreB[i]).length;
      const bGames = match.scoreB.filter((s, i) => s > match.scoreA[i]).length;
      if (match.winner === 'A') {
        assert.ok(aGames > bGames, `比赛 ${match._id} 判 A 胜，比分却是 ${match.scoreA} : ${match.scoreB}`);
      } else {
        assert.ok(bGames > aGames, `比赛 ${match._id} 判 B 胜，比分却是 ${match.scoreA} : ${match.scoreB}`);
      }
    }
  });

  test('每场比分都能通过赛制校验', () => {
    // 这是最关键的一条：拿正式的校验器逐场核对。此前测试只检查
    // 「局数是 2 或 3」，于是「胜方连赢两局后还多打了一局」这种
    // 根本不可能出现的比分被放了过去——642 场里错了 100 场。
    const data = generateSeed();
    for (const match of playedOf(data)) {
      const result = validateMatchScore(match.scoreA, match.scoreB, match);
      assert.equal(
        result.valid,
        true,
        `比赛 ${match._id}（${match.gamePoints} 分制 ${
          BEST_OF_LABEL[match.bestOf]
        }）比分不合法：${result.errors.join('；')}｜${match.scoreA} : ${match.scoreB}`
      );
      assert.equal(result.winner, match.winner, `比赛 ${match._id} 的胜方与比分不符`);
    }
  });

  test('每场都记下了自己采用的赛制', () => {
    const data = generateSeed();
    for (const match of data.matches) {
      assert.ok(
        GAME_POINTS_OPTIONS.includes(match.gamePoints),
        `比赛 ${match._id} 的分制 ${match.gamePoints} 不在允许范围内`
      );
      assert.ok(
        BEST_OF_OPTIONS.includes(match.bestOf),
        `比赛 ${match._id} 的局制 ${match.bestOf} 不在允许范围内`
      );
    }
  });

  test('总局数不超过该赛制的上限，且达到获胜局数', () => {
    const data = generateSeed();
    for (const match of playedOf(data)) {
      const need = gamesToWin(match.bestOf);
      assert.equal(match.scoreA.length, match.scoreB.length);
      assert.ok(match.scoreA.length <= match.bestOf, `比赛 ${match._id} 超过了局数上限`);
      assert.ok(match.scoreA.length >= need, `比赛 ${match._id} 还没打完就结束了`);
    }
  });

  test('单局比分符合匹克球规则：先到目标分且领先 2 分', () => {
    const data = generateSeed();
    for (const match of playedOf(data)) {
      match.scoreA.forEach((score, i) => {
        const other = match.scoreB[i];
        const high = Math.max(score, other);
        const low = Math.min(score, other);
        assert.equal(high - low >= 2, true, `比分 ${score}:${other} 未拉开 2 分`);
        assert.equal(
          high >= match.gamePoints,
          true,
          `比分 ${score}:${other} 未打到 ${match.gamePoints} 分`
        );
        // 恰好等于目标分时，对手不可能上到平分线
        if (high === match.gamePoints) {
          assert.ok(low < match.gamePoints - 1, `${match.gamePoints} 分获胜时对手不应拿到 ${low} 分`);
        }
      });
    }
  });

  test('模拟数据覆盖了全部三种分制与三种局制', () => {
    // 界面上「11 分制 · 三局两胜」这类文案得有各种样本，
    // 否则格式相关的界面改动没法在数据里看出来
    const data = generateSeed();
    const points = new Set(data.matches.map((m) => m.gamePoints));
    const bestOf = new Set(data.matches.map((m) => m.bestOf));
    assert.deepEqual([...points].sort((a, b) => a - b), [...GAME_POINTS_OPTIONS]);
    assert.deepEqual([...bestOf].sort((a, b) => a - b), [...BEST_OF_OPTIONS]);
  });
});

describe('generateGameScore —— 单局比分', () => {
  test('势均力敌时败方得分接近 10', () => {
    const random = createSeededRandom(1);
    const scores = Array.from({ length: 200 }, () => generateGameScore(random, 0.5));
    const avgLoser = scores.reduce((s, g) => s + g.loser, 0) / scores.length;
    assert.ok(avgLoser > 8.5 && avgLoser <= 10, `败方平均得分 ${avgLoser}，偏离预期`);
  });

  test('实力悬殊时败方得分明显更低', () => {
    const random = createSeededRandom(1);
    const scores = Array.from({ length: 200 }, () => generateGameScore(random, 1));
    const avgLoser = scores.reduce((s, g) => s + g.loser, 0) / scores.length;
    assert.ok(avgLoser < 4.5, `碾压局败方平均得分 ${avgLoser}，偏高`);
  });

  test('胜方得分始终合法', () => {
    const random = createSeededRandom(4);
    for (let i = 0; i < 500; i += 1) {
      const { winner, loser } = generateGameScore(random, random());
      assert.ok(loser >= 1 && loser <= 10, `败方得分越界：${loser}`);
      assert.ok(winner >= 11);
      assert.ok(winner - loser >= 2);
    }
  });

  test('15 分制与 21 分制按各自的目标分判定', () => {
    const random = createSeededRandom(6);
    for (const gamePoints of [15, 21]) {
      for (let i = 0; i < 200; i += 1) {
        const { winner, loser } = generateGameScore(random, random(), gamePoints);
        assert.ok(winner >= gamePoints, `${gamePoints} 分制胜方只拿到 ${winner} 分`);
        assert.ok(loser <= gamePoints - 1, `${gamePoints} 分制败方拿到 ${loser} 分，超出平分线`);
        assert.ok(winner - loser >= 2, `${winner}:${loser} 未拉开 2 分`);
      }
    }
  });

  test('不封顶：平分之后可以一路加上去', () => {
    const random = createSeededRandom(11);
    const scores = Array.from({ length: 400 }, () => generateGameScore(random, 0.5));
    // 势均力敌时应当出现 12:10 乃至更高的比分，而不是被硬截在 11 分
    assert.ok(scores.some((g) => g.winner > 11), '从未出现过分平后的加分比分');
    assert.ok(scores.every((g) => g.winner === 11 || g.winner - g.loser === 2));
  });
});

describe('generateMatchScore —— 逐局比分', () => {
  test('胜方拿下多数局', () => {
    const random = createSeededRandom(8);
    for (let i = 0; i < 200; i += 1) {
      const { scoreA, scoreB } = generateMatchScore(random, true, 0.6);
      const aGames = scoreA.filter((s, j) => s > scoreB[j]).length;
      assert.ok(aGames > scoreB.length / 2);
    }
  });

  test('B 队获胜时比分同样成立', () => {
    const random = createSeededRandom(8);
    for (let i = 0; i < 200; i += 1) {
      const { scoreA, scoreB } = generateMatchScore(random, false, 0.6);
      const bGames = scoreB.filter((s, j) => s > scoreA[j]).length;
      assert.ok(bGames > scoreA.length / 2);
    }
  });

  test('各种赛制下生成的比分都能通过校验', () => {
    const random = createSeededRandom(21);
    for (const format of [
      { gamePoints: 11, bestOf: 1 },
      { gamePoints: 11, bestOf: 3 },
      { gamePoints: 15, bestOf: 3 },
      { gamePoints: 15, bestOf: 5 },
      { gamePoints: 21, bestOf: 1 },
      { gamePoints: 21, bestOf: 5 },
    ]) {
      for (const teamAWins of [true, false]) {
        for (let i = 0; i < 60; i += 1) {
          const { scoreA, scoreB } = generateMatchScore(random, teamAWins, 0.5, format);
          const result = validateMatchScore(scoreA, scoreB, format);
          assert.equal(
            result.valid,
            true,
            `${format.gamePoints} 分制 ${BEST_OF_LABEL[format.bestOf]}：${scoreA} : ${scoreB} —— ${result.errors.join('；')}`
          );
          assert.equal(result.winner, teamAWins ? 'A' : 'B');
        }
      }
    }
  });

  test('一局一胜只打一局', () => {
    const random = createSeededRandom(5);
    for (let i = 0; i < 100; i += 1) {
      const { scoreA, scoreB } = generateMatchScore(random, true, 0.6, { gamePoints: 11, bestOf: 1 });
      assert.equal(scoreA.length, 1);
      assert.equal(scoreB.length, 1);
    }
  });

  test('五局三胜最多打五局，且胜方恰好赢三局', () => {
    const random = createSeededRandom(9);
    const counts = new Set();
    for (let i = 0; i < 300; i += 1) {
      const { scoreA, scoreB } = generateMatchScore(random, true, 0.5, { gamePoints: 11, bestOf: 5 });
      const aGames = scoreA.filter((s, j) => s > scoreB[j]).length;
      const bGames = scoreB.filter((s, j) => s > scoreA[j]).length;
      assert.equal(aGames, 3);
      assert.equal(scoreA.length, 3 + bGames);
      assert.ok(scoreA.length <= 5);
      counts.add(scoreA.length);
    }
    // 3:0、3:1、3:2 都应当出现过，否则「败方偶尔抢下一局」的设定名存实亡
    assert.deepEqual([...counts].sort((a, b) => a - b), [3, 4, 5]);
  });

  test('决胜局一定由胜方拿下（这正是不合法比分的病根）', () => {
    const random = createSeededRandom(13);
    for (const format of [
      { gamePoints: 11, bestOf: 3 },
      { gamePoints: 21, bestOf: 5 },
    ]) {
      for (let i = 0; i < 200; i += 1) {
        const { scoreA, scoreB } = generateMatchScore(random, true, 0.5, format);
        const last = scoreA.length - 1;
        assert.ok(scoreA[last] > scoreB[last], `比赛结束时最后一局却是败方拿下：${scoreA} : ${scoreB}`);
      }
    }
  });
});

describe('winProbability —— 胜率模型', () => {
  test('同分时胜率为 50%', () => {
    assert.equal(winProbability(1200, 1200), 0.5);
  });

  test('实力高 400 分时胜率约为 10:1', () => {
    const p = winProbability(1400, 1000);
    assert.ok(p > 0.9 && p < 0.91, `实际胜率 ${p}`);
  });

  test('双方胜率之和恒为 1', () => {
    for (const [a, b] of [[1200, 1400], [1000, 1000], [1600, 900]]) {
      assert.ok(Math.abs(winProbability(a, b) + winProbability(b, a) - 1) < 1e-9);
    }
  });
});

describe('simulateBracket —— 单败淘汰赛', () => {
  const makeEntries = (n) =>
    Array.from({ length: n }, (_, i) => ({
      key: 'p' + i,
      players: ['p' + i],
      skill: 1000 + i * 10,
    }));

  test('8 人淘汰赛共 7 场，全员都有名次', () => {
    const { matches, placements } = simulateBracket({
      entries: makeEntries(8),
      random: createSeededRandom(1),
      startTime: new Date('2026-05-01'),
      matchType: MATCH_TYPE.SINGLES,
      eventId: 'e01',
    });
    assert.equal(matches.length, 7);
    assert.equal(Object.keys(placements).length, 8);
  });

  test('名次集合符合淘汰赛结构：1 个冠军、1 个亚军、2 个四强……', () => {
    const { placements } = simulateBracket({
      entries: makeEntries(8),
      random: createSeededRandom(1),
      startTime: new Date('2026-05-01'),
      matchType: MATCH_TYPE.SINGLES,
      eventId: 'e01',
    });
    const counts = {};
    for (const place of Object.values(placements)) {
      counts[place] = (counts[place] || 0) + 1;
    }
    assert.deepEqual(counts, { 1: 1, 2: 1, 3: 2, 5: 4 });
  });

  test('每轮每人只会出场一次', () => {
    const { matches } = simulateBracket({
      entries: makeEntries(8),
      random: createSeededRandom(3),
      startTime: new Date('2026-05-01'),
      matchType: MATCH_TYPE.SINGLES,
      eventId: 'e01',
    });
    // 第 1 轮 4 场，第 2 轮 2 场，第 3 轮 1 场，全部打满
    assert.equal(matches.length, 7);
    const participants = new Set();
    for (const m of matches) {
      for (const id of [...m.teamA, ...m.teamB]) participants.add(id);
    }
    assert.equal(participants.size, 8);
  });

  test('种子排位让高手在早期轮次避开彼此', () => {
    // 1 号种子（最强）首轮应对上最弱的 8 号，而不是 2 号
    const { matches } = simulateBracket({
      entries: makeEntries(8),
      random: createSeededRandom(1),
      startTime: new Date('2026-05-01'),
      matchType: MATCH_TYPE.SINGLES,
      eventId: 'e01',
    });
    const firstRound = matches.slice(0, 4);
    const pairs = firstRound.map((m) => [m.teamA[0], m.teamB[0]].sort().join(' vs '));
    assert.ok(pairs.includes('p0 vs p7'), `首轮对阵为 ${pairs.join('、')}`);
  });

  test('参赛条目数不是 2 的幂次时抛出错误', () => {
    assert.throws(
      () =>
        simulateBracket({
          entries: makeEntries(6),
          random: createSeededRandom(1),
          startTime: new Date('2026-05-01'),
          matchType: MATCH_TYPE.SINGLES,
          eventId: 'e01',
        }),
      /2 的幂次/
    );
  });

  test('赛事对局带有 eventId 且记录为所属赛事', () => {
    const { matches } = simulateBracket({
      entries: makeEntries(4),
      random: createSeededRandom(2),
      startTime: new Date('2026-05-01'),
      matchType: MATCH_TYPE.DOUBLES,
      eventId: 'e09',
    });
    for (const m of matches) {
      assert.equal(m.eventId, 'e09');
      assert.ok(m._id.startsWith('e09-m'));
    }
  });
});

describe('generateSeed —— 赛事数据', () => {
  test('已结束的赛事，参赛人数与配额一致', () => {
    const data = generateSeed();
    for (const event of finishedOf(data)) {
      assert.equal(event.results.length, event.quota);
    }
  });

  test('赛事名次覆盖全部参赛者且每人只有一个名次', () => {
    const data = generateSeed();
    for (const event of finishedOf(data)) {
      const ids = event.results.map((r) => r.userId);
      assert.equal(new Set(ids).size, ids.length, `${event.title} 有重复参赛者`);
      for (const r of event.results) {
        assert.ok(r.placement >= 1, `名次 ${r.placement} 不合法`);
      }
    }
  });

  test('已结束的赛事带有结束时间', () => {
    const data = generateSeed();
    for (const event of finishedOf(data)) {
      assert.equal(event.status, EVENT_STATUS.FINISHED);
      assert.ok(new Date(event.endTime) > new Date(event.startTime));
    }
  });

  test('赛事名由实际月份推导，不是写死的', () => {
    const data = generateSeed();
    for (const event of data.events) {
      const month = new Date(event.startTime).getMonth() + 1;
      assert.ok(
        event.title.startsWith(`${month}月`),
        `赛事「${event.title}」的月份与实际日期不符`
      );
    }
  });

  test('已结束的赛事，对局数量与参赛规模相符', () => {
    const data = generateSeed();
    for (const event of finishedOf(data)) {
      const own = data.matches.filter((m) => m.eventId === event._id);
      // 8 个条目的单败淘汰赛共 7 场
      assert.equal(own.length, 7);
    }
  });

  test('留有一场进行中的赛事，供签到、签表与逐轮推进演示', () => {
    const data = generateSeed();
    const ongoing = data.events.filter((event) => event.status === EVENT_STATUS.ONGOING);
    assert.equal(ongoing.length, 1, '进行中的赛事应当恰好一场');

    const [event] = ongoing;
    // 还没打完：没有名次，但已抽签，签表也有了实体
    assert.deepEqual(event.results, []);
    assert.ok(event.draw, '进行中的赛事必须带抽签记录');
    assert.equal(event.draw.size, event.quota, '签位数应与名额一致');
    assert.equal(event.draw.slots.length, event.quota);
    // 封了报名参数，签表与手工指定种子的入口才有依据
    assert.ok(event.seedMode, '进行中的赛事应当写好种子口径');
    assert.ok(event.seedCount > 0, '进行中的赛事应当写好种子数量');
    // 开赛时间必须晚于所有已结束的赛事，否则会排在「近期赛事」的中间
    for (const finished of finishedOf(data)) {
      assert.ok(
        new Date(event.startTime) > new Date(finished.startTime),
        '进行中的赛事应当排在最后'
      );
    }
  });

  test('进行中的赛事：八人报名、四场八进四打完、半决赛排好却没打', () => {
    const data = generateSeed();
    const event = data.events.find((item) => item.status === EVENT_STATUS.ONGOING);
    assert.ok(event, '种子里应当有一场进行中的赛事');

    const own = data.matches
      .filter((match) => match.eventId === event._id)
      .sort(
        (a, b) => Number(a.round) - Number(b.round) || Number(a.slot) - Number(b.slot)
      );
    // 8 人 3 轮：四场八进四 + 两场半决赛，决赛还没排
    assert.equal(own.length, 6, '八进四四场、半决赛两场，共六场');
    for (const match of own) {
      // 轮次 / 阶段 / 签位是签表排轮次名的依据，一个都不能少
      assert.ok(Number.isFinite(match.round), `${match._id} 缺轮次，签表会叫不出轮次名`);
      assert.ok(match.stage, `${match._id} 缺阶段`);
      assert.ok(Number.isFinite(match.slot), `${match._id} 缺签位`);
    }

    const qf = own.filter((match) => match.round === 1);
    const sf = own.filter((match) => match.round === 2);
    assert.equal(qf.length, 4);
    assert.equal(sf.length, 2);

    // 八进四刚打完：比分齐全、状态已生效
    for (const match of qf) {
      assert.equal(match.status, MATCH_STATUS.ACTIVE);
      assert.ok(match.scoreA.length > 0, '打完的比赛必须有比分');
      assert.ok(match.winner === 'A' || match.winner === 'B');
    }
    // 半决赛排好了签位却还没开打：没比分、没胜者、状态待确认
    for (const match of sf) {
      assert.equal(match.status, MATCH_STATUS.PENDING);
      assert.deepEqual(match.scoreA, []);
      assert.deepEqual(match.scoreB, []);
      assert.equal(match.winner, null);
    }

    // 半决赛的两位选手正是八进四的胜者，签表前后对得上
    const qfWinners = new Set(
      qf.map((match) => (match.winner === 'A' ? match.teamA[0] : match.teamB[0]))
    );
    for (const match of sf) {
      assert.ok(qfWinners.has(match.teamA[0]), `${match.teamA[0]} 不是八进四胜者，不该进四强`);
      assert.ok(qfWinners.has(match.teamB[0]), `${match.teamB[0]} 不是八进四胜者，不该进四强`);
    }

    // 演示账号 u06 进四强了，正站在一场还没开打的半决赛里等着
    assert.ok(
      sf.some((match) => match.teamA[0] === 'u06' || match.teamB[0] === 'u06'),
      'u06 应当已经进入四强，等着打下一场'
    );
    // 决赛还没排出来，他不可能已经在打决赛
    assert.ok(!own.some((match) => Number(match.round) > 2), '决赛不该提前排出来');
  });

  test('进行中赛事的预置报名：八人、都已签到、不超名额', () => {
    const data = generateSeed();
    const event = data.events.find((item) => item.status === EVENT_STATUS.ONGOING);
    assert.ok(event, '种子里应当有一场进行中的赛事');

    assert.equal(data.signups.length, event.quota, '进行中的赛事应当报满名额');
    for (const signup of data.signups) {
      assert.equal(signup.eventId, event._id);
      assert.equal(signup.status, SIGNUP_STATUS.CHECKED_IN);
      assert.ok(signup.checkInTime, '已签到的报名应当留下签到时间');
      assert.ok(new Date(signup.signTime) < new Date(event.startTime), '报名应当早于开赛');
    }
    // 报名的都是单打组的男会员——本场是男子单打
    const men = new Set(data.members.filter((m) => m.gender === 'M').map((m) => m._id));
    const ids = data.signups.map((signup) => signup.userId);
    assert.equal(new Set(ids).size, ids.length, '同一人只报一次');
    for (const id of ids) {
      assert.ok(men.has(id), `${id} 不是男子组会员，不该出现在男子单打赛里`);
    }
    // 演示账号 u06 必须在名单里，否则「我进了四强」无从演示
    assert.ok(ids.includes('u06'), '演示账号应当报了名');
  });

  test('单打赛事按性别分组，标题与参赛者性别一致', () => {
    // 分数池合并了，但比赛本身仍分男子组、女子组，就像现实中的校赛。
    const data = generateSeed();
    const gender = {};
    for (const member of data.members) gender[member._id] = member.gender;

    const singlesEvents = data.events.filter((e) => e.matchType === MATCH_TYPE.SINGLES);
    assert.ok(singlesEvents.length > 0, '整份数据里没有单打赛事');
    for (const event of singlesEvents) {
      assert.ok(
        event.title.includes('男子') || event.title.includes('女子'),
        `单打赛事「${event.title}」缺少性别前缀`
      );
      const expected = event.title.includes('女子') ? 'F' : 'M';
      for (const result of event.results) {
        assert.equal(
          gender[result.userId],
          expected,
          `「${event.title}」里混进了性别为 ${gender[result.userId]} 的选手`
        );
      }
    }

    // 双打赛事不分性别，标题不应带性别前缀
    for (const event of data.events.filter((e) => e.matchType === MATCH_TYPE.DOUBLES)) {
      assert.ok(
        !event.title.includes('男子') && !event.title.includes('女子'),
        `双打赛事「${event.title}」不该带性别前缀`
      );
    }
  });
});

describe('generateSeed —— 场地分配', () => {
  /** 某场赛事自己的对局，保持种子返回的时间序 */
  const matchesOf = (data, event) => data.matches.filter((m) => m.eventId === event._id);

  test('每场赛事都带合法场地数、对局都排了场号，日常约球不排', () => {
    const data = generateSeed();

    for (const event of data.events) {
      assert.ok(
        Number.isInteger(event.courtCount) &&
          event.courtCount >= COURT_LIMITS.MIN &&
          event.courtCount <= COURT_LIMITS.MAX,
        `赛事「${event.title}」的场地数 ${event.courtCount} 不合法`
      );
      for (const match of matchesOf(data, event)) {
        assert.ok(
          match.courtNo >= 1 && match.courtNo <= event.courtCount,
          `${match._id} 的场号 ${match.courtNo} 超出了 1~${event.courtCount}`
        );
      }
    }

    // 约球没有场地可言，不能凭空捏一个场号（历史赛事读不到 courtNo 时同此口径）
    for (const match of data.matches.filter((m) => m.eventId === null)) {
      assert.equal(match.courtNo, undefined, `${match._id} 是日常约球，不该有场号`);
    }
  });

  test('场号与 planCourts 重算结果逐场一致，换一个读库顺序也照样对得上', () => {
    // 种子里排场号的方式与正式抽签同源：都拿这个纯函数现算。手写的场号一旦
    // 与算法分叉，界面上「场地分配」表就会与签表里的场号打架——而这种不一致
    // 光看数据是看不出来的。反过来，用逆序重算也检验了分配的可重入性。
    const data = generateSeed();

    for (const event of data.events) {
      const shuffled = matchesOf(data, event).reverse();
      const plan = planCourts(shuffled, event.courtCount);
      shuffled.forEach((match, index) => {
        assert.equal(
          match.courtNo,
          plan[index].courtNo,
          `${match._id} 的场号与重算结果不符（逆序后算出了另一套）`
        );
      });
    }
  });

  test('同一轮次不重号；场地不够时排到第二批（种子里确有这种赛事）', () => {
    const data = generateSeed();
    let batched = 0;

    for (const event of data.events) {
      const rounds = new Map();
      for (const match of matchesOf(data, event)) {
        if (!rounds.has(match.round)) rounds.set(match.round, []);
        rounds.get(match.round).push(match.courtNo);
      }

      rounds.forEach((courtNos, round) => {
        if (courtNos.length <= event.courtCount) {
          assert.equal(
            new Set(courtNos).size,
            courtNos.length,
            `「${event.title}」第 ${round} 轮有 ${courtNos.length} 场、${event.courtCount} 块场地，不该重号：${courtNos}`
          );
          return;
        }
        // 场地不够时必然重号，但每 N 场为一小批，批内仍然不重号
        batched += 1;
        for (let i = 0; i < courtNos.length; i += event.courtCount) {
          const wave = courtNos.slice(i, i + event.courtCount);
          assert.equal(
            new Set(wave).size,
            wave.length,
            `「${event.title}」第 ${round} 轮第 ${i / event.courtCount + 1} 批重号了：${wave}`
          );
        }
      });
    }

    // 只有「场地够用」的样本，分批这条分支在界面和演示里永远看不到，等于没做
    assert.ok(batched > 0, '种子里没有任何场地不够的赛事，分批行为无从验收');
  });

  test('进行中的赛事：八进四占满 4 块场地，半决赛回到 1、2 号场', () => {
    const data = generateSeed();
    const event = data.events.find((item) => item.status === EVENT_STATUS.ONGOING);
    const own = matchesOf(data, event);

    const courtNosOf = (round) =>
      own
        .filter((match) => match.round === round)
        .sort((a, b) => a.slot - b.slot)
        .map((match) => match.courtNo);

    assert.deepEqual(courtNosOf(1), [1, 2, 3, 4], '八进四四场应当一人一块场地');
    assert.deepEqual(courtNosOf(2), [1, 2], '半决赛两场用 1、2 号场');
  });
});
