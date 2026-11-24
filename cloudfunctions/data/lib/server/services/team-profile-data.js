const { unique } = require('./scoped-team-reads.js');

/** Current/left memberships and immutable entry snapshots both contribute history. */
async function loadTeamProfileData(ctx, userId, { football = false } = {}) {
  const repo = ctx.repo.forScope(ctx);
  const [mine, entries, statDocs, playerMatches, user] = await Promise.all([
    repo.teamMembers.listByUser(userId), repo.teamEventEntries.listForUser(userId),
    football ? [] : repo.teamMatchStats.listForUser(userId),
    football ? repo.teamMatches.listForPlayer(userId) : [],
    ctx.repo.users.getById(userId),
  ]);
  const teamIds = [...new Set([...mine.map(row => row.teamId), ...entries.map(row => row.teamId)])];
  const eventIds = [...new Set(entries.map(row => row.eventId))];
  const [teams, members, byTeams, byEvents, byStats] = await Promise.all([
    repo.teams.listByIds(teamIds), repo.teamMembers.listByTeams(teamIds),
    repo.teamMatches.listByTeams(teamIds), repo.teamMatches.listByEvents(eventIds),
    repo.teamMatches.listByIds(statDocs.map(row => row.matchId)),
  ]);
  const matches = unique([...byTeams, ...byEvents, ...byStats, ...playerMatches]);
  const events = await repo.teamEvents.listByIds([...new Set([
    ...eventIds, ...matches.map(row => row.eventId), ...statDocs.map(row => row.eventId),
  ])]);
  return { teams, members, entries, events, matches, statDocs, user };
}

function indexMatches(matches, field) {
  const result = new Map();
  for (const match of matches) {
    const keys = field === 'team' ? [match.teamA, match.teamB] : [match[field]];
    for (const key of new Set(keys)) {
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(match);
    }
  }
  return result;
}
module.exports = { loadTeamProfileData, indexMatches };
