/**
 * 赛事抽签服务
 * ============================================================
 * utils/bracket.js 保证「签位怎么摆」；这一层保证「摆谁进去」不出错：
 *   1. 谁参赛——未取消的报名者，不看签到，退赛的人不许再进签表；
 *   2. 谁是种子、什么顺序——三种来源各按各的规矩（双打只有手工 / 等级分）；
 *   3. 结果可复核——同一个 seedValue 必得同一张签表。
 * 再钉住几个「不该抽签」的场景（非报名阶段、人不够、双打人不够）。
 *
 * 【双打为什么也在这里】
 * 双打与单打共用同一张签表算法，差别只在「谁算一个签位」：单打是一人，
 * 双打是两人拼成的一支队伍。配对发生在 planDraw 内部（见 planDoublesEntries），
 * 所以配对规则也必须在这一层钉死，否则管理员点的人与他心里的队伍对不上。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  entryIdsOf,
  actualSeedCount,
  seedRankOf,
  teamIdOf,
  splitTeamId,
  teamSeedRankOf,
  manualPlayersNeeded,
  planDoublesEntries,
  resolveSeeds,
  planDraw,
  buildDrawRecord,
  eventMatchKey,
  buildBracketMatches,
  planNextRound,
  buildRoundMatches,
  canRedraw,
  normalizeGroupCount,
  normalizeAdvancePerGroup,
} = require('../src/shared/services/draw.js');
const {
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  RATING_POOL,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  TEAM_ID_SEPARATOR,
  GENDER,
  LEG_DISCIPLINE,
} = require('../src/shared/utils/constants.js');
const { DEFAULT_FORMAT } = require('../src/shared/utils/match-format.js');

/** 一位带单打等级分与赛季积分的会员 */
function member(id, { elo = 1450, points = 0 } = {}) {
  return {
    _id: id,
    points,
    ratings: { [RATING_POOL.SINGLES]: { elo } },
  };
}

/** 一条报名记录 */
function signup(userId, status = SIGNUP_STATUS.SIGNED) {
  return { userId, status };
}

/** 一场单打赛事，报名中 */
function singlesEvent(overrides = {}) {
  return {
    _id: 'e1',
    matchType: MATCH_TYPE.SINGLES,
    status: EVENT_STATUS.SIGNUP,
    seedMode: SEED_MODE.ELO,
    seedCount: 8,
    ...overrides,
  };
}

/**
 * 一位带双打等级分的会员。
 * 双打的种子只看双打池（决策 1），所以这里不写 ratings.singles。
 */
function doublesMember(id, { elo = 1450 } = {}) {
  return { _id: id, ratings: { [RATING_POOL.DOUBLES]: { elo } } };
}

/** 一场双打赛事，报名中 */
function doublesEvent(overrides = {}) {
  return {
    _id: 'e2',
    matchType: MATCH_TYPE.DOUBLES,
    status: EVENT_STATUS.SIGNUP,
    seedMode: SEED_MODE.ELO,
    seedCount: 2,
    ...overrides,
  };
}

/** 两人编号拼成的队号，与 draw.teamIdOf 同形 */
function teamOf(a, b) {
  return [a, b].join(TEAM_ID_SEPARATOR);
}

describe('entryIdsOf —— 参赛者口径', () => {
  test('已取消的人不进签表，不论其余人报名先后', () => {
    const signups = [
      signup('u3'),
      signup('u1', SIGNUP_STATUS.CANCELED),
      signup('u2', SIGNUP_STATUS.CHECKED_IN),
      signup('u4', SIGNUP_STATUS.CANCELED),
    ];
    assert.deepEqual(entryIdsOf(signups), ['u2', 'u3']);
  });

  test('重复记录与空值被剔除', () => {
    const signups = [signup('u1'), signup('u1'), signup(undefined), null];
    assert.deepEqual(entryIdsOf(signups), ['u1']);
  });

  test('签到与否不改变参赛资格', () => {
    const signed = [signup('u1'), signup('u2')];
    const checked = [signup('u1', SIGNUP_STATUS.CHECKED_IN), signup('u2', SIGNUP_STATUS.CHECKED_IN)];
    assert.deepEqual(entryIdsOf(signed), entryIdsOf(checked));
  });
});

describe('actualSeedCount —— 实际种子数取两者较小', () => {
  test('人数多时按选定数量', () => {
    assert.equal(actualSeedCount(8, 16), 8);
    assert.equal(actualSeedCount(4, 5), 4);
  });

  test('人数不超过种子数时人人都是种子', () => {
    assert.equal(actualSeedCount(8, 3), 3);
    assert.equal(actualSeedCount(2, 2), 2);
  });

  test('空名单与非法数量归零', () => {
    assert.equal(actualSeedCount(8, 0), 0);
    assert.equal(actualSeedCount(-1, 8), 0);
  });
});

