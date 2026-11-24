/**
 * 个人主页的读量（2026-10-22 大用户量复查 H-2）
 * ============================================================
 * 个人主页原来走 `loadScopeView(ctx)` 的默认参数：把本范围**全部历史比赛**
 * 读回来，而它的每一块（走势 / 交锋 / 搭档 / 逐场战绩 / 近期状态）都只筛
 * **这一个人**。8000 场就是 80 页 RPC，而且随办学年限线性变慢。
 * 训练报名同理：只增不减，3000 条是 30 页，而一个人只有几十条。
 *
 * 这条测试盯的是「取哪条路」，不是数字：只要有人把 matches 的整表读改回来，
 * 或者把训练报名改回 `list()`，它就会红。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const rank = require('../src/server/services/school-rank-service');
const {
  collegeKey, schoolMemberKey, memberRatingKey, schoolAssociationKey,
} = require('../src/shared/utils/school');
const { MATCH_STATUS, SETTLEMENT_STATUS, MATCH_TYPE } = require('../src/shared/utils/constants');

const SCHOOL = 'muc';
const ASSOC = 'pkb';
const NOW = new Date('2026-10-20T10:00:00Z');

const users = ['u_me', 'u_rival', 'u_other'].map(id => ({
  _id: id, openId: `o_${id}`, nickName: id, gender: 'M',
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));

const schoolMembers = users.map(user => ({
  _id: schoolMemberKey(user._id, SCHOOL), schoolId: SCHOOL, userId: user._id,
  collegeId: 'c01', status: 'active', gender: 'M',
}));

/** 一条已生效、带计分结算快照的比赛 */
const ratedMatch = (id, a, b, seq) => ({
  _id: id, schoolId: SCHOOL, association: ASSOC,
  matchType: MATCH_TYPE.SINGLES, pool: 'singles',
  teamA: [a], teamB: [b], scoreA: [11], scoreB: [5], winner: 'A',
  matchTime: new Date(NOW.getTime() - seq * 3600000).toISOString(),
  status: MATCH_STATUS.ACTIVE,
  settlement: {
    status: SETTLEMENT_STATUS.RATED, settlementSeq: seq,
    // 真实结算写进快照的字段：pool / side / isWin 都会被统计层读，
    // 少写一个 pool 就会在「按池筛流水」那一步被静默丢掉。
    players: [
      { userId: a, pool: 'singles', side: 'A', isWin: true, eloBefore: 1500, eloAfter: 1516, eloDelta: 16 },
      { userId: b, pool: 'singles', side: 'B', isWin: false, eloBefore: 1500, eloAfter: 1484, eloDelta: -16 },
    ],
  },
});

function seedOf() {
  return {
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users,
    schoolMembers,
    colleges: [{ _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '一院', status: 'active' }],
    schoolAssociations: [{
      _id: schoolAssociationKey({ schoolId: SCHOOL, association: ASSOC }),
      schoolId: SCHOOL, association: ASSOC, status: 'active',
    }],
    memberRatings: ['u_me', 'u_rival', 'u_other'].map((userId) => {
      const doc = {
        _id: memberRatingKey(userId, 'singles', { schoolId: SCHOOL, association: ASSOC }),
        schoolId: SCHOOL, association: ASSOC, userId, pool: 'singles',
        elo: userId === 'u_me' ? 1516 : 1484, startElo: 1500,
        matchCount: 1, wins: userId === 'u_me' ? 1 : 0, losses: userId === 'u_me' ? 0 : 1,
      };
      return doc;
    }),
    matches: [
      ratedMatch('m_mine', 'u_me', 'u_rival', 1),
      // 别人之间的比赛：不该进「我」的走势与战绩
      ratedMatch('m_other', 'u_other', 'u_rival', 2),
    ],
    events: [{
      _id: 'ev_1', schoolId: SCHOOL, association: ASSOC, title: '新生杯',
      matchType: MATCH_TYPE.SINGLES, pool: 'singles', status: 2,
      startTime: new Date(NOW.getTime() - 7200000).toISOString(),
      results: [
        { userId: 'u_me', placement: 1 }, { userId: 'u_rival', placement: 2 },
      ],
    }],
    associationTrainings: [{
      _id: 'tr_1', schoolId: SCHOOL, association: ASSOC, title: '周三训练',
      startTime: new Date(NOW.getTime() - 86400000).toISOString(), status: 'finished', points: 2,
    }],
    trainingRegistrations: [
      { _id: 'reg_me', schoolId: SCHOOL, association: ASSOC, trainingId: 'tr_1', userId: 'u_me', status: 'checked_in' },
      { _id: 'reg_o1', schoolId: SCHOOL, association: ASSOC, trainingId: 'tr_1', userId: 'u_other', status: 'checked_in' },
      { _id: 'reg_o2', schoolId: SCHOOL, association: ASSOC, trainingId: 'tr_1', userId: 'u_rival', status: 'checked_in' },
    ],
  };
}

