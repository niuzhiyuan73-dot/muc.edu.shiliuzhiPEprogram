/**
 * 运动会发布成绩：事务操作预算（2026-10-22 大用户量复查 W-0）
 * ============================================================
 * 【为什么单独一个文件】
 * 和 B-1（名单提交）是同一个病、另一条路径：发布成绩原来在**一个事务**里
 * 把「每条报名的结果行 + 每条报名的荣誉」按条写，还要逐条比对报名、成绩、
 * 裁判指派是否被人改过。一个 26 院满员的田赛项目是 52 条报名：
 *
 *     ≈ 6（上下文） + 1（项目） + 1（场次） + 52（报名比对）
 *       + 150（裁判分比对） + 3（指派） + 2（发布文档） + 52（总榜）
 *       + 52（结果行） + 52（荣誉） ≈ 370 个操作
 *
 * 云端事务预算约 100（cloud-repo.js 的 TX_OPERATION_BUDGET），于是管理员点
 * 「发布成绩」只会收到「事务读写总操作预算不足：请缩小本次处理范围」。
 * 与用户量无关，报名一多就必然发生——只是本地内存仓储不模拟预算，测试看不出来。
 *
 * 这里给内存仓储套一层按云端口径计数的探针（与 tests/meet-entry-budget.test.js
 * 同一套口径），把「发布一次用了多少个事务操作」变成可断言的事实。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../miniprogram/services/meet-context.js');
const meetService = require('../miniprogram/services/meet-service.js');
const leadService = require('../miniprogram/services/meet-college-lead-service.js');
const reg = require('../miniprogram/services/meet-registration-service.js');
const schedule = require('../miniprogram/services/meet-schedule-service.js');
const score = require('../miniprogram/services/meet-score-service.js');
const standingService = require('../miniprogram/services/meet-standing-service.js');
const { meetEventKey, meetSessionKey } = require('../miniprogram/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../miniprogram/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
/** 云端事务预算（cloud-repo.js 的 TX_OPERATION_BUDGET 默认值） */
const CLOUD_TX_BUDGET = 100;

/** 12 个学院各报 1 人 = 12 条报名，正好是「一多就撞预算」的量级。
 *  （一个学院在一个项目只能提交一条正式名单，所以靠学院数而不是每院人数堆量） */
