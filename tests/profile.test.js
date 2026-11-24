/**
 * 个人资料 —— 资料校验与展示
 * ============================================================
 * 这一组盯两件事：
 *   1. 白名单是真的白名单。任何「顺手改个 role / points / studentId」的
 *      请求都必须被丢掉，而不是写进账号。
 *   2. 昵称与真名的展示口径。真名只该在「与昵称不同」时出现，
 *      否则头卡上会冒出「张宇轩（张宇轩）」这种噪音。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EDITABLE_FIELDS,
  IMMUTABLE_FIELDS,
  NICKNAME_MAX,
  normalizeProfilePatch,
  validateProfilePatch,
  buildProfilePatch,
  resolveNameDisplay,
} = require('../src/shared/services/profile.js');

/* ============================================================
 * 一、补丁清洗：白名单之外一律丢掉
 * ============================================================ */

test('normalizeProfilePatch —— 只留下昵称与头像，敏感字段被丢掉', () => {
  const patch = normalizeProfilePatch({
    nickName: '  新昵称  ',
    avatarUrl: 'cloud://x/y.png',
    realName: '李四',
    studentId: '2026000001',
    role: 2,
    status: 1,
    points: 99999,
    ratings: { singles: { elo: 2000 } },
  });

  assert.deepEqual(patch, { nickName: '新昵称', avatarUrl: 'cloud://x/y.png' });
  // 白名单就是这两个字段本身，断言它俩确实是全部
  assert.deepEqual([...EDITABLE_FIELDS].sort(), ['avatarUrl', 'nickName']);
});

test('normalizeProfilePatch —— 没给的字段保持 undefined，据此区分「不改」与「改成空」', () => {
  const onlyAvatar = normalizeProfilePatch({ avatarUrl: 'cloud://a/b.png' });
  assert.equal(onlyAvatar.nickName, undefined);
  assert.equal(onlyAvatar.avatarUrl, 'cloud://a/b.png');

  // 显式给空串 = 要清掉这个字段
  const cleared = normalizeProfilePatch({ nickName: '' });
  assert.equal(cleared.nickName, '');
});

test('normalizeProfilePatch —— null / 非对象 / 数字都能安全处理', () => {
  assert.deepEqual(normalizeProfilePatch(null), {});
  assert.deepEqual(normalizeProfilePatch('不是对象'), {});
  // 数字会被转成字符串，不至于在 .test() 里抛错
  assert.deepEqual(normalizeProfilePatch({ nickName: 123 }), { nickName: '123' });
  assert.deepEqual(normalizeProfilePatch({ avatarUrl: null }), { avatarUrl: '' });
});

/* ============================================================
 * 二、校验：只校验「本次打算改」的字段
 * ============================================================ */

test('validateProfilePatch —— 昵称为空或超长都拦下', () => {
  assert.equal(validateProfilePatch({ nickName: '' }).valid, false);
  assert.equal(validateProfilePatch({ nickName: '   ' }).valid, false);
  assert.equal(validateProfilePatch({ nickName: '好'.repeat(NICKNAME_MAX + 1) }).valid, false);
  assert.equal(validateProfilePatch({ nickName: '好'.repeat(NICKNAME_MAX) }).valid, true);
});

test('validateProfilePatch —— 昵称里的换行被拒绝，避免在榜单上撑破一行', () => {
  const result = validateProfilePatch({ nickName: '上\n下' });
  assert.equal(result.valid, false);
  assert.equal(result.firstErrorField, 'nickName');
});

test('validateProfilePatch —— 只换头像时不该被昵称规则拦住', () => {
  const result = validateProfilePatch({ avatarUrl: 'cloud://a/b.png' });
  assert.equal(result.valid, true);
  assert.equal(result.firstError, '');
});

test('validateProfilePatch —— 错误信息带出出错字段，便于逐字段标红', () => {
  const result = validateProfilePatch({ nickName: '' });
  assert.equal(result.firstErrorField, 'nickName');
  assert.match(result.firstError, /昵称/);
  assert.ok(result.errors.nickName);
});

/* ============================================================
 * 三、组装：空补丁与非法补丁都拒绝
 * ============================================================ */

test('buildProfilePatch —— 合法补丁通过，并带上清洗后的值', () => {
  const built = buildProfilePatch({ nickName: ' 小明 ', avatarUrl: 'cloud://a/b.png' });
  assert.equal(built.ok, true);
  assert.deepEqual(built.patch, { nickName: '小明', avatarUrl: 'cloud://a/b.png' });
  assert.equal(built.firstError, '');
});

test('buildProfilePatch —— 空补丁被挡下，理由是「没有要修改的内容」', () => {
  const built = buildProfilePatch({});
  assert.equal(built.ok, false);
  assert.equal(built.patch, null);
  assert.equal(built.firstError, '没有要修改的内容');

  // 只有敏感字段的补丁同样等于「什么都没改」
  assert.equal(buildProfilePatch({ role: 2 }).firstError, '没有要修改的内容');
});

test('buildProfilePatch —— 非法昵称不产出补丁', () => {
  const built = buildProfilePatch({ nickName: '' });
  assert.equal(built.ok, false);
  assert.equal(built.patch, null);
  assert.ok(built.errors.nickName);
});

/* ============================================================
 * 四、展示：昵称与真名怎么并排
 * ============================================================ */

test('resolveNameDisplay —— 真名与昵称不同时两者都给出', () => {
  const display = resolveNameDisplay({ nickName: '明宇', realName: '赵明宇' });
  assert.equal(display.nickName, '明宇');
  assert.equal(display.realName, '赵明宇');
  assert.equal(display.showRealName, true);
});

test('resolveNameDisplay —— 真名与昵称相同时不重复显示', () => {
  const display = resolveNameDisplay({ nickName: '赵明宇', realName: '赵明宇' });
  assert.equal(display.showRealName, false);
});

test('resolveNameDisplay —— 缺真名时不显示，缺昵称时真名顶上', () => {
  assert.equal(resolveNameDisplay({ nickName: '明宇' }).showRealName, false);
  // 连昵称都没有的人（老数据），真名就是他唯一的名字
  const onlyReal = resolveNameDisplay({ realName: '赵明宇' });
  assert.equal(onlyReal.realName, '赵明宇');
  assert.equal(onlyReal.showRealName, true);
});

test('resolveNameDisplay —— null / 非对象都安全返回空值', () => {
  const display = resolveNameDisplay(null);
  assert.deepEqual(display, { nickName: '', realName: '', showRealName: false });
  assert.equal(resolveNameDisplay(undefined).showRealName, false);
});

test('IMMUTABLE_FIELDS —— 实名与权限字段都在禁改名单里', () => {
  for (const field of ['realName', 'gender', 'studentId', 'role', 'status', 'points']) {
    assert.ok(IMMUTABLE_FIELDS.includes(field), `${field} 应当明确不可改`);
  }
});
