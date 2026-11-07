const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ObjectId } = require('mongoose').mongo;
const { fail } = require('./accountAccess');
const { geofence } = require('./salesFloorPolicy');
const directory = () => path.resolve(process.env.FLOOR_MEDIA_DIR || path.join(__dirname, '../../.runtime/media'));
function videoDuration(bytes) {
  function scan(start, end, depth = 0) {
    if (depth > 4) return null;
    for (let at = start; at + 8 <= end;) {
      let size = bytes.readUInt32BE(at), header = 8;
      const type = bytes.toString('ascii', at + 4, at + 8);
      if (size === 1) { if (at + 16 > end) return null; const wide = bytes.readBigUInt64BE(at + 8); if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null; size = Number(wide); header = 16; }
      if (!size) size = end - at;
      if (size < header || at + size > end) return null;
      const data = at + header;
      if (type === 'mvhd') {
        const version = bytes[data], scaleAt = data + (version === 1 ? 20 : 12), durationAt = data + (version === 1 ? 24 : 16);
        if (![0, 1].includes(version) || durationAt + (version === 1 ? 8 : 4) > at + size) return null;
        const timescale = bytes.readUInt32BE(scaleAt), ticks = version === 1 ? Number(bytes.readBigUInt64BE(durationAt)) : bytes.readUInt32BE(durationAt);
        return timescale > 0 && Number.isFinite(ticks) ? ticks / timescale : null;
      }
      if (type === 'moov') { const result = scan(data, at + size, depth + 1); if (result !== null) return result; }
      at += size;
    }
    return null;
  }
  return scan(0, bytes.length);
}
function inspect(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 65 * 1024 * 1024) fail(400, 'Select an image or MP4/MOV video smaller than 65 MB.');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && contentType === 'image/jpeg') return { kind: 'image', extension: 'jpg', contentType };
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && contentType === 'image/png') return { kind: 'image', extension: 'png', contentType };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && contentType === 'image/webp') return { kind: 'image', extension: 'webp', contentType };
  if (['video/mp4', 'video/quicktime'].includes(contentType) && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const durationSeconds = videoDuration(bytes);
    if (!(durationSeconds > 0 && durationSeconds <= 180)) fail(400, 'Video must have a readable duration of three minutes or less.');
    return { kind: 'video', extension: contentType === 'video/mp4' ? 'mp4' : 'mov', contentType, durationSeconds };
  }
  fail(400, 'Unsupported media. Use JPEG, PNG, WebP or MP4/MOV.');
}
async function upload(service, input, bytes, contentType, user) {
  const subject = input.clientId ? await service.record('clients', input.clientId, user) : await service.record('leads', input.leadId, user);
  const base = process.env.PUBLIC_API_URL;
  if (!base || !/^https:\/\//.test(base)) fail(503, 'Configure an HTTPS PUBLIC_API_URL before sharing media.');
  const metadata = inspect(bytes, contentType.split(';')[0]);
  if (input.clientId && !(subject.accessories || []).some(accessory => String(accessory.id || accessory._id) === input.accessoryId)) fail(400, 'Choose the accessory job for this completion photo.');
  if (input.clientId && user.role === 'contractor') {
    const accessory = subject.accessories.find(row => String(row.id || row._id) === input.accessoryId);
    if (accessory.contractorId !== user.id) fail(403, 'Capture proof only for your assigned accessory work.');
    const config = await service.config(subject.site_location || subject.site), lat = Number(input.latitude), lon = Number(input.longitude);
    if (!input.latitude || !input.longitude || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(400, 'Device GPS coordinates are required for contractor photo proof.');
    const distance = geofence(lat, lon, config.geofence);
    if (distance === null) fail(409, 'Configure the delivery site geofence before contractor proof is captured.');
    if (distance > config.geofence.radiusMeters) fail(409, 'Contractor completion proof must be captured on-site.');
  }
  const _id = new ObjectId(), token = crypto.randomBytes(24).toString('hex'), filename = `${_id}.${metadata.extension}`;
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory(), filename), bytes, { mode: 0o600, flag: 'wx' });
  const record = { _id, ...metadata, bytes: bytes.length, filename, tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    publicUrl: `${base.replace(/\/$/, '')}/api/mobile/media/${_id}/${token}`, site: subject.dealer || subject.site_location || subject.site,
    leadId: input.clientId ? null : String(subject._id), clientId: input.clientId ? String(subject._id) : null, accessoryId: input.accessoryId || null, owner_user_id: user.id, createdAt: new Date(),
    latitude: Number(input.latitude) || null, longitude: Number(input.longitude) || null };
  await service.panel.collection('floor_media').insertOne(record);
  return { id: String(_id), kind: record.kind, publicUrl: record.publicUrl, durationSeconds: record.durationSeconds };
}
module.exports = { directory, inspect, videoDuration, upload };
