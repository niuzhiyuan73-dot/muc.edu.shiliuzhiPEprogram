/**
 * 稳定的值指纹（前端本地比较用）。
 * ============================================================
 * `JSON.stringify` 的属性顺序取决于对象的插入顺序：同一份表单经两条路径
 * 构造（编辑一次 / 刷新回来），键序不同就会得到两个字符串，表现为
 * 「明明没改，却提示有未提交改动」或「确认后又被判成内容变了」。
 *
 * 这里按对象键排序后再序列化，数组保持原序（顺序本身是语义）。只用于
 * 脏检查与二次确认，不用于安全校验——真正的幂等与权限都在服务端。
 */

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  });
  return out;
}

/** 值 → 稳定字符串。undefined 与缺失同义，对象里直接丢掉。 */
function fingerprintOf(value) {
  return JSON.stringify(canonical(value));
}

module.exports = { fingerprintOf };
