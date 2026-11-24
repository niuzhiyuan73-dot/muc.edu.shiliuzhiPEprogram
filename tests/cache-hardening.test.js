// 缓存加固与日期校验（2026-10-28 审计 2：C-1 / P-1 / B-1）
//
// 这三条都是「本地全绿、线上才疼」的类型：缓存竞态要并发交错才现形，学院目录多读
// 几十条只在按量计费时体现，日期进位则要日历上不存在的日才会遇到。这里各钉一条。
process.env.RATE_LIMIT = 'off';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// 取云端镜像实例：handleSchoolRequest 加载的是 cloudfunctions/data/lib 下的同一份。
const contextCache = require('../cloudfunctions/data/lib/server/services/context-cache.js');
const { loadColleges } = require('../src/server/services/college-directory.js');
const { isCalendarDate } = require('../src/server/services/meet-time.js');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

const NOW = new Date('2026-10-13T12:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'pkb' };

/** 数一数这次调用从某集合读了多少条文档。 */
function countingRepo() {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const hits = { colleges: 0 };
  const wrap = (obj) => new Proxy(obj, {
    get(target, key) {
      const value = target[key];
      if (typeof value === 'function') {
        return (...args) => {
          const result = value.apply(target, args);
          const record = (res) => {
            if (key === 'forScope') return wrap(res);
            return res;
          };
          return result && typeof result.then === 'function' ? result.then(record) : record(result);
        };
      }
      if (value && typeof value === 'object' && key !== 'colleges') return wrap(value);
      if (key === 'colleges' && value && typeof value === 'object') {
        const list = value.list;
        const colleges = { ...value, list: async () => {
          const rows = await list();
          hits.colleges += Array.isArray(rows) ? rows.length : 0;
          return rows;
        } };
        return colleges;
      }
      return value;
    },
  });
  return { repo: wrap(repo), hits };
}

test('缓存：读开始早于一次失效的，不写回（否则旧身份会顶掉刚清掉的缓存）', () => {
  contextCache.__setTtlForTest(5000);
  const key = contextCache.keyOf(SCOPE, 'race', '');
  const readStartedAt = Date.now();
  contextCache.invalidateAll();          // 读还在路上，写请求先失效了
  contextCache.set(key, { actor: { _id: 'stale' } }, readStartedAt);
  assert.equal(contextCache.get(key), null, '失效前读到的快照不能回填');
  contextCache.__setTtlForTest(0);
});

test('缓存：读开始晚于失效的，正常写回（不能把好数据也一起丢掉）', () => {
  contextCache.__setTtlForTest(5000);
  const key = contextCache.keyOf(SCOPE, 'fresh', '');
  contextCache.invalidateAll();
  const readStartedAt = Date.now() + 1;
  contextCache.set(key, { actor: { _id: 'fresh' } }, readStartedAt);
  assert.deepEqual(contextCache.get(key), { actor: { _id: 'fresh' } });
  contextCache.__setTtlForTest(0);
});

test('学院目录：同一个仓储第二次不再整表读，两个仓储之间不串味', async () => {
  const first = countingRepo();
  const ctx = { repo: first.repo, schoolId: 'muc', association: 'pkb' };
  const a = await loadColleges(ctx);
  const afterFirst = first.hits.colleges;
  const b = await loadColleges(ctx);
  assert.equal(a.length, b.length);
  assert.ok(afterFirst > 0, '第一次应当真的读库');
  assert.equal(first.hits.colleges, afterFirst, '第二次应当命中缓存，不再读 colleges');

  // 换一个仓储实例（等于换了一所学校/一次重启）不能拿到别人的缓存
  const second = countingRepo();
  await loadColleges({ repo: second.repo, schoolId: 'muc', association: 'pkb' });
  assert.ok(second.hits.colleges > 0, '新仓储必须自己读一次');
});

test('日期回读：日历上不存在的日子不算有效日期', () => {
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2026-02-29'), false, '2026 不是闰年');
  assert.equal(isCalendarDate('2024-02-29'), true, '2024 是闰年');
  assert.equal(isCalendarDate('2026-02-30'), false, 'Date.parse 会把它进位成 03-02');
  assert.equal(isCalendarDate('2026-04-31'), false);
});

test('发起运动会：2026-02-30 被拒，不再原样落库', async () => {
  const repo = createMemoryRepo(createSchoolDemoSeed());
  const call = (action, payload = {}) => handleSchoolRequest(
    { protocolVersion: 2, ...SCOPE, action, payload },
    { repo, openId: 'mock_openid_muc_admin', now: NOW },
  );
  const bad = await call('createSportsMeet', {
    name: '日期校验', year: 2026, startDate: '2026-02-30', endDate: '2026-03-10',
    location: '田径场', requestId: 'd1',
  });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.message, /不是有效日期/);

  const good = await call('createSportsMeet', {
    name: '日期校验', year: 2026, startDate: '2026-02-28', endDate: '2026-03-10',
    location: '田径场', requestId: 'd2',
  });
  assert.equal(good.data.ok, true, good.data.message || '');
  assert.equal(good.data.meet.startDate, '2026-02-28');
});
