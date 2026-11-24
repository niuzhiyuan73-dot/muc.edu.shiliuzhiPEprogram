/**
 * 演示数据不能过期
 * ============================================================
 * 演示数据的状态（报名中 / 进行中 / 待开赛 / 已结束）是**存下来的字段**，
 * 不随当前时间变化。所以时间锚点一旦写死，过几个月就会出现
 * 「报名中」却开赛在半年前的赛事——界面上自相矛盾，而且只会越来越离谱。
 *
 * 2026-10-20 的实测就是这种事：`school-seed.js` 的锚点钉在 2026-03-01，
 * 种子里 24 场协会个人赛没有一场开赛时间晚于当天；石榴籽杯「进行中」的那届
 * 停在 5 月 18 日；团队赛里还有「已结束」却排在未来的。
 *
 * 这一组按「状态 → 时间应该在哪边」来守，且**不依赖任何具体日期**，
 * 所以日历往前翻它也不会变红：
 *
 *   | 状态            | 开赛时间 |
 *   |-----------------|----------|
 *   | 报名中 / 待开赛  | 必须在将来 |
 *   | 进行中          | 必须已经开始 |
 *   | 已结束          | 必须已经开始 |
 *
 * 锚点的实现见 `services/demo-clock.js`。
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoContent } = require('../miniprogram/services/school-seed.js');
const { createMeetDemoRecords } = require('../miniprogram/services/meet-seed.js');
const {
  EVENT_STATUS, TEAM_EVENT_STATUS, COLLEGE_EVENT_STATUS,
} = require('../src/shared/utils/constants.js');

const msOf = value => new Date(value).getTime();
const content = createSchoolDemoContent();

/**
 * 断言一组赛事里，处于「还没开赛」状态的那些都排在将来。
 *
 * @param {Array<Object>} rows
 * @param {Function} statusOf 取状态
 * @param {Array<*>} pendingStatuses 尚未开赛的状态
 * @param {Function} titleOf 取标题（失败信息用）
 * @param {string} label 分组名
 */
function assertNotStartedYet(rows, statusOf, pendingStatuses, titleOf, label) {
  const now = Date.now();
  const stale = rows.filter(row => pendingStatuses.includes(statusOf(row)) && msOf(row.startTime) <= now);
  assert.deepEqual(
    stale.map(row => `${titleOf(row)} @ ${row.startTime}`), [],
    `${label}里有 ${stale.length} 场「还没开赛却已经把开赛时间排在过去」的赛事——演示时间锚点没有滚动`,
  );
}

/**
 * 断言一组赛事里，处于「已经开打」状态的那些确实已经开赛。
 *
 * @param {Array<Object>} rows
 * @param {Function} statusOf
 * @param {Array<*>} startedStatuses 已开打的、或已结束的状态
 * @param {Function} titleOf
 * @param {string} label
 */
function assertAlreadyStarted(rows, statusOf, startedStatuses, titleOf, label) {
  const now = Date.now();
  const early = rows.filter(row => startedStatuses.includes(statusOf(row)) && msOf(row.startTime) > now);
  assert.deepEqual(
    early.map(row => `${titleOf(row)} @ ${row.startTime}`), [],
    `${label}里有 ${early.length} 场「已经开打 / 已结束却还没到开赛日」的赛事`,
  );
}

test('协会个人赛：报名中的排在将来，进行中与已结束的已经开赛', () => {
  assertNotStartedYet(content.events, row => row.status, [EVENT_STATUS.SIGNUP], row => row.title, '协会个人赛');
  assertAlreadyStarted(content.events, row => row.status,
    [EVENT_STATUS.ONGOING, EVENT_STATUS.FINISHED], row => row.title, '协会个人赛');
});

test('团队赛：报名 / 待开赛的排在将来，进行中与已结束的已经开赛', () => {
  const pending = [TEAM_EVENT_STATUS.DRAFT, TEAM_EVENT_STATUS.REGISTRATION,
    TEAM_EVENT_STATUS.LOCKED, TEAM_EVENT_STATUS.SCHEDULED];
  const started = [TEAM_EVENT_STATUS.RUNNING, TEAM_EVENT_STATUS.FINISHED];
  assertNotStartedYet(content.teamEvents, row => row.status, pending, row => row.name, '团队赛');
  assertAlreadyStarted(content.teamEvents, row => row.status, started, row => row.name, '团队赛');
});

test('石榴籽杯：报名 / 待开赛的排在将来，进行中与已结束的已经开赛', () => {
  const pending = [COLLEGE_EVENT_STATUS.SIGNUP, COLLEGE_EVENT_STATUS.READY];
  const started = [COLLEGE_EVENT_STATUS.ONGOING, COLLEGE_EVENT_STATUS.FINISHED];
  assertNotStartedYet(content.collegeEvents, row => row.status, pending, row => row.title, '石榴籽杯');
  assertAlreadyStarted(content.collegeEvents, row => row.status, started, row => row.title, '石榴籽杯');
});

test('跨校邀请赛：报名中的那一场还没开赛', () => {
  const now = Date.now();
  const stale = content.exchangeEvents.filter(row => row.status === 'signup' && msOf(row.startTime) <= now);
  assert.deepEqual(stale.map(row => `${row.title} @ ${row.startTime}`), [],
    '跨校邀请赛「报名中」的那场已经开赛，报名一定被拒');
});

test('运动会：有一届正在报名、且开赛日在将来；另有一届已经开过', async () => {
  const records = await createMeetDemoRecords();
  const now = Date.now();
  const meets = records.sportsMeets.filter(row => row.registration);
  assert.ok(meets.length >= 3, `演示届太少：${meets.length}`);

  // 「本届」= 报名窗口包含此刻的那一届。不能取 startDate 最大的那届——
  // 演示里还有一届是明年，它的窗口当然还没开。
  const current = meets.filter(row => msOf(row.registration.openAt) <= now
    && msOf(row.registration.closeAt) >= now);
  assert.equal(current.length, 1, `应该恰好一届正在报名，实际 ${current.length} 届`);
  assert.ok(msOf(current[0].startDate) > now,
    `本届（${current[0].name}）已经开过了：${current[0].startDate}`);

  // 历史：至少一届已经开完，否则「历史届」这条演示路径是空的
  const history = meets.filter(row => msOf(row.startDate) < now);
  assert.ok(history.length >= 1, '没有一届过去的运动会，历史记录演示不出来');
});
