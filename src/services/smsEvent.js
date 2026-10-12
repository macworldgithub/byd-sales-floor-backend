function phoneKey(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) digits = '61' + digits.slice(1);
  if (/^4\d{8}$/.test(digits)) digits = '61' + digits;
  return digits;
}
function phoneRegex(value) {
  const digits = phoneKey(value);
  if (!digits) return /^$/;
  const national = /^61\d{9}$/.test(digits) ? digits.slice(2) : digits;
  const prefix = national.length === 9 ? '(?:61\\D*|0\\D*)?' : '';
  return new RegExp('^\\D*' + prefix + national.split('').join('\\D*') + '\\D*$');
}
function inboundId(payload, phone, text) {
  const explicit = payload.message_id || payload.MessageId || payload.id;
  if (explicit) return String(explicit);
  if (!payload.received_at) return 'in-' + require('crypto').randomUUID();
  const event = [phoneKey(phone), phoneKey(payload.to), String(text).trim(), String(payload.received_at), String(payload.type || 'inbound').toLowerCase(), String(payload.original_message_id || '')];
  return 'in-' + require('crypto').createHash('sha256').update(JSON.stringify(event)).digest('hex');
}
function receivedAt(payload) {
  let stamp = String(payload.received_at || '');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(stamp)) stamp = stamp.replace(' ', 'T') + 'Z';
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
function inboundDocumentId(id) {
  return require('crypto').createHash('sha256').update('sms-inbound:' + id).digest('hex').slice(0, 24);
}
function inboundSite(original, source, leads, clients) {
  const { siteKey } = require('./threadHistory');
  const originalClient = original?.client_id ? clients.find(c => [c.id, String(c._id)].includes(String(original.client_id))) : null;
  const correlated = original?.site || originalClient?.site_location || originalClient?.site || source?.dealer;
  if (correlated) return correlated;
  const sites = [...leads.map(l => l.dealer || l.site), ...clients.map(c => c.site_location || c.site)].filter(Boolean);
  return new Set(sites.map(siteKey)).size === 1 ? sites[0] : '';
}
module.exports = { phoneRegex, inboundId, receivedAt, inboundDocumentId, inboundSite };
