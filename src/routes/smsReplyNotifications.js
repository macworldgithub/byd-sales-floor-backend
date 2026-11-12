const express = require('express');
const { authenticate } = require('../middleware/auth');
const { ensureDbConnected, deliveryConn, leadConn } = require('../db');
const service = require('../services/smsReplyNotifications');
const router = express.Router();
router.use(authenticate);
router.use(async (req,res,next) => {
  try {
    const access = req.user.platform_access;
    if (Array.isArray(access) && !access.some(p => ['crm','sales_floor'].includes(p))) return res.status(403).json({ success:false,message:'SMS access is not assigned.' });
    await ensureDbConnected(); res.set('Cache-Control','no-store'); next();
  } catch (error) { next(error); }
});
router.get('/sms-replies', async (req,res,next) => {
  try { res.json({ success:true,data:await service.list(deliveryConn.db,req.user,req.query) }); } catch (error) { next(error); }
});
router.get('/sms-replies/:id/messages', async (req,res,next) => {
  try { res.json({ success:true,data:await service.conversation(deliveryConn.db,leadConn.db,req.user,req.params.id) }); } catch (error) { next(error); }
});
router.post('/sms-replies/:id/read', async (req,res,next) => {
  try { await service.read(deliveryConn.db,req.user,req.params.id,req.body.seen_message_ids || []); res.json({ success:true }); } catch (error) { next(error); }
});
module.exports = router;
