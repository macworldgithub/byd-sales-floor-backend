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

async function summary(collection, filter, deals, config, bounds, now = new Date()) {
  const lastContact = date(choose('$lastContactAt', '$createdAt'));
  const overdue = { $and: [active, truthy('$createdAt'), { $ne: [lastContact, null] }, { $lte: [lastContact, new Date(now - config.followupRedHours * 3600000)] }] };
  const created = within('$createdAt', bounds);
  const [result] = await collection.aggregate([
    { $match: filter },
    { $group: { _id: null, activeLeads: count(active), unactionedLeads: count({ $and: [active, { $not: [truthy('$lastContactAt')] }] }),
      overdueLeads: count(overdue), created: count(created), converted: count({ $and: [created, { $in: [{ $toString: '$_id' }, signedIds(deals)] }] }) } },
  ]).toArray();
  return result || { activeLeads: 0, unactionedLeads: 0, overdueLeads: 0, created: 0, converted: 0 };
}

async function pulse(collection, filter, deals, config, now = new Date()) {
  const rows = await collection.aggregate([
    { $match: filter },
    { $project: { name: 1, assignedTo: 1, active, owner: choose('$allocatedPersonFullName', '$owner_name', '$assignedTo', { $literal: 'Unassigned' }),
      sold: { $in: [{ $toString: '$_id' }, signedIds(deals)] },
      age: { $max: [0, { $divide: [{ $subtract: [now, date(choose('$lastContactAt', '$createdAt', now))] }, 3600000] }] } } },
    { $group: { _id: '$owner', email: { $first: '$assignedTo' }, total: { $sum: 1 }, sold: count('$sold'), activeLeads: count('$active'),
      maxFollowupHours: { $max: { $cond: ['$active', '$age', 0] } },
      overdueSla: count({ $and: ['$active', { $gte: ['$age', config.followupAmberHours] }] }),
      flaggedLeads: { $push: { $cond: [{ $and: ['$active', { $gte: ['$age', config.followupAmberHours] }] }, { id: { $toString: '$_id' }, name: '$name', hours: '$age' }, null] } } } },
    { $project: { name: '$_id', email: 1, total: 1, sold: 1, activeLeads: 1, overdueSla: 1, maxFollowupHours: 1,
      flaggedLeads: { $filter: { input: '$flaggedLeads', as: 'lead', cond: { $ne: ['$$lead', null] } } } } },
    { $sort: { name: 1 } },
  ], { allowDiskUse: true }).toArray();
  return rows.map(({ _id, ...row }) => ({ ...row, flaggedLeads: row.flaggedLeads.map(({ hours, ...lead }) => ({ ...lead, age: `${Math.floor(hours)}h`, reason: 'Follow-up due' })),
    conversionRate: row.total ? Math.round(row.sold / row.total * 1000) / 10 : null,
    trafficLight: row.maxFollowupHours >= config.followupRedHours || row.sold / row.total * 100 < config.conversionAmber ? 'red' :
      row.maxFollowupHours >= config.followupAmberHours || row.sold / row.total * 100 < config.conversionGreen ? 'amber' : 'green' }));
}
async function reportLeads(collection, filter, deals, bounds) {
  return collection.aggregate([
    { $match: filter },
    { $group: { _id: '$dealer', created: count(within('$createdAt', bounds)),
      converted: count({ $and: [within('$createdAt', bounds), { $in: [{ $toString: '$_id' }, signedIds(deals)] }] }) } },
  ]).toArray();
}
module.exports = { summary, pulse, reportLeads };
