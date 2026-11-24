/**
 * 学院队挑人：单次请求的事务预算（2026-10-22 大用户量复查 H-8）
 * ============================================================
 * `addCollegeTeamMembers` 在一个事务里按人「点读判重 + 写入」：每人 2 个操作，
 * 固定开销约 8 个（身份上下文 6、球队 1、队头计数 1）。云端事务预算约 100，
 * 于是 46 人左右就会抛「事务读写总操作预算不足：请缩小本次处理范围」——
 * 纯开发者文案，学院负责人只会看到「服务异常」。
 *
 * 这条测试把「一次挑满整队」钉进预算内，同时守住入口上限：
 * 超限的请求必须在进入事务前就被拒，而不是先花掉一整套读再失败。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const teamService = require('../src/server/services/team-service');
const { schoolMemberKey, schoolMembershipKey, collegeTeamKey } = require('../src/shared/utils/school');

const SCOPE = { schoolId: 'muc', association: 'bk' };
const NOW = new Date('2026-10-20T10:00:00Z');
/** 云端事务预算（cloud-repo.js 的 TX_OPERATION_BUDGET 默认值） */
const CLOUD_TX_BUDGET = 100;
/** 足球院队满编 23 人；这里按「一次挑满 30 人」这个上限给足余量 */
const BATCH = 30;

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c02', studentId: id, status: 'active', simulated: true,
    });
    seed.memberships.push({
      _id: schoolMembershipKey(id, SCOPE),
      userId: id, schoolId: 'muc', association: 'bk', role: 'member', collegeId: 'c02', status: 'active',
    });
  };
  add('staff_c02');
  seed.memberships.find(row => row.userId === 'staff_c02').role = 'staff';
  // 候选人：一批 c02 的在册会员
  const candidates = [];
  for (let i = 1; i <= BATCH + 1; i += 1) {
    const id = `c02_p${String(i).padStart(2, '0')}`;
    add(id);
    candidates.push(id);
  }
  return { repo: createSchoolMemoryRepo(seed), candidates };
}

/** 按云端口径逐事务计数的探针（与 meet-entry-budget.test.js 同一套口径） */
function instrument(repo) {
  const stats = { reads: 0, writes: 0, perTx: [] };
  Object.defineProperty(stats, 'peak', {
    get: () => stats.perTx.reduce((max, tx) => Math.max(max, tx.reads + tx.writes), 0),
  });

  const COUNTED = new Set(['getById', 'set', 'insert', 'update', 'remove']);
  const rawTransaction = repo.transaction;

  const wrap = (surface, scoped, local) => {
    const readIds = new Set();
    return new Proxy(surface, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          if (prop === 'forScope' || prop === 'forMeet') {
            return input => wrap(value.call(target, input), true, local);
          }
          if (prop === 'transaction') return value.bind(target);
          if (COUNTED.has(prop)) {
            return (...args) => {
              const id = typeof args[0] === 'string' ? args[0] : '';
              const isWrite = prop !== 'getById';
              if (isWrite && scoped && id && !readIds.has(id)) {
                stats.reads += 1; local.reads += 1; readIds.add(id);
              } else if (!isWrite && id) {
                stats.reads += 1; local.reads += 1; readIds.add(id);
              }
              if (isWrite) { stats.writes += 1; local.writes += 1; }
              return value.apply(target, args);
            };
          }
          return value.bind(target);
        }
        if (value && typeof value === 'object') return wrap(value, scoped, local);
        return value;
      },
    });
  };

  repo.transaction = async (fn) => {
    const local = { reads: 0, writes: 0 };
    try {
      return await rawTransaction(tx => fn(wrap(tx, false, local)));
    } finally {
      stats.perTx.push(local);
    }
  };
  return { stats, reset() { stats.reads = 0; stats.writes = 0; stats.perTx.length = 0; } };
}

async function call(repo, action, payload = {}, actor = 'staff_c02') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamService[action](payload, ctx)).data;
}

test(`一次挑满 ${BATCH} 人：不超事务预算`, async () => {
  const { repo, candidates } = fixture();
  const probe = instrument(repo);

  // 院队是预置的：读一次就落库
  const team = await call(repo, 'getCollegeTeam', {});
  assert.equal(team.ok, true, team.message);
  assert.equal(team.team.teamId, collegeTeamKey('c02', SCOPE));

  probe.reset();
  const added = await call(repo, 'addCollegeTeamMembers', {
    teamId: team.team.teamId, userIds: candidates.slice(0, BATCH),
  });

  assert.equal(added.ok, true, added.message);
  assert.equal(added.added, BATCH);
  if (process.env.TX_PROBE === '1') {
    probe.stats.perTx.forEach((tx, i) => {
      console.log(`[tx] 第 ${i + 1} 个事务：读 ${tx.reads} / 写 ${tx.writes} / 合计 ${tx.reads + tx.writes}（${BATCH} 人）`);
    });
  }
  assert.ok(
    probe.stats.peak <= CLOUD_TX_BUDGET,
    `最贵的一个事务用了 ${probe.stats.peak} 个操作`
    + `（${probe.stats.perTx.map(tx => tx.reads + tx.writes).join(' / ')}），超过云端预算 ${CLOUD_TX_BUDGET}`,
  );

  // 队头人数要跟上，否则列表页显示的是 0 人
  const after = await call(repo, 'getCollegeTeam', {});
  assert.equal(after.team.memberCount, BATCH);
});

test('超过单次上限的请求在进入事务前被拒，且用业务文案', async () => {
  const { repo, candidates } = fixture();
  const team = await call(repo, 'getCollegeTeam', {});
  const probe = instrument(repo);

  probe.reset();
  const tooMany = await call(repo, 'addCollegeTeamMembers', {
    teamId: team.team.teamId, userIds: candidates,
  });

  assert.equal(tooMany.ok, false);
  // 不能出现「事务读写总操作预算不足」这类开发者文案
  assert.ok(!/事务|预算|操作/.test(tooMany.message), `文案不该暴露实现细节：${tooMany.message}`);
  assert.match(tooMany.message, /最多.*名队员/);
  assert.equal(probe.stats.perTx.length, 0, '超限请求不该开启任何事务');
});

test('分两次挑人能把整队凑满，人数累计正确', async () => {
  const { repo, candidates } = fixture();
  const team = await call(repo, 'getCollegeTeam', {});

  const first = await call(repo, 'addCollegeTeamMembers', {
    teamId: team.team.teamId, userIds: candidates.slice(0, BATCH),
  });
  assert.equal(first.ok, true, first.message);
  // 第 31 个人单独挑一次：队伍总人数不受单次上限约束
  const second = await call(repo, 'addCollegeTeamMembers', {
    teamId: team.team.teamId, userIds: [candidates[BATCH]],
  });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.added, 1);

  const after = await call(repo, 'getCollegeTeam', {});
  assert.equal(after.team.memberCount, BATCH + 1);
});
