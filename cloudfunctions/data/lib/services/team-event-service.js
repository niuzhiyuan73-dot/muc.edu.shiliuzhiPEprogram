/**
 * 团队运动：团队赛事与报名（C 期首片）
 * ============================================================
 * 只做「建赛 → 报名 → 审核 → 锁定名单」这一段。赛程、录分、发布在后续切片，
 * 它们都要读这里的规则快照与名单快照，先把这两份快照钉住。
 *
 * 【规则快照为什么在建赛时固化】
 * 「4 节 × 10 分钟」还是「2 × 20」、个人几犯离场，直接决定比分怎么算。
 * 开赛后再改规则，前面打过的比赛就不可比了。所以 rules 一旦建库就不再变，
 * 改规则 = 新建一场赛事。
 *
 * 【名单快照为什么在锁定那一刻拍】
 * 报名名单锁定后，队员退队、改名、换号都不该回写历史。锁定把每个人的
 * 姓名当场抄进 roster；后续退队只影响球队，不影响这场比赛由谁打。
 * ============================================================
 */

const { canManageAssociationSpace, canReadAssociationSpace } = require('./association-space-permission.js');
const { collegeMemberCandidates, resolveCollegeTeam } = require('./team-service.js');
const { createBasketballLive, applyBasketballOperation, basketballLiveView, BASKETBALL_STAT_LIMITS } = require('../utils/basketball-live.js');
const { buildDirectory } = require('./school-actor.js');
const { loadTeamProfileData, indexMatches } = require('./team-profile-data.js');
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('./school-permission.js');
const { schoolKey, schoolMemberKey, schoolMembershipKey, teamMemberKey, collegeTeamKey, PLATFORM_STATUS } = require('../utils/school.js');
const {
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS, TEAM_MATCH_STATUS,
  TEAM_EVENT_STATUS_LABEL, TEAM_ENTRY_STATUS_LABEL, TEAM_MATCH_STATUS_LABEL,
  TEAM_STATUS_LABEL, TEAM_MEMBER_STATUS_LABEL,
  TEAM_TYPE, CUP_MODE, CUP_MODE_LABEL,
  BRACKET_STAGE, EVENT_BRONZE_MODE, TEAM_STAT_INTEGRITY, TEAM_STAT_STATUS,
} = require('../utils/constants.js');
const { EVENT_FORMAT } = require('../utils/constants.js');
// 展示与年份判定统一按东八区（云函数跑在 UTC）
const { displayYearOf } = require('../utils/format.js');
const { teamSportStrategyFor } = require('../utils/team-sport-rules.js');
const { isCalendarDate } = require('./meet-time.js');
const { sportTypeOf } = require('../utils/associations.js');
const { drawBracket } = require('../utils/bracket.js');
const { roundRobinRounds } = require('../utils/standings.js');
const { createSeededRandom, shuffle } = require('../utils/random.js');
const { eventMatchKey, planNextRound } = require('./draw.js');
const { computeTeamPlacements, isFinal } = require('../utils/team-standings.js');
const football = require('./football-match-service');
const footballSchedule = require('./football-schedule-service');
const { matchMinutes: footballMatchMinutes } = require('../utils/football-report');
const { compareCode } = require('../utils/text-order.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const NAME_MAX = 30;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * 首版支持两种赛制。
 *
 * 小组赛+淘汰（GROUP_KNOCKOUT）不是「多打几场」，它要分组、组内循环、
 * 按小组名次出线再拼签表——少一层都会排出一张错的赛程。首版明确拒绝，
 * 而不是默默按单败淘汰处理（那会让人以为小组赛已经能用了）。
 */
const FORMATS = [EVENT_FORMAT.SINGLE_ELIM, EVENT_FORMAT.ROUND_ROBIN];
const SCORE_MAX = 299;

function assertTeamSport(ctx) {
  return sportTypeOf(ctx.association) === 'team';
}

function supportsMatchData(ctx, event, match) {
  const strategy = teamSportStrategyFor(ctx.association, event);
  return Boolean(strategy && strategy.supportsMatchData
    && (!match || match.sportFormat === undefined || match.sportFormat === strategy.sportFormat));
}

function inScope(doc, ctx) {
  return Boolean(doc) && doc.schoolId === ctx.schoolId && doc.association === ctx.association;
}

/* ---------------- 赛程：时间与场地 ---------------- */

/** 一场比赛的默认时长（分钟）：只有时间没有结束时间时，界面靠它推算 */
const MATCH_MINUTES = 90;
const LOCATION_MAX = 40;
/** 整轮顺延的边界：一次挪十几个小时一定是填错了，挡住比算错好 */
const SHIFT_MAX_MINUTES = 240;

/**
 * 时间归一。
 *
 * 接受 ISO 与「YYYY-MM-DD HH:mm」两种写法：前者是接口与数据库的形状，
 * 后者是管理员在输入框里真正会敲的形状。`''` / null 表示「清空时间」，
 * 返回的 `ok` 为真但 `value` 为 null——这与「格式不合法」必须分开。
 */
function toMatchTime(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const raw = String(value).trim();
  if (raw === '') return { ok: true, value: null };
  // 手填的「年月日 + 时分」先过日历日回读：`2026-02-30 10:00` 会被 Date.parse 静默进位成
  // 03-02，比赛时间白白错两天（2026-10-28 审计 2 B-2）。时分超范围 Date.parse 自己会拒。
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(raw);
  if (naive && !isCalendarDate(naive[1])) return { ok: false, value: null };
  // `YYYY-MM-DD HH:mm` 在部分运行时会被当成非法日期；补成显式带时区的 ISO
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}:00+08:00`
    : raw;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return { ok: false, value: null };
  return { ok: true, value: new Date(time).toISOString() };
}

/**
 * 展示用的开赛时间：`MM-DD HH:mm`（北京时间）。
 *
 * 不用 `formatDateTime`：那个按运行环境本地时区格式化，而云函数跑在 UTC，
 * 同一场比赛在本地看是 14:00、在线上会显示 06:00。
 */
function matchTimeText(value) {
  if (!value) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`
    + ` ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`;
}

/** 人的显示名：真名优先，没有就用昵称，再没有用编号 */
function personNameOf(user, fallbackId) {
  if (!user) return fallbackId || '';
  return user.realName || user.nickName || fallbackId || user._id || '';
}

const eventKey = (seed, ctx) => schoolKey('tev', ctx.schoolId, ctx.association, seed);
const entryKey = (eventId, teamId) => schoolKey('ten', eventId, teamId);

/** 球衣号：0–99 的整数，空表示没登记（校园赛常见「先报名，号码后补」） */
const JERSEY_MAX = 99;
function toJerseyNo(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const raw = String(value).trim();
  if (raw === '') return { ok: true, value: null };
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0 || number > JERSEY_MAX) return { ok: false, value: null };
  return { ok: true, value: number };
}

/** 某一侧已定的出场名单；空数组表示「还没定」，与「一个都不上」区分开 */
function lineupOf(match, side) {
  const lineups = (match && match.lineups) || {};
  return Array.isArray(lineups[side]) ? lineups[side] : [];
}

/** 赛事视图：布尔量与文案在服务端算好 */
function eventView(event, ctx, { manage, entryCount }) {
  const strategy = teamSportStrategyFor(ctx.association, event);
  const cupMode = event.cupMode === CUP_MODE.COLLEGE ? CUP_MODE.COLLEGE : '';
  return {
    eventId: event._id,
    name: event.name,
    format: event.format,
    status: event.status,
    statusLabel: TEAM_EVENT_STATUS_LABEL[event.status] || event.status,
    sportFormat: strategy ? strategy.sportFormat : null,
    /**
     * 石榴籽杯学院赛：只接受学院代表队报名，其余规则与同项目的普通赛事一致。
     * 它只影响「谁能报名」与页面文案，不进 rules 快照。
     */
    cupMode,
    cupModeLabel: cupMode ? CUP_MODE_LABEL[cupMode] : '',
    isCollegeCup: cupMode === CUP_MODE.COLLEGE,
    supportsLiveScore: Boolean(strategy && strategy.supportsLiveScore),
    supportsMatchData: Boolean(strategy && strategy.supportsMatchData),
    rulesText: strategy ? strategy.formatRules(event.rules, event.format) : '',
    rules: event.rules,
    draw: event.draw || null,
    bronzeMode: event.bronzeMode || EVENT_BRONZE_MODE.PLAYOFF,
    statPolicy: event.statPolicy || STAT_MODE.BASIC,
    entryCount: Number(entryCount) || 0,
    canManage: manage,
    createdAt: event.createdAt || null,
    revision: Number(event.revision) || 0,
  };
}

/**
 * 一场团队比赛的展示形状。
 *
 * 比分是**一个数字**（96:88），不是个人赛那种「逐局比分数组」。缺比分时
 * 显示 `—` 而不是 0:0——0:0 是「还没开打」，不能和「打完了 0 分」混为一谈。
 *
 * 【待审核的比分对谁可见】
 * 录完但没发布的比分随时可能被驳回重录。普通成员看到它，会把它当成正式成绩；
 * 第二天成绩变了，他会认为自己被骗了一次。所以只有管理者与参赛队队长能看到
 * 待审核的数字，其他人只看到「待审核」三个字——这一点在服务端做，不能靠
 * 页面「不渲染」来挡。
 *
 * 【revision 必须下发】
 * 录分、发布、改统计都要带版本号做乐观锁。页面拿不到版本号，就只能不带，
 * 于是并发保护形同虚设——这是 D 期的一个真实缺口，不是可选项。
 */
function matchView(match, teamName, rights = {}) {
  const nameOf = teamId => (teamName && teamName.get(teamId)) || teamId;
  const hasScore = match.scoreA !== null && match.scoreA !== undefined
    && match.scoreB !== null && match.scoreB !== undefined;
  const isPublished = match.status === TEAM_MATCH_STATUS.PUBLISHED;
  // 未发布且无权查看待审核：数字、胜方、加时、弃权一律不下发
  const masked = !isPublished && rights.canSeePending !== true;
  const showScore = hasScore && !masked;
  const strategy = teamSportStrategyFor(match.association, { sportFormat: match.sportFormat });
  const live = strategy && strategy.supportsLiveScore && match.status === TEAM_MATCH_STATUS.LIVE
    ? basketballLiveView(match.liveScore, false) : null;
  return {
    matchId: match._id,
    round: Number(match.round) || 1,
    stage: match.stage || BRACKET_STAGE.MAIN,
    slot: Number(match.slot) || 0,
    teamA: match.teamA,
    teamB: match.teamB,
    teamAName: nameOf(match.teamA),
    teamBName: nameOf(match.teamB),
    scoreA: showScore ? Number(match.scoreA) : null,
    scoreB: showScore ? Number(match.scoreB) : null,
    live,
    scoreText: live ? `${live.scoreA} : ${live.scoreB}` : showScore
      ? `${match.scoreA} : ${match.scoreB}`
      : (masked ? '待审核' : '—'),
    overtime: masked ? false : match.overtime === true,
    forfeit: masked ? null : (match.forfeit || null),
    winner: masked ? null : (match.winner || null),
    status: match.status,
    statusLabel: TEAM_MATCH_STATUS_LABEL[match.status] || match.status,
    matchTime: match.matchTime || null,
    // 展示文本在服务端算好：云函数跑在 UTC，页面拿 ISO 自己格式化会差 8 小时
    matchTimeText: matchTimeText(match.matchTime),
    location: match.location || '',
    refereeId: match.refereeId || '',
    refereeName: match.refereeName || '',
    recorderId: match.recorderId || '',
    recorderName: match.recorderName || '',
    // 两侧任一有值即视为「出场名单已定」：页面据此把按钮从「定出场」改成「改出场」
    hasLineup: lineupOf(match, 'A').length > 0 || lineupOf(match, 'B').length > 0,
    // 版本号：调用方拿它做乐观锁，对不上就要求刷新
    revision: Number(match.revision) || 0,
    // 按钮显不显示由服务端定：页面拿不到「我是不是这队的队长」，
    // 自己猜一遍迟早与接口的口径分叉
    canRecord: rights.canRecord === true,
    canPublish: rights.canPublish === true,
    canSetLineup: rights.canSetLineup === true,
    canSchedule: rights.canSchedule === true,
    canSeePending: rights.canSeePending === true,
    // 这一场的统计有未审核的新版本（只有能看到待审核内容的人才需要知道）
    statPending: rights.canSeePending === true && rights.statPending === true,
    ...(strategy && strategy.sportFormat === 'football11' ? football.footballMatchView(match, rights.canSeePending === true) : {}),
  };
}

/** 把赛事编号揉成一个稳定的随机种子：同一个赛事重抽不会拿到同一张签 */
function hashSeed(text) {
  let hash = 2166136261;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647;
}

/* ---------------- 读 ---------------- */
async function listTeamEvents(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const manage = canManageAssociationSpace(ctx);
  const repo = ctx.repo.forScope(ctx);
  if (payload.home === true) {
    const page = await repo.teamEvents.homeSummary({ limit: payload.limit });
    return ok({ ok: true, totalAll: page.totalAll, matchTotal: page.matchTotal,
      hasMore: page.hasMore, canManage: manage, message: '',
      events: page.events.map(event => ({ eventId: event._id, eventKind: 'team',
        title: event.name || '', status: event.status,
        statusLabel: TEAM_EVENT_STATUS_LABEL[event.status] || '',
        startTime: event.startTime || '', location: event.location || '',
        isSignup: event.status === TEAM_EVENT_STATUS.REGISTRATION,
        isOngoing: [TEAM_EVENT_STATUS.LOCKED, TEAM_EVENT_STATUS.SCHEDULED, TEAM_EVENT_STATUS.RUNNING].includes(event.status),
      })),
    });
  }
  // 【2026-10-26 第六轮 D】原来还在这里 buildDirectory：整个函数只用它的
  // `collegeIdOf(ctx.actorId)`，而那正是上下文里已有的 schoolMember.collegeId。
  // 为一个字段读全校名册 + 全量账号（2000 人 40 次 RPC）不划算，直接取上下文。
  const [events, entries] = await Promise.all([
    repo.teamEvents.list(), repo.teamEventEntries.list(),
  ]);
  const countByEvent = new Map();
  for (const entry of entries) {
    countByEvent.set(entry.eventId, (countByEvent.get(entry.eventId) || 0) + 1);
  }

  // 石榴籽杯页面的筛选口径：杯赛归属、关键词（名称/场地）、发起年份。
  // 与学院赛列表同口径——年份按**发起时间**归档，不按开赛时间（一场可以提前很久发布）。
  const cupMode = payload.cupMode === CUP_MODE.COLLEGE
    ? CUP_MODE.COLLEGE
    : (payload.cupMode === 'free' ? 'free' : '');
  const keyword = typeof payload.keyword === 'string' ? payload.keyword.trim().slice(0, 40).toLowerCase() : '';
  const year = Number(payload.year);
  const yearFilter = Number.isInteger(year) && year > 0 ? year : 0;

  // 「我能不能报名」：本院院队的报名处在什么状态。
  // 院队编号是确定性派生的，所以不必先把队读出来就能与报名记录比对。
  const myCollegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
  const myTeamId = myCollegeId ? collegeTeamKey(myCollegeId, ctx) : '';
  const canManageMyCollege = Boolean(myCollegeId) && canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: myCollegeId,
  });

  const rows = events
    .filter(event => event.status !== TEAM_EVENT_STATUS.DRAFT || manage)
    .filter((event) => {
      if (!cupMode) return true;
      return cupMode === CUP_MODE.COLLEGE
        ? event.cupMode === CUP_MODE.COLLEGE
        : event.cupMode !== CUP_MODE.COLLEGE;
    })
    .filter(event => !keyword || [event.name, event.location]
      .some(value => String(value || '').toLowerCase().includes(keyword)))
    .filter((event) => {
      if (!yearFilter) return true;
      // 年份按东八区判（displayYearOf），不用 getFullYear()：云函数是 UTC，
      // 跨年前后 8 小时内建的赛事会归错年，本地与云端结果不一致。
      return displayYearOf(event.createdAt) === yearFilter;
    })
    .sort((a, b) => compareCode(b.createdAt, a.createdAt))
    .map((event) => {
      const view = eventView(event, ctx, { manage, entryCount: countByEvent.get(event._id) });
      if (!view.isCollegeCup) return { ...view, canSubmit: false, myEntryStatusLabel: '' };
      const mine = myTeamId ? entries.find(row => row.eventId === event._id && row.teamId === myTeamId) : null;
      const entered = Boolean(mine) && mine.status !== TEAM_ENTRY_STATUS.REJECTED;
      return {
        ...view,
        /** 学院负责人（及以上）在报名阶段、本学院还没有有效报名时可以报名；校管可代任意学院 */
        canSubmit: (canManageMyCollege || manage)
          && event.status === TEAM_EVENT_STATUS.REGISTRATION && !entered,
        myEntryStatusLabel: mine ? (TEAM_ENTRY_STATUS_LABEL[mine.status] || '') : '',
      };
    });
  return ok({ ok: true, events: rows, canManage: manage, message: '' });
}

