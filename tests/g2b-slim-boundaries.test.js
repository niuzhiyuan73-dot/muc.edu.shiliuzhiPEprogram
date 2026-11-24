/**
 * T-03 (G2b) 客户端瘦身、Mock 剥离、分包下沉与重型组件拆分护栏测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, ext, out);
    else if (!ext || p.endsWith(ext)) out.push(p);
  }
  return out;
}

describe('T-03 (G2b) 客户端瘦身与边界护栏', () => {
  test('miniprogram/ 下不得存在向包外（src/server、src/mock 等）的 require', () => {
    const leaks = [];
    for (const file of walk(MINI, '.js')) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
        const target = spec.startsWith('/')
          ? path.join(MINI, spec)
          : path.resolve(path.dirname(file), spec);
        if (!target.startsWith(MINI)) {
          leaks.push(`${path.relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(leaks, [], `发现客户端引用包外模块：\n${leaks.join('\n')}`);
  });

  test('9 个纯模拟/种子文件已彻底迁出 miniprogram/ 至 src/mock/', () => {
    const mockFiles = [
      'school-mock.js', 'school-memory-repo.js', 'school-seed.js',
      'meet-seed.js', 'seed.js', 'team-demo.js',
      'football-demo.js', 'college-cup-seed.js', 'demo-clock.js',
    ];
    for (const name of mockFiles) {
      assert.equal(fs.existsSync(path.join(MINI, 'services', name)), false, `miniprogram/services/${name} 不应存在`);
      assert.equal(fs.existsSync(path.join(ROOT, 'src', 'mock', name)), true, `src/mock/${name} 应存在`);
    }
  });

  test('主包 services/ 与 utils/ 中不存在仅被单一分包独占的模块', () => {
    const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
    const roots = new Set(app.subPackages.map((p) => p.root));
    const pkgOf = (abs) => {
      const head = path.relative(MINI, abs).split(path.sep)[0];
      return roots.has(head) ? head : 'main';
    };

    const callersByTarget = new Map();
    for (const file of walk(MINI, '.js')) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
        const raw = spec.startsWith('/') ? path.join(MINI, spec) : path.resolve(path.dirname(file), spec);
        const norm = path.relative(MINI, raw.endsWith('.js') ? raw : `${raw}.js`).replace(/\\/g, '/');
        if (!callersByTarget.has(norm)) callersByTarget.set(norm, new Set());
        callersByTarget.get(norm).add(pkgOf(file));
      }
    }

    const singleSubpkgLeaks = [];
    for (const file of walk(MINI, '.js')) {
      const rel = path.relative(MINI, file).replace(/\\/g, '/');
      if (!/^(services|utils)\//.test(rel)) continue;
      const pkgs = [...(callersByTarget.get(rel) || [])];
      if (pkgs.length === 1 && pkgs[0] !== 'main') {
        singleSubpkgLeaks.push(`${rel} -> ONLY ${pkgs[0]}`);
      }
    }
    assert.deepEqual(singleSubpkgLeaks, [], `发现主包遗留单分包独占模块：\n${singleSubpkgLeaks.join('\n')}`);
  });

  test('app.json preloadRule 禁止 network:"all"，且首页不预载 packageMeet', () => {
    const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
    for (const [page, rule] of Object.entries(app.preloadRule || {})) {
      assert.notEqual(rule.network, 'all', `${page} 不得配置 network: "all"`);
    }
    const indexRule = app.preloadRule && app.preloadRule['pages/index/index'];
    assert.ok(indexRule, '首页应保留 preloadRule');
    assert.equal(indexRule.packages.includes('packageMeet'), false, '首页不得预载低频分包 packageMeet');
  });

  test('school-mock-loader 未注入 provider 时抛出明确提示，注入后正常返回', () => {
    const loaderPath = require.resolve('../miniprogram/services/school-mock-loader.js');
    delete require.cache[loaderPath];
    const freshLoader = require('../miniprogram/services/school-mock-loader.js');
    assert.throws(
      () => freshLoader.loadSchoolMock(),
      /客户端已剥离本地模拟数据/,
    );
    const sentinel = { reset() {} };
    freshLoader.registerMockProvider(() => sentinel);
    assert.equal(freshLoader.loadSchoolMock(), sentinel);
    // 恢复测试环境 provider，避免影响同进程其它用例
    require('./helpers/register-mock.js');
  });

  test('association-space-panel 与 match-panel 均已完成模块化拆分且外壳精简', () => {
    const spaceDir = path.join(MINI, 'components', 'association-space-panel');
    for (const f of ['group-tab.js', 'notice-tab.js', 'training-tab.js', 'member-tab.js',
      'group-tab.wxml', 'notice-tab.wxml', 'training-tab.wxml', 'member-tab.wxml']) {
      assert.equal(fs.existsSync(path.join(spaceDir, f)), true, `缺少拆分文件 ${f}`);
    }
    const spaceShellLines = fs.readFileSync(path.join(spaceDir, 'association-space-panel.js'), 'utf8').split(/\r?\n/).length;
    assert.ok(spaceShellLines <= 500, `association-space-panel.js 外壳应 <= 500 行，实际 ${spaceShellLines}`);

    const matchDir = path.join(MINI, 'components', 'match-panel');
    assert.equal(fs.existsSync(path.join(matchDir, 'match-actions.js')), true, '缺少 match-actions.js');
    const matchShellLines = fs.readFileSync(path.join(matchDir, 'match-panel.js'), 'utf8').split(/\r?\n/).length;
    assert.ok(matchShellLines <= 500, `match-panel.js 外壳应 <= 500 行，实际 ${matchShellLines}`);
  });
});
