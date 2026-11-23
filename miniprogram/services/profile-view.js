/**
 * 个人主页的视图模型
 * ============================================================
 * 「我的」页面要展示的东西很多：分数卡、分数曲线、交锋记录、
 * 搭档记录、赛事名次、逐场战绩。如果全在页面里拼装，会有两个问题：
 *
 *   1. 页面文件会膨胀到几百行，且几乎无法测试（wx 环境跑不了 Node 测试）；
 *   2. 「查看他人主页」要做一模一样的事，只能整段复制，改一处漏一处。
 *
 * 所以把「取数 + 整形 + 算文案」集中到这里，页面只剩渲染和交互。
 * 这个模块不碰任何 wx API，因而可以在 Node 里完整测试。
 *
 * 【分项目约定】
 * 页面上的项目切换（男单 / 女单 / 双打）作用范围是整页：
 * 分数、曲线、排名、交锋、搭档、赛事、逐场战绩，全部跟着当前项目走。
 * 这样「看双打」看到的就是纯粹的双打数据，不会混进单打场次。
 * 默认停在单打上（见 sortProjectsForDisplay）。
 *
 * 【项目与池的配合】
 * 项目决定「看哪张榜」（女单榜只列女生），池决定「取哪些比赛」
 * （单打的比赛流水）。所以筛选比赛时用的是 item.pool，
 * 取榜单名次时用的是 item.project。
 *
 * 【P10 合并批之后】取数那两个协议 1 入口（loadMemberView 读门面台账、
 * loadProfileSummary 用 scope.mapActiveAssociations 跨协会捞 getEventRecord）
 * 已随协议 1 一并删除，页面只剩两个 S2 装载器：loadSchoolMemberView（个人
 * 详情 / 他人主页）与 loadSchoolProfileSummaryView（「我的」页）。纯整形
 * 用的构建器（buildChart / buildHistoryRow / pickProject）两边共用，保留。
 * 原先由客户端按 isGlobalAdmin 推断的角色徽标，S2 直接取服务端
 * permissionLabel，roleLabelOf 那条旧规则一并删除。
 * ============================================================
 */

const { RATING_POOL_LABEL } = require('../utils/constants.js');
const {
  formatDate,
  formatSigned,
  formatElo,
  formatPercent,
  formatPlacement,
  formatRank,
  formatScore,
} = require('../utils/format.js');
const { sortProjectsForDisplay } = require('../utils/leaderboard.js');
const { allAssociations } = require('../utils/associations.js');
const { formatMatchFormat, formatOfRecord } = require('../utils/match-format.js');
const { resolveNameDisplay } = require('./profile.js');

/** 默认取多少场逐场战绩。太多会拖慢首屏，剩下的靠「加载更多」。 */
const DEFAULT_HISTORY_LIMIT = 20;

/** 近期状态的小圆点个数 */
const FORM_LIMIT = 5;

/**
 * 选出当前要展示的项目。
 *
 * 优先用调用方指定的项目（用户点了某个 tab）；指定的项目不存在时
 * 退回第一个——此时传进来的 projects 已经过 sortProjectsForDisplay，
 * 第一个也就是单打（没有单打成绩的人才会落到双打）。
 *
 * @param {Array<Object>} projects getMyProjects 的结果（建议先过一遍排序）
 * @param {string} [preferred] 项目名
 * @returns {Object|null}
 */
function pickProject(projects, preferred) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (preferred) {
    const hit = projects.find((item) => item.project === preferred);
    if (hit) return hit;
  }
  return projects[0];
}

/**
 * 把分数曲线加工成页面需要的形状。
 *
 * 序列首部补一个「入池起点分」，这样曲线从进池那天开始画，
 * 和图上那条虚线（起点）自然衔接，一眼能看出「这一路涨了多少」。
 *
 * @param {Array<Object>} ratingHistory buildRatingHistory 的结果（时间升序）
 * @param {number} startElo 入池起点分
 * @returns {Object}
 */
function buildChart(ratingHistory, startElo) {
  const list = Array.isArray(ratingHistory) ? ratingHistory : [];
  const values = [startElo, ...list.map((point) => point.eloAfter)];
  const deltas = list.map((point) => ({
    value: point.eloDelta,
    matchTime: point.matchTime,
  }));

  // 单场最大涨幅：这是「加减分情况」里最值得单独拎出来的一条
  let best = null;
  let worst = null;
  for (const item of deltas) {
    if (best === null || item.value > best.value) best = item;
    if (worst === null || item.value < worst.value) worst = item;
  }

  const decorate = (item) =>
    item === null
      ? null
      : { deltaText: formatSigned(item.value), dateText: formatDate(item.matchTime) };

  return {
    empty: list.length === 0,
    values,
    pointCount: list.length,
    startElo,
    currentElo: values[values.length - 1],
    maxElo: Math.max(...values),
    minElo: Math.min(...values),
    best: decorate(best),
    worst: decorate(worst),
  };
}

