#!/usr/bin/env node
/**
 * 生成本地工程配置（干净克隆 / CI 的前置步骤）
 * ============================================================
 * 【解决什么】
 * f94d3ba 把 AppID 与云开发环境 ID 移出版本库后，仓库里只剩 `*.example.*`
 * 模板；但 `miniprogram/app.js:12` 仍静态 `require('./config.js')`。干净克隆、
 * CI、换机时这个文件不存在，小程序在 require 阶段就崩（白屏），加载 app.js
 * 的两个测试文件也直接红。
 *
 * 【为什么不改 app.js】
 * 小程序 require 是静态打包依赖，编译期就要求文件存在，try/catch 未必兜得住；
 * 动态探测又会撞上「miniprogram 禁止 Node 专有 API」的运行时红线。让文件在
 * 启动之前存在，比在加载时补救更确定，也不破坏「真实值不入库」的约定。
 *
 * 【幂等】目标文件已存在就跳过，绝不覆盖本地已填的 AppID / 环境 ID。
 * 两个目标文件都在 .gitignore 里，生成物不会进版本库。
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 模板 → 本地正式文件。顺序即生成顺序，新增一对要同步补测试。 */
const PAIRS = Object.freeze([
  { from: 'miniprogram/config.example.js', to: 'miniprogram/config.js' },
  { from: 'project.config.example.json', to: 'project.config.json' },
]);

/**
 * @param {string} [root] 仓库根目录，测试可注入临时目录
 * @returns {{created: string[], kept: string[]}}
 */
function setupLocalConfig(root = ROOT) {
  const created = [];
  const kept = [];

  for (const { from, to } of PAIRS) {
    const src = path.join(root, from);
    const dest = path.join(root, to);
    if (!fs.existsSync(src)) {
      throw new Error(`缺少配置模板：${from}（请从版本库重新拉取）`);
    }
    if (fs.existsSync(dest)) {
      kept.push(to);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    created.push(to);
  }

  return { created, kept };
}

function main() {
  try {
    const { created, kept } = setupLocalConfig();
    if (created.length) console.log(`[setup] 已从模板生成本地配置：${created.join('、')}`);
    if (kept.length) console.log(`[setup] 保留已有本地配置（不覆盖）：${kept.join('、')}`);
  } catch (err) {
    console.error(`[setup] ${err && err.message}`);
    process.exit(1);
  }
}

module.exports = { setupLocalConfig, PAIRS, ROOT };

if (require.main === module) main();
