/* 篮球云端专项审计：仅在进程内模拟 SDK，不连接或修改真实云环境。 */
// 审计脚本用同一身份连续打十几个写请求（抽签 → 开台 → 判球 → 重抽 → 锁名单…），
// 会被入口限流按「每秒 3 次写」拦下，后续断言全变成「没有抛错」。这里关掉限流：
// 它模拟的是压测/故障注入，不是真实用户交互（生产默认开启）。
process.env.RATE_LIMIT = 'off';
const assert = require('node:assert/strict');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { schoolKey, schoolMemberKey, schoolMembershipKey } = require('../miniprogram/utils/school');
const { fieldValues } = require('../miniprogram/services/scoped-team-reads');
const scope = { schoolId: 'muc', association: 'bk' };
const { directoryDatabase } = require('./audit-directory-database.cjs');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

/**
 * `db.command` 的最小子集：游标分页（`_id > 上一页末条`）与批读（`_.in`）要用。
 * 只有操作符对象带 CMD 标记，普通值仍按严格相等比较。
 */
const CMD = Symbol('db.command');
const command = {
  gt: value => ({ [CMD]: 'gt', value }),
  gte: value => ({ [CMD]: 'gte', value }),
  lte: value => ({ [CMD]: 'lte', value }),
  lt: value => ({ [CMD]: 'lt', value }),
  neq: value => ({ [CMD]: 'neq', value }),
  or: value => ({ [CMD]: 'or', value }),
  in: value => ({ [CMD]: 'in', value }),
  and: value => ({ [CMD]: 'and', value }),
};
const isCmd = value => Boolean(value && value[CMD]);
function matchRow(row, where) {
  if (!where) return true;
  if (isCmd(where)) {
    if (where[CMD] === 'or') return where.value.some(part => matchRow(row, part));
    return where[CMD] === 'and' ? where.value.every(part => matchRow(row, part)) : false;
  }
  return Object.entries(where).every(([field, cond]) => {
    if (!isCmd(cond)) return fieldValues(row, field).includes(cond);
    if (cond[CMD] === 'and') return cond.value.every(part => matchRow(row, part));
    if (cond[CMD] === 'in') return Array.isArray(cond.value) && fieldValues(row, field).some(value => cond.value.includes(value));
    if (cond[CMD] === 'gt') return String(row[field] ?? '') > String(cond.value ?? '');
    if (cond[CMD] === 'gte') return String(row[field] ?? '') >= String(cond.value ?? '');
    if (cond[CMD] === 'lte') return String(row[field] ?? '') <= String(cond.value ?? '');
    if (cond[CMD] === 'lt') return String(row[field] ?? '') < String(cond.value ?? '');
    if (cond[CMD] === 'neq') return row[field] !== cond.value;
    return false;
  });
}

