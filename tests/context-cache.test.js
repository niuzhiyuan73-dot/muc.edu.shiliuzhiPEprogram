/**
 * 身份上下文缓存（2026-10-23 H-10）
 * ============================================================
 * `buildSchoolContext` 每请求 6 次点读（学校 / 协会 / 账号 / 名册 / 校级角色 /
 * 协会身份），而一个页面连发十几个请求。缓存 5 秒能吃掉绝大部分重复读。
 *
 * 这条测试要钉的是**边界**，不是命中率：
 *   1. 测试进程默认关闭缓存（否则其他用例会读到 5 秒前的快照，变成间歇性失败）；
 *   2. 只有读动作才缓存——写动作套上缓存就是越权窗口；
 *   3. 写动作之后缓存必须整体失效（写请求可能改了**别人**的权限）；
 *   4. 缓存命中的上下文与现场构建的逐字段一致（now 除外，它每次都要新鲜）。
 * ============================================================
 */

process.env.RATE_LIMIT = 'off';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
// 【为什么 require 云端镜像那份】handleSchoolRequest 走的是 cloudfunctions/data/lib/
// 下的副本，而源文件在 miniprogram/services/。两份模块各自持有自己的 Map 与 TTL——
// 拿源文件那份去断言，测的是另一个缓存，永远是「没命中」。镜像与源逐字节一致
// 由 tests/cloud-lib-sync.test.js 守着，所以这里以运行时真正用到的那份为准。
const contextCache = require('../cloudfunctions/data/lib/server/services/context-cache');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

function fixture() {
  return createMemoryRepo(createSchoolDemoSeed());
}

/** 统计「构建上下文」读了几次库（schools.getById 是必经且唯一的一次）。 */
function spyContextReads(repo) {
  const counter = { count: 0 };
  const raw = repo.schools.getById;
  repo.schools.getById = (...args) => {
    counter.count += 1;
    return raw.apply(repo.schools, args);
  };
  return counter;
}

const call = (repo, action, payload = {}, openId = 'mock_openid_muc_admin') => handleSchoolRequest({
  protocolVersion: 2, ...SCOPE, action, payload,
}, { repo, openId, now: new Date() });

afterEach(() => contextCache.__setTtlForTest(0));

describe('身份上下文缓存', () => {
  test('测试进程默认关闭：其他用例不会读到 5 秒前的快照', () => {
    // 这条同时也是一道护栏：如果有人把 readTtl 的测试分支去掉，
    // 整套用例会开始随机失败，而不是等到线上才发现。
    assert.equal(contextCache.stats().ttlMs, 0);
  });

  test('只有读动作命中缓存；写动作每次都重读', async () => {
    const repo = fixture();
    const reads = spyContextReads(repo);
    contextCache.__setTtlForTest(5000);

    await call(repo, 'getSchoolMembers');
    const afterFirstRead = reads.count;
    assert.equal(afterFirstRead, 1, '第一次要读库');

    await call(repo, 'getSchoolMembers');
    assert.equal(reads.count, afterFirstRead, '同一身份的范围读第二次应命中缓存');

    // 写动作不该套缓存：它每次都必须是新鲜上下文
    await call(repo, 'updateSchoolProfile', { patch: { nickName: '改名一次' } });
    const afterWrite = reads.count;
    assert.equal(afterWrite, afterFirstRead + 1, '写动作自己也不走缓存');
  });

  test('写动作之后整份缓存失效（别人被我改了权限也要立刻生效）', async () => {
    const repo = fixture();
    const reads = spyContextReads(repo);
    contextCache.__setTtlForTest(5000);

    await call(repo, 'getSchoolMembers');
    await call(repo, 'getSchoolMembers');
    assert.equal(reads.count, 1, '读两次只建一次上下文');

    // 管理员改自己的昵称：一次写，应当把整份缓存清掉
    await call(repo, 'updateSchoolProfile', { patch: { nickName: '改名后' } });
    await call(repo, 'getSchoolMembers');
    assert.equal(reads.count, 3, '写动作自身 1 次 + 写后失效导致重建 1 次');
  });

  test('TTL 到期后重新读库', async () => {
    const repo = fixture();
    const reads = spyContextReads(repo);
    contextCache.__setTtlForTest(10);

    await call(repo, 'getSchoolMembers');
    assert.equal(reads.count, 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    await call(repo, 'getSchoolMembers');
    assert.equal(reads.count, 2, '超过窗口就要重读，不能一直拿着旧权限');
  });

  test('缓存命中的上下文与现场构建的一致（now 每次新鲜）', async () => {
    const repo = fixture();
    contextCache.__setTtlForTest(5000);

    const fresh = await call(repo, 'getSchoolMembers');
    const cached = await call(repo, 'getSchoolMembers');
    assert.deepEqual(
      { ...cached.data },
      { ...fresh.data },
      '命中缓存不能改变任何返回内容',
    );

    // now 不进缓存：时间判定（报名截止、赛季分界）必须用本次请求的时间
    const { buildSchoolContext } = require('../cloudfunctions/data/lib/server/services/school-context');
    const before = await buildSchoolContext({ repo, openId: 'mock_openid_muc_admin', scope: SCOPE, action: 'getSchoolMembers' });
    const after = await buildSchoolContext({ repo, openId: 'mock_openid_muc_admin', scope: SCOPE, action: 'getSchoolMembers', now: new Date(Date.now() + 1000) });
    assert.notEqual(after.now, before.now);
  });

  test('读动作判定按白名单前缀：写动作一律不缓存', () => {
    contextCache.__setTtlForTest(5000);
    for (const action of ['getSchoolRanking', 'listSchoolEvents', 'getSchoolMemberProfile', 'searchSchoolMembers']) {
      assert.equal(contextCache.isReadAction(action), true, `${action} 应可缓存`);
    }
    for (const action of [
      'applySchoolMembership', 'reviewSchoolMembership', 'applySchoolTransfer', 'reviewSchoolTransfer',
      'grantSchoolPermission', 'updateSchoolProfile', 'submitSchoolMatch', 'publishSchoolEvent',
      'signUpSchoolEvent', 'saveMeetJudgeScore', 'publishMeetResults', 'resetSchoolSeason',
      '', null, undefined,
    ]) {
      assert.equal(contextCache.isReadAction(action), false, `${action} 不该缓存`);
    }
  });

  test('运动会上下文同样只缓存读动作', async () => {
    const repo = fixture();
    const reads = spyContextReads(repo);
    contextCache.__setTtlForTest(5000);

    const meetCall = () => handleSchoolRequest({
      protocolVersion: 2, schoolId: 'muc', action: 'listMyMeetTasks', payload: {},
    }, { repo, openId: 'mock_openid_muc_admin', now: new Date() });

    const first = await meetCall();
    const afterFirst = reads.count;
    const second = await meetCall();
    assert.equal(reads.count, afterFirst, '运动会读动作也应命中缓存');
    assert.deepEqual(second.data, first.data);
  });
});
