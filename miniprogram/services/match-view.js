/**
 * 比赛页的视图模型
 * ============================================================
 * 比赛页要做的事比「我的」页更敏感：它不只展示成绩，还让人确认、驳回
 * 成绩。因此这里的重点是**把权限算在视图模型里**，页面拿到的每一行
 * 都自带 canConfirm 等旗标，页面只负责照着渲染按钮。
 *
 * 【为什么权限不上页面】
 * 页面上写 `wx:if="{{item.status === 0 && item.side !== 'A'}}"` 这种条件，
 * 一是把业务规则散进了模板（改规则要翻 wxml），二是没法测试——Node 跑不了
 * 模板。规则全部来自 match-record.js，这里只是把结果放进行数据里。
 *
 * 【本模块现在只剩纯构建器】
 * 取数那一段（loadMatchView，读协议 1 台账）已在 P10 合并批里随协议 1 一并
 * 删除：页面走 school-match-view.js 的 loadSchoolMatchView，取数经 S2 的
 * listSchoolMatches（含「待确认」「已撤销」这些 getMatches 给不出的状态）。
 * 这里保留的是被 S2 装载器与学院赛 / 赛事视图共用的纯构建器与常量。
 *
 * 【确认权的演示口径】
 * 逐行比对「放宽后的权限」与「严格口径的权限」，只要两者不一致就置
 * confirmRelaxed——文案的触发条件是算出来的，不是靠页面猜的。注意 S2 的
 * matchSummary **不再放宽**确认（演示数据源也一样严格），因此 confirmRelaxed
 * 在 S2 链路上恒为假；这里保留是为了纯构建器语义完整，并由
 * tests/school-match-view.test.js 守着「别把放宽悄悄加回来」。
 * ============================================================
 */

const {
  MATCH_STATUS,
  MATCH_STATUS_LABEL,
  MATCH_TYPE_LABEL,
  ROLE,
  courtNoTextOf,
} = require('../shared/utils/constants.js');
const { formatDateTime, formatScore } = require('../shared/utils/format.js');
const { formatMatchFormat, formatOfRecord } = require('../shared/utils/match-format.js');
const { createNameResolver } = require('../shared/utils/stats.js');
const { describeLive } = require('./live-view.js');
const {
  canAssignReferee,
  canConfirm,
  canForfeit,
  canRecordScore,
  hasReferee,
  needsScore,
  sideOf,
} = require('../shared/services/match-record.js');
// 运行模式取中立模块，不经协议 1 门面（P10-a）。本模块剩下的唯一用途是
// buildRecordRow 的 isMock 缺省值——S2 装载器都显式传 isMock:false，
// 这里只是给「忘了传」的场景兜一个与当前数据源一致的底。
const { isMockNow } = require('./runtime-mode.js');

/**
 * 页面上的两个标签页。
 *
 * 【为什么没有「全部比赛」】
 * 台账里有六百多场，绝大多数与看的人无关。全量列表既刷不动，也答不了
 * 「接下来要做什么」。只留「我的比赛」与「待确认」，让每个人看到的都是
 * 与自己有关的那些场次。
 */
const TAB = {
  MINE: 'mine', // 我的比赛
  PENDING: 'pending', // 待我确认的
};

const TAB_LABEL = {
  [TAB.MINE]: '我的比赛',
  [TAB.PENDING]: '待确认',
};

/** 空态文案按标签页区分。「没有比赛」和「没有待确认的比赛」是两回事 */
const TAB_EMPTY = {
  [TAB.MINE]: '你还没有参加过比赛',
  [TAB.PENDING]: '没有待确认的比赛',
};

/**
 * 默认取多少场。
 *
 * 台账里有六百多场，一次全渲染出来会让首屏明显变卡。这里取最近
 * 一批即可，超出部分置 hasMore，由页面如实告知「只显示最近 N 场」，
 * 不假装已经翻到底了。比赛页不做翻页（见计划的「明确不做」）。
 */
const DEFAULT_LIMIT = 100;