describe('seedRankOf —— 排序依据', () => {
  test('elo 取单打池的等级分', () => {
    const m = member('u1', { elo: 1700 });
    assert.equal(seedRankOf(m, SEED_MODE.ELO), 1700);
  });

  test('points 取赛季积分，缺失时按 0', () => {
    assert.equal(seedRankOf(member('u1', { points: 42 }), SEED_MODE.POINTS), 42);
    assert.equal(seedRankOf({ _id: 'u2' }, SEED_MODE.POINTS), 0);
  });
});

describe('resolveSeeds —— 三种种子来源', () => {
  const entries = ['u1', 'u2', 'u3', 'u4'];
  const members = [
    member('u1', { elo: 1500 }),
    member('u2', { elo: 1800 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1700 }),
  ];

  test('按等级分降序取前 S 名', () => {
    const res = resolveSeeds({ entries, members, mode: SEED_MODE.ELO, seedCount: 2 });
    assert.equal(res.firstError, '');
    assert.deepEqual(res.seeds, ['u2', 'u4']);
  });

  test('按赛季积分降序取前 S 名，与等级分无关', () => {
    const pointed = [
      member('u1', { elo: 1900, points: 3 }),
      member('u2', { elo: 1400, points: 30 }),
      member('u3', { elo: 1450, points: 10 }),
      member('u4', { elo: 1450, points: 20 }),
    ];
    const res = resolveSeeds({ entries, members: pointed, mode: SEED_MODE.POINTS, seedCount: 2 });
    assert.deepEqual(res.seeds, ['u2', 'u4']);
  });

  test('同分时按编号定序——随机只该来自 seedValue', () => {
    const tied = entries.map((id) => member(id, { elo: 1500 }));
    const res = resolveSeeds({ entries, members: tied, mode: SEED_MODE.ELO, seedCount: 2 });
    assert.deepEqual(res.seeds, ['u1', 'u2']);
  });

  test('手工指定原样采用管理员的顺序', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 2,
      manualOrder: ['u4', 'u1'],
    });
    assert.equal(res.firstError, '');
    assert.deepEqual(res.seeds, ['u4', 'u1']);
  });

  test('手工指定的人数不够时明确报错', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 4,
      manualOrder: ['u1'],
    });
    assert.match(res.firstError, /4 位种子/);
  });

  test('手工指定的种子必须在参赛者之中', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 2,
      manualOrder: ['u9', 'u1'],
    });
    assert.match(res.firstError, /参赛者/);
  });

  test('种子数量不在 2/4/8 之内直接拒绝', () => {
    const res = resolveSeeds({ entries, members, mode: SEED_MODE.ELO, seedCount: 3 });
    assert.match(res.firstError, /2 \/ 4 \/ 8/);
  });
});

describe('planDraw —— 整体与拒绝条件', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));
  // 6 人配 2 个种子：既有种子落位，也有 4 个非种子参与洗牌
  const seededEvent = () => singlesEvent({ seedCount: 2 });

  test('同一个 seedValue 必得同一张签表（可复核）', () => {
    const a = planDraw({ event: seededEvent(), signups, members, seedValue: 20260911 });
    const b = planDraw({ event: seededEvent(), signups, members, seedValue: 20260911 });
    assert.equal(a.ok, true);
    assert.deepEqual(a.slots, b.slots);
    assert.deepEqual(a.byes, b.byes);
  });

  test('不同 seedValue 会得到不同的非种子落位', () => {
    const a = planDraw({ event: seededEvent(), signups, members, seedValue: 1 });
    const b = planDraw({ event: seededEvent(), signups, members, seedValue: 2 });
    assert.notDeepEqual(a.slots, b.slots);
  });

  test('6 人补到 8 签，两个轮空都给了高种子', () => {
    const plan = planDraw({ event: seededEvent(), signups, members, seedValue: 7 });
    assert.equal(plan.size, 8);
    assert.equal(plan.slots.length, 8);
    assert.equal(plan.byes.length, 2);
    // 轮空只能落在种子身上
    assert.ok(plan.byes.every((id) => plan.seeds.includes(id)));
    assert.deepEqual([...plan.byes].sort(), ['u1', 'u2']);
  });

  test('人数不超过种子数时人人按来源顺序排位，不再随机（决策 9.3）', () => {
    const wide = singlesEvent({ seedCount: 8 });
    const a = planDraw({ event: wide, signups, members, seedValue: 1 });
    const b = planDraw({ event: wide, signups, members, seedValue: 2 });
    assert.deepEqual(a.slots, b.slots, '6 人配 8 个种子，没有非种子可洗牌');
    assert.deepEqual(a.seeds, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });

  test('1 号与 2 号种子分处上下半区，决赛前不相遇', () => {
    const plan = planDraw({ event: seededEvent(), signups, members, seedValue: 7 });
    const half = plan.size / 2;
    const posOf = (id) => plan.slots.indexOf(id);
    const top = posOf(plan.seeds[0]) < half;
    const second = posOf(plan.seeds[1]) < half;
    assert.notEqual(top, second);
  });

  test('已开赛或已结束都不许抽签', () => {
    for (const status of [EVENT_STATUS.ONGOING, EVENT_STATUS.FINISHED]) {
      const plan = planDraw({ event: singlesEvent({ status }), signups, members, seedValue: 1 });
      assert.equal(plan.ok, false);
      assert.match(plan.message, /报名阶段/);
    }
  });

  test('不足 2 人拒绝抽签', () => {
    const plan = planDraw({ event: singlesEvent(), signups: [signup('u1')], members, seedValue: 1 });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不足 2 人/);
  });

  test('取消报名的人不算数，可能因此凑不够 2 人', () => {
    const plan = planDraw({
      event: singlesEvent(),
      signups: [signup('u1'), signup('u2', SIGNUP_STATUS.CANCELED)],
      members,
      seedValue: 1,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不足 2 人/);
  });

  test('赛事不存在时明确报错', () => {
    const plan = planDraw({ event: null, signups, members, seedValue: 1 });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不存在/);
  });
});

