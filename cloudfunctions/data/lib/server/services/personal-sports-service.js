/** 本人赛程、待办与运动护照。只读聚合；客户端不能指定目标用户。 */
const { allAssociations, getAssociation } = require('../../shared/utils/associations');
const { schoolAssociationKey, schoolMembershipKey } = require('../../shared/utils/school');
const { isLocalActiveMember } = require('./school-permission');
const { PLATFORM_STATUS } = require('../../shared/utils/school');
const { canManageAssociationSpace } = require('./association-space-permission');
const { canManageMeet } = require('./meet-permission');
const { legacyRoleOf } = require('./school-actor');
const { canConfirm, needsScore } = require('../../shared/services/match-record');
const { formatDateTime } = require('../../shared/utils/format');
const { meetPublicationKey, meetResultRowKey } = require('../../shared/utils/meet-scope');
const { SOURCES, DIRECTIONS, PAGE_MAX } = require('./personal-sports-query');
const ok = data => ({ ok: true, data });
const refuse = message => ok({ ok: false, message, resetRequired: true });
const position = row => ({ time: String(row.__hubTime || ''), id: String(row.__hubId || row._id) });
const comparePosition = (a, b) => a.time === b.time ? a.id === b.id ? 0 : a.id < b.id ? -1 : 1 : a.time < b.time ? -1 : 1;

