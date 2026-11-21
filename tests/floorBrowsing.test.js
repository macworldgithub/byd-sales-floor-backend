const test = require('node:test');
const assert = require('node:assert/strict');
const floor = require('../src/services/floorBrowsing');
const browse = require('../src/services/crmBrowsing');
const get = (doc, name) => name.split('.').reduce((value, key) => value?.[key], doc);
const { matches } = require('./helpers/floorMemory');
const records = Array.from({ length: 105 }, (_, index) => ({ _id: String(index), name: index < 65 ? 'Nunawading lead' : 'Caroline lead',
  dealer: index < 65 ? 'BYD Nunawading' : 'BYD Caroline Springs', stage: 'NEW ENQUIRIES', source: index % 2 ? 'Web' : 'Walk-in',
  model: index % 2 ? 'SEAL' : 'ATTO 3', vehicle: index % 2 ? 'SEAL' : 'ATTO 3', score: index % 100,
  allocatedPersonFullName: 'Another colleague', createdAt: new Date('2026-11-05T20:00:00Z') }));
function database(rows = records) {
  const collection = {
    async countDocuments(query) { return rows.filter(doc => matches(doc, query)).length; },
    async distinct(field, query) { return [...new Set(rows.filter(doc => matches(doc, query)).map(doc => get(doc, field)).filter(Boolean))]; },
    find(query) {
      let data = rows.filter(doc => matches(doc, query));
      return { sort() { return this; }, skip(n) { data = data.slice(n); return this; }, limit(n) { data = data.slice(0, n); return this; }, async toArray() { return data; } };
    },
  };
  return { collection: () => collection };
}
const staff = { role: 'sales_consultant', site: 'BYD Nunawading', platform: 'sales_floor' };

test('staff see every lead at their site, including colleagues, and filters cannot widen it', async () => {
  const db = database();
  const first = await floor.leads({ lead: db }, { limit: 30 }, staff);
  const third = await floor.leads({ lead: db }, { page: 3, limit: 30, site: 'BYD Caroline Springs' }, staff);
  assert.equal(first.pagination.total, 65);
  assert.equal(third.data.length, 5);
  assert.ok(third.data.every(row => row.dealer === 'BYD Nunawading'));
  assert.deepEqual(first.meta.filters.models, ['ATTO 3', 'SEAL']);
  const search = await floor.leads({ lead: db }, { q: 'Caroline', filterSite: 'BYD Caroline Springs' }, staff);
  assert.equal(search.pagination.total, 0);
  const filtered = await floor.leads({ lead: db }, { model: 'SEAL', source: 'Web', scoreMin: 60 }, staff);
  assert.equal(filtered.pagination.total, 2);
});

test('admin browsing includes all sites regardless of a saved site while unassigned staff fail closed', async () => {
  for (const role of ['admin', 'site_admin', 'super_admin']) {
    const result = await floor.leads({ lead: database() }, { site: 'BYD Nunawading', page: 4, limit: 30 }, { ...staff, role, locked_site: staff.site });
    assert.equal(result.pagination.total, 105);
    assert.equal(result.data.length, 15);
  }
  assert.throws(() => floor.accountScope({ role: 'agent' }), { statusCode: 403 });
});

test('Today uses complete counts and Melbourne dates; Calendar receives the same authenticated scope', async t => {
  const calls = [];
  t.mock.method(browse, 'calendar', async (db, query, user) => {
    calls.push({ query, user });
    return { data: [], pagination: { total: query.category === 'delivery' ? 7 : 11, page: 1, limit: 25, pages: 1 }, meta: { sourceCounts: { appointment: 4 }, nextEvent: null } };
  });
  const db = database();
  const result = await floor.today({ lead: db, panel: db }, {}, staff, new Date('2026-11-05T20:00:00Z'));
  assert.equal(result.data.date, '2026-11-06');
  assert.equal(result.data.stats.totalLeads, 65);
  assert.equal(result.data.stats.needsMe, 65);
  assert.equal(result.data.leads.length, 5);
  assert.equal(result.data.stats.appointmentsToday, 4);
  assert.equal(result.data.stats.deliveriesThisWeek, 7);
  assert.equal(calls[0].query.to, '2026-11-07');
  assert.equal(calls[1].query.to, '2026-11-13');
  await floor.calendar({ lead: db, panel: db }, { from: '2026-11-01', to: '2026-12-01', site: 'BYD Caroline Springs' }, staff);
  assert.equal(calls.at(-1).user.locked_site, 'BYD Nunawading');
  assert.equal(calls.at(-1).query.site, '');
});

test('calendar export uses real stable IDs, UTC instants and escaped, folded UTF-8 text', () => {
  const content = floor.calendarIcs([{ id: 'appointment:real-id', date: '2026-11-05T23:00:00Z', endsAt: '2026-11-05T23:45:00Z', title: 'Customer, event; one\nnext', subtitle: '車'.repeat(80), site: 'BYD Nunawading', status: 'Cancelled' }]);
  assert.ok(content.includes('UID:appointment:real-id@sales-floor'));
  assert.ok(content.includes('DTSTART:20261105T230000Z'));
  assert.ok(content.includes('Customer\\, event\\; one\\nnext'));
  assert.ok(content.includes('STATUS:CANCELLED'));
  assert.ok(content.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
});

test('all-site BYD browsing excludes other brands and Today attention excludes already closed enquiries',async t=>{
  t.mock.method(browse,'calendar',async()=>({data:[],pagination:{total:0,page:1},meta:{sourceCounts:{appointment:5},scheduledAppointments:3,nextEvent:null}}));
  const db=database([
    {_id:'open',dealer:'BYD Fairfield',stage:'NEW ENQUIRIES',score:90},
    {_id:'sold',dealer:'BYD Fairfield',stage:'DELIVERED',status:'sold',score:99},
    {_id:'other-brand',dealer:'Denza Melbourne',stage:'NEW ENQUIRIES',score:99},
  ]);
  const user={role:'sales_manager',all_sites:true,site:'All Sites'};
  const result=await floor.today({lead:db,panel:db},{},user);
  assert.equal(result.data.stats.totalLeads,2);assert.equal(result.data.stats.needsMe,1);
  assert.equal(result.data.stats.appointmentsToday,3);
  assert.equal(result.data.leads[0]._id,'open');
  const rows=await floor.leads({lead:db},{},{...user,role:'super_admin'});
  assert.equal(rows.pagination.total,2);assert.ok(rows.data.every(row=>row.dealer.startsWith('BYD')));
});