/** 兜底的名解析：查不到就原样返回编号，绝不渲染出 undefined */
const DEFAULT_NAME_OF = createNameResolver(null);

/**
 * 状态标签的文案与样式类。
 *
 * 【驳回为什么借「已撤销」的壳】
 * 驳回和撤销的终态一样（成绩作废、分数回滚），区别只在动作和理由。
 * 为驳回单开一个枚举值，会让所有「判断是否作废」的地方都要改，
 * 而 constants.js 规定枚举只增不改，所以靠 action 区分文案即可。
 *
 * @param {number} status 取值见 constants.MATCH_STATUS
 * @param {string} [action] 'confirm' | 'reject' | 'revoke'
 * @returns {{label:string, className:string}}
 */
function statusTagOf(status, action) {
  if (status === MATCH_STATUS.PENDING) return { label: '待确认', className: 'is-pending' };
  if (status === MATCH_STATUS.REVOKED) {
    return action === 'reject'
      ? { label: '已驳回', className: 'is-revoked' }
      : { label: '已撤销', className: 'is-revoked' };
  }
  if (status === MATCH_STATUS.ACTIVE) return { label: '已生效', className: 'is-active' };
  return { label: MATCH_STATUS_LABEL[status] || '未知状态', className: 'is-unknown' };
}

/** 把一串会员编号变成「张三、李四」。空队伍给「待定」，不给空串 */
function joinNames(ids, nameOf) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => nameOf(id));
  return list.length ? list.join('、') : '待定';
}

/**
 * 把一串会员编号变成可点击的条目。
 * 页面上的队名要能点开看主页，所以除了昵称还得带上编号。
 */
function memberList(ids, nameOf) {
  return (Array.isArray(ids) ? ids : []).map((id) => ({ userId: id, nickName: nameOf(id) }));
}

/**
 * 整形比赛台账的一行。
 *
 * @param {Object} record getMatchRecords 的单项
 * @param {Object} [ctx]
 * @param {string} [ctx.userId] 当前看页面的会员
 * @param {number} [ctx.role] 当前会员的角色，决定能不能撤销
 * @param {string} [ctx.college] 当前会员的学院，学院负责人代录时划范围
 * @param {Function} [ctx.collegeOf] 编号 → 学院，学院负责人代录时划范围
 * @param {Function} [ctx.nameOf] 编号转昵称
 * @param {boolean} [ctx.isMock] 是否放宽确认权
 * @returns {Object}
 */
