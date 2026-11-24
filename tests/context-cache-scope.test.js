/**
 * 写后缓存失效的范围（2026-10-27 第八轮审查 P2-6）
 * ============================================================
 * 【要守什么】
 * 写动作原本一律 `invalidateAll()`：判球一次就是一次写，一场 50 球期间把所有
 * 用户（含观众、别的协会）的上下文一起打掉，缓存对最热的计分台完全失效。
 *
 * 现在只允许「纯比赛类写」按 `schoolId + association` 失效——它们不写学籍 /
 * 角色 / 会籍，不可能改变任何人的身份。身份类写（审批、任免、变更学籍）
 * 必须继续全清，否则就是一段撤权不生效的窗口。
 *
 * 【为什么盯分流本身而不是盯读量】
 * 「读了几次」随实现变化，而「哪个动作走哪条失效」是这个决策的全部内容：
 * 有人把审批动作塞进白名单，这里就要红。
 * ============================================================
 */

process.env.RATE_LIMIT = 'off';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 必须取云函数侧的镜像实例：handleSchoolRequest 加载的是 cloudfunctions/data/lib
// 下的同一份文件，require 另一份（miniprogram/）会拿到不同对象，spy 就不生效。
const contextCache = require('../cloudfunctions/data/lib/server/services/context-cache.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request.js');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo.js');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const NOW = new Date('2026-10-27T10:00:00Z');

function repo() {
  return createSchoolMemoryRepo(createSchoolDemoSeed());
}

/** 记录失效调用，并原样转发（不影响真实行为）。 */
function spyInvalidation() {
  const calls = { all: 0, scope: [] };
  const originalAll = contextCache.invalidateAll;
  const originalScope = contextCache.invalidateScope;
  contextCache.invalidateAll = () => { calls.all += 1; };
  contextCache.invalidateScope = (schoolId, association) => { calls.scope.push([schoolId, association]); };
  calls.restore = () => {
    contextCache.invalidateAll = originalAll;
    contextCache.invalidateScope = originalScope;
  };
  return calls;
}

const send = (action, payload = {}) => handleSchoolRequest(
  { protocolVersion: 2, ...SCOPE, action, payload },
  { repo: repo(), openId: 'mock_openid_muc_admin', now: NOW },
);

test('invalidateScope 只清本范围，别的协会与别的学校仍在', () => {
  contextCache.__setTtlForTest(5000);
  const key = (scope, openId) => contextCache.keyOf(scope, openId, '');
  contextCache.set(key(SCOPE, 'a'), { actor: { _id: 'a' } });
  contextCache.set(key({ schoolId: 'muc', association: 'tt' }, 'b'), { actor: { _id: 'b' } });
  contextCache.set(key({ schoolId: 'buaa', association: 'pkb' }, 'c'), { actor: { _id: 'c' } });
  assert.equal(contextCache.stats().size, 3);

  contextCache.invalidateScope(SCOPE.schoolId, SCOPE.association);

  assert.equal(contextCache.get(key(SCOPE, 'a')), null, '本范围应被清掉');
  assert.ok(contextCache.get(key({ schoolId: 'muc', association: 'tt' }, 'b')), '同校别的协会不该被牵连');
  assert.ok(contextCache.get(key({ schoolId: 'buaa', association: 'pkb' }, 'c')), '别的学校不该被牵连');
  contextCache.__setTtlForTest(0);
});

test('判球这类纯比赛写：只按范围失效，不清全场', async () => {
  const calls = spyInvalidation();
  try {
    await send('recordSchoolRally', {});
  } finally {
    calls.restore();
  }
  assert.deepEqual(calls.scope, [[SCOPE.schoolId, SCOPE.association]], '应只失效本范围');
  assert.equal(calls.all, 0, '判球不该清掉所有用户的上下文');
});

test('成员审批这类身份写：必须全清（撤权要立刻生效）', async () => {
  const calls = spyInvalidation();
  try {
    await send('reviewSchoolMembership', {});
  } finally {
    calls.restore();
  }
  assert.equal(calls.all, 1, '身份类写必须全清，按范围清会留下别校的陈旧权限');
  assert.deepEqual(calls.scope, []);
});
