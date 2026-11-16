const valueAt = (row, field) => field.split('.').reduce((value, key) => value == null ? undefined : value[key], row);

/** Evaluates the SDK stages independently of the application directory search implementation. */
function directoryDatabase(tables) {
  const traces = [], returned = [];
  const expression = (value, row) => {
    if (typeof value === 'string' && value.startsWith('$')) return valueAt(row, value.slice(1));
    if (Array.isArray(value)) return value.map(item => expression(item, row));
    if (!value || typeof value !== 'object') return value;
    if (value.literal !== undefined) return value.literal;
    if (value.op === 'cond') return expression(value.args.if, row) ? expression(value.args.then, row) : expression(value.args.else, row);
    const args = value.args && expression(value.args, row);
    switch (value.op) {
      case 'ifNull': return args[0] == null ? args[1] : args[0];
      case 'indexOfCP': return args[0].indexOf(args[1]);
      case 'eq': return args[0] === args[1];
      case 'neq': return args[0] !== args[1];
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      default: throw new Error(`unsupported expression: ${JSON.stringify(value)}`);
    }
  };
  const matches = (row, query) => Object.entries(query).every(([field, cond]) => {
    if (field === '$or') return cond.some(item => matches(row, item));
    const value = valueAt(row, field);
    if (!cond || typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, expected]) => {
      if (op === '$gt') return value > expected;
      if (op === '$gte') return value >= expected;
      if (op === '$ne') return value !== expected;
      if (op === '$exists') return (value !== undefined) === expected;
      throw new Error(`unsupported query operator: ${op}`);
    });
  });
  const command = { aggregate: Object.fromEntries(['ifNull','indexOfCP','eq','neq','and','or','cond'].map(op => [op, args => ({ op, args })])) };
  command.aggregate.literal = literal => ({ literal });
  const db = { traces, returned, command, collection: name => ({ aggregate: () => {
    const stages = [];
    const api = Object.fromEntries(['match','lookup','unwind','project','addFields','sort','limit'].map(kind => [kind, spec => {
      stages.push([kind, spec]); return api;
    }]));
    api.end = async () => {
      traces.push(stages);
      const source = typeof tables === 'function' ? tables() : tables;
      let rows = source[name].map(row => ({ ...row }));
      for (const [kind, spec] of stages) {
        if (kind === 'match') rows = rows.filter(row => matches(row, spec));
        if (kind === 'lookup') rows = rows.map(row => ({ ...row,
          [spec.as]: source[spec.from].filter(other => valueAt(row, spec.localField) === valueAt(other, spec.foreignField)) }));
        if (kind === 'unwind') rows = rows.flatMap(row => valueAt(row, spec.slice(1)).map(value => ({ ...row, [spec.slice(1)]: value })));
        if (kind === 'project') rows = rows.map(row => Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== 0)
          .map(([key, value]) => [key, value === 1 ? row[key] : expression(value, row)])));
        if (kind === 'addFields') rows = rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, expression(value, row)])) }));
        if (kind === 'sort') rows.sort((a, b) => {
          for (const [field, direction] of Object.entries(spec)) {
            if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * direction;
          }
          return 0;
        });
        if (kind === 'limit') rows = rows.slice(0, spec);
      }
      returned.push(rows.length);
      return { list: rows };
    };
    return api;
  } }) };
  return db;
}

module.exports = { directoryDatabase };
