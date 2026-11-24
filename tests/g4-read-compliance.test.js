/**
 * G4 核心（读写放大治理）+ 合规补齐专项测试（T-05）
 * ============================================================
 * 覆盖：
 *   1. 首页 BFF 聚合（loadSchoolHomeView 首屏云调用 <= 2 次，实测 1 次）与降级开关；
 *   2. readMatchPage 续页翻页跳过 2 次冗余 count 聚合；
 *   3. MAX_READ_ROWS=500 压测热路径（600 条规模下 0 越界、0 报错）；
 *   4. finishSchoolEvent 增量积分更新（0 次整表重读 + 未物化自动回退）；
 *   5. 精准缓存失效核查（录分不打穿全容器，账号注销触发全清）；
 *   6. 合规闭环：统一脱敏管道、UGC 内容安全拦截/放行、账号注销与数据删除闭环。
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runtime = require('../miniprogram/services/runtime-mode.js');
const schoolMock = require('../src/mock/school-mock.js');
const { loadSchoolHomeView } = require('../miniprogram/services/school-home-view.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { buildSchoolContext } = require('../src/server/services/school-context.js');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const { getSchoolHomeSummary } = require('../src/server/services/school-home-service.js');
const { listSchoolMatches } = require('../src/server/services/school-match-service.js');
const { finishSchoolEvent } = require('../src/server/services/school-event-service.js');
const { refreshAssociationPoints, isSettled, settledPointsOf } = require('../src/server/services/season-points.js');
const { aggregatePoints } = require('../src/server/services/school-points-service.js');
const { listAssociationNotices, publishAssociationNotice } = require('../src/server/services/association-notice-service.js');
const { listTrainings } = require('../src/server/services/association-training-service.js');
const { listAssociationGroups, getAssociationGroup, createAssociationGroup } = require('../src/server/services/association-group-service.js');
const { listTeamEvents } = require('../src/server/services/team-event-service.js');
const { listCollegeEntries, listCollegeTies } = require('../src/server/services/school-college-service.js');
const { publishSchoolAnnouncement } = require('../src/server/services/school-announcement-service.js');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request.js');
const contextCache = require('../cloudfunctions/data/lib/server/services/context-cache.js');
const {
  isPrivacyMaskEnabled, maskRealName, maskDisplayName, maskStudentId, sanitizePublicMember,
} = require('../src/shared/utils/privacy-mask.js');
const { setUgcChecker, resetUgcChecker, checkUgcContent } = require('../src/server/services/ugc-safety.js');
const {
  MATCH_STATUS, MATCH_TYPE, EVENT_STATUS, EVENT_LEVEL, EVENT_FORMAT, SIGNUP_STATUS,
  ANNOUNCEMENT_STATUS, ASSOCIATION_NOTICE_STATUS, GROUP_STATUS, TEAM_EVENT_STATUS,
  TRAINING_STATUS, COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS,
} = require('../src/shared/utils/constants.js');
const { scopeKey, schoolEventSignupKey, schoolMemberKey } = require('../src/shared/utils/school.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const ROOT = path.join(__dirname, '..');

beforeEach(() => {
  runtime.setDataSource('mock');
  schoolMock.reset();
  resetUgcChecker();
});

afterEach(() => {
  resetUgcChecker();
});

describe('1. 首页 BFF 聚合与降级开关', () => {
  test('loadSchoolHomeView 首屏仅发起 1 次 getSchoolHomeSummary 调用且数据完整', async () => {
    schoolMock.setDemoActor('u06');
    const calls = [];
    const baseIdentity = schoolMock.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
    const identityClient = {
      async getSchoolHomeSummary(payload) {
        calls.push(payload);
        return baseIdentity.getSchoolHomeSummary(payload);
      },
    };
    const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', identityClient });
    assert.equal(calls.length, 1, '首屏云调用应压至 1 次（<= 2 次门槛）');
    assert.equal(view.loggedIn, true);
    assert.ok(view.announcements.rows.length > 0);
    assert.equal(view.upcomingEvents.length, 3);
    assert.equal(view.summary.memberCount, 28);
    assert.equal(view.summary.seasonText, '第 1 赛季');

    // 对比降级回退模式（useBff: false）结果一致
    const fallbackView = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', useBff: false });
    assert.deepEqual(view.summary, fallbackView.summary);
    assert.equal(view.announcements.total, fallbackView.announcements.total);
    assert.deepEqual(
      view.upcomingEvents.map(row => row.id),
      fallbackView.upcomingEvents.map(row => row.id),
    );
  });

  test('游客与跨校只读走 BFF 仍保持原隐私边界（游客仅公告、跨校得空聚合）', async () => {
    schoolMock.setDemoActor('u06');
    const guestView = await loadSchoolHomeView({ schoolId: 'muc', viewerId: '' });
    assert.equal(guestView.loggedIn, false);
    assert.ok(guestView.announcements.rows.length > 0);
    assert.deepEqual(guestView.upcomingEvents, []);
    assert.equal(guestView.summary, null);

    schoolMock.setDemoActor('demo_muc_member');
    const crossView = await loadSchoolHomeView({ schoolId: 'buaa', viewerId: 'demo_muc_member' });
    assert.deepEqual(crossView.announcements.rows, []);
    assert.deepEqual(crossView.upcomingEvents, []);
    assert.equal(crossView.summary, null);
  });
});

describe('2. readMatchPage 续页翻页跳过冗余 count', () => {
  test('带 cursor 翻页时仅执行 1 次聚合查询，跳过 2 次 count', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      _id: `m_${String(i).padStart(3, '0')}`,
      ...SCOPE,
      teamA: ['u01'],
      teamB: ['u02'],
      matchType: MATCH_TYPE.SINGLES,
      status: MATCH_STATUS.PENDING,
      pool: 1,
      eventId: 'ev1',
      matchTime: `2026-10-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
      scoreA: [],
      scoreB: [],
    }));

    const aggCalls = [];
    const matchesCol = {
      aggregate() {
        const stages = [];
        const pipe = {
          match(w) { stages.push(['match', w]); return pipe; },
          sort(s) { stages.push(['sort', s]); return pipe; },
          skip(n) { stages.push(['skip', n]); return pipe; },
          limit(n) { stages.push(['limit', n]); return pipe; },
          count(f) { stages.push(['count', f]); return pipe; },
          async end() {
            aggCalls.push(stages);
            const hasCount = stages.some(([k]) => k === 'count');
            if (hasCount) return { list: [{ total: docs.length }] };
            return { list: docs.slice(0, 3) };
          },
        };
        return pipe;
      },
    };
    const db = {
      command: {},
      collection(name) {
        assert.equal(name, 'matches');
        return matchesCol;
      },
    };

    const query = createRepo(db).forScope(SCOPE).matches;
    const first = await query.listPage({ filter: {}, limit: 2 });
    assert.equal(aggCalls.length, 3, '首屏应执行 1 次分页 + 2 次 count');
    assert.equal(first.total, 10);

    aggCalls.length = 0;
    const second = await query.listPage({
      filter: {},
      limit: 2,
      cursor: { matchTime: docs[8].matchTime, id: docs[8]._id },
      skipCount: true,
    });
    assert.equal(aggCalls.length, 1, '带 cursor + skipCount 续页只应执行 1 次分页聚合');
    assert.equal(second.total, null);
    assert.equal(second.pendingCount, null);
    assert.equal(second.hasMore, true);
  });
});

describe('3. MAX_READ_ROWS=500 热路径压测', () => {
  test('在 MAX_READ_ROWS=500 严格限制下 600 条数据规模热路径全部 0 越界', () => {
    const script = `
      const assert = require('node:assert/strict');
      const { createSchoolDemoSeed } = require('./src/mock/school-seed.js');
      const { createSchoolMemoryRepo } = require('./src/mock/school-memory-repo.js');
      const { buildSchoolContext } = require('./src/server/services/school-context.js');
      const { buildMeetContext } = require('./src/server/services/meet-context.js');
      const { getSchoolHomeSummary } = require('./src/server/services/school-home-service.js');
      const { listSchoolMatches } = require('./src/server/services/school-match-service.js');
      const { listAssociationNotices } = require('./src/server/services/association-notice-service.js');
      const { listTrainings } = require('./src/server/services/association-training-service.js');
      const { listAssociationGroups, getAssociationGroup } = require('./src/server/services/association-group-service.js');
      const { listTeamEvents } = require('./src/server/services/team-event-service.js');
      const { listCollegeEntries, listCollegeTies } = require('./src/server/services/school-college-service.js');

      (async () => {
        const seed = createSchoolDemoSeed();
        for (const k of ['announcements', 'associationNotices', 'associationTrainings', 'associationGroups', 'associationGroupMembers', 'teamEvents', 'teamEventEntries', 'collegeEvents', 'collegeEntries', 'ties', 'matches']) {
          seed[k] = seed[k] || [];
        }
        const N = 600;
        const guard = (rows) => {
          if (rows.length > 500) throw new Error('MAX_READ_ROWS=500 越界：单次读 ' + rows.length);
          return rows;
        };
        for (let i = 0; i < N; i += 1) {
          const id = String(i).padStart(4, '0');
          seed.announcements.push({ _id: 'ann_' + id, schoolId: 'muc', association: 'pkb', title: '公告' + id, content: 'c', status: 'published', pinned: i === 0, publishTime: '2026-10-01T00:00:00.000Z' });
          seed.associationNotices.push({ _id: 'an_' + id, schoolId: 'muc', association: 'pkb', title: '通知' + id, content: 'c', status: 'published', pinned: i === 0, publishedAt: '2026-10-01T00:00:00.000Z' });
          seed.associationTrainings.push({ _id: 'tr_' + id, schoolId: 'muc', association: 'pkb', title: '训练' + id, startAt: '2026-11-01T10:00:00.000Z', signupDeadline: '2026-10-30T10:00:00.000Z', status: 'open' });
          seed.associationGroups.push({ _id: 'gp_' + id, schoolId: 'muc', association: 'pkb', name: '小组' + id, status: 'active', createdAt: '2026-10-01T00:00:00.000Z' });
          seed.associationGroupMembers.push({ _id: 'gm_' + id, schoolId: 'muc', association: 'pkb', groupId: i < 5 ? 'gp_0000' : 'gp_other_' + id, userId: 'demo_muc_admin', status: 'active' });
          seed.teamEvents.push({ _id: 'te_' + id, schoolId: 'muc', association: 'bk', name: '杯赛' + id, status: 'registration', format: 'single_elim', createdAt: '2026-10-01T00:00:00.000Z', startTime: '2026-11-01T10:00:00.000Z' });
          seed.teamEventEntries.push({ _id: 'tee_' + id, schoolId: 'muc', association: 'bk', eventId: i < 3 ? 'te_0000' : 'te_other_' + id, teamId: 'tm_' + id, status: 'approved' });
          seed.collegeEntries.push({ _id: 'ce_' + id, schoolId: 'muc', association: 'pkb', eventId: i < 4 ? 'cev_1' : 'cev_other_' + id, college: 'c01', members: ['demo_muc_admin'], status: 'approved' });
          seed.ties.push({ _id: 'tie_' + id, schoolId: 'muc', association: 'pkb', eventId: i < 4 ? 'cev_1' : 'cev_other_' + id, round: 1, slot: i + 1, collegeA: 'c01', collegeB: 'c02', status: 'pending' });
          seed.matches.push({ _id: 'mt_' + id, schoolId: 'muc', association: 'pkb', teamA: ['demo_muc_admin'], teamB: ['demo_muc_member'], matchType: 1, status: 0, pool: 1, eventId: 'ev1', matchTime: '2026-10-01T10:00:00.000Z', scoreA: [], scoreB: [] });
        }
        seed.collegeEvents.push({ _id: 'cev_1', schoolId: 'muc', association: 'pkb', title: '学院赛', status: 1, legPlan: [1], revision: 1 });

        const repo = createSchoolMemoryRepo(seed);
        // 拦截 .list() 与超限读：任何热路径读超 500 行直接报错
        for (const col of ['announcements', 'associationNotices', 'associationTrainings', 'associationGroups', 'associationGroupMembers', 'teamEvents', 'teamEventEntries', 'collegeEntries', 'ties', 'matches']) {
          const origList = repo[col].list.bind(repo[col]);
          repo[col].list = async () => guard(await origList());
          const origByScope = repo[col].listByScope.bind(repo[col]);
          repo[col].listByScope = async (s) => guard(await origByScope(s));
        }

        const homeCtx = await buildMeetContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc' } });
        assert.equal((await getSchoolHomeSummary({}, homeCtx)).data.ok, true);

        const pkbCtx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'pkb' } });
        const bkCtx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: { schoolId: 'muc', association: 'bk' } });

        const m1 = (await listSchoolMatches({ limit: 10 }, pkbCtx)).data;
        assert.equal(m1.ok, true);
        const m2 = (await listSchoolMatches({ limit: 10, cursor: m1.nextCursor }, pkbCtx)).data;
        assert.equal(m2.ok, true);
        assert.equal(m2.total, null);
        assert.equal((await listAssociationNotices({ limit: 10 }, pkbCtx)).data.ok, true);
        assert.equal((await listTrainings({ limit: 10 }, pkbCtx)).data.ok, true);
        assert.equal((await listAssociationGroups({ limit: 10 }, pkbCtx)).data.ok, true);
        assert.equal((await getAssociationGroup({ groupId: 'gp_0000' }, pkbCtx)).data.ok, true);
        assert.equal((await listTeamEvents({ limit: 10 }, bkCtx)).data.ok, true);
        assert.equal((await listCollegeEntries({ eventId: 'cev_1' }, pkbCtx)).data.ok, true);
        assert.equal((await listCollegeTies({ eventId: 'cev_1' }, pkbCtx)).data.ok, true);
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, MAX_READ_ROWS: '500' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `MAX_READ_ROWS=500 压测失败：\n${run.stderr}\n${run.stdout}`);
  });
});

describe('4. finishSchoolEvent 增量积分更新', () => {
  test('已物化赛季下 finishSchoolEvent 0 次整表重读，分数与全量重算一致', async () => {
    const seed = createSchoolDemoSeed();
    seed.events = seed.events || [];
    seed.eventSignups = seed.eventSignups || [];
    seed.users.push(
      { _id: 'p1', openId: 'op_p1', nickName: '甲', realName: '甲某', gender: 'M', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' },
      { _id: 'p2', openId: 'op_p2', nickName: '乙', realName: '乙某', gender: 'M', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' },
    );
    seed.schoolMembers.push(
      { _id: schoolMemberKey('p1', 'muc'), userId: 'p1', schoolId: 'muc', collegeId: 'c01', status: 'active' },
      { _id: schoolMemberKey('p2', 'muc'), userId: 'p2', schoolId: 'muc', collegeId: 'c01', status: 'active' },
    );
    seed.events.push({
      _id: 'ev_inc',
      ...SCOPE,
      title: '增量积分测试赛',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SCHOOL,
      format: EVENT_FORMAT.SINGLE_ELIM,
      status: EVENT_STATUS.ONGOING,
      startTime: '2026-10-10T09:00:00.000Z',
      publishTime: '2026-10-01T09:00:00.000Z',
      quota: 16,
      signupCount: 2,
      revision: 1,
    });
    seed.eventSignups.push(
      { _id: schoolEventSignupKey('ev_inc', 'p1', SCOPE), ...SCOPE, eventId: 'ev_inc', userId: 'p1', status: SIGNUP_STATUS.CHECKED_IN, revision: 1 },
      { _id: schoolEventSignupKey('ev_inc', 'p2', SCOPE), ...SCOPE, eventId: 'ev_inc', userId: 'p2', status: SIGNUP_STATUS.CHECKED_IN, revision: 1 },
    );

    const repo = createSchoolMemoryRepo(seed);
    const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });

    // 先完成一次全量物化
    await refreshAssociationPoints(ctx);

    // 监视：增量模式下不应调用 events / associationTrainings / trainingRegistrations / schoolMembers 的 .list()
    const forbidden = [];
    for (const key of ['events', 'associationTrainings', 'trainingRegistrations', 'schoolMembers']) {
      const origScope = repo.forScope;
      const col = repo[key];
      const origListByScope = col.listByScope.bind(col);
      col.listByScope = async (s) => { forbidden.push(key); return origListByScope(s); };
      void origScope;
    }

    const res = (await finishSchoolEvent({
      eventId: 'ev_inc',
      results: [{ userId: 'p1', placement: 1 }, { userId: 'p2', placement: 2 }],
    }, ctx)).data;

    assert.equal(res.ok, true);
    assert.equal(res.needsRefresh, undefined, '内部标志不泄露到响应');
    assert.deepEqual(forbidden, [], '已物化状态下不应触发全量重读');

    const season = await repo.seasons.getById(scopeKey(SCOPE));
    assert.equal(isSettled(season), true, '赛季应保持已物化状态');

    const memberRows = [
      await repo.schoolMembers.getById(schoolMemberKey('p1', 'muc')),
      await repo.schoolMembers.getById(schoolMemberKey('p2', 'muc')),
    ];
    const settled = settledPointsOf(season, memberRows, 'pkb');
    const expected = aggregatePoints({
      events: [await repo.events.getById('ev_inc')],
      trainings: [],
      trainingRegistrations: [],
      resetTime: season.resetTime,
    });
    assert.equal(settled.get('p1'), expected.get('p1'));
    assert.equal(settled.get('p2'), expected.get('p2'));
  });
});

describe('5. 精准缓存失效核查', () => {
  test('运动会录分不触发全容器失效，账号注销触发全容器失效', async () => {
    const seed = createSchoolDemoSeed();
    const repo = createSchoolMemoryRepo(seed);

    let invalidateAllCount = 0;
    let invalidateMeetCount = 0;
    const origAll = contextCache.invalidateAll;
    const origMeet = contextCache.invalidateMeet;
    contextCache.invalidateAll = (...args) => { invalidateAllCount += 1; return origAll(...args); };
    contextCache.invalidateMeet = (...args) => { invalidateMeetCount += 1; return origMeet(...args); };

    try {
      await handleSchoolRequest({
        protocolVersion: 2,
        schoolId: 'muc',
        meetId: 'meet_1',
        action: 'saveMeetJudgeScore',
        payload: {},
      }, { repo, openId: 'mock_openid_muc_admin' });
      assert.equal(invalidateMeetCount, 1);
      assert.equal(invalidateAllCount, 0, '纯录分不得打穿全容器缓存');

      await handleSchoolRequest({
        protocolVersion: 2,
        schoolId: 'muc',
        association: 'pkb',
        action: 'deactivateMySchoolAccount',
        payload: { confirm: false },
      }, { repo, openId: 'mock_openid_muc_member' });
      assert.equal(invalidateAllCount, 1, '账号注销必须触发全容器失效');
    } finally {
      contextCache.invalidateAll = origAll;
      contextCache.invalidateMeet = origMeet;
    }
  });
});

describe('6. 合规闭环：脱敏、UGC 内容安全与账号注销', () => {
  test('统一脱敏管道支持姓名、显示名、学号脱敏与公开对象清理', () => {
    assert.equal(isPrivacyMaskEnabled(), true);
    assert.equal(maskRealName('张伟'), '张*');
    assert.equal(maskRealName('王小明'), '王*明');
    assert.equal(maskRealName('阿不都·热合曼'), '阿*****曼');
    assert.equal(maskDisplayName('会员'), '会员');
    assert.equal(maskDisplayName('已注销用户'), '已注销用户');
    assert.equal(maskStudentId('20230001'), '20****01');

    const cleaned = sanitizePublicMember({
      userId: 'u1',
      openId: 'secret_openid',
      studentId: '20230001',
      realName: '王小明',
      nickName: '球王',
      phone: '13800138000',
    }, { maskNick: true });
    assert.equal(cleaned.openId, undefined);
    assert.equal(cleaned.studentId, undefined);
    assert.equal(cleaned.phone, undefined);
    assert.equal(cleaned.realName, '王*明');
    assert.equal(cleaned.nickName, '球*');
  });

  test('UGC 内容安全拦截本地违禁词/控制字符与自定义 msgSecCheck，并可按开关控制', async () => {
    assert.equal((await checkUgcContent('周末匹克球校内交流赛')).ok, true);
    assert.equal((await checkUgcContent('正常标题\u0007')).ok, false);
    assert.equal((await checkUgcContent('欢迎访问赌博网站')).ok, false);

    setUgcChecker(async ({ content }) => {
      if (content.includes('风险测试词')) return { errCode: 87014, result: { suggest: 'risky' } };
      return { errCode: 0, result: { suggest: 'pass' } };
    });

    schoolMock.setDemoActor('demo_muc_admin');
    const api = schoolMock.forAssociationSpace(SCOPE);
    const annRes = await api.publishSchoolAnnouncement({
      title: '风险测试词公告',
      content: '正文',
      requestId: 'req_ugc_1',
    });
    assert.equal(annRes.ok, false);

    const noticeRes = await api.publishAssociationNotice({
      title: '包含代开发票广告',
      content: '正文',
      category: '通知',
      requestId: 'req_ugc_2',
    });
    assert.equal(noticeRes.ok, false);

    const groupRes = await api.createAssociationGroup({
      name: '正常小组\u0000',
      description: 'desc',
      requestId: 'req_ugc_3',
    });
    assert.equal(groupRes.ok, false);

    // 端到端通过（不含违禁内容）
    resetUgcChecker();
    const okGroup = await api.createAssociationGroup({
      name: '周末约球组',
      description: '校内球友交流',
      requestId: 'req_ugc_ok',
    });
    assert.equal(okGroup.ok, true);
  });

  test('账号注销闭环：需本人确认、抹除敏感字段、释放学号、撤销角色会籍且保留历史战绩', async () => {
    const seed = createSchoolDemoSeed();
    seed.events = seed.events || [];
    seed.eventSignups = seed.eventSignups || [];
    seed.studentIdClaims = seed.studentIdClaims || [];
    seed.matches = seed.matches || [];
    seed.users.push({
      _id: 'u_bye',
      openId: 'op_bye',
      nickName: '小张',
      realName: '张小飞',
      gender: 'M',
      avatarUrl: 'https://example.com/a.png',
      platformStatus: 'active',
      platformRole: 'member',
      primarySchoolId: 'muc',
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey('u_bye', 'muc'),
      userId: 'u_bye',
      schoolId: 'muc',
      collegeId: 'c01',
      studentId: '20249999',
      status: 'active',
    });
    seed.studentIdClaims.push({
      _id: 'sid_muc_20249999',
      schoolId: 'muc',
      studentId: '20249999',
      userId: 'u_bye',
    });
    seed.memberships.push({
      _id: 'mb:muc:pkb:u_bye',
      userId: 'u_bye',
      schoolId: 'muc',
      association: 'pkb',
      role: 'leader',
      status: 'active',
    });
    seed.matches.push({
      _id: 'm_hist_1',
      ...SCOPE,
      teamA: ['u_bye'],
      teamB: ['demo_muc_member'],
      matchType: MATCH_TYPE.SINGLES,
      status: MATCH_STATUS.ACTIVE,
      pool: 1,
      winner: 'A',
      scoreA: [11],
      scoreB: [8],
      matchTime: '2026-10-01T10:00:00.000Z',
    });

    const repo = createSchoolMemoryRepo(seed);
    // 缺 confirm 拒绝
    const unconfirmed = (await handleSchoolRequest({
      protocolVersion: 2,
      schoolId: 'muc',
      association: 'pkb',
      action: 'deactivateMySchoolAccount',
      payload: {},
    }, { repo, openId: 'op_bye' })).data;
    assert.equal(unconfirmed.ok, false);

    // 平台管理员不可自助注销
    const adminRes = (await handleSchoolRequest({
      protocolVersion: 2,
      schoolId: 'muc',
      association: 'pkb',
      action: 'deactivateMySchoolAccount',
      payload: { confirm: true },
    }, { repo, openId: 'mock_openid_platform_admin' })).data;
    assert.equal(adminRes.ok, false);

    // 正常注销
    const res = (await handleSchoolRequest({
      protocolVersion: 2,
      schoolId: 'muc',
      association: 'pkb',
      action: 'deactivateMySchoolAccount',
      payload: { confirm: true },
    }, { repo, openId: 'op_bye' })).data;
    assert.equal(res.ok, true);
    assert.equal(res.deactivated, true);

    const userAfter = await repo.users.getById('u_bye');
    assert.equal(userAfter.openId, '');
    assert.equal(userAfter.realName, '');
    assert.equal(userAfter.avatarUrl, '');
    assert.equal(userAfter.nickName, '已注销用户');
    assert.equal(userAfter.platformStatus, 'disabled');
    assert.equal(userAfter.deleted, true);

    const memberAfter = await repo.schoolMembers.getById(schoolMemberKey('u_bye', 'muc'));
    assert.equal(memberAfter.status, 'left');
    assert.equal(memberAfter.studentId, '');

    const mbAfter = await repo.memberships.getById('mb:muc:pkb:u_bye');
    assert.equal(mbAfter.status, 'revoked');

    const histMatch = await repo.matches.getById('m_hist_1');
    assert.ok(histMatch, '历史比赛账本必须保留');
    assert.equal(histMatch.winner, 'A');

    // 注销后原 openId 无法再发起写操作
    const afterWrite = (await handleSchoolRequest({
      protocolVersion: 2,
      schoolId: 'muc',
      association: 'pkb',
      action: 'updateSchoolProfile',
      payload: { patch: { nickName: '新名字' } },
    }, { repo, openId: 'op_bye' })).data;
    assert.equal(afterWrite.ok, false);
  });
});

/**
 * 榜单实名脱敏的 DTO 接线守卫（D2 合规）。
 * ============================================================
 * 上面的 maskRealName 单测只证明工具本身正确，不能证明"哪些 DTO 真接了管道"。
 * 这里直接走三个真实 handler，断言普通成员视角拿不到他人完整实名。
 */
