const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const delivery = require('../src/services/customerDelivery');
const actor = { id: 'sales-user', name: 'Sales Consultant', locked_site: 'BYD Fairfield', allowed_sites: ['BYD Fairfield'] };
const fields = () => ({ promises: 'Include mats', lead_time: '2–3 weeks', payment_method: 'Finance', finance_provider: 'Test provider', delivery_notes: 'Call before arrival' });
const clone = value => value == null ? value : structuredClone(value);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    if (key === '$and') return value.every(q => matches(row, q));
    if (value && typeof value === 'object') {
      if ('$exists' in value) return (row[key] !== undefined) === value.$exists;
      if ('$lt' in value) return row[key] < value.$lt;
      if ('$ne' in value) return row[key] !== value.$ne;
      if ('$in' in value) return value.$in.includes(row[key] ?? null);
    }
    return String(row[key]) === String(value);
  });
}
function fixture() {
  const state = { customers: [{ _id: 'cust-db', customer_id: 'customer-1', name: 'Test Customer', phone: '+61499918523', site: 'BYD Fairfield' }],
    opportunities: [{ _id: 'opp-db', opportunity_id: 'opp-1', customer_id: 'customer-1', site: 'BYD Fairfield', owner_name: actor.name, model: 'BYD Seal', stage: 'Negotiation' }] };
  const db = { collection(name) { const rows = () => state[name] ||= [];
    const apply = (row, update, inserted = false) => {
      if (inserted) Object.assign(row, clone(update.$setOnInsert || {}));
      Object.assign(row, clone(update.$set || {}));
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(clone(value));
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
    };
    return {
      async findOne(query) { return clone(rows().find(r => matches(r, query)) || null); },
      async countDocuments() { return rows().length; },
      async insertOne(row) { const saved = { ...clone(row), _id: `${name}-${rows().length}` }; rows().push(saved); return { insertedId: saved._id }; },
      async updateOne(query, update, options) { let row = rows().find(r => matches(r, query)); const inserted = !row;
        if (!row && options?.upsert) { row = { ...clone(query), _id: `${name}-${rows().length}` }; rows().push(row); }
        if (row) apply(row, update, inserted); return { matchedCount: row ? 1 : 0 }; },
      async findOneAndUpdate(query, update) { const row = rows().find(r => matches(r, query)); if (!row) return null; const before = clone(row); apply(row, update); return before; },
      async updateMany() { return { modifiedCount: 0 }; },
    };
  } };
  const filename = path.resolve(__dirname, '../src/services/crmService.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, process, Date,
    require(name) { if (name === '../db') return { deliveryConn: { db }, leadConn: { db }, ensureDbConnected: async () => {} };
      return require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name); } }, { filename });
  const crm = module.exports;
  crm.getOpportunityById = async id => clone(state.opportunities.find(r => r.opportunity_id === id));
  return { state, db, crm };
}

test('handoff rejects missing provider, blank fields, invalid payment and oversized payloads', () => {
  for (const input of [{ ...fields(), finance_provider: '' }, { ...fields(), promises: ' ' }, { ...fields(), lead_time: '' }, { ...fields(), payment_method: 'invalid' }, { ...fields(), delivery_notes: 'x'.repeat(2001) }]) {
    assert.throws(() => delivery.handoffFields(input), error => error.statusCode === 400);
  }
  assert.equal(delivery.handoffFields({ ...fields(), payment_method: 'Cash' }).finance_provider, '');
});

test('Sold persists structured handoff on customer, opportunity and stable Delivery client; retries do not duplicate a sale', async () => {
  const { state, crm, db } = fixture();
  const payload = { vin: 'TESTVIN123', sale_type: 'Retail', delivery_handoff: fields(), primary_salesperson: actor.name };
  const result = await crm.markSold('opp-1', payload, actor);
  assert.equal(result.deliverySyncSuccess, true);
  assert.equal(result.deliveryClientId, state.clients[0].id);
  assert.equal(state.customers[0].delivery_client_id, state.clients[0].id);
  assert.equal(state.clients[0].booking_type, 'estimated');
  assert.equal(state.clients[0].handoff_status, 'new');
  for (const record of [state.clients[0], state.customers[0], state.opportunities[0]]) assert.equal(record.delivery_handoff.promises, 'Include mats');
  await crm.markSold('opp-1', payload, actor);
  assert.equal(state.clients.length, 1); assert.equal(state.saleslogentries.length, 1);
  const record = await delivery.profile(db, db, 'customer-1', actor);
  const message = await delivery.chat(db, record, 'Can you confirm arrival?', actor);
  const data = delivery.view(await delivery.profile(db, db, 'customer-1', actor));
  assert.equal(data.messages[0].id, message.id);
  assert.equal(data.messages[0].author_id, actor.id);
  assert.equal(data.messages[0].team, 'sales');
  assert.equal(state.clients[0].delivery_unread, 1);
  assert.ok(Date.parse(message.created_at));
});

test('cross-site handoff and chat are rejected before any sales writes', async () => {
  const { crm, state, db } = fixture();
  const other = { ...actor, locked_site: 'BYD Nunawading', allowed_sites: ['BYD Nunawading'] };
  await assert.rejects(crm.markSold('opp-1', { vin: 'TESTVIN', sale_type: 'Retail', delivery_handoff: fields() }, other), e => e.statusCode === 404);
  await assert.rejects(delivery.profile(db, db, 'customer-1', other), e => e.statusCode === 404);
  assert.equal(state.clients, undefined); assert.equal(state.saleslogentries, undefined);
});

test('concurrent Sold requests cannot create duplicate client or sales log records', async () => {
  const { crm, state } = fixture();
  const input = { vin: 'TESTVIN', sale_type: 'Retail', delivery_handoff: fields() };
  const outcomes = await Promise.allSettled([crm.markSold('opp-1', input, actor), crm.markSold('opp-1', input, actor)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.clients.length, 1); assert.equal(state.saleslogentries.length, 1);
  assert.equal(state.opportunities[0].sold_handoff_lock, undefined);
});

test('blank chat and chat before Sold are rejected without persisting messages', async () => {
  const { db } = fixture();
  await assert.rejects(delivery.chat(db, { client: {} }, ' ', actor), e => e.statusCode === 400);
  await assert.rejects(delivery.chat(db, { client: null }, 'Question', actor), e => e.statusCode === 409);
});

test('Sales Floor lead is linked to one durable canonical customer before handoff', async () => {
  const { state, db } = fixture(); state.customers = [];
  state.leads = [{ _id: 'lead-db', leadId: 'lead-alias', name: 'Floor Customer', phone: '+61499918523', dealer: 'BYD Fairfield', vehicle: 'BYD Seal' }];
  const one = await delivery.profile(db, db, 'lead-alias', actor, true);
  const two = await delivery.profile(db, db, 'lead-alias', actor, true);
  assert.equal(one.customer.customer_id, two.customer.customer_id);
  assert.equal(state.customers.length, 1);
  assert.equal(state.leads[0].customerId, one.customer.customer_id);
});
