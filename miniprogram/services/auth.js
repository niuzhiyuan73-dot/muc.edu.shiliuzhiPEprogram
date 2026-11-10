/**
 * 登录与会籍
 * ============================================================
 * 这里放三件事，全部不依赖任何微信 API，因而可以在 Node 里直接测试：
 *
 *   1. 实名信息的校验——姓名、性别、学号、学院
 *   2. 注册申请的组装——新账号一律是「待审核」，不能自己把自己激活
 *   3. 登录态判定——能不能录入成绩、要不要提示待审核、能不能看战绩
 *
 * 【为什么 wx.login 不在这里】
 * 真正与微信打交道的那一步（取 code、授权昵称头像）放在页面层
 * （pages/login）。这样上面这些判断逻辑可以脱离微信测试，而微信 API
 * 的调用集中在少数几处，将来换成云端（user.login 云函数）也只改那一处。
 *
 * 【为什么新账号状态写死为待审核】
 * 实名信息必须由管理员核对学号与姓名是否对得上，否则任何人都能填个
 * 假名注册进来打球。把「激活」的权力留在后台，是防刷分的第一道闸门。
 * ============================================================
 */

const {
  ROLE,
  USER_STATUS,
  USER_STATUS_LABEL,
  ROLE_LABEL,
  ALL_GENDERS,
  COLLEGES,
} = require('../utils/constants.js');
const { createEmptyRatings } = require('../utils/rating.js');

/**
 * 各字段的校验规则。
 * label 用于拼错误文案，test 返回 true 表示通过。
 * 顺序即表单顺序，校验时按此顺序取「第一条错误」。
 */
const PROFILE_RULES = [
  {
    field: 'realName',
    label: '姓名',
    test: (value) => value.length >= 2 && value.length <= 15 && /^[\u4e00-\u9fa5A-Za-z·\s]+$/.test(value),
    message: '请填写 2~15 个字的真实姓名（中文或字母）',
  },
  {
    field: 'gender',
    label: '性别',
    // 只认 'M' / 'F' 两个取值。它决定初始分与上榜的性别榜，缺失即判不通过——
    // 放任空值，会员会在两张单打榜上同时消失（见 constants.GENDER 的说明）
    test: (value) => ALL_GENDERS.includes(value),
    message: '请选择性别',
  },
  {
    field: 'studentId',
    label: '学号',
    test: (value) => /^\d{6,12}$/.test(value),
    message: '学号应为 6~12 位数字',
  },
  {
    field: 'college',
    label: '学院',
    test: (value) => COLLEGES.includes(value),
    message: '请选择所属学院',
  },
];

/**
 * 去掉各项的首尾空格，并把缺失字段补成空串。
 * 用户从别处复制粘贴来的学号很容易带空格，不处理会莫名其妙校验失败。
 *
 * @param {Object} [form]
 * @returns {Object}
 */
function normalizeProfile(form) {
  // 传进来的可能是 null、字符串等非对象，统一当成空表单处理，避免取值时抛错
  const source = form && typeof form === 'object' ? form : {};
  const pickString = (value) => (value === null || value === undefined ? '' : String(value).trim());
  return {
    realName: pickString(source.realName),
    // 统一转成大写：表单偶尔会传来小写的 'm' / 'f'，不该因此判错
    gender: pickString(source.gender).toUpperCase(),
    studentId: pickString(source.studentId),
    college: pickString(source.college),
    nickName: pickString(source.nickName),
    avatarUrl: pickString(source.avatarUrl),
  };
}

/**
 * 校验实名信息。
 *
 * @param {Object} [form] 原始表单，内部会先做 normalize
 * @returns {{valid:boolean, errors:Object<string,string>, firstError:string, firstErrorField:string, profile:Object}}
 */
