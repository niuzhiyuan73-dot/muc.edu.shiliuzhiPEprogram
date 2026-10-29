/**
 * 学院赛页面的视图模型（协议 2）—— 迁移清单 M2-c / M3 的页面配套
 * ============================================================
 * 与 school-event-view.js 同一思路：学校维度的服务端（school-college-service /
 * school-match-service / school-live-service / school-member-service）已经把
 * 「业务数据 + 操作权限」一并下发；本模块只把 DTO 整成旧栈页面**已经认识**的
 * 形状（services/college-view.js 的那一套），页面几乎不用改，展示规则也就不会
 * 分叉。换栈换的是取数，不是尺子。
 *
 * 【权限从哪来：判权在服务端】
 * 页面上没有旧角色可算。名单与排阵的能力由服务端算好随读端下发：
 *   · 赛事读端 `canSubmitEntry` / `submittableCollegeIds`（我能替谁交名单）
 *   · 大场读端逐场 `lineupCollegeIds`（我能替哪几侧排阵）
 *   · 名单读端 `canManage`（能不能审名单）
 * 本层把它们与页面已有的数据拼成按钮与拦截文案（如 lineupActions、canForfeit），
 * 不再自己调 canSubmitCollegeEntry / canSubmitLineup 判角色——那是服务端的事。
 *
 * 【学院编号 ↔ 全名】
 * 名单与排阵的入口给的是**学院编号**（会话 account.collegeId），而页面展示与
 * 旧栈规则认的是**全名**。赛事读端顺势下发本校学院目录（`colleges`），本层据
 * 它换算，免得页面再去别处取一次。
 *
 * 【为什么不额外读 lineups】
 * 详情页只想知道某一侧「交没交排阵」——大场读端已经逐场给出 `lineupASubmitted`
 * / `lineupBSubmitted`，够用了。只有排阵页为了「沿用上次」才真的去读 lineups。
 *
 * 【actorId 只用于「我」的高亮与点名】
 * isMine / isRefereeSelf 是展示，不是判权。actorId 由页面从学校身份会话取来传入；
 * 传空即访客。
 *
 * 【本模块只回旧栈同形的数据，写入仍由页面直接调协会空间】
 * 读与写都走同一把范围（学校 + 协会），范围在页面进入时固定一次。
 *
 * 本模块不碰 wx API，可在 Node 里逐条测。
 * ============================================================
 */

const {
  COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS, MATCH_STATUS, MATCH_OUTCOME,
  GENDER_LABEL, LEG_DISCIPLINE_LABEL, MATCH_TYPE_LABEL,
  requiredGendersOf, courtNoTextOf, courtCountTextOf,
} = require('../utils/constants.js');
const { formatDate, formatDateTime, formatScore } = require('../utils/format.js');
const { formatMatchFormat } = require('../utils/match-format.js');
// 路由编号兼容（query 值在不同环境可能已解码 / 未解码，见 utils/route-query.js）
const { routeIdCandidates } = require('../utils/route-query.js');
const space = require('./association-space.js');
const { entryStateOf, remainingMemberIds } = require('./college-entry.js');
const { approvedCollegesOf } = require('./college-draw.js');
const {
  tieStatusLabelOf, firstRoundPairsOf, isDoublesDiscipline,
} = require('./college-tie.js');
const { defaultLineupEntries, playersPerLeg } = require('./college-lineup.js');
const { statusTagOf } = require('./match-view.js');
const { describeLive } = require('./live-view.js');
// 列表读端封顶的条数：与 school-college-service 同一常量，避免两处各写一个数。
const { EVENT_LIST_MAX } = require('./school-college-service.js');

const asArray = value => (Array.isArray(value) ? value : []);
const okOf = dto => Boolean(dto && dto.ok);

/* ============================================================
 * 纯适配
 * ============================================================ */

/** 取名字，逐层兜底，绝不渲染出 undefined */
function nameOf(member) {
  if (!member) return '';
  return member.nickName || member.realName || member._id || '';
}

/** 头像占位字：取名字最后一个字，与其它页面一致 */
function avatarTextOf(name) {
  return name ? name.slice(-1) : '?';
}

/**
 * 会员目录行 → 本模块内部认的会员档案。
 *
 * 旧栈档案以 `_id` 编键、以 `college` 存全名；学校维度读端给的是 `userId` 与
 * `collegeName`。这里抹平这一处差异，之后就能沿用旧栈的姓名 / 性别 / 学院口径。
 *
 * @param {Array<Object>} rows listSchoolMembers 的 members
 * @returns {Array<Object>}
 */
function membersOf(rows) {
  return asArray(rows).map(row => ({
    _id: row.userId,
    nickName: row.nickName || '',
    realName: row.realName || '',
    avatarUrl: row.avatarUrl || '',
    gender: row.gender || '',
    college: row.collegeName || '',
    collegeId: row.collegeId || '',
  }));
}

/** 学院目录（id ↔ 全名）两张表。目录为空时两张都是空表，换算退化为空串。 */
function collegeMaps(colleges) {
  const list = asArray(colleges);
  return {
    nameById: new Map(list.map(item => [item.collegeId, item.name])),
    idByName: new Map(list.map(item => [item.name, item.collegeId])),
  };
}

/**
 * 大场读端行 → 旧栈 buildLineupRow / defaultLineupEntries 认的大场。
 * 只补它们要用的字段：主键换回 `_id`，`legRows` 摊回 `legs`。
 */
