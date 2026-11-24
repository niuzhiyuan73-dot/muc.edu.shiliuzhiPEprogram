/**
 * 读接口的「全院目录」代价（2026-10-23 H-4）
 * ============================================================
 * `buildDirectory` 一次读全校在册名单 + 这批人的账号（2000 人 = 40 次 RPC）。
 * 它是**权限判定**的正确实现，但很多读接口只是顺手借它拿一个学院名或几个
 * 参赛者的学院——为此付 40 页 RPC 不划算。
 *
 * 这条测试盯的是「读接口不再读全院名册」这件事本身（不是数字）：
 * 谁把 buildDirectory 改回来，它就会红。
 *
 * 覆盖：
 *   · 赛事详情（getSchoolEvent）—— 只借一个操作者学院名；
 *   · 报名台账（listSchoolEventSignups）—— 只显示本场报名者；
 *   · 比赛详情（getSchoolMatch）—— 管理员/参赛者本人不需要学院映射。
 * 录入页（getSchoolMatchEntryContext）**仍然要读**：它要下发本协会可选的会员
 * 名单，那正是名册本身，不在本测试约束范围内。
 * ============================================================
 */

process.env.RATE_LIMIT = 'off';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed, createSchoolDemoContent } = require('../miniprogram/services/school-seed');
const { MEMBER_SEED } = require('../miniprogram/services/seed');
const { schoolMemberKey } = require('../src/shared/utils/school');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const NOW = new Date('2026-10-23T10:00:00Z');

/** 演示种子 + 演示内容（赛事 / 比赛 / 报名），并接上旧版会员 u01–u24。 */
function fixture() {
  const seed = createSchoolDemoSeed();
  const content = createSchoolDemoContent();
  for (const key of Object.keys(content)) seed[key] = (seed[key] || []).concat(content[key]);
  MEMBER_SEED.forEach((item, index) => {
    const userId = `u${String(index + 1).padStart(2, '0')}`;
    seed.users.push({
      _id: userId, openId: `mock_openid_${userId}`, nickName: item.nickName,
      realName: item.realName, gender: item.gender || '',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc',
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(userId, 'muc'), userId, schoolId: 'muc',
      collegeId: 'c01', studentId: `2023${String(index + 1).padStart(4, '0')}`, status: 'active',
    });
  });
  return createMemoryRepo(seed);
}

const call = (repo, action, payload, openId = 'mock_openid_muc_admin') => handleSchoolRequest({
  protocolVersion: 2, ...SCOPE, action, payload,
}, { repo, openId, now: NOW });

/**
 * 统计「受范围仓储的 schoolMembers.list()」被调了几次——buildDirectory 的唯一入口。
 * 只包 forScope 返回的那一层：业务代码全部经过 ctx.repo.forScope(...)。
 */
function spyFullRoster(repo) {
  const calls = { count: 0 };
  const raw = repo.forScope;
  repo.forScope = (input) => {
    const surface = raw(input);
    if (surface.schoolMembers && typeof surface.schoolMembers.list === 'function') {
      const original = surface.schoolMembers.list;
      surface.schoolMembers.list = (...args) => {
        calls.count += 1;
        return original.apply(surface.schoolMembers, args);
      };
    }
    return surface;
  };
  return calls;
}

describe('读接口不再为此读全院名册', () => {
  test('赛事详情：只借操作者学院名，不读全校名单', async () => {
    const repo = fixture();
    const event = (await repo.forScope(SCOPE).events.list())[0];
    assert.ok(event, '演示内容里应有赛事');
    const spy = spyFullRoster(repo);

    const res = (await call(repo, 'getSchoolEvent', { eventId: event._id })).data;
    assert.equal(res.ok, true, res.message);
    assert.equal(spy.count, 0, '赛事详情不该调 buildDirectory（40 次 RPC 只为拿一个学院名）');
  });

  test('报名台账：按报名者批读，不读全校名单', async () => {
    const repo = fixture();
    const event = (await repo.forScope(SCOPE).events.list())[0];
    const spy = spyFullRoster(repo);

    const res = (await call(repo, 'listSchoolEventSignups', { eventId: event._id })).data;
    assert.equal(res.ok, true, res.message);
    assert.equal(spy.count, 0, '台账只显示本场报名者，不该读全校名册');
  });

  test('比赛详情：管理员不读全院名册（学院映射只对学院负责人有意义）', async () => {
    const repo = fixture();
    const match = (await repo.forScope(SCOPE).matches.list())[0];
    assert.ok(match, '演示内容里应有比赛');
    const spy = spyFullRoster(repo);

    const res = (await call(repo, 'getSchoolMatch', { matchId: match._id })).data;
    assert.equal(res.ok, true, res.message);
    assert.equal(spy.count, 0, '管理员/参赛者本人不需要学院映射');
  });
});

test('比赛列表：一页比赛不读全校名册（2026-10-23 第三轮 X-3）', async () => {
  const repo = fixture();
  const spy = spyFullRoster(repo);

  const res = (await call(repo, 'listSchoolMatches', { limit: 20 })).data;
  assert.equal(res.ok, true, res.message);
  assert.ok(res.matches.length > 0, '演示内容里应有比赛');
  // 2000 人的学校，buildDirectory = 20（名册）+ 20（账号）+ 1 = 41 次 RPC；
  // 而首页六个协会各调一次列表。改后只按「这一页参赛者」批读学籍。
  assert.equal(spy.count, 0, '比赛列表不该为了一页比赛读全校名册');
  assert.equal(res.matches[0].canRecord !== undefined, true, '行级权限旗标仍要下发');
});