describe('双打 —— 队号、配对与抽签', () => {
  /** 6 人，双打等级分两两成档，正好编成 3 队 */
  const sixMembers = [
    doublesMember('u1', { elo: 1600 }),
    doublesMember('u2', { elo: 1580 }),
    doublesMember('u3', { elo: 1450 }),
    doublesMember('u4', { elo: 1440 }),
    doublesMember('u5', { elo: 1300 }),
    doublesMember('u6', { elo: 1290 }),
  ];
  const sixSignups = sixMembers.map((m) => signup(m._id));

  test('队号是两人编号拼成的串，拆得回来', () => {
    assert.equal(teamIdOf(['u1', 'u2']), teamOf('u1', 'u2'));
    assert.deepEqual(splitTeamId(teamOf('u1', 'u2')), ['u1', 'u2']);
    // 单打编号拆出来还是一个人，两种项目共用同一套签表算法
    assert.deepEqual(splitTeamId('u1'), ['u1']);
    assert.deepEqual(splitTeamId(''), []);
  });

  test('teamSeedRankOf —— 一队的排位依据是两人双打等级分之和', () => {
    const map = new Map(sixMembers.map((m) => [m._id, m]));
    assert.equal(teamSeedRankOf(['u1', 'u2'], map), 3180);
    assert.equal(teamSeedRankOf(['u5', 'u6'], map), 2590);
  });

  test('teamSeedRankOf —— 查无此人不硬凑默认分', () => {
    const map = new Map(sixMembers.map((m) => [m._id, m]));
    assert.equal(teamSeedRankOf(['u1', 'nobody'], map), 1600);
  });

  test('按等级分：双打池高分两两成队，队伍分从高到低即种子顺序', () => {
    const plan = planDraw({
      event: doublesEvent({ seedCount: 2 }),
      signups: sixSignups,
      members: sixMembers,
      seedValue: 9,
    });

    assert.equal(plan.ok, true);
    assert.deepEqual(
      plan.entries.slice(0, 2),
      [teamOf('u1', 'u2'), teamOf('u3', 'u4')],
      '最强的两人先成一队，次强的两人成第二队'
    );
    assert.deepEqual(plan.seeds, [teamOf('u1', 'u2'), teamOf('u3', 'u4')]);
    assert.equal(plan.entries.length, 3, '6 人编 3 队');
    assert.equal(plan.size, 4, '3 队补到 4 个签位');
    // 3 队 4 签，多出的一个签位是轮空，只能落在 1 号种子队上
    assert.deepEqual(plan.byes, [teamOf('u1', 'u2')]);
  });

  test('按等级分：取的确实是双打池，不是单打池', () => {
    // 单打分与双打分刻意相反：只有按双打池排，才会是 u3/u4 先成一队
    const members = [
      { _id: 'u1', ratings: { singles: { elo: 1900 }, doubles: { elo: 1200 } } },
      { _id: 'u2', ratings: { singles: { elo: 1850 }, doubles: { elo: 1210 } } },
      { _id: 'u3', ratings: { singles: { elo: 1300 }, doubles: { elo: 1600 } } },
      { _id: 'u4', ratings: { singles: { elo: 1250 }, doubles: { elo: 1650 } } },
    ];
    const plan = planDraw({
      event: doublesEvent({ seedCount: 2 }),
      signups: members.map((m) => signup(m._id)),
      members,
      seedValue: 1,
    });

    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entries, [teamOf('u4', 'u3'), teamOf('u2', 'u1')], '双打分高的两人先成一队');
  });

  test('混双 —— 一男一女成队，强弱各自保序，不做「最强的男配最弱的女」', () => {
    // 双打等级分由高到低：m1、f1、m2、f2。若无性别意识，相邻配对会变成
    // m1+f1（恰好）、m2+f2（恰好）——所以换个分数让相邻配对必然出错：
    // 设 m1 1600、m2 1590、f1 1300、f2 1290，相邻配对是 m1+m2、f1+f2（两队同性），
    // 按性别保序配对才是 m1+f1、m2+f2。
    const members = [
      { _id: 'm1', gender: GENDER.MALE, ratings: { doubles: { elo: 1600 } } },
      { _id: 'm2', gender: GENDER.MALE, ratings: { doubles: { elo: 1590 } } },
      { _id: 'f1', gender: GENDER.FEMALE, ratings: { doubles: { elo: 1300 } } },
      { _id: 'f2', gender: GENDER.FEMALE, ratings: { doubles: { elo: 1290 } } },
    ];
    const plan = planDraw({
      event: doublesEvent({ discipline: LEG_DISCIPLINE.XD, seedCount: 1 }),
      signups: members.map((m) => signup(m._id)),
      members,
      seedValue: 1,
    });

    assert.equal(plan.ok, true);
    assert.deepEqual(
      plan.entries,
      [teamOf('m1', 'f1'), teamOf('m2', 'f2')],
      '男女各自按强弱保序，第 i 强男配第 i 强女'
    );
    assert.deepEqual(plan.seeds, [teamOf('m1', 'f1')], '第一队即 1 号种子');
  });

  test('混双 —— 男女人数不相等时拒绝抽签，并说清各几人', () => {
    const members = [
      { _id: 'm1', gender: GENDER.MALE, ratings: { doubles: { elo: 1600 } } },
      { _id: 'm2', gender: GENDER.MALE, ratings: { doubles: { elo: 1500 } } },
      { _id: 'm3', gender: GENDER.MALE, ratings: { doubles: { elo: 1400 } } },
      { _id: 'f1', gender: GENDER.FEMALE, ratings: { doubles: { elo: 1300 } } },
    ];
    const plan = planDraw({
      event: doublesEvent({ discipline: LEG_DISCIPLINE.XD, seedCount: 1 }),
      signups: members.map((m) => signup(m._id)),
      members,
      seedValue: 1,
    });

    assert.equal(plan.ok, false);
    assert.match(plan.message, /男女人数相等/);
    assert.match(plan.message, /男 3 人、女 1 人/);
  });

  test('手工指定：先点的人两两成队，前若干队为种子', () => {
    const plan = planDraw({
      event: doublesEvent({ seedMode: SEED_MODE.MANUAL, seedCount: 2 }),
      signups: sixSignups,
      members: sixMembers,
      seedValue: 3,
      manualOrder: ['u6', 'u1', 'u5', 'u2'],
    });

    assert.equal(plan.ok, true);
    assert.deepEqual(
      plan.seeds,
      [teamOf('u6', 'u1'), teamOf('u5', 'u2')],
      '1、2 号种子队 = 管理员点选的第 1–4 位，两人一队'
    );
    assert.deepEqual(plan.entries.slice(0, 2), plan.seeds);
    // 剩下两位（u3、u4）由 seedValue 决定谁在前
    assert.deepEqual(plan.entries.slice(2), [teamOf('u3', 'u4')]);
  });

  test('手工指定的点数必须是种子组数 × 2', () => {
    const plan = planDraw({
      event: doublesEvent({ seedMode: SEED_MODE.MANUAL, seedCount: 2 }),
      signups: sixSignups,
      members: sixMembers,
      seedValue: 3,
      manualOrder: ['u1', 'u2', 'u3'],
    });

    assert.equal(plan.ok, false);
    assert.match(plan.message, /4 位参赛者/);
  });

  test('手工指定的种子必须在参赛者之中', () => {
    const plan = planDraw({
      event: doublesEvent({ seedMode: SEED_MODE.MANUAL, seedCount: 2 }),
      signups: sixSignups,
      members: sixMembers,
      seedValue: 3,
      manualOrder: ['u9', 'u1', 'u2', 'u3'],
    });

    assert.equal(plan.ok, false);
    assert.match(plan.message, /参赛者/);
  });

  test('双打没有赛季积分，按积分定种子被拒', () => {
    const plan = planDraw({
      event: doublesEvent({ seedMode: SEED_MODE.POINTS }),
      signups: sixSignups,
      members: sixMembers.map((m) => ({ ...m, points: 30 })),
      seedValue: 1,
    });

    assert.equal(plan.ok, false);
    assert.match(plan.message, /没有赛季积分/);
  });

  test('人不够 4 名、或人数不是偶数时拒绝抽签', () => {
    const two = planDraw({
      event: doublesEvent(),
      signups: ['u1', 'u2'].map((id) => signup(id)),
      members: sixMembers.slice(0, 2),
      seedValue: 1,
    });
    assert.equal(two.ok, false);
    assert.match(two.message, /至少需要 4 名/);

    const odd = planDraw({
      event: doublesEvent(),
      signups: ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => signup(id)),
      members: sixMembers.slice(0, 5),
      seedValue: 1,
    });
    assert.equal(odd.ok, false);
    assert.match(odd.message, /偶数/);
  });

  test('生成的比赛两侧各两人，项目与池都按双打写死', () => {
    const plan = planDraw({
      event: doublesEvent({ seedCount: 2 }),
      signups: sixSignups,
      members: sixMembers,
      seedValue: 9,
    });
    const drafts = buildBracketMatches(plan, {
      event: { _id: 'e2', matchType: MATCH_TYPE.DOUBLES, location: '馆', startTime: null },
    });

    assert.ok(drafts.length > 0, '3 队 4 签，首轮应有一场');
    for (const draft of drafts) {
      assert.equal(draft.matchType, MATCH_TYPE.DOUBLES);
      assert.equal(draft.pool, MATCH_TYPE_TO_POOL[MATCH_TYPE.DOUBLES]);
      assert.equal(draft.teamA.length, 2, '双打一方是两个人');
      assert.equal(draft.teamB.length, 2);
    }
  });

  test('双败至少 4 队：2 队时报错', () => {
    const plan = planDraw({
      event: doublesEvent({ format: EVENT_FORMAT.DOUBLE_ELIM, seedCount: 2 }),
      signups: ['u1', 'u2', 'u3', 'u4'].map((id) => signup(id)),
      members: sixMembers.slice(0, 4),
      seedValue: 1,
    });

    assert.equal(plan.ok, false);
    assert.match(plan.message, /4 组参赛队伍/);
  });

  test('planDoublesEntries —— 手动调用与 planDraw 同一口径', () => {
    const res = planDoublesEntries({
      entries: ['u1', 'u2', 'u3', 'u4'],
      members: sixMembers.slice(0, 4),
      mode: SEED_MODE.ELO,
      seedCount: 2,
      seedValue: 1,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.entries, [teamOf('u1', 'u2'), teamOf('u3', 'u4')]);
    assert.deepEqual(res.seeds, res.entries, '2 队配 2 组种子，人人都是种子');
  });

  test('manualPlayersNeeded —— 双打点的人数 = 种子组数 × 2，封顶参赛人数', () => {
    assert.equal(manualPlayersNeeded(8, 6), 6, '3 队，种子组数最多 3');
    assert.equal(manualPlayersNeeded(2, 8), 4, '2 组种子 = 4 位参赛者');
    assert.equal(manualPlayersNeeded(8, 0), 0);
  });
});

