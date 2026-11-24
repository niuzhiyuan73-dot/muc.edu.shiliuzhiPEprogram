/**
 * 学校身份的纯构造器：平台账号（registerSchoolAccount）与学校申请（applySchoolMembership）。
 * 实际审批、学号占用与转校事务在 S2 接入。
 *
 * 【平台账号与学校身份分开登记（迁移清单 §7）】
 * 真名 / 性别留在平台账号上——它是一个人跨学校的身份；学号 / 学院随学校走，
 * 归到学校身份（buildSchoolApplication）。所以注册账号只校验真名与性别，
 * 学号 / 学院在申请时另行登记。两侧的校验规则都取自旧栈纯模块（同一把尺子）。
 */
const {
  SCHOOL_MEMBER_STATUS, schoolMemberKey, schoolAccountKey, PLATFORM_STATUS, PLATFORM_ROLE,
} = require('../../shared/utils/school.js');
const { PROFILE_RULES } = require('../../shared/services/auth.js');
const { validateProfilePatch, NICKNAME_MAX } = require('../../shared/services/profile.js');
const { accountDirectoryFields } = require('./account-directory.js');

/** 平台账号上仍成立的实名字段：真名与性别。规则直接取自旧栈 auth.PROFILE_RULES。 */
const ACCOUNT_RULES = PROFILE_RULES.filter((rule) => ['realName', 'gender'].includes(rule.field));

function normalizeSchoolAccount(form) {
  const source = form && typeof form === 'object' ? form : {};
  const pick = (value) => (value === null || value === undefined ? '' : String(value).trim());
  return {
    realName: pick(source.realName),
    // 与旧栈同口径：性别统一转大写，容忍表单传来的小写 'm' / 'f'
    gender: pick(source.gender).toUpperCase(),
    nickName: pick(source.nickName),
    avatarUrl: pick(source.avatarUrl),
  };
}

/**
 * 校验注册表单里属于平台账号的部分。
 * @param {Object} [form]
 * @returns {{valid:boolean, errors:Object<string,string>, firstError:string, profile:Object}}
 */
function validateSchoolAccount(form = {}) {
  const profile = normalizeSchoolAccount(form);
  const errors = {};
  for (const rule of ACCOUNT_RULES) {
    if (!rule.test(profile[rule.field])) errors[rule.field] = rule.message;
  }
  const display = validateProfilePatch({
    ...(profile.nickName ? { nickName: profile.nickName } : {}), avatarUrl: profile.avatarUrl,
  });
  Object.assign(errors, display.errors);
  const firstFailed = ACCOUNT_RULES.find((rule) => errors[rule.field]);
  return {
    valid: !firstFailed && display.valid, errors,
    firstError: firstFailed ? firstFailed.message : display.firstError, profile,
  };
}

/**
 * 由微信 OpenID 组装一条平台账号。
 *
 * 编号只由 OpenID 派生（`schoolAccountKey`），同一微信身份恒一条，重复注册
 * 落同一键；角色 / 状态一律服务端盖章（普通会员 / 平台启用），不接受前端传入。
 * 昵称缺省时退回真名，与旧栈 `auth.buildAccount` 同一口径。
 *
 * @param {Object} params
 * @param {string} params.openId 微信 OpenID，账号凭证
 * @param {Object} [params.profile] 注册表单（真名 / 性别 / 昵称 / 头像）
 * @param {Date|string} [params.now] 注册时间，便于测试固定
 * @returns {{ok:boolean, account:Object|null, errors:Object, firstError:string}}
 */
function buildSchoolAccount({ openId, profile, now = new Date() } = {}) {
  const normalizedOpenId = typeof openId === 'string' ? openId.trim() : '';
  if (!normalizedOpenId) return { ok: false, account: null, errors: {}, firstError: '请先授权微信登录' };
  const validation = validateSchoolAccount(profile);
  if (!validation.valid) {
    return { ok: false, account: null, errors: validation.errors, firstError: validation.firstError };
  }
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) {
    return { ok: false, account: null, errors: {}, firstError: '注册时间无效' };
  }
  const p = validation.profile;
  return {
    ok: true,
    errors: {},
    firstError: '',
    account: {
      _id: schoolAccountKey(normalizedOpenId),
      openId: normalizedOpenId,
      nickName: p.nickName || p.realName.slice(0, NICKNAME_MAX),
      avatarUrl: p.avatarUrl,
      realName: p.realName,
      gender: p.gender,
      ...accountDirectoryFields({ ...p, nickName: p.nickName || p.realName.slice(0, NICKNAME_MAX) }),
      platformStatus: PLATFORM_STATUS.ACTIVE,
      platformRole: PLATFORM_ROLE.MEMBER,
      joinDate: date.toISOString(),
    },
  };
}

function buildSchoolApplication({ userId, school, college, studentId, now = new Date() } = {}) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('缺少用户身份');
  if (!school || school.status !== 'active') throw new Error('学校不可申请');
  if (!college || college.status !== 'active' || college.schoolId !== school.schoolId || !college.collegeId) {
    throw new Error('请选择本校有效学院');
  }
  const normalized = typeof studentId === 'string' ? studentId.trim() : '';
  if (!normalized || normalized.length > 64 || /\s/.test(normalized)) throw new Error('学号格式不正确');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('申请时间无效');
  return {
    _id: schoolMemberKey(userId, school.schoolId), userId, schoolId: school.schoolId,
    collegeId: college.collegeId, studentId: normalized,
    status: SCHOOL_MEMBER_STATUS.PENDING, appliedAt: date.toISOString(),
  };
}

module.exports = { normalizeSchoolAccount, validateSchoolAccount, buildSchoolAccount, buildSchoolApplication };
