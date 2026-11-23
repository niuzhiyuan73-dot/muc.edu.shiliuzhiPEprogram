/**
 * 运动会范围与确定性主键（B2）
 * ============================================================
 * 运动会是**学校级**业务，不属于任何体育协会。现有的 `schoolScope()`
 * 要求 schoolId + association，直接拿来做运动会会把「停用某协会」牵连到
 * 运动会（交接文档 §7.2 明确要求独立学校级 context）。所以这里单独一套：
 * 范围是 `{ schoolId, meetId }`，没有 association。
 *
 * 【为什么所有主键都要确定性】
 * 云开发事务内**不能 where 查询**，只能按 id 点读。报名时要在同一事务里
 * 判断「这个学院在这个项目组的额度还剩几个」「这个人是否已经在同项目组
 * 报过」「这个裁判是否已提交过这份分」，这些计数与声明如果每次都要查集合，
 * 运动会就永远无法保证并发不超卖。于是把它们设计成**由已知字段拼出来的
 * 主键**：知道 meetId / eventKey / collegeId / userId / judgeId 就能直接点读，
 * 不需要任何查询。
 *
 * 【为什么拼键要做合法性校验】
 * 直接用 `${a}:${b}` 拼，遇到含冒号的输入就会和别的键撞上（`a:b` + `c`
 * 与 `a` + `b:c` 同形），而键碰撞在计数类文档上表现为「扣了别人的名额」。
 * 所以每段都拒绝空值与冒号，宁可当场抛错，也不静默拼出一个可能重复的键。
 * ============================================================
 */

/** 运动会相关集合的逻辑名（与 utils/constants.js 的 COLLECTION 键一致）。 */
const MEET_COLLECTIONS = Object.freeze([
  'sportsMeets',
  'sportsMeetEvents',
  'sportsMeetColleges',
  'sportsMeetInterests',
  'sportsMeetEntries',
  'sportsMeetSessions',
  'sportsMeetJudgeAssignments',
  'sportsMeetScores',
  'sportsMeetPublications',
  'sportsMeetResultRows',
  'sportsMeetQuotaUsage',
  'sportsMeetParticipantClaims',
  // B8：学院总榜快照与个人荣誉
  'sportsMeetStandings',
  'sportsMeetHonors',
]);

/** 运动会状态机（发布/归档一律显式流转，不靠字段拼凑）。 */
const MEET_STATUS = Object.freeze({
  DRAFT: 'draft',
  REGISTRATION: 'registration',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  FINISHED: 'finished',
  ARCHIVED: 'archived',
  // 软删除：仓储没有物理删除接口，且报名/成绩/荣誉都按 meetId 指过来，
  // 删掉文档会留下悬空引用。读取路径一律把 deleted 当不存在。
  DELETED: 'deleted',
});

/** 学生意向状态（与正式 entry 分离，D10）。 */
const MEET_INTEREST_STATUS = Object.freeze({
  PENDING: 'pending',
  SELECTED: 'selected',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
});

/** 正式报名状态（D21 审核、B5 驳回回退）。 */
const MEET_ENTRY_STATUS = Object.freeze({
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
});

/**
 * 单条正式名单的人数上限（配置上限与提交校验共用同一个数字）。
 *
 * 【为什么会存在】（2026-10-22 第二轮审查 B-1）
 * 云数据库事务预算约 100 个操作，提交名单要在**一个事务**里写完一条名单的
 * 全部声明与计数。原实现每人约 9 个操作，于是 10 人以上的团体项目必然抛
 * 「事务读写总操作预算不足」；而配置侧允许配到 200 人、内置模板里
 * 「入场式展示」默认就是 20 人。两处数字各自为政，谁也没发现它们不相容。
 *
 * 现在：提交侧把按人的身份读取搬到事务外（每人只剩 2 个操作），配置侧与
 * 提交侧**共用这一个常量**，20 人对得上全部内置模板，也不会再出现
 * 「配得出、报不进」。
 *
 * 【要提高这个数字，必须同时改提交路径】
 * 超过 20 人就得把名单拆成多次事务写入（分批 + 失败补偿），不能只调大这里。
 */