describe('buildDrawRecord —— 落库形状', () => {
  test('算法内容与台账信息拼成 draw 字段', () => {
    const plan = planDraw({
      event: singlesEvent(),
      signups: ['u1', 'u2', 'u3', 'u4'].map((id) => signup(id)),
      members: [member('u1'), member('u2'), member('u3'), member('u4')],
      seedValue: 99,
    });
    const drawnAt = new Date('2026-09-11T10:00:00');
    const record = buildDrawRecord(plan, { drawnAt, drawnBy: 'admin', drawCount: 2 });

    assert.equal(record.seedMode, SEED_MODE.ELO);
    assert.equal(record.seedCount, 8);
    assert.equal(record.seedValue, 99);
    assert.equal(record.drawCount, 2);
    assert.equal(record.drawnBy, 'admin');
    assert.deepEqual(record.drawnAt, drawnAt);
    assert.equal(record.size, plan.size);
    assert.deepEqual(record.slots, plan.slots);
    assert.deepEqual(record.seeds, plan.seeds);
    assert.deepEqual(record.byes, plan.byes);
  });

  test('分组赛的 draw 落库带组信息，单败淘汰不落 groups（保持旧形状）', () => {
    const entries = ['u1', 'u2', 'u3', 'u4'];
    const grouped = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.ROUND_ROBIN }),
      signups: entries.map((id) => signup(id)),
      members: entries.map((id) => member(id)),
      seedValue: 5,
    });
    const groupedRecord = buildDrawRecord(grouped, { drawnAt: new Date('2026-09-11T10:00:00'), drawnBy: 'admin' });

    assert.equal(groupedRecord.format, EVENT_FORMAT.ROUND_ROBIN);
    assert.equal(groupedRecord.groupCount, 1);
    assert.deepEqual(groupedRecord.groups, [{ group: 0, entries: grouped.groups[0].entries }]);

    const solo = planDraw({
      event: singlesEvent(),
      signups: entries.map((id) => signup(id)),
      members: entries.map((id) => member(id)),
      seedValue: 5,
    });
    const soloRecord = buildDrawRecord(solo, { drawnAt: new Date('2026-09-11T10:00:00'), drawnBy: 'admin' });

    assert.equal(soloRecord.format, EVENT_FORMAT.SINGLE_ELIM);
    assert.equal(soloRecord.groups, undefined);
  });
});

