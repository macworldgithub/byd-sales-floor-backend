const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseCsv, loadRoster, makeAccount, membershipSites, importStaff } = require('../src/importCsvStaff');
const { siteRegex, siteConditions } = require('../src/services/staffDirectory');

test('reads UTF-8 headers, commas, escaped quotes and multiline CSV fields', () => {
  assert.deepEqual(parseCsv('\uFEFFName,Note\r\n"王, Jane","a ""quote""\nnext"\r\n'), [['Name', 'Note'], ['王, Jane', 'a "quote"\nnext']]);
  assert.throws(() => parseCsv('a,"unterminated'), /Unclosed/);
});
test('roster deduplicates management and preserves the specific showroom', () => {
  const roster = loadRoster(path.resolve(__dirname, 'fixtures/staff'));
  assert.equal(roster.rowCount, 5);
  assert.equal(roster.staff.length, 4);
  const manager = roster.staff.find(u => u.email === 'manager@example.com');
  assert.equal(manager.site, 'BYD Caroline Springs');
  assert.equal(manager.management, true);
  assert.equal(roster.staff.filter(u => u.site === 'BYD Doncaster').length, 2);
});
test('missing counterpart accounts inherit credentials and permissions without promoting roles', () => {
  const staff = { name: 'Manager', email: 'manager@example.com', position: 'COO', site: null, management: true };
  const counterpart = { role: 'agent', locked_site: null, active_site: 'Fairfield', password_hash: 'existing-hash', network_lookup: false };
  const account = makeAccount(staff, counterpart, 'leads', 'new-hash');
  for (const [key, value] of Object.entries(counterpart)) assert.equal(account[key], value);
  assert.deepEqual(membershipSites(staff, { locked_site: 'BYD Nunawading' }), ['BYD Nunawading']);
});
test('site aliases match exactly and never merge BYD Melbourne with Denza Melbourne', () => {
  assert.ok(siteRegex('Caroline Springs').test('BYD Caroline Springs'));
  assert.ok(siteRegex('BYD Melbourne City VIC').test('Melbourne'));
  assert.ok(!siteRegex('BYD Melbourne').test('Denza Melbourne'));
  assert.ok(!siteRegex('BYD Doncaster').test('BYD Nunawading'));
  assert.ok(!siteRegex('Fairfield').test('Fairfield Other'));
});
test('directory memberships include shared staff without changing their account affiliation', async () => {
  let query;
  const conditions = await siteConditions({ collection() { return { find(filter) { query = filter; return { async toArray() { return [{ email: 'shared@example.com' }]; } }; } }; } }, 'BYD Doncaster');
  assert.ok(query.sites.test('BYD Doncaster'));
  assert.ok(conditions[3].email.$in[0].test(' Shared@Example.com '));
});
for (const route of ['../src/routes/staff.js']) {
  test(`staff endpoint retains a locked site when a different site and search are supplied: ${route}`, async () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    let handler, query, payload;
    const db = { collection() { return { find() { return { async toArray() { return []; } }; } }; } };
    const chain = { select() { return this; }, sort() { return this; }, async lean() { return []; } };
    const userModel = { db, find(filter) { query = filter; return chain; } };
    const router = { get(_path, _auth, callback) { handler = callback; } };
    const filename = path.resolve(__dirname, route);
    const moduleFixture = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: moduleFixture, console,
      require(name) {
        if (name === 'express') return { Router: () => router };
        if (name.includes('models/')) return userModel;
        if (name.includes('middleware/auth')) return { authenticate() {} };
        if (name.includes('staffDirectory')) return { siteConditions };
        throw new Error(`Unexpected dependency ${name}`);
      },
    }, { filename });
    await handler({ user: { role: 'agent', locked_site: 'BYD Nunawading' }, query: { site: 'BYD Doncaster', q: 'Sales' } }, {
      json(value) { payload = value; },
    }, error => { throw error; });
    const scope = query.$and[0].$or[0].locked_site;
    assert.ok(scope.test('Nunawading'));
    assert.ok(!scope.test('BYD Doncaster'));
    assert.equal(query.$and[1].$or[0].name.$regex, 'Sales');
    assert.equal(payload.userScope.hasFullAccess, false);
  });
}
function fakeDb(existing) {
  const collections = { users: structuredClone(existing), staff_site_memberships: [] };
  const matches = (row, query) => Object.entries(query).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && condition.$regex) return new RegExp(condition.$regex, condition.$options).test(row[key]);
    if (condition && typeof condition === 'object' && condition.$in) return condition.$in.includes(row[key]);
    return row[key] === condition;
  });
  return { collections, collection(name) { return {
    find(query) { return { async toArray() { return structuredClone(collections[name].filter(row => matches(row, query))); } }; },
    async findOne(query) { return structuredClone(collections[name].find(row => matches(row, query))); },
    async updateOne(query, update) {
      if (name === 'users') assert.deepEqual(Object.keys(update), ['$setOnInsert']);
      let row = collections[name].find(item => matches(item, query));
      if (row) { if (update.$set) Object.assign(row, update.$set); return { upsertedCount: 0 }; }
      row = { _id: `${name}-${collections[name].length}`, ...update.$setOnInsert, ...update.$set };
      collections[name].push(row); return { upsertedCount: 1 };
    },
  }; } };
}
test('import skips case/whitespace duplicates, preserves every existing field and is repeatable', async () => {
  const existing = { _id: 'old', email: ' Existing@Example.com ', name: 'Old Name', password_hash: 'old-hash', role: 'agent', locked_site: 'Old Site', active: false, custom_permission: 'keep' };
  const panel = fakeDb([existing]), leads = fakeDb([]);
  const roster = { rowCount: 2, staff: [
    { email: 'existing@example.com', name: 'New Name', position: 'Sales Manager', site: 'BYD Doncaster', sources: [] },
    { email: 'new@example.com', name: 'New Person', position: 'Sales Consultant', site: 'BYD Doncaster', sources: [] },
  ] };
  const first = await importStaff({ panel, leads }, roster, { apply: true });
  assert.equal(first.platforms.panel.created.length, 1);
  assert.equal(first.platforms.leads.created.length, 2);
  assert.deepEqual(panel.collections.users[0], existing);
  assert.equal(leads.collections.users[0].password_hash, 'old-hash');
  assert.equal(leads.collections.users[0].active, false);
  const second = await importStaff({ panel, leads }, roster, { apply: true });
  assert.equal(second.platforms.panel.created.length, 0);
  assert.equal(second.platforms.leads.created.length, 0);
  assert.equal(panel.collections.users.length, 2);
  assert.equal(panel.collections.staff_site_memberships.length, 2);
});
