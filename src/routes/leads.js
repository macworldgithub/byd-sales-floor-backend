/**
 * leads.js – Lead Centre Lead routes
 *
 * GET    /api/leads              list with filters + pagination
 * POST   /api/leads              create a new lead (walk-in)
 * GET    /api/leads/:id          single lead
 * PATCH  /api/leads/:id          update lead
 * DELETE /api/leads/:id          soft-delete (archive)
 * GET    /api/leads/:id/timeline lead conversation timeline
 * POST   /api/leads/:id/notes    add a note to a lead
 */
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Lead = require('../models/lead/Lead');
const Conversation = require('../models/lead/Conversation');
const AuditTrail = require('../models/lead/AuditTrail');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// All lead routes require authentication
router.use(authenticate);

// ─── Helper: write audit trail ─────────────────────────────────────────────
const audit = (req, leadId, message, action = '') =>
  AuditTrail.create({
    message,
    actor: req.user.email,
    leadId,
    action,
    ip: req.ip,
  }).catch(() => {}); // fire-and-forget, never block response

// ─── GET /api/leads ────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      stage,
      status,
      assignedTo,
      allocatedPersonFullName,
      source,
      platform,
      q,
      isArchived = 'false',
      scoreMin,
      scoreMax,
      sort = '-createdAt',
    } = req.query;

    const filter = { isArchived: isArchived === 'true' };

    // Role-based scoping: consultants see only their own leads
    if (req.user.role === 'consultant') {
      filter.$or = [
        { assignedTo: req.user.email },
        { allocatedPersonFullName: { $regex: req.user.name || req.user.email, $options: 'i' } },
      ];
    }

    if (stage) filter.stage = stage;
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (allocatedPersonFullName)
      filter.allocatedPersonFullName = { $regex: allocatedPersonFullName, $options: 'i' };
    if (source) filter.source = source;
    if (platform) filter.platform = platform;
    if (scoreMin || scoreMax) {
      filter.score = {};
      if (scoreMin) filter.score.$gte = Number(scoreMin);
      if (scoreMax) filter.score.$lte = Number(scoreMax);
    }

    // Full-text search across name, phone, email, vehicle
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { vehicle: { $regex: q, $options: 'i' } },
        { leadIdShort: { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [leads, total] = await Promise.all([
      Lead.find(filter).sort(sort).skip(skip).limit(Number(limit)).lean(),
      Lead.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/leads ────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('phone').optional().isString(),
    body('vehicle').optional().isString(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const leadData = {
        ...req.body,
        // Auto-assign to the creating consultant
        assignedTo: req.body.assignedTo || req.user.email,
        allocatedPersonFullName:
          req.body.allocatedPersonFullName || req.user.name || req.user.email,
        source: req.body.source || 'Walk-in',
        platform: req.body.platform || 'manual',
        stage: req.body.stage || 'NEW ENQUIRIES',
      };

      const lead = await Lead.create(leadData);
      await audit(req, lead._id, `Lead created: ${lead.name}`, 'create');

      return res.status(201).json({ success: true, data: lead });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/leads/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
    await audit(req, lead._id, `Lead viewed: ${lead.name}`, 'view');
    return res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/leads/:id ───────────────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Prevent overwriting _id
    delete req.body._id;

    const lead = await Lead.findByIdAndUpdate(id, { $set: req.body }, { new: true, runValidators: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    await audit(req, lead._id, `Lead updated: ${Object.keys(req.body).join(', ')}`, 'update');
    return res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/leads/:id (soft delete = archive) ─────────────────────────
router.delete('/:id', requireRole('manager', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: { isArchived: true } },
      { new: true }
    );
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
    await audit(req, lead._id, `Lead archived: ${lead.name}`, 'archive');
    return res.json({ success: true, message: 'Lead archived.', data: lead });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/leads/:id/timeline ────────────────────────────────────────────
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    // Conversations associated with this lead
    const conversations = await Conversation.find({ leadId: req.params.id })
      .select('messages lastMessage lastMessageAt status control')
      .lean();

    // Audit trail for this lead
    const auditEvents = await AuditTrail.find({ leadId: req.params.id })
      .sort('-createdAt')
      .limit(50)
      .lean();

    return res.json({
      success: true,
      data: {
        lead,
        conversations,
        auditTrail: auditEvents,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/leads/:id/notes ───────────────────────────────────────────────
router.post(
  '/:id/notes',
  [body('note').notEmpty().withMessage('Note text required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const lead = await Lead.findById(req.params.id);
      if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

      // Append to existing notes
      const timestamp = new Date().toISOString();
      const noteEntry = `[${timestamp}] ${req.user.name || req.user.email}: ${req.body.note}`;
      lead.notes = lead.notes ? `${lead.notes}\n${noteEntry}` : noteEntry;
      await lead.save();

      await audit(req, lead._id, `Note added: ${req.body.note.substring(0, 50)}`, 'note');
      return res.json({ success: true, data: lead });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