const MEET_ENTRY_MAX_MEMBERS = 20;

/** 项目组别状态：删除用软删除，因为报名/成绩都可能已经指过来。 */
const MEET_EVENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  DELETED: 'deleted',
});

/**
 * 项目组别是否还在。
 *
 * 为什么不用物理删除：报名、成绩、场次都按 eventKey 指过来，删文档会留下
 * 悬空引用；而且仓储接口本身没有 remove。所以置 status='deleted'，
 * 读取处一律用 listAliveEvents 过滤——漏掉一处，被删的项目就会在报名页
 * 里「复活」，所以这里只留一个入口，不要在调用处自己写 filter。
 */
function isEventAlive(doc) {
  return Boolean(doc) && doc.status !== MEET_EVENT_STATUS.DELETED;
}

/** 读一个项目集合，并滤掉已删除的条目。 */
async function listAliveEvents(collection) {
  return (await collection.list()).filter(isEventAlive);
}

/** 单段合法性：非空、不含分隔符。 */
function part(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`运动会键缺少${label}`);
  if (text.includes(':')) throw new Error(`${label} 不能包含冒号`);
  return text;
}

/**
 * 用户 / 裁判编号段：真实微信注册账号由 `schoolAccountKey(openId)` 生成，
 * 形如 `acc:<40位hex>`（含冒号且长 44）。经 `encodeURIComponent` 编码后不含冒号、
 * 不与相邻段碰撞，且对 `u1` / `demo_*` 等无冒号账号保持原串不变。
 */
function userPart(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`运动会键缺少${label}`);
  return encodeURIComponent(text);
}

/**
 * 内嵌键的段：允许冒号。
 *
 * 事件 / 参赛记录 / 发布编号本身就是「前一级的键」，它们内部以冒号分段。
 * 这类段不接受外部输入（都由本模块生成并落库后回读），所以放行冒号不会引入
 * 「a:b」+「c」与「a」+「b:c」同形的风险；而 meetId / collegeId / userId / slot
 * 这些来自请求或学籍的段仍然走严格校验。
 */
function rawPart(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`运动会键缺少${label}`);
  return text;
}

/**
 * 归一运动会范围。
 *
 * @param {{schoolId?:string, meetId?:string}} input
 * @returns {{schoolId:string, meetId:string}}
 */
function meetScope(input = {}) {
  return {
    schoolId: part(input.schoolId, '学校'),
    meetId: part(input.meetId, '运动会'),
  };
}

/**
 * 生成运动会主键。
 *
 * 用 36 进制时间戳而不是随机串：同一毫秒内不会重复创建（同校同一时刻只可能有一次
 * 发起动作），且排错时能从 ID 直接看出创建时间。
 *
 * 分隔符用下划线而**不是冒号**：meetId 会作为一段被拼进 `meetEventKey` 等键，
 * 而拼键用冒号分段。若 meetId 自带冒号，`mt:a` + `b` 与 `mt` + `a:b` 会同形，
 * 计数类文档一旦撞键就会扣到别人的名额上。所以 ID 自身只用 [_0-9a-z]。
 */
function newMeetId(schoolId, at = Date.now()) {
  const school = part(schoolId, '学校');
  const stamp = Math.floor(Number(at) / 1000).toString(36);
  if (!stamp || stamp === 'NaN') throw new Error('运动会创建时间非法');
  return `mt_${school}_${stamp}`;
}

/** 项目组别：一届之内「模板 + 组别」唯一，男子 100 米与女子 100 米是两条。 */
function meetEventKey(meetId, templateId, group) {
  return `mte:${part(meetId, '运动会')}:${part(templateId, '项目')}:${part(group, '组别')}`;
}

/** 本届学院范围快照：保留当届名称，学院改名不影响历史。 */
function meetCollegeKey(meetId, collegeId) {
  return `mtcol:${part(meetId, '运动会')}:${part(collegeId, '学院')}`;
}

