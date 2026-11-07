const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ObjectId } = require('mongoose').mongo;
const express = require('express');
const { database } = require('./helpers/floorMemory');

async function fixture(run) {
  const user = { id: 'staff-1', name: 'Consultant', email: 'consultant@example.invalid', role: 'sales_consultant', site: 'BYD Fairfield', locked_site: 'BYD Fairfield', allowed_sites: ['BYD Fairfield'], platform_access: ['sales_floor'] };
  const leadId = new ObjectId(), otherId = new ObjectId();
  const lead = database({ leads: [{ _id: leadId, name: 'Actual Customer', phone: '+61400000000', email: 'actual@example.invalid', dealer: 'BYD Fairfield', assignedTo: user.email, allocatedPersonFullName: user.name },
    { _id: otherId, name: 'Other Site', dealer: 'BYD Nunawading', assignedTo: user.email }] });
  const panel = database(), bookings = [];
  const file = path.resolve(__dirname, '../src/routes/mobile.js'), localRequire = createRequire(file), module = { exports: {} };
  const mocks = { '../db': { leadConn: { db: lead }, deliveryConn: { db: panel } }, '../middleware/auth': {
    authenticate(req, res, next) { if (!req.headers.authorization) return res.status(401).json({ success: false }); req.user = user; next(); },
  }, '../services/virtualyard': { async metadata(account) {
    return { yards: [{ id: '4840', name: 'BYD Fairfield' }, { id: '4850', name: 'BYD Nunawading' }].filter(row => !account.locked_site || row.name === account.locked_site) };
  } }, '../services/appointmentBooking': { async book(document, input, account, collection) {
    bookings.push({ document, input, account }); document._id = new ObjectId(); document.virtualyardSync = { state: 'failed', message: 'Session expired.' }; await collection.insertOne(document);
    return { appointment: document, reused: false };
  } } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), process, Buffer, URL, console });
  const app = express(); app.use(express.json()); app.use('/mobile', module.exports);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = async (route, body, method = 'POST', auth = true, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mobile${route}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer fixture' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('text/csv') ? await response.text() : await response.json() };
  };
  try { await run({ user, leadId: String(leadId), otherId: String(otherId), bookings, request, lead, panel }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('mobile test drive uses canonical customer identity, preserves timezone and returns actual failed sync state', async () => fixture(async ({ request, leadId, bookings }) => {
  const when = '2026-11-20T10:00:00+11:00';
  const response = await request('/appointments', { leadId, bookingRequestId: 'stable-mobile-request', when, type: 'Test Drive', phone: 'attacker', prospectName: 'Forged customer', site: 'BYD Nunawading',
    createVirtualyardCustomer: true, virtualyard: { vehicleId: '1', userId: '2', locationId: '4840' } });
  assert.equal(response.status, 200); assert.equal(bookings.length, 1);
  assert.equal(bookings[0].document.prospectName, 'Actual Customer'); assert.equal(bookings[0].document.phone, '+61400000000'); assert.equal(bookings[0].document.email, 'actual@example.invalid');
  assert.equal(bookings[0].document.site, 'BYD Fairfield'); assert.equal(bookings[0].document.when, when); assert.equal(bookings[0].input.createVirtualyardCustomer, true);
  assert.equal(response.body.data.virtualyardSync.state, 'failed'); assert.equal(response.body.data.virtualyardSync.externalId, undefined);
}));
test('all-site managers record reads honor the selected mobile site', async () => fixture(async ({ request, user, leadId, otherId }) => {
  Object.assign(user, { role: 'sales_manager', locked_site: '', all_sites: true });
  assert.equal((await request(`/leads/${otherId}`, null, 'GET', true, { 'X-Site': 'BYD Nunawading' })).status, 200);
  assert.equal((await request(`/leads/${leadId}`, null, 'GET', true, { 'X-Site': 'BYD Nunawading' })).status, 404);
  assert.equal((await request(`/leads/${leadId}`, null, 'GET', true, { 'X-Site': 'Kia Fairfield' })).status, 403);
}));
test('management report and CSV export use actual period records and model mix', async () => fixture(async ({ request, user, lead, leadId }) => {
  user.role = 'sales_manager';
  lead.tables.get('leads')[0].createdAt = new Date();
  await lead.collection('deals').insertOne({ dealer: 'BYD Fairfield', site: 'BYD Fairfield', leadId, contractSignedAt: new Date(), vehicle: { model: 'SEAL' } });
  const result = await request('/reports?period=today', null, 'GET');
  assert.equal(result.status, 200); assert.equal(result.body.data.dailyLeads, 1); assert.equal(result.body.data.soldUnits, 1);
  assert.equal(result.body.data.conversionRate, 100); assert.deepEqual(result.body.data.modelMix, [{ model: 'SEAL', units: 1 }]);
  const csv = await request('/reports.csv?period=today', null, 'GET');
  assert.equal(csv.status, 200); assert.match(csv.body, /"soldUnits","1"/); assert.match(csv.body, /"Model mix","SEAL","1"/);
}));
test('booking another-site customer, an invalid time, or an unauthenticated request never reaches Virtual Yard', async () => fixture(async ({ request, leadId, otherId, bookings }) => {
  assert.equal((await request('/appointments', { leadId: otherId, when: '2026-11-20T10:00:00Z' })).status, 404);
  assert.equal((await request('/appointments', { leadId, when: '2026-11-20T10:00:00' })).status, 400);
  assert.equal((await request('/appointments', { leadId, when: '2026-11-20T10:00:00Z' }, 'POST', false)).status, 401);
  assert.equal((await request('/appointments', { leadId, when: '2026-11-20T10:00:00Z', virtualyard: { locationId: '4850' } })).status, 400);
  assert.equal(bookings.length, 0);
}));
test('authorized CRM-style yard selection uses the upstream yard while retaining canonical customer identity', async () => fixture(async ({ request, user, leadId, bookings }) => {
  Object.assign(user, { role: 'sales_manager', locked_site: '', all_sites: true });
  const response = await request('/appointments', { leadId, when: '2026-11-20T10:00:00Z', virtualyard: { locationId: '4850' }, phone: 'Forged phone', site: 'Forged site' });
  assert.equal(response.status, 200); assert.equal(bookings[0].document.site, 'BYD Nunawading');
  assert.equal(bookings[0].document.leadId, leadId); assert.equal(bookings[0].document.phone, '+61400000000');
}));
test('contractors cannot create prospects and sales staff cannot change management settings or targets', async () => fixture(async ({ request, user }) => {
  assert.equal((await request('/settings', { settings: {} }, 'PUT')).status, 403);
  assert.equal((await request('/targets', { targetUnits: 20 })).status, 403);
  user.role = 'contractor'; assert.equal((await request('/leads', { name: 'Forbidden' })).status, 403);
}));
test('forged contract events never create deliveries when webhook authentication is missing or invalid', async () => fixture(async ({ request, panel }) => {
  const original = process.env.VIRTUALYARD_CONTRACT_WEBHOOK_SECRET;
  try { process.env.VIRTUALYARD_CONTRACT_WEBHOOK_SECRET = 'fixture-secret';
    const response = await request('/virtualyard/contract-signed', { eventId: 'fake', externalOrderId: 'fake', contractId: 'fake', signedAt: new Date().toISOString() });
    assert.equal(response.status, 401); assert.equal(panel.tables.get('clients'), undefined);
  } finally { if (original === undefined) delete process.env.VIRTUALYARD_CONTRACT_WEBHOOK_SECRET; else process.env.VIRTUALYARD_CONTRACT_WEBHOOK_SECRET = original; }
}));

test('journey previews validate unsaved manager settings and never enroll or send messages', async () => fixture(async ({ request, user, panel }) => {
  assert.equal((await request('/journey/preview', { settings: {} })).status, 403);
  user.role = 'sales_manager';
  const preview = await request('/journey/preview', { settings: {}, name: 'Alex', vehicle: 'BYD SEAL', deliveredAt: '2026-11-06T10:00:00+11:00' });
  assert.equal(preview.status, 200); assert.equal(preview.body.data.steps.length, 4);
  assert.equal(preview.body.data.steps[2].needsConfiguration, true); assert.equal(preview.body.data.steps[3].day, 21);
  assert.equal(panel.tables.get('floor_sms_requests'), undefined); assert.equal(panel.tables.get('floor_followups'), undefined);
  assert.equal((await request('/journey/preview', { deliveredAt: 'not-a-date' })).status, 400);
}));

test('vehicle readiness is honest and check history follows authorized customer ownership', async () => fixture(async ({ request, leadId, otherId, panel }) => {
  const result = await request('/vehicle/status', undefined, 'GET');
  assert.equal(result.status, 200); assert.equal(result.body.data.rego.liveValidated, false);
  await panel.collection('floor_vehicle_checks').insertOne({ _id: 'prior-staff-check', leadId, site: 'BYD Fairfield', owner_user_id: 'previous-staff', vin: 'LGXCE4C88P0123456' });
  assert.equal((await request(`/vehicle/checks?leadId=${leadId}`, undefined, 'GET')).body.data.length, 1);
  assert.equal((await request(`/vehicle/checks?leadId=${otherId}`, undefined, 'GET')).status, 404);
  const denied = await request('/vehicle/ppsr', { leadId: otherId, vin: 'LGXCE4C88P0123456', requestId: 'unauthorized-paid-check' });
  assert.equal(denied.status, 404); assert.equal(panel.tables.get('floor_vehicle_requests'), undefined);
}));

test('journey cancellation is scoped, audited and never changes an already submitted message', async () => fixture(async ({ request, user, panel }) => {
  user.role = 'sales_manager';
  await panel.collection('floor_followups').insertOne({ _id: 'pending', site: user.site, status: 'awaiting_approval' });
  await panel.collection('floor_followups').insertOne({ _id: 'submitted', site: user.site, status: 'sent' });
  await panel.collection('floor_followups').insertOne({ _id: 'other-site', site: 'BYD Nunawading', status: 'awaiting_approval' });
  assert.equal((await request('/followups/pending/cancel', {})).status, 400);
  assert.equal((await request('/followups/pending/cancel', { reason: 'Customer prefers a call.' })).status, 200);
  assert.equal(panel.tables.get('floor_followups')[0].cancelledBy, user.id);
  assert.equal((await request('/followups/submitted/cancel', { reason: 'Too late' })).status, 409);
  assert.equal((await request('/followups/other-site/cancel', { reason: 'Forbidden' })).status, 409);
}));
