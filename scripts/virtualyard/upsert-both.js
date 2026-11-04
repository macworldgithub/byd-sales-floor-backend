const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const { BSON } = mongoose.mongo;
const helpers = require('./mappings');
const models = { leads: require('./models/Lead'), appointments: require('./models/Appointment'), inventories: require('./models/Inventory') };

// Import validation is independent of the API's dual-database connections.
// Only this CLI connects, and it connects exclusively to the Lead Centre database.
function findBothJson(customPath) {
  const file = path.resolve(customPath || path.join(__dirname, '../../.runtime/virtualyard/both.json'));
  if (!fs.existsSync(file)) throw new Error(`Source file does not exist: ${file}`);
  return file;
}

const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null;
const sourceId = value => value == null ? '' : String(value).trim();
const name = customer => customer?.fullName || [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim();
const label = vehicle => vehicle?.raw || [vehicle?.year, vehicle?.colour, vehicle?.make, vehicle?.model].filter(Boolean).join(' ').trim();
const price = vehicle => vehicle?.price ? '$' + Number(vehicle.price).toLocaleString('en-AU') : vehicle?.priceRaw || '';
const emit = data => console.log(JSON.stringify(data));
const optedOut = existing => !!(existing?.do_not_contact || existing?.doNotContact || existing?.opted_out || existing?.status === 'opted out' || existing?.tag === 'Opted Out');
const driveDetails = (drive, existing) => ({
  ...(existing?.testDrive || {}),
  testDriveDate: date(drive.testDriveDate) || existing?.testDrive?.testDriveDate || null,
  location: drive.location || existing?.testDrive?.location || '',
  status: ['Completed', 'Cancelled', 'No Show'].includes(existing?.testDrive?.status) ? existing.testDrive.status : drive.status || 'Confirmed',
  confirmed: drive.status !== 'Cancelled',
});

function changedFields(existing, desired) {
  const patch = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (existing && (value === '' || value === null) && existing[key]) continue;
    if (!isDeepStrictEqual(existing?.[key], value)) patch[key] = value;
  }
  return patch;
}

