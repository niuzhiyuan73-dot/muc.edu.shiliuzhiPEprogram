#!/usr/bin/env node
/**
 * 提交前敏感信息扫描
 * ============================================================
 * 拦住"不该进版本库"的两类东西：
 *
 *   1. 账号级信息：小程序 AppID、云开发环境 ID、腾讯云密钥、私钥证书
 *   2. 个人资料：手机号、身份证号
 *
 * 【为什么还要这个钩子】
 * .gitignore 挡得住日常误提交，但挡不住 `git add -f`，也挡不住把 AppID
 * 直接写进某个 .js 或 .md 里。这里按「路径 + 内容」双保险：
 * 路径命中即拦（含法务文书、证书文件），内容命中再报行号。
 *
 * 【怎么用】
 *   npm run hooks:install     一次性把 core.hooksPath 指到 .githooks
 *   npm run check:secrets     手动扫全仓已跟踪文件（发布前过一遍）
 *   git commit --no-verify    确认是误报时跳过（慎用，会被记录在历史里）
 *
 * 退出码：0 通过；1 命中；2 运行环境异常。
 * ============================================================
 */

const { execFileSync } = require('node:child_process');

/** 超过这个大小的文本不再逐行扫，避免拖慢提交 */
const MAX_BYTES = 1024 * 1024;

/** 二进制文件按扩展名直接跳过（读了也是乱码） */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.docx', '.xlsx', '.pptx', '.pdf', '.zip', '.rar', '.7z', '.gz',
  '.mp3', '.mp4', '.mov', '.woff', '.woff2', '.ttf', '.otf', '.pyc',
]);

/**
 * 路径级规则：命中即拦，不看内容。
 * 这些文件要么本身含账号信息，要么根本不该进仓库。
 */
const BLOCKED_PATHS = [
  { re: /(^|\/)project\.config\.json$/, why: '含小程序 AppID，应只留本地' },
  { re: /(^|\/)project\.private\.config\.json$/, why: '开发者工具本地配置' },
  { re: /^miniprogram\/config\.js$/, why: '含云开发环境 ID，应只留本地' },
  { re: /^法务文书\//, why: '法务文书含个人与学校信息' },
  { re: /\.(pem|p12|key|cer)$/i, why: '密钥或证书' },
  { re: /(^|\/)\.env(\.|$)/, why: '环境变量文件' },
  { re: /(^|\/)cloudbaserc\.json$/, why: 'CloudBase 配置含 envId' },
];

/** 占位符不算泄漏：示例文件里本来就要写形状 */
function looksLikePlaceholder(value) {
  return /x{4,}|X{4,}|<|>|\u586b|\u4f60\u7684|your|example|xxx/i.test(value);
}

/** 测试用的假号码（含四位以上连号）不算泄漏 */
function looksLikeFakePhone(number) {
  return /(\d)\1{3,}/.test(number);
}

/**
 * 内容级规则。
 * skip(path) 为真时该规则不作用于这个文件（测试与 mock 里本来就有假数据）。
 */
const CONTENT_RULES = [
  {
    name: '小程序 AppID',
    re: /\bwx[0-9a-f]{16}\b/g,
  },
  {
    name: '云开发环境 ID',
    re: /CLOUD_ENV_ID\s*=\s*['"]([^'"]+)['"]/g,
    usable: (m) => !looksLikePlaceholder(m[1]),
  },
  {
    name: '云开发环境 ID',
    re: /["']envId["']\s*:\s*["']([^"']+)["']/g,
    usable: (m) => !looksLikePlaceholder(m[1]),
  },
  {
    name: '腾讯云密钥',
    re: /\bAKID[0-9A-Za-z]{13,}\b/g,
  },
  {
    name: '私钥内容',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: '身份证号',
    re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },
  {
    name: '手机号',
    re: /\b1[3-9]\d{9}\b/g,
    usable: (m) => !looksLikeFakePhone(m[0]),
    skip: (path) => /(^|\/)(tests?|fixtures?)\//.test(path) || /(mock|demo|seed|example)/i.test(path),
  },
];

/** 把敏感值打码后再打印，终端和日志里都不留全量 */
function mask(value) {
  const text = String(value);
  if (text.length <= 6) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function isBinaryByExt(file) {
  const dot = file.lastIndexOf('.');
  return dot >= 0 && BINARY_EXT.has(file.slice(dot).toLowerCase());
}

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

/** 取暂存区里的文件列表（新增/修改/改名，不含删除） */
function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']).toString('utf8');
  return out.split('\0').filter(Boolean);
}

/** 取已跟踪的全部文件，用于全仓体检 */
function trackedFiles() {
  const out = git(['ls-files', '-z']).toString('utf8');
  return out.split('\0').filter(Boolean);
}

/** 取暂存区版本的正文；读不到就返回 null（跳过，不阻断提交） */
function stagedContent(file) {
  try {
    return git(['show', `:${file}`]);
  } catch {
    return null;
  }
}

function readWorktree(file) {
  try {
    return require('node:fs').readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * 扫描一份内容，返回命中列表。
 * 导出出来便于手工验证，不依赖 git 状态。
 */
function scanText(file, text) {
  const hits = [];

  for (const rule of CONTENT_RULES) {
    if (rule.skip && rule.skip(file)) continue;
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      if (rule.usable && !rule.usable(match)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      hits.push({ file, line, name: rule.name, value: mask(match[0]) });
      // 同一行同一规则只报一次，避免长文件刷屏
      if (hits.filter((h) => h.file === file && h.line === line && h.name === rule.name).length > 1) {
        hits.pop();
      }
    }
  }

  return hits;
}

function scanFile(file, buffer) {
  const hits = [];

  const blocked = BLOCKED_PATHS.find((item) => item.re.test(file));
  if (blocked) hits.push({ file, line: 0, name: '受保护路径', value: blocked.why });

  if (!buffer || buffer.length > MAX_BYTES || isBinaryByExt(file)) return hits;
  if (buffer.includes(0)) return hits; // 二进制内容，跳过

  return hits.concat(scanText(file, buffer.toString('utf8')));
}

function report(hits, scope) {
  if (!hits.length) {
    console.log(`✔ ${scope}未发现账号级信息或个人资料`);
    return 0;
  }

  console.error(`\n✖ ${scope}被拦下：发现 ${hits.length} 处疑似敏感信息\n`);
  for (const hit of hits) {
    const where = hit.line ? `${hit.file}:${hit.line}` : hit.file;
    console.error(`  ${where.padEnd(46)} ${hit.name.padEnd(12)} ${hit.value}`);
  }
  console.error('\n这些内容不应进入版本库。处理办法：');
  console.error('  · 配置类：改用同目录的 *.example.* 模板，真实值只留本地');
  console.error('  · 代码里的常量：挪进本地 config，或换成占位符');
  console.error('  · 确属误报：git commit --no-verify（会在历史里留下记录）');
  console.error('');
  return 1;
}

function main() {
  const all = process.argv.includes('--all');
  const files = all ? trackedFiles() : stagedFiles();
  const reader = all ? readWorktree : stagedContent;

  if (!files.length) {
    console.log('✔ 暂存区为空，无需扫描');
    return 0;
  }

  const hits = files.flatMap((file) => scanFile(file, reader(file)));
  return report(hits, all ? '全仓检查：' : '提交前扫描：');
}

module.exports = { scanText, scanFile, mask, looksLikeFakePhone, looksLikePlaceholder };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error('[pre-commit] 扫描器自身出错：', error && error.message);
    process.exit(2);
  }
}
