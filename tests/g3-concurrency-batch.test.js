/**
 * T-04 (G3) 热点解耦、单栅栏守卫与 VersionedBatchJob 专项测试
 */
process.env.RATE_LIMIT = 'off';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runVersionedBatchJob } = require('../src/server/services/versioned-batch-job.js');
const { fixture: basketFixture } = require('../tools/audit-basketball-cloud.cjs');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildMeetContext } = require('../src/server/services/meet-context.js');
const meetService = require('../src/server/services/meet-service.js');
const leadService = require('../src/server/services/meet-college-lead-service.js');
const regService = require('../src/server/services/meet-registration-service.js');
const scheduleService = require('../src/server/services/meet-schedule-service.js');
const scoreService = require('../src/server/services/meet-score-service.js');
const { meetEventKey } = require('../src/shared/utils/meet-scope.js');
const { touchEvent } = require('../src/server/services/meet-consistency.js');
const { TEMPLATES } = require('../src/shared/services/meet-event-catalog.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../src/shared/utils/school.js');
const contextCache = require('../cloudfunctions/data/lib/server/services/context-cache.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request.js');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');

describe('1. VersionedBatchJob 统一批任务引擎契约', () => {
  test('支持 startCursor / maxBatches 分步续跑，并按 BATCH_JOB_MAX_OPS 动态缩批', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i + 1);
    const seen = [];
    const prev = process.env.BATCH_JOB_MAX_OPS;
    process.env.BATCH_JOB_MAX_OPS = '24'; // (24 - 8) / 2 = 8 条/批
    try {
      const step1 = await runVersionedBatchJob({
        items,
        opsPerItem: 2,
        fixedOps: 8,
        maxBatches: 1,
        runBatch: async ({ slice }) => {
          seen.push(slice.length);
          return { ok: true, written: slice.length };
        },
      });
      assert.equal(step1.ok, true);
      assert.equal(step1.done, false);
      assert.equal(step1.batchSize, 8);
      assert.equal(step1.nextCursor, 8);

      const step2 = await runVersionedBatchJob({
        items,
        opsPerItem: 2,
        fixedOps: 8,
        startCursor: step1.nextCursor,
        runBatch: async ({ slice }) => {
          seen.push(slice.length);
          return { ok: true, written: slice.length };
        },
      });
      assert.equal(step2.ok, true);
      assert.equal(step2.done, true);
      assert.equal(step2.nextCursor, 25);
      assert.deepEqual(seen, [8, 8, 8, 1]);
    } finally {
      if (prev === undefined) delete process.env.BATCH_JOB_MAX_OPS;
      else process.env.BATCH_JOB_MAX_OPS = prev;
    }
  });

  test('BATCH_JOB_MAX_OPS 能下调业务接入点的硬编码预算，但不抬升其天花板', async () => {
    const { resolveMaxOpsPerBatch } = require('../src/server/services/versioned-batch-job.js');
    const prev = process.env.BATCH_JOB_MAX_OPS;
    try {
      delete process.env.BATCH_JOB_MAX_OPS;
      assert.equal(resolveMaxOpsPerBatch(60), 60, '无环境变量时用业务硬编码预算');
      assert.equal(resolveMaxOpsPerBatch(90), 90, '派裁判 90 预算不被默认 60 覆盖');

      process.env.BATCH_JOB_MAX_OPS = '24';
      assert.equal(resolveMaxOpsPerBatch(60), 24, '环境变量应能下调 60 预算');
      assert.equal(resolveMaxOpsPerBatch(90), 24, '环境变量应能下调 90 预算');

      process.env.BATCH_JOB_MAX_OPS = '80';
      assert.equal(resolveMaxOpsPerBatch(60), 60, '环境变量不得把 60 天花板抬升到 80');
      assert.equal(resolveMaxOpsPerBatch(90), 80, '90 天花板内允许抬到 80');

      // 业务路径实证：带 override=60 的接入点在环境变量 24 下按 8 条/批缩批
      process.env.BATCH_JOB_MAX_OPS = '24';
      const res = await runVersionedBatchJob({
        items: Array.from({ length: 25 }, (_, i) => i + 1),
        opsPerItem: 2,
        fixedOps: 8,
        maxOpsPerBatch: 60,
        runBatch: async ({ slice }) => ({ ok: true, written: slice.length }),
      });
      assert.equal(res.batchSize, 8, '业务路径的硬编码预算应被环境变量下调');
    } finally {
      if (prev === undefined) delete process.env.BATCH_JOB_MAX_OPS;
      else process.env.BATCH_JOB_MAX_OPS = prev;
    }
  });

  test('遇到 targetVersion 漂移（stale: true）立即中止并返回当前游标', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const res = await runVersionedBatchJob({
      items,
      opsPerItem: 2,
      fixedOps: 8,
      maxOpsPerBatch: 28, // 10 条/批
      runBatch: async ({ batchIndex, slice }) => {
        if (batchIndex === 1) return { ok: false, stale: true, message: '版本已变化' };
        return { ok: true, written: slice.length };
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.stale, true);
    assert.equal(res.processed, 10);
    assert.equal(res.nextCursor, 10);
    assert.match(res.message, /版本/);
  });
});

