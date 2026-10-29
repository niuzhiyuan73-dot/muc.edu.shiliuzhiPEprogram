const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const { listSchoolMatches } = require('../miniprogram/services/school-match-service');
const { schoolLiveKey } = require('../miniprogram/utils/school');
const { MATCH_STATUS, MATCH_TYPE } = require('../miniprogram/utils/constants');
const SCOPE = { schoolId: 'muc', association: 'pkb' };
const TIME = '2026-10-22T10:00:00.000Z';
const match = (id, extra = {}) => ({ _id: id, ...SCOPE, teamA: ['a'], teamB: ['b'],
  matchType: MATCH_TYPE.SINGLES, status: MATCH_STATUS.PENDING, pool: 1, eventId: 'event1',
  matchTime: TIME, scoreA: [], scoreB: [], ...extra });

// 独立模拟 SDK 聚合管道：检查真实适配器的 match/sort/skip/limit/count，不借用产品筛选器。
function fieldMatches(value, condition) {
  if (condition && typeof condition === 'object') return Object.entries(condition).every(([op, operand]) => {
    if (op === '$type') return operand === 'array' ? Array.isArray(value) :
      typeof value === 'number' || (Array.isArray(value) && value.some(item => typeof item === 'number'));
    if (op === '$not') return !fieldMatches(value, operand);
    if (op === '$exists') return (value !== undefined) === operand;
    if (op === '$nin') return !operand.includes(value);
    if (op === '$lt') return value < operand;
    throw Error(`Unsupported operator ${op}`);
  });
  return Array.isArray(value) ? value.includes(condition) : value === condition;
}
function matches(doc, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === '$and') return condition.every(part => matches(doc, part));
    if (key === '$or') return condition.some(part => matches(doc, part));
    return fieldMatches(doc[key], condition);
  });
}
function cloudDatabase(docs) {
  const calls = [];
  const pipeline = stages => ({
    match: where => pipeline([...stages, ['match', where]]),
    sort: order => pipeline([...stages, ['sort', order]]),
    skip: n => pipeline([...stages, ['skip', n]]),
    limit: n => pipeline([...stages, ['limit', n]]),
    count: field => pipeline([...stages, ['count', field]]),
    end: async () => {
      let rows = docs.slice();
      for (const [stage, value] of stages) {
        if (stage === 'match') rows = rows.filter(doc => matches(doc, value));
        if (stage === 'sort') rows.sort((a, b) => {
          for (const [key, direction] of Object.entries(value)) {
            if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction;
          }
          return 0;
        });
        if (stage === 'skip') rows = rows.slice(value);
        if (stage === 'limit') rows = rows.slice(0, value);
        if (stage === 'count') rows = rows.length ? [{ [value]: rows.length }] : [];
      }
      calls.push({ stages, returned: rows.length });
      return { list: rows };
    },
  });
  return { calls, command: {}, collection: name => {
    assert.equal(name, 'matches');
    return { aggregate: () => pipeline([]) };
  } };
}

const fixtures = [
  ['本地 mock', docs => ({ repo: createSchoolMemoryRepo({ matches: docs }) })],
  ['云端业务内存夹具', docs => ({ repo: createMemoryRepo({ matches: docs }) })],
  ['真实云端查询构造', docs => { const db = cloudDatabase(docs); return { repo: createRepo(db), db }; }],
];

