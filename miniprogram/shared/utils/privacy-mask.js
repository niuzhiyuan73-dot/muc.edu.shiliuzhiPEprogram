/**
 * 统一脱敏管道（两端共享纯模块）
 * ============================================================
 * 严禁裸写 `process`：小程序运行时没有 Node global `process`。
 */

function readEnvFlag(envKey, defaultEnabled) {
  const proc = typeof process !== 'undefined' ? process : null;
  if (!proc || !proc.env) return defaultEnabled;
  const raw = proc.env[envKey];
  if (raw === undefined || raw === '') return defaultEnabled;
  const val = String(raw).trim().toLowerCase();
  if (val === 'off' || val === 'false' || val === '0') return false;
  if (val === 'on' || val === 'true' || val === '1') return true;
  return defaultEnabled;
}

/**
 * 脱敏开关：
 * - `PRIVACY_MASK` 默认开启（仅 `'off'` 关闭）；
 * - `PRIVACY_MASK_PUBLIC` 默认关闭（仅 `'on'` 时在公开/跨校视图强制脱敏普通昵称，兼容既有展示与测试）。
 */
function isPrivacyMaskEnabled(envKey = 'PRIVACY_MASK') {
  if (envKey === 'PRIVACY_MASK_PUBLIC') return readEnvFlag('PRIVACY_MASK_PUBLIC', false);
  return readEnvFlag(envKey, true);
}

const PRESERVED_PLACEHOLDERS = new Set(['会员', '已注销用户', '匿名用户', '游客']);

function maskTextChars(text) {
  const s = String(text || '').trim();
  if (!s || s.includes('*') || PRESERVED_PLACEHOLDERS.has(s)) return s;
  const chars = Array.from(s);
  if (chars.length === 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function maskRealName(name, options = {}) {
  if (options.enabled === false || !isPrivacyMaskEnabled()) return String(name || '').trim();
  return maskTextChars(name);
}

function maskDisplayName(name, options = {}) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (options.enabled === false || !isPrivacyMaskEnabled()) return raw;
  if (options.preserveNick === true) return raw;
  return maskTextChars(raw);
}

/**
 * 公开昵称脱敏：只处理「昵称实际就是实名」的情况。
 *
 * 注册时未填昵称会把 `nickName` 回退为 `realName`（产品或历史约定），
 * 若 DTO 只对 `realName` 调 `maskRealName`，前端展示的 `nickName` 仍是完整实名，
 * 脱敏等于没做。这里不改变存储、不改变用户自选昵称，只在公开视图把
 * 「昵称 === 实名（或其实名前 N 位截断）」的值按实名规则脱敏。
 *
 * @param {string} nickName 展示昵称
 * @param {string} realName 实名
 * @param {{canSeeFull?:boolean, enabled?:boolean}} [options] 本人/管理员可看完整值
 * @returns {string}
 */
function maskPublicNickName(nickName, realName, options = {}) {
  const rawNick = String(nickName || '').trim();
  if (!rawNick) return '';
  if (options.canSeeFull === true) return rawNick;
  if (options.enabled === false || !isPrivacyMaskEnabled()) return rawNick;
  const rawReal = String(realName || '').trim();
  if (!rawReal) return rawNick;
  // 注册默认昵称可能按 NICKNAME_MAX 截断，不能只比较全等。
  const same = rawNick === rawReal
    || (rawNick.length >= 2 && rawNick.length < rawReal.length && rawReal.startsWith(rawNick));
  return same ? maskRealName(rawNick, options) : rawNick;
}

function maskStudentId(studentId, options = {}) {
  const raw = String(studentId || '').trim();
  if (!raw) return '';
  if (options.enabled === false || !isPrivacyMaskEnabled()) return raw;
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 2)}${'*'.repeat(raw.length - 4)}${raw.slice(-2)}`;
}

function sanitizePublicMember(doc, options = {}) {
  if (!doc || typeof doc !== 'object') return null;
  const out = { ...doc };
  delete out.openId;
  delete out.studentId;
  delete out.phone;
  delete out.idCard;
  if (typeof out.realName === 'string') {
    out.realName = maskRealName(out.realName, options);
  }
  if (options.maskNick === true && typeof out.nickName === 'string') {
    out.nickName = maskDisplayName(out.nickName, options);
  }
  return out;
}

module.exports = {
  isPrivacyMaskEnabled,
  maskRealName,
  maskDisplayName,
  maskPublicNickName,
  maskStudentId,
  sanitizePublicMember,
};
