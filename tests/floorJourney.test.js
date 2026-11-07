const test = require('node:test');
const assert = require('node:assert/strict');
const journey = require('../src/services/floorJourney');
const p = require('../src/services/salesFloorPolicy');
const { SalesFloorOperations } = require('../src/services/salesFloorOperations');
const { FloorCommunications } = require('../src/services/floorCommunications');
const { database } = require('./helpers/floorMemory');
const { sha } = require('../src/services/salesFloorMobile');
const user = { id: 'manager-1', name: 'Manager', role: 'sales_manager', site: 'BYD Fairfield', locked_site: 'BYD Fairfield' };
const at = new Date('2026-09-15T10:00:00+10:00');
const client = { _id: 'client-1', name: 'Alex Customer', vehicle: 'BYD ATTO 3', site: user.site, crm_customer_id: 'customer-1', phone: '+61400000000', deliveredAt: at };
const config = () => p.settings({ smsSenderId: 'BYD-approved', journey: { steps: journey.STEPS.map(step => ({ ...step })), contact: 'Contact your BYD dealership.', modelVideos: [{ model: 'ATTO 3', urls: ['https://dealer.example.invalid/atto-3-guide'] }] } });
function fixture() {
  const service = new SalesFloorOperations(database({ leads: [{ _id: 'lead-1', dealer: user.site, customerId: 'customer-1', phone: client.phone }] }), database({ clients: [{ ...client }] }));
  service.config = async () => config();
  return { service, queue: service.panel.collection('floor_followups') };
}
test('the scope defaults produce congratulations, welcome, held videos and day-21 satisfaction', () => {
  const rows = journey.preview(p.DEFAULTS, client, at);
  assert.deepEqual(rows.map(row => row.day), [0, 1, 3, 21]);
  assert.equal(rows[2].needsConfiguration, true); assert.equal(rows[3].needsConfiguration, false);
  assert.match(rows[0].body, /Congratulations Alex.*BYD ATTO 3/);
  assert.match(rows[3].body, /Contact your BYD team/);
  assert.equal(Number(rows[3].dueAt) - Number(at), 21 * 86400000);
});
test('model video selection, template variables and contact details render without sending', () => {
  const settings = config(), rows = journey.preview(settings, client, at);
  assert(rows.every(row => !row.needsConfiguration)); assert.match(rows[2].body, /atto-3-guide/);
  assert.equal(journey.journeySteps(settings, { ...client, vehicle: 'BYD SEAL' })[2].needsConfiguration, true);
  settings.journey.steps[1].template = 'Welcome {firstName} to {site}: {vehicle}.';
  assert.equal(journey.preview(settings, client, at)[1].body, 'Welcome Alex to BYD Fairfield: BYD ATTO 3.');
});
test('invalid template variables, schedules and non-HTTPS content fail validation', () => {
  for (const mutate of [c => { c.steps[0].template = 'Hello {price}'; }, c => { c.steps[3].day = 22; }, c => { c.steps[1].day = -1; }, c => { c.steps[2].template = 'No links'; }, c => { c.steps[1].template = '{firstName'; }, c => { c.modelVideos[0].urls = ['http://unsafe.invalid']; }]) {
    const input = config().journey; mutate(input); assert.throws(() => journey.validateJourney(input));
  }
  assert.throws(() => p.settings({ surveyUrl: 'https://' }));
  assert.throws(() => p.settings({ videoUrls: ['https://user:password@example.invalid'] }));
});
test('pending journey content refreshes per site while sent and cancelled messages remain unchanged', async () => {
  const f = fixture(); await journey.enroll(f.service, client, p.DEFAULTS); await journey.enroll(f.service, client, p.DEFAULTS);
  assert.equal(f.queue.rows.length, 4);
  f.queue.rows[0].status = 'sent'; const original = f.queue.rows[0].body;
  f.queue.rows[1].status = 'cancelled';
  await f.queue.insertOne({ _id: 'other-site', site: 'BYD Nunawading', clientId: client._id, key: 'feature_videos', status: 'needs_configuration', body: 'Other site content' });
  const settings = config(); settings.journey.steps[0].template = 'Changed congratulations {name}';
  await journey.refreshPending(f.service, user.site, settings, user);
  assert.equal(f.queue.rows[0].body, original); assert.equal(f.queue.rows[1].status, 'cancelled');
  assert.equal(f.queue.rows[2].status, 'awaiting_approval'); assert.match(f.queue.rows[2].body, /atto-3-guide/);
  assert.equal(f.queue.rows[4].body, 'Other site content');
});
test('two managers approving concurrently produce one journey submission and a replay returns it', async () => {
  const f = fixture(); await journey.enroll(f.service, client, config()); let sends = 0;
  f.service.sendMessage = async (leadId, input, account, journeyId) => { assert(journeyId); sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { messageId: 'message-1', status: 'success' }; };
  const draft = f.queue.rows[0];
  const results = await Promise.allSettled([f.service.approveFollowup(draft._id, user), f.service.approveFollowup(draft._id, { ...user, id: 'manager-2' })]);
  assert.equal(sends, 1); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  await f.service.approveFollowup(draft._id, user); assert.equal(sends, 1);
});
test('changed configuration and opted-out recipients block journey submission', async () => {
  const f = fixture(); await journey.enroll(f.service, client, config()); let sends = 0;
  f.service.sendMessage = async () => { sends++; };
  const changed = config(); changed.journey.steps[0].template = 'Updated message for {firstName}'; f.service.config = async () => changed;
  await assert.rejects(f.service.approveFollowup(f.queue.rows[0]._id, user), /configuration has changed/);
  f.service.panel.tables.get('clients')[0].consent_sms = false;
  await assert.rejects(f.service.approveFollowup(f.queue.rows[0]._id, user), /opted out/); assert.equal(sends, 0);
});
test('a provider-confirmed submission repairs an interrupted journey update without another send', async () => {
  const f = fixture(); await journey.enroll(f.service, client, config());
  const draft = f.queue.rows[0]; draft.status = 'sending';
  await f.service.panel.collection('floor_sms_requests').insertOne({ _id: sha(`journey:${draft._id}:journey-${draft._id}`), state: 'sent', result: { messageId: 'message-1', status: 'success' }, createdAt: new Date() });
  const communications = new FloorCommunications(f.service, { getConfig: async () => ({ username: 'fixture', password: 'fixture' }), lookupMessage: async () => ({ results: [{ message_id: 'message-1', status: 'delivered' }] }) });
  const result = await communications.followupReceipt(draft._id, user);
  assert.equal(result.deliveryStatus, 'delivered'); assert.equal(draft.status, 'sent'); assert(result.verifiedDeliveredAt);
});
test('a changed recipient must be refreshed and reviewed before a journey message can send', async () => {
  const f = fixture(); await journey.enroll(f.service, client, config()); let sends = 0;
  f.service.lead.tables.get('leads')[0].phone = '+61400000001';
  f.service.sendMessage = async () => { sends++; return { messageId: 'message-2', status: 'success' }; };
  await assert.rejects(f.service.approveFollowup(f.queue.rows[0]._id, user), /review the updated recipient/);
  assert.equal(sends, 0); assert.equal(f.queue.rows[0].phone, '+61400000001');
  await f.service.approveFollowup(f.queue.rows[0]._id, user); assert.equal(sends, 1);
});
test('approval of an old message preview never sends newly configured content', async () => {
  const f = fixture(); await journey.enroll(f.service, client, config()); let sends = 0;
  const token = journey.reviewToken(f.queue.rows[0]);
  f.queue.rows[0].body = 'Changed after staff loaded their screen';
  f.service.sendMessage = async () => { sends++; };
  await assert.rejects(f.service.approveFollowup(f.queue.rows[0]._id, user, token), /message or recipient changed/);
  assert.equal(sends, 0);
});