for (const [name, create] of fixtures) {
  test(`${name}：范围、双方参与、组合过滤和计数口径一致，畸形记录不计入`, async () => {
    const docs = [match('a'), match('b', { teamA: ['c'], teamB: ['a'], status: MATCH_STATUS.ACTIVE }),
      match('c', { teamA: ['a'], pool: 2 }), match('d', { eventId: 'other' }),
      match('foreign', { schoolId: 'buaa' }), match('other-sport', { association: 'tt' }),
      match('invalid-array', { teamB: 'b' }), match('invalid-status', { status: '0' }),
      match('invalid-status-array', { status: [MATCH_STATUS.PENDING] }), match('invalid-time', { matchTime: '' })];
    const { repo } = create(docs);
    const page = await repo.forScope(SCOPE).matches.listPage({
      filter: { userId: 'a', pool: 1, eventId: 'event1', status: MATCH_STATUS.ACTIVE }, limit: 10,
    });
    assert.deepEqual(page.rows.map(doc => doc._id), ['b']);
    assert.equal(page.total, 1);
    assert.equal(page.pendingCount, 1, '待确认数忽略 status 筛选，但保留其他条件');
    assert.equal(page.hasMore, false);
  });

  test(`${name}：相同时间按编号稳定翻页，插入新比赛不会让游标页重复`, async () => {
    const docs = ['a', 'b', 'c', 'd'].map(id => match(id));
    const { repo, db } = create(docs);
    const query = repo.forScope(SCOPE).matches;
    const first = await query.listPage({ filter: {}, limit: 2 });
    assert.deepEqual(first.rows.map(doc => doc._id), ['d', 'c']);
    const added = match('z', { matchTime: '2026-10-23T00:00:00.000Z' });
    if (db) docs.push(added); else await query.insert(added);
    const next = await query.listPage({ filter: {}, limit: 2, cursor: { matchTime: TIME, id: 'c' } });
    assert.deepEqual(next.rows.map(doc => doc._id), ['b', 'a']);
    assert.equal(next.total, 5);
    assert.equal(next.hasMore, false);
    const offset = await query.listPage({ filter: {}, limit: 2, offset: 2 });
    assert.deepEqual(offset.rows.map(doc => doc._id), ['c', 'b']);
    const zero = await query.listPage({ filter: {}, limit: 0 });
    assert.equal(zero.rows.length, 0);
    assert.equal(zero.total, 5);
    assert.equal(zero.hasMore, true);
    const pastEnd = await query.listPage({ filter: {}, limit: 100, offset: 1e20 });
    assert.deepEqual(pastEnd.rows, []);
    assert.equal(pastEnd.total, 5);
    assert.equal(pastEnd.hasMore, false);
  });
}

test('云端一万场比赛只回传本页文档及计数，不逐页读取历史台账', async () => {
  const db = cloudDatabase(Array.from({ length: 10000 }, (_, i) => match(String(i).padStart(5, '0'))));
  const page = await createRepo(db).forScope(SCOPE).matches.listPage({ filter: {}, limit: 100 });
  assert.equal(page.total, 10000);
  assert.equal(page.rows.length, 100);
  assert.equal(page.hasMore, true);
  assert.equal(db.calls.length, 3, '一页查询 + 两个 count，次数不随台账增长');
  // 一页查询多取 1 条判 hasMore（2026-10-26 第四轮审查 P-8），另两个 count 各回 1 条。
  assert.equal(db.calls.reduce((sum, call) => sum + call.returned, 0), 103);
  const data = db.calls.find(call => call.stages.some(([stage]) => stage === 'limit'));
  assert.deepEqual(data.stages.find(([stage]) => stage === 'sort')[1], { matchTime: -1, _id: -1 });
  assert.equal(data.stages.find(([stage]) => stage === 'limit')[1], 101, '取 limit + 1 条，多一条只用于判 hasMore');
});

