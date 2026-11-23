/**
 * 团队赛事积分表与名次（纯模块）
 * ============================================================
 * 篮球比分是「一个数字」，不能复用个人赛那套按「逐局胜者」累计的积分表。
 * 这一组测试钉住三件事：
 *   1. 排序口径（胜场 → 相互战绩 → 净胜分 → 总得分 → id）
 *   2. 平局在积分表里照算，但不算「谁赢了」
 *   3. 淘汰赛名次按「被淘汰的轮次」倒排，季军赛存在时以它为准
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isFinal, computeTeamTable, computeTeamPlacements,
} = require('../miniprogram/utils/team-standings.js');
const { TEAM_MATCH_STATUS, BRACKET_STAGE } = require('../miniprogram/utils/constants.js');

/** 造一场已发布的比赛 */
function played(teamA, teamB, scoreA, scoreB, extra = {}) {
  const winner = scoreA === scoreB ? null : (scoreA > scoreB ? 'A' : 'B');
  return {
    _id: `${teamA}-${teamB}`,
    teamA, teamB, scoreA, scoreB, winner,
    status: TEAM_MATCH_STATUS.PUBLISHED,
    round: 1, stage: BRACKET_STAGE.MAIN, slot: 0,
    ...extra,
  };
}

const ENTRIES = [
  { teamId: 't1', teamName: '热浪队' },
  { teamId: 't2', teamName: '闪电队' },
  { teamId: 't3', teamName: '磐石队' },
];

test('isFinal —— 只有已发布算定局，平局也算', () => {
  assert.equal(isFinal({ status: TEAM_MATCH_STATUS.PUBLISHED }), true);
  assert.equal(isFinal({ status: TEAM_MATCH_STATUS.REVIEWING }), false);
  assert.equal(isFinal({ status: TEAM_MATCH_STATUS.SCHEDULED }), false);
  assert.equal(isFinal(null), false);
  // 平局（winner 为空）同样是定局：它照样占一场
  assert.equal(isFinal({ status: TEAM_MATCH_STATUS.PUBLISHED, winner: null }), true);
});

test('computeTeamTable —— 胜场优先，同胜场先比相互战绩', () => {
  // t1 与 t2 都是 2 胜 0 负，但 t1 赢了 t2，所以 t1 在前
  const rows = computeTeamTable({
    entries: ENTRIES,
    matches: [
      played('t1', 't2', 80, 70),
      played('t1', 't3', 90, 60),
      played('t2', 't3', 85, 75),
    ],
  });
  assert.deepEqual(rows.map(row => row.teamId), ['t1', 't2', 't3']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, 3]);
  assert.equal(rows[0].wins, 2);
  assert.equal(rows[0].played, 2);
  assert.equal(rows[0].diff, 40); // (80-70) + (90-60)
  assert.equal(rows[2].losses, 2);
});

test('computeTeamTable —— 相互战绩打平就比净胜分，再比总得分', () => {
  // 三队各 1 胜 1 负，相互战绩成环 → 只能靠净胜分
  const rows = computeTeamTable({
    entries: ENTRIES,
    matches: [
      played('t1', 't2', 80, 70), // t1 +10
      played('t3', 't1', 65, 60), // t1 -5 → 净胜 +5
      played('t2', 't3', 90, 80), // t2  0；t3 -5
    ],
  });
  assert.deepEqual(rows.map(row => row.teamId), ['t1', 't2', 't3']);
  assert.deepEqual(rows.map(row => row.diff), [5, 0, -5]);
});

test('computeTeamTable —— 平局计入场次与得失分，但不给任何一方胜场', () => {
  const rows = computeTeamTable({
    entries: ENTRIES.slice(0, 2),
    matches: [played('t1', 't2', 70, 70), played('t1', 't2', 80, 75)],
  });
  const t1 = rows.find(row => row.teamId === 't1');
  const t2 = rows.find(row => row.teamId === 't2');
  assert.equal(t1.played, 2);
  assert.equal(t1.wins, 1, '平局不算赢');
  assert.equal(t1.pointsFor, 150);
  assert.equal(t1.pointsAgainst, 145);
  assert.equal(t2.wins, 0);
});

test('computeTeamTable —— 未发布的比赛不进表，名单外的球队不会凭空出现', () => {
  const rows = computeTeamTable({
    entries: ENTRIES,
    matches: [
      played('t1', 't2', 80, 70, { status: TEAM_MATCH_STATUS.REVIEWING }),
      played('t1', 't9', 90, 60), // t9 不在名单里
    ],
  });
  assert.equal(rows.length, 3);
  rows.forEach(row => assert.equal(row.played, 0));
});

