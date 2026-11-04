const OWNER_EMAIL = 'devs@omnisuiteai.com';
const PLATFORMS = ['crm', 'sales_floor', 'lead_centre', 'delivery_centre'];
const SITES = ['BYD Melbourne City', 'BYD Caroline Springs', 'BYD Nunawading', 'BYD Fairfield', 'BYD Doncaster', 'Denza Melbourne', 'Holding Yard VIC', 'Clayton South', 'BYD Wodonga', 'BYD Wollongong', 'BYD Haberfield', 'BYD Berwick', 'BYD Nowra', 'BYD Frankston', 'BYD Campbelltown'];
const ROLES = ['sales_consultant', 'sales_manager', 'bdc', 'delivery', 'site_admin', 'super_admin', 'agent', 'contractor'];
const emailKey = value => String(value || '').trim().toLowerCase();
const siteKey = value => String(value || '').trim().toLowerCase().replace(/^byd\s+/, '').replace(/\s+vic$/, '').replace(/[^a-z0-9]/g, '').replace(/^melbourne$/, 'melbournecity');
const canonicalSite = value => SITES.find(site => siteKey(site) === siteKey(value));
const canManageUsers = user => emailKey(user?.email) === OWNER_EMAIL && user?.role === 'super_admin';
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
function hasPlatform(user, platform) {
  return !Array.isArray(user.platform_access) || user.platform_access.includes(platform);
}
function resolveSite(user, requested) {
  if (!Array.isArray(user.allowed_sites) || user.all_sites === true) return user.locked_site || '';
  if (!user.allowed_sites.length) fail(403, 'No sites are assigned to this account.');
  const explicit = requested && !/^(all|all sites|all locations|all yards|all departments|all sites & yards)$/i.test(requested);
  if (!explicit) return user.allowed_sites.find(s => siteKey(s) === siteKey(user.site)) || user.allowed_sites[0];
  const allowed = user.allowed_sites.find(s => siteKey(s) === siteKey(requested));
  if (!allowed) fail(403, 'You do not have access to this site.');
  return allowed;
}
function validateAccount(input) {
  const allowed = ['name', 'email', 'role', 'site', 'all_sites', 'allowed_sites', 'platform_access', 'network_lookup', 'active', 'password'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'User details are required.');
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Unsupported user field.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = emailKey(input.email);
  if (!name || name.length > 120) fail(400, 'Name must contain 1–120 characters.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'A valid email is required.');
  if (!ROLES.includes(input.role)) fail(400, 'Select a valid role.');
  for (const key of ['all_sites', 'network_lookup', 'active']) if (typeof input[key] !== 'boolean') fail(400, `Invalid ${key} setting.`);
  if (!Array.isArray(input.allowed_sites) || input.allowed_sites.some(s => typeof s !== 'string' || !canonicalSite(s))) fail(400, 'Select valid sites.');
  const sites = [...new Set(input.allowed_sites.map(canonicalSite))];
  if (!input.all_sites && !sites.length) fail(400, 'Assign at least one site or allow all sites.');
  if (!Array.isArray(input.platform_access) || input.platform_access.some(p => !PLATFORMS.includes(p))) fail(400, 'Select valid platforms.');
  const platforms = [...new Set(input.platform_access)];
  if (!platforms.length) fail(400, 'Assign at least one platform.');
  const site = canonicalSite(input.site) || (input.all_sites ? '' : sites[0]);
  if (!input.all_sites && !sites.includes(site)) fail(400, 'Home site must be one of the assigned sites.');
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length < 8 || Buffer.byteLength(input.password, 'utf8') > 72)) fail(400, 'Password must be at least 8 characters and at most 72 UTF-8 bytes.');
  return { name, email, role: input.role, site, all_sites: input.all_sites, allowed_sites: input.all_sites ? [] : sites,
    platform_access: platforms, network_lookup: input.all_sites && input.network_lookup, active: input.active,
    locked_site: input.all_sites || sites.length > 1 ? '' : sites[0], active_site: site || 'All Sites' };
}
module.exports = { OWNER_EMAIL, PLATFORMS, SITES, ROLES, emailKey, siteKey, canonicalSite, canManageUsers, hasPlatform, resolveSite, validateAccount, fail };
