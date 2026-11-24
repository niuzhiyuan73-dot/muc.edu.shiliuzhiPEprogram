/**
 * 石榴籽杯 · 篮球/足球学院赛：系统预置院队
 * ============================================================
 * 守的是这一版的口径：
 *   1. 每个学院有一支由系统预置的院队（确定性编号，读时补建，幂等）；
 *   2. 队员由**学院负责人挑选**（选了即入队），成员可自行退出，但没有申请入口；
 *   3. 学院赛只接受院队报名，院队也只打学院赛；一院一届一条报名由主键天然保证；
 *   4. 院队不设队长、不可改名、不可归档，管理权挂在学院角色上。
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/team-event-service');
const teamHandlers = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey, collegeTeamKey } = require('../src/shared/utils/school');
const {
  TEAM_TYPE, TEAM_ENTRY_STATUS, TEAM_EVENT_STATUS, CUP_MODE,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

/** c01 / c02 两个学院：各一名学院负责人 + 若干会员；另有一名协会负责人 */
function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, collegeId) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
    seed.memberships.push({ _id: schoolMembershipKey(id, SCOPE),
      userId: id, schoolId: 'muc', association: 'bk', role: 'member', collegeId, status: 'active' });
  };
  add('staff_c01', 'c01');
  add('staff_c02', 'c02');
  // 学院负责人 = staff + collegeId（与学院赛交名单同一档）
  seed.memberships.find(row => row.userId === 'staff_c01').role = 'staff';
  seed.memberships.find(row => row.userId === 'staff_c02').role = 'staff';
  for (let i = 1; i <= 5; i += 1) add(`c02_p${i}`, 'c02');
  // c03：有会员、但从来没有学院负责人（校管代报的场景）
  for (let i = 1; i <= 5; i += 1) add(`c03_p${i}`, 'c03');
  add('c01_p1', 'c01');
  add('u_leader', 'c01');
  seed.memberships.find(row => row.userId === 'u_leader').role = 'leader';
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  const handler = handlers[action] || teamHandlers[action];
  assert.ok(handler, `没有这个动作：${action}`);
  return (await handler(payload, ctx)).data;
}

const collegeTeamId = collegeId => collegeTeamKey(collegeId, SCOPE);

/* ------------------------------------------------------------ 院队预置 */

test('院队：系统按学院预置，一个学院一条，读时补建且幂等', async () => {
  const repo = fixture();
  const first = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(first.ok, true, first.message);
  assert.equal(first.team.type, TEAM_TYPE.COLLEGE);
  assert.equal(first.team.teamId, collegeTeamId('c02'));
  assert.equal(first.team.captainId, '', '院队不设队长');
  assert.match(first.team.name, /代表队$/, '院队名按学院目录现拼');
  assert.equal(first.team.memberCount, 0);
  assert.equal(first.canPickMembers, true, '本学院负责人可以挑人');

  // 再读一次：同一条，不会建出第二支
  const again = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(again.team.teamId, first.team.teamId);
  const all = (await repo.teams.list()).filter(team => team.collegeId === 'c02');
  assert.equal(all.length, 1, '同一学院只应有一条院队');

  // 编号与学院绑定：换个人读，读到的还是本院那一条
  const byMember = await call(repo, 'getCollegeTeam', {}, 'c02_p1');
  assert.equal(byMember.team.teamId, first.team.teamId);
  assert.equal(byMember.canPickMembers, false, '普通队员不能挑人');
  assert.deepEqual(byMember.candidates, [], '普通队员拿不到候选池');
});

test('院队：不进入「组队」列表，避免二十来支院队淹没自由组队', async () => {
  const repo = fixture();
  await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  const listed = await call(repo, 'listTeams', {}, 'staff_c02');
  assert.equal(listed.ok, true, listed.message);
  assert.equal(listed.teams.some(team => team.type === TEAM_TYPE.COLLEGE), false);
});

/* ------------------------------------------------------------ 挑人与退出 */

