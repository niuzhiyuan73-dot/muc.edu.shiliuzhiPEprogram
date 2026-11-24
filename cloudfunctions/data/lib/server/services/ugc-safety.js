/**
 * UGC 内容安全校验适配器（G4 合规补齐）
 * ============================================================
 * 第一道防线：控制字符过滤 + 本地高危违禁词（支持 `UGC_BLOCK_WORDS` 扩展）；
 * 第二道防线：可插拔异步检测器（如微信 `openapi.security.msgSecCheck`）。
 * 可通过环境变量 `UGC_SAFETY=off` 关闭。
 */

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// 高危违禁基线词（避免误伤任何正常体育/校园词汇）
const DEFAULT_BLOCK_WORDS = [
  '法轮功', '台独', '藏独', '疆独', '暴恐', '恐怖袭击',
  '办证刻章', '代开发票', '出售枪支', '海洛因', '冰毒',
  '裸聊', '约炮', '色情网站', '赌博网站', '博彩平台',
];

let customChecker = null;

function isUgcSafetyEnabled() {
  if (typeof process === 'undefined' || !process || !process.env) return true;
  const raw = String(process.env.UGC_SAFETY || '').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

function blockWords() {
  const extraRaw = (typeof process !== 'undefined' && process && process.env && process.env.UGC_BLOCK_WORDS) || '';
  const extra = String(extraRaw).split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_BLOCK_WORDS.concat(extra);
}

function setUgcChecker(fn) {
  customChecker = typeof fn === 'function' ? fn : null;
}

function resetUgcChecker() {
  customChecker = null;
}

function collectTexts(fields) {
  if (typeof fields === 'string') return [fields];
  if (Array.isArray(fields)) return fields.filter(v => typeof v === 'string');
  if (fields && typeof fields === 'object') {
    return Object.values(fields).filter(v => typeof v === 'string');
  }
  return [];
}

/**
 * 校验用户提交的文本字段。
 *
 * @param {string|Array<string>|Object} fields
 * @param {Object} [ctx]
 * @returns {Promise<{ok:boolean, code?:string, message:string}>}
 */
async function checkUgcContent(fields, ctx = {}) {
  if (!isUgcSafetyEnabled()) return { ok: true, message: '' };
  const texts = collectTexts(fields).map(s => s.trim()).filter(Boolean);
  if (texts.length === 0) return { ok: true, message: '' };

  for (const text of texts) {
    if (CONTROL_CHAR_RE.test(text)) {
      return { ok: false, code: 'UGC_INVALID_CHAR', message: '输入内容包含不支持的控制字符，请修改后重试' };
    }
  }

  const combined = texts.join('\n').toLowerCase();
  for (const word of blockWords()) {
    if (word && combined.includes(word.toLowerCase())) {
      return { ok: false, code: 'UGC_BLOCKED', message: '内容包含敏感信息，请修改后重试' };
    }
  }

  if (customChecker) {
    try {
      const verdict = await customChecker({
        content: texts.join('\n'),
        openId: (ctx && ctx.openId) || '',
        scene: 2,
      });
      if (verdict && (verdict.ok === false || verdict.errCode === 87014
        || (verdict.result && verdict.result.suggest === 'risky'))) {
        return {
          ok: false,
          code: 'UGC_BLOCKED',
          message: (verdict && verdict.message) || '内容未通过安全检测，请修改后重试',
        };
      }
    } catch (err) {
      const failClosed = typeof process !== 'undefined' && process && process.env && process.env.UGC_FAIL_CLOSED === 'on';
      console.warn('[ugc-safety] 外部内容安全检测调用异常', err && err.message);
      if (failClosed) {
        return { ok: false, code: 'UGC_UNAVAILABLE', message: '内容安全服务暂时不可用，请稍后重试' };
      }
    }
  }

  return { ok: true, message: '' };
}

module.exports = {
  isUgcSafetyEnabled,
  setUgcChecker,
  resetUgcChecker,
  checkUgcContent,
};