/** 学生意向：一人一项目组别一条，可撤回（D19）。 */
function meetInterestKey(meetId, eventKey, userId) {
  return `mti:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${userPart(userId, '用户')}`;
}

/**
 * 正式参赛记录：一院一项目组别下的第 n 个名额一条。
 *
 * slot 用 `s1`／`s2`… 表示第几个单人名额，`t1` 表示第几支队，`g1` 表示第几组
 * 多人协作组。名额序号进主键，是为了让「撤回第 2 个名额、再报一个」能落到
 * 同一条文档上，而不是不断产生新文档。
 */
function meetEntryKey(meetId, eventKey, collegeId, slot) {
  return `mtr:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${part(collegeId, '学院')}:${part(slot, '名额序号')}`;
}

/** 学院额度计数：一院一项目组别一条，事务内点读判断是否还有余量。 */
function meetQuotaKey(meetId, eventKey, collegeId) {
  return `mtq:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${part(collegeId, '学院')}`;
}

/** 兼项与重复报名声明：一人一项目组别一条，事务内点读即可判重。 */
function meetClaimKey(meetId, eventKey, userId) {
  return `mtc:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${userPart(userId, '用户')}`;
}

/**
 * 一人一届一份的兼项计数（同一集合里以 kind='counter' 区分）。
 *
 * 为什么不能靠「扫 claim 文档数出来」：云开发事务内不能查询，而兼项上限（个人 2 项）
 * 是提交时必须判的。把个人项数与团体项数压到一份可点读的计数文档上，
 * 并发提交时两条写入会撞在同一个文档上，天然串行。
 */
function meetParticipantCounterKey(meetId, userId) {
  return `mtcnt:${part(meetId, '运动会')}:${userPart(userId, '用户')}`;
}

/**
 * 个人荣誉：一条参赛记录一条（不是一人一条）。
 *
 * 用 entryKey 而不是 userId 做主键段，两个原因：
 *   · 队伍项目一条记录对应多名队员，按人拆条会让「4×100 接力第 1 名」产生 4 条
 *     几乎相同的荣誉，还得保证它们同时更新；
 *   · 无痕更正时要按 entryKey 覆盖/作废，按人做主键会多一步反查。
 * 代价是「我的荣誉」要按 userIds 过滤一届的荣誉（上限约 800 条），读取端可接受。
 */
function meetHonorKey(meetId, entryKey) {
  return `mth:${part(meetId, '运动会')}:${rawPart(entryKey, '参赛记录')}`;
}

/** 参赛名额序号：单人 s1/s2、多人协作组 g1/g2、队伍 t1（一院一队）。 */
function meetEntrySlot(entryForm, index) {
  const prefix = entryForm === 'team' ? 't' : entryForm === 'group' ? 'g' : 's';
  const num = Number(index);
  if (!Number.isInteger(num) || num < 1) throw new Error('名额序号必须是正整数');
  return `${prefix}${num}`;
}

/** 场次：轮次 + 组次（预赛第 1 组、决赛等）。 */
function meetSessionKey(meetId, eventKey, round, index) {
  return `mts:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${part(round, '轮次')}:${part(index, '组次')}`;
}

/** 裁判指派：场次 + 裁判，一人一场一条（撤换即改状态，不新增文档）。 */
function meetJudgeKey(meetId, sessionKey, judgeId) {
  return `mtj:${part(meetId, '运动会')}:${rawPart(sessionKey, '场次')}:${userPart(judgeId, '裁判')}`;
}

/** 裁判成绩：参赛记录 + 场次 + 裁判，唯一键防重复提交（含 revision）。 */
function meetScoreKey(entryKey, sessionKey, judgeId) {
  return `mtx:${rawPart(entryKey, '参赛记录')}:${rawPart(sessionKey, '场次')}:${userPart(judgeId, '裁判')}`;
}