test('院队：负责人挑人即入队，只挑本学院会员，重复挑幂等', async () => {
  const repo = fixture();
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;

  const picked = await call(repo, 'addCollegeTeamMembers',
    { teamId: team.teamId, userIds: ['c02_p1', 'c02_p2', 'c02_p3'] }, 'staff_c02');
  assert.equal(picked.ok, true, picked.message);
  assert.equal(picked.added, 3);

  const detail = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(detail.team.memberCount, 3);
  assert.equal(detail.members.length, 3);
  // 候选池标出谁已在队，负责人一眼能看出还差谁
  assert.equal(detail.candidates.find(row => row.userId === 'c02_p1').inTeam, true);
  assert.equal(detail.candidates.find(row => row.userId === 'c02_p4').inTeam, false);

  const repeated = await call(repo, 'addCollegeTeamMembers',
    { teamId: team.teamId, userIds: ['c02_p1'] }, 'staff_c02');
  assert.equal(repeated.added, 0, '重复挑同一个人不应重复计数');

  // 别院的人挑不进来；别院负责人也挑不动本院
  const outside = await call(repo, 'addCollegeTeamMembers',
    { teamId: team.teamId, userIds: ['c01_p1'] }, 'staff_c02');
  assert.equal(outside.ok, false);
  assert.match(outside.message, /本学院/);

  const otherCollege = await call(repo, 'addCollegeTeamMembers',
    { teamId: team.teamId, userIds: ['c02_p4'] }, 'staff_c01');
  assert.equal(otherCollege.ok, false);
  assert.match(otherCollege.message, /本学院负责人/);
});

test('院队：没有申请入口，成员可自退；负责人可移除队员', async () => {
  const repo = fixture();
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;
  await call(repo, 'addCollegeTeamMembers', { teamId: team.teamId, userIds: ['c02_p1', 'c02_p2'] }, 'staff_c02');

  const applied = await call(repo, 'applyToJoinTeam', { teamId: team.teamId }, 'c02_p3');
  assert.equal(applied.ok, false);
  assert.match(applied.message, /负责人挑选/, '院队不给申请入口');

  const left = await call(repo, 'leaveTeam', { teamId: team.teamId }, 'c02_p1');
  assert.equal(left.ok, true, left.message);
  let detail = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(detail.team.memberCount, 1, '自己退出后人数减一');
  assert.equal(detail.members.some(row => row.userId === 'c02_p1'), false);

  const removed = await call(repo, 'removeCollegeTeamMember',
    { teamId: team.teamId, userId: 'c02_p2' }, 'staff_c02');
  assert.equal(removed.ok, true, removed.message);
  detail = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(detail.team.memberCount, 0);
});

test('院队：不能转让队长、不能归档（系统预置，用户不可解散）', async () => {
  const repo = fixture();
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;
  await call(repo, 'addCollegeTeamMembers', { teamId: team.teamId, userIds: ['c02_p1'] }, 'staff_c02');

  const transfer = await call(repo, 'transferTeamCaptain',
    { teamId: team.teamId, userId: 'c02_p1' }, 'staff_c02');
  assert.equal(transfer.ok, false);
  assert.match(transfer.message, /没有队长/);

  const archive = await call(repo, 'archiveTeam', { teamId: team.teamId }, 'staff_c02');
  assert.equal(archive.ok, false);
  assert.match(archive.message, /不能归档/);
});

/* ------------------------------------------------------------ 学院赛报名 */

let cupSeq = 0;
async function collegeCup(repo, name = '2026 石榴籽杯篮球学院赛') {
  cupSeq += 1;
  const created = await call(repo, 'createTeamEvent',
    { name, requestId: `req_cup_${cupSeq}`, cupMode: CUP_MODE.COLLEGE });
  assert.equal(created.ok, true, created.message);
  return created.eventId;
}

