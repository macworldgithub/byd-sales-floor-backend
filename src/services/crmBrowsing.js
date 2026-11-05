const { siteKey } = require('./accountAccess');

const STAGES = [
  'New / Allocated',
  'Working',
  'Appointment',
  'Negotiation',
  'Written / Sold',
  'In Delivery',
  'Delivered / Won',
  'Lost / Parked',
];
const fail = (message) => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};
const literal = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const active = (value) => value && !/^all(?:\s.*)?$/i.test(String(value));
const text = (value) =>
  String(value || '')
    .trim()
    .slice(0, 200);
const regex = (value) => new RegExp(literal(text(value)), 'i');
const exact = (value) => new RegExp(`^${literal(text(value))}$`, 'i');
function paging(query, total) {
  const requested = Number(query.page || 1),
    limit = Number(query.limit || 25);
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    fail('Page must be positive and page size must be between 1 and 100.');
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requested, pages);
  return {
    total,
    page,
    limit,
    pages,
    hasNextPage: page < pages,
    hasPrevPage: page > 1,
  };
}
const and = (conditions) => (conditions.length ? { $and: conditions } : {});
function siteScope(query, user = {}, fields = ['site']) {
  const site = user.locked_site || query.site || query.yard || query.location;
  if (!active(site)) return {};
  let clean = text(site)
    .replace(/^BYD\s+/i, '')
    .replace(/,?\s+VIC$/i, '')
    .trim();
  if (siteKey(clean) === 'melbournecity') clean = 'Melbourne(?:\\s+City)?';
  else clean = literal(clean);
  const match = new RegExp(`^(?:BYD\\s+)?${clean}(?:,?\\s+VIC)?$`, 'i');
  // Use the first populated site field so stale secondary fields cannot widen access.
  const first = fields.reduceRight(
    (fallback, field) => ({
      $cond: [
        { $and: [{ $ne: [{ $ifNull: [`$${field}`, ''] }, ''] }] },
        `$${field}`,
        fallback,
      ],
    }),
    ''
  );
  return {
    $expr: {
      $regexMatch: {
        input: {
          $convert: { input: first, to: 'string', onError: '', onNull: '' },
        },
        regex: match,
      },
    },
  };
}
async function options(collection, scope, fields) {
  const entries = await Promise.all(
    Object.entries(fields).map(async ([name, columns]) => {
      const values = (
        await Promise.all(
          columns.map((column) => collection.distinct(column, scope))
        )
      ).flat();
      return [
        name,
        [
          ...new Set(
            values
              .filter((value) => typeof value === 'string' && value.trim())
              .map((value) => value.trim())
          ),
        ].sort((a, b) => a.localeCompare(b)),
      ];
    })
  );
  return Object.fromEntries(entries);
}

