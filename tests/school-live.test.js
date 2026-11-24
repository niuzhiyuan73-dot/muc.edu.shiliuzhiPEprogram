/**
 * 学校维度：实时比分状态机（迁移清单 M1-c）
 *
 * 守的是：开台 / 判球 / 撤销 / 定稿 / 批量读的权限与幂等与旧栈同口径，
 * 实时态钉在 `schoolId + association` 上，跨校读不到也写不进。
 * 逐球重算、定稿只交「打完的局」等纯逻辑由 live-score.js 的既有用例覆盖，本片
 * 只验学校维度的归属与权限来源。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const handlers = require('../src/server/services/school-live-service');
const matchHandlers = require('../src/server/services/school-match-service');
const { schoolMemberKey, schoolMatchKey, schoolKey, schoolLiveKey } = require('../src/shared/utils/school');
const { MATCH_TYPE, MATCH_STATUS } = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member');
  add('demo_muc_member_2');
  add('demo_muc_member_3');
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

/** 与 call 同路数，换成比赛读端的处理器（验证读端是否带 live）。 */
async function callMatch(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await matchHandlers[action](payload, ctx)).data;
}

async function seedMatch(repo, { id = 'm1', bestOf = 3, status = MATCH_STATUS.PENDING,
  teamA = ['demo_muc_member'], teamB = ['demo_muc_member_2'] } = {}) {
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_member', id), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA, teamB,
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status, revision: 1,
  });
  return matchId;
}

/** 连判 n 球给某一方；每球带唯一编号，避开幂等去重。 */
async function rallies(repo, matchId, side, n, prefix) {
  for (let i = 0; i < n; i += 1) {
    await call(repo, 'recordSchoolRally', { matchId, side, rallyId: `${prefix}-${side}-${i}` });
  }
}

for (const action of ['startSchoolLiveScore', 'recordSchoolRally', 'undoSchoolRally', 'finishSchoolLiveScore']) {
  for (const mutation of ['account', 'membership', 'referee', 'match', 'role']) {
    test(`${action}：事务前 ${mutation} 改变后拒绝，实时态及比赛不变`, async () => {
      const repo = fixture();
      const matchId = await seedMatch(repo, { bestOf: 1 });
      await call(repo, 'startSchoolLiveScore', { matchId });
      await rallies(repo, matchId, 'A', action === 'finishSchoolLiveScore' ? 11 : 1, 'before');
      const transaction = repo.transaction;
      let beforeMatch;
      const beforeLive = await repo.liveScores.getById(schoolLiveKey(matchId, { schoolId: 'muc', association: 'pkb' }));
      repo.transaction = async work => {
        const actor = mutation === 'role' ? 'demo_muc_admin' : 'demo_muc_member';
        if (mutation === 'role') {
          const key = require('../src/shared/utils/school').schoolRoleKey(actor, 'muc');
          await repo.schoolRoles.set(key, { ...await repo.schoolRoles.getById(key), status: 'disabled' });
        }
        if (mutation === 'account') await repo.users.set(actor, { ...await repo.users.getById(actor), platformStatus: 'disabled' });
        if (mutation === 'membership') {
          const key = schoolMemberKey(actor, 'muc');
          await repo.schoolMembers.set(key, { ...await repo.schoolMembers.getById(key), status: 'left' });
        }
        if (mutation === 'referee') await repo.matches.set(matchId, { ...await repo.matches.getById(matchId), referee: 'demo_muc_member_3' });
        if (mutation === 'match') await repo.matches.set(matchId, { ...await repo.matches.getById(matchId), status: MATCH_STATUS.ACTIVE });
        beforeMatch = await repo.matches.getById(matchId);
        return transaction(work);
      };
      const result = await call(repo, action, { matchId, side: 'A', rallyId: 'after-revoke' },
        { actor: mutation === 'role' ? 'demo_muc_admin' : 'demo_muc_member' });
      assert.equal(result.ok, false, result.message);
      assert.deepEqual(await repo.matches.getById(matchId), beforeMatch);
      assert.deepEqual(await repo.liveScores.getById(beforeLive._id), beforeLive);
    });
  }
}

test('开台：参赛者可开，非参赛会员被拒；重开不重置比分', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);

  const denied = await call(repo, 'startSchoolLiveScore', { matchId }, { actor: 'demo_muc_member_3' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /无权/);

  const started = await call(repo, 'startSchoolLiveScore', { matchId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.live.status, 'live');
  assert.equal(started.live.matchId, matchId);

  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  const again = await call(repo, 'startSchoolLiveScore', { matchId });
  assert.equal(again.live.pointsA, 1, '重开不重置比分');
});

