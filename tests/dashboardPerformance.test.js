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
  assert.equal(result.activeLeads,1);
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

test('Today, Weekly and MTD use received dates and recognize imported contact history', async () => {
  const now=new Date('2026-11-21T10:00:00Z'), today=new Date('2026-11-21T01:00:00Z');
  const rows=[
    {_id:'today',leadDate:today,createdAt:today,lastContact:'2026-11-21T02:00:00Z'},
    {_id:'week',leadDate:new Date('2026-11-18T01:00:00Z'),createdAt:today},
    {_id:'month',leadCreatedDate:'2026-11-02T01:00:00Z',createdAt:today,lastContact:' Never '},
    {_id:'backfill',leadDate:new Date('2026-10-01T01:00:00Z'),createdAt:today,lastContact:'2026-10-02T01:00:00Z'},
    {_id:'stats',leadDate:'invalid',leadCreatedDate:today,createdAt:today,leadStats:{smsCount:'2'}},
    {_id:'placeholder',createdAt:today,lastContact:'N/A'},
    {_id:'relative',createdAt:today,lastContact:'3 days ago'},
  ].map(row=>({...row,dealer:manager.site,stage:'NEW ENQUIRIES'}));
  rows.push({...rows[0],_id:'archived',isArchived:true});
  const db=database({leads:rows});
  for(const [period,active,unactioned] of [['today',4,1],['weekly',5,2],['mtd',6,3]]) {
    const result=await metrics.summary(db.collection('leads'),p.scope(manager,{},['dealer','site']),[],p.DEFAULTS,p.period(period,now),now);
    assert.equal(result.activeLeads,active,period);
    assert.equal(result.unactionedLeads,unactioned,period);
  }
});

test('PULSE independently paginates consultant totals and follow-ups without duplicate or missing customers', async () => {
  const now=new Date('2026-11-21T10:00:00Z');
  const leads=Array.from({length:48},(_,i)=>({_id:String(i).padStart(3,'0'),name:`Customer ${i}`,dealer:manager.site,
    allocatedPersonFullName:`Consultant ${String(Math.floor(i/4)).padStart(2,'0')}`,createdAt:new Date(now-80*3600000),stage:'NEW ENQUIRIES'}));
  leads.push({...leads[0],_id:'outside',dealer:'BYD Nunawading',site:manager.site});
  const db=database({leads}), filter=p.scope(manager,{},['dealer','site']);
  const read=(page,followupPage)=>metrics.pagedPulse(db.collection('leads'),filter,[],p.DEFAULTS,{page,limit:5,followupPage,followupLimit:7},now);
  const first=await read(1,1), second=await read(2,2);
  assert.equal(first.pagination.total,12);assert.equal(first.followupPagination.total,48);
  assert.equal(first.consultants.length,5);assert.equal(first.followups.length,7);
  assert.ok(first.consultants.every(row=>row.activeLeads===4&&row.overdueSla===4&&row.flaggedLeads.length===0));
  assert.equal(first.consultants.some(a=>second.consultants.some(b=>a.name===b.name)),false);
  const ids=[];
  for(let page=1;page<=7;page++) ids.push(...(await read(1,page)).followups.map(row=>row.id));
  assert.equal(ids.length,48);assert.equal(new Set(ids).size,48);assert.equal(ids.includes('outside'),false);
  const last=await read(999,999);
  assert.equal(last.pagination.page,3);assert.equal(last.consultants.length,2);
  assert.equal(last.followupPagination.page,7);assert.equal(last.followups.length,6);
  const empty=await metrics.pagedPulse(database().collection('leads'),filter,[],p.DEFAULTS,{page:5,followupPage:5},now);
  assert.equal(empty.pagination.page,1);assert.equal(empty.followupPagination.total,0);
});

test('invalid PULSE pages are rejected before any database read', async () => {
  const service=new SalesFloorOperations({collection(){throw Error('Unexpected database read');}},{});
  for(const query of [{page:0},{page:-1},{page:1.5},{limit:0},{limit:51},{followupPage:'bad'},{followupLimit:100},{page:Number.MAX_SAFE_INTEGER,limit:50}]) {
    await assert.rejects(service.pulse(query,manager),{statusCode:400});
  }
});
