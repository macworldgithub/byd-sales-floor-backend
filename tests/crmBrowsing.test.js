const test = require('node:test');
const assert = require('node:assert/strict');
const {
  leads,
  pipeline,
  calendar,
  paging,
  dayStart,
  calendarEvent,
  eventPipelines,
  siteScope,
} = require('../src/services/crmBrowsing');

test('pagination clamps deleted or filtered-out pages, keeps empty results on page one and rejects unbounded requests', () => {
  assert.deepEqual(paging({ page: 9, limit: 25 }, 31), {
    total: 31,
    page: 2,
    limit: 25,
    pages: 2,
    hasNextPage: false,
    hasPrevPage: true,
  });
  assert.equal(paging({ page: 10 }, 0).page, 1);
  for (const query of [
    { page: -1 },
    { page: 1.5 },
    { limit: 101 },
    { limit: '0' },
    { limit: 'bad' },
  ])
    assert.throws(() => paging(query, 1), { statusCode: 400 });
});

test('Melbourne ranges handle daylight saving without a fixed UTC offset', () => {
  assert.equal(
    dayStart('2026-10-04').toISOString(),
    '2026-10-03T14:00:00.000Z'
  );
  assert.equal(
    dayStart('2026-10-05').toISOString(),
    '2026-10-04T13:00:00.000Z'
  );
  assert.equal(
    dayStart('2026-04-06').toISOString(),
    '2026-04-05T14:00:00.000Z'
  );
  for (const value of ['', 'invalid', '2026-02-30', '2026-13-01'])
    assert.throws(() => dayStart(value), { statusCode: 400 });
});

test('calendar rejects missing, reversed and excessive ranges before querying any database', () => {
  for (const query of [
    {},
    { from: '2026-10-10', to: '2026-10-01' },
    { from: '2026-01-01', to: '2027-01-01' },
    { from: '2026-10-01', to: '2026-11-01', category: 'unknown' },
  ]) {
    assert.throws(() => eventPipelines({}, query, {}), { statusCode: 400 });
  }
});

test('calendar events carry Melbourne dates and real appointment IDs for sync retry', () => {
  const event = calendarEvent(
    {
      _id: 'local-id',
      stamp: '2026-10-31T13:30:00Z',
      type: 'drive',
      label: 'Test Drive',
      customer_name: 'Driver',
      vehicle: { raw: 'BYD ATTO 3' },
      duration: 45,
      virtualyardSync: { state: 'synced', externalId: 'upstream-id' },
    },
    'appointment'
  );
  assert.equal(event.dateStr, '2026-11-01');
  assert.equal(event.timeStr, '00:30');
  assert.equal(event.endTimeStr, '01:15');
  assert.equal(event.vehicle, 'BYD ATTO 3');
  assert.equal(event.rawObject.appointment_id, 'local-id');
  assert.equal(event.rawObject.virtualyardSync.externalId, 'upstream-id');
});

test('site locks override user-selected sites and use authoritative fields before stale secondary sites', () => {
  const scope = siteScope(
    { site: 'Denza Melbourne' },
    { locked_site: 'BYD Fairfield' },
    ['dealer', 'site']
  );
  const rule = scope.$expr.$regexMatch;
  assert.ok(rule.regex.test('Fairfield'));
  assert.ok(!rule.regex.test('Denza Melbourne'));
  assert.match(JSON.stringify(rule.input), /dealer.*site/);
  const melbourne = siteScope({ site: 'BYD Melbourne City' }).$expr.$regexMatch
    .regex;
  assert.ok(melbourne.test('Melbourne'));
  assert.ok(!melbourne.test('Denza Melbourne'));
});

