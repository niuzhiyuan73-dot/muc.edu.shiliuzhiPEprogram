const { normalizeText, normalizeKeyword, matchesKeyword, searchMemberPage } = require('./association-member.js');

/** ASCII UTF-16 keys preserve the existing JavaScript ordering even for emoji. */
function directorySortText(value) {
  const text = String(value || '');
  let key = '';
  for (let index = 0; index < text.length; index++) key += text.charCodeAt(index).toString(16).padStart(4, '0');
  return key;
}
function accountDirectoryFields(user) {
  return { directoryVersion: 1,
    directoryNickName: normalizeText(user.nickName || ''),
    directoryRealName: normalizeText(user.realName || ''),
    directoryNickSort: directorySortText(user.nickName), directoryRealSort: directorySortText(user.realName) };
}

/**
 * 本校在册会员的目录行（学籍 active × 账号 active × 账号归属本校 × 可选学院）。
 *
 * 分页与计数共用这一处过滤，云端 `member-page.js` 的聚合是同一条口径——
 * 「首页会员数」与「名录可翻到的行数」必须相等（2026-10-29 第十一轮审计 P2-9）。
 */
function directoryRows(members, users, scope, query) {
  const userById = new Map(users.map(user => [user._id, user]));
  const rows = [];
  for (const member of members) {
    if (member.schoolId !== scope.schoolId || member.status !== 'active') continue;
    if (query && query.collegeId && member.collegeId !== query.collegeId) continue;
    const user = userById.get(member.userId);
    if (!user || user.platformStatus !== 'active' || user.primarySchoolId !== scope.schoolId) continue;
    rows.push({ userId: user._id, nickName: user.nickName || '', realName: user.realName || '',
      avatarUrl: user.avatarUrl || '', collegeId: member.collegeId || '' });
  }
  return rows;
}

function memoryDirectoryPage(members, users, scope, query) {
  return searchMemberPage(directoryRows(members, users, scope, query), query);
}

/** 与 memoryDirectoryPage 同一套过滤（含关键词）的总数；不切页，直接数长度。 */
function memoryDirectoryCount(members, users, scope, query) {
  const keyword = normalizeKeyword(query && query.keyword);
  return directoryRows(members, users, scope, query)
    .filter(row => matchesKeyword(row, keyword)).length;
}

module.exports = {
  accountDirectoryFields, directorySortText, directoryRows, memoryDirectoryPage, memoryDirectoryCount,
};
