/** 本人体育中心的查询计划。先按学校和本人关系过滤，在数据库完成关联、排序与限量。 */
const { fieldValues } = require('./scoped-team-reads');
const SECTIONS = ['schedule', 'tasks', 'passport'];
const PAGE_MAX = 30;
const DIRECTIONS = { schedule: 1, tasks: 1, passport: -1 };
const SOURCES = {
  schedule: ['personalSchedule', 'teamSchedule', 'teamOfficial', 'meetSchedule', 'meetJudge', 'individualWaiting', 'collegeWaiting', 'teamWaiting'],
  tasks: ['confirmScore', 'collegeReturned', 'teamReturned', 'reviewReport', 'judgeDraft', 'membershipReview'],
  passport: ['personalResult', 'personalHonor', 'collegeExperience', 'teamExperience', 'basketballPlayed', 'footballPlayed', 'meetResult'],
};
const expr = value => ({ $expr: value });
const eq = (a, b) => ({ $eq: [a, b] });
const oneOf = (a, b) => ({ $in: [a, b] });
const and = (...items) => ({ $and: items });
const or = (...items) => ({ $or: items });
const fallback = (a, b) => ({ $ifNull: [a, b] });
const join = (key, localField, alias, optional = false, foreignField = '_id') => [
  ['lookup', { key, localField, foreignField, as: alias }],
  ['unwind', { path: `$${alias}`, preserveNullAndEmptyArrays: optional }],
];
function queryPlan(source, auth, query = {}) {
  const section = SECTIONS.find(key => SOURCES[key].includes(source));
  if (!section || !auth.schoolId || !auth.userId) throw new Error('个人体育查询范围无效');
  const scope = { schoolId: auth.schoolId, association: { $in: auth.associations || [] } };
  const uid = auth.userId;
  const ownMatch = { $or: [{ teamA: uid }, { teamB: uid }, { referee: uid }] };
  const stages = [];
  let key, time = '$updatedAt', id = '$_id', subject = '', running = null;
  const eventGuard = (alias, parent, statuses, association = true) => expr(and(
    eq(`$${alias}.schoolId`, `$${parent ? parent + '.' : ''}schoolId`),
    ...(association ? [eq(`$${alias}.association`, `$${parent ? parent + '.' : ''}association`)] : []),
    oneOf(`$${alias}.status`, statuses)));
  const addEvent = (collection, field, statuses, parent = '', optional = false) => {
    stages.push(...join(collection, field, 'hubEvent', optional));
    const guard = eventGuard('hubEvent', parent, statuses);
    stages.push(['match', optional ? expr(or(eq(fallback(`$${field}`, ''), ''), guard.$expr)) : guard]);
  };
  const meetParents = (session = true) => {
    stages.push(...join('sportsMeets', 'meetId', 'hubMeet'));
    stages.push(['match', eventGuard('hubMeet', '', section === 'passport' ? ['registration', 'scheduled', 'running', 'finished', 'archived'] : section === 'schedule' ? ['scheduled', 'running'] : ['registration', 'scheduled', 'running'], false)]);
    stages.push(...join('sportsMeetEvents', 'eventKey', 'hubEvent'));
    stages.push(['match', expr(and(eq('$hubEvent.schoolId', auth.schoolId), eq('$hubEvent.meetId', '$meetId'), { $ne: ['$hubEvent.status', 'deleted'] }))]);
    if (session) stages.push(['match', expr(and(eq('$hubSession.schoolId', auth.schoolId), eq('$hubSession.meetId', '$meetId'),
      eq('$hubSession.eventKey', '$eventKey'), eq(fallback('$hubSession.voidedAt', null), null)))]);
  };
  if (['personalSchedule', 'confirmScore', 'personalResult'].includes(source)) {
    key = 'matches';
    const own = source === 'personalResult' ? { $or: [{ teamA: uid }, { teamB: uid }] } : ownMatch;
    stages.push(['match', { ...scope, ...own, status: source === 'personalResult' ? 1 : 0,
      ...(source === 'confirmScore' ? { winner: { $in: ['A', 'B'] } } : source === 'personalSchedule' ? { winner: { $in: ['', null] } } : {}) }]);
    addEvent('events', 'eventId', source === 'personalResult' ? [0, 1, 2] : [0, 1], '', true);
    // 学院小场的 eventId 指向学院赛，另按 collegeEventId 关联；个人赛与日常赛不受影响。
    stages.push(...join('collegeEvents', 'collegeEventId', 'hubCollegeEvent', true));
    stages.push(['match', expr(or(eq(fallback('$collegeEventId', ''), ''), and(eq('$hubCollegeEvent.schoolId', auth.schoolId),
      eq('$hubCollegeEvent.association', '$association'), oneOf('$hubCollegeEvent.status', source === 'personalResult' ? [0, 1, 2, 3] : [1, 2]))))]);
    time = source === 'confirmScore' ? fallback('$recordTime', '$matchTime') : '$matchTime';
    if (source === 'personalSchedule') {
      stages.push(...join('liveScores', '_id', 'hubLive', true, 'matchId'));
      running = and(eq('$hubLive.status', 'live'), eq('$hubLive.schoolId', auth.schoolId), eq('$hubLive.association', '$association'));
    }
  } else if (['teamSchedule', 'teamExperience', 'teamWaiting'].includes(source)) {
    key = 'teamEventEntries';
    stages.push(['match', { ...scope, 'roster.userId': uid, status: { $in: source === 'teamWaiting' ? ['approved', 'locked'] : ['locked'] } }]);
    addEvent('teamEvents', 'eventId', source === 'teamExperience' ? ['finished'] : source === 'teamWaiting' ? ['registration', 'locked'] : ['scheduled', 'running']);
    if (source === 'teamSchedule') {
      stages.push(...join('teamMatches', 'eventId', 'hubMatch', false, 'eventId'));
      stages.push(['match', expr(and(eq('$hubMatch.schoolId', auth.schoolId), eq('$hubMatch.association', '$association'),
        or(eq('$hubMatch.teamA', '$teamId'), eq('$hubMatch.teamB', '$teamId')), oneOf('$hubMatch.status', ['scheduled', 'live'])))]);
      time = '$hubMatch.matchTime'; id = '$hubMatch._id'; subject = 'hubMatch'; running = eq('$hubMatch.status', 'live');
    } else time = source === 'teamWaiting' ? '9999-12-31T23:59:59.999Z' : fallback('$hubEvent.finishedAt', '$hubEvent.startTime');
  } else if (['basketballPlayed', 'footballPlayed'].includes(source)) {
    if (source === 'basketballPlayed') {
      key = 'teamMatchStats';
      stages.push(['match', { ...scope, $or: [{ 'published.players.userId': uid }, { 'published.rows.userId': uid }] }]);
      stages.push(...join('teamMatches', 'matchId', 'hubMatch'));
      stages.push(['match', expr(and(eq('$hubMatch.schoolId', auth.schoolId), eq('$hubMatch.association', '$association'), eq('$hubMatch.eventId', '$eventId'), eq('$hubMatch.status', 'published')))]);
      addEvent('teamEvents', 'eventId', ['scheduled', 'running', 'finished']);
      time = fallback('$hubMatch.publishedAt', '$hubMatch.matchTime'); id = '$hubMatch._id';
    } else {
      key = 'teamMatches';
      stages.push(['match', { ...scope, status: 'published', $or: [{ 'footballPublished.sides.A.players.userId': uid }, { 'footballPublished.sides.B.players.userId': uid }] }]);
      addEvent('teamEvents', 'eventId', ['scheduled', 'running', 'finished']);
      time = fallback('$publishedAt', '$matchTime');
    }
  } else if (['teamOfficial', 'reviewReport'].includes(source)) {
    key = 'teamMatches';
    stages.push(['match', source === 'reviewReport' ? { schoolId: auth.schoolId, association: { $in: auth.managedAssociations || [] },
      $or: [{ status: 'reviewing' }, { status: 'published', footballDraft: { $ne: null, $exists: true } }] }
      : { ...scope, $or: [{ refereeId: uid }, { recorderId: uid }], status: { $in: ['scheduled', 'live'] } }]);
    addEvent('teamEvents', 'eventId', source === 'reviewReport' ? ['scheduled', 'running', 'finished'] : ['scheduled', 'running']);
    time = source === 'reviewReport' ? fallback('$recordedAt', '$updatedAt') : '$matchTime';
    if (source === 'teamOfficial') running = eq('$status', 'live');
  } else if (['meetSchedule', 'meetJudge', 'judgeDraft'].includes(source)) {
    key = source === 'meetSchedule' ? 'sportsMeetEntries' : source === 'meetJudge' ? 'sportsMeetJudgeAssignments' : 'sportsMeetScores';
    stages.push(['match', { schoolId: auth.schoolId, ...(source === 'meetSchedule' ? { userIds: uid, status: 'approved' }
      : source === 'meetJudge' ? { judgeId: uid, status: 'active' } : { judgeId: uid, state: 'draft' }) }]);
    stages.push(...join('sportsMeetSessions', source === 'meetSchedule' ? 'eventKey' : 'sessionKey', 'hubSession', false, source === 'meetSchedule' ? 'eventKey' : '_id'));
    meetParents();
    const sameJudgeRevision = field => eq(fallback(field, 0), fallback('$hubSession.judgeAssignmentRevision', 0));
    if (source === 'meetSchedule') stages.push(['match', expr(or(oneOf('$_id', fallback('$hubSession.entryKeys', [])),
      and(eq({ $size: fallback('$hubSession.entryKeys', []) }, 0), { $ne: ['$hubEvent.rounds', 'heat_final'] })))]);
    if (source === 'meetJudge') stages.push(['match', expr(sameJudgeRevision('$judgeAssignmentRevision'))]);
    if (source === 'judgeDraft') {
      stages.push(...join('sportsMeetJudgeAssignments', 'sessionKey', 'hubAssignment', false, 'sessionKey'));
      stages.push(['match', expr(and(eq('$hubAssignment.schoolId', auth.schoolId), eq('$hubAssignment.meetId', '$meetId'),
        eq('$hubAssignment.eventKey', '$eventKey'), eq('$hubAssignment.judgeId', uid), eq('$hubAssignment.status', 'active'),
        sameJudgeRevision('$hubAssignment.judgeAssignmentRevision')))]);
    }
    time = source === 'judgeDraft' ? '$updatedAt' : '$hubSession.startAt';
    id = source === 'judgeDraft' ? '$_id' : '$hubSession._id'; subject = 'hubSession';
    if (source !== 'judgeDraft') running = eq('$hubSession.status', 'running');
  } else if (['individualWaiting', 'personalHonor'].includes(source)) {
    key = source === 'individualWaiting' ? 'eventSignups' : 'events';
    if (source === 'individualWaiting') {
      stages.push(['match', { ...scope, userId: uid, status: { $in: [1, 2] } }]);
      addEvent('events', 'eventId', [0]);
      stages.push(['match', { 'hubEvent.draw': { $in: [null, false] } }]);
      time = '9999-12-31T23:59:59.999Z';
    } else {
      stages.push(['match', { ...scope, status: 2, 'results.userId': uid }]);
      time = fallback('$finishedAt', '$startTime');
    }
  } else if (['collegeWaiting', 'collegeExperience', 'collegeReturned'].includes(source)) {
    key = 'collegeEntries';
    const manage = (auth.collegeScopes || []).map(row => ({ association: row.association, collegeId: row.collegeId }));
    stages.push(['match', { ...scope, status: source === 'collegeReturned' ? 2 : 1,
      ...(source === 'collegeReturned' ? { $or: manage.length ? manage : [{ _id: '__no_authorized_college__' }] } : { members: uid }) }]);
    addEvent('collegeEvents', 'eventId', source === 'collegeExperience' ? [3] : source === 'collegeReturned' ? [0] : [0, 1]);
    time = source === 'collegeWaiting' ? '9999-12-31T23:59:59.999Z' : source === 'collegeExperience' ? fallback('$hubEvent.finishTime', '$hubEvent.startTime') : '$updatedAt';
  } else if (source === 'teamReturned') {
    key = 'teams'; stages.push(['match', { ...scope, captainId: uid, status: 'active' }]);
    stages.push(...join('teamMembers', '_id', 'hubMembership', false, 'teamId'));
    stages.push(['match', expr(and(eq('$hubMembership.schoolId', auth.schoolId), eq('$hubMembership.association', '$association'),
      eq('$hubMembership.userId', uid), eq('$hubMembership.status', 'active')))]);
    stages.push(...join('teamEventEntries', '_id', 'hubEntry', false, 'teamId'));
    stages.push(['match', expr(and(eq('$hubEntry.schoolId', auth.schoolId), eq('$hubEntry.association', '$association'), eq('$hubEntry.status', 'rejected')))]);
    addEvent('teamEvents', 'hubEntry.eventId', ['registration']);
    time = '$hubEntry.updatedAt'; id = '$hubEntry._id';
  } else if (source === 'membershipReview') {
    key = 'schoolMembers'; stages.push(['match', { schoolId: auth.schoolId, status: auth.canReviewMembers ? 'pending' : '__not_authorized__' }]);
    time = fallback('$updatedAt', '$appliedAt');
  } else if (source === 'meetResult') {
    key = 'sportsMeetPublications';
    stages.push(['match', { schoolId: auth.schoolId, status: 'published', 'rows.userIds': uid }]);
    meetParents(false);
    stages.push(['unwind', { path: '$rows' }]);
    stages.push(['match', { 'rows.userIds': uid, 'rows.status': 'result' }]);
    stages.push(['addFields', {
      publicationKey: '$_id', entryKey: '$rows.entryKey',
      rank: '$rows.rank', userIds: '$rows.userIds', collegeId: '$rows.collegeId',
      hubPublication: { official: '$official', roundLabel: '$roundLabel' },
    }]);
    // 保持原明细行主键，升级前发出的游标仍使用同一排序边界。
    id = { $concat: ['mtrow:', '$_id', ':', '$rows.entryKey'] };
    time = '$publishedAt';
  }
  if (!key) throw new Error('未知个人体育数据源');
  if (section === 'schedule' && !source.endsWith('Waiting')) {
    const upper = new Date(Date.parse(query.asOf) + 90 * 86400000).toISOString();
    stages.push(['match', expr(or(...(running ? [running] : []), and({ $gte: [time, query.asOf] }, { $lte: [time, upper] }))) ]);
    if (running) time = { $cond: { if: running, then: '', else: time } };
  }
  stages.push(['addFields', { __hubTime: fallback(time, ''), __hubId: id }]);
  // 同一场可能由多个报名关系命中，在限量前去重，游标始终对应真实场次。
  stages.push(['group', { _id: '$__hubId', document: { $first: '$$ROOT' } }], ['replaceRoot', { newRoot: '$document' }]);
  const direction = DIRECTIONS[section];
  if (query.cursor) stages.push(['match', { $or: [
    { __hubTime: { [direction > 0 ? '$gt' : '$lt']: query.cursor.time } },
    { __hubTime: query.cursor.time, __hubId: { [direction > 0 ? '$gt' : '$lt']: query.cursor.id } },
  ] }]);
  const limit = Number.isInteger(query.limit) ? Math.max(1, Math.min(query.limit, PAGE_MAX)) : 20;
  stages.push(['sort', { __hubTime: direction, __hubId: direction }], ['limit', limit + 1]);
  const fields = ['_id', 'schoolId', 'association', 'eventId', 'collegeEventId', 'tieId', 'collegeId', 'teamId', 'teamA', 'teamB',
    'matchTime', 'location', 'winner', 'scoreA', 'scoreB', 'status', 'outcome', 'referee', 'refereeId', 'recorderId', 'recorder',
    'revision', 'sportFormat', 'meetId', 'eventKey', 'sessionKey', 'rank', 'entryKey', 'publicationKey', 'version', 'reason', 'transferFrom', 'results', '__hubTime', '__hubId',
    ...['title', 'name', 'location', 'rounds'].map(field => `hubEvent.${field}`), 'hubCollegeEvent.title', 'hubCollegeEvent.location',
    ...['_id', 'eventId', 'teamA', 'teamB', 'matchTime', 'location', 'status', 'sportFormat', 'refereeId', 'recorderId'].map(field => `hubMatch.${field}`),
    ...['_id', 'venue', 'roundLabel', 'round', 'index', 'status'].map(field => `hubSession.${field}`),
    'hubMeet.name', 'hubMeet.location', 'hubPublication.official', 'hubPublication.roundLabel', 'hubEntry.reason', 'hubEntry.eventId'];
  stages.push(['project', Object.fromEntries(fields.map(field => [field, 1]))]);
  return { source, section, key, stages, limit, subject };
}

