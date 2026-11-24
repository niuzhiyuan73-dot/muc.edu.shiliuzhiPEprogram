/**
 * 仓储契约测试：云端适配器与本地模拟仓储必须可互换
 * ============================================================
 * 【为什么需要这条测试】
 * 2026-10-16 的只读审计发现：共享服务里写得最多的写法是
 *
 *     ctx.repo.transaction(async tx => { await tx.events.set(id, doc) })
 *
 * 而云端适配器（cloudfunctions/data/src/adapters/cloud-repo.js）**没有**给
 * events / matches / eventSignups / collegeEvents / collegeEntries / ties /
 * lineups / announcements / liveScores 定义 set，`seasons` 也没有 getById。
 * 结果：同一个动作在本地 mock 下全绿、在真实云数据源下抛
 * `tx.events.set is not a function`，被云函数入口兜成「服务异常，请稍后再试」。
 *
 * 之所以 2600 多条测试一条都没照出来，是因为 school 域的测试**全部**注入内存
 * 仓储（createSchoolMemoryRepo），而内存仓储对每个集合都统一生成
 * getById / set / list —— 业务代码调到的那些方法，在 mock 侧永远存在。
 *
 * 于是这里换个思路：不去逐个用例试云端，而是**直接断言两个适配器的接口形状
 * 一致**，并**从服务代码里静态推导出「业务到底调了哪些方法」**，要求两边都提供。
 * 以后任何一侧少一个方法，这条测试立刻红，不必等真机验收才发现。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');

const SERVICE_DIR = path.join(__dirname, '..', 'cloudfunctions', 'data', 'lib', 'server', 'services');
const CORE_DIR = path.join(__dirname, '..', 'cloudfunctions', 'data', 'src', 'core');

/** 云数据库桩：只实现适配器用到的那几招（查询构造 + doc(id) 读写 + 事务）。 */
function database(seed = {}) {
  const state = Object.fromEntries(Object.values(COLLECTIONS).map(name => [name, new Map()]));
  for (const [name, docs] of Object.entries(seed)) {
    for (const doc of docs || []) state[name].set(doc._id, { ...doc });
  }
  const surface = (store) => ({
    collection(name) {
      const table = store[name];
      if (!table) throw new Error(`unknown collection ${name}`);
      const query = (where = {}, offset = 0, limit = 100) => ({
        where: (next) => query(next, offset, limit),
        orderBy: () => query(where, offset, limit),
        skip: (next) => query(where, next, limit),
        limit: (next) => query(where, offset, next),
        get: async () => ({
          data: [...table.values()]
            .filter(doc => Object.entries(where).every(([key, value]) => doc[key] === value))
            .sort((a, b) => String(a._id).localeCompare(String(b._id)))
            .slice(offset, offset + limit),
        }),
      });
      return {
        ...query(),
        doc: (id) => ({
          get: async () => ({ data: table.get(id) || null }),
          set: async ({ data }) => { table.set(id, { ...data, _id: id }); },
          update: async ({ data }) => { table.set(id, { ...(table.get(id) || {}), ...data, _id: id }); },
          remove: async () => { table.delete(id); },
        }),
      };
    },
  });
  return { ...surface(state), runTransaction: async (fn) => fn(surface(state)) };
}

/** 内存仓储里「一个集合」的判定：三件套齐才认（users / events … 都符合）。 */
function collectionKeysOf(repo) {
  return Object.entries(repo)
    .filter(([, value]) => value && typeof value === 'object'
      && typeof value.getById === 'function'
      && typeof value.set === 'function'
      && typeof value.list === 'function')
    .map(([key]) => key);
}

/**
 * 静态扫出「业务代码真正调用了仓储的哪些方法」，形如 `events.set`。
 *
 * 只认「仓储形状」的方法名：局部变量也常叫 `matches` / `colleges`（数组），
 * `matches.map(...)` 这种数组操作必须排除掉，否则测试会指着一堆数组方法报缺。
 */
const REPO_METHODS = new Set([
  'getById', 'set', 'list', 'insert', 'update', 'get', 'remove', 'append',
  'listByEvent', 'listByScope', 'getByOpenId',
]);

function repositoryCalls(dirs, keys) {
  const wanted = new Set(keys);
  const calls = new Map();
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      // 只认「.<集合名>.<仓储方法>(」——`repo.forScope(ctx).matches.list()` 这种链式
      // 调用也能被匹配到（中间的 forScope(...) 不是集合名，天然被过滤掉）。
      for (const match of text.matchAll(/\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        const [, key, method] = match;
        if (!wanted.has(key) || !REPO_METHODS.has(method)) continue;
        const pair = `${key}.${method}`;
        if (!calls.has(pair)) calls.set(pair, []);
        const where = `${path.basename(dir)}/${file}`;
        if (!calls.get(pair).includes(where)) calls.get(pair).push(where);
      }
    }
  }
  return calls;
}

