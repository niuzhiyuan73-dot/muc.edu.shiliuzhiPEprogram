/**
 * 学校维度：学院赛「发布 → 名单 → 抽签 → 开赛 → 排阵 → 名次结束」
 * （迁移清单 M2-a / M2-b / M2-c）
 *
 * 守的是：
 *   1. 学院赛主记录、名单、大场与小场都钉在 `schoolId + association` 上，跨校读不到、写不进；
 *   2. 学院目录改为**每校独立**：主键用稳定 `collegeId`，判权与校验仍按本校全名，
 *      复用旧栈纯规则（college-event.js / college-entry.js / college-draw.js /
 *      college-tie.js / college-lineup.js），不另抄一份；
 *   3. 发布权仅管理员、名单提交限本学院负责人（管理员可代交）、审核仅管理员、
 *      退回须理由——与旧栈同一口径；
 *   4. 抽签 / 开赛同样仅管理员，必须按顺序（报名中→抽签→待开赛→开赛），抽签只收
 *      已通过名单的学院，开赛只铺首轮且「只补不覆盖」；
 *   5. 排阵限本大场参赛学院（管理员可代交），排阵齐才能开大场，开大场铺出的小场
 *      写进 matches 集合并带范围；名次只记已通过审核的学院、冠军唯一。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-college-service');
const { collegeTieKey } = require('../src/shared/services/college-draw');
const { collegeLegKey, tieStatusOf } = require('../src/shared/services/college-tie');
const {
  schoolMemberKey, schoolMembershipKey, collegeEventKey, collegeEntryKey, collegeKey,
  collegeLineupKey,
} = require('../src/shared/utils/school');
const {
  COLLEGES, COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS,
  LEG_DISCIPLINE, TIE_ALGO, TIE_NET_MODE, MATCH_COMPETITION, MATCH_STATUS,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

const C01 = 'c01';            // 中华民族共同体学院
const C02 = 'c02';            // 民族学与社会学学院
const NAME_C01 = COLLEGES[0];
const NAME_C02 = COLLEGES[1];

/**
 * 演示仓储：民大有三个学院负责人 / 会员分布在 c01、c02。
 *   · demo_muc_admin      —— 校管理员（可发布 / 审核 / 代交任何学院）
 *   · demo_muc_member     —— c01 普通会员
 *   · demo_muc_member_2   —— c01 普通会员
 *   · demo_muc_member_3   —— c02 学院负责人（membership.role=staff + collegeId=c02）
 *   · demo_muc_member_4   —— c02 普通会员
 */
function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, collegeId) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member_2', C01);
  add('demo_muc_member_3', C02);
  add('demo_muc_member_4', C02);
  // c02 的学院负责人：staff + collegeId，与学校身份页授予的「学院负责人」同形。
  seed.memberships.push({
    _id: schoolMembershipKey('demo_muc_member_3', { schoolId: 'muc', association: 'pkb' }),
    userId: 'demo_muc_member_3', schoolId: 'muc', association: 'pkb',
    role: 'staff', collegeId: C02, status: 'active', simulated: true,
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '院际杯羽毛球赛', description: '学院团体赛',
  legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.XD], allowMultiEntry: true,
  rosterMin: 1, rosterMax: 5, tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF,
  startTime: at(DAY), location: '综合体育馆', courtCount: 2, ...extra,
});

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishCollegeEvent', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.event;
}

/* ------------------------------------------------------------ 发布 */

test('正式授权：学籍在 c01，仅管理 c02，不能借学籍提交 c01 名单；事务内改授权也拒绝', async () => {
  const repo = fixture();
  const scope = { schoolId: 'muc', association: 'pkb' };
  const admin = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope, now: NOW });
  const granted = (await require('../src/server/services/school-membership-service').createSchoolHandlers({}).grantSchoolPermission({
    userId: 'demo_muc_member', permission: 'collegeLeader', collegeId: C02, make: true,
  }, admin)).data;
  assert.equal(granted.ok, true, granted.message);
  const event = await publish(repo, 'assigned-college');
  const payload = { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member'] };
  assert.equal((await call(repo, 'submitCollegeEntry', payload, { actor: 'demo_muc_member' })).ok, false);
  const validPayload = { ...payload, collegeId: C02, memberIds: ['demo_muc_member_4'] };
  assert.equal((await call(repo, 'submitCollegeEntry', validPayload, { actor: 'demo_muc_member' })).ok, true);
  const before = await repo.collegeEntries.list();
  const transaction = repo.transaction;
  repo.transaction = async work => {
    const key = schoolMembershipKey('demo_muc_member', scope);
    await repo.memberships.set(key, { ...await repo.memberships.get(key), collegeId: C01 });
    return transaction(work);
  };
  const result = await call(repo, 'submitCollegeEntry', validPayload, { actor: 'demo_muc_member' });
  assert.equal(result.ok, false);
  assert.deepEqual(await repo.collegeEntries.list(), before);
});

test('置顶：审计失败整体回滚，不能留下半次写入', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin-rollback');
  const before = await repo.collegeEvents.getById(event.eventId);
  const transaction = repo.transaction;
  repo.transaction = fn => transaction(async tx => {
    tx.audit.append = async () => { throw new Error('audit unavailable'); };
    return fn(tx);
  });
  await assert.rejects(call(repo, 'setCollegeEventPinned', { eventId: event.eventId, pinned: true }), /audit unavailable/);
  assert.deepEqual(await repo.collegeEvents.getById(event.eventId), before);
});

test('置顶：事务执行前管理权被撤销，重新判权后拒绝', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin-permission');
  const transaction = repo.transaction;
  repo.transaction = async fn => {
    const user = await repo.users.getById('demo_muc_admin');
    await repo.users.set(user._id, { ...user, platformStatus: 'disabled' });
    return transaction(fn);
  };
  const result = await call(repo, 'setCollegeEventPinned', { eventId: event.eventId, pinned: true });
  assert.equal(result.ok, false);
  assert.equal(Boolean((await repo.collegeEvents.getById(event.eventId)).pinned), false);
});

test('发布：仅管理员可发，会员被拒；发布落在报名中', async () => {
  const repo = fixture();
  const byMember = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  // 学院负责人也不能发布（发布权收口到管理员，与个人赛同一门槛）。
  const byLeader = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member_3' });
  assert.equal(byLeader.ok, false);
  assert.match(byLeader.message, /管理员/);

  const byAdmin = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.event.status, COLLEGE_EVENT_STATUS.SIGNUP);
  assert.equal(byAdmin.event.canManage, true);
});