async function getTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  const manage = canManageAssociationSpace(ctx);
  if (event.status === TEAM_EVENT_STATUS.DRAFT && !manage) return ok(refused('赛事尚未发布'));

  const entries = await repo.teamEventEntries.listByEvent(event._id);
  const [teams, dir] = await Promise.all([repo.teams.list(), buildDirectory(ctx)]);
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  // 院队名按学院目录现拼：报名记录指向的院队即使还没落库（历史数据 / 惰性预置），
  // 也不该显示成「已归档球队」
  const collegeNameByTeamId = new Map((dir.colleges || [])
    .map(college => [collegeTeamKey(college.collegeId, ctx), college.name]));
  const collegeNameOfTeam = new Map(teams
    .filter(team => team.type === TEAM_TYPE.COLLEGE)
    .map(team => [team._id, team.college || '']));
  const rows = entries
    .filter(entry => manage || entry.status !== TEAM_ENTRY_STATUS.REJECTED)
    .map(entry => ({
      teamId: entry.teamId,
      teamName: teamName.get(entry.teamId)
        || (collegeNameByTeamId.has(entry.teamId) ? `${collegeNameByTeamId.get(entry.teamId)}代表队` : '已归档球队'),
      // 学院赛的报名单位是学院，列表按学院展示（院队名是「XX代表队」，学院名另给一个字段）
      collegeName: collegeNameByTeamId.get(entry.teamId) || collegeNameOfTeam.get(entry.teamId) || '',
      isCollegeTeam: collegeNameByTeamId.has(entry.teamId) || collegeNameOfTeam.has(entry.teamId),
      status: entry.status,
      statusLabel: TEAM_ENTRY_STATUS_LABEL[entry.status] || entry.status,
      rosterCount: (entry.roster || []).length,
      lockedAt: entry.lockedAt || null,
      placement: event.status === TEAM_EVENT_STATUS.FINISHED ? Number(entry.placement) || null : null,
    }));

  const matches = (await repo.teamMatches.listByEvent(event._id))
    .sort((a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)));
  // 积分表对所有人可见（它就是赛程的一部分），名次只认赛事上已结算的那份
  const strategy = teamSportStrategyFor(ctx.association, event);
  if (!strategy) return ok(refused('赛事运动规则与协会不符'));
  const table = strategy.computeTable({
    entries: entries
      .filter(entry => entry.status === TEAM_ENTRY_STATUS.LOCKED)
      .map(entry => ({ teamId: entry.teamId, teamName: teamName.get(entry.teamId) || entry.teamId })),
    matches, rules: event.rules, rankingDecisions: event.rankingDecisions || [],
  });

  // 哪些比赛的统计还有未审核的新版本：赛程列表上要能看见「统计待审核」，
  // 否则管理员得逐场点开才发现有人改过统计
  const statDocs = await repo.teamMatchStats.listByEvent(event._id);
  const pendingStatMatches = new Set(
    statDocs.filter(row => row.status === TEAM_STAT_STATUS.PENDING).map(row => row.matchId)
  );

  const rightsOf = match => {
    const captain = [match.teamA, match.teamB].some(
      teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
    );
    const active = ![TEAM_EVENT_STATUS.FINISHED, TEAM_EVENT_STATUS.CANCELED].includes(event.status)
      && ![TEAM_MATCH_STATUS.PUBLISHED, TEAM_MATCH_STATUS.CANCELED, TEAM_MATCH_STATUS.LIVE].includes(match.status);
    // 管理者与参赛队队长既录分也看得到自己录的待审核数字；其余人只看「待审核」
    return {
      canRecord: strategy.supportsMatchData && (manage || (strategy.sportFormat !== 'football11' && captain) || match.recorderId === ctx.actorId),
      canPublish: strategy.supportsMatchData && manage,
      canSetLineup: active && (manage || captain) && !match.footballDraft,
      canSchedule: manage && ![TEAM_EVENT_STATUS.FINISHED, TEAM_EVENT_STATUS.CANCELED].includes(event.status)
        && match.status !== TEAM_MATCH_STATUS.CANCELED
        && (strategy.sportFormat !== 'football11' || match.status === TEAM_MATCH_STATUS.SCHEDULED),
      canSeePending: manage || (strategy.sportFormat !== 'football11' && captain) || match.recorderId === ctx.actorId,
      statPending: pendingStatMatches.has(match._id),
    };
  };

  // 「我能替哪支队报名」由服务端算：队长只有自己队，管理者可以替任何队补报。
  // 已经报过（含待审核、已通过、已锁定）的队不再出现，退回的可以重报。
  const memberRows = await repo.teamMembers.list();
  const activeCount = new Map();
  memberRows
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE)
    .forEach((row) => {
      activeCount.set(row.teamId, (activeCount.get(row.teamId) || 0) + 1);
    });
  const entered = new Set(
    entries
      .filter(entry => entry.status !== TEAM_ENTRY_STATUS.REJECTED)
      .map(entry => entry.teamId)
  );
  const entryMin = Number(event.entryMin) || 5;
  const entryMax = Number(event.entryMax) || 12;
  const isCollegeCup = event.cupMode === CUP_MODE.COLLEGE;
  const submitCandidates = event.status === TEAM_EVENT_STATUS.REGISTRATION
    ? (isCollegeCup
      // 学院赛：候选由**学院目录**派生，不依赖 teams 集合里有没有这条记录
      ? collegeEntryCandidates({
        ctx, dir, activeCount, entered, entryMin,
      })
      : teams
        .filter(team => inScope(team, ctx)
          && team.status === TEAM_STATUS.ACTIVE
          && !entered.has(team._id)
          // 普通赛事只列自由球队：院队与自由球队互不串门
          && team.type !== TEAM_TYPE.COLLEGE
          && (manage || team.captainId === ctx.actorId))
        .map((team) => {
          const count = activeCount.get(team._id) || 0;
          return {
            teamId: team._id,
            name: team.name,
            isCollegeTeam: false,
            memberCount: count,
            enough: count >= entryMin,
            need: entryMin,
            metaText: `${count} / ${entryMin} 人`,
          };
        }))
    : [];

  return ok({
    ok: true,
    event: eventView(event, ctx, { manage, entryCount: entries.length }),
    entries: rows,
    submitCandidates,
    // 报名面板的三种身份三种文案（学院负责人 / 校管代报 / 普通会员）
    entryPanel: entryPanelOf({
      ctx, dir, isCollegeCup, manage, entryMin, entryMax,
    }),
    matches: matches.map(match => matchView(match, teamName, rightsOf(match))),
    table,
    placements: event.placements || [],
    message: '',
  });
}

/**
 * 学院赛的报名候选：按学院目录派生，一个学院一条。
 *
 * 【为什么不用 teams 集合】
 * 院队是「系统预置」的，落库是惰性的（见 team-service 的 ensureCollegeTeam）。
 * 早先这里遍历 teams，全新库里一条院队都没有，学院负责人打开赛事详情就是空列表——
 * 页面上没有报名按钮，直接调接口又被「球队不存在」挡回去。编号是确定性的，
 * 目录里有多少学院就该有多少候选，读写两条路径就此对齐。
 *
 * 谁能看到谁的候选：校管看全部学院（代报），学院负责人只看本院，其余人不给。
 */
function collegeEntryCandidates({ ctx, dir, activeCount, entered, entryMin }) {
  const myCollegeId = dir.collegeIdOf(ctx.actorId) || '';
  const canPickAny = canManageAssociationSpace(ctx);
  const managesOwn = Boolean(myCollegeId) && canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: myCollegeId,
  });
  const target = canPickAny
    ? (dir.colleges || [])
    : (managesOwn ? (dir.colleges || []).filter(row => row.collegeId === myCollegeId) : []);
  return target
    .map((college) => {
      const teamId = collegeTeamKey(college.collegeId, ctx);
      const count = activeCount.get(teamId) || 0;
      const isOwn = college.collegeId === myCollegeId;
      return {
        teamId,
        name: `${college.name}代表队`,
        collegeId: college.collegeId,
        collegeName: college.name,
        isCollegeTeam: true,
        memberCount: count,
        // 院队从本院会员里选人，队里现在几个人不构成门槛——报名面板里挑得齐就行
        enough: true,
        need: entryMin,
        metaText: `学院队 · 已入队 ${count} 人`,
        actionText: managesOwn && isOwn ? '为本学院报名' : `代 ${college.name} 报名`,
      };
    })
    .filter(row => !entered.has(row.teamId));
}

/**
 * 报名面板的身份文案。页面只按 mode / hint 渲染，不在模板里判权。
 *
 * `manage`（协会负责人 / 校管）看得到全部学院，是「代报」；学院负责人只报本院；
 * 其余会员看不到入口，但要说明「由本院负责人提交」，否则会以为是页面坏了。
 */
function entryPanelOf({ ctx, dir, isCollegeCup, manage, entryMin, entryMax }) {
  if (!isCollegeCup) return { mode: 'free', hint: '' };
  const myCollegeId = dir.collegeIdOf(ctx.actorId) || '';
  const managesOwn = Boolean(myCollegeId) && canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: myCollegeId,
  });
  if (manage) {
    return { mode: 'school_admin', hint: '你是校级 / 协会管理员：可代任意学院报名，报名后仍需审核。' };
  }
  if (managesOwn) {
    return {
      mode: 'college_staff',
      hint: `为本学院报名：从本院在册会员里选 ${entryMin}–${entryMax} 人，选中即入队。`,
    };
  }
  return { mode: 'member', hint: '本院报名由学院负责人提交；你也可以先在院队里等负责人挑人。' };
}

// SDK 对象字段顺序不构成版本；Date 与 ISO 字符串按相同存储语义比较。
function sameRecord(a, b) {
  const canonical = value => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** 多记录变更必须整体提交；不在事务中查询集合。名单增改同步更新赛事版本以封住新增行窗口。 */
async function commitEventChange(ctx, { event, reads = [], writes = [], nextEvent, result }) {
  const expected = new Map(reads.map(row => [JSON.stringify([row.key, row.id || row.doc._id]),
    { key: row.key, id: row.id || row.doc._id, doc: row.doc }]));
  for (const row of writes) {
    const key = JSON.stringify([row.key, row.doc._id]);
    if (!expected.has(key)) expected.set(key, { key: row.key, id: row.doc._id, doc: null });
  }
  // 身份 6 点读 + 赛事 1 点读/1 写；范围 set 的归属读复用事务快照。
  if (8 + expected.size + writes.length > 96) return refused(
    '本次处理规模超过云端单事务安全容量，请减少本次场次或参赛队数后重试', { code: 'TEAM_BATCH_LIMIT' });
  return ctx.repo.transaction(async root => {
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!canManageAssociationSpace(fresh)) return refused('当前已无赛事管理权限');
    const tx = root.forScope(fresh);
    const current = await tx.teamEvents.getById(event._id);
    if (!sameRecord(current, event)) return refused('赛事刚被改过，请刷新后重试');
    for (const row of expected.values()) {
      const actual = await tx[row.key].getById(row.id);
      if (!sameRecord(actual, row.doc)) return refused('名单或比赛刚被改过，请刷新后重试');
    }
    for (const row of writes) await tx[row.key].set(row.doc._id, row.doc);
    await tx.teamEvents.set(event._id, nextEvent);
    return { ok: true, ...result, message: '' };
  });
}

/* ---------------- 写 ---------------- */

async function createTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以创建赛事'));

  const name = String(payload.name || '').trim();
  if (name.length < 2 || name.length > NAME_MAX) return ok(refused(`赛事名称需 2–${NAME_MAX} 个字`));
  // 不支持的形式要明确说出来，不能静默降级成单败淘汰——那会让人以为
  // 「选了小组赛」的赛事真的会分组打循环。
  if (payload.format && !FORMATS.includes(payload.format)) {
    return ok(refused('首版的团队赛事只支持单败淘汰与循环赛'));
  }
  const format = FORMATS.includes(payload.format) ? payload.format : EVENT_FORMAT.SINGLE_ELIM;
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('创建请求编号无效'));
  const strategy = teamSportStrategyFor(ctx.association);
  if (!strategy || (payload.sportFormat !== undefined && payload.sportFormat !== strategy.sportFormat)) {
    return ok(refused('赛事运动规则与协会不符'));
  }
  if (payload.rules !== undefined && (!payload.rules || typeof payload.rules !== 'object' || Array.isArray(payload.rules))) {
    return ok(refused('规则配置不合法'));
  }
  if (payload.presetKey !== undefined && payload.rules && payload.rules.presetKey !== undefined
    && payload.presetKey !== payload.rules.presetKey) return ok(refused('规则预设配置不一致'));
  const rules = strategy.normalizeRules({
    presetKey: payload.presetKey === undefined ? strategy.defaultPresetKey : payload.presetKey,
    ...(payload.rules || {}),
  });
  if (!rules) return ok(refused('规则配置不合法'));

  const eventId = eventKey(`${ctx.actorId}|${token}`, ctx);
  const existing = await ctx.repo.forScope(ctx).teamEvents.getById(eventId);
  if (inScope(existing, ctx)) return ok({ ok: true, eventId, message: '' });

  const duplicate = (await ctx.repo.forScope(ctx).teamEvents.list())
    .some(event => inScope(event, ctx) && event.name === name && event.status !== TEAM_EVENT_STATUS.CANCELED);
  if (duplicate) return ok(refused('同协会已有同名赛事'));

  // 季军赛默认要打：并列季军只适合「不发奖牌、只记名次」的场合，
  // 校园赛要发第三名，不给一场比赛就永远只能按净胜分排
  const bronzeMode = payload.bronzeMode === EVENT_BRONZE_MODE.TIED
    ? EVENT_BRONZE_MODE.TIED
    : EVENT_BRONZE_MODE.PLAYOFF;
  // 统计口径：默认只记总分与个人得分/犯规；有专职记录员的赛事才开按节统计
  const statPolicy = payload.statPolicy === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC;
  // 杯赛归属：只有石榴籽杯学院赛带这个标记。它不改变任何比赛规则，
  // 只决定「只接受学院代表队报名」与页面文案。
  const cupMode = payload.cupMode === CUP_MODE.COLLEGE ? CUP_MODE.COLLEGE : '';

  // 【权限与幂等都要在事务内再判一次】（2026-10-26 只读审查 P2-5）
  // 入口鉴权之后还要读规则、查重名、算主键，中间隔着好几次异步读；原先写完
  // 就直接落库，仓储内部的事务也只校验记录归属、不重判操作者。于是「查重名的
  // 那一刻被撤掉协会负责人」这类情况，请求仍然会把赛事建出来。
  // 现在把最终写入放进业务事务：重读身份、重读赛事主键（并发同请求幂等返回，
  // 不覆盖先写的那条），再落库。
  const created = await ctx.repo.transaction(async (root) => {
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!canManageAssociationSpace(fresh)) return refused('当前已无赛事管理权限');
    const tx = root.forScope(fresh);
    const current = await tx.teamEvents.getById(eventId);
    if (inScope(current, fresh)) return { ok: true, eventId, message: '' };
    const at = fresh.now;
    await tx.teamEvents.set(eventId, {
      _id: eventId, schoolId: fresh.schoolId, association: fresh.association,
      name, format, rules, sportFormat: strategy.sportFormat, bronzeMode, statPolicy, status: TEAM_EVENT_STATUS.REGISTRATION,
      cupMode,
      entryMin: rules.eventRosterMin === undefined ? rules.rosterMin : rules.eventRosterMin,
      entryMax: rules.eventRosterMax === undefined ? rules.rosterMax : rules.eventRosterMax,
      // 赛程的时间与地点在建赛时给一次，之后每场可单独改
      startTime: String(payload.startTime || '') || null,
      location: String(payload.location || '').trim(),
      revision: 1, requestId: token, createdBy: fresh.actorId, createdAt: at, updatedAt: at,
    });
    return { ok: true, eventId, message: '' };
  });
  return ok(created);
}

/**
 * 把报名名单里的人落进院队 —— 「负责人选了就算入队」。
 *
 * 已在队的跳过；不是本学院在册会员的拒绝（报名前已校验过一次，这里是并发兜底）。
 * 单独一个事务：先写后读在云开发事务里不允许，主事务里那句「名单必须在队」要在
 * 这一步完成之后才成立。
 */
async function ensureCollegeRosterMembers(ctx, team, roster) {
  const allowed = new Set((await collegeMemberCandidates(ctx, team.collegeId)).map(row => row.userId));
  if (roster.some(row => !allowed.has(row.userId))) {
    return { ok: false, message: '名单里有人不是本学院的在册会员' };
  }
  return ctx.repo.transaction(async (root) => {
    const fresh = await freshContext(root, ctx);
    const tx = root.forScope(fresh);
    const current = await tx.teams.getById(team._id);
    if (!current || current.type !== TEAM_TYPE.COLLEGE) return { ok: false, message: '学院代表队不存在' };
    let added = 0;
    for (const row of roster) {
      const key = teamMemberKey(team._id, row.userId);
      const member = await tx.teamMembers.getById(key);
      if (member && member.status === TEAM_MEMBER_STATUS.ACTIVE) continue;
      await tx.teamMembers.set(key, {
        ...(member || {}),
        _id: key, schoolId: fresh.schoolId, association: fresh.association,
        teamId: team._id, userId: row.userId, role: 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE, source: 'picked',
        joinedAt: fresh.now, leftAt: null, updatedAt: fresh.now,
      });
      added += 1;
    }
    if (added > 0) {
      await tx.teams.set(team._id, {
        ...current, memberCount: (Number(current.memberCount) || 0) + added, updatedAt: fresh.now,
      });
    }
    return { ok: true, added };
  });
}

/** 队长为本队报名：名单取当前在队成员，报名后待审核 */
async function submitTeamEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status !== TEAM_EVENT_STATUS.REGISTRATION) return ok(refused('赛事当前不开放报名'));
  const strategy = teamSportStrategyFor(ctx.association, event);
  if (!strategy) return ok(refused('赛事运动规则与协会不符'));
  const football = strategy.sportFormat === 'football11';
  if (football && !strategy.normalizeRules(event.rules)) return ok(refused('足球规则配置不合法'));
  if (football && payload.roster !== undefined && !Array.isArray(payload.roster)) return ok(refused('报名名单格式不合法'));

  // 学院赛与院队是绑定的：学院赛只收院队，院队也只打学院赛。
  // 前者防止「随便一支队代表学院」，后者防止院队被当成万能队报进普通赛事。
  const isCollegeCup = event.cupMode === CUP_MODE.COLLEGE;

  let team = await repo.teams.getById(payload.teamId);
  // 院队是惰性预置的：全新库里还没有这条记录。编号本身就是「它该存在」的凭证，
  // 所以先按学院目录反查、就地补建，再走后面的存在性与资格判定。
  // 不做这一步的话，新环境的第一场学院赛谁都报不上名（候选列表空、直接调被拒）。
  if (isCollegeCup && (!inScope(team, ctx) || team.status !== TEAM_STATUS.ACTIVE)) {
    const resolved = await resolveCollegeTeam(payload.teamId, ctx);
    if (resolved.ok) team = resolved.team;
  }
  if (!inScope(team, ctx) || team.status !== TEAM_STATUS.ACTIVE) return ok(refused('球队不存在或未通过审核'));

  const isCollegeTeam = team.type === TEAM_TYPE.COLLEGE;
  if (isCollegeCup && !isCollegeTeam) return ok(refused('石榴籽杯学院赛只接受学院代表队报名'));
  if (!isCollegeCup && isCollegeTeam) return ok(refused('学院代表队只参加石榴籽杯学院赛'));

  // 院队没有队长，报名权挂在「本学院负责人」上（与学院赛交名单同一把尺子）
  const managesThisCollege = isCollegeTeam && canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: team.collegeId,
  });
  if (team.captainId !== ctx.actorId && !canManageAssociationSpace(ctx) && !managesThisCollege) {
    return ok(refused(isCollegeCup ? '只有本学院负责人可以为本院报名' : '只有队长可以为本队报名'));
  }

  // 按队下推，不再读全协会队员再过滤（2026-10-29 第十一轮审计 P3）
  const members = (await repo.teamMembers.listByTeams([team._id]))
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE);
  const entryMin = Number(event.entryMin) || 5;
  const entryMax = Number(event.entryMax) || 12;

  // 报名可以只带一部分队员：全队都报满再上场，替补席会挂着一堆不上场的人。
  // 不传 roster 时保持旧口径（全队在队成员），老调用方与演示数据不受影响。
  const memberIds = new Set(members.map(row => row.userId));
  const incoming = Array.isArray(payload.roster)
    ? payload.roster.map((row) => {
      if (typeof row === 'string') return { userId: row.trim(), no: undefined };
      return {
        userId: String((row && row.userId) || '').trim(),
        no: row ? row.no : undefined,
      };
    }).filter(row => row.userId)
    : null;

  if (incoming) {
    const seen = new Set();
    for (const row of incoming) {
      // 院队例外：报名面板就是负责人挑人的地方，名单里的人由这一步自动进队
      if (!isCollegeTeam && !memberIds.has(row.userId)) return ok(refused('名单里有人不在本队，先处理入队再报名'));
      if (seen.has(row.userId)) return ok(refused('名单里有重复的队员'));
      seen.add(row.userId);
    }
  }
  const chosen = incoming || members.map(row => ({ userId: row.userId, no: null }));
  if (football && incoming && incoming.length !== payload.roster.length) return ok(refused('报名名单里有空白或无效队员'));
  if (chosen.length < entryMin) {
    return ok(refused(`报名至少需要 ${entryMin} 人，当前选了 ${chosen.length} 人`));
  }
  if (chosen.length > entryMax) {
    return ok(refused(`报名最多 ${entryMax} 人，当前选了 ${chosen.length} 人`));
  }

  const now = ctx.now;
  const key = entryKey(event._id, team._id);
  const previous = await repo.teamEventEntries.getById(key);
  if (previous && previous.status === TEAM_ENTRY_STATUS.LOCKED) return ok(refused('名单已锁定，不能再改'));

  const dir = await buildDirectory(ctx);
  const nameOf = userId => {
    const user = (dir.members || []).find(item => item._id === userId);
    return (user && (user.realName || user.nickName)) || userId;
  };

  // 球衣号：0–99，空表示没登记；同一支队内不许重号
  const numbers = new Set();
  const roster = [];
  for (const row of chosen) {
    const parsed = toJerseyNo(row.no);
    if (!parsed.ok) return ok(refused('球衣号码需为 0–99 的整数'));
    if (parsed.value !== null) {
      if (numbers.has(parsed.value)) return ok(refused(`球衣号码 ${parsed.value} 重复了`));
      numbers.add(parsed.value);
    }
    roster.push({ userId: row.userId, name: nameOf(row.userId), no: parsed.value });
  }

  // 名额与球衣号都过了之后，院队还要把「被选中的人」落进队里：
  // 规则是「负责人选了就算入队」，报名面板正是他挑人的地方。
  // 这一步单独一个事务（先写后读云开发事务不允许），主事务里的「名单必须在队」校验才成立。
  if (isCollegeTeam) {
    const ensured = await ensureCollegeRosterMembers(ctx, team, roster);
    if (!ensured.ok) return ok(ensured);
  }

  // 已通过审核的报名被改动后要重新走一遍审核：内容变了，原来的签字就不算数了
  const resubmitted = Boolean(previous && previous.status === TEAM_ENTRY_STATUS.APPROVED);
  const nextEntry = {
    _id: key, schoolId: ctx.schoolId, association: ctx.association,
    eventId: event._id, teamId: team._id,
    status: TEAM_ENTRY_STATUS.SUBMITTED,
    roster,
    submittedBy: ctx.actorId, submittedAt: now, updatedAt: now,
    lockedAt: null,
    ...(resubmitted ? { reviewedBy: null, reviewedAt: null } : {}),
  };
  // 所有有效报名变动都会递增赛事版本；事务内比较完整快照，封住查询后的新增行窗口。
  if (football) {
    const chosenIds = new Set(roster.map(row => row.userId));
    const occupied = (await repo.teamEventEntries.listByEvent(event._id)).find(entry =>
      entry.teamId !== team._id
      && [TEAM_ENTRY_STATUS.SUBMITTED, TEAM_ENTRY_STATUS.APPROVED, TEAM_ENTRY_STATUS.LOCKED].includes(entry.status)
      && (entry.roster || []).some(row => chosenIds.has(row.userId)));
    if (occupied) return ok(refused('名单中有球员已代表本届赛事的其他球队报名，请调整名单'));
  }
  const submitted = await ctx.repo.transaction(async root => {
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    const tx = root.forScope(fresh);
    const currentEvent = await tx.teamEvents.getById(event._id);
    const currentTeam = await tx.teams.getById(team._id);
    const currentEntry = await tx.teamEventEntries.getById(key);
    if (!currentEvent || currentEvent.status !== TEAM_EVENT_STATUS.REGISTRATION) return refused('赛事当前不开放报名');
    if (football && !sameRecord(currentEvent, event)) return refused('赛事或报名刚被改过，请刷新后重试');
    if (!currentTeam || currentTeam.status !== TEAM_STATUS.ACTIVE
      || (currentTeam.captainId !== fresh.actorId && !canManageAssociationSpace(fresh)
        && !(currentTeam.type === TEAM_TYPE.COLLEGE && canSchoolAction(fresh, 'manageCollege', {
          schoolId: fresh.schoolId, association: fresh.association, collegeId: currentTeam.collegeId,
        })))) return refused('当前无报名权限');
    if (currentEntry && currentEntry.status === TEAM_ENTRY_STATUS.LOCKED) return refused('名单已锁定，不能再改');
    // 不能把刚退队的人从事务外的名单重新写入。
    for (const row of roster) {
      const member = await tx.teamMembers.getById(teamMemberKey(team._id, row.userId));
      if (!member || member.status !== TEAM_MEMBER_STATUS.ACTIVE) return refused('名单里有人已不在本队，请刷新后重试');
      if (football) {
        const user = await root.users.getById(row.userId);
        const schoolMember = await root.schoolMembers.getById(schoolMemberKey(row.userId, fresh.schoolId));
        if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== fresh.schoolId
          || !schoolMember || schoolMember.userId !== row.userId || schoolMember.schoolId !== fresh.schoolId
          || schoolMember.status !== 'active') return refused('名单中有球员的本校在册身份已失效，请调整名单');
      }
    }
    await tx.teamEventEntries.set(key, nextEntry);
    await tx.teamEvents.set(event._id, { ...currentEvent,
      revision: (Number(currentEvent.revision) || 0) + 1, updatedAt: fresh.now });
    return { ok: true, eventId: event._id, teamId: team._id, status: TEAM_ENTRY_STATUS.SUBMITTED,
      rosterCount: roster.length, resubmitted, message: '' };
  });
  return ok(submitted);
}

