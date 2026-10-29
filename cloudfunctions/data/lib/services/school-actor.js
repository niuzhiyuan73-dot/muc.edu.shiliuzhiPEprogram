/**
 * 学校维度：旧栈纯规则模块所需的「角色 / 名单」适配层（协议 2，M1）
 * ============================================================
 * 旧栈的权限纯模块（event.js / match-record.js）认的是**账号**形状：
 * 数值 ROLE、学院全名、性别。S2 的角色分散在 schoolRole / membership 两张表
 * 里，且是字符串。若每个服务各推一遍，口径迟早分叉，所以推导只留这一处：
 *
 *   · legacyRoleOf   —— S2 角色 → 旧栈 ROLE 数值；
 *   · buildDirectory —— 一次读齐本范围的在册名单、会员档案与学院改名表；
 *   · recordOptions  —— 权限判定的公共入参；
 *   · legacyActorOf  —— 组装旧栈纯判定要的「账号」对象。
 *
 * 不含任何业务动作，也不参与处理器注册表，纯做适配。
 *
 * 【为什么 status 一律写 ACTIVE】
 * 只有通过了 S2 的读 / 管理判定（canReadAssociationSpace / canManageAssociationSpace
 * 或本协会会员资格）才会走到这里；platformStatus 与在册状态已由那一层把过关。
 * 这里给旧栈一个「可用账号」的满足值，让 canManageEvent / canCheckIn 这类判定
 * 只看角色，不必再推一遍平台状态。
 * ============================================================
 */

const { permissionOf, isPlatformAdminCtx, PERMISSION } = require('./school-permission.js');
const { loadColleges } = require('./college-directory.js');
const { ROLE, USER_STATUS } = require('../utils/constants.js');
const { PLATFORM_STATUS, collegeKey, schoolMemberKey } = require('../utils/school.js');
const contextCache = require('./context-cache.js');

/* ============================================================
 * 全校名册目录的短 TTL 缓存
 * ============================================================
 * 【为什么值得缓存】（2026-10-29 第十一轮审计 P1-1）
 * `buildDirectory` / `buildCollegeDirectory` 要做同一件事：读**全校**在册成员
 * （`schoolMembers.list()`）再按编号批读**全校**账号（`users.listByIds`）。一所
 * 2000 人的学校，这就是 20 页 + 20 页 = 40 次 RPC、4000 条文档，而它挂在球队
 * 列表/详情、录分入口、赛程指派面板、赛事抽签等 14 处读路径上，首页还会对每个
 * 协会各触发一次。云端按读条数计费，这是当前最大的一笔固定开销。
 *
 * 【为什么 TTL 取 5 秒，而不是像学院目录那样 60 秒】
 * 学院是纯字典（业务代码零写入点），名册目录不是：它会因为入会审批、转校、任免
 * 而变化，并且它的 `activeMemberIds` 参与**权限与资格判定**。5 秒与
 * `context-cache` 的上下文窗口取齐——同一个页面连发十几个请求能被吃掉，
 * 「撤权不生效」的窗口却不会比现状更长。
 *
 * 【失效靠代际号，不靠时间戳】
 * 写动作执行完会 `invalidateAll()`（见 school-request 的 finally），它顺带把
 * 代际号 +1，这里的所有条目立即作废。按范围失效（判球类）**不**递增代际，
 * 因为那类写不碰学籍 —— 否则一场 50 球的比赛会连续打掉全校目录缓存。
 *
 * 【测试与小程序的默认值】
 * `context-cache.stats().ttlMs` 在单元测试与小程序运行时都是 0（见该模块
 * `readTtl` 的说明），所以这里自然关闭：测试每一步都读最新数据，小程序端本来
 * 也不跑这条路径。要验证缓存行为时用 `__setTtlForTest` 显式打开。
 * ============================================================ */
const DIRECTORY_TTL_MS = 5000;
const DIRECTORY_MAX_SCHOOLS = 200;
/** repo → Map<schoolId, { docs, generation, expiresAt }> */
const directoryStores = new WeakMap();

function directoryCacheEnabled() {
  return contextCache.stats().ttlMs > 0;
}

