/**
 * 声明式数据库索引校验器（config/db-indexes.json）
 * ============================================================
 * 校验：
 *   1. 集合逻辑名均存在于 cloudfunctions/data/src/repository.js 的 COLLECTIONS；
 *   2. 无完全重复的字段+方向索引；
 *   3. 单条索引至多包含一个多键数组字段（防止 MongoDB/CloudBase 建索引报错）；
 *   4. 所有 SCOPED_COLLECTIONS、SCHOOL_ONLY、MEET_COLLECTIONS 均有对应范围前缀索引。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'config', 'db-indexes.json');
const DOC_FILE = path.join(ROOT, 'docs', '数据库索引清单.md');
const AUTO_START = '<!-- AUTO-GENERATED-INDEXES:START -->';
const AUTO_END = '<!-- AUTO-GENERATED-INDEXES:END -->';
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository.js');
const {
  SCHOOL_ONLY, SCOPED_COLLECTIONS,
} = require('../src/server/services/school-collections.js');
const { MEET_COLLECTIONS } = require('../src/shared/utils/meet-scope.js');

function hasPrefix(fields, prefix) {
  if (fields.length < prefix.length) return false;
  return prefix.every((name, i) => fields[i].field === name);
}

function validateIndexes(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.indexes)) {
    return ['config/db-indexes.json 缺少 indexes 数组'];
  }
  const arrayFields = new Set(Array.isArray(doc.arrayFields) ? doc.arrayFields : []);
  const seenSig = new Map();
  const byCol = new Map();

  for (const idx of doc.indexes) {
    if (!idx.collection || !Object.prototype.hasOwnProperty.call(COLLECTIONS, idx.collection)) {
      errors.push(`未知集合名：${idx.collection}（索引 ${idx.name || '(未命名)'}）`);
      continue;
    }
    if (!Array.isArray(idx.fields) || idx.fields.length === 0) {
      errors.push(`索引字段为空：${idx.collection}.${idx.name}`);
      continue;
    }
    const sig = `${idx.collection}:${idx.fields.map((f) => `${f.field}:${f.order}`).join(',')}`;
    if (seenSig.has(sig)) {
      errors.push(`重复索引：${sig}（${idx.name} 与 ${seenSig.get(sig)}）`);
    } else {
      seenSig.set(sig, idx.name);
    }

    const arrayHit = idx.fields.filter((f) => arrayFields.has(f.field));
    if (arrayHit.length > 1) {
      errors.push(`索引 ${idx.collection}.${idx.name} 包含多个数组路径（${arrayHit.map((f) => f.field).join(', ')}）`);
    }

    if (!byCol.has(idx.collection)) byCol.set(idx.collection, []);
    byCol.get(idx.collection).push(idx);
  }

  for (const key of SCOPED_COLLECTIONS) {
    const prefix = SCHOOL_ONLY.includes(key) ? ['schoolId'] : ['schoolId', 'association'];
    const list = byCol.get(key) || [];
    if (!list.some((idx) => hasPrefix(idx.fields, prefix))) {
      errors.push(`受范围集合 ${key} 缺少范围前缀索引（${prefix.join(' + ')}）`);
    }
  }

  for (const key of MEET_COLLECTIONS) {
    const prefix = ['schoolId', 'meetId'];
    const list = byCol.get(key) || [];
    if (!list.some((idx) => hasPrefix(idx.fields, prefix))) {
      errors.push(`运动会集合 ${key} 缺少范围前缀索引（schoolId + meetId）`);
    }
  }

  return errors;
}

function renderIndexDocSection(doc) {
  const lines = [
    AUTO_START,
    `> 本表由 \`tools/check-db-indexes.js --write-doc\` 从 [config/db-indexes.json](../config/db-indexes.json) 自动生成，禁止手改。集合总数 ${Object.keys(COLLECTIONS).length}，声明索引 ${doc.indexes.length} 条。`,
    '',
    '| 逻辑集合 | 物理集合 | 索引名 | 字段与方向 | 唯一 | 用途 |',
    '|---|---|---|---|---|---|',
  ];
  for (const idx of doc.indexes) {
    const physical = COLLECTIONS[idx.collection] || idx.collection;
    const fieldsText = idx.fields.map((f) => `\`${f.field}\` ${f.order < 0 ? '↓' : '↑'}`).join(' + ');
    const uniqueText = idx.unique ? '是' : '否';
    const purpose = String(idx.purpose || '').replace(/\|/g, '\\|');
    lines.push(`| \`${idx.collection}\` | \`${physical}\` | \`${idx.name}\` | ${fieldsText} | ${uniqueText} | ${purpose} |`);
  }
  lines.push(AUTO_END);
  return lines.join('\n');
}

function replaceAutoSection(markdown, rendered) {
  const startIdx = markdown.indexOf(AUTO_START);
  const endIdx = markdown.indexOf(AUTO_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const body = rendered.replace(/\r?\n/g, eol);
  return markdown.slice(0, startIdx) + body + markdown.slice(endIdx + AUTO_END.length);
}

function checkIndexDocSync(doc, docText = null) {
  const current = docText !== null ? docText : fs.readFileSync(DOC_FILE, 'utf8');
  const rendered = renderIndexDocSection(doc);
  const expected = replaceAutoSection(current, rendered);
  if (expected === null) {
    return `docs/数据库索引清单.md 缺少自动生成标记 ${AUTO_START} / ${AUTO_END}`;
  }
  if (current !== expected) {
    return 'docs/数据库索引清单.md 自动生成索引表与 config/db-indexes.json 不一致，请运行 npm run sync:indexes';
  }
  return null;
}

function syncIndexDoc(doc) {
  const current = fs.readFileSync(DOC_FILE, 'utf8');
  const rendered = renderIndexDocSection(doc);
  const next = replaceAutoSection(current, rendered);
  if (next === null) {
    throw new Error(`docs/数据库索引清单.md 缺少自动生成标记 ${AUTO_START} / ${AUTO_END}`);
  }
  if (next !== current) {
    fs.writeFileSync(DOC_FILE, next, 'utf8');
  }
  return next !== current;
}

function main() {
  const writeDoc = process.argv.includes('--write-doc');
  const doc = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const errors = validateIndexes(doc);
  if (errors.length > 0) {
    console.error('声明式索引校验失败：');
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  if (writeDoc) {
    const changed = syncIndexDoc(doc);
    console.log(`已同步 docs/数据库索引清单.md（共 ${doc.indexes.length} 条索引${changed ? '，已更新' : '，无变化'}）。`);
    return;
  }
  const docErr = checkIndexDocSync(doc);
  if (docErr) {
    console.error(`声明式索引文档同步失败：\n  - ${docErr}`);
    process.exit(1);
  }
  console.log(`声明式索引校验通过：共 ${doc.indexes.length} 条索引，覆盖全部范围与业务查询，且与文档一致。`);
}

if (require.main === module) {
  main();
}

module.exports = {
  validateIndexes,
  renderIndexDocSection,
  checkIndexDocSync,
  syncIndexDoc,
  INDEX_FILE,
  DOC_FILE,
  AUTO_START,
  AUTO_END,
};
