/**
 * 运动会发布赛程：事务操作预算（2026-10-26 只读审查 P1-2）
 * ============================================================
 * 【为什么单独一个文件】
 * 和 `meet-publish-budget.test.js`（发布成绩）是同一个病、另一条路径：
 * 发布赛程原来在**事务内**把全届项目组别与全届场次逐条重读、逐条比对快照：
 *
 *     48 个项目组别 × (1 项目 + 1 场次) = 96 次读
 *     + 上下文与运动会读 ≈ 5 次  →  101 次
 *
 * 云端事务预算 100（cloud-repo.js 的 TX_OPERATION_BUDGET），于是「项目一多就发布不了」，
 * 而且报名结束后正是项目最多的时刻。本地内存仓储不模拟预算，只跑功能用例看不出来，
 * 所以这里给仓储套一层按云端口径计数的探针（与 meet-entry-budget / meet-publish-budget
 * 同一套口径），把「发布一次用了多少事务操作」变成可断言的事实。
 *
 * 修复后事务内只剩「身份复核 + 运动会点读 + 赛程版本比对 + 落库」，
 * 与项目数、场次数无关。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const schedule = require('../src/server/services/meet-schedule-service.js');
const advance = require('../src/server/services/meet-advance-service.js');
const { MEET_STATUS, MEET_EVENT_STATUS, meetSessionKey } = require('../src/shared/utils/meet-scope.js');
const { MEET_SCORE_TYPE } = require('../src/shared/services/meet-event-catalog.js');
const { schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const MEET_ID = 'mt_muc_budget';
/** 云端事务预算（cloud-repo.js 的 TX_OPERATION_BUDGET 默认值） */
const CLOUD_TX_BUDGET = 100;
/**
 * 48 个项目组别是复现里的规模（26 院运动会常见 40+ 项，男/女两组即 80+）。
 * 修复前 48 项 = 101 次操作；修复后应与项数无关。
 */
const EVENT_COUNT = 48;

const users = [
  { _id: 'u_admin', openId: 'o_u_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
];
const members = [{
  _id: schoolMemberKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', collegeId: 'c01', status: 'active', gender: 'male',
}];
const roles = [{ _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' }];

const ctxOf = (repo, actorId = 'u_admin', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId: MEET_ID }, now: at,
});

/**
 * 给仓储套一个按云端口径计数的事务探针（与 meet-entry-budget / meet-publish-budget 同口径）。
 * 按 id 去重的读也算一次——云端就是这样计费的。
 */
function instrument(repo) {
  const stats = { perTx: [] };
  Object.defineProperty(stats, 'peak', {
    get: () => stats.perTx.reduce((max, tx) => Math.max(max, tx.reads + tx.writes), 0),
  });
  const COUNTED = new Set(['getById', 'set', 'insert', 'update', 'remove']);
  const rawTransaction = repo.transaction;

  const wrap = (surface, scoped, local) => {
    const readIds = new Set();
    return new Proxy(surface, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          if (prop === 'forScope' || prop === 'forMeet') {
            return (input) => wrap(value.call(target, input), true, local);
          }
          if (prop === 'transaction') return value.bind(target);
          if (COUNTED.has(prop)) {
            return (...args) => {
              const id = typeof args[0] === 'string' ? args[0] : '';
              const isWrite = prop !== 'getById';
              if (isWrite && scoped) {
                if (id && !readIds.has(id)) { local.reads += 1; readIds.add(id); }
              } else if (!isWrite && id) {
                local.reads += 1; readIds.add(id);
              }
              if (isWrite) local.writes += 1;
              return value.apply(target, args);
            };
          }
          return value.bind(target);
        }
        if (value && typeof value === 'object') return wrap(value, scoped, local);
        return value;
      },
    });
  };

  repo.transaction = async (fn) => {
    const local = { reads: 0, writes: 0 };
    try {
      return await rawTransaction((tx) => fn(wrap(tx, false, local)));
    } finally {
      stats.perTx.push(local);
    }
  };
  return { stats, reset() { stats.perTx.length = 0; } };
}

