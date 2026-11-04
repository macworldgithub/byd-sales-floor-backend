const crypto = require('node:crypto');
const virtualyard = require('./virtualyard');
const { fail } = require('./accountAccess');

async function book(document, input, user, collection) {
  const bookingRequestId = input.bookingRequestId || crypto.randomUUID();
  if (typeof bookingRequestId !== 'string' || !/^[\w-]{8,100}$/.test(bookingRequestId)) fail(400, 'Invalid booking request ID.');
  // Scope each idempotency key to an authenticated account; clients cannot claim another user's booking.
  const bookingOwner = String(user.id || user.email);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    document.type, document.when, document.prospectName, document.customer_id, document.leadId,
    document.site || document.dealership, document.vehicle, document.notes, input.virtualyard || null,
  ])).digest('hex');
  await collection.createIndex({ bookingRequestId: 1 }, { unique: true, sparse: true });
  const existing = await collection.findOne({ bookingRequestId });
  if (existing) {
    if (existing.bookingOwner !== bookingOwner || existing.bookingFingerprint !== fingerprint) fail(409, 'This booking request ID has already been used.');
    return { appointment: existing, reused: true };
  }
  const prepared = await virtualyard.prepare({ ...input, ...document }, user);
  Object.assign(document, { bookingRequestId, bookingOwner, bookingFingerprint: fingerprint,
    virtualyard: prepared, virtualyardSync: prepared ? { state: 'pending', updatedAt: new Date() } : { state: 'not_applicable' } });
  if (prepared) {
    document.vehicle = prepared.vehicleName;
    document.consultantName = prepared.userName;
    document.site = prepared.yardName;
    document.dealership = prepared.yardName;
    document.status = virtualyard.LOCAL_STATUS[prepared.status];
  }
  try {
    const result = await collection.insertOne(document);
    document._id = result.insertedId;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const previous = await collection.findOne({ bookingRequestId, bookingOwner, bookingFingerprint: fingerprint });
    if (!previous) fail(409, 'This booking request ID has already been used.');
    return { appointment: previous, reused: true };
  }
  // The appointment is durable before submitting to Virtual Yard.
  return { appointment: await virtualyard.sync(document, collection), reused: false };
}

function assertBookingPatch(patch) {
  for (const key of Object.keys(patch)) {
    if (key.startsWith('$') || /^(?:virtualyard|virtualyardSync|bookingRequestId|bookingOwner|bookingFingerprint)(?:\.|$)/.test(key)) {
      fail(400, 'Virtual Yard sync metadata cannot be changed through an appointment update.');
    }
  }
}

module.exports = { book, assertBookingPatch };
