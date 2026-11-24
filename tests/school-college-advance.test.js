/**
 * 学校维度：学院赛小场出结果后的大场推进（迁移清单 M2-c2）
 *
 * 守的是：
 *   1. 学院赛小场经 `submitScheduledMatch`（按 matchId 补录）录分、对手确认生效后，
 *      结果写回大场（`legs[].winner` 换成学院名、净胜分），全小项都有结果时定出大场胜负；
 *   2. 本轮大场全部结束时，按胜者排出下一轮大场，且「只补不覆盖」、带范围；
 *   3. 撤销小场时：已排进下一轮的一律撤不动（要求从最后一轮往前撤）；撤决定性的一场
 *      （会让大场永远打不完）被拒；撤无关紧要的一场只收回比分、不改大场结论。
 *
 * 链路跨 `school-college-service`（大场 / 小场 / 排阵）与 `school-match-service`
 * （小场录分 / 确认 / 撤销），故单列一份用例，不与 M2-a/b/c 的页面接线用例混在一起。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../src/server/services/school-context');
const college = require('../src/server/services/school-college-service');
const match = require('../src/server/services/school-match-service');
const { collegeTieKey } = require('../src/shared/services/college-draw');
const { collegeLegKey } = require('../src/shared/services/college-tie');
const { schoolMemberKey } = require('../src/shared/utils/school');
const {
  COLLEGES, TIE_STATUS, LEG_DISCIPLINE, TIE_ALGO, TIE_NET_MODE, MATCH_COMPETITION,
} = require('../src/shared/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

/** 四个学院各两名会员（一男一女），够铺「男单 + 女单」两个小项。 */
const COLLEGE_DEFS = [
  { id: 'c01', name: COLLEGES[0], male: 'adv_a_m', female: 'adv_a_f' },
  { id: 'c02', name: COLLEGES[1], male: 'adv_b_m', female: 'adv_b_f' },
  { id: 'c03', name: COLLEGES[2], male: 'adv_c_m', female: 'adv_c_f' },
  { id: 'c04', name: COLLEGES[3], male: 'adv_d_m', female: 'adv_d_f' },
];
const defByName = name => COLLEGE_DEFS.find(item => item.name === name);

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, collegeId, gender) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
  };
  for (const def of COLLEGE_DEFS) {
    add(def.male, def.id, 'M');
    add(def.female, def.id, 'F');
  }
  return createSchoolMemoryRepo(seed);
}

async function call(repo, mod, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await mod[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '院际杯', description: '学院团体赛',
  legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS], allowMultiEntry: true,
  rosterMin: 1, rosterMax: 5, tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF,
  startTime: at(DAY), location: '综合体育馆', courtCount: 2, ...extra,
});