async function authority(ctx) {
  const scopes = await Promise.all(allAssociations().map(async assoc => {
    const target = { schoolId: ctx.schoolId, association: assoc.id };
    const [schoolAssociation, membership] = await Promise.all([
      ctx.repo.schoolAssociations.getById(schoolAssociationKey(target)),
      ctx.repo.memberships.get(schoolMembershipKey(ctx.actorId, target)),
    ]);
    if (!schoolAssociation || schoolAssociation.schoolId !== ctx.schoolId || schoolAssociation.association !== assoc.id || schoolAssociation.status !== 'active') return null;
    const owned = membership && membership.schoolId === ctx.schoolId && membership.association === assoc.id && membership.userId === ctx.actorId ? membership : null;
    const scoped = { ...ctx, ...target, schoolAssociation, membership: owned };
    return { association: assoc.id, managed: canManageAssociationSpace(scoped), role: legacyRoleOf(scoped),
      collegeId: owned && owned.status === 'active' && owned.role === 'staff' ? owned.collegeId || '' : '' };
  }));
  const enabled = scopes.filter(Boolean);
  return { schoolId: ctx.schoolId, userId: ctx.actorId, associations: enabled.map(row => row.association),
    managedAssociations: enabled.filter(row => row.managed).map(row => row.association),
    collegeScopes: enabled.filter(row => row.collegeId).map(row => ({ association: row.association, collegeId: row.collegeId })),
    roles: Object.fromEntries(enabled.map(row => [row.association, row.role])), canReviewMembers: canManageMeet(ctx) };
}
function sourcesFor(section, auth, project) {
  return SOURCES[section].filter(source => {
    const meet = ['meetSchedule', 'meetJudge', 'judgeDraft', 'meetResult'].includes(source);
    if (project === 'meet' && !meet || project && project !== 'meet' && meet) return false;
    if (!meet && source !== 'membershipReview' && !auth.associations.length) return false;
    if (source === 'membershipReview' && (!auth.canReviewMembers || project)) return false;
    if (source === 'collegeReturned' && !auth.collegeScopes.length) return false;
    if (source === 'reviewReport' && !auth.managedAssociations.length) return false;
    return true;
  });
}
function fingerprint(auth, section, project) {
  return JSON.stringify([auth.schoolId, auth.userId, section, project, auth.associations,
    auth.managedAssociations, auth.collegeScopes, auth.canReviewMembers]);
}
function decodeCursor(cursor, key, sources, now) {
  if (!cursor) return { asOf: now.toISOString(), positions: {} };
  if (typeof cursor !== 'string' || cursor.length > 18000) throw new Error('分页位置无效，请刷新');
  let value; try { value = JSON.parse(decodeURIComponent(cursor)); } catch (_) { throw new Error('分页位置无效，请刷新'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分页位置无效，请刷新');
  if (value.key !== key) throw new Error('账号、学校或权限已变化，请刷新');
  if (typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf)) || Math.abs(now.getTime() - Date.parse(value.asOf)) > 30 * 60000) throw new Error('列表已过期，请刷新');
  const positions = {};
  for (const source of sources) {
    const item = value.positions?.[source];
    if (!item) continue;
    if (typeof item.id !== 'string' || item.id.length > 700 || typeof item.time !== 'string' || item.time.length > 80) throw new Error('分页位置无效，请刷新');
    positions[source] = { id: item.id, time: item.time };
  }
  return { asOf: value.asOf, positions };
}
const target = (kind, row, extra = {}) => ({ kind, association: row.association || '', ...extra });
function baseItem(source, row, section, auth, ctx) {
  const event = row.hubEvent, match = row.hubMatch || row;
  const item = { key: `${source}:${row.__hubId}`, title: '', subtitle: '', time: row.__hubTime,
    association: row.association || (row.meetId ? 'meet' : ''), state: '', roles: [], proof: '', target: null };
  if (['personalSchedule', 'personalResult', 'confirmScore'].includes(source)) {
    if (row.status !== (source === 'personalResult' ? 1 : 0)) return null;
    if (!Array.isArray(row.teamA) || !Array.isArray(row.teamB) || row.teamA.length < 1 || row.teamB.length < 1 || row.teamA.length > 2 || row.teamB.length > 2) return null;
    const player = [...(row.teamA || []), ...(row.teamB || [])].includes(auth.userId);
    if (!player && row.referee !== auth.userId) return null;
    item.key = `${section}:personal:${row._id}`;
    item.title = row.hubCollegeEvent?.title || event?.title || '日常比赛';
    item.roles = [player ? '参赛' : '', row.referee === auth.userId ? '裁判' : ''].filter(Boolean);
    item.playersA = (row.teamA || []).slice(0, 2); item.playersB = (row.teamB || []).slice(0, 2);
    item.scoreText = Array.isArray(row.scoreA) && Array.isArray(row.scoreB) && row.winner ? `${row.scoreA.join(' / ')} : ${row.scoreB.join(' / ')}` : '';
    item.location = row.location || row.hubCollegeEvent?.location || event?.location || '';
    item.state = source === 'personalResult' ? '已确认' : row.__hubTime === '' ? '进行中' : '已排期';
    item.proof = source === 'personalResult' ? (row.outcome === 'forfeit' ? '已确认弃权判定' : '已确认比分') : '';
    item.target = target('personal_match', row, { id: row._id });
    if (source === 'confirmScore') {
      if (needsScore(row) || !canConfirm(row, auth.userId, { role: auth.roles[row.association], isMock: ctx.isMock === true })) return null;
      item.state = '待确认比分'; item.target = target('confirm_score', row, { id: row._id, revision: row.revision });
    }
  } else if (['teamSchedule', 'teamOfficial', 'reviewReport', 'basketballPlayed', 'footballPlayed'].includes(source)) {
    if (typeof match.teamA !== 'string' || typeof match.teamB !== 'string') return null;
    item.key = `${section}:team:${match._id}`; item.title = event?.name || '团队赛事';
    item.teamA = match.teamA; item.teamB = match.teamB; item.location = match.location || event?.location || '';
    const published = section === 'passport';
    item.state = published ? '已发布' : source === 'reviewReport' ? '待审核报告' : match.status === 'live' ? '进行中' : '已排期';
    item.proof = published ? '已发布比赛报告收录' : '';
    item.roles = [source === 'teamSchedule' ? '参赛名单' : '', match.refereeId === auth.userId ? '裁判' : '', match.recorderId === auth.userId ? '记录员' : '', source === 'reviewReport' ? '赛事管理' : ''].filter(Boolean);
    if (published) item.roles = ['报告收录'];
    item.target = target(match.sportFormat === 'football11' ? 'football_match' : 'team_event', row,
      { id: match.sportFormat === 'football11' ? match._id : match.eventId, matchId: match._id });
  } else if (['meetSchedule', 'meetJudge', 'judgeDraft', 'meetResult'].includes(source)) {
    const slot = row.hubSession;
    item.key = source === 'meetResult' ? `passport:meet:${meetResultRowKey(row.publicationKey, row.entryKey)}` : source === 'judgeDraft' ? `tasks:judge:${row._id}` : `schedule:meet:${slot._id}`;
    item.title = `${row.hubMeet.name || '运动会'} · ${event?.name || '项目'}`;
    item.subtitle = source === 'meetResult' ? row.hubPublication.roundLabel || '' : [slot?.roundLabel || slot?.round, slot?.index ? `第 ${slot.index} 场` : ''].filter(Boolean).join(' · ');
    item.roles = [source === 'meetSchedule' ? '参赛' : source === 'meetResult' ? '正式成绩记录' : '裁判'];
    item.state = source === 'judgeDraft' ? '裁判成绩待提交' : source === 'meetResult' ? '已发布' : slot?.status === 'running' ? '进行中' : '已排期';
    item.location = slot?.venue || row.hubMeet.location || '';
    item.proof = source === 'meetResult' ? (row.hubPublication.official ? '已发布正式成绩' : '已发布分组成绩') : '';
    item.rank = source === 'meetResult' && Number.isInteger(row.rank) && row.rank > 0 ? row.rank : null;
    item.honor = Boolean(item.rank && item.rank <= 3 && row.hubPublication.official);
    item.target = { kind: source === 'meetJudge' || source === 'judgeDraft' ? 'meet_score' : 'meet_detail', meetId: row.meetId, sessionKey: slot?._id || row.sessionKey || '', eventKey: row.eventKey };
  } else if (source === 'personalHonor') {
    const result = (row.results || []).find(record => record.userId === auth.userId);
    if (!result || !Number.isInteger(Number(result.placement)) || Number(result.placement) < 1) return null;
    item.title = row.title || '个人赛事'; item.rank = Number(result.placement); item.honor = item.rank <= 3;
    item.state = '赛事已结束'; item.proof = '已发布个人名次'; item.roles = ['参赛'];
    item.target = target('personal_event', row, { id: row._id });
  } else if (['individualWaiting', 'collegeWaiting', 'teamWaiting', 'collegeExperience', 'teamExperience', 'collegeReturned', 'teamReturned'].includes(source)) {
    item.title = event?.title || event?.name || '赛事报名';
    const college = source.startsWith('college');
    item.roles = [college ? '学院名单' : source === 'individualWaiting' ? '本人报名' : '球队名单'];
    item.state = section === 'passport' ? '已归档' : section === 'tasks' ? '名单已退回' : college ? '等待排阵' : '等待赛程';
    item.proof = section === 'passport' ? college ? '已通过的学院参赛名单' : '已锁定的球队参赛名单' : '';
    item.subtitle = section === 'tasks' ? String(row.reason || row.hubEntry?.reason || '').slice(0, 120) : '';
    const eventId = row.eventId || row.hubEntry?.eventId;
    item.target = target(college ? source === 'collegeReturned' ? 'college_entry' : 'college_event' : source === 'individualWaiting' ? 'personal_event' : 'team_event', row,
      { id: eventId, collegeId: row.collegeId || '' });
    if (section === 'passport') item.subtitle = '报名名单记录，未据此推定实际出场';
  } else if (source === 'membershipReview') {
    item.title = row.transferFrom ? '转校申请待审核' : '入会申请待审核'; item.roles = ['学校审核'];
    item.state = '待处理'; item.target = { kind: 'school_identity' };
  }
  if (!item.title || !item.target) return null;
  return item;
}
async function hydrate(items, ctx) {
  const users = [...new Set(items.flatMap(item => [...(item.playersA || []), ...(item.playersB || [])]))];
  const teams = [...new Set(items.flatMap(item => [item.teamA, item.teamB]).filter(Boolean))];
  const [accounts, teamDocs] = await Promise.all([
    users.length ? ctx.repo.users.listByIds(users) : [],
    Promise.all(teams.map(id => ctx.repo.teams.getById(id))),
  ]);
  const names = new Map(accounts.map(row => [row._id, row.nickName || '会员']));
  const teamNames = new Map(teamDocs.filter(row => row && row.schoolId === ctx.schoolId).map(row => [row._id, { name: row.name || '球队', association: row.association }]));
  return items.map(item => {
    const result = { ...item };
    if (item.playersA) result.opponents = `${item.playersA.map(id => names.get(id) || '会员').join(' / ')} 对 ${item.playersB.map(id => names.get(id) || '会员').join(' / ')}`;
    if (item.teamA) result.opponents = [item.teamA, item.teamB].map(id => teamNames.get(id)?.association === item.association ? teamNames.get(id).name : '球队').join(' 对 ');
    result.projectName = item.association === 'meet' ? '运动会' : item.association ? getAssociation(item.association).sportName : '学校事务';
    result.waiting = item.time === '9999-12-31T23:59:59.999Z';
    result.timeText = result.waiting ? '时间待定' : !item.time && item.state === '进行中' ? '正在进行' : item.time && Number.isFinite(Date.parse(item.time)) ? formatDateTime(item.time) : '时间未记录';
    result.rolesText = item.roles.join(' · ');
    delete result.playersA; delete result.playersB; delete result.teamA; delete result.teamB;
    return result;
  });
}
async function pageFor(section, payload, auth, ctx) {
  const project = typeof payload.project === 'string' ? payload.project : '';
  if (project && project !== 'meet' && !allAssociations().some(row => row.id === project)) throw new Error('项目筛选无效');
  const scoped = project && project !== 'meet' ? { ...auth, associations: auth.associations.filter(id => id === project),
    managedAssociations: auth.managedAssociations.filter(id => id === project), collegeScopes: auth.collegeScopes.filter(row => row.association === project) } : auth;
  const sources = sourcesFor(section, scoped, project);
  const limit = Number.isInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, PAGE_MAX) : 20;
  const key = fingerprint(scoped, section, project);
  const cursor = decodeCursor(payload.cursor, key, sources, ctx.now);
  const pages = await Promise.all(sources.map(async source => ({ source, ...await ctx.repo.personalSports.readPage(source, scoped,
    { limit, asOf: cursor.asOf, cursor: cursor.positions[source] }) })));
  const candidates = [], positions = { ...cursor.positions };
  for (const page of pages) {
    let valid = 0;
    if (page.source === 'judgeDraft' && !auth.canReviewMembers) {
      const publications = new Map();
      const allowed = [];
      for (const row of page.rows) {
        const publicationKey = meetPublicationKey(row.meetId, row.eventKey, row.hubEvent?.rounds === 'final' ? 'all' : row.sessionKey);
        if (!publications.has(publicationKey)) publications.set(publicationKey, await ctx.repo.sportsMeetPublications.getById(publicationKey));
        if (!publications.get(publicationKey)) allowed.push(row.__hubId);
      }
      page.allowed = new Set(allowed);
    }
    page.rows.forEach((row, index) => { const item = page.allowed && !page.allowed.has(row.__hubId) ? null : baseItem(page.source, row, section, scoped, ctx); if (item) { valid++; candidates.push({ item, row, source: page.source, index }); } });
    if (!valid && page.rows.length) positions[page.source] = position(page.rows[page.rows.length - 1]);
  }
  candidates.sort((a, b) => comparePosition(position(a.row), position(b.row)) * DIRECTIONS[section] || (a.item.key < b.item.key ? -1 : 1));
  const selected = new Map();
  for (const candidate of candidates) {
    if (!selected.has(candidate.item.key) && selected.size >= limit) break;
    const prior = selected.get(candidate.item.key);
    if (prior) prior.roles = [...new Set([...prior.roles, ...candidate.item.roles])]; else selected.set(candidate.item.key, candidate.item);
    positions[candidate.source] = position(candidate.row);
  }
  const hasMore = pages.some(page => page.hasMore || candidates.some(row => row.source === page.source && (!positions[page.source]
    || comparePosition(position(row.row), positions[page.source]) * DIRECTIONS[section] > 0)));
  return { items: await hydrate([...selected.values()], ctx), hasMore,
    nextCursor: hasMore ? encodeURIComponent(JSON.stringify({ key, asOf: cursor.asOf, positions })) : '', asOf: cursor.asOf };
}
async function getMySportsDashboard(payload = {}, ctx) {
  if (!ctx.actorId || ctx.actor?.platformStatus !== PLATFORM_STATUS.ACTIVE) return refuse('请先登录后查看我的体育');
  if (!isLocalActiveMember(ctx)) return refuse('请切换到本人有效学校，或先完成学校身份审核');
  const section = payload.section || 'overview';
  if (!['overview', 'schedule', 'tasks', 'passport'].includes(section)) return refuse('内容分区无效');
  try {
    const auth = await authority(ctx);
    if (section === 'overview') {
      const [schedule, tasks] = await Promise.all([pageFor('schedule', { limit: 1 }, auth, ctx), pageFor('tasks', { limit: 3 }, auth, ctx)]);
      return ok({ ok: true, schedule, tasks });
    }
    return ok({ ok: true, section, ...await pageFor(section, payload, auth, ctx) });
  } catch (error) {
    // 参数错误是业务拒绝；仓储故障必须向调用方暴露，不能伪装为“没有安排”。
    if (/分页位置|权限已变化|列表已过期|筛选无效/.test(error.message || '')) return refuse(error.message);
    throw error;
  }
}
module.exports = { getMySportsDashboard };
