/**
 * 个人资料的纯逻辑
 * ============================================================
 * 会员能自己改的只有两样东西：昵称和头像。
 *
 * 【为什么用白名单而不是黑名单】
 * 账号记录里躺着 role、status、points、ratings 这些字段，改一个数字就能
 * 自封管理员、或者给自己刷分。黑名单（「不许改 role」）永远列不全将来
 * 新增的敏感字段，所以这里反过来：只把允许改的两个字段挑出来，
 * 其余的一律丢掉。姓名、学号更是从一开始就不在这份名单里——
 * 它们是实名信息，要与学号核对后才有效，不能让本人随手改掉。
 *
 * 【真名怎么显示】
 * 昵称是用户自己起的，真名是注册时登记的。头卡上两个都显示，位置和
 * 大小让「哪个是昵称」一眼可辨。真名与昵称一样时就不重复了——
 * 「张宇轩（张宇轩）」纯属噪音。
 *
 * 本模块不碰任何 wx / Node API，因而可以在 Node 里完整测试，也才能
 * 原样同步到云函数共享库（见 tools/sync-cloud-lib.js）。
 * ============================================================
 */

/** 允许用户自己修改的字段。多一个都不行，见文件头的说明 */
const EDITABLE_FIELDS = ['nickName', 'avatarUrl'];

/**
 * 明确不受理的字段。列出来只是为了让「为什么改不了」有据可查，
 * 校验时并不依赖它——真正起作用的是 EDITABLE_FIELDS 这份白名单。
 */
const IMMUTABLE_FIELDS = [
  '_id',
  'openId',
  'realName',
  // 性别与姓名、学号同类：它决定初始分与上哪张单打榜（见 constants.GENDER），
  // 让本人随手改等于让他能挑起点分，必须由管理员核改
  'gender',
  'studentId',
  'college',
  'points',
  'role',
  'status',
  'joinDate',
  'ratings',
];

/** 昵称长度上限。够长了，再长头像旁边的位置也放不下 */
const NICKNAME_MAX = 12;
const AVATAR_URL_MAX = 2048;

/** 云文件 ID 与 HTTPS 头像；兼容本地 mock 的微信临时文件地址。 */
function validAvatarUrl(value) {
  return value === '' || (value.length <= AVATAR_URL_MAX && !/[\s\u0000-\u001f\u007f]/.test(value)
    && /^(cloud:\/\/[^/]+\/.+|https:\/\/[^/?#]+(?:[/?#].*)?|wxfile:\/\/.+|https?:\/\/(?:tmp|usr)\/.+)$/.test(value));
}

/**
 * 逐字段的校验规则。顺序即「第一条错误」的取舍顺序。
 * 只校验「本次打算改」的字段——只换头像时不该被昵称规则拦住。
 */
const PROFILE_EDIT_RULES = [
  {
    field: 'avatarUrl', label: '头像', test: validAvatarUrl,
    message: `头像地址无效或超过 ${AVATAR_URL_MAX} 个字符`,
  },
  {
    field: 'nickName',
    label: '昵称',
    test: (value) => value.length >= 1 && value.length <= NICKNAME_MAX && !/[\r\n]/.test(value),
    message: `昵称需为 1~${NICKNAME_MAX} 个字符`,
  },
];

/**
 * 把补丁清洗成「只含白名单字段」的形状，并去掉首尾空格。
 * 没有出现在补丁里的字段保持 undefined——据此区分「不改」与「改成空」。
 *
 * @param {Object} [patch] 原始补丁，可能是任意形状
 * @returns {Object}
 */
function normalizeProfilePatch(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  for (const field of EDITABLE_FIELDS) {
    if (source[field] === undefined) continue;
    out[field] = source[field] === null ? '' : String(source[field]).trim();
  }
  return out;
}

/**
 * 校验一份资料补丁。
 *
 * @param {Object} [patch]
 * @returns {{valid:boolean, errors:Object<string,string>, firstError:string, firstErrorField:string, patch:Object}}
 */
function validateProfilePatch(patch) {
  const normalized = normalizeProfilePatch(patch);
  const errors = {};

  for (const rule of PROFILE_EDIT_RULES) {
    if (normalized[rule.field] === undefined) continue;
    if (!rule.test(normalized[rule.field])) errors[rule.field] = rule.message;
  }

  const firstFailed = PROFILE_EDIT_RULES.find((rule) => errors[rule.field]);

  return {
    valid: !firstFailed,
    errors,
    firstError: firstFailed ? firstFailed.message : '',
    firstErrorField: firstFailed ? firstFailed.field : '',
    patch: normalized,
  };
}

/**
 * 校验并组装一次资料修改。空补丁与非法补丁一样被挡下：
 * 用户什么都没动就点保存，应该明确告诉他，而不是写一条无意义的记录。
 *
 * @param {Object} [patch]
 * @returns {{ok:boolean, patch:Object|null, errors:Object, firstError:string}}
 */
function buildProfilePatch(patch) {
  const validation = validateProfilePatch(patch);
  if (!validation.valid) {
    return { ok: false, patch: null, errors: validation.errors, firstError: validation.firstError };
  }
  if (Object.keys(validation.patch).length === 0) {
    return { ok: false, patch: null, errors: {}, firstError: '没有要修改的内容' };
  }
  return { ok: true, patch: validation.patch, errors: {}, firstError: '' };
}

/**
 * 头卡上怎么同时显示昵称与真名。
 * 真名与昵称一样时不必重复显示——那只是把同一个名字说两遍。
 *
 * @param {Object|null} user 会员记录
 * @returns {{nickName:string, realName:string, showRealName:boolean}}
 */
function resolveNameDisplay(user) {
  const source = user && typeof user === 'object' ? user : {};
  const nickName = String(source.nickName || '').trim();
  const realName = String(source.realName || '').trim();
  return {
    nickName,
    realName,
    showRealName: realName !== '' && realName !== nickName,
  };
}

module.exports = {
  AVATAR_URL_MAX, validAvatarUrl,
  EDITABLE_FIELDS,
  IMMUTABLE_FIELDS,
  NICKNAME_MAX,
  PROFILE_EDIT_RULES,
  normalizeProfilePatch,
  validateProfilePatch,
  buildProfilePatch,
  resolveNameDisplay,
};
