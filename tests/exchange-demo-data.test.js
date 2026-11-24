/**
 * 跨校邀请赛的演示数据（2026-10-16 起预置）
 * ============================================================
 * 「我的 → 跨校邀请赛」在云数据源（真实环境）下已可用；本地模拟环境则预置两场
 * 演示赛事，进去就有东西可点，不必先手工「发起 → 邀请 → 报名 → 抽签」走一遍。
 * 这一组盯四件事：
 *   1. 两场赛事的状态互补：一场停在「报名中」演示报名与锁名单，一场停在
 *      「已抽签」演示录比分与确认名次——只预置一场就演示不了另一半；
 *   2. 四张表自洽：每场赛事都有自己的邀请索引与报名，报名人都在册（读端要按
 *      昵称显示，落成编号就白预置了），赛事的 signupCount 与报名条数相等；
 *      对阵由赛制引擎现算（不在种子里手写），因此小组赛真的排出两组；
 *   3. 参演账号都在演示身份清单里，否则演示数据看得见、切不进去；
 *   4. 转校：预置一条「已提交、待北航审批」的申请，北航管理员一进「学校身份」
 *      就能审；另一位民大会员保持干净，专门用来当场演示提交转校申请。
 * ============================================================
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchoolDemoContent, createSchoolDemoSeed, DEMO_ACCOUNTS,
} = require('../src/mock/school-seed.js');
const schoolMock = require('../src/mock/school-mock.js');
const { schoolKey, schoolMemberKey } = require('../src/shared/utils/school.js');
const { EVENT_FORMAT } = require('../src/shared/utils/constants.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
/** 演示内容锚点（DEMO_CONTENT_NOW = 2026-03-01）之后，用来确认开赛时间没被写回过去 */
const FIXED_FUTURE = '2029-01-01T00:00:00Z';

/* ============================================================
 * 一、纯形状：两场赛事 + 四张表
 * ============================================================ */

test('演示邀请赛 —— 报名中与已抽签各一场，边界字段都按邀请赛口径', () => {
  const content = createSchoolDemoContent();
  const events = content.exchangeEvents;

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.status), ['signup', 'drawn']);
  assert.equal(new Set(events.map(event => event._id)).size, 2, '两场赛事编号不能重复');

  for (const event of events) {
    // 邀请赛的边界：独立集合、不计校内等级分、固定单打、两校各半
    assert.equal(event.eventScope, 'inter_school', `${event.title} 必须是跨校赛事`);
    assert.equal(event.ratingPolicy, 'unrated', `${event.title} 不能计入校内等级分`);
    assert.equal(event.matchType, 'singles', `${event.title} 项目固定单打`);
    assert.equal(event.schoolId, 'muc', '主办校是民大');
    assert.deepEqual(event.participantSchoolIds.slice().sort(), ['buaa', 'muc']);
    assert.deepEqual(event.schoolQuotas, { buaa: 2, muc: 2 });
    assert.equal(event.quota, 4);
    // 开赛时间必须在「未来」：报名与锁定都拿当前时间与它比大小，
    // 一旦退回过去，演示的第一步就会被服务端拒掉。
    assert.ok(Date.parse(event.startTime) > Date.parse(FIXED_FUTURE),
      `${event.title} 的开赛时间应远在未来，实际 ${event.startTime}`);
  }

  // 赛制刻意取两种：单败用来演示最常用的一条路，小组赛+淘汰用来演示签表分组
  assert.equal(events[0].format, EVENT_FORMAT.SINGLE_ELIM);
  assert.equal(events[1].format, EVENT_FORMAT.GROUP_KNOCKOUT);
});

