// 入口限流按 openId 每秒计数，而这些用例用同一身份连打几十次（申请→审核→再申请、
// 连续路由等），属于压测式调用而非真实交互，故跑测试时关掉（生产默认开启）。
process.env.RATE_LIMIT = 'off';
/**
 * 跨校邀请赛的云端接入（协议 2 分发 + 客户端门面）
 * ============================================================
 * 2026-10-16 用户口径：交流赛剩余能力做完后要「同步到云函数」。这里守三件事：
 *   1. 邀请赛动作确已在协议 2 分发里注册（服务端实现来自共享库镜像）；
 *   2. 新增的剩余能力（签到 / 退赛移除 / 邀请撤回 / 取消赛事 / 比分撤销）在
 *      云入口上同样可用、同样受权限与跨校边界约束；
 *   3. 客户端门面在云数据源下不再拒绝进入（此前 `services/exchange.js` 直接抛错）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { schoolMemberKey } = require('../src/shared/utils/school');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');
const handlers = require('../cloudfunctions/data/src/core/school-exchange-handlers');

const NOW = new Date('2026-10-16T12:00:00Z');
const form = { title: '云端交流赛', location: '云端球场', startTime: '2026-12-01T10:00:00Z',
  participantSchoolIds: ['muc', 'buaa'], quota: 4, schoolQuotas: { muc: 2, buaa: 2 }, requestId: 'cloud1' };

const fixture = () => createMemoryRepo(createSchoolDemoSeed());
const request = (repo, action, payload = {}, openId = 'mock_openid_muc_admin', schoolId = 'muc') =>
  handleSchoolRequest({ protocolVersion: 2, schoolId, association: 'pkb', action, payload },
    { repo, openId, now: NOW });
/** 与云端同一条入口，取出处理器返回的 data。 */
const call = async (...args) => (await request(...args)).data;

async function readyFour(repo) {
  const created = await call(repo, 'createExchangeEvent', form);
  assert.equal(created.ok, true, created.message);
  const id = created.event._id;
  const accept = await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'accepted' },
    'mock_openid_buaa_admin', 'buaa');
  assert.equal(accept.ok, true, accept.message);
  for (const [openId, schoolId] of [['mock_openid_muc_member', 'muc'], ['mock_openid_muc_admin', 'muc'],
    ['mock_openid_buaa_member', 'buaa'], ['mock_openid_buaa_admin', 'buaa']]) {
    const signed = await call(repo, 'signUpExchangeEvent', { eventId: id }, openId, schoolId);
    assert.equal(signed.ok, true, signed.message);
  }
  const locked = await call(repo, 'lockExchangeRoster', { eventId: id });
  assert.equal(locked.ok, true, locked.message);
  return id;
}

for (const referee of [false, true]) {
  for (const invalidation of ['account', 'membership', 'transfer', 'duringTransaction']) {
    test(`云端录分拒绝失效${referee ? '裁判' : '选手'}：${invalidation}`, async () => {
      const repo = fixture();
      const eventId = await readyFour(repo);
      assert.equal((await call(repo, 'drawExchangeEvent', { eventId, seedValue: 11 })).ok, true);
      const match = (await repo.exchangeMatches.listByEvent(eventId))
        .find(row => [row.playerA, row.playerB].includes('demo_muc_member'));
      assert.ok(match);
      if (referee) assert.equal((await call(repo, 'assignExchangeReferee', {
        eventId, matchId: match._id, refereeId: 'demo_muc_member',
      })).ok, true);
      const invalidate = async () => {
        const user = await repo.users.getById('demo_muc_member');
        if (invalidation === 'membership') {
          const id = schoolMemberKey(user._id, 'muc');
          await repo.schoolMembers.set(id, { ...await repo.schoolMembers.getById(id), status: 'disabled' });
        } else {
          await repo.users.set(user._id, { ...user, ...(invalidation === 'transfer'
            ? { primarySchoolId: 'buaa' } : { platformStatus: 'disabled' }) });
        }
      };
      if (invalidation === 'duringTransaction') {
        const transaction = repo.transaction.bind(repo);
        repo.transaction = async fn => { await invalidate(); return transaction(fn); };
      } else await invalidate();
      const before = await repo.exchangeMatches.getById(match._id);
      const result = await call(repo, 'submitExchangeScore', {
        eventId, matchId: match._id, scoreA: 11, scoreB: 5,
      }, 'mock_openid_muc_member');
      assert.equal(result.ok, false);
      assert.match(result.message, /权限/);
      assert.deepEqual(await repo.exchangeMatches.getById(match._id), before, '拒绝后比分及版本均不变');
    });
  }
}

