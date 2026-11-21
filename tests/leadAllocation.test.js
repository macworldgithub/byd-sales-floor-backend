const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ObjectId } = require('mongoose').mongo;
const { database } = require('./helpers/floorMemory');
const projection = require('../src/services/leadAllocation');

function fixture() {
  const person = { _id: new ObjectId(), name: 'Fixture Consultant', email: 'consultant@example.test', role: 'sales_consultant', site: 'BYD Fairfield', active: true, platform_access: ['sales_floor'] };
  const enquiry = { _id: new ObjectId(), name: 'Fixture Customer', phone: '0412345678', dealer: 'BYD Fairfield', stage: 'NEW ENQUIRIES', status: 'new' };
  const lead = database({ leads: [enquiry] }), panel = database({ users: [person] });
  // Model BSON identity accurately: MongoDB does not equate an ObjectId and a string.
  const base = lead.collection.bind(lead); let failProjection = false;
  lead.collection = name => {
    const collection = base(name), find = collection.findOne.bind(collection), update = collection.updateOne.bind(collection);
    return { ...collection, findOne(query) { if (name === 'leads' && typeof query._id === 'string') return Promise.resolve(null); return find(query); },
      updateOne(query, change, options) { if (name === 'leads' && failProjection) throw Error('Fixture write failed'); return update(query, change, options); } };
  };
  const collection = panel.collection.bind(panel);
  panel.collection = name => { const result = collection(name); const count = result.countDocuments; return { ...result, countDocuments: (query = {}) => count(query) }; };
  const filename = path.resolve(__dirname, '../src/services/crmService.js'), actualRequire = createRequire(filename), loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: loaded, console, Date, process, require(key) {
    if (key === '../db') return { leadConn: { db: lead }, deliveryConn: { db: panel }, ensureDbConnected: async () => {} };
    if (key === './crmLive') return { settings: async () => ({ effective: { slaTimeoutMinutes: 15 } }) };
    return actualRequire(key);
  } });
  const payload = { event_id: 'fixture-event', lead_prospect_id: String(enquiry._id), name: enquiry.name, phone: enquiry.phone, site: 'BYD Fairfield', assigned_to: person.email };
  return { lead, panel, person, enquiry, payload, service: loaded.exports, failProjection(value) { failProjection = value; } };
}
test('Lead Centre allocation updates the original BSON enquiry and is visible to its real salesperson', async () => {
  const f = fixture(); const result = await f.service.createAllocation(f.payload);
  assert.equal(f.lead.tables.get('leads').length, 1);
  assert.equal(f.enquiry.assignedTo, f.person.email);
  assert.equal(f.enquiry.owner_user_id, String(f.person._id));
  assert.equal(f.enquiry.stage, 'IN FOLLOW-UP'); assert.equal(f.enquiry.status, 'qualification');
  assert.equal(result.lead_prospect_id, String(f.enquiry._id));
  assert.equal(result.projection_state, 'complete');
  assert.equal(f.panel.tables.get('customers')[0].owner_user_id, String(f.person._id));
  assert.equal(f.panel.tables.get('opportunities')[0].owner_name, f.person.name);
  assert.equal(f.panel.tables.get('floor_notifications')[0].owner_user_id, String(f.person._id));
  assert.equal((await f.service.createAllocation(f.payload)).duplicate, true);
  assert.equal(f.panel.tables.get('allocations').length, 1);
  assert.equal(f.panel.tables.get('floor_notifications').length, 1);
});
test('a failed lead write is an error; replay repairs the saved allocation without creating another lead or allocation', async () => {
  const f = fixture(); f.failProjection(true);
  await assert.rejects(f.service.createAllocation(f.payload), /Fixture write failed/);
  assert.equal(f.panel.tables.get('allocations').length, 1);
  f.failProjection(false);
  const result = await f.service.createAllocation(f.payload);
  assert.equal(result.duplicate, true); assert.equal(result.projection_state, 'complete');
  assert.equal(f.panel.tables.get('allocations').length, 1); assert.equal(f.lead.tables.get('leads').length, 1);
});
test('replay repairs an allocation interrupted before its opportunity was created', async () => {
  const f = fixture(); f.service.createOpportunity = async () => { throw Error('Fixture opportunity write failed'); };
  await assert.rejects(f.service.createAllocation(f.payload), /opportunity write failed/);
  const result = await f.service.createAllocation(f.payload);
  assert.equal(result.projection_state, 'complete');
  assert.equal(f.panel.tables.get('opportunities').length, 1);
  assert.equal(f.panel.tables.get('opportunities')[0].lead_prospect_id, String(f.enquiry._id));
});
test('unknown, inactive, ambiguous, non-floor and cross-site staff cannot receive a successful allocation', async () => {
  for (const patch of [{ active: false }, { site: 'BYD Nunawading' }, { platform_access: ['lead_centre'] }, { role: 'contractor' }]) {
    const f = fixture(); Object.assign(f.person, patch);
    await assert.rejects(f.service.createAllocation(f.payload), /active Sales Floor consultant/);
    assert.equal(f.panel.tables.get('allocations')?.length || 0, 0);
  }
  const f = fixture(); f.panel.tables.get('users').push({ ...f.person, _id: new ObjectId(), email: 'another@example.test' });
  await assert.rejects(projection.assignee(f.panel, { site: 'BYD Fairfield', assigned_to: f.person.name }), /Choose one/);
});
test('a missing enquiry never falls back to a same-phone record, and another dealership cannot be reassigned', async () => {
  const f = fixture();
  await assert.rejects(f.service.createAllocation({ ...f.payload, lead_prospect_id: String(new ObjectId()) }), /not found/);
  await assert.rejects(f.service.createAllocation({ ...f.payload, site: 'BYD Nunawading', assigned_to: f.person.email }), /consultant/);
  assert.equal(f.enquiry.assignedTo, undefined);
});
test('legacy directory IDs resolve through the same verified email, and another salesperson cannot accept the allocation', async () => {
  const f = fixture();
  const allocated = await f.service.createAllocation({ ...f.payload, assigned_to_user_id: String(new ObjectId()) });
  assert.equal(allocated.assigned_to_user_id, String(f.person._id));
  await assert.rejects(f.service.acceptAllocation(allocated.allocation_id, 'Another Consultant', {
    id: String(new ObjectId()), name: 'Another Consultant', role: 'sales_consultant',
  }), /Only the assigned salesperson/);
  assert.equal(f.panel.tables.get('allocations')[0].status, 'pending');
});
test('accept/reassign touches only the exact allocated lead, retaining booked test drives', async () => {
  const f = fixture(); f.enquiry.stage = 'TEST DRIVE BOOKED';
  await f.service.createAllocation(f.payload);
  f.lead.tables.get('leads').push({ _id: new ObjectId(), dealer: 'BYD Nunawading', phone: f.enquiry.phone, assignedTo: 'other@example.test' });
  const next = { ...f.person, _id: new ObjectId(), email: 'next@example.test', name: 'Next Consultant' }; f.panel.tables.get('users').push(next);
  const allocation = f.panel.tables.get('allocations')[0];
  await f.service.reassignAllocation(allocation.allocation_id, next.email);
  assert.equal(f.enquiry.assignedTo, next.email); assert.equal(f.enquiry.stage, 'TEST DRIVE BOOKED');
  assert.equal(f.lead.tables.get('leads')[1].assignedTo, 'other@example.test');
});
test('historical recovery previews without writes, repairs the original enquiry and preserves a newer owner', async () => {
  const f = fixture(); f.failProjection(true); await assert.rejects(f.service.createAllocation(f.payload)); f.failProjection(false);
  const manager = { role: 'sales_manager', site: 'BYD Fairfield' };
  const preview = await projection.recover(f.lead, f.panel, {}, manager);
  assert.equal(preview.ready, 1); assert.equal(f.enquiry.assignedTo, undefined);
  const repaired = await projection.recover(f.lead, f.panel, {}, manager, true);
  assert.equal(repaired.recovered, 1); assert.equal(f.enquiry.assignedTo, f.person.email);
  const other = fixture(); other.failProjection(true); await assert.rejects(other.service.createAllocation(other.payload)); other.failProjection(false);
  other.enquiry.assignedTo = 'newer-owner@example.test';
  assert.equal((await projection.recover(other.lead, other.panel, {}, manager, true)).review, 1);
  assert.equal(other.enquiry.assignedTo, 'newer-owner@example.test');
});