describe('eventMatchKey —— 确定性编号', () => {
  test('同一场赛事的同一签位恒得同一个编号', () => {
    assert.equal(eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0), eventMatchKey('e1', 1, 'main', 0));
  });

  test('赛事、轮次、阶段、签位任一变则编号变', () => {
    const base = eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0);
    assert.notEqual(base, eventMatchKey('e2', 1, BRACKET_STAGE.MAIN, 0));
    assert.notEqual(base, eventMatchKey('e1', 2, BRACKET_STAGE.MAIN, 0));
    assert.notEqual(base, eventMatchKey('e1', 1, BRACKET_STAGE.BRONZE, 0));
    assert.notEqual(base, eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 1));
  });

  test('缺省阶段按主赛处理', () => {
    assert.equal(eventMatchKey('e1', 1, null, 2), eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 2));
  });

  test('四参调用与旧版逐字节一致（历史比赛的 _id 不能变）', () => {
    assert.equal(eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0), 'x_e1_r1_main_0');
    assert.equal(eventMatchKey('e1', 2, BRACKET_STAGE.BRONZE, 0), 'x_e1_r2_bronze_0');
  });

  test('带上小组段：同轮同签位不同组是两场比赛', () => {
    assert.equal(eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 0), 'x_e1_g0_r2_group_1');
    assert.notEqual(
      eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 0),
      eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 1)
    );
  });
});

