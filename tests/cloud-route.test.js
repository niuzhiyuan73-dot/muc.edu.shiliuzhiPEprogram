// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
/**
 * 云函数入口路由判据（只读审计 H6）
 * ============================================================
 * `cloudfunctions/data/index.js` 顶层 require 了 wx-server-sdk，测试环境装不了它，
 * 所以判据被抽到 `src/core/route.js` 才测得到。这里同时做两件事：
 *
 *   1. 断言判据本身的行为：只认 protocolVersion，不认顶层 schoolId；
 *   2. 静态断言 index.js **确实在用**这个判据（否则把判据抽出来只是摆设，
 *      将来有人把 `|| event.schoolId !== undefined` 写回 index.js 也没人拦）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSchoolRequest } = require('../cloudfunctions/data/src/core/route');

const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'data', 'index.js'), 'utf8');

test('带 protocolVersion 的请求走协议 2（学校维度）', () => {
  assert.equal(isSchoolRequest({ protocolVersion: 2, action: 'getSchoolRanking' }), true);
  // 版本号写错也归协议 2 分支——由 handleSchoolRequest 内部给出「需要协议版本 2」
  // 的明确报错，而不是被当成旧协议去查一个不存在的 action。
  assert.equal(isSchoolRequest({ protocolVersion: 1, action: 'getLeaderboard' }), true);
});

test('顶层 schoolId 不再是协议 2 的信号（H6 的回归位）', () => {
  // 从前判据是 `protocolVersion !== undefined || schoolId !== undefined`，
  // 于是「旧协议请求恰好带了顶层 schoolId」会被拉进协议 2 分支，得到一句
  // 误导性的「学校接口需要协议版本 2，请升级客户端」。
  assert.equal(isSchoolRequest({ action: 'getLeaderboard', payload: {}, schoolId: 'muc' }), false);
  assert.equal(isSchoolRequest({ action: 'getMembers', payload: {}, schoolId: 'muc', association: 'pkb' }), false);
});

test('旧协议请求（两个字段都不带）仍走旧分支', () => {
  assert.equal(isSchoolRequest({ action: 'getLeaderboard', payload: {} }), false);
  assert.equal(isSchoolRequest({}), false);
  assert.equal(isSchoolRequest(), false, '入参缺省时也不能抛');
});

test('index.js 确实使用该判据，且没有把 schoolId 条件写回去', () => {
  assert.match(INDEX_SRC, /isSchoolRequest\((?:safeEvent|event)\)/,
    'index.js 应当用 isSchoolRequest(event) 路由，而不是内联判据');
  assert.doesNotMatch(INDEX_SRC, /event\.schoolId\s*!==\s*undefined/,
    'index.js 里不该再出现「顶层 schoolId」这个条件（见 H6）');
});
