const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongoose').mongo;
const p = require('../src/services/salesFloorPolicy');
const { SalesFloorOperations } = require('../src/services/salesFloorOperations');
const { inspect } = require('../src/services/floorMedia');
const { database, matches } = require('./helpers/floorMemory');
const manager = { id: 'manager', name: 'Manager', email: 'manager@example.invalid', role: 'sales_manager', site: 'BYD Fairfield', locked_site: 'BYD Fairfield', allowed_sites: ['BYD Fairfield'] };
const consultant = { ...manager, id: 'consultant', name: 'Consultant', email: 'consultant@example.invalid', role: 'sales_consultant' };
const details = { name: 'Test Customer', phone: '0400000000', email: 'customer@example.invalid', model: 'BYD SEAL', businessName: 'Fleet Pty Ltd', companyContacts: [{ name: 'Fleet Contact', email: 'fleet@example.invalid', phone: '0400000001' }], notes: 'Initial note' };

test('salespeople are scoped to their own site and ownership; a manager sees the site team', () => {
  const mine = { dealer: 'Fairfield', assignedTo: consultant.email };
  assert(matches(mine, p.scope(consultant))); assert(!matches({ ...mine, dealer: 'BYD Nunawading' }, p.scope(consultant)));
  assert(!matches({ dealer: 'BYD Fairfield', assignedTo: 'other@example.invalid' }, p.scope(consultant)));
  assert(matches({ dealer: 'BYD Fairfield', assignedTo: 'other@example.invalid' }, p.scope(manager)));
  assert(!matches({ dealer: 'BYD Nunawading', assignedTo: consultant.email }, p.scope(consultant, { site: 'BYD Nunawading' })));
  assert.throws(() => p.scope({ ...consultant, locked_site: '' }, { site: 'BYD Nunawading' }), /Site access|denied/);
});
test('customer mandatory fields, age boundaries and stock status have no fabricated values', () => {
  assert.equal(p.customer(details).phone, '+61400000000'); assert.throws(() => p.customer({ ...details, phone: '' })); assert.throws(() => p.customer({ ...details, email: '' }));
  for (const [days, expected] of [[0, '0-30'], [30, '0-30'], [31, '31-60'], [60, '31-60'], [61, '61-89'], [89, '61-89'], [90, '90+'], [null, 'Unknown']]) assert.equal(p.ageBucket(days), expected);
  assert.equal(p.stockStatus('Deal Pending'), 'Deal Pending'); assert.equal(p.stockStatus('Held'), 'Deal Pending'); assert.equal(p.stockStatus('unrecognised'), 'Unknown');
});
test('same-site duplicate mobile merges notes and retains business links; another site remains separate', async () => {
  const lead = database(), panel = database(), service = new SalesFloorOperations(lead, panel);
  const first = await service.saveLead(details, consultant);
  const second = await service.saveLead({ ...details, phone: '+61 400 000 000', notes: 'Second note' }, consultant);
  assert.equal(String(first._id), String(second._id)); assert.equal(second.merged, true); assert.equal(lead.tables.get('leads').length, 1);
  assert.match(second.notes, /Initial note\nSecond note/); assert.equal(panel.tables.get('customers')[0].businessId, second.businessId);
  assert.equal(panel.tables.get('businesses')[0].contacts.length, 1);
  await service.saveLead(details, { ...consultant, site: 'BYD Nunawading', locked_site: 'BYD Nunawading', allowed_sites: ['BYD Nunawading'] });
  assert.equal(lead.tables.get('leads').length, 2);
});
test('a salesperson cannot merge a different consultant customer or overwrite a verified PPSR status', async () => {
  const lead = database(), panel = database(), service = new SalesFloorOperations(lead, panel);
  const saved = await service.saveLead(details, consultant);
  await assert.rejects(service.saveLead(details, { ...consultant, id: 'another', email: 'another@example.invalid', name: 'Another' }), /another consultant/);
  assert.equal((await service.saveLead({ ...details, ppsrStatus: 'Clear', tradeInVin: 'FAKE' }, consultant)).ppsrStatus, undefined);
  assert.equal((await lead.collection('leads').findOne({ _id: saved._id })).tradeInVin, undefined);
});
test('stock sale claim is atomic and group view shows only available vehicles without cost leakage', async () => {
  const lead = database(), panel = database(), service = new SalesFloorOperations(lead, panel);
  const customer = await service.saveLead(details, consultant), stock = { _id: new ObjectId(), stock: 'REAL-1', model: 'BYD', status: 'Available', location: 'BYD Fairfield', costPrice: 42000, priceData: { ui: 50000 }, daysInStock: 75 };
  await lead.collection('inventories').insertOne(stock);
  const inventory = await service.inventory({}, consultant); assert.equal(inventory.data[0].costPrice, null); assert.equal(inventory.data[0].ageingBucket, '61-89');
  const attempts = await Promise.allSettled(['request-one', 'request-two'].map(bookingRequestId => service.saveDeal({ bookingRequestId, leadId: String(customer._id), inventoryId: String(stock._id), salePrice: 50000 }, consultant)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(lead.tables.get('deals').length, 1);
  assert.equal(lead.tables.get('inventories')[0].status, 'Deal Pending'); assert.equal((await service.inventory({ group: 'true' }, manager)).data.length, 0);
  const saved = attempts.find(result => result.status === 'fulfilled').value; assert.equal(saved.businessName, details.businessName); assert.equal(saved.customerId, customer.customerId);
  await assert.rejects(service.pushDeal(saved._id, consultant), /not configured/); assert.equal(panel.tables.get('clients'), undefined);
});
test('signed contract events are idempotent and create delivery only for a known external order', async () => {
  const deal = { _id: new ObjectId(), dealId: 'DEAL-1', buyerName: details.name, buyerPhone: '+61400000000', vehicle: { model: 'SEAL', vin: 'LVVDB21B8RD000001' }, site: 'BYD Fairfield', consultantName: manager.name, consultantId: manager.id, virtualYard: { virtualYardOrderId: 'VY-1' } };
  const lead = database({ deals: [deal] }), panel = database(), service = new SalesFloorOperations(lead, panel);
  const event = { eventId: 'signed-1', externalOrderId: 'VY-1', contractId: 'CONTRACT-1', signedAt: new Date().toISOString() };
  await service.signedContract(event); await service.signedContract(event);
  assert.equal(panel.tables.get('clients').length, 1); assert.equal(lead.tables.get('deals')[0].virtualYard.status, 'Contract Signed');
  await assert.rejects(service.signedContract({ ...event, externalOrderId: 'unknown' }), /No registered deal/);
});
test('handover refuses incomplete work and enrolls four approval steps exactly once', async () => {
  const client = { _id: new ObjectId(), site: 'BYD Fairfield', site_location: 'BYD Fairfield', name: details.name, vehicle: 'BYD SEAL', phone: '+61400000000', pdiComplete: false, contractSignedAt: new Date(), accessories: [{ name: 'Mats', status: 'Pending Order' }] };
  const panel = database({ clients: [client] }), service = new SalesFloorOperations(database(), panel);
  await assert.rejects(service.handover(String(client._id), manager), /PDI/);
  client.pdiComplete = true; client.accessories[0] = { id: 'accessory-1', name: 'Mats', status: 'Fitted', proofId: 'uploaded-photo' };
  await assert.rejects(service.handover(String(client._id), manager), /own uploaded completion photo/);
  await panel.collection('floor_media').insertOne({ _id: 'uploaded-photo', kind: 'image', clientId: String(client._id), accessoryId: 'accessory-1' });
  await service.handover(String(client._id), manager); await service.handover(String(client._id), manager);
  const steps = panel.tables.get('floor_followups'); assert.equal(steps.length, 4);
  assert.equal(steps.find(row => row.key === 'feature_videos').status, 'needs_configuration');
  assert.equal(steps.find(row => row.key === 'satisfaction_21_day').dueAt - client.deliveredAt, 21 * 86400000);
  assert(steps.every(row => row.status !== 'sent'));
});
test('all requested alert phrases classify and AI price/trade statements are blocked', () => {
  for (const text of ['Ready to buy', 'Can I come in today', 'book an appointment', 'finance enquiries', 'Pricing requests', 'quote request', 'Trade-in enquiry', 'Repayment questions', 'Comparing brands', 'Competitor offers']) assert(p.classify(text).includes('high_buyer'), text);
  for (const text of ['Too expensive', 'Outside my budget', 'Looking for a better deal', 'Can you do any better?']) assert(p.classify(text).includes('price_objection'), text);
  for (const text of ['Need to think about it', 'Not right now', "I'm still looking", 'Leave it with me', "I'll get back to you"]) assert(p.classify(text).includes('high_risk'), text);
  for (const text of ['The price is $49,990', 'Your trade-in valuation is available', 'Repayments start at 99 dollars']) assert.throws(() => p.assertAiReply(text));
  assert.equal(p.assertAiReply('The vehicle has a 60 kWh battery.'), 'The vehicle has a 60 kWh battery.');
});
test('empty summaries show zero activity and unknown targets/conversion, and notifications deduplicate', async () => {
  const service = new SalesFloorOperations(database(), database());
  const summary = await service.summary({ period: 'today' }, consultant);
  assert.equal(summary.activeLeads, 0); assert.equal(summary.dealsCompleted, 0); assert.equal(summary.monthlyTarget, null); assert.equal(summary.conversionRate, null);
  const lead = { _id: 'lead-1', dealer: 'BYD Fairfield', assignedTo: consultant.email, owner_user_id: consultant.id, name: details.name };
  await service.ingestMessage(lead, 'Ready to buy', 'message-1'); await service.ingestMessage(lead, 'Ready to buy', 'message-1');
  assert.equal(service.panel.tables.get('floor_notifications').length, 1);
});
test('server reads the video container duration instead of trusting a client duration', () => {
  function movie(seconds) {
    const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16); ftyp.write('ftyp', 4); ftyp.write('isom', 8);
    const mvhd = Buffer.alloc(32); mvhd.writeUInt32BE(32); mvhd.write('mvhd', 4); mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(seconds * 1000, 24);
    const moov = Buffer.alloc(8); moov.writeUInt32BE(40); moov.write('moov', 4);
    return Buffer.concat([ftyp, moov, mvhd]);
  }
  assert.equal(inspect(movie(180), 'video/mp4').durationSeconds, 180); assert.throws(() => inspect(movie(181), 'video/mp4'), /three minutes/);
  assert.throws(() => inspect(Buffer.from('not a real video file'), 'video/mp4'), /Unsupported/);
});

test('customer edits persist mobile and company contacts and refuse same-site identity collisions', async () => {
  const service = new SalesFloorOperations(database(), database());
  const first = await service.saveLead(details, consultant);
  const second = await service.saveLead({ ...details, name: 'Second', phone: '0400000002', email: 'second@example.invalid' }, consultant);
  const updated = await service.updateLead(first._id, { phone: '0400000003', businessName: 'New Fleet Pty Ltd', companyContacts: details.companyContacts, vehicle: 'SEALION 7' }, consultant);
  const customer = await service.panel.collection('customers').findOne({ customer_id: first.customerId });
  assert.equal(updated.phone, '+61400000003'); assert.equal(customer.phone, updated.phone); assert.equal(customer.company_name, 'New Fleet Pty Ltd'); assert.equal(customer.vehicle, 'SEALION 7');
  await assert.rejects(service.updateLead(first._id, { phone: second.phone }, consultant), /mobile belongs/);
  await assert.rejects(service.updateLead(first._id, { email: second.email }, consultant), /email belongs/);
  assert.equal((await service.record('leads', first._id, consultant)).phone, '+61400000003');
});

test('manager duplicate merge moves related records and preserves a source audit snapshot', async () => {
  const target = { _id: new ObjectId(), name: 'Target', phone: '+61400000000', dealer: manager.site, notes: 'First', customerId: 'target-customer' };
  const source = { _id: new ObjectId(), name: 'Source', phone: '0400000000', dealer: manager.site, notes: 'Second', customerId: 'source-customer' };
  const lead = database({ leads: [target, source], appointments: [{ _id: new ObjectId(), leadId: String(source._id) }] });
  const panel = database({ floor_media: [{ _id: 'media-1', leadId: String(source._id) }], floor_licences: [{ _id: 'licence-1', leadId: String(source._id) }], clients: [{ _id: 'delivery-1', crm_customer_id: source.customerId }] });
  const service = new SalesFloorOperations(lead, panel);
  const result = await service.mergeLeads(target._id, source._id, manager);
  assert.equal(result.notes, 'First\nSecond'); assert.equal(source.isArchived, true); assert.equal(lead.tables.get('appointments')[0].leadId, String(target._id));
  assert.equal(service.panel.tables.get('floor_merges')[0].state, 'complete');
  assert.equal(panel.tables.get('floor_media')[0].leadId, String(target._id)); assert.equal(panel.tables.get('floor_licences')[0].leadId, String(target._id));
  assert.equal(panel.tables.get('clients')[0].crm_customer_id, target.customerId);
  await panel.collection('timelineevents').insertOne({ _id: 'other-site-event', customer_id: target.customerId, site: 'BYD Nunawading', body: 'Other site' });
  assert(!(await service.timeline(target._id, manager)).some(row => row._id === 'other-site-event'));
  await service.mergeLeads(target._id, source._id, manager);
  assert.equal(target.notes, 'First\nSecond');
  await assert.rejects(service.mergeLeads(target._id, source._id, consultant), /Only managers/);
});

test('AI drafts can select only approved facts and never add model-generated statements', () => {
  const facts = p.approvedFacts([{ sourceUrl: 'https://example.invalid/manual', content: 'Battery capacity is 60 kWh. The price is $49,990. Opening hours are 9am to 5pm.' }]);
  assert.equal(facts.length, 2); assert(!facts.some(fact => fact.text.includes('$')));
  assert.equal(p.renderFacts([facts[0].id], facts).text, 'Battery capacity is 60 kWh.');
  assert.throws(() => p.renderFacts(['unapproved-fact'], facts), /valid approved/);
  assert.throws(() => p.settings({ salesSeeCost: 'false' }), /Pricing permissions/);
  assert.throws(() => p.settings({ followupAmberHours: '24' }), /must be numbers/);
});

test('SMS retry repairs an interrupted local projection without another provider send or duplicate history', async () => {
  const sms = require('../src/services/mobileMessage'), original = { getConfig: sms.getConfig, sendSms: sms.sendSms, getApprovedSenders: sms.getApprovedSenders };
  const service = new SalesFloorOperations(database(), database());
  const lead = await service.saveLead(details, consultant);
  service.config = async () => ({ ...p.DEFAULTS, smsSenderId: 'verified-site-sender' });
  let sends = 0;
  sms.getConfig = async () => ({ username: 'fixture', password: 'fixture', simulationMode: false });
  sms.getApprovedSenders = async () => [{ sender: 'verified-site-sender' }];
  sms.sendSms = async () => { sends++; return { messageId: 'provider-1', status: 'sent' }; };
  const project = service.projectMessage.bind(service); let interrupted = true;
  service.projectMessage = async (...args) => { await project(...args); if (interrupted) { interrupted = false; throw Error('Local write interrupted'); } };
  const input = { body: 'Your vehicle is ready.', requestId: 'fixture-send-request' };
  try {
    await assert.rejects(service.sendMessage(lead._id, input, consultant), /interrupted/);
    assert.equal((await service.sendMessage(lead._id, input, consultant)).messageId, 'provider-1');
    assert.equal(sends, 1); assert.equal(service.panel.tables.get('messages').length, 1);
    const conversation = service.lead.tables.get('conversations')[0];
    assert.equal(conversation.messages.length, 1); assert.equal(conversation.msgCount, 1);
    assert.equal(service.panel.tables.get('timelineevents').filter(row => row.type === 'SMS sent').length, 1);
    await assert.rejects(service.sendMessage(lead._id, { ...input, body: 'Different content' }, consultant), /already been used/);
  } finally { Object.assign(sms, original); }
});

test('alert worker ignores other-brand leads and delivery records', async () => {
  const lead = database({ leads: [{ _id: 'kia-lead', dealer: 'Kia Fairfield', name: 'Other brand', createdAt: new Date('2020-01-01') }] });
  const panel = database({ clients: [{ _id: 'kia-delivery', site: 'Kia Fairfield', name: 'Other brand', delivery_date: new Date() }] });
  await require('../src/services/floorWorker').tick(lead, panel, () => { throw Error('Unexpected push'); });
  assert.equal(panel.tables.get('floor_notifications').length, 0);
});
