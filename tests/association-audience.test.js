const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIENCE_MODE, AUDIENCE_GROUP_MAX, buildAudience, readAudience, audienceAllows, hitGroupIds,
} = require('../miniprogram/services/association-audience');

test('buildAudience 缺省即「不限」，显式 all 也规范成空清单', () => {
  assert.deepEqual(buildAudience(), { ok: true, audienceMode: 'all', audienceGroupIds: [], message: '' });
  assert.deepEqual(buildAudience({}), { ok: true, audienceMode: 'all', audienceGroupIds: [], message: '' });
  assert.deepEqual(buildAudience({ audienceMode: 'all', audienceGroupIds: [] }),
    { ok: true, audienceMode: 'all', audienceGroupIds: [], message: '' });
});

test('buildAudience 对「限组」去重并升序，保证落库形式稳定', () => {
  const result = buildAudience({ audienceMode: 'groups', audienceGroupIds: ['g2', 'g1', 'g2'] });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.audienceGroupIds, ['g1', 'g2']);
});

test('buildAudience 拒绝混合与空清单，不静默降级为不限', () => {
  assert.equal(buildAudience({ audienceMode: 'groups' }).ok, false, 'groups 缺清单');
  assert.equal(buildAudience({ audienceMode: 'groups', audienceGroupIds: [] }).ok, false, 'groups 空清单');
  assert.equal(buildAudience({ audienceMode: 'all', audienceGroupIds: ['g1'] }).ok, false, 'all 带清单');
  assert.equal(buildAudience({ audienceMode: 'nope' }).ok, false, '非法模式');
  assert.equal(buildAudience({ audienceMode: 'groups', audienceGroupIds: 'g1' }).ok, false, '清单不是数组');
});

test('buildAudience 拒绝形态不合规的小组编号', () => {
  for (const id of ['has space', 'a/b', '', 'x'.repeat(65), 7]) {
    assert.equal(buildAudience({ audienceMode: 'groups', audienceGroupIds: [id] }).ok, false, `拒绝 ${id}`);
  }
});

test('readAudience 把缺字段与空 groups 都兼容成「不限」，旧活动不被漏读', () => {
  assert.deepEqual(readAudience(), { audienceMode: 'all', audienceGroupIds: [] });
  assert.deepEqual(readAudience({}), { audienceMode: 'all', audienceGroupIds: [] });
  assert.deepEqual(readAudience({ audienceMode: 'groups', audienceGroupIds: [] }),
    { audienceMode: 'all', audienceGroupIds: [] });
  assert.deepEqual(readAudience({ audienceMode: 'groups', audienceGroupIds: ['g3', 'g1', 'g3'] }),
    { audienceMode: 'groups', audienceGroupIds: ['g1', 'g3'] });
});

test('audienceAllows：不限恒真，限组按并集命中', () => {
  assert.equal(audienceAllows({ audienceMode: 'all' }, []), true);
  assert.equal(audienceAllows({ audienceMode: 'groups', audienceGroupIds: ['g1'] }, ['g1']), true);
  assert.equal(audienceAllows({ audienceMode: 'groups', audienceGroupIds: ['g1'] }, ['g2']), false);
  assert.equal(audienceAllows({ audienceMode: 'groups', audienceGroupIds: ['g1', 'g2'] }, ['g2']), true, '并集命中');
  assert.equal(audienceAllows({ audienceMode: 'groups', audienceGroupIds: ['g1'] }, []), false);
});

test('hitGroupIds 返回稳定升序的命中清单，不限时为空', () => {
  assert.deepEqual(hitGroupIds({ audienceMode: 'all' }, ['g1']), []);
  assert.deepEqual(hitGroupIds({ audienceMode: 'groups', audienceGroupIds: ['g1', 'g2', 'g3'] }, ['g3', 'g1']),
    ['g1', 'g3']);
});

test('AUDIENCE_MODE 常量冻结且取值稳定', () => {
  assert.equal(AUDIENCE_MODE.ALL, 'all');
  assert.equal(AUDIENCE_MODE.GROUPS, 'groups');
  assert.equal(Object.isFrozen(AUDIENCE_MODE), true);
});

test('一次限制最多 20 个小组：超出即拒绝，不是静默截断', () => {
  const ids = Array.from({ length: AUDIENCE_GROUP_MAX }, (_, i) => `g${i}`);
  const ok20 = buildAudience({ audienceMode: 'groups', audienceGroupIds: ids });
  assert.equal(ok20.ok, true, '正好 20 个允许');
  assert.equal(ok20.audienceGroupIds.length, AUDIENCE_GROUP_MAX);

  const over = buildAudience({ audienceMode: 'groups', audienceGroupIds: [...ids, 'g-extra'] });
  assert.equal(over.ok, false, '21 个必须拒绝');
  assert.match(over.message, /最多选择 20 个小组/);
  assert.deepEqual(over.audienceGroupIds, [], '拒绝时不回半份清单');

  // 去重后才算数：重复的 30 个编号实际只有 20 个小组
  const dup = buildAudience({ audienceMode: 'groups', audienceGroupIds: [...ids, ...ids] });
  assert.equal(dup.ok, true, '重复编号先去重再判上限');
});
