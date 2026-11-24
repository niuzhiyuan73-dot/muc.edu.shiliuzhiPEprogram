/**
 * 协议 2 的「注册面」必须恰好等于「客户端会发的动作集」（只读审计 H1）
 * ============================================================
 * 【为什么需要这条测试】
 * 服务端从前这样注册处理器：
 *
 *     Object.entries({ ...11 个 service }).filter(([, v]) => typeof v === 'function')
 *
 * 于是 27 个内部辅助函数（`buildDirectory` / `isEventDoc` / `medalOf` /
 * `tallySignups` …）也成了协议 2 的 action。`school-request.js` 只做
 * `hasOwnProperty` 检查，所以任何拿到 OpenID 的客户端都能构造调用这些名字——
 * 客户端从不声明它们，服务端却照单执行，攻击面被无谓放大。
 *
 * 【四个方向都断言】
 *   ① 白名单 == 客户端三个门面声明的动作集（清单不能与客户端漂移）
 *   ② 云端注册集 == 白名单（云端不能偷偷多注册或少注册）
 *   ③ 本地模拟注册集 == 白名单（mock 与云端不能各注册一套）
 *   ④ 那 27 个内部辅助名字一个都不许被注册（点名回归）
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SCHOOL_IDENTITY_ACTIONS, SCHOOL_SPACE_ACTIONS, SCHOOL_EXCHANGE_ACTIONS,
  SCHOOL_MEET_ACTIONS,
} = require('../src/shared/utils/school-actions');
const cloudMember = require('../cloudfunctions/data/src/core/school-member-handlers');
const cloudSpace = require('../cloudfunctions/data/src/core/school-space-handlers');
const cloudExchange = require('../cloudfunctions/data/src/core/school-exchange-handlers');
const cloudMeet = require('../cloudfunctions/data/src/core/school-meet-handlers');
const schoolMock = require('../miniprogram/services/school-mock');

const ROOT = path.join(__dirname, '..');
const SCOPE = { schoolId: 'muc', association: 'pkb' };

/**
 * 从客户端门面 `school-cloud.js` 静态解析出「客户端会发哪些 action」。
 * 它是唯一的事实来源——白名单必须与它一致，而不是与我们的记忆一致。
 */
function clientDeclared() {
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'services', 'school-cloud.js'), 'utf8');
  const slice = (from, to) => {
    const i = src.indexOf(`function ${from}`);
    const j = to === null ? src.length : src.indexOf(to, i + 1);
    assert.ok(i >= 0 && j > i, `解析 school-cloud.js 的 ${from} 失败`);
    return src.slice(i, j);
  };
  const names = (seg) => {
    const out = new Set();
    for (const match of seg.matchAll(/request\('([A-Za-z0-9_]+)'/g)) out.add(match[1]);
    return out;
  };
  return {
    identity: names(slice('forSchoolIdentity', 'function forAssociationSpace')),
    space: names(slice('forAssociationSpace', 'function forExchange')),
    exchange: names(slice('forExchange', 'function forMeet')),
    // 运动会门面：学校级、不带 association，动作单列一组，与前三面互不混入
    meet: names(slice('forMeet', 'module.exports')),
  };
}

/** 集合比较：只报差在哪，不必看整份清单。 */
function diff(actual, expected) {
  const a = new Set(actual); const e = new Set(expected);
  return {
    missing: [...e].filter(name => !a.has(name)).sort(),
    extra: [...a].filter(name => !e.has(name)).sort(),
  };
}

/**
 * 那 27 个「曾经被顺手注册」的内部辅助函数。
 * 它们不是动作，点名钉在这里，将来谁再把注册面放宽，这条会指名道姓。
 */
const INTERNAL_HELPERS = [
  'activeSignupCount', 'advanceSchoolEvent', 'badgeOf', 'buildDirectory', 'buildRows',
  'compareNotices', 'countRegistered', 'defaultSeason', 'displaySignupCount', 'eventSummary',
  'isAnnouncementDoc', 'isCollegeEventDoc', 'isCollegeTieDoc', 'isEventDoc', 'isMatchDoc',
  'legacyRoleOf', 'loadSeason', 'matchSummary', 'medalOf', 'normalizeCapacity',
  'occupiedSignupCount', 'parseTime', 'recordOptions', 'returnPendingOnSeasonReset',
  'seasonKeyOf', 'tallySignups', 'trainingState',
];

