/**
 * 顶层 list() 的使用边界（2026-10-27 第八轮审查 P1-3）
 * ============================================================
 * 【问题】
 * `attachSchoolRepository` 给每个集合都补了 `list: () => io.query(key, {})`——
 * 条件对象为空，云端等于「把这个集合的所有学校的行都读回来」。它存在是为满足
 * 「两套仓储方法面一致」的契约（模拟仓储顶层 list 也是全量），本身没错；
 * 错的是业务代码顺手写成 `ctx.repo.schoolMembers.list()`：一次请求就是一次
 * 跨校全表读，读配额与内存同时爆，而且结果里带着别校的数据。
 *
 * 历史上确实发生过（`exchange-service.js` 里留着一句「原先是
 * ctx.repo.schoolMembers.list()」的注释），只是当时靠人工审查才发现。
 *
 * 【为什么用静态扫描而不是运行时抛错】
 * 契约测试把顶层 list 当作合法形态钉着，模拟端也这么实现；运行时禁掉会让两端
 * 分叉（本地绿、云端红）。静态扫描守的是「业务层不要这么写」，与
 * `subpackage-boundaries` / `miniprogram-runtime-safety` 同一路数：零运行时成本，
 * 新代码写错当场变红。
 *
 * 【白名单为什么只有这三个】
 * 学校 / 协会 / 学院目录是平台级或学校级的小集合，且本来就该跨校枚举
 * （选校页、注册页）。其余集合一律必须带范围。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICES_DIR = path.join(__dirname, '..', 'miniprogram', 'services');

/** 允许顶层无范围读取的集合：平台级 / 学校级小目录。 */
const ALLOWED = new Set(['schools', 'schoolAssociations', 'colleges']);

/** 只认代码行，跳过注释（注释里会引用旧写法的历史说明）。 */
function codeLines(source) {
  return source.split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

const TOP_LEVEL_LIST = /ctx\.repo\.([A-Za-z0-9_]+)\.list\(\s*\)/g;

test('业务服务不得用顶层 list() 做跨范围整表读', () => {
  const offenders = [];
  for (const name of fs.readdirSync(SERVICES_DIR)) {
    if (!name.endsWith('.js')) continue;
    // school-memory-repo 是仓储实现本身，顶层 list 是它的契约职责，不在此列。
    if (name === 'school-memory-repo.js') continue;
    const source = fs.readFileSync(path.join(SERVICES_DIR, name), 'utf8');
    for (const { line, number } of codeLines(source)) {
      TOP_LEVEL_LIST.lastIndex = 0;
      let hit;
      while ((hit = TOP_LEVEL_LIST.exec(line)) !== null) {
        if (ALLOWED.has(hit[1])) continue;
        offenders.push(`${name}:${number} → ctx.repo.${hit[1]}.list()`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    '顶层 list() 的条件是空对象，云端会把全平台该集合读回来。\n'
    + '请改用 ctx.repo.forScope(ctx).<集合>.list()（带 schoolId + association），'
    + '或给仓储加一个带条件的原语（listByEvent / listByStatus / listByUser …）。');
});

test('forScope 上的 list() 不受影响（带范围的整表读是允许的）', () => {
  // 反向验证：这条正则不该把 `forScope(ctx).x.list()` 也算进来，否则规则会误伤。
  const sample = 'const rows = await ctx.repo.forScope(ctx).schoolMembers.list();';
  TOP_LEVEL_LIST.lastIndex = 0;
  assert.equal(TOP_LEVEL_LIST.exec(sample), null);
});

/* ------------------------------------------------------------------ 跨校赛事 */

/**
 * 跨校赛事的 `listByEvent` 是**顶层**原语，条件里只有 `eventId`。
 *
 * 【为什么它不能像 forScope 那样自带范围】（第十八轮审查 P2）
 * 每一行归属的是**主办校**，而读它的人可能来自参赛校或平台管理员——调用方的
 * schoolId 与行的 schoolId 本来就不同，拼进去会把功能改坏。所以范围校验只能
 * 落在调用方：先取赛事并过 `eventMatches` / `canSee` / `managesExchange` 等判据，
 * 再用这条原语取行。这条纪律必须由静态扫描守住，否则「新写的 handler 直接拿
 * 客户端 eventId 去查」就会变成跨校读名单。
 */
const EXCHANGE_EVENT_READ = /ctx\.repo\.(exchangeSignups|exchangeMatches)\.listByEvent\s*\(/g;
const AUTHORIZED = /\b(eventMatches|canSee|managesExchange|managesParticipant|canScoreMatch)\s*\(/;

/** 找出每个跨校读取所在的函数体；返回没有授权判据的那些。 */
function unauthorizedExchangeReads(source, label = '') {
  const lines = source.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, index) => {
    if (!EXCHANGE_EVENT_READ.test(line)) { EXCHANGE_EVENT_READ.lastIndex = 0; return; }
    EXCHANGE_EVENT_READ.lastIndex = 0;
    // 向上找函数起点（这些服务都是顶层 `function` / `async function` 声明）
    let start = index;
    while (start > 0 && !/^(?:async )?function [A-Za-z0-9_$]+\s*\(/.test(lines[start])) start -= 1;
    // 向下找到下一个顶层函数或文件结尾
    let end = index + 1;
    while (end < lines.length && !/^(?:async )?function [A-Za-z0-9_$]+\s*\(/.test(lines[end])) end += 1;
    const body = lines.slice(start, end).join('\n');
    if (AUTHORIZED.test(body)) return;
    offenders.push(`${label}:${index + 1} → ${line.trim()}`);
  });
  return offenders;
}

test('跨校赛事的顶层 listByEvent 必须紧跟在授权判据之后', () => {
  const offenders = [];
  let total = 0;
  for (const name of fs.readdirSync(SERVICES_DIR)) {
    if (!name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(SERVICES_DIR, name), 'utf8');
    total += (source.match(EXCHANGE_EVENT_READ) || []).length;
    EXCHANGE_EVENT_READ.lastIndex = 0;
    offenders.push(...unauthorizedExchangeReads(source, name));
  }
  // 扫不出调用说明正则或目录写错了，直接失败，别静默通过。
  assert.ok(total >= 5, `静态扫描只认出 ${total} 处跨校按赛事读取，扫描逻辑可能失效`);
  assert.deepEqual(offenders, [],
    '跨校赛事行归属主办校，无法按调用方学校收范围；这些位置必须在调用前先过\n'
    + 'eventMatches / canSee / managesExchange 等授权判据，否则客户端换个 eventId 就能读别校名单。');
});

test('授权扫描本身有效：没有判据的读取会被点名', () => {
  const sample = [
    'async function leaky(payload, ctx) {',
    '  const rows = await ctx.repo.exchangeSignups.listByEvent(payload.eventId);',
    '  return rows;',
    '}',
  ].join('\n');
  assert.equal(unauthorizedExchangeReads(sample, 'sample.js').length, 1);
  const guarded = [
    'async function ok(payload, ctx) {',
    '  const event = await ctx.repo.exchangeEvents.getById(payload.eventId);',
    '  if (!canSee(event, ctx)) return ok(refused("没有权限"));',
    '  return ctx.repo.exchangeMatches.listByEvent(event._id);',
    '}',
  ].join('\n');
  assert.equal(unauthorizedExchangeReads(guarded, 'sample.js').length, 0);
});