test('邀请赛动作已在协议 2 注册，且服务端实现来自共享库镜像', async () => {
  const expected = ['createExchangeEvent', 'respondExchangeInvitation', 'signUpExchangeEvent',
    'cancelExchangeSignup', 'removeExchangeSignup', 'checkInExchangeSignup',
    'withdrawExchangeInvitation', 'cancelExchangeEvent',
    'lockExchangeRoster', 'drawExchangeEvent', 'assignExchangeReferee',
    'submitExchangeScore', 'confirmExchangeRanking', 'getExchangeEvents', 'getExchangeEvent', 'listExchangeRefereeCandidates'];
  assert.deepEqual(Object.keys(handlers).sort(), expected.slice().sort());
  assert.equal((await request(fixture(), 'notAnExchangeAction')).ok, false, '未注册动作仍被拒');
});

test('云端入口：报名 → 锁定 → 代签 → 抽签 → 录分 → 名次全程可用', async () => {
  const repo = fixture();
  const baseline = { matches: (await repo.matches.list()).length };
  const id = await readyFour(repo);

  const checked = await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_muc_member' });
  assert.equal(checked.ok, true, checked.message);
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.participants.find(row => row.userId === 'demo_muc_member').checkedIn, true);

  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 11 });
  assert.equal(drawn.ok, true, drawn.message);
  let matches = (await repo.exchangeMatches.listByEvent(id)).filter(row => row.round === 1);
  assert.equal(matches.length, 2);
  for (const row of matches) {
    const scored = await call(repo, 'submitExchangeScore', { eventId: id, matchId: row._id, scoreA: 11, scoreB: 5 });
    assert.equal(scored.ok, true, scored.message);
  }
  const final = (await repo.exchangeMatches.listByEvent(id)).find(row => row.round === 2);
  assert.ok(final, '两场半决赛确认后应在云入口生成决赛');
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: final._id, scoreA: 11, scoreB: 7 });

  // 撤销已随逐场结算改造取消：录完决赛直接进名次确认
  assert.equal(typeof handlers.revokeExchangeScore, 'undefined', '撤销实现已删除');

  const ranked = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(ranked.ok, true, ranked.message);
  assert.equal(ranked.event.status, 'finished');
  assert.deepEqual(ranked.event.results.map(row => row.placement).sort(), [1, 2, 3, 3]);
  // 全程不写校内流水与等级分（夹具自带演示内容，比的是「没变多」）
  assert.equal((await repo.matches.list()).length, baseline.matches, '校内比赛流水一条没多');
});

test('云端入口：跨校边界与权限照样生效（外校不能替主办取消或撤回）', async () => {
  const repo = fixture();
  const id = await readyFour(repo);

  // 北航（受邀校）不能取消整场；主办校（民大）可以
  assert.equal((await call(repo, 'cancelExchangeEvent', { eventId: id },
    'mock_openid_buaa_admin', 'buaa')).ok, false);
  // 外校不能撤回民大那一侧
  assert.equal((await call(repo, 'withdrawExchangeInvitation', { eventId: id, schoolId: 'muc' },
    'mock_openid_buaa_admin', 'buaa')).ok, false);
  // 普通会员不能代签
  assert.equal((await call(repo, 'checkInExchangeSignup', { eventId: id, userId: 'demo_buaa_member' },
    'mock_openid_buaa_member', 'buaa')).ok, false);
  const canceled = await call(repo, 'cancelExchangeEvent', { eventId: id, reason: '云端取消' });
  assert.equal(canceled.ok, true, canceled.message);
  assert.equal(canceled.event.status, 'canceled');
});

test('客户端门面：云数据源不再直接拒绝进入邀请赛', async () => {
  // 门面按数据源选择：mock 走本地仓储，cloud 走协议 2 客户端；两者都不再抛「尚未开放云端」
  const exchange = require('../miniprogram/packageMember/services/exchange.js');
  const schoolSession = require('../miniprogram/services/school-session.js');
  const schoolMock = require('../src/mock/school-mock.js');
  schoolSession.reset();
  schoolMock.reset();
  const client = exchange.forScope({ schoolId: 'muc', association: 'pkb' });
  assert.equal(typeof client.checkInExchangeSignup, 'function', '剩余能力在门面上可用');
  assert.equal(typeof client.revokeExchangeScore, 'undefined', '撤销已从客户端门面移除');
});
