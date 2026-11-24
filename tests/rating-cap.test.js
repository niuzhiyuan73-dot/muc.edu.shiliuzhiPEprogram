/**
 * 防刷分上限单元测试
 *
 * 规则：同一对会员在一个赛季内，最多 RATED_PAIR_LIMIT 场「自行录入的比赛」
 * 计入等级分。赛事比赛不设上限；双打按跨队无序对计。
 *
 * 这里只测纯判定函数，不碰界面、不碰数据库。边界要钉死，因为这条规则
 * 直接决定谁的分算数、谁的分不算数——差一场就是两个人分数不同。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCasualMatch,
  pairKey,
  crossPairs,
  crossPairList,
  countedMatches,
  tallyPairUsage,
  seasonPairCounts,
  findCappedMatchIds,
  checkSubmitAllowed,
} = require('../src/server/services/rating-cap.js');

const { MATCH_STATUS, MATCH_TYPE, RATED_PAIR_LIMIT } = require('../src/shared/utils/constants.js');

/** 一场日常单打 */
function casualSingles(id, a, b, matchTime, status = MATCH_STATUS.ACTIVE) {
  return {
    _id: id,
    teamA: [a],
    teamB: [b],
    matchTime,
    status,
    matchType: 1,
  };
}

/** 一场日常双打 */
function casualDoubles(id, teamA, teamB, matchTime, status = MATCH_STATUS.ACTIVE) {
  return { _id: id, teamA, teamB, matchTime, status, matchType: 2 };
}

/** 一天一天往后排，保证回放顺序确定 */
function day(n) {
  return new Date(Date.UTC(2026, 0, n, 12, 0, 0));
}

describe('isCasualMatch —— 什么算「自行录入的比赛」', () => {
  test('没有赛事身份的就是日常约球', () => {
    assert.equal(isCasualMatch(casualSingles('m1', 'u1', 'u2', day(1))), true);
  });

  test('带 eventId 的是赛事比赛，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), eventId: 'e1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('带 collegeEventId 的是学院赛，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), collegeEventId: 'ce1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('带 tieId 的是学院赛小场，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), tieId: 't1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('三者任一为空串也仍算日常（空串等于没设）', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), eventId: '', tieId: null };
    assert.equal(isCasualMatch(match), true);
  });

  test('null 不报错，按非日常处理', () => {
    assert.equal(isCasualMatch(null), false);
  });
});

describe('pairKey —— 无序对', () => {
  test('甲乙与乙甲是同一个键', () => {
    assert.equal(pairKey('u1', 'u2'), pairKey('u2', 'u1'));
  });

  test('不同的人对不同', () => {
    assert.notEqual(pairKey('u1', 'u2'), pairKey('u1', 'u3'));
  });
});

describe('crossPairs —— 跨队无序对', () => {
  test('单打只有一组', () => {
    const keys = crossPairs(casualSingles('m1', 'u1', 'u2', day(1)));
    assert.equal(keys.length, 1);
    assert.equal(keys[0], pairKey('u1', 'u2'));
  });

  test('双打四组，同队两人之间不算', () => {
    const keys = crossPairs(casualDoubles('m1', ['a', 'b'], ['c', 'd'], day(1)));
    assert.equal(keys.length, 4);
    assert.deepEqual(
      keys.slice().sort(),
      [
        pairKey('a', 'c'),
        pairKey('a', 'd'),
        pairKey('b', 'c'),
        pairKey('b', 'd'),
      ].sort()
    );
  });

  test('队伍数据缺失时返回空数组，不抛错', () => {
    assert.deepEqual(crossPairs(null), []);
    assert.deepEqual(crossPairs({ _id: 'm1' }), []);
    assert.deepEqual(crossPairs({ _id: 'm1', teamA: ['a'], teamB: [] }), []);
  });

  test('队伍里的 null / undefined 成员被跳过', () => {
    const keys = crossPairs({ _id: 'm1', teamA: ['a', null], teamB: ['c'] });
    assert.deepEqual(keys, [pairKey('a', 'c')]);
  });
});

