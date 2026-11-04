const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { appointmentReferenceFilter, leadReferenceFilter } = require('../src/services/appointmentReference');

test('external numeric and synthetic lead IDs are queried without ObjectId casting', () => {
  for (const id of ['123456', 'td-drive-1']) {
    assert.deepEqual(appointmentReferenceFilter(id), { $in: [id] });
    assert.deepEqual(leadReferenceFilter(id), { $or: [{ leadId: id }, { virtualyardId: id }] });
  }
});

test('legacy ObjectId and string references both remain searchable', () => {
  const id = new Types.ObjectId();
  const query = appointmentReferenceFilter(String(id));
  assert.equal(query.$in[0], String(id));
  assert.ok(query.$in[1].equals(id));
  assert.ok(leadReferenceFilter(id).$or[0]._id.equals(id));
});
