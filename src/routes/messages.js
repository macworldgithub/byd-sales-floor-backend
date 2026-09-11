/**
 * messages.js – Delivery Centre SMS Message routes
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const Message = require('../models/delivery/Message');
const Client = require('../models/delivery/Client');
const AuditEvent = require('../models/delivery/AuditEvent');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { client_id, phone, limit = 50 } = req.query;
    const filter = {};
    if (client_id) filter.client_id = client_id;
    if (phone) filter.phone = phone;

    const messages = await Message.find(filter).sort('-sent_at').limit(Number(limit)).lean();
    return res.json({ success: true, data: messages });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/send',
  [
    body('phone').notEmpty().withMessage('Phone required'),
    body('body').notEmpty().withMessage('Message body required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { phone, body: msgBody, client_id, client_name, template_id } = req.body;

      // In a real implementation, you would call the MobileMessage API here.
      // For now, we simulate a successful send.
      
      const message = await Message.create({
        client_id,
        client_name,
        phone,
        body: msgBody,
        direction: 'outbound',
        status: 'sent', // simulated
        sent_by_id: req.user.id,
        sent_by_name: req.user.name || req.user.email,
        template_id,
      });

      if (client_id) {
         await AuditEvent.create({
            actor_id: req.user.id,
            actor_email: req.user.email,
            action: 'message.send',
            entity: 'Client',
            entity_id: client_id,
            ip: req.ip,
         }).catch(() => {});
         
         // Update client's contact status
         await Client.findByIdAndUpdate(client_id, {
             contact_status: 'Contacted',
             last_contacted_at: new Date()
         });
      }

      return res.status(201).json({ success: true, data: message });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