describe('findCappedMatchIds —— 上限本身', () => {
  test('恰好打满 15 场，全部计入', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('第 16 场不计入，前 15 场不受影响', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has(`m${RATED_PAIR_LIMIT + 1}`));
  });

  test('超限只压那一对：别人的比赛照常计入', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // u3 与 u4 只有一场，不该被牵连
    matches.push(casualSingles('other', 'u3', 'u4', day(20)));

    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(!capped.has('other'));
  });

  test('同日多场时按确定顺序判定，结果可复现', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      // 全部同一时刻：排序要能给出稳定次序
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(1)));
    }
    const first = findCappedMatchIds(matches);
    const second = findCappedMatchIds([...matches].reverse());
    assert.deepEqual([...first].sort(), [...second].sort());
    assert.equal(first.size, 1);
  });

  test('空数组与 null 返回空集合，不报错', () => {
    assert.equal(findCappedMatchIds([]).size, 0);
    assert.equal(findCappedMatchIds(null).size, 0);
    assert.equal(findCappedMatchIds(undefined).size, 0);
  });

  test('limit 传 0 或负数时视为不设上限（防误配把全部比赛压掉）', () => {
    const matches = [casualSingles('m1', 'u1', 'u2', day(1))];
    assert.equal(findCappedMatchIds(matches, { limit: 0 }).size, 0);
    assert.equal(findCappedMatchIds(matches, { limit: -1 }).size, 0);
  });

  test('limit 可调，便于不同项目走不同口径', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      casualSingles('m2', 'u1', 'u2', day(2)),
    ];
    assert.equal(findCappedMatchIds(matches, { limit: 1 }).size, 1);
  });
});

