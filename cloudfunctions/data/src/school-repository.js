/** 两个适配器共享的学校仓储扩展。原单校接口保留，S2 逐一接入新接口。 */
const { schoolScope, SCHOOL_MEMBER_STATUS } = require('../lib/utils/school.js');
const { MEET_COLLECTIONS, meetScope } = require('../lib/utils/meet-scope.js');
const { attachTeamReads, unique } = require('../lib/services/scoped-team-reads.js');
const { attachOverviewReads } = require('../lib/services/school-overview-reads.js');
const { pageOfCollection } = require('../lib/services/event-list-page.js');

const SCHOOL_COLLECTIONS = ['schools', 'schoolAssociations', 'colleges', 'schoolMembers', 'schoolRoles', 'studentIdClaims',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations', 'pairCounts',
  // 会员评级表与结算序号计数：均为「学校 + 协会」双维度归属，写入即校验。
  'memberRatings', 'ratingCounters',
  // 团队运动（篮球/足球/排球）6 个集合：与个人赛彻底分开，同样按
  // 「学校 + 协会」双维度归属。比赛与统计**绝不写 matches / memberRatings**。
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
  // 运动会 12 个集合：学校级业务，不属于任何协会。基础读写挂在这里，
  // 范围校验走 forMeet（{schoolId, meetId}），不能混进下面的 SCOPED_COLLECTIONS
  // ——那一组会注入 association 字段，把运动会错挂到协会上。
  ...MEET_COLLECTIONS,
  // 学院部长授权：**学校级**常设角色，不随届次、也不挂协会，故按 SCHOOL_ONLY 处理。
  'sportsMeetCollegeLeads'];
