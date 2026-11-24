// 协议 2 的回包形状（2026-10-28 第十轮只读审计 P1 / P2）。
//
// 这一组钉住三件事，缺一件就会出现「同一个失败在四组接口里长得不一样」：
//   1. 业务拒绝一律在 `data` 里（`{ok:true, data:{ok:false, message}}`），
//      顶层 ok:false 只留给「请求本身处理不了」；
//   2. 业务对象（DTO）自带 ok，`okOf(dto)` 那种判法可以跨域复用；
//   3. 列表页的截断必须给 hasMore，不能静默少几条。
process.env.RATE_LIMIT = 'off';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

const NOW = new Date('2026-10-13T12:00:00Z');

function fixture() {
  return createMemoryRepo(createSchoolDemoSeed());
}

/** 协议 2 的一次调用；默认学校管理员身份。 */
const call = (repo, action, payload = {}, extra = {}, openId = 'mock_openid_muc_admin') =>
  handleSchoolRequest({ protocolVersion: 2, schoolId: 'muc', action, payload, ...extra },
    { repo, openId, now: NOW });

test('业务拒绝不在顶层：运动会与其余三组同形（顶层 ok:true，失败在 data.ok）', async () => {
  const repo = fixture();
  // 运动会：不是校管理员 ⇔ 拒绝
  const meet = await call(repo, 'listMeetColleges', {}, {}, 'mock_openid_muc_member');
  assert.equal(meet.ok, true, '运动会拒绝不能落成顶层 ok:false——那会被客户端当成基础设施故障');
  assert.equal(meet.data.ok, false);
  assert.match(meet.data.message, /校级管理员/);

  // 参数缺失同样是业务拒绝，不是故障
  const created = await call(repo, 'createSportsMeet', {});
  assert.equal(created.ok, true);
  assert.equal(created.data.ok, false);

  // 其余三组本来就如此，一并钉住，防止将来谁把某一组改回顶层失败
  const identity = await call(repo, 'grantSchoolPermission', {}, { association: 'pkb' });
  const space = await call(repo, 'createAssociationGroup', {}, { association: 'pkb' });
  for (const [name, result] of [['identity', identity], ['space', space], ['meet', meet]]) {
    assert.equal(result.ok, true, `${name} 的业务拒绝不该是顶层 ok:false`);
    assert.equal(result.data.ok, false, `${name} 的业务拒绝要在 data.ok 里`);
    assert.equal(typeof result.data.message, 'string');
  }
});

test('真正的请求级失败仍然是顶层 ok:false（版本 / 未知动作 / 缺范围）', async () => {
  const repo = fixture();
  const badVersion = await handleSchoolRequest({ protocolVersion: 1, schoolId: 'muc', action: 'listSportsMeets', payload: {} },
    { repo, openId: 'mock_openid_muc_admin', now: NOW });
  assert.equal(badVersion.ok, false);

  const unknown = await call(repo, 'notAnAction');
  assert.equal(unknown.ok, false);

  const noSchool = await handleSchoolRequest({ protocolVersion: 2, action: 'listSportsMeets', payload: {} },
    { repo, openId: 'mock_openid_muc_admin', now: NOW });
  assert.equal(noSchool.ok, false);
});

test('运动会 DTO 自带 ok，可与其余三组的 okOf(dto) 判法通用', async () => {
  const repo = fixture();
  const colleges = await call(repo, 'listMeetColleges', {});
  assert.equal(colleges.data.ok, true, '运动会业务对象缺 ok 会让 okOf(dto) 把成功判成失败');
  assert.ok(Array.isArray(colleges.data.items));

  const meets = await call(repo, 'listSportsMeets', {});
  assert.equal(meets.data.ok, true);
  assert.ok(Array.isArray(meets.data.items));

  // 失败时 DTO 的 ok 必须是 false，不能被注入逻辑改回 true
  const refused = await call(repo, 'listMeetColleges', {}, {}, 'mock_openid_muc_member');
  assert.equal(refused.data.ok, false);
});

test('学院目录按页返回：截断必须给 hasMore / nextOffset，不再静默少几条', async () => {
  const repo = fixture();
  const all = await call(repo, 'listMeetColleges', {});
  assert.equal(all.data.hasMore, false, '默认页大小应能一次取完一个学校的学院');
  assert.ok(all.data.total > 1, '演示数据里应当有多个学院');

  const first = await call(repo, 'listMeetColleges', { limit: 3 });
  assert.equal(first.data.items.length, 3);
  assert.equal(first.data.hasMore, true);
  assert.equal(first.data.nextOffset, 3);

  const rest = await call(repo, 'listMeetColleges', { limit: 3, offset: first.data.nextOffset });
  assert.equal(rest.data.items.length, 3);
  // 两页不重叠
  const ids = new Set(first.data.items.map(row => row.collegeId));
  assert.ok(rest.data.items.every(row => !ids.has(row.collegeId)));
});

test('赛季接口在测试桩上可跑（仓储桩补 getById 后不再是盲区）', async () => {
  const repo = fixture();
  const season = await call(repo, 'getSchoolSeason', {}, { association: 'pkb' });
  assert.equal(season.ok, true);
  assert.equal(season.data.ok, true, season.data.message || '');
  assert.ok(Number(season.data.season.seasonNumber) >= 1);
});