function database(seed) {
  let state = Object.fromEntries(Object.values(COLLECTIONS).map(name => [name, new Map()]));
  for (const [key, rows] of Object.entries(seed)) {
    if (!COLLECTIONS[key]) continue;
    for (const row of rows) state[COLLECTIONS[key]].set(row._id, clone(row));
  }
  const traces = [];
  let failure;
  const surface = (store, trace) => ({ collection(name) {
    const table = store[name];
    assert.ok(table, name);
    function operation(kind, id) {
      if (trace) {
        trace.push({ kind, name, id });
        if (trace.length > 100) throw new Error('injected cloud contract: >100 transaction operations');
      }
      if (failure && kind === 'set' && name === failure.name && ++failure.seen === failure.nth) {
        failure = null;
        throw new Error('injected RPC failure');
      }
    }
    const query = (where = {}, offset = 0, count = 100, order = []) => ({
      where: next => query(next, offset, count, order),
      orderBy: (field, direction) => query(where, offset, count, [...order, { field, direction }]),
      skip: next => query(where, next, count, order), limit: next => query(where, offset, next, order),
      count: async () => ({ total: [...table.values()].filter(row => matchRow(row, where)).length }),
      get: async () => {
        assert.ok(!trace, 'query forbidden inside transaction');
        return { data: [...table.values()].filter(row => matchRow(row, where))
          .sort((a, b) => {
            for (const { field, direction } of order) {
              const av = a[field] == null ? '' : a[field], bv = b[field] == null ? '' : b[field];
              if (av !== bv) return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1);
            }
            return a._id.localeCompare(b._id);
          }).slice(offset, offset + count).map(clone) };
      },
    });
    return { ...query(), doc: id => {
      assert.equal(typeof id, 'string');
      return {
        get: async () => { operation('get', id); return { data: clone(table.get(id)) || null }; },
        set: async ({ data }) => { operation('set', id); assert.equal(data._id, undefined); table.set(id, { ...clone(data), _id: id }); },
      };
    } };
  } });
  const directory = directoryDatabase(() => Object.fromEntries(Object.entries(state).map(([name, rows]) => [name, [...rows.values()]])));
  const db = {
    collection: name => ({ ...surface(state).collection(name), aggregate: () => directory.collection(name).aggregate() }), traces,
    // 与云开发 db.command 同形的最小子集：仓储的游标分页（_id > 上一页末条）
    // 与批读（_.in）都依赖它。缺了它 createRepo 一用 listByIds 就炸
    // 「Cannot read properties of undefined (reading 'in')」。
    command: { ...command, aggregate: directory.command.aggregate },
    failSet: (key, nth) => { failure = { name: COLLECTIONS[key], nth, seen: 0 }; },
    runTransaction: async fn => {
      if (db.beforeTransaction) { const hook = db.beforeTransaction; db.beforeTransaction = null; await hook(); }
      const scratch = Object.fromEntries(Object.entries(state).map(([name, rows]) => [name,
        new Map([...rows].map(([id, row]) => [id, clone(row)]))]));
      const trace = []; traces.push(trace);
      const result = await fn(surface(scratch, trace));
      state = scratch;
      return result;
    },
  };
  return db;
}
async function fixture({ format = 'single_elim', count = 4, status = 'locked' } = {}) {
  const seed = createSchoolDemoSeed();
  for (const id of ['leader', 'captain']) {
    seed.users.push({ _id: id, openId: `audit_${id}`, nickName: id, platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc', status: 'active', collegeId: 'c01' });
  }
  seed.memberships.push({ _id: schoolMembershipKey('leader', scope), userId: 'leader', ...scope, role: 'leader', status: 'active' });
  const db = database(seed), repo = createRepo(db);
  await repo.teamEvents.set('event', { _id: 'event', ...scope, name: '审计篮球赛', status,
    format, revision: 1, bronzeMode: 'playoff', entryMin: 5, statPolicy: 'basic', rules: { periods: 2 }, startTime: '2026-10-20T08:00:00Z' });
  for (let i = 0; i < count; i++) {
    const teamId = `team${i}`;
    await repo.teams.set(teamId, { _id: teamId, ...scope, name: teamId, status: 'active', captainId: 'captain' });
    const key = schoolKey('ten', 'event', teamId);
    await repo.teamEventEntries.set(key, { _id: key, ...scope, eventId: 'event', teamId,
      status: status === 'registration' ? 'approved' : 'locked',
      roster: Array.from({ length: 5 }, (_, n) => ({ userId: n === 0 ? 'captain' : `${teamId}p${n}`, name: `球员${n}`, no: n })) });
  }
  const call = async (action, payload = {}, actor = 'leader') => {
    const result = await handleSchoolRequest({ protocolVersion: 2, ...scope, action, payload },
      { repo, openId: `audit_${actor}`, now: new Date('2026-10-20T09:00:00Z') });
    return result.data || result;
  };
  const matches = () => repo.forScope(scope).teamMatches.list();
  return { repo, db, call, matches };
}
async function main() {
  const results = [];
  {
    const f = await fixture();
    assert.equal((await f.call('drawTeamEvent', { eventId: 'event' })).ok, true);
    const match = (await f.matches())[0];
    await f.call('startTeamLiveScore', { matchId: match._id });
    await f.call('updateTeamLiveScore', { matchId: match._id, type: 'score', side: 'A', points: 3, operationId: 'live1', expectRevision: 0 });
    const before = await f.repo.teamMatches.getById(match._id);
    const redraw = await f.call('drawTeamEvent', { eventId: 'event' });
    const after = await f.repo.teamMatches.getById(match._id);
    assert.equal(before.liveScore.scoreA, 3);
    assert.equal(redraw.ok, false);
    assert.equal(after.status, 'live');
    assert.equal(after.liveScore.scoreA, 3);
    results.push({ issue: 'LIVE_REDRAW_LOSS', before: { status: before.status, liveScore: 3 }, after: { status: after.status, liveScore: after.liveScore.scoreA }, fixed: true });
  }
  {
    const f = await fixture({ status: 'registration' });
    f.db.failSet('teamEventEntries', 2);
    await assert.rejects(f.call('lockTeamEntries', { eventId: 'event' }), /RPC failure/);
    assert.ok((await f.repo.forScope(scope).teamEventEntries.list()).every(row => row.status === 'approved'));
    const retry = await f.call('lockTeamEntries', { eventId: 'event' });
    const event = await f.repo.teamEvents.getById('event');
    const entries = await f.repo.forScope(scope).teamEventEntries.list();
    assert.equal(retry.locked, 4);
    assert.equal(entries.filter(row => row.status === 'locked').length, 4);
    results.push({ issue: 'LOCK_PARTIAL_COMMIT', eventLockedCount: event.lockedCount, actualLocked: 4 });
  }
  {
    const f = await fixture({ format: 'round_robin' });
    f.db.failSet('teamMatches', 2);
    await assert.rejects(f.call('drawTeamEvent', { eventId: 'event' }), /RPC failure/);
    const event = await f.repo.teamEvents.getById('event');
    assert.equal((await f.matches()).length, 0);
    assert.equal(event.draw, undefined);
    assert.equal((await f.call('drawTeamEvent', { eventId: 'event' })).ok, true);
    assert.equal((await f.matches()).length, 6);
    results.push({ issue: 'DRAW_PARTIAL_COMMIT', rollbackGames: 0, retryGames: 6, fixed: true });
  }
  {
    const f = await fixture({ count: 2 });
    await f.call('drawTeamEvent', { eventId: 'event' });
    const match = (await f.matches())[0];
    await f.call('recordTeamMatch', { matchId: match._id, scoreA: 50, scoreB: 40 });
    await f.call('publishTeamMatch', { matchId: match._id, approve: true });
    f.db.failSet('teamEventEntries', 1);
    await assert.rejects(f.call('settleTeamEvent', { eventId: 'event' }), /RPC failure/);
    const event = await f.repo.teamEvents.getById('event');
    const retry = await f.call('settleTeamEvent', { eventId: 'event' });
    assert.equal(event.status, 'running');
    assert.equal(retry.ok, true);
    results.push({ issue: 'SETTLE_UNRECOVERABLE_PARTIAL_COMMIT', eventStatus: event.status, retryMessage: retry.message,
      entriesWithPlacement: (await f.repo.forScope(scope).teamEventEntries.list()).filter(row => row.placement).length });
  }
  {
    const f = await fixture({ count: 2 });
    await f.call('drawTeamEvent', { eventId: 'event' });
    const match = (await f.matches())[0];
    const user = await f.repo.users.getById('captain');
    await f.repo.users.set('captain', { ...user, platformStatus: 'disabled' });
    const read = await f.call('getTeamEvent', { eventId: 'event' }, 'captain');
    const live = await f.call('startTeamLiveScore', { matchId: match._id }, 'captain');
    const write = await f.call('recordTeamMatch', { matchId: match._id, scoreA: 99, scoreB: 1 }, 'captain');
    assert.equal(read.ok, false); assert.equal(live.ok, false); assert.equal(write.ok, false);
    assert.equal((await f.call('saveTeamMatchStats', { matchId: match._id, players: [{ userId: 'captain', points: 3 }] }, 'captain')).ok, false);
    results.push({ issue: 'DISABLED_CAPTAIN_BYPASS', readAllowed: read.ok, liveAllowed: live.ok, officialWriteAllowed: write.ok });
  }
  {
    const f = await fixture({ count: 2 });
    await f.call('drawTeamEvent', { eventId: 'event' });
    const match = (await f.matches())[0];
    const first = await f.call('startTeamLiveScore', { matchId: match._id });
    const write = await f.call('updateTeamLiveScore', { matchId: match._id, type: 'stat', side: 'A', userId: 'captain', field: 'fouls', delta: 1, operationId: 'stat1', expectRevision: first.live.revision });
    assert.equal(write.ok, true);
    const trace = f.db.traces.at(-1);
    const firstWrite = trace.findIndex(row => row.kind === 'set');
    assert.equal(trace.slice(firstWrite + 1).filter(row => row.kind === 'get').length, 0);
    results.push({ check: 'LIVE_CLOUD_ROUTE_AND_ADAPTER', ok: true, transactionOperations: trace.length,
      readsAfterFirstWrite: trace.slice(firstWrite + 1).filter(row => row.kind === 'get').length });
  }
  {
    const f = await fixture({ count: 2 });
    // 模拟 32 场同轮次（例如 64 队首轮），每场一读 + 范围写前重读 + 一写，再加身份点读。
    await f.repo.teamEvents.set('event', { ...(await f.repo.teamEvents.getById('event')), status: 'scheduled' });
    for (let n = 0; n < 32; n++) await f.repo.teamMatches.set(`large${n}`, { _id: `large${n}`, ...scope,
      eventId: 'event', teamA: 'team0', teamB: 'team1', status: 'scheduled', round: 1, revision: 1, matchTime: '2026-10-20T08:00:00Z' });
    assert.equal((await f.call('updateTeamRoundSchedule', { eventId: 'event', round: 1, shiftMinutes: 10 })).ok, true);
    assert.ok(f.db.traces.at(-1).length <= 100);
    assert.ok((await f.matches()).every(row => row.matchTime === '2026-10-20T08:10:00.000Z'));
    results.push({ issue: 'TX_TOTAL_OPERATION_LIMIT', games: 32, attemptedOperations: f.db.traces.at(-1).length,
      fixed: true, shiftedGames: 32 });
  }
  return results;
}
if (require.main === module) main().then(results => console.log(JSON.stringify(results, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyCloudFixes: main, fixture, database };
