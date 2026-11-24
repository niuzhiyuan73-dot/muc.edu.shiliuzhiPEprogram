/**
 * 学校维度：个人赛事「页面适配层」（school-event-view.js，迁移清单 M1-a 配套）
 *
 * 守的是：协议 2 的 DTO 经这一层翻译回旧构建器的形状后，页面上看到的东西与
 * 协议 1 同一把尺子——
 *   · 单打 / 双打 / 分组赛 / 淘汰赛的签表、积分表、名次都能整形成旧形状；
 *   · 权限旗标来自服务端 DTO，不在视图层用旧角色重算；
 *   · 「我」的高亮按传入的 actorId 落在本人那几行上。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { schoolMemberKey } = require('../src/shared/utils/school');
const {
  MATCH_TYPE, EVENT_FORMAT, EVENT_BRONZE_MODE, SEED_MODE, MATCH_STATUS,
} = require('../src/shared/utils/constants');

const eventSvc = require('../src/server/services/school-event-service');
const matchSvc = require('../src/server/services/school-match-service');
const rankSvc = require('../src/server/services/school-rank-service');
const assocSpace = require('../miniprogram/services/association-space');
const view = require('../miniprogram/services/school-event-view');

const SPACE_HANDLERS = { ...eventSvc, ...matchSvc, ...rankSvc };
const SPACE_NAMES = ['publishSchoolEvent', 'signUpSchoolEvent', 'drawSchoolEvent', 'startSchoolEvent',
  'finishSchoolEvent', 'confirmSchoolMatch', 'getSchoolEvent', 'listSchoolEvents',
  'listSchoolEventSignups', 'listSchoolMatches', 'getSchoolMemberStats'];

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const startAt = new Date(NOW.getTime() + DAY).toISOString();

/**
 * 民大 pkb：管理员 + 四名在册男会员（够排单打 4 人与双打 2 队）。
 * @param {number} [extraCount] 再补几名在册男会员（8 人签位 / 场地看板要用）
 */
function fixture(extraCount = 0) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  seed.users.find(item => item._id === 'demo_muc_admin').gender = 'M';
  seed.users.find(item => item._id === 'demo_muc_member').gender = 'M';
  ['_2', '_3', '_4'].forEach((suffix, index) => {
    const id = `demo_muc_member${suffix}`;
    seed.users.push({ _id: id, openId: `mock_openid${suffix}`, nickName: `会员${index + 2}`,
      gender: 'M', platformStatus: 'active', platformRole: 'member',
      primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: `TEST00${index + 3}`, status: 'active', simulated: true });
  });
  for (let index = 0; index < extraCount; index += 1) {
    const id = `demo_muc_player_${index + 1}`;
    seed.users.push({ _id: id, openId: `mock_openid_player_${index + 1}`, nickName: `选手${index + 1}`,
      gender: 'M', platformStatus: 'active', platformRole: 'member',
      primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: `PLAYER0${index + 1}`, status: 'active', simulated: true });
  }
  return createSchoolMemoryRepo(seed);
}

/**
 * 直接打一个 S2 处理器（SPACE_NAMES 之外也要用得上，比如驳回 / 手工抽签）。
 * @returns {Promise<Object>} 处理器的 `.data`
 */
async function call(repo, name, payload, actor = 'demo_muc_admin') {
  const ctx = await buildSchoolContext({
    repo, actorId: actor, scope: { schoolId: 'muc', association: 'pkb' }, now: NOW,
  });
  return (await SPACE_HANDLERS[name](payload || {}, { ...ctx, isMock: true })).data;
}

/**
 * 协会空间客户端：与 school-mock.forAssociationSpace 同一套绑法——把 actor 与
 * scope 绑进 ctx，返回各接口的 `.data`（读端失败藏在 data.ok 里，与线上一致）。
 */
function spaceClient(repo, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  return Object.fromEntries(SPACE_NAMES.map(name => [name, async payload => {
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
    return (await SPACE_HANDLERS[name](payload || {}, { ...ctx, isMock: true })).data;
  }]));
}

const valid = (extra = {}) => ({
  title: '周末单打赛', description: '协会常规赛', matchType: MATCH_TYPE.SINGLES, level: 3,
  format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
  startTime: startAt, courtCount: 2, ...extra,
});

