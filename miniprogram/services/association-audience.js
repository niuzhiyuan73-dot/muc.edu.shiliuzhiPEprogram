/**
 * 小组限制（受众范围）的纯规则
 * ============================================================
 * 赛事 / 训练要表达「这次谁能报名」：不限，或只限若干会员小组。本模块只管
 * 这两个字段的**规范化、校验与并集命中**，不碰仓储、不碰时间、不碰角色。
 *
 * 【为什么单独一个纯模块】
 * 写入端（发布赛事、发布训练）与读取端（详情、报名资格）以及云端处理器都要
 * 用同一套判断。写死在某个页面里，迟早出现「发布时说合法、报名时说不合法」
 * 的分叉。放进纯模块后 miniprogram 与云端共享同一份实现（见同步清单）。
 *
 * 【规范形式】
 *   { audienceMode: 'all',    audienceGroupIds: [] }
 *   { audienceMode: 'groups', audienceGroupIds: ['g1', 'g2'] }   // 去重、升序
 * 混合非法（all 带非空数组、groups 为空）一律拒绝，不静默降级为不限。
 *
 * 【旧数据兼容】
 * 历史活动可能根本没有这两个字段。**读**的时候缺字段按「不限」解释；但客户端
 * 明确传 groups 却给空数组属于格式错误，buildAudience 会拒绝——两者不能混为
 * 一谈，否则一个写坏的请求会被当成旧数据悄悄放过。
 * ============================================================
 */

/** 小组限制模式 */
const AUDIENCE_MODE = Object.freeze({
  ALL: 'all', // 不限小组
  GROUPS: 'groups', // 只限所选小组（并集）
});

/** 小组 ID 的形态：与 schoolKey 里的片段一致，稳定且不含分隔符 */
const GROUP_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 一次限制最多选几个小组。
 *
 * 【为什么必须有】（2026-11-07 审查 P2）报名事务里要**逐组**读本人关系
 * （事务内不能整表查），命中的组还要再读+写一次提升 membershipRevision。
 * 40 个组就是 80+ 个操作，加上下文与报名本身会撞 100 操作的事务预算——
 * 表现为报名随机失败、报错还看不出原因。取 20：最坏 20 读 + 20 写 = 40，
 * 留足余量。
 *
 * 【老数据怎么办】写入路径一律走这里，所以新数据一定在限内；历史超限的活动
 * 读路径（`readAudience`）不做截断，避免悄悄改变「谁有资格报名」的口径。
 */
const AUDIENCE_GROUP_MAX = 20;

/**
 * 把外部传入的限制字段规范化。用于**写入**：非法即拒绝。
 *
 * @param {Object} [payload] { audienceMode, audienceGroupIds }
 * @returns {{ok: boolean, audienceMode: string, audienceGroupIds: string[], message: string}}
 */
function buildAudience(payload = {}) {
  const mode = payload.audienceMode === undefined ? AUDIENCE_MODE.ALL : payload.audienceMode;
  if (mode !== AUDIENCE_MODE.ALL && mode !== AUDIENCE_MODE.GROUPS) {
    return { ok: false, audienceMode: '', audienceGroupIds: [], message: '小组限制类型无效' };
  }
  const raw = payload.audienceGroupIds === undefined ? [] : payload.audienceGroupIds;
  if (!Array.isArray(raw)) {
    return { ok: false, audienceMode: '', audienceGroupIds: [], message: '小组清单格式无效' };
  }
  const ids = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !GROUP_ID_PATTERN.test(id)) {
      return { ok: false, audienceMode: '', audienceGroupIds: [], message: '小组编号无效' };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  ids.sort();

  if (mode === AUDIENCE_MODE.ALL) {
    if (ids.length > 0) {
      return { ok: false, audienceMode: '', audienceGroupIds: [], message: '不限小组时不能指定小组' };
    }
    return { ok: true, audienceMode: AUDIENCE_MODE.ALL, audienceGroupIds: [], message: '' };
  }
  if (ids.length === 0) {
    return { ok: false, audienceMode: '', audienceGroupIds: [], message: '请至少选择一个小组' };
  }
  if (ids.length > AUDIENCE_GROUP_MAX) {
    return { ok: false, audienceMode: '', audienceGroupIds: [],
      message: `最多选择 ${AUDIENCE_GROUP_MAX} 个小组（当前 ${ids.length} 个）` };
  }
  return { ok: true, audienceMode: AUDIENCE_MODE.GROUPS, audienceGroupIds: ids, message: '' };
}

/**
 * 从已存文档读限制字段。用于**读取**：缺字段或 `groups` 为空都按「不限」兼容，
 * 不让旧活动因为历史缺字段变成谁都报名不了。
 *
 * @param {Object} [doc]
 * @returns {{audienceMode: string, audienceGroupIds: string[]}}
 */
function readAudience(doc = {}) {
  const mode = doc && doc.audienceMode === AUDIENCE_MODE.GROUPS ? AUDIENCE_MODE.GROUPS : AUDIENCE_MODE.ALL;
  const ids = Array.isArray(doc && doc.audienceGroupIds)
    ? [...new Set(doc.audienceGroupIds.filter((id) => typeof id === 'string' && id))].sort()
    : [];
  if (mode !== AUDIENCE_MODE.GROUPS || ids.length === 0) {
    return { audienceMode: AUDIENCE_MODE.ALL, audienceGroupIds: [] };
  }
  return { audienceMode: AUDIENCE_MODE.GROUPS, audienceGroupIds: ids };
}

/**
 * 目标用户是否被本次受众允许：不限恒真；限组时命中任一 active 组即可（并集）。
 * 同一用户同时属于多个选中组也只算命中一次——由调用方按用户去重。
 *
 * @param {Object} audience { audienceMode, audienceGroupIds }（文档或规范形式均可）
 * @param {Iterable<string>} activeGroupIds 目标用户当前 active 的小组 ID
 * @returns {boolean}
 */
function audienceAllows(audience, activeGroupIds) {
  const normalized = readAudience(audience);
  if (normalized.audienceMode === AUDIENCE_MODE.ALL) return true;
  const owned = new Set(activeGroupIds || []);
  return normalized.audienceGroupIds.some((id) => owned.has(id));
}

/**
 * 命中的小组 ID（稳定升序），供写报名资格快照。不限时返回空数组。
 * @param {Object} audience
 * @param {Iterable<string>} activeGroupIds
 * @returns {string[]}
 */
function hitGroupIds(audience, activeGroupIds) {
  const normalized = readAudience(audience);
  if (normalized.audienceMode === AUDIENCE_MODE.ALL) return [];
  const owned = new Set(activeGroupIds || []);
  return normalized.audienceGroupIds.filter((id) => owned.has(id));
}

module.exports = {
  AUDIENCE_MODE, GROUP_ID_PATTERN, AUDIENCE_GROUP_MAX,
  buildAudience, readAudience, audienceAllows, hitGroupIds,
};
