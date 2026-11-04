const test = require('node:test');
const assert = require('node:assert/strict');
const { canManageUsers, hasPlatform, resolveSite, validateAccount } = require('../src/services/accountAccess');
const input = () => ({ name: 'Test Staff', email: 'staff@example.com', role: 'sales_consultant', site: 'BYD Fairfield', all_sites: false,
  allowed_sites: ['BYD Fairfield', 'BYD Nunawading'], platform_access: ['crm'], network_lookup: false, active: true });

test('only the named owner with the super admin role can manage users', () => {
  assert.equal(canManageUsers({ email: 'devs@omnisuiteai.com', role: 'super_admin' }), true);
  assert.equal(canManageUsers({ email: 'other@example.com', role: 'super_admin' }), false);
  assert.equal(canManageUsers({ email: 'devs@omnisuiteai.com', role: 'sales_manager' }), false);
});
test('assigned sites support aliases and cannot be widened by query parameters', () => {
  const user = input();
  assert.equal(resolveSite(user, 'Nunawading'), 'BYD Nunawading');
  assert.equal(resolveSite(user, 'All Sites'), 'BYD Fairfield');
  assert.throws(() => resolveSite(user, 'Denza Melbourne'), { statusCode: 403 });
  assert.throws(() => resolveSite({ ...user, allowed_sites: [] }), { statusCode: 403 });
  assert.throws(() => resolveSite({ ...user, allowed_sites: ['Denza Melbourne'] }, 'BYD Melbourne City'), { statusCode: 403 });
});
test('platform grants are explicit while existing unmanaged accounts remain compatible', () => {
  assert.equal(hasPlatform(input(), 'crm'), true);
  assert.equal(hasPlatform(input(), 'lead_centre'), false);
  assert.equal(hasPlatform({ platform_access: [] }, 'crm'), false);
  assert.equal(hasPlatform({}, 'crm'), true);
});
test('invalid access lists, unknown fields, and invalid passwords fail before writes', () => {
  for (const patch of [{ allowed_sites: [] }, { platform_access: [] }, { platform_access: ['unknown'] }, { allowed_sites: ['unknown'] }, { role: 'unknown' }, { password: 'short' }, { password: '😀'.repeat(20) }, { email: 'bad' }, { active: 'true' }, { password_hash: 'injected' }]) {
    assert.throws(() => validateAccount({ ...input(), ...patch }), { statusCode: 400 });
  }
  assert.equal(validateAccount({ ...input(), email: ' STAFF@EXAMPLE.COM ' }).email, 'staff@example.com');
});
test('single-site locks are retained and multi-site access is explicitly bounded', () => {
  assert.equal(validateAccount({ ...input(), allowed_sites: ['BYD Fairfield'] }).locked_site, 'BYD Fairfield');
  assert.equal(validateAccount(input()).locked_site, '');
  assert.equal(validateAccount({ ...input(), network_lookup: true }).network_lookup, false);
});
