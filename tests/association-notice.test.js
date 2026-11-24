const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
// 用云函数形状的内存仓储（含 announcements 等旧集合），才能验证空间通知
// 不落全局公告集合；其余断言只依赖学校仓储接口，两种实现等价。
const { createMemoryRepo } = require('./helpers/memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/association-notice-service');
const { schoolMembershipKey } = require('../src/shared/utils/school');

const NOW = new Date('2026-10-13T10:00:00Z');

/** 演示种子 + 可选负责人身份 + 学院负责人身份，用于权限矩阵。 */
function fixture({ leader = false, collegeLeader = false } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  if (leader) {
    seed.memberships.push({ _id: schoolMembershipKey('demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'leader', status: 'active' });
  }
  if (collegeLeader) {
    seed.memberships.push({ _id: schoolMembershipKey('demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'staff', collegeId: 'c01', status: 'active' });
  }
  return createMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({ title: '周末训练安排', content: '本周六下午三点，老地方。', category: '通知', ...extra });

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishAssociationNotice', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.notice;
}

const noticeRows = async (repo) => (await repo.associationNotices.list()).filter(doc => !doc.nameClaim);

test('发布权限：普通会员与学院负责人被拒，管理员 / 协会负责人 / 平台管理员可发', async () => {
  const repo = fixture({ collegeLeader: true });
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r1', ...valid() }, { actor: 'demo_muc_member' })).ok,
    false, '普通会员不能发通知');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r2', ...valid() }, { actor: 'demo_muc_member' })).ok,
    false, '学院负责人不能发通知');
  assert.equal((await repo.announcements.list()).length, 0, '被拒时无写入');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r3', ...valid() })).ok, true, '校管理员可发');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r4', ...valid() }, { actor: 'demo_platform_admin', schoolId: 'buaa' })).ok,
    true, '平台管理员可跨校发');

  const led = fixture({ leader: true });
  assert.equal((await call(led, 'publishAssociationNotice', { requestId: 'r1', ...valid() }, { actor: 'demo_muc_member' })).ok,
    true, '协会负责人可发');
});

test('N01 空间通知只在本协会可见，不进入全局公告集合', async () => {
  const repo = fixture();
  await publish(repo, 'r1');

  const mine = await call(repo, 'listAssociationNotices', {}, { actor: 'demo_muc_member' });
  assert.equal(mine.ok, true);
  assert.equal(mine.notices.length, 1, '本协会会员能看到');
  assert.equal(mine.canManage, false, '会员不显示管理入口');

  const crossSchool = await call(repo, 'listAssociationNotices', {}, { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.deepEqual(crossSchool.notices, [], '别校看不到');
  const otherSport = await call(repo, 'listAssociationNotices', {}, { association: 'tt' });
  assert.deepEqual(otherSport.notices, [], '同校别协会看不到');

  assert.equal((await repo.announcements.list()).length, 0, '空间通知不落全局 announcements 集合（首页 / 旧公告中心读不到）');
});

test('N02 排序置顶优先，撤回后会员直达不可读、管理端仍可见', async () => {
  const repo = fixture();
  const a = await publish(repo, 'a', { title: '普通通知' }, { now: new Date(NOW.getTime()) });
  const b = await publish(repo, 'b', { title: '后续通知' }, { now: new Date(NOW.getTime() + 60000) });
  const c = await publish(repo, 'c', { title: '置顶通知', pinned: true }, { now: new Date(NOW.getTime() + 120000) });

  const listed = await call(repo, 'listAssociationNotices', {}, { actor: 'demo_muc_member' });
  assert.deepEqual(listed.notices.map(row => row.noticeId), [c.noticeId, b.noticeId, a.noticeId],
    '置顶在前，其余按发布时间倒序');

  const withdrawn = await call(repo, 'withdrawAssociationNotice',
    { noticeId: a.noticeId, expectedRevision: a.revision });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.notice.status, 'withdrawn');
  assert.equal(withdrawn.notice.revision, a.revision + 1, '撤回升版本');
  assert.equal(withdrawn.notice.canWithdraw, false, '已撤回不再显示撤回入口');

  const memberGet = await call(repo, 'getAssociationNotice', { noticeId: a.noticeId }, { actor: 'demo_muc_member' });
  assert.equal(memberGet.ok, false, '撤回后会员直达不可读');
  const managerGet = await call(repo, 'getAssociationNotice', { noticeId: a.noticeId });
  assert.equal(managerGet.ok, true, '管理端保留可读');
  assert.equal(managerGet.notice.statusLabel, '已撤回');

  const memberList = await call(repo, 'listAssociationNotices', {}, { actor: 'demo_muc_member' });
  assert.deepEqual(memberList.notices.map(row => row.noticeId), [c.noticeId, b.noticeId], '会员列表不含已撤回');
  const managerList = await call(repo, 'listAssociationNotices', {});
  assert.equal(managerList.notices.length, 3, '管理列表保留已撤回以便追溯');
});

test('N03 分页超过单页条数不重不漏，同刻按 ID 稳定排序', async () => {
  const repo = fixture();
  const ids = [];
  for (let i = 0; i < 25; i += 1) {
    const notice = await publish(repo, `n${String(i).padStart(2, '0')}`,
      { title: `通知 ${i}` }, { now: new Date(NOW.getTime() + i * 60000) });
    ids.push(notice.noticeId);
  }
  const page1 = await call(repo, 'listAssociationNotices', {}, { actor: 'demo_muc_member' });
  assert.equal(page1.notices.length, 20, '默认单页 20 条');
  assert.equal(page1.hasMore, true);
  const page2 = await call(repo, 'listAssociationNotices', { cursor: page1.nextCursor }, { actor: 'demo_muc_member' });
  assert.equal(page2.notices.length, 5, '第二页取余下 5 条');
  assert.equal(page2.hasMore, false);
  const seen = [...page1.notices, ...page2.notices].map(row => row.noticeId);
  assert.equal(new Set(seen).size, 25, '不重不漏');
  assert.deepEqual(seen, [...ids].reverse(), '整体按发布时间倒序');

  // 同一发布时刻，按 ID 升序稳定排序（token a/b/c → id 递增）
  const sameTime = fixture();
  const at = new Date(NOW.getTime());
  for (const token of ['c', 'a', 'b']) {
    await publish(sameTime, token, { title: `同刻 ${token}` }, { now: at });
  }
  const rows = await call(sameTime, 'listAssociationNotices', {}, { actor: 'demo_muc_member' });
  assert.deepEqual(rows.notices.map(row => row.title), ['同刻 a', '同刻 b', '同刻 c'], '同刻按 ID 升序');
});

test('发布幂等：同请求编号同内容返回同一条，换内容被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1', { title: '第一条' });
  const retry = await call(repo, 'publishAssociationNotice', { requestId: 'r1', ...valid({ title: '第一条' }) });
  assert.equal(retry.ok, true);
  assert.equal(retry.notice.noticeId, first.noticeId);
  assert.equal((await noticeRows(repo)).length, 1, '同一编号只落一条');
  const changed = await call(repo, 'publishAssociationNotice', { requestId: 'r1', ...valid({ title: '换标题' }) });
  assert.equal(changed.ok, false, '同编号换内容被拒');
});

