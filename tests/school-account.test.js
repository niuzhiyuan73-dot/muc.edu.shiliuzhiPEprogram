/**
 * 学校维度：平台账号开通（迁移清单 M3-d）
 *
 * 守的是：
 *   1. 新微信身份（只有 OpenID、尚无账号）能凭真名 / 性别开出一条平台账号，
 *      角色 / 状态一律服务端盖章（普通会员 / 平台启用），实名之外的字段
 *      （学号 / 学院 / 角色 / 积分）进不了账号——它们归学校身份（§7）；
 *   2. 编号由 OpenID 派生：重复注册走同一条，且**不改写**已登记的实名；
 *      已有账号（旧账号 / 演示身份）走同一入口时原样返回，不新开一条；
 *   3. 非法表单（缺真名 / 缺性别 / 性别取值错）与未授权微信身份被拒；
 *   4. 桥接：注册后同一 OpenID 能解析出账号，进而可提交学校身份申请——
 *      这正是「新账号创建」（S2 身份审核记录·下一步 1）要接上的一环。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { createSchoolHandlers } = require('../src/server/services/school-membership-service');
const { schoolAccountKey } = require('../src/shared/utils/school');

const NOW = new Date('2026-10-14T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'pkb' };
const handlers = createSchoolHandlers({ claimKey: (schoolId, studentId) => `claim_${schoolId}_${studentId}` });

function fixture() {
  return createSchoolMemoryRepo(createSchoolDemoSeed());
}
const byOpenId = (repo, openId) => buildSchoolContext({ repo, openId, scope: SCOPE, now: NOW });
const byActor = (repo, actorId) => buildSchoolContext({ repo, actorId, scope: SCOPE, now: NOW });

test('开通：新 OpenID 落一条平台账号，实名之外的字段被丢弃', async () => {
  const repo = fixture();
  const res = (await handlers.registerSchoolAccount({ profile: {
    realName: '张三', gender: 'm', nickName: '小三', avatarUrl: 'https://cdn.example/a.png',
    // 下面这些不属于平台账号（§7），应被无声丢掉。
    studentId: '2023001', college: '某学院', role: 2, points: 9999, status: 1, _id: 'someone',
  } }, await byOpenId(repo, 'wechat_new_1'))).data;

  assert.equal(res.ok, true, res.message);
  assert.equal(res.account.realName, '张三');
  assert.equal(res.account.gender, 'M');
  assert.equal(res.account.nickName, '小三');
  // 只回展示字段，不带 openId 等隐私。
  assert.deepEqual(Object.keys(res.account).sort(), ['gender', 'nickName', 'realName', 'userId']);

  const stored = await repo.users.getByOpenId('wechat_new_1');
  assert.equal(stored._id, schoolAccountKey('wechat_new_1'));
  assert.equal(stored.platformStatus, 'active');
  assert.equal(stored.platformRole, 'member');
  assert.equal(stored.realName, '张三');
  assert.equal(stored.gender, 'M');
  assert.equal(stored.studentId, undefined);
  assert.equal(stored.college, undefined);
  assert.equal(stored.role, undefined);
  assert.equal(stored.points, undefined);
  assert.equal(stored.status, undefined);

  // 昵称留空时退回真名（与旧栈 buildAccount 同口径）。
  const bare = (await handlers.registerSchoolAccount({ profile: { realName: '李四', gender: 'F' } },
    await byOpenId(repo, 'wechat_new_2'))).data;
  assert.equal(bare.ok, true, bare.message);
  assert.equal((await repo.users.getByOpenId('wechat_new_2')).nickName, '李四');
});

test('开通：重复注册走同一条，既有实名不被改写', async () => {
  const repo = fixture();
  const first = (await handlers.registerSchoolAccount({ profile: { realName: '张三', gender: 'M' } },
    await byOpenId(repo, 'wechat_dup'))).data;
  assert.equal(first.ok, true, first.message);

  const again = (await handlers.registerSchoolAccount({ profile: { realName: '李四', gender: 'F' } },
    await byOpenId(repo, 'wechat_dup'))).data;
  assert.equal(again.ok, true, again.message);
  assert.equal(again.account.userId, first.account.userId);
  assert.equal(again.account.realName, '张三');
  assert.equal(again.account.gender, 'M');

  const stored = await repo.users.getByOpenId('wechat_dup');
  assert.equal(stored.realName, '张三');
  assert.equal(stored.gender, 'M');
});

test('开通：已有账号（演示身份）原样返回，不新开一条', async () => {
  const repo = fixture();
  const existing = (await handlers.registerSchoolAccount({ profile: { realName: '王五', gender: 'M' } },
    await byActor(repo, 'demo_muc_member'))).data;
  assert.equal(existing.ok, true, existing.message);
  assert.equal(existing.account.userId, 'demo_muc_member');

  // 旧账号的实名没被新表单覆盖。
  const stored = await repo.users.getById('demo_muc_member');
  assert.notEqual(stored.realName, '王五');
});

test('开通：非法表单与未授权微信身份被拒', async () => {
  const repo = fixture();
  const ctx = await byOpenId(repo, 'wechat_bad');

  const noOpen = (await handlers.registerSchoolAccount({ profile: { realName: '张三', gender: 'M' } },
    await buildSchoolContext({ repo, scope: SCOPE, now: NOW }))).data;
  assert.equal(noOpen.ok, false);
  assert.match(noOpen.firstError, /授权微信登录/);

  const shortName = (await handlers.registerSchoolAccount({ profile: { realName: '张', gender: 'M' } }, ctx)).data;
  assert.equal(shortName.ok, false);
  assert.ok(shortName.errors.realName);

  const noGender = (await handlers.registerSchoolAccount({ profile: { realName: '张三' } }, ctx)).data;
  assert.equal(noGender.ok, false);
  assert.ok(noGender.errors.gender);

  const badGender = (await handlers.registerSchoolAccount({ profile: { realName: '张三', gender: 'X' } }, ctx)).data;
  assert.equal(badGender.ok, false);
  assert.ok(badGender.errors.gender);

  // 全部被拒，没有落任何账号。
  assert.equal(await repo.users.getByOpenId('wechat_bad'), null);
});

test('桥接：注册后同一 OpenID 解析出账号，进而能提交学校身份申请', async () => {
  const repo = fixture();

  // 未开通：只有 OpenID、没有账号，申请会因「请先登录」被挡下。
  const before = (await handlers.applySchoolMembership({ collegeId: 'c01', studentId: '2023999' },
    await byOpenId(repo, 'wechat_bridge'))).data;
  assert.equal(before.ok, false);
  assert.match(before.message, /请先登录/);

  // 开通平台账号。
  const reg = (await handlers.registerSchoolAccount({ profile: { realName: '赵六', gender: 'M' } },
    await byOpenId(repo, 'wechat_bridge'))).data;
  assert.equal(reg.ok, true, reg.message);

  // 同一 OpenID 现在解析出账号（编号由 OpenID 派生）。
  const after = await byOpenId(repo, 'wechat_bridge');
  assert.equal(after.actorId, schoolAccountKey('wechat_bridge'));
  assert.equal(after.actor.platformStatus, 'active');

  // 学校身份申请随之可走通，落成待审核。
  const applied = (await handlers.applySchoolMembership({ collegeId: 'c01', studentId: '2023999' }, after)).data;
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.account.status, 'pending');
});

test('开通：账号编号由 OpenID 派生，含范围无关性（换学校不改账号）', async () => {
  const repo = fixture();
  const reg = (await handlers.registerSchoolAccount({ profile: { realName: '钱七', gender: 'F' } },
    await byOpenId(repo, 'wechat_scope'))).data;
  assert.equal(reg.ok, true, reg.message);

  // 同一条账号在另一所学校（北航）也能解析出来：账号级，不随学校变。
  const buaa = await buildSchoolContext({ repo, openId: 'wechat_scope',
    scope: { schoolId: 'buaa', association: 'pkb' }, now: NOW });
  assert.equal(buaa.actorId, reg.account.userId);
  assert.equal(buaa.actor.realName, '钱七');
});