test('发布：请求编号幂等，改内容重发被拒；非法编号与非法表单被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1');
  const again = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(again.ok, true);
  assert.equal(again.event.eventId, first.eventId);

  const changed = await call(repo, 'publishCollegeEvent',
    { requestId: 'r1', ...valid({ title: '改了名字的赛事' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);

  const badToken = await call(repo, 'publishCollegeEvent', { requestId: '非法 编号', ...valid() });
  assert.equal(badToken.ok, false);
  assert.match(badToken.message, /编号无效/);

  const noLeg = await call(repo, 'publishCollegeEvent', { requestId: 'r2', ...valid({ legPlan: [] }) });
  assert.equal(noLeg.ok, false);
  assert.match(noLeg.message, /小项/);

  const noCourt = await call(repo, 'publishCollegeEvent', { requestId: 'r3', ...valid({ courtCount: '' }) });
  assert.equal(noCourt.ok, false);
  assert.match(noCourt.message, /场地/);
});

/* ------------------------------------------------------------ 列表 / 详情 */

test('列表 / 详情：本协会可读，跨校读不到', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const mine = await call(repo, 'listCollegeEvents', {});
  assert.equal(mine.ok, true);
  assert.equal(mine.events.length, 1);
  assert.equal(mine.events[0].eventId, t.eventId);

  const detail = await call(repo, 'getCollegeEvent', { eventId: t.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(detail.ok, true);
  assert.equal(detail.event.eventId, t.eventId);
  assert.equal(detail.canManage, false, '普通会员不能管理');

  const buaaList = await call(repo, 'listCollegeEvents', {},
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaList.events.length, 0);

  const buaaGet = await call(repo, 'getCollegeEvent', { eventId: t.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /不存在/);
});

test('列表：关键词按名称与场地过滤，且在分页之前生效', async () => {
  const repo = fixture();
  await publish(repo, 'kw-1', { title: '2026 春季篮球联赛', location: '主体育馆' });
  await publish(repo, 'kw-2', { title: '2026 秋季篮球联赛', location: '副体育馆' });
  await publish(repo, 'kw-3', { title: '院际杯羽毛球赛', location: '综合馆' });

  const byTitle = await call(repo, 'listCollegeEvents', { keyword: '篮球' });
  assert.equal(byTitle.ok, true);
  assert.equal(byTitle.total, 2, 'total 应是筛选后的口径');
  assert.deepEqual(byTitle.events.map(row => row.title).sort(),
    ['2026 春季篮球联赛', '2026 秋季篮球联赛']);

  const byLocation = await call(repo, 'listCollegeEvents', { keyword: '综合' });
  assert.equal(byLocation.total, 1);
  assert.equal(byLocation.events[0].title, '院际杯羽毛球赛');

  // 分页之前过滤：只取 1 条时拿到的必须是命中集里的第一条，而不是先切页再筛
  const paged = await call(repo, 'listCollegeEvents', { keyword: '篮球', limit: 1 });
  assert.equal(paged.total, 2);
  assert.equal(paged.events.length, 1);
  assert.equal(paged.hasMore, true);

  // 空串 / 纯空格等于不筛；大小写与首尾空格不影响命中
  assert.equal((await call(repo, 'listCollegeEvents', { keyword: '   ' })).total, 3);
  assert.equal((await call(repo, 'listCollegeEvents', { keyword: '  篮球  ' })).total, 2);
  assert.equal((await call(repo, 'listCollegeEvents', { keyword: '不存在的赛事' })).total, 0);
});

/* ------------------------------------------------------------ 名单提交 */
test('名单：学院负责人只能交本学院，管理员可代交', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const wrongCollege = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(wrongCollege.ok, false);
  assert.match(wrongCollege.message, /本学院/);

  const byLeader = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(byLeader.ok, true, byLeader.message);
  assert.equal(byLeader.entry.college, NAME_C02, '落库按本校学院全名');
  assert.equal(byLeader.entry.status, COLLEGE_ENTRY_STATUS.PENDING);

  const byAdmin = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.entry.college, NAME_C01);
});

test('名单：跨院凑人与人数上下限被拒', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1', { rosterMin: 2, rosterMax: 3 });

  const crossCollege = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(crossCollege.ok, false);
  assert.match(crossCollege.message, /不属于本学院/);

  const tooFew = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少 2 人/);

  // 名单里混入外校会员：在本校在册名录里查不到，被拒。
  const foreign = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01,
      memberIds: ['demo_muc_member', 'demo_muc_member_2', 'demo_buaa_member'] },
    { actor: 'demo_muc_admin' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /查不到|不属于本学院/);
});

test('名单：重复提交覆盖同一条，不新增记录', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  const firstRevision = (await repo.collegeEntries.list())[0].revision;
  const again = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.entry.memberCount, 1, '第二次提交覆盖为 1 人');

  const rows = await repo.collegeEntries.list();
  assert.equal(rows.length, 1, '同「赛事 + 学院」只有一条');
  assert.ok(rows[0].revision > firstRevision, '同一条名单版本递增');

  const listed = await call(repo, 'listCollegeEntries', { eventId: t.eventId });
  assert.equal(listed.entries.length, 1);
});

/* ------------------------------------------------------------ 名单审核 */

test('审核：仅管理员；通过后不可再动；退回须理由', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });

  const byMember = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const approved = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.entry.status, COLLEGE_ENTRY_STATUS.APPROVED);

  const again = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经处理过/);

  // 换一个学院：退回必须先给理由。
  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  const noReason = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C01, action: 'reject' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /理由/);

  const returned = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C01, action: 'reject', reason: '名单人数不足' });
  assert.equal(returned.ok, true, returned.message);
  assert.equal(returned.entry.status, COLLEGE_ENTRY_STATUS.RETURNED);
  assert.equal(returned.entry.reason, '名单人数不足');
});

/* ------------------------------------------------------------ 范围隔离 */

test('跨校：外校提交读不到赛事，也写不进名单', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const buaa = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_buaa_member'] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /不存在/);

  const buaaEntries = await call(repo, 'listCollegeEntries', { eventId: t.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaEntries.entries.length, 0);
});

test('主键带范围：学院赛 / 名单都含 schoolId + association', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const storedEvent = await repo.collegeEvents.getById(t.eventId);
  assert.equal(storedEvent.schoolId, 'muc');
  assert.equal(storedEvent.association, 'pkb');

  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  const key = collegeEntryKey(t.eventId, C02, { schoolId: 'muc', association: 'pkb' });
  const storedEntry = await repo.collegeEntries.getById(key);
  assert.equal(storedEntry.schoolId, 'muc');
  assert.equal(storedEntry.association, 'pkb');
  assert.equal(storedEntry.collegeId, C02);

  // 键确实由范围 + 学院编号构成，换个学院编号就是另一条。
  assert.notEqual(key, collegeEntryKey(t.eventId, C01, { schoolId: 'muc', association: 'pkb' }));
  // 学院赛键：换范围即换键。
  assert.notEqual(t.eventId, collegeEventKey('x', { schoolId: 'buaa', association: 'pkb' }));
  assert.equal(await repo.colleges.getById(collegeKey('muc', C02)).then(c => c.collegeId), C02);
});

