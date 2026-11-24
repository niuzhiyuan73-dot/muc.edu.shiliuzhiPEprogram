const assert = require('node:assert/strict');
const mock = require('../../src/mock/school-mock.js');
const session = require('../../miniprogram/services/school-session');
const association = require('../../miniprogram/services/association-scope');
const space = require('../../miniprogram/services/association-space');
const { COLLEGES } = require('../../src/shared/utils/constants');

const scope = { schoolId: 'muc', association: 'pkb' };
const ADMIN = 'demo_muc_admin';
const LEADER = 'demo_muc_college_leader';
const MEMBER = 'demo_muc_member';
const collegeId = name => `c${String(COLLEGES.indexOf(name) + 1).padStart(2, '0')}`;
const eventOf = row => row && ({ ...row, _id: row.eventId });
const tieOf = row => ({ ...row, _id: row.tieId, legs: row.legRows,
  lineupA: row.lineupASubmitted, lineupB: row.lineupBSubmitted });

// All writes go through actual protocol-2 handlers. These aliases only keep existing
// page assertions readable; they never touch the legacy mock or fabricate permissions.
function createCollegeFixture() {
  const previous = { actor: mock.getDemoActor(), school: session.getSchoolId(), association: association.getAssociation() };
  mock.reset({ withDemoContent: false });
  session.reset();
  session.setSchoolId(scope.schoolId);
  association.setAssociation(scope.association);
  mock.setDemoActor(ADMIN);
  let sequence = 0;
  const entries = new Map();
  function api(actor = mock.getDemoActor(), target = scope) {
    const before = mock.getDemoActor();
    mock.setDemoActor(actor);
    const client = space.forScope(target);
    mock.setDemoActor(before);
    return client;
  }
  const requireOk = dto => { assert.equal(dto.ok, true, dto.message); return dto; };
  const fixture = {
    api, scope, to: actor => mock.setDemoActor(actor),
    async getMembers() {
      return requireOk(await api(ADMIN).listSchoolMembers({})).members.map(row => ({
        ...row, _id: row.userId, college: row.collegeName, status: 1,
      }));
    },
    async getCollegeEvents() {
      const rows = requireOk(await api(ADMIN).listCollegeEvents({ limit: 100 })).events;
      return Promise.all(rows.map(row => fixture.getCollegeEvent(row.eventId)));
    },
    async getCollegeEvent(eventId) {
      return eventOf(requireOk(await api(ADMIN).getCollegeEvent({ eventId })).event);
    },
    async publishCollegeEvent(payload, actor = ADMIN) {
      const dto = await api(actor).publishCollegeEvent({ ...payload, requestId: `college-fixture-${++sequence}` });
      return { ...dto, record: dto.ok ? await fixture.getCollegeEvent(dto.event.eventId) : null };
    },
    async getCollegeEntries(eventId) {
      return requireOk(await api(ADMIN).listCollegeEntries({ eventId })).entries.map(row => {
        entries.set(row.entryId, row);
        return { ...row, _id: row.entryId, members: row.memberIds };
      });
    },
    submitCollegeEntry(payload, actor = LEADER) {
      return api(actor).submitCollegeEntry({ ...payload, collegeId: collegeId(payload.college) });
    },
    reviewCollegeEntry(entryId, action, reason, actor = ADMIN) {
      const row = entries.get(entryId);
      assert.ok(row, 'Read the entry before reviewing it');
      return api(actor).reviewCollegeEntry({ eventId: row.eventId, collegeId: collegeId(row.college), action, reason });
    },
    async drawCollegeEvent(eventId, actor = ADMIN, options = {}) {
      const dto = await api(actor).drawCollegeEvent({ eventId, ...options });
      return { ...dto, record: dto.ok ? await fixture.getCollegeEvent(eventId) : null };
    },
    async startCollegeEvent(eventId, actor = ADMIN) {
      const dto = await api(actor).startCollegeEvent({ eventId });
      return { ...dto, ties: (dto.ties || []).map(tieOf) };
    },
    async getCollegeTies(eventId) {
      return requireOk(await api(ADMIN).listCollegeTies({ eventId })).ties.map(tieOf);
    },
    async getCollegeLineups(eventId) {
      return requireOk(await api(ADMIN).listCollegeLineups({ eventId })).lineups;
    },
    submitLineup(payload, actor = LEADER) {
      return api(actor).submitCollegeLineup({ ...payload, collegeId: collegeId(payload.college) });
    },
    startTie: (tieId, actor = ADMIN) => api(actor).startCollegeTie({ tieId }),
    assignTieReferee: (tieId, refereeId, actor = ADMIN) => api(actor).assignCollegeTieReferee({ tieId, refereeId }),
    async getMatchRecords() {
      return requireOk(await api(ADMIN).listSchoolMatches({})).matches.map(row => ({ ...row, _id: row.matchId }));
    },
    close() {
      mock.reset();
      if (mock.DEMO_ACTORS.some(item => item.id === previous.actor)) mock.setDemoActor(previous.actor);
      session.reset();
      if (previous.school) session.setSchoolId(previous.school);
      association.setAssociation(previous.association);
    },
  };
  return fixture;
}

module.exports = { createCollegeFixture, ADMIN, LEADER, MEMBER, collegeId };
