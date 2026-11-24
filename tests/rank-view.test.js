const test = require('node:test');
const assert = require('node:assert');

const {
  TOP_LIMIT,
  normalizeKeyword,
  filterRows,
  describeSearch,
  loadSchoolRankView,
} = require('../miniprogram/services/rank-view.js');
const { RANK_PROJECT } = require('../src/shared/utils/constants.js');

/* ============================================================
 * 本文件已被 P10 合并批瘦身（26 条 → 9 条）
 * ============================================================
 * 删掉的两类：
 *   · 19 条「排行榜 ——」端到端用例，守的是协议 1 的 loadRankView；
 *   · 6 条守随它一并删除的纯构建器（medalOf / badgeOf /
 *     rankProjectBoard / buildEloRows）。
 * 这些规则在 S2 全部搬到了服务端 school-rank-service.getSchoolRanking
 * （与旧栈同形），等价覆盖已建在 tests/school-rank.test.js 的
 * 「榜单展示形状 —— 旧栈 loadRankView 的 S2 对应」一组：
 *   前 10 截断 / total 报完整人数 / 计数文案 / 我的名次来自完整榜单 /
 *   项目标签 / 非法项目回退 / 名次连续 / 等级分降序 / 点进主页所需字段 /
 *   奖牌只给前三 / 徽章只翻译两种 / 主数字与副行、isMe 唯一 / 搜到前十之外。
 * 其中「rankProjectBoard 传非数组返回空数组」一条在 S2 无对应——S2 的输入
 * 是服务端自己回放出的数组，不是外部入参，这条防御性断言不再适用。
 *
 * 留下的是页面侧仍在用的搜索筛选（rank-panel / events-panel）与 S2 装载器。
 * ============================================================ */

/* ============================================================
 * 一、页面侧搜索筛选（rank-panel / events-panel 在用）
 * ============================================================ */

test('normalizeKeyword —— 去空白、转小写，空值当作不筛选', () => {
  assert.strictEqual(normalizeKeyword('  张三 '), '张三');
  assert.strictEqual(normalizeKeyword('Leo'), 'leo', '英文昵称要能不分大小写地搜到');
  assert.strictEqual(normalizeKeyword(''), '');
  assert.strictEqual(normalizeKeyword(null), '');
  assert.strictEqual(normalizeKeyword(undefined), '');
});

test('filterRows —— 按昵称子串命中，前后空格与大小写都不影响', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张宇轩' },
    { userId: 'u2', rank: 2, nickName: 'Leo' },
    { userId: 'u3', rank: 3, nickName: '李思远' },
  ];

  assert.deepStrictEqual(
    filterRows(rows, '张').map((r) => r.userId),
    ['u1']
  );
  assert.deepStrictEqual(
    filterRows(rows, 'le').map((r) => r.userId),
    ['u2'],
    '搜 le 应当能命中 Leo'
  );
  assert.deepStrictEqual(
    filterRows(rows, '  远 ').map((r) => r.userId),
    ['u3']
  );
  assert.deepStrictEqual(filterRows(rows, '不存在'), []);
});

test('filterRows —— 只筛不重新编号，名次保持榜单上的绝对名次', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张三' },
    { userId: 'u2', rank: 2, nickName: '李四' },
    { userId: 'u3', rank: 3, nickName: '张五' },
  ];
  const hit = filterRows(rows, '张');

  assert.deepStrictEqual(
    hit.map((r) => r.rank),
    [1, 3],
    '搜索不是重新排名，张五仍该是第 3 名'
  );
});

