/**
 * 个人赛事页视图（协议 2）的适配层 —— 迁移清单 M1-a 的页面配套
 * ============================================================
 * 学校维度的服务端（school-event-service / school-match-service /
 * school-rank-service）已经把「业务数据 + 操作权限」一并下发。本模块**只做
 * 数据形状适配**：把 DTO 转回旧栈构建器（event.js / events-view.js）认识的
 * 形状，再复用同一套展示规则（姓名、比分、签表、名次表、场地分配、名次推导），
 * 因此协议 1 与协议 2 在页面上看到的是同一把尺子量出来的东西。
 *
 * 【为什么不另写一套页面构建器】
 * events-view.js 已经写了 1200 多行的展示规则，另起炉灶等于把「轮次怎么叫、
 * 双打一边怎么显示、名次怎么排」再抄一遍，两边迟早分叉。这里只补一层
 * DTO → 旧形状的翻译（`eventId` → `_id`、`matchId` → `_id`、报名计数拼成
 * 报名记录数组……），其余一字不动。
 *
 * 【权限从哪来】
 * 判权在服务端，页面上没有旧角色 actor 可算。DTO 的能力旗标（event 级
 * `capabilities`、报名记录级 `canCheckIn`、比赛记录级 `canRecord / canConfirm /
 * canAssignReferee`）由本层**原样注入**既有构建器（buildEventRow /
 * buildSignupRows / buildBracketRows 都已允许显式传 caps），构建器便不再自行
 * 判权——这正是「服务端提供权限、视图层复用构建器」的分工。
 *
 * 【actorId 只用于「我」的高亮】
 * isMe / isMine 是展示，不是判权。actorId 由页面从学校身份会话取来传入；
 * 传空即视作访客，任何一行都不高亮「我」。
 *
 * 【列表行为什么只给 canPin】
 * 列表读端（listSchoolEvents）刻意保持精简，只回 `canManage` 一个总闸门。
 * 列表页只用它决定置顶入口；报名 / 抽签 / 开赛等按钮都在详情页，那里才下发
 * 逐项能力。于是列表行只注入 `canPin`，其余能力旗标保持默认（不被使用）。
 *
 * 本模块不碰 wx API，可在 Node 里逐条测。
 * ============================================================
 */

const { RATING_POOL, SIGNUP_STATUS } = require('../utils/constants.js');
const { getAssociation, isKnownAssociation } = require('../utils/associations.js');
// 路由编号兼容（query 值在不同环境可能已解码 / 未解码，见 utils/route-query.js）
const { resolveRouteId } = require('../utils/route-query.js');
const space = require('./association-space.js');
const { buildEventRow } = require('./event.js');
const { actualSeedCount, manualPlayersNeeded } = require('./draw.js');
const { derivePlacements } = require('./format-plan.js');

/**
 * `limit: Infinity`（取齐）最多翻几页。每页在服务端都是一次全表读 + 全量排序，
 * 所以取齐必须有天花板，不能跟着数据量一路翻下去（2026-10-29 第十一轮审计 P2-4）。
 */
const INFINITE_FETCH_PAGES = 5;
const {
  asArray,
  buildSignupRows,
  buildResultRows,
  buildBracketRows,
  buildBracketLanes,
  describeMyBracket,
  buildStandings,
  buildCourtBoard,
  describeDraw,
  byeTextOf,
  drawnTeamIds,
  buildTeamRows,
  groupedPlacementHint,
  hasAutoPlacements,
  bronzeHintOf,
} = require('./events-view.js');

/* ============================================================
 * 纯适配：DTO → 旧构建器的形状
 * ============================================================ */