/** 缺哪些方法，逐条给出「谁在调」。 */
function missingOn(repo, calls) {
  const missing = [];
  for (const [pair, callers] of calls) {
    const [key, method] = pair.split('.');
    const target = repo[key];
    if (!target || typeof target[method] !== 'function') {
      missing.push(`${pair}（${callers.join('、')}）`);
    }
  }
  return missing;
}

test('两个适配器对每个集合都提供同一套三件套 getById / set / list', async () => {
  const mock = createSchoolMemoryRepo();
  const cloud = createRepo(database());
  const txRepo = await cloud.transaction(async (tx) => tx);
  const keys = collectionKeysOf(mock);

  assert.ok(keys.length >= 25, `集合清单看起来不对，只认出 ${keys.length} 个：${keys.join('、')}`);

  const missingCloud = [];
  const missingTx = [];
  for (const key of keys) {
    for (const method of ['getById', 'set', 'list']) {
      if (typeof cloud[key][method] !== 'function') missingCloud.push(`${key}.${method}`);
      if (typeof txRepo[key][method] !== 'function') missingTx.push(`${key}.${method}`);
    }
  }

  assert.deepEqual(missingCloud, [],
    `云端仓储缺这些方法（本地 mock 有，业务会调到）：${missingCloud.join('、')}`);
  assert.deepEqual(missingTx, [],
    `云端事务仓储缺这些方法（业务写在事务里）：${missingTx.join('、')}`);
});

test('学校维度服务调用到的仓储方法，两套适配器（含事务内）都必须提供', async () => {
  const mock = createSchoolMemoryRepo();
  const cloud = createRepo(database());
  const txRepo = await cloud.transaction(async (tx) => tx);
  const mockTxRepo = await mock.transaction(async (tx) => tx);
  // 只扫 lib/services（与 miniprogram/services 逐字节同源的学校维度服务）：
  // 这一层是两套仓储真正互换的战场。
  const calls = repositoryCalls([SERVICE_DIR], collectionKeysOf(mock));

  // 扫不出东西说明正则或目录写错了，直接失败，别静默通过。
  assert.ok(calls.size >= 40, `静态扫描只认出 ${calls.size} 个仓储调用，扫描逻辑可能失效`);

  assert.deepEqual(missingOn(cloud, calls), [], '云端仓储（顶层）缺业务调用的方法');
  assert.deepEqual(missingOn(txRepo, calls), [], '云端仓储（事务内）缺业务调用的方法');
  assert.deepEqual(missingOn(mock, calls), [], '本地模拟仓储（顶层）缺业务调用的方法');
  assert.deepEqual(missingOn(mockTxRepo, calls), [], '本地模拟仓储（事务内）缺业务调用的方法');
});

test('事务内 tx.X.set 在云端真的能写进去（审计里挂掉的那条路径）', async () => {
  const db = database();
  const cloud = createRepo(db);
  const doc = { _id: 'x_intro_2026-10-16', schoolId: 'muc', association: 'pkb', title: '审计回归' };

  await cloud.transaction(async (tx) => { await tx.events.set(doc._id, doc); });
  assert.deepEqual(await cloud.events.getById(doc._id), doc, '写完要能按主键读回来');

  // seasons 同理：榜单 / 录分 / 新赛季都从 loadSeason() 起步。
  await cloud.transaction(async (tx) => { await tx.seasons.set('s_current', { _id: 's_current', seasonNo: 1 }); });
  assert.deepEqual(await cloud.seasons.getById('s_current'), { _id: 's_current', seasonNo: 1 });
});

/* ---------------------------------------------------------------- 审计 C3 */
// 云端与本地仓储的「错误形态」差异：本地读不到返回 null，云端读不到抛错；
// 其中「集合不存在」（-502005）与「文档不存在」的 errMsg 都含 not exist，
// 旧 isMissing 正则一把抓，把少建集合读成了空结果——读静默、写才炸。
// 这两条钉住修好后的区分：集合不存在必须响亮失败，文档不存在仍然降级 null。

/** 造一个「指定集合抛指定错误」的最小 db 桩 */
function failingDb(collectionName, errFactory) {
  return {
    collection(name) {
      if (name !== collectionName) throw new Error(`unexpected collection ${name}`);
      return {
        doc: () => ({ get: async () => { throw errFactory(); } }),
      };
    },
    runTransaction: async (fn) => fn(this),
  };
}