test('filterRows —— 真实姓名同样能命中（昵称只是真名的一部分时）', () => {
  // 真实姓名「赵明宇」，昵称只取了「明宇」。用户按真名去搜，输入「赵」
  // 必须能找到这个人——这正是只按昵称匹配时漏掉的场景。
  const rows = [
    { userId: 'u1', rank: 1, nickName: '明宇', realName: '赵明宇' },
    { userId: 'u2', rank: 2, nickName: '思远', realName: '李思远' },
  ];

  assert.deepStrictEqual(
    filterRows(rows, '赵').map((r) => r.userId),
    ['u1'],
    '搜真名的姓也应当命中'
  );
  assert.deepStrictEqual(
    filterRows(rows, '明宇').map((r) => r.userId),
    ['u1'],
    '昵称仍然照常命中'
  );
  assert.deepStrictEqual(
    filterRows(rows, '思').map((r) => r.userId),
    ['u2'],
    '两个名字都能独立命中'
  );
  // 同一个人不会因为两个字段都命中而出现两行
  assert.deepStrictEqual(filterRows(rows, '宇').map((r) => r.userId), ['u1']);
});

test('filterRows —— 行里没有 realName 字段时不报错', () => {
  const rows = [{ userId: 'u1', rank: 1, nickName: '张三' }];
  assert.deepStrictEqual(filterRows(rows, '张').map((r) => r.userId), ['u1']);
  assert.deepStrictEqual(filterRows(rows, '李'), []);
});

test('filterRows —— 空搜索词原样返回，非数组当空榜处理', () => {
  const rows = [{ userId: 'u1', rank: 1, nickName: '张三' }];
  assert.strictEqual(filterRows(rows, ''), rows);
  assert.strictEqual(filterRows(rows, '   '), rows);
  assert.deepStrictEqual(filterRows(null, '张'), []);
  assert.deepStrictEqual(filterRows(undefined, '张'), []);
});

test('describeSearch —— 不搜索时给「N 人上榜」，空榜才提示没人打过', () => {
  const rows = [{ userId: 'u1', rank: 1, nickName: '张三' }];

  const idle = describeSearch(rows, '');
  assert.strictEqual(idle.searching, false);
  assert.strictEqual(idle.keyword, '');
  assert.strictEqual(idle.rows.length, 1);
  assert.strictEqual(idle.countText, '1 人上榜');
  assert.strictEqual(idle.empty, false);
  assert.strictEqual(idle.emptyNote, '', '正常浏览时不该冒出一句提示');

  const blank = describeSearch([], '');
  assert.strictEqual(blank.empty, true);
  assert.strictEqual(blank.emptyNote, '这个项目还没有人打过');
});

test('describeSearch —— 搜索时给「找到 N 人」，无命中时把搜索词写进提示', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张宇轩' },
    { userId: 'u2', rank: 2, nickName: '李思远' },
  ];

  const hit = describeSearch(rows, ' 张 ');
  assert.strictEqual(hit.searching, true);
  assert.strictEqual(hit.keyword, '张', '搜索词要去掉首尾空白');
  assert.strictEqual(hit.countText, '找到 1 人');
  assert.strictEqual(hit.empty, false);

  const miss = describeSearch(rows, '王');
  assert.strictEqual(miss.rows.length, 0);
  assert.strictEqual(miss.empty, true);
  assert.strictEqual(miss.countText, '找到 0 人');
  assert.strictEqual(miss.emptyNote, '没有名字含「王」的会员');
});

/* ============================================================
 * S2 装载器（B4-a）
 * ============================================================ */

test('loadSchoolRankView —— 透传 S2 榜单视图，并带上项目参数', async () => {
  const calls = [];
  const api = {
    getSchoolRanking: async (payload) => {
      calls.push(payload);
      return { ok: true, schoolName: '民大', rows: [{ userId: 'u06' }] };
    },
  };

  const view = await loadSchoolRankView(api, { project: RANK_PROJECT.DOUBLES });

  assert.strictEqual(view.rows[0].userId, 'u06');
  assert.strictEqual(view.schoolName, '民大');
  assert.deepStrictEqual(calls, [{ project: RANK_PROJECT.DOUBLES }]);
});

test('loadSchoolRankView —— 无读取权限时上抛服务端原因，不吞成空榜单', async () => {
  const api = {
    getSchoolRanking: async () => ({ ok: false, message: '没有读取本协会排行榜的权限' }),
  };

  await assert.rejects(
    loadSchoolRankView(api, {}),
    /没有读取本协会排行榜的权限/
  );
});