/**
 * 赛事摘要 DTO → 旧构建器认识的赛事记录。
 *
 * 两处差异要抹平：
 *   · 主键 `eventId` → `_id`（构建器一律按 `_id` 编键、带队内引用）；
 *   · `pool` 不下发，由项目推出来——单打赛事看单打分池、双打看双打分池，
 *     报名名单的等级分才取对池（见 buildSignupRows）。
 *
 * `draw` 在列表摘要里不出现，只有 `drawn` 布尔量；补一个真值占位，让
 * 「是否已抽签」在列表行上仍旧成立（占位对象没有 drawCount，退化为 0）。
 *
 * @param {Object} summary eventSummary DTO
 * @returns {Object}
 */
function toLegacyEvent(summary = {}) {
  return {
    ...summary,
    _id: summary.eventId,
    pool: summary.isDoubles ? RATING_POOL.DOUBLES : RATING_POOL.SINGLES,
    draw: summary.draw !== undefined ? summary.draw : (summary.drawn ? {} : null),
  };
}

/** 比赛记录 DTO → 旧构建器认识的比赛记录（`matchId` → `_id`）。 */
function toLegacyMatches(matchDtos) {
  return asArray(matchDtos).map(dto => ({ ...dto, _id: dto.matchId }));
}

/**
 * 报名记录 DTO + 选手成绩 DTO → 会员档案表（等级分 / 积分 / 学院）。
 *
 * 构建器从这张表取昵称（签表两边的显示名）、等级分与积分（名单行的
 * `statText`）、学院（学院负责人代签的旧判据）。成绩读端带评级与积分但不含
 * 学院，名单读端反过来——两边合起来才是完整档案。
 *
 * @param {Array<Object>} statsRows getSchoolMemberStats 的 members
 * @param {Array<Object>} rosterRows listSchoolEventSignups 的 signups
 * @returns {Map<string, Object>} 会员编号 → 档案
 */
function toMemberMap(statsRows, rosterRows) {
  const map = new Map();
  for (const row of asArray(statsRows)) {
    map.set(row.userId, {
      _id: row.userId,
      nickName: row.nickName || '',
      realName: row.realName || '',
      avatarUrl: row.avatarUrl || '',
      points: Number(row.points) || 0,
      ratings: row.ratings || {},
    });
  }
  for (const row of asArray(rosterRows)) {
    const existing = map.get(row.userId);
    if (!existing) {
      // 成绩读端没给出此人（理论上不会——报名者必是本校在册会员），
      // 用名单行兜底，好过让签表上出现一个光秃秃的编号
      map.set(row.userId, {
        _id: row.userId,
        nickName: row.nickName || '',
        realName: row.realName || '',
        avatarUrl: row.avatarUrl || '',
        college: row.college || '',
        gender: row.gender || '',
        points: 0,
        ratings: {},
      });
      continue;
    }
    if (!existing.college && row.college) existing.college = row.college;
    if (!existing.gender && row.gender) existing.gender = row.gender;
  }
  return map;
}

/**
 * 由赛事摘要拼出一串「报名记录」，喂给 buildEventRow。
 *
 * 列表与详情都只拿得到**计数**与**本人的报名态**，没有逐条名单（名单是独立
 * 读端）。构建器只从这个数组读两件事：非取消条目的个数（已报几人）与本人的
 * 那一条（我报没报、签没签到）。所以这里把本人的状态放进去，其余用占位条目
 * 补足计数——占位条目的 userId 为空，不会冒充任何人。
 *
 * @param {Object} summary eventSummary DTO
 * @param {string|null} actorId
 * @returns {Array<Object>}
 */
function signupsFromSummary(summary = {}, actorId = null) {
  const count = Number(summary.signupCount) || 0;
  const mine = summary.mySignup;
  const hasMine = mine && mine.status !== null && mine.status !== undefined;
  const rows = hasMine
    ? [{ userId: actorId, status: mine.status, signTime: mine.signTime || null }]
    : [];
  let active = rows.filter(row => row.status !== SIGNUP_STATUS.CANCELED).length;
  while (active < count) {
    rows.push({ status: SIGNUP_STATUS.SIGNED });
    active += 1;
  }
  return rows;
}

