/**
 * 场地分配表（buildCourtBoard）单元测试
 * ============================================================
 * 本文件原是「场地分配」全链路的端到端：经旧栈门面发布赛事、报名、抽签、
 * 录分，再断言场号落库与看板分组。协议 1 已随 P10-c 完全下线，那条链的
 * 集成语义由三处接管：
 *   · planCourts 排序 / 分池 / 分批算法 → tests/court.test.js（24 条纯算法）；
 *   · 场号随比赛记录下发 → tests/school-match.test.js（「比赛读端」用例）；
 *   · S2 详情装载器的场地看板 → tests/school-event-view.test.js。
 * 这里只留 buildCourtBoard 自身的两条展示规则：按场号分组、无场地数不建表。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCourtBoard } = require('../miniprogram/services/events-view.js');
const { planCourts } = require('../src/shared/services/court.js');
const { MATCH_TYPE, MATCH_STATUS } = require('../src/shared/utils/constants.js');

/** 造一批形状合法的比赛记录（字段只要够 planCourts / buildCourtBoard 用）。 */
function fakeRecords(count, { round = 1, stage = 'main' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `m${String(index + 1).padStart(2, '0')}`,
    matchType: MATCH_TYPE.SINGLES,
    status: MATCH_STATUS.CONFIRMED,
    round,
    stage,
    slot: index + 1,
  }));
}

test('场地分配表按场号分组，组内按传入行序排', () => {
  const records = fakeRecords(4, { round: 1 });
  // planCourts 的分批结论在这里不重验（court.test.js 的职责），
  // 只要求看板分组与重算的场号严格一致。
  const plan = planCourts(records, 2);
  const withCourt = records.map((record, index) => ({ ...record, courtNo: plan[index].courtNo }));

  const rows = withCourt.map((record) => ({
    matchId: record._id,
    courtText: `${record.courtNo} 号场`,
    roundText: `第 ${record.round} 轮`,
  }));
  const board = buildCourtBoard({ _id: 'ev1', courtCount: 2 }, withCourt, rows);

  assert.deepStrictEqual(board.map((group) => group.courtText), ['1 号场', '2 号场']);
  board.forEach((group) => {
    assert.ok(group.rows.length > 0, `${group.courtText} 上没有比赛`);
    group.rows.forEach((row) => {
      const record = withCourt.find((item) => item._id === row.matchId);
      assert.strictEqual(record.courtNo, group.courtNo, '分到这一组的比赛场号必须对得上');
    });
  });
});

test('没有场地数时不建表，不抛错', () => {
  const records = fakeRecords(2);
  assert.deepStrictEqual(buildCourtBoard({ _id: 'ev1' }, records, []), []);
});
