/**
 * 目录读取收窄（2026-10-26 第六轮 D）
 * ============================================================
 * `buildDirectory` 一次读**全校**在册名册 + 这批人的账号：2000 人的学校约 40 次
 * RPC。而绝大多数调用方只需要其中很小一部分——
 *   · 写动作的身份闸（`legacyActorOf`）只取 `actorCollege` 一个字符串；
 *   · 代签 / 指派 / 判分只要**当事人那几个**的学院；
 *   · 列表页只要操作者自己属于哪个学院。
 *
 * 为这些读全校名册，是比赛写动作、赛事启停、赛季重置这类低频操作上的固定开销，
 * 也是「一次点击翻十几页」的来源。本组用例把「这些路径不许整表读名册」钉死：
 * 把 `forScope(...).schoolMembers.list` 换成抛错，任何退回整表读的实现都会当场红。
 *
 * 【为什么这个探针在 mock 上成立】
 * 内存仓储的 `listByIds` / `listByStatus` 走的是 **base 仓储**的 `list()`
 * （`repo.schoolMembers.list`），不是 `forScope` 表面上的 `list`。所以只封
 * forScope 表面的 `list`，既能拦住「整表读」，又不会误伤批读路径。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { createSchoolMemoryRepo } = require('../src/mock/school-memory-repo.js');
const { buildSchoolContext } = require('../src/server/services/school-context');
const { actorDirectory, userDirectory } = require('../src/server/services/school-actor');
const rank = require('../src/server/services/school-rank-service');
const teamEvent = require('../src/server/services/team-event-service');

const SCOPE = { schoolId: 'muc', association: 'bk' };

/** 把「整表读名册」变成硬错误，并记下是谁碰的。 */
function forbidFullRoster(repo) {
  const hits = [];
  const raw = repo.forScope.bind(repo);
  repo.forScope = (input) => {
    const surface = raw(input);
    surface.schoolMembers.list = () => {
      hits.push(`${input.schoolId}/${input.association}`);
      throw new Error('不允许读全校名册');
    };
    return surface;
  };
  return hits;
}

test('actorDirectory：只解析操作者自己的学院，别人的一律空串', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  const hits = forbidFullRoster(repo);

  const dir = await actorDirectory(ctx);
  assert.equal(typeof dir.actorCollege, 'string');
  assert.deepEqual(hits, [], '身份闸不该读全校名册');
  // 空串在旧栈判定里等于「不同学院」，属于收紧；需要别人学院的地方必须用 userDirectory
  assert.equal(dir.collegeOf('demo_muc_member'), '');
});

test('userDirectory：批读指定会员的学院，不读全校名册', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  const hits = forbidFullRoster(repo);

  const dir = await userDirectory(ctx, ['demo_muc_member']);
  assert.deepEqual(hits, []);
  // 目标会员的学院必须真的解析出来——空串会让「未指定目标」的分支放行（见 checkIn）
  assert.equal(dir.collegeOf('demo_muc_member'), '中华民族共同体学院');
  assert.equal(dir.collegeIdOf('demo_muc_member'), 'c01');
  assert.equal(dir.collegeNameById('c01'), '中华民族共同体学院');
});

test('赛季重置与团队赛事列表不再为目录读全校名册（第六轮 D）', async () => {
  const repo = createSchoolMemoryRepo(createSchoolDemoSeed());
  const ctx = await buildSchoolContext({ repo, actorId: 'demo_muc_admin', scope: SCOPE });
  const hits = forbidFullRoster(repo);

  const reset = await rank.resetSchoolSeason({ resetTime: '2026-10-01T00:00:00.000Z' }, ctx);
  assert.notEqual(reset.ok, false, reset.message);
  const list = await teamEvent.listTeamEvents({}, ctx);
  assert.notEqual(list.ok, false, list.message);
  assert.deepEqual(hits, [], `这些路径不该读全校名册，实际：${hits.join(', ')}`);
});