/** 演示仓储使用相同查询计划的有限操作集合；不参与云端的数据库查询执行。 */
const at = (row, path) => path.split('.').reduce((value, field) => value == null ? undefined : value[field], row);
function evaluate(value, row) {
  if (value === '$$ROOT') return row;
  if (typeof value === 'string' && value[0] === '$') return at(row, value.slice(1));
  if (Array.isArray(value)) return value.map(item => evaluate(item, row));
  if (!value || typeof value !== 'object') return value;
  const [op] = Object.keys(value); const args = evaluate(value[op], row);
  if (op === '$ifNull') return args[0] == null ? args[1] : args[0];
  if (op === '$eq') return args[0] === args[1];
  if (op === '$concat') return args.join('');
  if (op === '$ne') return args[0] !== args[1];
  if (op === '$in') return Array.isArray(args[1]) && args[1].includes(args[0]);
  if (op === '$and') return args.every(Boolean);
  if (op === '$or') return args.some(Boolean);
  if (op === '$gte') return args[0] != null && args[0] >= args[1];
  if (op === '$lte') return args[0] != null && args[0] <= args[1];
  if (op === '$size') return Array.isArray(args) ? args.length : 0;
  if (op === '$cond') return args.if ? args.then : args.else;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item, row)]));
}
function matches(row, query) {
  return Object.entries(query).every(([field, cond]) => {
    if (field === '$expr') return Boolean(evaluate(cond, row));
    if (field === '$and') return cond.every(item => matches(row, item));
    if (field === '$or') return cond.some(item => matches(row, item));
    const values = fieldValues(row, field), raw = at(row, field);
    if (!cond || typeof cond !== 'object') return cond === null ? raw == null : values.includes(cond);
    return Object.entries(cond).every(([op, expected]) => {
      if (op === '$in') return expected.some(item => item === null ? raw == null : values.includes(item));
      if (op === '$ne') return expected === null ? raw != null : !values.includes(expected);
      if (op === '$exists') return (raw !== undefined) === expected;
      if (op === '$gt') return raw != null && raw > expected;
      if (op === '$lt') return raw != null && raw < expected;
      return false;
    });
  });
}
function memoryPersonalPage(list, source, auth, query) {
  const plan = queryPlan(source, auth, query);
  let rows = list(plan.key).map(row => ({ ...row }));
  for (const [kind, spec] of plan.stages) {
    if (kind === 'match') rows = rows.filter(row => matches(row, spec));
    if (kind === 'lookup') rows = rows.map(row => ({ ...row, [spec.as]: list(spec.key).filter(other => fieldValues(row, spec.localField).some(value => fieldValues(other, spec.foreignField).includes(value))) }));
    if (kind === 'unwind') {
      const field = spec.path.slice(1);
      rows = rows.flatMap(row => Array.isArray(row[field]) && row[field].length ? row[field].map(value => ({ ...row, [field]: value }))
        : spec.preserveNullAndEmptyArrays ? [{ ...row, [field]: null }] : []);
    }
    if (kind === 'addFields') rows = rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(spec).map(([key, val]) => [key, evaluate(val, row)])) }));
    if (kind === 'group') rows = [...new Map(rows.map(row => [row.__hubId, { document: row }])).values()];
    if (kind === 'replaceRoot') rows = rows.map(row => row.document);
    if (kind === 'sort') rows.sort((a, b) => { for (const [field, dir] of Object.entries(spec)) if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * dir; return 0; });
    if (kind === 'limit') rows = rows.slice(0, spec);
    if (kind === 'project') rows = rows.map(row => {
      const out = {};
      for (const field of Object.keys(spec)) {
        const value = at(row, field); if (value === undefined) continue;
        const parts = field.split('.'); let object = out;
        while (parts.length > 1) { const key = parts.shift(); object = object[key] || (object[key] = {}); }
        object[parts[0]] = value;
      }
      return out;
    });
  }
  return { rows: rows.slice(0, plan.limit), hasMore: rows.length > plan.limit };
}
module.exports = { SECTIONS, SOURCES, DIRECTIONS, PAGE_MAX, queryPlan, memoryPersonalPage };