function toLegacyTie(row) {
  if (!row) return null;
  return {
    _id: row.tieId,
    eventId: row.eventId,
    round: row.round,
    collegeA: row.collegeA,
    collegeB: row.collegeB,
    status: row.status,
    referee: row.referee || '',
    legs: asArray(row.legRows).map(leg => ({
      legNo: leg.legNo,
      discipline: leg.discipline,
      matchId: leg.matchId,
      winner: leg.winner,
    })),
  };
}

/** 排阵读端行 → defaultLineupEntries 认的排阵记录（补 submitTime 供「沿用上次」排序）。 */
function toCarryLineup(row) {
  return {
    tieId: row.tieId,
    college: row.college,
    submitTime: row.submitTimeText || null,
    entries: asArray(row.entries).map(entry => ({
      legNo: entry.legNo,
      discipline: entry.discipline,
      players: asArray(entry.players),
    })),
  };
}

/** 小项的性别提示：男单 / 男双 → 「限男」；女单 / 女双 → 「限女」；混双 → 「一男一女」。 */
function genderHintOf(discipline) {
  const required = requiredGendersOf(discipline);
  if (!required || required.length === 0) return '';
  const kinds = Array.from(new Set(required));
  if (kinds.length > 1) return '一男一女';
  return `限${GENDER_LABEL[kinds[0]] || ''}`;
}

/**
 * 种子行的显示整形：按已选顺序标出「种子 N」。
 * 与旧栈 buildSeedRows 一模一样——这是页面交互态，不属于赛事规则。
 */
function buildSeedRows(colleges, seedColleges) {
  const order = asArray(seedColleges);
  return asArray(colleges).map(college => {
    const index = order.indexOf(college);
    return {
      college,
      isSeed: index >= 0,
      seedOrder: index >= 0 ? index + 1 : 0,
      seedOrderText: index >= 0 ? `种子 ${index + 1}` : '',
    };
  });
}

/** 首轮对阵的文字预览，例如「1. 体育学院 vs 信息工程学院」 */
function firstRoundPairsTextOf(draw) {
  return firstRoundPairsOf(draw)
    .filter(pair => pair && pair[0] && pair[1])
    .map((pair, index) => `${index + 1}. ${pair[0]} vs ${pair[1]}`)
    .join('　');
}

/* ============================================================
 * 装载器：向协会空间要数，整成旧栈同形
 * ============================================================ */

/**
 * 路由编号兼容：先原值、再解码值地探测学院赛，返回命中的编号与 DTO。
 * 未命中时回退到第一个候选与最后一次的失败 DTO（保留原有的「找不到」话术）。
 *
 * 【为什么命中的编号要一路带回页面】
 * 探测出真实编号却不回传，页面实例上留着的仍是路由原值；读靠本层兜住了，
 * 写却直连服务端——同一个编号两种命运，页面就成了「看得见、写不进」。
 * 所以这里返回的 `id` 是**写操作与跳转唯一该用的编号**，由装载器放进视图模型
 * （各 loadCollegeXxxView 的 eventId / tieId / matchId），页面照单采纳。
 */
async function resolveCollegeEventId(api, eventId) {
  const candidates = routeIdCandidates(eventId);
  let last = null;
  for (const id of candidates) {
    // eslint-disable-next-line no-await-in-loop —— 候选最多两个
    const dto = await api.getCollegeEvent({ eventId: id });
    if (okOf(dto)) return { id, dto };
    last = dto;
  }
  return { id: candidates[0] || '', dto: last || { ok: false, message: '找不到这场学院赛' } };
}

/**
 * 名单提交页视图（协议 2）。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @param {string} [options.collegeId] 替哪个学院提交；缺省从服务端授权范围选择
 * @returns {Promise<Object>} 与旧栈 loadCollegeEntryView 同形
 */
