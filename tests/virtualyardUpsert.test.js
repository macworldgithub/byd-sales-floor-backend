const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { buildPlan } = require('../scripts/virtualyard/upsert-both');
const snapshot = '2026-10-11T13:36:33.083Z';
const item = { leadId: 'external-1', customer: { fullName: 'Updated Customer', phone: '0400000000' }, vehicle: { raw: 'BYD ATTO 3', vehicleId: 'stock-1', model: 'ATTO 3', yard: 'BYD Caroline Springs' }, stage: 'in_contact', scrapedAt: snapshot };
const empty = () => ({ leads: [], appointments: [], inventories: [] });
const payload = (leads = [item], testDrives = []) => ({ scrapedAt: snapshot, leads, testDrives });
function apply(stored, plans) {
  return Object.fromEntries(Object.keys(stored).map(collection => {
    const result = stored[collection].map(doc => ({ ...doc }));
    for (const { updateOne: op } of plans[collection].operations) {
      if (op.update.$setOnInsert) result.push(op.update.$setOnInsert);
      else Object.assign(result.find(doc => String(doc._id) === String(op.filter._id)), op.update.$set);
    }
    return [collection, result];
  }));
}

test('new records have stable IDs and a second import has no operations', () => {
  const first = buildPlan(payload(), empty());
  assert.equal(first.leads.inserted, 1);
  assert.equal(first.inventories.inserted, 1);
  const second = buildPlan(payload(), apply(empty(), first));
  assert.equal(second.leads.operations.length, 0);
  assert.equal(second.inventories.operations.length, 0);
});

test('a CRM-created synced booking is updated by its external ID without a duplicate or relinking', () => {
  const stored = empty();
  const localId = new mongoose.Types.ObjectId();
  const localLead = new mongoose.Types.ObjectId();
  stored.appointments.push({ _id: localId, leadId: localLead, customer_id: 'CRM-1', notes: 'Staff notes',
    platform: 'manual', virtualyardSync: { state: 'synced', externalId: 'drive-1' },
    status: 'Completed', when: '2026-10-11T12:00:00.000Z', prospectName: 'Driver', updatedAt: new Date(snapshot) });
  const source = payload([], [{ _id: 'drive-1', customer: { fullName: 'Driver' }, location: 'BYD Fairfield', testDriveDate: '2026-10-11T12:00:00Z', status: 'Confirmed' }]);
  const plans = buildPlan(source, stored);
  assert.equal(plans.appointments.inserted, 0);
  assert.equal(plans.appointments.updated, 1);
  const op = plans.appointments.operations[0].updateOne;
  assert.equal(String(op.filter._id), String(localId));
  assert.equal(op.filter.platform, 'manual');
  assert.equal(op.update.$set.leadId, undefined);
  assert.equal(op.update.$set.customer_id, undefined);
  assert.equal(op.update.$set.notes, undefined);
  assert.equal(op.update.$set.virtualyardSync, undefined);
  assert.equal(op.update.$set.platform, undefined);
  assert.equal(op.update.$set.status, undefined);
  assert.equal(buildPlan(source, apply(stored, plans)).appointments.operations.length, 0);
});

