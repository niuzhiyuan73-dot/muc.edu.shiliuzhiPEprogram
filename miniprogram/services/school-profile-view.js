/**
 * 学校维度「编辑资料」装载器（协议 2，M3-c 的页面配套）
 * ============================================================
 * 与旧栈 `pages/profile-edit` 的差别只有「从哪儿取自己」：旧栈读 `getApp()` 的
 * 全局登录态，学校维度下没有这样一份客户端账号快照——账号由服务端按 OpenID
 * 解析。所以这里向身份接口问一次会话（我是谁），再向协会空间问一次自己的会员
 * 档案（实名 / 性别 / 学院 / 头像），两块拼成页面要的只读信息。
 *
 * 【为什么分两处取】
 * 会话只下发 userId / 昵称 / 学校，**刻意不下发账号级实名**（见
 * school-membership 的 getSchoolIdentitySession 注释与它的用例）；实名 / 性别 /
 * 学院在会员档案里（getSchoolMember），且那条口对「本校在册会员」才放行。
 * 两处各司其职，谁都不越权。
 *
 * 【学号从哪来】
 * 会员档案**不下发学号**（隐私口径），但自己的学校身份里有——会话的 account 就是
 * 自己那条 schoolMember，取它的 studentId 即可。
 *
 * 【能改什么，这一层说了不算】
 * 只组 `{nickName, avatarUrl}` 两个字段，真正的白名单与校验在服务端
 * `updateSchoolProfile` → `profile.buildProfilePatch`（同一把尺子）。
 *
 * 本模块不碰 wx API，因而能在 Node 里逐条测。
 * ============================================================
 */

const identity = require('./school-identity.js');
const space = require('./association-space.js');
const { GENDER_LABEL } = require('../shared/utils/constants.js');
const { NICKNAME_MAX, resolveNameDisplay } = require('../shared/services/profile.js');

/** 拿不到会话（没有账号）时的说法，与旧栈同一句 */
const LOGIN_BLOCK = '请先登录后再修改资料';

/** 昵称首字占位头像。没有昵称时用一个方块字，绝不渲染空 */
function avatarTextOf(nickName) {
  return (nickName || '？').slice(0, 1);
}

/**
 * 装载「编辑资料」页。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @returns {Promise<Object>} 页面数据：allowed / blockReason / form / avatarText /
 *   realName / genderText / studentId / nicknameMax
 */
async function loadSchoolProfileEditView(options = {}) {
  const scope = { schoolId: options.schoolId, association: options.association };
  const session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
  const user = session && session.user;

  if (!user) {
    return {
      allowed: false,
      blockReason: LOGIN_BLOCK,
      nicknameMax: NICKNAME_MAX,
      form: { nickName: '', avatarUrl: '' },
      avatarText: '',
      realName: '',
      genderText: '',
      studentId: '',
    };
  }

  // 自己的会员档案。没有读权限（如尚未入会）时留空，不把整页打白——
  // 昵称 / 头像仍可改（账号级动作），只是没有实名可展示。
  const profile = await space.forScope(scope).getSchoolMember({ userId: user.userId });
  const member = profile && profile.ok ? profile.member : null;

  const display = resolveNameDisplay(member || { nickName: user.nickName });
  return {
    allowed: true,
    blockReason: '',
    nicknameMax: NICKNAME_MAX,
    form: { nickName: display.nickName, avatarUrl: (member && member.avatarUrl) || user.avatarUrl || '' },
    avatarText: avatarTextOf(display.nickName),
    realName: display.realName,
    genderText: (member && GENDER_LABEL[member.gender]) || '',
    studentId: (session.account && session.account.studentId) || '',
  };
}

/**
 * 把表单揉成提交补丁。**只挑可改的两项**——服务端还会再清洗一遍。
 * @param {Object} [form]
 * @returns {{nickName: string, avatarUrl: string}}
 */
function schoolProfilePatch(form) {
  const source = form && typeof form === 'object' ? form : {};
  return {
    nickName: typeof source.nickName === 'string' ? source.nickName : '',
    avatarUrl: typeof source.avatarUrl === 'string' ? source.avatarUrl : '',
  };
}

module.exports = { LOGIN_BLOCK, avatarTextOf, loadSchoolProfileEditView, schoolProfilePatch };
