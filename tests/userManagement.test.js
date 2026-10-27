const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId, BSON } = require('mongoose').mongo;
const bcrypt = require('bcryptjs');
const { createUserManagement } = require('../src/services/userManagement');
const clone = value => BSON.EJSON.parse(BSON.EJSON.stringify(value));
const owner = { id: String(new ObjectId()), email: 'devs@omnisuiteai.com', role: 'super_admin' };
const input = () => ({ name: 'Test Staff', email: 'staff@example.com', role: 'sales_consultant', site: 'BYD Fairfield', all_sites: false,
  allowed_sites: ['BYD Fairfield', 'BYD Nunawading'], platform_access: ['crm', 'lead_centre'], network_lookup: false, active: true, password: 'Testing123!' });
function fixture() {
  const state = { panel: {}, lead: {} };
  let failLeadWrite = false;
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => value?.$regex ? new RegExp(value.$regex, value.$options).test(doc[key] || '') : String(doc[key]) === String(value));
  function db(label) { return { collection(name) {
    const rows = () => state[label][name] ||= [];
    const check = () => { if (label === 'lead' && failLeadWrite) throw new Error('Simulated replica write failure'); };
    return {
      find(filter) { return { async toArray() { return rows().filter(d => matches(d, filter)).map(clone); } }; },
      async findOne(filter) { return clone(rows().find(d => matches(d, filter)) || null); },
      async insertOne(doc) { check(); rows().push(clone(doc)); return { insertedId: doc._id }; },
      async updateOne(filter, update, options) { check(); let doc = rows().find(d => matches(d, filter)); if (!doc && options?.upsert) { doc = clone(filter); rows().push(doc); } if (doc) Object.assign(doc, clone(update.$set)); return { matchedCount: doc ? 1 : 0 }; },
      async deleteMany(filter) { check(); state[label][name] = rows().filter(d => !matches(d, filter)); },
    };
  } }; }
  const client = { startSession() { return { async withTransaction(callback) { const snapshot = clone(state); try { await callback(); } catch (error) { Object.assign(state, snapshot); throw error; } }, async endSession() {} }; } };
  const service = createUserManagement({ panelDb: db('panel'), leadDb: db('lead'), client, hashPassword: password => bcrypt.hash(password, 4) });
  return { service, state, failLead() { failLeadWrite = true; } };
}
test('new users are created in both stores with shared credentials and sanitized responses', async () => {
  const { service, state } = fixture();
  const result = await service.mutate({ input: input(), actor: owner });
  const panel = state.panel.users[0], lead = state.lead.users[0];
  assert.equal(panel.id, lead.id);
  assert.equal(panel.password_hash, lead.password_hash);
  assert.ok(await bcrypt.compare('Testing123!', lead.password_hash));
  assert.deepEqual(panel.allowed_sites, ['BYD Fairfield', 'BYD Nunawading']);
  assert.deepEqual(panel.platform_access, ['crm', 'lead_centre']);
  assert.equal(panel.auth_version, 1);
  assert.equal(result.password_hash, undefined);
  assert.equal(JSON.stringify(await service.list()).includes(panel.password_hash), false);
  assert.equal(JSON.stringify(state.panel.auditevents).includes('Testing123!'), false);
});
test('edit, email changes and password reset preserve IDs and update both account stores', async () => {
  const { service, state } = fixture();
  const first = await service.mutate({ input: input(), actor: owner });
  const id = state.panel.users[0].id;
  const result = await service.mutate({ id: first.id, input: { ...input(), email: 'changed@example.com', password: 'ResetPassword123!', allowed_sites: ['BYD Fairfield'], platform_access: ['delivery_centre'] }, actor: owner });
  assert.equal(result.id, first.id);
  for (const database of Object.values(state)) {
    assert.equal(database.users[0].id, id);
    assert.equal(database.users[0].email, 'changed@example.com');
    assert.equal(database.users[0].locked_site, 'BYD Fairfield');
    assert.equal(database.users[0].auth_version, 2);
    assert.ok(await bcrypt.compare('ResetPassword123!', database.users[0].password_hash));
    assert.equal(database.staff_site_memberships[0].email, 'changed@example.com');
  }
});
test('disabled and deleted users lose platform access without deleting business records', async () => {
  const { service, state } = fixture();
  const created = await service.mutate({ input: input(), actor: owner });
  state.panel.clients = [{ id: 'business-record', assigned_agent_id: state.panel.users[0].id }];
  const { password, ...fields } = input();
  await service.mutate({ id: created.id, input: { ...fields, active: false }, actor: owner });
  assert.equal(state.panel.users[0].active, false);
  const hash = state.panel.users[0].password_hash;
  await service.mutate({ id: created.id, actor: owner, remove: true });
  for (const database of Object.values(state)) {
    assert.equal(database.users[0].active, false);
    assert.deepEqual(database.users[0].platform_access, []);
    assert.ok(database.users[0].deleted_at);
    assert.equal(database.users[0].password_hash, hash);
  }
  assert.equal(state.panel.clients.length, 1);
});
test('a replica failure rolls back the whole account operation', async () => {
  const { service, state, failLead } = fixture(); failLead();
  await assert.rejects(service.mutate({ input: input(), actor: owner }), /replica write failure/);
  assert.deepEqual(state, { panel: {}, lead: {} });
});
test('duplicate emails, privilege injection and owner changes are rejected', async () => {
  const { service, state } = fixture();
  await service.mutate({ input: input(), actor: owner });
  await assert.rejects(service.mutate({ input: { ...input(), email: ' STAFF@example.com ' }, actor: owner }), { statusCode: 409 });
  await assert.rejects(service.mutate({ input: input(), actor: { ...owner, email: 'other@example.com' } }), { statusCode: 403 });
  await assert.rejects(service.mutate({ input: { ...input(), email: owner.email }, actor: owner }), { statusCode: 400 });
  state.panel.users.push({ _id: new ObjectId(owner.id), email: owner.email, role: owner.role });
  await assert.rejects(service.mutate({ id: `panel:${owner.id}`, actor: owner, remove: true }), { statusCode: 400 });
});
test('lead-only legacy accounts can be managed without recreating their identity', async () => {
  const { service, state } = fixture();
  const _id = new ObjectId();
  state.lead.users = [{ _id, email: 'legacy@example.com', name: 'Legacy', role: 'agent', locked_site: 'BYD Fairfield', password_hash: await bcrypt.hash('Existing123!', 4) }];
  const list = await service.list();
  assert.deepEqual(list.users[0].platform_access, ['lead_centre']);
  const { password, ...fields } = input();
  await service.mutate({ id: `lead:${_id}`, input: { ...fields, email: 'legacy@example.com' }, actor: owner });
  assert.equal(String(state.lead.users[0]._id), String(_id));
  assert.equal(state.panel.users.length, 1);
  assert.ok(await bcrypt.compare('Existing123!', state.panel.users[0].password_hash));
});
