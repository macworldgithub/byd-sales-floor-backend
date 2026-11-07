const { fail, siteKey, SITES, canonicalSite } = require('./accountAccess');
const { siteScope, dayStart } = require('./crmBrowsing');
const normalizeAustralianPhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^04\d{8}$/.test(digits) ? '+61' + digits.slice(1) : /^614\d{8}$/.test(digits) ? '+' + digits : /^4\d{8}$/.test(digits) ? '+61' + digits : digits;
};
const MANAGEMENT = ['sales_manager', 'manager', 'site_admin', 'super_admin', 'admin', 'principal', 'bdc'];
const isManager = user => MANAGEMENT.includes(user.role);
const literal = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp(`^${literal(value)}$`, 'i');
const stages = { Imported: 'NEW ENQUIRIES', Engaged: 'IN FOLLOW-UP', Qualified: 'AI QUALIFYING', Committed: 'COMMITTED',
  Delivered: 'DELIVERED', Lost: 'LOST' };
const active = row => !['DELIVERED', 'LOST', 'OPTED OUT'].includes(row.stage) && !row.isArchived;
function stage(value) {
  const result = stages[value] || value || 'NEW ENQUIRIES';
  if (![...Object.values(stages), 'TEST DRIVE BOOKED', 'OPTED OUT'].includes(result)) fail(400, 'Select a valid lead stage.');
  return result;
}
function scope(user, query = {}, fields = ['dealer', 'site']) {
  const selected = user.locked_site || query.site || user.site;
  if (selected && !/^all(?:\s|$)/i.test(selected) && !canonicalSite(selected)?.startsWith('BYD')) fail(403, 'This mobile workspace is configured for BYD sites.');
  if (!selected || /^all(?:\s|$)/i.test(selected)) {
    if (!isManager(user) || !user.all_sites) fail(403, 'Select an assigned site.');
  } else if (Array.isArray(user.allowed_sites) && !user.all_sites && !user.allowed_sites.some(s => siteKey(s) === siteKey(selected))) fail(403, 'Site access denied.');
  const conditions = [!selected || /^all(?:\s|$)/i.test(selected) ? { $or: SITES.filter(s => s.startsWith('BYD')).map(site => siteScope({ site }, {}, fields)) } : siteScope({ site: selected }, {}, fields)];
  if (!isManager(user)) conditions.push({ $or: [{ assignedTo: exact(user.email) }, { assignedTo: user.id },
    { allocatedPersonFullName: exact(user.name) }, { owner_user_id: user.id }, { owner_name: exact(user.name) },
    { consultantName: exact(user.name) }, { consultant: exact(user.name) }, { consultantId: user.id }, { salesperson: exact(user.name) }, { agent: exact(user.name) },
    { assigned_agent_id: user.id }, { contractorIds: user.id }] });
  return { $and: conditions };
}
function customer(input) {
  const name = String(input.name || '').trim(), phone = normalizeAustralianPhone(input.phone), email = String(input.email || '').trim().toLowerCase();
  if (!name || !/^\+614\d{8}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Name, Australian mobile and valid email are required.');
  const contacts = Array.isArray(input.companyContacts) ? input.companyContacts : [];
  if (contacts.length > 50) fail(400, 'A business can have at most 50 linked contacts.');
  if (contacts.length && !String(input.businessName || '').trim()) fail(400, 'Enter the business name before linking contacts.');
  for (const contact of contacts) if (!String(contact.name || '').trim() || !/^\+614\d{8}$/.test(normalizeAustralianPhone(contact.phone)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email || ''))) fail(400, 'Each business contact needs a name, valid mobile and email.');
  return { name, phone, email, businessName: String(input.businessName || '').trim().slice(0, 160), abn: String(input.abn || '').trim(),
    companyContacts: contacts.map(c => ({ name: String(c.name || '').trim(), role: String(c.role || '').trim(),
      phone: c.phone ? normalizeAustralianPhone(c.phone) : '', email: String(c.email || '').trim().toLowerCase() })).filter(c => c.name) };
}
function ageBucket(days) { return !Number.isFinite(days) ? 'Unknown' : days <= 30 ? '0-30' : days <= 60 ? '31-60' : days < 90 ? '61-89' : '90+'; }
function stockStatus(value) {
  const v = String(value || '').toLowerCase().trim();
  if (/sold|delivered/.test(v)) return 'Sold';
  if (/held|hold|pending|reserved|allocated/.test(v)) return 'Deal Pending';
  if (/transit|inbound/.test(v)) return 'In Transit';
  return /^(available|in stock|instock|on hand)$/.test(v) ? 'In Stock' : 'Unknown';
}
const DEFAULTS = { followupAmberHours: 24, followupRedHours: 72, conversionAmber: 20, conversionGreen: 30,
  alertTypes: ['high_buyer', 'price_objection', 'high_risk'], aiMode: 'approval', aiResumeHours: 0, videoUrls: [], welcomeText: '', surveyUrl: '',
  geofence: null, salesSeeCost: false, salesSeePrice: true, smsSenderId: '', journey: null };
