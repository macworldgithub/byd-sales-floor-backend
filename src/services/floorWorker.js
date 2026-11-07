const { SalesFloorOperations } = require('./salesFloorOperations');
const p = require('./salesFloorPolicy');
const { and } = require('./salesFloorMobile');
const bydScope = fields => p.scope({ role: 'manager', all_sites: true }, {}, fields);
let running = false;
async function tick(lead, panel, fetchImpl = fetch) {
  if (running) return;
  running = true;
  try {
    const service = new SalesFloorOperations(lead, panel);
    const rows = await lead.collection('leads').find(and(bydScope(['dealer', 'site']), { isArchived: { $ne: true }, stage: { $nin: ['DELIVERED', 'LOST', 'OPTED OUT'] } })).toArray();
    for (const row of rows) {
      const settings = await service.config(row.dealer || row.site), last = row.lastEngagementAt || row.lastContactAt || row.createdAt;
      if (last && Date.now() - new Date(last).getTime() >= 3 * 86400000 && settings.alertTypes.includes('high_risk')) await service.notify(row, 'high_risk', `High Risk · ${row.name}`, row.lastQuoteAt ? 'No response after quote' : row.lastTestDriveAt ? 'No response after test drive' : 'No customer engagement for 3+ days', `inactive:${row._id}:${new Date(last).toISOString()}`);
    }
    const clients = await panel.collection('clients').find(and(bydScope(['site_location', 'site']), { stage: { $ne: 'Delivered' }, delivery_date: { $exists: true }, deliveredAt: null })).toArray();
    for (const client of clients) if (new Date(client.delivery_date) <= new Date(Date.now() + 86400000) && (!client.pdiComplete || (client.accessories || []).some(a => a.status !== 'Fitted' || !a.proofId))) {
      await service.notify({ ...client, dealer: client.site_location || client.site, allocatedPersonFullName: client.salesperson, owner_user_id: client.consultantId }, 'delivery', `Delivery work incomplete · ${client.name}`, 'PDI or accessory photo proof is outstanding.', `delivery:${client._id}:${client.delivery_date}`);
    }
    const tasks = await panel.collection('floor_tasks').find(and(bydScope(['site']), { status: 'open', dueAt: { $lte: new Date() } })).toArray();
    for (const task of tasks) await service.notify({ ...task, _id: task.leadId, dealer: task.site }, 'task', task.title, 'A manager task is overdue.', `overdue:${task._id}`);
    const push = new (require('./floorPush').FloorPush)(panel, fetchImpl);
    const pending = await panel.collection('floor_notifications').find(and(bydScope(['site']), { pushState: { $in: ['pending', 'waiting_device'] }, type: { $in: ['high_buyer', 'price_objection', 'high_risk', 'delivery', 'task'] } })).limit(100).toArray();
    for (const notification of pending) await push.dispatch(notification);
    await push.reconcile();

  } finally { running = false; }
}
module.exports = { tick };