test('学校目录：每校独立——北航用本校学院名（不在全局 COLLEGES 里）也能过', async () => {
  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };
  const repo = fixture();
  // 民大目录即全局 COLLEGES；提交一个不在目录里的学院名被拒。
  const muc = await publish(repo, 'r1');
  const ghost = await call(repo, 'submitCollegeEntry',
    { eventId: muc.eventId, college: '不存在的学院', memberIds: ['demo_muc_member'] });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /学院无效/);

  // 北航目录是「航空学院（模拟）」等，均不在全局 COLLEGES 里；仍能发布并按本校目录入名单。
  const buaaEvent = await publish(repo, 'r2', {}, buaa);
  const entry = await call(repo, 'submitCollegeEntry',
    { eventId: buaaEvent.eventId, collegeId: 'c01', memberIds: ['demo_buaa_member'] }, buaa);
  assert.equal(entry.ok, true, entry.message);
  assert.equal(entry.entry.college, '航空学院（模拟）');
});

/* ------------------------------------------------------------ 抽签 / 开赛 */

/** 交一份本学院名单并让管理员通过——抽签只收已通过的学院。 */
async function approveCollege(repo, eventId, collegeId, memberIds, opts = {}) {
  const submitted = await call(repo, 'submitCollegeEntry', { eventId, collegeId, memberIds }, opts);
  assert.equal(submitted.ok, true, submitted.message);
  const approved = await call(repo, 'reviewCollegeEntry', { eventId, collegeId, action: 'approve' }, opts);
  assert.equal(approved.ok, true, approved.message);
}

test('抽签：仅管理员、报名中、抽完转待开赛并锁名单', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);

  // 学院负责人 / 会员都不能抽签（与发布同一门槛）。
  const byMember = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 1 },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const drawn = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.event.status, COLLEGE_EVENT_STATUS.READY);
  // 两个已通过学院都进了签表。
  assert.deepEqual(drawn.draw.slots.filter(Boolean).sort(), [NAME_C01, NAME_C02].sort());

  // 抽签顺带锁名单：转待开赛后名单不可再改（提交权只看「是否报名中」）。
  const late = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  assert.equal(late.ok, false);

  // 待开赛再抽签被拒。
  const again = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 43 });
  assert.equal(again.ok, false);
  assert.match(again.message, /报名阶段/);
});

/**
 * 写路径扫尾（2026-10-16 独立验收 F1/F2 的同类）：学院赛的写动作原先一律在事务外
 * 判一次身份，事务里用的还是外层推出来的 actor。账号被停用、角色被撤之后，
 * 只要请求已经进来，抽签 / 开赛 / 录名次仍然会落库。这里逐个守住。
 */
test('写路径：请求期间账号被停用，抽签与开赛都不落库', async () => {
  const repo = fixture();
  const t = await publish(repo, 'inflight_draw');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);

  const disableAdminAtTxStart = (target) => {
    const transaction = target.transaction;
    target.transaction = async fn => {
      const user = await target.users.getById('demo_muc_admin');
      await target.users.set(user._id, { ...user, platformStatus: 'disabled' });
      return transaction(fn);
    };
    return () => { target.transaction = transaction; };
  };

  const restore = disableAdminAtTxStart(repo);
  const drawn = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  assert.equal(drawn.ok, false, '停用之后不能再抽签');
  assert.match(drawn.message, /停用|权限/);
  assert.equal((await repo.collegeEvents.getById(t.eventId)).status, COLLEGE_EVENT_STATUS.SIGNUP,
    '状态没有被改动');

  // 撤掉注入、把账号改回来：同一笔抽签就能正常落库（说明拒绝的是身份，不是流程本身）
  restore();
  const user = await repo.users.getById('demo_muc_admin');
  await repo.users.set(user._id, { ...user, platformStatus: 'active' });
  const okDraw = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  assert.equal(okDraw.ok, true, okDraw.message);
});

test('写路径：请求期间管理权被撤销，开赛与录名次都不落库', async () => {
  const repo = fixture();
  const t = await publish(repo, 'inflight_start');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);
  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });

  // 撤掉校级管理员角色（账号本身仍有效，所以只有「事务内重判角色」才拦得住）
  const transaction = repo.transaction;
  repo.transaction = async fn => {
    const { schoolRoleKey } = require('../src/shared/utils/school');
    const key = schoolRoleKey('demo_muc_admin', 'muc');
    const role = await repo.schoolRoles.getById(key);
    await repo.schoolRoles.set(key, { ...role, status: 'disabled' });
    return transaction(fn);
  };

  const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(started.ok, false, '撤权之后不能再开赛');
  assert.equal((await repo.collegeEvents.getById(t.eventId)).status, COLLEGE_EVENT_STATUS.READY,
    '状态没有被改动');
});

test('抽签：已通过学院不足 2 个被拒；种子必须是已通过学院', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);

  const tooFew = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 7 });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /不足 2 个/);

  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);
  const badSeed = await call(repo, 'drawCollegeEvent',
    { eventId: t.eventId, seedValue: 7, seedColleges: ['非本赛学院'] });
  assert.equal(badSeed.ok, false);
  assert.match(badSeed.message, /种子/);

  const okSeed = await call(repo, 'drawCollegeEvent',
    { eventId: t.eventId, seedValue: 7, seedColleges: [NAME_C01] });
  assert.equal(okSeed.ok, true, okSeed.message);
  assert.deepEqual(okSeed.draw.seeds, [NAME_C01]);
});

test('开赛：先抽签才能开；开赛铺首轮大场带范围，重开被拒', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);

  // 没抽签不能开。
  const tooEarly = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /还没有抽签/);

  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });

  const byMember = await call(repo, 'startCollegeEvent', { eventId: t.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.event.status, COLLEGE_EVENT_STATUS.ONGOING);
  // 两个学院只出一场大场，键由签位决定（赛事 + 轮次 + 阶段 + 签位）。
  assert.equal(started.ties.length, 1);
  assert.equal(started.ties[0].tieId, collegeTieKey(t.eventId, 1, 0));

  const stored = await repo.ties.getById(collegeTieKey(t.eventId, 1, 0));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(stored.status, TIE_STATUS.PENDING_LINEUP, '首轮大场等双方排阵');

  // 已经进行中，再点开始被拒（与旧栈同口径：非「待开赛」一律不能开始）。
  const again = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(again.ok, false);
  assert.match(again.message, /不能开始/);

  const listed = await call(repo, 'listCollegeTies', { eventId: t.eventId });
  assert.equal(listed.ties.length, 1);
  assert.ok(listed.ties[0].collegeA && listed.ties[0].collegeB);
});