test('leads paginate on the server, include legacy active records and keep literal search separate from consultant/site filters', async () => {
  const calls = {};
  const collection = {
    async countDocuments(filter) {
      calls.filter = filter;
      return 47;
    },
    async distinct(field, scope) {
      calls.scope = scope;
      return ['Option outside current page'];
    },
    find(filter, options) {
      calls.options = options;
      return {
        sort(value) {
          calls.sort = value;
          return this;
        },
        skip(value) {
          calls.skip = value;
          return this;
        },
        limit(value) {
          calls.limit = value;
          return this;
        },
        async toArray() {
          return [{ _id: 'second-page-lead' }];
        },
      };
    },
  };
  const result = await leads(
    { collection: () => collection },
    { page: 2, limit: 25, q: 'A+B', owner: 'Staff', stage: 'NEW ENQUIRIES' },
    { locked_site: 'BYD Fairfield' }
  );
  assert.equal(calls.skip, 25);
  assert.equal(calls.limit, 25);
  assert.equal(calls.options.allowDiskUse, true);
  assert.equal(result.pagination.total, 47);
  assert.equal(result.pagination.page, 2);
  assert.ok(result.meta.filters.owners.includes('Option outside current page'));
  assert.match(JSON.stringify(calls.filter), /isArchived.*\$ne.*true/);
  assert.equal(calls.filter.$and.at(-1).$or[0].name.source, 'A\\+B');
  assert.ok(
    calls.filter.$and.some((condition) => condition.stage === 'NEW ENQUIRIES')
  );
  assert.ok(
    calls.filter.$and.some((condition) => condition.$or?.[0]?.assignedTo)
  );
  await assert.rejects(
    leads({ collection: () => collection }, { scoreMin: 90, scoreMax: 10 }),
    { statusCode: 400 }
  );
});

test('pipeline totals and filter options cover all matching deals, independently of the requested page', async () => {
  let skip;
  const collection = {
    aggregate() {
      return {
        async toArray() {
          return [
            { _id: 'Working', count: 30, value: 90000 },
            { _id: 'Negotiation', count: 5, value: 50000 },
          ];
        },
      };
    },
    async distinct() {
      return ['A model on another page'];
    },
    find() {
      return {
        sort() {
          return this;
        },
        skip(value) {
          skip = value;
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return [{ _id: 'id-2', total_price: 2000, customer_name: 'Buyer', stock_type: 'factory_order', extras_price: 100 }];
        },
      };
    },
  };
  const result = await pipeline(
    { collection: () => collection },
    { page: 2, limit: 25 }
  );
  assert.equal(skip, 25);
  assert.equal(result.pagination.total, 35);
  assert.equal(result.meta.totalValue, 140000);
  assert.equal(result.meta.stages.Working.count, 30);
  assert.equal(result.data[0].total_deal_value, 2000);
  assert.equal(result.data[0].order_type, 'Factory Order');
  assert.equal(result.data[0].extras, 100);
  assert.deepEqual(result.meta.filters.models, ['A model on another page']);
});

test('calendar merges and paginates all sources chronologically with stable ties and no overlapping pages', async () => {
  const rows = {
    appointments: [1, 4, 6].map((i) => ({
      _id: String(i),
      stamp: new Date(`2026-10-10T0${i}:00:00Z`),
      type: 'drive',
      label: 'Test Drive',
    })),
    opportunities: [2, 4, 7].map((i) => ({
      _id: String(i),
      stamp: new Date(`2026-10-10T0${i}:00:00Z`),
      type: 'followup',
      label: 'Follow-up',
    })),
    clients: [3, 5, 8].map((i) => ({
      _id: String(i),
      stamp: new Date(`2026-10-10T0${i}:00:00Z`),
      type: 'delivery',
      label: 'Delivery',
    })),
  };
  const db = {
    collection(name) {
      return {
        aggregate(stages) {
          return {
            async toArray() {
              if (stages.some((stage) => stage.$facet))
                return [
                  {
                    total: [{ count: rows[name].length }],
                    filters: [
                      { consultants: ['Staff'], statuses: ['Confirmed'] },
                    ],
                  },
                ];
              return rows[name].slice(0, stages.at(-1).$limit);
            },
          };
        },
      };
    },
  };
  const ids = [];
  for (let page = 1; page <= 5; page++) {
    const result = await calendar(
      { lead: db, panel: db },
      { from: '2026-10-01', to: '2026-11-01', page, limit: 2 }
    );
    assert.equal(result.pagination.total, 9);
    ids.push(...result.data.map((event) => event.id));
  }
  assert.equal(new Set(ids).size, 9);
  assert.deepEqual(ids, [
    'appointment:1',
    'opportunity:2',
    'delivery:3',
    'appointment:4',
    'opportunity:4',
    'delivery:5',
    'appointment:6',
    'opportunity:7',
    'delivery:8',
  ]);
});