describe('findCappedMatchIds —— 赛事不算数', () => {
  test('赛事比赛再多也不占名额、也不被压', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 5; i += 1) {
      matches.push({
        ...casualSingles(`e${i}`, 'u1', 'u2', day(i)),
        eventId: 'evt-1',
      });
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('赛事比赛不占用日常名额：15 场赛事之后日常仍能打满 15 场', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push({ ...casualSingles(`e${i}`, 'u1', 'u2', day(i)), eventId: 'evt-1' });
    }
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`c${i}`, 'u1', 'u2', day(100 + i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('学院赛小场也不占名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push({
        ...casualSingles(`t${i}`, 'u1', 'u2', day(i)),
        collegeEventId: 'ce1',
        tieId: 'tie1',
      });
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 双打按跨队无序对', () => {
  test('同一对搭档反复对上同一对对手，第 16 场整场不计', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], ['c', 'd'], day(i)));
    }
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has(`m${RATED_PAIR_LIMIT + 1}`));
  });

  test('换搭档不刷新名额：甲丙交手 15 场之后，甲乙对丙丁仍受同一名额约束', () => {
    // 甲与丙这一对已经打满 15 场
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'x'], ['c', 'y'], day(i)));
    }
    // 这一场里仍然含「甲 vs 丙」这一对，因此超限
    matches.push(casualDoubles('extra', ['a', 'b'], ['c', 'd'], day(50)));

    const capped = findCappedMatchIds(matches);
    assert.ok(capped.has('extra'));
  });

  test('四对里只要有一对满额，整场不计（队内 delta 共用，没法半算）', () => {
    // 把 a-c 这一对喂到满额
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'x'], ['c', 'y'], day(i)));
    }
    // 这场只让 a-c 复用，其余三对都是新的
    matches.push(casualDoubles('mixed', ['a', 'new1'], ['c', 'new2'], day(60)));

    assert.ok(findCappedMatchIds(matches).has('mixed'));
  });

  test('(甲,乙) 与 (乙,甲) 是同一对：四人不变只换边，仍是同一批对子', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], ['c', 'd'], day(i)));
    }
    // 同样的四人、同样的组合，只是两队位置对调——四组跨队对一模一样
    matches.push(casualDoubles('swap', ['c', 'd'], ['a', 'b'], day(50)));
    assert.ok(findCappedMatchIds(matches).has('swap'));
  });

  test('同队两人之间不算一对：他们从未交手', () => {
    // 甲与乙永远同队，从不交手
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 5; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], [`c${i}`, `d${i}`], day(i)));
    }
    // a-b 同队，不该因为同队次数过多而互相压分；但与 c/d 各只交手一次
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 状态与赛季', () => {
  test('待确认的场次也占名额（否则先录 15 场再一起确认就绕过了）', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i), MATCH_STATUS.PENDING));
    }
    // 第 16 场无论什么状态，都该被压
    matches.push(casualSingles('m16', 'u1', 'u2', day(20), MATCH_STATUS.ACTIVE));
    const capped = findCappedMatchIds(matches);
    assert.ok(capped.has('m16'));
    assert.equal(capped.size, 1);
  });

  test('已撤销的场次不占名额，名额释放给后来的场次', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i), MATCH_STATUS.REVOKED));
    }
    // 前面 15 场全撤销，这场是第 1 场有效
    matches.push(casualSingles('m16', 'u1', 'u2', day(20), MATCH_STATUS.ACTIVE));
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('被撤销的是超限的那一场后，名额回到后面的场次', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    matches.push(casualSingles('m17', 'u1', 'u2', day(30)));
    // m16 是超限的那场，把它撤掉，m17 应该补位进来
    matches[RATED_PAIR_LIMIT].status = MATCH_STATUS.REVOKED;

    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has('m17'));
  });

  test('赛季分界点之前的场次不占本赛季名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // 本赛季从第 10 天开始：只有 m10..m16 属于本赛季，共 7 场，没超
    const capped = findCappedMatchIds(matches, { seasonStart: day(10) });
    assert.equal(capped.size, 0);
  });

  test('赛季分界点之后重新计数：上赛季打满，本赛季重新有 15 个名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`old${i}`, 'u1', 'u2', day(i)));
    }
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`new${i}`, 'u1', 'u2', day(100 + i)));
    }
    const capped = findCappedMatchIds(matches, { seasonStart: day(100) });
    assert.equal(capped.size, 0);
  });

  test('不传赛季分界点：全部流水都算本赛季', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 1);
    assert.equal(findCappedMatchIds(matches, { seasonStart: null }).size, 1);
  });

  test('分界点之后正好 15 场，第 16 场才压', () => {
    const matches = [];
    for (let i = 1; i <= 40; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // 从第 20 天起有新赛季，则 m20..m34 是本赛季第 1..15 场，m35 是第 16 场
    const capped = findCappedMatchIds(matches, { seasonStart: day(20) });
    assert.equal(capped.size, 6); // m35..m40
    assert.ok(capped.has('m35'));
    assert.ok(!capped.has('m34'));
  });

  test('matchTime 非法的场次跳过，不占名额', () => {
    const matches = [
      casualSingles('bad', 'u1', 'u2', '不是时间'),
      casualSingles('ok', 'u1', 'u2', day(1)),
    ];
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 多名会员交织', () => {
  test('每对各自计数，互不干扰', () => {
    const matches = [];
    // u1-u2 打 20 场
    for (let i = 1; i <= 20; i += 1) {
      matches.push(casualSingles(`a${i}`, 'u1', 'u2', day(i)));
    }
    // u3-u4 打 20 场
    for (let i = 1; i <= 20; i += 1) {
      matches.push(casualSingles(`b${i}`, 'u3', 'u4', day(i)));
    }
    const capped = findCappedMatchIds(matches);
    // 两对各超 5 场
    assert.equal(capped.size, 10);
    assert.ok(capped.has('a16'));
    assert.ok(capped.has('b16'));
  });

  test('一个人同时对多个对手：每个对子单独计数', () => {
    const matches = [];
    // u1 与 u2、u3 各打 15 场，都还没超
    for (let i = 1; i <= 15; i += 1) {
      matches.push(casualSingles(`p${i}`, 'u1', 'u2', day(i)));
      matches.push(casualSingles(`q${i}`, 'u1', 'u3', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);

    // 各自再打一场，两对都超
    matches.push(casualSingles('p16', 'u1', 'u2', day(20)));
    matches.push(casualSingles('q16', 'u1', 'u3', day(21)));
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 2);
    assert.ok(capped.has('p16'));
    assert.ok(capped.has('q16'));
  });
});

describe('crossPairList —— 跨队对，连同两边是谁', () => {
  test('单打带出两个人，编号是原样的', () => {
    assert.deepEqual(crossPairList(casualSingles('m1', 'u1', 'u2', day(1))), [
      { key: pairKey('u1', 'u2'), a: 'u1', b: 'u2' },
    ]);
  });

  test('双打四组，编号能直接读出是甲乙丙丁', () => {
    const list = crossPairList(casualDoubles('m1', ['a', 'b'], ['c', 'd'], day(1)));
    assert.equal(list.length, 4);
    // 不能靠切 '|' 把编号还原：编号里一旦含分隔符就会错，所以必须原样带出来
    for (const pair of list) {
      assert.ok(['a', 'b'].includes(pair.a));
      assert.ok(['c', 'd'].includes(pair.b));
      assert.equal(pair.key, pairKey(pair.a, pair.b));
    }
  });

  test('与 crossPairs 同源：键一一对应', () => {
    const match = casualDoubles('m1', ['a', 'b'], ['c', 'd'], day(1));
    assert.deepEqual(
      crossPairList(match).map((pair) => pair.key),
      crossPairs(match)
    );
  });
});

describe('countedMatches —— 哪些场次占名额', () => {
  test('撤销的场次不占名额', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      casualSingles('m2', 'u1', 'u2', day(2), MATCH_STATUS.REVOKED),
    ];
    assert.deepEqual(
      countedMatches(matches, null).map((m) => m._id),
      ['m1']
    );
  });

  test('赛事与学院赛不占名额', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      { ...casualSingles('m2', 'u1', 'u2', day(2)), eventId: 'e1' },
      { ...casualSingles('m3', 'u1', 'u2', day(3)), collegeEventId: 'ce1', tieId: 't1' },
    ];
    assert.deepEqual(
      countedMatches(matches, null).map((m) => m._id),
      ['m1']
    );
  });

  test('待确认的场次同样占名额（否则连录 15 场等确认就绕过去了）', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1), MATCH_STATUS.PENDING),
      casualSingles('m2', 'u1', 'u2', day(2)),
    ];
    assert.equal(countedMatches(matches, null).length, 2);
  });

  test('分界点之前的场次归上个赛季，不占本赛季名额', () => {
    const matches = [
      casualSingles('old', 'u1', 'u2', day(1)),
      casualSingles('new', 'u1', 'u2', day(10)),
    ];
    const list = countedMatches(matches, day(5));
    assert.deepEqual(
      list.map((m) => m._id),
      ['new']
    );
    // 没开始过新赛季时分界点为 null，全部算本赛季
    assert.equal(countedMatches(matches, null).length, 2);
  });

  test('时间不可解析的脏数据跳过，不吃别人的名额', () => {
    const matches = [
      casualSingles('bad', 'u1', 'u2', '不是时间'),
      casualSingles('good', 'u1', 'u2', day(1)),
    ];
    assert.deepEqual(
      countedMatches(matches, null).map((m) => m._id),
      ['good']
    );
  });

  test('没有跨队对的记录跳过（队伍不全，算不出和谁交手）', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      { _id: 'broken', teamA: ['u1'], teamB: [], matchTime: day(2), status: MATCH_STATUS.ACTIVE },
    ];
    assert.deepEqual(
      countedMatches(matches, null).map((m) => m._id),
      ['m1']
    );
  });

  test('按回放顺序排好，同日多场也不抖动', () => {
    const matches = [
      casualSingles('third', 'u1', 'u2', day(3)),
      casualSingles('first', 'u1', 'u2', day(1)),
      casualSingles('second', 'u1', 'u2', day(2)),
    ];
    assert.deepEqual(
      countedMatches(matches, null).map((m) => m._id),
      ['first', 'second', 'third']
    );
  });

  test('非数组与空数组给空结果', () => {
    assert.deepEqual(countedMatches(null, null), []);
    assert.deepEqual(countedMatches([], null), []);
  });
});

