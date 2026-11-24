const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// 执行真实缓存实现，仅替换昂贵的底层生成器，精确控制首次初始化完成的时刻。
function cacheFixture(runMeetDemo) {
  const source = fs.readFileSync(require.resolve('../src/mock/meet-seed'), 'utf8');
  const start = source.indexOf('let meetRecordsSnapshotJson = null;');
  assert.ok(start > 0);
  const context = { module: { exports: {} }, JSON, runMeetDemo,
    MEET_EDITIONS: [2025, 2026, 2027], DUMP_KEYS: ['sportsMeets'], editionOptions: year => ({ year }),
    SCHOOL: 'muc', MEET_NAME: 'test' };
  vm.runInNewContext(source.slice(start), context);
  return context.module.exports.createMeetDemoRecords;
}
const edition = year => ({ repo: { sportsMeets: { list: async () => [{ _id: String(year), nested: { score: 1 } }] } } });

test('并发 reset 在冷缓存时只生成一份三届记录，且每位调用者获得独立副本', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const create = cacheFixture(async ({ year }) => { runs++; await gate; return edition(year); });
  const pending = Array.from({ length: 30 }, () => create());
  assert.equal(runs, 1, '首届未完成时，后来的调用必须共享它');
  release();
  const records = await Promise.all(pending);
  assert.equal(runs, 3, '三届各跑一次');
  records[0].sportsMeets[0].nested.score = 99;
  assert.equal(records[1].sportsMeets[0].nested.score, 1);
  assert.equal((await create()).sportsMeets[0].nested.score, 1);
  assert.equal(runs, 3, '热缓存不重新生成');
});

test('初始化失败会传给所有等待者并清理任务，随后可重试且副本保持隔离', async () => {
  let runs = 0;
  const create = cacheFixture(async ({ year }) => {
    if (++runs === 1) throw Error('seed failed');
    return edition(year);
  });
  const results = await Promise.allSettled([create(), create(), create()]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'seed failed'));
  assert.equal(runs, 1);
  assert.equal((await create()).sportsMeets.length, 3);
  assert.equal(runs, 4);
});