async function leads(db, query = {}, user = {}) {
  paging(query, 0);
  const collection = db.collection('leads');
  const scope = and([
    siteScope(query, user, ['dealer', 'site', 'dealerName']),
    query.archived === 'all'
      ? {}
      : query.archived === 'true'
        ? { isArchived: true }
        : { isArchived: { $ne: true } },
  ]);
  const conditions = [scope];
  if (active(query.leadYard))
    conditions.push(
      siteScope({ site: query.leadYard }, {}, ['dealer', 'site', 'dealerName'])
    );
  for (const field of ['stage', 'status', 'source', 'platform'])
    if (active(query[field])) conditions.push({ [field]: text(query[field]) });
  if (active(query.owner))
    conditions.push({
      $or: [
        { assignedTo: exact(query.owner) },
        { allocatedPersonFullName: exact(query.owner) },
      ],
    });
  if (text(query.q))
    conditions.push({
      $or: [
        'name',
        'phone',
        'email',
        'vehicle',
        'leadId',
        'virtualyardId',
        'leadIdShort',
        'stockNum',
      ].map((field) => ({ [field]: regex(query.q) })),
    });
  if (active(query.model)) conditions.push({ $or: [{ model: regex(query.model) }, { vehicle: regex(query.model) }] });
  if (query.receivedAfter) {
    const stamp = new Date(query.receivedAfter);
    if (Number.isNaN(stamp.getTime())) fail('Select a valid received timestamp.');
    conditions.push({ $expr: { $gte: [convertDate(fallback('$leadDate', '$leadCreatedDate', '$createdAt')), stamp] } });
  }
  const received = convertDate(
    fallback('$leadDate', '$leadCreatedDate', '$createdAt')
  );
  if (query.receivedFrom)
    conditions.push({
      $expr: { $gte: [received, dayStart(query.receivedFrom)] },
    });
  if (query.receivedTo) {
    const last = dayStart(query.receivedTo);
    if (query.receivedFrom && last < dayStart(query.receivedFrom))
      fail('Received end date cannot precede the start date.');
    const next = new Date(
      Date.parse(`${query.receivedTo}T12:00:00Z`) + 86400000
    )
      .toISOString()
      .slice(0, 10);
    conditions.push({ $expr: { $lt: [received, dayStart(next)] } });
  }
  for (const [key, operator] of [
    ['scoreMin', '$gte'],
    ['scoreMax', '$lte'],
  ]) {
    if (query[key] !== undefined && query[key] !== '') {
      const value = Number(query[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100)
        fail('Lead scores must be between 0 and 100.');
      conditions.push({ score: { [operator]: value } });
    }
  }
  if (
    query.scoreMin !== '' &&
    query.scoreMax !== '' &&
    Number(query.scoreMin) > Number(query.scoreMax)
  )
    fail('Minimum score cannot exceed maximum score.');
  const filter = and(conditions);
  const total = await collection.countDocuments(filter);
  const pagination = paging(query, total);
  const sorts = {
    newest: { createdAt: -1, _id: -1 },
    updated: { updatedAt: -1, _id: -1 },
    oldest: { createdAt: 1, _id: 1 },
    score: { score: -1, _id: -1 },
    name: { name: 1, _id: 1 },
  };
  const [data, filters] = await Promise.all([
    collection
      .find(filter, { allowDiskUse: true })
      .sort(sorts[query.sort] || sorts.updated)
      .skip((pagination.page - 1) * pagination.limit)
      .limit(pagination.limit)
      .toArray(),
    options(collection, scope, {
      stages: ['stage'],
      statuses: ['status'],
      sources: ['source'],
      platforms: ['platform'],
      owners: ['assignedTo', 'allocatedPersonFullName'],
      yards: ['dealer', 'site', 'dealerName'],
      models: ['model', 'vehicle'],
    }),
  ]);
  return { success: true, data, pagination, meta: { filters } };
}

function deal(doc) {
  return {
    ...doc,
    opportunity_id: doc.opportunity_id || String(doc._id),
    customer_name: doc.customer_name || '',
    customer_phone: doc.customer_phone || '',
    vehicle_descriptor:
      doc.vehicle_descriptor ||
      [doc.model, doc.variant].filter(Boolean).join(' '),
    model: doc.model || '',
    owner_name: doc.owner_name || '',
    sale_type: doc.sale_type || 'Retail',
    stage: doc.stage || 'New / Allocated',
    customer_email: doc.customer_email || '',
    site: doc.site || '',
    order_type: doc.order_type || (doc.stock_type === 'factory_order' ? 'Factory Order' : 'Stock'),
    extras: Number(doc.extras_price ?? doc.extras) || 0,
    list_price: Number(doc.list_price) || 0,
    discount: Number(doc.discount) || 0,
    trade_in_flag: Boolean(doc.trade_in_flag),
    secondary_owner: doc.secondary_owner || doc.secondary_salesperson || null,
    lost_reason: doc.loss_reason || doc.lost_reason || null,
    sync_status: typeof doc.sync_status === 'string' ? doc.sync_status : doc.delivery_sync_pending ? 'delivery_pending' : 'synced',
    total_deal_value:
      Number(doc.total_price ?? doc.total_deal_value ?? doc.list_price) || 0,
    next_action_text: doc.next_action_desc || doc.next_action_text || '',
    is_overdue:
      !!doc.next_action_at &&
      new Date(doc.next_action_at) < new Date() &&
      !['Delivered / Won', 'Lost / Parked'].includes(doc.stage),
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}
async function pipeline(db, query = {}, user = {}) {
  paging(query, 0);
  const collection = db.collection('opportunities');
  const scope = siteScope(query, user, ['site', 'location', 'dealer']);
  const conditions = [scope];
  if (active(query.dealYard))
    conditions.push(
      siteScope({ site: query.dealYard }, {}, ['site', 'location', 'dealer'])
    );
  if (active(query.stage)) conditions.push({ stage: text(query.stage) });
  if (active(query.model))
    conditions.push({
      $or: [
        { model: exact(query.model) },
        { vehicle_descriptor: regex(query.model) },
      ],
    });
  if (active(query.owner))
    conditions.push({
      $or: [
        { owner_name: exact(query.owner) },
        { owner_user_id: text(query.owner) },
      ],
    });
  if (active(query.sale_type))
    conditions.push({ sale_type: text(query.sale_type) });
  if (text(query.q))
    conditions.push({
      $or: [
        'customer_name',
        'customer_phone',
        'customer_email',
        'vehicle_descriptor',
        'opportunity_id',
        'vy_stock_id',
        'vy_order_id',
        'vin',
        'owner_name',
      ].map((field) => ({ [field]: regex(query.q) })),
    });
  const filter = and(conditions);
  const groups = await collection
    .aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $ifNull: ['$stage', 'New / Allocated'] },
          count: { $sum: 1 },
          value: {
            $sum: {
              $convert: {
                input: {
                  $ifNull: [
                    '$total_price',
                    { $ifNull: ['$total_deal_value', '$list_price'] },
                  ],
                },
                to: 'double',
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
      },
    ])
    .toArray();
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const pagination = paging(query, total);
  const [docs, filters] = await Promise.all([
    collection
      .find(filter, { allowDiskUse: true })
      .sort({ updatedAt: -1, _id: -1 })
      .skip((pagination.page - 1) * pagination.limit)
      .limit(pagination.limit)
      .toArray(),
    options(collection, scope, {
      models: ['model'],
      owners: ['owner_name'],
      saleTypes: ['sale_type'],
      stages: ['stage'],
      yards: ['site', 'location', 'dealer'],
    }),
  ]);
  return {
    success: true,
    data: docs.map(deal),
    pagination,
    meta: {
      filters,
      totalValue: groups.reduce((sum, group) => sum + group.value, 0),
      stages: Object.fromEntries(
        [...new Set([...STAGES, ...groups.map((group) => group._id)])].map(
          (stage) => {
            const group = groups.find((item) => item._id === stage);
            return [
              stage,
              { count: group?.count || 0, value: group?.value || 0 },
            ];
          }
        )
      ),
    },
  };
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
function dayStart(day) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (
    !dayPattern.test(String(day)) ||
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== day
  )
    fail('Select a valid calendar date range.');
  for (const offset of [10, 11]) {
    const candidate = new Date(utc - offset * 3600000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Australia/Melbourne',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(candidate)
        .map((p) => [p.type, p.value])
    );
    if (
      `${parts.year}-${parts.month}-${parts.day}` === day &&
      parts.hour === '00'
    )
      return candidate;
  }
  fail('Select a valid Melbourne date.');
}
const convertDate = (value) => ({
  $convert: { input: value, to: 'date', onError: null, onNull: null },
});
function scheduled(value, time) {
  return {
    $cond: [
      {
        $regexMatch: {
          input: {
            $convert: { input: value, to: 'string', onError: '', onNull: '' },
          },
          regex: dayPattern,
        },
      },
      {
        $dateFromString: {
          dateString: { $concat: [value, `T${time}:00`] },
          timezone: 'Australia/Melbourne',
          onError: null,
          onNull: null,
        },
      },
      { $cond: [
        { $regexMatch: { input: { $convert: { input: value, to: 'string', onError: '', onNull: '' } }, regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/ } },
        { $dateFromString: { dateString: value, timezone: 'Australia/Melbourne', onError: null, onNull: null } },
        convertDate(value),
      ] },
    ],
  };
}
const fallback = (...values) =>
  values.reduceRight((next, value) => ({ $ifNull: [value, next] }), null);
function eventPipelines(databases, query, user) {
  const from = dayStart(query.from),
    to = dayStart(query.to);
  if (to <= from || to - from > 94 * 86400000)
    fail('Calendar range must be between 1 and 93 days.');
  if (
    query.category &&
    !['all', 'drive', 'followup', 'delivery', 'hold'].includes(query.category)
  )
    fail('Invalid calendar category.');
  const definitions = [
    {
      db: databases.lead,
      collection: 'appointments',
      source: 'appointment',
      siteFields: ['site', 'dealership', 'location'],
      project: {
        stamp: scheduled(fallback('$testDriveDate', '$when'), '09:00'),
        type: { $ifNull: ['$floorCategory', {
          $switch: {
            branches: [
              { case: { $eq: ['$type', 'Handover'] }, then: 'delivery' },
              { case: { $eq: ['$type', 'Callback'] }, then: 'followup' },
            ],
            default: 'drive',
          },
        }] },
        label: fallback('$type', 'Test Drive'),
        customer_id: fallback('$customer_id', '$leadId'),
        customer_name: fallback('$prospectName', '$customer_name', 'Customer'),
        phone: '$phone',
        email: '$email',
        vehicle: '$vehicle',
        site: fallback('$site', '$dealership', '$location'),
        consultant: fallback('$consultantName', '$consultant', '$bookedBy'),
        status: '$status',
        notes: '$notes',
        duration: fallback('$durationMinutes', '$duration_minutes', 45),
        virtualyardSync: '$virtualyardSync',
      },
    },
    {
      db: databases.panel,
      collection: 'opportunities',
      source: 'opportunity',
      siteFields: ['site', 'location', 'dealer'],
      project: {
        stamp: scheduled(
          fallback('$next_action_at', '$expected_close'),
          '09:00'
        ),
        type: { $literal: 'followup' },
        label: { $literal: 'Follow-up' },
        customer_id: '$customer_id',
        customer_name: '$customer_name',
        phone: '$customer_phone',
        email: '$customer_email',
        vehicle: fallback('$vehicle_descriptor', '$model'),
        site: '$site',
        consultant: '$owner_name',
        status: '$stage',
        notes: fallback('$next_action_desc', '$next_action_text'),
        duration: { $literal: 30 },
      },
    },
    {
      db: databases.panel,
      collection: 'clients',
      source: 'delivery',
      siteFields: ['site_location', 'site', 'location', 'dealer'],
      project: {
        stamp: scheduled(
          fallback('$delivery_date', '$scheduled_delivery_date'),
          '11:00'
        ),
        type: { $literal: 'delivery' },
        label: { $literal: 'Delivery' },
        customer_id: '$crm_customer_id',
        customer_name: fallback('$name', '$customer_name'),
        phone: '$phone',
        email: '$email',
        vehicle: '$vehicle',
        site: fallback('$site_location', '$site', '$location'),
        consultant: fallback(
          '$handover_specialist',
          '$delivery_consultant',
          '$salesperson'
        ),
        status: fallback('$stage', '$delivery_stage'),
        notes: '$last_comment',
        duration: { $literal: 60 },
      },
    },
  ];
  return definitions.map((definition) => {
    const base = [
      { $match: siteScope(query, user, definition.siteFields) },
      { $project: definition.project },
      { $match: { stamp: { $gte: from, $lt: to } } },
    ];
    if (query.category && query.category !== 'all')
      base.push({ $match: { type: query.category } });
    const filters = [];
    if (active(query.eventYard)) filters.push({ site: exact(query.eventYard) });
    if (active(query.consultant))
      filters.push({ consultant: exact(query.consultant) });
    if (active(query.status)) filters.push({ status: exact(query.status) });
    if (text(query.q))
      filters.push({
        $or: [
          'customer_name',
          'phone',
          'email',
          'vehicle',
          'consultant',
          'notes',
          'label',
        ].map((field) => ({ [field]: regex(query.q) })),
      });
    return {
      ...definition,
      base,
      filtered: [...base, { $match: and(filters) }],
    };
  });
}
const timeParts = (stamp) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(stamp)
      .map((part) => [part.type, part.value])
  );
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${p.hour}:${p.minute}`,
  };
};
function calendarEvent(row, source) {
  const id = String(row._id),
    date = new Date(row.stamp);
  const duration = Math.max(1, Math.min(1440, Number(row.duration) || 45));
  const vehicle =
    typeof row.vehicle === 'object' && row.vehicle
      ? row.vehicle.raw || row.vehicle.model || ''
      : row.vehicle || '';
  return {
    id: `${source}:${id}`,
    type: row.type,
    title: `${row.label}: ${row.customer_name || 'Customer'}`,
    subtitle: row.notes || vehicle,
    date: date.toISOString(),
    endsAt: new Date(date.getTime() + duration * 60000).toISOString(),
    ...timeParts(date),
    endTimeStr: timeParts(new Date(date.getTime() + duration * 60000)).timeStr,
    customer_id: row.customer_id ? String(row.customer_id) : '',
    customer_name: row.customer_name || 'Customer',
    phone: row.phone || '',
    email: row.email || '',
    vehicle,
    site: row.site || '',
    consultant: row.consultant || '',
    status: row.status || '',
    notes: row.notes || '',
    rawSource: source,
    rawObject:
      source === 'appointment'
        ? { appointment_id: id, virtualyardSync: row.virtualyardSync }
        : undefined,
  };
}
async function calendar(databases, query = {}, user = {}) {
  paging(query, 0);
  const sources = eventPipelines(databases, query, user);
  const stats = await Promise.all(
    sources.map(async (source) => {
      const [result] = await source.db
        .collection(source.collection)
        .aggregate([
          ...source.base,
          {
            $facet: {
              next: [
                { $match: { $and: [source.filtered[source.filtered.length - 1].$match, { stamp: { $gte: new Date() }, status: { $nin: ['Cancelled', 'Completed', 'No Show', 'Delivered', 'Delivered / Won', 'Lost / Parked'] } }] } },
                { $sort: { stamp: 1, _id: 1 } }, { $limit: 1 },
              ],
              total: [
                { $match: source.filtered[source.filtered.length - 1].$match },
                { $count: 'count' },
              ],
              filters: [
                {
                  $group: {
                    _id: null,
                    consultants: { $addToSet: '$consultant' },
                    statuses: { $addToSet: '$status' },
                    yards: { $addToSet: '$site' },
                  },
                },
              ],
            },
          },
        ])
        .toArray();
      return {
        total: result?.total[0]?.count || 0,
        filters: result?.filters[0] || {},
        next: result?.next?.[0] ? calendarEvent(result.next[0], source.source) : null,
      };
    })
  );
  const pagination = paging(
    query,
    stats.reduce((sum, stat) => sum + stat.total, 0)
  );
  const offset = (pagination.page - 1) * pagination.limit;
  const batches = await Promise.all(
    sources.map(async (source, i) =>
      !stats[i].total
        ? []
        : (
            await source.db
              .collection(source.collection)
              .aggregate(
                [
                  ...source.filtered,
                  { $sort: { stamp: 1, _id: 1 } },
                  { $limit: offset + pagination.limit },
                ],
                { allowDiskUse: true }
              )
              .toArray()
          ).map((row) => calendarEvent(row, source.source))
    )
  );
  const all = batches
    .flat()
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const values = (key) =>
    [
      ...new Set(
        stats
          .flatMap((stat) => stat.filters[key] || [])
          .filter((value) => typeof value === 'string' && value.trim())
      ),
    ].sort();
  return {
    success: true,
    data: all.slice(offset, offset + pagination.limit),
    pagination,
    meta: {
      filters: {
        consultants: values('consultants'),
        statuses: values('statuses'),
        yards: values('yards'),
      },
      sourceCounts: Object.fromEntries(sources.map((source, index) => [source.source, stats[index].total])),
      nextEvent: stats.map(stat => stat.next).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))[0] || null,
      timezone: 'Australia/Melbourne',
    },
  };
}
module.exports = {
  leads,
  pipeline,
  calendar,
  paging,
  siteScope,
  dayStart,
  calendarEvent,
  eventPipelines,
};