test('updates preserve Mongo IDs, staff notes, consent and manual SMS control', () => {
  const stored = empty();
  stored.leads.push({ _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', leadId: item.leadId, virtualyardId: item.leadId, name: 'Old Name', notes: 'Staff note', do_not_contact: true, tag: 'Opted Out', status: 'opted out', stage: 'OPTED OUT', control: 'Human', updatedAt: new Date(snapshot) });
  const plan = buildPlan(payload(), stored);
  const patch = plan.leads.operations[0].updateOne;
  assert.equal(String(patch.filter._id), String(stored.leads[0]._id));
  assert.equal(patch.update.$set.name, 'Updated Customer');
  assert.equal(patch.update.$set.notes, undefined);
  assert.equal(patch.update.$set.do_not_contact, undefined);
  assert.equal(patch.update.$set.status, undefined);
  assert.equal(patch.update.$set.control, undefined);
});

test('duplicate existing identities are refreshed without inserting more duplicates', () => {
  const stored = empty();
  stored.leads = [1, 2].map(() => ({ _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', leadId: item.leadId, name: 'Old Name' }));
  const plan = buildPlan(payload(), stored);
  assert.equal(plan.leads.updated, 2);
  assert.equal(plan.leads.inserted, 0);
});

test('a legacy Virtual Yard alias is not assigned a canonical leadId already owned by another record', () => {
  const stored = empty();
  stored.leads = [
    { _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', virtualyardId: item.leadId, name: 'Legacy Record' },
    { _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', virtualyardId: item.leadId, leadId: item.leadId, name: 'Canonical Record' },
  ];
  const plan = buildPlan(payload(), stored);
  assert.equal(plan.leads.updated, 2);
  assert.equal(plan.leads.inserted, 0);
  assert.equal(plan.leads.operations[0].updateOne.update.$set.leadId, undefined);
  assert.equal(plan.leads.operations[1].updateOne.update.$set.leadId, undefined);
});

test('non-Virtual Yard records remain outside the update plan', () => {
  const stored = empty();
  const unrelated = { _id: new mongoose.Types.ObjectId(), platform: 'manual', leadId: item.leadId, name: 'Manual Record' };
  stored.leads.push(unrelated);
  const plan = buildPlan(payload(), stored);
  assert.equal(plan.leads.updated, 0);
  assert.equal(plan.leads.inserted, 1);
  assert.equal(stored.leads[0].name, 'Manual Record');
});

test('unmatched test drives are retained and booked manually without duplicate reruns', () => {
  const source = payload([], [{ _id: 'drive-1', leadId: 'missing-lead', customer: { fullName: 'Test Customer' }, location: 'BYD Melbourne City', testDriveDate: '2026-10-15T10:00:00Z', scrapedAt: snapshot }]);
  const plan = buildPlan(source, empty());
  assert.equal(plan.leads.inserted, 1);
  assert.equal(plan.appointments.inserted, 1);
  assert.equal(plan.appointments.operations[0].updateOne.update.$setOnInsert.bookedBy, 'Manual');
  const second = buildPlan(source, apply(empty(), plan));
  assert.equal(second.leads.operations.length, 0);
  assert.equal(second.appointments.operations.length, 0);
});

test('cancellation and lost statuses take precedence over order text, completion and bookings', () => {
  for (const status of ['ORDER-CANCELLED', 'ORDER-CANCELLATION-REQUEST', 'LOST', 'Lost']) {
    const source = payload([{ ...item, stage: 'complete', status }], [{ _id: 'drive-1', leadId: item.leadId, testDriveDate: '2026-11-01T10:00:00Z' }]);
    const lead = buildPlan(source, empty()).leads.operations[0].updateOne.update.$setOnInsert;
    assert.equal(lead.status, 'lost', status);
    assert.equal(lead.stage, 'LOST', status);
    assert.equal(lead.tag, 'Contact', status);
    assert.equal(lead.score, 20, status);
    assert.equal(lead.color, 'red', status);
  }
});

test('completed leads and historical drives do not become active bookings', () => {
  const drive = { _id: 'drive-1', leadId: item.leadId, testDriveDate: '2026-10-01T10:00:00Z' };
  const historical = buildPlan(payload([item], [drive]), empty()).leads.operations[0].updateOne.update.$setOnInsert;
  assert.equal(historical.stage, 'IN FOLLOW-UP');
  const completed = buildPlan(payload([{ ...item, stage: 'complete', status: 'FINALISE' }], [{ ...drive, testDriveDate: '2026-11-01T10:00:00Z' }]), empty()).leads.operations[0].updateOne.update.$setOnInsert;
  assert.equal(completed.stage, 'DELIVERED');
});

test('the latest drive is selected regardless of source order and dates are stored as ISO', () => {
  const newer = { _id: 'newer', leadId: item.leadId, testDriveDate: '2026-11-01T10:00:00Z' };
  const older = { _id: 'older', leadId: item.leadId, testDriveDate: '2026-10-01T10:00:00Z' };
  const first = buildPlan(payload([item], [newer, older]), empty());
  const lead = first.leads.operations[0].updateOne.update.$setOnInsert;
  assert.equal(lead.testDrive.testDriveDate.toISOString(), '2026-11-01T10:00:00.000Z');
  assert.equal(first.appointments.operations[0].updateOne.update.$setOnInsert.when, '2026-11-01T10:00:00.000Z');
  const second = buildPlan(payload([item], [older, newer]), apply(empty(), first));
  assert.equal(second.leads.operations.length, 0);
  assert.equal(second.appointments.operations.length, 0);
});

test('imported drives preserve staff appointment outcomes and missing dates retain stored dates', () => {
  const drive = { _id: 'drive-1', leadId: item.leadId, status: 'Confirmed', testDriveDate: null };
  const stored = empty();
  stored.appointments.push({ _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', appointmentId: drive._id, status: 'Completed', testDriveDate: new Date(snapshot), when: snapshot });
  stored.leads.push({ _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', leadId: item.leadId, testDrive: { status: 'Completed', testDriveDate: new Date(snapshot), location: 'BYD Melbourne City' } });
  const plan = buildPlan(payload([item], [drive]), stored);
  const updated = apply(stored, plan);
  assert.equal(updated.appointments[0].status, 'Completed');
  assert.equal(updated.leads[0].testDrive.status, 'Completed');
  assert.equal(updated.leads[0].testDrive.testDriveDate.toISOString(), snapshot);
});

test('test drive prospects preserve consent flags and appointments link to the synthetic prospect', () => {
  const source = payload([], [{ _id: 'drive-1', customer: { fullName: 'Test Customer' } }]);
  const stored = empty();
  stored.leads.push({ _id: new mongoose.Types.ObjectId(), platform: 'virtualyard', leadId: 'td-drive-1', doNotContact: true, status: 'opted out', stage: 'OPTED OUT', control: 'Assigned: Sales Consultant' });
  const updated = apply(stored, buildPlan(source, stored));
  assert.equal(updated.leads[0].status, 'opted out');
  assert.equal(updated.leads[0].control, 'Assigned: Sales Consultant');
  assert.equal(updated.appointments[0].leadId, 'td-drive-1');
});

test('an explicitly missing source file fails instead of importing a stale fallback', () => {
  const { findBothJson } = require('../scripts/virtualyard/upsert-both');
  assert.throws(() => findBothJson('missing-source-file.json'), /Source file does not exist/);
});

test('the importer defaults to the private backend snapshot', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { findBothJson } = require('../scripts/virtualyard/upsert-both');
  const expected = path.resolve(__dirname, '../.runtime/virtualyard/both.json');
  const original = fs.existsSync;
  try {
    fs.existsSync = file => file === expected;
    assert.equal(findBothJson(), expected);
  } finally { fs.existsSync = original; }
});

test('the importer requires the Lead Centre URI and never falls back to a generic URI', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../scripts/virtualyard/upsert-both');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-import-'));
  const file = path.join(directory, 'both.json');
  const previous = { lead: process.env.LEAD_CENTER_MONGO_URI, generic: process.env.MONGO_URI };
  try {
    fs.writeFileSync(file, JSON.stringify(payload()));
    delete process.env.LEAD_CENTER_MONGO_URI;
    process.env.MONGO_URI = 'mongodb://invalid.example/wrong-database';
    await assert.rejects(main([file, '--dry-run']), /LEAD_CENTER_MONGO_URI is required/);
    await assert.rejects(main([file]), /Provide --backup/);
  } finally {
    for (const [key, value] of [['LEAD_CENTER_MONGO_URI', previous.lead], ['MONGO_URI', previous.generic]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('display and numeric inventory prices stay in sync without changing stock availability', () => {
  const stored = empty();
  stored.inventories.push({ _id: new mongoose.Types.ObjectId(), identifier: 'stock-1', platform: 'virtualyard', price: '$60,000', priceData: { ui: 60000, currency: 'AUD', label: 'Drive Away' }, status: 'Sold' });
  const source = payload([{ ...item, vehicle: { ...item.vehicle, price: 55000 } }]);
  const updated = apply(stored, buildPlan(source, stored));
  assert.equal(updated.inventories[0].price, '$55,000');
  assert.equal(updated.inventories[0].priceData.ui, 55000);
  assert.equal(updated.inventories[0].priceData.label, 'Drive Away');
  assert.equal(updated.inventories[0].status, 'Sold');
});
