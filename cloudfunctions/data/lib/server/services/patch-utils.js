/**
 * 局部字段更新与点路径安全合并工具（G1 统一仓储底座）
 * ============================================================
 * 同时服务于：
 *   1. 内存端 / 仿真器 `io.update` 的点路径合并（如 `'seasonPointsByAssociation.pkb': 22`）；
 *   2. 云端事务读缓存 `instrumentTransaction` 的原地更新；
 *   3. `buildScoped` 写入前对顶层与点路径归属字段的防篡改校验。
 * ============================================================
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = cloneValue(v);
    }
    return out;
  }
  return value;
}

function parseDotPath(key) {
  const parts = String(key).split('.');
  if (parts.some((seg) => !seg || FORBIDDEN_SEGMENTS.has(seg))) {
    throw new Error(`非法更新字段路径：${key}`);
  }
  return parts;
}

/**
 * 校验局部更新补丁不会篡改归属字段（顶层或点路径首段）及 `_id`。
 *
 * @param {Object} patch
 * @param {Object} expected 范围字段对象（如 `{ schoolId, association }`）
 * @param {string} mismatchMessage 越权报错文案
 * @param {string} [id] 记录主键（可选，传入时校验 `patch._id` 一致性）
 */
function assertPatchScopeSafe(patch, expected, mismatchMessage, id) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('更新补丁必须为对象');
  }
  if (id !== undefined && patch._id !== undefined && patch._id !== id) {
    throw new Error('记录 ID 不一致');
  }
  for (const [rawKey, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const segments = parseDotPath(rawKey);
    const root = segments[0];
    if (Object.prototype.hasOwnProperty.call(expected, root)) {
      if (segments.length > 1 || value !== expected[root]) {
        throw new Error(mismatchMessage);
      }
    }
  }
}

/**
 * 不可变应用局部补丁（支持顶层字段与 `a.b.c` 点路径）。
 *
 * @param {Object} doc 原文档
 * @param {Object} patch 补丁对象
 * @returns {Object} 合并后的新文档副本
 */
function applyPatch(doc, patch) {
  const base = isPlainObject(doc) ? cloneValue(doc) : {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;

  for (const [rawKey, rawVal] of Object.entries(patch)) {
    if (rawVal === undefined) continue;
    const segments = parseDotPath(rawKey);
    const nextVal = cloneValue(rawVal);

    if (segments.length === 1) {
      base[segments[0]] = nextVal;
      continue;
    }

    let cursor = base;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (!isPlainObject(cursor[seg])) {
        cursor[seg] = {};
      } else {
        cursor[seg] = { ...cursor[seg] };
      }
      cursor = cursor[seg];
    }
    cursor[segments[segments.length - 1]] = nextVal;
  }

  return base;
}

/**
 * 是否启用字段级局部更新（默认开启；设置 `PARTIAL_UPDATE=off` 可一键回退整文档 `set`）。
 * @returns {boolean}
 */
function isPartialUpdateEnabled() {
  if (typeof process === 'undefined' || !process || !process.env) return true;
  return process.env.PARTIAL_UPDATE !== 'off';
}

module.exports = {
  applyPatch,
  assertPatchScopeSafe,
  isPartialUpdateEnabled,
};
