const test=require('node:test');
const assert=require('node:assert/strict');
const { phoneRegex,inboundId,receivedAt }=require('../src/services/smsEvent');
test('provider sender matches spaced, local and international phones, without partial matches',()=>{
 const regex=phoneRegex('+61499918523');
 for(const value of ['+61 499 918 523','0499 918 523','61499918523','+61499918523'])assert.equal(regex.test(value),true);
 for(const value of ['+61499918524','+614999185230','+15499918523'])assert.equal(regex.test(value),false);
});
test('documented payload retries use a stable inbound ID distinct from outbound correlation',()=>{
 const payload={sender:'61499918523',to:'61468104118',message:'SYNC CHECK 1210',received_at:'2026-10-12 09:00:00',type:'inbound',original_message_id:'outgoing-id'};
 const id=inboundId(payload,payload.sender,payload.message);
 assert.equal(id,inboundId({...payload},'+61 499 918 523',payload.message));
 assert.notEqual(id,payload.original_message_id);
 assert.notEqual(id,inboundId({...payload,received_at:'2026-10-12 09:00:01'},payload.sender,payload.message));
 assert.equal(receivedAt(payload).toISOString(),'2026-10-12T09:00:00.000Z');
});
test('explicit inbound provider IDs are preserved',()=>{
 assert.equal(inboundId({message_id:'inbound-id'},'61499918523','reply'),'inbound-id');
});

test('inbound site follows outbound ownership; ambiguous phone owners fail closed',()=>{
 const { inboundSite }=require('../src/services/smsEvent');
 const leads=[{dealer:'BYD Melbourne'},{dealer:'BYD Nunawading'}];
 const clients=[{id:'delivery-1',site_location:'BYD Melbourne'}];
 assert.equal(inboundSite(null,null,leads,clients),'');
 assert.equal(inboundSite({client_id:'delivery-1'},null,leads,clients),'BYD Melbourne');
 assert.equal(inboundSite(null,{dealer:'BYD Nunawading'},leads,clients),'BYD Nunawading');
 assert.equal(inboundSite(null,null,[{dealer:'Melbourne CBD'}],clients),'Melbourne CBD');
});