async function loadCollegeEntryView(eventId, options = {}) {
  const { schoolId, association, actorId = null, collegeId: requestedCollegeId = '', preferredCollegeId = '' } = options;
  const api = space.forScope({ schoolId, association });
  const resolved = await resolveCollegeEventId(api, eventId);
  const resolvedId = resolved.id;

  const allowedIds = asArray(resolved.dto && resolved.dto.submittableCollegeIds);
  const collegeId = requestedCollegeId || (allowedIds.includes(preferredCollegeId) ? preferredCollegeId : allowedIds[0]) || '';

  const [eventDto, entriesDto, membersDto] = await Promise.all([
    Promise.resolve(resolved.dto),
    api.listCollegeEntries({ eventId: resolvedId }),
    allowedIds.includes(collegeId) && !options.pagedCandidates ? api.listSchoolMembers({ collegeId }) : Promise.resolve({ ok: true, members: [] }),
  ]);

  const found = okOf(eventDto);
  const event = found ? eventDto.event : null;
  const { nameById } = collegeMaps(found ? eventDto.colleges : []);
  const college = nameById.get(collegeId) || '';
  const submittable = asArray(found ? eventDto.submittableCollegeIds : []);
  const members = membersOf(membersDto && membersDto.members);
  const entries = asArray(entriesDto && entriesDto.entries);

  // 拦截顺序与旧栈一致：登录 → 赛事存在 → 状态 → 学院范围
  let blockReason = '';
  if (!actorId) blockReason = '请先登录后再提交名单';
  else if (!found) blockReason = (eventDto && eventDto.message) || '找不到这场学院赛';
  else if (event.status !== COLLEGE_EVENT_STATUS.SIGNUP) blockReason = '名单已经锁定，不能再修改';
  else if (!college || !submittable.includes(collegeId)) blockReason = '只能提交本学院的名单';

  const canSubmit = !blockReason;
  const existing = entries.find(item => item.college === college) || null;
  const picked = new Set(existing ? asArray(existing.memberIds) : []);

  // 候选队员：本学院在册会员。已提交的名单里的人预勾选，便于改后重交
  const candidates = members
    .filter(member => member.college === college)
    .map(member => {
      const name = nameOf(member);
      return {
        memberId: member._id,
        nickName: name,
        avatarUrl: member.avatarUrl || '',
        avatarText: avatarTextOf(name),
        gender: member.gender || '',
        genderLabel: GENDER_LABEL[member.gender] || '',
        checked: picked.has(member._id),
      };
    });

  const state = entryStateOf(existing ? { status: existing.status } : null);
  const status = found ? event.status : null;

  return {
    found,
    canSubmit,
    blockReason,
    // 真实编号（探测命中的那个）回传页面：提交名单必须用它，路由原值在未解码
    // 环境里查不到这场赛事（见 resolveCollegeEventId 的注释）
    eventId: found ? (event.eventId || resolvedId) : eventId || '',
    title: found ? event.title || '' : '',
    status,
    statusLabel: found ? event.statusLabel || '未知状态' : '',
    college,
    collegeId,
    collegeOptions: submittable.map(id => ({ collegeId: id, name: nameById.get(id) || id })),
    collegeIndex: Math.max(0, submittable.indexOf(collegeId)),
    legPlanText: found ? event.legPlanText : '',
    rosterText: found ? event.rosterText : '',
    allowMultiEntry: found ? event.allowMultiEntry !== false : false,
    startTimeText: found ? event.startTimeText : '',
    location: found ? event.location || '' : '',
    tieAlgoLabel: found ? event.tieAlgoLabel : '',
    tieNetModeLabel: found ? event.tieNetModeLabel : '',
    entryStatus: state.status,
    entryStatusLabel: state.label,
    entryPending: state.pending,
    entryApproved: state.approved,
    entryReturned: state.returned,
    entryReason: existing ? existing.reason || '' : '',
    existingCount: existing ? asArray(existing.memberIds).length : 0,
    existingMemberIds: [...picked],
    existingMembers: [...picked].map((userId, index) => ({ userId,
      nickName: (existing.memberNames || [])[index] || userId })),
    candidates,
    selectedCount: options.pagedCandidates ? picked.size : candidates.filter(item => item.checked).length,
    remark: existing ? existing.remark || '' : '',
  };
}

/**
 * 名单审核页视图（协议 2）。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>} 与旧栈 loadCollegeEntryReviewView 同形
 */
async function loadCollegeEntryReviewView(eventId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });
  const resolved = await resolveCollegeEventId(api, eventId);

  const [eventDto, entriesDto] = await Promise.all([
    Promise.resolve(resolved.dto),
    api.listCollegeEntries({ eventId: resolved.id }),
  ]);

  const found = okOf(eventDto);
  const event = found ? eventDto.event : null;
  const canReview = Boolean(entriesDto && entriesDto.canManage);

  let blockReason = '';
  if (!actorId) blockReason = '请先登录后再审核名单';
  else if (!canReview) blockReason = '只有管理员可以审核名单';
  else if (!found) blockReason = '找不到这场学院赛';

  const rows = asArray(entriesDto && entriesDto.entries)
    .map(row => ({ ...row, memberNamesText: asArray(row.memberNames).join('、') }));

  return {
    found,
    canReview,
    blockReason,
    // 真实编号回传页面：审核（通过 / 退回）必须用它（见 loadCollegeEntryView）
    eventId: found ? (event.eventId || resolved.id) : eventId || '',
    title: found ? event.title || '' : '',
    statusLabel: found ? event.statusLabel || '未知状态' : '',
    legPlanText: found ? event.legPlanText : '',
    rosterText: found ? event.rosterText : '',
    startTimeText: found ? event.startTimeText : '',
    location: found ? event.location || '' : '',
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有学院提交名单',
    pendingCount: rows.filter(row => row.isPending).length,
    substituteHint: '名单内未上场的队员即为替补，无需单独维护替补栏',
  };
}

/**
 * 详情页视图（协议 2）：赛事信息 + 抽签入口 + 赛事级开赛 + 大场列表。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>} 与旧栈 loadCollegeEventDetailView 同形
 */