describe('tallyPairUsage —— 每对已经用了多少名额', () => {
  test('单打逐场累加', () => {
    const matches = [];
    for (let i = 1; i <= 3; i += 1) matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));

    const usage = tallyPairUsage(matches);
    assert.equal(usage.get(pairKey('u1', 'u2')), 3);
    assert.equal(usage.size, 1);
  });

  test('双打一场给四组对子各记一场', () => {
    const usage = tallyPairUsage([casualDoubles('m1', ['a', 'b'], ['c', 'd'], day(1))]);
    assert.equal(usage.size, 4);
    for (const key of [['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd']]) {
      assert.equal(usage.get(pairKey(key[0], key[1])), 1);
    }
    // 同队的搭档之间不算：那不是交手
    assert.equal(usage.get(pairKey('a', 'b')), undefined);
    assert.equal(usage.get(pairKey('c', 'd')), undefined);
  });

  test('超限时如实报出实际场次，不截到上限', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 3; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    assert.equal(tallyPairUsage(matches).get(pairKey('u1', 'u2')), RATED_PAIR_LIMIT + 3);
  });

  test('赛事与撤销都不计入', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      { ...casualSingles('m2', 'u1', 'u2', day(2)), eventId: 'e1' },
      casualSingles('m3', 'u1', 'u2', day(3), MATCH_STATUS.REVOKED),
    ];
    assert.equal(tallyPairUsage(matches).get(pairKey('u1', 'u2')), 1);
  });

  test('没有比赛的会员不出现在表里', () => {
    assert.equal(tallyPairUsage([]).size, 0);
    assert.equal(tallyPairUsage(null).size, 0);
  });
});