test('学院赛：建赛带杯赛标记，普通赛事不带；院队只打学院赛', async () => {
  const repo = fixture();
  const cupId = await collegeCup(repo);
  const plain = await call(repo, 'createTeamEvent', { name: '秋季友谊赛', requestId: 'req_plain' });

  const cup = await repo.teamEvents.getById(cupId);
  assert.equal(cup.cupMode, CUP_MODE.COLLEGE);
  const listedCups = await call(repo, 'listTeamEvents', { cupMode: CUP_MODE.COLLEGE }, 'staff_c02');
  assert.deepEqual(listedCups.events.map(row => row.eventId), [cupId], '按杯赛归属过滤');
  assert.equal(listedCups.events[0].isCollegeCup, true);

  const plainDoc = await repo.teamEvents.getById(plain.eventId);
  assert.equal(plainDoc.cupMode, '', '普通赛事不带杯赛标记');

  // 院队报名普通赛事：拒绝
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;
  await call(repo, 'addCollegeTeamMembers',
    { teamId: team.teamId, userIds: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'] }, 'staff_c02');
  const intoPlain = await call(repo, 'submitTeamEntry',
    { eventId: plain.eventId, teamId: team.teamId }, 'staff_c02');
  assert.equal(intoPlain.ok, false);
  assert.match(intoPlain.message, /只参加石榴籽杯/);
});

test('学院赛：只接受院队报名，普通球队被拒；院队报名一院一条', async () => {
  const repo = fixture();
  const eventId = await collegeCup(repo);

  // 一支自由球队想代表学院：拒
  const free = await call(repo, 'createTeamApplication', { name: '野球队', requestId: 'req_free' }, 'c02_p1');
  await call(repo, 'reviewTeamApplication', { teamId: free.teamId, approve: true }, 'u_leader');
  const freeTry = await call(repo, 'submitTeamEntry', { eventId, teamId: free.teamId }, 'c02_p1');
  assert.equal(freeTry.ok, false);
  assert.match(freeTry.message, /学院代表队/);

  // 院队报上
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;
  const submitted = await call(repo, 'submitTeamEntry', {
    eventId, teamId: team.teamId,
    roster: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'],
  }, 'staff_c02');
  assert.equal(submitted.ok, true, submitted.message);

  const entries = (await repo.teamEventEntries.list()).filter(row => row.eventId === eventId);
  assert.equal(entries.length, 1, '一个学院一届只有一条报名');
  assert.equal(entries[0].teamId, team.teamId);
  assert.equal(entries[0].status, TEAM_ENTRY_STATUS.SUBMITTED);
  assert.equal(entries[0].roster.length, 5);

  // 再报一次仍是同一条（主键决定），不会出现第二条
  await call(repo, 'submitTeamEntry', {
    eventId, teamId: team.teamId, roster: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'],
  }, 'staff_c02');
  assert.equal((await repo.teamEventEntries.list()).filter(row => row.eventId === eventId).length, 1);

  // 报名阶段、本院已报名 → 杯赛页不再给「报名」按钮
  const listed = await call(repo, 'listTeamEvents', { cupMode: CUP_MODE.COLLEGE }, 'staff_c02');
  assert.equal(listed.events[0].canSubmit, false);
  assert.equal(listed.events[0].myEntryStatusLabel, '待审核');
});

test('学院赛：报名名单里的人自动进院队；跨院负责人报不了别院', async () => {
  const repo = fixture();
  const eventId = await collegeCup(repo);
  const team = (await call(repo, 'getCollegeTeam', {}, 'staff_c02')).team;
  assert.equal(team.memberCount, 0, '前置：院队一开始是空的');

  // 报名面板：候选池是本院会员（不是「已在队的人」）
  const roster = await call(repo, 'getTeamEntryRoster', { eventId, teamId: team.teamId }, 'staff_c02');
  assert.equal(roster.ok, true, roster.message);
  assert.equal(roster.team.isCollegeTeam, true);
  assert.equal(roster.event.isCollegeCup, true);
  assert.equal(roster.members.length, 6, 'c02 的 6 名会员（含负责人）都可被挑');
  assert.equal(roster.members.every(row => row.selected === false), true, '空院队不默认全选');

  // 报 5 人 → 这些人自动进队
  const submitted = await call(repo, 'submitTeamEntry', {
    eventId, teamId: team.teamId, roster: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'],
  }, 'staff_c02');
  assert.equal(submitted.ok, true, submitted.message);
  const after = await call(repo, 'getCollegeTeam', {}, 'staff_c02');
  assert.equal(after.team.memberCount, 5, '「选了自动进队」');

  // 别院负责人不能代本院报名
  const otherCollege = await call(repo, 'getCollegeTeam', { collegeId: 'c02' }, 'staff_c01');
  assert.equal(otherCollege.ok, true, otherCollege.message);
  assert.equal(otherCollege.canPickMembers, false, 'c01 负责人管不到 c02 的院队');

  const event2 = await collegeCup(repo, '2026 秋季学院赛');
  const cross = await call(repo, 'submitTeamEntry',
    { eventId: event2, teamId: team.teamId, roster: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'] },
    'staff_c01');
  assert.equal(cross.ok, false);
  assert.match(cross.message, /本学院负责人/);
});

test('学院赛：关键词按赛事名与场地过滤，不影响普通赛事列表', async () => {
  const repo = fixture();
  await collegeCup(repo, '2026 春季篮球学院赛');
  await collegeCup(repo, '2026 秋季篮球学院赛');
  await call(repo, 'createTeamEvent', { name: '毕业杯友谊赛', requestId: 'req_grad' });

  const cups = await call(repo, 'listTeamEvents', { cupMode: CUP_MODE.COLLEGE, keyword: '秋季' }, 'staff_c02');
  assert.equal(cups.events.length, 1);
  assert.match(cups.events[0].name, /秋季/);

  const all = await call(repo, 'listTeamEvents', {}, 'staff_c02');
  assert.equal(all.events.length, 3, '不带 cupMode 时仍是全部团队赛事');

  const status = await repo.teamEvents.getById(cups.events[0].eventId);
  assert.equal(status.status, TEAM_EVENT_STATUS.REGISTRATION);
});

/* ------------------------------------------------------------ 惰性预置的补建 */

test('学院赛：全新库里院队还没落过库，负责人照样看得到、报得上名', async () => {
  const repo = fixture();
  const eventId = await collegeCup(repo);
  assert.equal((await repo.teams.list()).length, 0, '前置：建赛不预置院队');

  // 报名候选按学院目录派生，不依赖 teams 集合里有没有这条记录
  const detail = await call(repo, 'getTeamEvent', { eventId }, 'staff_c02');
  assert.equal(detail.submitCandidates.length, 1);
  assert.equal(detail.submitCandidates[0].teamId, collegeTeamId('c02'));
  assert.match(detail.submitCandidates[0].name, /代表队$/);
  assert.equal(detail.submitCandidates[0].actionText, '为本学院报名');
  assert.equal(detail.entryPanel.mode, 'college_staff');
  assert.match(detail.entryPanel.hint, /为本学院报名/);

  // 直接调报名：不再被「球队不存在或未通过审核」挡回去，报名时就地补建院队
  const submitted = await call(repo, 'submitTeamEntry', {
    eventId, teamId: collegeTeamId('c02'),
    roster: ['c02_p1', 'c02_p2', 'c02_p3', 'c02_p4', 'c02_p5'],
  }, 'staff_c02');
  assert.equal(submitted.ok, true, submitted.message);

  const created = (await repo.teams.list()).filter(row => row.collegeId === 'c02');
  assert.equal(created.length, 1, '补建是幂等的，只出一条');
  assert.equal(created[0].type, TEAM_TYPE.COLLEGE);
  assert.equal(created[0]._id, collegeTeamId('c02'));
  assert.equal((await repo.teamEventEntries.list()).filter(row => row.eventId === eventId).length, 1);
});

test('学院赛：没有负责人的学院，校管也能代报名；普通会员只看到说明', async () => {
  const repo = fixture();
  const eventId = await collegeCup(repo);

  // 普通会员：没有入口，但要说清「由学院负责人提交」，不能让人以为页面坏了
  const memberView = await call(repo, 'getTeamEvent', { eventId }, 'c02_p5');
  assert.deepEqual(memberView.submitCandidates, []);
  assert.equal(memberView.entryPanel.mode, 'member');
  assert.match(memberView.entryPanel.hint, /学院负责人/);

  // 校管：候选 = 全校学院目录（一人一条），文案是「代 X 学院报名」
  const adminView = await call(repo, 'getTeamEvent', { eventId }, 'u_leader');
  const collegeCount = (await repo.forScope(SCOPE).colleges.list()).length;
  assert.equal(adminView.entryPanel.mode, 'school_admin');
  assert.match(adminView.entryPanel.hint, /代任意学院报名/);
  assert.equal(adminView.submitCandidates.length, collegeCount);
  const c03Row = adminView.submitCandidates.find(row => row.collegeId === 'c03');
  assert.ok(c03Row, '无负责人的学院也在候选里');
  assert.match(c03Row.actionText, /^代 .+ 报名$/);

  // c03 从来没有负责人：校管代报照样成功，院队按编号补建
  const submitted = await call(repo, 'submitTeamEntry', {
    eventId, teamId: collegeTeamId('c03'),
    roster: ['c03_p1', 'c03_p2', 'c03_p3', 'c03_p4', 'c03_p5'],
  }, 'u_leader');
  assert.equal(submitted.ok, true, submitted.message);
  const after = await call(repo, 'getTeamEvent', { eventId }, 'u_leader');
  assert.equal(after.submitCandidates.some(row => row.collegeId === 'c03'), false, '报过的学院不再出现在候选里');
  assert.equal(after.entries.length, 1);
  assert.match(after.entries[0].collegeName, /学院/);
});

test('我的球队：本院院队自动在列表里，排在自由球队之前；组队列表仍不列院队', async () => {
  const repo = fixture();
  const free = await call(repo, 'createTeamApplication', { name: '野球队', requestId: 'req_mine_free' }, 'c02_p1');
  await call(repo, 'reviewTeamApplication', { teamId: free.teamId, approve: true }, 'u_leader');

  // 普通会员、且没被挑进院队：本院院队仍在「我的球队」里
  const mine = await call(repo, 'listTeams', { mine: true }, 'c02_p1');
  assert.equal(mine.teams[0].isCollegeTeam, true);
  assert.equal(mine.teams[0].teamId, collegeTeamId('c02'));
  assert.equal(mine.teams[0].isMine, true, '本院即算我的球队，不必先被挑进队');
  assert.equal(mine.teams[0].memberCount, 0);
  assert.ok(mine.teams.some(row => row.teamId === free.teamId));

  // 组队列表（不带 mine）仍不列院队：二十来支院队会把自由组队淹掉
  const all = await call(repo, 'listTeams', {}, 'c02_p1');
  assert.equal(all.teams.some(row => row.isCollegeTeam), false);
});

test('学院赛：院队没落库时，点进详情与开报名名单都能就地补建', async () => {
  const repo = fixture();
  const eventId = await collegeCup(repo);
  assert.equal((await repo.teams.list()).length, 0, '前置：一条院队都没有');

  // 我的球队 → 点院队 → getTeam：先补建再读，不该报「球队不存在」
  const detail = await call(repo, 'getTeam', { teamId: collegeTeamId('c02') }, 'c02_p5');
  assert.equal(detail.ok, true, detail.message);
  assert.equal(detail.team.isCollegeTeam, true);
  assert.equal((await repo.teams.list()).filter(row => row.collegeId === 'c02').length, 1);

  // 「代 X 学院报名」点进去开名单面板：候选池是本院会员
  const roster = await call(repo, 'getTeamEntryRoster', { eventId, teamId: collegeTeamId('c03') }, 'u_leader');
  assert.equal(roster.ok, true, roster.message);
  assert.equal(roster.team.isCollegeTeam, true);
  assert.equal(roster.members.length, 5, 'c03 的 5 名会员都可被挑');
});

/* ------------------------------------------------------------ 页面 */

const path = require('node:path');const fs = require('node:fs');
const { loadPage, instantiate, withApi } = require('./helpers/page-harness.js');

test('球队详情：院队不显示申请与归档，负责人有「添加队员」和「移出」', async () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/packageTeam/team-detail/team-detail.wxml'), 'utf8');
  assert.ok(/onOpenPick/.test(wxml) && /onSavePick/.test(wxml), '院队挑人面板没接上');
  assert.ok(/onRemoveMember/.test(wxml), '院队缺「移出」');
  assert.ok(/team\.isCollegeTeam && canPickMembers/.test(wxml), '挑人入口必须同时受院队与负责人两个条件约束');
  assert.ok(/!team\.isCollegeTeam/.test(wxml), '院队的「归档球队」没有关掉');

  // 页面在院队时额外取候选池；普通球队不打这个接口
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.scope = { schoolId: 'muc', association: 'bk' };
  page.data.teamId = 'tm:college';
  await withApi({
    getTeam: () => ({ ok: true, team: { teamId: 'tm:college', isCollegeTeam: true, canManage: true },
      members: [], pendingCount: 0 }),
    getTeamRecord: () => ({ ok: true, overall: {}, seasons: [], recent: [] }),
    getCollegeTeam: () => ({ ok: true, canPickMembers: true, team: { teamId: 'tm:college', isCollegeTeam: true },
      candidates: [{ userId: 'u1', name: '张三', inTeam: false }] }),
  }, async (calls) => {
    await page.refresh();
    assert.equal(page.data.canPickMembers, true);
    assert.equal(page.data.candidates.length, 1);
    assert.ok(calls.some(call => call[0] === 'getCollegeTeam'), '院队详情应取候选池');

    page.onOpenPick();
    assert.equal(page.data.pickOpen, true);
    page.onTogglePick({ currentTarget: { dataset: { userid: 'u1' } } });
    assert.equal(page.data.pickedCount, 1);
  });
});

test('赛事详情：学院赛有标签与说明，报名单位按学院表达', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/packageTeam/team-event-detail/team-event-detail.wxml'), 'utf8');
  assert.ok(/event\.isCollegeCup/.test(wxml), '详情页没有学院赛标记');
  assert.ok(/个学院/.test(wxml), '学院赛的报名单位应显示为「个学院」而不是「支球队」');
  assert.ok(/还没有学院报名/.test(wxml), '学院赛的空态文案没换');
  assert.ok(/item\.collegeName/.test(wxml), '名次/报名行应按学院展示');
});

test('赛事列表：从杯赛页带 cupMode 进来时建赛面板标明学院赛', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/packageTeam/team-event-list/team-event-list.wxml'), 'utf8');
  assert.ok(/isCollegeCup \? '发起学院赛' : '新建赛事'/.test(wxml), '建赛面板标题没按杯赛模式切换');
  assert.ok(/一院一队/.test(wxml), '学院赛建赛时没有交代报名规则');

  const page = loadPage('team-event-list/team-event-list.js');
  assert.equal(typeof page.onLoad, 'function');
});

