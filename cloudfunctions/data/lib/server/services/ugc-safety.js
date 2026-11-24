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
    const failClosed = typeof process !== 'undefined' && process && process.env && process.env.UGC_FAIL_CLOSED === 'on';
    try {
      const verdict = await customChecker({
        content: texts.join('\n'),
        openId: (ctx && ctx.openId) || '',
        scene: 2,
      });
      const errCode = verdict && verdict.errCode !== undefined && verdict.errCode !== null
        ? Number(verdict.errCode)
        : 0;
      if (verdict && (verdict.ok === false || errCode === 87014
        || (verdict.result && verdict.result.suggest === 'risky'))) {
        return {
          ok: false,
          code: 'UGC_BLOCKED',
          message: (verdict && verdict.message) || '内容未通过安全检测，请修改后重试',
        };
      }
      // 【非 0 errCode 不是「通过」】微信 msgSecCheck 的鉴权失败、频率限制等
      // 都以 errCode 返回，不会抛异常；旧实现只在 catch 里看 UGC_FAIL_CLOSED，
      // 结果打开失败关闭也照样放行。这里把「调用失败」与「内容违规」分开：
      // 违规必拦；调用失败按开关决定拒绝或告警放行。
      if (errCode !== 0) {
        console.warn('[ugc-safety] 外部内容安全检测返回错误码', errCode, (verdict && verdict.errMsg) || '');
        if (failClosed) {
          return { ok: false, code: 'UGC_UNAVAILABLE', message: '内容安全服务暂时不可用，请稍后重试' };
        }
      }
      // review（疑似）不是确定违规；默认放行并留痕，失败关闭模式下转人工前先拦。
      if (verdict && verdict.result && verdict.result.suggest === 'review') {
        console.warn('[ugc-safety] 内容安全检测结果为 review，按当前策略放行');
        if (failClosed) {
          return { ok: false, code: 'UGC_UNAVAILABLE', message: '内容需要人工复核，请稍后重试' };
        }
      }
    } catch (err) {
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