test('列表服务只调用分页原语与一次比分批读，保留归属校验、顺序及首帧比分', async () => {
  const seed = createSchoolDemoSeed();
  seed.matches = ['a', 'b', 'c'].map(id => match(id));
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  const rawScope = repo.forScope;
  repo.forScope = scope => {
    const result = rawScope(scope);
    result.matches.list = () => { throw Error('不允许全量读'); };
    const listPage = result.matches.listPage;
    result.matches.listPage = options => {
      assert.ok(options.limit <= 100, '畸形大 limit 必须收紧到单页上限');
      return listPage(options);
    };
    return result;
  };
  repo.liveScores.getById = () => { throw Error('不允许逐条点读'); };
  let ids;
  repo.liveScores.listByIds = async input => {
    assert.equal(ids, undefined, '只能批读一次');
    ids = input;
    return [
      { _id: schoolLiveKey('a', SCOPE), ...SCOPE, matchId: 'a', pointsA: 5, pointsB: 2 },
      { _id: schoolLiveKey('c', SCOPE), ...SCOPE, schoolId: 'buaa', matchId: 'c', pointsA: 99 },
    ];
  };
  const result = (await listSchoolMatches({ limit: 500 }, ctx)).data;
  assert.deepEqual(result.matches.map(row => row.matchId), ['c', 'b', 'a']);
  assert.deepEqual(ids, ['c', 'b', 'a'].map(id => schoolLiveKey(id, SCOPE)));
  assert.equal(result.matches[0].live, undefined, '跨校实时态不下发');
  assert.equal(result.matches[1].live, undefined, '未开台时不添加比分');
  assert.equal(result.matches[2].live.pointsA, 5);
  const empty = (await listSchoolMatches({ limit: 0 }, ctx)).data;
  assert.deepEqual(empty.matches, []);
  assert.equal(empty.total, 3);
});

test('游标入参和混用 offset 被拒绝，访客不查询台账；事务两端都拒绝分页', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  for (const payload of [{ cursor: false }, { cursor: {} }, { cursor: { id: 'a', matchTime: 'bad' } },
    { cursor: { id: 'a', matchTime: TIME }, offset: 1 }]) {
    assert.equal((await listSchoolMatches(payload, ctx)).data.ok, false);
  }
  const guest = await buildSchoolContext({ repo, actorId: null, scope: SCOPE });
  repo.forScope = () => { throw Error('访客不得查询'); };
  assert.equal((await listSchoolMatches({}, guest)).data.ok, false);
  for (const memory of [createSchoolMemoryRepo(), createMemoryRepo()]) {
    await assert.rejects(memory.transaction(tx => tx.forScope(SCOPE).matches.listPage({ limit: 1 })), /事务内/);
  }
});

/**
 * 游标类型统一（2026-10-29 第十一轮审计 P2-7）
 * ============================================================
 * 这里原本返回 `{matchTime, id}` 对象，而公告 / 成员 / 分组 / 训练的 nextCursor
 * 都是不透明字符串——同名同义两种类型，任何「把游标原样回传」的封装都会在比赛
 * 这一路踩成 `[object Object]`。现在统一为 `matchTime|id` 字符串：
 *   · 能原样回传续读，两页不重不漏；
 *   · 非法串必须被拒，而不是静默退回第一页（那会让「翻不动」看起来像「到底了」）。
 */
test('比赛游标是不透明字符串：可原样回传续读，非法串被拒', async () => {
  const seed = createSchoolDemoSeed();
  seed.matches = ['a', 'b', 'c', 'd', 'e'].map(id => match(id));
  const repo = createSchoolMemoryRepo(seed);
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });

  const first = (await listSchoolMatches({ limit: 2 }, ctx)).data;
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, 'string', '游标必须是字符串，不能是对象');
  assert.ok(first.nextCursor.length > 0);
  assert.ok(first.nextCursor.includes('|'), '编码形如 matchTime|id');

  const second = (await listSchoolMatches({ limit: 2, cursor: first.nextCursor }, ctx)).data;
  assert.equal(second.ok, true, '字符串游标应当被接受');
  const ids = [...first.matches, ...second.matches].map(row => row.matchId);
  assert.equal(new Set(ids).size, ids.length, '两页之间不重复');

  // 非法串：段数不对 / 编码坏掉 / 空段
  for (const bad of ['not-a-cursor', `${first.nextCursor}|x`, 'abc|']) {
    assert.equal((await listSchoolMatches({ cursor: bad }, ctx)).data.ok, false, `非法游标必须拒绝：${bad}`);
  }
  // 对象游标仍然接受（内部调用与旧客户端）
  assert.equal((await listSchoolMatches({ limit: 2, cursor: { matchTime: TIME, id: 'a' } }, ctx)).data.ok, true);
});
