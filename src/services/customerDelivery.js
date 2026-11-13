const crypto = require('crypto');
const { ObjectId } = require('mongoose').mongo;
const { canonicalSite, siteKey, fail } = require('./accountAccess');

const PAYMENT_METHODS = ['Cash', 'Finance', 'Lease', 'Novated lease', 'Other'];
function handoffFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Complete the delivery handoff.');
  const value = {};
  for (const key of ['promises', 'lead_time', 'payment_method', 'finance_provider', 'delivery_notes']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') fail(400, 'Handoff fields must be text.');
    value[key] = String(input[key] || '').trim();
    if (value[key].length > 2000) fail(400, 'Handoff fields must be at most 2,000 characters.');
  }
  if (!value.promises || !value.lead_time || !PAYMENT_METHODS.includes(value.payment_method)) {
    fail(400, 'Enter promises made, expected lead time and a payment method. Use “None” if no promises were made.');
  }
  if (['Finance', 'Lease', 'Novated lease'].includes(value.payment_method) && !value.finance_provider) fail(400, 'Enter the finance or leasing provider.');
  if (value.payment_method === 'Cash') value.finance_provider = '';
  return value;
}
function assertSite(user, record) {
  if (!record) fail(404, 'Customer not found.');
  const site = record.site_location || record.site || record.dealer || record.dealership;
  if (user.locked_site && siteKey(site) !== siteKey(user.locked_site)) fail(404, 'Customer not found.');
  if (Array.isArray(user.allowed_sites) && !user.all_sites && !user.allowed_sites.some(s => siteKey(s) === siteKey(site))) fail(404, 'Customer not found.');
}
const identity = value => ({ $or: [{ id: String(value) }, ...(/^[a-f\d]{24}$/i.test(String(value)) ? [{ _id: new ObjectId(String(value)) }] : [])] });

async function profile(panel, lead, reference, user, create = false) {
  const customers = panel.collection('customers');
  let customer = await customers.findOne({ $or: [{ customer_id: reference }, { lead_prospect_id: reference }] });
  let prospect;
  if (!customer) {
    prospect = await lead.collection('leads').findOne({ $or: [{ leadId: reference }, { virtualyardId: reference }, ...(/^[a-f\d]{24}$/i.test(reference) ? [{ _id: new ObjectId(reference) }] : [])] });
    assertSite(user, prospect);
    if (prospect.customerId || prospect.customer_id) customer = await customers.findOne({ customer_id: prospect.customerId || prospect.customer_id });
    if (!customer && create) {
      const now = new Date();
      const customerId = `CUS-SF-${crypto.createHash('sha256').update(reference).digest('hex').slice(0, 24)}`;
      const record = { customer_id: customerId, lead_prospect_id: reference,
        name: prospect.name || prospect.prospectName, phone: prospect.phone, email: prospect.email || null,
        site: canonicalSite(prospect.dealer || prospect.site || prospect.dealership) || prospect.dealer || prospect.site,
        owner_user_id: user.id, owner_name: user.name, source: prospect.source || 'Sales Floor', createdAt: now, updatedAt: now };
      if (!record.name || !record.phone) fail(400, 'Save the customer name and phone before marking Sold.');
      await customers.updateOne({ customer_id: customerId }, { $setOnInsert: record }, { upsert: true });
      customer = await customers.findOne({ customer_id: customerId });
      await lead.collection('leads').updateOne({ _id: prospect._id }, { $set: { customerId: customer.customer_id } });
    }
    if (!customer) return { customer: null, prospect, client: null };
  }
  assertSite(user, customer);
  let client = customer.delivery_client_id ? await panel.collection('clients').findOne(identity(customer.delivery_client_id)) : null;
  if (!client) client = await panel.collection('clients').findOne({ crm_customer_id: customer.customer_id }, { sort: { created_at: -1, createdAt: -1 } });
  if (client) assertSite(user, client);
  return { customer, prospect, client };
}
function messagePage(comments, before) {
  const messages = (comments || []).filter(c => c.channel === 'sales_delivery');
  let end = messages.length;
  if (before !== undefined) {
    if (typeof before !== 'string' || !before || before.length > 100) fail(400, 'Invalid conversation cursor.');
    end = messages.findIndex(message => message.id === before);
    if (end < 0) fail(400, 'Conversation cursor not found. Refresh the customer profile.');
  }
  const start = Math.max(0, end - 100);
  return { messages: messages.slice(start, end), has_more: start > 0 };
}
function view(record, before) {
  const { customer, client } = record;
  return { customer_id: customer?.customer_id || null, client_id: client?.id || (client?._id ? String(client._id) : null),
    handoff: client?.delivery_handoff || customer?.delivery_handoff || null, stage: client?.stage || null,
    ...messagePage(client?.comments, before),
    last_delivery_message_id: client?.last_delivery_message_id || null,
    unread: client?.sales_unread || 0 };
}
async function chat(panel, record, body, user) {
  if (typeof body !== 'string' || !body.trim() || body.trim().length > 2000) fail(400, 'Enter a message of 1–2,000 characters.');
  if (!record.client) fail(409, 'Mark this deal Sold before messaging Delivery.');
  assertSite(user, record.client);
  const message = { id: crypto.randomUUID(), body: body.trim(), author_id: user.id, author_name: user.name || 'Sales',
    team: 'sales', channel: 'sales_delivery', created_at: new Date().toISOString() };
  await panel.collection('clients').updateOne({ _id: record.client._id }, { $push: { comments: message }, $inc: { delivery_unread: 1 }, $set: { last_sales_message_id: message.id, updated_at: new Date() } });
  return message;
}
async function notifications(panel, user) {
  const filter = { sales_unread: { $gt: 0 } };
  const { siteScope } = require('./crmBrowsing');
  if (user.locked_site) Object.assign(filter, siteScope({}, user, ['site_location']));
  else if (Array.isArray(user.allowed_sites) && !user.all_sites) {
    filter.$or = user.allowed_sites.map(site => siteScope({ site }, {}, ['site_location']));
    if (!filter.$or.length) return [];
  }
  const rows = await panel.collection('clients').find(filter, { projection: { id: 1, name: 1, site_location: 1, crm_customer_id: 1, sales_unread: 1 } }).limit(100).toArray();
  return rows.filter(row => { try { assertSite(user, row); return true; } catch { return false; } }).map(row => ({ customer_id: row.crm_customer_id, name: row.name, unread: row.sales_unread }));
}
module.exports = { PAYMENT_METHODS, handoffFields, assertSite, identity, profile, messagePage, view, chat, notifications };