async function loadCollegeEventDetailView(eventId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });
  const resolved = await resolveCollegeEventId(api, eventId);

  const eventDto = resolved.dto;
  const found = okOf(eventDto);
  const event = found ? eventDto.event : null;

  let blockReason = '';
  if (!actorId) blockReason = '请先登录后再查看学院赛';
  else if (!found) blockReason = (eventDto && eventDto.message) || '找不到这场学院赛';

  if (blockReason || !event) {
    return {
      found: false,
      blockReason: blockReason || '找不到这场学院赛',
      eventId: eventId || '',
      title: '', status: null, statusLabel: '',
      isSignup: false, isReady: false, isOngoing: false, isFinished: false,
      legPlanText: '', rosterText: '', startTimeText: '', location: '', courtCountText: '',
      tieAlgoLabel: '', tieNetModeLabel: '',
      canManage: false, canDraw: false, canSubmitEntry: false,
      approvedColleges: [], hasApprovedColleges: false,
      drawHint: '', hasDraw: false, drawPairsText: '', drawSeedsText: '', drawByesText: '',
      canStartEvent: false, ties: [], hasTies: false, tiesEmptyNote: '', currentRound: 0,
      approvedCount: 0, canFinish: false, resultRows: [], hasResults: false,
    };
  }

  const [entriesDto, tiesDto] = await Promise.all([
    api.listCollegeEntries({ eventId: resolved.id }),
    api.listCollegeTies({ eventId: resolved.id }),
  ]);

  const canManage = Boolean(eventDto.canManage);
  const { nameById } = collegeMaps(eventDto.colleges);
  const entries = asArray(entriesDto && entriesDto.entries);
  const tieRows = asArray(tiesDto && tiesDto.ties);
  // 【只批读裁判，不读全校名录】（2026-10-29 第十二轮审计）
  // 这一页用到名录的只有「大场裁判叫什么」。原先读整校名录 + 全部账号（2000 人
  // 就是 40 次 RPC）只为几个人，现在按编号批读。
  const refereeIds = [...new Set(tieRows.map(row => row.referee).filter(id => typeof id === 'string' && id))];
  const members = refereeIds.length
    ? membersOf((await api.listSchoolMembers({ userIds: refereeIds })).members)
    : [];
  const memberById = new Map(members.map(member => [member._id, member]));

  const isSignup = event.status === COLLEGE_EVENT_STATUS.SIGNUP;
  const isReady = event.status === COLLEGE_EVENT_STATUS.READY;
  const isOngoing = event.status === COLLEGE_EVENT_STATUS.ONGOING;
  const approvedColleges = approvedCollegesOf(entries);

  // 大场行：在服务端已算好的 buildTieRow 之上补「我能不能排阵 / 该显示什么按钮」。
  // 排阵入口按「两侧各解一次」：lineupCollegeIds 就是服务端逐侧解出来的可排学院。
  const ties = tieRows.map(row => {
    const lineupActions = asArray(row.lineupCollegeIds)
      .map(id => {
        const college = nameById.get(id);
        if (!college) return null;
        const side = college === row.collegeA ? 'A' : 'B';
        const submitted = side === 'A' ? Boolean(row.lineupASubmitted) : Boolean(row.lineupBSubmitted);
        return {
          side,
          college,
          submitted,
          label: `${submitted ? '修改' : '提交'} ${side} 侧排阵`,
        };
      })
      .filter(Boolean);
    // 裁判显示姓名而不是编号：服务端的大场读端只带 referee（编号），姓名由本层
    // 用会员目录补——与旧栈详情页 messageNode 同一处整形，模板不必再判空。
    const refereeName = row.referee && memberById.get(row.referee)
      ? nameOf(memberById.get(row.referee))
      : (row.referee || '');
    return {
      ...row,
      refereeName,
      // 指派大场裁判只给管理员，且只在大场未结束时开
      canAssignReferee: Boolean(row.canAssignReferee && canManage),
      canSubmitLineup: lineupActions.length > 0,
      lineupActions,
    };
  });

  // 小场的实时比分：把这一场所有小场的 matchId 收齐，一次批量取（首屏与增量同源）
  const legIds = [];
  for (const row of ties) {
    for (const leg of asArray(row.legRows)) {
      if (leg.matchId) legIds.push(leg.matchId);
    }
  }
  const liveDto = legIds.length > 0 ? await api.getSchoolLiveScores({ matchIds: legIds }) : null;
  const liveByMatch = new Map(
    asArray(liveDto && liveDto.scores).map(view => [view.matchId, view])
  );
  const liveTies = ties.map(row => ({
    ...row,
    legRows: asArray(row.legRows).map(leg => {
      const live = describeLive(liveByMatch.get(leg.matchId));
      return live ? { ...leg, live, liveActive: true } : leg;
    }),
  }));

  const draw = event.draw || null;
  const resultRows = asArray(event.results)
    .slice()
    .sort((a, b) => Number(a.placement) - Number(b.placement))
    .map(item => ({
      college: item.college || '',
      placement: Number(item.placement),
      placementText: formatPlacementText(item.placement),
    }));

  return {
    found: true,
    blockReason: '',
    // 真实编号回传页面：抽签 / 开赛 / 跳转名单与排阵页都必须用它（见 resolveCollegeEventId）
    eventId: event.eventId || resolved.id,
    title: event.title || '',
    status: event.status,
    statusLabel: event.statusLabel || '未知状态',
    isSignup,
    isReady,
    isOngoing,
    isFinished: event.status === COLLEGE_EVENT_STATUS.FINISHED,
    legPlanText: event.legPlanText,
    rosterText: event.rosterText,
    startTimeText: event.startTimeText,
    location: event.location || '',
    courtCountText: courtCountTextOf(event.courtCount),
    tieAlgoLabel: event.tieAlgoLabel,
    tieNetModeLabel: event.tieNetModeLabel,
    canManage,
    canDraw: isSignup && canManage,
    canSubmitEntry: Boolean(eventDto.canSubmitEntry),
    approvedColleges,
    hasApprovedColleges: approvedColleges.length > 0,
    drawHint: '按顺序点选种子学院：先点的排 1 号，再点一次取消',
    hasDraw: Boolean(draw),
    drawPairsText: draw ? firstRoundPairsTextOf(draw) : '',
    drawSeedsText: draw && asArray(draw.seeds).length > 0 ? draw.seeds.join('、') : '未指定种子',
    drawByesText: draw && asArray(draw.byes).length > 0 ? `轮空：${draw.byes.join('、')}` : '',
    canStartEvent: isReady && canManage,
    ties: liveTies,
    hasTies: liveTies.length > 0,
    tiesEmptyNote: '本轮还没有大场',
    currentRound: Number(event.currentRound) || 0,
    approvedCount: approvedColleges.length,
    canFinish: isOngoing && canManage,
    resultRows,
    hasResults: resultRows.length > 0,
  };
}

