const { Types } = require('mongoose');

function references(value) {
  const id = String(value);
  return /^[a-f\d]{24}$/i.test(id) ? [id, new Types.ObjectId(id)] : [id];
}

function appointmentReferenceFilter(value) {
  return { $in: references(value) };
}

function leadReferenceFilter(value) {
  const id = String(value);
  const alternatives = [{ leadId: id }, { virtualyardId: id }];
  const objectId = references(value)[1];
  if (objectId) alternatives.unshift({ _id: objectId });
  return { $or: alternatives };
}

module.exports = { appointmentReferenceFilter, leadReferenceFilter };
