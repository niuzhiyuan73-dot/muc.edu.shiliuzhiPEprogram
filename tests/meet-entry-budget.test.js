/**
 * 运动会名单提交：事务操作预算（2026-10-22 第二轮审查 B-1／B-2）
 * ============================================================
 * 【为什么单独一个文件】
 * 本地内存仓储没有事务上限（云端约 100 个操作，见 cloud-repo.js 的
 * TX_OPERATION_BUDGET），所以「配得出、报不进」这类问题在原有测试里全绿也照不出来：
 *   · 配置侧允许团体项目配到 200 人，「入场式展示」模板默认就是 20 人；
 *   · 提交侧原来每人约 9 个事务操作，10 人以上必然超预算。
 * 于是管理员配一个默认的 20 人项目，学院部长点提交只会收到
 * 「事务读写总操作预算不足：请缩小本次处理范围」——纯开发者文案，部长无从下手。
 *
 * 这里给内存仓储套一层**按云端口径计数**的探针，把「一次提交用了多少个操作」
 * 变成可断言的事实，而不是靠人肉推算。
 *
 * 计数口径与 cloud-repo.js 的 instrumentTransaction 对齐：
 *   · 每次 getById          → 1 读
 *   · 顶层 set              → 1 写
 *   · 受范围 set/update     → 读归属(1) + 写(1)；同一事务内已读过同一 _id 则只计写
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../miniprogram/services/meet-context.js');
const meetService = require('../miniprogram/services/meet-service.js');
const leadService = require('../miniprogram/services/meet-college-lead-service.js');
const reg = require('../miniprogram/services/meet-registration-service.js');
const { meetEventKey, meetInterestKey, MEET_ENTRY_MAX_MEMBERS } = require('../miniprogram/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../miniprogram/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-17T09:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-20T23:59' };
/** 云端事务预算（cloud-repo.js 的 TX_OPERATION_BUDGET 默认值） */
const CLOUD_TX_BUDGET = 100;
const ROSTER = 20;

const studentIds = Array.from({ length: ROSTER }, (_, i) => `u_s${String(i + 1).padStart(2, '0')}`);

const users = [
  { _id: 'u_admin', openId: 'o_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  { _id: 'u_lead', openId: 'o_lead', name: '一部部长', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
  ...studentIds.map(id => ({ _id: id, openId: `o_${id}`, name: id, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL })),
];
const colleges = [
  { _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '信息工程学院', status: 'active' },
];
const schoolMembers = ['u_admin', 'u_lead', ...studentIds].map(userId => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId: 'c01',
  status: 'active', gender: 'male',
}));
const schoolRoles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

/**
 * 给仓储套一个按云端口径计数的事务探针。
 *
 * 预算是**按单个事务**计的，所以这里逐事务记账，断言看的是"最贵的那个事务"，
 * 而不是一次调用的总和（提交名单会有主事务 + 意向回写两个事务）。
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
              // 受范围写：写前必读一次归属；同一事务里读过同一 _id 则命中读缓存
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

/** 建一个「报名窗口已开、配好 20 人项目、授好部长」的世界 */
async function makeWorld(templateId = 'show-parade') {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });
  const probe = instrument(repo);

  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);

  // 入场式展示是 20 人团体；多人绑腿跑是 20 人「多人协作组」（计入个人兼项额度）。
  const configured = await meetService.configureMeetEvent(
    { templateId, group: 'mixed', members: ROSTER, perCollegeLimit: 1 }, admin,
  );
  assert.equal(configured.ok, true, `配置 ${ROSTER} 人项目（${templateId}）应成功：${configured.message}`);
  await meetService.publishMeetRegistration(WINDOW, admin);
  await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);

  const eventKey = meetEventKey(meetId, templateId, 'mixed');
  // 全员提交意向（D14：部长只能从申请人里选）
  for (const userId of studentIds) {
    const res = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
    assert.equal(res.ok, true, `${userId} 提交意向应成功：${res.message}`);
  }
  return { repo, meetId, eventKey, probe };
}

