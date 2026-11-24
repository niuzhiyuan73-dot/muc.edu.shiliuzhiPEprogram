#!/usr/bin/env node
/**
 * 评级冗余字段回填 · CLI（2026-10-23 方案 A 第 1 步）
 * ============================================================
 * 用法（先 dry-run 看清影响面，再 --apply）：
 *
 *   node tools/backfill-rating-profile.js --school=muc
 *   node tools/backfill-rating-profile.js --school=muc --apply
 *
 * 可选参数：
 *   --school=<id>      必填，只回填这一所学校
 *   --limit=<1..100>   每批条数，默认 100（云开发单次查询上限）
 *   --cursor=<_id>     断点续跑：从上次输出的 nextCursor 继续
 *   --max-batches=<n>  本进程最多跑几批（默认 200），防止跑穿整个集合
 *   --apply            真正写库；不带则只统计（默认 dry-run）
 *   --adapter=memory   不连云，用演示种子在内存里演练脚本本身
 *
 * 云环境凭据（--adapter=cloud，默认）：
 *   TCB_ENV / TCB_SECRET_ID / TCB_SECRET_KEY，或 CLOUDBASE_ENV 等
 *   `@cloudbase/node-sdk` 支持的环境变量；需先 `npm i @cloudbase/node-sdk`。
 *
 * 【验收判据】同一所学校连跑两遍，第二遍的 updated 必须是 0。
 * 不为 0 说明有人还在写缺字段的评级文档，或权威值本身在变，先查清再切读路径。
 * ============================================================
 */

const { backfillBatch, backfillAll } = require('./rating-backfill-core.js');

const COLLECTION = 'member_ratings';

function parseArgs(argv) {
  const out = { apply: false, adapter: 'cloud', limit: 100, maxBatches: 200 };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? '' : body.slice(eq + 1);
    if (key === 'apply') out.apply = true;
    else if (key === 'school') out.school = value;
    else if (key === 'limit') out.limit = Number(value);
    else if (key === 'cursor') out.cursor = value || null;
    else if (key === 'max-batches') out.maxBatches = Number(value);
    else if (key === 'adapter') out.adapter = value;
    else if (key === 'help' || key === 'h') out.help = true;
  }
  return out;
}

function usage() {
  process.stdout.write([
    '评级冗余字段回填（member_ratings.gender / memberStatus）',
    '',
    '  node tools/backfill-rating-profile.js --school=<id> [--apply]',
    '',
    '  --school=<id>      必填',
    '  --limit=<1..100>   每批条数，默认 100',
    '  --cursor=<_id>     断点续跑',
    '  --max-batches=<n>  最多几批，默认 200',
    '  --apply            真正写库（默认只统计）',
    '  --adapter=memory   用演示种子在内存里演练',
    '',
  ].join('\n'));
}

/** 云端适配器：@cloudbase/node-sdk，懒加载——只在真正连云时才要求装依赖。 */
function cloudAdapter() {
  let tcb;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    tcb = require('@cloudbase/node-sdk');
  } catch (err) {
    throw new Error('缺少 @cloudbase/node-sdk，请先 npm i @cloudbase/node-sdk，或改用 --adapter=memory 演练');
  }
  const { schoolMemberKey } = require('../src/shared/utils/school.js');
  const app = tcb.init({
    env: process.env.TCB_ENV || process.env.CLOUDBASE_ENV || process.env.ENV_ID,
    secretId: process.env.TCB_SECRET_ID || process.env.SECRETID,
    secretKey: process.env.TCB_SECRET_KEY || process.env.SECRETKEY,
  });
  const db = app.database();
  const _ = db.command;
  return {
    async listRatings({ schoolId, cursor, limit }) {
      const where = { schoolId };
      if (cursor) where._id = _.gt(cursor);
      const res = await db.collection(COLLECTION).where(where).orderBy('_id', 'asc').limit(limit).get();
      const rows = res.data || [];
      return { rows, nextCursor: rows.length ? rows[rows.length - 1]._id : null };
    },
    async usersByIds(ids) {
      if (!ids.length) return [];
      const res = await db.collection('users').where({ _id: _.in(ids) }).limit(ids.length).get();
      return res.data || [];
    },
    async membersByIds(ids, schoolId) {
      if (!ids.length) return [];
      const keys = ids.map(userId => schoolMemberKey(userId, schoolId));
      const res = await db.collection('school_members').where({ _id: _.in(keys) }).limit(keys.length).get();
      return res.data || [];
    },
    async saveRating(id, patch) {
      // update 只改传入字段，避免整文档覆盖时把并发写入的 elo 盖回去。
      await db.collection(COLLECTION).doc(id).update({ data: patch });
    },
  };
}

/**
 * 内存适配器：用演示种子跑一遍，验证脚本自身（分页、统计、幂等）没有问题。
 * 演示种子里的评级文档本来就没有这两个字段，正好是回填的典型输入。
 */
