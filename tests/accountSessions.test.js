const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const { canManageUsers } = require('../src/services/accountAccess');
function load(filename, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, process, Date,
    require(name) { return name in mocks ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name); } }, { filename });
  return module.exports;
}
async function authorize(account, { version = 1, platform = 'crm', site, claims = {} } = {}) {
  const filename = path.resolve(__dirname, '../src/middleware/auth.js');
  const auth = load(filename, { '../models/delivery/User': { findById() { return { async lean() { return account; } }; } } });
  const token = jwt.sign({ id: '123', role: 'super_admin', email: 'devs@omnisuiteai.com', auth_version: version, platform, ...claims }, process.env.JWT_SECRET || 'change_me_in_production');
  const req = { headers: { authorization: `Bearer ${token}`, ...(site ? { 'x-site': site } : {}) }, query: {}, body: {}, method: 'GET', baseUrl: '/api/crm' };
  const result = { status: 200, accepted: false, req };
  const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
  await auth.authenticate(req, res, error => { if (error) throw error; result.accepted = true; });
  return result;
}
const account = () => ({ _id: '123', email: 'staff@example.com', name: 'Staff', role: 'sales_consultant', active: true, auth_version: 1,
  platform_access: ['crm'], allowed_sites: ['BYD Fairfield', 'BYD Nunawading'], all_sites: false, site: 'BYD Fairfield' });
test('stored permissions replace stale or elevated claims from the JWT', async () => {
  const result = await authorize(account());
  assert.equal(result.accepted, true);
  assert.equal(result.req.user.role, 'sales_consultant');
  assert.equal(canManageUsers(result.req.user), false);
});
test('password reset, disable, delete and missing accounts invalidate existing sessions', async () => {
  for (const user of [{ ...account(), auth_version: 2 }, { ...account(), active: false }, { ...account(), deleted_at: new Date() }, null]) {
    const result = await authorize(user);
    assert.equal(result.status, 401);
    assert.equal(result.accepted, false);
  }
});
test('revoked platform grants reject an otherwise valid session', async () => {
  const result = await authorize({ ...account(), platform_access: ['delivery_centre'] });
  assert.equal(result.status, 403);
});
test('requests can select an assigned site but cannot select an unassigned site', async () => {
  const valid = await authorize(account(), { site: 'Nunawading' });
  assert.equal(valid.req.user.locked_site, 'BYD Nunawading');
  assert.equal(valid.req.query.site, 'BYD Nunawading');
  const invalid = await authorize(account(), { site: 'Denza Melbourne' });
  assert.equal(invalid.status, 403);
});
