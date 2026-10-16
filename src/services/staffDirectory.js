const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function siteRegex(site) {
  const name = String(site).trim().replace(/\s+VIC$/i, '').replace(/^BYD\s+/i, '');
  const names = /^(Melbourne|Melbourne City)$/i.test(name) ? ['Melbourne', 'Melbourne City'] : [name];
  return new RegExp(`^(?:BYD\\s+)?(?:${names.map(escapeRegex).join('|')})(?:\\s+VIC)?$`, 'i');
}
async function siteConditions(db, site) {
  const regex = siteRegex(site);
  const memberships = await db.collection('staff_site_memberships').find({ sites: regex }).toArray();
  const conditions = ['locked_site', 'site', 'active_site'].map(key => ({ [key]: regex }));
  if (memberships.length) conditions.push({ email: { $in: memberships.map(m => new RegExp(`^\\s*${escapeRegex(m.email)}\\s*$`, 'i')) } });
  return conditions;
}
module.exports = { siteRegex, siteConditions };
