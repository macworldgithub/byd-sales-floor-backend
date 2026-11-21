// Keep dashboard arithmetic in MongoDB: never ship full lead/customer records
// to the API process just to count them. Dates can be BSON dates or legacy ISO strings.
const date = input => ({ $convert: { input, to: 'date', onError: null, onNull: null } });
// Mongo considers an empty string true; these legacy fields follow JS/UI
// fallback semantics, where an empty name/date/contact value is absent.
const truthy = input => ({ $not: [{ $in: [{ $ifNull: [input, null] }, [null, false, 0, '']] }] });
const choose = (...values) => values.reduceRight((fallback, value) => ({ $cond: [truthy(value), value, fallback] }), null);
const active = { $and: [{ $not: [{ $in: ['$stage', ['DELIVERED', 'LOST', 'OPTED OUT']] }] }, { $not: [truthy('$isArchived')] }] };
const within = (field, bounds) => ({ $and: [{ $gte: [date(field), bounds.from] }, { $lte: [date(field), bounds.to] }] });
const count = condition => ({ $sum: { $cond: [condition, 1, 0] } });
const signedIds = deals => [...new Set(deals.filter(row => row.contractSignedAt).map(row => String(row.leadId)))];
async function appointmentsBooked(collection, filter, bounds) {
  return collection.countDocuments({ $and: [filter, { $expr: within('$createdAt', bounds) }, { status: { $nin: ['Cancelled', 'No Show'] } }] });
}
const receivedDate = chooseValidDate('$leadDate', '$leadCreatedDate', '$createdAt');
function chooseValidDate(...values) { return values.reduceRight((fallback, value) => ({ $ifNull: [date(value), fallback] }), null); }
const legacyContact = { $toLower: { $trim: { input: { $convert: { input: '$lastContact', to: 'string', onError: '', onNull: '' } } } } };
const contactRecorded = { $or: [
  truthy('$lastContactAt'),
  { $not: [{ $in: [legacyContact, ['', 'never', 'never contacted', 'not contacted', 'no contact', 'no contact yet', 'n/a', 'na', 'none', 'null', 'unknown', '-', '--', '0']] }] },
  ...['phoneCallCount', 'smsCount', 'emailCount'].map(field => ({ $gt: [{ $convert: { input: `$leadStats.${field}`, to: 'double', onError: 0, onNull: 0 } }, 0] })),
] };

async function summary(collection, filter, deals, config, bounds, now = new Date()) {
  const lastContact = chooseValidDate('$lastContactAt', '$lastContact', '$leadDate', '$leadCreatedDate', '$createdAt');
  const overdue = { $and: [active, truthy('$createdAt'), { $ne: [lastContact, null] }, { $lte: [lastContact, new Date(now - config.followupRedHours * 3600000)] }] };
  const created = within(receivedDate, bounds), periodActive = { $and: [active, created] };
  const [result] = await collection.aggregate([
    { $match: filter },
    { $group: { _id: null, activeLeads: count(periodActive), unactionedLeads: count({ $and: [periodActive, { $not: [contactRecorded] }] }),
      overdueLeads: count(overdue), created: count(created), converted: count({ $and: [created, { $in: [{ $toString: '$_id' }, signedIds(deals)] }] }) } },
  ]).toArray();
  return result || { activeLeads: 0, unactionedLeads: 0, overdueLeads: 0, created: 0, converted: 0 };
}