// 学校级集合：只按 schoolId 判归属，写入不注入 association。
// 公告 2026-10-18 起并入这一档——只有管理员能发、发的是全校信息，
// 不能因为发布时当前协会不同而只在那家协会可见。
const SCHOOL_ONLY = ['colleges', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', 'announcements'];
// 带 eventId 的从属集合：按赛事取子集走 listByEvent（条件查询），不再整表读完
// 再内存过滤。与内存仓储 school-memory-repo.js 的 EVENT_SCOPED 一一对应。
//
// 团队运动的报名 / 比赛 / 统计三个集合同样有 eventId、同样是「按赛事取子集」
// 的读法（team-event-service 里 6 处 `list().filter(eventId)`），2026-10-21
// 审查 P1-5 把它们并进来：此前一次详情页要把历年全部比赛与统计读回来才滤出
// 本届那几十条。
const EVENT_SCOPED = ['matches', 'eventSignups', 'collegeEntries', 'ties', 'lineups',
  'teamEventEntries', 'teamMatches', 'teamMatchStats'];
const SCOPED_COLLECTIONS = [
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  ...SCHOOL_ONLY, 'schoolAssociations', 'memberships',
  'matches', 'events', 'eventSignups', 'collegeEvents', 'collegeEntries',
  'ties', 'lineups', 'liveScores', 'seasons',
  // 协会空间小组 / 通知 / 训练均按「学校 + 协会」双维度范围，写入即校验归属。
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  // 交手名额计数：每对一条，同属「学校 + 协会 + 赛季」，写入即校验归属。
  'pairCounts',
  // 会员评级表：每「学校 + 协会 + 用户 + 池」一条，写入即校验归属。
  'memberRatings',
  // 结算序号计数：每「学校 + 协会」一条，写入即校验归属。
  'ratingCounters',
  // 团队运动：球队 / 队员 / 赛事 / 报名 / 比赛 / 统计，一律按「学校 + 协会」。
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
];

/**
 * 通用「受范围仓储」。
 *
 * 协会维度与运动会维度只有 `expected` 字段不同（前者 schoolId+association，
 * 后者 schoolId+meetId），读写校验、事务内点读、事务包装完全一致。
 * 抽成一处而不是复制两份：这段代码里「写入前在同一事务内复查归属」是关键，
 * 两份实现迟早分叉，而分叉的后果是能跨届/跨院写入。
 *
 * @param {Object} repo 基础仓储
 * @param {Object} io { read, set, query }
 * @param {boolean} inTx 是否已在事务内
 * @param {Object} options
 * @param {ReadonlyArray<string>} options.keys 受范围集合
 * @param {Object} options.scope 写进文档与结果的范围对象
 * @param {Function} options.expectedOf (key) => 该集合应有的归属字段
 * @param {Function} options.surfaceOf (tx, scope) => 事务内的对应受范围仓储
 * @param {string} options.mismatchMessage 越界写入的报错文案
 */
function buildScoped(repo, io, inTx, options) {
  const { keys, scope, expectedOf, surfaceOf, mismatchMessage } = options;
  const result = { scope };

  /**
   * 按 `_id` 升序读最多 `size` 条，可用 `afterId` 续读。
   *
   * 【为什么要自己循环】（2026-10-26 只读审查 P2-9）
   * 云端 `io.top` 单次最多回 100 条（适配器的 PAGE_SIZE 截断），而分页接口靠
   * 「多取 1 条」判 `hasMore`：调用方要 100/200 条时，101/201 被静默截成 100，
   * 于是 `hasMore` 恒为 false，页面以为「没有下一页」——待审申请提示、跨校赛
   * 裁判候选名单这类列表会被悄悄截断，且本地内存仓储不截断，测试看不出来。
   * 这里用游标自己续读，页大小上限与 hasMore 判定都不再依赖单次 RPC 的容量。
   */
  const READ_PAGE_SIZE = 100;
  const readUpTo = async (key, where, size, afterId) => {
    const out = [];
    let cursor = typeof afterId === 'string' ? afterId : '';
    while (out.length < size) {
      const want = Math.min(size - out.length, READ_PAGE_SIZE);
      const cond = { ...where };
      if (cursor) cond._id = io.cmd.gt(cursor);
      const rows = await io.top(key, cond, [{ field: '_id', direction: 'asc' }], want);
      if (!rows || rows.length === 0) break;
      out.push(...rows);
      cursor = rows[rows.length - 1]._id;
      if (rows.length < want) break;
    }
    return out;
  };

  for (const key of keys) {
    const expected = expectedOf(key);
    const owns = (doc) => doc && Object.keys(expected).every((field) => doc[field] === expected[field]);
    const checked = (doc) => {
      for (const field of Object.keys(expected)) {
        if (doc[field] !== undefined && doc[field] !== expected[field]) throw new Error(mismatchMessage);
      }
      return { ...doc, ...expected };
    };
    // 按主键写前检查已有归属，检查与写入保持在同一事务。
    //
    // 【`current === null` 为什么可以当作「确实不存在」】（2026-10-27 第八轮审查 P0-1）
    // 这里一旦把「读失败」误当成「没有记录」，下面的 owns() 校验就被跳过，
    // 随后 checked() 会把 schoolId / association 改写成调用方范围整条写入——
    // 等于跨校覆盖。这个不变量由适配器保证：cloud-repo 的 readDoc 只在
    // **确认**不存在时返回 null，其余错误一律抛出（见那里的 isMissingDoc /
    // docAbsent）。因此**不要**在这里再加「读不到就当空」的兜底。
    const write = async (id, doc, mode) => {
      if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
      if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
      const patch = checked(doc);
      const run = async (tx) => {
        const current = await tx[key].getById(id);
        if (current && mode === 'insert') throw new Error('记录已存在');
        if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
        await tx[key].set(id, mode === 'update' ? { ...current, ...patch } : patch);
        return { ...(mode === 'update' ? current : {}), ...patch, _id: id };
      };
      if (!inTx) return repo.transaction((tx) => run(surfaceOf(tx, scope)));
      const current = await io.read(key, id);
      if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
      if (current && mode === 'insert') throw new Error('记录已存在');
      if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
      const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
      await io.set(key, id, next);
      return next;
    };
    result[key] = {
      list: () => repo[key].listByScope(scope),
      getById: async (id) => {
        const doc = await io.read(key, id);
        return owns(doc) ? doc : null;
      },
      set: (id, doc) => write(id, doc, 'set'),
      insert: (doc) => write(doc._id, doc, 'insert'),
      update: (id, patch) => write(id, patch, 'update'),
    };
    // 按赛事取子集：条件**一起下推到查询**（范围字段 + eventId），而不是读全表
    // 再在内存里过滤。内存仓储有同名方法（school-memory-repo.js 的 listByEvent），
    // 两端方法面由 tests/for-scope-contract.test.js 逐字守住。
    if (EVENT_SCOPED.includes(key)) {
      const scopeFields = SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association };
      result[key].listByEvent = (eventId) => io.query(key, { ...scopeFields, eventId });
      // 按一批 _id 取（一次 `_.in`，1 个 RTT）。赛事列表要标「我报名了没」：
      // 原来一页 20 条就是 20 次点读，按页批读后是 1 次（2026-10-22 H-3）。
      // **范围字段一起拼进查询**：`_id` 可能是客户端给的，归属校验不能只靠调用方。
      result[key].listByIds = (ids) => io.byIds(key, ids, scopeFields);
    }
    // ── 运动会录分页：只取本场次的报名与成绩（2026-10-23 H-9）──
    //
    // 【要解决什么】`getMeetSessionScores` 原来读的是**一届全部**的
    // `sportsMeetEntries` 与 `sportsMeetScores`。一届运动会的报名是「项目 × 学院
    // × 名额」，成绩还要再乘裁判数，上千条很常见；而一个场次只需要十几条。
    // 管理员/裁判录分页因此每次要翻十几页 RPC。
    //
    // 【为什么只下推这两处】`sportsMeetSessions` 与 `sportsMeetJudgeAssignments`
    // 还要参与「我是不是这个项目的裁判」的权限判定，量级是几十到几百条，
    // 本轮不动——先把最贵的两个集合收窄。
    // 命名用 listByProject 而不是 listByEvent：运动会的 `sportsMeetEvents` 是
    // 「比赛项目」，而协会侧的 listByEvent 指的是「一场赛事」。同名不同义会让仓储
    // 契约扫描把它们混为一谈（协会侧的 listByEvent 顶层也有，运动会没有顶层的
    // 等价值——它必须带 meetId 范围）。
    // 报名 / 场次 / 意向 / 成绩 / 发布快照 / 指派 / 结果行都按「本项目」取。
    //
    // 【为什么从两项扩到七项】（2026-10-26 第五轮审查 B）
    // 第三轮只把录分页最贵的两个集合（报名、成绩）收了窄，其余读取仍是「读一届
    // 全部再按 eventKey 过滤」。第五轮排查发现这样的调用点在运动会域共有 45 处，
    // 分布在晋级、签表、成绩发布、赛程、报名池这些页面上：一届 20 项目 × 8 学院
    // × 6 名额 = 960 条报名、成绩还要再乘裁判数，一次「预览汇总」就是几十页 RPC，
    // 只为其中一个项目的几十条。
    // 这七个集合的文档**全部带 `eventKey`**（写入时落的，见 meet-score-service 的
    // 发布快照与结果行、meet-schedule-service 的指派），所以共用同一个原语：
    // 命名用 listByProject 而不是 listByEvent——运动会的 `sportsMeetEvents` 是
    // 「比赛项目」，协会侧的 listByEvent 指的是「一场赛事」，同名不同义会让仓储
    // 契约扫描把它们混为一谈。
    if (key === 'sportsMeetEntries' || key === 'sportsMeetSessions' || key === 'sportsMeetInterests'
      || key === 'sportsMeetScores' || key === 'sportsMeetPublications'
      || key === 'sportsMeetJudgeAssignments' || key === 'sportsMeetResultRows') {
      result[key].listByProject = (projectKey) => {
        if (typeof projectKey !== 'string' || !projectKey) return Promise.resolve([]);
        return io.query(key, { ...expected, eventKey: projectKey });
      };
    }
    if (key === 'sportsMeetScores' || key === 'sportsMeetJudgeAssignments') {
      // sessionKey 在写入时落库（见 meet-score-service / meet-schedule-service 的 doc），
      // 可以直接按它查：本场次的成绩、本场次的裁判指派。
      result[key].listBySession = (sessionKey) => {
        if (typeof sessionKey !== 'string' || !sessionKey) return Promise.resolve([]);
        return io.query(key, { ...expected, sessionKey });
      };
    }
    if (key === 'sportsMeetJudgeAssignments') {
      // 「我在本届被指派到哪些场次」：权限判定只需要这个人的指派，
      // 不需要把一届所有指派（场次 × 裁判数）读回来再筛。
      result[key].listByJudge = (judgeId) => {
        if (typeof judgeId !== 'string' || !judgeId) return Promise.resolve([]);
        return io.query(key, { ...expected, judgeId });
      };
    }
    // 名录页要给每一行算权限标签：20 行 × (校级角色 + 协会身份) = 40 次点读。
    // 两者都是「按主键点取」，主键由 userId 派生，正好可以整页批读（H-5）。
    // schoolMembers 后来也用上同一条路（2026-10-23 第三轮 X-3）：比赛列表只需
    // 「这一页参赛者属于哪个学院」，不必为此读全校名册。
    if (key === 'schoolMembers' || key === 'schoolRoles' || key === 'memberships'
      || key === 'memberRatings') {
      // memberRatings（2026-10-26 只读审查 P2-6）：`getSchoolMemberStats` 指定
      // userIds 时按「学校 + 协会 + 人 + 池」的确定性主键批读，不再整表读全范围
      // 评级。它是协会级集合，范围字段要带 association。
      const scopeFields = key === 'memberships' || key === 'memberRatings'
        ? { schoolId: scope.schoolId, association: scope.association }
        : { schoolId: scope.schoolId };
      result[key].listByIds = (ids) => io.byIds(key, ids, scopeFields);
    }
    // ── 名册分页与按状态/学号取（2026-10-26 第四轮审查 P-2 / P-3 / P-7）──
    //
    // 【要解决什么】`getSchoolMembers` 原来 `list()` 整校名册后过滤在册，一次性
    // 把所有行下发给客户端；`getSchoolApplications` 为了几条待审申请同样整校读；
    // 入会审批为了判「学号是否已被占用」再整校读一遍。三处都是 O(会员数)，
    // 而真正需要的分别是「一页 50 条」「几条 pending」「这个学号那 1 条」。
    //
    // 【为什么用 _id 当游标】名册主键 `sm:<schoolId>:<userId>`，同一校内按 _id
    // 升序等价于按 userId 升序（与原来 members.sort(userId) 同序），所以游标不
    // 改变展示顺序；换成 skip 分页则会随页码线性变慢并在写入时漂移（同 cursorCond）。
    //
    // 【为什么多取一条】`hasMore` 用「多取 1 条」判断，不为一个问题再发一次 count；
    // 总数另给 `countByStatus`（聚合计数，不读文档），只在首屏要一次。
    if (key === 'schoolMembers') {
      result[key].listByStatus = async (status, options = {}) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        if (typeof status !== 'string' || !status) return { rows: [], hasMore: false };
        const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
        const afterId = typeof options.afterId === 'string' ? options.afterId : '';
        // 读 limit + 1 条判 hasMore；超过单次读取上限时由 readUpTo 续读
        // （见 readUpTo 的说明：截断会让 hasMore 恒为 false）。
        const where = { schoolId: scope.schoolId, status };
        if (typeof options.collegeId === 'string' && options.collegeId) where.collegeId = options.collegeId;
        const rows = await readUpTo('schoolMembers', where, limit + 1, afterId);
        return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
      };
      result[key].countByStatus = (status) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        return io.count('schoolMembers', { schoolId: scope.schoolId, status: String(status || '') });
      };
      // 学号判重：审批时只需「这个学号在本校有没有有效身份」。
      // 学号不在主键里，只能按字段查 —— 索引见 docs/数据库索引清单.md
      // （`schoolMembers`: schoolId + studentId）。
      result[key].listByStudentId = (studentId) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        if (typeof studentId !== 'string' || !studentId) return Promise.resolve([]);
        return io.query('schoolMembers', { schoolId: scope.schoolId, studentId });
      };
    }
  }
  // 本赛季的比赛：把 `matchTime >= sinceIso` 下推到查询。
  //
  // 【为什么需要】（2026-10-22 第二轮审查 P-2）
  // 「本赛季与每个人的交手次数」原来是把**全部历史比赛**读回来再按 resetTime
  // 在应用层过滤。matches 是只增不减的最大集合，一个练了三年的协会打开一次
  // 录分页要翻上百页 RPC，而真正用得上的只有本赛季那几十条。
  //
  // 【为什么不过滤 status】
  // 名额口径（rating-cap.countedMatches）只排除**作废**的场次，待确认的照样占
  // 名额。若这里按 status 收窄，等于顺手改了业务口径——过滤留在 countedMatches。
  //
  // 【为什么只挂在 forScope 上】
  // 没有范围字段的同类查询会跨校泄露。matchTime 落库是 ISO 串，同格式字符串的
  // 字典序即时间序，字符串范围比较成立。
  if (result.matches) {
    result.matches.listPage = (options) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      return io.matchPage(scope, options);
    };
    result.matches.listSince = (sinceIso) => {
      const where = { schoolId: scope.schoolId, association: scope.association };
      if (typeof sinceIso === 'string' && sinceIso) where.matchTime = io.cmd.gte(sinceIso);
      return io.query('matches', where);
    };
    // 「我的比赛（本赛季）」：只取含本人的场次。
    //
    // 【要解决什么】（2026-10-23 第三轮 X-7）录分页要算「我本赛季每对对手打了几场」，
    // 原实现把整个赛季的台账读回来再筛——一个赛季 3000 场 = 30 页 RPC，越往后越慢。
    // 而下游 `seasonPairCounts` 内部先过 `countedMatches`、再只保留含本人的场次，
    // 所以把输入收窄到「含我的」**不改变输出**：这是缩范围，不是改算法。
    //
    // 【为什么分两支】`teamA` / `teamB` 是两个**数组**字段，一条等值查询表达不出
    // 「我在任一侧」。两支各是一个纯等值前缀（等值对数组字段即「包含」），正好各自
    // 命中索引清单 §2.3 的 `by_scope_team_a_match_time` / `..._team_b_match_time`。
    // 同一手法在 `teamMatches.listByTeams`（scoped-team-reads.js）已有先例。
    //
    // 【为什么必须按 _id 去重】同一人同时出现在两队的脏数据会被合并成两条，名额
    // 数字直接偏大——这里的去重是正确性要求，不是优化。
    result.matches.listMineSince = (userId, sinceIso) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      const where = { schoolId: scope.schoolId, association: scope.association };
      if (typeof sinceIso === 'string' && sinceIso) where.matchTime = io.cmd.gte(sinceIso);
      return Promise.all([
        io.query('matches', { ...where, teamA: userId }),
        io.query('matches', { ...where, teamB: userId }),
      ]).then((rows) => unique(rows.flat()));
    };
  }

  // 按人反查：这两个集合都是「只增不减 + 一个人只有几十条」，而调用方只需要
  // 这一个人的那几条。
  //
  // 【训练报名】（2026-10-22 H-2）个人主页算训练积分：3000 条 / 3000 人是
  // 30 页 RPC，原来靠「读全范围再按 userId 筛」。
  // 【小组成员】（同轮 H-3）赛事详情要算「我在不在指定小组才能报名」：
  // 原来把整个协会的小组成员行（6 协会 × 若干组 × 数十人）读回来，只为找出
  // 自己加入的那几行。
  //
  // userId 缺失时**返回空数组**，不退化成整表读——调用方漏传参数不该变成
  // 一次全表扫描。
  for (const key of ['trainingRegistrations', 'associationGroupMembers', 'memberRatings']) {
    if (!result[key]) continue;
    result[key].listByUser = (userId) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      return io.query(key, { schoolId: scope.schoolId, association: scope.association, userId });
    };
  }

  // 运动会的「按人反查」（2026-10-23 第三轮 X-9）。
  //
  // 【要解决什么】「我的参赛页」只要「我报了哪些项目、选上了没」，原实现把一届的
  // 意向与名单全读回来再按 userId 筛。报名旺季一届意向数千条 = 30~50 页 RPC。
  //
  // 【为什么另起一条循环，而不是并进上面那条】运动会集合的归属是
  // `{schoolId, meetId}`，**没有 association**；并进去会拼出一个带 undefined 的
  // 条件，云端查不到任何文档（本地 filter 恰好也会空，两端一起静默变空）。
  // 条件由 `expectedOf(key)` 给出，范围天然内置。
  //
  // 【名单为什么按 `userIds` 匹配】`sportsMeetEntries` 一行是一个「项目 × 学院」
  // 的名额占位，参赛者是 `userIds` 数组；等值对数组字段即「包含」，与内存端
  // `includes` 同口径。
  for (const key of ['sportsMeetInterests', 'sportsMeetEntries']) {
    if (!result[key]) continue;
    const actorField = key === 'sportsMeetEntries' ? 'userIds' : 'userId';
    result[key].listByUser = (userId) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      return io.query(key, { ...expectedOf(key), [actorField]: userId });
    };
  }

  // 按训练取报名：一场训练的报名只有几十条，而集合是「只增不减」的。
  // 原来详情页把整个协会的报名台账读回来再按 trainingId 过滤（2026-10-23 第三轮 X-8）。
  if (result.trainingRegistrations) {
    result.trainingRegistrations.listByTraining = (trainingId) => {
      if (inTx) throw new Error('事务内不允许条件读取（trainingRegistrations），请改用 getById');
      if (typeof trainingId !== 'string' || !trainingId) return Promise.resolve([]);
      return io.query('trainingRegistrations', {
        schoolId: scope.schoolId, association: scope.association, trainingId,
      });
    };
  }

  // ── 评级表的下推读（2026-10-23 方案 A 第 2 步）──
  //
  // 【要解决什么】榜单要「本池、本项目（性别）、在册、按 elo 前 10」；个人主页要
  // 「我在同项目排第几」。这两件事原本都得把 8000 条评级（2000 人 × 4 池）读回
  // 内存里算——因为排序键 `elo` 在评级表，而过滤键 `gender` / 在册状态在别的
  // 集合里。方案 A 把这两个字段冗余进来之后，条件与排序可以一起下推。
  //
  // 【为什么门槛是 matchCount > 0】榜单只展示「上过场」的人（与 buildRows 同口径）。
  // 不下推的话，取回的前 10 里可能一半是「建了档但一场没打」的会员，再被内存
  // 过滤掉——那等于白读，也只能靠 limit 放大来补偿。
  //
  // 【排序只负责「取哪一批」】名次仍由调用方用同一个比较器重算（elo → 胜率 →
  // 胜场 → 时间 → 编号）。数据库只按 elo 与胜场取前 N，避免把 `winRate` 这种
  // 派生字段写进索引。
  if (result.memberRatings) {
    const rankedWhere = ({
      pool, gender = null, memberStatus = SCHOOL_MEMBER_STATUS.ACTIVE, minElo = null,
      missingProfile = false,
    }) => {
      const where = {
        schoolId: scope.schoolId,
        association: scope.association,
        matchCount: io.cmd.gt(0),
      };
      // pool 传 null 表示不分池（回填监控要数全协会的残留文档）。
      if (pool) where.pool = pool;
      // 回填监控：数「没有 memberStatus 字段」的文档。这类文档是方案 A 上线前
      // 建的档，按状态筛会被整体漏掉——榜单会静默少人，而不是报错。
      if (missingProfile) {
        where.memberStatus = io.cmd.exists(false);
        return where;
      }
      // memberStatus 传空串/null 表示不按状态筛（回填监控的对照口径）。
      if (memberStatus) where.memberStatus = memberStatus;
      if (gender) where.gender = gender;
      if (minElo !== null && minElo !== undefined) where.elo = io.cmd.gt(minElo);
      return where;
    };
    result.memberRatings.listTop = (options = {}) => {
      if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
      const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100));
      return io.top('memberRatings', rankedWhere(options), [
        { field: 'elo', direction: 'desc' },
        { field: 'wins', direction: 'desc' },
        { field: '_id', direction: 'asc' },
      ], limit);
    };
    // 名次用两次计数算出来：比我高的人 + 1。不读文档，只有数字。
    result.memberRatings.countRanked = (options = {}) => {
      if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
      return io.count('memberRatings', rankedWhere(options));
    };
  }
  if (!inTx) result.transaction = (fn) => repo.transaction((tx) => fn(surfaceOf(tx, scope)));
  attachTeamReads(result, { inTx, query: io.query, byIds: io.byIds, command: io.cmd });
  attachOverviewReads(result, { inTx, top: io.top, count: io.count, command: io.cmd });
  if (result.schoolMembers) result.schoolMembers.listDirectoryPage = options => {
    if (inTx) throw new Error('事务内不允许查询会员目录');
    return io.memberPage(scope, options);
  };
  // 与 listDirectoryPage 同一套过滤的聚合计数（2026-10-29 第十一轮审计 P2-9）。
  // 首页概况只要「本校会员数」；先前的替代做法是拉一整份名录再数长度。
  if (result.schoolMembers) result.schoolMembers.countDirectory = options => {
    if (inTx) throw new Error('事务内不允许查询会员目录');
    if (!io.memberCount) throw new Error('会员目录计数适配器未接入');
    return io.memberCount(scope, options);
  };
  // 【赛事 / 学院赛列表的受控分页】（2026-10-29 第十二轮审计）
  // 范围、状态、年份区间、排序与 offset/limit 一起下推，只取当前页；total 与
  // totalAll 各一次聚合计数。原先这两个列表是「整表读 + 内存筛选排序切片」，
  // 每翻一页都要把本协会全部赛事读一遍。
  for (const key of ['events', 'collegeEvents']) {
    if (!result[key]) continue;
    result[key].listPage = options => {
      if (inTx) throw new Error(`事务内不允许分页读取（${key}），请改用 getById`);
      return pageOfCollection(io, scope, key, options);
    };
  }
  return result;}

