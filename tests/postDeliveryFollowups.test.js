const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./helpers/floorMemory');
const followups = require('../src/services/postDeliveryFollowups');
const { selectInventory } = require('../src/services/inventorySelection');
const user = { id: 'sales-1', name: 'Sales One', role: 'sales_consultant', site: 'BYD Fairfield', locked_site: 'BYD Fairfield', allowed_sites: ['BYD Fairfield'] };
const row = (fields = {}) => ({ id: 'a'.repeat(64), client_id: 'client-1', customer_id: 'customer-1', site: 'BYD Fairfield', salesperson_id: user.id, salesperson_name: user.name, status: 'open', due_at: new Date('2026-01-01'), ...fields });

test('post-delivery reminders stay within assigned salesperson and dealership', async () => {
  const db = database({ post_delivery_followups: [row(), row({ id: 'b'.repeat(64), salesperson_id: 'someone-else' }), row({ id: 'c'.repeat(64), site: 'BYD Nunawading' })] });
  assert.equal((await followups.list(db, user)).length, 1);
  assert.equal((await followups.list(db, { ...user, role: 'sales_manager' })).length, 2);
  await assert.rejects(followups.complete(db, 'b'.repeat(64), { notes: 'Done', call_outcome: 'Contacted', text_action: 'No text required' }, user), error => error.statusCode === 404);
});

test('call notes and text actions persist once in the task and both customer histories', async () => {
  const db = database({ post_delivery_followups: [row()], clients: [{ id: 'client-1', comments: [] }] });
  const input = { notes: 'Customer is enjoying the car.', call_outcome: 'Contacted', text_action: 'Text planned' };
  const first = await followups.complete(db, row().id, input, user);
  const again = await followups.complete(db, row().id, { ...input, notes: 'Late retry' }, user);
  assert.equal(first.status, 'completed'); assert.equal(again.notes, input.notes);
  assert.equal(db.tables.get('timelineevents').length, 1);
  assert.equal(db.tables.get('clients')[0].comments.length, 1);
  assert.match(db.tables.get('timelineevents')[0].content, /Text planned/);
  assert.equal((await followups.list(db, user)).length, 0);
});

test('follow-up validation never writes an empty or unrecorded action', async () => {
  const db = database({ post_delivery_followups: [row()] });
  for (const input of [{ notes: '' }, { notes: 'Done', call_outcome: 'invalid', text_action: 'Text sent' }, { notes: 'Done', call_outcome: 'Contacted', text_action: 'invalid' }]) {
    await assert.rejects(followups.complete(db, row().id, input, user), error => error.statusCode === 400);
  }
  assert.equal(db.tables.get('post_delivery_followups')[0].status, 'open');
});

test('inventory selection uses the authoritative VIN and rejects another site, stale stock and missing VIN', async () => {
  const db = database({ inventories: [{ stock: '123', location: 'Fairfield', status: 'Available', registration: { vin: 'ACTUALVIN123' }, specifications: { model: 'Seal' } }] });
  const opp = { opportunity_id: 'opp-1', site: 'BYD Fairfield' };
  assert.equal((await selectInventory(db, db, 'VY-VIC-123', opp)).vin, 'ACTUALVIN123');
  await assert.rejects(selectInventory(db, db, 'VY-VIC-123', { ...opp, site: 'BYD Nunawading' }), error => error.statusCode === 404);
  db.tables.get('inventories')[0].status = 'Sold';
  await assert.rejects(selectInventory(db, db, 'VY-VIC-123', opp), error => error.statusCode === 409);
  db.tables.get('inventories')[0].status = 'Available'; db.tables.get('inventories')[0].registration.vin = '';
  await assert.rejects(selectInventory(db, db, 'VY-VIC-123', opp), error => error.statusCode === 400);
});
