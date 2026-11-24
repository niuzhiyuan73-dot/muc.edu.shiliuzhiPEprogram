/**
 * 学校维度演示内容（公告 / 赛事 / 比赛 / 报名）自检（迁移清单 C）
 * ============================================================
 * schoolMock.reset() 默认给多个「学校 + 协会」范围摆上演示内容，协会空间与排行榜
 * 一进去就有东西可看，不必先手工发几条。这里守四件事：
 *   1. 每个范围的内容都绑定自己的范围，且是被服务读得出来的完整记录（不是半截）；
 *   2. 三层差异性（2026-10-16 扩充）：协会之间的公告条数 / 标题不同、跨校各有各的
 *      内容、不同演示账号战绩不同——切了范围或身份，看到的东西确实不一样；
 *   3. reset({ withDemoContent: false }) 能把内容关干净——公告页那类
 *      「自己摆几条再数条数」的用例全靠它，否则条数会随演示内容的多寡漂移；
 *   4. 报名与赛事自洽（2026-10-16 修复「已结束的赛事显示 0 人 / 名次显示编号」）：
 *      每场赛事的 signupCount 等于有效报名条数；已结束赛事的报名记录与名次同源，
 *      名次里的每个人都能在名单里查到姓名。
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchoolDemoContent, DEMO_CONTENT_SPECS, DEMO_ACCOUNTS,
} = require('../miniprogram/services/school-seed.js');
const { MEMBER_SEED } = require('../miniprogram/services/seed.js');
const { isAnnouncementDoc } = require('../src/server/services/school-announcement-service.js');
const { isEventDoc } = require('../src/server/services/school-event-service.js');
const {
  loadSchoolEventDetailView, loadSchoolEventPlacementView,
} = require('../miniprogram/services/school-event-view.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const { schoolEventSignupKey } = require('../src/shared/utils/school.js');
const {
  MATCH_STATUS, MATCH_OUTCOME, MATCH_COMPETITION, RANK_PROJECT,
  EVENT_STATUS, SIGNUP_STATUS,
} = require('../src/shared/utils/constants.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/** 旧种子账号的编号（u01 … u24），与 school-mock 的 attachLegacyMembers 同口径。 */
const legacyIds = () => MEMBER_SEED.map((_, index) => `u${String(index + 1).padStart(2, '0')}`);

/** 演示内容里允许出现的会员：两校演示账号 + 旧种子会员 + 学院负责人演示身份。 */
function knownMemberIds() {
  return new Set([
    ...DEMO_ACCOUNTS.map(account => account.id),
    ...legacyIds(),
    // 由 school-mock 补进种子（不在 DEMO_ACCOUNTS 里），演示数据不许写到这之外的人头上
    'demo_muc_college_leader',
  ]);
}

/** 某范围的内容片（与 createSchoolDemoContent 的切法一致）。 */
function contentOf(schoolId, association) {
  const content = createSchoolDemoContent();
  const inScope = doc => doc.schoolId === schoolId && doc.association === association;
  return {
    announcements: content.announcements.filter(inScope),
    events: content.events.filter(inScope),
    matches: content.matches.filter(inScope),
    eventSignups: content.eventSignups.filter(inScope),
  };
}

/* ============================================================
 * 一、纯形状：每批记录都绑定自己的范围，形状可被服务读出来
 * ============================================================ */

test('演示内容 —— 每个范围的记录都绑定自己的「学校 + 协会」，形状可被服务读出来', () => {
  const content = createSchoolDemoContent();

  // 公告 2026-10-18 起是学校级一条通道：民大 5 条 + 北航 4 条（不再按协会各造一份）
  assert.equal(content.announcements.length, 9);
  // 2026-10-20 扩容：每个球拍项目的赛事与流水补到 3 倍（民大），网球从 0 补齐
  assert.equal(content.events.length, 24);
  assert.equal(content.matches.length, 113);
  // 报名记录条数也是契约：改了要同步 docs/mock演示账号.md §7.1 与本节断言
  assert.equal(content.eventSignups.length, 96);

  assert.ok(content.announcements.every(doc => isAnnouncementDoc(doc)), '公告形状不完整');
  assert.ok(content.events.every(doc => isEventDoc(doc)), '赛事形状不完整');
  assert.ok(content.matches.every(doc => doc.status === MATCH_STATUS.ACTIVE
    && doc.outcome === MATCH_OUTCOME.NORMAL
    && doc.competition === MATCH_COMPETITION.PERSONAL), '比赛形状不是「已生效的个人赛」');

  // 每条记录都能在规格表里找到自己的范围
  const scopes = new Set(DEMO_CONTENT_SPECS.map(spec => `${spec.schoolId}/${spec.association}`));
  const scoped = doc => scopes.has(`${doc.schoolId}/${doc.association}`);
  assert.ok(content.announcements.every(scoped), '公告必须绑定规格表里的范围');
  assert.ok(content.events.every(scoped), '赛事必须绑定规格表里的范围');
  assert.ok(content.matches.every(scoped), '比赛必须绑定规格表里的范围');
  assert.ok(content.eventSignups.every(scoped), '报名记录必须绑定规格表里的范围');
  assert.ok(scoped(content.announcements[0]) && content.announcements.some(doc =>
    doc.schoolId === 'buaa'), '跨校内容也要有（切到北航不是空态）');

  const ids = [...content.announcements, ...content.events, ...content.matches, ...content.eventSignups]
    .map(doc => doc._id);
  assert.equal(new Set(ids).size, ids.length, '演示记录编号必须唯一');
});

