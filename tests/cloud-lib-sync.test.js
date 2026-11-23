/**
 * 云函数共享库镜像守卫
 * ============================================================
 * cloudfunctions/data/lib/ 是 miniprogram/ 里纯模块的副本（原因见
 * tools/sync-cloud-lib.js 的文件头）。副本一旦落后于源文件，云端就会用
 * 旧算法算分，而本地测试全绿——这种错误最难发现。
 *
 * 所以这里做两件事：
 *   1. 逐字节比对，防止漂移；
 *   2. 逐个 require，证明镜像自洽（不依赖清单以外的文件）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MANIFEST, SRC_ROOT, DEST_ROOT } = require('../tools/sync-cloud-lib.js');

test('镜像文件与源文件逐字节一致', () => {
  const drifted = [];
  const missing = [];

  for (const rel of MANIFEST) {
    const srcPath = path.join(SRC_ROOT, rel);
    const destPath = path.join(DEST_ROOT, rel);

    if (!fs.existsSync(destPath)) {
      missing.push(rel);
      continue;
    }
    if (!fs.readFileSync(destPath).equals(fs.readFileSync(srcPath))) {
      drifted.push(rel);
    }
  }

  assert.deepEqual(missing, [], '以下文件没有同步到云函数镜像，请运行 node tools/sync-cloud-lib.js');
  assert.deepEqual(drifted, [], '以下文件已漂移（源文件改了但镜像没更新），请运行 node tools/sync-cloud-lib.js');
});

test('清单里每个源文件都存在', () => {
  for (const rel of MANIFEST) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, rel)), `清单里的源文件不存在：${rel}`);
  }
});

test('镜像模块都能独立加载，不依赖清单以外的文件', () => {
  for (const rel of MANIFEST) {
    const destPath = path.join(DEST_ROOT, rel);
    assert.doesNotThrow(
      () => require(destPath),
      `镜像模块 ${rel} 加载失败——说明它依赖了清单以外的文件`
    );
  }
});

test('镜像里的结算内核与源文件算出的结果完全一致', () => {
  // 镜像在磁盘上是一份独立文件，必然是独立的模块实例——这是设计使然。
  // 真正要守住的是「同一份输入得到同一份输出」，所以这里跑一遍比对结果
  // （旧回放引擎已删除，改用逐场结算内核）。
  const source = require('../miniprogram/services/school-rating-service.js');
  const mirror = require(path.join(DEST_ROOT, 'services', 'school-rating-service.js'));

  const SCOPE = { schoolId: 'muc', association: 'pkb' };
  const now = '2026-04-08T10:00:00Z';
  const match = {
    _id: 'm1', ...SCOPE, matchType: 1, pool: 'singles',
    teamA: ['u01'], teamB: ['u02'],
    scoreA: [11], scoreB: [7], winner: 'A',
    matchTime: '2026-04-08T18:00:00Z',
  };

  async function run(mod) {
    const created = [];
    const store = new Map();
    const ratingOf = (userId) => store.get(`${userId}|singles`) || null;
    const tx = {
      users: { getById: async (id) => ({ _id: id, gender: id === 'u02' ? 'F' : 'M' }) },
      // 结算内核现在会读会员行上的按协会初始分；假事务给一个空会员行即可。
      schoolMembers: { getById: async () => null },
      memberRatings: {
        getById: async (id) => ratingOf(id),
        set: async (id, doc) => { store.set(id, doc); },
      },
      ratingCounters: {
        getById: async () => null,
        set: async () => {},
      },
    };
    const result = await mod.settleMatchInTransaction(tx, { ...SCOPE, now }, match, {});
    created.push(...store.values());
    return { settlement: result.settlement, ratings: created };
  }

  return Promise.all([run(source), run(mirror)]).then(([a, b]) => {
    assert.deepEqual(b.settlement, a.settlement, '镜像与源文件的结算快照必须一致');
    assert.deepEqual(b.ratings, a.ratings, '镜像与源文件的评级结果必须一致');
  });
});
