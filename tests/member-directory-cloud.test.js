const test = require('node:test');
const assert = require('node:assert/strict');
const { readMemberPage } = require('../cloudfunctions/data/src/adapters/member-page');
const { memoryDirectoryPage, accountDirectoryFields } = require('../miniprogram/services/account-directory');
const scope = { schoolId: 'muc', association: 'pkb' };
const { directoryDatabase } = require('../tools/audit-directory-database.cjs');

function fixture(names) {
  const tables = { users: [], school_members: [] };
  names.forEach((name, i) => {
    const user = { _id: `u${String(i).padStart(4,'0')}`, nickName: name, realName: i % 2 ? '小张' : '张甲',
      openId: `private-${i}`, platformStatus: 'active', primarySchoolId: 'muc', avatarUrl: '' };
    tables.users.push({ ...user, ...accountDirectoryFields(user) });
    tables.school_members.push({ _id: `m${i}`, userId: user._id, schoolId: 'muc', status: 'active', collegeId: 'c01', studentId: 'PRIVATE' });
  });
  return tables;
}

test('学院选人分页：学院条件在联表前下推，双端结果一致且不带学号', async () => {
  const tables = fixture(['甲', '乙', '丙', '丁']);
  tables.school_members[0].collegeId = 'c02'; tables.school_members[2].collegeId = 'c02';
  const query = { collegeId: 'c02', limit: 1 };
  const db = directoryDatabase(tables);
  const first = await readMemberPage(db, db.command, scope, query);
  assert.deepEqual(first, memoryDirectoryPage(tables.school_members, tables.users, scope, query));
  assert.deepEqual(db.traces[0][0], ['match', { schoolId: 'muc', status: 'active', collegeId: 'c02' }]);
  assert.equal(first.members.length, 1); assert.equal(first.hasMore, true);
  const next = await readMemberPage(db, db.command, scope, { ...query, cursor: first.nextCursor });
  assert.notEqual(first.members[0].userId, next.members[0].userId);
  assert.ok([...first.members, ...next.members].every(row => row.collegeId === 'c02' && !('studentId' in row)));
});

test('云端目录查询与原搜索一致：NFKC、前缀优先、同名、特殊字符、UTF-16 排序及跨页', async () => {
  const tables = fixture(['小张', '张甲', 'ＡＢＣ', 'abc', 'xABC', '张甲', '😀', '\ue000', '$x', '.*']);
  for (const keyword of ['', '张', 'abc', '$x', '.*', '不存在']) {
    const db = directoryDatabase(tables);
    let cursor = '';
    const actual = [];
    for (let i = 0; i < 20; i++) {
      const result = await readMemberPage(db, db.command, scope, { keyword, cursor, limit: 2 });
      const expectedPage = memoryDirectoryPage(tables.school_members, tables.users, scope, { keyword, cursor, limit: 2 });
      assert.deepEqual(result, expectedPage, keyword);
      actual.push(...result.members);
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    const expected = memoryDirectoryPage(tables.school_members, tables.users, scope, { keyword, limit: 100 }).members;
    assert.deepEqual(actual, expected);
  }
});

test('2000 人目录只返回页大小加一，学校与状态筛选、投影均在数据库完成', async () => {
  const tables = fixture(Array.from({ length: 2000 }, (_, i) => `成员${i}`));
  tables.users[0].platformStatus = 'disabled';
  tables.users[1].primarySchoolId = 'other';
  tables.school_members[2].schoolId = 'other';
  tables.school_members[3].status = 'left';
  const db = directoryDatabase(tables);
  const result = await readMemberPage(db, db.command, scope, { limit: 20 });
  assert.equal(result.members.length, 20); assert.equal(result.hasMore, true);
  assert.deepEqual(db.returned, [21]);
  assert.equal(result.members.some(row => ['u0000','u0001','u0002','u0003'].includes(row.userId)), false);
  assert.equal(result.members.some(row => 'openId' in row || 'studentId' in row || 'searchNick' in row), false);
  assert.deepEqual(db.traces[0][0], ['match', { schoolId: 'muc', status: 'active' }]);
});

test('历史搜索字段缺失：目录与计数都不算未回填账号，不再中断整页', async () => {
  const tables = fixture(['测试']); delete tables.users[0].directoryVersion;
  const db = directoryDatabase(tables);
  const page = await readMemberPage(db, db.command, scope, { limit: 20 });
  assert.deepEqual(page, { members: [], hasMore: false, keyword: '', nextCursor: '' });
  // 计数与分页共用 memberQuery 的同一段 match，因此也自动排除未回填账号。
});
