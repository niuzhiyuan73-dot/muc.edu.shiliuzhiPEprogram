/**
 * 学院目录（colleges）的短 TTL 缓存
 * ============================================================
 * 【为什么值得单独缓存】（2026-10-28 审计 2 P-1）
 * `colleges` 是学校级字典：业务代码里**没有任何写入点**（只有种子与控制台初始化），
 * 但每个列表/详情请求都要整表读一次，只为把 `collegeId` 翻译成学院名。实测
 * `listAssociationMembers` 一次请求读 29 条文档，其中 26 条是这个目录——九成的读
 * 花在了一个基本不变的字典上，而云开发是按读取条数计费的。
 *
 * 【为什么键挂在 repo 上，而不是模块级 Map】
 * 内存仓储与云端仓储是两个实例，测试里每个用例还会新建一份。按 repo 用 WeakMap
 * 分桶：实例销毁时缓存自然回收，用例之间也不会串味；云端容器内 repo 是单例，
 * 所以同一个热实例上确实只读一次。
 *
 * 【为什么是 60 秒而不是永久】
 * 学院不是绝对不可变——控制台可能补录。60 秒是「改完最多等一分钟」与「一小时内
 * 几千次请求各读 26 条」之间的折中。TTL 内不做主动失效：为一个字典再引一套失效
 * 协议不值当。
 *
 * 【只用于事务外】
 * 传进来的 ctx 必须是请求级上下文（`ctx.repo` 是根仓储）。事务内要读学院时仍在
 * 事务里点读/列读——那里的数据必须是事务内的一致快照。
 */

/** 缓存有效期：一分钟。学院变更极低频，这点延迟换掉的是每个请求一次整表读。 */
const TTL_MS = 60 * 1000;

/** 单实例最多缓存多少所学校的目录，超出直接清空（学校数量级很小）。 */
const MAX_SCHOOLS = 200;

/** repo → Map<schoolId, { docs, expiresAt }> */
const stores = new WeakMap();

/**
 * 取某校的学院目录（带缓存）。
 *
 * @param {Object} ctx 请求级上下文（需要 `repo` 与 `schoolId`，`forScope` 还要 association）
 * @param {Object} [repoOverride] 调用方手里已有的仓储（通常是 `ctx.repo`，少数函数把它
 *        当参数传下来）。不传就用 `ctx.repo`。
 * @returns {Promise<Array<Object>>} 学院文档数组；参数不全时返回空数组
 */
async function loadColleges(ctx, repoOverride) {
  const repo = repoOverride || (ctx && ctx.repo);
  const schoolId = String((ctx && ctx.schoolId) || '');
  if (!repo || !schoolId) return [];

  let perRepo = stores.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    stores.set(repo, perRepo);
  }
  const hit = perRepo.get(schoolId);
  if (hit && hit.expiresAt > Date.now()) return hit.docs;

  // 【运动会上下文没有 association】
  // `forScope` 要求 schoolId + association，而运动会是学校级栏目（请求里不带协会）。
  // 学院目录本来就只按学校归属，所以没有协会时改走按校列举；两边读的是同一批文档，
  // 缓存键仍只有 schoolId，不会串味（2026-10-29 第十一轮审计 P2-5）。
  const docs = ctx && ctx.association
    ? await repo.forScope(ctx).colleges.list()
    : await repo.colleges.listBySchool(schoolId);
  const rows = Array.isArray(docs) ? docs : [];
  perRepo.set(schoolId, { docs: rows, expiresAt: Date.now() + TTL_MS });
  if (perRepo.size > MAX_SCHOOLS) perRepo.clear();
  return rows;
}

module.exports = { loadColleges, TTL_MS };