function readDirectoryCache(repo, schoolId, generation) {
  const perRepo = directoryStores.get(repo);
  if (!perRepo) return null;
  const hit = perRepo.get(schoolId);
  if (!hit) return null;
  // 代际变了 = 期间发生过写动作，整批作废（比逐条推时间更直白）。
  if (hit.generation !== generation || hit.expiresAt <= Date.now()) {
    perRepo.delete(schoolId);
    return null;
  }
  return hit.docs;
}

function writeDirectoryCache(repo, schoolId, generation, docs) {
  let perRepo = directoryStores.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    directoryStores.set(repo, perRepo);
  }
  perRepo.set(schoolId, { docs, generation, expiresAt: Date.now() + DIRECTORY_TTL_MS });
  if (perRepo.size > DIRECTORY_MAX_SCHOOLS) perRepo.clear();
}

/**
 * 读一次「本校在册成员 + 账号 + 学院目录」，两端共用。
 *
 * 缓存里存的是**文档与派生 Map**：调用方沿用项目既定纪律「只读不改」，
 * 需要改就 spread 出新的（与 context-cache 同一条约定）。
 *
 * @param {Object} ctx 请求级上下文（事务内请勿使用缓存语义：事务仓储是另一个
 *        实例，WeakMap 天然不命中，读的是一致快照）
 * @returns {Promise<{members:Array<Object>, colleges:Array<Object>, userById:Map<string,Object>}>}
 */
async function loadDirectoryDocs(ctx) {
  const repo = ctx.repo;
  const schoolId = String(ctx.schoolId || '');
  const enabled = directoryCacheEnabled() && Boolean(schoolId);
  const startedGeneration = enabled ? contextCache.currentGeneration() : 0;
  if (enabled) {
    const hit = readDirectoryCache(repo, schoolId, startedGeneration);
    if (hit) return hit;
  }
  const [members, colleges] = await Promise.all([
    repo.forScope(ctx).schoolMembers.list(),
    loadColleges(ctx),
  ]);
  // 账号按在册成员的编号批量取。原先是 ctx.repo.users.list()——users 是平台级
  // 集合（不带 schoolId），一次要把**全平台所有学校**的账号读回来建 Map，
  // 而本函数是每个协会页面的必经之路（2026-10-21 审查 P0-1）。
  const users = await repo.users.listByIds(members.map(item => item.userId));
  const docs = Object.freeze({
    members,
    colleges,
    userById: new Map(users.map(item => [item._id, item])),
  });
  // 与 context-cache 的 C-1 同一条判据：读过程跨了多次 await，期间若有写动作做了
  // 整体失效（代际已变），这份快照就是失效前的，不能写回，否则「清了也没清干净」。
  if (enabled && contextCache.currentGeneration() === startedGeneration) {
    writeDirectoryCache(repo, schoolId, startedGeneration, docs);
  }
  return docs;
}

/**
 * S2 角色 → 旧栈 ROLE 数值，供旧栈纯判定复用。
 * 校级管理员 / 协会负责人 / 平台管理员按「管理员」；学院负责人按「学院职员」。
 * @param {Object} ctx
 * @returns {number}
 */
function legacyRoleOf(ctx) {
  if (isPlatformAdminCtx(ctx)) return ROLE.ADMIN;
  const permission = permissionOf(ctx && ctx.schoolRole, ctx && ctx.membership);
  if (permission === PERMISSION.SCHOOL_ADMIN || permission === PERMISSION.ASSOCIATION_LEADER) return ROLE.ADMIN;
  if (permission === PERMISSION.COLLEGE_LEADER) return ROLE.STAFF;
  return ROLE.MEMBER;
}

// 管理范围来自授权；schoolMember.collegeId 只表示学籍所属学院。
function managementCollegeId(ctx) {
  return legacyRoleOf(ctx) === ROLE.STAFF ? ((ctx.membership && ctx.membership.collegeId) || '')
    : ((ctx.schoolMember && ctx.schoolMember.collegeId) || '');
}

