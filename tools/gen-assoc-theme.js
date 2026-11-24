/**
 * 协会主题样式生成器
 * ============================================================
 * `src/shared/associations/` 是协会主题的唯一真相源；小程序 WXSS 读不到 JS
 * 常量，因此把六套 CSS 变量从插件声明生成到 `miniprogram/styles/assoc-theme.wxss`。
 * 新增协会时只改插件，再执行 `npm run gen:theme`，不再手抄 `app.wxss`。
 *
 * 用法：
 *   node tools/gen-assoc-theme.js           # 生成 / 覆盖
 *   node tools/gen-assoc-theme.js --check   # 只校验，漂移时退出码 1
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'miniprogram', 'styles', 'assoc-theme.wxss');

const { allAssociations } = require('../src/shared/associations/registry.js');
const { buildThemeVars } = require('../src/shared/associations/base.js');

function buildFile() {
  const blocks = allAssociations().map((assoc) => {
    const vars = buildThemeVars(assoc.theme)
      .split(';')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => `  ${item.replace(':', ': ')};`)
      .join('\n');
    return `.assoc-${assoc.id} {\n${vars}\n}`;
  });

  return [
    '/*',
    ' * 协会主题变量（自动生成，请勿手改）',
    ' * 源：src/shared/associations/ 的协会插件 theme',
    ' * 生成：node tools/gen-assoc-theme.js',
    ' */',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const expected = buildFile();

  if (checkOnly) {
    if (!fs.existsSync(OUT)) {
      console.error(`缺少生成文件：${path.relative(ROOT, OUT)}；请运行 npm run gen:theme`);
      process.exit(1);
    }
    // checkout 在 Windows 可能把 LF 翻成 CRLF；比较前统一换行，避免误报漂移。
    const actual = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    if (actual !== expected) {
      console.error(`协会主题样式已漂移：${path.relative(ROOT, OUT)}；请运行 npm run gen:theme`);
      process.exit(1);
    }
    console.log(`协会主题样式已同步：${allAssociations().length} 个协会。`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, expected);
  console.log(`已生成 ${path.relative(ROOT, OUT)}（${allAssociations().length} 个协会）。`);
}

main();