/**
 * 报名选人面板：本队可报名的人 + 已选与已填的号码。
 *
 * 为什么要一个读接口，而不是让页面拿球队成员自己拼：可报名的人只算「在队」的，
 * 而「队里现在有谁」与「报名名单上有谁」是两份数据——页面拼两遍迟早会把
 * 退队的人又塞回名单里。
 */
async function getTeamEntryRoster(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  let team = await repo.teams.getById(payload.teamId);
  // 学院赛的候选是按学院目录派生的，院队此时可能还没落库（见 ensureCollegeTeam）：
  // 「代 X 学院报名」点进来要能开名单面板，所以这里同样就地补建。
  if (event.cupMode === CUP_MODE.COLLEGE && (!inScope(team, ctx) || team.status !== TEAM_STATUS.ACTIVE)) {
    const resolved = await resolveCollegeTeam(payload.teamId, ctx);
    if (resolved.ok) team = resolved.team;
  }
  if (!inScope(team, ctx)) return ok(refused('球队不存在，或不在本协会'));

  const manage = canManageAssociationSpace(ctx);
  const isCollegeTeamHere = team.type === TEAM_TYPE.COLLEGE;
  const managesThisCollege = isCollegeTeamHere && canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: team.collegeId,
  });
  if (team.captainId !== ctx.actorId && !manage && !managesThisCollege) {
    return ok(refused(isCollegeTeamHere
      ? '只有本学院负责人可以编辑报名名单'
      : '只有队长或协会负责人可以编辑报名名单'));
  }

  const activeRows = (await repo.teamMembers.listByTeams([team._id]))
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE);
  const dir = await buildDirectory(ctx);
  // 姓名表改 Map：原先每人一次 find，名单一长就是 O(n²)
  const nameById = new Map((dir.members || []).map(item => [item._id, item]));
  const nameOf = (userId) => {
    const user = nameById.get(userId);
    return (user && (user.realName || user.nickName)) || userId;
  };

  // 院队的候选池是「本学院在该协会的在册会员」，不只是已经进队的人：
  // 学院赛报名正是负责人挑人的地方，选了就算入队（见 submitTeamEntry）。
  const inTeam = new Set(activeRows.map(row => row.userId));
  const candidates = isCollegeTeamHere
    ? (await collegeMemberCandidates(ctx, team.collegeId))
      .map(row => ({ userId: row.userId, name: row.name, inTeam: inTeam.has(row.userId) }))
    : activeRows.map(row => ({ userId: row.userId, name: nameOf(row.userId), inTeam: true }));

  const entry = await repo.teamEventEntries.getById(entryKey(event._id, team._id));
  const saved = new Map(((entry && entry.roster) || []).map(row => [row.userId, row.no]));
  const hasSnapshot = saved.size > 0;

  return ok({
    ok: true,
    event: {
      eventId: event._id,
      name: event.name,
      entryMin: Number(event.entryMin) || 5,
      entryMax: Number(event.entryMax) || 12,
      status: event.status,
      isCollegeCup: event.cupMode === CUP_MODE.COLLEGE,
    },
    team: {
      teamId: team._id, name: team.name, captainId: team.captainId,
      isCollegeTeam: isCollegeTeamHere,
      collegeId: team.collegeId || '',
      collegeName: dir.collegeNameById(team.collegeId) || '',
    },
    members: candidates.map(row => ({
      userId: row.userId,
      name: row.name,
      /** 已在院队：报名面板上标一下，让负责人知道谁本来就属于这支队伍 */
      inTeam: row.inTeam,
      // 已有名单就按名单回填勾选与号码；没有名单时院队只默认勾已在队的人，
      // 不把全院会员一次全报上去
      no: hasSnapshot && saved.has(row.userId) && Number.isInteger(saved.get(row.userId))
        ? saved.get(row.userId)
        : null,
      selected: hasSnapshot ? saved.has(row.userId) : row.inTeam,
    })),
    status: entry ? entry.status : null,
    canEdit: (team.captainId === ctx.actorId || manage || managesThisCollege)
      && event.status === TEAM_EVENT_STATUS.REGISTRATION
      && (!entry || entry.status !== TEAM_ENTRY_STATUS.LOCKED),
    message: '',
  });
}

/** 审核报名（协会负责人） */
async function reviewTeamEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以审核报名'));

  const key = entryKey(payload.eventId, payload.teamId);
  return ok(await ctx.repo.transaction(async root => {
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!canManageAssociationSpace(fresh)) return refused('当前已无赛事管理权限');
    const tx = root.forScope(fresh);
    const event = await tx.teamEvents.getById(payload.eventId);
    const entry = await tx.teamEventEntries.getById(key);
    if (!event || event.status !== TEAM_EVENT_STATUS.REGISTRATION) return refused('赛事已锁定或不在报名阶段');
    if (!entry) return refused('找不到这条报名');
    if (entry.status === TEAM_ENTRY_STATUS.LOCKED) return refused('名单已锁定，不能再改');
    const status = payload.approve === true ? TEAM_ENTRY_STATUS.APPROVED : TEAM_ENTRY_STATUS.REJECTED;
    await tx.teamEventEntries.set(key, { ...entry, status, reviewedBy: fresh.actorId,
      reviewedAt: fresh.now, updatedAt: fresh.now });
    await tx.teamEvents.set(event._id, { ...event, revision: (Number(event.revision) || 0) + 1, updatedAt: fresh.now });
    return { ok: true, status, message: '' };
  }));
}

/**
 * 锁定报名名单：已是「已通过」的报名一律转「已锁定」，并把 roster 定稿。
 * 锁定后球队再换人也不影响这一场——历史成绩按快照认人。
 */
async function lockTeamEntries(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以锁定名单'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (![TEAM_EVENT_STATUS.REGISTRATION, TEAM_EVENT_STATUS.LOCKED].includes(event.status)) {
    return ok(refused('只有在报名阶段可以锁定名单'));
  }
  const entries = (await repo.teamEventEntries.listByEvent(event._id)).filter(entry =>
    [TEAM_ENTRY_STATUS.APPROVED, TEAM_ENTRY_STATUS.LOCKED].includes(entry.status));
  if (entries.some(entry => (entry.roster || []).length < (Number(event.entryMin) || 5))) {
    return ok(refused('有球队名单人数不足，先补齐再锁定'));
  }
  const writes = entries.filter(entry => entry.status !== TEAM_ENTRY_STATUS.LOCKED).map(entry => ({
    key: 'teamEventEntries', doc: { ...entry, status: TEAM_ENTRY_STATUS.LOCKED, lockedAt: ctx.now, updatedAt: ctx.now },
  }));
  return ok(await commitEventChange(ctx, { event,
    reads: entries.map(doc => ({ key: 'teamEventEntries', doc })), writes,
    nextEvent: { ...event, status: TEAM_EVENT_STATUS.LOCKED, lockedCount: entries.length,
      revision: (Number(event.revision) || 0) + 1, updatedAt: ctx.now }, result: { locked: entries.length } }));
}

/* ---------------- 单场出场名单 ---------------- */

/**
 * 单场出场名单：从报名快照里勾「这一场真正上的人」。
 *
 * 【为什么报名与出场要分开】
 * 报名是「这一届能上的 5–12 人」，出场是「这一场上了谁」。校园赛里两者经常
 * 不一样：有人临时没来、有人只能打半场、有人毕业了但名字还在报名表上。
 * 录分台按出场名单列格子，未上场的人就不会挂着一排 0 分——那比不显示更糟，
 * 它会被当真。
 *
 * 【默认全选】
 * 没定过出场名单时，所有报名队员都算「已上场」：绝大多数场次就是全队轮换，
 * 让人先取消一遍再保存，是把简单的事做复杂。
 */
async function getTeamMatchLineup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (!supportsMatchData(ctx, event, match)) return ok(refused('赛事运动规则与协会不符，或统计功能尚未开放'));

  const teams = await repo.teams.list();
  const teamById = new Map(teams.map(team => [team._id, team]));
  const manage = canManageAssociationSpace(ctx);
  const captainOfMatch = [match.teamA, match.teamB].some(
    teamId => (teamById.get(teamId) || {}).captainId === ctx.actorId
  );
  // 出场名单里带着待审核比分（matchView 的可见性分层），只开给当事两队与管理者
  if (!manage && !captainOfMatch) return ok(refused('只有参赛队队长或协会负责人可以查看出场名单'));
  // 已发布的比赛名册已定稿：这时再改出场，等于改一份对外公布过的成绩
  const canChange = match.status !== TEAM_MATCH_STATUS.PUBLISHED
    && match.status !== TEAM_MATCH_STATUS.CANCELED
    && event.status !== TEAM_EVENT_STATUS.FINISHED
    && event.status !== TEAM_EVENT_STATUS.CANCELED;

  const sides = [];
  for (const side of ['A', 'B']) {
    const teamId = side === 'A' ? match.teamA : match.teamB;
    const team = teamById.get(teamId) || {};
    const entry = await repo.teamEventEntries.getById(entryKey(event._id, teamId));
    const roster = (entry && entry.roster) || [];
    const saved = lineupOf(match, side);
    sides.push({
      side,
      teamId,
      teamName: team.name || '已归档球队',
      players: roster.map(row => ({
        userId: row.userId,
        name: row.name || row.userId,
        no: Number.isInteger(row.no) ? row.no : null,
        checked: saved.length > 0 ? saved.includes(row.userId) : true,
      })),
      savedCount: saved.length,
      editable: canChange && (manage || team.captainId === ctx.actorId),
    });
  }

  return ok({
    ok: true,
    match: matchView(match, new Map(teams.map(team => [team._id, team.name])), {
      canRecord: manage || captainOfMatch, canPublish: manage, canSeePending: true,
    }),
    revision: Number(match.revision) || 0,
    // 规则快照里的「场上不足 N 人判负」：出场名单低于它就等于自己判负
    minOnCourt: Number(event.rules && event.rules.minOnCourt) || 2,
    sides,
    canManage: manage,
    message: '',
  });
}

/**
 * 定这一场的出场名单。
 *
 * 【为什么按「侧」保存】
 * 队长只能定自己那一侧，管理员可以替两侧定。一次提交一侧，既贴合权限，
 * 也让两侧的提交互不覆盖——两个人同时排阵不会互相把对方的选择冲掉。
 */
async function saveTeamMatchLineup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const side = payload.side === 'B' ? 'B' : (payload.side === 'A' ? 'A' : '');
  if (!side) return ok(refused('缺少出场方（A / B）'));
  const players = Array.isArray(payload.players)
    ? payload.players.map(userId => String(userId || '').trim()).filter(Boolean)
    : null;
  if (!players) return ok(refused('缺少出场名单'));

  const teamName = new Map(
    (await ctx.repo.forScope(ctx).teams.list()).map(team => [team._id, team.name])
  );

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!assertTeamSport(fresh)) return refused('该协会不是团队项目');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');
    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx)) return refused('赛事不存在，或不在本协会');
    if (!supportsMatchData(fresh, event, match)) return refused('赛事运动规则与协会不符，或录分功能尚未开放');
    if (event.status === TEAM_EVENT_STATUS.FINISHED) return refused('赛事已结束，出场名单不能再改');
    if (event.status === TEAM_EVENT_STATUS.CANCELED) return refused('赛事已取消');
    if (match.status === TEAM_MATCH_STATUS.PUBLISHED) return refused('这场已发布，出场名单不能再改');
    if (match.status === TEAM_MATCH_STATUS.CANCELED) return refused('这场已取消');

    if (Number.isInteger(payload.expectRevision)
      && payload.expectRevision !== (Number(match.revision) || 0)) {
      return refused('这场比赛刚被改过，请刷新后重试');
    }

    const teamId = side === 'A' ? match.teamA : match.teamB;
    const team = await tx.teams.getById(teamId);
    if (!inScope(team, ctx)) return refused('球队不存在，或不在本协会');
    if (!canManageAssociationSpace(fresh) && team.captainId !== fresh.actorId) {
      return refused('只能定自己队的出场名单');
    }

    const entry = await tx.teamEventEntries.getById(entryKey(event._id, teamId));
    const roster = ((entry && entry.roster) || []).slice();
    if (roster.length === 0) return refused('这支队还没有锁定报名名单');
    const rosterIds = new Set(roster.map(row => row.userId));

    const seen = new Set();
    for (const userId of players) {
      if (!rosterIds.has(userId)) return refused('出场名单里有人不在报名名单中');
      if (seen.has(userId)) return refused('出场名单里有重复的队员');
      seen.add(userId);
    }

    const minOnCourt = Number(event.rules && event.rules.minOnCourt) || 2;
    if (players.length < minOnCourt) {
      return refused(`出场名单至少 ${minOnCourt} 人（场上不足 ${minOnCourt} 人判负）`);
    }
    if (players.length > roster.length) return refused('出场人数超过报名名单');
    if (match.status === TEAM_MATCH_STATUS.LIVE && match.liveScore
      && (match.liveScore.playerRows || []).some(row => row.side === side && !players.includes(row.userId)
        && Object.keys(BASKETBALL_STAT_LIMITS).some(field => Number.isInteger(row[field])))) {
      return refused('已有实时统计的球员不能移出出场名单，请先核对或撤销相关统计');
    }
    if (match.status === TEAM_MATCH_STATUS.LIVE && match.liveScore) {
      return refused('实时计分已开始，出场名单已固定；请在计分台使用换人');
    }

    const nextRevision = (Number(match.revision) || 1) + 1;
    const lineups = { ...(match.lineups || {}), [side]: players };
    const next = {
      ...match, lineups, revision: nextRevision, updatedAt: fresh.now,
    };
    await tx.teamMatches.set(match._id, next);

    return {
      ok: true,
      side,
      lineup: players,
      revision: nextRevision,
      match: matchView(next, teamName, {
        canRecord: true, canPublish: canManageAssociationSpace(fresh), canSeePending: true,
      }),
      message: '',
    };
  });
  return ok(result);
}

/* ---------------- 抽签与赛程 ---------------- */