/**
 * 整形逐场战绩的一行。
 * @param {Object} row getMatchHistory 的单项
 * @returns {Object}
 */
function buildHistoryRow(row) {
  return {
    matchId: row.matchId,
    dateText: formatDate(row.matchTime),
    isWin: row.isWin,
    resultText: row.isWin ? '胜' : '负',
    // 双打对手有两人，用顿号连起来读起来更顺
    rivalText: row.opponentNames.join('、'),
    partnerText: row.partnerNames.length ? `搭档 ${row.partnerNames.join('、')}` : '单打',
    scoreText: formatScore(row.score.mine, row.score.theirs, row.tiebreaks),
    eloDeltaText: formatSigned(row.eloDelta),
    eloDeltaUp: row.eloDelta >= 0,
    pointDeltaText: formatSigned(row.pointDelta),
    // 日常比赛不再产生积分（决策 9），大多数场次的分差是 0。
    // 一行一行地写「积分 0」既占地方又像没算对，索性只在真有积分时显示。
    hasPointDelta: Number(row.pointDelta) !== 0,
    isEvent: Boolean(row.eventId),
    poolLabel: RATING_POOL_LABEL[row.pool] || '',
    // 赛制文案。老数据没有这两个字段时 formatMatchFormat 返回空串，
    // 模板那边用 wx:if 挡住，免得留下一截悬空的分隔符
    formatText: formatMatchFormat(formatOfRecord(row)),
  };
}

/**
 * 学校维度的个人主页装载器（B4-c）。
 *
 * 取数走绑定范围的 S2 客户端（getSchoolMemberProfile：一次回放取齐卡片、
 * 项目、走势、交锋、搭档、逐场战绩、近期状态与本范围荣誉），整形与旧栈
 * 旧栈 loadMemberView 共用同一套纯函数（buildChart / buildHistoryRow / format*），
 * 页面与模板因此不需要改形状。
 *
 * 【任免 / 改分入口为什么在这里关掉】S2 下「指定权限」统一走学校身份页的
 * grantSchoolPermission（一个入口、权限不同），改分收尾属 B5；个人主页不再
 * 提供旧栈写入口，避免读 S2、写旧栈的混用。
 *
 * @param {Object} api 绑定学校 / 协会的协会空间客户端
 * @param {Object} [options]
 * @param {string} [options.userId] 想看谁；不传即本人
 * @param {string} [options.project] 初始选中的项目
 * @param {number} [options.historyLimit] 逐场战绩取多少条
 * @returns {Promise<Object>} 与旧栈 loadMemberView 同形状；查无此人时 { found: false }
 */
async function loadSchoolMemberView(api, options = {}) {
  const { project, historyLimit = DEFAULT_HISTORY_LIMIT } = options;
  const data = await api.getSchoolMemberProfile({
    userId: options.userId || '',
    project: project || '',
    historyLimit,
  });
  if (!data || !data.found) return { found: false };

  const projects = sortProjectsForDisplay(data.projects);
  const active = pickProject(projects, project);

  const eventRecords = (data.honors.records || []).map((row) => ({
    eventId: row.eventId,
    title: row.title,
    dateText: formatDate(row.startTime),
    placement: row.placement,
    placementText: formatPlacement(row.placement),
    isTop: row.placement <= 3,
    participantCount: row.participantCount,
  }));

  const nameDisplay = resolveNameDisplay(data.user);
  const honorSummary = data.honors.summary || {};

  return {
    found: true,
    user: {
      userId: data.user.userId,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: data.user.avatarUrl || '',
      college: data.user.college || '',
      collegeId: data.user.collegeId || '',
      studentId: data.user.studentId || '',
      roleLabel: data.user.permissionLabel || '',
      // 机器可读的权限档（设置身份用，模板只拿它做比较，不自己拼规则）
      permission: data.user.permission || '',
      statusLabel: '正常',
      joinDateText: '',
      points: data.user.points || 0,
      showPoints: true,
    },
    projectTabs: projects.map((item) => ({
      project: item.project,
      label: item.label,
      elo: formatElo(item.elo),
      active: Boolean(active) && item.project === active.project,
    })),
    activeProject: active ? active.project : null,
    activeProjectLabel: active ? active.label : '',
    hasProject: Boolean(active),
    summary: active
      ? {
          elo: formatElo(active.elo),
          startElo: formatElo(active.startElo),
          delta: active.delta,
          deltaText: formatSigned(active.delta),
          deltaUp: active.delta >= 0,
          matchCount: active.matchCount,
          wins: active.wins,
          losses: active.losses,
          recordText: `${active.wins} 胜 ${active.losses} 负`,
          winRateText: formatPercent(active.wins / Math.max(active.matchCount, 1)),
          rank: active.rank,
          total: active.total,
          rankText: formatRank(active.rank, active.total),
          beatText: `超过 ${formatPercent(active.beatPercent / 100)} 的会员`,
        }
      : null,
    chart: buildChart(data.ratingHistory || [], active ? active.startElo : 0),
    form: {
      dots: (data.form.results || []).map((isWin) => (isWin ? 'W' : 'L')),
      wins: data.form.wins,
      losses: data.form.losses,
      streakText: data.form.streak > 0 ? `${data.form.streak} 连胜` : '暂无连胜',
    },
    events: {
      records: eventRecords,
      summary: {
        eventCount: honorSummary.eventCount || 0,
        championCount: honorSummary.championCount || 0,
        topThreeCount: honorSummary.topThreeCount || 0,
        bestPlacementText: formatPlacement(honorSummary.bestPlacement),
      },
    },
    headToHead: (data.headToHead || []).map((row) => ({
      opponentId: row.opponentId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
      deltaText: formatSigned(row.eloDeltaSum),
      deltaUp: row.eloDeltaSum >= 0,
    })),
    partners: (data.partners || []).map((row) => ({
      partnerId: row.partnerId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
    })),
    history: (data.history || []).map(buildHistoryRow),
    // S2 下任免 / 改分统一走学校身份页，个人主页不再提供旧栈写入口（B4 边界）
    leader: { visible: false },
    associationLeader: { visible: false },
    currentElo: { visible: false },
  };
}