/** 发布一场，返回 eventId。 */
async function publish(admin, token, extra = {}) {
  const result = await admin.publishSchoolEvent({ requestId: token, ...valid(extra) });
  assert.equal(result.ok, true, result.message);
  return result.event.eventId;
}

/**
 * 把一个空间客户端装到 association-space.forScope 上跑一段——装载器会自己调
 * forScope，这里替掉门面即可（跑完恢复）。与 school-profile-view.test.js 同路数。
 */
async function asSpace(repo, opts, run) {
  const orig = assocSpace.forScope;
  assocSpace.forScope = () => spaceClient(repo, opts);
  try {
    return await run();
  } finally {
    assocSpace.forScope = orig;
  }
}

/** 让一组会员各自报名。 */
async function signUpAll(repo, eventId, actorIds, opts = {}) {
  for (const actor of actorIds) {
    const result = await spaceClient(repo, { ...opts, actor }).signUpSchoolEvent({ eventId });
    assert.equal(result.ok, true, result.message);
  }
}

/* ============================================================
 * 单打
 * ============================================================ */

test('单打详情：抽签后带签表与种子，能力旗标照服务端落位', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.found, true);
  assert.equal(detail.event.isSignup, true, '抽签不改报名状态');
  assert.equal(detail.event.drawn, true);
  // 能力来自服务端 capabilities：报名阶段管理员可重抽、可开赛、不可录名次
  assert.equal(detail.event.canDraw, true);
  assert.equal(detail.event.canStart, true);
  assert.equal(detail.event.canFinish, false);
  assert.equal(detail.event.canPin, true, '置顶入口按 canManage 推');
  assert.match(detail.drawText, /2 个签位/);
  assert.equal(detail.event.signupCount, 2);
  assert.equal(detail.event.quotaText, '2 人');
  assert.deepEqual(detail.resultRows, [], '未结束无名次');

  assert.equal(detail.bracketRows.length, 1, '两人单败只排一场首轮（即决赛）');
  assert.equal(detail.bracketRows[0].roundText, '决赛');
  assert.equal(detail.bracketRows[0].groupText, '');
  assert.equal(detail.seedCandidates.length, 2, '种子候选即有效报名者');
});

test('单打详情：开赛后名单行给代签、签表行按服务端给录分/确认', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const asAdmin = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(asAdmin.event.isOngoing, true);
  assert.equal(asAdmin.event.canStart, false, '已开赛不能再开');
  assert.equal(asAdmin.event.canDraw, false, '已开赛不能再抽');
  assert.equal(asAdmin.event.canFinish, true);
  assert.ok(asAdmin.signupRows.every(row => row.canCheckIn === true), '进行中管理员可代签');
  assert.equal(asAdmin.bracketRows[0].canRecord, true, '待录分的场次，管理员可录分');

  // 换成普通会员看同一页：能力全部收回，代签不给
  const asMember = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  assert.equal(asMember.event.canFinish, false);
  assert.equal(asMember.event.canCheckIn, false);
  assert.ok(asMember.signupRows.every(row => row.canCheckIn === false), '普通会员不能代签');
});

test('单打详情：isMe 只落在本人那几行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  const mine = detail.signupRows.filter(row => row.isMe).map(row => row.userId);
  assert.deepEqual(mine, ['demo_muc_member']);
  assert.equal(detail.event.signedUp, true);
  assert.equal(detail.event.mySignupLabel, '已报名');

  // 访客（无 actorId）不该有任何人被标成「我」
  const guest = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: null }));
  assert.equal(guest.signupRows.some(row => row.isMe), false);
});

/* ============================================================
 * 双打
 * ============================================================ */

test('双打：签表两边显示两人，名次页按队伍成行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1', {
    matchType: MATCH_TYPE.DOUBLES, seedMode: 'elo', seedCount: 2,
  });
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.event.isDoubles, true);
  assert.equal(detail.seedUnit, '位参赛者', '双打点的是参赛者，不是种子组');
  assert.equal(detail.bracketRows.length, 1, '四人为两队，单败一场决赛');
  assert.equal(detail.bracketRows[0].teamAText.includes('、'), true, '一边两人，名字用顿号相连');
  assert.equal(detail.bracketRows[0].teamBText.includes('、'), true);

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.allowed, true);
  assert.equal(placement.rows.length, 2, '一行一支队伍');
  assert.ok(placement.rows.every(row => Array.isArray(row.userIds) && row.userIds.length === 2));
  assert.ok(placement.rows.every(row => row.nickName.includes('、')));
  assert.match(placement.bronzeHint, /两组/, '双打量词跟着换');
});

