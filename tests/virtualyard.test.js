const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { VirtualyardSession } = require('../src/services/virtualyardSession');
const realVy = require('../src/services/virtualyard');

function load(name, mocks) {
  const filename = path.resolve(__dirname, '../src/services', name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, URLSearchParams, Date, console,
    require(key) { return Object.hasOwn(mocks, key) ? mocks[key] : require(key); } }, { filename });
  return module.exports;
}
function sessionFixture(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-session-test-'));
  const file = path.join(directory, 'session.json');
  t.after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); });
  return new VirtualyardSession({ file, cookie: 'PHPSESSID=initial', fetchImpl });
}

test('session keeps replacement cookies across restarts and never exposes them in status', async t => {
  let seen;
  const session = sessionFixture(t, async (url, options) => {
    seen = options;
    return new Response('[]', { headers: { 'Set-Cookie': 'PHPSESSID=rotated; Path=/; HttpOnly; Secure' } });
  });
  const status = await session.check();
  assert.equal(seen.headers.Cookie, 'PHPSESSID=initial');
  assert.equal(seen.redirect, 'manual');
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes('rotated'));
  const restored = new VirtualyardSession({ file: session.file });
  assert.equal(restored.readCookie(), 'PHPSESSID=rotated');
});

test('expired login HTML and redirects fail without following or replaying requests', async t => {
  let calls = 0;
  const session = sessionFixture(t, async () => { calls++; return new Response('', { status: 302, headers: { Location: '/login.php' } }); });
  await assert.rejects(session.check(), { code: 'VY_SESSION_EXPIRED' });
  assert.equal(calls, 1);
  assert.equal(session.status().connected, false);
  session.fetchImpl = async () => new Response('<title>Virtual Yard - Login</title>');
  await assert.rejects(session.check(), { code: 'VY_SESSION_EXPIRED' });
});

test('failed reconnect keeps the previously stored session', async t => {
  const session = sessionFixture(t, async () => new Response('<title>Virtual Yard - Login</title>'));
  session.persist('PHPSESSID=working');
  await assert.rejects(session.connect('PHPSESSID=bad'));
  assert.equal(session.readCookie(), 'PHPSESSID=working');
  await assert.rejects(session.connect('PHPSESSID=bad\r\nInjected: header'));
});

test('POST network failures are uncertain and third-party cookie forwarding is prohibited', async t => {
  const session = sessionFixture(t, async () => { throw new Error('timeout'); });
  await assert.rejects(session.request('/save/save.php', { method: 'POST', body: 'x=1' }), { mayHaveCreated: true });
  await assert.rejects(session.request('https://example.com/'), { code: 'VY_INVALID_URL' });
});

test('save payload preserves verified IDs, Melbourne time and UTF-8 base64 notes', () => {
  const input = { _id: 'crm-1', notes: 'testing 中文', virtualyard: { vehicleId: '861656', vehicleName: '10092 BYD ATTO 2 Premium',
    userId: '9738', userName: 'Sales Person', customerId: '2447922', customerName: 'Driver', locationId: '4209', status: 'C', bookingType: 'T', bookingDateTime: '2026-10-31 21:00:00' } };
  const payload = new URLSearchParams(realVy.payload(input));
  assert.equal(payload.get('dealerTestDrive-customerId'), '2447922');
  assert.equal(payload.get('dealerTestDrive-bookingDateTime'), '2026-10-31 21:00:00');
  assert.equal(Buffer.from(payload.get('dealerTestDrive-notes-base64'), 'base64').toString(), 'testing 中文\nCRM booking: crm-1');
  assert.equal(realVy.melbourneTime('2026-10-31T10:00:00Z'), '2026-10-31 21:00:00');
  assert.equal(realVy.melbourneTime('2026-07-01T00:00:00Z'), '2026-07-01 10:00:00');
  assert.throws(() => realVy.melbourneTime('2026-10-31T21:00:00'));
});

