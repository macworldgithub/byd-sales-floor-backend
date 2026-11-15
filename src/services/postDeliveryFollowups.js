const { fail } = require('./accountAccess');
const { assertSite } = require('./customerDelivery');
const { siteScope } = require('./crmBrowsing');

const managers = new Set(['super_admin', 'admin', 'site_admin', 'manager', 'sales_manager']);
const literal = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scope(user) {
  const clauses = [];
  if (user.locked_site) clauses.push(siteScope({}, user));
  else if (Array.isArray(user.allowed_sites) && !user.all_sites) {
    if (!user.allowed_sites.length) return { _id: '__no_assigned_site__' };
    clauses.push({ $or: user.allowed_sites.map(site => siteScope({ site })) });
  } else if (!user.all_sites && !managers.has(user.role)) clauses.push(siteScope({ site: user.site || '__unassigned__' }));
  if (!managers.has(user.role)) clauses.push({ $or: [
    { salesperson_id: String(user.id) },
    { salesperson_id: null, salesperson_name: new RegExp(`^${literal(user.name || '__unassigned__')}$`, 'i') },
  ] });
  return clauses.length ? { $and: clauses } : {};
}
async function list(db, user, site) {
  return db.collection('post_delivery_followups').find({ $and: [scope(user), siteScope({ site }, user), { status: 'open', due_at: { $lte: new Date() } }] }, { projection: { _id: 0 } }).sort({ due_at: 1 }).limit(100).toArray();
}
async function complete(db, id, input, user) {
  if (!/^[a-f0-9]{64}$/.test(id)) fail(404, 'Follow-up not found.');
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (!notes || notes.length > 2000) fail(400, 'Record call notes (1–2,000 characters).');
  if (!['Contacted', 'Voicemail', 'No answer', 'Call scheduled'].includes(input.call_outcome)) fail(400, 'Choose the call outcome.');
  if (!['Text sent', 'Text planned', 'No text required'].includes(input.text_action)) fail(400, 'Record the text action.');
  const tasks = db.collection('post_delivery_followups');
  let row = await tasks.findOne({ $and: [{ id }, scope(user)] });
  if (!row) fail(404, 'Follow-up not found.');
  assertSite(user, row);
  if (!['open', 'completed'].includes(row.status)) fail(409, 'This follow-up is no longer active.');
  const at = new Date();
  const updates = { status: 'completed', notes, call_outcome: input.call_outcome, text_action: input.text_action,
    completed_at: at, completed_by: user.id, completed_by_name: user.name,
    completed_platform: user.platform === 'sales_floor' ? 'sales_floor' : 'crm' };
  if (row.status !== 'completed') {
    await tasks.updateOne({ id, status: 'open' }, { $set: updates });
    row = await tasks.findOne({ id });
  }
  // Project the persisted winner, including when repairing a prior partial write.
  const recordedAt = row.completed_at;
  const content = `${row.call_outcome}. ${row.notes}\nText action: ${row.text_action}`;
  const eventId = `POST-DELIVERY-FOLLOWUP-${id}`;
  await db.collection('timelineevents').updateOne({ event_id: eventId }, { $setOnInsert: {
    event_id: eventId, customer_id: row.customer_id, client_id: row.client_id, type: 'call', event_type: 'call',
    title: 'Day 3 post-delivery follow-up completed', content,
    author_name: row.completed_by_name, author: row.completed_by_name, author_id: row.completed_by,
    source: row.completed_platform === 'sales_floor' ? 'Sales Floor' : 'Sales CRM', source_system: row.completed_platform || 'crm',
    occurred_at: recordedAt, timestamp: recordedAt, createdAt: recordedAt, visibility: 'internal',
  } }, { upsert: true });
  if (row.client_id) await db.collection('clients').updateOne({ id: row.client_id, 'comments.id': { $ne: eventId } }, { $push: { comments: {
    id: eventId, author_id: row.completed_by, author_name: row.completed_by_name, body: content, created_at: recordedAt,
  } } });
  return { ...row, _id: undefined };
}
module.exports = { scope, list, complete };