const COLLEGES = Array.from({ length: 12 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
const LEAD = Object.fromEntries(COLLEGES.map((id) => [id, `u_l_${id}`]));
const STUDENTS = Object.fromEntries(COLLEGES.map((id) => [id, [`u_${id}_1`]]));
const JUDGES = ['u_j1', 'u_j2', 'u_j3'];

const people = [['u_admin', '校管理员']];
for (const id of COLLEGES) {
  people.push([LEAD[id], `${id} 部长`]);
  for (const student of STUDENTS[id]) people.push([student, `${student} 号`]);
}
for (const judge of JUDGES) people.push([judge, judge]);

const users = people.map(([id, name]) => ({
  _id: id, openId: `o_${id}`, name, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const colleges = COLLEGES.map((id, index) => ({
  _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id, name: `${index + 1} 院`, status: 'active',
}));
const memberRows = [['u_admin', 'c01']];
for (const id of COLLEGES) {
  memberRows.push([LEAD[id], id]);
  for (const student of STUDENTS[id]) memberRows.push([student, id]);
}
for (const judge of JUDGES) memberRows.push([judge, 'c01']);
const members = memberRows.map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId, status: 'active', gender: 'male',
}));
const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/**
 * 给仓储套一个按云端口径计数的事务探针（与 meet-entry-budget.test.js 同口径）。
 *
 * @param {Object} repo
 * @returns {{stats:{reads:number, writes:number, peak:number, perTx:Array}, reset:Function}}
 */
function instrument(repo) {
  const stats = { reads: 0, writes: 0, perTx: [] };
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
            return input => wrap(value.call(target, input), true, local);
          }
          if (prop === 'transaction') return value.bind(target);
          if (COUNTED.has(prop)) {
            return (...args) => {
              const id = typeof args[0] === 'string' ? args[0] : '';
              const isWrite = prop !== 'getById';
              if (isWrite && scoped) {
                if (id && !readIds.has(id)) {
                  stats.reads += 1; local.reads += 1; readIds.add(id);
                }
              } else if (!isWrite && id) {
                stats.reads += 1; local.reads += 1; readIds.add(id);
              }
              if (isWrite) { stats.writes += 1; local.writes += 1; }
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
      return await rawTransaction(tx => fn(wrap(tx, false, local)));
    } finally {
      stats.perTx.push(local);
    }
  };
  return {
    stats,
    reset() { stats.reads = 0; stats.writes = 0; stats.perTx.length = 0; },
  };
}

/**
 * 建一届运动会 + 一个「只跑决赛」的 100 米，6 个学院各报 2 人（共 12 条），
 * 派 3 名裁判并把 12 条成绩全部录齐交齐。
 */
async function makeFinishedEvent() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles,
  });
  const probe = instrument(repo);

  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  assert.ok(created.ok, `建赛失败：${created.message}`);
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);

  // rounds='final'：一场定成绩，发布时走「整项目一条成绩」，正是最贵的写法
  const configured = await meetService.configureMeetEvent({
    templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1, rounds: 'final',
  }, admin);
  assert.equal(configured.ok, true, configured.message);
  await meetService.publishMeetRegistration(WINDOW, admin);
  for (const collegeId of COLLEGES) {
    const granted = await leadService.grantMeetCollegeLead(
      { collegeId, userId: LEAD[collegeId] }, admin,
    );
    assert.equal(granted.ok, true, granted.message);
  }

  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  const enrolled = [];
  for (const collegeId of COLLEGES) {
    for (const userId of STUDENTS[collegeId]) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(interest.ok, true, `${userId} 交意向失败：${interest.message}`);
      const submitted = await reg.submitMeetCollegeEntry(
        { eventKey, userIds: [userId] }, await ctxOf(repo, LEAD[collegeId], meetId),
      );
      assert.equal(submitted.ok, true, submitted.message);
      const approved = await reg.reviewMeetEntry(
        { entryKey: submitted.data.entry._id, decision: 'approve' }, admin,
      );
      assert.equal(approved.ok, true, approved.message);
      enrolled.push(userId);
    }
  }
  assert.equal(enrolled.length, 12, '12 院各 1 人，共 12 条报名');

  const sessionKey = meetSessionKey(meetId, eventKey, 'final', 1);
  const saved = await schedule.saveMeetSession({
    eventKey, round: 'final', index: 1,
    startAt: '2026-10-24T09:00', endAt: '2026-10-24T10:00', venue: '田径场直道',
  }, admin);
  assert.equal(saved.ok, true, saved.message);
  for (const judgeId of JUDGES) {
    const assigned = await schedule.assignMeetJudge({ sessionKey, judgeId }, admin);
    assert.equal(assigned.ok, true, assigned.message);
  }

  // 每人一个成绩：12 条 × 3 名裁判 = 36 份成绩单
  for (let i = 0; i < enrolled.length; i += 1) {
    const entryKey = await entryKeyOf(repo, meetId, eventKey, enrolled[i]);
    const rawText = `1${i % 9 + 1}.${String(i * 7 % 100).padStart(2, '0')}`;
    for (const judgeId of JUDGES) {
      const wrote = await score.saveMeetJudgeScore(
        { sessionKey, entryKey, judgeId, rawText }, admin,
      );
      assert.equal(wrote.ok, true, wrote.message);
      const submitted = await score.submitMeetJudgeScore(
        { sessionKey, entryKey, judgeId }, admin,
      );
      assert.equal(submitted.ok, true, submitted.message);
    }
  }

  return { repo, meetId, admin, eventKey, sessionKey, probe, enrolled };
}

async function entryKeyOf(repo, meetId, eventKey, userId) {
  const entries = (await repo.forMeet({ schoolId: SCHOOL, meetId }).sportsMeetEntries.list())
    .filter((doc) => doc.eventKey === eventKey && (doc.userIds || []).includes(userId)
      && doc.status === 'approved');
  assert.equal(entries.length, 1, `${userId} 应有且只有一条有效报名`);
  return entries[0]._id;
}

test('12 条报名、36 份成绩：发布成绩不超事务预算', async () => {
  const { repo, admin, eventKey, probe } = await makeFinishedEvent();

  probe.reset();
  const published = await score.publishMeetResults({ eventKey }, admin);

  assert.equal(published.ok, true, `发布应成功，实际：${published.message}`);
  if (process.env.TX_PROBE === '1') {
    probe.stats.perTx.forEach((tx, i) => {
      console.log(`[tx] 第 ${i + 1} 个事务：读 ${tx.reads} / 写 ${tx.writes} / 合计 ${tx.reads + tx.writes}`);
    });
  }
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map(tx => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );
  assert.equal(published.data.publication.rows.length, 12);
});