/**
 * 赛事级能力：详情用 DTO 的 capabilities，置顶入口一律按 canManage 推。
 * @param {Object} dto getSchoolEvent / listSchoolEvents 的响应
 * @returns {Object}
 */
function capsForEvent(dto = {}) {
  return { ...(dto.capabilities || {}), canPin: Boolean(dto.canManage) };
}

/** 报名记录能力表：userId → { canCheckIn }。 */
function signupCapsOf(rosterRows) {
  return new Map(asArray(rosterRows).map(row => [row.userId, { canCheckIn: Boolean(row.canCheckIn) }]));
}

/** 比赛能力表：matchId → { canRecord, canConfirm, canAssignReferee }。 */
function bracketCapsOf(matchDtos) {
  return new Map(asArray(matchDtos).map(dto => [dto.matchId, {
    canRecord: Boolean(dto.canRecord),
    canConfirm: Boolean(dto.canConfirm),
    canAssignReferee: Boolean(dto.canAssignReferee),
  }]));
}

/** 报名名单里出现过的会员编号（去重）——只在这些人身上取评级与积分。 */
function memberIdsOf(rosterRows) {
  return Array.from(new Set(asArray(rosterRows).map(row => row.userId).filter(Boolean)));
}

/**
 * 已录名次里出现过的会员编号（去重）。
 *
 * 【为什么名次上的人也要取档案】
 * 名次行的姓名只能从会员档案解析（buildResultRows 查不到档案就退回显示编号）。
 * 正常路径上名次的人必是报名者，档案随名单一起来；但历史数据 / 演示种子里
 * 可能只有名次没有报名记录，那时详情页的「最终名次」就会显示成 `u03` 这样的
 * 编号——用户看到的是「名次里全是编号，不是名字」。多带这几个编号去取一次
 * 档案，名次行的姓名就不再依赖报名名单是否完整。
 *
 * @param {Object} dto getSchoolEvent 的成功响应
 * @returns {string[]}
 */
function resultUserIdsOf(dto = {}) {
  return Array.from(new Set(
    asArray(dto.event && dto.event.results).map(row => row.userId).filter(Boolean)
  ));
}

/** 本人 actorId 收敛成一个最小 actor（构建器只读它的 _id 来标「我」）。 */
const actorOf = actorId => (actorId ? { _id: actorId } : null);

/* ============================================================
 * 详情视图
 * ============================================================ */

/** 找不到赛事时的详情视图（与 loadEventDetailView 的缺省形状一致）。 */
function notFoundDetailView() {
  return {
    found: false,
    notFoundText: '这场赛事不存在或已被删除',
    eventId: '',
    event: null,
    signupRows: [],
    hasSignups: false,
    signupsEmptyNote: '',
    bracketRows: [],
    bracketLanes: [],
    myBracketText: '',
    hasBracket: false,
    standings: [],
    hasStandings: false,
    drawText: '',
    byeText: '',
    seedCandidates: [],
    manualSeedNeeded: 0,
    seedUnit: '位种子',
    resultRows: [],
    hasResults: false,
    courtBoard: [],
    hasCourts: false,
  };
}

/**
 * 装载一场赛事的详情视图（协议 2）。
 *
 * @param {Object} input
 * @param {Object} input.dto getSchoolEvent 的成功响应（含 event / capabilities）
 * @param {Array<Object>} [input.rosterRows] listSchoolEventSignups 的行
 * @param {Array<Object>} [input.matchDtos] listSchoolMatches({eventId}) 的行
 * @param {Array<Object>} [input.statsRows] getSchoolMemberStats 的行
 * @param {string|null} [input.actorId]
 * @returns {Object} 与 loadEventDetailView 同形
 */