/**
 * 一次读齐本范围的在册名单、会员档案与学院改名表，供权限判定、展示与抽签复用。
 *
 * members 是**会员档案**（含 gender），抽签算种子、配对要用；memberIds 是在册编号，
 * 供 match-record 的阵容校验。user 表是全局的，这里只取本范围在册会员那几份。
 *
 * 【memberIds 与 activeMemberIds 为什么要分开（2026-10-16 独立验收 F4）】
 * 「在册」与「账号还能用」是两件事：
 *   · `memberIds` 只按学籍行状态过滤——离校 / 被拒的人不在里面，但**平台账号被停用**
 *     的人还在。它记录的是「这个人在本校有学籍」这个事实，展示与历史口径要用；
 *   · `activeMemberIds` 再叠一层 `platformStatus === active`，与录分页可选名单
 *     同一口径。**新比赛 / 新阵容**的资格校验用它——否则界面上看不见的人，改个
 *     请求体直接传 ID 就能录进来。
 * 已排定的赛程（签表场次、学院赛小场）不在此列：对阵是抽签定死的既成事实，
 * 一方事后被停用不该把对手卡住，那条通路按记录本身校验（见 submitScheduledMatch）。
 *
 * @param {Object} ctx
 * @returns {Promise<{memberIds:string[], activeMemberIds:string[], members:Array<Object>, actorCollege:string, collegeIdOf:function(string):string, collegeNameById:function(string):string, collegeOf:function(string):string}>}
 */
