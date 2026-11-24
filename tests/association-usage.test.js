/**
 * 默认协会规则（association-usage）—— S2 数据源版 单元测试
 * ============================================================
 * P10 协议 1 下线后，「比赛最多的协会」改由 S2 的 getSchoolMemberStats
 * 逐协会取数（按池累加 matchCount）。这里守四条规则 + 一条契约：
 *
 *   1. 只在某一个协会打过球 → 默认落那个协会；
 *   2. 并列最多 → 取注册表在前的；
 *   3. 一场没打过 / 没登录 → 回落默认协会；
 *   4. matchCountsByAssociation 与启用协会同序、逐协会给数；
 *   5. 契约：本模块不得再 require 旧门面（协议 1 下线的静态守护）。
 *
 * 演示数据（school-seed）里民大各协会的球员分布是刻意拉开的：
 *   · u03 只在匹克球（pkb）打过；
 *   · u08 只在乒乓球（tt）打过 3 场；
 *   · u12 乒乓 3 场、羽毛球 3 场（并列，tt 在注册表里先于 bd）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schoolMock = require('../miniprogram/services/school-mock.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const { matchCountsByAssociation, mostPlayedAssociation } = require('../miniprogram/services/association-usage.js');
const { defaultAssociationId, activeAssociations } = require('../src/shared/utils/associations.js');

test.beforeEach(() => {
  schoolMock.reset();
  schoolMock.setDemoActor('demo_muc_admin'); // 民大有效会员身份，能读本校各协会空间
  schoolSession.reset();
});

test.afterEach(() => {
  schoolMock.reset();
  schoolMock.setDemoActor(schoolMock.DEMO_ACTORS[0].id);
});

test('只在匹克球打过球的会员，默认落匹克球', async () => {
  assert.equal(await mostPlayedAssociation('u03'), 'pkb');
});

test('只在乒乓球打过球的会员，默认落乒乓球', async () => {
  assert.equal(await mostPlayedAssociation('u08'), 'tt');
});

test('乒乓与羽毛球并列时，取注册表在前的乒乓球', async () => {
  const registry = activeAssociations().map(a => a.id);
  assert.ok(registry.indexOf('tt') < registry.indexOf('bd'), '前置：tt 注册在 bd 之前');
  assert.equal(await mostPlayedAssociation('u12'), 'tt');
});

test('一场没打过、没登录，都回落默认协会', async () => {
  const fallback = defaultAssociationId();
  assert.equal(await mostPlayedAssociation(), fallback, '没登录');
  // 演示申请人在册但没有任何比赛记录
  assert.equal(await mostPlayedAssociation('demo_applicant'), fallback, '零战绩');
});

test('matchCountsByAssociation 与启用协会同序，逐协会给数', async () => {
  const counts = await matchCountsByAssociation('u03');
  assert.deepEqual(counts.map(item => item.id), activeAssociations().map(a => a.id));
  const byId = Object.fromEntries(counts.map(item => [item.id, item.matchCount]));
  assert.ok(byId.pkb > 0, 'u03 在匹克球有场次');
  assert.equal(byId.tt, 0, 'u03 没打过乒乓球');
  assert.equal(byId.bd, 0, 'u03 没打过羽毛球');
});

test('契约：association-usage 不再 require 旧门面', () => {
  const text = fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'services', 'association-usage.js'), 'utf8');
  assert.ok(!text.includes("require('./index.js')"), '协议 1 门面已下线，默认协会规则走 S2');
});