function buildDetailView(input = {}) {
  const {
    dto = {}, rosterRows = [], matchDtos = [], statsRows = [], actorId = null,
  } = input;

  const event = toLegacyEvent(dto.event);
  const actor = actorOf(actorId);
  const caps = capsForEvent(dto);
  const ledger = toLegacyMatches(matchDtos);

  const row = buildEventRow(event, { actor, signups: signupsFromSummary(dto.event, actorId), caps });
  const memberMap = toMemberMap(statsRows, rosterRows);
  const signupRows = buildSignupRows(rosterRows, memberMap, {
    actor, event, caps: signupCapsOf(rosterRows),
  });
  const bracketRows = buildBracketRows(ledger, event, memberMap, {
    actor, isAdmin: Boolean(dto.canManage), caps: bracketCapsOf(matchDtos),
  });
  const standings = buildStandings(event, ledger, memberMap, actor);
  const resultRows = buildResultRows(event, memberMap, actor);
  const courtBoard = buildCourtBoard(event, ledger, bracketRows);

  const seedCandidates = signupRows.map(signup => ({
    userId: signup.userId,
    nickName: signup.nickName,
    avatarText: signup.avatarText,
    avatarUrl: signup.avatarUrl || '',
  }));

  return {
    found: true,
    notFoundText: '',
    // 解析后的真实编号（见 loadSchoolEventDetailView）：页面据此读写，
    // 不必自己再解一次路由 query
    eventId: (dto.event && dto.event.eventId) || '',
    event: row,
    signupNote: dto.signupNote || '',
    signupRows,
    hasSignups: signupRows.length > 0,
    signupsEmptyNote: '还没有人报名',
    bracketRows,
    bracketLanes: buildBracketLanes(bracketRows),
    myBracketText: describeMyBracket(bracketRows),
    hasBracket: bracketRows.length > 0,
    courtBoard,
    hasCourts: courtBoard.length > 0,
    standings,
    hasStandings: standings.some(group => group.rows.length > 0),
    drawText: describeDraw(event.draw),
    byeText: byeTextOf(event.draw, memberMap),
    seedCandidates,
    manualSeedNeeded: row.isDoubles
      ? manualPlayersNeeded(row.seedCount, seedCandidates.length)
      : actualSeedCount(row.seedCount, seedCandidates.length),
    seedUnit: row.isDoubles ? '位参赛者' : '位种子',
    resultRows,
    hasResults: resultRows.length > 0,
  };
}

/* ============================================================
 * 名次录入视图
 * ============================================================ */

/** 名次页的缺省形状（未放行 / 未找到时用，字段一个不少）。 */
function placementShell(overrides = {}) {
  return {
    allowed: true,
    blockedText: '',
    found: true,
    eventId: '',
    canEdit: false,
    statusNote: '',
    event: null,
    rows: [],
    hasRows: false,
    emptyNote: '',
    bronzeHint: '',
    hintText: '',
    ...overrides,
  };
}

/**
 * 装载名次录入视图（协议 2）。
 *
 * 【为什么失败关闭】
 * 名次直接换成积分，一个错字就凭空多出一位参赛者。没有管理权时一条名单都不
 * 下发，界面上就不可能冒出一个能点的录入框。与旧栈 loadEventPlacementView 同。
 *
 * @param {Object} input 同 buildDetailView
 * @returns {Object} 与 loadEventPlacementView 同形
 */
