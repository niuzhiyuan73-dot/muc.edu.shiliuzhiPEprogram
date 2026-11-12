/**
 * 提交前敏感信息扫描（第十七轮 P2-1 修正）
 * ============================================================
 * 钉住两个此前能静默绕过的通道：
 *   1. 手机号规则按「路径」整目录豁免 → 真实号写进 mock / demo / tests 不拦；
 *   2. 暂存区 `--diff-filter=ACM` 漏掉 R（重命名）状态 → `git mv` 绕过。
 * 顺带守住「公认假号不误报」，否则正常提交会被拦。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanText, scanFile, looksLikeFakePhone, STAGED_DIFF_FILTER,
} = require('../tools/pre-commit-check.cjs');

// 拼装而非写字面量：本文件提交时同样会被扫描，完整号码会命中自家规则
const REAL_PHONE = ['138', '5678', '1234'].join('');

test('暂存区过滤包含 R/T，重命名文件不能绕过扫描', () => {
  assert.match(STAGED_DIFF_FILTER, /R/, 'git mv 产生的 R 状态必须进入扫描列表');
  assert.match(STAGED_DIFF_FILTER, /T/, '文件类型变更也要扫');
});

test('真实格式手机号在任何路径都拦，包括原先被豁免的目录', () => {
  const paths = [
    'miniprogram/services/school-mock.js',
    'docs/demo说明.md',
    'tests/fixture.js',
    'src/a.js',
  ];
  for (const file of paths) {
    const hits = scanText(file, `const phone = "${REAL_PHONE}";`);
    assert.ok(hits.some(hit => hit.name === '手机号'), `${file} 里的真实号码应被拦`);
  }
});

test('公认假号不误报：四连号、13800138000、顺序号', () => {
  const fake = ['13800138000', '13800000099', '13933334444', '13812345678'];
  for (const number of fake) {
    assert.equal(looksLikeFakePhone(number), true, `${number} 应判为假号`);
    const hits = scanText('src/a.js', `phone: ${number}`).filter(hit => hit.name === '手机号');
    assert.equal(hits.length, 0, `${number} 不该被拦`);
  }
});

test('路径级规则仍拦下法务文书与正式配置', () => {
  assert.ok(scanFile('法务文书/协议.md', Buffer.from('普通文本'))
    .some(hit => hit.name === '受保护路径'));
  assert.ok(scanFile('miniprogram/config.js', Buffer.from('const x = 1;'))
    .some(hit => hit.name === '受保护路径'));
});

test('账号级信息照旧命中，且敏感值打码', () => {
  // 同样拼装：本文件提交时会被扫描，完整 AppID 字面量会命中自家规则
  const fakeAppId = ['wx', '1a2b3c4d5e6f7890'].join('');
  const hits = scanText('src/a.js', `const appid = "${fakeAppId}";`);
  const hit = hits.find(row => row.name === '小程序 AppID');
  assert.ok(hit, 'AppID 应命中');
  assert.ok(hit.value.includes('***'), '打印时要打码');
});

test('.env.example 模板不被路径规则误拦，真实 .env 仍被拦', () => {
  assert.ok(!scanFile('.env.example', Buffer.from('KEY=placeholder'))
    .some(hit => hit.name === '受保护路径'));
  assert.ok(scanFile('.env', Buffer.from('KEY=real'))
    .some(hit => hit.name === '受保护路径'));
});
