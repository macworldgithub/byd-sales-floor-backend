const fs = require('node:fs/promises');
const path = require('node:path');
const { ObjectId } = require('mongoose').mongo;
const { inspect } = require('./floorMedia');
const { fail } = require('./accountAccess');
const { id, reference } = require('./salesFloorMobile');
const directory = () => path.resolve(process.env.FLOOR_PRIVATE_MEDIA_DIR || path.join(__dirname, '../../.runtime/licences'));
async function capture(service, leadId, bytes, contentType, user) {
  const lead = await service.record('leads', leadId, user), image = inspect(bytes, contentType);
  if (image.kind !== 'image') fail(400, 'Capture a photo of the licence.');
  const _id = new ObjectId(), filename = `${_id}.${image.extension}`;
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory(), filename), bytes, { mode: 0o600, flag: 'wx' });
  const record = { _id, leadId: id(lead), site: lead.dealer, owner_user_id: user.id, filename, contentType, status: 'captured', createdAt: new Date() };
  await service.panel.collection('floor_licences').insertOne(record);
  let suggestions = null, ocrError = '';
  if (process.env.LICENCE_OCR_API_URL) {
    try {
      const response = await fetch(process.env.LICENCE_OCR_API_URL, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${process.env.LICENCE_OCR_API_TOKEN || ''}` }, body: bytes, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Licence OCR provider could not read this image.');
      const data = await response.json();
      suggestions = { fullName: String(data.fullName || ''), licenceNumber: String(data.licenceNumber || ''), state: String(data.state || ''), expiryDate: String(data.expiryDate || '') };
    } catch (error) { ocrError = error.message; }
  }
  return { id: String(_id), suggestions, ocrError, manualReviewRequired: true };
}
async function review(service, leadId, input, user) {
  const lead = await service.record('leads', leadId, user);
  const licence = await service.panel.collection('floor_licences').findOne({ _id: reference(input.imageId), leadId: id(lead), owner_user_id: user.id });
  if (!licence) fail(404, 'Licence capture not found.');
  const fullName = String(input.fullName || '').trim(), licenceNumber = String(input.licenceNumber || '').trim(), state = String(input.state || ''), expiryDate = String(input.expiryDate || '');
  if (!fullName || !/^[A-Z0-9 -]{3,30}$/i.test(licenceNumber) || !['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'].includes(state) || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || !Number.isFinite(Date.parse(expiryDate)) || new Date(expiryDate).toISOString().slice(0, 10) !== expiryDate) fail(400, 'Verify the licence holder, number, issuing state and expiry date.');
  const value = { fullName, licenceNumber, state, expiryDate, status: 'reviewed', reviewedBy: user.id, reviewedAt: new Date() };
  await service.panel.collection('floor_licences').updateOne({ _id: licence._id }, { $set: value });
  await service.event(lead, user, 'Licence reviewed', 'Licence photo captured and details reviewed.');
  return { id: id(licence), ...value };
}
module.exports = { directory, capture, review };