/**
 * 结果发布：**一场次一条**（预赛第 1 组、决赛各一条），保存当前生效版本。
 *
 * 为什么不是「一项目组别一条」：有预赛的项目，预赛各组的成绩要分别发布
 * （各组比赛时间不同），决赛再单独发布。若共用一条发布文档，第二组发布就会
 * 覆盖第一组的名字与版本号，晋级判定随即读不到第一组的结果。
 *
 * sessionKey 必填。缺了它会退回「一项目一条」的老形状，而那种形状在多轮项目上
 * 是错的——所以这里不做兼容，直接抛错，让调用方当场暴露。
 */
function meetPublicationKey(meetId, eventKey, sessionKey) {
  return `mtp:${part(meetId, '运动会')}:${rawPart(eventKey, '项目组别')}:${rawPart(sessionKey, '场次')}`;
}

/** 结果行：一次发布下的一条参赛记录，一行一个名次与学院积分贡献。 */
function meetResultRowKey(publicationKey, entryKey) {
  return `mtrow:${rawPart(publicationKey, '结果发布')}:${rawPart(entryKey, '参赛记录')}`;
}

/**
 * 学院总榜快照：一届一院一条，B8 起正式启用。
 *
 * 为什么不在读取时实时聚合：一届的结果行可能上千（40 学院 × 90+ 项目组别 ×
 * 每项若干记录），每次打开总榜都全量扫一遍既慢又贵。发布成绩本身是低频写操作，
 * 把累加放进那个事务，总榜读到的就是一份现成的快照。
 *
 * 注意：正式结果行仍是事实来源。快照与结果行不一致时，以结果行为准——
 * 快照只是加速读取的派生数据，不能反过来当成原始记录。
 */
function meetStandingKey(meetId, collegeId) {
  return `mtb:${part(meetId, '运动会')}:${part(collegeId, '学院')}`;
}

/** 学院部长授权状态。撤销保留记录，不做物理删除。 */
const MEET_COLLEGE_LEAD_STATUS = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked',
});

/**
 * 学院部长授权主键：**按学校 + 学院**，不含届次。
 *
 * 学院部长是常设角色（一届结束仍在任，下一届继续报名），所以不进 sportsMeets 范围；
 * 主键做成「一院一条」，由存储层直接保证 D12 的「一院一名」——并发授予时两条写入
 * 会撞在同一个文档上，不需要先查后写。
 */
function meetCollegeLeadKey(schoolId, collegeId) {
  return `mtl:${part(schoolId, '学校')}:${part(collegeId, '学院')}`;
}

/**
 * 请求范围：学校必填，届次可选。
 *
 * 为什么与 `meetScope` 分开：`meetScope` 用于**仓储范围**，没有届就读不了任何
 * 届内集合，必须严格；而「列运动会」「搜项目模板」「发起运动会」这些动作本来就
 * 没有届，请求里传一个空 meetId 反而会让服务端以为要读某一届。
 */
function meetRequestScope(input = {}) {
  const schoolId = part(input.schoolId, '学校');
  const meetId = String(input.meetId == null ? '' : input.meetId).trim();
  if (meetId.includes(':')) throw new Error('运动会 不能包含冒号');
  return meetId ? { schoolId, meetId } : { schoolId };
}

module.exports = {
  MEET_COLLECTIONS,
  MEET_STATUS,
  MEET_INTEREST_STATUS,
  MEET_ENTRY_STATUS,
  MEET_COLLEGE_LEAD_STATUS,
  MEET_EVENT_STATUS,
  MEET_ENTRY_MAX_MEMBERS,
  isEventAlive,
  listAliveEvents,
  meetScope,
  meetRequestScope,
  newMeetId,
  meetEventKey,
  meetCollegeKey,
  meetCollegeLeadKey,
  meetInterestKey,
  meetEntryKey,
  meetQuotaKey,
  meetClaimKey,
  meetParticipantCounterKey,
  meetStandingKey,
  meetHonorKey,
  meetEntrySlot,
  meetSessionKey,
  meetJudgeKey,
  meetScoreKey,
  meetPublicationKey,
  meetResultRowKey,
};