function buildPlacementView(input = {}) {
  const {
    dto = {}, rosterRows = [], matchDtos = [], statsRows = [], actorId = null,
  } = input;

  const event = toLegacyEvent(dto.event);
  const actor = actorOf(actorId);
  const caps = capsForEvent(dto);
  const ledger = toLegacyMatches(matchDtos);

  const row = buildEventRow(event, { actor, signups: signupsFromSummary(dto.event, actorId), caps });
  const memberMap = toMemberMap(statsRows, rosterRows);
  // 双打按队伍录入名次（一行两人）：队伍由签表定。没有签表时退回按人，至少不挡录入
  const teamIds = row.isDoubles ? drawnTeamIds(event.draw) : [];
  const baseRows = teamIds.length > 0
    ? buildTeamRows(teamIds, memberMap)
    : buildSignupRows(rosterRows, memberMap, { actor, event, caps: signupCapsOf(rosterRows) });
  const canEdit = Boolean(dto.capabilities && dto.capabilities.canFinish);

  let statusNote = '';
  if (!canEdit) {
    statusNote = row.isFinished
      ? '这场赛事已经结束，名次不可再改'
      : '赛事开始后才能录入名次，请先在详情页把赛事设为「进行中」';
  }

  // 循环 / 小组 / 双败的名次由赛制推得：预填进输入框，管理员在其上微调
  const derived = hasAutoPlacements(event)
    ? derivePlacements({ event, draw: event.draw, matches: ledger })
    : { ok: false, results: [], message: '' };
  const autoPlacement = new Map(
    derived.ok ? derived.results.map(item => [item.userId, item.placement]) : []
  );
  const rows = baseRows.map(item => {
    const placement = autoPlacement.get(item.userId);
    return placement === undefined ? item : { ...item, placementText: String(placement) };
  });

  return placementShell({
    allowed: true,
    found: true,
    eventId: (dto.event && dto.event.eventId) || '',
    canEdit,
    statusNote,
    event: row,
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有人报名，录入名次前先让会员报名',
    bronzeHint: bronzeHintOf(event),
    hintText: hasAutoPlacements(event) ? groupedPlacementHint(event, row, derived) : bronzeHintOf(event),
  });
}

/* ============================================================
 * 列表视图
 * ============================================================ */

/**
 * 把一条赛事摘要整形成列表行。服务端已排好序，这里不再重排。
 *
 * `canManage` 来自列表响应的顶层（列表读端不逐条下发能力），置顶入口据此渲染。
 *
 * @param {Object} summary eventSummary DTO
 * @param {Object} [ctx]
 * @param {string|null} [ctx.actorId]
 * @param {boolean} [ctx.canManage]
 * @returns {Object}
 */
function buildListRow(summary, ctx = {}) {
  const { actorId = null, canManage = false, association = '' } = ctx;
  const row = buildEventRow(toLegacyEvent(summary), {
    actor: actorOf(actorId),
    signups: signupsFromSummary(summary, actorId),
    caps: { ...capsForEvent(summary), canPin: Boolean(canManage) },
  });
  // 协会标识用于跨协会列表的文字 + 图形双重识别，不单靠主题色区分。
  const meta = isKnownAssociation(association) ? getAssociation(association) : null;
  return {
    ...row,
    association: association || '',
    associationName: meta ? meta.shortName : '',
    associationGlyph: meta ? meta.logoGlyph : '',
  };
}

/* ============================================================
 * 装载器：向协会空间要数，交给上面的纯适配
 * ============================================================ */

/**
 * 报名名单 + 比赛台账 + 选手成绩，一次取齐（详情与名次页共用）。
 *
 * 先取名单，是因为成绩读端要按报名者的编号去问——既省一次全量回放，也避免
 * 把「没报名的人」一并捞回来。名单为空时干脆不问（成绩读端的空 userIds 语义是
 * 「全体会员」，那会白拉一次全量）。
 *
 * `extraUserIds` 是名单之外还要取档案的人（目前只有「已录名次的人」，
 * 见 resultUserIdsOf）：他们可能在历史数据里没有报名记录，但名次行仍要显示姓名。
 *
 * @param {Object} api 协会空间客户端
 * @param {string} eventId
 * @param {string[]} [extraUserIds]
 */
