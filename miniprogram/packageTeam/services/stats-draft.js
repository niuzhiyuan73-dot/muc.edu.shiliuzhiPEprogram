/**
 * 团队比赛统计的本地草稿
 * ============================================================
 * 现场录统计最怕两件事：小程序被切走 / 被回收，以及误触取消把整张表清空。
 * 服务端草稿是另一套业务状态（裁判提交、负责人审核），这里只保存**尚未提交**
 * 的本地输入，不改接口、不冒充已保存。
 *
 * 约束：
 *   · 键按学校 + 协会 + 场次隔离，同一台设备换账号时不会串到别人；
 *   · 记录打开面板时的 revision。服务端版本变了就不自动套用旧草稿，
 *     由页面明确提示冲突，避免覆盖其他人的修改；
 *   · 24 小时过期，成功保存后立即删除；
 *   · 只恢复已知球员行与已知指标，存储里被塞入未知字段也不会进入视图。
 *
 * 本模块不依赖 wx 的存在，测试里可注入 storage 替身。
 * ============================================================
 */

const VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'shilzi:team-stats-draft:v1:';

/** 读取当前登录人；拿不到时用 anonymous，至少同设备同场次仍可恢复。 */
function currentUserId() {
  try {
    const dto = require('../../services/app-session.js').get();
    const userId = dto && dto.session && dto.session.user && dto.session.user.userId;
    if (userId) return userId;
  } catch (err) {
    // 继续尝试旧页面的 app 兼容对象
  }
  try {
    if (typeof getApp === 'function') {
      const app = getApp();
      const user = app && typeof app.getUserInfo === 'function' ? app.getUserInfo() : app && app.globalData && app.globalData.userInfo;
      const id = user && (user._id || user.userId);
      if (id) return id;
    }
  } catch (err) {
    // 测试或未登录环境没有 app，落回 anonymous
  }
  return 'anonymous';
}

/** 草稿键。各段编码，避免冒号出现在业务编号里时拼出歧义键。 */
function keyOf(input = {}) {
  const parts = [
    input.schoolId || '',
    input.association || '',
    input.matchId || '',
    input.userId || currentUserId(),
  ].map(value => encodeURIComponent(String(value)));
  return `${PREFIX}${parts.join(':')}`;
}

function storageOf(injected) {
  if (injected) return injected;
  if (typeof wx !== 'undefined' && wx && typeof wx.setStorageSync === 'function') {
    return {
      get: key => wx.getStorageSync(key),
      set: (key, value) => wx.setStorageSync(key, value),
      remove: key => {
        if (typeof wx.removeStorageSync === 'function') wx.removeStorageSync(key);
      },
    };
  }
  return null;
}

/**
 * 保存草稿。
 * @param {string} key keyOf 的结果
 * @param {Object} draft { revision, mode, rows }
 * @param {Object} [injected] 测试用 storage
 * @returns {boolean} 是否写入成功
 */
function save(key, draft, injected) {
  const storage = storageOf(injected);
  if (!storage || !key || !draft || !Array.isArray(draft.rows)) return false;
  try {
    storage.set(key, {
      version: VERSION,
      savedAt: Date.now(),
      revision: Number(draft.revision) || 0,
      mode: draft.mode === 'detailed' ? 'detailed' : 'basic',
      rows: draft.rows.map(row => ({ ...row })),
    });
    return true;
  } catch (err) {
    // 本地空间满 / 存储被禁用：草稿是增强能力，不能拖垮录入本身
    return false;
  }
}

/**
 * 读取未过期草稿。格式不合法或过期时顺手删除。
 * @param {string} key
 * @param {Object} [injected]
 * @returns {Object|null}
 */
function load(key, injected) {
  const storage = storageOf(injected);
  if (!storage || !key) return null;
  let value;
  try {
    value = storage.get(key);
  } catch (err) {
    return null;
  }
  if (!value || value.version !== VERSION || !Array.isArray(value.rows)) return null;
  if (!Number.isFinite(Number(value.savedAt)) || Date.now() - Number(value.savedAt) > TTL_MS) {
    clear(key, injected);
    return null;
  }
  return value;
}

function clear(key, injected) {
  const storage = storageOf(injected);
  if (!storage || !key) return;
  try {
    storage.remove(key);
  } catch (err) {
    // 删除失败不阻断保存 / 关闭流程；过期数据下次读取时仍会被拒绝
  }
}

/**
 * 把草稿中的已知行、已知指标套回服务端刚下发的空表。
 * 只按 key 对齐，不新增行；revision 不同时整体拒绝，交由页面提示冲突。
 *
 * @param {Array<Object>} rows 服务端当前版本铺出的行
 * @param {Object|null} draft load 的结果
 * @param {string[]} fields 允许恢复的指标字段
 * @param {number} currentRevision 服务端当前版本
 * @returns {{ rows: Array<Object>, restored: boolean, conflict: boolean }}
 */
function merge(rows, draft, fields, currentRevision) {
  const base = Array.isArray(rows) ? rows : [];
  if (!draft || !Array.isArray(draft.rows) || !Array.isArray(fields)) {
    return { rows: base, restored: false, conflict: false };
  }
  if (Number(draft.revision) !== Number(currentRevision)) {
    return { rows: base, restored: false, conflict: true };
  }
  const allowed = new Set(fields);
  const saved = new Map(draft.rows.filter(row => row && row.key).map(row => [row.key, row]));
  let restored = false;
  const next = base.map((row) => {
    const hit = saved.get(row.key);
    if (!hit) return row;
    const out = { ...row };
    allowed.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(hit, field)) {
        out[field] = hit[field] == null ? '' : String(hit[field]);
        restored = true;
      }
    });
    return out;
  });
  return { rows: next, restored, conflict: false };
}

module.exports = {
  VERSION, TTL_MS, PREFIX, keyOf, save, load, clear, merge, currentUserId,
};