describe('2. 团队大签表与单栅栏（11–16 队循环赛抽签 + 16 队结算）', () => {
  for (const count of [11, 16]) {
    const expectedMatches = (count * (count - 1)) / 2;
    test(`${count} 队篮球单循环（${expectedMatches} 场）在云端严格预算下分批抽签全绿`, async () => {
      const f = await basketFixture({ count, format: 'round_robin' });
      const draw = await f.call('drawTeamEvent', { eventId: 'event' });
      assert.equal(draw.ok, true, draw.message);
      assert.equal(draw.matchCount, expectedMatches);
      assert.equal((await f.matches()).length, expectedMatches);
      assert.ok(f.db.traces.length > 1, '超过 45 场应自动走分批事务');
      for (const trace of f.db.traces) {
        assert.ok(trace.length <= 66, `单批事务操作数应受控在 60 档预算内，实际 ${trace.length}`);
      }
      const ev = await f.repo.teamEvents.getById('event');
      assert.equal(ev.status, 'scheduled');
      assert.equal(Boolean(ev.batchDrawPending), false);
    });
  }

  test('16 队循环赛（120 场）结算在单栅栏模式下单事务不超 100 次上限', async () => {
    const f = await basketFixture({ count: 16, format: 'round_robin' });
    const draw = await f.call('drawTeamEvent', { eventId: 'event' });
    assert.equal(draw.ok, true, draw.message);
    const matches = await f.matches();
    assert.equal(matches.length, 120);
    // 直接播种为已发布状态，测试结算事务本身的读预算
    for (const m of matches) {
      await f.repo.teamMatches.set(m._id, {
        ...m, status: 'published', scoreA: 60, scoreB: 50, winner: 'A',
      });
    }
    f.db.traces.length = 0;
    const settled = await f.call('settleTeamEvent', { eventId: 'event' });
    assert.equal(settled.ok, true, settled.message);
    assert.equal(settled.placements.length, 16);
    assert.equal(f.db.traces.length, 1);
    assert.ok(f.db.traces[0].length <= 60, `单栅栏结算只应核对 event.revision 与写入 16 条报名，实际 ${f.db.traces[0].length}`);
  });

  test('分批抽签批次间遭遇外部修改 event.revision 时乐观锁中止', async () => {
    const f = await basketFixture({ count: 11, format: 'round_robin' });
    const rawTx = f.db.runTransaction;
    let txCount = 0;
    f.db.runTransaction = async (fn) => {
      txCount += 1;
      if (txCount === 2) {
        const cur = await f.repo.teamEvents.getById('event');
        await f.repo.teamEvents.set('event', { ...cur, revision: Number(cur.revision || 0) + 9 });
      }
      return rawTx(fn);
    };
    const draw = await f.call('drawTeamEvent', { eventId: 'event' });
    assert.equal(draw.ok, false);
    assert.match(draw.message, /刷新后重试/);
    assert.equal(draw.batchDrawPending, true);
    const saved = (await f.matches()).length;
    assert.ok(saved > 0 && saved < 55);
    assert.equal(draw.batchProgress.nextCursor, saved);
    assert.equal(draw.batchProgress.written, saved);
    assert.equal(draw.batchProgress.total, 55);
    assert.equal(draw.batchProgress.stale, true);
  });
});