describe('seasonPairCounts —— 我本赛季和每个人打过几场', () => {
  test('单打：只给对手记一场', () => {
    const counts = seasonPairCounts('u1', [casualSingles('m1', 'u1', 'u2', day(1))]);
    assert.deepEqual(counts, { u2: 1 });
  });

  test('双打：只数对面的两个人，搭档不算', () => {
    const counts = seasonPairCounts('me', [
      casualDoubles('m1', ['me', 'mate'], ['x', 'y'], day(1)),
    ]);
    assert.deepEqual(counts, { x: 1, y: 1 });
    assert.equal(counts.mate, undefined, '搭档不是交手对象');
  });

  test('打了好几场就累加', () => {
    const matches = [];
    for (let i = 1; i <= 4; i += 1) matches.push(casualSingles(`m${i}`, 'u2', 'u1', day(i)));
    assert.deepEqual(seasonPairCounts('u1', matches), { u2: 4 });
  });

  test('没交过手的人不出现，而不是给 0', () => {
    const counts = seasonPairCounts('u1', [casualSingles('m1', 'u3', 'u4', day(1))]);
    assert.deepEqual(counts, {});
  });

  test('两边都有我的脏数据算不出交手，跳过', () => {
    const counts = seasonPairCounts('u1', [casualSingles('m1', 'u1', 'u1', day(1))]);
    assert.deepEqual(counts, {});
  });

  test('编号为空或缺失时给出空表，不抛错', () => {
    assert.deepEqual(seasonPairCounts('', [casualSingles('m1', 'u1', 'u2', day(1))]), {});
    assert.deepEqual(seasonPairCounts(null, [casualSingles('m1', 'u1', 'u2', day(1))]), {});
  });

  test('与名额表同一口径：赛事与撤销都不算', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      { ...casualSingles('m2', 'u1', 'u2', day(2)), eventId: 'e1' },
      casualSingles('m3', 'u1', 'u2', day(3), MATCH_STATUS.REVOKED),
    ];
    assert.deepEqual(seasonPairCounts('u1', matches), { u2: 1 });
  });

  test('赛季分界点之前的场次不算本赛季', () => {
    const matches = [
      casualSingles('old', 'u1', 'u2', day(1)),
      casualSingles('new', 'u1', 'u2', day(10)),
    ];
    assert.deepEqual(seasonPairCounts('u1', matches, { seasonStart: day(5) }), { u2: 1 });
  });
});

