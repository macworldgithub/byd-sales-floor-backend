const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { database } = require('./helpers/floorMemory');
const followups = require('../src/services/postDeliveryFollowups');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, relative), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console,
    require(key) { return Object.hasOwn(mocks, key) ? mocks[key] : require(key.startsWith('.') ? path.resolve(path.dirname(filename), key) : key); },
  }, { filename });
  return module.exports;
}

test('Sales Floor-only users can search scoped inventory and complete shared reminders without CRM access', async () => {
  const user = { _id: '123456789012345678901234', name: 'Floor Consultant', role: 'sales_consultant',
    site: 'BYD Fairfield', locked_site: 'BYD Fairfield', platform_access: ['sales_floor'], active: true };
  const auth = load('../src/middleware/auth.js', {
    '../models/delivery/User': { findById() { return { lean: async () => user }; } },
  });
  const task = { id: 'a'.repeat(64), salesperson_id: user._id, salesperson_name: user.name, site: user.site,
    client_id: 'client-1', customer_id: 'customer-1', status: 'open', due_at: new Date('2026-01-01') };
  const db = database({ post_delivery_followups: [task, { ...task, id: 'b'.repeat(64), salesperson_id: 'other-user' }], clients: [{ id: 'client-1', comments: [] }] });
  let stockQuery;
  const router = load('../src/routes/customerDelivery.js', {
    '../middleware/auth': auth,
    '../db': { deliveryConn: { db }, leadConn: { db }, ensureDbConnected: async () => {} },
    '../services/crmService': { getVyStock: async query => { stockQuery = query; return { data: [{ stock_id: 'VY-VIC-123', vin: 'VIN123' }], pagination: { page: 2, pages: 3 } }; } },
  });
  const app = express(); app.use(express.json()); app.use('/api/customer-delivery', router);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/customer-delivery`;
  const headers = { authorization: `Bearer ${auth.generateToken(user, 'sales_floor')}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/inventory')).status, 401);
    const inventory = await fetch(base + '/inventory?q=VIN123&page=2&site=BYD%20Nunawading', { headers });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.headers.get('cache-control'), 'no-store');
    const stock = await inventory.json(); assert.equal(stock.pagination.pages, 3);
    assert.equal(stockQuery.site, user.site); assert.equal(stockQuery.page, '2'); assert.equal(stockQuery.q, 'VIN123');
    const list = await (await fetch(base + '/post-delivery-followups', { headers })).json();
    assert.equal(list.data.length, 1); assert.equal(list.data[0].id, task.id);
    const input = { notes: 'Customer enjoying the vehicle.', call_outcome: 'Contacted', text_action: 'Text planned' };
    assert.equal((await fetch(base + '/post-delivery-followups/' + 'b'.repeat(64) + '/complete', { method: 'POST', headers, body: JSON.stringify(input) })).status, 404);
    const result = await fetch(base + `/post-delivery-followups/${task.id}/complete`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(result.status, 200); assert.equal((await result.json()).data.status, 'completed');
    // CRM reads the same task collection: no second reminder or completion is created.
    assert.equal((await followups.list(db, { id: user._id, name: user.name, role: user.role, locked_site: user.site })).length, 0);
    assert.equal(db.tables.get('timelineevents').length, 1); assert.equal(db.tables.get('clients')[0].comments.length, 1);
    assert.equal(db.tables.get('timelineevents')[0].source_system, 'sales_floor');
    user.platform_access = ['delivery_centre'];
    assert.equal((await fetch(base + '/post-delivery-followups', { headers })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