async function buildDirectory(ctx) {
  const { members, colleges, userById } = await loadDirectoryDocs(ctx);
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  const collegeIdOf = new Map(members.map(item => [item.userId, item.collegeId]));
  const active = members.filter(item => item.status === 'active');
  const activeUsers = active.filter(item => {
    const user = userById.get(item.userId);
    return Boolean(user && user.platformStatus === PLATFORM_STATUS.ACTIVE);
  });
  return {
    memberIds: active.map(item => item.userId),
    activeMemberIds: activeUsers.map(item => item.userId),
    members: active.map(item => userById.get(item.userId)).filter(Boolean),
    // 学院目录：院队按它派生（一个学院一支，编号确定性），读路径不必等 teams 集合里有记录
    colleges: colleges
      .map(item => ({ collegeId: item.collegeId, name: item.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')),
    actorCollege: nameByCollegeId.get(collegeIdOf.get(ctx.actorId)) || '',
    collegeIdOf: userId => collegeIdOf.get(userId) || '',
    collegeNameById: collegeId => nameByCollegeId.get(collegeId) || '',
    collegeOf: userId => nameByCollegeId.get(collegeIdOf.get(userId)) || '',
  };
}

/**
 * 一次读齐本校的**学院目录**与在册会员，供学院赛（名单制）复用旧栈纯校验。
 * ============================================================
 * 旧栈学院赛认「学院全名」，且有效学院写死在全局 `COLLEGES`。学校维度要求
 * 每校一份独立目录（改为稳定 `collegeId`），所以这里把本校 colleges 表读出来，
 * 同时提供「编号 ↔ 全名」的互查，并给在册会员补上 `college` 全名与数字
 * `status`——正是 `college-entry.validateCollegeEntry` 校验队员身份所需。
 *
 * 【为什么同时给编号与全名】
 * 对外主键用**稳定编号**（`collegeEntryKey` 以 collegeId 组成），显示与旧栈
 * 校验仍按**全名**（`managesCollege` / `member.college` 都是全名比对）。两者
 * 一次读齐、就地互查，页面与服务不必各转一遍。
 *
 * @param {Object} ctx
 * @returns {Promise<{
 *   colleges:Array<Object>, collegeNames:Array<string>,
 *   collegeIdOf:function(string):string, collegeOf:function(string):string,
 *   collegeNameById:function(string):string, collegeIdByName:function(string):string,
 *   memberIds:Array<string>, members:Array<Object>,
 *   actorCollege:string, actorCollegeId:string,
 * }>}
 */
async function buildCollegeDirectory(ctx) {
  const { members, colleges, userById } = await loadDirectoryDocs(ctx);
  const nameById = new Map(colleges.map(item => [item.collegeId, item.name]));
  const idByName = new Map(colleges.map(item => [item.name, item.collegeId]));
  const collegeIdOfMember = new Map(members.map(item => [item.userId, item.collegeId]));
  const active = members.filter(item => item.status === 'active');
  const collegeIdOf = userId => collegeIdOfMember.get(userId) || '';
  const collegeOf = userId => nameById.get(collegeIdOfMember.get(userId)) || '';
  return {
    colleges: colleges.slice(),
    collegeNames: colleges.map(item => item.name),
    collegeIdOf,
    collegeOf,
    collegeNameById: collegeId => nameById.get(collegeId) || '',
    collegeIdByName: name => idByName.get(name) || '',
    memberIds: active.map(item => item.userId),
    // 会员档案补「学院全名 + 可用状态」，与旧栈校验所需形状对齐（status 恒 ACTIVE：
    // 离校 / 停用者已被 active 过滤掉，走不到这里）。
    members: active.map(item => {
      const user = userById.get(item.userId);
      if (!user) return null;
      return { ...user, college: nameById.get(item.collegeId) || '', status: USER_STATUS.ACTIVE };
    }).filter(Boolean),
    actorCollege: collegeOf(ctx.actorId),
    actorCollegeId: collegeIdOf(ctx.actorId),
  };
}

/**
 * 权限判定的公共入参：角色 + 操作者学院 + 编号→学院。
 *
 * 学院负责人使用 ctx.membership.collegeId 的授权范围；学籍学院只用于选手归属。
 * 事务内以 fresh 重算，避免撤权或调授权后的在途写入。
 *
 * @param {Object} ctx 事务内 fresh 上下文或事务外上下文
 * @param {Object} dir buildDirectory 的结果（只用到「学院编号 → 全名」的静态映射）
 */
function recordOptions(ctx, dir) {
  const collegeId = managementCollegeId(ctx) ||
    (dir && typeof dir.collegeIdOf === 'function' ? dir.collegeIdOf(ctx.actorId) : '');
  const college = (dir && typeof dir.collegeNameById === 'function' ? dir.collegeNameById(collegeId) : '') ||
    (legacyRoleOf(ctx) !== ROLE.STAFF && dir && dir.actorCollege) || '';
  return { role: legacyRoleOf(ctx), college, collegeOf: dir.collegeOf };
}

/**
 * 组装旧栈纯规则模块要的「账号」对象（event.js 的 canManage/canCheckIn 等）。
 * role / college / gender 取自 S2 推导；status 恒为 ACTIVE（调用方已把过关）。
 *
 * @param {Object} ctx
 * @param {Object} dir buildDirectory 的返回值
 * @returns {Object}
 */
function legacyActorOf(ctx, dir) {
  const actor = (ctx && ctx.actor) || {};
  return {
    _id: ctx.actorId,
    status: USER_STATUS.ACTIVE,
    role: legacyRoleOf(ctx),
    college: legacyRoleOf(ctx) === ROLE.STAFF
      ? (dir.collegeNameById && dir.collegeNameById(managementCollegeId(ctx))) || dir.managedCollegeName || '' : dir.actorCollege,
    schoolCollegeId: (ctx.schoolMember && ctx.schoolMember.collegeId) || '',
    managedCollegeId: legacyRoleOf(ctx) === ROLE.STAFF ? managementCollegeId(ctx) : '',
    gender: actor.gender || '',
    nickName: actor.nickName || '',
    realName: actor.realName || '',
  };
}

/** 没有学院归属时的空目录：`involvesCollege` 的两个条件必然不成立。 */
const EMPTY_RECORD_DIR = Object.freeze({
  actorCollege: '',
  collegeIdOf: () => '',
  collegeNameById: () => '',
  collegeOf: () => '',
});

/**
 * 只取「这场比赛用得上」的那几个学院，而不是全院名单（2026-10-23 H-4）。
 *
 * 【为什么不能直接用 buildDirectory】（2026-10-22 第二轮审查 P-1）
 * `buildDirectory` 会读全校在册名单 + 这批人的账号：2000 人的学校是
 * 20 + 20 = 40 次 RPC。判球路径上**每一球**都要判一次权限，一场 50 球的比赛
 * 光"确认你有没有权限"就要 2000 次 RPC，同场多个场地并行时直接打空全校
 * 每日读配额。
 *
 * 真正需要的信息只有：操作者自己的学院名，加上**这场比赛的两队选手**各自
 * 属于哪个学院。单人赛 2 人、双人赛 4 人，最多 4 次点读 + 2 次学院名点读。
 *
 * 【为什么现在放到这里】原来只服务实时比分（school-live-service），赛事 /
 * 比赛详情同样只需要这一小块——两处各写一份必然分叉，因此上收到适配层。
 *
 * @param {Object} ctx 请求上下文（含 schoolMember）
 * @param {Object} doc 比赛或赛事文档（读 teamA / teamB）
 * @returns {Promise<Object>} 与 recordOptions 兼容的目录形状
 */
async function recordDirOf(ctx, doc) {
  const memberCollegeId = managementCollegeId(ctx);
  // 没有学院归属 ⇒ involvesCollege 的两个条件（college 非空、collegeOf 是函数）
  // 必然不成立，与"全院目录里查不到他的学院"是同一个结论，读都不用读。
  if (!memberCollegeId) return EMPTY_RECORD_DIR;

  const participants = [...new Set([...((doc && doc.teamA) || []), ...((doc && doc.teamB) || [])])];
  const [actorCollege, rows] = await Promise.all([
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, memberCollegeId)),
    Promise.all(participants.map(userId =>
      ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)))),
  ]);
  const actorCollegeName = (actorCollege && actorCollege.name) || '';

  const collegeIdByUser = new Map();
  rows.forEach((row, index) => {
    if (row && row.collegeId) collegeIdByUser.set(participants[index], row.collegeId);
  });

  // 一张「学院编号 → 全名」表，先放操作者自己的学院，再补参赛者涉及的学院。
  // 两边必须走同一张表：involvesCollege 比较的是"操作者学院名 === 参赛者学院名"，
  // 若操作者的学院没有登记进来，同一学院也会被判成不同学院（越权拦截误伤）。
  const nameById = new Map();
  if (memberCollegeId && actorCollegeName) nameById.set(memberCollegeId, actorCollegeName);
  const missingIds = [...new Set([...collegeIdByUser.values()])].filter(id => !nameById.has(id));
  const missing = await Promise.all(missingIds.map(id =>
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, id))));
  missing.forEach((doc2) => {
    if (doc2 && doc2.collegeId) nameById.set(doc2.collegeId, doc2.name || '');
  });

  return {
    actorCollege: actorCollegeName,
    collegeIdOf: userId => collegeIdByUser.get(userId) || '',
    collegeNameById: id => nameById.get(id) || '',
    collegeOf: userId => nameById.get(collegeIdByUser.get(userId)) || '',
  };
}

