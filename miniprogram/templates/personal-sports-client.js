const identity = require('../services/school-identity');
const association = require('../services/association-scope');
const { isKnownAssociation } = require('../shared/utils/associations');
function loadPersonalSports(schoolId, payload) {
  return identity.forSchoolIdentity({ schoolId, association: association.getAssociation() }).getMySportsDashboard(payload);
}
/**
 * 首页「下一步」的行动文案。
 *
 * 首页原先只给一个通用箭头，用户仍需进入详情后再找按钮。这里仅根据服务端已
 * 下发的 target.kind / state 选择更明确的动词，不新增权限判断：真正能不能操作
 * 仍由目标页与写接口在事务内复核。
 *
 * @param {Object} item 个人体育条目
 * @returns {string}
 */
function actionTextOf(item) {
  if (!item || !item.target) return '查看记录';
  const kind = item.target.kind;
  const state = String(item.state || '');
  if (kind === 'confirm_score') return '确认比分';
  if (kind === 'college_entry') return '处理名单';
  if (kind === 'school_identity') return '去审核';
  if (kind === 'meet_score') return state.includes('待提交') ? '提交成绩' : '进入录分';
  if (kind === 'football_match') return '查看报告';
  if (state.includes('待审核')) return '审核报告';
  if (state.includes('退回')) return '处理退回';
  if (state.includes('待处理') || state.includes('待确认')) return '立即处理';
  if (state.includes('进行中')) return '查看现场';
  if (kind === 'personal_event' || kind === 'college_event') return '查看赛事';
  if (kind === 'meet_detail') return '查看赛程';
  if (kind === 'personal_match') return '查看比赛';
  return '查看记录';
}

/**
 * 从运动护照中提取可核验的生涯节点。
 *
 * 只使用服务端已经确认/发布的记录：名次、荣誉、证明文案。不生成成长值、
 * 不推断未出场、不把报名名单写成参赛成绩。时间轴按当前已加载页生成，
 * 页面会明确说明它还不是完整生涯总量。
 *
 * @param {Array<Object>} items 运动护照条目
 * @param {number} [limit]
 * @returns {Array<Object>}
 */
function careerMilestonesOf(items, limit = 8) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(item => item && item.target)
    .filter(item => item.honor || Number(item.rank) > 0 || item.proof)
    .slice()
    .sort((a, b) => (Date.parse(b.time || '') || 0) - (Date.parse(a.time || '') || 0))
    .slice(0, limit);
  return rows.map((item) => {
    const time = Date.parse(item.time || '');
    const year = Number.isFinite(time)
      ? String(new Date(time + 8 * 60 * 60 * 1000).getUTCFullYear())
      : '时间待定';
    return {
      key: item.key,
      year,
      timeText: item.timeText || '',
      projectName: item.projectName || '',
      title: item.title || '',
      detail: Number(item.rank) > 0 ? `第 ${item.rank} 名` : item.proof || '',
      proof: item.proof || '',
      honor: Boolean(item.honor),
    };
  });
}

/** 给首页/待办卡补上行动文案；不修改原对象，避免污染服务层缓存。 */
function withPersonalActions(dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return dashboard;
  const decorate = page => page && Array.isArray(page.items)
    ? { ...page, items: page.items.map(item => ({ ...item, actionText: actionTextOf(item) })) }
    : page;
  return { ...dashboard, schedule: decorate(dashboard.schedule), tasks: decorate(dashboard.tasks) };
}

function openSportsTarget(target) {
  if (!target || typeof target.kind !== 'string') return false;
  if (target.association && target.association !== 'meet') {
    if (!isKnownAssociation(target.association)) return false;
    association.setAssociation(target.association);
  }
  const id = encodeURIComponent(target.id || '');
  const routes = {
    personal_event: `/packageEvent/event-detail/event-detail?eventId=${id}`,
    college_event: `/packageCollege/college-event-detail/college-event-detail?eventId=${id}`,
    college_entry: `/packageCollege/college-entry/college-entry?eventId=${id}&collegeId=${encodeURIComponent(target.collegeId || '')}`,
    team_event: `/packageTeam/team-event-detail/team-event-detail?eventId=${id}`,
    football_match: `/packageTeam/football-match/football-match?matchId=${id}`,
    personal_match: `/packageMember/my-sports/my-sports?tab=schedule&matchId=${id}&association=${encodeURIComponent(target.association || '')}`,
    confirm_score: `/packageMember/my-sports/my-sports?tab=tasks&matchId=${id}&association=${encodeURIComponent(target.association || '')}`,
    meet_detail: `/packageMeet/meet-detail/meet-detail?meetId=${encodeURIComponent(target.meetId || '')}`,
    meet_score: `/packageMeet/meet-score/meet-score?meetId=${encodeURIComponent(target.meetId || '')}&sessionKey=${encodeURIComponent(target.sessionKey || '')}`,
    school_identity: '/packageMember/school-identity/school-identity',
  };
  if (!Object.prototype.hasOwnProperty.call(routes, target.kind)) return false;
  wx.navigateTo({ url: routes[target.kind] });
  return true;
}
module.exports = {
  loadPersonalSports,
  openSportsTarget,
  actionTextOf,
  withPersonalActions,
  careerMilestonesOf,
};
