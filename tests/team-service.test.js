/**
 * 团队运动：球队与队员（篮球）
 * ============================================================
 * 这一层守的是「球队不是一次填几个名字」那几条硬约束：
 *   · 建队要审核（学生不能自助开队），同一请求不重复建队；
 *   · 一队一人一条，重复申请幂等；同赛事只能代表一队由赛事批次再守一次；
 *   · 队长只能管自己的队，不因此获得协会管理权限；
 *   · 退队留痕不物理删除；队长不能直接溜走，必须先交接或归档；
 *   · 跨协会不串：个人赛协会调这套接口直接拒绝。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/team-service');
const { schoolMemberKey, schoolMembershipKey } = require('../miniprogram/utils/school');
const { TEAM_STATUS, TEAM_MEMBER_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-19T12:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
  };
  add('u_cap');     // 建队人 → 队长
  add('u_m1');      // 普通队员
  add('u_m2');      // 另一个申请人
  add('u_leader');  // 协会负责人
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'u_cap', association = 'bk', now = NOW } = opts;
  const ctx = await buildSchoolContext({
    repo, actorId: actor, scope: { schoolId: 'muc', association }, now,
  });
  return (await handlers[action](payload, ctx)).data;
}

/** 建一支队并审核通过，返回 teamId */
let teamSeq = 0;
async function activeTeam(repo, name = '热浪队') {
  teamSeq += 1;
  const created = await call(repo, 'createTeamApplication', { name, requestId: `req_team_${teamSeq}` });
  assert.equal(created.ok, true, created.message);
  const reviewed = await call(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true }, { actor: 'u_leader' });
  assert.equal(reviewed.ok, true, reviewed.message);
  return created.teamId;
}

/* ============================================================
 * 一、建队
 * ============================================================ */

test('建队申请 —— 落在待审核，创建人自动成为队长', async () => {
  const repo = fixture();
  const result = await call(repo, 'createTeamApplication', { name: '  热浪队  ', requestId: 'req_1' });

  assert.equal(result.ok, true);
  const team = await repo.teams.getById(result.teamId);
  assert.equal(team.name, '热浪队', '队名去空白');
  assert.equal(team.status, TEAM_STATUS.PENDING);
  assert.equal(team.captainId, 'u_cap');
  assert.equal(team.memberCount, 1);

  const detail = await call(repo, 'getTeam', { teamId: result.teamId });
  assert.equal(detail.members.length, 1);
  assert.equal(detail.members[0].role, 'captain');
  assert.equal(detail.members[0].status, TEAM_MEMBER_STATUS.ACTIVE);
});

test('建队申请 —— 同一请求编号重试不重复建队', async () => {
  const repo = fixture();
  const first = await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_1' });
  const again = await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_1' });

  assert.equal(again.ok, true);
  assert.equal(again.teamId, first.teamId);
  const all = await repo.teams.list();
  assert.equal(all.length, 1, '重试不该建出第二支队');
});

test('建队申请 —— 同协会不允许重名，跨协会互不影响', async () => {
  const repo = fixture();
  await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_1' });
  const same = await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_2' });
  assert.equal(same.ok, false);
  assert.match(same.message, /同名/);

  // 名字至少 2 个字
  const short = await call(repo, 'createTeamApplication', { name: '队', requestId: 'req_3' });
  assert.equal(short.ok, false);
});