/* ============================================================
 * 分组赛与淘汰赛
 * ============================================================ */

test('分组赛：积分表按组、签表行带组名、名次提示走推导口径', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1', {
    format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2, advancePerGroup: 2,
  });
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.standings.length, 2, '两组各一张积分表');
  assert.ok(detail.standings.every(group => group.rows.length === 2));
  assert.equal(detail.standings[0].groupLabel, 'A 组');
  assert.equal(detail.hasStandings, true);

  const groupRow = detail.bracketRows.find(row => row.groupText);
  assert.ok(groupRow, '小组赛的比赛带组名');
  assert.ok(['A 组', 'B 组'].includes(groupRow.groupText));

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.allowed, true);
  assert.equal(placement.hasRows, true);
  assert.match(placement.hintText, /抽签|打完|自动排名/, '未打完时给出可读的提示');
});

test('淘汰赛：四人单败首轮叫半决赛，确认后补出决赛行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const first = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(first.bracketRows.length, 2, '4 人单败首轮两场');
  assert.ok(first.bracketRows.every(row => row.roundText === '半决赛'));

  // 两场都确认后，签表推进补出决赛
  for (const matchId of drawn.matchIds) {
    const doc = await repo.matches.getById(matchId);
    await repo.matches.set(matchId, { ...doc, scoreA: [11], scoreB: [9], winner: 'A', recorder: 'demo_muc_admin' });
    const confirmed = await admin.confirmSchoolMatch({ matchId });
    assert.equal(confirmed.ok, true, confirmed.message);
  }

  const second = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(second.bracketRows.length, 3, '首轮打完后补出决赛');
  const final = second.bracketRows.find(row => row.roundText === '决赛');
  assert.ok(final, '决赛已排');
  assert.equal(final.scoreText, '', '刚补出的决赛还没有比分');
  assert.equal(final.winnerSide, '');
});

/* ============================================================
 * 列表与失败关闭
 * ============================================================ */

test('列表：本协会赛事按服务端次序下发，跨校 / 跨协会为空', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  await publish(admin, 'r1');
  await publish(admin, 'r2', { title: '第二场赛事' });

  const list = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(list.hasEvents, true);
  assert.equal(list.events.length, 2);
  assert.equal(list.canPublish, true);
  assert.equal(list.eventTotal, 2);
  assert.ok(list.events.every(row => row.canPin === true), '列表行只带置顶能力');
  assert.ok(list.events.every(row => typeof row.title === 'string' && row.title));

  // 北航管理员管的是北航自己的 pkb 空间，那边一场没有 → 列表为空
  const buaaList = await asSpace(repo, { actor: 'demo_buaa_admin', schoolId: 'buaa' }, () =>
    view.loadSchoolEventListView({ schoolId: 'buaa', association: 'pkb', actorId: 'demo_buaa_admin' }));
  assert.equal(buaaList.hasEvents, false);
  assert.equal(buaaList.eventTotal, 0);

  // 民大另一协会（乒乓）也看不到 pkb 的赛事
  const ttList = await asSpace(repo, { actor: 'demo_muc_member', association: 'tt' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'tt', actorId: 'demo_muc_member' }));
  assert.equal(ttList.hasEvents, false, '本校外协会看不到');
});

test('名次页失败关闭：普通会员被挡，管理员放行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const blocked = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.rows, [], '没有管理权就一条名单都不下发');
  assert.match(blocked.blockedText, /没有录入名次的权限/);

  const allowed = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.found, true);
  assert.equal(allowed.canEdit, true, '进行中可录名次');
  assert.equal(allowed.rows.length, 2);
});

