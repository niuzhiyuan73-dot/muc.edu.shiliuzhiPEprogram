/**
 * 本地工程配置生成（第十七轮审查 P1-1）
 * ============================================================
 * 守的是「干净克隆 / CI 也能跑起来」这件事：仓库只带 example 模板，
 * app.js 却静态 require 正式文件。这里钉住三件事：能从模板生成、不覆盖
 * 本地已填的真实值、模板缺失要报错而不是静默跳过；再把 npm 生命周期与
 * .gitignore 两处接线一起守住，避免改动被后人顺手摘掉。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setupLocalConfig, PAIRS } = require('../tools/setup-local-config.js');

const SETUP_COMMAND = 'node tools/setup-local-config.js';

/** 造一个只含模板的临时仓库，形状与干净克隆一致 */
function tempRepo(withTemplates = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shilzi-config-'));
  if (withTemplates) {
    for (const { from } of PAIRS) {
      const file = path.join(dir, from);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `template:${from}\n`);
    }
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readIn(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('干净克隆：两份本地配置按模板生成，内容逐字一致', () => {
  const root = tempRepo();
  try {
    const { created, kept } = setupLocalConfig(root);
    assert.deepEqual(created, PAIRS.map((pair) => pair.to));
    assert.deepEqual(kept, []);
    for (const { from, to } of PAIRS) {
      assert.equal(readIn(root, to), `template:${from}\n`);
    }
  } finally {
    cleanup(root);
  }
});

test('幂等：已有本地配置原样保留，不覆盖已填的账号级信息', () => {
  const root = tempRepo();
  try {
    for (const { to } of PAIRS) {
      const file = path.join(root, to);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'LOCAL_REAL_VALUE');
    }

    const { created, kept } = setupLocalConfig(root);
    assert.deepEqual(created, []);
    assert.deepEqual(kept, PAIRS.map((pair) => pair.to));
    for (const { to } of PAIRS) {
      assert.equal(readIn(root, to), 'LOCAL_REAL_VALUE');
    }
  } finally {
    cleanup(root);
  }
});

test('模板缺失时明确报错，不把缺失当成「已经配置好」', () => {
  const root = tempRepo(false);
  try {
    assert.throws(() => setupLocalConfig(root), /缺少配置模板/);
  } finally {
    cleanup(root);
  }
});

test('npm 生命周期已挂上生成脚本：npm ci 与 npm test 都能自恢复', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.prepare, SETUP_COMMAND);
  assert.equal(pkg.scripts.pretest, SETUP_COMMAND);
  assert.equal(pkg.scripts['setup:config'], SETUP_COMMAND);
});

test('两个目标文件都在 .gitignore 里，生成物不会进版本库', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8');
  const rules = ignore.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const { to } of PAIRS) {
    assert.ok(rules.includes(to), `${to} 必须被 .gitignore 忽略`);
  }
});