test('演示报名 —— 主键由「范围 + 赛事 + 会员」组成，只能写给存在的会员', () => {
  const content = createSchoolDemoContent();
  const eventIds = new Set(content.events.map(doc => doc._id));
  const known = knownMemberIds();

  for (const doc of content.eventSignups) {
    assert.ok(eventIds.has(doc.eventId), `报名记录必须挂在演示赛事上：${doc._id}`);
    assert.ok(known.has(doc.userId), `报名记录只能写给存在的会员：${doc.userId}`);
    // 主键由 schoolEventSignupKey 组成：同一人同一赛事恒一条，跨范围伪造不出编号
    assert.equal(doc._id, schoolEventSignupKey(doc.eventId, doc.userId, doc));
    assert.equal(doc.status, SIGNUP_STATUS.SIGNED, '演示报名一律落「已报名」');
    assert.equal(doc.actorId, doc.userId, '演示报名都是本人报的');
    assert.equal(doc.checkInTime, null);
    assert.equal(doc.cancelTime, null);
    assert.equal(doc.revision, 1);
    assert.ok(Number.isFinite(Date.parse(doc.signTime)), `报名时间必须可复现：${doc.signTime}`);
  }
});

test('演示报名 —— signupCount 就是有效报名条数，已结束赛事的名单覆盖名次', () => {
  const content = createSchoolDemoContent();
  const rosterOf = eventId => content.eventSignups
    .filter(doc => doc.eventId === eventId && doc.status !== SIGNUP_STATUS.CANCELED)
    .map(doc => doc.userId);

  for (const doc of content.events) {
    assert.equal(doc.signupCount, rosterOf(doc._id).length,
      `${doc.title} 的 signupCount 与报名记录条数不一致`);
  }

  // 已结束的赛事：名次里出现的每个人都必须报过名，人数就是名次人数
  // ——少了这条链，详情页与名次页取不到会员档案，只能回退显示编号
  const finished = content.events.filter(doc => doc.status === EVENT_STATUS.FINISHED);
  assert.ok(finished.length > 0, '演示内容里应有已结束的赛事');
  for (const doc of finished) {
    const roster = rosterOf(doc._id);
    assert.ok(doc.signupCount > 0, `${doc.title} 已结束却一个报名记录都没有`);
    assert.equal(doc.signupCount, doc.results.length, `${doc.title} 的报名人数应等于名次人数`);
    for (const result of doc.results) {
      assert.ok(roster.includes(result.userId), `${doc.title} 的名次里 ${result.userId} 没有报名记录`);
    }
  }

  // 报名中的赛事：给 2～6 人，且不给 u01 / u02 写报名
  // （它们在旧种子里是管理员 / 学院负责人，报了名会改掉别的演示身份看到的「我报没报」）
  const signupEvents = content.events.filter(doc => doc.status === EVENT_STATUS.SIGNUP);
  assert.ok(signupEvents.length > 0, '演示内容里应有报名中的赛事');
  for (const doc of signupEvents) {
    const roster = rosterOf(doc._id);
    assert.ok(roster.length >= 2 && roster.length <= 6, `${doc.title} 的报名人数应在 2～6 之间`);
    assert.ok(!roster.includes('u01') && !roster.includes('u02'), `${doc.title} 不该给 u01 / u02 写报名`);
  }
});