async function loadEventParts(api, eventId, extraUserIds = []) {
  const roster = await api.listSchoolEventSignups({ eventId });
  const rosterRows = (roster && roster.ok && roster.signups) || [];
  const ids = Array.from(new Set([...memberIdsOf(rosterRows), ...asArray(extraUserIds).filter(Boolean)]));

  const [matches, stats] = await Promise.all([
    api.listSchoolMatches({ eventId }),
    ids.length > 0
      ? api.getSchoolMemberStats({ userIds: ids })
      : Promise.resolve({ ok: true, members: [] }),
  ]);
  return {
    matchDtos: (matches && matches.ok && matches.matches) || [],
    statsRows: (stats && stats.ok && stats.members) || [],
    rosterRows,
  };
}

/**
 * 装载赛事列表视图（协议 2）。
 *
 * 取数按「学校 + 协会」：内部用 space.forScope 固定范围，之后每个请求都落在
 * 这把范围上（与 announcement-view 同路数，不在异步期间再读全局当前学校）。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId] 只用于「我」的高亮，缺省当访客
 * @param {number} [options.limit] 每页条数；Infinity 表示取齐（首页旧口径）
 * @param {number} [options.offset] 分页起点
 * @param {string} [options.keyword] 名称 / 场地关键词
 * @param {string} [options.year] 四位年份
 * @param {number|number[]} [options.status] 单个或一组赛事状态
 * @returns {Promise<Object>}
 */
async function loadSchoolEventListView(options = {}) {
  const {
    schoolId, association, actorId = null, limit, offset = 0,
    keyword = '', year = '', status,
  } = options;
  const api = space.forScope({ schoolId, association });
  const filters = {};
  if (String(keyword || '').trim()) filters.keyword = String(keyword).trim();
  if (/^\d{4}$/.test(String(year || ''))) filters.year = String(year);
  if (Array.isArray(status) && status.length > 0) filters.status = status.filter(value => typeof value === 'number');
  else if (typeof status === 'number') filters.status = status;

  const pageSize = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
  let dto = await api.listSchoolEvents(limit === Infinity
    ? { ...filters, limit: 50, offset: 0 }
    : { ...filters, limit: pageSize, offset: Number.isInteger(offset) && offset > 0 ? offset : 0 });
  if (!dto || !dto.ok) throw new Error((dto && dto.message) || '赛事列表读取失败');
  const summaries = [...asArray(dto.events)];
  let cursor = 0;
  // 【取齐必须有硬上限】（2026-10-29 第十一轮审计 P2-4）
  // 服务端 `listSchoolEvents` 是「整表读 + 内存排序 + 切片」，每翻一页就重复一次
  // 全表读。原先是 `while (hasMore)` 一直翻到底，赛事一多就是把云函数往超时上推。
  // 生产路径已经没有调用方传 Infinity（赛事面板改用服务端的 totalAll），这里保留
  // 兼容但压到最多 5 页：真要用「取齐」，应当先在服务端做带条件的下推。
  let pages = 1;
  while (limit === Infinity && dto.hasMore && pages < INFINITE_FETCH_PAGES) {
    if (!(dto.nextOffset > cursor)) throw new Error('赛事列表分页没有前进');
    cursor = dto.nextOffset;
    dto = await api.listSchoolEvents({ ...filters, limit: 50, offset: cursor });
    if (!dto || !dto.ok) throw new Error((dto && dto.message) || '赛事列表读取失败');
    summaries.push(...asArray(dto.events));
    pages += 1;
  }

  const canManage = Boolean(dto && dto.canManage);
  const events = summaries.map(summary => buildListRow(summary, { actorId, canManage, association }));
  const filteredTotal = Number(dto && dto.total);
  // totalAll 是「不带状态筛选」的赛事总量（服务端在过滤前算好）：首页/面板要的是
  // 「本协会一共几场」，不能靠把列表取齐再数长度——那会按页重复整表读。
  const overallTotal = Number(dto && dto.totalAll);
  return {
    events,
    hasEvents: events.length > 0,
    eventsEmptyNote: Object.keys(filters).length > 0 ? '没有符合条件的赛事，试试清除筛选' : '还没有赛事，等管理员发布一场吧',
    eventTotal: Number.isFinite(filteredTotal) && filteredTotal >= 0 ? filteredTotal : events.length,
    eventTotalAll: Number.isFinite(overallTotal) && overallTotal >= 0 ? overallTotal : events.length,
    nextOffset: Number(dto && dto.nextOffset) || (offset + events.length),
    hasMoreEvents: Boolean(dto && dto.hasMore),
    canPublish: canManage,
    canManage,
  };
}