test('判球：逐球累计，同一球编号幂等，非法方向被拒', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });

  const a = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(a.live.pointsA, 1);
  const dup = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(dup.live.pointsA, 1, '同编号不重复计一次');
  const b = await call(repo, 'recordSchoolRally', { matchId, side: 'B', rallyId: 'r2' });
  assert.equal(b.live.pointsB, 1);

  const bad = await call(repo, 'recordSchoolRally', { matchId, side: 'X', rallyId: 'r3' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不合法/);
});

test('未开台不能判球；已生效的比赛不能开台', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  const noTable = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(noTable.ok, false);
  assert.match(noTable.message, /还没开/);

  const activeId = await seedMatch(repo, { id: 'm2', status: MATCH_STATUS.ACTIVE });
  const blocked = await call(repo, 'startSchoolLiveScore', { matchId: activeId });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已生效|已作废/);
});

test('撤销：撤最后一球并回退进度；无球可撤被拒', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });

  const none = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(none.ok, false);
  assert.match(none.message, /没有可撤销/);

  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  const undo = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(undo.ok, true, undo.message);
  assert.equal(undo.live.pointsA, 0);
});

test('折叠之后：更早的判球撤不回来，文案要说清（第三轮 X-13）', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo, { bestOf: 5 });
  await call(repo, 'startSchoolLiveScore', { matchId });
  // A、B 各两局 = 44 球，越过折叠阈值；2:2 仍在进行中
  await rallies(repo, matchId, 'A', 11, 'f1');
  await rallies(repo, matchId, 'B', 11, 'f2');
  await rallies(repo, matchId, 'A', 11, 'f3');
  await rallies(repo, matchId, 'B', 11, 'f4');

  const before = await call(repo, 'startSchoolLiveScore', { matchId });
  assert.ok(before.live.folded && before.live.folded.count > 0, '44 球应当已经折叠过');

  let last;
  for (let i = 0; i < 60; i += 1) {
    last = await call(repo, 'undoSchoolRally', { matchId });
    if (!last.ok) break;
  }
  assert.equal(last.ok, false, '撤到窗口底部应当停下');
  assert.match(last.message, /已归档/,
    '撤空窗口后要说「更早的判球已归档」，不能沿用「没有可撤销的判球」——那会让裁判以为一球都没判过');
  const base = before.live.folded.base;
  assert.equal(last.live.gamesA + last.live.gamesB, base.gamesA + base.gamesB,
    '分数停在折叠水位，不是回到 0:0');
});

test('整场打完后不能再判球', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await rallies(repo, matchId, 'A', 11, 'g1');
  await rallies(repo, matchId, 'A', 11, 'g2');

  const afterEnd = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'z' });
  assert.equal(afterEnd.ok, false);
  assert.match(afterEnd.message, /已经结束/);
});

test('定稿：未打完不能定稿；打完写回待确认的比赛记录', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await rallies(repo, matchId, 'A', 11, 'g1');

  const early = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(early.ok, false);
  assert.match(early.message, /还没打完/);

  await rallies(repo, matchId, 'A', 11, 'g2');
  const done = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.live.finalizedAt != null, true, '定稿盖章');
  assert.equal(done.match.scoreA.join(','), '11,11', '只交打完的局');
  assert.equal(done.match.scoreB.join(','), '0,0');
  assert.equal(done.match.winner, 'A', '胜负由比分推出');
  assert.equal(done.match.status, MATCH_STATUS.PENDING, '定稿后仍待确认');

  const redo = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(redo.ok, false);
  assert.match(redo.message, /定稿/);

  const undo = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(undo.ok, false);
  assert.match(undo.message, /定稿/);
});

test('批量读：只读本范围，跨校读不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });

  const mine = await call(repo, 'getSchoolLiveScores', { matchIds: [matchId] });
  assert.equal(mine.ok, true);
  assert.equal(mine.scores.length, 1);
  assert.equal(mine.scores[0].pointsA, 1);

  const buaa = await call(repo, 'getSchoolLiveScores', { matchIds: [matchId] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.scores.length, 0);
});

test('跨校：外校开台被判找不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  const buaa = await call(repo, 'startSchoolLiveScore', { matchId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /找不到/);
});

test('比赛读端带实时比分：开台后首屏即实时值，跨校读不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);

  const idle = await callMatch(repo, 'listSchoolMatches', {});
  assert.equal(idle.matches[0].live, undefined, '没开台就不带 live');

  await call(repo, 'startSchoolLiveScore', { matchId });
  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });

  const list = await callMatch(repo, 'listSchoolMatches', {});
  assert.equal(list.matches[0].live.pointsA, 1, '开台后读端即实时值，不会先 0:0 再跳');

  const one = await callMatch(repo, 'getSchoolMatch', { matchId });
  assert.equal(one.match.live.pointsA, 1);

  const buaa = await callMatch(repo, 'listSchoolMatches', {},
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.matches.length, 0, '跨校读不到');
});

