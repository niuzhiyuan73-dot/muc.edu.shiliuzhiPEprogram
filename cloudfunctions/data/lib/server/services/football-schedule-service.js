/** 足球排期：预留 20 分钟补时/点球缓冲；用协会配置版本串行化排期，封住新增场次窗口。 */
const { canReadAssociationSpace, canManageAssociationSpace } = require('./association-space-permission');
const { buildSchoolContext } = require('./school-context');
const { schoolAssociationKey, schoolMemberKey } = require('../../shared/utils/school');
const { matchMinutes } = require('../../shared/utils/football-report');
const { teamSportStrategyFor } = require('../../shared/utils/team-sport-rules');
const { parseMeetTime } = require('./meet-time');
const ok = data => ({ ok: true, data });
const fail = message => ({ ok: false, message });
const scoped = (row, ctx) => row && row.schoolId === ctx.schoolId && row.association === ctx.association;
function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const n = parseMeetTime(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}
function conflicts(matches, events) {
  const eventById = new Map(events.map(e => [e._id, e]));
  const resources = new Map();
  for (const match of matches) {
    if (!match.matchTime || match.status === 'canceled') continue;
    const event = eventById.get(match.eventId);
    const start = Date.parse(match.matchTime);
    if (!Number.isFinite(start)) continue;
    const end = start + (match.durationMinutes || (event ? matchMinutes(event.rules, event.format) : 120)) * 60000;
    for (const [kind, id] of [['球队', match.teamA], ['球队', match.teamB], ['场地', match.location], ['裁判', match.refereeId]]) {
      if (!id) continue;
      const key = `${kind}:${id}`;
      if (!resources.has(key)) resources.set(key, { kind, rows: [] });
      resources.get(key).rows.push({ id: match._id, start, end });
    }
  }
  for (const { kind, rows } of resources.values()) {
    rows.sort((a, b) => a.start - b.start);
    let previous = null;
    for (const row of rows) {
      if (previous && row.start < previous.end && previous.id !== row.id) {
        return `赛程冲突：${kind}在预留时间内重叠（${previous.id} / ${row.id}）`;
      }
      if (!previous || row.end > previous.end) previous = row;
    }
  }
  return '';
}
async function change(payload, ctx, roundMode) {
  if (!ctx.actorId || !canReadAssociationSpace(ctx) || !canManageAssociationSpace(ctx)) return ok(fail('只有有效的协会管理者可以排赛程'));
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(payload.requestId || '')) return ok(fail('缺少请求编号，请刷新后重试'));
  const repo = ctx.repo.forScope(ctx);
  const configId = schoolAssociationKey(ctx);
  const config = await repo.schoolAssociations.getById(configId);
  const targets = roundMode
    ? (await repo.teamMatches.listByEvent(payload.eventId)).filter(m => m.round === payload.round && (!payload.stage || m.stage === payload.stage))
    : [await repo.teamMatches.getById(payload.matchId)].filter(Boolean);
  if (!targets.length) return ok(fail('比赛或轮次不存在'));
  if (targets.length > 30) return ok(fail('本轮超过单次处理容量，请按阶段分别排期'));
  const event = await repo.teamEvents.getById(targets[0].eventId);
  if (!scoped(event, ctx) || teamSportStrategyFor(ctx.association, event)?.sportFormat !== 'football11') return ok(fail('赛事规则不匹配'));
  const writes = [];
  const shift = Number(payload.shiftMinutes);
  if (roundMode && (!Number.isInteger(shift) || !shift || Math.abs(shift) > 240)) return ok(fail('顺延需为非零整数，一次不超过 240 分钟'));
  for (const match of targets) {
    if (match.status !== 'scheduled') { if (roundMode) continue; return ok(fail('只有尚未录分的比赛可以改赛程')); }
    if (roundMode && !match.matchTime) continue;
    const patch = {};
    if (roundMode) patch.matchTime = new Date(Date.parse(match.matchTime) + shift * 60000).toISOString();
    else {
      if (!Number.isInteger(payload.expectRevision)) return ok(fail('缺少比赛版本，请刷新后重试'));
      for (const key of ['matchTime', 'location', 'refereeId', 'recorderId', 'durationMinutes']) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
        if (key === 'matchTime') {
          patch.matchTime = parseTime(payload[key]);
          if (patch.matchTime === undefined) return ok(fail('开赛时间格式不正确'));
        } else if (key === 'durationMinutes') {
          const n = Number(payload[key]);
          if (!Number.isInteger(n) || n < matchMinutes(event.rules, event.format) || n > 480) return ok(fail(`预留时长至少 ${matchMinutes(event.rules, event.format)} 分钟，最多 480 分钟`));
          patch.durationMinutes = n;
        } else {
          if (payload[key] != null && typeof payload[key] !== 'string') return ok(fail('场地或人员格式不正确'));
          patch[key] = (payload[key] || '').trim();
          if (key === 'location' && patch[key].length > 40) return ok(fail('场地名称不超过 40 字'));
        }
      }
      if (!Object.keys(patch).length) return ok(fail('没有要修改的内容'));
    }
    writes.push({ ...match, ...patch, durationMinutes: patch.durationMinutes || match.durationMinutes || matchMinutes(event.rules, event.format),
      revision: match.revision + 1, scheduleUpdatedBy: ctx.actorId, scheduleUpdatedAt: new Date(ctx.now).toISOString() });
  }
  const requestKey = `${ctx.actorId}:${roundMode ? 'shift' : 'schedule'}:${payload.requestId}`;
  // 幂等回执先于冲突检查，重试不会把整轮再次顺延。
  const existing = (config?.footballScheduleRequests || []).find(r => r.key === requestKey);
  if (existing) return ok(existing.result);
  if (roundMode && (!Number.isInteger(payload.expectRevision) || payload.expectRevision !== event.revision)) return ok(fail('缺少赛事版本或赛程已变动，请刷新后重试'));
  if (!writes.length) return ok(fail('这一轮没有可顺延的未开赛场次'));
  const candidates = await repo.teamMatches.listScheduleCandidates(writes);
  const writeIds = new Set(writes.map(m => m._id));
  const planned = [...candidates.filter(m => !writeIds.has(m._id)), ...writes];
  const events = await repo.teamEvents.listByIds([...new Set(planned.map(m => m.eventId))]);
  const conflict = conflicts(planned, events);
  if (conflict) return ok(fail(conflict));
  return ok(await ctx.repo.transaction(async root => {
    const context = await buildSchoolContext({ repo: root, actorId: ctx.actorId, scope: ctx, now: ctx.now });
    const fresh = { ...context, now: new Date(context.now).toISOString() };
    if (!canReadAssociationSpace(fresh) || !canManageAssociationSpace(fresh)) return fail('当前已无排期权限');
    const tx = root.forScope(fresh);
    const currentConfig = await tx.schoolAssociations.getById(configId);
    const retry = (currentConfig?.footballScheduleRequests || []).find(r => r.key === requestKey);
    if (retry) return retry.result;
    if (!currentConfig || (currentConfig.footballScheduleRevision || 0) !== (config?.footballScheduleRevision || 0)) return fail('赛程刚被改过，请刷新后重试');
    const currentEvent = await tx.teamEvents.getById(event._id);
    if (!currentEvent || currentEvent.revision !== event.revision || ['finished', 'canceled'].includes(currentEvent.status)) return fail('赛事刚被改过或已结束，请刷新');
    for (const doc of writes) {
      const current = await tx.teamMatches.getById(doc._id);
      if (!current || current.revision !== doc.revision - 1 || (!roundMode && current.revision !== payload.expectRevision)) return fail('比赛刚被改过，请刷新后重试');
      if (!roundMode) for (const role of ['referee', 'recorder']) {
        const id = doc[`${role}Id`];
        if (!id) { doc[`${role}Name`] = ''; continue; }
        const user = await root.users.getById(id);
        const member = await tx.schoolMembers.getById(schoolMemberKey(id, fresh.schoolId));
        if (!user || user.platformStatus !== 'active' || user.primarySchoolId !== fresh.schoolId
          || member?.status !== 'active') return fail('指派人员须为本校有效协会会员');
        if (role === 'referee') {
          const a = await tx.teams.getById(doc.teamA); const b = await tx.teams.getById(doc.teamB);
          if ([a?.captainId, b?.captainId].includes(id)) return fail('参赛队队长不能执法自己队的比赛');
        }
        doc[`${role}Name`] = user.realName || user.nickName || id;
      }
    }
    const result = { ok: true, shifted: writes.length, skipped: targets.length - writes.length,
      revision: writes[0].revision, matchId: writes[0]._id, message: '' };
    for (const doc of writes) await tx.teamMatches.set(doc._id, doc);
    await tx.teamEvents.set(event._id, { ...currentEvent, revision: currentEvent.revision + 1, updatedAt: fresh.now });
    await tx.schoolAssociations.set(configId, { ...currentConfig,
      footballScheduleRevision: (currentConfig.footballScheduleRevision || 0) + 1,
      footballScheduleRequests: [...(currentConfig.footballScheduleRequests || []), { key: requestKey, result }].slice(-32) });
    return result;
  }));
}
module.exports = { conflicts, updateTeamMatchSchedule: (payload, ctx) => change(payload, ctx, false),
  updateTeamRoundSchedule: (payload, ctx) => change(payload, ctx, true) };
