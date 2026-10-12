const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const history = require('../src/services/threadHistory');
const smsEvent = require('../src/services/smsEvent');

const phone = '+61499918523';
const leadId = '6acc72ac18b6c13e851e0bc1';
const clientId = '4bb445bc-04db-43da-b50c-3a0bc217975e';
async function fixture(user, run, optedOut = false) {
  const records = {
    leads: [{ _id: leadId, phone: '+61 499 918 523', dealer: 'BYD Melbourne', name: 'BYD Customer' }],
    clients: [{ _id: '6acc72ad18b6c13e851e0bc5', id: clientId, phone: '+61 499 918 523', site: 'Denza Melbourne', name: 'Denza Customer' }],
    customers: [{ customer_id: 'byd-customer', phone, site: 'Melbourne City' }],
  };
  const sends = [];
  const saved = [];
  const timeline = [];
  const db = { collection(name) { return {
    find() { return { async toArray() { return records[name] || []; } }; },
    async updateOne() {},
    async insertOne(document) { if (name === 'timelineevents') timeline.push(document); },
  }; } };
  const mocks = {
    '../models/delivery/Message': { async create(data) { const record = { _id: 'sms-1', ...data }; saved.push(record); return record; } },
    '../models/delivery/Client': { async findOne() { return optedOut ? { opted_out: true } : null; } },
    '../models/lead/Lead': { async findOne() { return null; } },
    '../models/delivery/AuditEvent': { async create() {} },
    '../middleware/auth': { authenticate(req, res, next) { req.user = user; next(); } },
    '../services/mobileMessage': { normalizeAustralianPhone: number => '+' + history.phoneKey(number), async sendSms(data) { sends.push(data); return { status: 'success', messageId: 'provider-1' }; } },
    '../services/threadHistory': history,
    '../services/smsEvent': smsEvent,
    '../db': { leadConn: { db }, deliveryConn: { db } },
  };
  const moduleFixture = { exports: {} };
  const filename = path.resolve(__dirname, '../src/routes/messages.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: moduleFixture, exports: moduleFixture.exports, console, process, Date,
    require(name) { return Object.hasOwn(mocks, name) ? mocks[name] : require(name); },
  }, { filename });
  const app = express();
  app.use(express.json());
  app.use('/messages', moduleFixture.exports);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  async function request(payload) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, body: 'Manual test message', ...payload }) });
    return { status: response.status, body: await response.json() };
  }
  try { await run({ request, sends, saved, timeline }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const admin = { id: 'staff-1', email: 'fixture@example.com', role: 'super_admin', locked_site: '', network_lookup: true };

test('reported BYD lead ID plus Denza site mismatch is rejected before any SMS', async () => fixture(admin, async ({ request, sends }) => {
  const response = await request({ leadId, site: 'Denza Melbourne' });
  assert.equal(response.status, 403);
  assert.equal(response.body.message, 'Recipient not found or site access denied');
  assert.equal(sends.length, 0);
}));

test('correct Denza delivery identity sends manually and does not log to the BYD customer', async () => fixture(admin, async ({ request, sends, saved, timeline }) => {
  const response = await request({ client_id: clientId, site: 'Denza Melbourne' });
  assert.equal(response.status, 201);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].requestedBy, 'staff-1');
  assert.equal(saved[0].site, 'Denza Melbourne');
  assert.equal(timeline[0].customer_id, 'CUST-SMS-sms-1');
}));

test('phone and Denza site resolve an existing delivery recipient without a borrowed lead ID', async () => fixture(admin, async ({ request, saved }) => {
  const response = await request({ site: 'Denza Melbourne' });
  assert.equal(response.status, 201);
  assert.equal(saved[0].site, 'Denza Melbourne');
}));

test('BYD site-locked staff still cannot send to a Denza recipient sharing the same phone', async () => fixture({ ...admin, locked_site: 'BYD Melbourne' }, async ({ request, sends }) => {
  const response = await request({ client_id: clientId, site: 'Denza Melbourne' });
  assert.equal(response.status, 403);
  assert.equal(sends.length, 0);
}));

test('global opt-out suppression still blocks a correctly resolved recipient', async () => fixture(admin, async ({ request, sends }) => {
  const response = await request({ client_id: clientId, site: 'Denza Melbourne' });
  assert.equal(response.status, 403);
  assert.equal(response.body.opted_out, true);
  assert.equal(sends.length, 0);
}, true));
