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

      const newMessage = {
        id: require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString(36),
        sender: req.body.sender || 'agent',
        text: req.body.text,
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        status: 'sent',
        createdAt: new Date(),
      };

      conversation.messages.push(newMessage);
      conversation.lastMessage = req.body.text;
      conversation.lastMessageAt = new Date();
      conversation.msgCount = (conversation.msgCount || 0) + 1;
      await conversation.save();

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