test('差异性 —— 公告按学校一份，赛事与比赛按协会不同，跨校内容也不同', () => {
  const pkb = contentOf('muc', 'pkb');
  const tt = contentOf('muc', 'tt');
  const bd = contentOf('muc', 'bd');
  const buaa = contentOf('buaa', 'pkb');

  // 公告归学校：种子里只造一份（muc/pkb 这个桶），tt / bd 不再各自一份。
  // 「换协会读到的仍是同一份」由服务端学校级读取保证，见 school-announcement-view 测试。
  assert.equal(pkb.announcements.length, 5, '民大 5 条');
  assert.deepEqual([tt.announcements.length, bd.announcements.length], [0, 0], '公告不再按协会分桶');
  // 3 倍口径：匹克球 3→9、乒乓 2→6、羽球 1→3；网球原先 0，按同量级补到 3
  assert.deepEqual([pkb.events.length, tt.events.length, bd.events.length,
    contentOf('muc', 'tn').events.length], [9, 6, 3, 3]);

  // 公告标题不重复：一条公告只有一条，不会因为多个协会而重复出现
  const titles = pkb.announcements.map(doc => doc.title);
  assert.equal(new Set(titles).size, titles.length, '公告标题不能重复');

  // 跨校：北航有自己的整套内容，且与民大不重名
  assert.equal(buaa.announcements.length, 4);
  assert.equal(buaa.events.length, 2);
  assert.equal(buaa.matches.length, 8);
  const crossTitles = [...pkb.announcements, ...buaa.announcements].map(doc => doc.title);
  assert.equal(new Set(crossTitles).size, crossTitles.length, '跨校公告标题不能重复');

  // 报名记录同样是「各范围各一份」：条数与 docs/mock演示账号.md §7.1 的规模表同源
  assert.deepEqual([
    pkb.eventSignups.length, tt.eventSignups.length, bd.eventSignups.length,
    buaa.eventSignups.length, contentOf('buaa', 'tt').eventSignups.length,
    contentOf('muc', 'tn').eventSignups.length,
  ], [35, 24, 12, 8, 4, 13]);
});

/* ============================================================
 * 二、reset() 默认挂上演示内容
 * ============================================================ */