test('computeTeamTable —— 结果与入参顺序无关，绝不留并列', () => {
  const matches = [
    played('t2', 't3', 66, 66),
    played('t1', 't2', 70, 70),
  ];
  const forward = computeTeamTable({ entries: ENTRIES, matches });
  const backward = computeTeamTable({ entries: ENTRIES.slice().reverse(), matches });
  assert.deepEqual(forward.map(row => row.teamId), backward.map(row => row.teamId));
  assert.deepEqual(forward.map(row => row.rank), [1, 2, 3]);
});

test('computeTeamPlacements —— 四队淘汰赛：冠军 / 亚军 / 其余按淘汰轮次', () => {
  const draw = { size: 4, slots: ['t1', 't2', 't3', 't4'] };
  const matches = [
    // 半决赛：t1 赢 t2，t3 赢 t4
    played('t1', 't2', 80, 70, { round: 1, slot: 0 }),
    played('t3', 't4', 75, 60, { round: 1, slot: 1 }),
    // 决赛：t1 赢 t3
    played('t1', 't3', 90, 88, { round: 2, slot: 0 }),
  ];
  const placements = computeTeamPlacements({ draw, matches });
  assert.equal(placements[0].teamId, 't1');
  assert.equal(placements[0].note, '冠军');
  assert.equal(placements[1].teamId, 't3');
  assert.equal(placements[1].note, '亚军');
  // 半决赛的两位负者并列第 3；次序由积分表兜底，但名次必须是 3、4 而不重号
  assert.deepEqual(placements.map(row => row.rank), [1, 2, 3, 4]);
  assert.deepEqual(placements.slice(2).map(row => row.teamId).sort(), ['t2', 't4']);
});

test('computeTeamPlacements —— 有季军赛时以它定 3/4 名', () => {
  const draw = { size: 4, slots: ['t1', 't2', 't3', 't4'] };
  const matches = [
    played('t1', 't2', 80, 70, { round: 1, slot: 0 }),
    played('t3', 't4', 75, 60, { round: 1, slot: 1 }),
    played('t1', 't3', 90, 88, { round: 2, slot: 0 }),
    played('t4', 't2', 70, 65, { round: 2, stage: BRACKET_STAGE.BRONZE, slot: 0 }),
  ];
  const placements = computeTeamPlacements({ draw, matches });
  assert.deepEqual(placements.map(row => row.teamId), ['t1', 't3', 't4', 't2']);
  assert.equal(placements[2].note, '季军');
  assert.equal(placements[3].note, '第四名');
});

test('computeTeamPlacements —— 决赛没发布就一名都排不出来', () => {
  const draw = { size: 4, slots: ['t1', 't2', 't3', 't4'] };
  const matches = [
    played('t1', 't2', 80, 70, { round: 1, slot: 0 }),
    played('t3', 't4', 75, 60, { round: 1, slot: 1 }),
    played('t1', 't3', 90, 88, { round: 2, slot: 0, status: TEAM_MATCH_STATUS.REVIEWING }),
  ];
  assert.deepEqual(computeTeamPlacements({ draw, matches }), []);
  assert.deepEqual(computeTeamPlacements({ draw: null, matches }), []);
});

test('5–8 名排位：名次按排位赛结果，而不是按被淘汰轮次倒排', () => {
  const matches = [
    played('t1', 't8', 80, 70, { round: 1, slot: 0 }),
    played('t2', 't7', 80, 70, { round: 1, slot: 1 }),
    played('t3', 't6', 80, 70, { round: 1, slot: 2 }),
    played('t4', 't5', 80, 70, { round: 1, slot: 3 }),
    played('t1', 't4', 80, 70, { round: 2, slot: 0 }),
    played('t2', 't3', 80, 70, { round: 2, slot: 1 }),
    played('t8', 't7', 80, 70, { round: 2, stage: BRACKET_STAGE.PLACEMENT, slot: 0 }),
    played('t6', 't5', 80, 70, { round: 2, stage: BRACKET_STAGE.PLACEMENT, slot: 1 }),
    played('t1', 't2', 80, 70, { round: 3, slot: 0 }),
    played('t4', 't3', 80, 70, { round: 3, stage: BRACKET_STAGE.BRONZE, slot: 0 }),
    played('t6', 't8', 80, 70, { round: 3, stage: BRACKET_STAGE.PLACEMENT, slot: 0 }),
    played('t5', 't7', 80, 70, { round: 3, stage: BRACKET_STAGE.PLACEMENT, slot: 1 }),
  ];
  const rows = computeTeamPlacements({ draw: { size: 8 }, matches, table: [], placementMode: 'top8' });
  assert.deepEqual(rows.map((row) => `${row.rank}:${row.teamId}`),
    ['1:t1', '2:t2', '3:t4', '4:t3', '5:t6', '6:t8', '7:t5', '8:t7']);
});
