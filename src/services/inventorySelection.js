const { fail, siteKey } = require('./accountAccess');
const { ObjectId } = require('mongoose').mongo;
async function selectInventory(leadDb, panelDb, stockId, opportunity) {
  if (typeof stockId !== 'string' || !stockId.trim() || stockId.length > 120) fail(400, 'Select a valid inventory vehicle.');
  const raw = stockId.replace(/^VY-VIC-/, '');
  const identities = [{ stock: raw }, { identifier: stockId }, { stock_id: stockId }, { legacyId: stockId }];
  if (/^[a-f\d]{24}$/i.test(stockId)) identities.push({ _id: new ObjectId(stockId) });
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) identities.push({ stock: Number(raw) }, { identifier: Number(raw) }, { legacyId: Number(raw) });
  const stock = await leadDb.collection('inventories').findOne({ $or: identities });
  if (!stock) fail(404, 'Inventory vehicle not found. Refresh the inventory search.');
  const site = stock.site || stock.dealer || stock.orderYard || stock.shirleyData?.outBoundStore || stock.location || stock.yard;
  if (!site || siteKey(site) !== siteKey(opportunity.site)) fail(404, 'Inventory vehicle is not at this dealership.');
  if (/sold|delivered|withdrawn/i.test(String(stock.status || ''))) fail(409, 'This inventory vehicle is no longer available.');
  const hold = await panelDb.collection('stockholds').findOne({ vy_stock_id: stockId, status: 'active', opportunity_id: { $ne: opportunity.opportunity_id } });
  if (hold) fail(409, 'This inventory vehicle is held for another deal.');
  const vin = String(stock.registration?.vin || stock.vin || '').trim();
  if (!vin) fail(400, 'This inventory vehicle has no VIN yet. Choose TBA instead.');
  return { vin, stock_id: stockId, make: stock.make || stock.specifications?.make || 'BYD', model: stock.specifications?.model || stock.model || opportunity.model };
}
module.exports = { selectInventory };