function attachSchoolRepository(repo, io, inTx) {
  repo.personalSports = { readPage: (source, auth, query) => {
    if (inTx) throw new Error('事务内不允许个人体育查询');
    if (!io.personalPage) throw new Error('个人体育查询适配器未接入');
    return io.personalPage(source, auth, query);
  } };
  // 【顶层 list() 是「跨范围读」，业务代码不要用】（2026-10-27 第八轮审查 P1-3）
  // 这里的条件对象是空的：`io.query(key, {})` 会把**全平台**该集合读回来。
  // 它存在只为满足「两套仓储方法面一致」的契约（模拟仓储的顶层 list 也是全量），
  // 业务读取一律走 `forScope(ctx).<集合>.list()`（带 schoolId + association）。
  //
  // 为什么不在运行时抛错：契约测试（cloud-repo-contract）把顶层 list 当作合法
  // 形态钉着，模拟端也这么实现；运行时禁掉会造成两端分叉。防线改为
  // `tests/top-level-list-guard.test.js` 的静态扫描——禁止业务代码写
  // `ctx.repo.<集合>.list()`，只有平台级小集合（学校 / 协会 / 学院目录）例外。
  for (const key of SCHOOL_COLLECTIONS) {
    repo[key] = {
      getById: (id) => io.read(key, id),
      set: (id, doc) => io.set(key, id, doc),
      list: () => io.query(key, {}),
    };
  }
  for (const key of SCOPED_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = schoolScope(input);
      return io.query(key, SCHOOL_ONLY.includes(key) ? { schoolId: scope.schoolId } : scope);
    };
  }
  // 学校级集合（学院目录 / 身份 / 校级角色 / 学院部长授权）的按校列举。
  // 为什么另开一个方法：listByScope 走 schoolScope()，它要求 schoolId + association，
  // 而运动会的 context 里根本没有 association——拿 forScope 去列学院部长会直接抛错。
  for (const key of SCHOOL_ONLY) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  // 运动会集合的按校列举（列「本校有哪些届运动会」用）。
  for (const key of MEET_COLLECTIONS) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  // 运动会集合的 listByScope 只按「学校 + 运动会」，与协会无关。
  for (const key of MEET_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = meetScope(input);
      return io.query(key, { schoolId: scope.schoolId, meetId: scope.meetId });
    };
  }
  repo.exchangeSignups.listByEvent = eventId => io.query('exchangeSignups', { eventId });
  repo.exchangeMatches.listByEvent = eventId => io.query('exchangeMatches', { eventId });

  repo.forScope = (input) => {
    const scope = schoolScope(input);
    return buildScoped(repo, io, inTx, {
      keys: SCOPED_COLLECTIONS,
      scope,
      expectedOf: (key) => (SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association }),
      surfaceOf: (tx, next) => tx.forScope(next),
      mismatchMessage: '不能写入其他学校或协会的数据',
    });
  };

  /**
   * 运动会范围的受范围仓储。
   *
   * 与 forScope 的关键差异：归属字段是 `{schoolId, meetId}`，**没有 association**。
   * 因此不能复用 forScope，也不能把运动会集合塞进 SCOPED_COLLECTIONS——
   * 那会在每次写入时给文档强塞一个 association，等于把运动会挂到匹克球协会上。
   */
  repo.forMeet = (input) => {
    const scope = meetScope(input);
    return buildScoped(repo, io, inTx, {
      keys: MEET_COLLECTIONS,
      scope,
      expectedOf: () => ({ schoolId: scope.schoolId, meetId: scope.meetId }),
      surfaceOf: (tx, next) => tx.forMeet(next),
      mismatchMessage: '不能写入其他学校或其他运动会的数据',
    });
  };

  return repo;
}

module.exports = {
  SCHOOL_COLLECTIONS,
  SCOPED_COLLECTIONS,
  MEET_COLLECTIONS,
  attachSchoolRepository,
};