test('HTTP 200 alone never confirms a booking: require dealerTestDrive ID', () => {
  assert.equal(realVy.savedId('[{"class":"dealerTestDrive","id":1234}]'), '1234');
  for (const text of ['<html>Login</html>', '{}', '[]', '[{"class":"customer","id":4}]']) {
    assert.throws(() => realVy.savedId(text), { mayHaveCreated: true });
  }
  assert.throws(() => realVy.savedId('{"error":true,"msg":"invalid"}'), { mayHaveCreated: false });
});

function memoryCollection(document) {
  const docs = document ? [structuredClone(document)] : [];
  return { docs, async createIndex() {},
    async findOne(query) { return docs.find(doc => Object.entries(query).every(([key, value]) => doc[key] === value)); },
    async insertOne(doc) {
      if (docs.some(row => row.bookingRequestId === doc.bookingRequestId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      doc._id ||= `local-${docs.length + 1}`; docs.push({ ...doc }); return { insertedId: doc._id };
    },
    async updateOne(query, update) {
      const doc = docs.find(row => row._id === query._id);
      const states = query['virtualyardSync.state']?.$in;
      if (!doc || (states && !states.includes(doc.virtualyardSync?.state))) return { modifiedCount: 0 };
      Object.assign(doc, update.$set); return { modifiedCount: 1 };
    },
  };
}

test('concurrent saves with the same CRM request key submit exactly once', async () => {
  let sends = 0;
  const service = load('appointmentBooking.js', {
    './accountAccess': require('../src/services/accountAccess'),
    './virtualyard': { LOCAL_STATUS: realVy.LOCAL_STATUS, async prepare() { return { vehicleName: 'Demo', userName: 'Sales', yardName: 'BYD Fairfield', status: 'C' }; },
      async sync(doc) { sends++; return doc; } },
  });
  const collection = memoryCollection();
  const doc = { type: 'Test Drive', when: '2026-10-31T10:00:00Z', prospectName: 'Driver', site: 'BYD Fairfield', vehicle: 'Demo' };
  const results = await Promise.all([1, 2].map(() => service.book({ ...doc }, { bookingRequestId: 'request-1234' }, { id: 'staff-1' }, collection)));
  assert.equal(sends, 1); assert.equal(collection.docs.length, 1);
  assert.equal(results.filter(result => result.reused).length, 1);
  await assert.rejects(service.book({ ...doc }, { bookingRequestId: 'request-1234' }, { id: 'staff-2' }, collection), { statusCode: 409 });
});

test('uncertain submissions and successful submissions cannot be replayed', async () => {
  let sends = 0;
  const session = { async check() {}, async request() { sends++; throw Object.assign(new Error('Timeout: check Virtual Yard.'), { mayHaveCreated: true }); } };
  const service = load('virtualyard.js', { './virtualyardSession': session, './accountAccess': require('../src/services/accountAccess') });
  const doc = { _id: '1', virtualyard: {}, virtualyardSync: { state: 'pending' } };
  const collection = memoryCollection(doc);
  const first = await service.sync(doc, collection);
  assert.equal(first.virtualyardSync.state, 'unknown');
  await service.sync(first, collection);
  assert.equal(sends, 1);
  collection.docs[0].virtualyardSync.state = 'synced';
  await service.sync(first, collection);
  assert.equal(sends, 1);
});

test('expired sessions do not send a POST and leave a safely retryable failure', async () => {
  let sends = 0;
  const service = load('virtualyard.js', { './virtualyardSession': { async check() { throw new Error('Session expired'); }, async request() { sends++; } }, './accountAccess': require('../src/services/accountAccess') });
  const doc = { _id: '1', virtualyard: {}, virtualyardSync: { state: 'pending' } };
  const result = await service.sync(doc, memoryCollection(doc));
  assert.equal(result.virtualyardSync.state, 'failed'); assert.equal(sends, 0);
});

test('booking preparation validates IDs and enforces permitted yards', async () => {
  const form = '<select name="dealerTestDrive-locationId"><option value="4840">BYD Fairfield</option><option value="4209">BYD Melbourne City</option></select><select name="dealerTestDrive-status"><option value="C">Confirmed</option></select><select name="dealerTestDrive-bookingType"><option value="T">Test Drive</option></select>';
  const session = { async request() { return { text: form }; }, async json(resource) {
    if (resource.includes('vehicles-demonstrator-adv')) return [{ vehicleId: 1, name: 'Demo', locationId: 4840 }];
    if (resource.includes('key=users')) return [{ userId: 2, name: 'Sales Person' }];
    return [{ customerId: 3, name: 'Driver' }];
  } };
  const service = load('virtualyard.js', { './virtualyardSession': session, './accountAccess': require('../src/services/accountAccess') });
  const user = { locked_site: 'BYD Fairfield' };
  const input = { type: 'Test Drive', site: 'BYD Fairfield', when: '2026-10-31T10:00:00Z', virtualyard: { vehicleId: '1', userId: '2', customerId: '3', customerName: 'Driver' } };
  const result = await service.prepare(input, user);
  assert.equal(result.locationId, '4840');
  await assert.rejects(service.prepare({ ...input, virtualyard: { ...input.virtualyard, locationId: '4209' } }, user), { statusCode: 400 });
  await assert.rejects(service.prepare({ ...input, virtualyard: { ...input.virtualyard, vehicleId: '999' } }, user), { statusCode: 400 });
});

test('generic PATCH cannot reset sync state through nested paths or MongoDB operators', () => {
  const { assertBookingPatch } = require('../src/services/appointmentBooking');
  for (const patch of [{ virtualyardSync: { state: 'pending' } }, { 'virtualyardSync.state': 'pending' }, { $unset: { virtualyardSync: 1 } }, { 'virtualyard.customerId': '4' }, { bookingRequestId: 'new-key' }]) {
    assert.throws(() => assertBookingPatch(patch), { statusCode: 400 });
  }
  assert.doesNotThrow(() => assertBookingPatch({ status: 'Completed', notes: 'Customer attended' }));
});

test('concurrent sync attempts persist a confirmed external ID and send one POST', async () => {
  let sends = 0;
  const service = load('virtualyard.js', { './virtualyardSession': { async check() {}, async request() {
    sends++; return { text: '[{"class":"dealerTestDrive","id":"54321"}]' };
  } }, './accountAccess': require('../src/services/accountAccess') });
  const doc = { _id: '1', virtualyard: {}, virtualyardSync: { state: 'pending' } };
  const collection = memoryCollection(doc);
  await Promise.all([service.sync(doc, collection), service.sync(doc, collection)]);
  assert.equal(sends, 1);
  assert.equal(collection.docs[0].virtualyardSync.state, 'synced');
  assert.equal(collection.docs[0].virtualyardSync.externalId, '54321');
});

test('retry rejects stale appointment details and yards outside the current account scope', async () => {
  const form = '<select name="dealerTestDrive-locationId"><option value="4840">BYD Fairfield</option></select><select name="dealerTestDrive-status"><option value="C">Confirmed</option></select><select name="dealerTestDrive-bookingType"><option value="T">Test Drive</option></select>';
  const service = load('virtualyard.js', { './virtualyardSession': { async request() { return { text: form }; } }, './accountAccess': require('../src/services/accountAccess') });
  const appointment = { when: '2026-10-31T10:00:00Z', site: 'BYD Fairfield', vehicle: 'Demo', consultantName: 'Sales', status: 'Confirmed',
    virtualyard: { bookingDateTime: '2026-10-31 21:00:00', yardName: 'BYD Fairfield', locationId: '4840', vehicleName: 'Demo', userName: 'Sales', status: 'C' } };
  await service.validateRetry(appointment, { locked_site: 'Fairfield' });
  await assert.rejects(service.validateRetry({ ...appointment, status: 'Cancelled' }, {}), { statusCode: 409 });
  await assert.rejects(service.validateRetry(appointment, { locked_site: 'Melbourne City' }), { statusCode: 403 });
});

test('POST session-file failures remain uncertain and cannot be treated as a safe rejection', async t => {
  const session = sessionFixture(t, async () => {
    fs.writeFileSync(session.file, 'invalid JSON');
    return new Response('[{"class":"dealerTestDrive","id":1}]');
  });
  await assert.rejects(session.request('/save/save.php', { method: 'POST', body: 'x=1' }), { mayHaveCreated: true, code: 'VY_SESSION_STORAGE' });
});