function buildRecordRow(record, ctx = {}) {
  const {
    userId = null,
    role,
    college = '',
    collegeOf = null,
    nameOf = DEFAULT_NAME_OF,
    // 默认值取「此刻」的数据源状态，而不是模块加载那一刻的快照：
    // 页面可能先于 app.js 的 setDataSource 被 require（测试环境尤其如此），
    // 解构快照会把演示口径带到正式数据源上。
    isMock: mock = isMockNow(),
  } = ctx;

  const tag = statusTagOf(record.status, record.action);
  const side = sideOf(record, userId);
  const isMine = side !== null;
  const winner = record.winner || '';

  // 只有自己参与过、且这场已分出胜负，才谈得上「胜/负」。
  // 旁观者看别人的比赛不该被标一个「负」，所以 resultText 留空由模板挡掉
  const isWin = Boolean(isMine && winner && winner === side);

  // 抽签排出的比赛还没比分，此时谈「确认」为时过早：确认要按胜方计分，
  // 没有胜方就无从计起。先在比赛页给一个「录分」入口。
  const waiting = needsScore(record);
  const relaxedConfirm = !waiting && canConfirm(record, userId, { isMock: mock, role });
  const strictConfirm = !waiting && canConfirm(record, userId, { isMock: false, role });

  // ---------- 裁判 ----------
  const isAdmin = Number(role) >= ROLE.ADMIN;
  const officiated = hasReferee(record);
  const refereeId = officiated ? String(record.referee) : '';
  const refereeName = officiated ? nameOf(refereeId) : '';
  // 被裁判接管后，只有裁判与管理员能录分 / 确认。这里提前算好一句提示，
  // 免得页面自己去拼「我是不是裁判」——模板里写权限判断正是要避免的事。
  const refereeTakesOver = officiated && userId !== refereeId && !isAdmin;
  // Q5：裁判也可以是本场参赛者，界面给个提示，不禁止
  const refereeIsParticipant = officiated && sideOf(record, refereeId) !== null;

  return {
    matchId: record._id,
    typeLabel: MATCH_TYPE_LABEL[record.matchType] || '',
    // P3 要求的赛制落地：老数据没有这两个字段时返回空串，模板用 wx:if 挡掉
    formatText: formatMatchFormat(formatOfRecord(record)),
    dateText: formatDateTime(record.matchTime),
    locationText: record.location || '',
    // 约球没有场号，老赛事的记录也没有——空串由模板挡掉
    courtText: courtNoTextOf(record.courtNo),
    teamAText: joinNames(record.teamA, nameOf),
    teamBText: joinNames(record.teamB, nameOf),
    teamAList: memberList(record.teamA, nameOf),
    teamBList: memberList(record.teamB, nameOf),
    winnerSide: winner,
    scoreText: formatScore(record.scoreA, record.scoreB, record.tiebreaks),
    // 正在逐球计分的那一场：把当前比分顶到终局比分的位置上显示（进行中 / 已结束）。
    // 首屏的 live 由读接口带上（见 read-handlers.attachLive 与 mock.attachLive）
    live: describeLive(record.live),
    liveActive: Boolean(record.live),
    isMine,
    isWin,
    resultText: isMine && winner ? (isWin ? '胜' : '负') : '',
    isEvent: Boolean(record.eventId),
    status: record.status,
    statusLabel: tag.label,
    statusClass: tag.className,
    statusReason: record.reason || '',
    action: record.action || '',
    canConfirm: relaxedConfirm,
    // 权限只来自 mock 放宽时置真——界面据此标注「演示口径」
    confirmRelaxed: relaxedConfirm && !strictConfirm,
    // 还没比分的赛事比赛：给「录分」而不是「确认」
    needsScore: waiting,
    // 录分权与写入端一致：参赛者、管理员，或学院负责人代录本学院有人上场的比赛
    // （见 match-record.canRecordScore）。演示数据源不再放宽，免得看到
    // 一个点下去会被拒的入口。
    canRecord: Boolean(waiting && userId && canRecordScore(record, userId, { role, college, collegeOf })),
    // 撤销已随 Elo 逐场结算改造取消（确认即最终结算），不再提供 canRevoke 旗标
    // 本人自选弃权（D41）：只有赛事的待确认比赛可以，约球不行；本人弃自己那场，
    // 管理员若也在场上同样成立。弃权后对手直接晋级，且不计个人等级分。
    canForfeit: canForfeit(record, userId, userId, { role }),
    // 裁判：指派入口只给管理员，且只在「还没生效」的场次上开
    hasReferee: officiated,
    referee: refereeId,
    refereeName,
    refereeIsParticipant,
    refereeNotice: refereeTakesOver
      ? `本场由 ${refereeName} 裁判执法，仅裁判与管理员可录分`
      : '',
    canAssignReferee: Boolean(isAdmin && canAssignReferee(record)),
  };
}

/**
 * 按标签页筛选台账。
 *
 * @param {Array<Object>} records
 * @param {string} tab 取值见 TAB
 * @param {string} userId
 * @returns {Array<Object>}
 */
function filterRecords(records, tab, userId) {
  const list = Array.isArray(records) ? records : [];
  if (tab === TAB.MINE) return list.filter((match) => sideOf(match, userId) !== null);
  if (tab === TAB.PENDING) {
    return list.filter(
      (match) => match.status === MATCH_STATUS.PENDING && sideOf(match, userId) !== null
    );
  }
  return list;
}

module.exports = {
  TAB,
  TAB_LABEL,
  TAB_EMPTY,
  DEFAULT_LIMIT,
  statusTagOf,
  buildRecordRow,
  filterRecords,
};
