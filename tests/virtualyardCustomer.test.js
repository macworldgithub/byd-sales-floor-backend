const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureCustomer, customerPayload, customerId } = require('../src/services/virtualyardCustomer');
const { database } = require('./helpers/floorMemory');
const form = '<form><input type="hidden" name="csrf" value="server-token"><input name="customer-firstName" required><input name="customer-lastName" required><input name="customer-mobile" required><input name="customer-email" required><input name="customer-locationId"></form>';
const user = { id: 'staff-1', locked_site: 'BYD Fairfield' };
const input = { name: 'Test Driver', phone: '0400000000', email: 'driver@example.invalid', locationId: '4840', site: 'BYD Fairfield' };
function fixture(overrides = {}) {
  let posts = 0;
  const transport = { async json() { return []; }, async check() {}, async request(resource, options) { if (options?.method === 'POST') { posts++; return { text: '[{"class":"customer","id":123}]' }; } return { text: form }; }, ...overrides };
  return { transport, get posts() { return posts; }, collection: database().collection('requests') };
}
test('customer form retains upstream hidden tokens and sends customer details with actual form fields', () => {
  const body = new URLSearchParams(customerPayload(form, input, '4840'));
  assert.equal(body.get('csrf'), 'server-token'); assert.equal(body.get('customer-firstName'), 'Test'); assert.equal(body.get('customer-lastName'), 'Driver');
  assert.equal(body.get('customer-mobile'), '0400000000'); assert.equal(body.get('customer-locationId'), '4840');
  assert.throws(() => customerPayload('<input name="unknown-name">', input, '4840'), /not recognised/);
  assert.throws(() => customerPayload(form + '<input name="customer-required-extra" required>', input, '4840'), /requires customer-required-extra/);
});
test('test-drive customer creation reuses an exact mobile match without sending a create POST', async () => {
  const f = fixture({ async json() { return [{ customerId: 8, name: 'Existing Driver', mobile: '+61 400 000 000', locationId: 4840 }]; } });
  const result = await ensureCustomer(input, user, f.collection, f.transport);
  assert.equal(result.id, '8'); assert.equal(result.reused, true); assert.equal(f.posts, 0);
});
test('confirmed customer ID is durable and repeated requests do not create a second customer', async () => {
  const f = fixture(); const first = await ensureCustomer(input, user, f.collection, f.transport); const second = await ensureCustomer(input, user, f.collection, f.transport);
  assert.equal(first.id, '123'); assert.equal(second.id, '123'); assert.equal(second.reused, true); assert.equal(f.posts, 1);
});
test('ambiguous matching customers fail before creation and other-yard records are not reused', async () => {
  const f = fixture({ async json() { return [1, 2].map(customerId => ({ customerId, name: 'Driver', mobile: input.phone, locationId: 4840 })); } });
  await assert.rejects(ensureCustomer(input, user, f.collection, f.transport), /Multiple/); assert.equal(f.posts, 0);
  const other = fixture({ async json() { return [{ customerId: 99, name: 'Other site', mobile: input.phone, locationId: 999 }]; } });
  assert.equal((await ensureCustomer(input, user, other.collection, other.transport)).id, '123'); assert.equal(other.posts, 1);
});
test('uncertain upstream customer response blocks blind re-creation', async () => {
  let posts = 0;
  const f = fixture({ async request(resource, options) { if (options?.method === 'POST') { posts++; return { text: '<html>Unexpected response</html>' }; } return { text: form }; } });
  await assert.rejects(ensureCustomer(input, user, f.collection, f.transport), /not confirmed/);
  await assert.rejects(ensureCustomer(input, user, f.collection, f.transport), /may already/);
  assert.equal(posts, 1);
});
test('invalid contact details and missing customer IDs never produce a successful create', async () => {
  const f = fixture(); await assert.rejects(ensureCustomer({ ...input, email: '' }, user, f.collection, f.transport), /required/); assert.equal(f.posts, 0);
  assert.equal(customerId('[{"class":"customer","id":91}]'), '91');
  for (const response of ['{}', '[]', '[{"class":"dealerTestDrive","id":5}]', '{"success":false}']) assert.throws(() => customerId(response));
});
