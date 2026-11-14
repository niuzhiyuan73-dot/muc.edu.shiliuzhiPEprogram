const { COLLECTIONS } = require('../repository');
const { queryPlan } = require('../../lib/services/personal-sports-query');

/** SDK 表达式只在适配器构造，查询规格不依赖云 SDK。 */
function compileExpression(value, aggregate) {
  if (Array.isArray(value)) return value.map(item => compileExpression(item, aggregate));
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0][0] === '$') {
    const operator = keys[0].slice(1);
    const name = operator === 'ne' ? 'neq' : operator;
    if (typeof aggregate[name] !== 'function') throw new Error(`不支持的聚合表达式：${name}`);
    return aggregate[name](compileExpression(value[keys[0]], aggregate));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compileExpression(item, aggregate)]));
}
function compileMatch(value, aggregate) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === '$expr' ? compileExpression(item, aggregate)
    : (key === '$and' || key === '$or') ? item.map(cond => compileMatch(cond, aggregate)) : item]));
}
async function readPersonalSportsPage(db, command, source, auth, query) {
  const plan = queryPlan(source, auth, query);
  let page = db.collection(COLLECTIONS[plan.key]).aggregate();
  for (const [kind, spec] of plan.stages) {
    const value = kind === 'lookup' ? { from: COLLECTIONS[spec.key], localField: spec.localField, foreignField: spec.foreignField, as: spec.as }
      : kind === 'addFields' || kind === 'group' ? compileExpression(spec, command.aggregate)
        : kind === 'match' ? compileMatch(spec, command.aggregate) : spec;
    page = page[kind](value);
  }
  const result = await page.end();
  const rows = result.list || result.data || [];
  return { rows: rows.slice(0, plan.limit), hasMore: rows.length > plan.limit };
}
module.exports = { readPersonalSportsPage, compileExpression };