describe('3. 百人成绩发布（100 学院报名）+ 20 路并发录分无全局热点锁', () => {
  test('100 人正式成绩发布在严格仿真下全绿，派生明细按 <= 60 ops 分批并保留快照兜底', async () => {
    const SCHOOL = 'muc';
    const T0 = new Date('2026-10-24T08:00:00Z');
    const colleges = Array.from({ length: 100 }, (_, i) => `c${String(i + 1).padStart(3, '0')}`);
    const users = [
      { _id: 'u_admin', openId: 'o_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
      { _id: 'u_j1', openId: 'o_j1', name: '裁判', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
      ...colleges.map((c) => ({ _id: `u_l_${c}`, openId: `o_l_${c}`, name: `${c}部长`, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL })),
      ...colleges.map((c) => ({ _id: `u_s_${c}`, openId: `o_s_${c}`, name: `${c}选手`, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL })),
    ];
    const members = [
      { _id: schoolMemberKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', collegeId: 'c001', status: 'active', gender: 'male' },
      { _id: schoolMemberKey('u_j1', SCHOOL), schoolId: SCHOOL, userId: 'u_j1', collegeId: 'c001', status: 'active', gender: 'male' },
      ...colleges.map((c) => ({ _id: schoolMemberKey(`u_l_${c}`, SCHOOL), schoolId: SCHOOL, userId: `u_l_${c}`, collegeId: c, status: 'active', gender: 'male' })),
      ...colleges.map((c) => ({ _id: schoolMemberKey(`u_s_${c}`, SCHOOL), schoolId: SCHOOL, userId: `u_s_${c}`, collegeId: c, status: 'active', gender: 'male' })),
    ];
    const repo = createSchoolMemoryRepo({
      schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '民大', status: 'active' }],
      users,
      colleges: colleges.map((c, idx) => ({ _id: collegeKey(SCHOOL, c), schoolId: SCHOOL, collegeId: c, name: `${idx + 1}院`, status: 'active' })),
      schoolMembers: members,
      schoolRoles: [{ _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' }],
    }, { strict: true });

    const ctxOf = (actorId, meetId = '') => buildMeetContext({ repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: T0 });
    const created = await meetService.createSportsMeet({
      name: '百人运会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
    }, await ctxOf('u_admin'));
    assert.equal(created.ok, true, created.message);
    const meetId = created.data.meet.meetId;
    const adminCtx = await ctxOf('u_admin', meetId);

    assert.equal((await meetService.configureMeetEvent({
      templateId: 'sprint-100m', group: 'male', perCollegeLimit: 1, rounds: 'final',
    }, adminCtx)).ok, true);
    assert.equal((await meetService.publishMeetRegistration({
      openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59',
    }, adminCtx)).ok, true);

    const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
    const entryKeys = [];
    for (const c of colleges) {
      await leadService.grantMeetCollegeLead({ collegeId: c, userId: `u_l_${c}` }, adminCtx);
      const stu = `u_s_${c}`;
      await regService.submitMeetInterest({ eventKey }, await ctxOf(stu, meetId));
      const sub = await regService.submitMeetCollegeEntry({ eventKey, userIds: [stu] }, await ctxOf(`u_l_${c}`, meetId));
      assert.equal(sub.ok, true, sub.message);
      const ek = sub.data.entry._id;
      entryKeys.push(ek);
      assert.equal((await regService.reviewMeetEntry({ entryKey: ek, decision: 'approve' }, adminCtx)).ok, true);
    }

    const ses = await scheduleService.saveMeetSession({
      eventKey, round: 'final', index: 1,
      startAt: '2026-10-24T09:00', endAt: '2026-10-24T11:00', venue: '沙坑',
    }, adminCtx);
    assert.equal(ses.ok, true, ses.message);
    const sessionKey = ses.data.session.sessionKey;
    assert.equal((await scheduleService.assignMeetJudge({ sessionKey, judgeId: 'u_j1' }, adminCtx)).ok, true);
    assert.equal((await scheduleService.publishMeetSchedule({}, adminCtx)).ok, true);
    assert.equal((await scheduleService.startMeetEvent({ sessionKey }, adminCtx)).ok, true);

    const judgeCtx = await ctxOf('u_j1', meetId);
    for (let i = 0; i < entryKeys.length; i += 1) {
      const saved = await scoreService.saveMeetJudgeScore({
        sessionKey, entryKey: entryKeys[i], rawText: (10 + i * 0.01).toFixed(2),
      }, judgeCtx);
      assert.equal(saved.ok, true, saved.message);
      const submitted = await scoreService.submitMeetJudgeScore({
        sessionKey, entryKey: entryKeys[i],
      }, judgeCtx);
      assert.equal(submitted.ok, true, submitted.message);
    }

    const pub = await scoreService.publishMeetResults({ eventKey, sessionKey }, adminCtx);
    assert.equal(pub.ok, true, pub.message);
    assert.equal(pub.data.publication.rows.length, 100);
    const detailRows = await repo.forMeet({ schoolId: SCHOOL, meetId }).sportsMeetResultRows.listByProject(eventKey);
    assert.equal(detailRows.length, 100);

    const publishedView = await scoreService.getPublishedResults({ eventKey }, await ctxOf('u_admin', meetId));
    assert.equal(publishedView.ok, true);
    assert.equal(publishedView.data.items.length, 100);
  });

  test('20 路并发录分与提交：全部成功且 sportsMeets[meetId] 写入次数为 0', async () => {
    const SCHOOL = 'muc';
    const T0 = new Date('2026-10-24T08:00:00Z');
    const N = 20;
    const users = [
      { _id: 'u_admin', openId: 'o_admin', name: '校管理员', platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL },
      ...Array.from({ length: N }, (_, i) => ({ _id: `u_j_${i}`, openId: `o_j_${i}`, name: `裁判${i}`, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL })),
      ...Array.from({ length: N }, (_, i) => ({ _id: `u_s_${i}`, openId: `o_s_${i}`, name: `学生${i}`, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL })),
    ];
    const members = users.map((u) => {
      const idx = u._id.startsWith('u_s_') ? Number(u._id.slice(4)) : 0;
      return {
        _id: schoolMemberKey(u._id, SCHOOL), schoolId: SCHOOL, userId: u._id, collegeId: 'c01',
        status: 'active', gender: idx < 10 ? 'male' : 'female',
      };
    });
    const repo = createSchoolMemoryRepo({
      schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '民大', status: 'active' }],
      colleges: [{ _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '1院', status: 'active' }],
      users,
      schoolMembers: members,
      schoolRoles: [{ _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' }],
    }, { strict: true });

    const ctxOf = (actorId, meetId = '') => buildMeetContext({ repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: T0 });
    const created = await meetService.createSportsMeet({
      name: '并发录分测试', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
    }, await ctxOf('u_admin'));
    const meetId = created.data.meet.meetId;
    const adminCtx = await ctxOf('u_admin', meetId);
    const nonVersus = TEMPLATES.filter((t) => t.scoreType !== 'versus' && t.entryForm === 'single').slice(0, 10);
    const tplIds = [...nonVersus.map((t) => t.id), ...nonVersus.map((t) => t.id)];
    const groups = tplIds.map((_, i) => (i < 10 ? 'male' : 'female'));

    for (let i = 0; i < N; i += 1) {
      const cfg = await meetService.configureMeetEvent({
        templateId: tplIds[i], group: groups[i], perCollegeLimit: 1, rounds: 'final',
      }, adminCtx);
      assert.equal(cfg.ok, true, cfg.message);
    }
    assert.equal((await meetService.publishMeetRegistration({
      openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59',
    }, adminCtx)).ok, true);

    const sessions = [];
    for (let i = 0; i < N; i += 1) {
      const eventKey = meetEventKey(meetId, tplIds[i], groups[i]);
      const stu = `u_s_${i}`;
      await regService.submitMeetInterest({ eventKey }, await ctxOf(stu, meetId));
      const sub = await regService.submitMeetCollegeEntry({ eventKey, collegeId: 'c01', userIds: [stu] }, adminCtx);
      assert.equal(sub.ok, true, sub.message);
      const ek = sub.data.entry._id;
      await regService.reviewMeetEntry({ entryKey: ek, decision: 'approve' }, adminCtx);
      const ses = await scheduleService.saveMeetSession({
        eventKey, round: 'final', index: 1,
        startAt: '2026-10-24T09:00', endAt: '2026-10-24T10:00', venue: `场地${i}`,
      }, adminCtx);
      const sk = ses.data.session.sessionKey;
      await scheduleService.assignMeetJudge({ sessionKey: sk, judgeId: `u_j_${i}` }, adminCtx);
      sessions.push({ sessionKey: sk, entryKey: ek, judgeId: `u_j_${i}` });
    }
    assert.equal((await scheduleService.publishMeetSchedule({}, adminCtx)).ok, true);
    for (const s of sessions) {
      assert.equal((await scheduleService.startMeetEvent({ sessionKey: s.sessionKey }, adminCtx)).ok, true);
    }

    const meetBefore = await repo.sportsMeets.getById(meetId);
    const revBefore = Number(meetBefore.contentRevision || 0);

    const results = await Promise.all(sessions.map(async (s) => {
      const jCtx = await ctxOf(s.judgeId, meetId);
      const saved = await scoreService.saveMeetJudgeScore({
        sessionKey: s.sessionKey, entryKey: s.entryKey, rawText: '12.34',
      }, jCtx);
      const submitted = await scoreService.submitMeetJudgeScore({ sessionKey: s.sessionKey, entryKey: s.entryKey }, jCtx);
      return { saved: saved.ok, submitted: submitted.ok };
    }));
    for (const r of results) {
      assert.equal(r.saved, true);
      assert.equal(r.submitted, true);
    }
    const meetAfter = await repo.sportsMeets.getById(meetId);
    assert.equal(Number(meetAfter.contentRevision || 0), revBefore, '20 路并发录分不应写 sportsMeets.contentRevision');
  });
});

describe('4. 运动会独立缓存失效粒度（invalidateMeet）', () => {
  test('saveMeetJudgeScore / submitMeetJudgeScore 只清本届缓存，不触发 invalidateAll', async () => {
    const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
    const calls = { all: 0, meet: [] };
    const origAll = contextCache.invalidateAll;
    const origMeet = contextCache.invalidateMeet;
    contextCache.invalidateAll = () => { calls.all += 1; };
    contextCache.invalidateMeet = (schoolId, meetId) => { calls.meet.push([schoolId, meetId]); };

    contextCache.__setTtlForTest(5000);
    contextCache.set('muc|pkb|o1|', { actor: { _id: 'a' } });
    contextCache.set('meet|muc|m1|o1|', { actor: { _id: 'a' } });
    contextCache.set('meet|muc|m2|o1|', { actor: { _id: 'a' } });
    origMeet('muc', 'm1');
    assert.equal(contextCache.get('meet|muc|m1|o1|'), null, '本届缓存应失效');
    assert.ok(contextCache.get('meet|muc|m2|o1|'), '同校其他届次缓存应保留');
    assert.ok(contextCache.get('muc|pkb|o1|'), '同校协会缓存应保留');
    contextCache.__setTtlForTest(0);

    try {
      await handleSchoolRequest(
        { protocolVersion: 2, schoolId: 'muc', meetId: 'm1', action: 'saveMeetJudgeScore', payload: {} },
        { repo, openId: 'mock_openid_muc_admin', now: new Date('2026-10-27T10:00:00Z') },
      );
      await handleSchoolRequest(
        { protocolVersion: 2, schoolId: 'muc', meetId: 'm1', action: 'submitMeetJudgeScore', payload: {} },
        { repo, openId: 'mock_openid_muc_admin', now: new Date('2026-10-27T10:00:00Z') },
      );
    } finally {
      contextCache.invalidateAll = origAll;
      contextCache.invalidateMeet = origMeet;
    }
    assert.equal(calls.all, 0, '运动会录分不应清全容器缓存');
    assert.deepEqual(calls.meet, [['muc', 'm1'], ['muc', 'm1']]);
  });
});

describe('5. G3 静态守卫（单栅栏全覆盖 + 无热点写回）', () => {
  test('team-event-service 与 football-match-service 所有比赛/报名写事务均推进 event.revision', () => {
    const teamSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'team-event-service.js'), 'utf8');
    // 确认 saveTeamMatchLineup / recordTeamMatch / publishTeamMatch / updateTeamMatchSchedule / updateTeamRoundSchedule / startTeamLiveScore 均写 teamEvents
    for (const fnName of [
      'saveTeamMatchLineup', 'recordTeamMatch', 'publishTeamMatch',
      'updateTeamMatchSchedule', 'updateTeamRoundSchedule', 'startTeamLiveScore',
    ]) {
      const start = teamSrc.indexOf(`async function ${fnName}(`);
      assert.ok(start > 0, `未找到 ${fnName}`);
      const nextFn = teamSrc.indexOf('\nasync function ', start + 20);
      const body = teamSrc.slice(start, nextFn > 0 ? nextFn : start + 4000);
      assert.match(body, /tx\.teamEvents\.set\(/, `${fnName} 必须同步推进 teamEvents.revision 守住单栅栏`);
      // 只断言「出现 set」不够：写一份不带 revision 的旧对象也能过。
      // 静态要求同一个函数里出现 revision 字段；运行时契约仍由单栅栏用例兜底。
      assert.match(body, /revision\s*:/, `${fnName} 写 teamEvents 时必须显式带 revision`);
    }
    const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'football-match-service.js'), 'utf8');
    assert.match(fbSrc, /tx\.teamEvents\.set\(/, 'football-match-service 必须同步推进 teamEvents.revision');
  });

  test('meet-consistency touchEvent 默认不写 sportsMeets，assignMeetJudges 不写 contentRevision', () => {
    const mcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'meet-consistency.js'), 'utf8');
    assert.match(mcSrc, /const bumpMeet = Boolean\(options && options\.bumpMeet\)/,
      'touchEvent 必须门控 bumpMeet 才能写 contentRevision');
    assert.match(mcSrc, /const bumpEntries = Boolean\(options && options\.bumpEntries\)/,
      'touchEvent 必须门控 bumpEntries 才能写 entriesRevision');
    const msSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'meet-schedule-service.js'), 'utf8');
    const fnStart = msSrc.indexOf('async function assignMeetJudges(');
    const fnEnd = msSrc.indexOf('\nfunction ', fnStart + 20);
    const fnBody = msSrc.slice(fnStart, fnEnd > 0 ? fnEnd : msSrc.length);
    assert.equal(fnBody.includes('contentRevision'), false, 'assignMeetJudges 不得写入 sportsMeets.contentRevision');
  });
});