describe('7. 榜单 DTO 实名脱敏接线', () => {
  const rank = require('../src/server/services/school-rank-service.js');
  const { RATING_POOL } = require('../src/shared/utils/constants.js');
  const {
    memberRatingKey, schoolAssociationKey, collegeKey, SCHOOL_MEMBER_STATUS,
  } = require('../src/shared/utils/school.js');

  function rankFixture() {
    const people = [
      { id: 'viewer', gender: 'M', realName: '赵明宇' },
      { id: 'other', gender: 'M', realName: '王小明' },
    ];
    const users = people.map(p => ({
      _id: p.id, openId: `o_${p.id}`, nickName: p.id, realName: p.realName,
      gender: p.gender, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCOPE.schoolId,
    }));
    const schoolMembers = people.map(p => ({
      _id: schoolMemberKey(p.id, SCOPE.schoolId), schoolId: SCOPE.schoolId, userId: p.id,
      collegeId: 'c01', status: SCHOOL_MEMBER_STATUS.ACTIVE,
    }));
    const memberRatings = people.map((p, i) => ({
      _id: memberRatingKey(p.id, RATING_POOL.SINGLES, SCOPE),
      schoolId: SCOPE.schoolId, association: SCOPE.association, userId: p.id, pool: RATING_POOL.SINGLES,
      elo: 1600 - i, startElo: 1450, matchCount: 3, wins: 2, losses: 1,
      gender: p.gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE,
    }));
    return createSchoolMemoryRepo({
      schools: [{ _id: SCOPE.schoolId, schoolId: SCOPE.schoolId, name: '中央民族大学', status: 'active' }],
      users, schoolMembers, memberRatings,
      colleges: [{ _id: collegeKey(SCOPE.schoolId, 'c01'), schoolId: SCOPE.schoolId, collegeId: 'c01', name: '一院', status: 'active' }],
      schoolAssociations: [{
        _id: schoolAssociationKey(SCOPE), schoolId: SCOPE.schoolId,
        association: SCOPE.association, status: 'active',
      }],
    });
  }

  test('普通成员视角：排行榜/成绩/他人档案不返回完整实名，本人保留完整', async () => {
    const repo = rankFixture();
    const ctx = await buildSchoolContext({ repo, actorId: 'viewer', scope: SCOPE });

    // 排行榜：他人脱敏、本人完整
    const board = (await rank.getSchoolRanking({}, ctx)).data;
    const other = board.rows.find(row => row.userId === 'other');
    const mine = board.rows.find(row => row.isMe);
    assert.ok(other && mine, '榜单应包含本人与他人');
    assert.equal(other.realName, '王*明', '普通成员不得拿到他人完整实名');
    assert.equal(mine.realName, '赵明宇', '本人可见完整实名');

    // 成绩列表：他人脱敏、本人完整
    const stats = (await rank.getSchoolMemberStats({ userIds: ['other', 'viewer'] }, ctx)).data;
    assert.equal(stats.members.find(m => m.userId === 'other').realName, '王*明');
    assert.equal(stats.members.find(m => m.userId === 'viewer').realName, '赵明宇');

    // 他人档案：实名脱敏且不返回学号
    const profile = (await rank.getSchoolMemberProfile({ userId: 'other' }, ctx)).data;
    assert.equal(profile.user.realName, '王*明', '他人档案实名必须脱敏');
    assert.equal(profile.user.studentId, undefined, '他人档案不得返回学号');
  });

  test('管理员视角：榜单与他人档案保留完整实名与学号', async () => {
    const repo = rankFixture();
    const ctx = await buildSchoolContext({ repo, actorId: 'viewer', scope: SCOPE });
    ctx.actor.platformRole = 'admin';

    const board = (await rank.getSchoolRanking({}, ctx)).data;
    assert.equal(board.rows.find(row => row.userId === 'other').realName, '王小明', '管理员可见完整实名');

    const profile = (await rank.getSchoolMemberProfile({ userId: 'other' }, ctx)).data;
    assert.equal(profile.user.realName, '王小明', '管理员看他人档案保留完整实名');
  });
});