test('白名单与客户端四个门面声明的动作集逐字一致', () => {
  const client = clientDeclared();
  for (const [face, expected, declared] of [
    ['身份', SCHOOL_IDENTITY_ACTIONS, client.identity],
    ['协会空间', SCHOOL_SPACE_ACTIONS, client.space],
    ['跨校邀请赛', SCHOOL_EXCHANGE_ACTIONS, client.exchange],
    ['运动会', SCHOOL_MEET_ACTIONS, client.meet],
  ]) {
    const d = diff(expected, declared);
    assert.deepEqual(d.missing, [], `${face}：客户端会发但白名单里没有 ${d.missing.join('、')}`);
    assert.deepEqual(d.extra, [], `${face}：白名单里有但客户端从不声明 ${d.extra.join('、')}`);
  }
});

test('云端四张注册表都恰好等于白名单', () => {
  for (const [face, registered, expected] of [
    ['身份', cloudMember, SCHOOL_IDENTITY_ACTIONS],
    ['协会空间', cloudSpace, SCHOOL_SPACE_ACTIONS],
    ['跨校邀请赛', cloudExchange, SCHOOL_EXCHANGE_ACTIONS],
    ['运动会', cloudMeet, SCHOOL_MEET_ACTIONS],
  ]) {
    const d = diff(Object.keys(registered), expected);
    assert.deepEqual(d.missing, [], `云端${face}少了这些动作：${d.missing.join('、')}`);
    assert.deepEqual(d.extra, [], `云端${face}多注册了这些动作：${d.extra.join('、')}`);
  }
});

test('本地模拟端的注册面与云端完全一致（含身份 / 空间 / 跨校 / 运动会四面）', () => {
  const faces = [
    ['身份', schoolMock.forSchoolIdentity(SCOPE), SCHOOL_IDENTITY_ACTIONS],
    ['协会空间', schoolMock.forAssociationSpace(SCOPE), SCHOOL_SPACE_ACTIONS],
    ['跨校邀请赛', schoolMock.forExchange(SCOPE), SCHOOL_EXCHANGE_ACTIONS],
    // 运动会门面只传 schoolId，不传 association——这是它与其余三面的结构性差异
    ['运动会', schoolMock.forMeet({ schoolId: SCOPE.schoolId }), SCHOOL_MEET_ACTIONS],
  ];
  for (const [face, client, expected] of faces) {
    const d = diff(Object.keys(client), expected);
    assert.deepEqual(d.missing, [], `模拟端${face}少了这些动作：${d.missing.join('、')}`);
    assert.deepEqual(d.extra, [], `模拟端${face}多注册了这些动作：${d.extra.join('、')}`);
  }
});

test('27 个内部辅助函数一个都没被注册（H1 的点名回归）', () => {
  const registered = new Set([
    ...Object.keys(cloudMember), ...Object.keys(cloudSpace), ...Object.keys(cloudExchange),
    ...Object.keys(cloudMeet),
  ]);
  const leaked = INTERNAL_HELPERS.filter(name => registered.has(name));
  assert.deepEqual(leaked, [],
    `这些内部辅助函数不该是可被客户端调用的 action：${leaked.join('、')}`);

  // 反向自查：名单本身要对得上现实——这些名字在实现里确实存在于某个 service 的导出中，
  // 否则「一个都没注册」就成了一句空话（说明我们列的是一批不存在的名字）。
  const serviceDirs = [
    path.join(ROOT, 'cloudfunctions', 'data', 'lib', 'server', 'services'),
    path.join(ROOT, 'cloudfunctions', 'data', 'lib', 'shared', 'services'),
  ];
  const exported = new Set();
  for (const serviceDir of serviceDirs) {
    for (const file of fs.readdirSync(serviceDir).filter(name => name.endsWith('.js'))) {
      const mod = require(path.join(serviceDir, file));
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === 'function') exported.add(name);
      }
    }
  }
  const unknown = INTERNAL_HELPERS.filter(name => !exported.has(name));
  assert.deepEqual(unknown, [],
    `这些名字已经不在任何 service 导出里，请更新 INTERNAL_HELPERS：${unknown.join('、')}`);
});