/** 一场待打的比赛。比分留空 = 还没打，与「打了 0 分」区分开 */
function matchDocOf({ event, ctx, round, stage, slot, teamA, teamB, now }) {
  const strategy = teamSportStrategyFor(ctx.association, event);
  return {
    _id: eventMatchKey(event._id, round, stage, slot),
    schoolId: ctx.schoolId,
    association: ctx.association,
    eventId: event._id,
    sportFormat: strategy ? strategy.sportFormat : null,
    round,
    stage,
    slot,
    teamA,
    teamB,
    scoreA: null,
    scoreB: null,
    overtime: false,
    forfeit: null,
    winner: null,
    status: TEAM_MATCH_STATUS.SCHEDULED,
    matchTime: strategy && strategy.sportFormat === 'football11' ? null : event.startTime || null,
    ...(strategy && strategy.sportFormat === 'football11' ? { rules: event.rules,
      durationMinutes: footballMatchMinutes(event.rules, event.format) } : {}),
    location: event.location || '',
    recordedBy: null,
    recordedAt: null,
    publishedBy: null,
    publishedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 抽签：把已锁定的球队摆进签表，并生成首轮（循环赛则生成全部轮次）。
 *
 * 【为什么可以重抽】
 * 种子排错、有队退赛都发生在开打之前。只要还没有任何一场录过分，
 * 重抽是安全的；一旦有了比分，重抽等于把已经打过的比赛从赛程里抹掉，
 * 所以这里直接拒绝。
 *
 * 【种子从哪来】
 * 由「赛事编号 + 当前版本号」揉成，存进 `draw.seed`。同样的种子重跑一次
 * 得到同一张签，事后能复核；重抽时版本号变了，签也就变了。
 */
async function drawTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以抽签'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  // 报名阶段还没锁定名单，抽签无从谈起；已开打的赛事交给下面的
  // 「已有比分」判定给出一句更准确的话
  if (event.status === TEAM_EVENT_STATUS.DRAFT || event.status === TEAM_EVENT_STATUS.REGISTRATION) {
    return ok(refused('请先锁定报名名单再抽签'));
  }
  if (event.status === TEAM_EVENT_STATUS.FINISHED || event.status === TEAM_EVENT_STATUS.CANCELED) {
    return ok(refused('赛事已结束，不能再抽签'));
  }

  const entries = (await repo.teamEventEntries.listByEvent(event._id))
    .filter(entry => entry.status === TEAM_ENTRY_STATUS.LOCKED)
    .sort((a, b) => compareCode(a.teamId, b.teamId));
  if (entries.length < 2) return ok(refused('至少 2 支球队才能抽签'));

  const existingMatches = await repo.teamMatches.listByEvent(event._id);
  if (football.isFootball(ctx) && existingMatches.length) return ok(refused('足球赛程已经生成；首版不重抽，请核对现有签表或重建赛事'));
  if (existingMatches.some(match => match.status === TEAM_MATCH_STATUS.LIVE || match.liveScore
    || match.footballDraft || match.footballPublished || match.footballLineups
    || (match.scoreA !== null && match.scoreA !== undefined))) return ok(refused('已经有比赛开台或录了分，不能再重抽'));

  const teamIds = entries.map(entry => entry.teamId);
  const seeds = Array.isArray(payload.seedTeamIds) ? payload.seedTeamIds.filter(Boolean) : [];
  if (new Set(seeds).size !== seeds.length) return ok(refused('种子名单里有重复的球队'));
  if (seeds.some(teamId => !teamIds.includes(teamId))) return ok(refused('种子必须是已锁定的参赛球队'));
  if (seeds.length > teamIds.length) return ok(refused('种子数不能超过参赛队数'));

  const revision = Number(event.revision || 1);
  const seed = Number.isInteger(payload.seed) ? payload.seed : hashSeed(`${event._id}#${revision}`);
  const random = createSeededRandom(seed);
  const now = ctx.now;

  let draw;
  let rounds;
  if (event.format === EVENT_FORMAT.ROUND_ROBIN) {
    // 种子按顺序占前排，其余洗牌：强弱均匀分摊到各轮
    const rest = shuffle(random, teamIds.filter(teamId => !seeds.includes(teamId)));
    const ordered = seeds.concat(rest);
    const schedule = roundRobinRounds(ordered);
    rounds = schedule.map((pairs, index) => ({
      round: index + 1, stage: BRACKET_STAGE.GROUP, pairs,
    }));
    draw = {
      format: event.format, size: ordered.length, slots: ordered,
      byes: [], seeds: seeds.slice(), seed, roundCount: schedule.length, drawnAt: now,
    };
  } else {
    const plan = drawBracket({ entries: teamIds, seeds, random });
    if (!plan.ok) return ok(refused(plan.firstError || '抽签失败'));
    rounds = [{ round: 1, stage: BRACKET_STAGE.MAIN, pairs: plan.pairs }];
    draw = {
      format: event.format, size: plan.size, slots: plan.slots,
      byes: plan.byes, seeds: plan.seeds, seed, roundCount: 1, drawnAt: now,
    };
  }

  // 轮空（一方为空）不产生比赛，直接晋级
  const writes = [];
  for (const item of rounds) {
    for (let slot = 0; slot < item.pairs.length; slot += 1) {
      const [a, b] = item.pairs[slot] || [];
      if (!a || !b) continue;
      const doc = matchDocOf({
        event, ctx, round: item.round, stage: item.stage, slot, teamA: a, teamB: b, now,
      });
      writes.push({ key: 'teamMatches', doc });
    }
  }

  return ok(await commitEventChange(ctx, { event,
    reads: [...entries.map(doc => ({ key: 'teamEventEntries', doc })),
      ...existingMatches.map(doc => ({ key: 'teamMatches', doc }))], writes,
    nextEvent: { ...event, draw, status: TEAM_EVENT_STATUS.SCHEDULED, revision: revision + 1, updatedAt: now },
    result: { matchCount: writes.length, rounds: rounds.length, byes: draw.byes || [], seed } }));
}

/** 赛程列表：按轮次与签位排好，供赛程页与录分页使用 */
async function listTeamMatches(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  const strategy = teamSportStrategyFor(ctx.association, event);
  if (!strategy) return ok(refused('赛事运动规则与协会不符'));

  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const manage = canManageAssociationSpace(ctx);
  // 按赛事下推（`eventId` 已在 EVENT_SCOPED 索引内，2026-10-26 第四轮审查 P-4）：
  // 原来读本协会**历年全部**团队比赛再内存过滤，赛程页每打开一次就翻若干页 RPC。
  const rows = (await repo.teamMatches.listByEvent(event._id))
    .sort((a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)))
    .map(match => matchView(match, teamName, {
      canRecord: manage || match.recorderId === ctx.actorId || (strategy.sportFormat !== 'football11' && [match.teamA, match.teamB].some(
        teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
      )),
      canPublish: manage,
      canSeePending: manage || match.recorderId === ctx.actorId || (strategy.sportFormat !== 'football11' && [match.teamA, match.teamB].some(
        teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
      )),
    }));

  return ok({
    ok: true,
    rounds: event.draw && event.draw.roundCount ? event.draw.roundCount : 1,
    matches: rows,
    canManage: manage,
    message: '',
  });
}

/* ---------------- 录分与发布 ---------------- */

/** 比分归一：非整数或越界一律返回 null（不静默夹取） */
function toScore(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > SCORE_MAX) return null;
  return n;
}

async function canRecordTeamMatch(match, ctx, repo) {
  if (!ctx.actorId || !canReadAssociationSpace(ctx)) return false;
  if (canManageAssociationSpace(ctx)) return true;
  // 被指派为这一场的记录员，就负责录这一场——指派了却录不了，等于白指派
  if (ctx.actorId && match.recorderId && match.recorderId === ctx.actorId) return true;
  const sides = await Promise.all([
    repo.teams.getById(match.teamA),
    repo.teams.getById(match.teamB),
  ]);
  return sides.some(team => inScope(team, ctx) && team.captainId === ctx.actorId);
}

/**
 * 事务内重建上下文：会籍、角色、成员身份都按最新状态重判。
 * 与 association-group-service 等既有服务保持同一写法——权限不能在事务外定死。
 */
const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx,
  actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association },
  now: ctx.now,
});

/** 一场比赛某一方的统计文档主键：确定性键，事务内可直接点读 */
const statDocKey = (matchId, teamId) => schoolKey('tms', matchId, teamId);

/**
 * 统计的可发布快照。
 *
 * 只留「对外可见」需要的字段，不带 updatedBy 这类操作痕迹——快照是给读者看的
 * 一版成绩，不是一份操作日志。
 */
function snapshotOf(doc) {
  if (!doc) return null;
  const mode = doc.mode === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC;
  return {
    mode,
    // 发布快照落库前先去重：历史脏数据一旦被审核通过，快照里也必须是审核人看到的
    // 那一份，不能把重复行原样带进榜单累计（见 statRowKey / uniqueRows）。
    rows: uniqueRows(Array.isArray(doc.rows) ? doc.rows : [], STAT_MODE.DETAILED),
    players: uniqueRows(Array.isArray(doc.players) ? doc.players : [], STAT_MODE.BASIC),
    integrity: doc.integrity || TEAM_STAT_INTEGRITY.NONE,
    revision: Number(doc.revision) || 0,
    publishedAt: doc.publishedAt || null,
    publishedBy: doc.publishedBy || null,
  };
}

/**
 * 一份统计文档「此刻对谁来说算数」。
 *
 * 编辑者看工作副本（他正在改的就是这个）；其他人只看已发布快照——
 * 这就是「已发布比赛的统计不能绕过审核直接生效」的唯一落点。
 */
function effectiveStatOf(doc, { editor }) {
  if (!doc) return null;
  if (editor) {
    return {
      mode: doc.mode === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC,
      rows: Array.isArray(doc.rows) ? doc.rows : [],
      players: Array.isArray(doc.players) ? doc.players : [],
      integrity: doc.integrity || TEAM_STAT_INTEGRITY.NONE,
      revision: Number(doc.revision) || 0,
    };
  }
  return doc.published || null;
}

/** 把工作副本提升为已发布快照（发布比赛 / 审核统计通过时调用） */
function publishStatDoc(doc, { actorId, now }) {
  const snapshot = snapshotOf({ ...doc, publishedAt: now, publishedBy: actorId });
  return {
    ...doc,
    status: TEAM_STAT_STATUS.PUBLISHED,
    published: snapshot,
    publishedRevision: snapshot.revision,
    publishedBy: actorId,
    publishedAt: now,
    updatedAt: now,
  };
}

/**
 * 录一场比赛的比分（→ 待审核）。
 *
 * 【为什么录完不是直接发布】
 * 两队的队长都可能录分，谁录的都可能看错记分牌。录分只说明「这场打完了」，
 * 由协会负责人核对后发布，发布之后才进入积分表与名次。
 *
 * 【平局】
 * 篮球没有平局，只有允许平局的循环赛例外（`rules.allowDraw`）。淘汰赛
 * 平局直接拒绝，并提示打加时——静默接受会让签表卡在「这一轮永远打不完」。
 *
 * 【并发：读-判-写必须在同一事务里】
 * 从前这里先读比赛、再写统计、最后才比版本号，两个请求各自基于同一份旧快照，
 * 后写者把先写者的比分整个盖掉（本地复现：80:70 被 81:70 覆盖）。现在整段
 * 放进事务：事务内重读比赛，先比 `expectRevision`、再落库，第二个请求读到的
 * 已是 +1 后的版本，判不过就拒绝——不是「提示可能冲突」，而是根本写不进去。
 */
async function recordTeamMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const stats = Array.isArray(payload.stats) ? payload.stats : [];
  const result = await ctx.repo.transaction(async (root) => {
    // 事务根带全部集合（会籍、学校、角色都要重读）；受范围集合从 scope 视图取
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    // 事务内按最新会籍重判：请求期间被撤权的不予放行
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!assertTeamSport(fresh)) return refused('该协会不是团队项目');
    if (!fresh.actorId) return refused('请先登录');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');

    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx)) return refused('赛事不存在，或不在本协会');
    if (!supportsMatchData(fresh, event, match)) return refused('赛事运动规则与协会不符，或录分功能尚未开放');
    if (event.status === TEAM_EVENT_STATUS.FINISHED) return refused('赛事已结束，不能再录分');
    if (event.status !== TEAM_EVENT_STATUS.SCHEDULED && event.status !== TEAM_EVENT_STATUS.RUNNING) {
      return refused('赛事当前不可录分');
    }
    if (match.status === TEAM_MATCH_STATUS.PUBLISHED) return refused('这场已发布，要改请先驳回');
    if (match.status === TEAM_MATCH_STATUS.CANCELED) return refused('这场已取消');
    if (match.status === TEAM_MATCH_STATUS.LIVE) return refused('请在实时计分台结束比赛后提交比分');

    if (!(await canRecordTeamMatch(match, fresh, tx))) {
      return refused('只有协会管理者或参赛队队长可以录分');
    }

    // 乐观锁：先判后写。判不过直接返回，不留任何副作用
    if (Number.isInteger(payload.expectRevision)
      && payload.expectRevision !== (Number(match.revision) || 0)) {
      return refused('这场比赛刚被改过，请刷新后重试');
    }

    const scoreA = toScore(payload.scoreA);
    const scoreB = toScore(payload.scoreB);
    if (scoreA === null || scoreB === null) return refused(`比分需为 0–${SCORE_MAX} 的整数`);
    if (scoreA === 0 && scoreB === 0) return refused('0:0 不是有效的比赛比分');

    const forfeit = payload.forfeit === 'A' || payload.forfeit === 'B' ? payload.forfeit : null;
    let winner = null;
    if (forfeit) {
      winner = forfeit === 'A' ? 'B' : 'A';
    } else if (scoreA === scoreB) {
      const drawAllowed = event.rules && event.rules.allowDraw === true
        && event.format === EVENT_FORMAT.ROUND_ROBIN;
      if (!drawAllowed) return refused('篮球不允许平局，请打加时后再录');
    } else {
      winner = scoreA > scoreB ? 'A' : 'B';
    }

    const warnings = [];
    const now = fresh.now;
    // 【先把要读的都读完，再开始写】
    // 云开发事务要求「读在写前」：一旦写过某集合，再回头读就可能被拒。
    // 所以名单快照与既有统计文档都先在写之前取齐，后面只剩下 set。
    const rosters = new Map();
    const previousStats = new Map();
    if (stats.length > 0) {
      for (const teamId of [match.teamA, match.teamB]) {
        // 名单是「锁定那一刻的快照」，按确定性主键点读即可，事务内不必整表列
        const entry = await tx.teamEventEntries.getById(entryKey(event._id, teamId));
        const side = teamId === match.teamA ? 'A' : 'B';
        const lineup = lineupOf(match, side);
        const ids = ((entry && entry.roster) || []).map(row => row.userId);
        // 定过出场名单就只认上过场的人：没上的人不该在这场的统计里出现
        rosters.set(teamId, new Set(lineup.length > 0 ? ids.filter(id => lineup.includes(id)) : ids));
        previousStats.set(teamId, await tx.teamMatchStats.getById(statDocKey(match._id, teamId)));
      }
    }

    const statDocs = [];
    for (const item of stats) {
      const teamId = item && item.teamId;
      if (teamId !== match.teamA && teamId !== match.teamB) {
        return refused('统计里的球队与这场比赛的对阵不符');
      }
      const roster = rosters.get(teamId) || new Set();
      const players = (Array.isArray(item.players) ? item.players : [])
        .filter(row => row && roster.has(row.userId))
        .map(row => ({
          userId: row.userId,
          points: Number.isInteger(Number(row.points)) ? Math.max(0, Number(row.points)) : null,
          fouls: Number.isInteger(Number(row.fouls)) ? Math.max(0, Number(row.fouls)) : null,
        }));
      const total = players.reduce((sum, row) => sum + (row.points || 0), 0);
      const teamScore = teamId === match.teamA ? scoreA : scoreB;
      if (players.some(row => row.points !== null) && total !== teamScore) {
        warnings.push(`个人得分合计 ${total}，球队 ${teamScore}，差 ${teamScore - total} 分待归属`);
      }
      const previous = previousStats.get(teamId);
      statDocs.push({
        _id: statDocKey(match._id, teamId),
        schoolId: ctx.schoolId,
        association: ctx.association,
        eventId: event._id,
        matchId: match._id,
        teamId,
        mode: STAT_MODE.BASIC,
        players,
        rows: [],
        // 首版只做「总分 + 个人得分/犯规」，其余指标是 D 期的详细模式
        integrity: players.some(row => row.points !== null || row.fouls !== null)
          ? TEAM_STAT_INTEGRITY.BASIC
          : TEAM_STAT_INTEGRITY.NONE,
        // 比赛尚未发布，统计只是工作副本；发布比赛时一并转成已发布快照
        status: TEAM_STAT_STATUS.DRAFT,
        published: null,
        publishedRevision: 0,
        revision: (Number(previous && previous.revision) || 0) + 1,
        updatedBy: ctx.actorId,
        updatedAt: now,
      });
    }

    for (const doc of statDocs) await tx.teamMatchStats.set(doc._id, doc);

    const nextRevision = (Number(match.revision) || 1) + 1;
    await tx.teamMatches.set(match._id, {
      ...match,
      scoreA,
      scoreB,
      overtime: payload.overtime === true,
      forfeit,
      winner,
      status: TEAM_MATCH_STATUS.REVIEWING,
      recordedBy: ctx.actorId,
      recordedAt: now,
      revision: nextRevision,
      updatedAt: now,
    });

    if (event.status === TEAM_EVENT_STATUS.SCHEDULED) {
      await tx.teamEvents.set(event._id, {
        ...event,
        status: TEAM_EVENT_STATUS.RUNNING,
        revision: Number(event.revision || 1) + 1,
        updatedAt: now,
      });
    }

    return {
      ok: true, status: TEAM_MATCH_STATUS.REVIEWING, winner, warnings, revision: nextRevision, message: '',
    };
  });
  return ok(result);
}

/**
 * 发布 / 驳回比分。
 *
 * 驳回会把比分清空并要求重录，而不是「留着让人改一改」——留着的话，
 * 一次驳回之后谁都分不清屏幕上那串数字是核对过的还是被退回的。
 *
 * 【发布比分 = 同时发布这一场的统计】
 * 校园赛的实际顺序是「先录比分，再补统计」。若发布只管比分，统计会一直停在
 * 工作副本里，球员榜永远是空的。所以发布时把两队的统计副本一并转成已发布
 * 快照；驳回时两者一起退回，不留「比分没了、统计还在」的半截状态。
 */
async function publishTeamMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以发布成绩'));

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!assertTeamSport(fresh)) return refused('该协会不是团队项目');
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布成绩');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');
    if (match.status !== TEAM_MATCH_STATUS.REVIEWING) {
      return refused('只有待审核的比赛可以发布或驳回');
    }
    if (Number.isInteger(payload.expectRevision)
      && payload.expectRevision !== (Number(match.revision) || 0)) {
      return refused('这场比赛刚被改过，请刷新后重试');
    }

    const now = fresh.now;
    const nextRevision = (Number(match.revision) || 1) + 1;
    // 读在写前：比赛、两队统计、赛事一次取齐（云开发事务不允许写后再读）
    const statDocs = new Map();
    for (const teamId of [match.teamA, match.teamB]) {
      statDocs.set(teamId, await tx.teamMatchStats.getById(statDocKey(match._id, teamId)));
    }
    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx) || !supportsMatchData(fresh, event, match)) {
      return refused('赛事运动规则与协会不符，或成绩发布功能尚未开放');
    }

    if (payload.approve !== true) {
      await tx.teamMatches.set(match._id, {
        ...match,
        scoreA: null,
        scoreB: null,
        overtime: false,
        forfeit: null,
        winner: null,
        status: TEAM_MATCH_STATUS.SCHEDULED,
        recordedBy: null,
        recordedAt: null,
        revision: nextRevision,
        updatedAt: now,
      });
      // 统计随之退回：对外不再有这一场的已发布统计
      for (const [teamId, doc] of statDocs) {
        if (!doc) continue;
        await tx.teamMatchStats.set(statDocKey(match._id, teamId), {
          ...doc,
          status: TEAM_STAT_STATUS.DRAFT,
          published: null,
          publishedRevision: 0,
          updatedAt: now,
        });
      }
      return { ok: true, status: TEAM_MATCH_STATUS.SCHEDULED, message: '' };
    }

    await tx.teamMatches.set(match._id, {
      ...match,
      status: TEAM_MATCH_STATUS.PUBLISHED,
      publishedBy: fresh.actorId,
      publishedAt: now,
      revision: nextRevision,
      updatedAt: now,
    });

    let publishedStats = 0;
    for (const [teamId, doc] of statDocs) {
      if (!doc) continue;
      await tx.teamMatchStats.set(
        statDocKey(match._id, teamId),
        publishStatDoc(doc, { actorId: fresh.actorId, now })
      );
      publishedStats += 1;
    }

    if (inScope(event, ctx) && event.status === TEAM_EVENT_STATUS.SCHEDULED) {
      await tx.teamEvents.set(event._id, {
        ...event,
        status: TEAM_EVENT_STATUS.RUNNING,
        revision: Number(event.revision || 1) + 1,
        updatedAt: now,
      });
    }

    return {
      ok: true, status: TEAM_MATCH_STATUS.PUBLISHED, publishedStats, revision: nextRevision, message: '',
    };
  });
  return ok(result);
}

/**
 * 审核已发布比赛的统计新版本。
 *
 * 【为什么统计要单独审核】
 * 比分发布之后，统计仍可能被补录或更正。若这类修改直接生效，球员榜就绕过了
 * 发布审核——录错一个人的 20 分，榜单当场变形，而页面上看不出这一版有没有
 * 人核对过。所以已发布比赛的统计修改只写 `pending` 工作副本，对外继续读
 * `published` 快照；管理员在这里通过（指针前移）或退回（丢弃工作副本）。
 */