/**
 * 只取「这批人 + 操作者自己」的学院关系（2026-10-23 第三轮审查 X-3）。
 *
 * 【为什么要另开一条路】
 * `buildDirectory` 读的是**全校**在册名单 + 这批人的账号：2000 人的学校是
 * 40 次 RPC。比赛列表一页最多 100 场、参赛者两三百人，`matchSummary` 真正
 * 需要的只是「这些编号分别属于哪个学院」以及操作者自己的学院名——
 * 为一次翻页读全校名册，是当前全站最大的一笔固定开销（首页六个协会各一次）。
 *
 * 现在：学院目录 1 页（几十条）+ 这一页参赛者的学籍一次批读（每 100 个一批）。
 * 与 `recordDirOf`（单场、按 2~4 个参赛者点读）同一口径，只是这里按批。
 *
 * 【返回值必须与 buildDirectory 的子集形状一致】
 * `recordOptions` 只用到 `collegeIdOf` / `collegeNameById` / `actorCollege` /
 * `collegeOf` 四个成员；这里照抄形状，调用方不必分支。
 *
 * @param {Object} ctx
 * @param {Array<string>} userIds 本页涉及的会员编号（会去重、忽略空值）
 * @returns {Promise<Object>} 与 recordOptions 兼容的目录
 */
async function recordDirOfUsers(ctx, userIds) {
  const memberCollegeId = managementCollegeId(ctx);
  if (!memberCollegeId) return EMPTY_RECORD_DIR;
  return userDirectory(ctx, userIds);
}

/**
 * 「这批人 + 操作者」的学院关系（2026-10-26 第六轮 D）。
 *
 * 与 `recordDirOfUsers` 同一个读法（学院目录 1 页 + 这批人学籍一次批读），
 * 但**不做「操作者没有学院就短路」**那一步：
 *   · 判球路径的短路是对的——同学院判定必然不成立，读都不用读；
 *   · 代签 / 指派这类路径的短路是**错的**——它们要判的是「目标会员属于哪个学院」，
 *     与操作者自己有没有学院无关。短路会让 `collegeOf(target)` 变空串，而
 *     `canCheckIn` 把「目标学院为空」当作「未指定目标」直接放行（见 checkIn 的注释：
 *     始终带上目标学院，避免学院边界被放行）。所以这里必须照常解析。
 *
 * 返回值与 `buildDirectory` 的子集同形（actorCollege / collegeIdOf /
 * collegeNameById / collegeOf），调用方不必分支。
 *
 * @param {Object} ctx
 * @param {Array<string>} userIds 额外需要的会员编号（会去重、忽略空值，自动并入操作者）
 * @returns {Promise<Object>}
 */
