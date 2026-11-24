/**
 * 镜像里的服务与门面的关系（只读审计 H9）
 * ============================================================
 * 背景：旧门面 `miniprogram/services/index.js` 不在 `tools/sync-cloud-lib.js`
 * 的 MANIFEST 里——镜像之后云端根本没有这个文件。因此镜像里任何一处
 * require 门面，无论写在模块顶层还是函数体内，到了云端都是「找不到模块」。
 *
 * 历史上这里有过**一处例外**：`services/auth.js` 的 `login()` 为规避
 * `mock → auth → index → mock` 循环依赖，把 require 写在函数体内，靠
 * 「云端按 OpenID 取用户，调不到 login()」这条前提登记在白名单里
 * （注释原在 auth.js:240-247）。协议 1 下线后 `login()` 已删除，白名单
 * 随之作废——**本约束因此从「白名单恰好一个」收紧为「一处都不许有」**。
 *
 * 注意不能简单断言「没有任何文件 require './index.js'」了事——将来若有人
 * 真的引入，只会得到一句干巴巴的失败，看不出该去哪儿确认。下面三条各守
 * 一层，报错信息里都写明前因后果：
 *
 *   ① **模块顶层**不许 require 门面——那会让云端连加载都失败（本测试的重点）；
 *   ② 函数体内也不许 require 门面（原白名单项已随 login() 一并删除）；
 *   ③ 门面本身不在 MANIFEST、也不在镜像里（否则 ① 的前提就不成立）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MANIFEST, DEST_ROOT } = require('../tools/sync-cloud-lib');
const LIB_SHARED = path.join(DEST_ROOT, 'shared');
const LIB_SERVER = path.join(DEST_ROOT, 'server');

/** 递归列出目录下的 .js 文件。 */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 找出门面 require：返回 [{ target, line, topLevel }]。 */
function facadeRequires(file) {
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!/(^|\/)index(\.js)?$/.test(match[1])) continue;
      // 顶层 require 顶格写（本项目所有文件都是这个风格）；缩进即「在函数体里」。
      found.push({ target: match[1], line: index + 1, topLevel: line === line.trimStart() });
    }
  });
  return found;
}

const MIRRORED = [...jsFiles(LIB_SHARED), ...jsFiles(LIB_SERVER)];

test('镜像里没有任何文件在模块顶层 require 门面（加载期安全）', () => {
  const offenders = [];
  for (const file of MIRRORED) {
    for (const hit of facadeRequires(file)) {
      if (hit.topLevel) offenders.push(`${path.relative(DEST_ROOT, file)}:${hit.line} → ${hit.target}`);
    }
  }
  assert.deepEqual(offenders, [],
    `顶层 require 门面会让云端加载即失败：\n  ${offenders.join('\n  ')}`);
});

test('镜像里没有任何文件在函数体内 require 门面（原 auth.login 白名单项已删除）', () => {
  const found = [];
  for (const file of MIRRORED) {
    const hits = facadeRequires(file).filter(hit => !hit.topLevel);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      found.push(`${path.relative(DEST_ROOT, file).replace(/\\/g, '/')}:${hit.line} → ${hit.target}`);
    }
  }
  assert.deepEqual(found, [],
    '函数体内 require 门面同样会让云端炸，只是炸得晚一点（调到了才发现）。\n'
    + '历史上唯一在册的一处是 services/auth.js 的 login()，它已随协议 1 删除；\n'
    + '若这里出现新条目，说明有人重新引入了懒加载门面，请确认它真的只在云端调不到的分支里：\n'
    + `  ${found.join('\n  ')}`);
});

test('门面 index.js 本身不在 MANIFEST、也不在镜像里', () => {
  assert.equal(MANIFEST.includes('services/index.js'), false,
    'index.js 若进了镜像，说明有人改了同步清单，请一并复核本测试的前提');
  assert.equal(fs.existsSync(path.join(DEST_ROOT, 'services', 'index.js')), false,
    '镜像目录里出现了 index.js，云端将拿到一个依赖本地 mock 的门面');
});

test('扫描逻辑本身有效：MANIFEST 里的纯模块确实都镜像到了', () => {
  const missing = MANIFEST.filter(rel => !fs.existsSync(path.join(DEST_ROOT, rel)));
  assert.deepEqual(missing, [], `这些清单文件没同步：${missing.join('、')}`);
  assert.ok(jsFiles(path.join(LIB_SERVER, 'services')).length >= 30, '镜像 services 数量异常，扫描目录可能写错了');
});