async function reviewTeamMatchStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以审核统计'));

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以审核统计');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');
    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx) || !supportsMatchData(fresh, event, match)) {
      return refused('赛事运动规则与协会不符，或统计功能尚未开放');
    }
    if (match.status !== TEAM_MATCH_STATUS.PUBLISHED) {
      return refused('这场还没发布，统计跟随比赛一起发布');
    }

    const now = fresh.now;
    // 读在写前：两份统计文档先取齐，再决定写哪些
    const docs = new Map();
    for (const teamId of [match.teamA, match.teamB]) {
      docs.set(teamId, await tx.teamMatchStats.getById(statDocKey(match._id, teamId)));
    }

    let reviewed = 0;
    let keptDraft = 0;
    for (const [teamId, doc] of docs) {
      if (!doc || doc.status !== TEAM_STAT_STATUS.PENDING) continue;
      const key = statDocKey(match._id, teamId);

      if (payload.approve === true) {
        await tx.teamMatchStats.set(key, publishStatDoc(doc, { actorId: fresh.actorId, now }));
      } else if (doc.published) {
        // 退回：工作副本回到已发布的那一版，不留半改的数据
        await tx.teamMatchStats.set(key, {
          ...doc,
          ...doc.published,
          status: TEAM_STAT_STATUS.PUBLISHED,
          revision: Number(doc.published.revision) || 0,
          updatedAt: now,
        });
      } else {
        // 还没有任何已发布版本：退回只是取消「待审核」，草稿仍是草稿
        await tx.teamMatchStats.set(key, { ...doc, status: TEAM_STAT_STATUS.DRAFT, updatedAt: now });
        keptDraft += 1;
      }
      reviewed += 1;
    }

    if (reviewed === 0) return refused('这场的统计没有待审核的版本');
    return {
      ok: true, approved: payload.approve === true, reviewed, keptDraft, message: '',
    };
  });
  return ok(result);
}

/**
 * 生成下一轮（淘汰赛）。
 *
 * 复用个人赛的 `planNextRound`：它只认「签位 + 已有比赛 + 哪一场算定局」，
 * 与参赛单位是人还是球队无关。团队赛只是把判定函数换成「已发布」。
 */
/* ---------------- 赛程：逐场时间 / 场地 / 裁判 / 记录员 ---------------- */

/**
 * 这一场可以指派谁。
 *
 * 三条口径：
 *   · 只列**本协会**正常在册、账号可用的会员——指派给名单外的人，页面上
 *     连名字都显示不出来；
 *   · 裁判不能是这两支队的队长（自己队自己判，成绩没人信）；记录员可以，
 *     校园赛经常就是队长拿手机记；
 *   · 候选里保留「为什么不给选」的原因，页面直接显示，不在前端重新推一遍
 *     规则——推两遍迟早分叉。
 */
async function schedulePeople(ctx, match) {
  const repo = ctx.repo.forScope(ctx);
  // 【按需读，不整表】（2026-10-29 第十一轮审计 P3-10）
  // 原实现无条件读三份整表：目录（已缓存）、本协会全部会籍、本协会全部球队。
  // 其中「球队」只为取两支队的队长——点读两次即可；「会籍」只有非足球协会才用
  // （足球按账号口径判有效成员），足球路径整份读回来是纯浪费。
  const isFootball = football.isFootball(ctx);
  const [dir, memberships, teamA, teamB] = await Promise.all([
    buildDirectory(ctx),
    isFootball ? Promise.resolve([]) : repo.memberships.list(),
    match.teamA ? repo.teams.getById(match.teamA) : null,
    match.teamB ? repo.teams.getById(match.teamB) : null,
  ]);
  const userById = new Map(dir.members.map(user => [user._id, user]));
  const activeIds = isFootball ? new Set(dir.activeMemberIds.filter(id => userById.get(id)?.primarySchoolId === ctx.schoolId)) : new Set(
    memberships
      .filter(row => row.status === 'active'
        && row.schoolId === ctx.schoolId
        && row.association === ctx.association)
      .map(row => row.userId)
  );
  const captainIds = new Set(
    [teamA, teamB].filter(Boolean).map(team => team.captainId).filter(Boolean)
  );
  const people = [...activeIds]
    .filter(userId => userById.has(userId))
    .map((userId) => {
      const user = userById.get(userId);
      return {
        userId,
        name: personNameOf(user, userId),
        college: dir.collegeOf(userId),
        isCaptain: captainIds.has(userId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return {
    recorders: people.map(row => ({
      ...row, disabled: false, disabledReason: '',
    })),
    referees: people.map(row => ({
      ...row,
      disabled: row.isCaptain,
      disabledReason: row.isCaptain ? '参赛队队长不能执法自己队的比赛' : '',
    })),
  };
}

/** 单场赛程的编辑面板：当前值 + 候选名单 */
async function getTeamMatchSchedule(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以排赛程'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));

  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const people = await schedulePeople(ctx, match);

  return ok({
    ok: true,
    match: matchView(match, teamName, { canRecord: true, canPublish: true, canSeePending: true }),
    ...people,
    // 已结束的赛事不再改赛程：改了也不会有比赛按新时间去打
    canEdit: event.status !== TEAM_EVENT_STATUS.FINISHED
      && event.status !== TEAM_EVENT_STATUS.CANCELED
      && match.status !== TEAM_MATCH_STATUS.CANCELED
      && (!football.isFootball(ctx) || match.status === TEAM_MATCH_STATUS.SCHEDULED),
    message: '',
  });
}

/**
 * 改一场比赛的时间 / 场地 / 裁判 / 记录员。
 *
 * 【为什么全部收在一个动作里】
 * 这四样是同一件事的四个字段：管理员在一个浮层里改完一起保存。拆成四个动作，
 * 一次改动就会产生四个版本号，页面得跟着记四个——并发判断反而更容易错。
 *
 * 【为什么读在写前、先判后写】
 * 与录分同一条纪律：事务内重读比赛、按最新会籍重判权限、先比 `expectRevision`
 * 再落库。改期是「赛前高频、多人同时改」的操作，正是最容易互相覆盖的地方。
 */
async function updateTeamMatchSchedule(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以排赛程'));

  // 队名要在事务外读（事务内不能整表列）；只用于返回体的展示
  const teamName = new Map(
    (await ctx.repo.forScope(ctx).teams.list()).map(team => [team._id, team.name])
  );

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!assertTeamSport(fresh)) return refused('该协会不是团队项目');
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以排赛程');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');
    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx)) return refused('赛事不存在，或不在本协会');
    if (event.status === TEAM_EVENT_STATUS.FINISHED) return refused('赛事已结束，不能再改赛程');
    if (event.status === TEAM_EVENT_STATUS.CANCELED) return refused('赛事已取消');
    if (match.status === TEAM_MATCH_STATUS.CANCELED) return refused('这场已取消');

    if (Number.isInteger(payload.expectRevision)
      && payload.expectRevision !== (Number(match.revision) || 0)) {
      return refused('这场比赛刚被改过，请刷新后重试');
    }

    const has = key => Object.prototype.hasOwnProperty.call(payload, key);
    const patch = {};
    const touches = [];

    if (has('matchTime')) {
      const parsed = toMatchTime(payload.matchTime);
      if (!parsed.ok) return refused('开赛时间格式不对，请按 2026-10-21 14:00 填写');
      patch.matchTime = parsed.value;
      touches.push(parsed.value ? '开赛时间' : '清空开赛时间');
    }
    if (has('location')) {
      const text = String(payload.location === null || payload.location === undefined ? '' : payload.location).trim();
      if (text.length > LOCATION_MAX) return refused(`场地名称不超过 ${LOCATION_MAX} 个字`);
      patch.location = text;
      touches.push('场地');
    }

    // 裁判 / 记录员：先在事务内点读重判资格，再一起落库
    for (const role of ['referee', 'recorder']) {
      const key = `${role}Id`;
      if (!has(key)) continue;
      const targetId = String(payload[key] === null || payload[key] === undefined ? '' : payload[key]).trim();
      if (!targetId) {
        patch[key] = null;
        patch[`${role}Name`] = '';
        touches.push(role === 'referee' ? '清空裁判' : '清空记录员');
        continue;
      }
      // users 是全局集合，不在「学校 + 协会」范围视图里，只能从事务根上点读
      const user = await root.users.getById(targetId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE) {
        return refused('这位会员的账号已停用，不能指派');
      }
      const member = await tx.schoolMembers.getById(schoolMemberKey(targetId, fresh.schoolId));
      if (!member || member.status !== 'active') return refused('这位同学不在本校在册名单里');
      const membership = await tx.memberships.getById(schoolMembershipKey(targetId, {
        schoolId: fresh.schoolId, association: fresh.association,
      }));
      if (!membership || membership.status !== 'active') {
        return refused('这位同学不是本协会会员，不能指派');
      }
      if (role === 'referee') {
        const sides = await Promise.all([
          tx.teams.getById(match.teamA),
          tx.teams.getById(match.teamB),
        ]);
        if (sides.some(team => team && team.captainId === targetId)) {
          return refused('参赛队队长不能执法自己队的比赛');
        }
      }
      patch[key] = targetId;
      patch[`${role}Name`] = personNameOf(user, targetId);
      touches.push(role === 'referee' ? '裁判' : '记录员');
    }

    if (touches.length === 0) return refused('没有要修改的内容');

    const nextRevision = (Number(match.revision) || 1) + 1;
    const next = {
      ...match,
      ...patch,
      revision: nextRevision,
      updatedAt: fresh.now,
      scheduleUpdatedBy: fresh.actorId,
      scheduleUpdatedAt: fresh.now,
    };
    await tx.teamMatches.set(match._id, next);

    return {
      ok: true,
      revision: nextRevision,
      changed: touches,
      match: matchView(next, teamName, { canRecord: true, canPublish: true, canSeePending: true }),
      message: '',
    };
  });
  return ok(result);
}

/**
 * 整轮顺延：把同一轮（可限定 stage）还没打的比赛统一往后挪几分钟。
 *
 * 【为什么需要它】
 * 一场雨、一次拖场，整轮都要挪。逐场改二十次既慢又容易漏，而漏掉的一场
 * 会让两支队伍在不同时间到场。
 *
 * 【为什么跳过已发布与没有时间的场次】
 * 已发布 = 已经打完；没有时间 = 本来就没排期，顺延无从谈起。跳过的数量
 * 一并返回，页面能说清「改了 5 场、跳过 1 场」。
 */
async function updateTeamRoundSchedule(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以排赛程'));

  const shift = Number(payload.shiftMinutes);
  if (!Number.isInteger(shift) || shift === 0) return ok(refused('顺延分钟数需为非零整数'));
  if (Math.abs(shift) > SHIFT_MAX_MINUTES) {
    return ok(refused(`一次最多顺延 ${SHIFT_MAX_MINUTES} 分钟`));
  }
  const round = Number(payload.round);
  if (!Number.isInteger(round) || round < 1) return ok(refused('缺少轮次'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status === TEAM_EVENT_STATUS.FINISHED) return ok(refused('赛事已结束，不能再改赛程'));
  if (event.status === TEAM_EVENT_STATUS.CANCELED) return ok(refused('赛事已取消'));

  const stage = payload.stage ? String(payload.stage) : '';
  const targets = (await repo.teamMatches.listByEvent(event._id)).filter(match =>
    Number(match.round) === round
    && (!stage || match.stage === stage));
  if (targets.length === 0) return ok(refused('这一轮还没有比赛'));
  if (8 + targets.length * 2 > 96) return ok(refused('本轮场次超过云端单事务安全容量，请按阶段分别顺延', { code: 'TEAM_BATCH_LIMIT' }));

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以排赛程');

    const currentEvent = await tx.teamEvents.getById(event._id);
    if (!currentEvent || [TEAM_EVENT_STATUS.FINISHED, TEAM_EVENT_STATUS.CANCELED].includes(currentEvent.status)) {
      return refused('赛事已结束，不能再改赛程');
    }
    // 读在写前：先按编号点读齐，再统一写
    const docs = [];
    for (const target of targets) docs.push(await tx.teamMatches.getById(target._id));

    const writes = [];
    let skipped = 0;
    for (const doc of docs) {
      if (!doc) continue;
      if (doc.status === TEAM_MATCH_STATUS.PUBLISHED || doc.status === TEAM_MATCH_STATUS.CANCELED) {
        skipped += 1;
        continue;
      }
      if (!doc.matchTime) {
        skipped += 1;
        continue;
      }
      const shifted = Date.parse(doc.matchTime) + shift * 60 * 1000;
      if (!Number.isFinite(shifted)) {
        skipped += 1;
        continue;
      }
      writes.push({
        ...doc,
        matchTime: new Date(shifted).toISOString(),
        revision: (Number(doc.revision) || 1) + 1,
        updatedAt: fresh.now,
        scheduleUpdatedBy: fresh.actorId,
        scheduleUpdatedAt: fresh.now,
      });
    }
    if (writes.length === 0) return refused('这一轮没有可顺延的比赛（已发布或没有开赛时间）');
    for (const doc of writes) await tx.teamMatches.set(doc._id, doc);
    return { ok: true, shifted: writes.length, skipped, minute: shift, message: '' };
  });
  return ok(result);
}

async function advanceTeamRound(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以编排赛程'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.format !== EVENT_FORMAT.SINGLE_ELIM) return ok(refused('循环赛没有下一轮'));
  if (!event.draw || !Array.isArray(event.draw.slots) || event.draw.slots.length < 2) {
    return ok(refused('还没有抽签'));
  }
  if (event.status === TEAM_EVENT_STATUS.FINISHED || event.status === TEAM_EVENT_STATUS.CANCELED) {
    return ok(refused('赛事已结束'));
  }

  const matches = await repo.teamMatches.listByEvent(event._id);
  const plan = planNextRound({
    eventId: event._id,
    draw: event.draw,
    matches,
    bronzeMode: event.bronzeMode || EVENT_BRONZE_MODE.PLAYOFF,
    isFinal: match => isFinal(match) && Boolean(match.winner),
  });
  if (!plan.ok || plan.rounds.length === 0) {
    const pending = matches.filter(
      match => match.status !== TEAM_MATCH_STATUS.PUBLISHED && match.status !== TEAM_MATCH_STATUS.CANCELED
    );
    return ok(refused(pending.length > 0
      ? `还有 ${pending.length} 场未发布，打完了再排下一轮`
      : '赛程已全部打完，可以结算名次'));
  }

  const now = ctx.now;
  const writes = [];
  for (const item of plan.rounds) {
    for (let slot = 0; slot < item.pairs.length; slot += 1) {
      const [a, b] = item.pairs[slot] || [];
      if (!a || !b) continue;
      const doc = matchDocOf({
        event, ctx, round: item.round, stage: item.stage, slot, teamA: a, teamB: b, now,
      });
      if (matches.some(match => match._id === doc._id)) continue;
      writes.push({ key: 'teamMatches', doc });
    }
  }

  const addedRounds = plan.rounds.length;
  return ok(await commitEventChange(ctx, { event,
    reads: matches.map(doc => ({ key: 'teamMatches', doc })), writes,
    nextEvent: { ...event, draw: { ...event.draw,
      roundCount: Math.max(Number(event.draw.roundCount) || 1, ...plan.rounds.map(row => row.round)) },
      revision: (Number(event.revision) || 0) + 1, updatedAt: now },
    result: { rounds: addedRounds, matchCount: writes.length } }));
}

/**
 * 结算名次：写进赛事与各队报名记录，赛事转「已结束」。
 *
 * 循环赛按积分表定名次；淘汰赛按签表定。两者都要求「所有比赛已定局」，
 * 否则结算出来的名次第二天就变了。
 */
async function settleTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以结算名次'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status === TEAM_EVENT_STATUS.CANCELED) return ok(refused('赛事已取消'));
  if (event.status === TEAM_EVENT_STATUS.FINISHED && (event.placements || []).length) {
    const entries = await repo.teamEventEntries.listByEvent(event._id);
    const writes = entries.filter(entry => event.placements.some(row => row.teamId === entry.teamId && row.rank !== entry.placement))
      .map(entry => ({ key: 'teamEventEntries', doc: { ...entry,
        placement: event.placements.find(row => row.teamId === entry.teamId).rank, updatedAt: ctx.now } }));
    if (!writes.length) return ok({ ok: true, placements: event.placements, message: '' });
    return ok(await commitEventChange(ctx, { event, reads: entries.map(doc => ({ key: 'teamEventEntries', doc })), writes,
      nextEvent: { ...event, revision: (Number(event.revision) || 0) + 1, updatedAt: ctx.now }, result: { placements: event.placements } }));
  }

  const matches = await repo.teamMatches.listByEvent(event._id);
  if (matches.length === 0) return ok(refused('还没有赛程，无法结算'));
  if (football.isFootball(ctx) && matches.some(match => match.footballDraft)) return ok(refused('仍有足球报告待审核，请先审核后结算'));
  const pending = matches.filter(
    match => match.status !== TEAM_MATCH_STATUS.PUBLISHED && match.status !== TEAM_MATCH_STATUS.CANCELED
  );
  if (pending.length > 0) return ok(refused(`还有 ${pending.length} 场未发布，无法结算`));

  const entries = (await repo.teamEventEntries.listByEvent(event._id))
    .filter(entry => entry.status === TEAM_ENTRY_STATUS.LOCKED);
  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));

  const strategy = teamSportStrategyFor(ctx.association, event);
  if (!strategy) return ok(refused('赛事运动规则与协会不符'));
  if (strategy.sportFormat === 'football11' && payload.rankingDecisions !== undefined
    && (!Array.isArray(payload.rankingDecisions) || payload.rankingDecisions.some(row => !row
      || typeof row.tieKey !== 'string' || !Array.isArray(row.teamIds)
      || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500))) {
    return ok(refused('抽签确认须填写有效的球队顺序与理由（不超过 500 字）'));
  }
  const rankingDecisions = strategy.sportFormat === 'football11' && Array.isArray(payload.rankingDecisions)
    ? payload.rankingDecisions.map(row => ({ tieKey: row.tieKey, teamIds: row.teamIds,
      reason: row.reason, decidedBy: ctx.actorId, decidedAt: new Date(ctx.now).toISOString() })) : event.rankingDecisions || [];
  const table = strategy.computeTable({
    entries: entries.map(entry => ({ teamId: entry.teamId, teamName: teamName.get(entry.teamId) })),
    matches, rules: event.rules, rankingDecisions,
  });

  let placements;
  if (event.format === EVENT_FORMAT.ROUND_ROBIN) {
    if (table.some(row => row.rank === null)) return ok(refused('同分球队的名次待确认，不能结算'));
    placements = table.map(row => ({
      rank: row.rank,
      teamId: row.teamId,
      note: row.rank === 1 ? '冠军' : (row.rank === 2 ? '亚军' : ''),
    }));
  } else {
    if (strategy.sportFormat === 'football11') {
      const remaining = planNextRound({ eventId: event._id, draw: event.draw, matches,
        bronzeMode: event.bronzeMode || EVENT_BRONZE_MODE.PLAYOFF,
        isFinal: match => isFinal(match) && Boolean(match.winner) });
      if (remaining.ok && remaining.rounds.length) return ok(refused('还有未生成的淘汰赛程，请先排下一轮'));
      if (matches.some(m => m.status === 'canceled' || !m.winner)) return ok(refused('淘汰赛必须有完整有效的晋级结果才能结算'));
    }
    placements = computeTeamPlacements({ draw: event.draw, matches, table });
    // 足球同轮淘汰球队共享名次，不能用稳定 ID 顺序代替抽签。
    if (strategy.sportFormat === 'football11') {
      const rankByRound = new Map();
      placements = placements.map(row => {
        if (row.note !== '淘汰') return row;
        const lost = matches.find(m => m.stage !== 'bronze' && (m.winner === 'A' ? m.teamB : m.teamA) === row.teamId);
        const round = lost && lost.round;
        if (!rankByRound.has(round)) rankByRound.set(round, row.rank);
        return { ...row, rank: rankByRound.get(round), note: '同轮淘汰（并列）' };
      });
    }
  }
  if (placements.length === 0) return ok(refused('还没有产生可结算的名次'));

  const rows = placements.map(row => ({
    rank: row.rank,
    teamId: row.teamId,
    teamName: teamName.get(row.teamId) || '已归档球队',
    note: row.note || '',
  }));

  const now = ctx.now;
  const writes = rows.map(row => {
    const entry = entries.find(item => item.teamId === row.teamId);
    return entry ? { key: 'teamEventEntries', doc: { ...entry, placement: row.rank, updatedAt: now } } : null;
  }).filter(Boolean);
  return ok(await commitEventChange(ctx, { event,
    reads: [...matches.map(doc => ({ key: 'teamMatches', doc })), ...entries.map(doc => ({ key: 'teamEventEntries', doc }))], writes,
    nextEvent: { ...event, rankingDecisions, placements: rows, status: TEAM_EVENT_STATUS.FINISHED, finishedAt: now,
      revision: (Number(event.revision) || 0) + 1, updatedAt: now }, result: { placements: rows } }));
}

