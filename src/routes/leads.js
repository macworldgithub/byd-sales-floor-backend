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

const { deliveryConn } = require('../db');

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

      // Direct CRM / Delivery Centre database sync (§5.4, §7.3)
      try {
        const custColl = deliveryConn.db.collection('customers');
        const oppColl = deliveryConn.db.collection('opportunities');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const now = new Date();

        let cleanPhone = lead.phone ? String(lead.phone).replace(/\D/g, '') : '';
        if (cleanPhone.startsWith('61')) cleanPhone = '+' + cleanPhone;
        else if (cleanPhone.startsWith('0')) cleanPhone = '+61' + cleanPhone.slice(1);
        else if (cleanPhone) cleanPhone = '+' + cleanPhone;

        let customer = await custColl.findOne({
          $or: [
            cleanPhone ? { phone: cleanPhone } : null,
            lead.email ? { email: lead.email.toLowerCase() } : null,
          ].filter(Boolean),
        });

        if (!customer) {
          const custCount = await custColl.countDocuments();
          const customer_id = 'CUST-BYD-' + (100 + custCount + 1);
          const newCust = {
            customer_id,
            name: lead.name,
            phone: cleanPhone || '',
            email: lead.email ? lead.email.toLowerCase() : null,
            site: lead.dealer || 'Fairfield',
            owner_user_id: req.user?.id || 'usr-001',
            owner_name: lead.allocatedPersonFullName,
            source: lead.source || 'Walk-in',
            record_type: 'Individual',
            lead_prospect_id: String(lead._id),
            delivery_client_id: null,
            consent_sms: true,
            do_not_contact: false,
            preferred_model: lead.vehicle || 'SEALION 7',
            tags: [],
            notes: lead.notes || '',
            is_merged: false,
            createdAt: now,
            updatedAt: now,
          };
          await custColl.insertOne(newCust);
          customer = newCust;
        } else {
          await custColl.updateOne(
            { customer_id: customer.customer_id },
            { $set: { lead_prospect_id: String(lead._id), updatedAt: now } }
          );
        }

        const oppCount = await oppColl.countDocuments();
        const opportunity_id = 'OPP-BYD-' + (200 + oppCount + 1);
        await oppColl.insertOne({
          opportunity_id,
          customer_id: customer.customer_id,
          customer_name: customer.name,
          customer_phone: customer.phone,
          customer_email: customer.email,
          site: lead.dealer || customer.site || 'Fairfield',
          owner_name: lead.allocatedPersonFullName,
          stage: 'New / Allocated',
          model: lead.vehicle?.replace(/.*BYD\s+/, '') || 'SEALION 7',
          variant: 'Premium',
          vehicle_descriptor: lead.vehicle || 'BYD SEALION 7 Premium',
          source: lead.source || 'Walk-in',
          sale_type: 'Retail',
          lead_prospect_id: String(lead._id),
          total_price: 58000,
          list_price: 58000,
          createdAt: now,
          updatedAt: now,
        });

        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: customer.customer_id,
          opportunity_id,
          type: 'system',
          event_type: 'system',
          title: 'Prospect Captured in Showroom (Walk-in)',
          content: `Walk-in prospect ${lead.name} captured by ${lead.allocatedPersonFullName}. Model interest: ${lead.vehicle || 'BYD'}.`,
          body: `Walk-in prospect ${lead.name} captured by ${lead.allocatedPersonFullName}. Model interest: ${lead.vehicle || 'BYD'}.`,
          author: lead.allocatedPersonFullName,
          source: 'Sales Floor',
          occurred_at: now,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      } catch (crmErr) {
        console.error('CRM sync on lead create error:', crmErr.message);
      }

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
    delete req.body._id;

    const lead = await Lead.findByIdAndUpdate(id, { $set: req.body }, { new: true, runValidators: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    await audit(req, lead._id, `Lead updated: ${Object.keys(req.body).join(', ')}`, 'update');

    // Direct sync to Delivery Centre & CRM customer / opportunity records
    try {
      const custColl = deliveryConn.db.collection('customers');
      const oppColl = deliveryConn.db.collection('opportunities');
      const tlColl = deliveryConn.db.collection('timelineevents');
      const now = new Date();

      if (lead.phone || id) {
        const last8 = lead.phone ? String(lead.phone).slice(-8) : '';
        const cust = await custColl.findOne({
          $or: [{ lead_prospect_id: String(id) }, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
        });

        if (cust) {
          const custPatch = { updatedAt: now };
          if (req.body.allocatedPersonFullName) custPatch.owner_name = req.body.allocatedPersonFullName;
          if (req.body.do_not_contact !== undefined) {
            custPatch.do_not_contact = req.body.do_not_contact;
            if (req.body.do_not_contact) custPatch.consent_sms = false;
          }
          await custColl.updateOne({ customer_id: cust.customer_id }, { $set: custPatch });

          if (req.body.stage) {
            const crypto = require('crypto');
            await tlColl.insertOne({
              event_id: `EVT-${crypto.randomUUID()}`,
              customer_id: cust.customer_id,
              type: 'stage_change',
              event_type: 'stage_change',
              title: `Lead Stage Updated: ${req.body.stage}`,
              content: `Lead stage transitioned to ${req.body.stage} by ${req.user.name || req.user.email}.`,
              body: `Lead stage transitioned to ${req.body.stage} by ${req.user.name || req.user.email}.`,
              author: req.user.name || req.user.email,
              source: 'Lead Centre',
              occurred_at: now,
              visibility: 'internal',
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    } catch (_) {}

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

    // Pull unified timeline events from Delivery Centre DB
    let timelineEvents = [];
    try {
      const tlColl = deliveryConn.db.collection('timelineevents');
      const custColl = deliveryConn.db.collection('customers');
      const last8 = lead.phone ? String(lead.phone).slice(-8) : '';
      const cust = await custColl.findOne({
        $or: [{ lead_prospect_id: String(lead._id) }, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
      });
      if (cust) {
        timelineEvents = await tlColl.find({ customer_id: cust.customer_id }).sort({ occurred_at: -1 }).limit(50).toArray();
      }
    } catch (_) {}

    return res.json({
      success: true,
      data: {
        lead,
        conversations,
        auditTrail: auditEvents,
        timelineEvents,
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
      const now = new Date();
      const timestamp = now.toISOString();
      const authorName = req.user.name || req.user.email;
      const noteEntry = `[${timestamp}] ${authorName}: ${req.body.note}`;
      lead.notes = lead.notes ? `${lead.notes}\n${noteEntry}` : noteEntry;
      lead.lastTouch = `Note from ${authorName} · Just now`;
      lead.lastActivityAt = now;
      await lead.save();

      await audit(req, lead._id, `Note added: ${req.body.note.substring(0, 50)}`, 'note');

      // Direct write into Delivery Centre timelineevents & Client comments
      try {
        const custColl = deliveryConn.db.collection('customers');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const clientColl = deliveryConn.db.collection('clients');
        const last8 = lead.phone ? String(lead.phone).slice(-8) : '';

        const cust = await custColl.findOne({
          $or: [{ lead_prospect_id: String(lead._id) }, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
        });

        if (cust) {
          const crypto = require('crypto');
          await tlColl.insertOne({
            event_id: `EVT-${crypto.randomUUID()}`,
            customer_id: cust.customer_id,
            type: 'note',
            event_type: 'note',
            title: 'Lead Centre Note',
            content: req.body.note,
            body: req.body.note,
            author: authorName,
            source: 'Lead Centre',
            source_system: 'lead',
            occurred_at: now,
            visibility: 'internal',
            createdAt: now,
            updatedAt: now,
          });
        }

        if (last8) {
          await clientColl.updateOne(
            { phone: { $regex: last8, $options: 'i' } },
            {
              $push: {
                comments: {
                  author_name: `${authorName} (Lead Centre)`,
                  body: req.body.note,
                  created_at: now,
                },
              },
            }
          ).catch(() => {});
        }
      } catch (_) {}

      return res.json({ success: true, data: lead });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