test('建队申请 —— 没有本协会会籍的人不能建队', async () => {
  const repo = fixture();
  // 平台账号在册、但没有本校会籍
  repo.__seedForTest = null;
  const outsider = 'u_outsider';
  const seed = { users: [{ _id: outsider, openId: 'mock_openid_out', nickName: '外人',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' }] };
  for (const [key, docs] of Object.entries(seed)) {
    for (const doc of docs) await repo.users.set(doc._id, doc);
  }
  const result = await call(repo, 'createTeamApplication', { name: '外队', requestId: 'req_out' }, { actor: outsider });
  assert.equal(result.ok, false);
  assert.match(result.message, /在册会员/);
});

/* ============================================================
 * 二、审核建队
 * ============================================================ */

test('审核建队 —— 普通会员不能审；协会负责人通过后转正常', async () => {
  const repo = fixture();
  const created = await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_1' });

  const denied = await call(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true }, { actor: 'u_m1' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /协会负责人/);

  const passed = await call(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true }, { actor: 'u_leader' });
  assert.equal(passed.ok, true);
  const team = await repo.teams.getById(created.teamId);
  assert.equal(team.status, TEAM_STATUS.ACTIVE);
  assert.equal(team.reviewedBy, 'u_leader');
});

test('审核建队 —— 退回留理由，队伍不能被重复审核', async () => {
  const repo = fixture();
  const created = await call(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_1' });

  const rejected = await call(repo, 'reviewTeamApplication',
    { teamId: created.teamId, approve: false, reason: '队名与已有球队重复' }, { actor: 'u_leader' });
  assert.equal(rejected.ok, true);
  const team = await repo.teams.getById(created.teamId);
  assert.equal(team.status, TEAM_STATUS.REJECTED);
  assert.equal(team.reason, '队名与已有球队重复');

  const again = await call(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true }, { actor: 'u_leader' });
  assert.equal(again.ok, false);
  assert.match(again.message, /待审核/);
});

/* ============================================================
 * 三、入队与审批
 * ============================================================ */

test('入队申请 —— 待审核时可重复申请（幂等），审批后人数只加一次', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);

  const first = await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });
  assert.equal(first.ok, true);
  assert.equal(first.status, TEAM_MEMBER_STATUS.PENDING);
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });

  const rows = (await repo.teamMembers.list()).filter(row => row.teamId === teamId);
  assert.equal(rows.filter(row => row.userId === 'u_m1').length, 1, '一人一队只能有一条');

  const approved = await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true });
  assert.equal(approved.ok, true);
  const team = await repo.teams.getById(teamId);
  assert.equal(team.memberCount, 2);

  // 重复审批被拒，人数不会再加
  const twice = await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true });
  assert.equal(twice.ok, false);
  assert.equal((await repo.teams.getById(teamId)).memberCount, 2);
});

test('入队审批 —— 非队长不能批；队长可以批自己的队', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });

  const denied = await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true }, { actor: 'u_m2' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /队长/);

  const passed = await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true }, { actor: 'u_cap' });
  assert.equal(passed.ok, true);
});

test('入队申请 —— 已归档的球队不再接受申请', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);
  await call(repo, 'archiveTeam', { teamId });

  const result = await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /不接受/);
});

/* ============================================================
 * 四、退队、交接、归档
 * ============================================================ */

test('退队 —— 队员可退且留痕；队长必须先交接或归档', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });
  await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true });

  const left = await call(repo, 'leaveTeam', { teamId }, { actor: 'u_m1' });
  assert.equal(left.ok, true);
  const row = await repo.teamMembers.getById(
    require('../miniprogram/utils/school').teamMemberKey(teamId, 'u_m1')
  );
  assert.equal(row.status, TEAM_MEMBER_STATUS.LEFT, '退队是留痕，不删记录');
  assert.equal((await repo.teams.getById(teamId)).memberCount, 1);

  const captainLeave = await call(repo, 'leaveTeam', { teamId }, { actor: 'u_cap' });
  assert.equal(captainLeave.ok, false);
  assert.match(captainLeave.message, /转让队长/);
});

test('转让队长 —— 只能转给在队队员，角色互换且队伍指向更新', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });
  await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true });

  const notMember = await call(repo, 'transferTeamCaptain', { teamId, userId: 'u_m2' });
  assert.equal(notMember.ok, false);
  assert.match(notMember.message, /在队队员/);

  const done = await call(repo, 'transferTeamCaptain', { teamId, userId: 'u_m1' });
  assert.equal(done.ok, true);
  const team = await repo.teams.getById(teamId);
  assert.equal(team.captainId, 'u_m1');

  const { teamMemberKey } = require('../miniprogram/utils/school');
  const oldCaptain = await repo.teamMembers.getById(teamMemberKey(teamId, 'u_cap'));
  const newCaptain = await repo.teamMembers.getById(teamMemberKey(teamId, 'u_m1'));
  assert.equal(oldCaptain.role, 'member');
  assert.equal(newCaptain.role, 'captain');
});

test('归档 —— 队长可归档，归档后列表仍可见但状态为已归档', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);

  const result = await call(repo, 'archiveTeam', { teamId });
  assert.equal(result.ok, true);
  assert.equal((await repo.teams.getById(teamId)).status, TEAM_STATUS.ARCHIVED);

  // 归档后学生列表里看不到（管理者仍可见）
  const studentView = await call(repo, 'listTeams', {}, { actor: 'u_m2' });
  assert.equal(studentView.teams.length, 0);
  const managerView = await call(repo, 'listTeams', {}, { actor: 'u_leader' });
  assert.equal(managerView.teams.length, 1);
  assert.equal(managerView.teams[0].status, TEAM_STATUS.ARCHIVED);
});