test('详情：赛事不存在时给出与旧栈同形的空视图', async () => {
  const repo = fixture();
  const missing = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView('x_muc_pkb_missing', { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(missing.found, false);
  assert.equal(missing.event, null);
  assert.deepEqual(missing.bracketRows, []);
  assert.equal(missing.notFoundText, '这场赛事不存在或已被删除');
});

/* ============================================================
 * 纯适配单测
 * ============================================================ */

test('全量列表装载器：连续取完超过 50 场的 S2 分页', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  for (let i = 0; i < 52; i += 1) await publish(admin, `list_${i}`);
  const result = await asSpace(repo, {}, () => view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', limit: Infinity }));
  assert.equal(result.events.length, 52);
  assert.equal(new Set(result.events.map(row => row.id)).size, 52);
});

test('纯适配：DTO 形状翻译与权限注入', () => {
  const event = view.toLegacyEvent({ eventId: 'e1', isDoubles: true, drawn: true });
  assert.equal(event._id, 'e1');
  assert.equal(event.pool, 'doubles');
  assert.equal(Boolean(event.draw), true, '列表只有 drawn，补一个真值占位');

  const matches = view.toLegacyMatches([{ matchId: 'm1', eventId: 'e1' }]);
  assert.equal(matches[0]._id, 'm1');

  const signups = view.signupsFromSummary(
    { signupCount: 2, mySignup: { status: 1, signTime: 't' } }, 'me');
  assert.equal(signups.length, 2, '本人一条 + 占位一条凑足计数');
  assert.equal(signups[0].userId, 'me');
  assert.equal(signups[0].status, 1);
  assert.equal(signups[1].userId, undefined, '占位条目不冒充任何人');

  // 本人已取消：不计入有效人数，但本人那一条要留着显示「已取消」
  const canceled = view.signupsFromSummary({ signupCount: 1, mySignup: { status: 0 } }, 'me');
  assert.equal(canceled.length, 2);
  assert.equal(canceled.filter(row => row.status !== 0).length, 1);

  const caps = view.capsForEvent({ canManage: true, capabilities: { canSignUp: false, canDraw: true } });
  assert.deepEqual(caps, { canSignUp: false, canDraw: true, canPin: true });
});

/* ============================================================
 * 路由编号编码兼容（2026-10-16 实测：开发者工具把 query 原样透传）
 * ============================================================ */

test('路由编号兼容：未解码的 query（%3A 形式）也能打开详情，真不存在仍是 notFound', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_enc');
  const encoded = encodeURIComponent(eventId);
  assert.notStrictEqual(encoded, eventId, '前提：S2 编号含需要编码的字符（冒号）');

  // 开发者工具 / 真机：query 原样透传（仍是编码串）
  const viaEncoded = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(encoded, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(viaEncoded.found, true, '未解码的 query 也要查得到');
  assert.equal(viaEncoded.event.id, eventId, '命中的是解码后的真实编号');

  // 测试替身 / 已解码环境：原值照旧
  const viaPlain = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(viaPlain.found, true, '已解码环境照旧');
  assert.match(viaEncoded.notFoundText + viaPlain.notFoundText, /^$/);

  // 真正不存在的编号：仍然是「不存在」，不会因为探测而变成别的话术
  const missing = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView('sev%3Amuc%3Apkb%3Anope', { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(missing.found, false);
  assert.match(missing.notFoundText, /不存在/);
});

test('名次录入页同样兼容未解码的编号', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_enc2');

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(encodeURIComponent(eventId),
      { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.found, true, '名次页也要认编码过的编号');
});

/* ============================================================
 * 写路径的路由编号（2026-10-16 用户实测：点「报名」显示「赛事不存在」）
 * ============================================================
 * 读路径早就做了候选探测，写路径没有：页面拿着路由原值（开发者工具里是
 * `%3A` 形式）去报名 / 开赛 / 抽签，服务端按主键查不到 → 「赛事不存在」。
 * 修法是装载器把命中的真实编号回传给页面，页面采纳后再读写。
 */

test('装载器回传真实编号：页面拿它去报名成功，拿路由原值去写会被服务端判「赛事不存在」', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_route');
  const encoded = encodeURIComponent(eventId);
  assert.notStrictEqual(encoded, eventId, '前提：编号里有需要编码的字符');

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(encoded, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.eventId, eventId, '详情装载器必须回传解析后的真实编号');

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(encoded, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.eventId, eventId, '名次页装载器同样回传真实编号');

  // 页面采纳回传的编号之后，报名这一步真的能落库
  const member = spaceClient(repo, { actor: 'demo_muc_member' });
  const signed = await member.signUpSchoolEvent({ eventId: detail.eventId });
  assert.equal(signed.ok, true, signed.message);
  assert.equal(signed.event.signupCount, 1, '人数随报名加一');

  // 对照：未解码的编号直接写，就是用户看到的那句话（回归的靶子）
  const naive = await spaceClient(repo, { actor: 'demo_muc_member_2' })
    .signUpSchoolEvent({ eventId: encoded });
  assert.equal(naive.ok, false);
  assert.match(naive.message, /赛事不存在/);
});

test('装载器回传真实编号：名次页提交（结束赛事）也落在同一场赛事上', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_route2', { seedCount: 2 });
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(encodeURIComponent(eventId),
      { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.eventId, eventId);
  assert.equal(placement.canEdit, true);

  const finished = await admin.finishSchoolEvent({
    eventId: placement.eventId,
    results: placement.rows.map((row, index) => ({ userId: row.userId, placement: index + 1 })),
  });
  assert.equal(finished.ok, true, finished.message);
  assert.equal((await admin.getSchoolEvent({ eventId })).event.isFinished, true);
});

/* ============================================================
 * 人数与姓名以台账/档案为准（用户实测：已结束赛事显示 0 人、名次显示编号）
 * ============================================================ */

/** 一份「只有名次、没有报名记录」的历史赛事台账（早期导入 / 演示数据的形态）。 */
function legacyFinishedRepo() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  // 名次上的第二位会员：夹具里另外补一位在册会员，昵称一眼能认出不是编号
  seed.users.push({ _id: 'demo_muc_member_2', openId: 'mock_openid_muc_member_2',
    nickName: '民大模拟会员二', gender: 'M', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: 'muc', simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_member_2', 'muc'),
    userId: 'demo_muc_member_2', schoolId: 'muc', collegeId: 'c01',
    studentId: 'TEST003', status: 'active', simulated: true });
  seed.events = [{
    _id: 'sev:muc:pkb:legacy-cup', schoolId: 'muc', association: 'pkb',
    title: '历史杯男单赛', description: '', matchType: MATCH_TYPE.SINGLES, level: 3,
    format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: 'tied', seedMode: 'elo', seedCount: 2,
    location: '体育馆', startTime: '2026-05-01T09:00:00.000Z', publishTime: '2026-04-20T09:00:00.000Z',
    courtCount: 2, quota: 16, status: 2, pinned: false, draw: null, signupCount: 0,
    results: [
      { userId: 'demo_muc_member', placement: 1 },
      { userId: 'demo_muc_member_2', placement: 2 },
    ],
    revision: 1, updatedAt: '2026-05-01T18:00:00.000Z',
  }];
  return createSchoolMemoryRepo(seed);
}

test('人数真值：台账与名次都在、主记录计数是 0 时，展示真实人数而不是 0 人', async () => {
  const repo = legacyFinishedRepo();
  const admin = spaceClient(repo);

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView('sev:muc:pkb:legacy-cup',
      { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.found, true);
  assert.equal(detail.event.isFinished, true);
  assert.equal(detail.event.signupCount, 2, '名次上的两个人是实打实参加过的');
  assert.equal(detail.event.quotaText, '2/16 人', '列表行上的「几人」不能再是 0');

  const list = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  const row = list.events.find(item => item.id === 'sev:muc:pkb:legacy-cup');
  assert.ok(row, '这场赛事在列表里');
  assert.equal(row.quotaText, '2/16 人');
});

test('名次姓名：没有报名名单也能按会员档案解析出姓名，不退化成编号', async () => {
  const repo = legacyFinishedRepo();
  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(encodeURIComponent('sev:muc:pkb:legacy-cup'),
      { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));

  assert.deepEqual(detail.resultRows.map(row => row.userId), ['demo_muc_member', 'demo_muc_member_2']);
  assert.deepEqual(detail.resultRows.map(row => row.nickName), ['民大模拟会员', '民大模拟会员二']);
  assert.ok(detail.resultRows.every(row => row.nickName !== row.userId), '名次行不能显示成编号');
  assert.equal(detail.resultRows[0].placementText, '冠军');
  assert.equal(detail.resultRows[0].medal, 'gold');
});

test('人数真值：台账有记录时以台账为准，主记录计数偏大也不虚报', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_count', { quota: 8 });
  await signUpAll(repo, eventId, ['demo_muc_member']);

  // 手工把主记录计数改大，模拟「计数与台账分叉」的历史数据
  await repo.transaction(async (tx) => {
    const doc = await tx.events.getById(eventId);
    await tx.events.set(eventId, { ...doc, signupCount: 7 });
  });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.event.signupCount, 1, '台账里只有一个有效报名');
  assert.equal(detail.event.quotaText, '1/8 人');
  assert.equal(detail.signupRows.length, 1);
});

/* ============================================================
 * 旧栈 loadEventDetailView 三个端到端场景的 S2 对应
 * ------------------------------------------------------------
 * P10 合并批第 9 子批要先建这三段覆盖，才能删掉旧装载器：
 *   · 打三四名模式下逐轮推进（旧：赛事详情 —— 抽签后签表随详情下发）
 *   · 驳回后重抽，签位回到待确认（旧：首轮某场被驳回后重抽）
 *   · 手工指定种子的候选名单与需凑齐的人数（旧：手工指定种子）
 * 外加 tests/court-assign.test.js 里那条「视图模型带出场地数与场地分配表」。
 * ============================================================ */

test('打三四名：首轮打完同时补出决赛与季军赛', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_bronze', {
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF, courtCount: 2,
  });
  await signUpAll(repo, eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  await admin.startSchoolEvent({ eventId });

  for (const matchId of drawn.matchIds) {
    const doc = await repo.matches.getById(matchId);
    await repo.matches.set(matchId, {
      ...doc, scoreA: [11], scoreB: [9], winner: 'A', recorder: 'demo_muc_admin',
    });
    const confirmed = await admin.confirmSchoolMatch({ matchId });
    assert.equal(confirmed.ok, true, confirmed.message);
  }

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.bracketRows.length, 4, '两场半决赛 + 决赛 + 季军赛');
  const texts = detail.bracketRows.map(row => row.roundText);
  assert.equal(texts.filter(text => text === '半决赛').length, 2);
  assert.equal(texts.filter(text => text === '决赛').length, 1);
  assert.equal(texts.filter(text => text === '季军赛').length, 1,
    '打三四名模式下必须排出季军赛，否则季军要凭空造');
});

