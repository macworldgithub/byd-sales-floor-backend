const crypto = require('node:crypto');
const { fail } = require('./accountAccess');
const media = require('./floorMedia');
const CHUNK_BYTES = 2 * 1024 * 1024;
async function start(service, input, user) {
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 12 || size > 65 * 1024 * 1024) fail(400, 'Choose a file smaller than 65 MB.');
  if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'].includes(input.contentType)) fail(400, 'Choose a photo or MP4/MOV video.');
  await service.record(input.clientId ? 'clients' : 'leads', input.clientId || input.leadId, user);
  const _id = crypto.randomUUID(), expiresAt = new Date(Date.now() + 60 * 60000);
  const record = { _id, ownerId: user.id, size, contentType: input.contentType, leadId: input.leadId,
    clientId: input.clientId, accessoryId: input.accessoryId, latitude: input.latitude, longitude: input.longitude,
    parts: Math.ceil(size / CHUNK_BYTES), state: 'uploading', expiresAt };
  await Promise.all([service.panel.collection('floor_media_uploads').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    service.panel.collection('floor_media_upload_chunks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })]);
  await service.panel.collection('floor_media_uploads').insertOne(record);
  return { id: _id, chunkBytes: CHUNK_BYTES, parts: record.parts };
}
async function session(service, id, user) {
  const record = await service.panel.collection('floor_media_uploads').findOne({ _id: id, ownerId: user.id });
  if (!record || record.expiresAt < new Date()) fail(404, 'Upload expired. Choose the file again.');
  return record;
}
async function append(service, id, index, bytes, user) {
  const upload = await session(service, id, user), part = Number(index);
  if (upload.state !== 'uploading') fail(409, 'This upload is already being completed.');
  const expected = part === upload.parts - 1 ? upload.size - part * CHUNK_BYTES : CHUNK_BYTES;
  if (!Number.isSafeInteger(part) || part < 0 || part >= upload.parts || !Buffer.isBuffer(bytes) || bytes.length !== expected) fail(400, 'Invalid upload chunk.');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex'), key = `${id}:${part}`;
  const chunks = service.panel.collection('floor_media_upload_chunks');
  await chunks.updateOne({ _id: key }, { $setOnInsert: { uploadId: id, index: part, bytes, hash, expiresAt: upload.expiresAt } }, { upsert: true });
  const saved = await chunks.findOne({ _id: key });
  if (saved.hash !== hash) fail(409, 'This chunk belongs to different file contents.');
  return { received: part };
}
async function finish(service, id, user) {
  const upload = await session(service, id, user);
  if (upload.result) return upload.result;
  const parts = await service.panel.collection('floor_media_upload_chunks').find({ uploadId: id }).sort({ index: 1 }).toArray();
  if (parts.length !== upload.parts || parts.some((part, index) => part.index !== index)) fail(409, 'Upload is incomplete. Retry missing chunks.');
  const claim = await service.panel.collection('floor_media_uploads').updateOne({ _id: id, ownerId: user.id, state: 'uploading' }, { $set: { state: 'completing' } });
  if (!claim.modifiedCount) fail(409, 'This upload is already being completed.');
  try {
    const bytes = Buffer.concat(parts.map(part => Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(typeof part.bytes.value === 'function' ? part.bytes.value(true) : part.bytes.buffer)));
    if (bytes.length !== upload.size) fail(400, 'The uploaded size does not match the selected file.');
    const result = await media.upload(service, upload, bytes, upload.contentType, user);
    await service.panel.collection('floor_media_uploads').updateOne({ _id: id }, { $set: { state: 'complete', result } });
    return result;
  } catch (error) {
    await service.panel.collection('floor_media_uploads').updateOne({ _id: id }, { $set: { state: 'uploading' } });
    throw error;
  }
}
module.exports = { start, append, finish, CHUNK_BYTES };
