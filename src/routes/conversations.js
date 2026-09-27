/**
 * conversations.js – Lead Centre Conversation + Message routes
 *
 * GET    /api/conversations             list all conversations
 * GET    /api/conversations/:id         single conversation with messages
 * POST   /api/conversations/:id/messages  add a message to a conversation
 * PATCH  /api/conversations/:id         update conversation metadata
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: () => require('crypto').randomUUID() } : { v4: () => Date.now().toString(36) };
const Conversation = require('../models/lead/Conversation');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/conversations ─────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, q, dealer, status, control, leadId, sort = '-lastMessageAt' } = req.query;

    const filter = {};
    if (dealer) filter.dealer = { $regex: dealer, $options: 'i' };
    if (status) filter.status = status;
    if (control) filter.control = control;
    if (leadId) filter.leadId = leadId;
    if (q) {
      filter.$or = [
        { prospectName: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { lastMessage: { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [threads, total] = await Promise.all([
      Conversation.find(filter)
        .select('-messages')  // exclude heavy messages array from list view
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Conversation.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: threads,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/conversations/:id ─────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.id).lean();
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    return res.json({ success: true, data: conversation });
  } catch (err) {
    next(err);
  }
});

const Message = require('../models/delivery/Message');
const mobileMessageService = require('../services/mobileMessage');

// ─── POST /api/conversations/:id/messages ────────────────────────────────────
router.post(
  '/:id/messages',
  [
    body('text').notEmpty().withMessage('Message text required'),
    body('sender').optional().isIn(['ai', 'user', 'agent', 'system']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const conversation = await Conversation.findById(req.params.id);
      if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found.' });

      const senderType = req.body.sender || 'agent';
      let providerMessageId = null;
      let sendStatus = 'sent';

      // If sent by agent or AI and phone exists, dispatch real SMS via MobileMessage
      if (['agent', 'ai'].includes(senderType) && conversation.phone) {
        try {
          const sendResult = await mobileMessageService.sendSms({
            to: conversation.phone,
            message: req.body.text,
            customRef: String(conversation._id),
          });
          providerMessageId = sendResult.messageId;
          sendStatus = sendResult.status === 'success' || sendResult.status === 'sent' ? 'sent' : sendResult.status;

          // Record in Delivery Centre Message collection
          await Message.create({
            client_name: conversation.prospectName,
            phone: conversation.phone,
            body: req.body.text,
            direction: 'outbound',
            status: sendStatus,
            provider: 'mobilemessage',
            provider_message_id: providerMessageId,
            sent_by_id: req.user ? req.user.id : null,
            sent_by_name: req.user ? (req.user.name || req.user.email) : 'Agent',
            sent_at: new Date(),
          }).catch((mErr) => console.error('Error logging Message model:', mErr.message));
        } catch (smsErr) {
          console.error('Failed to dispatch SMS via MobileMessage:', smsErr.message);
          sendStatus = 'failed';
        }
      }

      const newMessage = {
        id: providerMessageId || (require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString(36)),
        sender: senderType,
        text: req.body.text,
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        status: sendStatus,
        createdAt: new Date(),
      };

      conversation.messages.push(newMessage);
      conversation.lastMessage = req.body.text;
      conversation.lastMessageAt = new Date();
      conversation.msgCount = (conversation.msgCount || 0) + 1;
      await conversation.save();

      // Direct write to CRM timeline (§5.2, §5.7)
      try {
        const { deliveryConn } = require('../db');
        const custColl = deliveryConn.db.collection('customers');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const last8 = conversation.phone ? conversation.phone.slice(-8) : '';

        const cust = await custColl.findOne({
          $or: [conversation.leadId ? { lead_prospect_id: String(conversation.leadId) } : null, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
        });

        await tlColl.insertOne({
          event_id: 'EVT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
          customer_id: cust?.customer_id || `CUST-CONV-${conversation._id}`,
          type: 'sms',
          event_type: 'sms',
          title: senderType === 'user' ? 'Inbound Customer SMS' : 'Outbound SMS (Lead Centre)',
          content: req.body.text,
          body: req.body.text,
          author: senderType === 'user' ? (conversation.prospectName || 'Customer') : (req.user?.name || req.user?.email || 'Lead Centre Agent'),
          source: 'Lead Centre SMS',
          source_system: 'sms',
          occurred_at: new Date(),
          visibility: 'customer',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (_) {}

      return res.status(201).json({ success: true, data: newMessage });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /api/conversations/:id ───────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    delete req.body._id;
    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found.' });
    return res.json({ success: true, data: conversation });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