/* ---------------- 个人统计 ---------------- */

/**
 * 统计口径与两种模式。
 *
 *   basic    —— 只记每个人整场的得分与犯规（没有专职记录员的比赛）
 *   detailed —— 按节记每个人（得分 / 篮板 / 助攻 / 抢断 / 盖帽 / 失误 / 犯规），
 *               合计由各行算出，绝不与合计双份存储
 *
 * 【为什么不做逐球事件流】
 * 逐球（谁在哪儿投了个两分）需要一个人全程盯着一支队录，校园赛凑不出这个人力。
 * 「按节合计」是记录员在纸上真正会填的粒度：一节一格，四节就是四行。
 */
const STAT_MODE = { BASIC: 'basic', DETAILED: 'detailed' };
const STAT_FIELDS = BASKETBALL_STAT_LIMITS;

/** 报错时用中文指标名，不把字段键抛给用户 */
const STAT_LABEL = {
  points: '个人得分', rebounds: '篮板', assists: '助攻',
  steals: '抢断', blocks: '盖帽', turnovers: '失误', fouls: '犯规',
};

/** 一个格子的数字：空 → null（未记录），非整数 / 越界 → 非法 */
function parseStat(raw, max) {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false };
  return { ok: true, value: n };
}

/**
 * 统计记录的唯一键：详细模式「一人一节一条」，基础模式「一人一条」。
 *
 * 【为什么需要它】（2026-10-26 只读审查 P2-3）
 * 保存时没有校验唯一性，审核面板用 `find()` 只显示**第一条**，而榜单对同一批
 * 记录**全部累加**：队长提交同一球员两条「10 助攻」，保存不报错、审核面板显示 10、
 * 审核通过后榜单显示 20。数字对不上，责任还落在审核人身上。
 * 现在保存侧直接拒绝重复（见 saveTeamMatchStats），读取侧再用下表兜住历史脏数据。
 */
function statRowKey(row, mode) {
  return mode === STAT_MODE.DETAILED ? `${row.userId}#${Number(row.period)}` : String(row.userId);
}

/**
 * 去重：同一唯一键只保留**第一条**。
 *
 * 保留第一条而不是求和，是为了与审核面板的历史口径一致——审核人当时看到的就是
 * 第一条，通过之后榜单必须显示同一个数，而不是「审核 10 分、榜单 20 分」。
 * 新数据不会再产生重复（保存侧已拒绝），这里只兜历史记录。
 */
function uniqueRows(rows, mode) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.userId) continue;
    const key = statRowKey(row, mode);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** 由各行算出合计；某个指标一行都没填 → null（不是 0） */
function totalsOf(rows) {
  const out = {};
  for (const field of Object.keys(STAT_FIELDS)) {
    const filled = rows.filter(row => row[field] !== null && row[field] !== undefined);
    out[field] = filled.length > 0 ? filled.reduce((sum, row) => sum + row[field], 0) : null;
  }
  return out;
}

/**
 * 按人分组求和。
 *
 * 【为什么要按 userId 分组】
 * 从前这里对**整队**的行求和，再把同一个合计填给队里每个人：两人分别得
 * 10 分与 3 分，读回来每人都是 13 分。合计是「队」的量，不是「人」的量，
 * 必须按人分开累。
 */
function totalsByPlayer(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.userId) continue;
    if (!map.has(row.userId)) map.set(row.userId, {});
    const acc = map.get(row.userId);
    for (const field of Object.keys(STAT_FIELDS)) {
      const value = row[field];
      if (!Number.isInteger(value)) continue;
      acc[field] = (Number.isInteger(acc[field]) ? acc[field] : 0) + value;
    }
  }
  return map;
}

/**
 * 取一场比赛的个人统计面板。
 *
 * 【为什么要单独一个接口】
 * 名单是「锁定那一刻的快照」（`team_event_entries.roster`），不在球队表里。
 * 页面要按当时上场的人列格子，只能由服务端把快照与已有统计一起给出——
 * 前端自己拼会把「现在队里有谁」误当成「这场谁打了」。
 *
 * 【谁能看到哪一版】
 * 可编辑者（管理者 / 参赛队队长）看工作副本，那正是他要改的东西；其他人只看
 * 已发布快照。比赛还没发布时，非编辑者连面板都拿不到——待审核的统计和待审核
 * 的比分一样，不能先看到再被改掉。
 */
async function getTeamMatchStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (!supportsMatchData(ctx, event, match)) return ok(refused('赛事运动规则与协会不符，或统计功能尚未开放'));

  // 两处都按赛事下推（2026-10-26 第四轮审查 P-4）：原来读本协会全年的报名与
  // **全部**技术统计再筛这一场，统计集合是只增不减的，越到赛季后段越慢。
  const entries = await repo.teamEventEntries.listByEvent(match.eventId);
  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const stats = (await repo.teamMatchStats.listByEvent(match.eventId))
    .filter(row => row.matchId === match._id);
  const manage = canManageAssociationSpace(ctx);
  const captain = [match.teamA, match.teamB].some(
    teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
  );
  const editor = manage || captain || match.recorderId === ctx.actorId;
  const published = match.status === TEAM_MATCH_STATUS.PUBLISHED;
  if (!editor && !published) return ok(refused('这场还没发布，统计暂不可查看'));

  const sides = [match.teamA, match.teamB].map((teamId) => {
    const entry = entries.find(row => row.eventId === event._id && row.teamId === teamId);
    const side = teamId === match.teamA ? 'A' : 'B';
    const lineup = lineupOf(match, side);
    const fullRoster = ((entry && entry.roster) || []).map(row => ({
      userId: row.userId, name: row.name, no: Number.isInteger(row.no) ? row.no : null,
    }));
    // 定过出场名单就只列上过场的人：没上的人挂一排「未记录」，页面会以为是漏填
    const roster = lineup.length > 0
      ? fullRoster.filter(row => lineup.includes(row.userId))
      : fullRoster;
    const doc = stats.find(row => row.teamId === teamId) || null;
    const effective = effectiveStatOf(doc, { editor });
    const mode = effective ? effective.mode : STAT_MODE.BASIC;
    // 历史数据可能残留同一人的重复行（旧版保存侧没有唯一性校验）：
    // 一律先按唯一键去重，保证「审核面板看到的」与「榜单累加的」是同一份记录。
    const rows = uniqueRows((effective && effective.rows) || [], STAT_MODE.DETAILED);
    const savedPlayers = uniqueRows((effective && effective.players) || [], STAT_MODE.BASIC);
    // 详细模式的合计由各行算出（按人）；基础模式直接取存好的合计
    const perPlayer = mode === STAT_MODE.DETAILED ? totalsByPlayer(rows) : new Map();
    return {
      teamId,
      teamName: teamName.get(teamId) || '已归档球队',
      players: roster.map((row) => {
        const out = { userId: row.userId, name: row.name || row.userId };
        if (mode === STAT_MODE.DETAILED) {
          const totals = perPlayer.get(row.userId) || {};
          for (const field of Object.keys(STAT_FIELDS)) {
            out[field] = Number.isInteger(totals[field]) ? totals[field] : null;
          }
        } else {
          const hit = savedPlayers.find(item => item.userId === row.userId) || {};
          for (const field of Object.keys(STAT_FIELDS)) {
            out[field] = Number.isInteger(hit[field]) ? hit[field] : null;
          }
        }
        return out;
      }),
      // 详细模式把每节各行一起交给页面；基础模式没有行
      rows: mode === STAT_MODE.DETAILED ? rows.map(row => ({ ...row })) : null,
      // 编辑者拿到的版本号用于乐观锁；非编辑者拿到的是已发布版本号（只读）
      revision: editor
        ? (Number(doc && doc.revision) || 0)
        : (Number(doc && doc.publishedRevision) || 0),
      status: doc ? doc.status || TEAM_STAT_STATUS.DRAFT : null,
      pendingReview: Boolean(doc && doc.status === TEAM_STAT_STATUS.PENDING),
      publishedRevision: Number(doc && doc.publishedRevision) || 0,
      hasPublished: Boolean(doc && doc.published),
    };
  });

  return ok({
    ok: true,
    match: matchView(match, teamName, {
      canRecord: editor, canPublish: manage, canSeePending: editor,
    }),
    statPolicy: match.liveScore && match.liveScore.statsIntegrated
      ? match.liveScore.statMode : (event.statPolicy === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC),
    periods: Math.max(Number(event.rules && event.rules.periods) || 4,
      Number(match.liveScore && match.liveScore.period) || 0),
    sides,
    canEdit: editor && match.status !== TEAM_MATCH_STATUS.CANCELED && match.status !== TEAM_MATCH_STATUS.LIVE
      && event.status !== TEAM_EVENT_STATUS.FINISHED,
    // 已发布的比赛改统计要重新审核；页面据此提示「保存后需审核」
    needReview: published,
    canReview: manage && sides.some(side => side.pendingReview),
    message: '',
  });
}

/**
 * 保存一场比赛的个人统计。
 *
 * 【总分与个人统计谁说话】
 * 比分是权威、统计是解释。个人得分合计与球队得分对不上时**照存**，
 * 只回一句差额提醒——校园赛经常只有一个记分牌，硬拦会让人干脆不录。
 *
 * 【未记录 ≠ 0】
 * 没填的格子存 `null` 而不是 0。0 分是一个事实（上场了没得分），
 * 没填是另一个事实（这场没统计）。混成一个数，场均得分就永远偏低。
 *
 * 【已发布比赛的统计不直接生效】
 * 发布之后补录或更正统计，写入的是 `pending` 工作副本，对外仍读已发布快照，
 * 由管理员在 `reviewTeamMatchStats` 里通过或退回。否则「改一个数字就改榜单」
 * 等于把发布审核整个绕过去。
 *
 * 【并发】
 * 两个队文档在同一事务里写，读-判-写不分离；调用方带 `expectRevision`
 * （面板打开时拿到的版本号），对不上就拒绝并要求刷新。
 */
async function saveTeamMatchStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const result = await ctx.repo.transaction(async (root) => {
    const tx = root.forScope({ schoolId: ctx.schoolId, association: ctx.association });
    const fresh = await freshContext(root, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');
    if (!assertTeamSport(fresh)) return refused('该协会不是团队项目');
    if (!fresh.actorId) return refused('请先登录');

    const match = await tx.teamMatches.getById(payload.matchId);
    if (!inScope(match, ctx)) return refused('比赛不存在，或不在本协会');
    const event = await tx.teamEvents.getById(match.eventId);
    if (!inScope(event, ctx)) return refused('赛事不存在，或不在本协会');
    if (!supportsMatchData(fresh, event, match)) return refused('赛事运动规则与协会不符，或录分功能尚未开放');
    if (event.status === TEAM_EVENT_STATUS.FINISHED) return refused('赛事已结束，统计不能再改');
    if (match.status === TEAM_MATCH_STATUS.CANCELED) return refused('这场已取消');
    if (match.status === TEAM_MATCH_STATUS.LIVE) return refused('请在实时计分台记录球员统计');
    if (!(await canRecordTeamMatch(match, fresh, tx))) {
      return refused('只有协会管理者或参赛队队长可以录统计');
    }

    const mode = payload.mode === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC;
    if (mode === STAT_MODE.DETAILED && event.statPolicy !== STAT_MODE.DETAILED) {
      return refused('这场赛事未开启按节统计');
    }

    const periods = Math.max(Number(event.rules && event.rules.periods) || 4,
      Number(match.liveScore && match.liveScore.period) || 0);
    const sides = [];
    for (const teamId of [match.teamA, match.teamB]) {
      const entry = await tx.teamEventEntries.getById(entryKey(event._id, teamId));
      const doc = await tx.teamMatchStats.getById(statDocKey(match._id, teamId));
      const sideKey = teamId === match.teamA ? 'A' : 'B';
      const lineup = lineupOf(match, sideKey);
      const rows = ((entry && entry.roster) || [])
        .filter(row => lineup.length === 0 || lineup.includes(row.userId));
      sides.push({
        teamId,
        roster: new Map(rows.map(row => [row.userId, row.name || row.userId])),
        doc,
        rows: [],
        players: [],
      });
    }

    // 条目数不可能超过「本场名单 × 节数」：超过即是构造的请求，先挡在解析之前。
    const rosterTotal = sides.reduce((sum, side) => sum + side.roster.size, 0);

    if (mode === STAT_MODE.DETAILED) {
      const incoming = Array.isArray(payload.rows) ? payload.rows : [];
      if (incoming.length === 0) return refused('没有可保存的统计');
      if (incoming.length > rosterTotal * periods) return refused('统计条目超出本场名单范围');
      // 一人一节只能有一条（见 statRowKey）。重复会让审核面板与榜单对不上，直接拒绝。
      const seen = new Set();
      for (const row of incoming) {
        const side = sides.find(item => item.roster.has(row && row.userId));
        if (!side) return refused('统计里有人不在本场名单中');
        const period = Number(row.period);
        if (!Number.isInteger(period) || period < 1 || period > periods) {
          return refused(`节次需在 1–${periods} 之间`);
        }
        const cleaned = { period, userId: row.userId };
        let any = false;
        for (const [field, max] of Object.entries(STAT_FIELDS)) {
          const parsed = parseStat(row[field], max);
          if (!parsed.ok) return refused(`第 ${period} 节的「${STAT_LABEL[field] || field}」需为 0–${max} 的整数`);
          cleaned[field] = parsed.value;
          if (parsed.value !== null) any = true;
        }
        // 整行都是空的等于没录这个人这一节，直接丢掉，不要存一排 null
        if (!any) continue;
        const key = `${side.teamId}#${statRowKey(cleaned, mode)}`;
        if (seen.has(key)) return refused(`同一球员的第 ${period} 节统计重复，请检查后重新提交`);
        seen.add(key);
        side.rows.push(cleaned);
      }
      if (sides.every(side => side.rows.length === 0)) return refused('没有可保存的统计');
    } else {
      const incoming = Array.isArray(payload.players) ? payload.players : [];
      if (incoming.length === 0) return refused('没有可保存的统计');
      if (incoming.length > rosterTotal) return refused('统计条目超出本场名单范围');
      // 一人一条（见 statRowKey）：重复行会让合计被算两遍
      const seen = new Set();
      for (const row of incoming) {
        const side = sides.find(item => item.roster.has(row && row.userId));
        if (!side) return refused('统计里有人不在本场名单中');
        const cleaned = { userId: row.userId };
        let any = false;
        for (const [field, max] of Object.entries(STAT_FIELDS)) {
          const parsed = parseStat(row[field], max);
          if (!parsed.ok) return refused(`${STAT_LABEL[field] || field}需为 0–${max} 的整数`);
          cleaned[field] = parsed.value;
          if (parsed.value !== null) any = true;
        }
        if (!any) continue;
        const key = `${side.teamId}#${statRowKey(cleaned, mode)}`;
        if (seen.has(key)) return refused('同一球员的统计重复，请检查后重新提交');
        seen.add(key);
        side.players.push(cleaned);
      }
      if (sides.every(side => side.players.length === 0)) return refused('没有可保存的统计');
    }

    // 乐观锁：两个队文档一起判，任一版本对不上就整笔不做
    for (const side of sides) {
      const current = Number(side.doc && side.doc.revision) || 0;
      if (Number.isInteger(payload.expectRevision) && payload.expectRevision !== current) {
        return refused('这场的统计刚被改过，请刷新后重试');
      }
    }

    const warnings = [];
    const now = fresh.now;
    const published = match.status === TEAM_MATCH_STATUS.PUBLISHED;
    // 已发布比赛的新版本是「待审核」；未发布比赛的统计只是草稿
    const status = published ? TEAM_STAT_STATUS.PENDING : TEAM_STAT_STATUS.DRAFT;

    for (const side of sides) {
      const key = statDocKey(match._id, side.teamId);
      const current = Number(side.doc && side.doc.revision) || 0;
      const rows = mode === STAT_MODE.DETAILED ? side.rows : [];
      const players = mode === STAT_MODE.DETAILED ? [] : side.players;
      const teamScore = side.teamId === match.teamA ? match.scoreA : match.scoreB;
      let integrity;

      if (mode === STAT_MODE.DETAILED) {
        const rosterIds = [...side.roster.keys()];
        const covered = new Set(rows.map(row => row.userId));
        integrity = rows.length === 0
          ? TEAM_STAT_INTEGRITY.NONE
          : (rosterIds.every(id => covered.has(id)) ? TEAM_STAT_INTEGRITY.FULL : TEAM_STAT_INTEGRITY.PARTIAL);
        const pointsTotal = totalsOf(rows).points;
        if (pointsTotal !== null && Number.isInteger(Number(teamScore)) && pointsTotal !== Number(teamScore)) {
          warnings.push(`第 ${side.teamId === match.teamA ? 'A' : 'B'} 队个人得分合计 ${pointsTotal}，球队 ${teamScore}，差 ${Number(teamScore) - pointsTotal} 分待归属`);
        }
      } else {
        const hasAny = side.players.some(row => Object.keys(STAT_FIELDS).some(f => row[f] !== null));
        integrity = hasAny ? TEAM_STAT_INTEGRITY.BASIC : TEAM_STAT_INTEGRITY.NONE;
        const pointsTotal = side.players.reduce((sum, row) => sum + (row.points || 0), 0);
        if (hasAny && side.players.some(row => row.points !== null)
          && Number.isInteger(Number(teamScore)) && pointsTotal !== Number(teamScore)) {
          warnings.push(`第 ${side.teamId === match.teamA ? 'A' : 'B'} 队个人得分合计 ${pointsTotal}，球队 ${teamScore}，差 ${Number(teamScore) - pointsTotal} 分待归属`);
        }
      }

      await tx.teamMatchStats.set(key, {
        _id: key,
        schoolId: ctx.schoolId,
        association: ctx.association,
        eventId: event._id,
        matchId: match._id,
        teamId: side.teamId,
        mode,
        rows,
        players,
        integrity,
        status,
        // 已发布快照原样保留：审核通过前，对外仍是上一版
        published: (side.doc && side.doc.published) || null,
        publishedRevision: Number(side.doc && side.doc.publishedRevision) || 0,
        publishedBy: side.doc ? side.doc.publishedBy || null : null,
        publishedAt: side.doc ? side.doc.publishedAt || null : null,
        revision: current + 1,
        updatedBy: fresh.actorId,
        updatedAt: now,
      });
    }

    return {
      ok: true, mode, status, warnings, needReview: published, message: '',
    };
  });
  return ok(result);
}

/**
 * 一届赛事的球员数据榜。
 *
 * 【为什么不落库】
 * 只统计「已发布」的比赛，从 `team_matches` + `team_match_stats` 现算。
 * 多一张赛季汇总表就多一次不一致的机会，而它没有任何写入方需要它——
 * 赛事一年才打几十场，现算的开销可以忽略。
 *
 * 【只读已发布快照】
 * 已发布比赛的统计改动进入待审核，榜单必须继续读 `published` 快照，
 * 这样「榜上的数字」与「公开页面看到的成绩」永远是同一版。
 *
 * 【未记录 ≠ 0】
 * 每个指标单独记「有值的场次」，一场都没记过就输出 null、页面显示 `—`。
 * 从前累加器从 0 起、无条件回填，只录得分的球员在篮板上显示 0 次——
 * 那既不是事实，也会把场均直接拉低。
 */
