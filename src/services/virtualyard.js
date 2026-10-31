const session = require('./virtualyardSession');
const { siteKey, fail } = require('./accountAccess');

function decode(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
}
function optionsFromForm(html, field) {
  const select = html.match(new RegExp(`<select[^>]*name=["']dealerTestDrive-${field}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
  if (!select) fail(502, 'Virtual Yard booking form changed. Could not load booking options.');
  return [...select[1].matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)]
    .filter(match => match[1]).map(match => ({ id: match[1], name: decode(match[2]) }));
}
async function metadata(user = {}) {
  const { text } = await session.request('/render.php?page=test-drive&params=&auto=add');
  const yards = optionsFromForm(text, 'locationId').filter(yard => !user.locked_site || siteKey(yard.name) === siteKey(user.locked_site))
    .filter(yard => !Array.isArray(user.allowed_sites) || user.all_sites || user.allowed_sites.some(site => siteKey(site) === siteKey(yard.name)));
  return { yards, statuses: optionsFromForm(text, 'status'), bookingTypes: optionsFromForm(text, 'bookingType') };
}
const KEYS = { vehicles: 'vehicles-demonstrator-adv', users: 'users', customers: 'customers' };
const LOCAL_STATUS = { P: 'Pending', C: 'Confirmed', I: 'In-Progress', F: 'Completed', R: 'Rescheduled', X: 'Cancelled', M: 'No Show' };
async function lookupRows(kind, query, limit) {
  if (!Object.hasOwn(KEYS, kind)) fail(400, 'Unsupported Virtual Yard lookup.');
  const key = KEYS[kind];
  const q = String(query).trim().slice(0, 120);
  const rows = await session.json(`/ajax/JSON/lookup.php?${new URLSearchParams({ key, [key]: q, categoryId: '0', limit: String(limit) })}`, { timeoutMs: limit > 10000 ? 60000 : 20000 });
  if (!Array.isArray(rows)) fail(502, 'Invalid Virtual Yard lookup response.');
  return rows;
}

async function normalizeLookup(kind, rows, user) {
  const idKey = { vehicles: 'vehicleId', users: 'userId', customers: 'customerId' }[kind];
  // A no-match response contains a UI action and SQL diagnostic, not a real record.
  rows = [...new Map(rows.filter(row => row && /^\d+$/.test(String(row[idKey] || '')) && Number(row[idKey]) > 0 &&
    typeof (row.name || row.value) === 'string' && (row.name || row.value).trim() && !row.noResultsAction)
    .map(row => [String(row[idKey]), row])).values()];
  if (kind === 'vehicles') {
    const { yards } = await metadata(user);
    return rows.filter(row => yards.some(yard => yard.id === String(row.locationId))).map(row => ({
      id: String(row.vehicleId), name: row.name || row.value, locationId: String(row.locationId), registration: row.registrationNo || '',
    }));
  }
  return rows.map(row => ({ id: String(kind === 'users' ? row.userId : row.customerId), name: row.name || row.value,
    ...(kind === 'customers' ? { phone: row.mobile || row.phone || '' } : {}) }));
}

async function lookup(kind, query = '', user = {}) {
  // Used to validate a selected booking against current upstream matches.
  let limit = 1000;
  for (;;) {
    const rows = await lookupRows(kind, query, limit);
    if (rows.length < limit) return normalizeLookup(kind, rows, user);
    if (limit >= 50000) fail(502, 'Virtual Yard returned too many matches. Enter a more specific search.');
    limit = Math.min(limit * 2, 50000);
  }
}

async function lookupPage(kind, query = '', user = {}, requestedLimit = 1000) {
  const limit = Number(requestedLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50000) fail(400, 'Invalid Virtual Yard lookup limit.');
  // Offset/page are ignored upstream. Request a live prefix plus one record to
  // expose whether more matches exist, instead of silently hiding them at 100.
  const rows = await lookupRows(kind, query, limit + 1);
  return { data: await normalizeLookup(kind, rows.slice(0, limit), user), hasMore: rows.length > limit, limit };
}

function melbourneTime(value) {
  const date = new Date(value);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(String(value)) || Number.isNaN(date.getTime())) fail(400, 'Booking time must include a timezone.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function prepare(data, user = {}) {
  if ((data.type || 'Test Drive') !== 'Test Drive') return null;
  const selected = data.virtualyard || {};
  const meta = await metadata(user);
  const site = user.locked_site || data.site || data.dealership || user.site;
  const yard = meta.yards.find(row => siteKey(row.name) === siteKey(site));
  if (!yard || (selected.locationId && String(selected.locationId) !== yard.id)) fail(400, 'Select a Virtual Yard yard matching this appointment site.');
  const [vehicles, users, customers] = await Promise.all([
    lookup('vehicles', selected.vehicleName || data.vehicle || '', user),
    lookup('users', selected.userName || data.consultantName || user.name || '', user),
    lookup('customers', selected.customerName || data.prospectName || data.customer_name || '', user),
  ]);
  const choose = (rows, id, name, label) => {
    const matches = rows.filter(row => id ? row.id === String(id) : String(row.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    if (matches.length !== 1) fail(400, `Select a valid Virtual Yard ${label}.`);
    return matches[0];
  };
  const vehicle = choose(vehicles.filter(row => row.locationId === yard.id), selected.vehicleId, data.vehicle, 'demo vehicle');
  const salesperson = choose(users, selected.userId, data.consultantName || user.name, 'salesperson');
  const customer = choose(customers, selected.customerId, data.prospectName || data.customer_name, 'driver');
  const status = selected.status || ({ Proposed: 'P', Pending: 'P', Confirmed: 'C', 'In-Progress': 'I', Completed: 'F', Rescheduled: 'R', Cancelled: 'X', 'No Show': 'M' }[data.status || 'Confirmed']);
  const bookingType = selected.bookingType || 'T';
  if (!meta.statuses.some(row => row.id === status) || !meta.bookingTypes.some(row => row.id === bookingType)) fail(400, 'Invalid Virtual Yard booking type or status.');
  return { vehicleId: vehicle.id, vehicleName: vehicle.name, userId: salesperson.id, userName: salesperson.name,
    customerId: customer.id, customerName: customer.name, locationId: yard.id, yardName: yard.name, status, bookingType,
    bookingDateTime: melbourneTime(data.when) };
}

function payload(appointment) {
  const v = appointment.virtualyard;
  return new URLSearchParams({
    'vehicles-testDriveVehicle': v.vehicleName, 'dealerTestDrive-id': '', 'dealerTestDrive-vehicleId': v.vehicleId,
    'dealerTestDrive-status': v.status, 'dealerTestDrive-locationId': v.locationId,
    'testDriveUser-testDriveUserFullName': v.userName, 'dealerTestDrive-bookingDateTime': v.bookingDateTime,
    'datetimeValidation[dealerTestDrive-bookingDateTime]': 'Timestamp', 'testDriveCustomer-testDriveFullName': v.customerName,
    'addNew[testDriveCustomer-testDriveFullName]': '1', 'testDriveCustomer-testDriveFullName:linkedId': 'customerId',
    'testDriveCustomer-testDriveFullName:insertingClass': '', 'dealerTestDrive-bookingType': v.bookingType,
    'dealerTestDrive-confirmed': '', 'dealerTestDrive-customerId': v.customerId, 'dealerTestDrive-userId': v.userId,
    'dealerTestDrive-testDriveDate': '', 'dealerTestDrive-testDriveTime': '',
    'dealerTestDrive-notes-base64': Buffer.from([appointment.notes, appointment.loop, `CRM booking: ${appointment._id}`].filter(Boolean).join('\n'), 'utf8').toString('base64'),
  }).toString();
}

function savedId(text) {
  let result;
  try { result = JSON.parse(text.trim()); } catch (_) { throw Object.assign(new Error('Virtual Yard save response was not recognised. Check Virtual Yard before retrying.'), { mayHaveCreated: true }); }
  if (result?.error || result?.success === false) throw Object.assign(new Error('Virtual Yard rejected this booking. Check its required fields and session.'), { mayHaveCreated: false });
  // The native save handler returns an array of { class, id } records.
  const record = Array.isArray(result) ? result.find(row => row.class === 'dealerTestDrive') : null;
  if (!record?.id || !/^\d+$/.test(String(record.id))) throw Object.assign(new Error('Virtual Yard did not confirm a booking ID. Check Virtual Yard before retrying.'), { mayHaveCreated: true });
  return String(record.id);
}

async function validateRetry(appointment, user) {
  const v = appointment.virtualyard;
  if (!v || melbourneTime(appointment.when) !== v.bookingDateTime ||
      siteKey(appointment.site || appointment.dealership) !== siteKey(v.yardName) ||
      appointment.vehicle !== v.vehicleName || appointment.consultantName !== v.userName ||
      appointment.status !== LOCAL_STATUS[v.status]) {
    fail(409, 'Appointment details changed after booking. Resolve them in Virtual Yard before retrying.');
  }
  const { yards } = await metadata(user);
  if (!yards.some(yard => yard.id === v.locationId)) fail(403, 'This Virtual Yard yard is not available to your account.');
}

async function sync(appointment, collection) {
  if (!appointment.virtualyard) return appointment;
  // Preflight failures are safe to retry; uncertain POST results never replay automatically.
  try { await session.check(); }
  catch (error) {
    await collection.updateOne({ _id: appointment._id, 'virtualyardSync.state': { $in: ['pending', 'failed'] } }, { $set: { virtualyardSync: { state: 'failed', message: error.message, updatedAt: new Date() } } });
    return collection.findOne({ _id: appointment._id });
  }
  const claimed = await collection.updateOne({ _id: appointment._id, 'virtualyardSync.state': { $in: ['pending', 'failed'] } }, { $set: { virtualyardSync: { state: 'sending', updatedAt: new Date() } } });
  if (!claimed.modifiedCount) return collection.findOne({ _id: appointment._id });
  let state;
  try {
    // Use immutable booking fields even if the CRM appointment was edited before a retry.
    const { text } = await session.request('/save/save.php?page=test-drive&auto=add', { method: 'POST', body: payload(appointment) });
    state = { state: 'synced', externalId: savedId(text), updatedAt: new Date() };
  } catch (error) {
    state = { state: error.mayHaveCreated ? 'unknown' : 'failed', message: error.message, updatedAt: new Date() };
  }
  // If this write fails, leave 'sending' in storage: a replay could duplicate an accepted booking.
  await collection.updateOne({ _id: appointment._id }, { $set: { virtualyardSync: state } });
  return collection.findOne({ _id: appointment._id });
}

module.exports = { metadata, lookup, lookupPage, prepare, payload, savedId, sync, melbourneTime, optionsFromForm, validateRetry, LOCAL_STATUS };
