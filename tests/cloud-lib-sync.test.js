/**
 * 三层共享与云端构建产物镜像守卫
 * ============================================================
 * src/shared/** -> miniprogram/shared/** （客户端共享层）
 * src/{shared,server}/** -> cloudfunctions/data/lib/{shared,server}/** （云端）
 *
 * 1. 逐字节比对，防止漂移、缺失或残留孤儿文件；
 * 2. 逐个 require 云端镜像，证明自洽（不依赖源目录之外的文件）；
 * 3. 验证结算内核在源模块与云端镜像间输出完全一致。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MANIFEST,
  SHARED_FILES,
  SERVER_FILES,
  SRC_ROOT,
  DEST_ROOT,
  MINI_SHARED_DEST,
} = require('../tools/sync-cloud-lib.js');

function walkJs(dir, relPrefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkJs(abs, rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

test('云端镜像与源文件逐字节一致，且无孤儿文件', () => {
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

  const expected = new Set(MANIFEST);
  const orphan = walkJs(DEST_ROOT).filter((rel) => !expected.has(rel));

  assert.deepEqual(missing, [], '以下文件没有同步到云函数镜像，请运行 npm run sync:cloud');
  assert.deepEqual(drifted, [], '以下文件已漂移（源文件改了但镜像没更新），请运行 npm run sync:cloud');
  assert.deepEqual(orphan, [], '云函数镜像目录存在多余孤儿文件，请运行 npm run sync:cloud');
});

test('客户端 miniprogram/shared 与 src/shared 逐字节一致，且无孤儿文件', () => {
  const drifted = [];
  const missing = [];
  const sharedSrc = path.join(SRC_ROOT, 'shared');

  for (const rel of SHARED_FILES) {
    const srcPath = path.join(sharedSrc, rel);
    const destPath = path.join(MINI_SHARED_DEST, rel);
    if (!fs.existsSync(destPath)) {
      missing.push(rel);
      continue;
    }
    if (!fs.readFileSync(destPath).equals(fs.readFileSync(srcPath))) {
      drifted.push(rel);
    }
  }

  const expected = new Set(SHARED_FILES);
  const orphan = walkJs(MINI_SHARED_DEST).filter((rel) => !expected.has(rel));

  assert.deepEqual(missing, [], 'miniprogram/shared 缺少文件，请运行 npm run sync:cloud');
  assert.deepEqual(drifted, [], 'miniprogram/shared 已漂移，请运行 npm run sync:cloud');
  assert.deepEqual(orphan, [], 'miniprogram/shared 存在多余孤儿文件，请运行 npm run sync:cloud');
});

test('清单里每个源文件都存在', () => {
  assert.ok(SHARED_FILES.length > 0 && SERVER_FILES.length > 0, '源目录扫描不应为空');
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
  const source = require('../src/server/services/school-rating-service.js');
  const mirror = require(path.join(DEST_ROOT, 'server', 'services', 'school-rating-service.js'));

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