function memoryAdapter() {
  const { createSchoolDemoSeed } = require('../src/mock/school-seed.js');
  const { createMemoryRepo } = require('../tests/helpers/memory-repo.js');
  const { schoolMemberKey, memberRatingKey } = require('../src/shared/utils/school.js');
  const { RATING_POOL } = require('../src/shared/utils/constants.js');
  const { allAssociations } = require('../src/shared/utils/associations.js');
  const seed = createSchoolDemoSeed();
  const repo = createMemoryRepo(seed);
  // 造数是异步的，必须等它写完再开始扫，否则第一批会读到半成品。
  const ready = seedLegacyRatings(repo, seed, { schoolMemberKey, memberRatingKey, RATING_POOL, allAssociations });
  return {
    repo,
    ready,
    async listRatings({ schoolId, cursor, limit }) {
      const all = (await repo.memberRatings.list())
        .filter(row => !schoolId || row.schoolId === schoolId)
        .sort((a, b) => (a._id < b._id ? -1 : 1));
      const start = cursor ? all.findIndex(row => row._id > cursor) : 0;
      const from = start === -1 ? all.length : start;
      const rows = all.slice(from, from + limit);
      return { rows, nextCursor: rows.length ? rows[rows.length - 1]._id : null };
    },
    async usersByIds(ids) {
      return repo.users.listByIds(ids);
    },
    async membersByIds(ids, schoolId) {
      const out = [];
      for (const userId of ids) {
        const row = await repo.schoolMembers.getById(schoolMemberKey(userId, schoolId));
        if (row) out.push(row);
      }
      return out;
    },
    async saveRating(id, patch) {
      const current = await repo.memberRatings.getById(id);
      if (!current) return;
      await repo.memberRatings.set(id, { ...current, ...patch });
    },
  };
}

/**
 * 造一批「回填前」的评级文档。
 *
 * 演示种子只产出身份与名册，评级是结算时惰性建档的，所以种子里一条都没有。
 * 演练若扫到 0 条就看不出脚本在干什么，因此这里按在册会员造一份**缺
 * gender / memberStatus 的老文档**——这正是线上回填要处理的输入形态。
 */
async function seedLegacyRatings(repo, seed, lib) {
  const { schoolMemberKey, memberRatingKey, RATING_POOL, allAssociations } = lib;
  const members = (seed.schoolMembers || []).filter(row => row.status === 'active').slice(0, 30);
  const association = allAssociations()[0].id;
  let created = 0;
  for (const member of members) {
    const schoolId = member.schoolId;
    const scope = { schoolId, association };
    for (const pool of [RATING_POOL.SINGLES, RATING_POOL.DOUBLES]) {
      const id = memberRatingKey(member.userId, pool, scope);
      await repo.memberRatings.set(id, {
        _id: id, schoolId, association, userId: member.userId, pool,
        elo: 1500, startElo: 1500, startSource: 'gender',
        matchCount: 3, wins: 2, losses: 1, version: 3,
        lastMatchTime: null, lastSettledAt: null, lastSettlementSeq: null,
        lastLedgerId: null, algorithmVersion: 1,
        // 刻意不写 gender / memberStatus：模拟方案 A 上线前的历史文档
      });
      created += 1;
    }
  }
  return { ratings: created, members: members.length, association };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (!args.school) { usage(); process.stderr.write('\n缺少 --school=<id>\n'); return 1; }
  const adapter = args.adapter === 'memory' ? memoryAdapter() : cloudAdapter();
  if (adapter.ready) await adapter.ready;
  const dryRun = !args.apply;
  process.stdout.write(`回填 ${args.school} · ${dryRun ? 'DRY-RUN（不写库）' : 'APPLY（写库）'}\n`);
  const total = await backfillAll(adapter, {
    schoolId: args.school,
    cursor: args.cursor,
    limit: args.limit,
    maxBatches: args.maxBatches,
    dryRun,
    onBatch: (stats, index) => {
      process.stdout.write([
        `  批 ${index}: 扫描 ${stats.scanned}`,
        `待改 ${stats.updated}`,
        `已一致 ${stats.unchanged}`,
        `无账号 ${stats.orphanUser}`,
        `无名册 ${stats.orphanMember}`,
        `→ ${stats.nextCursor || '(末页)'}`,
        '\n',
      ].join(' '));
      for (const sample of stats.samples) {
        process.stdout.write(`    ${sample.id}  ${JSON.stringify(sample.before)} → ${JSON.stringify(sample.after)}\n`);
      }
    },
  });
  process.stdout.write([
    '\n合计：',
    `${total.batches} 批 / 扫描 ${total.scanned} / `,
    `${dryRun ? '待改' : '已改'} ${total.updated} / `,
    `已一致 ${total.unchanged} / `,
    `无账号 ${total.orphanUser} / 无名册 ${total.orphanMember}\n`,
  ].join(''));
  if (!total.done) {
    process.stdout.write(`未跑完，续跑：--cursor=${total.cursor}\n`);
  } else if (dryRun) {
    process.stdout.write('确认数字合理后加 --apply 落库。\n');
  }
  if (total.orphanMember > 0) {
    process.stdout.write('注意：存在「名册里没有这个人」的评级文档，榜单会漏掉他们；先查 school_members 再决定是否清理。\n');
  }
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch((err) => {
    process.stderr.write(`回填失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

module.exports = { cloudAdapter, memoryAdapter, parseArgs };
