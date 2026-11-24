const test = require('node:test');
const assert = require('node:assert');

const {
  TAB,
  TAB_LABEL,
  TAB_EMPTY,
  DEFAULT_LIMIT,
  statusTagOf,
  buildRecordRow,
  filterRecords,
} = require('../miniprogram/services/match-view.js');
const { MATCH_STATUS, MATCH_TYPE, ROLE } = require('../src/shared/utils/constants.js');

const ME = 'u06';
const RIVAL = 'u01';

/** 一条待确认的单打记录（字面量，不依赖种子） */
function pendingRecord(overrides = {}) {
  return {
    _id: 'lm0001',
    matchType: MATCH_TYPE.SINGLES,
    pool: 'singles',
    teamA: [ME],
    teamB: [RIVAL],
    scoreA: [11, 9],
    scoreB: [9, 11],
    gamePoints: 11,
    bestOf: 3,
    winner: 'B',
    location: '学校体育馆 1 号场',
    matchTime: '2026-05-01T18:00:00',
    recorder: ME,
    eventId: null,
    status: MATCH_STATUS.PENDING,
    ...overrides,
  };
}

/** 编号 → 昵称，替掉真实的数据源 */
function fakeNameOf(id) {
  return { [ME]: '我', [RIVAL]: '对手' }[id] || id;
}

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('statusTagOf —— 三种状态各自的文案', () => {
  assert.deepStrictEqual(statusTagOf(MATCH_STATUS.PENDING), {
    label: '待确认',
    className: 'is-pending',
  });
  assert.deepStrictEqual(statusTagOf(MATCH_STATUS.ACTIVE), {
    label: '已生效',
    className: 'is-active',
  });
});

test('statusTagOf —— 驳回与撤销共用终态，靠 action 区分文案', () => {
  // 为驳回单开一个枚举值会波及所有「判断是否作废」的地方，
  // 所以终态一样，只让文案不一样
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'reject').label, '已驳回');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'revoke').label, '已撤销');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED).label, '已撤销');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'reject').className, 'is-revoked');
});

test('statusTagOf —— 未知状态不返回 undefined', () => {
  assert.strictEqual(statusTagOf(99).label, '未知状态');
  assert.strictEqual(statusTagOf(99).className, 'is-unknown');
});

test('buildRecordRow —— 赛制按 P3 口径渲染成「11 分制 · 三局两胜」', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.formatText, '11 分制 · 三局两胜');
});

test('buildRecordRow —— 缺赛制字段时 formatText 是空串而不是 undefined', () => {
  // 老数据没有 gamePoints / bestOf，模板靠 wx:if 挡住，
  // 空串能挡住，undefined 也能，但空串不会在页面上留下一截悬空分隔符
  const row = buildRecordRow(pendingRecord({ gamePoints: undefined, bestOf: undefined }), {
    userId: ME,
    nameOf: fakeNameOf,
  });
  assert.strictEqual(row.formatText, '');
});

test('buildRecordRow —— 队名按昵称拼接，空队给「待定」', () => {
  const row = buildRecordRow(pendingRecord({ teamB: [] }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.teamAText, '我');
  assert.strictEqual(row.teamBText, '待定');
});

test('buildRecordRow —— 比分逐局配对展示', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.scoreText, '11:9  9:11');
});

test('buildRecordRow —— 自己是败方时标「负」', () => {
  const row = buildRecordRow(pendingRecord({ winner: 'B' }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.isMine, true);
  assert.strictEqual(row.isWin, false);
  assert.strictEqual(row.resultText, '负');
});

test('buildRecordRow —— 自己是胜方时标「胜」', () => {
  const row = buildRecordRow(pendingRecord({ winner: 'A' }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.isWin, true);
  assert.strictEqual(row.resultText, '胜');
});

test('buildRecordRow —— 旁观者的比赛不标胜负', () => {
  // 看别人的比赛却给人标一个「负」，是很容易忽略的一类错误
  const row = buildRecordRow(pendingRecord(), { userId: 'u99', nameOf: fakeNameOf });
  assert.strictEqual(row.isMine, false);
  assert.strictEqual(row.resultText, '');
  assert.strictEqual(row.isWin, false);
});

test('buildRecordRow —— 尚未分出胜负时不标胜负', () => {
  const row = buildRecordRow(pendingRecord({ winner: null }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.resultText, '');
});

test('buildRecordRow —— 录入者本人不能自证，权限只来自演示口径', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: true,
  });

  // mock 放宽后才可确认，且必须标明这不是真实规则
  assert.strictEqual(row.canConfirm, true);
  assert.strictEqual(row.confirmRelaxed, true);
});

test('buildRecordRow —— 对手确认不属于放宽，不该被打上演示口径', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: RIVAL,
    nameOf: fakeNameOf,
    isMock: true,
  });

  assert.strictEqual(row.canConfirm, true);
  assert.strictEqual(row.confirmRelaxed, false);
});