test('发布后结果行落库；荣誉表不再写（读端直接取发布快照）', async () => {
  const { repo, meetId, admin, eventKey, sessionKey } = await makeFinishedEvent();
  const published = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(published.ok, true, published.message);
  assert.equal(published.data.publication.detailPending, undefined, '明细不该处于未写完状态');

  const scope = repo.forMeet({ schoolId: SCHOOL, meetId });
  const rows = await scope.sportsMeetResultRows.list();
  assert.equal(rows.length, 12, '12 条报名各一条结果行');
  // 第二十二轮 P2/P3：荣誉派生表停写（没有读方），「我的荣誉」改读发布快照。
  // 这条断言同时防止有人不明就里把写入加回来——那会让每次发布多付 52 条事务写。
  const honors = await scope.sportsMeetHonors.list();
  assert.equal(honors.length, 0, '荣誉表已停写，不应再有新文档');

  // 读接口取到的行数与成绩值都要对得上（明细与快照两条路一致）
  const view = await score.getPublishedResults({ eventKey }, admin);
  assert.equal(view.ok, true, view.message);
  assert.equal(view.data.items.length, 12);
  assert.ok(view.data.items.every((item) => item.text !== '—'), '成绩值不能显示成「—」');
  assert.equal(view.data.items.filter((item) => item.status === 'result').length, 12);

  const all = await score.listMeetPublishedResults({}, admin);
  assert.equal(all.ok, true, all.message);
  assert.equal(all.data.items.length, 1, '一个项目组别一条发布记录');
  assert.equal(all.data.items[0].rounds[0].items.length, 12);
});

test('学院总榜按名次积分，且重发不会把分数翻倍', async () => {
  const { repo, meetId, admin, eventKey } = await makeFinishedEvent();

  const first = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(first.ok, true, first.message);
  const board = await standingService.getMeetStandings({}, admin);
  assert.equal(board.ok, true, board.message);
  const totalAfterFirst = board.data.items.reduce((sum, row) => sum + Number(row.total || 0), 0);
  assert.ok(totalAfterFirst > 0, '正式成绩发布后总榜要有分');

  // 原样重发：净额为 0，总榜一分都不能变（这是「无痕更正」的核心）
  const again = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(again.ok, true, again.message);
  const again2 = await standingService.getMeetStandings({}, admin);
  const totalAfterSecond = again2.data.items.reduce((sum, row) => sum + Number(row.total || 0), 0);
  assert.equal(totalAfterSecond, totalAfterFirst, '重发同样结果，学院总分不能翻倍');
  assert.equal(again.data.publication.version, first.data.publication.version + 1);
});

test('明细索引缺失时读接口回落到发布快照（不显示空白）', async () => {
  const { repo, meetId, admin, eventKey } = await makeFinishedEvent();
  const published = await score.publishMeetResults({ eventKey }, admin);
  assert.equal(published.ok, true, published.message);

  // 模拟「发布成功、明细还没写完」：直接清掉派生索引
  // 把明细的版本改成「上一版」：正是发布成功、明细还没刷新的真实形态
  const scope = repo.forMeet({ schoolId: SCHOOL, meetId });
  for (const doc of await scope.sportsMeetResultRows.list()) {
    await repo.sportsMeetResultRows.set(doc._id, { ...doc, version: -1 });
  }
  const view = await score.getPublishedResults({ eventKey }, admin);
  assert.equal(view.ok, true, view.message);
  assert.equal(view.data.items.length, 12, '明细缺失时要靠发布快照兜底，而不是返回空列表');
  assert.ok(view.data.items.every((item) => item.text !== '—'), '快照里也存了成绩值');
  assert.equal(view.data.items.filter((item) => item.rank === 1).length, 1);
});

test('读成绩单不再逐人点读账号（第三轮审查 X-4）', async () => {
  const { repo, admin, eventKey } = await makeFinishedEvent();
  await score.publishMeetResults({ eventKey }, admin);

  // 只数「读账号」这一次动手：原来是每人一次 getById（12 人 12 次串行；
  // 一届运动会去重后上千人，就是上千次，必然超时）。
  let pointReads = 0;
  const raw = repo.users.getById;
  repo.users.getById = (...args) => { pointReads += 1; return raw.apply(repo.users, args); };
  try {
    const view = await score.getPublishedResults({ eventKey }, admin);
    assert.equal(view.ok, true, view.message);
    assert.equal(view.data.items.length, 12);
    assert.ok(view.data.items.every((item) => item.memberText && item.memberText !== ''),
      '昵称仍要解析出来，批读不能把内容弄丢');
  } finally {
    repo.users.getById = raw;
  }
  assert.equal(pointReads, 0, `成绩单不该逐人点读账号（实际 ${pointReads} 次）`);
});