async function getTeamEventPlayerStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));

  // 三个集合都按赛事下推（2026-10-26 第四轮审查 P-4）：个人累计统计页原来
  // 把本协会**历年**比赛、统计与报名全部读回来再筛本届，随赛季线性变慢。
  const matches = (await repo.teamMatches.listByEvent(event._id))
    .filter(match => match.status === TEAM_MATCH_STATUS.PUBLISHED);
  const publishedIds = new Set(matches.map(match => match._id));
  const stats = (await repo.teamMatchStats.listByEvent(event._id))
    .filter(row => publishedIds.has(row.matchId) && row.published);
  const entries = await repo.teamEventEntries.listByEvent(event._id);

  const byPlayer = new Map();
  for (const doc of stats) {
    const snapshot = doc.published;
    if (!snapshot || snapshot.integrity === TEAM_STAT_INTEGRITY.NONE) continue;
    const rows = snapshot.mode === STAT_MODE.DETAILED
      ? uniqueRows(snapshot.rows, STAT_MODE.DETAILED)
      : uniqueRows((snapshot.players || []).map(player => ({ userId: player.userId, ...player })), STAT_MODE.BASIC);
    for (const row of rows) {
      if (!row || !row.userId) continue;
      if (!byPlayer.has(row.userId)) {
        const acc = { userId: row.userId, games: new Set(), fields: {} };
        for (const field of Object.keys(STAT_FIELDS)) acc.fields[field] = { sum: 0, games: new Set() };
        byPlayer.set(row.userId, acc);
      }
      const acc = byPlayer.get(row.userId);
      acc.games.add(doc.matchId);
      for (const field of Object.keys(STAT_FIELDS)) {
        if (!Number.isInteger(row[field])) continue;
        acc.fields[field].sum += row[field];
        acc.fields[field].games.add(doc.matchId);
      }
    }
  }

  const nameOf = (userId) => {
    for (const entry of entries) {
      const hit = ((entry.roster || []).find(row => row.userId === userId) || {}).name;
      if (hit) return hit;
    }
    return userId;
  };
  const teamOf = (userId) => {
    const entry = entries.find(item => (item.roster || []).some(row => row.userId === userId));
    return entry ? entry.teamId : '';
  };

  /** 数字与展示文本一起下发：页面不写下标取值，也不会把 null 渲染成 0 */
  const textOf = value => (Number.isInteger(value) ? String(value) : '—');
  const round1 = value => Math.round(value * 10) / 10;

  const players = [...byPlayer.values()]
    .map((acc) => {
      const out = {
        userId: acc.userId,
        name: nameOf(acc.userId),
        teamId: teamOf(acc.userId),
        games: acc.games.size,
      };
      for (const field of Object.keys(STAT_FIELDS)) {
        const cell = acc.fields[field];
        // 该指标一场都没记过 → null（未记录），不是 0
        const total = cell.games.size > 0 ? cell.sum : null;
        out[field] = total;
        out[`${field}Text`] = textOf(total);
        // 场均按「该指标有记录的场次」算，不按总场次摊薄
        out[`${field}PerGame`] = total === null ? null : round1(cell.sum / cell.games.size);
        out[`${field}PerGameText`] = total === null ? '—' : String(out[`${field}PerGame`]);
      }
      return out;
    })
    .sort((a, b) => {
      // 未记录的排在最后，不参与比较——把 null 当 0 会让「没统计」冒充「没得分」
      const pointsA = a.points === null ? -1 : a.points;
      const pointsB = b.points === null ? -1 : b.points;
      const reboundA = a.rebounds === null ? -1 : a.rebounds;
      const reboundB = b.rebounds === null ? -1 : b.rebounds;
      return (pointsB - pointsA) || (reboundB - reboundA)
        || compareCode(a.userId, b.userId);
    });

  return ok({ ok: true, players, matchCount: matches.length, message: '' });
}

/* ---------------- 个人与球队成绩 ---------------- */

/** 名次文案：前三名给常说的说法，其余按名次写 */
function placementTextOf(rank) {
  const value = Number(rank);
  if (!Number.isInteger(value) || value <= 0) return '';
  if (value === 1) return '冠军';
  if (value === 2) return '亚军';
  if (value === 3) return '季军';
  return `第 ${value} 名`;
}

/**
 * 结算时名次写在报名单（`entry.placement`）上；早期赛事只把名次写进
 * `event.placements`，这里兜一次，免得老数据在个人页上「一个荣誉都没有」。
 */
function placementOf(event, teamId, entry) {
  const direct = Number(entry && entry.placement);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const rows = (event && event.placements) || [];
  const hit = rows.find(row => row.teamId === teamId);
  return hit ? Number(hit.rank) || 0 : 0;
}

/**
 * 一支球队在若干场比赛里的胜负。
 *
 * 只认**已发布**的比赛：待审核的比分会改，把它算进战绩等于发布审核白做。
 * 没有 winner 的已发布比赛按平局记（只有循环赛允许平局）。
 */
function teamRecordOf(matches, teamId) {
  const out = { games: 0, wins: 0, losses: 0, draws: 0 };
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || match.status !== TEAM_MATCH_STATUS.PUBLISHED) continue;
    const isA = match.teamA === teamId;
    const isB = match.teamB === teamId;
    if (!isA && !isB) continue;
    out.games += 1;
    if (match.winner !== 'A' && match.winner !== 'B') {
      out.draws += 1;
      continue;
    }
    if ((match.winner === 'A' && isA) || (match.winner === 'B' && isB)) out.wins += 1;
    else out.losses += 1;
  }
  return out;
}

/** 战绩一句话，页面直接显示，不再自己拼字符串 */
function recordTextOf(record) {
  if (!record || record.games === 0) return '还没打完一场';
  const draw = record.draws > 0 ? ` · ${record.draws} 平` : '';
  return `${record.games} 场 · ${record.wins} 胜 ${record.losses} 负${draw}`;
}

/** 累计器：每个指标单独记「有记录的场次」，未记录 ≠ 0 */
function emptyStatAcc() {
  const fields = {};
  for (const field of Object.keys(STAT_FIELDS)) fields[field] = { sum: 0, games: new Set() };
  return { fields, matchIds: new Set() };
}

/** 累计器 → 数字 + 展示文本；某个指标一场都没记过就是 null 与「—」 */
function statCellsOf(acc) {
  const out = {};
  for (const field of Object.keys(STAT_FIELDS)) {
    const cell = acc.fields[field];
    const total = cell.games.size > 0 ? cell.sum : null;
    const perGame = total === null ? null : Math.round((cell.sum / cell.games.size) * 10) / 10;
    out[field] = total;
    out[`${field}Text`] = Number.isInteger(total) ? String(total) : '—';
    // 场均按「该指标有记录的场次」算，不拿没记的场次摊薄
    out[`${field}PerGame`] = perGame;
    out[`${field}PerGameText`] = perGame === null ? '—' : String(perGame);
    out[`${field}RecordedMatches`] = cell.games.size;
  }
  out.games = acc.matchIds.size;
  return out;
}

/**
 * 我的团队档案：我的球队 / 参赛经历 / 团队荣誉 / 跨赛事累计。
 *
 * 【为什么退队后历史还在】
 * 参赛经历读的是**报名快照**（`team_event_entries.roster`），不是「现在队里有谁」。
 * 人退队了，他当年那届比赛的事实没有变；按当前队员表算，会把历史抹掉。
 *
 * 【为什么别人的要看权限】
 * 这份数据带「哪届报了、拿了几名、个人数据」。队内谁被退回、谁没报名，
 * 属于当事人与管理者之间的事，路人不必都能翻。管理者可以代查。
 */
