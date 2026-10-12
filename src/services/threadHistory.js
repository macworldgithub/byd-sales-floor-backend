const { phoneRegex } = require('./smsEvent');
// Thread history reads original records from both stores, including old and bulk SMS.
function phoneKey(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) digits = '61' + digits.slice(1);
  if (/^4\d{8}$/.test(digits)) digits = '61' + digits;
  return digits;
}
function siteKey(value) {
  return String(value || '').toLowerCase().replace(/^byd\s+/, '').replace(/[^a-z0-9]/g, '').replace(/vic$/, '').replace(/^melbourne(cbd|city)$/, 'melbourne');
}
function allowedSite(user, site) {
  if (!user || user.role === 'contractor') return false;
  if (user.locked_site) return !!siteKey(site) && siteKey(site) === siteKey(user.locked_site);
  if (Array.isArray(user.sites) && user.sites.length) return user.sites.some(s => siteKey(s) === siteKey(site));
  if (['super_admin', 'admin'].includes(user.role) || user.network_lookup) return true;
  return !!siteKey(user.site) && siteKey(site) === siteKey(user.site);
}
const statusRank = { failed: 6, error: 6, delivered: 5, received: 5, sent: 3, success: 3, simulated: 2, queued: 1 };
function mergeMessages(rows) {
  const result = new Map();
  for (const row of rows) {
    const direction = row.sender === 'user' ? 'inbound' : 'outbound';
    const key = direction + ':' + row.id;
    const previous = result.get(key);
    if (!previous) result.set(key, row);
    else if ((statusRank[row.status] || 0) > (statusRank[previous.status] || 0)) result.set(key, { ...previous, status: row.status });
  }
  return [...result.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
function buildThreads(conversations, messages, leads, clients) {
  const groups = new Map();
  const records = [...leads.map(l => ({ ...l, site: l.dealer || l.site })), ...clients.map(c => ({ ...c, site: c.site_location || c.site }))];
  function group(phone, site, metadata) {
    const key = siteKey(site) + ':' + (phoneKey(phone) || metadata._id);
    if (!groups.has(key)) groups.set(key, { ...metadata, phone: phoneKey(phone) ? '+' + phoneKey(phone) : phone, dealer: site || '', messages: [] });
    return groups.get(key);
  }
  for (const c of conversations) {
    const g = group(c.phone, c.dealer, c);
    g.threadIds ||= [];
    g.threadIds.push(String(c._id));
    g.leadId ||= c.leadId;
    g.manualProspectId ||= c.manualProspectId;
    g.messages.push(...(c.messages || []));
  }
  for (const m of messages) {
    const matches = records.filter(r => phoneKey(r.phone) && phoneKey(r.phone) === phoneKey(m.phone));
    const client = clients.find(c => m.client_id && [c.id, String(c._id)].includes(String(m.client_id)));
    const sites = [...new Set(matches.map(r => siteKey(r.site)).filter(Boolean))];
    const conversationSites = conversations.filter(c => phoneKey(c.phone) === phoneKey(m.phone)).map(c => c.dealer);
    const uniqueConvoSites = [...new Set(conversationSites.map(siteKey).filter(Boolean))];
    const correlation = m.direction === 'inbound' ? m.provider_response?.original_message_id : null;
    const original = correlation ? messages.find(row => row.direction === 'outbound' && String(row.provider_message_id) === String(correlation)) : null;
    const originalClient = original?.client_id ? clients.find(c => [c.id, String(c._id)].includes(String(original.client_id))) : null;
    const correlatedThread = correlation ? conversations.find(c => (c.messages || []).some(msg => msg.sender !== 'user' && String(msg.id) === String(correlation))) : null;
    const sourceThread = conversations.find(c => (c.messages || []).some(msg => String(msg.id) === String(m.provider_message_id)));
    const site = m.site || original?.site || originalClient?.site_location || originalClient?.site || correlatedThread?.dealer || sourceThread?.dealer || client?.site_location || client?.site || (sites.length === 1 ? matches.find(r => siteKey(r.site))?.site : '') || (sites.length <= 1 && uniqueConvoSites.length === 1 ? conversationSites[0] : '');
    const lead = matches.find(r => r.dealer && siteKey(r.dealer) === siteKey(site));
    const g = group(m.phone, site, {
      prospectName: m.client_name || client?.name || lead?.name || m.phone,
      leadId: lead?._id, client_id: client?.id || (client?._id ? String(client._id) : null), control: 'Human', status: 'Contact',
    });
    g.messages.push({ id: String(m.provider_message_id || m.id || m._id), sender: m.direction === 'inbound' ? 'user' : 'agent', text: m.body, status: m.status, createdAt: m.sent_at || m.createdAt, time: m.sent_at || m.createdAt });
  }
  return [...groups.values()].map(g => {
    g.messages = mergeMessages(g.messages);
    const last = g.messages.at(-1);
    return { ...g, control: 'Human', msgCount: g.messages.length, lastMessage: last?.text || '', lastMessageAt: last?.createdAt || g.lastMessageAt };
  }).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
}
async function getThreads(leadDb, deliveryDb, user, requestedSite, options = {}) {
  const filter = options.phone ? { phone: phoneRegex(options.phone) } : {};
  const [conversations, messages, leads, clients] = await Promise.all([
    leadDb.collection('conversations').find(filter).toArray(),
    deliveryDb.collection('messages').find(filter).toArray(),
    leadDb.collection('leads').find(filter, { projection: { name: 1, phone: 1, dealer: 1, site: 1 } }).toArray(),
    deliveryDb.collection('clients').find(filter, { projection: { id: 1, name: 1, phone: 1, site_location: 1, site: 1 } }).toArray(),
  ]);
  const threads = buildThreads(conversations, messages, leads, clients).filter(t => allowedSite(user, t.dealer) && (!requestedSite || /^(all|all sites|all locations|all yards)$/i.test(requestedSite) || siteKey(t.dealer) === siteKey(requestedSite)));
  // Materialize an empty identity for a delivery-only thread, enabling replies
  // without inventing an opening message or assigning a client ID as a lead ID.
  for (const t of threads) {
    if (!t._id) {
      const doc = await leadDb.collection('conversations').findOneAndUpdate(
        { _id: new (require('mongoose').Types.ObjectId)(require('crypto').createHash('sha256').update(siteKey(t.dealer) + ':' + phoneKey(t.phone)).digest('hex').slice(0, 24)) },
        { $setOnInsert: { phone: t.phone, dealer: t.dealer, prospectName: t.prospectName, leadId: t.leadId || null, control: 'Human', messages: [], createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      t._id = doc._id;
    }
  }
  // Combine only the messages the user is allowed to see, one thread per phone.
  const unified = new Map();
  for (const t of threads) {
    const key = phoneKey(t.phone) || String(t._id);
    if (!unified.has(key)) unified.set(key, { ...t, messages: [], threadIds: [], sites: [] });
    const entry = unified.get(key);
    entry.messages.push(...t.messages);
    entry.threadIds.push(...(t.threadIds || [String(t._id)]));
    entry.sites.push(t.dealer);
    entry.client_id ||= t.client_id;
    entry.leadId ||= t.leadId;
  }
  return [...unified.values()].map(t => {
    t.messages = mergeMessages(t.messages);
    const last = t.messages.at(-1);
    return { ...t, control: 'Human', msgCount: t.messages.length, lastMessage: last?.text || '', lastMessageAt: last?.createdAt || t.lastMessageAt };
  }).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
}
module.exports = { phoneKey, siteKey, allowedSite, mergeMessages, buildThreads, getThreads };
