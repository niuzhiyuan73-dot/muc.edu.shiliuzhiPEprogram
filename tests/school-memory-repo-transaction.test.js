/**
 * 线上内存仓储的事务与克隆语义
 * ============================================================
 * 注意区分：`helpers/memory-repo.js` 是测试夹具用的精简版，另一组用例
 * （memory-repo-transaction.test.js）守的是它。这里是 **mock 数据源真正在跑的
 * 那份** `services/school-memory-repo.js`。
 *
 * 【为什么要专门守（2026-10-20 性能修正）】
 * 事务原先靠「把整个库深拷贝当草稿」来隔离，每次克隆约两千条文档；
 * page.test.js 里 clone 一项吃掉 47.5% 的 CPU。改成只浅拷贝 Map 之后，
 * 数据隔离全部押在「三个读写入口各自克隆」这一条上：
 *   · getById / list 交出去的都是副本；
 *   · 任何写入都必须走 set()，而 set() 存的是 clone({...doc})。
 * 这是等价的前提，也是最容易被后人无意拆掉的地方（例如图省事让 getById
 * 直接返回原件）。所以钉成断言。
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');

/** 造一个只有一条用户的小库 */
async function freshRepo() {
  const repo = createSchoolMemoryRepo({ users: [{ _id: 'u1', nickName: '甲', points: 1 }] });
  await repo.users.set('u1', { _id: 'u1', nickName: '甲', points: 1 });
  return repo;
}

test('回滚：中途抛错，既有记录复原、新记录不残留', async () => {
  const repo = await freshRepo();
  await assert.rejects(repo.transaction(async (tx) => {
    await tx.users.set('u1', { _id: 'u1', nickName: '甲', points: 99 });
    await tx.users.set('u2', { _id: 'u2', nickName: '乙', points: 5 });
    throw new Error('中途失败');
  }), /中途失败/);

  assert.equal((await repo.users.getById('u1')).points, 1);
  assert.equal(await repo.users.getById('u2'), null);
});

test('提交：正常返回后写入才可见', async () => {
  const repo = await freshRepo();
  await repo.transaction(async (tx) => {
    await tx.users.set('u1', { _id: 'u1', nickName: '甲', points: 7 });
  });
  assert.equal((await repo.users.getById('u1')).points, 7);
});

test('读隔离：改 getById / list 的返回值都碰不到库', async () => {
  const repo = await freshRepo();

  const one = await repo.users.getById('u1');
  one.points = 999;
  assert.equal((await repo.users.getById('u1')).points, 1, 'getById 必须返回副本');

  const all = await repo.users.list();
  all[0].points = 888;
  all.push({ _id: 'u2', points: 0 });
  const again = await repo.users.list();
  assert.equal(again.length, 1, 'list 的数组改动不能影响库');
  assert.equal(again[0].points, 1, 'list 里的文档也必须是副本');
});

test('事务内先写后读：读到的是副本，改它不影响待提交的值', async () => {
  const repo = await freshRepo();
  await repo.transaction(async (tx) => {
    await tx.users.set('u1', { _id: 'u1', nickName: '甲', points: 2 });
    const staged = await tx.users.getById('u1');
    staged.points = -1;
  });
  assert.equal((await repo.users.getById('u1')).points, 2);
});

test('未提交的写入不泄漏到库外', async () => {
  const repo = await freshRepo();
  let seenDuringTx = null;
  await repo.transaction(async (tx) => {
    await tx.users.set('u1', { _id: 'u1', nickName: '甲', points: 42 });
    seenDuringTx = (await repo.users.getById('u1')).points;
  });
  assert.equal(seenDuringTx, 1, '事务未提交时，库外应仍读到旧值');
  assert.equal((await repo.users.getById('u1')).points, 42, '提交后才更新');
});

test('并发事务串行化：两次读改写不丢更新', async () => {
  const repo = createSchoolMemoryRepo({ seasons: [{ _id: 's1', value: 0 }] });
  const bump = () => repo.transaction(async (tx) => {
    const current = await tx.seasons.getById('s1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tx.seasons.set('s1', { ...current, value: current.value + 1 });
  });
  await Promise.all([bump(), bump()]);
  assert.equal((await repo.seasons.getById('s1')).value, 2);
});