/** 发布 → 四院报名通过 → 抽签 → 开赛：得到首轮两场大场。 */
async function toRound1(repo) {
  const pub = await call(repo, college, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(pub.ok, true, pub.message);
  const eventId = pub.event.eventId;
  for (const def of COLLEGE_DEFS) {
    const sub = await call(repo, college, 'submitCollegeEntry',
      { eventId, collegeId: def.id, memberIds: [def.male, def.female] });
    assert.equal(sub.ok, true, sub.message);
    const app = await call(repo, college, 'reviewCollegeEntry',
      { eventId, collegeId: def.id, action: 'approve' });
    assert.equal(app.ok, true, app.message);
  }
  const drawn = await call(repo, college, 'drawCollegeEvent', { eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  const started = await call(repo, college, 'startCollegeEvent', { eventId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.ties.length, 2, '四院两场大场');
  return { eventId, ties: started.ties };
}

/** 发布 → 两院报名通过 → 抽签 → 开赛：得到一场大场（男单 + 女单）。 */
async function toSingleTie(repo) {
  const pub = await call(repo, college, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(pub.ok, true, pub.message);
  const eventId = pub.event.eventId;
  for (const def of [COLLEGE_DEFS[0], COLLEGE_DEFS[1]]) {
    const sub = await call(repo, college, 'submitCollegeEntry',
      { eventId, collegeId: def.id, memberIds: [def.male, def.female] });
    assert.equal(sub.ok, true, sub.message);
    const app = await call(repo, college, 'reviewCollegeEntry',
      { eventId, collegeId: def.id, action: 'approve' });
    assert.equal(app.ok, true, app.message);
  }
  const drawn = await call(repo, college, 'drawCollegeEvent', { eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  const started = await call(repo, college, 'startCollegeEvent', { eventId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.ties.length, 1, '两院一场大场');
  return { eventId, tie: started.ties[0] };
}

/** 给一场大场双方排阵并开大场（铺出两个小场）。 */
async function startTie(repo, tie) {
  const a = defByName(tie.collegeA);
  const b = defByName(tie.collegeB);
  for (const def of [a, b]) {
    const lineup = await call(repo, college, 'submitCollegeLineup', {
      tieId: tie.tieId, collegeId: def.id,
      entries: [{ legNo: 1, players: [def.male] }, { legNo: 2, players: [def.female] }],
    });
    assert.equal(lineup.ok, true, lineup.message);
  }
  const started = await call(repo, college, 'startCollegeTie', { tieId: tie.tieId });
  assert.equal(started.ok, true, started.message);
}

/** 小场录分 + 对手确认，走的是「按 matchId 补录」那条通路。 */
async function playLeg(repo, eventId, tie, legNo, winner = 'A') {
  const a = defByName(tie.collegeA);
  const b = defByName(tie.collegeB);
  const legId = collegeLegKey(eventId, tie.tieId, legNo);
  const [aMember, bMember] = legNo === 1 ? [a.male, b.male] : [a.female, b.female];
  const scores = winner === 'A' ? { scoreA: [11], scoreB: [7] } : { scoreA: [7], scoreB: [11] };

  const submitted = await call(repo, match, 'submitSchoolMatch',
    { matchId: legId, ...scores }, { actor: aMember });
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.match.competition, MATCH_COMPETITION.COLLEGE);

  const confirmed = await call(repo, match, 'confirmSchoolMatch', { matchId: legId }, { actor: bMember });
  assert.equal(confirmed.ok, true, confirmed.message);
  return legId;
}

test('小场确认 → 结果写回大场，两个小项齐了定出大场胜负', async () => {
  const repo = fixture();
  const { eventId, ties } = await toRound1(repo);
  const tie = ties[0];
  await startTie(repo, tie);

  const a = defByName(tie.collegeA);
  const b = defByName(tie.collegeB);

  // 第一个小项：A 院胜。大场还没打完，仍是进行中。
  await playLeg(repo, eventId, tie, 1, 'A');
  let stored = await repo.ties.getById(tie.tieId);
  assert.equal(stored.legs[0].winner, a.name, '小项胜者记成学院名');
  assert.equal(stored.legs[0].matchId, collegeLegKey(eventId, tie.tieId, 1));
  assert.equal(stored.legs[0].pointsA, 11);
  assert.equal(stored.legs[0].pointsB, 7);
  assert.equal(stored.status, TIE_STATUS.ONGOING, '还差一个小项，大场未结束');
  assert.equal(stored.winner, null);

  // 第二个小项：B 院胜 → 一比一，按「胜场差」仍平（两套口径都平）→ 判未决，不记假胜者。
  await playLeg(repo, eventId, tie, 2, 'B');
  stored = await repo.ties.getById(tie.tieId);
  assert.equal(stored.legs[1].winner, b.name);
  assert.equal(stored.winner, null, '一胜一负判未决，不硬判一方');
  assert.equal(stored.status, TIE_STATUS.ONGOING);
});

test('本轮全部打完 → 按胜者排出下一轮大场，带范围且只补不覆盖', async () => {
  const repo = fixture();
  const { eventId, ties } = await toRound1(repo);
  for (const tie of ties) {
    await startTie(repo, tie);
    // 每场大场让 A 院两盘全胜，胜负明确（2:0）。
    await playLeg(repo, eventId, tie, 1, 'A');
    await playLeg(repo, eventId, tie, 2, 'A');
  }

  const winners = ties.map(tie => defByName(tie.collegeA).name).sort();
  for (const tie of ties) {
    const stored = await repo.ties.getById(tie.tieId);
    assert.equal(stored.status, TIE_STATUS.FINISHED);
    assert.equal(stored.winner, defByName(tie.collegeA).name, '各场大场胜者落定');
  }

  const final = await repo.ties.getById(collegeTieKey(eventId, 2, 0));
  assert.ok(final, '首轮打完排出了第二轮大场');
  assert.deepEqual([final.collegeA, final.collegeB].sort(), winners);
  assert.equal(final.round, 2);
  assert.equal(final.schoolId, 'muc');
  assert.equal(final.association, 'pkb');
  assert.equal(final.status, TIE_STATUS.PENDING_LINEUP, '下一轮大场等双方排阵');
  assert.equal(final.legs.length, 2, '下一轮大场同样按 legPlan 铺好小项');

  // 幂等：已确认的小场不能再补录（录分只认「待确认」），也就不会重复推进、
  // 重复铺下一轮。
  const before = (await repo.ties.list()).filter(t => t.eventId === eventId).length;
  const again = await call(repo, match, 'submitSchoolMatch',
    { matchId: collegeLegKey(eventId, ties[0].tieId, 1), scoreA: [11], scoreB: [7] },
    { actor: defByName(ties[0].collegeA).male });
  assert.equal(again.ok, false, '已确认的小场不能再补录');
  const after = (await repo.ties.list()).filter(t => t.eventId === eventId).length;
  assert.equal(after, before);
});

test('撤销小场已取消：学院赛小场一经确认即为最终结算', async () => {
  // Elo 逐场结算改造：撤销入口整体移除（服务实现不再导出），
  // 「从最后一轮往前撤」「回收大场结果」两条路径不复存在。
  const repo = fixture();
  const { eventId, tie } = await toSingleTie(repo);
  await startTie(repo, tie);
  await playLeg(repo, eventId, tie, 1, 'A');

  const mod = require('../src/server/services/school-match-service.js');
  assert.equal(typeof mod.revokeSchoolMatch, 'undefined', '撤销实现已删除');
  const stored = await repo.ties.getById(tie.tieId);
  assert.equal(stored.legs[0].winner, defByName(tie.collegeA).name, '已生效的小场结果保持不变');
});
