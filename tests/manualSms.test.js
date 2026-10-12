const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, process, Date,
    require(name) { return Object.hasOwn(mocks, name) ? mocks[name] : require(name); },
  }, { filename });
  return module.exports;
}

async function fixture(run) {
  const conversation = { _id: '6ac7dd9b3f815fbb351e16ca', phone: '+61400000000', dealer: 'BYD Nunawading', prospectName: 'Test Customer', control: 'AI active', messages: [] };
  const sends = [];
  const updates = [];
  const inertDb = { collection() { throw new Error('Retired automation must not read or mutate data'); } };
  const auth = { authenticate(req, res, next) { req.user = { id: 'staff-1', name: 'Staff', role: 'sales_manager' }; next(); } };
  const gateway = { async sendSms(options) { sends.push(options); return { messageId: 'provider-1', status: 'success' }; } };
  const mocks = {
    '../models/lead/Conversation': { async findById() { return conversation; }, async updateOne(filter, update) { updates.push(update); }, async findByIdAndUpdate(id, update) { updates.push(update); return { ...conversation, ...update.$set }; } },
    '../models/delivery/Message': { async create() {} },
    '../middleware/auth': auth,
    '../services/threadHistory': { async getThreads() { return []; }, allowedSite: () => true },
    '../db': { leadConn: { db: inertDb }, deliveryConn: { db: inertDb } },
    '../services/mobileMessage': gateway,
  };
  const app = express();
  app.use(express.json());
  app.use('/conversations', load('src/routes/conversations.js', mocks));
  app.use('/sequences', load('src/routes/sequences.js', mocks));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  async function request(route, body, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  try { await run({ request, sends, updates, conversation }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('conversation SMS endpoint rejects AI, customer and system sender impersonation', async () => fixture(async ({ request, sends, conversation }) => {
  for (const sender of ['ai', 'user', 'system']) {
    const response = await request(`/conversations/${conversation._id}/messages`, { sender, text: 'Unattended message' });
    assert.equal(response.status, 400);
  }
  assert.equal(sends.length, 0);
}));

test('staff message is attributed to the signed-in staff member and keeps human control', async () => fixture(async ({ request, sends, updates, conversation }) => {
  const response = await request(`/conversations/${conversation._id}/messages`, { text: 'Hello from your sales consultant.' });
  assert.equal(response.status, 201);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].requestedBy, 'staff-1');
  assert.equal(updates[0].$push.messages.sender, 'agent');
  assert.equal(updates[0].$set.control, 'Human');
}));

test('legacy PATCH requests cannot reactivate AI control', async () => fixture(async ({ request, updates, conversation }) => {
  const response = await request(`/conversations/${conversation._id}`, { control: 'AI active' }, 'PATCH');
  assert.equal(response.status, 200);
  assert.equal(updates[0].$set.control, 'Human');
}));

test('scheduled SMS processing, enrollment and resume are disabled without touching the gateway', async () => fixture(async ({ request, sends }) => {
  for (const route of ['/sequences/process-steps', '/sequences/enroll', '/sequences/legacy/resume']) {
    const response = await request(route, { phone: '+61400000000', customer_name: 'Test Customer' });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Automatic SMS is disabled/);
  }
  assert.equal(sends.length, 0);
}));

test('shared SMS gateway requires a staff identity before any provider contact', async () => {
  const gateway = load('src/services/mobileMessage.js', { '../models/lead/Setting': {} });
  await assert.rejects(gateway.sendSms({ to: '0400000000', message: 'Unattended' }), /manually by an authenticated staff member/);
});

test('legacy sequence listings and health cannot advertise active automation', async () => fixture(async ({ request }) => {
  const list = await request('/sequences', undefined, 'GET');
  assert.equal(list.status, 200);
  assert.equal(list.body.automation_enabled, false);
  assert.equal(list.body.data.length, 0);
  const health = await request('/sequences/health', undefined, 'GET');
  assert.equal(health.status, 200);
  assert.equal(health.body.data.summary.active, 0);
  assert.equal(health.body.data.automation_enabled, false);
}));