describe('checkSubmitAllowed —— 提交前那道闸门', () => {
  /** 造 n 场 u1 对 u2 的日常单打 */
  function played(n, a = 'u1', b = 'u2') {
    const matches = [];
    for (let i = 1; i <= n; i += 1) matches.push(casualSingles(`m${i}`, a, b, day(i)));
    return matches;
  }

  const draft = (a = 'u1', b = 'u2') => ({
    _id: 'new',
    teamA: [a],
    teamB: [b],
    matchTime: day(28),
    matchType: 1,
  });

  test('还没打满就放行', () => {
    const result = checkSubmitAllowed(draft(), played(RATED_PAIR_LIMIT - 1));
    assert.equal(result.ok, true);
    assert.deepEqual(result.pairs, []);
    assert.equal(result.message, '');
  });

  test('正好打满时，下一场就被拦下', () => {
    const result = checkSubmitAllowed(draft(), played(RATED_PAIR_LIMIT));
    assert.equal(result.ok, false);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].count, RATED_PAIR_LIMIT);
    assert.ok(result.message.includes(String(RATED_PAIR_LIMIT)));
  });

  test('拦下时用人话说清楚是谁和谁', () => {
    const names = { u1: '小明', u2: '小红' };
    const result = checkSubmitAllowed(draft(), played(RATED_PAIR_LIMIT), {
      nameOf: (id) => names[id],
    });
    assert.ok(result.message.includes('小明'));
    assert.ok(result.message.includes('小红'));
    assert.ok(!result.message.includes('u1|u2'), '不该把内部键抛给用户看');
  });

  test('拿不到昵称时退回编号，不抛错', () => {
    const result = checkSubmitAllowed(draft(), played(RATED_PAIR_LIMIT), {
      nameOf: () => undefined,
    });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('u1'));
  });

  test('只拦满员的那一对，其余照常放行', () => {
    // u1-u2 打满，u3-u4 只打了一场：u3 的提交不受影响
    const matches = played(RATED_PAIR_LIMIT).concat(casualSingles('x', 'u3', 'u4', day(20)));
    assert.equal(checkSubmitAllowed(draft('u3', 'u4'), matches).ok, true);
    assert.equal(checkSubmitAllowed(draft('u1', 'u2'), matches).ok, false);
  });

  test('双打里只要有一组满额，整场拦下并报出是哪一组', () => {
    // u1 与 x 已经打满；新的一场是 u1+mate 对 x+y
    const matches = played(RATED_PAIR_LIMIT, 'u1', 'x');
    const doubles = {
      _id: 'new',
      teamA: ['u1', 'mate'],
      teamB: ['x', 'y'],
      matchTime: day(28),
      matchType: 2,
    };

    const result = checkSubmitAllowed(doubles, matches);
    assert.equal(result.ok, false);
    assert.equal(result.pairs.length, 1, '只报满额的那一组');
    assert.deepEqual([result.pairs[0].a, result.pairs[0].b].sort(), ['u1', 'x']);
  });

  test('一场双打里两组都满额时，多出来的那句写进提示', () => {
    const matches = played(RATED_PAIR_LIMIT, 'u1', 'x').concat(played(RATED_PAIR_LIMIT, 'mate', 'y'));
    const doubles = {
      _id: 'new',
      teamA: ['u1', 'mate'],
      teamB: ['x', 'y'],
      matchTime: day(28),
      matchType: 2,
    };

    const result = checkSubmitAllowed(doubles, matches);
    assert.equal(result.ok, false);
    assert.equal(result.pairs.length, 2);
    assert.ok(result.message.includes('另有 1 对'));
  });

  test('赛事比赛不占名额，也就拦不到', () => {
    const matches = played(RATED_PAIR_LIMIT);
    const eventDraft = { ...draft(), eventId: 'e1' };
    assert.equal(checkSubmitAllowed(eventDraft, matches).ok, true);
  });

  test('撤销一场之后名额释放，又能录了', () => {
    const matches = played(RATED_PAIR_LIMIT);
    matches[0] = { ...matches[0], status: MATCH_STATUS.REVOKED };
    assert.equal(checkSubmitAllowed(draft(), matches).ok, true);
  });

  test('本赛季分界点之前的场次不占名额', () => {
    const result = checkSubmitAllowed(draft(), played(RATED_PAIR_LIMIT), {
      seasonStart: day(10),
    });
    assert.equal(result.ok, true, '全在分界点之前，本赛季一场没打');
  });

  test('上限设成非正数等于关掉这道闸门', () => {
    assert.equal(checkSubmitAllowed(draft(), played(30), { limit: 0 }).ok, true);
    assert.equal(checkSubmitAllowed(draft(), played(30), { limit: -1 }).ok, true);
    assert.equal(checkSubmitAllowed(draft(), played(30), { limit: NaN }).ok, true);
  });

  test('没有待提交的记录时放行', () => {
    assert.equal(checkSubmitAllowed(null, played(30)).ok, true);
  });

  test('自定义上限按新数字判，不是写死 15', () => {
    assert.equal(checkSubmitAllowed(draft(), played(3), { limit: 3 }).ok, false);
    assert.equal(checkSubmitAllowed(draft(), played(2), { limit: 3 }).ok, true);
  });
});

/* ============================================================
 * 事务内复核用的两个小函数（2026-10-16 独立验收 F3 的配套）
 * ============================================================
 * 提交闸门原先只看「整份台账算出来的用量」，那是事务外快照；并发下两个请求
 * 各自都能通过。现在事务内还要按计数文档再判一次，判的就是这两个函数：
 * findCappedPairs 挑出已满的对，pairCapMessage 说同一句话。
 */

