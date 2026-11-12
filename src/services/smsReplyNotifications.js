const crypto = require('crypto');
const { siteKey: accountSiteKey, fail } = require('./accountAccess');
const { phoneKey, allowedSite, getThreads } = require('./threadHistory');
const collection = db => db.collection('sms_reply_notifications');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const siteKey = value => { const key = accountSiteKey(value); return ['melbournecbd','melbournecity','melbourne'].includes(key) ? 'melbournecity' : key; };
const reader = user => digest(String(user.email || user.id).trim().toLowerCase());

async function recordReply(db, message, metadata = {}) {
  if (message.direction !== 'inbound' || !message.site || !phoneKey(message.phone) || !message.provider_message_id) return;
  const id = digest('sms-reply:' + message.provider_message_id);
  const row = { _id: id, id, message_id: String(message.provider_message_id), type: 'sms_reply',
    phone: message.phone, phone_key: phoneKey(message.phone), site: siteKey(message.site), site_name: message.site,
    sender_name: message.client_name || metadata.name || message.phone, preview: String(message.body || '').slice(0, 500),
    client_id: metadata.client_id || message.client_id || null, lead_id: metadata.lead_id || null,
    customer_id: metadata.customer_id || null, sent_at: new Date(message.sent_at || new Date()).toISOString(), created_at: new Date(), read_by: [] };
  await collection(db).updateOne({ _id: id }, { $setOnInsert: row }, { upsert: true });
  return id;
}
function scope(user, requested) {
  if (user.role === 'contractor') fail(403, 'SMS access is not assigned.');
  const explicit = requested && !/^all(?:\s|$)/i.test(requested) ? requested : null;
  if (explicit && !allowedSite(user, explicit)) fail(403, 'Site access denied.');
  const site = user.locked_site || explicit;
  if (site) return { site: siteKey(site) };
  if (Array.isArray(user.allowed_sites) && !user.all_sites) return { site: { $in: user.allowed_sites.map(siteKey) } };
  if (user.all_sites === true || ['super_admin','admin','site_admin'].includes(user.role) || user.network_lookup) return { site: { $ne: '' } };
  if (Array.isArray(user.sites) && user.sites.length) return { site: { $in: user.sites.map(siteKey) } };
  return { site: siteKey(user.site || '__unassigned__') };
}
async function list(db, user, query = {}) {
  const base = scope(user, query.site), key = reader(user), limit = 20;
  const offset = Number(query.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, 'Invalid notification page.');
  const filter = query.all === 'true' ? base : { ...base, read_by: { $ne: key } };
  const [rows, unread] = await Promise.all([
    collection(db).find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit + 1).toArray(),
    collection(db).countDocuments({ ...base, read_by: { $ne: key } }),
  ]);
  return { items: rows.slice(0,limit).map(({ _id, read_by, phone_key, ...row }) => ({ ...row, read: (read_by || []).includes(key) })), unread_count: unread, has_more: rows.length > limit, next_offset: offset + limit };
}
async function notification(db, user, id) {
  if (!/^[a-f\d]{64}$/.test(String(id))) fail(404, 'Notification not found.');
  const row = await collection(db).findOne({ _id: id, ...scope(user) });
  if (!row || !allowedSite(user, row.site_name)) fail(404, 'Notification not found.');
  return row;
}
async function read(db, user, id, seen = []) {
  const row = await notification(db, user, id);
  if (!Array.isArray(seen) || seen.length > 100 || seen.some(value => typeof value !== 'string' || value.length > 200)) fail(400, 'Invalid viewed messages.');
  await collection(db).updateMany({ site: row.site, phone_key: row.phone_key,
    $or: [{ _id: row._id }, { message_id: { $in: seen } }] }, { $addToSet: { read_by: reader(user) } });
}
async function conversation(panel, lead, user, id) {
  const row = await notification(panel, user, id);
  const threads = await getThreads(lead, panel, user, row.site_name, { phone: row.phone });
  const thread = threads.find(t => phoneKey(t.phone) === row.phone_key);
  if (!thread) fail(404, 'Conversation is unavailable.');
  return { recipient: { phone: row.phone, site: row.site_name, client_id: thread.client_id || undefined, name: thread.prospectName || row.sender_name },
    messages: thread.messages.filter(m => m.sender !== 'system').slice(-100).map(m => ({ id: m.id, body: m.text, direction: m.sender === 'user' ? 'inbound' : 'outbound', sent_at: m.createdAt, status: m.status })) };
}
module.exports = { recordReply, scope, list, read, conversation, reader };