test('赛事列表：从杯赛页带 cupMode 进来，建赛请求把标记一起提交', async () => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await withApi({
    listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
    createTeamEvent: payload => ({ ok: true, eventId: 'tev:new', __payload: payload }),
  }, async (calls) => {
    await page.onLoad({ create: '1', cupMode: 'college', projectId: 'bk' });
    assert.equal(page.data.isCollegeCup, true, '带 cupMode 进来就是学院赛');
    assert.equal(page.data.creating, true, 'create=1 直接落在建赛面板');

    page.data.newName = '2026 石榴籽杯篮球学院赛';
    await page.onSubmitCreate();
    const sent = calls.find(call => call[0] === 'createTeamEvent')[1];
    assert.equal(sent.cupMode, 'college', '建赛请求必须带杯赛标记');
  });

  // 普通进入：请求里不该出现这个字段（否则会被误读成学院赛）
  const plain = instantiate(loadPage('team-event-list/team-event-list.js'));
  await withApi({
    listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
    createTeamEvent: payload => ({ ok: true, eventId: 'tev:plain' }),
  }, async (calls) => {
    await plain.onLoad({ projectId: 'bk' });
    plain.data.newName = '秋季友谊赛';
    await plain.onSubmitCreate();
    assert.equal('cupMode' in calls.find(call => call[0] === 'createTeamEvent')[1], false);
  });
});

test('页面：工作台赛事列表给学院赛打标签、报名数按学院表达', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/packageTeam/team-event-list/team-event-list.wxml'), 'utf8');
  assert.ok(/item\.isCollegeCup.*学院赛/.test(wxml), '赛事列表行没有「学院赛」标签');
  assert.ok(/个学院.*支球队|支球队.*个学院/.test(wxml), '报名单位没有按学院赛切换');
});

test('页面：我的球队里院队不写「队长」，标成学院队', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/packageTeam/team-list/team-list.wxml'), 'utf8');
  assert.ok(/item\.isCollegeTeam.*学院队/s.test(wxml), '院队行没有按学院队展示');
  assert.ok(/mineLabel/.test(wxml), '院队应有「本院」标签');
});
