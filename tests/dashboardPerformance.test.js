const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./helpers/floorMemory');
const { SalesFloorOperations } = require('../src/services/salesFloorOperations');
const metrics = require('../src/services/dashboardMetrics');
const p = require('../src/services/salesFloorPolicy');
const manager = { id: 'manager', role: 'sales_manager', site: 'BYD Fairfield', locked_site: 'BYD Fairfield', allowed_sites: ['BYD Fairfield'] };

test('summary counts all records beyond the old caps without including other sites or archived activity', async () => {
  const now = new Date(), site = manager.site;
  const leads = Array.from({ length: 1105 }, (_, i) => ({ _id: String(i), dealer: site, stage: 'NEW ENQUIRIES', createdAt: now, assignedTo: 'sales@example.invalid' }));
  leads.push({ _id: 'archived', dealer: site, isArchived: true }, { _id: 'other', dealer: 'BYD Nunawading' });
  const lead = database({ leads, appointments: Array.from({length: 205}, () => ({ site, createdAt: now, status: 'Confirmed' })),
    deals: [{site,leadId:'1104',contractSignedAt:now}] });
  const panel = database({ floor_tasks: Array.from({length:105}, () => ({site,status:'open',dueAt:new Date(now - 3600000)})),
    timelineevents: Array.from({length:205}, () => ({site,type:'Video sent',createdAt:now})) });
  const result = await new SalesFloorOperations(lead,panel).summary({period:'today'},manager);
  assert.equal(result.activeLeads,1105);
  assert.equal(result.unactionedLeads,1105);
  assert.equal(result.appointmentsBooked,205);
  assert.equal(result.videosSent,205);
  assert.equal(result.overdueSla,105);
  assert.equal(result.dealsCompleted,1);
  assert.equal(result.conversionRate,0.1);
});

test('dashboard aggregates preserve mixed date formats, ownership, traffic thresholds and conversion semantics', async () => {
  const now = new Date('2026-11-21T10:00:00Z'), from = new Date('2026-11-20T13:00:00Z');
  const rows = [
    {_id:'one',dealer:manager.site,name:'One',allocatedPersonFullName:'Alex',assignedTo:'alex@example.invalid',stage:'NEW ENQUIRIES',createdAt:now.toISOString(),lastContactAt:new Date(now-25*3600000)},
    {_id:'two',dealer:manager.site,name:'Two',allocatedPersonFullName:'',owner_name:'Alex',assignedTo:'alex@example.invalid',stage:'NEW ENQUIRIES',isArchived:'',lastContactAt:'',createdAt:new Date(now-73*3600000)},
    {_id:'lost',dealer:manager.site,allocatedPersonFullName:'Alex',stage:'LOST',createdAt:now},
    {_id:'invalid',dealer:manager.site,allocatedPersonFullName:'Alex',stage:'NEW ENQUIRIES',createdAt:'invalid'},
    {_id:'archived',dealer:manager.site,isArchived:true,allocatedPersonFullName:'Alex',stage:'NEW ENQUIRIES',createdAt:now},
    {_id:'other',dealer:'BYD Nunawading',site:manager.site,allocatedPersonFullName:'Alex',createdAt:now},
  ];
  const db=database({leads:rows}), config=p.DEFAULTS, deals=[{leadId:'one',contractSignedAt:now}];
  const filter=p.scope(manager,{},['dealer','site']);
  const result=await metrics.summary(db.collection('leads'),filter,deals,config,{from,to:now},now);
  assert.equal(result.activeLeads,3);
  assert.equal(result.created,3);
  assert.equal(result.converted,1);
  assert.equal(result.overdueLeads,1);
  const [alex]=await metrics.pulse(db.collection('leads'),filter,deals,config,now);
  assert.equal(alex.total,5);
  assert.equal(alex.sold,1);
  assert.equal(alex.activeLeads,3);
  assert.equal(alex.overdueSla,2);
  assert.equal(alex.maxFollowupHours,73);
  assert.equal(alex.trafficLight,'red');
  assert.equal(alex.conversionRate,20);
  assert.deepEqual(alex.flaggedLeads.map(row=>row.id),['one','two']);
  assert.equal(alex.flaggedLeads[0].age,'25h');
  await assert.rejects(new SalesFloorOperations(db,database()).pulse({}, {...manager,role:'sales_consultant'}), {statusCode:403});
});