test(`配到上限（${ROSTER} 人）的团体项目：一次提交不超事务预算`, async () => {
  const { repo, meetId, eventKey, probe } = await makeWorld();

  probe.reset();
  const result = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: studentIds }, await ctxOf(repo, 'u_lead', meetId),
  );

  assert.equal(result.ok, true, `20 人名单应提交成功，实际：${result.message}`);
  assert.equal(result.data.entry.members, ROSTER);
  // 打印实际用量，便于后续调整上限时有据可依（可用 TX_PROBE=1 打开）
  if (process.env.TX_PROBE === '1') {
    probe.stats.perTx.forEach((tx, i) => {
      console.log(`[tx] 第 ${i + 1} 个事务：读 ${tx.reads} / 写 ${tx.writes} / 合计 ${tx.reads + tx.writes}（${ROSTER} 人名单）`);
    });
  }
  // 这是这条用例存在的理由：云端超预算会整个事务失败，本地必须提前看见
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map(tx => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );
});

test('20 人多人协作组：撤回不超事务预算，意向回到待选拔', async () => {
  const { repo, meetId, eventKey, probe } = await makeWorld('fun-multi-leg');
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: studentIds }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(submitted.ok, true, submitted.message);

  probe.reset();
  const withdrawn = await reg.withdrawMeetCollegeEntry(
    { entryKey: submitted.data.entry._id }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(withdrawn.ok, true, withdrawn.message);
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `撤回最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map(tx => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );
  const interest = await repo.sportsMeetInterests.getById(meetInterestKey(meetId, eventKey, studentIds[0]));
  assert.equal(interest.status, 'pending', '撤回后意向应回到待选拔');
  assert.equal(interest.entryKey, '');
});

test('20 人多人协作组：驳回不超事务预算，意向回到待选拔', async () => {
  const { repo, meetId, eventKey, probe } = await makeWorld('fun-multi-leg');
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: studentIds }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(submitted.ok, true, submitted.message);

  probe.reset();
  const rejected = await reg.reviewMeetEntry(
    { entryKey: submitted.data.entry._id, decision: 'reject', reason: '预算用例' },
    await ctxOf(repo, 'u_admin', meetId),
  );
  assert.equal(rejected.ok, true, rejected.message);
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `驳回最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map(tx => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );
  const interest = await repo.sportsMeetInterests.getById(meetInterestKey(meetId, eventKey, studentIds[0]));
  assert.equal(interest.status, 'pending', '驳回后意向应回到待选拔');
  assert.equal(interest.entryKey, '');
});

test('提交后 20 人的意向全部转为「已选入」', async () => {
  const { repo, meetId, eventKey } = await makeWorld();
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: studentIds }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(submitted.ok, true, submitted.message);

  for (const userId of studentIds) {
    const interest = await repo.sportsMeetInterests.getById(
      require('../miniprogram/utils/meet-scope.js').meetInterestKey(meetId, eventKey, userId),
    );
    assert.equal(interest.status, 'selected', `${userId} 的意向应转为已选入`);
    assert.equal(interest.entryKey, submitted.data.entry._id);
  }
});

test('超过上限的名单在进入事务前就被拒（不花一次数据库读）', async () => {
  const { repo, meetId, eventKey, probe } = await makeWorld();
  probe.reset();
  const tooMany = [...studentIds, 'u_lead'];
  const result = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: tooMany }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`最多 ${MEET_ENTRY_MAX_MEMBERS} 人`));
  assert.equal(probe.stats.perTx.length, 0, '超限名单不该开启任何事务');
});

test('配置侧与提交侧共用同一个人数上限', async () => {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 60 届', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const admin = await ctxOf(repo, 'u_admin', created.data.meet.meetId);

  const tooBig = await meetService.configureMeetEvent(
    { templateId: 'show-parade', group: 'mixed', members: MEET_ENTRY_MAX_MEMBERS + 1 }, admin,
  );
  assert.equal(tooBig.ok, false, '超上限的人数应在配置阶段就被拒');
  assert.match(tooBig.message, new RegExp(`${MEET_ENTRY_MAX_MEMBERS}`));
});

test('抽签之后名单不能再撤回', async () => {
  const { repo, meetId, eventKey } = await makeWorld();
  const submitted = await reg.submitMeetCollegeEntry(
    { eventKey, userIds: studentIds }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(submitted.ok, true, submitted.message);
  const event = await repo.sportsMeetEvents.getById(eventKey);
  await repo.sportsMeetEvents.set(eventKey, { ...event, bracket: { size: 2, totalRounds: 1 } });
  const withdrawn = await reg.withdrawMeetCollegeEntry(
    { entryKey: submitted.data.entry._id }, await ctxOf(repo, 'u_lead', meetId),
  );
  assert.equal(withdrawn.ok, false);
  assert.match(withdrawn.message, /已抽签/);
});