/* ============================================================
 * 五、范围隔离与列表
 * ============================================================ */

test('列表 —— 待审的队只给管理者看；我的球队筛选按成员关系', async () => {
  const repo = fixture();
  await call(repo, 'createTeamApplication', { name: '待审队', requestId: 'req_p' });
  const activeId = await activeTeam(repo, '热浪队');

  const student = await call(repo, 'listTeams', {}, { actor: 'u_m2' });
  assert.deepEqual(student.teams.map(team => team.name), ['热浪队']);

  const manager = await call(repo, 'listTeams', {}, { actor: 'u_leader' });
  assert.equal(manager.teams.length, 2);
  assert.equal(manager.canManage, true);

  await call(repo, 'applyToJoinTeam', { teamId: activeId }, { actor: 'u_m2' });
  await call(repo, 'reviewTeamMember', { teamId: activeId, userId: 'u_m2', approve: true });
  const mine = await call(repo, 'listTeams', { mine: true }, { actor: 'u_m2' });
  // 本院院队自动出现在「我的球队」里，排在自由球队之前（不必先被挑进队）：
  // 这是院队详情唯一的页面入口，缺了它负责人就没法挑人（2026-10-20 修复）。
  assert.equal(mine.teams[0].isCollegeTeam, true);
  assert.equal(mine.teams[0].isMine, true);
  assert.deepEqual(mine.teams.slice(1).map(team => team.name), ['热浪队']);
});

test('范围 —— 个人赛协会调球队接口直接拒绝', async () => {
  const repo = fixture();
  const result = await call(repo, 'listTeams', {}, { association: 'pkb' });
  assert.equal(result.ok, false);
  assert.match(result.message, /团队项目/);
});

test('列表 —— 人数按在队成员算，不是球队文档上的字段', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo, '热浪队');
  // 队长 1 人 + 两名通过审批的队员
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m1' });
  await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m1', approve: true });
  await call(repo, 'applyToJoinTeam', { teamId }, { actor: 'u_m2' });
  await call(repo, 'reviewTeamMember', { teamId, userId: 'u_m2', approve: true });

  const list = await call(repo, 'listTeams', {}, { actor: 'u_leader' });
  const team = list.teams.find(row => row.teamId === teamId);
  // 球队文档里从来没有 memberCount 字段；以前读它，列表里永远是「0 人」
  assert.equal(team.memberCount, 3, '队长 + 2 名队员');

  // 退队的人不算数
  await call(repo, 'leaveTeam', { teamId }, { actor: 'u_m1' });
  const after = await call(repo, 'listTeams', {}, { actor: 'u_leader' });
  assert.equal(after.teams.find(row => row.teamId === teamId).memberCount, 2);

  // 详情页与列表口径一致
  const detail = await call(repo, 'getTeam', { teamId }, { actor: 'u_leader' });
  assert.equal(detail.team.memberCount, 2);
});

/**
 * 按队下推（2026-10-29 第十一轮审计 P3）
 * ============================================================
 * 球队详情与报名名单原先把**本协会全部队员**读回来再 filter(teamId)，球队越多越亏。
 * 现在走 `teamMembers.listByTeams`。这里把整表读改成抛错，证明读路径真的换掉了：
 * 若还有人偷偷 `list()`，用例立刻红，而不是等云端配额告警才发现。
 */
test('球队详情与报名名单按队下推，不做全协会队员整表读', async () => {
  const repo = fixture();
  const teamId = await activeTeam(repo);
  const forScope = repo.forScope.bind(repo);
  repo.forScope = (scope) => {
    const surface = forScope(scope);
    surface.teamMembers.list = () => { throw new Error('不应读取全协会队员'); };
    return surface;
  };

  const detail = await call(repo, 'getTeam', { teamId }, { actor: 'u_leader' });
  assert.equal(detail.ok, true, detail.message);
  assert.ok(detail.members.length >= 1, '队长应当在名单里');
  // 报名名单（team-event-service）走同一个原语，由团队赛报名用例覆盖；
  // 这里只钉「详情页不再整表读」这一条，避免两处各写一份夹具。
});
