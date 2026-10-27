const test = require('node:test');
const assert = require('node:assert/strict');
const { guardResourceSites } = require('../src/services/resourceSiteAccess');
const user = { allowed_sites: ['BYD Fairfield', 'BYD Nunawading'], all_sites: false };
function databases(site) { return { panel: { collection() { return { async findOne() { return { site }; } }; } }, lead: { collection() { return { async findOne() { return { dealer: site }; } }; } } }; }
test('direct record URLs cannot bypass assigned sites', async () => {
  const req = { user, originalUrl: '/api/crm/customers/CUST-BYD-101', body: {} };
  await guardResourceSites(req, databases('Fairfield'));
  await assert.rejects(guardResourceSites(req, databases('Denza Melbourne')), { statusCode: 404 });
});
test('linked customer IDs in writes are checked and list/export URLs remain valid', async () => {
  const req = { user, originalUrl: '/api/crm/opportunities', body: { customer_id: 'CUST-BYD-101' } };
  await assert.rejects(guardResourceSites(req, databases('Denza Melbourne')), { statusCode: 404 });
  await guardResourceSites({ user, originalUrl: '/api/crm/customers/export-csv', body: {} }, databases('Denza Melbourne'));
});
test('site-scoped accounts cannot run global reconciliation or change global settings', async () => {
  for (const originalUrl of ['/api/crm/saleslog/reconcile-all', '/api/crm/allocations/check-sla', '/api/settings']) {
    await assert.rejects(guardResourceSites({ user, originalUrl, method: 'POST', body: {} }, databases('Fairfield')), { statusCode: 403 });
  }
});
