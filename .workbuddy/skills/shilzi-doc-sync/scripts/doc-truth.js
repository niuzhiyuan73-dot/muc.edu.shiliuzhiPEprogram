#!/usr/bin/env node
/**
 * 从代码算文档真值。
 *
 * 只做一件事：把「文档里会写的那些数字」从源码里读出来，输出一次。
 * 不读任何文档 —— 这是关键，读文档就成了「用旧值校对旧值」。
 *
 * 用法：
 *   node doc-truth.js              人读格式
 *   node doc-truth.js --json       JSON（供 doc-audit 或其他脚本消费）
 *   node doc-truth.js --cases=N    附带用例数（只能实跑 npm test 得到）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function countFiles(dir, suffix) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return 0;
  return fs.readdirSync(abs).filter((n) => n.endsWith(suffix)).length;
}

function collectFacts() {
  const app = readJson('miniprogram/app.json');
  const subs = app.subpackages || app.subPackages || [];

  const subDetail = {};
  subs.forEach((s) => {
    subDetail[s.root] = (s.pages || []).length;
  });
  const subTotal = Object.values(subDetail).reduce((a, b) => a + b, 0);

  // 四组 action：常量数组长度即注册面大小
  const actions = require(path.join(ROOT, 'src/shared/utils/school-actions.js'));
  const groupKeys = Object.keys(actions).filter((k) => k.endsWith('_ACTIONS'));
  const groups = {};
  groupKeys.forEach((k) => {
    groups[k] = actions[k].length;
  });
  const actionTotal = Object.values(groups).reduce((a, b) => a + b, 0);

  const constants = require(path.join(ROOT, 'src/shared/utils/constants.js'));
  const collections = Object.keys(constants.COLLECTION || {}).length;

  const syncLib = require(path.join(ROOT, 'tools/sync-cloud-lib.js'));
  const manifestCount = (syncLib.MANIFEST || []).length;

  // 实际镜像文件数（含 MANIFEST 之外的遗留文件，两者不等就说明有孤儿）
  const mirrorDir = path.join(ROOT, 'cloudfunctions/data/lib');
  let mirrorActual = 0;
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) mirrorActual += 1;
    });
  })(mirrorDir);

  return {
    root: ROOT,
    pages: {
      main: (app.pages || []).length,
      sub: subDetail,
      subTotal,
      total: (app.pages || []).length + subTotal,
    },
    actions: {
      groups,
      total: actionTotal,
    },
    collections,
    mirrors: {
      manifest: manifestCount,
      actual: mirrorActual,
    },
    testFiles: countFiles('tests', '.test.js'),
    cases: null,
  };
}

function printHuman(f) {
  const groupLine = Object.entries(f.actions.groups)
    .map(([k, v]) => `${k.replace(/^SCHOOL_|_ACTIONS$/g, '')} ${v}`)
    .join(' + ');
  const subLine = Object.entries(f.pages.sub)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  const mirrorFlag = f.mirrors.manifest === f.mirrors.actual ? '' : '  ⚠ 清单与实际不一致';

  console.log('=== 石榴籽文档真值 ===');
  console.log(`页面       主包 ${f.pages.main} + 分包 ${f.pages.subTotal} = ${f.pages.total}`);
  console.log(`  分包明细   ${subLine}`);
  console.log(`action     ${groupLine} = ${f.actions.total}`);
  console.log(`集合       ${f.collections}`);
  console.log(`镜像       ${f.mirrors.actual}（清单 ${f.mirrors.manifest}）${mirrorFlag}`);
  console.log(`测试文件   ${f.testFiles}`);
  console.log(
    f.cases === null
      ? '用例       —（需 --cases=N，或先跑 npm test 取值）'
      : `用例       ${f.cases}`
  );
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const casesArg = argv.find((a) => a.startsWith('--cases='));

  let facts;
  try {
    facts = collectFacts();
  } catch (err) {
    console.error(`真值计算失败：${err.message}`);
    console.error(`项目根推断为：${ROOT}`);
    process.exit(2);
  }

  if (casesArg) {
    const n = Number(casesArg.split('=')[1]);
    if (Number.isFinite(n) && n > 0) facts.cases = n;
  }

  if (jsonMode) console.log(JSON.stringify(facts, null, 2));
  else printHuman(facts);
}

module.exports = { collectFacts, ROOT };
