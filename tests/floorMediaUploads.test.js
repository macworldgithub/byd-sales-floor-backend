const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { database } = require('./helpers/floorMemory');
function fixture() {
  const panel = database(), calls = [];
  const service = { panel, async record(name, id, user) { if (id !== 'allowed-lead' || user.id !== 'fixture-user') throw Error('Access denied'); return { _id: id }; } };
  const filename = path.resolve(__dirname, '../src/services/floorMediaUploads.js'), actualRequire = createRequire(filename), loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: loaded, Buffer, Date, require(key) {
    if (key === './floorMedia') return { async upload(service, upload, bytes, contentType, user) { calls.push({ upload, bytes, contentType, user }); return { id: 'verified-media', publicUrl: 'https://example.test/media' }; } };
    return actualRequire(key);
  } });
  return { api: loaded.exports, service, calls, user: { id: 'fixture-user' } };
}
test('uploads stay within 2 MB requests, verify every byte and complete once across retries', async () => {
  const f = fixture(), file = Buffer.alloc(3 * 1024 * 1024, 7);
  const upload = await f.api.start(f.service, { size: file.length, contentType: 'video/mp4', leadId: 'allowed-lead' }, f.user);
  assert.equal(upload.parts, 2); assert.equal(upload.chunkBytes, 2 * 1024 * 1024);
  await f.api.append(f.service, upload.id, 0, file.subarray(0, upload.chunkBytes), f.user);
  await f.api.append(f.service, upload.id, 0, file.subarray(0, upload.chunkBytes), f.user);
  await assert.rejects(f.api.finish(f.service, upload.id, f.user), /incomplete/);
  await f.api.append(f.service, upload.id, 1, file.subarray(upload.chunkBytes), f.user);
  assert.equal((await f.api.finish(f.service, upload.id, f.user)).id, 'verified-media');
  assert.equal((await f.api.finish(f.service, upload.id, f.user)).id, 'verified-media');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].bytes, file);
});
test('another user, changed chunks, invalid sizes and inaccessible leads fail before media storage', async () => {
  const f = fixture();
  await assert.rejects(f.api.start(f.service, { size: 99e6, contentType: 'video/mp4', leadId: 'allowed-lead' }, f.user), /65 MB/);
  await assert.rejects(f.api.start(f.service, { size: 12, contentType: 'video/mp4', leadId: 'other-lead' }, f.user), /Access denied/);
  const upload = await f.api.start(f.service, { size: 12, contentType: 'video/mp4', leadId: 'allowed-lead' }, f.user);
  await assert.rejects(f.api.append(f.service, upload.id, 0, Buffer.alloc(12), { id: 'other-user' }), /expired/);
  await assert.rejects(f.api.append(f.service, upload.id, 0, Buffer.alloc(11), f.user), /Invalid upload chunk/);
  await f.api.append(f.service, upload.id, 0, Buffer.alloc(12), f.user);
  await assert.rejects(f.api.append(f.service, upload.id, 0, Buffer.alloc(12, 1), f.user), /different file contents/);
  assert.equal(f.calls.length, 0);
});
