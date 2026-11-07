const { ObjectId } = require('mongoose').mongo;
const same = (a, b) => a == null && b == null ? true : a instanceof Date || b instanceof Date ? Number(new Date(a)) === Number(new Date(b)) : String(a) === String(b);
const get = (object, key) => key.split('.').reduce((value, part) => Array.isArray(value) ? value.map(item => item?.[part]) : value?.[part], object);
function expr(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return get(row, value.slice(1));
  if (!value || typeof value !== 'object' || value instanceof RegExp) return value;
  if (value.$cond) return expr(value.$cond[0], row) ? expr(value.$cond[1], row) : expr(value.$cond[2], row);
  if (value.$and) return value.$and.every(v => expr(v, row));
  if (value.$ne) return !same(expr(value.$ne[0], row), expr(value.$ne[1], row));
  if (value.$ifNull) return expr(value.$ifNull[0], row) ?? expr(value.$ifNull[1], row);
  if (value.$convert) return String(expr(value.$convert.input, row) ?? '');
  if (value.$regexMatch) return value.$regexMatch.regex.test(expr(value.$regexMatch.input, row));
  return value;
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
      async findOne(query) { return rows.find(row => matches(row, query)) || null; },
      find(query) {
        let result = rows.filter(row => matches(row, query));
        const cursor = { sort() { return cursor; }, skip(value) { result = result.slice(value); return cursor; }, limit(value) { result = result.slice(0, value); return cursor; }, async toArray() { return result; } }; return cursor;
      },
      async countDocuments(query) { return rows.filter(row => matches(row, query)).length; },
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