function buildPlan(payload, stored) {
  if (!Array.isArray(payload.leads) || !Array.isArray(payload.testDrives)) throw new Error('Expected leads and testDrives arrays');
  const snapshot = date(payload.scrapedAt);
  if (!snapshot) throw new Error('Source snapshot needs a valid scrapedAt date');
  const plans = Object.fromEntries(Object.keys(models).map(collection => [collection, { inserted: 0, updated: 0, unchanged: 0, operations: [] }]));
  const sourceLeads = new Map();
  const drives = new Map();
  const vehicles = new Map();
  const keyFields = { leads: ['leadId', 'virtualyardId'], appointments: ['appointmentId'], inventories: ['identifier'] };
  const indexes = {};
  for (const collection of Object.keys(models)) {
    indexes[collection] = new Map();
    for (const document of stored[collection] || []) {
      const syncedBooking = collection === 'appointments' && document.virtualyardSync?.state === 'synced'
        ? sourceId(document.virtualyardSync.externalId) : '';
      if (document.platform !== 'virtualyard' && !syncedBooking) continue;
      const identities = [...keyFields[collection].map(field => sourceId(document[field])), syncedBooking];
      for (const id of new Set(identities)) {
        if (!id) continue;
        const list = indexes[collection].get(id) || [];
        if (!list.some(doc => String(doc._id) === String(document._id))) list.push(document);
        indexes[collection].set(id, list);
      }
    }
  }
  function upsert(collection, id, build) {
    if (!id || id === 'undefined' || id === 'null') throw new Error(`Missing ${collection} source identity`);
    const matches = indexes[collection].get(id) || [];
    if (matches.length) {
      for (const existing of matches) {
        const desired = build(existing);
        const patch = changedFields(existing, desired);
        if (!Object.keys(patch).length) { plans[collection].unchanged++; continue; }
        plans[collection].updated++;
        plans[collection].operations.push({ updateOne: { filter: { _id: existing._id, platform: Object.hasOwn(existing, 'platform') ? existing.platform : { $exists: false }, updatedAt: existing.updatedAt || null }, update: { $set: { ...patch, updatedAt: new Date() } } } });
      }
    } else {
      const document = new models[collection](build(null));
      const error = document.validateSync();
      if (error) throw error;
      const record = document.toObject();
      record._id = new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`virtualyard:${collection}:${id}`).digest('hex').slice(0, 24));
      record.createdAt = snapshot;
      record.updatedAt = snapshot;
      plans[collection].inserted++;
      plans[collection].operations.push({ updateOne: { filter: { _id: record._id }, update: { $setOnInsert: record }, upsert: true } });
    }
  }
  for (const item of payload.leads) {
    const id = sourceId(item.leadId || item._id);
    if (!id) throw new Error('Lead has no external ID');
    if (sourceLeads.has(id)) throw new Error(`Duplicate source lead ID ${id}`);
    sourceLeads.set(id, item);
    const vehicle = item.vehicle;
    if (vehicle && (vehicle.vehicleId || vehicle.stockNo || vehicle.raw)) {
      const key = sourceId(vehicle.vehicleId || vehicle.stockNo || vehicle.raw);
      if (!vehicles.has(key)) vehicles.set(key, vehicle);
    }
  }
  const driveIds = new Set();
  for (const drive of payload.testDrives) {
    const id = sourceId(drive._id);
    if (!id || driveIds.has(id)) throw new Error('Missing or duplicate test-drive ID');
    driveIds.add(id);
    if (drive.leadId) {
      const previous = drives.get(String(drive.leadId));
      if (!previous || (date(drive.testDriveDate)?.getTime() || 0) > (date(previous.testDriveDate)?.getTime() || 0)) drives.set(String(drive.leadId), drive);
    }
  }
  for (const [id, item] of sourceLeads) {
    const drive = drives.get(id);
    const vehicle = item.vehicle || {};
    upsert('leads', id, existing => {
      const restricted = optedOut(existing);
      const activeDrive = !!drive && (!date(drive.testDriveDate) || date(drive.testDriveDate) >= snapshot);
      const received = date(item.leadDate) || date(existing?.leadDate) || date(item.scrapedAt) || snapshot;
      return {
        name: name(item.customer) || name(drive?.customer) || existing?.name || 'Prospect',
        phone: item.customer?.phone || item.customer?.mobilePhone || item.customer?.homePhone || drive?.customer?.phone || existing?.phone || '',
        email: item.customer?.email || drive?.customer?.email || existing?.email || '',
        vehicle: label(vehicle) || existing?.vehicle || 'BYD Vehicle',
        dealer: vehicle.yard || drive?.location || existing?.dealer || 'BYD Dealership',
        stockNum: vehicle.stockNo || existing?.stockNum || '', price: price(vehicle) || existing?.price || '', paintColor: vehicle.colour || existing?.paintColor || '',
        score: helpers.calculateScore(item, activeDrive), color: helpers.mapColor(item, activeDrive),
        tag: restricted ? 'Opted Out' : helpers.mapTag(item, activeDrive),
        stage: restricted ? existing.stage : helpers.mapStage(item, activeDrive), status: restricted ? existing.status : helpers.mapStatus(item, activeDrive),
        control: existing?.control && !/^ai/i.test(existing.control) ? existing.control : 'Human',
        source: item.source || 'Virtual Yard', platform: 'virtualyard',
        leadId: existing ? existing.leadId : id, virtualyardId: existing?.virtualyardId || id,
        customerId: sourceId(item.customerId) || existing?.customerId || null,
        notes: existing?.notes || item.previewText || '', previewText: item.previewText || '',
        enquiryDesc: item.previewText || existing?.enquiryDesc || '',
        enquiryNote: item.status ? `Status: ${item.status} | Stage: ${item.stageText || item.stage}` : existing?.enquiryNote || '',
        vyStage: item.stage || '', vyStageText: item.stageText || '', vyTab: item.tab || '', vyStatus: item.status || '',
        stageText: item.stageText || item.stage || '', tab: item.tab || 'inbox',
        assignedTo: item.assignedTo && item.assignedTo !== 'Not Assigned' ? item.assignedTo : existing?.assignedTo || '',
        lastContact: item.lastContact || existing?.lastContact || '',
        leadDate: date(item.leadDate) || existing?.leadDate || date(item.scrapedAt) || snapshot,
        leadCreatedDate: date(item.leadDate) || existing?.leadCreatedDate || date(item.scrapedAt) || snapshot,
        receivedDaysAgo: Math.max(0, Math.floor((snapshot - received) / 86400000)),
        testDrive: drive ? driveDetails(drive, existing) : existing?.testDrive,
      };
    });
  }
  for (const drive of payload.testDrives) {
    const externalLead = sourceId(drive.leadId);
    const linked = sourceLeads.get(externalLead);
    if (!linked) {
      const id = 'td-' + sourceId(drive._id);
      upsert('leads', id, existing => ({
        name: name(drive.customer) || existing?.name || 'Test Drive Prospect', phone: drive.customer?.phone || existing?.phone || '', email: drive.customer?.email || existing?.email || '',
        vehicle: existing?.vehicle || 'BYD Vehicle', dealer: drive.location || existing?.dealer || 'BYD Dealership',
        platform: 'virtualyard', leadId: existing ? existing.leadId : id, virtualyardId: existing?.virtualyardId || id, source: 'Virtual Yard Test Drive',
        score: 90, tag: optedOut(existing) ? 'Opted Out' : 'Commitment', color: 'green',
        stage: optedOut(existing) ? existing.stage : 'TEST DRIVE BOOKED', status: optedOut(existing) ? existing.status : 'committed',
        control: existing?.control && !/^ai/i.test(existing.control) ? existing.control : 'Human',
        notes: existing?.notes || `Test Drive Booking (${drive.status || 'Confirmed'})`,
        testDrive: driveDetails(drive, existing),
        leadDate: existing?.leadDate || date(drive.testDriveDate) || snapshot,
      }));
    }
    upsert('appointments', sourceId(drive._id), existing => ({
      appointmentId: sourceId(drive._id),
      leadId: existing?.virtualyardSync?.state === 'synced' ? existing.leadId : linked ? externalLead : 'td-' + sourceId(drive._id),
      when: date(drive.testDriveDate)?.toISOString() || existing?.when || 'Upcoming Date',
      prospectName: name(drive.customer) || existing?.prospectName || 'Test Drive Prospect',
      phone: drive.customer?.phone || existing?.phone || '', email: drive.customer?.email || existing?.email || '',
      vehicle: label(linked?.vehicle) || existing?.vehicle || 'BYD Vehicle',
      dealership: drive.location || existing?.dealership || 'BYD Dealership', location: drive.location || existing?.location || 'BYD Dealership',
      site: existing?.virtualyardSync?.state === 'synced' ? drive.location || existing.site : undefined,
      bookedBy: existing?.bookedBy && existing.bookedBy !== 'AI' ? existing.bookedBy : 'Manual',
      status: ['Completed', 'Cancelled', 'No Show'].includes(existing?.status) ? existing.status : drive.status || existing?.status || 'Confirmed',
      testDriveDate: date(drive.testDriveDate) || existing?.testDriveDate || null,
      scrapedAt: date(drive.scrapedAt) || snapshot,
      platform: existing?.virtualyardSync?.state === 'synced' ? existing.platform : 'virtualyard', type: 'Test Drive',
    }));
  }
  for (const [id, vehicle] of vehicles) {
    upsert('inventories', id, existing => ({
      identifier: id, platform: 'virtualyard', stock: vehicle.stockNo || existing?.stock || '', model: vehicle.model || existing?.model || '', paint: vehicle.colour || existing?.paint || '',
      location: vehicle.yard || existing?.location || 'BYD Dealership', title: label(vehicle) || existing?.title || 'BYD Vehicle',
      price: price(vehicle) || existing?.price || '', status: existing?.status || 'Available',
      priceData: Number.isFinite(Number(vehicle.price)) && vehicle.price != null && vehicle.price !== ''
        ? { ...(existing?.priceData || {}), ui: Number(vehicle.price), currency: 'AUD', label: existing?.priceData?.label || 'DAP' }
        : existing?.priceData,
      specifications: { ...(existing?.specifications || {}), ...(vehicle.make ? { make: vehicle.make } : {}), ...(vehicle.model ? { model: vehicle.model } : {}), ...(vehicle.year ? { year: Number(vehicle.year) } : {}), ...(vehicle.colour ? { colour: vehicle.colour } : {}) },
    }));
  }
  return plans;
}

