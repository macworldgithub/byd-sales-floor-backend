const browse = require('./crmBrowsing');
const { fail } = require('./accountAccess');
const isAdmin = user => ['super_admin', 'admin', 'site_admin'].includes(user?.role);
const day = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const addDays = (value, count) => new Date(Date.parse(`${value}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
function accountScope(user) {
  if (!user) fail(401, 'Authentication required.');
  if (isAdmin(user)) return { ...user, locked_site: '' };
  const site = user.locked_site || user.site || user.allowed_sites?.[0];
  if (!site || /^all(?:\s|$)/i.test(site)) fail(403, 'A Sales Floor site must be assigned to this account.');
  return { ...user, locked_site: site };
}
const readQuery = query => ({ ...query, site: query.filterSite || '', yard: '', location: '' });
const leadScope = user => browse.siteScope({}, accountScope(user), ['dealer', 'site', 'dealerName']);
const priority = { $or: [{ score: { $gte: 80 } }, { priority: { $in: [true, 'high', 'High', 'Urgent', 'urgent'] } }, { stage: { $in: ['NEW ENQUIRIES', 'Imported'] } }] };

async function leads(databases, query, user) {
  return browse.leads(databases.lead, readQuery(query), accountScope(user));
}
async function calendar(databases, query, user) {
  return browse.calendar(databases, readQuery(query), accountScope(user));
}
async function today(databases, query, user, now = new Date()) {
  const date = day(now), next = addDays(date, 1), scope = accountScope(user);
  const leadFilter = { $and: [leadScope(user), { isArchived: { $ne: true } }] };
  const attention = { $and: [leadFilter, priority] };
  const collection = databases.lead.collection('leads');
  const [totalLeads, needsMe, records, events, deliveries, conversations] = await Promise.all([
    collection.countDocuments(leadFilter), collection.countDocuments(attention),
    collection.find(attention).sort({ score: -1, createdAt: -1, _id: -1 }).limit(5).toArray(),
    browse.calendar(databases, { from: date, to: next, page: query.page || 1, limit: 25 }, scope),
    browse.calendar(databases, { from: date, to: addDays(date, 7), category: 'delivery', limit: 1 }, scope),
    databases.lead.collection('conversations').countDocuments({ $and: [browse.siteScope({}, scope, ['dealer', 'site']), { msgCount: { $gt: 0 } }] }),
  ]);
  return { success: true, data: { date, site: scope.locked_site || 'All Sites',
    stats: { totalLeads, needsMe, appointmentsToday: events.meta.sourceCounts.appointment, conversationPulse: conversations, deliveriesThisWeek: deliveries.pagination.total },
    leads: records, events: events.data, eventPagination: events.pagination, nextDelivery: deliveries.data[0] || null, nextEvent: events.meta.nextEvent } };
}
const escapeIcs = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');
function calendarIcs(events, now = new Date()) {
  const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OmniSuiteAI//Sales Floor//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) lines.push('BEGIN:VEVENT', `UID:${escapeIcs(event.id)}@sales-floor`, `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(event.date)}`, `DTEND:${stamp(event.endsAt)}`, `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs(event.subtitle)}`, `LOCATION:${escapeIcs(event.site)}`,
    `STATUS:${event.status === 'Cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(line => {
    let result = '', chunk = '';
    for (const character of line) {
      if (Buffer.byteLength(chunk + character, 'utf8') > 75) { result += chunk + '\r\n'; chunk = ' '; }
      chunk += character;
    }
    return result + chunk;
  }).join('\r\n') + '\r\n';
}
module.exports = { isAdmin, accountScope, leadScope, leads, calendar, today, day, addDays, calendarIcs };