test('重抽：被驳回的签位回到待确认，不再卡在已撤销', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_redraw');
  await signUpAll(repo, eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);

  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  const target = drawn.matchIds[0];

  // 某一签位被对手驳回：比赛记录上压一条 REVOKED 改判
  const doc = await repo.matches.getById(target);
  const rejected = await call(repo, 'rejectSchoolMatch',
    { matchId: target, reason: '比分记错了' }, doc.teamB[0]);
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal((await repo.matches.getById(target)).status, MATCH_STATUS.REVOKED);

  // 再抽一次：编号是确定的，会落到同一个 _id 上
  const redrawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  assert.equal(redrawn.ok, true, redrawn.message);
  assert.equal((await repo.matches.getById(target)).status, MATCH_STATUS.PENDING,
    '重抽清掉旧改判，该签位回到待确认，而不是永远卡在已撤销');
});

test('手工种子：下发候选人名单与需凑齐的人数，没点名不许抽', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_manual', { seedMode: SEED_MODE.MANUAL, seedCount: 4 });
  const players = ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3'];
  await signUpAll(repo, eventId, players);

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.event.isManualSeed, true, '手工指定的赛事要能被界面认出来');
  assert.equal(detail.seedCandidates.length, 3, '候选名单就是有效报名者');
  assert.equal(detail.manualSeedNeeded, 3,
    '选定 4 位种子但只有 3 人参赛，只需点 3 位（与抽签算法同一口径）');
  assert.equal(detail.seedUnit, '位种子');
  for (const candidate of detail.seedCandidates) {
    assert.ok(players.includes(candidate.userId));
    assert.ok(candidate.nickName, '候选人要有名字可点');
  }

  // 没点名就抽：算法必须拒绝，而不是悄悄按报名顺序顶上
  const refused = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /请指定 3 位种子/);

  // 点名的顺序就是种子顺序，不是等级分顺序
  const manualOrder = [players[2], players[1], players[0]];
  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42, manualOrder });
  assert.equal(drawn.ok, true, drawn.message);
  assert.deepEqual(drawn.draw.seeds.slice().sort(), manualOrder.slice().sort(),
    '抽签落库的种子应与点名的那几位一致');
});