test('演示邀请赛 —— 邀请索引与报名挂在存在的赛事上，键都是 schoolKey 拼的', () => {
  const content = createSchoolDemoContent();
  const eventIds = new Set(content.exchangeEvents.map(event => event._id));

  assert.equal(content.exchangeInvitations.length, 4, '两场赛事 × 两所学校');
  for (const row of content.exchangeInvitations) {
    assert.ok(eventIds.has(row.eventId), `邀请必须挂在演示赛事上：${row._id}`);
    assert.equal(row._id, schoolKey('xi', row.eventId, row.schoolId));
    assert.ok(['buaa', 'muc'].includes(row.schoolId));
  }
  // 两校都接受了邀请，否则报名阶段的按钮是灰的
  for (const event of content.exchangeEvents) {
    assert.deepEqual(event.invitations, { buaa: 'accepted', muc: 'accepted' });
  }

  const known = new Set([...DEMO_ACCOUNTS.map(account => account.id), 'demo_muc_college_leader']);
  assert.equal(content.exchangeSignups.length, 6, '报名中 2 人 + 已抽签 4 人');
  for (const row of content.exchangeSignups) {
    assert.ok(eventIds.has(row.eventId), `报名必须挂在演示赛事上：${row._id}`);
    assert.equal(row._id, schoolKey('xs', row.eventId, row.userId));
    assert.ok(known.has(row.userId), `报名只能写给在册的演示账号：${row.userId}`);
    assert.equal(row.schoolMemberId, schoolMemberKey(row.userId, row.representedSchoolId));
    // 少了昵称，对阵里只剩编号——读端要靠它显示人
    assert.ok(row.nickName && row.nickName !== row.userId, `报名要带昵称：${row.userId}`);
    assert.ok(['buaa', 'muc'].includes(row.representedSchoolId), '要记清代表哪所学校出战');
    assert.equal(row.status, 'signed');
  }

  // signupCount 与报名条数同源，否则列表上的人数与名单对不上
  for (const event of content.exchangeEvents) {
    const roster = content.exchangeSignups.filter(row => row.eventId === event._id);
    assert.equal(event.signupCount, roster.length, `${event.title} 的 signupCount 与报名条数不一致`);
    assert.equal(event.schoolCounts.muc + event.schoolCounts.buaa, roster.length);
  }
});

test('演示邀请赛 —— 对阵由赛制引擎现算：小组赛真的排出两组，且都是待比赛', () => {
  const content = createSchoolDemoContent();
  const drawn = content.exchangeEvents.find(event => event.status === 'drawn');
  const matches = content.exchangeMatches;

  assert.ok(drawn.draw, '已抽签的赛事必须带签表，否则详情页没有对阵可读');
  assert.equal(drawn.draw.createdBy, 'demo_muc_admin');
  assert.equal(drawn.draw.seedValue, 20261016, '签表随机种子固定，每次 reset 签位一样');
  assert.equal(drawn.draw.groups.length, 2, '小组赛的签表落成两组');

  // 对手全是演示账号：签位写错人（例如签表里的编号不在报名名单里）会渲染成空名字
  const entrantIds = new Set(content.exchangeSignups
    .filter(row => row.eventId === drawn._id).map(row => row.userId));
  assert.equal(entrantIds.size, 4);
  assert.deepEqual([...new Set(drawn.draw.groups.flatMap(group => group.entries))].sort(),
    [...entrantIds].sort(), '签位与报名名单必须是同一批人');

  assert.equal(content.exchangeEvents.find(event => event.status === 'signup')
    ._id === matches[0].eventId, false, '没抽签的赛事不该有对阵');
  assert.ok(matches.length > 0, '已抽签的赛事要有对阵');
  for (const match of matches) {
    assert.equal(match.eventId, drawn._id, '没抽签的那场不该有对阵');
    assert.equal(match.schoolId, drawn.schoolId, '对阵要带范围，否则记录键对不上');
    assert.equal(match.association, drawn.association);
    assert.equal(match.status, 'pending', '预置的对阵一律停在待比赛，留给演示者录比分');
    assert.ok(entrantIds.has(match.playerA) && entrantIds.has(match.playerB),
      '对阵双方都要在报名名单里');
    assert.notEqual(match.playerA, match.playerB);
  }

  // 4 人 2 组：每组两人一场，两个组都得排出来（只排一组等于演示不全）
  assert.deepEqual([...new Set(matches.map(match => match.group))].sort(), [0, 1]);
  assert.equal(matches.filter(match => match.group === 0).length, 1);
  assert.equal(matches.filter(match => match.group === 1).length, 1);
  assert.ok(matches.every(match => match.stage === 'group'), '此刻只应有小组赛');
});

test('演示邀请赛 —— 参演账号都在演示身份清单里', () => {
  const content = createSchoolDemoContent();
  const actorIds = new Set(schoolMock.DEMO_ACTORS.map(actor => actor.id));
  const entrants = new Set([...content.exchangeSignups.map(row => row.userId),
    ...content.exchangeEvents.map(event => event.createdBy)]);

  assert.ok(entrants.size > 0);
  for (const id of entrants) {
    assert.ok(actorIds.has(id), `演示身份清单里没有 ${id}——数据看得见却切不进去`);
  }
});

