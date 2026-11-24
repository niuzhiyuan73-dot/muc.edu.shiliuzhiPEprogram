/**
 * 跨校录分只写差分（2026-10-23 第三轮审查 X-1）
 * ============================================================
 * 【要钉住什么】
 * `submitExchangeScore` 原来在事务里对**整张签表**逐场 `getById`，只为判断
 * 要不要补写。128 人单败到第 2 轮就有 96 场，加上事件读、本场读写与审计，
 * 直接越过云端 100 次操作上限——抽签与第一轮都正常，第二轮起每场录分都报
 * 「服务异常」，且重试无效。
 *
 * 修法是把「需要落库的场次」提前算成差分（`changedExchangeMatches`），
 * 事务只碰那几条。所以这里断言两件事：
 *   ① 差分结果**与签表规模无关**（127 场的签表，一次正常录分产生 0 条额外写）；
 *   ② 服务端循环的确实是差分，而不是退回去遍历整张投影（源码级钉死，
 *      否则这条缺陷会被一次「顺手改回来」无声复活）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { changedExchangeMatches } = require('../src/server/services/exchange-plan');

/** 造一份「已打完」的签表：每场都 active */
function activeLedger(n) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `x${i + 1}`,
    playerA: `a${i}`,
    playerB: `b${i}`,
    status: 'active',
    scoreA: 1,
    scoreB: 0,
    revision: 2,
  }));
}

test('签表再大，已生效的场次一条都不需要重写', () => {
  for (const n of [8, 32, 64, 127]) {
    const ledger = activeLedger(n);
    assert.equal(changedExchangeMatches(ledger, ledger).length, 0, `${n} 场的签表不应产生额外写`);
  }
});

test('新确定的对阵要补写，且只补那一条', () => {
  const ledger = activeLedger(127);
  const projected = [...ledger, {
    _id: 'x128', playerA: 'w1', playerB: 'w2', status: 'pending', scoreA: null, scoreB: null,
  }];
  const changed = changedExchangeMatches(ledger, projected);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]._id, 'x128', '128 人签表下的第 2 轮只应写新出现的那一场');
});

test('换人（待比赛场次对阵变化）要刷新，已生效的既成事实不动', () => {
  const ledger = [
    { _id: 'x1', playerA: 'a1', playerB: 'b1', status: 'active', scoreA: 2, scoreB: 0 },
    { _id: 'x2', playerA: 'a2', playerB: 'b2', status: 'pending', scoreA: null, scoreB: null },
  ];
  const projected = [
    // 已生效的一场即使投影里状态不同，也不该被改写（撤销有专门入口）
    { _id: 'x1', playerA: 'a1', playerB: 'b1', status: 'pending', scoreA: null, scoreB: null },
    { _id: 'x2', playerA: 'a2', playerB: 'b3', status: 'pending', scoreA: null, scoreB: null },
  ];
  const changed = changedExchangeMatches(ledger, projected);
  assert.deepEqual(changed.map((row) => row._id), ['x2']);
});

test('对阵与状态都没变的场次不写（避免把「待比赛」洗成新记录）', () => {
  const ledger = [{ _id: 'x1', playerA: 'a1', playerB: 'b1', status: 'pending', scoreA: 6, scoreB: null }];
  assert.equal(changedExchangeMatches(ledger, [{ ...ledger[0] }]).length, 0);
});

test('服务端循环的是差分而不是整张投影（源码级），防止缺陷被改回来', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server', 'services', 'exchange-service.js'), 'utf8');
  assert.match(source, /changedExchangeMatches\(ledger, built\.matches\)/,
    'submitExchangeScore 必须用差分：签表规模越大，事务操作数不能跟着涨');
  assert.doesNotMatch(source, /for \(const row of built\.matches\)/,
    '不允许再遍历整张投影（128 人签表会越过事务预算）');
});
