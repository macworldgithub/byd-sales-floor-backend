const test = require('node:test');
const assert = require('node:assert/strict');
const { clientSiteFilter } = require('../src/services/deliverySite');

function matches(document, query) {
  return Object.entries(query).every(([field, value]) => {
    if (field === '$or') return value.some(item => matches(document, item));
    if (field === '$and') return value.every(item => matches(document, item));
    const actual = field.split('.').reduce((obj, key) => obj?.[key], document);
    if (value instanceof RegExp) return value.test(actual || '');
    if (value.$regex) return new RegExp(value.$regex, value.$options).test(actual || '');
    if (value.$in) return value.$in.includes(actual ?? null);
    return actual === value;
  });
}

test('DENZA dealership overrides the original department and customer suburb', () => {
  const client = { site_location: 'Denza Melbourne', site: 'BYD Nunawading',
    department: 'BYD Nunawading - New', location: 'Nunawading, VIC' };
  assert.equal(matches(client, clientSiteFilter('Denza Melbourne')), true);
  assert.equal(matches(client, clientSiteFilter('DENZA Melbourne')), true);
  assert.equal(matches(client, clientSiteFilter('BYD Nunawading')), false);
  assert.equal(matches(client, clientSiteFilter('BYD Melbourne')), false);
});

test('legacy records without site_location still match their dealership', () => {
  assert.equal(matches({ site: 'Denza Melbourne' }, clientSiteFilter('Denza Melbourne')), true);
  assert.equal(matches({ site_location: '', site: 'BYD Nunawading' }, clientSiteFilter('Nunawading')), true);
});

test('Sales Floor client lists keep a locked dealership when another site is requested', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const routes = [];
  const router = { use() {}, get(path, handler) { routes.push({ path, handler }); }, post() {}, patch() {}, delete() {} };
  let capturedFilter;
  const cursor = { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] };
  const mockClient = { find(filter) { capturedFilter = filter; return cursor; }, countDocuments: async () => 0 };
  const mocks = {
    express: { Router: () => router },
    'express-validator': { body: () => ({ notEmpty() { return this; }, withMessage() { return this; } }) },
    '../models/delivery/Client': mockClient,
    '../models/delivery/AuditEvent': {},
    '../middleware/auth': { authenticate() {}, requireRole: () => () => {} },
    '../services/deliverySite': { clientSiteFilter },
    '../db': {},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/routes/clients'), 'utf8'), {
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    module: { exports: {} }, console,
  });
  await routes.find(route => route.path === '/').handler({
    user: { role: 'super_admin', locked_site: 'Denza Melbourne' },
    query: { site: 'BYD Nunawading', q: 'Test' },
  }, { json() {} }, error => { throw error; });
  assert.equal(matches({ name: 'Test', site_location: 'Denza Melbourne', location: 'Nunawading, VIC' }, capturedFilter), true);
  assert.equal(matches({ name: 'Test', site_location: 'BYD Nunawading' }, capturedFilter), false);
});

test('CRM delivery watch returns the canonical dealership ahead of stale site data', async () => {
  const dbModule = require.resolve('../src/db');
  const previous = require.cache[dbModule];
  const client = { _id: 'client-id', site_location: 'Denza Melbourne', site: 'BYD Nunawading', name: 'Test' };
  let capturedFilter;
  const cursor = {
    sort() { return this; }, skip() { return this; }, limit() { return this; },
    async toArray() { return [client]; },
  };
  require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: {
    ensureDbConnected: async () => {}, leadConn: {},
    deliveryConn: { db: { collection(name) {
      return name === 'clients' ? {
        find(filter) { capturedFilter = filter; return cursor; }, countDocuments: async () => 1,
      } : { find: () => ({ toArray: async () => [] }) };
    } } },
  } };
  try {
    const service = require('../src/services/crmService');
    const result = await service.getDeliveryWatch({ site: 'Denza Melbourne' });
    assert.equal(result.data[0].site, 'Denza Melbourne');
    assert.equal(matches(client, capturedFilter), true);
    assert.equal(matches({ ...client, site_location: 'BYD Nunawading' }, capturedFilter), false);
  } finally {
    delete require.cache[require.resolve('../src/services/crmService')];
    if (previous) require.cache[dbModule] = previous;
    else delete require.cache[dbModule];
  }
});