test('跨校：外校读不到大场，也抽不了签', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);
  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  await call(repo, 'startCollegeEvent', { eventId: t.eventId });

  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };
  const ties = await call(repo, 'listCollegeTies', { eventId: t.eventId }, buaa);
  assert.equal(ties.ties.length, 0);

  const drawOther = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 1 }, buaa);
  assert.equal(drawOther.ok, false);
  assert.match(drawOther.message, /不存在/);

  const startOther = await call(repo, 'startCollegeEvent', { eventId: t.eventId }, buaa);
  assert.equal(startOther.ok, false);
  assert.match(startOther.message, /不存在/);
});

/* ------------------------------------------------------------ 排阵 / 开大场 / 名次 */

/** 走到「已开赛、首轮大场等排阵」这一步：发布 → 双方名单通过 → 抽签 → 开赛。 */
async function toTieReady(repo, extra = {}) {
  const t = await publish(repo, 'r1', { legPlan: [LEG_DISCIPLINE.MS], ...extra });
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member_2']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3', 'demo_muc_member_4']);
  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(started.ok, true, started.message);
  return { eventId: t.eventId, tieId: started.ties[0].tieId };
}

test('排阵：本大场参赛学院各自提交，大场转待开，主键带范围', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);

  // 普通会员不能替学院排阵。
  const byMember = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] },
    { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);

  // 管理员代交 c01 男单。
  const c01 = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  assert.equal(c01.ok, true, c01.message);
  assert.equal(c01.lineup.college, NAME_C01);
  // 只翻自己那一侧：c02 还没交，大场仍是等排阵。
  assert.equal((await repo.ties.getById(tieId)).lineupA, true);
  assert.equal((await repo.ties.getById(tieId)).lineupB, false);

  // c02 学院负责人交自己那份。
  const c02 = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });
  assert.equal(c02.ok, true, c02.message);

  const stored = await repo.ties.getById(tieId);
  assert.equal(stored.lineupA, true);
  assert.equal(stored.lineupB, true);
  // 与旧栈同口径：落库仍是待排阵，状态由 lineupA/lineupB 推导为待开。
  assert.equal(tieStatusOf(stored), TIE_STATUS.READY, '双方齐 → 待开大场');

  // 主键由范围 + 大场 + 学院编号派生。
  const key = collegeLineupKey(tieId, C01, { schoolId: 'muc', association: 'pkb' });
  const row = await repo.lineups.getById(key);
  assert.equal(row.schoolId, 'muc');
  assert.equal(row.association, 'pkb');
  assert.equal(row.collegeId, C01);

  // 重复提交覆盖同一条，每学院恒一条。
  const again = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_4'] }] },
    { actor: 'demo_muc_member_3' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.lineup.entries[0].players[0], 'demo_muc_member_4');
  assert.equal((await repo.lineups.list()).length, 2);

  const listed = await call(repo, 'listCollegeLineups', { tieId });
  assert.equal(listed.lineups.length, 2);
});

test('排阵：没排满 / 替无关学院排 / 名单外的人都被拒', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);

  // 男单必须排 1 人；空排被拒。
  const empty = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: [] }] });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /排满/);

  // 名单外的队员（这里是 c02 的人）不能替 c01 上场。
  const foreign = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /名单/);

  // 替不在本大场的学院排阵被拒（c03 存在但没参赛）。
  const outsider = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: 'c03', entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /本学院/);
});

test('开大场：双方排阵齐才能开，铺小场带范围；重开被拒', async () => {
  const repo = fixture();
  const { eventId, tieId } = await toTieReady(repo);

  // 排阵没交齐不能开。
  const early = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(early.ok, false);
  assert.match(early.message, /排阵/);

  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });

  // 会员不能替管理员开大场。
  const byMember = await call(repo, 'startCollegeTie', { tieId }, { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const started = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.tie.status, TIE_STATUS.ONGOING);

  // 小场写进 matches，带范围与参赛双方。
  const legKey = collegeLegKey(eventId, tieId, 1);
  const leg = await repo.matches.getById(legKey);
  assert.equal(leg.schoolId, 'muc');
  assert.equal(leg.association, 'pkb');
  assert.equal(leg.competition, MATCH_COMPETITION.COLLEGE);
  assert.deepEqual(leg.teamA, ['demo_muc_member_2']);
  assert.deepEqual(leg.teamB, ['demo_muc_member_3']);

  const again = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经开始/);
});

test('裁判 / 名次：仅管理员指派，名次只记参赛学院且冠军唯一', async () => {
  const repo = fixture();
  const { eventId, tieId } = await toTieReady(repo);
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });
  await call(repo, 'startCollegeTie', { tieId });

  // 会员不能指派裁判。
  const byMember = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'demo_muc_member' },
    { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  // 指派到不在册的人被拒。
  const ghost = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'nobody' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /找不到/);

  const assigned = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'demo_muc_member' });
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal(assigned.tie.referee, 'demo_muc_member');
  // 裁判同时下推到小场。
  assert.equal((await repo.matches.getById(collegeLegKey(eventId, tieId, 1))).referee, 'demo_muc_member');

  // 名次录给不在参赛学院里的名字被拒。
  const badPlacement = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: '不存在的学院', placement: 1 }] });
  assert.equal(badPlacement.ok, false);
  assert.match(badPlacement.message, /参赛学院/);

  // 没有唯一冠军被拒。
  const noChampion = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 2 }, { college: NAME_C02, placement: 2 }] });
  assert.equal(noChampion.ok, false);
  assert.match(noChampion.message, /冠军/);

  const finished = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 1 }, { college: NAME_C02, placement: 2 }] });
  assert.equal(finished.ok, true, finished.message);
  assert.equal(finished.event.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.equal(finished.results.length, 2);

  // 结束后再录名次被拒。
  const again = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 1 }] });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经结束/);
});

test('跨校：外校读不到排阵，也排不了阵 / 开不了大场', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);
  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };

  const lineups = await call(repo, 'listCollegeLineups', { tieId }, buaa);
  assert.equal(lineups.lineups.length, 0);

  const submit = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] }, buaa);
  assert.equal(submit.ok, false);
  assert.match(submit.message, /找不到/);

  const start = await call(repo, 'startCollegeTie', { tieId }, buaa);
  assert.equal(start.ok, false);
  assert.match(start.message, /找不到/);
});

/* ------------------------------------------------------------------ 小组限制（B6-b） */

const groupHandlers = require('../src/server/services/association-group-service');

async function callGroup(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await groupHandlers[action](payload, ctx)).data;
}

async function makeGroup(repo, token, memberIds) {
  const created = await callGroup(repo, 'createAssociationGroup',
    { requestId: token, name: `院队组${token}`, memberIds });
  assert.equal(created.ok, true, created.message);
  return created.group.groupId;
}