describe('schoolMock.reset() —— 默认挂上演示内容', () => {
  beforeEach(() => schoolMock.reset());

  test('协会空间能读到公告与赛事；三个榜单项目都有人', async () => {
    const api = schoolMock.forAssociationSpace(SCOPE);

    const ann = await api.listSchoolAnnouncements({});
    assert.equal(ann.ok, true);
    assert.equal(ann.announcements.length, 5);

    const events = await api.listSchoolEvents({});
    // 匹克球赛事 3→9（2026-10-20 扩容）
    assert.equal(events.events.length, 9);

    for (const project of [RANK_PROJECT.MEN_SINGLES, RANK_PROJECT.WOMEN_SINGLES, RANK_PROJECT.DOUBLES]) {
      const view = await api.getSchoolRanking({ project });
      assert.ok(view.rows.length > 0, `${project} 应有榜单行`);
      assert.equal(view.empty, false);
    }
  });

  test('默认身份（u06）出现在男单榜，带「我」的名次', async () => {
    assert.equal(schoolMock.getDemoActor(), 'u06', '默认演示身份应跟随 mock.js 的默认会员');
    const api = schoolMock.forAssociationSpace(SCOPE);
    const view = await api.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });

    assert.ok(view.rows.some(row => row.isMe), '默认会员应在男单榜上标出「我」');
    assert.ok(view.me && view.me.rank > 0);
  });

  test('别的协会读的是自己的榜单；公告是全校一份，两处读到的一样', async () => {
    const pkb = schoolMock.forAssociationSpace(SCOPE);
    const tt = schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'tt' });

    // 公告 2026-10-18 起是学校级一条通道：换协会不该换内容、也不该重复
    const pkbTitles = (await pkb.listSchoolAnnouncements({})).announcements.map(doc => doc.title);
    const ttTitles = (await tt.listSchoolAnnouncements({})).announcements.map(doc => doc.title);
    assert.deepEqual(ttTitles, pkbTitles, '同校两个协会读到同一份公告');
    assert.equal(new Set(ttTitles).size, ttTitles.length, '同一份公告不该重复出现');

    // 榜单按范围隔离：两个协会各有人，但榜单内容不是同一份
    // （同一个人可以同时是两个协会的会员，所以只守「各有自己的人」与「不是同一张榜」）
    const ttBoard = await tt.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });
    const pkbBoard = await pkb.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });
    const ttIds = ttBoard.rows.map(row => row.userId);
    const pkbIds = pkbBoard.rows.map(row => row.userId);

    assert.ok(ttIds.length > 0 && pkbIds.length > 0);
    assert.ok(ttIds.includes('u04'), 'u04 只在乒乓协会打过比赛，应出现在乒乓榜');
    assert.ok(!pkbIds.includes('u04'), 'u04 不在匹克球榜上（他只在乒乓协会有比赛）');
    assert.ok(pkbIds.includes('u03') && !ttIds.includes('u03'), 'u03 只在匹克球协会有比赛');
    assert.notDeepEqual(ttIds.slice().sort(), pkbIds.slice().sort(), '两张榜单不是同一份');
  });

  test('跨校：民大身份读不到北航内容，切到北航才看得到', async () => {
    // 当前身份 u06 是民大在册会员：读北航协会空间被拒（不是空内容，是没权限）
    const crossView = await schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' })
      .listSchoolAnnouncements({});
    assert.equal(crossView.ok, false);
    assert.match(crossView.message, /权限/);

    // 换成北航演示会员：读得到北航自己那套内容
    schoolMock.setDemoActor('demo_buaa_member');
    const ownView = await schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' })
      .listSchoolAnnouncements({});
    assert.equal(ownView.ok, true);
    assert.equal(ownView.announcements.length, 4);
    assert.ok(ownView.announcements.some(doc => doc.title.includes('北航')));
  });

  test('不同演示账号战绩不同（切身份数据跟着变）', async () => {
    const repoRead = async (userId) => {
      const api = schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' });
      const profile = await api.getSchoolMemberProfile({ userId });
      return profile.history.length;
    };
    schoolMock.setDemoActor('demo_buaa_member');
    const heavy = await repoRead('demo_buaa_member');
    const light = await repoRead('demo_buaa_college_leader');
    assert.ok(heavy > light, `同一协会里不同账号的场次应有差别（${heavy} vs ${light}）`);
  });

  test('报名人数与名次姓名都来自报名台账（不再是 0 人 / 编号）', async () => {
    const api = schoolMock.forAssociationSpace(SCOPE);
    const list = await api.listSchoolEvents({});

    // 已结束的赛事：列表人数是真实人数，quotaText 不再是 0/N 人
    const finished = list.events.find(row => row.isFinished);
    assert.ok(finished, '演示内容里有已结束的赛事');
    assert.equal(finished.signupCount, 4);
    assert.equal(finished.quotaText, '4/16 人');

    // 报名中的赛事同样是真实人数（条数由报名规格定，这里只守「与 DTO 一致、不为 0」）
    const open = list.events.find(row => row.isSignup);
    assert.ok(open && open.signupCount > 0, '报名中的赛事也应有人');
    assert.equal(open.quotaText, `${open.signupCount}/${open.quota} 人`);

    // 详情页的最终名次与报名名单：姓名来自会员档案，不再回退显示编号
    const names = new Map(MEMBER_SEED.map((item, index) =>
      [`u${String(index + 1).padStart(2, '0')}`, item.nickName]));
    const resultIds = ['u03', 'u05', 'u06', 'u07'];
    const detail = await loadSchoolEventDetailView(finished.eventId, { ...SCOPE, actorId: 'u06' });
    assert.equal(detail.found, true);
    assert.equal(detail.hasSignups, true, '已结束赛事的详情页应有报名名单');
    assert.deepEqual(detail.signupRows.map(row => row.userId).sort(), resultIds);
    assert.deepEqual(detail.signupRows.map(row => row.nickName), resultIds.map(id => names.get(id)));
    assert.deepEqual(detail.resultRows.map(row => row.nickName), resultIds.map(id => names.get(id)));

    // 名次录入页的名单同样有姓名（修复前是一条名单都没有的空名单）
    schoolMock.setDemoActor('demo_muc_admin');
    const placement = await loadSchoolEventPlacementView(finished.eventId,
      { ...SCOPE, actorId: 'demo_muc_admin' });
    assert.equal(placement.allowed, true);
    assert.equal(placement.found, true);
    assert.deepEqual(placement.rows.map(row => row.userId).sort(), resultIds);
    assert.deepEqual(placement.rows.map(row => row.nickName), resultIds.map(id => names.get(id)));
  });
});

/* ============================================================
 * 三、withDemoContent: false 能把内容关干净
 * ============================================================ */

describe('schoolMock.reset({ withDemoContent: false }) —— 关干净', () => {
  test('公告 / 赛事 / 榜单都为空，供「自己摆几条再数条数」的用例使用', async () => {
    schoolMock.reset({ withDemoContent: false });
    const api = schoolMock.forAssociationSpace(SCOPE);

    assert.equal((await api.listSchoolAnnouncements({})).announcements.length, 0);
    assert.equal((await api.listSchoolEvents({})).events.length, 0);
    assert.equal((await api.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES })).rows.length, 0);
  });
});