test('场地看板：详情带出场地数与按场地分组的分配表', async () => {
  const repo = fixture(4);
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_court', { courtCount: 4 });
  const players = ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4',
    'demo_muc_player_1', 'demo_muc_player_2', 'demo_muc_player_3', 'demo_muc_player_4'];
  await signUpAll(repo, eventId, players);
  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.matchIds.length, 4, '8 人 8 签，首轮四场');
  await admin.startSchoolEvent({ eventId });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.event.courtCountText, '4 块场地');
  assert.equal(detail.hasCourts, true);
  assert.deepEqual(detail.courtBoard.map(group => group.courtText),
    ['1 号场', '2 号场', '3 号场', '4 号场'],
    '首轮四场各占一块，四块场地都该出现在分配表里');
  detail.courtBoard.forEach(group => {
    assert.equal(group.rows.length, 1, `${group.courtText} 首轮只该有一场`);
    assert.ok(group.rows[0].teamAText, '分配表里的对阵要带上队名');
  });
});

/* ============================================================
 * 旧栈 loadEventsView 置顶与积分端到端的 S2 对应
 * ------------------------------------------------------------
 * 旧栈两条用例守的组合行为，S2 此前只有散件覆盖（写路径的置顶测试、
 * 列表行的 canPin 测试、纯函数的积分规则），组合链没人守：
 *   · 管理员置顶后该赛事排到列表最前，普通会员无权置顶；
 *   · 赛事名次结束后积分进入会员统计：参赛的有分、没参赛的一分不动。
 * ============================================================ */