test('B6-b 发布学院赛带小组限制：非法拒绝，合法落库并在 DTO 下发', async () => {
  const repo = fixture();
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member']);

  const empty = await call(repo, 'publishCollegeEvent',
    { requestId: 'r1', ...valid({ audienceMode: 'groups', audienceGroupIds: [] }) });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /至少选择一个小组/);

  const mixed = await call(repo, 'publishCollegeEvent',
    { requestId: 'r2', ...valid({ audienceMode: 'all', audienceGroupIds: [groupId] }) });
  assert.equal(mixed.ok, false);
  assert.match(mixed.message, /不能指定小组/);

  const event = await publish(repo, 'r3', { audienceMode: 'groups', audienceGroupIds: [groupId] });
  assert.equal(event.audienceMode, 'groups');
  assert.deepEqual(event.audienceGroupIds, [groupId]);

  const plain = await publish(repo, 'r4');
  assert.equal(plain.audienceMode, 'all');
  assert.deepEqual(plain.audienceGroupIds, []);
});

test('B6-b G08：名单里仅一人不在限定小组 → 整份提交失败；负责人本人入组不能替代选手资格', async () => {
  const repo = fixture();
  // 组里有 demo_muc_member（c01）与 c02 负责人 demo_muc_member_3；
  // c01 的 demo_muc_member_2 与 c02 的 demo_muc_member_4 不在组里。
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member', 'demo_muc_member_3']);
  const event = await publish(repo, 'r1', { audienceMode: 'groups', audienceGroupIds: [groupId] });

  // c01 名单：仅 member_2 一人不符 → 整份失败（不是只把那一人剔除）
  const c01 = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member', 'demo_muc_member_2'] },
    { actor: 'demo_muc_admin' });
  assert.equal(c01.ok, false);
  assert.match(c01.message, /小组/);

  // c02 负责人自己交：本人入组不能替代选手资格，member_4 不符 → 整份失败
  const c02 = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(c02.ok, false);
  assert.match(c02.message, /小组/);

  // 全员在组（或名单只含组内成员）才能提交成功
  const ok = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_muc_admin' });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.entry.status, COLLEGE_ENTRY_STATUS.PENDING);

  // 跨范围：外校同一名单提交不进去
  const buaa = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' });
  assert.equal(buaa.ok, false);
});

/* ------------------------------------------------------------------ 路由编号（未解码的 query） */

/**
 * 上面各条用例走的是仓储夹具；这一段另起一套：装载器只认 `association-space`，
 * 只有演示栈（school-mock）才能把「query 在开发者工具 / 真机里原样透传」这条
 * 链路整个跑通——跳转方 encodeURIComponent，接收方拿到的仍是 %3A 形式
 * （见 utils/route-query.js）。装载器必须把探测出的真实编号回传，页面才有东西可写。
 */
const schoolMock = require('../src/mock/school-mock.js');
const associationSpace = require('../miniprogram/services/association-space');
const collegeView = require('../miniprogram/packageCollege/services/school-college-view.js');

const MOCK_SCOPE = { schoolId: 'muc', association: 'pkb' };
const MOCK_ADMIN = 'demo_muc_admin';

/** 演示栈里某学院的队员编号：排阵要按性别筛人，只取有性别的会员 */
async function mockMemberIds(api, collegeId) {
  const dto = await api.listSchoolMembers({});
  assert.equal(dto.ok, true, dto.message);
  return dto.members
    .filter(row => row.collegeId === collegeId && ['M', 'F'].includes(row.gender))
    .map(row => row.userId);
}

/**
 * 演示栈里造一场「报名中」的学院赛，并把两所学院的名单审过。
 * @returns {Promise<{api:Object, eventId:string, routeValue:string}>}
 */
async function mockEntriesReady() {
  schoolMock.reset({ withDemoContent: false });
  schoolMock.setDemoActor(MOCK_ADMIN);
  const api = associationSpace.forScope(MOCK_SCOPE);
  const published = await api.publishCollegeEvent({
    requestId: 'route-college-1', title: '路由编号学院赛', description: '',
    legPlan: [LEG_DISCIPLINE.MS], allowMultiEntry: true, rosterMin: 1, rosterMax: 20,
    tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF,
    startTime: at(DAY), location: '综合体育馆', courtCount: 1,
  });
  assert.equal(published.ok, true, published.message);
  const eventId = published.event.eventId;
  for (const collegeId of [C01, C02]) {
    const submitted = await api.submitCollegeEntry(
      { eventId, collegeId, memberIds: await mockMemberIds(api, collegeId) });
    assert.equal(submitted.ok, true, submitted.message);
    const reviewed = await api.reviewCollegeEntry({ eventId, collegeId, action: 'approve', reason: '' });
    assert.equal(reviewed.ok, true, reviewed.message);
  }
  return { api, eventId, routeValue: encodeURIComponent(eventId) };
}

test('路由编号：未解码 query 下，学院赛装载器一律回传真实编号', async () => {
  const { eventId, routeValue } = await mockEntriesReady();
  try {
    // 演示编号里含 %3A（requestId 段）：只有编码过一遍，未解码环境才会暴露问题。
    // 这条断言守住用例的前提，免得编号形状一变，下面几条就静默地不再守任何东西。
    assert.match(eventId, /%/, '编号应含 %3A，未解码环境才暴露「查不到」');
    assert.notEqual(routeValue, eventId);

    const admin = { ...MOCK_SCOPE, actorId: MOCK_ADMIN };

    const detail = await collegeView.loadCollegeEventDetailView(routeValue, admin);
    assert.equal(detail.found, true, detail.blockReason);
    assert.equal(detail.eventId, eventId, '详情装载器要把探测出的真实编号回传');

    const review = await collegeView.loadCollegeEntryReviewView(routeValue, admin);
    assert.equal(review.found, true, review.blockReason);
    assert.equal(review.eventId, eventId);
    assert.ok(review.rows.length > 0, '未解码 query 也要看得到名单行');

    const entry = await collegeView.loadCollegeEntryView(routeValue,
      { ...MOCK_SCOPE, actorId: MOCK_ADMIN, collegeId: C01 });
    assert.equal(entry.found, true, entry.blockReason);
    assert.equal(entry.eventId, eventId);
    assert.ok(entry.candidates.length > 0, '未解码 query 也要看得到本学院队员');
  } finally {
    schoolMock.reset();
  }
});

