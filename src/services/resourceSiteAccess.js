const { ObjectId } = require('mongoose').mongo;
const { siteKey, fail } = require('./accountAccess');
function assertRecordSite(user, record) {
  if (!record) fail(404, 'Record not found.');
  const site = record.site_location || record.site || record.dealer || record.dealership || record.location || record.yard || record.dealerName;
  if (!user.allowed_sites.some(allowed => siteKey(allowed) === siteKey(site))) fail(404, 'Record not found.');
}
async function guardResourceSites(req, databases) {
  if (!Array.isArray(req.user?.allowed_sites) || req.user.all_sites || !req.originalUrl) return;
  const parts = req.originalUrl.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  const crm = parts[1] === 'crm';
  const resource = parts[crm ? 2 : 1], id = parts[crm ? 3 : 2];
  const globalAction = ['check-sla', 'reconcile-all', 'check-expired-holds'].includes(id)
    || (resource === 'settings' && req.method && req.method !== 'GET');
  if (globalAction) fail(403, 'This action requires access to all sites.');
  const rules = {
    leads: ['lead', 'leads', ['leadId', 'virtualyardId']], inventories: ['lead', 'inventories', ['identifier', 'stock']],
    inventory: ['lead', 'inventories', ['identifier', 'stock']], appointments: ['lead', 'appointments', ['appointmentId']],
    conversations: ['lead', 'conversations', []], clients: ['panel', 'clients', ['id']],
    customers: ['panel', 'customers', ['customer_id']], opportunities: ['panel', 'opportunities', ['opportunity_id']],
    allocations: ['panel', 'allocations', ['allocation_id']],
  };
  async function check(rule, reference) {
    const [database, collection, keys] = rule;
    const alternatives = keys.map(key => ({ [key]: String(reference) }));
    if (/^[a-f\d]{24}$/i.test(String(reference))) alternatives.push({ _id: new ObjectId(String(reference)) });
    if (!alternatives.length) fail(404, 'Record not found.');
    const record = await databases[database].collection(collection).findOne({ $or: alternatives });
    assertRecordSite(req.user, record);
  }
  const nonIds = ['export-csv', 'export.ics', 'check-conflict', 'check-sla', 'reminders', 'upcoming', 'inbound', 'status', 'dealerships', 'stats', 'by-lead'];
  if (rules[resource] && id && !nonIds.includes(id)) await check(rules[resource], id);
  if (resource === 'conversations' && id === 'by-lead' && parts[3]) await check(rules.leads, parts[3]);
  for (const [key, rule] of Object.entries({ customer_id: rules.customers, sourceId: rules.customers, opportunity_id: rules.opportunities, lead_prospect_id: rules.leads, delivery_client_id: rules.clients })) {
    if (req.body?.[key]) await check(rule, req.body[key]);
  }
}
module.exports = { guardResourceSites, assertRecordSite };
