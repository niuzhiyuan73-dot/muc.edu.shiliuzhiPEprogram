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
  maskStudentId,
  sanitizePublicMember,
};
