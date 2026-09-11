/**
 * appointments.js – Lead Centre Appointment routes
 *
 * GET    /api/appointments           list (filter by consultantName, status, date range)
 * POST   /api/appointments           create appointment (test drive, callback, etc.)
 * GET    /api/appointments/:id       single appointment
 * PATCH  /api/appointments/:id       update (reschedule, status change)
 * DELETE /api/appointments/:id       cancel
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const Appointment = require('../models/lead/Appointment');
const Lead = require('../models/lead/Lead');
const AuditTrail = require('../models/lead/AuditTrail');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const audit = (req, leadId, message) =>
  AuditTrail.create({ message, actor: req.user.email, leadId, ip: req.ip }).catch(() => {});

// ─── GET /api/appointments ──────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      consultantName,
      status,
      type,
      from,
      to,
      leadId,
      sort = 'when',
    } = req.query;

    const filter = {};

    // Scope consultants to their own appointments
    if (req.user.role === 'consultant') {
      filter.consultantName = { $regex: req.user.name || req.user.email, $options: 'i' };
    } else if (consultantName) {
      filter.consultantName = { $regex: consultantName, $options: 'i' };
    }

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (leadId) filter.leadId = leadId;

    if (from || to) {
      filter.when = {};
      if (from) filter.when.$gte = from;
      if (to) filter.when.$lte = to;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [appointments, total] = await Promise.all([
      Appointment.find(filter).sort(sort).skip(skip).limit(Number(limit)).lean(),
      Appointment.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: appointments,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/appointments ─────────────────────────────────────────────────
router.post(
  '/',
  [
    body('when').notEmpty().withMessage('Appointment datetime required'),
    body('prospectName').notEmpty().withMessage('Prospect name required'),
    body('type').optional().isIn(['Test Drive', 'Callback', 'Showroom Visit']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const apptData = {
        ...req.body,
        consultantName: req.body.consultantName || req.user.name || req.user.email,
        bookedBy: req.body.bookedBy || 'Agent',
      };

      const appointment = await Appointment.create(apptData);

      // Update lead appointment count if linked
      if (appointment.leadId) {
        await Lead.findByIdAndUpdate(appointment.leadId, {
          $inc: { 'leadStats.appointmentCount': 1 },
          $set: { stage: 'TEST DRIVE BOOKED' },
        });
        await audit(req, appointment.leadId, `Appointment created: ${appointment.type} on ${appointment.when}`);
      }

      return res.status(201).json({ success: true, data: appointment });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/appointments/:id ──────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id).lean();
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });
    return res.json({ success: true, data: appt });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/appointments/:id ────────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    delete req.body._id;
    const appt = await Appointment.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Handle No Show → update lead
    if (req.body.status === 'No Show' && appt.leadId) {
      await audit(req, appt.leadId, `Test drive no-show: ${appt.prospectName}`);
    }

    return res.json({ success: true, data: appt });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/appointments/:id (cancel) ──────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const appt = await Appointment.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'Cancelled' } },
      { new: true }
    );
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });
    if (appt.leadId) {
      await audit(req, appt.leadId, `Appointment cancelled: ${appt.type} on ${appt.when}`);
    }
    return res.json({ success: true, message: 'Appointment cancelled.', data: appt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
