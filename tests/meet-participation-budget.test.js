/**
 * 「我的参赛页」的按人下推（2026-10-23 第三轮 X-9）
 * ============================================================
 * 一届运动会的意向与名单是「项目 × 学院 × 名额」，报名旺季数千条；而这一页
 * 只显示本人的那几条。原实现把两个集合**整届读回来再按 userId 筛**
 * （30~50 页 RPC），现在下推成 `listByUser`。
 *
 * 这组用例钉四件事：
 *   1. 两个集合的**整表读调用数为 0**（改回去就红）；
 *   2. 只回本人的行——**取回后不再复筛**，原语漏掉范围条件会当场暴露；
 *   3. 名单按 `userIds`（数组）匹配，一行多人里包含我即命中；
 *   4. 跨届不可见：范围条件内置在仓储里，不是调用方记得传。
 * ============================================================
 */

process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const reg = require('../src/server/services/meet-registration-service.js');
const { MEET_INTEREST_STATUS, MEET_ENTRY_STATUS } = require('../src/shared/utils/meet-scope.js');

const SCHOOL = 'muc';
const MEET = 'mt_muc_59';
const OTHER_MEET = 'mt_muc_60';
const NOW = new Date('2026-10-23T10:00:00Z');

const users = [
  ['u_me', '本人'], ['u_mate', '队友'], ['u_other', '别人'],
].map(([id, name]) => ({
  _id: id, openId: `o_${id}`, nickName: name,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));

async function fixture() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users,
    sportsMeets: [
      { _id: MEET, meetId: MEET, schoolId: SCHOOL, name: '第 59 届田径运动会' },
      { _id: OTHER_MEET, meetId: OTHER_MEET, schoolId: SCHOOL, name: '第 60 届田径运动会' },
    ],
  });

  const scoped = repo.forMeet({ schoolId: SCHOOL, meetId: MEET });
  await scoped.sportsMeetEvents.set('e100', { name: '100 米', group: 'male' });
  await scoped.sportsMeetEvents.set('e200', { name: '200 米', group: 'male' });

  // 意向：本人两条（一条已撤回）、别人一条
  await scoped.sportsMeetInterests.set('i100', {
    userId: 'u_me', eventKey: 'e100', status: MEET_INTEREST_STATUS.PENDING, collegeId: 'c01',
  });
  await scoped.sportsMeetInterests.set('i200', {
    userId: 'u_me', eventKey: 'e200', status: MEET_INTEREST_STATUS.WITHDRAWN, collegeId: 'c01',
  });
  await scoped.sportsMeetInterests.set('i_other', {
    userId: 'u_other', eventKey: 'e100', status: MEET_INTEREST_STATUS.PENDING, collegeId: 'c02',
  });

  // 名单：一行多人（含我）、一行只有别人、一行含我已撤回
  await scoped.sportsMeetEntries.set('en_relay', {
    userIds: ['u_mate', 'u_me'], eventKey: 'e200', status: MEET_ENTRY_STATUS.APPROVED, collegeId: 'c01',
  });
  await scoped.sportsMeetEntries.set('en_other', {
    userIds: ['u_other'], eventKey: 'e100', status: MEET_ENTRY_STATUS.APPROVED, collegeId: 'c02',
  });
  await scoped.sportsMeetEntries.set('en_withdrawn', {
    userIds: ['u_me'], eventKey: 'e100', status: MEET_ENTRY_STATUS.WITHDRAWN, collegeId: 'c01',
  });

  // 另一届里也有本人的意向：范围条件必须把它挡在外面
  await repo.forMeet({ schoolId: SCHOOL, meetId: OTHER_MEET }).sportsMeetInterests.set('i_next', {
    userId: 'u_me', eventKey: 'e100', status: MEET_INTEREST_STATUS.PENDING, collegeId: 'c01',
  });

  return repo;
}

const ctxOf = (repo, actorId = 'u_me', meetId = MEET) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: NOW,
});

/**
 * 统计「整届读」的次数：`sportsMeetInterests.list()` / `sportsMeetEntries.list()`
 * 是这两处读放大的唯一入口。只包 forMeet 返回的那一层——业务全部经过它。
 */
function spyWholeTable(repo) {
  const calls = { interests: 0, entries: 0 };
  const raw = repo.forMeet.bind(repo);
  repo.forMeet = (input) => {
    const surface = raw(input);
    for (const [key, field] of [['sportsMeetInterests', 'interests'], ['sportsMeetEntries', 'entries']]) {
      const original = surface[key].list;
      surface[key].list = (...args) => {
        calls[field] += 1;
        return original.apply(surface[key], args);
      };
    }
    return surface;
  };
  return calls;
}

test('我的参赛页不再整届读意向与名单', async () => {
  const repo = await fixture();
  const spy = spyWholeTable(repo);

  const res = await reg.getMyMeetParticipation({}, await ctxOf(repo));
  assert.equal(res.ok, true, res.message);
  assert.equal(spy.interests, 0, '不该读整届意向（旺季数千条 = 30~50 页 RPC）');
  assert.equal(spy.entries, 0, '不该读整届名单');
});

test('只回本人的意向，撤回状态原样下发', async () => {
  const repo = await fixture();
  const res = await reg.getMyMeetParticipation({}, await ctxOf(repo));
  assert.equal(res.ok, true, res.message);

  const byKey = new Map(res.data.interests.map((row) => [row.eventKey, row]));
  assert.deepEqual([...byKey.keys()].sort(), ['e100', 'e200'], '别人的意向不该出现');
  assert.equal(byKey.get('e100').name, '100 米', '项目名要照常解析');
  assert.equal(byKey.get('e200').status, MEET_INTEREST_STATUS.WITHDRAWN,
    '已撤回的意向仍要下发——页面靠它显示「已撤回」');
});

test('名单按 userIds 数组匹配：一行多人里包含我即命中，撤回的仍被排除', async () => {
  const repo = await fixture();
  const res = await reg.getMyMeetParticipation({}, await ctxOf(repo));
  assert.equal(res.ok, true, res.message);

  assert.deepEqual(res.data.entries.map((row) => row.entryKey), ['en_relay'],
    '只该回含本人且未撤回的那一行');
  assert.equal(res.data.entries[0].status, MEET_ENTRY_STATUS.APPROVED);
  assert.equal(res.data.entries[0].name, '200 米');
});

test('跨届不可见：范围条件在仓储里，不靠调用方记得传', async () => {
  const repo = await fixture();
  const res = await reg.getMyMeetParticipation({}, await ctxOf(repo));
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.interests.length, 2, '下一届的意向不该混进本届');

  // 换到下一届：只看到那一届的那一条
  const next = await reg.getMyMeetParticipation({}, await ctxOf(repo, 'u_me', OTHER_MEET));
  assert.deepEqual(next.data.interests.map((row) => row.eventKey), ['e100']);
});

test('缺 userId 时返回空数组，不退化成整表读（两端同口径）', async () => {
  const repo = await fixture();
  const scoped = repo.forMeet({ schoolId: SCHOOL, meetId: MEET });
  assert.deepEqual(await scoped.sportsMeetInterests.listByUser(''), []);
  assert.deepEqual(await scoped.sportsMeetEntries.listByUser(''), []);
});
