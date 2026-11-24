/** 统一部署前一键检查：镜像同步 + 声明式索引 + 敏感信息扫描。 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const steps = [
  ['镜像一致性', ['tools/sync-cloud-lib.js', '--check']],
  ['声明式索引', ['tools/check-db-indexes.js']],
  ['敏感信息扫描', ['tools/pre-commit-check.cjs', '--all']],
];

for (const [label, args] of steps) {
  console.log(`\n▶ [${label}] node ${args.join(' ')}`);
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
}

console.log('\n✔ 部署前检查全部通过。');
