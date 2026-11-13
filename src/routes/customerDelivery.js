const express = require('express');
const { authenticate, enforceSiteLock } = require('../middleware/auth');
const { deliveryConn, leadConn, ensureDbConnected } = require('../db');
const service = require('../services/customerDelivery');
const crm = require('../services/crmService');
const crypto = require('crypto');
const router = express.Router();
router.use(authenticate, enforceSiteLock);
router.use((req, res, next) => {
  const access = req.user.platform_access;
  if (Array.isArray(access) && !access.some(platform => ['crm', 'sales_floor'].includes(platform))) return res.status(403).json({ success: false, message: 'Sales access is required.' });
  next();
});
router.use(async (req, res, next) => { try { await ensureDbConnected(); res.set('Cache-Control', 'no-store'); next(); } catch (error) { next(error); } });
router.get('/delivery-notifications', async (req, res, next) => {
  try { res.json({ success: true, data: await service.notifications(deliveryConn.db, req.user) }); } catch (error) { next(error); }
});
router.get('/profiles/:id/delivery', async (req, res, next) => {
  try { res.json({ success: true, data: service.view(await service.profile(deliveryConn.db, leadConn.db, req.params.id, req.user), req.query.before) }); } catch (error) { next(error); }
});
router.post('/profiles/:id/delivery/read', async (req, res, next) => {
  try {
    const record = await service.profile(deliveryConn.db, leadConn.db, req.params.id, req.user);
    if (record.client && req.body.last_message_id) await deliveryConn.db.collection('clients').updateOne({ _id: record.client._id, last_delivery_message_id: req.body.last_message_id }, { $set: { sales_unread: 0 } });
    res.json({ success: true });
  } catch (error) { next(error); }
});
router.post('/profiles/:id/delivery/messages', async (req, res, next) => {
  try {
    const record = await service.profile(deliveryConn.db, leadConn.db, req.params.id, req.user);
    res.status(201).json({ success: true, data: await service.chat(deliveryConn.db, record, req.body.body, req.user) });
  } catch (error) { next(error); }
});
router.post('/profiles/:id/sold', async (req, res, next) => {
  try {
    const delivery_handoff = service.handoffFields(req.body.delivery_handoff);
    if (!String(req.body.vin || '').trim() && req.body.is_factory_order !== true) return res.status(400).json({ success: false, message: 'Enter the VIN or select Factory Order.' });
    const record = await service.profile(deliveryConn.db, leadConn.db, req.params.id, req.user, true);
    const coll = deliveryConn.db.collection('opportunities');
    let opp = req.body.opportunity_id ? await coll.findOne({ opportunity_id: req.body.opportunity_id, customer_id: record.customer.customer_id })
      : await coll.findOne({ customer_id: record.customer.customer_id, stage: { $ne: 'Lost / Parked' } }, { sort: { createdAt: -1 } });
    if (req.body.opportunity_id && !opp) return res.status(404).json({ success: false, message: 'Opportunity not found.' });
    if (!opp) {
      const model = record.prospect?.vehicle || record.prospect?.model || req.body.vehicle_descriptor;
      if (!model) return res.status(400).json({ success: false, message: 'Save the enquiry vehicle before marking Sold.' });
      opp = { opportunity_id: `OPP-SF-${crypto.createHash('sha256').update(record.customer.customer_id).digest('hex').slice(0,24)}`, customer_id: record.customer.customer_id,
        customer_name: record.customer.name, customer_phone: record.customer.phone, customer_email: record.customer.email,
        site: record.customer.site, owner_user_id: req.user.id, owner_name: req.user.name, model, vehicle_descriptor: model,
        stage: 'Negotiation', sale_type: req.body.sale_type || 'Retail', createdAt: new Date(), updatedAt: new Date() };
      await coll.updateOne({ opportunity_id: opp.opportunity_id }, { $setOnInsert: opp }, { upsert: true });
      opp = await coll.findOne({ opportunity_id: opp.opportunity_id });
    }
    service.assertSite(req.user, opp);
    const data = await crm.markSold(opp.opportunity_id, { ...req.body, primary_salesperson: req.user.name, delivery_handoff }, req.user);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
module.exports = router;
