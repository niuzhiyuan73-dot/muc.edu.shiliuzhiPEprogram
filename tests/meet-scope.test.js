/**
 * B2：运动会范围与确定性主键
 * ============================================================
 * 这里守三件事：
 *   1. 范围是 {schoolId, meetId}，**没有 association**——运动会不能被挂到协会上；
 *   2. 主键由已知字段拼出且稳定，同一组输入永远得到同一个键（事务内点读的前提）；
 *   3. 拼键前校验每段，含冒号或空值当场抛错，不允许拼出可能碰撞的键。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MEET_COLLECTIONS,
  meetScope,
  newMeetId,
  meetEventKey,
  meetCollegeKey,
  meetInterestKey,
  meetEntryKey,
  meetQuotaKey,
  meetClaimKey,
  meetSessionKey,
  meetJudgeKey,
  meetScoreKey,
  meetPublicationKey,
  meetResultRowKey,
  meetStandingKey,
} = require('../src/shared/utils/meet-scope.js');

const SCOPE = { schoolId: 'muc', meetId: 'mt_muc_abc' };

test('运动会集合清单为 14 个（B8 增加总榜与荣誉）', () => {
  assert.strictEqual(MEET_COLLECTIONS.length, 14);
  assert.deepStrictEqual([...MEET_COLLECTIONS], [
    'sportsMeets', 'sportsMeetEvents', 'sportsMeetColleges', 'sportsMeetInterests',
    'sportsMeetEntries', 'sportsMeetSessions', 'sportsMeetJudgeAssignments',
    'sportsMeetScores', 'sportsMeetPublications', 'sportsMeetResultRows',
    'sportsMeetQuotaUsage', 'sportsMeetParticipantClaims',
    // B8：学院总榜快照与个人荣誉
    'sportsMeetStandings', 'sportsMeetHonors',
  ]);
});

test('范围只有学校与运动会两个字段，不夹带协会', () => {
  const scope = meetScope({ schoolId: 'muc', meetId: 'mt1', association: 'pkb' });
  assert.deepStrictEqual(Object.keys(scope).sort(), ['meetId', 'schoolId']);
  assert.strictEqual(scope.association, undefined);
});

test('范围缺字段直接抛错，不默认成某校某届', () => {
  assert.throws(() => meetScope({ meetId: 'mt1' }), /缺少学校/);
  assert.throws(() => meetScope({ schoolId: 'muc' }), /缺少运动会/);
  assert.throws(() => meetScope({ schoolId: '  ', meetId: 'mt1' }), /缺少学校/);
  assert.throws(() => meetScope({}), /缺少学校/);
});

test('主键稳定：同一组输入永远同一键', () => {
  const a = meetEventKey(SCOPE.meetId, 'sprint-100m', 'male');
  const b = meetEventKey(SCOPE.meetId, 'sprint-100m', 'male');
  assert.strictEqual(a, b);
  // 组别不同即不同键：男子 100 米与女子 100 米是两条独立报名单位
  assert.notStrictEqual(a, meetEventKey(SCOPE.meetId, 'sprint-100m', 'female'));
});

test('主键各自加前缀，不同实体不会撞键', () => {
  const keys = [
    meetEventKey('mt1', 'sprint-100m', 'male'),
    meetCollegeKey('mt1', 'c01'),
    meetInterestKey('mt1', 'e1', 'u1'),
    meetEntryKey('mt1', 'e1', 'c01', 's1'),
    meetQuotaKey('mt1', 'e1', 'c01'),
    meetClaimKey('mt1', 'e1', 'u1'),
    meetSessionKey('mt1', 'e1', 'heat', '1'),
    meetJudgeKey('mt1', 's1', 'u9'),
    meetScoreKey('r1', 's1', 'u9'),
    meetPublicationKey('mt1', 'e1', 's1'),
    meetResultRowKey('p1', 'r1'),
    meetStandingKey('mt1', 'c01'),
  ];
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('跨届隔离：meetId 不同则键不同', () => {
  assert.notStrictEqual(
    meetEventKey('mt1', 'sprint-100m', 'male'),
    meetEventKey('mt2', 'sprint-100m', 'male'),
  );
});

test('拼键拒绝空值与冒号，避免键碰撞', () => {
  assert.throws(() => meetEventKey('mt1', '', 'male'), /缺少项目/);
  assert.throws(() => meetEventKey('mt1', 'a:b', 'male'), /不能包含冒号/);
  assert.throws(() => meetEventKey('mt1', 'sprint', ' '), /缺少组别/);
  assert.throws(() => meetEntryKey('mt1', 'e1', 'c1', ''), /缺少名额序号/);
});

test('名额序号进键：撤回第 2 个名额再报会落回同一条', () => {
  const first = meetEntryKey('mt1', 'e1', 'c01', 's1');
  const second = meetEntryKey('mt1', 'e1', 'c01', 's2');
  assert.notStrictEqual(first, second);
  // 重复取同一个名额序号 → 同一个键（可覆盖、可判重）
  assert.strictEqual(second, meetEntryKey('mt1', 'e1', 'c01', 's2'));
});

test('裁判成绩唯一键由参赛记录 + 场次 + 裁判构成', () => {
  const base = meetScoreKey('r1', 's1', 'j1');
  assert.strictEqual(base, meetScoreKey('r1', 's1', 'j1'));
  assert.notStrictEqual(base, meetScoreKey('r1', 's1', 'j2'));
  assert.notStrictEqual(base, meetScoreKey('r1', 's2', 'j1'));
  assert.notStrictEqual(base, meetScoreKey('r2', 's1', 'j1'));
});

test('运动会 ID 按学校与秒级时间生成，可复现且可读', () => {
  const at = Date.UTC(2026, 9, 17, 13, 0, 0);
  const id = newMeetId('muc', at);
  assert.strictEqual(id, newMeetId('muc', at));
  assert.match(id, /^mt_muc_[0-9a-z]+$/);
  assert.notStrictEqual(id, newMeetId('muc', at + 1000));
  assert.notStrictEqual(id, newMeetId('pku', at));
});