/**
 * 学校维度的「我的」页装载器（B4-c）：头卡来自 S2 会话，荣誉跨该校协会聚合
 * （与旧栈 loadProfileSummary 同形状）。
 *
 * @param {Object} options
 * @param {string} options.schoolId 当前浏览学校
 * @param {Object} options.session getSchoolIdentitySession 的返回（本人会话）
 * @param {Object} [options.client] 协会空间门面（测试可注入替身）
 * @returns {Promise<Object>} 未登录时 { found: false }
 */
async function loadSchoolProfileSummaryView({ schoolId, session, client }) {
  if (!session || !session.user) return { found: false };
  const user = session.user;
  const space = client || require('./association-space.js');

  // 会员档案（学院全名）：并发探测，取第一个读得到的协会。
  const memberResults = await Promise.all(allAssociations().map(async (assoc) => {
    try {
      const result = await space.forScope({ schoolId, association: assoc.id }).getSchoolMember({ userId: user.userId });
      return (result && result.member) || null;
    } catch (err) {
      return null;
    }
  }));
  const profile = memberResults.find(Boolean) || null;

  const groups = [];
  let eventCount = 0;
  let championCount = 0;
  let topThreeCount = 0;
  let bestPlacement = null;

  await Promise.all(allAssociations().map(async (assoc) => {
    try {
      const api = space.forScope({ schoolId, association: assoc.id });
      const result = await api.getSchoolMemberHonors({ userId: user.userId });
      if (!result || !result.ok || !result.honors) return;
      const records = (result.honors.records || []).map((row) => ({
        eventId: row.eventId,
        title: row.title,
        dateText: formatDate(row.startTime),
        placement: row.placement,
        placementText: formatPlacement(row.placement),
        isTop: row.placement <= 3,
        participantCount: row.participantCount,
      }));
      if (records.length === 0) return;
      const summary = result.honors.summary || {};
      eventCount += summary.eventCount || 0;
      championCount += summary.championCount || 0;
      topThreeCount += summary.topThreeCount || 0;
      if (summary.bestPlacement != null &&
          (bestPlacement === null || summary.bestPlacement < bestPlacement)) {
        bestPlacement = summary.bestPlacement;
      }
      groups.push({
        associationId: assoc.id,
        associationName: assoc.shortName,
        associationGlyph: assoc.logoGlyph,
        records,
      });
    } catch (err) {
      // 该协会读不到（未启用 / 无权限）：跳过，不拖垮整页
    }
  }));

  const nameDisplay = resolveNameDisplay(user);
  const account = session.account || {};
  const statusLabel = ({ pending: '待审核', active: '正常', rejected: '已驳回', left: '已离校', disabled: '已停用' })[account.status] || '未入会';

  return {
    found: true,
    user: {
      userId: user.userId,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: user.avatarUrl || '',
      college: (profile && profile.collegeName) || '',
      studentId: (account && account.studentId) || '',
      roleLabel: session.isPlatformAdmin ? '管理员' : (session.permissionLabel || '会员'),
      statusLabel,
      joinDateText: '',
      points: 0,
      showPoints: false,
    },
    honors: {
      summary: {
        eventCount,
        championCount,
        topThreeCount,
        bestPlacementText: formatPlacement(bestPlacement),
      },
      groups,
      total: eventCount,
    },
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  FORM_LIMIT,
  pickProject,
  buildChart,
  buildHistoryRow,
  loadSchoolMemberView,
  loadSchoolProfileSummaryView,
};