test('置顶端到端：管理员置顶后该赛事排到列表最前，普通会员无权置顶', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  // 服务端排序：置顶优先，其次状态，同状态按开赛时间倒序——
  // 所以默认情况下晚发布（开赛更晚）的 r2 排前面，置顶 r1 才能看出被提到最前。
  const earlier = await publish(admin, 'r_pin_earlier');
  const later = await publish(admin, 'r_pin_later', { startTime: new Date(NOW.getTime() + 2 * DAY).toISOString() });

  const before = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(before.events[0].id, later, '未置顶时晚开赛的排前面');
  assert.equal(before.events[0].pinned, false);

  const denied = await call(repo, 'setSchoolEventPinned', { eventId: earlier, pinned: true }, 'demo_muc_member');
  assert.equal(denied.ok, false, '普通会员不能置顶');
  assert.match(denied.message, /没有管理赛事的权限/);

  const done = await call(repo, 'setSchoolEventPinned', { eventId: earlier, pinned: true });
  assert.equal(done.ok, true, done.message);

  const adminView = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(adminView.events[0].id, earlier, '置顶的赛事排到最前');
  assert.equal(adminView.events[0].pinned, true);
  assert.equal(adminView.events[0].canPin, true, '管理员看得到置顶开关');

  // 普通会员看同一份列表：置顶标记照旧可见，但拿不到置顶开关
  const memberView = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  assert.equal(memberView.events[0].id, earlier);
  assert.equal(memberView.events[0].pinned, true);
  assert.equal(memberView.events[0].canPin, false, '普通会员拿不到置顶开关');
});

test('名次积分端到端：结束后参赛者积分上涨、没参赛的一分不动', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_points');
  const players = ['demo_muc_member', 'demo_muc_member_2'];
  await signUpAll(repo, eventId, players);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const statsOf = async userIds => {
    const result = await call(repo, 'getSchoolMemberStats', { userIds });
    assert.equal(result.ok, true, result.message);
    return Object.fromEntries(result.members.map(row => [row.userId, row]));
  };

  const outsider = 'demo_muc_member_3';
  const before = await statsOf([...players, outsider]);

  const finished = await admin.finishSchoolEvent({
    eventId,
    results: [
      { userId: 'demo_muc_member', placement: 1 },
      { userId: 'demo_muc_member_2', placement: 2 },
    ],
  });
  assert.equal(finished.ok, true, finished.message);

  const after = await statsOf([...players, outsider]);
  const delta = userId => Number(after[userId].points) - Number(before[userId].points);
  const championDelta = delta('demo_muc_member');
  assert.ok(Number.isInteger(championDelta), '积分是整数（名次分 + 参与分，不出现零头）');
  assert.ok(championDelta >= 2, `冠军至少拿 2 分参与分（实测 +${championDelta}）`);
  assert.ok(delta('demo_muc_member_2') >= 2, '亚军也至少拿参与分');
  assert.ok(championDelta > delta('demo_muc_member_2'), '同一赛事里名次越靠前分越多');
  assert.equal(delta(outsider), 0, '没参赛的人积分一分不动');
});