test('编辑与撤回：版本冲突要求刷新，撤回幂等，非法文本被拒', async () => {
  const repo = fixture();
  const notice = await publish(repo, 'r1');
  const good = await call(repo, 'updateAssociationNotice',
    { noticeId: notice.noticeId, ...valid({ title: '改后的标题' }), expectedRevision: notice.revision });
  assert.equal(good.ok, true);
  assert.equal(good.notice.title, '改后的标题');
  assert.equal(good.notice.revision, notice.revision + 1);

  const stale = await call(repo, 'updateAssociationNotice',
    { noticeId: notice.noticeId, ...valid({ title: '再改' }), expectedRevision: notice.revision });
  assert.equal(stale.ok, false, '旧版本被拒');

  const withdrawn = await call(repo, 'withdrawAssociationNotice',
    { noticeId: notice.noticeId, expectedRevision: good.notice.revision });
  assert.equal(withdrawn.ok, true);
  const again = await call(repo, 'withdrawAssociationNotice',
    { noticeId: notice.noticeId, expectedRevision: 99 });
  assert.equal(again.ok, true, '重复撤回幂等');
  const editWithdrawn = await call(repo, 'updateAssociationNotice',
    { noticeId: notice.noticeId, ...valid(), expectedRevision: 99 });
  assert.equal(editWithdrawn.ok, false, '已撤回不能再编辑');
});

test('文本校验复用公告规则：标题长度 / 正文 / 分类逐条拒绝且不落库', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r1', ...valid({ title: 'x' }) })).ok, false, '标题太短');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r2', ...valid({ title: '题'.repeat(31) }) })).ok, false, '标题太长');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r3', ...valid({ content: '' }) })).ok, false, '正文必填');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'r4', ...valid({ category: '公告' }) })).ok, false, '分类须在白名单');
  assert.equal((await call(repo, 'publishAssociationNotice', { requestId: 'bad id', ...valid() })).ok, false, '编号非法');
  assert.equal((await noticeRows(repo)).length, 0, '全部拒绝时无写入');
});

test('跨校跨协会隔离：别校读不到、也改不了本协会通知', async () => {
  const repo = fixture();
  const notice = await publish(repo, 'r1');
  assert.equal((await call(repo, 'getAssociationNotice', { noticeId: notice.noticeId },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' })).ok, false, '外校读不到');
  assert.equal((await call(repo, 'updateAssociationNotice',
    { noticeId: notice.noticeId, ...valid(), expectedRevision: notice.revision },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' })).ok, false, '外校改不了');
  assert.equal((await call(repo, 'withdrawAssociationNotice',
    { noticeId: notice.noticeId, expectedRevision: notice.revision },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' })).ok, false, '外校撤不了');
  assert.equal((await repo.associationNotices.getById(notice.noticeId)).status, 'published', '外校操作后仍为已发布');
});
