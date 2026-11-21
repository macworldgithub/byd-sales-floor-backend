const test = require('node:test');
const assert = require('node:assert/strict');
const { ReadCache, readRequest, invalidateReads } = require('../src/services/readCache');

test('concurrent reads coalesce, expire after completion, and failed reads can retry', async () => {
  let now=0, calls=0, finish;
  const cache=new ReadCache({now:()=>now,ttl:5});
  const loader=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const first=cache.read('key',loader);
  await Promise.resolve();
  now=10;
  const second=cache.read('key',loader);
  finish(42);
  assert.deepEqual(await Promise.all([first,second]),[42,42]);
  assert.equal(calls,1);
  assert.equal(await cache.read('key',()=>0),42);
  now=16;
  assert.equal(await cache.read('key',()=>99),99);
  await assert.rejects(cache.read('failed',()=>{throw Error('fail');}),/fail/);
  assert.equal(await cache.read('failed',()=>1),1);
});

test('mutation invalidation prevents stale completed and in-flight reads from being reused', async () => {
  const cache=new ReadCache();
  let finish;
  const pending=cache.read('key',()=>new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();
  invalidateReads();
  assert.equal(await cache.read('key',()=>2),2);
  finish(1); await pending;
  assert.equal(await cache.read('key',()=>3),2);
  invalidateReads();
  assert.equal(await cache.read('key',()=>3),3);
});

test('cache keys isolate accounts, sites, permissions, query strings and databases', async () => {
  const db={}, req={baseUrl:'/api/mobile',path:'/pulse',query:{period:'today'},headers:{'x-site':'BYD Fairfield'},user:{id:'a',role:'sales_manager',locked_site:'BYD Fairfield'}};
  let calls=0;
  const read=(database,request)=>readRequest(database,request,async()=>++calls);
  assert.equal(await read(db,req),1); assert.equal(await read(db,req),1);
  for(const changed of [
    {...req,user:{...req.user,id:'b'}}, {...req,user:{...req.user,role:'sales_consultant'}},
    {...req,user:{...req.user,auth_version:2}}, {...req,headers:{'x-site':'BYD Nunawading'}},
    {...req,query:{period:'mtd'}}, {...req,user:{...req.user,allowed_sites:['BYD Nunawading']}},
  ]) { const before=calls; assert.equal(await read(db,changed),before+1); assert.equal(calls,before+1); }
  const before=calls; await read({},req); assert.equal(calls,before+1);
});

test('cache bounds entries and does not retain large payloads', async () => {
  const cache=new ReadCache({maxEntries:2,maxBytes:20});
  await cache.read('a',()=>1); await cache.read('b',()=>2); await cache.read('c',()=>3);
  assert.equal(cache.entries.size,2); assert.equal(cache.entries.has('a'),false);
  await cache.read('large',()=> 'x'.repeat(100));
  assert.equal(cache.entries.has('large'),false);
});