async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run');
  const backupArg = args.find(arg => arg.startsWith('--backup='));
  const file = findBothJson(args.find(arg => !arg.startsWith('--')));
  if (!dryRun && !backupArg) throw new Error('Provide --backup=<file.ejson> for a live import');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const uri = process.env.LEAD_CENTER_MONGO_URI;
  if (!uri) throw new Error('LEAD_CENTER_MONGO_URI is required for the Virtual Yard import');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db;
    async function read() { return Object.fromEntries(await Promise.all(Object.keys(models).map(async collection => [collection, await db.collection(collection).find({}).toArray()]))); }
    const stored = await read();
    const plans = buildPlan(payload, stored);
    const summary = Object.fromEntries(Object.entries(plans).map(([collection, plan]) => [collection, { inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged }]));
    emit({ database: db.databaseName, source: file, sourceSnapshot: payload.scrapedAt, dryRun, summary });
    if (dryRun) return summary;
    const backupPath = path.resolve(backupArg.slice('--backup='.length));
    fs.writeFileSync(backupPath, BSON.EJSON.stringify({ database: db.databaseName, backedUpAt: new Date(), collections: stored }, { relaxed: false }), { flag: 'wx', mode: 0o600 });
    const applied = {};
    for (const [collection, plan] of Object.entries(plans)) {
      let inserted = 0, updated = 0;
      for (let start = 0; start < plan.operations.length; start += 300) {
        const result = await db.collection(collection).bulkWrite(plan.operations.slice(start, start + 300), { ordered: true });
        inserted += result.upsertedCount;
        updated += result.modifiedCount;
      }
      if (inserted !== plan.inserted || updated !== plan.updated) throw new Error(`Concurrent changes detected in ${collection}`);
      applied[collection] = { inserted, updated };
      emit({ collection, ...applied[collection] });
    }
    const after = await read();
    const second = buildPlan(payload, after);
    if (Object.values(second).some(plan => plan.operations.length)) throw new Error('Repeat-run verification found remaining changes');
    // Original records outside the planned updates must retain their full data.
    for (const collection of Object.keys(models)) {
      const changedIds = new Set(plans[collection].operations.filter(op => op.updateOne.update.$set).map(op => String(op.updateOne.filter._id)));
      const byId = new Map(after[collection].map(doc => [String(doc._id), doc]));
      for (const original of stored[collection]) {
        if (!changedIds.has(String(original._id)) && !isDeepStrictEqual(original, byId.get(String(original._id)))) throw new Error(`Unrelated record changed during ${collection} import`);
      }
    }
    emit({ complete: true, applied, repeatRunChanges: 0, unrelatedRecordsUnchanged: true, backupPath });
    return applied;
  } finally { await mongoose.disconnect(); }
}
module.exports = { buildPlan, changedFields, findBothJson, main };
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  main().catch(error => { emit({ error: error.name, message: error.message }); process.exitCode = 1; });
}