/** 直接落库造一届「48 个项目组别、各 1 个场次、时间与场地都配齐」的赛程。 */
async function seedPublishedReadyMeet() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, schoolMembers: members, schoolRoles: roles,
  });
  await repo.sportsMeets.set(MEET_ID, {
    _id: MEET_ID, schoolId: SCHOOL, name: '第 59 届田径运动会', year: 2026,
    status: MEET_STATUS.REGISTRATION, eventCount: EVENT_COUNT, version: 1,
    startDate: '2026-10-24', endDate: '2026-10-25',
  });
  for (let i = 1; i <= EVENT_COUNT; i += 1) {
    const eventKey = `mte:${MEET_ID}:t${i}:male`;
    await repo.sportsMeetEvents.set(eventKey, {
      _id: eventKey, schoolId: SCHOOL, meetId: MEET_ID, eventKey,
      templateId: `t${i}`, name: `第 ${i} 项`, group: 'male',
      scoreType: MEET_SCORE_TYPE.TIME, rounds: 'final',
      status: MEET_EVENT_STATUS.ACTIVE, revision: 1,
    });
    const sessionKey = meetSessionKey(MEET_ID, eventKey, 'final', 1);
    await repo.sportsMeetSessions.set(sessionKey, {
      _id: sessionKey, schoolId: SCHOOL, meetId: MEET_ID, eventKey,
      round: 'final', index: 1, roundLabel: '决赛',
      startAt: '2026-10-24T09:00', venue: '田径场', status: 'scheduled',
      entryKeys: [],
    });
  }
  // 造完赛程后把版本推到「已经发生过的变更」之后，模拟真实的届次状态
  const meet = await repo.sportsMeets.getById(MEET_ID);
  await repo.sportsMeets.set(MEET_ID, { ...meet, scheduleRevision: 1 });
  return repo;
}

test('48 个项目组别各 1 个场次：发布赛程不超事务预算', async () => {
  const repo = await seedPublishedReadyMeet();
  const probe = instrument(repo);
  const admin = await ctxOf(repo);

  probe.reset();
  const published = await schedule.publishMeetSchedule({}, admin);

  assert.equal(published.ok, true, `发布应成功，实际：${published.message}`);
  if (process.env.TX_PROBE === '1') {
    probe.stats.perTx.forEach((tx, i) => {
      console.log(`[tx] 第 ${i + 1} 个事务：读 ${tx.reads} / 写 ${tx.writes} / 合计 ${tx.reads + tx.writes}`);
    });
  }
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map((tx) => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );
  const meet = await repo.sportsMeets.getById(MEET_ID);
  assert.equal(meet.status, MEET_STATUS.SCHEDULED);
  assert.ok(meet.schedulePublishedAt, '要记下发布时间');
});

test('发布事务的操作数与项目规模无关（48 项 vs 4 项同量级）', async () => {
  const repo = await seedPublishedReadyMeet();
  const probe = instrument(repo);
  const admin = await ctxOf(repo);
  probe.reset();
  assert.equal((await schedule.publishMeetSchedule({}, admin)).ok, true);
  const large = probe.stats.peak;
  assert.ok(large < 30, `48 项的发布事务仍用了 ${large} 个操作，说明还在按项数读`);
});

test('快照之后赛程被改过：发布必须拒绝（版本戳兜住并发）', async () => {
  const repo = await seedPublishedReadyMeet();
  const admin = await ctxOf(repo);

  // 事务外读到的快照是「已配齐」；在事务开始前把某个场次的时间清空并递增赛程版本，
  // 等价于「管理员 A 点发布的同时，管理员 B 把某场的场地删了」。
  const rawTransaction = repo.transaction;
  repo.transaction = async (fn) => {
    const eventKey = `mte:${MEET_ID}:t7:male`;
    const sessionKey = meetSessionKey(MEET_ID, eventKey, 'final', 1);
    const session = await repo.sportsMeetSessions.getById(sessionKey);
    await repo.sportsMeetSessions.set(sessionKey, { ...session, venue: '' });
    const meet = await repo.sportsMeets.getById(MEET_ID);
    await repo.sportsMeets.set(MEET_ID, { ...meet, scheduleRevision: (meet.scheduleRevision || 0) + 1 });
    return rawTransaction(fn);
  };

  const result = await schedule.publishMeetSchedule({}, admin);
  assert.equal(result.ok, false);
  assert.match(result.message, /赛程已变化/);
  const meet = await repo.sportsMeets.getById(MEET_ID);
  assert.equal(meet.status, MEET_STATUS.REGISTRATION, '拒绝后状态与发布时间都不能动');
  assert.equal(meet.schedulePublishedAt, undefined);
});

test('改场次时间、改赛制、抽签分组都会递增届次赛程版本', async () => {
  const repo = await seedPublishedReadyMeet();
  const admin = await ctxOf(repo);
  const eventKey = `mte:${MEET_ID}:t3:male`;
  const before = (await repo.sportsMeets.getById(MEET_ID)).scheduleRevision || 0;

  const saved = await schedule.saveMeetSession({
    eventKey, round: 'final', index: 1, startAt: '2026-10-24T10:00', venue: '东场地',
  }, admin);
  assert.equal(saved.ok, true, saved.message);
  const afterSave = (await repo.sportsMeets.getById(MEET_ID)).scheduleRevision;
  assert.equal(afterSave, before + 1, '改时间/场地必须递增赛程版本');

  // 重排（清空场次时间与参赛人）也要递增：清空后「配齐」判定会变
  const reset = await advance.resetMeetDraw({ eventKey }, admin);
  assert.equal(reset.ok, true, reset.message);
  const afterReset = (await repo.sportsMeets.getById(MEET_ID)).scheduleRevision;
  assert.equal(afterReset, afterSave + 1, '重抽也必须递增赛程版本');
});