test('转校演示 —— 一条待北航审批的申请，申请人正是新增的「民大会员二」', () => {
  const content = createSchoolDemoContent();
  const seed = createSchoolDemoSeed();

  assert.equal(content.schoolMembers.length, 1, '只预置一条，别弄出两份待办');
  const [application] = content.schoolMembers;
  assert.equal(application.userId, 'demo_muc_member_2');
  // 落在**转入学校**那一侧（北航），因为转校只需转入校管理员同意
  assert.equal(application.schoolId, 'buaa');
  assert.equal(application.transferFrom, 'muc', '要留原学校，审批时才知道从哪转出');
  assert.equal(application.status, 'pending');
  assert.equal(application.revision, 1);

  // 申请人本身仍在民大在册：转校是「申请」，还没有搬运
  const ownMember = seed.schoolMembers.find(row => row.userId === 'demo_muc_member_2');
  assert.ok(ownMember, '“民大会员二”要是民大的在册会员');
  assert.equal(ownMember.schoolId, 'muc');
  assert.equal(ownMember.status, 'active');

  // 另一位民大会员要保持干净，否则「当场提交转校申请」无从演示
  assert.equal(seed.schoolMembers.some(row => row.userId === 'demo_muc_member'
    && row.schoolId === 'buaa'), false, '“民大会员”不该有北航的待审身份');
});

/* ============================================================
 * 二、reset() 之后从接口读出来：演示真的走得通
 * ============================================================ */

describe('schoolMock.reset() —— 预置的邀请赛与转校待办都读得出来', () => {
  beforeEach(() => schoolMock.reset());

  test('民大管理员看得到两场演示赛事，已抽签那场带着两组的对阵与四张名单', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const api = schoolMock.forExchange(SCOPE);

    const list = await api.getExchangeEvents();
    assert.equal(list.ok, true, list.message);
    assert.equal(list.events.length, 2, '两场演示赛事都要列出来（多了就是种子挂了）');

    const open = await api.getExchangeEvent({
      eventId: list.events.find(event => event.status === 'signup')._id });
    assert.equal(open.ok, true, open.message);
    assert.equal(open.participants.length, 2, '报名中那场应已有人报名，能直接演示锁名单');
    assert.equal(open.canManage, true);

    const drawn = await api.getExchangeEvent({
      eventId: list.events.find(event => event.status === 'drawn')._id });
    assert.equal(drawn.ok, true, drawn.message);
    assert.equal(drawn.participants.length, 4);
    assert.equal(drawn.matches.length, 2);
    // 对阵里的人名来自报名台账，不是编号
    assert.ok(drawn.matches.every(match => match.nameA && match.nameB));
    assert.ok(drawn.matches.every(match => /^第 [12] 组 · $/.test(match.groupText)));
    // 停在「待比赛」：可以录比分，但不能跳过比赛直接确认名次
    assert.equal(drawn.matches.every(match => match.status === 'pending'), true);
    assert.equal(drawn.canDraw, true, '还没打过一场，可以重新抽签');
    assert.equal(drawn.canConfirmRanking, false, '一场都没打完时不许确认名次');
  });

  test('北航管理员进「学校身份」就看到那条转校待办，且走的是转校审批口径', async () => {
    schoolMock.setDemoActor('demo_buaa_admin');
    const api = schoolMock.forSchoolIdentity({ schoolId: 'buaa', association: 'pkb' });

    const session = await api.getSchoolIdentitySession();
    assert.equal(session.ok, true, session.message);
    assert.equal(session.canReview, true, '北航管理员要有审核权，否则待办点不动');

    const result = await api.getSchoolApplications();
    assert.equal(result.ok, true, result.message);
    const transfer = result.applications.find(row => row.userId === 'demo_muc_member_2');
    assert.ok(transfer, '待审列表里应有这条转校申请');
    // transfer 标记决定页面调 reviewSchoolTransfer 还是普通入会审批（两条口径不同）
    assert.equal(transfer.transfer, true);
    assert.equal(transfer.revision, 1);
    assert.equal(transfer.studentId, 'TEST007');
    assert.ok(transfer.nickName, '待办要带申请人昵称，否则管理员面对一串编号');
    assert.ok(transfer.collegeName, '学院名要解析得出，页面上才不是「学院待核实」');
  });

  test('withDemoContent: false 时邀请赛演示数据也关得干净', async () => {
    schoolMock.reset({ withDemoContent: false });
    schoolMock.setDemoActor('demo_muc_admin');
    const api = schoolMock.forExchange(SCOPE);

    const list = await api.getExchangeEvents();
    assert.equal(list.ok, true, list.message);
    assert.deepEqual(list.events, [], '关掉演示内容后不该再剩邀请赛');
  });
});
