const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { database } = require('./helpers/floorMemory');
const { FloorPush } = require('../src/services/floorPush');
const { FloorCommunications, journeySteps } = require('../src/services/floorCommunications');
const { SalesFloorOperations } = require('../src/services/salesFloorOperations');
const p = require('../src/services/salesFloorPolicy');
const user = { id: 'staff-1', name: 'Staff', role: 'sales_manager', site: 'BYD Fairfield', locked_site: 'BYD Fairfield' };
const token = 'ExpoPushToken[fixture-device]', projectId = '11111111-1111-4111-8111-111111111111';
function pushFixture(sendResult = { data: { status: 'ok', id: 'ticket-1' } }, receipts = { 'ticket-1': { status: 'ok' } }) {
  const panel = database({ users: [{ _id: user.id, ...user, active: true, platform_access: ['sales_floor'] }] }), calls = [];
  const service = new FloorPush(panel, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => url.endsWith('getReceipts') ? { data: receipts } : sendResult }; });
  return { panel, service, calls, register: () => service.register({ token, projectId, platform: 'android' }, user, user.site), input: { token, requestId: 'stable-push-test' } };
}
test('push tickets, provider receipts and app acknowledgments are distinct; replay never resends', async () => {
  const f = pushFixture(); await f.register();
  const submitted = await f.service.test(f.input, user, user.site); assert.equal(submitted.state, 'submitted');
  const accepted = await f.service.status(submitted.notificationId, user); assert.equal(accepted.state, 'provider_accepted'); assert.equal(accepted.deliveries[0].receivedAt, null);
  const received = await f.service.acknowledge({ token, notificationId: submitted.notificationId, event: 'opened' }, user);
  assert.equal(received.state, 'received'); assert(received.deliveries[0].openedAt);
  await f.service.test(f.input, user, user.site);
  assert.equal(f.calls.filter(row => row.url.endsWith('/send')).length, 1);
});
test('push receipt errors disable an unregistered token and never claim delivery', async () => {
  const f = pushFixture(undefined, { 'ticket-1': { status: 'error', details: { error: 'DeviceNotRegistered' } } }); await f.register();
  const result = await f.service.test(f.input, user, user.site);
  assert.equal((await f.service.status(result.notificationId, user)).state, 'failed');
  assert.equal(f.panel.tables.get('floor_push_tokens')[0].enabled, false);
});
test('an absent push receipt stays unconfirmed and another user cannot send or acknowledge a device test', async () => {
  const f = pushFixture(undefined, {}); await f.register(); const result = await f.service.test(f.input, user, user.site);
  assert.equal((await f.service.status(result.notificationId, user)).state, 'submitted');
  await assert.rejects(f.service.test(f.input, { ...user, id: 'other-user' }, user.site), /Enable push/);
  await assert.rejects(f.service.acknowledge({ token, notificationId: result.notificationId, event: 'received' }, { ...user, id: 'other-user' }), /registration not found/);
});
test('uncertain push submission is durable and cannot be blindly sent again', async () => {
  const f = pushFixture(); await f.register(); let calls = 0;
  f.service.fetch = async () => { calls++; throw Error('Network interrupted'); };
  assert.equal((await f.service.test(f.input, user, user.site)).state, 'unknown');
  assert.equal((await f.service.test(f.input, user, user.site)).state, 'unknown'); assert.equal(calls, 1);
});
test('new device registration does not replay old customer alerts and revoked accounts receive no push', async () => {
  const f = pushFixture(); await f.register();
  const notification = { _id: 'old', owner_user_id: user.id, site: user.site, createdAt: new Date(Date.now() - 60000), title: 'Old alert', body: 'Old' };
  await f.panel.collection('floor_notifications').insertOne(notification); await f.service.dispatch(notification); assert.equal(f.calls.length, 0);
  f.panel.tables.get('users')[0].active = false;
  await f.service.test(f.input, user, user.site); assert.equal(f.calls.length, 0);
});
function smsFixture() {
  const panel = database(), sends = [], service = new SalesFloorOperations(database(), panel);
  service.config = async () => ({ ...p.DEFAULTS, smsSenderId: 'BYD-verified' });
  const gateway = { getConfig: async () => ({ username: 'fixture', password: 'fixture', simulationMode: false }),
    normalizeAustralianPhone: value => String(value).startsWith('+') ? value : '+61' + String(value).slice(1),
    getApprovedSenders: async () => [{ sender: 'BYD-verified' }],
    sendSms: async input => { sends.push(input); return { messageId: 'sms-1', status: 'success', simulated: false }; },
    lookupMessage: async id => ({ results: [{ message_id: id, status: 'delivered' }] }) };
  return { panel, sends, gateway, service, communications: new FloorCommunications(service, gateway), input: { phone: '0400000000', requestId: 'stable-sms-test' } };
}
test('a live journey test verifies the site sender, uses one stable send and checks the actual provider ID', async () => {
  const f = smsFixture(); const result = await f.communications.sendTest(f.input, user, user.site);
  assert.equal(result.state, 'submitted'); assert.equal(result.verifiedDeliveredAt, null);
  assert.equal(f.sends[0].useSiteSender, true); assert.match(f.sends[0].message, /^\[Sales Floor TEST\] Congratulations/);
  await f.communications.sendTest(f.input, user, user.site); assert.equal(f.sends.length, 1);
  const verified = await f.communications.testReceipt(result.id, user);
  assert.equal(verified.deliveryStatus, 'delivered'); assert(verified.verifiedDeliveredAt);
  await assert.rejects(f.communications.sendTest({ ...f.input, phone: '0400000001' }, user, user.site), /already been used/);
});
test('an unapproved sender, simulation or mismatched provider message never yields verified delivery', async () => {
  const f = smsFixture(); f.gateway.getApprovedSenders = async () => [];
  await assert.rejects(f.communications.sendTest(f.input, user, user.site), /approved/); assert.equal(f.sends.length, 0);
  f.gateway.getConfig = async () => ({ simulationMode: true });
  await assert.rejects(f.communications.receipt('sms-1'), /Live SMS/);
  f.gateway.getConfig = async () => ({ username: 'fixture', password: 'fixture' });
  f.gateway.lookupMessage = async () => ({ results: [{ message_id: 'another-message', status: 'delivered' }] });
  await assert.rejects(f.communications.receipt('sms-1'), /not returned this message/);
});
test('uncertain SMS submission is reported as unknown and cannot send a duplicate', async () => {
  const f = smsFixture(); let sends = 0; f.gateway.sendSms = async () => { sends++; throw Error('Connection lost'); };
  const result = await f.communications.sendTest(f.input, user, user.site); assert.equal(result.state, 'unknown');
  await assert.rejects(f.communications.sendTest(f.input, user, user.site), /may already/); assert.equal(sends, 1);
});
test('post-delivery approval checks due time and client opt-out before sending', async () => {
  const f = smsFixture(), client = { _id: 'client-1', site: user.site, crm_customer_id: 'customer-1', opted_out: true };
  await f.panel.collection('clients').insertOne(client);
  await f.panel.collection('floor_followups').insertOne({ _id: 'draft-1', site: user.site, clientId: 'client-1', dueAt: new Date(), status: 'awaiting_approval', body: 'Welcome', phone: '+61400000000' });
  await assert.rejects(f.service.approveFollowup('draft-1', user), /opted out/);
  client.opted_out = false; f.panel.tables.get('floor_followups')[0].dueAt = new Date(Date.now() + 86400000);
  await assert.rejects(f.service.approveFollowup('draft-1', user), /not ready/); assert.equal(f.sends.length, 0);
  assert.equal(journeySteps(p.DEFAULTS, { name: 'Test', vehicle: 'BYD' }).length, 4);
  f.panel.tables.get('clients')[0].opted_out = false; f.panel.tables.get('floor_followups')[0].dueAt = new Date(Date.now() - 1000);
  await f.service.lead.collection('leads').insertOne({ _id: 'lead-1', dealer: user.site, customerId: 'customer-1', phone: '+61400000000' });
  f.service.sendMessage = async () => { f.sends.push({ approved: true }); return { messageId: 'sms-1', status: 'success' }; };
  assert.equal((await f.service.approveFollowup('draft-1', user)).deliveryStatus, 'success');
  await f.service.approveFollowup('draft-1', user); assert.equal(f.sends.length, 1);
  assert.equal((await f.communications.followupReceipt('draft-1', user)).deliveryStatus, 'delivered');
});
test('the shared live SMS gateway honors an explicitly verified site sender over a deployment default', async () => {
  const file = path.resolve(__dirname, '../src/services/mobileMessage.js'), localRequire = createRequire(file), module = { exports: {} }, sent = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, Buffer, URL, AbortSignal, setTimeout, process: { env: { MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'fixture', MOBILEMESSAGE_SENDER_ID: 'GLOBAL' } },
    fetch: async (url, options) => { const body = JSON.parse(options.body); sent.push(body); return { ok: true, status: 200, json: async () => ({ results: [{ status: 'success', message_id: 'sms-1', sender: body.messages[0].sender }] }) }; },
    require: name => name === '../models/lead/Setting' ? {} : localRequire(name) });
  await module.exports.sendSms({ to: '0400000000', message: 'Manual test', sender: 'BYD-verified', useSiteSender: true, requestedBy: user.id });
  assert.equal(sent[0].messages[0].sender, 'BYD-verified');
});