describe('6. G3 补强：批任务异常与 7+ 项目收尾并发', () => {
  test('runBatch 抛错时返回确定失败进度，而不是把异常冒成服务异常', async () => {
    const job = await runVersionedBatchJob({
      items: [1, 2, 3],
      opsPerItem: 2,
      fixedOps: 2,
      runBatch: async () => { throw new Error('事务回调炸了'); },
    });
    assert.equal(job.ok, false);
    assert.equal(job.done, false);
    assert.equal(job.batches, 1);
    assert.equal(job.failed, 3);
    assert.equal(job.nextCursor, 0);
    assert.match(job.message, /事务回调炸了/);
  });

  test('7 项目运动会：报名读完时发生并发变更，收尾不得混用旧报名和新版本', async () => {
    const meetScope = { schoolId: 'muc', meetId: 'm' };
    const events = Array.from({ length: 7 }, (_, i) => ({
      _id: `e${i}`, ...meetScope, name: `项目${i}`, status: 'active', revision: 1,
    }));
    const seed = {
      schools: [{ _id: 'muc', schoolId: 'muc', status: 'active' }],
      users: [{ _id: 'admin', platformStatus: 'active', platformRole: 'admin' }],
      sportsMeets: [{
        _id: 'm', ...meetScope, name: '运动会', status: 'running',
        version: 1, contentRevision: 0, scheduleRevision: 0, entriesRevision: 0,
      }],
      sportsMeetEvents: events,
      // e0..e5 已发布；e6 还没有报名，也没有成绩
      sportsMeetPublications: events.slice(0, 6).map((event, index) => ({
        _id: `p${index}`, ...meetScope, eventKey: event._id, official: true, status: 'published', version: 1,
      })),
      sportsMeetEntries: [],
    };
    const repo = createSchoolMemoryRepo(seed);
    const ctx = await buildMeetContext({
      repo, actorId: 'admin', scope: meetScope, now: new Date('2026-11-14T00:00:00Z'),
    });

    // 模拟届次点读慢于报名列表。并行发起读请求时，旧实现会将旧列表与新版本混用。
    const readMeet = repo.sportsMeets.getById.bind(repo.sportsMeets);
    repo.sportsMeets.getById = async (id) => {
      await new Promise(resolve => setImmediate(resolve));
      return readMeet(id);
    };
    const forMeet = repo.forMeet.bind(repo);
    let injected = false;
    repo.forMeet = (scope) => {
      const scoped = forMeet(scope);
      const entriesOf = scoped.sportsMeetEntries;
      return {
        ...scoped,
        sportsMeetEntries: {
          ...entriesOf,
          async list() {
            const entries = await entriesOf.list();
            if (!injected) {
              injected = true;
              await repo.transaction(async (tx) => {
                await touchEvent(tx, 'e6', { bumpEntries: true });
                await tx.sportsMeetEntries.set('entry6', {
                  _id: 'entry6', ...meetScope, eventKey: 'e6', status: 'approved', userIds: ['admin'],
                });
              });
            }
            return entries;
          },
        },
      };
    };

    const result = await meetService.finishSportsMeet({}, ctx);
    assert.equal(result.ok, false, '并发审批报名后不得结束运动会');
    assert.match(result.message, /变化/);
    assert.equal((await repo.sportsMeets.getById('m')).status, 'running');
    assert.equal((await repo.sportsMeetEntries.list()).filter(row => row.eventKey === 'e6').length, 1);
    assert.equal((await repo.sportsMeetPublications.list()).filter(row => row.eventKey === 'e6').length, 0);
  });
});