describe('planDraw —— 循环 / 小组赛改走分组排期', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));

  test('循环赛：收起成单组，六人排五轮', () => {
    const plan = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.ROUND_ROBIN }),
      signups,
      members,
      seedValue: 5,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.format, EVENT_FORMAT.ROUND_ROBIN);
    assert.equal(plan.slots.length, 0, '不摆签表');
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].group, 0);
    assert.equal(plan.groups[0].entries.length, 6);
    assert.equal(plan.groups[0].rounds.length, 5);
  });

  test('小组赛：蛇形分组，种子被摊到不同组', () => {
    const plan = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2 }),
      signups,
      members,
      seedValue: 5,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.groups.length, 2);
    // 成员全是种子，顺序即 elo 序，蛇形分组的落位完全确定
    assert.deepEqual(plan.groups[0].entries, ['u1', 'u4', 'u5']);
    assert.deepEqual(plan.groups[1].entries, ['u2', 'u3', 'u6']);
  });

  test('不传组数按缺省 2 组；组数超过人数则收敛', () => {
    const byDefault = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT }),
      signups,
      members,
      seedValue: 5,
    });
    assert.equal(byDefault.groups.length, 2);

    const three = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 4 }),
      signups: signups.slice(0, 3),
      members: members.slice(0, 3),
      seedValue: 5,
    });
    assert.equal(three.groups.length, 3, '不超过人数，免得出现空组');
  });

  test('同一个 seedValue 的分组结果可复核', () => {
    const event = singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2 });
    const a = planDraw({ event, signups, members, seedValue: 42 });
    const b = planDraw({ event, signups, members, seedValue: 42 });
    assert.deepEqual(a.groups, b.groups);
  });

  test('小组数可选 8 组，出线人数可选 4 人', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      member(`u${index + 1}`, { elo: 2000 - index * 10 })
    );
    const plan = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 8 }),
      signups: many.map((item) => signup(item._id)),
      members: many,
      seedValue: 5,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.groups.length, 8, '8 人恰好一人一组');
    assert.equal(normalizeGroupCount(8), 8);
    assert.equal(normalizeAdvancePerGroup(4), 4);
    assert.equal(normalizeAdvancePerGroup(9), 2, '越界回落到缺省');
  });
});

