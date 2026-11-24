/** Offline, complete-export migration. Never connects to or modifies a live database. */
const fs = require('node:fs');
const { schoolAccountKey } = require('../src/shared/utils/school');
const { accountDirectoryFields } = require('../src/server/services/account-directory');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository');

function migrateExport(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('需要按集合名组织的完整 JSON 导出');
  const required = [...new Set(Object.values(COLLECTIONS))];
  const missing = required.filter(name => !Array.isArray(source[name]));
  if (missing.length) throw new Error(`导出不完整，缺少集合（空集合也需 []）：${missing.join(', ')}`);
  const idMap = new Map(), owners = new Map();
  for (const user of source.users) {
    if (typeof user.openId !== 'string' || !user.openId) throw new Error('账号缺少 OpenID，不能安全迁移');
    if (owners.has(user.openId)) throw new Error('存在重复微信账号，请先核对并合并重复账号');
    owners.set(user.openId, user._id);
    if (user._id === `acc:${encodeURIComponent(user.openId)}`) idMap.set(user._id, schoolAccountKey(user.openId));
  }
  const replacements = [];
  for (const [oldId, newId] of idMap) {
    let oldKey = oldId, newKey = newId;
    for (let level = 0; level < 8; level++) {
      replacements.push([oldKey, newKey]);
      oldKey = encodeURIComponent(oldKey); newKey = encodeURIComponent(newKey);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  const protectedField = /^(openId|nickName|realName|avatarUrl|directoryNickName|directoryRealName|title|name|content|description|message|reason|reviewReason)$/;
  const rewrite = text => {
    let result = text;
    for (const [oldKey, newKey] of replacements) {
      const pattern = oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`${pattern}(?=$|[^A-Za-z0-9_.~-])`, 'g'), () => newKey);
    }
    return result;
  };
  const walk = (value, field = '') => {
    if (typeof value === 'string') return protectedField.test(field) ? value : rewrite(value);
    if (Array.isArray(value)) return value.map(item => walk(item, field));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const nextKey = rewrite(key);
      if (Object.prototype.hasOwnProperty.call(result, nextKey)) throw new Error('迁移后对象键冲突');
      Object.defineProperty(result, nextKey, { value: walk(item, key), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const data = walk(source);
  for (const user of data.users) Object.assign(user, accountDirectoryFields(user));
  for (const [name, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw new Error(`集合 ${name} 必须为文档数组`);
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row._id !== 'string' || !row._id || ids.has(row._id)) throw new Error(`集合 ${name} 出现无效或重复主键`);
      ids.add(row._id);
    }
  }
  return { data, migratedAccounts: idMap.size, directoryAccounts: data.users.length };
}

function main(argv) {
  const arg = name => argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const input = arg('input'), output = arg('output');
  if (!input) throw new Error('用法：node tools/migrate-account-ids.js --input=完整导出.json [--output=迁移后.json]');
  const result = migrateExport(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (output) fs.writeFileSync(output, JSON.stringify(result.data, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ migratedAccounts: result.migratedAccounts, directoryAccounts: result.directoryAccounts,
    outputWritten: Boolean(output), mode: output ? 'offline-export' : 'dry-run' }));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { migrateExport };
