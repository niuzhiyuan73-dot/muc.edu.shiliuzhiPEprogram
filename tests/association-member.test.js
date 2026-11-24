const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText, normalizeKeyword, matchesKeyword, prefixRank,
  encodeCursor, decodeCursor, searchMemberPage,
} = require('../src/server/services/association-member');

const ROSTER = Object.freeze([
  { userId: 'u3', nickName: '张宇轩', realName: '张三' },
  { userId: 'u1', nickName: '小张', realName: '李张' },
  { userId: 'u2', nickName: 'Zhang', realName: '' },
  { userId: 'u4', nickName: '王五', realName: '张三丰' },
]);

test('normalizeText 折叠全半角与大小写', () => {
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
  assert.equal(normalizeText('Zhang'), 'zhang');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeKeyword('  张 '), '张');
});

test('匹配口径：昵称或真名包含关键词，学号不参与', () => {
  assert.equal(matchesKeyword(ROSTER[0], '张'), true, '昵称包含');
  assert.equal(matchesKeyword(ROSTER[3], '张三'), true, '真名包含');
  assert.equal(matchesKeyword(ROSTER[1], 'zhang'), false, '小张不匹配 zhang');
  assert.equal(matchesKeyword(ROSTER[2], 'zhang'), true, '英文昵称大小写折叠');
  assert.equal(matchesKeyword(ROSTER[0], ''), true, '空串视为未过滤');
  assert.equal(matchesKeyword({ userId: 'x', nickName: '甲', realName: '乙', studentId: '20260001' }, '20260001'),
    false, '学号不参与匹配');
});

test('排序：前缀命中优先，同档按昵称码点序', () => {
  const page = searchMemberPage(ROSTER, { keyword: '张' });
  assert.deepEqual(page.members.map(row => row.userId), ['u3', 'u4', 'u1']);
  assert.equal(prefixRank(ROSTER[0], '张'), 0, '张宇轩前缀命中');
  assert.equal(prefixRank(ROSTER[1], '张'), 1, '小张非前缀命中');
  assert.equal(prefixRank(ROSTER[3], '张'), 0, '真名以张开头也算前缀命中');
});

test('排序稳定：昵称相同再比真名，最后用 userId 兜底', () => {
  const rows = [
    { userId: 'b', nickName: '同名', realName: '乙' },
    { userId: 'a', nickName: '同名', realName: '乙' },
    { userId: 'c', nickName: '同名', realName: '甲' },
  ];
  const page = searchMemberPage(rows, {});
  // 真名「乙」码点小于「甲」，故 a、b 在前；a、b 同名同真名，用 userId 兜底 a 在 b 前。
  assert.deepEqual(page.members.map(row => row.userId), ['a', 'b', 'c']);
});

test('分页不重不漏：游标取自上一页最后一行', () => {
  const first = searchMemberPage(ROSTER, { keyword: '张', limit: 2 });
  assert.deepEqual(first.members.map(row => row.userId), ['u3', 'u4']);
  assert.equal(first.hasMore, true);
  assert.notEqual(first.nextCursor, '');
  const second = searchMemberPage(ROSTER, { keyword: '张', cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.members.map(row => row.userId), ['u1']);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, '');
});

test('游标编解码对分隔符与中文都安全，非法游标按首页处理', () => {
  const key = [0, '张|宇轩', 'a:b', 'u1'];
  assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  assert.equal(decodeCursor('garbage'), null);
  assert.equal(decodeCursor('2|a|b|c'), null, '非法档位');
  assert.equal(decodeCursor('0|a|b'), null, '段数不对');
  assert.equal(decodeCursor(''), null);
});

test('默认每页 20 条，其余判定 hasMore', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ userId: `u${String(i).padStart(2, '0')}`, nickName: `会员${i}`, realName: '' }));
  const page = searchMemberPage(many, {});
  assert.equal(page.members.length, 20);
  assert.equal(page.hasMore, true);
});
