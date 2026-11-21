const test=require('node:test'),assert=require('node:assert/strict');
const sales=require('../src/services/writtenSales');
const {database}=require('./helpers/floorMemory');
const {invalidateReads}=require('../src/services/readCache');
const site='BYD Fairfield',manager={role:'sales_manager',site,locked_site:site,allowed_sites:[site]};

test('one written sale shared by native, CRM, sales log and delivery records counts once',()=>{
 const result=sales.reconcile([
  ['native',[{_id:'native',site,leadId:'lead',contractSignedAt:'2026-11-21T00:30:00Z',virtualYard:{virtualYardOrderId:'VY1'},delivery:{deliveryClientId:'client'}}]],
  ['opportunity',[{_id:'opp',site,opportunity_id:'O1',customer_id:'C1',stage:'Written / Sold',sold_at:'2026-11-21T00:20:00Z',delivery_client_id:'client',sales_log_id:'S1'}]],
  ['saleslog',[{_id:'log',site,sales_log_id:'S1',opportunity_id:'O1',status:'written',deal_date:'2026-11-20'}]],
  ['delivery',[{_id:'client-object',id:'client',site_location:site,vy_order_id:'VY1',stage:'Delivered',order_date:'2026-11-20'}]],
 ],[{site,customer_id:'C1',lead_prospect_id:'lead'}]);
 assert.equal(result.sales.length,1);assert.deepEqual(result.sales[0].leadIds,['lead']);
 assert.equal(result.sales[0].contractSignedAt.toISOString(),'2026-11-21T00:30:00.000Z');
 assert.equal(result.quality.undatedSales,0);
});

test('order IDs deduplicate only within their site and source namespace; customers and VINs are not sale identities',()=>{
 const row={site_location:site,stage:'Scheduled',order_date:'2026-11-20',vin:'SAME-VIN',phone:'SAME-PHONE'};
 const result=sales.reconcile([['delivery',[
  {...row,_id:'a',vy_order_id:'one'}, {...row,_id:'b',vy_order_id:'one'},
  {...row,_id:'c',site_location:'BYD Nunawading',vy_order_id:'one'},
  {...row,_id:'d',dealerstudio_source_id:'one',vy_order_id:'one'},
  {...row,_id:'e',vy_order_id:'TBA'}, {...row,_id:'f',vy_order_id:'TBA'},
 ]]]);
 assert.equal(result.sales.length,5);
});

test('cancelled transactions remove stale written projections and expose their explicit lead IDs',()=>{
 const result=sales.reconcile([
  ['native',[{_id:'d',site,status:'Cancelled',leadId:'L',contractSignedAt:'2026-11-20',virtualYard:{virtualYardOrderId:'V'}}]],
  ['delivery',[{_id:'c',site_location:site,vy_order_id:'V',stage:'Delivered',order_date:'2026-11-20'}]],
 ]);
 assert.equal(result.sales.length,0);assert.deepEqual(result.cancelledLeadIds,['L']);
});

test('import timestamps never substitute for a missing sale date and an estimated booking is not a written sale',()=>{
 const result=sales.reconcile([
  ['delivery',[{_id:'known-sale',site_location:site,stage:'Delivered',created_at:'2026-11-21'},
   {_id:'estimate',site_location:site,stage:'Scheduled',created_at:'2026-11-21'}]],
  ['native',[{_id:'draft',site,status:'Draft',createdAt:'2026-11-21'}]],
  ['opportunity',[{_id:'working',site,stage:'Working',createdAt:'2026-11-21'}]],
 ]);
 assert.equal(result.sales.length,1);assert.equal(result.sales[0].contractSignedAt,null);
 assert.equal(result.quality.undatedSales,1);
 assert.equal(sales.date('2026-10-04').toISOString(),'2026-10-03T14:00:00.000Z');
 assert.equal(sales.date('2026-02-30'),null);
});

test('salesperson source reads enforce ownership, site precedence, and cache invalidation after writes',async()=>{
 const user={...manager,role:'sales_consultant',id:'alex',name:'Alex',email:'alex@example.invalid'};
 const lead=database(),panel=database({saleslogentries:[
  {_id:'own',site,status:'written',consultant_name:'Alex',deal_date:'2026-11-20'},
  {_id:'colleague',site,status:'written',consultant_name:'Other',deal_date:'2026-11-20'},
  {_id:'outside',site:'BYD Nunawading',dealer:site,status:'written',consultant_name:'Alex',deal_date:'2026-11-20'},
 ]});
 assert.equal((await sales.read(lead,panel,{},user)).sales.length,1);
 await panel.collection('saleslogentries').insertOne({_id:'second',site,status:'written',consultant_name:'Alex',deal_date:'2026-11-21'});
 invalidateReads();assert.equal((await sales.read(lead,panel,{},user)).sales.length,2);
 await assert.rejects(sales.read(lead,panel,{site:'All Sites'},{...user,locked_site:'',all_sites:true}),{statusCode:403});
});

test('dated targets support both schemas, prefer native overrides and preserve a configured zero',async()=>{
 const panel=database({crmtargets:[{site,period:'2026-11',consultant:'Alex',targetUnits:0}],targets:[
  {site,month:'2026-11',user_name:'Alex',unit_target:20},{site,month:'2026-11',user_name:'Other',unit_target:10},
  {site,month:'2026-09',user_name:'Old',unit_target:500},
 ]});
 assert.equal(await sales.monthlyTarget(panel,{},manager,'2026-11'),10);
 assert.equal(await sales.monthlyTarget(panel,{},manager,'2026-12'),null);
});
