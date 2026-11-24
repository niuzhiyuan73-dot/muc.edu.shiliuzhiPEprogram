/**
 * 演示数据规模与差异（2026-10-20 扩容）
 * ============================================================
 * 用户口径：所有项目的当前比赛 ×3（赛事与场次都算），并且每个项目至少两届
 * 历史石榴籽杯，另选两个项目各留一届进行中的。这里把这些口径钉成断言，
 * 免得以后加数据时悄悄少一届、少几场，或者把杯赛挂到不存在的学院上。
 *
 *   1. 球拍四项目：赛事 9 / 6 / 3 / 3，流水 42 / 24 / 18 / 18（基线 ×3，网球从 0 补齐）
 *   2. 团队两项目：赛事各 6 届；篮球 12 场（×3），足球 6 场
 *      （足球学院赛 11 人制只放得下两支院队，两届各 1 场决赛，不再是 4 场）
 *   3. 石榴籽杯：每个项目 ≥2 届已结束；进行中的恰好两个项目（匹克球、篮球）
 *   4. 引用完整：名单 / 大场 / 对阵不许指向不存在的学院或院队
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoContent } = require('../miniprogram/services/school-seed.js');
const {
  COLLEGE_EVENT_STATUS, TEAM_EVENT_STATUS, TEAM_TYPE, TEAM_MATCH_STATUS, CUP_MODE, TIE_STATUS,
} = require('../src/shared/utils/constants.js');

const content = createSchoolDemoContent();

const countBy = (rows, keyOf) => rows.reduce((map, row) => {
  const key = keyOf(row);
  map[key] = (map[key] || 0) + 1;
  return map;
}, {});

test('球拍项目：赛事与比赛流水都扩到 3 倍，网球从 0 补齐', () => {
  const mucEvents = content.events.filter(row => row.schoolId === 'muc');
  // 3/2/1/0 → 9/6/3/3
  assert.deepEqual(countBy(mucEvents, row => row.association), { pkb: 9, tt: 6, bd: 3, tn: 3 });

  // 比赛流水（个人赛）同样 ×3：14 / 8 / 6 / 0 → 42 / 24 / 18 / 18
  const mucMatches = content.matches.filter(row => row.schoolId === 'muc');
  assert.deepEqual(countBy(mucMatches, row => row.association), {
    pkb: 42, tt: 24, bd: 18, tn: 18,
  });
});

test('团队项目：赛事各 6 届，场次按 3 倍补足', () => {
  const teamEvents = countBy(content.teamEvents.filter(row => !row.cupMode),
    row => row.association);
  assert.deepEqual(teamEvents, { bk: 6, fb: 6 });

  // 只数普通团队赛事的场次：石榴籽杯的场次单独在下面守
  const cupIds = new Set(content.teamEvents.filter(row => row.cupMode).map(row => row._id));
  const regularMatches = content.teamMatches.filter(row => !cupIds.has(row.eventId));
  // 篮球 4 → 12（×3）；足球 1 → 4（只有两支 11 人队，凑不出第三支，故 ≥3×）
  const teamMatches = countBy(regularMatches, row => row.association);
  assert.equal(teamMatches.bk, 12);
  assert.ok(teamMatches.fb >= 3, `足球场次应至少 3 场，实际 ${teamMatches.fb}`);
});

test('石榴籽杯：每个项目至少两届历史，且恰有两个项目有进行中的一届', () => {
  const racketFinished = countBy(
    content.collegeEvents.filter(row => row.status === COLLEGE_EVENT_STATUS.FINISHED),
    row => row.association,
  );
  for (const association of ['pkb', 'tt', 'bd', 'tn']) {
    assert.ok((racketFinished[association] || 0) >= 2,
      `${association} 的已结束石榴籽杯不足两届：${racketFinished[association] || 0}`);
  }

  const teamCups = content.teamEvents.filter(row => row.cupMode === CUP_MODE.COLLEGE);
  const teamFinished = countBy(
    teamCups.filter(row => row.status === TEAM_EVENT_STATUS.FINISHED),
    row => row.association,
  );
  for (const association of ['bk', 'fb']) {
    assert.ok((teamFinished[association] || 0) >= 2,
      `${association} 的已结束石榴籽杯不足两届`);
  }

  // 进行中：球拍一个（匹克球）、团队一个（篮球）
  const racketOngoing = content.collegeEvents.filter(row => row.status === COLLEGE_EVENT_STATUS.ONGOING);
  assert.deepEqual(racketOngoing.map(row => row.association), ['pkb']);
  const teamOngoing = teamCups.filter(row => row.status === TEAM_EVENT_STATUS.RUNNING);
  assert.deepEqual(teamOngoing.map(row => row.association), ['bk']);
});

test('石榴籽杯：名单、大场与名次都指向本届参赛学院', () => {
  for (const event of content.collegeEvents) {
    const entries = content.collegeEntries.filter(row => row.eventId === event._id);
    assert.ok(entries.length >= 4, `${event.title} 的名单太少`);
    const colleges = new Set(entries.map(row => row.college));
    assert.equal(colleges.size, entries.length, `${event.title} 同一学院报了多份名单`);

    // 大场两侧必须都是本届报名过的学院
    for (const tie of content.ties.filter(row => row.eventId === event._id)) {
      assert.ok(colleges.has(tie.collegeA) && colleges.has(tie.collegeB),
        `${event.title} 的大场指向未报名的学院`);
      assert.ok(tie.legs.length >= 1, '大场至少一个小项');
    }

    if (event.status === COLLEGE_EVENT_STATUS.FINISHED) {
      assert.equal(event.results.length, entries.length, `${event.title} 名次没有覆盖全部学院`);
      const placed = new Set(event.results.map(row => row.college));
      assert.deepEqual([...placed].sort(), [...colleges].sort());
    }
    if (event.status === COLLEGE_EVENT_STATUS.ONGOING) {
      assert.deepEqual(event.results, [], '进行中的赛事不该有名次');
      const ties = content.ties.filter(row => row.eventId === event._id);
      assert.ok(ties.some(tie => tie.status === TIE_STATUS.FINISHED), '进行中的赛事应已打完若干场');
      assert.ok(ties.some(tie => tie.status !== TIE_STATUS.FINISHED), '进行中的赛事应留有待打的场次');
    }
  }
});

test('石榴籽杯：团队杯赛的院队、报名与对阵互相自洽', () => {
  const cupTeams = new Map(content.teams
    .filter(row => row.type === TEAM_TYPE.COLLEGE)
    .map(row => [row._id, row]));
  // 篮球 5 人制：4 支院队；足球 11 人制：2 支院队（首发就要 11 人，4 队 × 11 = 44 人
  // 种子池撑不住——硬凑只会造出「5 人院队打 11 人制」这种连报告都发不出的数据）
  assert.equal(cupTeams.size, 6, '篮球四支院队 + 足球两支院队');

  for (const event of content.teamEvents.filter(row => row.cupMode === CUP_MODE.COLLEGE)) {
    const football = event.association === 'fb';
    const entries = content.teamEventEntries.filter(row => row.eventId === event._id);
    assert.ok(entries.length >= (football ? 2 : 4), `${event.name} 报名院队不足`);
    for (const entry of entries) {
      assert.ok(cupTeams.has(entry.teamId), `报名指向不存在的院队：${entry.teamId}`);
      assert.ok(entry.roster.length >= (football ? 11 : 5),
        football ? '足球报名名单要凑够 11 人首发' : '院队报名名单至少要凑够上场人数');
    }
    const entered = new Set(entries.map(row => row.teamId));
    for (const match of content.teamMatches.filter(row => row.eventId === event._id)) {
      assert.ok(entered.has(match.teamA) && entered.has(match.teamB),
        `${event.name} 的对阵里有未报名的院队`);
    }
    if (event.status === TEAM_EVENT_STATUS.FINISHED) {
      assert.equal(event.placements.length, entries.length, `${event.name} 名次未覆盖全部院队`);
      // 名次必须有比赛支撑：拿名次的队伍至少出现在一场比赛里
      const played = new Set();
      for (const match of content.teamMatches.filter(row => row.eventId === event._id)) {
        played.add(match.teamA); played.add(match.teamB);
      }
      for (const placement of event.placements) {
        assert.ok(played.has(placement.teamId),
          `${event.name}：${placement.teamName} 一场没打却排第 ${placement.rank}`);
      }
    }
  }
});

test('足球演示：已发布的比赛必须带赛后报告，否则统计与比分都会丢失', () => {
  // 报告是比分与个人统计的唯一真相源：缺了它，比赛详情显示「—」、
  // 出场与战绩全为 0，而赛事上的名次照旧——就是「没打却有亚军」的由来。
  const published = content.teamMatches.filter(row => row.association === 'fb'
    && row.status === TEAM_MATCH_STATUS.PUBLISHED);
  assert.ok(published.length >= 4, '足球演示应有若干场已发布比赛');
  for (const match of published) {
    assert.ok(match.footballPublished, `足球比赛 ${match._id} 已发布却没有赛后报告`);
    assert.equal(match.footballPublished.result.scoreA, match.scoreA);
    assert.equal(match.footballPublished.result.scoreB, match.scoreB);
  }
});

test('演示内容：赛事标题不重名，便于按名字辨认', () => {
  const titles = [
    ...content.events.map(row => `${row.schoolId}/${row.title}`),
    ...content.teamEvents.map(row => `${row.schoolId}/${row.name}`),
    ...content.collegeEvents.map(row => `${row.schoolId}/${row.title}`),
  ];
  assert.equal(new Set(titles).size, titles.length, '赛事标题重复');
});