test('buildRecordRow —— 严格口径下录入者不能确认', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: false,
  });

  assert.strictEqual(row.canConfirm, false);
  assert.strictEqual(row.confirmRelaxed, false);
});

test('buildRecordRow —— 已生效的比赛不再提供确认按钮', () => {
  const row = buildRecordRow(pendingRecord({ status: MATCH_STATUS.ACTIVE }), {
    userId: ME,
    nameOf: fakeNameOf,
  });
  assert.strictEqual(row.canConfirm, false);
});

test('buildRecordRow —— 抽签比赛没录分时给「录分」而不是「确认」', () => {
  const row = buildRecordRow(pendingRecord({ scoreA: [], scoreB: [], winner: null }), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: true,
  });

  assert.strictEqual(row.needsScore, true);
  assert.strictEqual(row.canRecord, true, '参赛者可以录分');
  assert.strictEqual(row.canConfirm, false, '确认要按胜方计分，没比分就无从确认');
});

test('buildRecordRow —— 录分权与写入口径一致：参赛者或管理员', () => {
  const waiting = pendingRecord({ scoreA: [], scoreB: [], winner: null });
  const base = { nameOf: fakeNameOf, isMock: false };

  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: ME, role: ROLE.MEMBER }).canRecord,
    true,
    '参赛者'
  );
  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: 'u99', role: ROLE.ADMIN }).canRecord,
    true,
    '管理员可以代为录分'
  );
  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: 'u99', role: ROLE.MEMBER }).canRecord,
    false,
    '非参赛的普通会员不行'
  );
});

test('buildRecordRow —— 已经有比分的比赛不再给「录分」', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf, isMock: true });
  assert.strictEqual(row.needsScore, false);
  assert.strictEqual(row.canRecord, false);
});

test('buildRecordRow —— 撤销已取消：行数据不再带 canRevoke 旗标', () => {
  // Elo 逐场结算改造：确认即最终结算，任何角色都没有撤销入口
  const base = { userId: ME, nameOf: fakeNameOf, role: ROLE.MEMBER };
  assert.strictEqual('canRevoke' in buildRecordRow(pendingRecord(), base), false);
  assert.strictEqual(
    'canRevoke' in buildRecordRow(pendingRecord(), { ...base, userId: 'u99', role: ROLE.ADMIN }),
    false,
    '管理员也没有撤销旗标'
  );
});

test('buildRecordRow —— 撤销理由随行带出，界面才显示得出原因', () => {
  const row = buildRecordRow(
    pendingRecord({
      status: MATCH_STATUS.REVOKED,
      action: 'revoke',
      reason: '比分记反了',
    }),
    { userId: ME, nameOf: fakeNameOf }
  );

  assert.strictEqual(row.statusLabel, '已撤销');
  assert.strictEqual(row.statusReason, '比分记反了');
});

test('filterRecords —— 两个标签页各自的筛选口径', () => {
  const mine = pendingRecord({ _id: 'm1' });
  const others = pendingRecord({ _id: 'm2', teamA: ['u01'], teamB: ['u02'], recorder: 'u01' });
  const done = pendingRecord({ _id: 'm3', status: MATCH_STATUS.ACTIVE });
  const list = [mine, others, done];

  // 「我的比赛」看我参与的全部，不分状态
  assert.deepStrictEqual(
    filterRecords(list, TAB.MINE, ME).map((m) => m._id),
    ['m1', 'm3']
  );
  // 待确认标签只看「还没生效且我参与」的
  assert.deepStrictEqual(
    filterRecords(list, TAB.PENDING, ME).map((m) => m._id),
    ['m1']
  );
});

test('filterRecords —— 非法输入退回空数组，不抛错', () => {
  assert.deepStrictEqual(filterRecords(null, TAB.MINE, ME), []);
  assert.deepStrictEqual(filterRecords(undefined, TAB.MINE, ME), []);
});

/* ============================================================
 * 端到端部分已迁走
 * ============================================================
 * 原先这一段有 14 条 `loadMatchView`（协议 1 装载器）的端到端用例。该装载器
 * 已随协议 1 删除，等价覆盖建在 tests/school-match-view.test.js（16 条，守
 * S2 的 loadSchoolMatchView）。接口形状不同，是重写而不是照搬：
 *   · 旧栈 loadMatchView({ userId, user, tab, limit })，查无此人返回 found:false；
 *   · S2  loadSchoolMatchView(api, tab)，viewer 来自服务端上下文，读失败抛错。
 * 其中「演示数据源放宽确认 + demoNotice 提示」这一条在 S2 无对应——S2 不再
 * 放宽确认，新用例反向钉住了「confirmRelaxed 恒假、demoNotice 为空」。
 * ============================================================ */
