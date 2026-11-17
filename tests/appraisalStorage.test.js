const test=require('node:test');
const assert=require('node:assert/strict');
const {database}=require('./helpers/floorMemory');
const {storage,MARKER}=require('../src/services/appraisalStorage');
test('shared storage isolates logical appraisals from each other and existing integration checkpoints',async()=>{
 process.env.APPRAISAL_STATE_COLLECTION='idempotency_keys';
 try{
  const db=database({idempotency_keys:[{_id:'legacy',event_id:'original-event',scope:'contract',response:{kept:true}}]}),s=storage(db);
  await s.collection('appraisal_partners').insertOne({_id:'partner',name:'Partner',site:'BYD Fairfield'});
  await s.collection('iappraise_archive').updateOne({_id:'archive'},{$setOnInsert:{sourceId:'source-1',site:'BYD Fairfield'}},{upsert:true});
  assert.equal(await s.collection('appraisal_partners').countDocuments({}),1);assert.equal(await s.collection('iappraise_archive').countDocuments({}),1);
  assert.equal(await s.collection('appraisal_invitations').countDocuments({}),0);assert.equal(await s.collection('iappraise_archive').findOne({_id:'legacy'}),null);
  assert.equal((await s.collection('appraisal_partners').findOne({_id:'partner'}))[MARKER],undefined);
  assert.equal((await s.collection('appraisal_partners').find({}).sort({name:1}).limit(1).toArray())[0].name,'Partner');
  await s.collection('appraisal_partners').updateOne({_id:'legacy'},{$set:{name:'overwrite'}});assert.equal(db.collection('idempotency_keys').rows[0].name,undefined);assert.deepEqual(db.collection('idempotency_keys').rows[0].response,{kept:true});
  assert.throws(()=>s.collection('appraisal_partners').updateOne({_id:'partner'},{$set:{[MARKER]:'iappraise_archive'}}),/immutable/);
  await s.collection('appraisal_partners').deleteOne({});assert.equal(db.collection('idempotency_keys').rows.length,2);assert.equal(db.collection('idempotency_keys').rows[0].event_id,'original-event');
  assert.equal(db.collection('appraisal_partners').rows.length,0);assert.equal(db.collection('iappraise_archive').rows.length,0);
 }finally{delete process.env.APPRAISAL_STATE_COLLECTION;}
});
test('shared source imports remain scoped and repeatable without creating any new physical collections',async()=>{
 process.env.APPRAISAL_STATE_COLLECTION='idempotency_keys';
 try{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),migration=require('../src/services/iappraiseMigration'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'byd-shared-import-'));
  try{
   const row={Dealership:'BYD Melbourne',Department:'Nunawading - NEW','Customer Name':'Source',Rego:'ABC123',VIN:'',Make:'Toyota',Model:'Corolla',Year:'2020'},source=path.join(dir,'source.json');
   await fs.writeFile(source,JSON.stringify({records:[row],recordCount:1,columns:Object.keys(row)}));const prepared=await migration.prepare(source,undefined,{'BYD Melbourne::Nunawading - NEW':'BYD Nunawading'}),db=database({idempotency_keys:[{_id:'legacy',event_id:'kept'}]});
   await migration.apply(prepared,db,path.join(dir,'archive'));await migration.apply(prepared,db,path.join(dir,'archive'));assert.equal(db.collection('idempotency_keys').rows.length,2);assert.equal(await storage(db).collection('iappraise_archive').countDocuments({}),1);assert.equal(db.tables.size,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }finally{delete process.env.APPRAISAL_STATE_COLLECTION;}
});