/**
 * 排阵页视图（协议 2）：本大场逐个小项的出场人。
 *
 * @param {string} tieId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @param {string} [options.eventId]
 * @param {string} [options.collegeId] 替哪个学院排；缺省取 options.college（全名）
 * @param {string} [options.college] 替哪个学院排（全名）
 * @returns {Promise<Object>} 与旧栈 loadCollegeLineupView 同形
 */
async function loadCollegeLineupView(tieId, options = {}) {
  const { schoolId, association, actorId = null, eventId = '' } = options;
  const api = space.forScope({ schoolId, association });

  // 路由编号兼容：未解码的 query 也要能对上大场。
  // 【为什么按候选序列取列表】大场列表要按 eventId 过滤，而未解码的 eventId 会被
  // 服务端原样比对，一条都过滤不出来——排阵页于是「找不到这个大场」。候选最多两个
  // （原值 → 解码值），取到就停；没带 eventId 时退化成一次不带过滤的读取，与从前一样。
  const eventCandidates = eventId ? routeIdCandidates(eventId) : [''];
  let tiesDto = null;
  let tieRows = [];
  for (const candidate of eventCandidates) {
    // eslint-disable-next-line no-await-in-loop —— 候选最多两个
    const dto = await api.listCollegeTies(candidate ? { eventId: candidate } : {});
    if (!tiesDto) tiesDto = dto;
    tieRows = asArray(dto && dto.ties);
    if (tieRows.length > 0) { tiesDto = dto; break; }
  }
  const tieCandidates = routeIdCandidates(tieId);
  const row = tieRows.find(item => tieCandidates.includes(item.tieId)) || null;
  const resolvedTieId = row ? row.tieId : (tieCandidates[0] || '');
  const resolvedEventId = row ? row.eventId : eventId;

  const [eventDto, entriesDto, lineupsDto] = await Promise.all([
    resolvedEventId ? api.getCollegeEvent({ eventId: resolvedEventId }) : Promise.resolve(null),
    resolvedEventId ? api.listCollegeEntries({ eventId: resolvedEventId }) : Promise.resolve(null),
    resolvedEventId ? api.listCollegeLineups({ eventId: resolvedEventId }) : Promise.resolve(null),
  ]);

  const event = okOf(eventDto) ? eventDto.event : null;
  const { nameById, idByName } = collegeMaps(okOf(eventDto) ? eventDto.colleges : []);
  const college = String(options.college || nameById.get(options.collegeId) || '').trim();
  // 编号以「显式指定的一侧」为准：管理员替某侧排阵时路由里带的是那一侧的学院名，
  // 而会话里带的是本人学院编号（c01），两者未必是同一所学院。若拿会话编号去判
  // 排阵权，两侧都进不去（管理员本人不在大场内）。所以先按全名反查编号，查不到
  // 再退回会话编号。
  const collegeId = idByName.get(college) || options.collegeId || '';
  const submittable = asArray(row && row.lineupCollegeIds);

  const entry = asArray(entriesDto && entriesDto.entries).find(item => item.college === college) || null;
  const lineups = asArray(lineupsDto && lineupsDto.lineups);
  const tie = toLegacyTie(row);
  const defaults = defaultLineupEntries({ tie, college, lineups: lineups.map(toCarryLineup) });
  const defaultMap = new Map(
    asArray(defaults.entries).map(item => [Number(item.legNo), asArray(item.players).map(String)])
  );
  const roster = entry ? asArray(entry.memberIds) : [];
  // 【只批读本队名单，不读全校名录】（2026-10-29 第十二轮审计）
  // 排阵下拉列的就是这一队的人；原先为这几十个人读整校名录 + 全部账号。
  const members = roster.length
    ? membersOf((await api.listSchoolMembers({ userIds: roster })).members)
    : [];
  const byId = new Map(members.map(member => [member._id, member]));
  // 「我交没交过」按**解析后的**大场编号比对：路由原值在未解码环境里对不上
  const existing = lineups.find(item => item.tieId === resolvedTieId && item.college === college) || null;

  // 拦截顺序即提示顺序：登录 → 大场存在 → 参赛学院 → 赛事态 → 排阵权 → 名单状态
  let blockReason = '';
  if (!actorId) {
    blockReason = '请先登录后再排阵';
  } else if (!row) {
    blockReason = (tiesDto && tiesDto.message) || '找不到这个大场';
  } else if (college !== row.collegeA && college !== row.collegeB) {
    blockReason = '你不在本大场的参赛学院内';
  } else if (row.status === TIE_STATUS.ONGOING || row.status === TIE_STATUS.FINISHED) {
    blockReason = '大场已经开始，不能再改排阵';
  } else if (event && event.status !== COLLEGE_EVENT_STATUS.ONGOING) {
    blockReason = '赛事还没开始，不能排阵';
  } else if (!collegeId || !submittable.includes(collegeId)) {
    blockReason = '只有本学院负责人、协会负责人或管理员可以排阵';
  } else if (!entry || entry.status !== COLLEGE_ENTRY_STATUS.APPROVED) {
    blockReason = '本学院的名单尚未通过审核，不能排阵';
  }

  const legs = asArray(row && row.legRows).map(legRow => {
    const picked = defaultMap.get(Number(legRow.legNo)) || [];
    const need = playersPerLeg(legRow.discipline);
    // 候选按小项性别过滤：男单只列男队员、混双列男女
    const allowed = requiredGendersOf(legRow.discipline);
    const legOptions = roster
      .filter(id => {
        if (!allowed) return true;
        const member = byId.get(id);
        return Boolean(member) && allowed.includes(member.gender);
      })
      .map(id => {
        const member = byId.get(id);
        return {
          memberId: id,
          name: nameOf(member) || id,
          gender: (member && member.gender) || '',
          genderLabel: (member && GENDER_LABEL[member.gender]) || '',
          checked: picked.includes(String(id)),
        };
      });
    return {
      legNo: legRow.legNo,
      discipline: legRow.discipline,
      disciplineLabel: LEG_DISCIPLINE_LABEL[legRow.discipline] || legRow.discipline || '',
      genderHint: genderHintOf(legRow.discipline),
      need,
      needText: `${need} 人`,
      pickedText: picked.length > 0 ? picked.map(id => nameOf(byId.get(id))).join('、') : '未排人',
      options: legOptions,
    };
  });

  return {
    found: Boolean(row),
    blockReason,
    canSubmit: !blockReason,
    // 真实编号（探测命中的大场 / 它所属的赛事）回传页面：提交排阵必须用它，
    // 路由原值在未解码环境里对不上大场（见 resolveCollegeEventId 的注释）
    tieId: row ? row.tieId : resolvedTieId,
    eventId: resolvedEventId,
    title: event ? event.title || '' : '',
    roundText: row ? `第 ${row.round} 轮` : '',
    collegeA: row ? row.collegeA || '' : '',
    collegeB: row ? row.collegeB || '' : '',
    college,
    isCollegeA: Boolean(row) && college === row.collegeA,
    isCollegeB: Boolean(row) && college === row.collegeB,
    statusLabel: tieStatusLabelOf(tie),
    legs,
    hasLegs: legs.length > 0,
    carryHint:
      defaults.source === 'carried'
        ? '已自动沿用上次提交的排阵，可直接提交或调整'
        : defaults.source === 'own'
          ? '你已提交过本场排阵，下面是已交的内容'
          : '还没有可沿用的排阵，请逐项选择队员',
    rosterCount: roster.length,
    rosterEmpty: roster.length === 0,
    hasLineup: Boolean(existing),
  };
}