test('实时态带范围：schoolId + association，主键含范围', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  const stored = await repo.liveScores.getById(schoolLiveKey(matchId, { schoolId: 'muc', association: 'pkb' }));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(stored.matchId, matchId);
});

/**
 * 判球不读全院名单（2026-10-22 第二轮审查 P-1）
 * ============================================================
 * `guard()` 原来每一球都调 `buildDirectory`：全校在册名单 + 这批人的账号，
 * 2000 人的学校就是 40 次 RPC。一场 50 球的比赛光"确认权限"就要 2000 次读，
 * 几个场地并行就能把全校每日读配额（5 万次）打空。
 *
 * 判球真正需要的只有"操作者自己的学院"，以及（仅学院负责人这一档）这场两队
 * 选手的学院。这里直接钉行为：连判 5 球，一次全院名单都不许读。
 */
test('判球不读全院名单：每球不触发 buildDirectory', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });

  let rosterReads = 0;
  const rawMemberList = repo.schoolMembers.list;
  repo.schoolMembers.list = (...args) => { rosterReads += 1; return rawMemberList(...args); };
  if (typeof repo.users.listByIds === 'function') {
    const rawByIds = repo.users.listByIds;
    repo.users.listByIds = (...args) => { rosterReads += 1; return rawByIds(...args); };
  }

  await rallies(repo, matchId, 'A', 5, 'noread');
  assert.equal(rosterReads, 0, '判球不该读全院在册名单（那是每球 40 次 RPC 的来源）');
});

test('学院负责人判球：只读这场两队成员的学院，且权限判定仍然正确', async () => {
  const { schoolMembershipKey } = require('../src/shared/utils/school');
  const seed = createSchoolDemoSeed();
  [['demo_muc_member', 'c01'], ['demo_muc_member_2', 'c01'], ['demo_muc_member_3', 'c01']]
    .forEach(([id, collegeId]) => {
      seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
        platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
      seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
        collegeId, studentId: id, status: 'active', simulated: true });
    });
  // demo_muc_member_3 是 c01 的学院负责人：这一档才会走到 involvesCollege，
  // 也就是"这位操作者的学院，是否等于某个参赛者的学院"。
  seed.memberships.push({
    _id: schoolMembershipKey('demo_muc_member_3', { schoolId: 'muc', association: 'pkb' }),
    userId: 'demo_muc_member_3', schoolId: 'muc', association: 'pkb',
    role: 'staff', collegeId: 'c01', status: 'active',
  });
  const repo = createSchoolMemoryRepo(seed);
  const matchId = await seedMatch(repo);   // 两队都是 c01 的人
  await call(repo, 'startSchoolLiveScore', { matchId });

  let rosterReads = 0;
  const rawMemberList = repo.schoolMembers.list;
  repo.schoolMembers.list = (...args) => { rosterReads += 1; return rawMemberList(...args); };

  const scored = await call(repo, 'recordSchoolRally',
    { matchId, side: 'A', rallyId: 'staff-1' }, { actor: 'demo_muc_member_3' });
  assert.equal(scored.ok, true, `同学院负责人应能计分：${scored.message}`);
  assert.equal(scored.live.pointsA, 1);
  assert.equal(rosterReads, 0, '学院负责人判球也只读两队成员，不读全院名单');
});

/**
 * 判球编号的入参校验（2026-10-22 第二轮审查 S-2／B-4）
 * ============================================================
 * rallyId 由客户端生成，会原样存进实时态文档、且每次判球整条重写。
 * 一条 1 MB 的编号足以让该场计分台永久写不进去（超单文档上限），
 * 之后既不能继续计分、也不能撤销或定稿。
 */
test('判球编号缺失或超长被拒，且不写入任何状态', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  const liveKey = schoolLiveKey(matchId, { schoolId: 'muc', association: 'pkb' });

  const missing = await call(repo, 'recordSchoolRally', { matchId, side: 'A' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /判球编号无效/);

  const huge = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'x'.repeat(5000) });
  assert.equal(huge.ok, false);
  assert.match(huge.message, /判球编号无效/);

  const state = await repo.liveScores.getById(liveKey);
  assert.equal(state.pointsA, 0, '被判据拒掉的请求不能留下分数');
  assert.equal((state.rallies || []).length, 0, '更不该把超长编号写进流水');
});

test('正常格式的判球编号（含 matchId 里的 % :）可以通过', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  const okRally = await call(repo, 'recordSchoolRally',
    { matchId, side: 'A', rallyId: `${matchId}-1750000000000-1` });
  assert.equal(okRally.ok, true, okRally.message);
  assert.equal(okRally.live.pointsA, 1);
});