describe('buildBracketMatches —— 首轮比赛生成', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));
  // 6 人配 2 个种子 → 8 签、4 个签位对、其中 2 对含轮空
  const planned = (seedValue = 7, seedCount = 2) =>
    planDraw({ event: singlesEvent({ seedCount }), signups, members, seedValue });
  const theEvent = (overrides = {}) =>
    singlesEvent({ _id: 'e9', location: '体育馆', startTime: '2026-09-20T09:00:00', ...overrides });

  test('有一方轮空的签位不生成比赛', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });
    const playable = plan.pairs.filter(([a, b]) => a && b).length;

    assert.equal(plan.byes.length, 2);
    assert.equal(drafts.length, playable);
    assert.equal(drafts.length, 2);
  });

  test('轮空者不出现在任何一场比赛里', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });
    const playing = new Set(drafts.flatMap((d) => [...d.teamA, ...d.teamB]));
    assert.ok(plan.byes.every((id) => !playing.has(id)));
  });

  test('每场都带 eventId 与轮次/阶段/签位，且签位互不重复', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });

    const slots = drafts.map((d) => d.slot);
    assert.equal(new Set(slots).size, slots.length);

    for (const draft of drafts) {
      assert.equal(draft.eventId, 'e9');
      assert.equal(draft.round, 1);
      assert.equal(draft.stage, BRACKET_STAGE.MAIN);
      assert.equal(draft.matchType, MATCH_TYPE.SINGLES);
      assert.equal(draft.pool, MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES]);
      assert.equal(draft.teamA.length, 1);
      assert.equal(draft.teamB.length, 1);
      // 还没开打：比分空、胜方未知、录入人待赛后补
      assert.deepEqual(draft.scoreA, []);
      assert.deepEqual(draft.scoreB, []);
      assert.equal(draft.winner, null);
      assert.equal(draft.recorder, null);
      assert.equal(draft.location, '体育馆');
      assert.equal(new Date(draft.matchTime).toISOString(), new Date('2026-09-20T09:00:00').toISOString());
      assert.equal(draft.gamePoints, DEFAULT_FORMAT.gamePoints);
      assert.equal(draft.bestOf, DEFAULT_FORMAT.bestOf);
    }
  });

  test('同一签位上的编号与抽签结果无关——重抽才能覆盖而不是追加', () => {
    const a = buildBracketMatches(planned(1), { event: theEvent() });
    const b = buildBracketMatches(planned(2), { event: theEvent() });
    assert.deepEqual(
      a.map((d) => d._id).sort(),
      b.map((d) => d._id).sort()
    );
  });

  test('对局双方都来自参赛者', () => {
    const plan = planned();
    const entries = new Set(plan.entries);
    for (const draft of buildBracketMatches(plan, { event: theEvent() })) {
      assert.ok(entries.has(draft.teamA[0]));
      assert.ok(entries.has(draft.teamB[0]));
      assert.notEqual(draft.teamA[0], draft.teamB[0]);
    }
  });

  test('抽签失败或赛事缺失时不产出任何比赛', () => {
    assert.deepEqual(buildBracketMatches({ ok: false }, { event: theEvent() }), []);
    assert.deepEqual(buildBracketMatches(null, { event: theEvent() }), []);
    assert.deepEqual(buildBracketMatches(planned(), { event: null }), []);
  });
});

describe('canRedraw —— 重抽前置', () => {
  test('尚无比赛时可重抽', () => {
    assert.equal(canRedraw([]), true);
  });

  test('全部尚未确认时仍可重抽', () => {
    assert.equal(canRedraw([{ status: MATCH_STATUS.PENDING }]), true);
  });

  test('已有比赛生效（已计 elo）即禁止重抽', () => {
    assert.equal(
      canRedraw([{ status: MATCH_STATUS.PENDING }, { status: MATCH_STATUS.ACTIVE }]),
      false
    );
  });
});

/* ============================================================
 * 逐轮推进（决策 5.2）
 * ============================================================ */

/** 该赛事的一场既有比赛：编号由轮次 / 阶段 / 签位确定 */
function eventMatchRecord(eventId, round, stage, slot, winner, status = MATCH_STATUS.ACTIVE) {
  return { _id: eventMatchKey(eventId, round, stage, slot), round, stage, slot, winner, status };
}