/**
 * 小场录分页视图（协议 2）。
 *
 * @param {string} matchId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>} 与旧栈 loadCollegeMatchView 同形
 */
async function loadCollegeMatchView(matchId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });

  // 路由编号兼容：先原值、再解码值地探测比赛（详见 utils/route-query.js）
  let matchDto = null;
  let resolvedMatchId = routeIdCandidates(matchId)[0] || '';
  for (const candidate of routeIdCandidates(matchId)) {
    // eslint-disable-next-line no-await-in-loop —— 候选最多两个
    const dto = await api.getSchoolMatch({ matchId: candidate });
    if (okOf(dto)) { matchDto = dto; resolvedMatchId = candidate; break; }
    if (!matchDto) matchDto = dto;
  }
  const record = okOf(matchDto) ? matchDto.match : null;

  if (!record) {
    // 找不到比赛也要给全「比分行」所需的形状：页面 refresh 会按 bestOf 逐行读
    // scoreA/scoreB 回填输入框，缺了字段会在读下标时抛错。
    return {
      found: false,
      blockReason: '找不到这场比赛',
      matchId: resolvedMatchId,
      teamARows: [], teamBRows: [], scoreA: [], scoreB: [],
      gamePoints: 11, bestOf: 1,
    };
  }

  const eventId = record.collegeEventId || '';
  const tiesDto = await api.listCollegeTies(eventId ? { eventId } : {});
  const tieRow = asArray(tiesDto && tiesDto.ties).find(item => item.tieId === record.tieId) || null;
  const tie = toLegacyTie(tieRow);
  const canManage = Boolean(tiesDto && tiesDto.canManage);

  const eventDto = eventId ? await api.getCollegeEvent({ eventId }) : null;
  const event = okOf(eventDto) ? eventDto.event : null;

  // 【只批读这一场涉及的人】（2026-10-29 第十二轮审计）
  // 小场详情要把双方与裁判的编号换成姓名；原先为此读整校名录 + 全部账号。
  const personIds = [...new Set([
    ...asArray(record.teamA), ...asArray(record.teamB),
    typeof record.referee === 'string' ? record.referee : '',
  ].map(String).filter(Boolean))];
  const members = personIds.length
    ? membersOf((await api.listSchoolMembers({ userIds: personIds })).members)
    : [];
  const byId = new Map(members.map(member => [member._id, member]));
  const nameOfId = id => {
    const member = byId.get(id);
    if (!member) return id || '';
    return member.nickName || member.realName || id || '';
  };
  const rowsOf = team => asArray(team).map(id => {
    const name = nameOfId(id);
    return { userId: id, nickName: name, avatarText: name ? name.slice(-1) : '?' };
  });

  const tag = statusTagOf(record.status, record.action);
  const pending = record.status === MATCH_STATUS.PENDING;
  // 「这个小项已有结果」以大场快照为准（与旧栈同口径）：小场录了分但未确认时
  // 快照还没写，仍可记弃权；快照一落，弃权入口即关闭。
  const leg = asArray(tieRow && tieRow.legRows)
    .find(item => Number(item.legNo) === Number(record.legNo)) || null;
  const legSettled = Boolean(leg && leg.winner);
  // 弃权：判权在服务端（canManage），其余条件都是数据——大场进行中、小项未定、小场未生效。
  // 学院赛小场弃权记给学院，不走个人赛那条 forfeitSchoolMatch（见 school-match-service）。
  const canForfeit = Boolean(
    actorId && canManage && tieRow && tieRow.status === TIE_STATUS.ONGOING &&
    !legSettled && record.status !== MATCH_STATUS.ACTIVE
  );

  const officiated = Boolean(record.hasReferee);
  const refereeName = officiated ? nameOfId(record.referee) : '';
  const isRefereeSelf = Boolean(officiated && actorId && actorId === record.referee);
  const refereeRestricted = Boolean(officiated && !isRefereeSelf && !canManage);
  const doubles = isDoublesDiscipline(record.discipline);

  return {
    found: true,
    blockReason: '',
    // 真实编号回传页面：录分 / 确认 / 撤销都要用它（见 resolveCollegeEventId 的注释）
    matchId: record.matchId || resolvedMatchId,
    tieId: record.tieId || '',
    legNo: Number(record.legNo) || 0,
    eventId,
    title: event ? event.title || '' : '',
    roundText: tieRow ? `第 ${tieRow.round} 轮` : '',
    legNoText: record.legNo ? `第 ${record.legNo} 场` : '',
    disciplineLabel: LEG_DISCIPLINE_LABEL[record.discipline] || record.discipline || '',
    matchTypeLabel: MATCH_TYPE_LABEL[record.matchType] || record.matchTypeLabel || '',
    collegeA: tieRow ? tieRow.collegeA || '' : '',
    collegeB: tieRow ? tieRow.collegeB || '' : '',
    teamARows: rowsOf(record.teamA),
    teamBRows: rowsOf(record.teamB),
    scoreText: formatScore(record.scoreA, record.scoreB),
    scoreA: asArray(record.scoreA).map(v => (v === null || v === undefined ? '' : String(v))),
    scoreB: asArray(record.scoreB).map(v => (v === null || v === undefined ? '' : String(v))),
    gamePoints: Number(record.gamePoints) || 11,
    bestOf: Number(record.bestOf) || 1,
    formatText: formatMatchFormat({ gamePoints: record.gamePoints, bestOf: record.bestOf }),
    matchTimeText: formatDateTime(record.matchTime),
    location: record.location || '',
    courtText: courtNoTextOf(record.courtNo),
    status: record.status,
    statusLabel: tag.label,
    statusClass: tag.className,
    statusTagClass:
      record.status === MATCH_STATUS.PENDING
        ? 'tag-warning'
        : record.status === MATCH_STATUS.ACTIVE
          ? 'tag-success'
          : 'tag-gray',
    statusReason: record.reason || '',
    isForfeit: record.outcome === MATCH_OUTCOME.FORFEIT,
    forfeitBy: record.forfeitBy || '',
    forfeitText: record.outcome === MATCH_OUTCOME.FORFEIT ? `${record.forfeitBy || '一方'} 弃权` : '',
    winnerSide: record.winner || null,
    winnerText:
      record.winner === 'A'
        ? `${tieRow ? tieRow.collegeA : 'A 队'} 胜`
        : record.winner === 'B'
          ? `${tieRow ? tieRow.collegeB : 'B 队'} 胜`
          : '',
    needsScore: Boolean(record.needsScore),
    canRecord: Boolean(pending && record.canRecord),
    canConfirm: Boolean(record.canConfirm),
    canForfeit,
    isDoubles: doubles,
    hasReferee: officiated,
    refereeName,
    refereeRestricted,
    refereeNotice: refereeRestricted
      ? `本场由 ${refereeName} 裁判执法，仅裁判与管理员可录入比分`
      : '',
    eloHint: doubles
      ? '双打小场只决定大场胜负，不改变任何人的个人等级分'
      : '单打小场确认后，个人等级分立刻更新',
    demoNotice: '',
  };
}