function pulseBase(filter, deals, now) {
  return [
    { $match: filter },
    { $project: { name: 1, assignedTo: 1, active, owner: choose('$allocatedPersonFullName', '$owner_name', '$assignedTo', { $literal: 'Unassigned' }),
      sold: { $in: [{ $toString: '$_id' }, signedIds(deals)] },
      age: { $max: [0, { $divide: [{ $subtract: [now, { $ifNull: [chooseValidDate('$lastContactAt', '$lastContact', '$leadDate', '$leadCreatedDate', '$createdAt'), now] }] }, 3600000] }] } } },
  ];
}
function pulseGroups(config, includeLeads) {
  return [
    { $group: { _id: '$owner', email: { $first: '$assignedTo' }, total: { $sum: 1 }, sold: count('$sold'), activeLeads: count('$active'),
      maxFollowupHours: { $max: { $cond: ['$active', '$age', 0] } },
      overdueSla: count({ $and: ['$active', { $gte: ['$age', config.followupAmberHours] }] }),
      ...(includeLeads ? { flaggedLeads: { $push: { $cond: [{ $and: ['$active', { $gte: ['$age', config.followupAmberHours] }] }, { id: { $toString: '$_id' }, name: '$name', hours: '$age' }, null] } } } : {}) } },
    { $project: { name: '$_id', email: 1, total: 1, sold: 1, activeLeads: 1, overdueSla: 1, maxFollowupHours: 1,
      ...(includeLeads ? { flaggedLeads: { $filter: { input: '$flaggedLeads', as: 'lead', cond: { $ne: ['$$lead', null] } } } } : {}) } },
    { $sort: { name: 1 } },
  ];
}
const formatFollowup = ({ _id, hours, ...lead }) => ({ ...lead, age: `${Math.floor(hours)}h`, reason: 'Follow-up due' });
const formatConsultant = config => ({ _id, ...row }) => ({ ...row, flaggedLeads: (row.flaggedLeads || []).map(formatFollowup),
    conversionRate: row.total ? Math.round(row.sold / row.total * 1000) / 10 : null,
    trafficLight: row.maxFollowupHours >= config.followupRedHours || row.sold / row.total * 100 < config.conversionAmber ? 'red' :
      row.maxFollowupHours >= config.followupAmberHours || row.sold / row.total * 100 < config.conversionGreen ? 'amber' : 'green' });
async function pulse(collection, filter, deals, config, now = new Date()) {
  const rows = await collection.aggregate([...pulseBase(filter, deals, now), ...pulseGroups(config, true)], { allowDiskUse: true }).toArray();
  return rows.map(formatConsultant(config));
}
function pulsePages(query) {
  const specs = { consultants: { page: query.page ?? 1, limit: query.limit ?? 10 }, followups: { page: query.followupPage ?? 1, limit: query.followupLimit ?? 10 } };
  for (const spec of Object.values(specs)) {
    if (![spec.page, spec.limit].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)) require('./accountAccess').fail(400, 'PULSE pages and page sizes must be positive integers.');
    require('./crmBrowsing').paging(spec, 0);
    if (Number(spec.limit) > 50) require('./accountAccess').fail(400, 'PULSE page size must not exceed 50.');
    if (!Number.isSafeInteger((Number(spec.page) - 1) * Number(spec.limit))) require('./accountAccess').fail(400, 'PULSE page offset is too large.');
  }
  return specs;
}
async function aggregatePage(collection, pipeline, spec) {
  const { paging } = require('./crmBrowsing');
  const page = Number(spec.page), limit = Number(spec.limit);
  const [result] = await collection.aggregate([...pipeline, { $facet: {
    total: [{ $count: 'count' }], rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
  } }], { allowDiskUse: true }).toArray();
  const pagination = paging(spec, result?.total?.[0]?.count || 0);
  const data = pagination.total && pagination.page !== page
    ? await collection.aggregate([...pipeline, { $skip: (pagination.page - 1) * limit }, { $limit: limit }], { allowDiskUse: true }).toArray()
    : result?.rows || [];
  return { data, pagination };
}
async function pagedPulse(collection, filter, deals, config, query, now = new Date()) {
  const specs = pulsePages(query), base = pulseBase(filter, deals, now);
  const [consultants, followups] = await Promise.all([
    aggregatePage(collection, [...base, ...pulseGroups(config, false)], specs.consultants),
    aggregatePage(collection, [...base, { $match: { active: true, age: { $gte: config.followupAmberHours } } },
      { $sort: { age: -1, _id: 1 } }, { $project: { id: { $toString: '$_id' }, name: 1, consultant: '$owner', hours: '$age' } }], specs.followups),
  ]);
  return { consultants: consultants.data.map(formatConsultant(config)), pagination: consultants.pagination,
    followups: followups.data.map(formatFollowup), followupPagination: followups.pagination };
}
async function reportLeads(collection, filter, deals, bounds) {
  return collection.aggregate([
    { $match: filter },
    { $group: { _id: '$dealer', created: count(within('$createdAt', bounds)),
      converted: count({ $and: [within('$createdAt', bounds), { $in: [{ $toString: '$_id' }, signedIds(deals)] }] }) } },
  ]).toArray();
}
module.exports = { summary, pulse, pagedPulse, pulsePages, reportLeads, appointmentsBooked };