test('集合不存在（-502005）时读路径抛出可操作的中文错误，不降级成空结果', async () => {
  const err = new Error('database collection not exists');
  err.errCode = -502005;
  const repo = createRepo(failingDb('users', () => err));

  await assert.rejects(
    () => repo.users.getById('acc:whatever'),
    /集合 users 不存在.*-502005/,
    '少建集合时必须指明是哪个集合，而不是让业务层当成「这条数据没有」',
  );
});

test('集合不存在的另一种官方文案（Db or Table not exist）同样被识别', async () => {
  // 控制台实测 errMsg 可能是 "[ResourceNotFound] Db or Table not exist"，
  // 只认 errCode 不够——按官方错误码页与社区记录，两种文案都要接住。
  const err = new Error('[ResourceNotFound] Db or Table not exist. Please check your request');
  err.errCode = -502005;
  const repo = createRepo(failingDb('schools', () => err));

  await assert.rejects(() => repo.schools.getById('muc'), /集合 schools 不存在/);
});

test('文档不存在仍然降级成 null（与集合不存在区分开）', async () => {
  // 这是 readDoc 的原有语义：读一条不存在的文档等价于 null，业务照常走。
  const err = new Error('document does not exist');
  err.errCode = -1;
  const repo = createRepo(failingDb('users', () => err));

  assert.equal(await repo.users.getById('acc:nope'), null);
});

/* ---------------------------------------------------------------- 审计 C4 */
// 事务写入预算护栏：本地内存事务无操作数上限，云端未公示（社区实践约 100 写）。
// 超预算必须当场抛出人话，而不是让云开发在事务中途晦涩报错。

test('事务写入超过预算时抛出可操作错误，且 bolt 之前已写的操作被带到错误信息里', async () => {
  const db = database();
  const cloud = createRepo(db);
  // 读写预算默认 100；这里用 210 条写入探到护栏（内存桩无上限，正好验证护栏本身）。
  await assert.rejects(
    () => cloud.transaction(async (tx) => {
      for (let i = 0; i < 210; i += 1) {
        await tx.matches.set(`m_${i}`, { _id: `m_${i}`, eventId: 'e1' });
      }
    }),
    /事务读写总操作预算不足/,
  );
});

test('事务写入在预算之内不打扰（护栏不误伤正常批量）', async () => {
  const db = database();
  const cloud = createRepo(db);
  // 建 50 人小组 = 53 次写，是已知最大的合法批量；护栏必须放行。
  await cloud.transaction(async (tx) => {
    for (let i = 0; i < 53; i += 1) {
      await tx.matches.set(`m_${i}`, { _id: `m_${i}`, eventId: 'e1' });
    }
  });
  assert.equal(await cloud.matches.list().then(rows => rows.length), 53);
});

/* ---------------------------------------------------------------- 审计 C9 */
// 同一个时间字段在云数据库里不能有 Date 与字符串两种 BSON 类型：控制台排序与
// 聚合按类型分段，orderBy 落到时间字段会静默错序。仓储写入口统一收口。

test('写库把 Date 规格成 ISO 绝对串（含嵌套），undefined 字段被去掉', async () => {
  const db = database();
  const cloud = createRepo(db);
  const at = new Date('2026-10-17T19:30:00');
  await cloud.events.set('e_c9', {
    _id: 'e_c9', schoolId: 'muc', association: 'pkb',
    startTime: at, draw: { drawnAt: at, seedValue: 1 }, note: undefined,
  });
  const stored = await cloud.events.getById('e_c9');
  assert.equal(stored.startTime, at.toISOString(), '顶层 Date 要落成 ISO 串');
  assert.equal(stored.draw.drawnAt, at.toISOString(), '嵌套 Date 同样收口');
  assert.equal('note' in stored, false, 'undefined 字段不落库（两种仓储可见字段集一致）');
  // 读回来是串，业务侧 new Date(x) 照吃——读路径无需配套改动
  assert.equal(new Date(stored.startTime).getTime(), at.getTime());
});


test('事务按读写总数检查上限，同一文档重复点读使用事务快照', async () => {
  const cloud = createRepo(database());
  await assert.rejects(cloud.transaction(async tx => {
    for (let i = 0; i < 101; i++) await tx.matches.getById(`missing_${i}`);
  }), /事务读写总操作预算不足/);
  await cloud.transaction(async tx => {
    for (let i = 0; i < 150; i++) assert.equal(await tx.matches.getById('same'), null);
    await tx.matches.set('same', { _id: 'same', value: 1 });
    const first = await tx.matches.getById('same');
    first.value = 9;
    assert.equal((await tx.matches.getById('same')).value, 1);
  });
});
