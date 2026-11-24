/**
 * 学校维度：学院赛列表行装载器 loadCollegeEventListRows
 * ============================================================
 * 【为什么现在才补】`school-college-view.js` 的列表行装载器是赛事页 / 全部
 * 学院赛页的学院赛分支唯一取数口，但 P10 合并批之前它零测试覆盖——旧栈那条
 * 「管理员置顶学院赛排在列表最前，普通会员无权置顶」的端到端用例守的是协议 1
 * 的 loadEventsView。删旧栈前必须先把等价覆盖建起来。
 *
 * 守的是（旧栈用例的 S2 对应）：
 *   1. 服务端排好序的学院赛列表被如实下发（不重排）；
 *   2. 管理员置顶后该学院赛排到列表最前，行带 pinned 标记；
 *   3. canPin 与发布 / 置顶同一门槛：管理员有、普通会员没有；
 *   4. 普通会员置顶被拒，列表不变。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createCollegeFixture, ADMIN, MEMBER } = require('./helpers/school-college-fixture');
const view = require('../miniprogram/packageCollege/services/school-college-view.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/** 发布一场学院赛（S2 写路径），返回 eventId。 */
async function publish(fixture, token, extra = {}) {
  const published = await fixture.publishCollegeEvent({
    title: `置顶测试学院赛 ${token}`,
    legPlan: ['MS', 'WS'],
    startTime: '2026-10-01T09:00:00',
    rosterMin: 1,
    rosterMax: 20,
    courtCount: 4,
    ...extra,
  }, ADMIN);
  assert.equal(published.ok, true, published.firstError);
  return published.record._id;
}

describe('学院赛列表行 —— 旧栈置顶端到端的 S2 对应', () => {
  test('管理员置顶后该学院赛排到最前，canPin 按管理权下发；会员无权置顶', async () => {
    const fixture = createCollegeFixture();
    try {
      // 服务端排序：置顶优先，同状态按开赛时间升序——
      // 先发的 A 开赛更早，默认排前面；置顶后发的 B 才能看出被提到最前。
      const first = await publish(fixture, 'a', { startTime: '2026-10-01T09:00:00' });
      const second = await publish(fixture, 'b', { startTime: '2026-10-02T09:00:00' });

      fixture.to(ADMIN);
      const before = await view.loadCollegeEventListRows(SCOPE);
      assert.equal(before.rows[0].eventId, first, '未置顶时先开赛的排前面');
      assert.equal(before.rows[0].pinned, false);

      const denied = await fixture.api(MEMBER).setCollegeEventPinned({ eventId: second, pinned: true });
      assert.equal(denied.ok, false, '普通会员不能置顶');
      assert.match(denied.message, /没有管理学院赛的权限/);

      const done = await fixture.api(ADMIN).setCollegeEventPinned({ eventId: second, pinned: true });
      assert.equal(done.ok, true, done.message);

      const adminRows = await view.loadCollegeEventListRows(SCOPE);
      assert.equal(adminRows.rows[0].eventId, second, '置顶的学院赛排到最前');
      assert.equal(adminRows.rows[0].pinned, true);
      assert.equal(adminRows.rows[0].canPin, true, '管理员看得到置顶开关');

      // 普通会员看同一份列表：置顶标记照旧可见，但拿不到置顶开关
      fixture.to(MEMBER);
      const memberRows = await view.loadCollegeEventListRows(SCOPE);
      assert.equal(memberRows.rows[0].eventId, second);
      assert.equal(memberRows.rows[0].pinned, true);
      assert.equal(memberRows.rows[0].canPin, false, '普通会员拿不到置顶开关');
    } finally {
      fixture.close();
    }
  });
});