function settings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Site settings are required.');
  const result = { ...DEFAULTS, ...input };
  if (Object.keys(input).some(k => !Object.hasOwn(DEFAULTS, k))) fail(400, 'Unsupported site setting.');
  for (const key of ['followupAmberHours', 'followupRedHours', 'conversionAmber', 'conversionGreen']) if (!Number.isFinite(result[key])) fail(400, 'PULSE thresholds must be numbers.');
  for (const key of ['salesSeeCost', 'salesSeePrice']) if (typeof result[key] !== 'boolean') fail(400, 'Pricing permissions must be enabled or disabled.');
  for (const key of ['smsSenderId', 'welcomeText', 'surveyUrl']) if (typeof result[key] !== 'string') fail(400, 'Invalid site communication setting.');
  if (!(result.followupAmberHours > 0 && result.followupRedHours >= result.followupAmberHours && result.followupRedHours <= 720) ||
    !(result.conversionAmber >= 0 && result.conversionGreen >= result.conversionAmber && result.conversionGreen <= 100)) fail(400, 'Invalid PULSE thresholds.');
  if (!Array.isArray(result.alertTypes) || result.alertTypes.some(t => !DEFAULTS.alertTypes.includes(t))) fail(400, 'Invalid alert category.');
  if (!['off', 'approval'].includes(result.aiMode)) fail(400, 'AI follow-ups require staff approval.');
  if (!Number.isFinite(result.aiResumeHours) || result.aiResumeHours < 0 || result.aiResumeHours > 720) fail(400, 'Invalid AI inactivity interval.');
  const journey = require('./floorJourney');
  if (!Array.isArray(result.videoUrls) || result.videoUrls.length > 10 || result.videoUrls.some(v => !journey.httpsUrl(v))) fail(400, 'Vehicle video links must use HTTPS.');
  if (result.surveyUrl && !journey.httpsUrl(result.surveyUrl)) fail(400, 'Survey link must use HTTPS.');
  if (result.welcomeText.length > 3000) fail(400, 'Welcome message must be at most 3000 characters.');
  result.journey = journey.validateJourney(result.journey);
  if (!result.journey && result.welcomeText) journey.validateJourney({ steps: journey.STEPS.map(step => ({ ...step, ...(step.key === 'welcome' ? { template: result.welcomeText } : {}) })) });
  if (result.geofence && (!Number.isFinite(result.geofence.latitude) || Math.abs(result.geofence.latitude) > 90 || !Number.isFinite(result.geofence.longitude) || Math.abs(result.geofence.longitude) > 180 || !(result.geofence.radiusMeters > 0 && result.geofence.radiusMeters <= 5000))) fail(400, 'Invalid dealership geofence.');
  return result;
}
function classify(text) {
  const value = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
  const matched = [];
  const buyer = /ready to buy|come in today|book (?:an? |the )?appointment|finance|financing|pric(?:e|ing)|quot(?:e|es)|trade[ -]?in|repayment|compar(?:e|ing).*(?:brand|tesla|kia|hyundai)|competitor|(?:tesla|kia|hyundai|chery).*(?:offer|quote)/;
  if (buyer.test(value)) matched.push('high_buyer');
  if (/too expensive|outside my budget|better deal|do any better|over (?:my )?budget/.test(value)) matched.push('price_objection');
  if (/need to think|not right now|still looking|leave it with me|i'?ll get back to you/.test(value)) matched.push('high_risk');
  return matched;
}
function assertAiReply(text) {
  if (!String(text || '').trim() || /[$£€]|\b(?:price|pricing|costs?|discount|trade[ -]?in|valuation|repayment|finance offer|aud|dollars?|grand|cheaper|expensive)\b/i.test(text)) fail(400, 'AI may only discuss verified product features, opening times and general information. Pricing and trade values require a person.');
  return text;
}
function approvedFacts(documents) {
  const facts = [];
  for (const [index, document] of documents.entries()) for (const [part, text] of String(document.content || '').split(/(?<=[.!?])\s+|\n+/).entries()) {
    if (!text.trim() || text.length > 1600) continue;
    try { assertAiReply(text); facts.push({ id: `${index}:${part}`, text: text.trim(), source: document.sourceUrl }); } catch { /* Pricing/trade content is never sent to the drafting provider. */ }
  }
  return facts.slice(0, 500);
}
function renderFacts(ids, facts) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 5 || ids.some(key => typeof key !== 'string' || !facts.some(fact => fact.id === key))) fail(502, 'AI did not select valid approved product facts. Write a manual reply instead.');
  const selected = [...new Set(ids)].map(key => facts.find(fact => fact.id === key));
  return { text: assertAiReply(selected.map(fact => fact.text).join(' ')), sources: [...new Set(selected.map(fact => fact.source))] };
}
function period(value = 'today', now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  let from = day;
  if (value === 'weekly') from = new Date(Date.parse(`${day}T12:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  else if (value === 'mtd') from = day.slice(0, 8) + '01';
  else if (value !== 'today') fail(400, 'Select Today, Weekly or MTD.');
  return { from: dayStart(from), to: new Date(now), month: day.slice(0, 7) };
}
function geofence(lat, lon, site) {
  if (!site) return null;
  const radians = value => value * Math.PI / 180;
  const a = Math.sin(radians(lat - site.latitude) / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(site.latitude)) * Math.sin(radians(lon - site.longitude) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
module.exports = { isManager, scope, customer, stage, active, ageBucket, stockStatus, settings, DEFAULTS, classify, assertAiReply, approvedFacts, renderFacts, period, geofence, exact, literal };
