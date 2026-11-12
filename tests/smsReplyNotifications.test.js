const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../src/services/smsReplyNotifications');
const user = { id:'staff',email:'staff@example.com',role:'sales_consultant',locked_site:'BYD Fairfield' };
const message = (id, fields={}) => ({provider_message_id:id,direction:'inbound',phone:'+61499918523',site:'BYD Fairfield',client_name:'Fixture Customer',body:'A normal reply with no alert keywords',sent_at:new Date(),...fields});
function fixture() {
  const rows=[];
  const matches=(row,query)=>Object.entries(query).every(([key,value])=>{
    if(key==='$or')return value.some(q=>matches(row,q));
    if(value && typeof value==='object') {
      if('$ne' in value)return Array.isArray(row[key])?!row[key].includes(value.$ne):row[key]!==value.$ne;
      if('$in' in value)return value.$in.includes(row[key]);
    }
    return row[key]===value;
  });
  const collection={
    async updateOne(filter,update){if(!rows.some(row=>matches(row,filter))) rows.push(structuredClone(update.$setOnInsert));},
    async updateMany(filter,update){for(const row of rows.filter(r=>matches(r,filter))){const key=update.$addToSet.read_by;if(!row.read_by.includes(key))row.read_by.push(key);}},
    async findOne(filter){return rows.find(row=>matches(row,filter)) || null;},
    async countDocuments(filter){return rows.filter(row=>matches(row,filter)).length;},
    find(filter){let selected=rows.filter(row=>matches(row,filter));return {
      sort(){selected.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)||b.id.localeCompare(a.id));return this;},
      skip(n){selected=selected.slice(n);return this;},limit(n){selected=selected.slice(0,n);return this;},async toArray(){return selected;}
    };},
  };
  return { rows,db:{collection:()=>collection} };
}
test('all inbound text replies notify, retries preserve read state and outbound/ambiguous records do not notify',async()=>{
 const {db,rows}=fixture();const id=await service.recordReply(db,message('event-1'));
 assert.equal(id,crypto.createHash('sha256').update('sms-reply:event-1').digest('hex'));
 assert.equal((await service.list(db,user)).unread_count,1);
 await service.read(db,user,id);await service.recordReply(db,message('event-1'));
 assert.equal(rows.length,1);assert.equal((await service.list(db,user)).unread_count,0);
 await service.recordReply(db,message('outbound',{direction:'outbound'}));await service.recordReply(db,message('ambiguous',{site:''}));assert.equal(rows.length,1);
});
test('read state is per account, durable across platforms and limited to viewed messages in the same conversation',async()=>{
 const {db}=fixture();const first=await service.recordReply(db,message('one'));await service.recordReply(db,message('two'));await service.recordReply(db,message('three',{phone:'+61400000000'}));
 await service.read(db,user,first,['one']);assert.equal((await service.list(db,user)).unread_count,2);
 assert.equal((await service.list(db,{...user,email:'other@example.com'})).unread_count,3);
 assert.equal(service.reader({...user,id:'different-platform-id',email:' STAFF@example.com '}),service.reader(user));
});
test('site restrictions apply to counts, previews, open and mark-read, including aliases and Denza separation',async()=>{
 const {db}=fixture();const privateId=await service.recordReply(db,message('private',{site:'BYD Nunawading'}));
 assert.equal((await service.list(db,user)).unread_count,0);
 await assert.rejects(service.read(db,user,privateId),e=>e.statusCode===404);
 await assert.rejects(service.list(db,user,{site:'BYD Nunawading'}),e=>e.statusCode===403);
 const melbourne={...user,locked_site:'BYD Melbourne City'};await service.recordReply(db,message('alias',{site:'Melbourne CBD'}));await service.recordReply(db,message('denza',{site:'Denza Melbourne'}));
 assert.equal((await service.list(db,melbourne)).unread_count,1);
});
test('notification pages retain total unread count, hide reader identities and expose older pages',async()=>{
 const {db}=fixture();for(let i=0;i<25;i++)await service.recordReply(db,message('page-'+i));
 const first=await service.list(db,user);assert.equal(first.items.length,20);assert.equal(first.unread_count,25);assert.equal(first.has_more,true);assert.equal(first.items[0].read_by,undefined);
 const second=await service.list(db,user,{offset:first.next_offset});assert.equal(second.items.length,5);assert.equal(second.has_more,false);assert.ok(!first.items.some(a=>second.items.some(b=>a.id===b.id)));
});
test('explicit account site grants govern notifications and conversation access even for elevated roles',async()=>{
 const {db}=fixture();await service.recordReply(db,message('site-one'));await service.recordReply(db,message('site-two',{site:'BYD Nunawading'}));
 const manager={...user,locked_site:'',role:'site_admin',allowed_sites:['BYD Fairfield'],all_sites:false};
 assert.equal((await service.list(db,manager)).unread_count,1);
 assert.equal((await service.list(db,{...manager,all_sites:true})).unread_count,2);
 assert.equal((await service.list(db,{...manager,allowed_sites:[]})).unread_count,0);
});