async function userDirectory(ctx, userIds) {
  const ids = [...new Set([...(Array.isArray(userIds) ? userIds : []), ctx.actorId]
    .filter(id => typeof id === 'string' && id))];
  const scoped = ctx.repo.forScope(ctx);
  const [colleges, rows] = await Promise.all([
    loadColleges(ctx),
    ids.length ? scoped.schoolMembers.listByIds(ids.map(id => schoolMemberKey(id, ctx.schoolId))) : [],
  ]);
  const nameById = new Map(colleges.map(item => [item.collegeId, item.name]));
  const collegeIdByUser = new Map();
  for (const row of rows) {
    if (row && row.userId && row.collegeId) collegeIdByUser.set(row.userId, row.collegeId);
  }
  const myCollegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
  // 操作者自己一定在表里（他的学院名要用于「同学院」判定，见 recordDirOf 的说明）
  if (myCollegeId) collegeIdByUser.set(ctx.actorId, myCollegeId);
  return {
    actorCollege: nameById.get(myCollegeId) || '',
    collegeIdOf: userId => collegeIdByUser.get(userId) || '',
    collegeNameById: id => nameById.get(id) || '',
    collegeOf: userId => nameById.get(collegeIdByUser.get(userId)) || '',
  };
}

/**
 * 只解析**操作者自己**的学院（2026-10-26 第六轮 D）。
 *
 * 【给谁用】写动作的身份闸（`freshActorGate` → `legacyActorOf`）从目录里唯一取的
 * 就是 `dir.actorCollege` 这一个字符串，而 `buildDirectory` 为此要读全校在册名单
 * + 这批人的账号（2000 人的学校 40 次 RPC）。
 *
 * 【为什么不是「随便查得到就查」】这里显式只认操作者本人：别人的学院一律给空串。
 * 需要别人学院的地方（代签、指派、判球）**必须**改用 `userDirectory` / `recordDirOf`。
 * 给空串而不是抛错，是因为空的学院名在旧栈判定里是「不同学院」，属于**收紧**；
 * 唯一会因此放行的是「目标学院为空 = 未指定目标」那类分支，所以那些路径不能走这里。
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} 与 buildDirectory 子集同形
 */
async function actorDirectory(ctx) {
  const myCollegeId = managementCollegeId(ctx);
  const name = await actorCollegeNameOf(ctx);
  return {
    actorCollege: name,
    collegeIdOf: userId => (userId === ctx.actorId ? myCollegeId : ''),
    collegeNameById: id => (myCollegeId && id === myCollegeId ? name : ''),
    collegeOf: userId => (userId === ctx.actorId ? name : ''),
  };
}

/**
 * 只取「操作者自己的学院名」——一次点读，而不是全院目录（2026-10-23 H-4）。
 *
 * 【为什么够用】`legacyActorOf` 组装旧栈账号时，从目录里唯一取的就是
 * `dir.actorCollege`。为这一个字符串去读全校在册名单 + 这批人的账号（2000 人
 * 是 40 次 RPC），在赛事详情这种每次打开都走的读接口上尤其不划算。
 *
 * 不能直接用 `ctx.actor.college`：账号上的学院是历史遗留字段，权威值是
 * `school_members.collegeId`；学院负责人则取 memberships.collegeId 的管理授权。
 * 按对应的稳定编号点读学院全名。
 *
 * @param {Object} ctx
 * @returns {Promise<string>} 学院全名；没有学院归属时为空串
 */
async function actorCollegeNameOf(ctx) {
  const collegeId = managementCollegeId(ctx);
  if (!collegeId) return '';
  const doc = await ctx.repo.colleges.getById(collegeKey(ctx.schoolId, collegeId));
  return (doc && doc.name) || '';
}

module.exports = {
  legacyRoleOf, buildDirectory, buildCollegeDirectory, recordOptions, legacyActorOf,
  actorCollegeNameOf, recordDirOf, recordDirOfUsers, userDirectory, actorDirectory,
  EMPTY_RECORD_DIR,
};