async function getMyTeamProfile(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const targetId = payload.userId ? String(payload.userId) : ctx.actorId;
  const manage = canManageAssociationSpace(ctx);
  if (targetId !== ctx.actorId && !manage) {
    return ok(refused('只能查看自己的团队成绩'));
  }

  const { teams: teamsRaw, members, entries, events, matches, statDocs, user } = await loadTeamProfileData(ctx, targetId);
  const teams = teamsRaw.filter(team => inScope(team, ctx));
  const teamById = new Map(teams.map(team => [team._id, team]));
  const eventById = new Map(events.map(event => [event._id, event]));
  const matchById = new Map(matches.map(match => [match._id, match]));
  const matchesByTeam = indexMatches(matches, 'team');
  const matchesByEvent = indexMatches(matches, 'eventId');
  const countByTeam = new Map();
  for (const row of members) if (row.status === TEAM_MEMBER_STATUS.ACTIVE) {
    countByTeam.set(row.teamId, (countByTeam.get(row.teamId) || 0) + 1);
  }
  const nameOf = () => (user && (user.nickName || user.realName)) || targetId;
  const memberCountOf = teamId => countByTeam.get(teamId) || 0;

  /* 我的球队：当前在队 + 已离队的历史（离队的不抹掉，只标状态） */
  const myMemberships = members.filter(row => row.userId === targetId && teamById.has(row.teamId));
  const myTeams = myMemberships
    .map((row) => {
      const team = teamById.get(row.teamId);
      const record = teamRecordOf(
        (matchesByTeam.get(team._id) || []),
        team._id
      );
      return {
        teamId: team._id,
        name: team.name,
        isCaptain: team.captainId === targetId,
        roleLabel: team.captainId === targetId ? '队长' : '队员',
        status: team.status,
        statusLabel: TEAM_STATUS_LABEL[team.status] || team.status,
        memberStatus: row.status,
        memberStatusLabel: TEAM_MEMBER_STATUS_LABEL[row.status] || row.status,
        current: row.status === TEAM_MEMBER_STATUS.ACTIVE,
        memberCount: memberCountOf(team._id),
        joinedAt: row.joinedAt || null,
        record,
        recordText: recordTextOf(record),
      };
    })
    .sort((a, b) => (Number(b.current) - Number(a.current)) || String(a.name).localeCompare(String(b.name)));

  /* 参赛经历：按报名快照算，退队后仍在 */
  const playedEntries = entries.filter(
    entry => Array.isArray(entry.roster) && entry.roster.some(row => row.userId === targetId)
  );
  const eventRows = playedEntries
    .map((entry) => {
      const event = eventById.get(entry.eventId);
      if (!event || event.status === TEAM_EVENT_STATUS.DRAFT) return null;
      const team = teamById.get(entry.teamId);
      const record = teamRecordOf(
        (matchesByEvent.get(event._id) || []),
        entry.teamId
      );
      const rank = placementOf(event, entry.teamId, entry);
      return {
        eventId: event._id,
        name: event.name,
        status: event.status,
        statusLabel: TEAM_EVENT_STATUS_LABEL[event.status] || event.status,
        teamId: entry.teamId,
        teamName: (team && team.name) || '已归档球队',
        entryStatusLabel: TEAM_ENTRY_STATUS_LABEL[entry.status] || entry.status,
        placement: rank || null,
        placementText: placementTextOf(rank),
        games: record.games,
        wins: record.wins,
        losses: record.losses,
        draws: record.draws,
        recordText: recordTextOf(record),
        createdAt: event.createdAt || null,
        finishedAt: event.finishedAt || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareCode(b.createdAt, a.createdAt));

  // 团队荣誉：只算前三名。第四名也是成绩，但「荣誉」在校园语境里就是冠亚季
  const honors = eventRows
    .filter(row => Number(row.placement) >= 1 && Number(row.placement) <= 3)
    .map(row => ({
      eventId: row.eventId,
      eventName: row.name,
      teamId: row.teamId,
      teamName: row.teamName,
      placement: row.placement,
      placementText: row.placementText,
      finishedAt: row.finishedAt,
    }));

  /* 跨赛事累计：只算已发布的比赛，且按赛事分组，避免不同届混算 */
  const publishedIds = new Set(
    matches.filter(match => match.status === TEAM_MATCH_STATUS.PUBLISHED).map(match => match._id)
  );
  const total = emptyStatAcc();
  const byEvent = new Map();
  for (const doc of statDocs) {
    if (!publishedIds.has(doc.matchId)) continue;
    const snapshot = doc.published;
    if (!snapshot || snapshot.integrity === TEAM_STAT_INTEGRITY.NONE) continue;
    const rows = snapshot.mode === STAT_MODE.DETAILED
      ? (snapshot.rows || [])
      : (snapshot.players || []);
    const mine = rows.filter(row => row && row.userId === targetId);
    if (mine.length === 0) continue;

    const eventId = doc.eventId || (matchById.get(doc.matchId) || {}).eventId;
    if (!byEvent.has(eventId)) byEvent.set(eventId, emptyStatAcc());
    const buckets = [total, byEvent.get(eventId)];
    for (const bucket of buckets) {
      bucket.matchIds.add(doc.matchId);
      for (const row of mine) {
        for (const field of Object.keys(STAT_FIELDS)) {
          if (!Number.isInteger(row[field])) continue;
          bucket.fields[field].sum += row[field];
          bucket.fields[field].games.add(doc.matchId);
        }
      }
    }
  }

  const statEvents = [...byEvent.entries()]
    .map(([eventId, acc]) => {
      const event = eventById.get(eventId);
      const entry = playedEntries.find(item => item.eventId === eventId);
      const team = entry ? teamById.get(entry.teamId) : null;
      return {
        eventId,
        name: (event && event.name) || '已删除赛事',
        teamName: (team && team.name) || '',
        ...statCellsOf(acc),
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  /* 球队层面的总战绩：按「报名过的每一届」累加，一队一届只算一次 */
  const teamTotals = { games: 0, wins: 0, losses: 0, draws: 0 };
  for (const entry of playedEntries) {
    const event = eventById.get(entry.eventId);
    if (!event || event.status === TEAM_EVENT_STATUS.DRAFT) continue;
    const record = teamRecordOf((matchesByEvent.get(event._id) || []), entry.teamId);
    teamTotals.games += record.games;
    teamTotals.wins += record.wins;
    teamTotals.losses += record.losses;
    teamTotals.draws += record.draws;
  }

  // 球队参加过的场次与本人实际出场分开。
  //
  // 【出场的两个证据】
  //   1. 这一场定过出场名单，且名单里有我；
  //   2. 这一场有我的个人统计（统计只在某一项真的填了数字时才落行，见
  //      saveTeamMatchStats / writeLiveStats，所以「有行」本身就是上场的事实）。
  // 两处取并集。只认名单会把「录了分却没定名单」的比赛全部算成没上场——
  // 计分台在没定名单时按整份报名名单录分，这正是「已记录出场 0」的来源。
  // 两处都没有的场次仍然不推定出场（没有证据就不编）。
  const statMatchIds = new Set();
  for (const doc of statDocs) {
    if (!publishedIds.has(doc.matchId)) continue;
    const snapshot = doc.published;
    if (!snapshot || snapshot.integrity === TEAM_STAT_INTEGRITY.NONE) continue;
    const rows = snapshot.mode === STAT_MODE.DETAILED
      ? (snapshot.rows || [])
      : (snapshot.players || []);
    const appeared = rows.some(row => row && row.userId === targetId
      && Object.keys(STAT_FIELDS).some(field => Number.isInteger(row[field])));
    if (appeared) statMatchIds.add(doc.matchId);
  }

  const eligibleMatches = matches.filter(match => match.status === TEAM_MATCH_STATUS.PUBLISHED
    && playedEntries.some(entry => entry.status === TEAM_ENTRY_STATUS.LOCKED && entry.eventId === match.eventId
      && [match.teamA, match.teamB].includes(entry.teamId)));
  let appearanceGames = 0;
  let lineupRecordedMatches = 0;
  let statOnlyAppearanceGames = 0;
  // 按赛事累计同一份出场口径：参赛经历里每一行都要显示「本项赛事出场几场」，
  // 否则「报名了 3 项赛事、顶部只记 1 场出场」看起来就是数字对不上。
  const appearanceByEvent = new Map();
  for (const match of eligibleMatches) {
    const entry = playedEntries.find(row => row.eventId === match.eventId && [match.teamA, match.teamB].includes(row.teamId));
    if (!entry) continue;
    const lineup = lineupOf(match, entry.teamId === match.teamA ? 'A' : 'B');
    const inLineup = lineup.includes(targetId);
    const hasStat = statMatchIds.has(match._id);
    if (lineup.length) lineupRecordedMatches += 1;
    const appeared = inLineup || hasStat;
    if (appeared) appearanceGames += 1;
    if (!inLineup && hasStat) statOnlyAppearanceGames += 1;
    const perEvent = appearanceByEvent.get(match.eventId) || { eligibleMatchCount: 0, appearedMatches: 0 };
    perEvent.eligibleMatchCount += 1;
    if (appeared) perEvent.appearedMatches += 1;
    appearanceByEvent.set(match.eventId, perEvent);
  }
  const noAppearance = { eligibleMatchCount: 0, appearedMatches: 0 };
  for (const row of eventRows) Object.assign(row, appearanceByEvent.get(row.eventId) || noAppearance);

  return ok({
    ok: true,
    sportFormat: 'basketball5',
    userId: targetId,
    name: nameOf(targetId),
    isSelf: targetId === ctx.actorId,
    teams: myTeams,
    events: eventRows,
    honors,
    statEvents,
    totals: { ...statCellsOf(total), ...teamTotals, appearanceGames, lineupRecordedMatches,
      statOnlyAppearanceGames,
      eligibleMatchCount: eligibleMatches.length, recordText: recordTextOf(teamTotals) },
    message: '',
  });
}

/**
 * 球队战绩：一支球队的历史参赛与胜负。
 *
 * 【为什么归档后还要能查】
 * 「归档」只是不再接新队员、不再报名，历史成绩是别人查得到的公开事实。
 * 把归档球队的战绩页一起关掉，等于把往届冠军从记录里抹掉。
 */
async function getTeamRecord(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!supportsMatchData(ctx)) return ok(refused('该运动的录分、名单及统计功能尚未开放'));

  const repo = ctx.repo.forScope(ctx);
  let team = await repo.teams.getById(payload.teamId);
  // 院队编号来自学院目录：直接分享链接打开战绩页时，记录可能还没落库
  if (!inScope(team, ctx)) {
    const resolved = await resolveCollegeTeam(payload.teamId, ctx);
    if (resolved.ok) team = resolved.team;
  }
  if (!inScope(team, ctx)) return ok(refused('球队不存在，或不在本协会'));

  // 【按队收窄，不再读本协会历年全量】（2026-10-27 第八轮审查 P1-4）
  // 原实现一次读 teamEvents / teamEventEntries / teamMatches / teamMembers /
  // teams 五个集合，外加 buildDirectory（全校名册 + 账号）——只为一个队的战绩页。
  // 读量与协会历史总量成正比：届数越多、队伍越多，翻页越多，最后撞云函数超时。
  // 现在先按队取报名，得到「这支队参加过的届」，再按编号批读赛事与对手队名：
  // 读量只与这支队自己的参赛史成正比。
  const [entries, members, teamMatches] = await Promise.all([
    repo.teamEventEntries.listByTeam(team._id),
    repo.teamMembers.listByTeams([team._id]),
    repo.teamMatches.listByTeams([team._id]),
  ]);
  const eventIds = [...new Set(entries.map(entry => entry.eventId).filter(Boolean))];
  const opponentIds = [...new Set(
    teamMatches.flatMap(match => [match.teamA, match.teamB])
      .filter(id => typeof id === 'string' && id && id !== team._id),
  )];
  const [events, opponents, accounts] = await Promise.all([
    eventIds.length ? repo.teamEvents.listByIds(eventIds) : Promise.resolve([]),
    opponentIds.length ? repo.teams.listByIds(opponentIds) : Promise.resolve([]),
    // 只要「队长 + 本队队员」的昵称：原先借 buildDirectory 读全校名册（20 页）
    // 只为取几个名字，现在按编号批读账号（1 次 `_.in`）。
    (() => {
      const ids = [...new Set([team.captainId, ...members.map(row => row.userId)]
        .filter(id => typeof id === 'string' && id))];
      return ids.length ? ctx.repo.users.listByIds(ids) : Promise.resolve([]);
    })(),
  ]);
  const eventById = new Map(events.map(event => [event._id, event]));
  const teamName = new Map([[team._id, team.name], ...opponents.map(row => [row._id, row.name])]);
  const accountById = new Map(accounts.map(user => [user._id, user]));
  const nameOf = (userId) => {
    const user = accountById.get(userId);
    return (user && (user.nickName || user.realName)) || '';
  };

  const overall = teamRecordOf(teamMatches, team._id);
  const seasons = entries
    .filter(entry => entry.teamId === team._id)
    .map((entry) => {
      const event = eventById.get(entry.eventId);
      // 草稿赛事不对外：它可能只是管理员试建的一张空壳
      if (!event || event.status === TEAM_EVENT_STATUS.DRAFT) return null;
      const record = teamRecordOf(
        teamMatches.filter(match => match.eventId === event._id),
        team._id
      );
      const rank = placementOf(event, team._id, entry);
      return {
        eventId: event._id,
        name: event.name,
        status: event.status,
        statusLabel: TEAM_EVENT_STATUS_LABEL[event.status] || event.status,
        placement: rank || null,
        placementText: placementTextOf(rank),
        games: record.games,
        wins: record.wins,
        losses: record.losses,
        draws: record.draws,
        recordText: recordTextOf(record),
        createdAt: event.createdAt || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareCode(b.createdAt, a.createdAt));

  // 近期战绩：只列已发布的，比分是定稿的那一版
  const recent = teamMatches
    .filter(match => match.status === TEAM_MATCH_STATUS.PUBLISHED)
    .sort((a, b) => compareCode(b.matchTime || b.recordedAt, a.matchTime || a.recordedAt))
    .slice(0, 10)
    .map((match) => {
      const isA = match.teamA === team._id;
      const opponentId = isA ? match.teamB : match.teamA;
      const mine = isA ? match.scoreA : match.scoreB;
      const other = isA ? match.scoreB : match.scoreA;
      let result = 'draw';
      if (match.winner === 'A' || match.winner === 'B') {
        result = (match.winner === 'A') === isA ? 'win' : 'loss';
      }
      const event = eventById.get(match.eventId);
      return {
        matchId: match._id,
        opponentName: teamName.get(opponentId) || '已归档球队',
        eventName: (event && event.name) || '',
        scoreText: `${mine} : ${other}`,
        result,
        resultLabel: result === 'win' ? '胜' : (result === 'loss' ? '负' : '平'),
        matchTimeText: matchTimeText(match.matchTime),
      };
    });

  const winRate = overall.games > 0 ? Math.round((overall.wins / overall.games) * 100) : null;
  return ok({
    ok: true,
    team: {
      teamId: team._id,
      name: team.name,
      status: team.status,
      statusLabel: TEAM_STATUS_LABEL[team.status] || team.status,
      archived: team.status === TEAM_STATUS.ARCHIVED,
      captainName: nameOf(team.captainId),
      memberCount: members.filter(
        row => row.teamId === team._id && row.status === TEAM_MEMBER_STATUS.ACTIVE
      ).length,
    },
    overall: { ...overall, winRate, winRateText: winRate === null ? '—' : `${winRate}%`, recordText: recordTextOf(overall) },
    seasons,
    recent,
    message: '',
  });
}

/* ---------------- 篮球单人实时计分（与个人统计、正式发布隔离） ---------------- */

/** 事务内按固定主键读报名快照与统计，禁止用当前球队成员替代比赛名单。 */
async function liveStatContext(tx, match, event) {
  return Promise.all(['A', 'B'].map(async side => {
    const teamId = side === 'A' ? match.teamA : match.teamB;
    const [entry, doc] = await Promise.all([
      tx.teamEventEntries.getById(entryKey(event._id, teamId)),
      tx.teamMatchStats.getById(statDocKey(match._id, teamId)),
    ]);
    const lineup = lineupOf(match, side);
    const players = ((entry && entry.roster) || [])
      .filter(row => lineup.length === 0 || lineup.includes(row.userId))
      .map(row => ({ userId: row.userId, name: row.name || row.userId,
        no: Number.isInteger(row.no) ? row.no : null }));
    return { side, teamId, players, doc };
  }));
}

/** 保留先前填写的统计。已有整场统计继续按整场累计，不擅自分摊到某一节。 */
function integrateLiveStats(state, event, context) {
  const populated = context.filter(({ doc }) => doc && [...(doc.rows || []), ...(doc.players || [])]
    .some(row => Object.keys(STAT_FIELDS).some(field => Number.isInteger(row[field]))));
  const statMode = populated.some(({ doc }) => doc.mode !== STAT_MODE.DETAILED)
    ? STAT_MODE.BASIC : (event.statPolicy === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC);
  const playerRows = [];
  for (const side of context) {
    const doc = side.doc;
    if (!doc) continue;
    const byPlayer = doc.mode === STAT_MODE.DETAILED ? totalsByPlayer(doc.rows || []) : null;
    const rows = statMode === STAT_MODE.DETAILED ? (doc.rows || [])
      : side.players.map(player => ({ userId: player.userId,
        ...(byPlayer ? byPlayer.get(player.userId) : (doc.players || []).find(row => row.userId === player.userId)) }));
    for (const row of rows) {
      if (!side.players.some(player => player.userId === row.userId)) continue;
      if (!Object.keys(STAT_FIELDS).some(field => Number.isInteger(row[field]))) continue;
      const clean = { side: side.side, userId: row.userId,
        period: statMode === STAT_MODE.DETAILED ? Number(row.period) : 0 };
      for (const field of Object.keys(STAT_FIELDS)) clean[field] = Number.isInteger(row[field]) ? row[field] : null;
      playerRows.push(clean);
    }
  }
  return { ...state, statMode, playerRows, statsIntegrated: true };
}

/** 旧实时比赛首次迁移也只取名单前五人；此后换人持久化，不随重进重置。 */
function ensureLiveCourt(state, context) {
  if (state.onCourt) return state;
  return { ...state, onCourt: Object.fromEntries(context.map(side => [side.side,
    side.players.slice(0, 5).map(player => player.userId)])) };
}

/** 比分、统计与撤销一起提交。草稿沿用既有发布审核链路，不直接更新个人榜。 */
async function writeLiveStats(tx, match, state, context, fresh) {
  const revision = Math.max(...context.map(side => Number(side.doc && side.doc.revision) || 0)) + 1;
  for (const side of context) {
    const values = state.playerRows.filter(row => row.side === side.side).map(row => {
      const clean = { userId: row.userId };
      if (state.statMode === STAT_MODE.DETAILED) clean.period = row.period;
      for (const field of Object.keys(STAT_FIELDS)) clean[field] = Number.isInteger(row[field]) ? row[field] : null;
      return clean;
    });
    const key = statDocKey(match._id, side.teamId);
    await tx.teamMatchStats.set(key, { ...(side.doc || {}), _id: key,
      schoolId: fresh.schoolId, association: fresh.association, eventId: match.eventId,
      matchId: match._id, teamId: side.teamId, mode: state.statMode,
      rows: state.statMode === STAT_MODE.DETAILED ? values : [],
      players: state.statMode === STAT_MODE.BASIC ? values : [],
      integrity: values.length === 0 ? TEAM_STAT_INTEGRITY.NONE
        : (state.statMode === STAT_MODE.BASIC ? TEAM_STAT_INTEGRITY.BASIC : TEAM_STAT_INTEGRITY.PARTIAL),
      status: TEAM_STAT_STATUS.DRAFT, revision, updatedBy: fresh.actorId, updatedAt: fresh.now });
  }
}

async function liveWriteTarget(root, ctx, matchId) {
  const fresh = await freshContext(root, ctx);
  if (!fresh.actorId || !canReadAssociationSpace(fresh) || !assertTeamSport(fresh)) {
    return { error: '没有本协会的计分权限' };
  }
  const tx = root.forScope(fresh);
  const match = await tx.teamMatches.getById(matchId);
  if (!inScope(match, fresh)) return { error: '比赛不存在，或不在本协会' };
  const event = await tx.teamEvents.getById(match.eventId);
  if (!inScope(event, fresh) || ![TEAM_EVENT_STATUS.SCHEDULED, TEAM_EVENT_STATUS.RUNNING].includes(event.status)) {
    return { error: '赛事当前不可计分' };
  }
  const strategy = teamSportStrategyFor(fresh.association, event);
  if (!strategy || !strategy.supportsLiveScore
    || (match.sportFormat !== undefined && match.sportFormat !== strategy.sportFormat)) {
    return { error: '该运动不支持实时计分' };
  }
  if (!(await canRecordTeamMatch(match, fresh, tx))) return { error: '你无权为这场比赛计分' };
  return { fresh, tx, match, event };
}

/** 建立 / 恢复计分台。一场一份实时态，仍放在独立的团队比赛集合。 */
async function startTeamLiveScore(payload = {}, ctx) {
  if (!ctx.actorId || typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少登录身份或比赛编号'));
  return ok(await ctx.repo.transaction(async root => {
    const target = await liveWriteTarget(root, ctx, payload.matchId);
    if (target.error) return refused(target.error);
    const { tx, match, event, fresh } = target;
    if (![TEAM_MATCH_STATUS.SCHEDULED, TEAM_MATCH_STATUS.LIVE].includes(match.status)
      && !(match.liveScore && match.liveScore.submittedAt
        && [TEAM_MATCH_STATUS.REVIEWING, TEAM_MATCH_STATUS.PUBLISHED].includes(match.status))) {
      return refused('只有未开赛或进行中的比赛可以进入实时计分台');
    }
    // 事务内不并发：云开发要求对同一事务对象的操作串行，Promise.all 会同时发起两次读。
    // 本地内存仓储是同步 Map，照不出问题；云端可能撞事务冲突，而这条路径正是「开计分台」
    // 的第一步，失败就进不去（2026-10-28 审计 2 C-2）。
    const teamA = await tx.teams.getById(match.teamA);
    const teamB = await tx.teams.getById(match.teamB);
    const statContext = await liveStatContext(tx, match, event);
    let state = match.liveScore;
    if (match.status === TEAM_MATCH_STATUS.SCHEDULED || !state) {
      state = { ...createBasketballLive(event.rules),
        revision: state ? Number(state.revision) + 1 : 0, startedBy: fresh.actorId, startedAt: fresh.now };
      state = ensureLiveCourt(integrateLiveStats(state, event, statContext), statContext);
      await tx.teamMatches.set(match._id, { ...match, status: TEAM_MATCH_STATUS.LIVE, liveScore: state,
        revision: (Number(match.revision) || 0) + 1, updatedAt: fresh.now });
      if (event.status === TEAM_EVENT_STATUS.SCHEDULED) {
        await tx.teamEvents.set(event._id, { ...event, status: TEAM_EVENT_STATUS.RUNNING,
          revision: (Number(event.revision) || 0) + 1, updatedAt: fresh.now });
      }
    } else if (!state.statsIntegrated || !state.onCourt) {
      state = ensureLiveCourt(state.statsIntegrated ? state : integrateLiveStats(state, event, statContext), statContext);
      await tx.teamMatches.set(match._id, { ...match, liveScore: state });
    } else if (state.submittedAt) {
      // 完赛后补录过统计时，只读计分台也使用最新工作副本。
      state = integrateLiveStats(state, event, statContext);
    }
    return { ok: true, matchId: match._id, eventId: event._id, actorId: fresh.actorId,
      allowDraw: Boolean(event.format === EVENT_FORMAT.ROUND_ROBIN && event.rules && event.rules.allowDraw),
      teamAName: (teamA && teamA.name) || 'A 队', teamBName: (teamB && teamB.name) || 'B 队',
      rosters: statContext.map(({ side, players }) => ({ side, players })),
      live: basketballLiveView(state), message: '' };
  }));
}

/** 一次点击一个 operationId；即使撤销后重试旧请求，也不能把旧分重新加回来。 */
async function updateTeamLiveScore(payload = {}, ctx) {
  if (!ctx.actorId || typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少登录身份或比赛编号'));
  if (typeof payload.operationId !== 'string' || !REQUEST_ID_PATTERN.test(payload.operationId)) {
    return ok(refused('计分操作编号无效'));
  }
  return ok(await ctx.repo.transaction(async root => {
    const target = await liveWriteTarget(root, ctx, payload.matchId);
    if (target.error) return refused(target.error);
    const { tx, match, event, fresh } = target;
    let current = match.liveScore;
    if (!current) return refused('请先开启实时计分台');
    // 先幂等，再核版本与状态：已保存但回执丢失的结束请求，也可以安全重发。
    if ((current.operationIds || []).includes(payload.operationId)) {
      return { ok: true, live: basketballLiveView(current), message: '' };
    }
    if (match.status !== TEAM_MATCH_STATUS.LIVE || current.submittedAt) return refused('本场已结束实时计分');
    if (!Number.isInteger(payload.expectRevision) || payload.expectRevision !== current.revision) {
      return refused('比分已变化，请重新载入后再操作', { code: 'LIVE_CONFLICT' });
    }
    if ((current.operationIds || []).length >= 4000 && payload.type !== 'finish') return refused('本场操作次数已达上限，请联系管理员');
    const statContext = await liveStatContext(tx, match, event);
    if (!current.statsIntegrated) current = integrateLiveStats(current, event, statContext);
    current = ensureLiveCourt(current, statContext);
    if (payload.userId) {
      const side = statContext.find(item => item.side === payload.side);
      if (!side || !side.players.some(player => player.userId === payload.userId)) {
        return refused('请选择本队出场名单中的球员');
      }
      if (!(current.onCourt[payload.side] || []).includes(payload.userId)) {
        return refused('该球员不在场上，请先通过换人上场');
      }
    }
    if (payload.type === 'substitute') {
      const side = statContext.find(item => item.side === payload.side);
      if (!side || !side.players.some(player => player.userId === payload.inId)) {
        return refused('换上球员必须在本队出场名单中');
      }
    }
    let next;
    let patch = {};
    if (payload.type === 'finish') {
      if (current.period < current.regulationPeriods) return refused('请先完成常规节次');
      if (current.scoreA === 0 && current.scoreB === 0) return refused('0:0 不能提交为完赛比分');
      const allowDraw = event.format === EVENT_FORMAT.ROUND_ROBIN && event.rules && event.rules.allowDraw;
      if (current.scoreA === current.scoreB && !allowDraw) return refused('比分相同，请进入加时继续计分');
      next = { ...current, revision: current.revision + 1, submittedAt: fresh.now };
      patch = { status: TEAM_MATCH_STATUS.REVIEWING, scoreA: current.scoreA, scoreB: current.scoreB,
        winner: current.scoreA === current.scoreB ? null : (current.scoreA > current.scoreB ? 'A' : 'B'),
        overtime: current.period > current.regulationPeriods, forfeit: null,
        periods: current.periods.map(row => ({ ...row })), recordedBy: fresh.actorId, recordedAt: fresh.now };
    } else {
      try { next = applyBasketballOperation(current, payload); }
      catch (err) { return refused(err.message); }
    }
    next.operationIds = [...(current.operationIds || []), payload.operationId];
    next.updatedBy = fresh.actorId;
    next.updatedAt = fresh.now;
    if (JSON.stringify(next.playerRows) !== JSON.stringify(current.playerRows)) {
      await writeLiveStats(tx, match, next, statContext, fresh);
    }
    await tx.teamMatches.set(match._id, { ...match, ...patch, liveScore: next,
      revision: (Number(match.revision) || 0) + 1, updatedAt: fresh.now });
    return { ok: true, live: basketballLiveView(next), message: '' };
  }));
}

/**
 * 观众读摘要，不下发操作流水；待审核分数仍沿用既有可见性规则。
 *
 * 【为什么整批读，而不是逐场点读】（2026-10-26 第五轮审查 A）
 * 这个接口被 `live-watch` **每 2 秒**打一次，原来的实现是「每场点读比赛 → 再点读
 * 它所属赛事 → 再为判队长点读两支球队」：50 场就是最多 50 + 50 + 100 = 200 次
 * RPC/拍。而同一届赛事的 50 场共用**一个** eventId、球队更是反复出现——重复读了
 * 几十遍同一份文档。按 32 场淘汰赛算，一个观众页开着就是 ~3800 读/分钟，
 * 8 分钟就能吃掉全校一天的读配额。
 *
 * 现在三个集合各一次 `_.in`：
 *   1. 比赛按编号批读（`listByIds`，自带范围条件）；
 *   2. 赛事按去重后的 eventId 批读；
 *   3. 球队**只在真要判队长时才读**——管理员与被指派的记录员在这一步之前就返回了。
 * 200 次 → 通常 2~3 次。订单（scores 顺序）仍按入参 ids 走，客户端按 matchId 取用。
 */
async function getTeamLiveScores(payload = {}, ctx) {
  if (!ctx.actorId || !canReadAssociationSpace(ctx) || !assertTeamSport(ctx)) return ok(refused('没有本协会的读取权限'));
  const strategy = teamSportStrategyFor(ctx.association);
  if (!strategy || !strategy.supportsLiveScore) return ok(refused('该运动不支持实时计分'));
  const ids = [...new Set((Array.isArray(payload.matchIds) ? payload.matchIds : [])
    .filter(id => typeof id === 'string' && id))];
  if (ids.length > 50) return ok(refused('一次最多查询 50 场比赛'));
  if (ids.length === 0) return ok({ ok: true, scores: [], message: '' });
  const repo = ctx.repo.forScope(ctx);

  const matches = new Map((await repo.teamMatches.listByIds(ids))
    .filter(match => inScope(match, ctx))
    .map(match => [match._id, match]));
  if (matches.size === 0) return ok({ ok: true, scores: [], message: '' });

  const eventIds = [...new Set([...matches.values()].map(match => match.eventId).filter(Boolean))];
  const events = new Map((await repo.teamEvents.listByIds(eventIds)).map(event => [event._id, event]));

  // 队长的判定要读球队，但只有「既不是管理员、也不是本场记录员」的场次才用得上。
  const manage = canManageAssociationSpace(ctx);
  const needCaptain = [...matches.values()].filter(match => !manage && match.recorderId !== ctx.actorId);
  const teamIds = [...new Set(needCaptain
    .flatMap(match => [match.teamA, match.teamB])
    .filter(id => typeof id === 'string' && id))];
  const teams = new Map((await repo.teams.listByIds(teamIds)).map(team => [team._id, team]));
  const captainOfMe = match => [match.teamA, match.teamB].some((teamId) => {
    const team = teams.get(teamId);
    return Boolean(team) && inScope(team, ctx) && team.captainId === ctx.actorId;
  });

  const scores = [];
  for (const id of ids) {
    const match = matches.get(id);
    if (!match) continue;
    const event = events.get(match.eventId);
    const matchStrategy = inScope(event, ctx) && teamSportStrategyFor(ctx.association, event);
    if (!matchStrategy || !matchStrategy.supportsLiveScore
      || (match.sportFormat !== undefined && match.sportFormat !== matchStrategy.sportFormat)) continue;
    const editor = manage || Boolean(match.recorderId && match.recorderId === ctx.actorId) || captainOfMe(match);
    const view = matchView(match, null, { canRecord: editor, canSeePending: editor });
    scores.push({ matchId: id, live: view.live, scoreText: view.scoreText,
      scoreA: view.scoreA, scoreB: view.scoreB, overtime: view.overtime, forfeit: view.forfeit, winner: view.winner,
      status: view.status, statusLabel: view.statusLabel, revision: view.revision,
      pointsA: view.live ? view.live.scoreA : null, pointsB: view.live ? view.live.scoreB : null,
      finished: [TEAM_MATCH_STATUS.PUBLISHED, TEAM_MATCH_STATUS.CANCELED].includes(match.status) });
  }
  return ok({ ok: true, scores, message: '' });
}

module.exports = {
  startTeamLiveScore, updateTeamLiveScore, getTeamLiveScores,
  listTeamEvents,
  getTeamEvent,
  createTeamEvent,
  submitTeamEntry,
  reviewTeamEntry,
  lockTeamEntries,
  drawTeamEvent,
  listTeamMatches,
  recordTeamMatch,
  publishTeamMatch,
  advanceTeamRound,
  settleTeamEvent,
  getTeamMatchStats,
  saveTeamMatchStats,
  reviewTeamMatchStats,
  getTeamEventPlayerStats,
  getTeamMatchSchedule,
  updateTeamMatchSchedule,
  updateTeamRoundSchedule,
  getTeamEntryRoster,
  getTeamMatchLineup,
  saveTeamMatchLineup,
  // 个人与球队成绩
  getMyTeamProfile,
  getTeamRecord,
};

// 足球复用协议和门面，独立校验比分/名单/统计；篮球仍执行原有实现。
for (const [name, implementation] of Object.entries({ ...football, ...footballSchedule })) {
  if (!Object.prototype.hasOwnProperty.call(module.exports, name)) continue;
  const original = module.exports[name];
  module.exports[name] = (payload = {}, ctx) => football.isFootball(ctx)
    ? implementation(payload, ctx) : original(payload, ctx);
}