function validateProfile(form = {}) {
  const profile = normalizeProfile(form);
  const errors = {};

  for (const rule of PROFILE_RULES) {
    if (!rule.test(profile[rule.field])) {
      errors[rule.field] = rule.message;
    }
  }

  const firstFailed = PROFILE_RULES.find((rule) => errors[rule.field]);

  return {
    valid: !firstFailed,
    errors,
    firstError: firstFailed ? firstFailed.message : '',
    firstErrorField: firstFailed ? firstFailed.field : '',
    profile,
  };
}

/**
 * 根据表单组装一条「待审核」的账号记录。
 *
 * 形状与 seed.js 里的会员保持一致（含 ratings），这样登录后即使在
 * 名单里查不到这个人，各页面也能拿它当普通会员对象来渲染。
 *
 * @param {Object} params
 * @param {string} [params.openId] 微信 OpenID。mock 模式下为空
 * @param {Object} params.profile 实名信息
 * @param {Date} [params.now] 注册时间，便于测试固定
 * @returns {Object} 会员记录
 */
function buildAccount({ openId = '', profile = {}, now = new Date() }) {
  const p = normalizeProfile(profile);

  return {
    // 本地账号在前端生成一个临时 _id；上云后由云函数分配并去重
    _id: openId ? `local_${openId}` : `local_${now.getTime()}`,
    openId,
    nickName: p.nickName || p.realName,
    avatarUrl: p.avatarUrl,
    realName: p.realName,
    gender: p.gender,
    studentId: p.studentId,
    college: p.college,
    points: 0,
    role: ROLE.MEMBER,
    // 关键：注册只产生申请，激活由管理员在后台完成
    status: USER_STATUS.PENDING,
    joinDate: now,
    ratings: createEmptyRatings(),
  };
}

/**
 * 由一条会员记录推导出界面需要的登录态。
 *
 * 页面只读这里给出的布尔量，而不用自己去比对 status 的数值——
 * 将来状态机若有增减，改动只发生在本函数一处。
 *
 * @param {Object|null} user
 * @returns {Object}
 */
function resolveAuthState(user) {
  if (!user) {
    return {
      loggedIn: false,
      status: null,
      statusLabel: '未登录',
      roleLabel: '',
      isActive: false,
      isPending: false,
      isDisabled: false,
      canRecord: false,
      notice: '登录后可查看自己的等级分、排名与逐场战绩',
    };
  }

  const status = user.status;
  const isActive = status === USER_STATUS.ACTIVE;
  const isPending = status === USER_STATUS.PENDING;
  const isDisabled = status === USER_STATUS.DISABLED;

  let notice = '';
  if (isPending) notice = '实名信息正在审核，通过后即可录入比赛成绩';
  else if (isDisabled) notice = '账号已被禁用，如有疑问请联系管理员';

  return {
    loggedIn: true,
    status,
    statusLabel: USER_STATUS_LABEL[status] || '',
    roleLabel: ROLE_LABEL[user.role] || '',
    isActive,
    isPending,
    isDisabled,
    // 只有审核通过的账号才能录成绩，待审核只能浏览
    canRecord: isActive,
    notice,
  };
}

/**
 * 校验并组装一次注册申请。
 *
 * @param {Object} form 实名信息表单
 * @param {Object} [options]
 * @param {string} [options.openId]
 * @param {Date} [options.now]
 * @returns {{ok:boolean, account:Object|null, state:Object, errors:Object, firstError:string}}
 */
function register(form, options = {}) {
  const validation = validateProfile(form);
  if (!validation.valid) {
    return {
      ok: false,
      account: null,
      state: resolveAuthState(null),
      errors: validation.errors,
      firstError: validation.firstError,
    };
  }

  const account = buildAccount({ ...options, profile: validation.profile });
  return {
    ok: true,
    account,
    state: resolveAuthState(account),
    errors: {},
    firstError: '',
  };
}

module.exports = {
  COLLEGES,
  PROFILE_RULES,
  normalizeProfile,
  validateProfile,
  buildAccount,
  resolveAuthState,
  register,
};