test('路由编号：未解码 query 下的抽签 / 开赛 / 名次，照回传的真实编号才落库', async () => {
  const { api, eventId, routeValue } = await mockEntriesReady();
  try {
    const admin = { ...MOCK_SCOPE, actorId: MOCK_ADMIN };
    const detail = await collegeView.loadCollegeEventDetailView(routeValue, admin);
    assert.equal(detail.eventId, eventId);

    // 对照：路由原值（页面修复前写操作拿的就是它）被服务端拒下
    const refused = await api.drawCollegeEvent({ eventId: routeValue, seedValue: 1 });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /找不到|不存在/);

    // 装载器回传的真实编号：抽签落库
    const drawn = await api.drawCollegeEvent({ eventId: detail.eventId, seedValue: 1 });
    assert.equal(drawn.ok, true, drawn.message);

    const ready = await collegeView.loadCollegeEventDetailView(routeValue, admin);
    assert.equal(ready.isReady, true, '抽签后转待开赛');
    const started = await api.startCollegeEvent({ eventId: ready.eventId });
    assert.equal(started.ok, true, started.message);

    // 名次装载器同样回传真实编号；候选学院也要真的取到（这一处曾拿路由原值查名单，
    // 未解码环境里一行都查不出来，看着像「没人交名单」）
    const placement = await collegeView.loadCollegePlacementView(routeValue, admin);
    assert.equal(placement.eventId, eventId);
    assert.deepEqual(
      placement.rows.map(row => row.college).sort(),
      [NAME_C01, NAME_C02].sort()
    );

    const finished = await api.finishCollegeEvent({
      eventId: placement.eventId,
      results: [{ college: NAME_C01, placement: 1 }, { college: NAME_C02, placement: 2 }],
    });
    assert.equal(finished.ok, true, finished.message);
    assert.equal(finished.event.status, COLLEGE_EVENT_STATUS.FINISHED);
  } finally {
    schoolMock.reset();
  }
});

