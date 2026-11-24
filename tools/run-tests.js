#!/usr/bin/env node
/**
 * 测试运行器：逐文件隔离 + 硬超时 + 过程可见
 * ============================================================
 * 【为什么不用原生的 node --test 通配跑法了】
 * 原生运行器把每个测试文件当子进程跑，但它对「文件迟迟不结束」没有兜底：
 * 只要有一个文件卡住，整套测试就永远不出结果，日志停在半路。
 * 2026-10-20 就踩过一次：`tests/page.test.js` 本身要 ~190 秒，而当时又被
 * 上一次被中断的运行留下的子进程抢了 CPU，日志十几分钟没有新行，
 * 看上去像「某个用例死锁」，实际只是没人告诉你在等什么。
 *
 * 这个运行器补三件事：
 *   1. **硬超时**：单个文件超过 `--timeout`（默认 8 分钟）就杀掉，记为超时，
 *      并把它已经输出的最后几十行原样打出来——不用重跑也能看出卡在哪。
 *   2. **过程可见**：每 15 秒打一行「正在跑哪几个文件、各跑了多久」，
 *      再慢也不会出现长时间无输出。
 *   3. **总结台账**：文件数、通过/失败/超时、总耗时，以及超过慢阈值的文件。
 *      慢文件点名比「总耗时变长了」有用得多——回归时第一个要看的就是它。
 *
 * 文件通过与否只看退出码；固定 TAP 输出，仅从汇总行统计用例数，
 * 避免 Node 默认 reporter 随版本或终端环境切换后把总数统计为 0。
 *
 * 用法：
 *   node tools/run-tests.js                     # 跑 tests/ 下全部
 *   node tools/run-tests.js --root tests --concurrency 4 --timeout 120000
 *   node tools/run-tests.js --filter page       # 只跑文件名含 page 的
 * ============================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULTS = {
  root: path.join(ROOT_DIR, 'tests'),
  concurrency: Math.max(1, Math.min(os.cpus().length || 2, 8)),
  // 8 分钟：最慢的 page.test.js 目前约 110 秒（292 条页面装配用例）。留足余量是
  // 为了让慢机器与 CI 不误判成超时——真卡住时拿的是「谁卡了」，不是省那几分钟。
  timeout: 8 * 60 * 1000,
  slow: 60 * 1000,
  filter: '',
  heartbeat: 15 * 1000,
  tailLines: 40,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (flag === '--root') options.root = path.resolve(next());
    else if (flag === '--concurrency') options.concurrency = Math.max(1, Number(next()) || 1);
    else if (flag === '--timeout') options.timeout = Math.max(1, Number(next()) || 1);
    else if (flag === '--slow') options.slow = Math.max(1, Number(next()) || 1);
    else if (flag === '--filter') options.filter = next() || '';
    else if (flag === '--heartbeat') options.heartbeat = Math.max(200, Number(next()) || 200);
    else if (flag === '--tail') options.tailLines = Math.max(0, Number(next()) || 0);
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write('用法: node tools/run-tests.js [--root 目录] [--concurrency N] [--timeout 毫秒] [--slow 毫秒] [--filter 关键字]\n');
      process.exit(0);
    }
  }
  return options;
}

/** 递归收集测试文件（按路径排序，保证每次运行的顺序稳定） */
function collectTestFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'helpers') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** 保留尾部若干行：失败时只关心最后几十行，不必把整份日志塞进内存 */
function keepTail(buffer, text) {
  buffer.push(text);
  let total = buffer.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > 256 * 1024 && buffer.length > 1) {
    total -= buffer.shift().length;
  }
}

