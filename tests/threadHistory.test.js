const test = require('node:test');
const assert = require('node:assert/strict');
const { phoneKey, siteKey, allowedSite, buildThreads } = require('../src/services/threadHistory');
const phone = '+61 499 918 523';
const lead = { _id: 'lead', phone: '0499 918 523', dealer: 'BYD Caroline Springs', name: 'Test Lead' };
const client = { id: 'delivery-client', phone: '+61499918523', site_location: 'BYD Caroline Springs', name: 'Test Lead' };
test('Australian phone formats and site aliases have a stable identity', () => {
  assert.equal(phoneKey(phone), phoneKey('0499-918-523'));
  assert.equal(phoneKey(phone), phoneKey('61499918523'));
  assert.equal(siteKey('BYD Fairfield VIC'), siteKey('Fairfield'));
  assert.notEqual(siteKey('Denza Melbourne'), siteKey('Melbourne'));
});
test('single, bulk, inbound and historical SMS merge without duplicate provider IDs', () => {
  const conversations = [{ _id: 'thread', phone, dealer: lead.dealer, messages: [
    { id: 'sent', sender: 'agent', text: 'hello', status: 'sent', createdAt: '2026-10-12T00:00:00Z' },
    { id: 'old', sender: 'ai', text: 'older', status: 'sent', createdAt: '2026-10-11T00:00:00Z' },
  ] }];
  const messages = [
    { phone: client.phone, body: 'hello', provider_message_id: 'sent', direction: 'outbound', status: 'delivered', sent_at: '2026-10-12T00:00:00Z' },
    { phone, body: 'bulk', id: 'bulk', client_id: client.id, direction: 'outbound', status: 'simulated', sent_at: '2026-10-12T00:01:00Z' },
    { phone, body: 'reply', provider_message_id: 'reply', direction: 'inbound', status: 'received', sent_at: '2026-10-12T00:02:00Z' },
    { phone, body: 'reply', provider_message_id: 'reply', direction: 'inbound', status: 'received', sent_at: '2026-10-12T00:02:00Z' },
  ];
  const [thread] = buildThreads(conversations, messages, [lead], [client]);
  assert.equal(thread.msgCount, 4);
  assert.equal(thread.lastMessage, 'reply');
  assert.equal(thread.messages.find(m => m.id === 'sent').status, 'delivered');
  assert.deepEqual(thread.messages.map(m => m.id), ['old', 'sent', 'bulk', 'reply']);
});
test('same phone at different sites stays isolated; unknown sites fail closed', () => {
  const threads = buildThreads([
    { _id: 'a', phone, dealer: 'BYD Caroline Springs', messages: [{ id: 'a', sender: 'agent', text: 'a' }] },
    { _id: 'b', phone, dealer: 'BYD Nunawading', messages: [{ id: 'b', sender: 'agent', text: 'b' }] },
  ], [], [], []);
  assert.equal(threads.length, 2);
  const user = { role: 'super_admin', locked_site: 'Caroline Springs' };
  assert.equal(threads.filter(t => allowedSite(user, t.dealer)).length, 1);
  assert.equal(allowedSite(user, ''), false);
  assert.equal(allowedSite({ role: 'contractor' }, lead.dealer), false);
  assert.equal(allowedSite({ role: 'agent', site: 'Nunawading' }, lead.dealer), false);
});
test('authorized readers see one full phone thread; site locks filter before aggregation', async () => {
  const { getThreads } = require('../src/services/threadHistory');
  const sources = {
    conversations: [
      { _id: 'thread-a', phone, dealer: 'BYD Melbourne', messages: [{ id: 'a', sender: 'agent', text: 'sales', createdAt: '2026-10-12T00:00:00Z' }] },
      { _id: 'thread-b', phone, dealer: 'Denza Melbourne', messages: [{ id: 'b', sender: 'user', text: 'delivery', createdAt: '2026-10-12T00:01:00Z' }] },
    ],
    leads: [], clients: [], messages: [],
  };
  const db = { collection: name => ({ find: () => ({ toArray: async () => sources[name] }) }) };
  const admin = await getThreads(db, db, { role: 'super_admin' });
  assert.equal(admin.length, 1);
  assert.equal(admin[0].msgCount, 2);
  const locked = await getThreads(db, db, { role: 'super_admin', locked_site: 'BYD Melbourne' });
  assert.equal(locked[0].msgCount, 1);
  assert.equal(locked[0].messages[0].text, 'sales');
  assert.deepEqual(await getThreads(db, db, { role: 'agent', site: 'Nunawading' }), []);
});
test('legacy site aliases preserve every original thread identity and the lead link', async () => {
  const { getThreads } = require('../src/services/threadHistory');
  const sources = { conversations: [
    { _id: 'legacy', phone, dealer: 'Melbourne CBD', messages: [{ id: 'a', sender: 'agent', text: 'legacy' }] },
    { _id: 'current', leadId: 'real-lead', phone, dealer: 'BYD Melbourne', messages: [{ id: 'b', sender: 'ai', text: 'current' }] },
  ], leads: [], clients: [], messages: [] };
  const db = { collection: name => ({ find: () => ({ toArray: async () => sources[name] }) }) };
  const [thread] = await getThreads(db, db, { role: 'super_admin' });
  assert.deepEqual(thread.threadIds, ['legacy', 'current']);
  assert.equal(thread.leadId, 'real-lead');
  assert.equal(thread.msgCount, 2);
});
test('legacy inbound replies inherit their outbound site even when one phone has multiple sites',()=>{
 const conversations=[{_id:'byd',phone,dealer:'BYD Melbourne',messages:[]}];
 const messages=[
  {id:'out',provider_message_id:'out',phone,site:'Denza Melbourne',body:'outgoing',direction:'outbound',status:'sent'},
  {id:'incoming',provider_message_id:'incoming',phone,body:'reply',direction:'inbound',status:'received',provider_response:{original_message_id:'out'}},
 ];
 const threads=buildThreads(conversations,messages,[],[{id:'denza',phone,site_location:'Denza Melbourne'}]);
 const denza=threads.find(t=>t.dealer==='Denza Melbourne');
 assert.equal(denza.msgCount,2);
 assert.equal(threads.find(t=>t.dealer==='BYD Melbourne').msgCount,0);
});
