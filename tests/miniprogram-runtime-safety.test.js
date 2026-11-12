/**
 * 小程序运行时的安全边界（2026-10-23 真机白屏事故）
 * ============================================================
 * 【事故】身份上下文缓存里用了 `process.env` / `process.argv`。
 * 单元测试跑在 Node 里，`process` 一直都在，**全绿**；真机上小程序运行时
 * 没有 `process`，于是 `school-context.js` 在 require 阶段就抛
 * `ReferenceError: process is not defined`，首页直接白屏。
 *
 * 【为什么要两条断言】
 *   1. **静态扫描**：`miniprogram/` 下任何模块都不得直接碰 Node 专有 API。
 *      它防的是"以后再写一个"——这类错误在本地永远测不出来；
 *   2. **环境模拟**：用 `node:vm` 在一个**没有 process 的沙箱**里加载模块，
 *      它防的是"当前这个文件是否真的可加载"，比静态扫描更接近真机。
 *
 * 只靠扫描会漏（比如 `typeof process` 判断写错），只靠模拟又得逐个模块写沙箱，
 * 所以两条都要。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** 小程序包里禁止出现的 Node 专有写法。 */
const FORBIDDEN = [
  { pattern: /\bprocess\s*\./, label: 'process.', why: '小程序运行时没有 process' },
  { pattern: /\bBuffer\s*[.(]/, label: 'Buffer', why: '小程序没有 Buffer' },
  { pattern: /__dirname|__filename/, label: '__dirname/__filename', why: '小程序没有模块目录概念' },
];

/**
 * Node 内建模块的 require 单独查（第十七轮 P2-2）。
 *
 * 下面的 stripCommentsAndStrings 会把 `require('fs')` 洗成 `require('')`，
 * 所以原先放在 FORBIDDEN 里的第 4 条规则**永远匹配不到**。这里只去注释、
 * 保留字符串，在原始调用形态上判定。
 */
const NODE_BUILTIN_REQUIRE = /require\(\s*['"](node:|fs|path|crypto|os|child_process)[^'"]*['"]\s*\)/g;

function findNodeBuiltinRequires(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return [...withoutComments.matchAll(NODE_BUILTIN_REQUIRE)].map(match => match[1]);
}

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 去掉注释与字符串字面量，避免把文档里提到的 `process` 当成真用法。 */
function stripCommentsAndStrings(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 白名单：确实需要读环境变量、但已经做过环境判断的模块。
 *
 * 静态扫描分不清「裸写 process」与「typeof process 之后再用」，所以对这类文件
 * 放行——前提是它必须同时被下面的沙箱用例覆盖（在无 process 环境里能加载）。
 * **新增条目要给出理由，并且补一条沙箱用例**，否则白名单就会变成漏洞清单。
 */
const ALLOWED = new Map([
  ['miniprogram/services/context-cache.js',
    'TTL 需要读环境变量；已用 hasNodeProcess() 判环境，并由本书第二条用例在无 process 沙箱里验证'],
]);

describe('小程序端不得使用 Node 专有 API', () => {
  test('miniprogram/ 下没有任何裸 process / Buffer / Node 内建', () => {
    const offenders = [];
    for (const file of listJs(path.join(ROOT, 'miniprogram'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const code = stripCommentsAndStrings(source);
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(code)) {
          offenders.push(`${rel} → ${rule.label}（${rule.why}）`);
        }
      }
      for (const builtin of findNodeBuiltinRequires(source)) {
        offenders.push(`${rel} → require('${builtin}'…)（小程序不支持 Node 内建模块）`);
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件会让真机在 require 阶段直接崩，本地测试却全绿：\n  ${offenders.join('\n  ')}`);
  });

  test('Node 内建 require 不会被「去字符串」步骤洗掉', () => {
    assert.deepEqual(findNodeBuiltinRequires("const fs = require('fs');"), ['fs']);
    assert.deepEqual(findNodeBuiltinRequires("const p = require('node:path');"), ['node:']);
    assert.deepEqual(findNodeBuiltinRequires("// 文档说明：require('fs') 只是举例"), []);
    assert.deepEqual(findNodeBuiltinRequires("const x = require('./local.js');"), []);
  });

  test('身份上下文缓存在没有 process 的环境里能加载，并自动关闭', () => {
    const file = path.join(ROOT, 'miniprogram', 'services', 'context-cache.js');
    const code = fs.readFileSync(file, 'utf8');
    const mod = { exports: {} };
    // 沙箱里刻意不给 process —— 与微信小程序运行时一致
    const sandbox = {
      module: mod, exports: mod.exports, console,
      Map, Set, Number, Boolean, String, Array, Object, Math, Date, RegExp, JSON,
    };
    vm.runInNewContext(code, sandbox);
    assert.equal(typeof mod.exports.isReadAction, 'function', '模块没导出预期接口');
    assert.equal(mod.exports.stats().ttlMs, 0,
      '小程序端必须关闭缓存：那里不跑 handleSchoolRequest，开着只会带来陈旧权限的风险');
    assert.equal(mod.exports.isReadAction('getSchoolRanking'), false, '关闭时任何动作都不该命中');
  });

  test('沙箱里加载 school-context 不会因为缓存模块而崩', () => {
    const ctxFile = path.join(ROOT, 'miniprogram', 'services', 'school-context.js');
    const code = fs.readFileSync(ctxFile, 'utf8');
    const mod = { exports: {} };
    const calls = [];
    const sandbox = {
      module: mod,
      exports: mod.exports,
      console,
      Map, Set, Number, Boolean, String, Array, Object, Math, Date, RegExp, JSON, Promise,
      require: (id) => {
        calls.push(id);
        // school-context 依赖 utils/school 与 ./context-cache：
        // 前者是纯常量模块，后者由本文件第二条用例单独验过。
        if (id === '../utils/school.js') {
          return require(path.join(ROOT, 'miniprogram', 'utils', 'school.js'));
        }
        return require(path.join(ROOT, 'miniprogram', 'services', 'context-cache.js'));
      },
    };
    vm.runInNewContext(code, sandbox);
    assert.equal(typeof mod.exports.buildSchoolContext, 'function');
    assert.deepEqual(calls.sort(), ['../utils/school.js', './context-cache.js']);
  });
});