test('路由编号：未解码 query 下的排阵与小场，照回传的真实编号写成功', async () => {
  const { api, eventId, routeValue } = await mockEntriesReady();
  try {
    const admin = { ...MOCK_SCOPE, actorId: MOCK_ADMIN };
    const detail = await collegeView.loadCollegeEventDetailView(routeValue, admin);
    const drawn = await api.drawCollegeEvent({ eventId: detail.eventId, seedValue: 7 });
    assert.equal(drawn.ok, true, drawn.message);
    const began = await api.startCollegeEvent({ eventId: detail.eventId });
    assert.equal(began.ok, true, began.message);

    const ties = (await api.listCollegeTies({ eventId })).ties;
    assert.ok(ties.length > 0, '开赛后铺出首轮大场');
    const tieId = ties[0].tieId;

    // 大场编号与赛事编号都是未解码的：装载器要认出大场，并把两个真实编号都回传
    const lineup = await collegeView.loadCollegeLineupView(encodeURIComponent(tieId),
      { ...MOCK_SCOPE, actorId: MOCK_ADMIN, eventId: routeValue, college: NAME_C02 });
    assert.equal(lineup.found, true, lineup.blockReason);
    assert.equal(lineup.tieId, tieId);
    assert.equal(lineup.eventId, eventId);
    assert.equal(lineup.canSubmit, true, lineup.blockReason);

    // 照回传的编号替两侧排阵（管理员可代交任一方）
    for (const collegeId of [C01, C02]) {
      const players = await mockMemberIds(api, collegeId);
      const saved = await api.submitCollegeLineup({
        tieId: lineup.tieId, collegeId, entries: [{ legNo: 1, players: [players[0]] }] });
      assert.equal(saved.ok, true, saved.message);
    }
    const startedTie = await api.startCollegeTie({ tieId: lineup.tieId });
    assert.equal(startedTie.ok, true, startedTie.message);

    const started = (await api.listCollegeTies({ eventId })).ties.find(row => row.tieId === tieId);
    const matchId = started.legRows[0].matchId;
    assert.ok(matchId, '大场开打后小场才生成');

    const match = await collegeView.loadCollegeMatchView(encodeURIComponent(matchId),
      { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
    assert.equal(match.found, true, match.blockReason);
    assert.equal(match.matchId, matchId);

    // 录分 → 确认：两步都是写，都要用回传的真实小场编号
    const recorded = await api.submitSchoolMatch({ matchId: match.matchId, scoreA: [11], scoreB: [3] });
    assert.equal(recorded.ok, true, recorded.message);
    const confirmed = await api.confirmSchoolMatch({ matchId: match.matchId });
    assert.equal(confirmed.ok, true, confirmed.message);
    const saved = (await api.listSchoolMatches({})).matches.find(row => row.matchId === matchId);
    assert.equal(saved.status, MATCH_STATUS.ACTIVE);
  } finally {
    schoolMock.reset();
  }
});

/* ---------------------------------------------- 小场视图（旧栈回归的 S2 对应） */

/**
 * 下面两条由旧栈 tests/college-view.test.js 迁移而来。
 *
 * 【为什么是迁移而不是删除】它们守的是两条曾经让页面直接崩掉的回归：
 *   1. 找不到比赛时不下发比分行所需字段，页面按 bestOf 读 scoreA[i] 抛错；
 *   2. 权限布尔量撞暂时性死区，闸门为真时抛 ReferenceError。
 * S2 的 loadCollegeMatchView 里这两处都已按同一口径实现（见其「找不到比赛」
 * 分支与 canConfirm / canRevoke 的 Boolean(...)），但**此前没有任何测试覆盖**——
 * 旧栈那两条随 college-view.js 一并删除后，若不迁移，这两条回归就无人看守了。
 */
describe('小场视图 —— 旧栈两条回归在 S2 的对应', () => {
  test('找不到比赛时如实返回 found:false，并补齐比分行所需的全部字段', async () => {
    schoolMock.reset({ withDemoContent: false });
    try {
      const view = await collegeView.loadCollegeMatchView('不存在的小场',
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });

      assert.equal(view.found, false);
      assert.equal(view.blockReason, '找不到这场比赛');
      // 页面 refresh 会按 bestOf 逐行读 scoreA / scoreB；缺一个就是读下标抛错
      assert.deepEqual(view.scoreA, []);
      assert.deepEqual(view.scoreB, []);
      assert.deepEqual(view.teamARows, []);
      assert.deepEqual(view.teamBRows, []);
      assert.equal(typeof view.gamePoints, 'number');
      assert.equal(typeof view.bestOf, 'number');
    } finally {
      schoolMock.reset();
    }
  });

  test('已录分未确认的小场：canConfirm / canRevoke 是布尔量而不是抛错', async () => {
    const { api, eventId } = await mockEntriesReady();
    try {
      const drawn = await api.drawCollegeEvent({ eventId, seedValue: 7 });
      assert.equal(drawn.ok, true, drawn.message);
      const began = await api.startCollegeEvent({ eventId });
      assert.equal(began.ok, true, began.message);

      const ties = (await api.listCollegeTies({ eventId })).ties;
      assert.ok(ties.length > 0, '开赛后铺出首轮大场');
      const tieId = ties[0].tieId;

      // 两侧各排一人，开大场铺出小场
      const playersByCollege = {};
      for (const collegeId of [C01, C02]) {
        const players = await mockMemberIds(api, collegeId);
        assert.ok(players.length > 0, `${collegeId} 应有可排阵的会员`);
        playersByCollege[collegeId] = players;
        const saved = await api.submitCollegeLineup({
          tieId, collegeId, entries: [{ legNo: 1, players: [players[0]] }] });
        assert.equal(saved.ok, true, saved.message);
      }
      const startedTie = await api.startCollegeTie({ tieId });
      assert.equal(startedTie.ok, true, startedTie.message);

      const started = (await api.listCollegeTies({ eventId })).ties.find(row => row.tieId === tieId);
      const matchId = started.legRows[0].matchId;
      assert.ok(matchId, '大场开打后小场才生成');

      // 录分但**不确认**：这正是旧栈 TDZ 的触发条件（待确认 + 有胜方 + 我在场上）。
      // 种子里恰好一场都没有，必须自己造，线上才会漏网。
      const recorded = await api.submitSchoolMatch({ matchId, scoreA: [11], scoreB: [7] });
      assert.equal(recorded.ok, true, recorded.message);

      const onCourt = playersByCollege[C01][0];
      const view = await collegeView.loadCollegeMatchView(matchId,
        { ...MOCK_SCOPE, actorId: onCourt });

      assert.equal(view.found, true, view.blockReason);
      assert.equal(typeof view.canConfirm, 'boolean');
      // 撤销旗标已随逐场结算改造移除（曾经的回归点：canRevoke 必须是布尔量而非抛错）
      assert.equal('canRevoke' in view, false, '小场视图不再提供撤销旗标');
      // 场上参与者即可确认——正是这条路以前会抛 ReferenceError
      assert.equal(view.canConfirm, true, '场上参与者应当能确认自己这一场');
    } finally {
      schoolMock.reset();
    }
  });
});

/* --------------------------------------- 名次与隔离（旧栈 college-placement 的 S2 对应） */

/**
 * 下面一组由旧栈 tests/college-placement.test.js 迁移而来。
 *
 * 【为什么是迁移而不是删除】旧栈那 11 条守的是「名次只按学院落库、不产生任何
 * 个人等级分与积分、也不进个人赛事集合」这条隔离边界，以及名次页 / 详情页两个
 * 视图的拦截文案。S2 的 finishCollegeEvent 与 loadCollegePlacementView /
 * loadCollegeEventDetailView 里这些规则都已按同一口径实现，但此前只被
 * 「裁判 / 名次」那一条顺带碰到两点（名次记给非参赛学院被拒、缺冠军被拒），
 * 其余各点（缺项只有冠军、未开始拒绝、非管理员拒绝、重名次拒绝、等级分与积分
 * 零变化、不进个人赛事集合、两个视图的文案）在 S2 **零覆盖**。随
 * college-view.js 一并删除旧栈文件后若不迁移，这些边界就无人看守了。
 */
describe('名次与隔离 —— 旧栈 college-placement 的 S2 对应', () => {
  /** 走到「进行中」：两院过审 → 抽签 → 开赛 */
  async function toOngoing(repo) {
    const t = await publish(repo, 'placement-1', { legPlan: [LEG_DISCIPLINE.MS] });
    await approveCollege(repo, t.eventId, C01, ['demo_muc_member_2']);
    await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3', 'demo_muc_member_4']);
    await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
    const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
    assert.equal(started.ok, true, started.message);
    return t.eventId;
  }

  const resultsOf = () => [
    { college: NAME_C01, placement: 1 },
    { college: NAME_C02, placement: 2 },
  ];

  test('名次允许缺项，但必须有一位冠军', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);

    // 只记冠军，其余学院可能没到场
    const only = await call(repo, 'finishCollegeEvent',
      { eventId, results: [{ college: NAME_C01, placement: 1 }] });
    assert.equal(only.ok, true, only.message);
    assert.equal((await repo.collegeEvents.getById(eventId)).results.length, 1);
  });

  test('未开始的学院赛不能录名次', async () => {
    const repo = fixture();
    const t = await publish(repo, 'placement-not-started', { legPlan: [LEG_DISCIPLINE.MS] });
    await approveCollege(repo, t.eventId, C01, ['demo_muc_member_2']);

    const result = await call(repo, 'finishCollegeEvent',
      { eventId: t.eventId, results: [{ college: NAME_C01, placement: 1 }] });
    assert.equal(result.ok, false);
    assert.match(result.message, /还没开始/);
    assert.equal((await repo.collegeEvents.getById(t.eventId)).status, COLLEGE_EVENT_STATUS.SIGNUP);
  });

  test('学院负责人与会员都无权录入名次', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);

    for (const actor of ['demo_muc_member_3', 'demo_muc_member']) {
      const result = await call(repo, 'finishCollegeEvent', { eventId, results: resultsOf() }, { actor });
      assert.equal(result.ok, false);
      assert.match(result.message, /只有管理员/);
    }
    // 一次都没落库
    assert.equal((await repo.collegeEvents.getById(eventId)).status, COLLEGE_EVENT_STATUS.ONGOING);
  });

  /**
   * 这一条是迁移时**新补**的，不是旧栈搬过来的。
   *
   * 【为什么必须补】`finishCollegeEvent` 在事务内复查管理权（撤权后不能再录
   * 名次），既有用例「写路径：请求期间管理权被撤销，开赛与录名次都不落库」的
   * 标题里提到了录名次，但正文只调到 `startCollegeEvent`——赛事停在待开赛，
   * 根本走不到名次那条分支。反向验证时把事务内复查整行短路，全量仍 39/0 通过，
   * 证实了这一处此前无人看守。
   */
  test('写路径：请求期间管理权被撤销，事务内复查拦下录名次', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);

    // 撤掉校级管理员角色（账号本身仍有效，所以只有「事务内重判角色」才拦得住）
    const transaction = repo.transaction;
    repo.transaction = async fn => {
      const { schoolRoleKey } = require('../src/shared/utils/school');
      const key = schoolRoleKey('demo_muc_admin', 'muc');
      const role = await repo.schoolRoles.getById(key);
      await repo.schoolRoles.set(key, { ...role, status: 'disabled' });
      return transaction(fn);
    };

    const result = await call(repo, 'finishCollegeEvent', { eventId, results: resultsOf() });
    assert.equal(result.ok, false, '撤权之后不能再录名次');
    assert.equal((await repo.collegeEvents.getById(eventId)).status, COLLEGE_EVENT_STATUS.ONGOING,
      '状态没有被改动');
  });

  test('同一学院记两次名次被拒（每院只记一次）', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);

    const twice = await call(repo, 'finishCollegeEvent', {
      eventId,
      results: [
        { college: NAME_C01, placement: 1 },
        { college: NAME_C01, placement: 2 },
      ],
    });
    assert.equal(twice.ok, false);
    assert.match(twice.message, /每院只记一次/);
  });

  test('隔离 —— 录入名次不改变任何人的等级分与积分', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);

    // 【为什么盯「全部集合」而不是盯某个分数字段】S2 里等级分与积分都不是存在
    // 会员文档上的字段，而是由 matches / 赛事 / 训练事实「回放」出来的
    // （见 school-rank-service 的 replayScope）。所以「不动任何人的分数」等价于
    // 「除了本赛事记录与审计，一个字都没往别处写」。末尾再确认本赛事确实变了，
    // 免得「哪儿都没动」被误当成隔离通过——那只是这次写根本没生效。
    const COLLECTIONS = ['users', 'schools', 'schoolAssociations', 'colleges', 'schoolMembers',
      'schoolRoles', 'memberships', 'studentIdClaims', 'auditLogs',
      'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
      'associationGroups', 'associationGroupMembers',
      'associationNotices', 'associationTrainings', 'trainingRegistrations',
      'announcements', 'events', 'eventSignups', 'matches', 'liveScores',
      'collegeEvents', 'collegeEntries', 'ties', 'lineups', 'seasons', 'pairCounts'];
    const snapshot = async () => Object.fromEntries(await Promise.all(
      COLLECTIONS.map(async key => [key, await repo[key].list()])));

    const before = await snapshot();
    const finished = await call(repo, 'finishCollegeEvent', { eventId, results: resultsOf() });
    assert.equal(finished.ok, true, finished.message);
    const after = await snapshot();

    assert.notDeepEqual(after.collegeEvents, before.collegeEvents, '名次应当已落到本赛事记录上');
    const touched = COLLECTIONS.filter(
      key => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
    assert.deepEqual(
      touched.filter(key => key !== 'auditLogs'),
      ['collegeEvents'],
      '学院名次不该动任何个人的等级分与积分'
    );
  });

  test('隔离 —— 学院赛不进个人赛事集合', async () => {
    const repo = fixture();
    const eventId = await toOngoing(repo);
    await call(repo, 'finishCollegeEvent', { eventId, results: resultsOf() });

    const personal = await repo.forScope({ schoolId: 'muc', association: 'pkb' }).events.list();
    assert.equal(
      personal.some(row => (row.eventId || row._id) === eventId),
      false,
      '学院赛写在 college_events 集合，个人赛事读路径里不应出现'
    );
  });

  /** 演示栈里走到「进行中」：两院过审 → 抽签 → 开赛（视图层只认 association-space） */
  async function mockOngoing() {
    const { api, eventId } = await mockEntriesReady();
    const drawn = await api.drawCollegeEvent({ eventId, seedValue: 42 });
    assert.equal(drawn.ok, true, drawn.message);
    const started = await api.startCollegeEvent({ eventId });
    assert.equal(started.ok, true, started.message);
    return { api, eventId };
  }

  test('名次页视图 —— 管理员在赛事进行中可提交，候选只有参赛学院', async () => {
    const { eventId } = await mockOngoing();
    try {
      const view = await collegeView.loadCollegePlacementView(eventId,
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
      assert.equal(view.found, true);
      assert.equal(view.canSubmit, true);
      assert.equal(view.blockReason, '');
      assert.deepEqual(
        view.rows.map(row => row.college).sort(),
        [NAME_C01, NAME_C02].sort(),
        '一行一所已通过名单的学院'
      );
      assert.ok(view.rows.every(row => row.placementText === ''), '还没录过名次，输入框留空');
    } finally {
      schoolMock.reset();
    }
  });

  test('名次页视图 —— 未开始 / 已结束 / 无权限各有各的拦截文案', async () => {
    const { api, eventId } = await mockEntriesReady();
    try {
      const signupView = await collegeView.loadCollegePlacementView(eventId,
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
      assert.equal(signupView.canSubmit, false);
      assert.match(signupView.blockReason, /还没开始/);

      const drawn = await api.drawCollegeEvent({ eventId, seedValue: 42 });
      assert.equal(drawn.ok, true, drawn.message);
      const started = await api.startCollegeEvent({ eventId });
      assert.equal(started.ok, true, started.message);

      // 【为什么这里要换演示身份而不是只换 options.actorId】S2 的装载器只拿
      // options.actorId 判「有没有登录」，真正的 canManage 由服务端按**当前会话
      // 身份**算（school-mock 的 actor）。这与旧栈 `{ user }` 直接决定视图权限
      // 不同——旧栈删掉后，想守「非管理员被拦」就必须切会话身份。已记入
      // docs 的隐患清单，本批不擅自改行为。
      schoolMock.setDemoActor('demo_muc_member_2');
      const staffView = await collegeView.loadCollegePlacementView(eventId,
        { ...MOCK_SCOPE, actorId: 'demo_muc_member_2' });
      assert.equal(staffView.canSubmit, false);
      assert.match(staffView.blockReason, /只有管理员/);
      schoolMock.setDemoActor(MOCK_ADMIN);

      const guestView = await collegeView.loadCollegePlacementView(eventId, { ...MOCK_SCOPE });
      assert.equal(guestView.canSubmit, false);
      assert.match(guestView.blockReason, /请先登录/);

      const finished = await api.finishCollegeEvent({ eventId, results: resultsOf() });
      assert.equal(finished.ok, true, finished.message);
      const doneView = await collegeView.loadCollegePlacementView(eventId,
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
      assert.equal(doneView.canSubmit, false);
      assert.match(doneView.blockReason, /已经结束/);
    } finally {
      schoolMock.reset();
    }
  });

  test('详情页视图 —— 进行中给录入入口，结束后展示名次文案', async () => {
    const { api, eventId } = await mockOngoing();
    try {
      const ongoing = await collegeView.loadCollegeEventDetailView(eventId,
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
      assert.equal(ongoing.canFinish, true, '进行中的赛事给管理员录入入口');
      assert.equal(ongoing.hasResults, false);

      const done = await api.finishCollegeEvent({ eventId, results: resultsOf() });
      assert.equal(done.ok, true, done.message);

      const finished = await collegeView.loadCollegeEventDetailView(eventId,
        { ...MOCK_SCOPE, actorId: MOCK_ADMIN });
      assert.equal(finished.isFinished, true);
      assert.equal(finished.canFinish, false, '已结束不再给录入入口');
      assert.equal(finished.hasResults, true);
      assert.deepEqual(
        finished.resultRows.map(row => [row.college, row.placementText]),
        [[NAME_C01, '冠军'], [NAME_C02, '亚军']]
      );
    } finally {
      schoolMock.reset();
    }
  });
});
