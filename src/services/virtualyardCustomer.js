const crypto = require('node:crypto');
const session = require('./virtualyardSession');
const { fail, siteKey } = require('./accountAccess');

const phoneKey = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.replace(/^61(?=\d{9}$)/, '0');
};
const decode = value => String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], decode(m[2] ?? m[3])]));
}

// Use the upstream form's field names, hidden tokens and required fields. Refuse
// an unfamiliar form rather than posting a guessed customer or inventing an ID.
function customerPayload(html, customer, locationId, configuredMapping = {}) {
  const values = new URLSearchParams();
  const parts = customer.name.trim().split(/\s+/);
  const data = { name: customer.name.trim(), firstName: parts[0], lastName: parts.slice(1).join(' '),
    phone: customer.phone, email: customer.email, locationId };
  const aliases = { name: ['customer-fullName', 'customer-name'], firstName: ['customer-firstName', 'customer-firstname'],
    lastName: ['customer-lastName', 'customer-surname'], phone: ['customer-mobile', 'customer-mobilePhone', 'customer-mobileNumber', 'customer-phone'],
    email: ['customer-email', 'customer-emailAddress'], locationId: ['customer-locationId', 'customer-yardId'] };
  const fields = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)].map(m => ({ tag: m[0], ...attributes(m[0]) })).filter(f => f.name);
  const used = new Set();
  for (const field of fields) {
    if (field.type === 'hidden') values.set(field.name, field.value || '');
    const key = Object.keys(aliases).find(k => configuredMapping[k] === field.name || aliases[k].includes(field.name));
    if (key) { values.set(field.name, String(data[key] || '')); used.add(key); }
    if (/\brequired(?:\s|=|>)/i.test(field.tag) && !values.get(field.name)) fail(502, `Virtual Yard customer form requires ${field.name}. Configure the customer field mapping before retrying.`);
  }
  if ((!used.has('name') && !(used.has('firstName') && used.has('lastName'))) || !used.has('phone') || !used.has('email')) {
    fail(502, 'Virtual Yard customer form was not recognised. Configure its form path and field mapping.');
  }
  return values.toString();
}

function customerId(text) {
  let result;
  try { result = JSON.parse(text); } catch { throw Object.assign(new Error('Virtual Yard customer creation was not confirmed. Check Virtual Yard before retrying.'), { mayHaveCreated: true }); }
  if (result?.error || result?.success === false) throw Object.assign(new Error('Virtual Yard rejected customer creation.'), { mayHaveCreated: false });
  const record = Array.isArray(result) ? result.find(row => /^(customer|customers)$/i.test(row.class)) : null;
  if (!record || !/^[1-9]\d*$/.test(String(record.id))) throw Object.assign(new Error('Virtual Yard did not return a customer ID. Check Virtual Yard before retrying.'), { mayHaveCreated: true });
  return String(record.id);
}

async function ensureCustomer(input, user, collection, transport = session) {
  const name = String(input.name || '').trim(), phone = phoneKey(input.phone), email = String(input.email || '').trim().toLowerCase();
  const site = user.locked_site || input.site || user.site;
  if (!name || !/^0[23478]\d{8}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !site) fail(400, 'Customer name, valid Australian phone, email and site are required to create a Virtual Yard customer.');
  const query = new URLSearchParams({ key: 'customers', customers: phone, categoryId: '0', limit: '1000' });
  const rows = await transport.json(`/ajax/JSON/lookup.php?${query}`);
  if (!Array.isArray(rows)) fail(502, 'Virtual Yard customer lookup failed.');
  const matches = rows.filter(row => /^[1-9]\d*$/.test(String(row.customerId || '')) && phoneKey(row.mobile || row.phone) === phone &&
    (!row.locationId || String(row.locationId) === String(input.locationId)));
  if (matches.length > 1) fail(409, 'Multiple Virtual Yard customers match this phone. Select the existing customer explicitly.');
  if (matches.length === 1) return { id: String(matches[0].customerId), name: matches[0].name || matches[0].value || name, reused: true };

  const key = crypto.createHash('sha256').update(`${siteKey(site)}:${phone}`).digest('hex');
  const existing = await collection.findOne({ _id: key });
  if (existing?.state === 'synced') return { id: existing.externalId, name: existing.name, reused: true };
  if (existing && ['sending', 'unknown'].includes(existing.state)) fail(409, 'Customer creation may already have reached Virtual Yard. Check the customer record before retrying.');
  const formPath = process.env.VIRTUALYARD_CUSTOMER_FORM_PATH || '/render.php?page=customers&params=&auto=add';
  const savePath = process.env.VIRTUALYARD_CUSTOMER_SAVE_PATH || '/save/save.php?page=customers&auto=add';
  const { text } = await transport.request(formPath);
  let mapping = {};
  try { mapping = JSON.parse(process.env.VIRTUALYARD_CUSTOMER_FIELDS || '{}'); } catch { fail(503, 'Virtual Yard customer field mapping is invalid.'); }
  const body = customerPayload(text, { name, phone, email }, input.locationId, mapping);
  await transport.check();
  try {
    await collection.updateOne({ _id: key }, { $setOnInsert: { name, phone, email, site, state: 'pending', createdAt: new Date() } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const claimed = await collection.updateOne({ _id: key, state: { $in: ['pending', 'failed'] } }, { $set: { state: 'sending', updatedAt: new Date() } });
  if (!claimed.modifiedCount) fail(409, 'Customer creation is already in progress. Check Virtual Yard before retrying.');
  let result;
  try {
    const response = await transport.request(savePath, { method: 'POST', body });
    result = { state: 'synced', externalId: customerId(response.text), name, updatedAt: new Date() };
  } catch (error) {
    await collection.updateOne({ _id: key }, { $set: { state: error.mayHaveCreated ? 'unknown' : 'failed', message: error.message, updatedAt: new Date() } });
    throw error;
  }
  await collection.updateOne({ _id: key }, { $set: result });
  return { id: result.externalId, name, reused: false };
}

module.exports = { ensureCustomer, customerPayload, customerId, phoneKey };
