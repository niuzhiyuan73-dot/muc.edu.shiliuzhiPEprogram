/**
 * 三层构建产物自动同步工具（源头唯一：src/shared + src/server）
 * ============================================================
 * 【物理约束】
 *   1. 小程序只打包 miniprogram/ 目录下的文件；
 *   2. 云函数只打包 cloudfunctions/data/ 目录下的文件。
 *
 * 【源头与生成物】
 *   · src/shared/** → 自动复制到 miniprogram/shared/** （客户端共享层）
 *   · src/shared/** → 自动复制到 cloudfunctions/data/lib/shared/**
 *   · src/server/** → 自动复制到 cloudfunctions/data/lib/server/**
 *
 * 无需再手工维护 MANIFEST 列表：新增/删除 src/ 下模块后直接运行
 * `npm run sync:cloud` 即可同步并清理孤儿文件；生成目录禁止手改。
 *
 * 用法：
 *   node tools/sync-cloud-lib.js           # 生成 / 更新镜像并清理孤儿
 *   node tools/sync-cloud-lib.js --check   # 只校验不写入，漂移/缺失/孤儿时退出码为 1
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'src');
const SHARED_SRC = path.join(SRC_ROOT, 'shared');
const SERVER_SRC = path.join(SRC_ROOT, 'server');
const DEST_ROOT = path.join(ROOT, 'cloudfunctions', 'data', 'lib');
const MINI_SHARED_DEST = path.join(ROOT, 'miniprogram', 'shared');

function walkJsRel(baseDir, relPrefix = '') {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = path.join(baseDir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkJsRel(abs, rel));
    } else if (entry.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

const SHARED_FILES = walkJsRel(SHARED_SRC);
const SERVER_FILES = walkJsRel(SERVER_SRC);
const MANIFEST = [
  ...SHARED_FILES.map((rel) => `shared/${rel}`),
  ...SERVER_FILES.map((rel) => `server/${rel}`),
];

function syncPair(srcDir, destDir, relFiles, checkOnly) {
  const missing = [];
  const drifted = [];
  const expectedSet = new Set(relFiles);

  for (const rel of relFiles) {
    const srcPath = path.join(srcDir, rel);
    const destPath = path.join(destDir, rel);
    const srcBuf = fs.readFileSync(srcPath);

    if (checkOnly) {
      if (!fs.existsSync(destPath)) {
        missing.push(rel);
      } else if (!fs.readFileSync(destPath).equals(srcBuf)) {
        drifted.push(rel);
      }
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, srcBuf);
  }

  const existing = walkJsRel(destDir);
  const orphan = [];
  for (const rel of existing) {
    if (!expectedSet.has(rel)) {
      if (checkOnly) {
        orphan.push(rel);
      } else {
        fs.unlinkSync(path.join(destDir, rel));
      }
    }
  }

  if (!checkOnly && fs.existsSync(destDir)) {
    pruneEmptyDirs(destDir);
  }

  return { missing, drifted, orphan };
}

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return true;
  let empty = true;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!pruneEmptyDirs(full)) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty) fs.rmdirSync(dir);
  return empty;
}

/**
 * 同步或校验全部镜像产物（miniprogram/shared + cloudfunctions/data/lib）。
 * @param {boolean} checkOnly 只校验不写入
 */
function sync(checkOnly) {
  const sharedFiles = walkJsRel(SHARED_SRC);
  const serverFiles = walkJsRel(SERVER_SRC);

  // 1. miniprogram/shared/** <-- src/shared/**
  const miniRes = syncPair(SHARED_SRC, MINI_SHARED_DEST, sharedFiles, checkOnly);

  // 2. cloudfunctions/data/lib/{shared,server}/** <-- src/{shared,server}/**
  const cloudManifest = [
    ...sharedFiles.map((rel) => `shared/${rel}`),
    ...serverFiles.map((rel) => `server/${rel}`),
  ];
  const cloudRes = syncPair(SRC_ROOT, DEST_ROOT, cloudManifest, checkOnly);

  const prefix = (tag, arr) => arr.map((r) => `${tag}:${r}`);
  return {
    missing: [...prefix('miniprogram/shared', miniRes.missing), ...prefix('cloudfunctions/data/lib', cloudRes.missing)],
    drifted: [...prefix('miniprogram/shared', miniRes.drifted), ...prefix('cloudfunctions/data/lib', cloudRes.drifted)],
    orphan: [...prefix('miniprogram/shared', miniRes.orphan), ...prefix('cloudfunctions/data/lib', cloudRes.orphan)],
    sharedCount: sharedFiles.length,
    serverCount: serverFiles.length,
    totalCount: cloudManifest.length,
  };
}

function main() {
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    const { missing, drifted, orphan, sharedCount, totalCount } = sync(true);
    if (missing.length > 0 || drifted.length > 0 || orphan.length > 0) {
      console.error('构建镜像产物与源文件不一致：');
      for (const rel of missing) console.error(`  缺少   ${rel}`);
      for (const rel of drifted) console.error(`  已漂移 ${rel}`);
      for (const rel of orphan) console.error(`  孤儿   ${rel}`);
      console.error('请运行：npm run sync:cloud');
      process.exit(1);
    }
    console.log(`共享与云端镜像已同步：客户端 shared ${sharedCount} 个，云端 lib ${totalCount} 个文件。`);
    return;
  }

  const { sharedCount, serverCount, totalCount } = sync(false);
  console.log(`已自动同步：miniprogram/shared (${sharedCount} 文件)、cloudfunctions/data/lib (${totalCount} 文件 = shared ${sharedCount} + server ${serverCount})。`);
}

if (require.main === module) {
  main();
}

module.exports = {
  MANIFEST,
  SHARED_FILES,
  SERVER_FILES,
  SRC_ROOT,
  DEST_ROOT,
  MINI_SHARED_DEST,
  sync,
};