/**
 * 学院名次录入页视图（协议 2）。
 *
 * 【为什么失败关闭】没有管理权时一条学院名单都不下发，界面上就不可能冒出一个
 * 能点的录入框。与旧栈 loadCollegePlacementView 同。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>} 与旧栈 loadCollegePlacementView 同形
 */
async function loadCollegePlacementView(eventId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });
  const resolved = await resolveCollegeEventId(api, eventId);

  const eventDto = resolved.dto;
  const found = okOf(eventDto);
  const event = found ? eventDto.event : null;
  const canManage = Boolean(eventDto && eventDto.canManage);

  let blockReason = '';
  if (!actorId) blockReason = '请先登录后再录入名次';
  else if (!found) blockReason = '找不到这场学院赛';
  else if (event.status === COLLEGE_EVENT_STATUS.FINISHED) blockReason = '这场学院赛已经结束了';
  else if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) blockReason = '学院赛还没开始，不能录入名次';
  else if (!canManage) blockReason = '只有管理员可以录入名次';

  const eventFields = {
    found,
    // 真实编号回传页面：提交名次（结束赛事）必须用它（见 resolveCollegeEventId 的注释）
    eventId: found ? (event.eventId || resolved.id) : eventId || '',
    title: found ? event.title || '' : '',
    statusLabel: found ? event.statusLabel || '未知状态' : '',
    isFinished: found && event.status === COLLEGE_EVENT_STATUS.FINISHED,
    startTimeText: found ? event.startTimeText : '',
    location: found ? event.location || '' : '',
    legPlanText: found ? event.legPlanText : '',
  };

  if (blockReason) {
    return {
      ...eventFields,
      blockReason,
      canSubmit: false,
      rows: [],
      hasRows: false,
      emptyNote: '',
      hint: '',
    };
  }

  // 取名单也要用**解析后的**编号：路由原值在未解码环境里查不到名单，
  // 页面上就会一所候选学院也没有（看着像「没人交名单」）
  const entriesDto = await api.listCollegeEntries({ eventId: resolved.id });
  const entries = asArray(entriesDto && entriesDto.entries);

  // 已录过的名次回填，免得管理员重开页面时从零再填一遍
  const recorded = new Map(
    asArray(event.results).map(row => [row.college, String(row.placement)])
  );
  const rows = entries
    .filter(entry => entry.status === COLLEGE_ENTRY_STATUS.APPROVED)
    .map(entry => ({
      college: entry.college,
      placementText: recorded.get(entry.college) || '',
    }));

  return {
    ...eventFields,
    blockReason: '',
    canSubmit: true,
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有已通过审核的学院，先收齐名单再来录名次',
    hint: '每所参赛学院一行：名次为不小于 1 的整数，冠军有且只有一位；没到场的学院可以不填',
  };
}

