/**
 * clients.js – Delivery Centre Client (handover/delivery) routes
 *
 * GET    /api/clients                          list clients
 * POST   /api/clients                          create client
 * GET    /api/clients/:id                      single client
 * PATCH  /api/clients/:id                      update client
 * DELETE /api/clients/:id                      delete (admin only)
 *
 * POST   /api/clients/:id/comments             add comment
 * DELETE /api/clients/:id/comments/:commentId  remove comment
 *
 * GET    /api/clients/:id/accessories          list accessories
 * POST   /api/clients/:id/accessories          add accessory
 * PATCH  /api/clients/:id/accessories/:accId   update accessory
 * DELETE /api/clients/:id/accessories/:accId   remove accessory
 *
 * GET    /api/clients/:id/documents            list documents
 * POST   /api/clients/:id/documents            add document record
 * PATCH  /api/clients/:id/documents/:docId     update document record
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const Client = require('../models/delivery/Client');
const AuditEvent = require('../models/delivery/AuditEvent');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const audit = (req, clientId, action, meta = {}) =>
  AuditEvent.create({
    actor_id: req.user.id,
    actor_email: req.user.email,
    action,
    entity: 'Client',
    entity_id: clientId,
    meta,
    ip: req.ip,
  }).catch(() => {});

// ─── GET /api/clients ───────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      stage,
      contact_status,
      salesperson,
      arrived,
      q,
      deliveryFrom,
      deliveryTo,
      sort = 'delivery_date',
    } = req.query;

    const filter = {};

    // Scope consultants to their own delivery book
    if (req.user.role === 'consultant') {
      filter.salesperson = { $regex: req.user.name || req.user.email, $options: 'i' };
    } else if (salesperson) {
      filter.salesperson = { $regex: salesperson, $options: 'i' };
    }

    if (stage) filter.stage = stage;
    if (contact_status) filter.contact_status = contact_status;
    if (arrived !== undefined) filter.arrived = arrived === 'true';

    if (deliveryFrom || deliveryTo) {
      filter.delivery_date = {};
      if (deliveryFrom) filter.delivery_date.$gte = deliveryFrom;
      if (deliveryTo) filter.delivery_date.$lte = deliveryTo;
    }

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { vehicle: { $regex: q, $options: 'i' } },
        { rego: { $regex: q, $options: 'i' } },
        { vin: { $regex: q, $options: 'i' } },
        { vy_order_id: { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [clients, total] = await Promise.all([
      Client.find(filter)
        .select('-documents -comments') // exclude heavy sub-arrays from list
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Client.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: clients,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

const { deliveryConn, leadConn } = require('../db');

// ─── POST /api/clients ──────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('name').notEmpty().withMessage('Name required'),
    body('phone').notEmpty().withMessage('Phone required'),
    body('vehicle').notEmpty().withMessage('Vehicle required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const client = await Client.create(req.body);
      await audit(req, client._id.toString(), 'client.create');

      // Direct CRM customer & opportunity link
      try {
        const custColl = deliveryConn.db.collection('customers');
        const oppColl = deliveryConn.db.collection('opportunities');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const now = new Date();

        let cleanPhone = client.phone ? String(client.phone).replace(/\D/g, '') : '';
        if (cleanPhone.startsWith('61')) cleanPhone = '+' + cleanPhone;
        else if (cleanPhone.startsWith('0')) cleanPhone = '+61' + cleanPhone.slice(1);
        else if (cleanPhone) cleanPhone = '+' + cleanPhone;

        let customer = await custColl.findOne({
          $or: [
            cleanPhone ? { phone: cleanPhone } : null,
            client.email ? { email: client.email.toLowerCase() } : null,
          ].filter(Boolean),
        });

        if (customer) {
          await custColl.updateOne(
            { customer_id: customer.customer_id },
            { $set: { delivery_client_id: String(client._id), updatedAt: now } }
          );
          await oppColl.updateMany(
            { customer_id: customer.customer_id },
            { $set: { delivery_client_id: String(client._id), delivery_stage: client.stage || 'Scheduled', updatedAt: now } }
          );
        }

        await tlColl.insertOne({
          event_id: 'EVT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
          customer_id: customer?.customer_id || `CUST-DEL-${client._id}`,
          type: 'delivery_stage_change',
          event_type: 'delivery_stage_change',
          title: `Delivery Handover Scheduled: ${client.stage || 'Scheduled'}`,
          content: `Delivery record created for ${client.name}. Vehicle: ${client.vehicle} (VIN: ${client.vin || 'Pending'}). Salesperson: ${client.salesperson || 'Unassigned'}.`,
          body: `Delivery record created for ${client.name}. Vehicle: ${client.vehicle} (VIN: ${client.vin || 'Pending'}). Salesperson: ${client.salesperson || 'Unassigned'}.`,
          author: req.user.name || req.user.email,
          source: 'Delivery Centre',
          source_system: 'delivery',
          occurred_at: now,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      } catch (_) {}

      return res.status(201).json({ success: true, data: client });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/clients/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id).lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    await audit(req, req.params.id, 'client.view');
    return res.json({ success: true, data: client });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/clients/:id ─────────────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    delete req.body._id;
    // Consultants cannot change PDI stages (stage field protected)
    if (req.user.role === 'consultant') {
      const protectedStages = ['Pre-Delivery Inspection', 'In Transit'];
      if (req.body.stage && protectedStages.includes(req.body.stage)) {
        delete req.body.stage;
      }
      delete req.body.vin;
    }

    const previousClient = await Client.findById(req.params.id);
    if (!previousClient) return res.status(404).json({ success: false, message: 'Client not found.' });

    const client = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    await audit(req, req.params.id, 'client.update', { fields: Object.keys(req.body) });

    // Direct database sync to CRM Opportunity & TimelineEvents (§5.5, §5.8, AC-9)
    try {
      const oppColl = deliveryConn.db.collection('opportunities');
      const custColl = deliveryConn.db.collection('customers');
      const tlColl = deliveryConn.db.collection('timelineevents');
      const now = new Date();

      const oppUpdates = { updatedAt: now };
      if (req.body.stage) oppUpdates.delivery_stage = req.body.stage;
      if (req.body.salesperson) oppUpdates.owner_name = req.body.salesperson;
      if (req.body.delivery_date) oppUpdates.delivery_date = req.body.delivery_date;

      await oppColl.updateMany(
        { $or: [{ delivery_client_id: String(req.params.id) }, { customer_phone: client.phone }] },
        { $set: oppUpdates }
      );

      const cust = await custColl.findOne({
        $or: [{ delivery_client_id: String(req.params.id) }, { phone: client.phone }],
      });

      if (req.body.stage && req.body.stage !== previousClient.stage) {
        await tlColl.insertOne({
          event_id: 'EVT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
          customer_id: cust?.customer_id || `CUST-DEL-${client._id}`,
          type: 'delivery_stage_change',
          event_type: 'delivery_stage_change',
          title: `Delivery Stage Transitioned: ${req.body.stage}`,
          content: `Delivery stage moved from '${previousClient.stage}' to '${req.body.stage}' by ${req.user.name || req.user.email}.`,
          body: `Delivery stage moved from '${previousClient.stage}' to '${req.body.stage}' by ${req.user.name || req.user.email}.`,
          author: req.user.name || req.user.email,
          source: 'Delivery Centre',
          source_system: 'delivery',
          occurred_at: now,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }

      if (req.body.delivery_date && req.body.delivery_date !== previousClient.delivery_date) {
        await tlColl.insertOne({
          event_id: 'EVT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
          customer_id: cust?.customer_id || `CUST-DEL-${client._id}`,
          type: 'delivery_date_change',
          event_type: 'delivery_date_change',
          title: `Delivery Date Updated: ${req.body.delivery_date}`,
          content: `Handover date rescheduled from '${previousClient.delivery_date || 'Unset'}' to '${req.body.delivery_date}'.`,
          body: `Handover date rescheduled from '${previousClient.delivery_date || 'Unset'}' to '${req.body.delivery_date}'.`,
          author: req.user.name || req.user.email,
          source: 'Delivery Centre',
          source_system: 'delivery',
          occurred_at: now,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (_) {}

    return res.json({ success: true, data: client });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/clients/:id ────────────────────────────────────────────────
router.delete('/:id', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    await audit(req, req.params.id, 'client.delete');
    return res.json({ success: true, message: 'Client deleted.' });
  } catch (err) {
    next(err);
  }
});

// ─── COMMENTS ───────────────────────────────────────────────────────────────

router.post(
  '/:id/comments',
  [body('body').notEmpty().withMessage('Comment body required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const client = await Client.findById(req.params.id);
      if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

      const now = new Date();
      const authorName = req.user.name || req.user.email;
      const comment = {
        author_id: req.user.id,
        author_name: authorName,
        body: req.body.body,
        created_at: now,
      };

      client.comments.push(comment);
      await client.save();
      await audit(req, req.params.id, 'client.comment.add');

      // Direct write into unified CRM timeline & Lead Centre database (AC-3)
      try {
        const custColl = deliveryConn.db.collection('customers');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const leadColl = leadConn.db.collection('leads');
        const last8 = client.phone ? String(client.phone).slice(-8) : '';

        const cust = await custColl.findOne({
          $or: [{ delivery_client_id: String(req.params.id) }, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
        });

        await tlColl.insertOne({
          event_id: 'EVT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
          customer_id: cust?.customer_id || `CUST-DEL-${client._id}`,
          type: 'note',
          event_type: 'note',
          title: 'Delivery Centre Comment',
          content: req.body.body,
          body: req.body.body,
          author: authorName,
          source: 'Delivery Centre',
          source_system: 'delivery',
          occurred_at: now,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });

        if (last8) {
          const matchedLead = await leadColl.findOne({ phone: { $regex: last8, $options: 'i' } });
          if (matchedLead) {
            const timestampIso = now.toISOString();
            const noteEntry = `[${timestampIso}] ${authorName} (Delivery Centre): ${req.body.body}`;
            const updatedNotes = matchedLead.notes ? `${matchedLead.notes}\n${noteEntry}` : noteEntry;
            await leadColl.updateOne(
              { _id: matchedLead._id },
              { $set: { notes: updatedNotes, lastTouch: `Delivery comment · Just now`, lastActivityAt: now, updatedAt: now } }
            );
          }
        }
      } catch (_) {}

      const addedComment = client.comments[client.comments.length - 1];
      return res.status(201).json({ success: true, data: addedComment });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id/comments/:commentId', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

    client.comments = client.comments.filter(
      (c) => c._id.toString() !== req.params.commentId
    );
    await client.save();
    await audit(req, req.params.id, 'client.comment.delete');
    return res.json({ success: true, message: 'Comment removed.' });
  } catch (err) {
    next(err);
  }
});

// ─── ACCESSORIES ─────────────────────────────────────────────────────────────

router.get('/:id/accessories', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id).select('accessories').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    return res.json({ success: true, data: client.accessories });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/accessories',
  [body('name').notEmpty().withMessage('Accessory name required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const client = await Client.findById(req.params.id);
      if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

      client.accessories.push({ name: req.body.name, status: req.body.status || 'Pending Order', note: req.body.note });
      await client.save();
      const acc = client.accessories[client.accessories.length - 1];
      return res.status(201).json({ success: true, data: acc });
    } catch (err) {
      next(err);
    }
  }
);

router.patch('/:id/accessories/:accId', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

    const acc = client.accessories.id(req.params.accId);
    if (!acc) return res.status(404).json({ success: false, message: 'Accessory not found.' });

    Object.assign(acc, req.body, { updated_at: new Date() });
    await client.save();
    return res.json({ success: true, data: acc });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/accessories/:accId', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    client.accessories = client.accessories.filter((a) => a._id.toString() !== req.params.accId);
    await client.save();
    return res.json({ success: true, message: 'Accessory removed.' });
  } catch (err) {
    next(err);
  }
});

// ─── DOCUMENTS ───────────────────────────────────────────────────────────────

router.get('/:id/documents', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id).select('documents').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
    return res.json({ success: true, data: client.documents });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/documents', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

    const doc = {
      ...req.body,
      client_id: req.params.id,
      created_at: new Date(),
      uploaded_by: req.user.email,
    };

    client.documents.push(doc);
    await client.save();
    await audit(req, req.params.id, 'client.document.add', { type: doc.document_type });
    return res.status(201).json({ success: true, data: client.documents[client.documents.length - 1] });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/documents/:docId', async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

    const docIndex = client.documents.findIndex((d) => d._id?.toString() === req.params.docId);
    if (docIndex === -1) return res.status(404).json({ success: false, message: 'Document not found.' });

    client.documents[docIndex] = { ...client.documents[docIndex].toObject?.() || client.documents[docIndex], ...req.body };
    client.markModified('documents');
    await client.save();
    return res.json({ success: true, data: client.documents[docIndex] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