const { findCappedPairs, pairCapMessage } = require('../src/server/services/rating-cap.js');

describe('findCappedPairs —— 按给定用量挑出已满额的对', () => {
  const pairs = [
    { key: 'a|b', a: 'a', b: 'b' },
    { key: 'a|c', a: 'a', b: 'c' },
  ];

  test('Map 与普通对象两种用量都认', () => {
    const viaMap = findCappedPairs(pairs, new Map([['a|b', RATED_PAIR_LIMIT]]), { limit: RATED_PAIR_LIMIT });
    assert.equal(viaMap.ok, false);
    assert.deepEqual(viaMap.full.map(row => row.key), ['a|b']);

    const viaObject = findCappedPairs(pairs, { 'a|b': RATED_PAIR_LIMIT }, { limit: RATED_PAIR_LIMIT });
    assert.deepEqual(viaObject.full.map(row => row.count), [RATED_PAIR_LIMIT]);
  });

  test('差一场不算满：14 场在上限 15 下必须放行', () => {
    const result = findCappedPairs(pairs, { 'a|b': RATED_PAIR_LIMIT - 1 }, { limit: RATED_PAIR_LIMIT });
    assert.equal(result.ok, true);
    assert.deepEqual(result.full, []);
  });

  test('同一对出现两次只报一次；超限的历史数据如实报出用量', () => {
    const twice = [...pairs, { key: 'a|b', a: 'a', b: 'b' }];
    const result = findCappedPairs(twice, { 'a|b': RATED_PAIR_LIMIT + 3 }, { limit: RATED_PAIR_LIMIT });
    assert.equal(result.full.length, 1);
    assert.equal(result.full[0].count, RATED_PAIR_LIMIT + 3);
  });

  test('上限关闭（<=0）或传空清单时一律放行', () => {
    assert.equal(findCappedPairs(pairs, { 'a|b': 99 }, { limit: 0 }).ok, true);
    assert.equal(findCappedPairs([], { 'a|b': 99 }).ok, true);
    assert.equal(findCappedPairs(null, null).ok, true);
  });
});

describe('pairCapMessage —— 满额提示', () => {
  test('给出名字、场次与上限，并提示换对手或等下赛季', () => {
    const message = pairCapMessage([{ key: 'a|b', a: 'a', b: 'b', count: RATED_PAIR_LIMIT }],
      { limit: RATED_PAIR_LIMIT, nameOf: id => ({ a: '甲', b: '乙' }[id]) });
    assert.match(message, /甲 与 乙/);
    assert.match(message, new RegExp(`已经打了 ${RATED_PAIR_LIMIT} 场`));
    assert.match(message, /等下个赛季/);
  });

  test('多对满额时只报第一对，其余给一句计数', () => {
    const full = [
      { key: 'a|b', a: 'a', b: 'b', count: RATED_PAIR_LIMIT },
      { key: 'a|c', a: 'a', b: 'c', count: RATED_PAIR_LIMIT },
    ];
    const message = pairCapMessage(full, { limit: RATED_PAIR_LIMIT });
    assert.match(message, /另有 1 对也已满额/);
  });

  test('没有满额的对时给空串（调用方据此放行）', () => {
    assert.equal(pairCapMessage([], { limit: RATED_PAIR_LIMIT }), '');
    assert.equal(pairCapMessage(null), '');
  });
});

/* ============================================================
 * 端到端：这条上限确实作用在数据源上
 * ============================================================ */


/** 一份合法的单打录入参数 */
function draft(teamA, teamB) {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: [teamA],
    teamB: [teamB],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    matchTime: '2026-05-01T18:00:00',
    location: '学校体育馆 1 号场',
  };
}

/** 拿一条「本赛季已打满名额」的无序对键，演示流水里一定存在 */
function fullPairKey(ledger, seasonStart) {
  const usage = tallyPairUsage(ledger, { seasonStart });
  const full = [...usage.entries()].filter(([, count]) => count >= RATED_PAIR_LIMIT);
  assert.ok(full.length > 0, '演示流水里应当有成对打满上限的会员，否则这条测试验不出东西');
  return full[0][0];
}