function tailOf(chunks, lines) {
  const text = chunks.join('');
  const list = text.split(/\r?\n/);
  return list.slice(Math.max(0, list.length - lines)).join('\n');
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 展示用路径：项目内的给相对路径，项目外的（临时目录）给绝对路径 */
function displayPath(file) {
  const relative = path.relative(ROOT_DIR, file);
  return relative.startsWith('..') ? file : relative;
}

/** 跑一个文件：成功 resolve，失败/超时 reject 并带上输出尾巴 */
function runFile(file, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = [];
    // 【为什么剥掉 NODE_TEST_CONTEXT】
    // 这个运行器本身也可能在测试里被跑（见 tests/test-runner.test.js）。
    // 此时环境里带着 NODE_TEST_CONTEXT，子进程会以为自己在给上层运行器
    // 汇报，退出码不再代表「这个文件过没过」，失败会被当成通过。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      '--require', path.join(ROOT_DIR, 'tests', 'helpers', 'register-mock.js'),
      '--test', '--test-reporter=tap', file,
    ], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => keepTail(chunks, data.toString()));
    child.stderr.on('data', (data) => keepTail(chunks, data.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout);

    /** 从 TAP 的汇总行里取用例数：文件级超时时可能取不到，按 0 计 */
    const countOf = () => {
      const match = /# tests (\d+)/.exec(chunks.join(''));
      return match ? Number(match[1]) : 0;
    };

    const finish = (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      if (timedOut) {
        resolve({
          file, status: 'timeout', duration, tests: countOf(), output: tailOf(chunks, options.tailLines),
        });
        return;
      }
      if (code === 0) {
        resolve({
          file, status: 'pass', duration, tests: countOf(),
        });
        return;
      }
      resolve({
        file, status: 'fail', duration, tests: countOf(), signal, output: tailOf(chunks, options.tailLines),
      });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        file, status: 'fail', duration: Date.now() - startedAt, output: String(err && err.message),
      });
    });
    child.on('close', finish);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let files = collectTestFiles(options.root);
  if (options.filter) files = files.filter((file) => file.includes(options.filter));
  if (files.length === 0) {
    process.stdout.write(`没有找到测试文件：${options.root}\n`);
    process.exit(1);
  }

  const queue = files.slice();
  const running = new Map(); // file -> startedAt
  const results = [];
  const startedAt = Date.now();

  // 心跳：永远让人知道「现在在等谁」，这是这套工具存在的第一理由
  const heartbeat = setInterval(() => {
    if (running.size === 0) return;
    const list = [...running.entries()]
      .map(([file, since]) => `${displayPath(file)} ${seconds(Date.now() - since)}`)
      .join(' · ');
    process.stdout.write(`… 正在运行 ${running.size} 个：${list}\n`);
  }, options.heartbeat);
  heartbeat.unref();

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    process.stdout.write('\n收到中断，正在收尾…\n');
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  const worker = async () => {
    while (queue.length > 0 && !interrupted) {
      const file = queue.shift();
      running.set(file, Date.now());
      const result = await runFile(file, options);
      running.delete(file);
      results.push(result);
      const name = displayPath(file);
      const mark = result.status === 'pass' ? '✔' : (result.status === 'timeout' ? '⏱' : '✖');
      const note = result.status === 'timeout' ? `超时（>${seconds(options.timeout)}）` : '';
      process.stdout.write(`${mark} ${name} ${seconds(result.duration)}${note ? `  ${note}` : ''}\n`);
    }
  };

  const workers = Array.from({ length: Math.min(options.concurrency, files.length) }, worker);
  await Promise.all(workers);
  clearInterval(heartbeat);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);

  const total = Date.now() - startedAt;
  const failed = results.filter((row) => row.status === 'fail');
  const timedOut = results.filter((row) => row.status === 'timeout');
  const slow = results
    .filter((row) => row.status === 'pass' && row.duration >= options.slow)
    .sort((a, b) => b.duration - a.duration);

  process.stdout.write('\n────────────────────────────────\n');
  const testTotal = results.reduce((sum, row) => sum + (row.tests || 0), 0);
  process.stdout.write(
    `文件 ${results.length} · 用例 ${testTotal} · 通过 ${results.length - failed.length - timedOut.length}`
    + ` · 失败 ${failed.length} · 超时 ${timedOut.length} · 总耗时 ${seconds(total)}\n`
  );
  if (slow.length > 0) {
    process.stdout.write(`\n慢文件（≥${seconds(options.slow)}，改动这些文件时留意）：\n`);
    slow.forEach((row) => {
      process.stdout.write(`  ${displayPath(row.file)} ${seconds(row.duration)}\n`);
    });
  }

  [...failed, ...timedOut].forEach((row) => {
    process.stdout.write(`\n──── ${row.status === 'timeout' ? '超时' : '失败'}：${displayPath(row.file)}\n`);
    process.stdout.write(`${row.output || '(没有输出)'}\n`);
  });

  process.exit(failed.length + timedOut.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`测试运行器自身出错：${err && err.stack}\n`);
  process.exit(1);
});