/** 默认夹具；传 overrides 可替换某一类集合（如把 matches 换成上百条）。 */
function fixture(overrides = {}) {
  return createSchoolMemoryRepo({ ...seedOf(), ...overrides });
}

/**
 * 记录「调用了哪条取数路」。包装的是 `forScope` 返回的集合方法——
 * 业务代码全都经过 `ctx.repo.forScope(...)`，所以这里能看清它走的是
 * 「全量 list」还是「按人下推」。
 */
function spyScope(repo) {
  const calls = [];
  const raw = repo.forScope;
  repo.forScope = (input) => {
    const surface = raw(input);
    for (const key of ['matches', 'trainingRegistrations', 'memberRatings']) {
      const collection = surface[key];
      if (!collection) continue;
      for (const method of ['list', 'listPage', 'listByUser']) {
        if (typeof collection[method] !== 'function') continue;
        const original = collection[method];
        collection[method] = (...args) => {
          calls.push({ key, method, args });
          return original.apply(collection, args);
        };
      }
    }
    return surface;
  };
  return calls;
}

async function callProfile(repo, payload, actor = 'u_me') {
  const ctx = await buildSchoolContext({
    repo, actorId: actor, scope: { schoolId: SCHOOL, association: ASSOC }, now: NOW,
  });
  return (await rank.getSchoolMemberProfile(payload, ctx)).data;
}

test('个人主页只读「我参与过的」比赛，不再整表读 matches', async () => {
  const repo = fixture();
  const calls = spyScope(repo);

  const data = await callProfile(repo, { userId: 'u_me' });
  assert.equal(data.ok, true, data.message);
  assert.equal(data.found, true);

  const matchCalls = calls.filter(c => c.key === 'matches');
  assert.ok(matchCalls.some(c => c.method === 'listPage'), '比赛应走按参赛者下推的 listPage');
  assert.ok(!matchCalls.some(c => c.method === 'list'),
    '不允许再整表读 matches：8000 场是 80 页 RPC，而这里只用到一个人的场次');

  const page = matchCalls.find(c => c.method === 'listPage');
  assert.equal(page.args[0].filter.userId, 'u_me', '必须按「我」下推');
  assert.ok(Number.isInteger(page.args[0].limit) && page.args[0].limit > 0, '必须带条数上限');
});

test('个人主页的走势与战绩只含自己的比赛', async () => {
  const repo = fixture();
  const data = await callProfile(repo, { userId: 'u_me' });
  assert.equal(data.ok, true, data.message);

  const ids = data.history.map(row => row.matchId).filter(Boolean);
  assert.ok(ids.length > 0, '自己的比赛要出现在逐场战绩里');
  assert.ok(!JSON.stringify(data.history).includes('m_other'), '别人的比赛不能混进来');
});

test('训练报名按 userId 下推，不再整表读', async () => {
  const repo = fixture();
  const calls = spyScope(repo);

  await callProfile(repo, { userId: 'u_me' });

  const regCalls = calls.filter(c => c.key === 'trainingRegistrations');
  assert.ok(regCalls.some(c => c.method === 'listByUser'), '训练报名应按人下推');
  assert.ok(!regCalls.some(c => c.method === 'list'),
    '不允许再整表读 trainingRegistrations：只增不减的集合，3000 条是 30 页');

  const byUser = regCalls.find(c => c.method === 'listByUser');
  assert.equal(byUser.args[0], 'u_me', '下推的必须是当前查看的这个人');
});

test('训练报名按人下推后，训练积分仍算得对', async () => {
  const repo = fixture();
  const data = await callProfile(repo, { userId: 'u_me' });
  assert.equal(data.ok, true, data.message);
  // 一条签到（2 分）+ 赛事第一名（按赛事分规则），至少要有训练那 2 分
  assert.ok(Number(data.user.points) >= 2, `训练积分不能因为下推而丢失，实际 ${data.user.points}`);
});

test('个人主页按页读比赛：单页不超过 99 条，场次多时继续翻页', async () => {
  // 第十八轮审查 P2：原实现把 PROFILE_MATCH_FETCH=500 直接交给分页原语，
  // 云端会拼出 limit(501)——越过平台 100 条上限，要么报错要么被截断。
  const repo = fixture({
    matches: Array.from({ length: 150 }, (_, i) => ratedMatch(`m_mine_${i}`, 'u_me', 'u_rival', i + 10)),
  });
  const calls = spyScope(repo);

  await callProfile(repo, { userId: 'u_me' });

  const pages = calls.filter(c => c.key === 'matches' && c.method === 'listPage');
  assert.ok(pages.length >= 2, `150 场应分页读取，实际只读了 ${pages.length} 页`);
  for (const call of pages) {
    assert.ok(call.args[0].limit <= 99,
      `单页必须夹到 99 条（多取 1 条判 hasMore），实际 ${call.args[0].limit}`);
  }
  assert.deepEqual(pages.map(call => call.args[0].offset), [0, 99], '偏移量应按上一页条数前进');
});