/**
 * 装载赛事详情视图（协议 2）。
 *
 * 【为什么把解析后的真实编号一并回传】
 * 路由 query 的值是否已解码取决于运行环境（见 utils/route-query.js）：开发者
 * 工具 / 真机原样透传，页面拿到的是 `sev%3Amuc%3Apkb%3Aspring-cup`。读路径靠
 * `resolveRouteId` 探测两种候选，但**写路径不探测**——页面拿着未解码的编号去
 * 报名 / 取消 / 开赛 / 抽签 / 代签，服务端按主键查不到，只能回「赛事不存在」
 * （2026-10-16 用户实测：点报名报「赛事不存在」）。视图模型里的 `eventId`
 * 就是探测命中的真实编号，页面采纳后所有读写与跳转都用它。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>}
 */
async function loadSchoolEventDetailView(eventId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });
  // 路由编号兼容两种环境（详见 utils/route-query.js）：先原值、再解码值
  const found = await resolveRouteId(eventId, async (id) => {
    const dto = await api.getSchoolEvent({ eventId: id });
    return dto && dto.ok ? dto : null;
  });
  if (!found.result) return notFoundDetailView();

  const parts = await loadEventParts(api, found.id, resultUserIdsOf(found.result));
  return { ...buildDetailView({ dto: found.result, actorId, ...parts }), eventId: found.id };
}

/**
 * 装载名次录入视图（协议 2）。
 *
 * 解析后的真实编号同样回传（理由见 loadSchoolEventDetailView）：名次页提交即
 * 结束赛事，写的是同一把主键，不能拿未解码的路由值去写。
 *
 * @param {string} eventId
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.association
 * @param {string|null} [options.actorId]
 * @returns {Promise<Object>}
 */
async function loadSchoolEventPlacementView(eventId, options = {}) {
  const { schoolId, association, actorId = null } = options;
  const api = space.forScope({ schoolId, association });
  // 路由编号兼容两种环境（详见 utils/route-query.js）
  const found = await resolveRouteId(eventId, async (id) => {
    const dto = await api.getSchoolEvent({ eventId: id });
    return dto && dto.ok ? dto : null;
  });

  // 读不到赛事：与旧栈同形——放行到底、只是 found 为假，页面据此显示「不存在」。
  // （放行而非挡住，是为了让「不存在」这句话由页面统一说，而不是混进权限话术。）
  if (!found.result) return placementShell({ found: false });
  const dto = found.result;
  if (!dto.canManage) {
    return placementShell({
      allowed: false,
      found: true,
      eventId: found.id,
      blockedText: actorId ? '当前账号没有录入名次的权限，请联系管理员' : '请先登录后再录入名次',
    });
  }

  const parts = await loadEventParts(api, found.id, resultUserIdsOf(dto));
  return { ...buildPlacementView({ dto, actorId, ...parts }), eventId: found.id };
}

module.exports = {
  toLegacyEvent,
  toLegacyMatches,
  toMemberMap,
  signupsFromSummary,
  capsForEvent,
  signupCapsOf,
  bracketCapsOf,
  memberIdsOf,
  resultUserIdsOf,
  notFoundDetailView,
  buildDetailView,
  buildPlacementView,
  buildListRow,
  loadSchoolEventListView,
  loadSchoolEventDetailView,
  loadSchoolEventPlacementView,
};