/**
 * 学院赛列表行（协议 2）—— 供给赛事页 / 全部学院赛页的学院赛分支。
 * ============================================================
 * 旧栈的 `events-view.loadEventsView` 曾拿旧门面的学院赛再整形成行；学院赛迁到
 * 学校维度后，这一处也改由 S2 协会空间取数，否则「发布走 S2、列表读旧栈」，
 * 新发布的学院赛在列表里根本不出现（跨库不一致）。
 *
 * 服务端读端已逐行下发 `canManage` / `canReview` / `canSubmit` 与状态标记，本层
 * 只补三样纯展示字段（置顶开关、入口文案、状态色），与旧栈列表行一字不差，
 * 模板与跳转逻辑不必改。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @returns {Promise<{rows: Array<Object>, canManage: boolean}>}
 */
async function loadCollegeEventListRows(options = {}) {
  const { schoolId, association } = options;
  const api = space.forScope({ schoolId, association });
  // 分批取齐，服务端单次上限不等于全部赛事总数。
  const all = [];
  let offset = 0;
  let dto;
  do {
    dto = await api.listCollegeEvents({ limit: EVENT_LIST_MAX, offset });
    if (!okOf(dto)) return { rows: [], canManage: false };
    all.push(...asArray(dto.events));
    if (dto.hasMore && !(dto.nextOffset > offset)) throw new Error('学院赛列表分页没有前进');
    offset = dto.nextOffset;
  } while (dto.hasMore);
  const rows = all.map(row => ({
    ...row,
    // 置顶与发布 / 审核同一门槛（仅管理员），直接复用行里算好的 canManage
    canPin: Boolean(row.canManage),
    actionText: row.canReview ? '管理' : row.canSubmit ? '提交名单' : '查看',
    // 报名中用成功色、进行中用警示色，待开赛与已结束用灰色
    statusClass: row.isSignup ? 'tag-success' : row.isOngoing ? 'tag-warning' : 'tag-gray',
  }));
  return { rows, canManage: Boolean(dto && dto.canManage) };
}

/**
 * 发布权探针（协议 2）：发布学院赛只给管理员，但发布页进来就得知道有没有资格。
 * 借列表读端的 `canManage` 当探针——它就是服务端算好的 canManageCollegeEvent，
 * 不新增接口、也不在页面上拼角色。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @returns {Promise<boolean>}
 */
async function canPublishCollegeEvent(options = {}) {
  const { schoolId, association } = options;
  const api = space.forScope({ schoolId, association });
  const dto = await api.listCollegeEvents({ limit: 1 });
  return Boolean(dto && dto.canManage);
}

/** 名次文案：淘汰赛口径（1 冠军 / 2 亚军 / 3 四强），与个人赛的奖牌文案各管各的。 */
function formatPlacementText(placement) {
  const { formatPlacement } = require('../utils/format.js');
  return formatPlacement(placement);
}

module.exports = {
  membersOf,
  collegeMaps,
  toLegacyTie,
  buildSeedRows,
  loadCollegeEntryView,
  loadCollegeEntryReviewView,
  loadCollegeEventDetailView,
  loadCollegeLineupView,
  loadCollegeMatchView,
  loadCollegePlacementView,
  loadCollegeEventListRows,
  canPublishCollegeEvent,
  remainingMemberIds,
};