describe('planNextRound —— 逐轮推进', () => {
  const eventId = 'e1';
  // 4 人 4 签：首轮两场，胜者会师决赛
  const fourDraw = { size: 4, slots: ['u1', 'u2', 'u3', 'u4'] };

  test('首轮没打完，排不出下一轮', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      matches: [eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A')],
    });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.rounds, []);
  });

  test('待确认的比赛不算打完，照样排不出下一轮', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A', MATCH_STATUS.PENDING),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
      ],
    });
    assert.equal(plan.ok, false);
  });

  test('首轮全部生效，按签位排出决赛对阵', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'), // u1 胜 u2
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'), // u4 胜 u3
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.rounds.length, 1);
    assert.deepEqual(plan.rounds[0], {
      round: 2,
      stage: BRACKET_STAGE.MAIN,
      pairs: [['u1', 'u4']],
    });
  });

  test('打三四名：半决赛结束同时排出决赛与季军赛', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'), // 负者 u2
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'), // 负者 u3
      ],
    });
    const bronze = plan.rounds.find((round) => round.stage === BRACKET_STAGE.BRONZE);
    assert.deepEqual(bronze, {
      round: 2,
      stage: BRACKET_STAGE.BRONZE,
      pairs: [['u2', 'u3']],
    });
  });

  test('并列季军：只排决赛，不生成季军赛', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
      ],
    });
    assert.equal(plan.rounds.length, 1);
    assert.equal(plan.rounds[0].stage, BRACKET_STAGE.MAIN);
  });

  test('下一轮已排过（哪怕还只是待确认）就不再返回，免得抹掉已录比分', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
        eventMatchRecord(eventId, 2, BRACKET_STAGE.MAIN, 0, null, MATCH_STATUS.PENDING),
      ],
    });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.rounds, []);
  });

  test('决赛打完，签表到头，不再产出任何对阵', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
        eventMatchRecord(eventId, 2, BRACKET_STAGE.MAIN, 0, 'A'),
      ],
    });
    assert.equal(plan.ok, false);
  });

  test('轮空的一方直接晋级，只等另一半区打完', () => {
    // 4 签少一人：u1 首轮轮空
    const draw = { size: 4, slots: ['u1', null, 'u3', 'u4'] };
    const plan = planNextRound({
      eventId,
      draw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'A')], // u3 胜 u4
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.rounds[0].pairs, [['u1', 'u3']]);
  });

  test('没有签表就排不出对阵', () => {
    assert.equal(planNextRound({ eventId, draw: null }).ok, false);
    assert.equal(planNextRound({ eventId, draw: { slots: ['u1'] } }).ok, false);
  });
});

describe('buildRoundMatches —— 逐轮对阵生成', () => {
  const event = { _id: 'e7', location: '体育馆', startTime: '2026-06-10T09:00:00' };

  test('按对阵生成草稿，编号带轮次与阶段', () => {
    const drafts = buildRoundMatches(event, {
      round: 2,
      stage: BRACKET_STAGE.BRONZE,
      pairs: [['u2', 'u3']],
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]._id, eventMatchKey('e7', 2, BRACKET_STAGE.BRONZE, 0));
    assert.deepEqual(drafts[0].teamA, ['u2']);
    assert.deepEqual(drafts[0].teamB, ['u3']);
    assert.equal(drafts[0].winner, null);
    assert.deepEqual(drafts[0].scoreA, []);
    assert.equal(drafts[0].stage, BRACKET_STAGE.BRONZE);
    assert.equal(drafts[0].eventId, 'e7');
  });

  test('缺赛事或缺对阵一律返回空数组', () => {
    assert.deepEqual(buildRoundMatches(null, { round: 1, pairs: [['u1', 'u2']] }), []);
    assert.deepEqual(buildRoundMatches(event, { round: 1 }), []);
  });
});

describe('buildRoundMatches —— 赛制按协会议定，抽签时就写进草稿', () => {
  const event = { _id: 'e7', location: '体育馆', startTime: '2026-06-10T09:00:00' };

  test('网球赛制整块进草稿，且不留 gamePoints', () => {
    const format = {
      scoring: 'tennis',
      bestOf: 1,
      setGames: 4,
      tiebreakAt: 4,
      tiebreakPoints: 7,
      noAd: true,
    };
    const drafts = buildRoundMatches(event, { round: 1, pairs: [['u1', 'u2']], format });

    assert.equal(drafts[0].scoring, 'tennis');
    assert.equal(drafts[0].bestOf, 1);
    assert.equal(drafts[0].setGames, 4);
    assert.equal(drafts[0].tiebreakAt, 4);
    assert.equal(drafts[0].tiebreakPoints, 7);
    assert.equal(drafts[0].noAd, true);
    assert.equal(drafts[0].gamePoints, undefined, '按 11 分制解释 4:2 会把整盘读错');
  });

  test('不传赛制时照旧 11 分制 / 一局一胜，老调用方不改也能跑', () => {
    const drafts = buildRoundMatches(event, { round: 1, pairs: [['u1', 'u2']] });
    assert.equal(drafts[0].gamePoints, 11);
    assert.equal(drafts[0].bestOf, 3);
    assert.equal(drafts[0].scoring, undefined);
    assert.equal(drafts[0].setGames, undefined);
  });
});
