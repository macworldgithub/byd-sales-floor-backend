const { ObjectId } = require('mongoose').mongo;
const same = (a, b) => a == null && b == null ? true : a instanceof Date || b instanceof Date ? Number(new Date(a)) === Number(new Date(b)) : String(a) === String(b);
const get = (object, key) => key.split('.').reduce((value, part) => Array.isArray(value) ? value.map(item => item?.[part]) : value?.[part], object);
function expr(value, row, vars = {}) {
  const evaluate = item => expr(item, row, vars);
  const truthy = item => item != null && item !== false && item !== 0;
  if (typeof value === 'string' && value.startsWith('$$')) return get(vars, value.slice(2));
  if (typeof value === 'string' && value.startsWith('$')) return get(row, value.slice(1));
  if (!value || typeof value !== 'object' || value instanceof RegExp || value instanceof Date || value instanceof ObjectId) return value;
  if (Array.isArray(value)) return value.map(evaluate);
  if ('$literal' in value) return value.$literal;
  if (value.$cond) return truthy(evaluate(value.$cond[0])) ? evaluate(value.$cond[1]) : evaluate(value.$cond[2]);
  if (value.$and) return value.$and.every(item => truthy(evaluate(item)));
  if (value.$or) return value.$or.some(item => truthy(evaluate(item)));
  if (value.$not) return !truthy(evaluate(value.$not[0]));
  if (value.$ne) return !same(...value.$ne.map(evaluate));
  if (value.$gte) { const [a,b] = value.$gte.map(evaluate); return a >= b; }
  if (value.$lte) { const [a,b] = value.$lte.map(evaluate); return a <= b; }
  if (value.$gt) { const [a,b] = value.$gt.map(evaluate); return a > b; }
  if (value.$toLower) return String(evaluate(value.$toLower)).toLowerCase();
  if (value.$trim) return String(evaluate(value.$trim.input)).trim();
  if (value.$in) { const [a,b] = value.$in.map(evaluate); return b.some(item => same(a,item)); }
  if (value.$subtract) { const [a,b] = value.$subtract.map(evaluate); return a == null || b == null ? null : a - b; }
  if (value.$divide) { const [a,b] = value.$divide.map(evaluate); return a == null || b == null ? null : a / b; }
  if (value.$max) return Math.max(...value.$max.map(evaluate));
  if (value.$toString) { const item = evaluate(value.$toString); return item == null ? null : String(item); }
  if (value.$ifNull) return evaluate(value.$ifNull[0]) ?? evaluate(value.$ifNull[1]);
  if (value.$convert) {
    const item = evaluate(value.$convert.input);
    if (value.$convert.to === 'double') return item == null ? (value.$convert.onNull ?? null) : Number.isFinite(Number(item)) ? Number(item) : (value.$convert.onError ?? null);
    if (value.$convert.to !== 'date') return String(item ?? '');
    const date = item == null ? null : new Date(item);
    return date && Number.isFinite(date.getTime()) ? date : null;
  }
  if (value.$regexMatch) return value.$regexMatch.regex.test(evaluate(value.$regexMatch.input));
  if (value.$filter) return evaluate(value.$filter.input).filter(item => expr(value.$filter.cond, row, { ...vars, [value.$filter.as]: item }));
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,evaluate(item)]));
}
function aggregate(rows, pipeline) {
  let data = rows;
  for (const stage of pipeline) {
    if (stage.$match) data = data.filter(row => matches(row, stage.$match));
    else if (stage.$facet) data = [Object.fromEntries(Object.entries(stage.$facet).map(([name,stages]) => [name,aggregate(data,stages)]))];
    else if (stage.$count) data = data.length ? [{[stage.$count]:data.length}] : [];
    else if ('$skip' in stage) data = data.slice(stage.$skip);
    else if (stage.$limit) data = data.slice(0,stage.$limit);
    else if (stage.$project) data = data.map(row => Object.fromEntries([
      ...(!('_id' in stage.$project) ? [['_id',row._id]] : []),
      ...Object.entries(stage.$project).filter(([,v]) => v !== 0).map(([key,v]) => [key,v === 1 ? row[key] : expr(v,row)]),
    ]));
    else if (stage.$sort) data = [...data].sort((a,b) => {
      for (const [key,direction] of Object.entries(stage.$sort)) if (!same(a[key],b[key])) return a[key] > b[key] ? direction : -direction;
      return 0;
    });
    else if (stage.$group) {
      const groups = new Map();
      for (const row of data) {
        const key = expr(stage.$group._id,row), encoded = JSON.stringify(key);
        let group = groups.get(encoded);
        if (!group) { group = {_id:key}; groups.set(encoded,group); }
        for (const [field,accumulator] of Object.entries(stage.$group)) {
          if (field === '_id') continue;
          const [op,arg] = Object.entries(accumulator)[0], result = expr(arg,row);
          if (op === '$sum') group[field] = (group[field] || 0) + result;
          else if (op === '$first') { if (!(field in group)) group[field] = result; }
          else if (op === '$max') group[field] = field in group ? Math.max(group[field],result) : result;
          else if (op === '$push') (group[field] ||= []).push(result);
          else throw Error('Unsupported test accumulator ' + op);
        }
      }
      data = [...groups.values()];
    } else throw Error('Unsupported test pipeline stage');
  }
  return data;
}
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every(v => matches(row, v));
    if (key === '$or') return value.some(v => matches(row, v));
    if (key === '$expr') return expr(value, row);
    const actual = get(row, key);
    if (value instanceof RegExp) return value.test(String(actual ?? ''));
    if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof ObjectId)) return Object.entries(value).every(([op, item]) => {
      if (op === '$exists') return (actual !== undefined) === item;
      if (op === '$in') return item.some(v => same(actual, v));
      if (op === '$nin') return !item.some(v => same(actual, v));
      if (op === '$ne') return Array.isArray(actual) ? actual.every(value => !same(value, item)) : !same(actual, item);
      if (op === '$lt') return actual < item;
      if (op === '$lte') return actual <= item;
      if (op === '$gt') return actual > item;
      if (op === '$gte') return actual >= item;
      throw Error(`Unsupported test operator ${op}`);
    });
    if (Array.isArray(actual)) return actual.some(v => same(v, value));
    return same(actual, value);
  });
}
function set(row, key, value, remove = false) {
  const pieces = key.split('.'), last = pieces.pop(); let target = row;
  for (const piece of pieces) target = target[piece] ||= {};
  if (remove) delete target[last]; else target[last] = value;
}
function database(initial = {}) {
  const tables = new Map(Object.entries(initial));
  return { tables, collection(name) {
    if (!tables.has(name)) tables.set(name, []);
    const rows = tables.get(name);
    return { rows, async createIndex() {},
      aggregate(pipeline) { return { toArray: async () => aggregate(rows,pipeline) }; },
      async findOne(query) { return rows.find(row => matches(row, query)) || null; },
      find(query) {
        let result = rows.filter(row => matches(row, query));
        const cursor = { sort() { return cursor; }, skip(value) { result = result.slice(value); return cursor; }, limit(value) { result = result.slice(0, value); return cursor; }, async toArray() { return result; } }; return cursor;
      },
      async countDocuments(query) { return rows.filter(row => matches(row, query)).length; },
      async distinct(key, query = {}) { return [...new Set(rows.filter(row => matches(row, query)).map(row => get(row, key)).filter(value => value !== undefined))]; },
      async insertOne(row) { if (row._id && rows.some(old => same(old._id, row._id))) throw Object.assign(Error('Duplicate'), { code: 11000 }); row._id ||= new ObjectId(); rows.push({ ...row }); return { insertedId: row._id }; },
      async updateOne(query, update, options = {}) {
        let row = rows.find(row => matches(row, query)), created = false;
        if (!row && options.upsert) { row = Object.fromEntries(Object.entries(query).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v instanceof ObjectId))); row._id ||= new ObjectId(); rows.push(row); created = true; }
        if (!row) return { modifiedCount: 0 };
        for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
        if (created) for (const [key, value] of Object.entries(update.$setOnInsert || {})) set(row, key, value);
        for (const key of Object.keys(update.$unset || {})) set(row, key, null, true);
        for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, (get(row, key) || 0) + value);
        for (const [key, value] of Object.entries(update.$max || {})) if (get(row, key) === undefined || get(row, key) < value) set(row, key, value);
        for (const [key, value] of Object.entries(update.$addToSet || {})) { const array = get(row, key) || []; for (const item of value?.$each || [value]) if (!array.some(old => JSON.stringify(old) === JSON.stringify(item))) array.push(item); set(row, key, array); }
        for (const [key, value] of Object.entries(update.$push || {})) set(row, key, [...(get(row, key) || []), value]);
        return { modifiedCount: 1, upsertedId: created ? row._id : null };
      },
      async deleteOne(query) { const at = rows.findIndex(row => matches(row, query)); if (at >= 0) rows.splice(at, 1); },
      async updateMany(query, update) {
        const selected = rows.filter(row => matches(row, query));
        for (const row of selected) await this.updateOne({ _id: row._id }, update);
        return { modifiedCount: selected.length };
      },
    };
  } };
}
module.exports = { database, matches };
