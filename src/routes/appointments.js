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

// ─── Helper: RFC 5545 iCalendar Generator (§5.2, §6.3) ─────────────────────
const generateIcs = (appts) => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OmniSuiteAI//BYD Sales Floor Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:BYD Sales Floor Calendar',
    'X-WR-TIMEZONE:Australia/Melbourne',
  ];

  appts.forEach((a) => {
    const dt = new Date(a.when || Date.now());
    const startStr = dt.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const endDt = new Date(dt.getTime() + (a.durationMinutes || 45) * 60000);
    const endStr = endDt.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const summary = `${a.type || 'Appointment'}: ${a.prospectName} (${a.vehicle || 'BYD'})`;
    const description = `BYD Customer: ${a.prospectName}\\nPhone: ${a.phone}\\nConsultant: ${a.consultantName}\\nNotes: ${a.notes || 'None'}`;
    const location = a.location || a.dealership || 'BYD Melbourne CBD Showroom';

    ics.push('BEGIN:VEVENT');
    ics.push(`UID:appt-${a._id || Math.random()}@sales.bydharmony.app`);
    ics.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);
    ics.push(`DTSTART:${startStr}`);
    ics.push(`DTEND:${endStr}`);
    ics.push(`SUMMARY:${summary}`);
    ics.push(`DESCRIPTION:${description}`);
    ics.push(`LOCATION:${location}`);
    ics.push(`STATUS:${a.status === 'Cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    ics.push('END:VEVENT');
  });

  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
};

// ─── GET /api/appointments/export.ics (§5.2, §6.3 Outbound Calendar Sync) ───
router.get('/export.ics', async (req, res, next) => {
  try {
    const { consultantName, from } = req.query;
    const filter = { status: { $ne: 'Cancelled' } };
    if (consultantName) {
      filter.consultantName = { $regex: consultantName, $options: 'i' };
    }
    if (from) {
      filter.when = { $gte: from };
    }

    const appts = await Appointment.find(filter).limit(100).lean();
    const icsContent = generateIcs(appts);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="byd-sales-calendar.ics"');
    return res.send(icsContent);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/appointments/check-conflict (§5.2 Conflict Detection) ────────
router.post('/check-conflict', async (req, res, next) => {
  try {
    const { consultantName, when, durationMinutes = 45, excludeId } = req.body;
    if (!when) return res.json({ hasConflict: false });

    const newStart = new Date(when).getTime();
    const newEnd = newStart + Number(durationMinutes) * 60000;

    const repName = consultantName || req.user.name || req.user.email;
    const filter = {
      consultantName: { $regex: repName, $options: 'i' },
      status: { $in: ['Confirmed', 'Proposed'] },
    };
    if (excludeId) filter._id = { $ne: excludeId };

    const candidateAppts = await Appointment.find(filter).lean();
    const conflicting = candidateAppts.find((a) => {
      const aStart = new Date(a.when).getTime();
      const aEnd = aStart + (a.durationMinutes || 45) * 60000;
      return (newStart < aEnd && newEnd > aStart);
    });

    if (conflicting) {
      return res.json({
        hasConflict: true,
        conflictingEvent: {
          id: conflicting._id,
          title: `${conflicting.type} with ${conflicting.prospectName}`,
          when: conflicting.when,
          vehicle: conflicting.vehicle,
        },
        message: `Conflict detected: ${repName} already has ${conflicting.type} booked at ${new Date(conflicting.when).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}.`,
      });
    }

    return res.json({ hasConflict: false });
  } catch (err) {
    next(err);
  }
});

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

// ─── PATCH /api/appointments/:id (§5.2 Show / No-Show Closeout) ─────────────
router.patch('/:id', async (req, res, next) => {
  try {
    delete req.body._id;
    const appt = await Appointment.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    const { deliveryConn } = require('../db');
    const tlColl = deliveryConn.db.collection('timelineevents');

    // Handle No Show → update lead and record timeline event (§5.2, §10 AC-4)
    if (req.body.status === 'No Show') {
      if (appt.leadId) {
        await Lead.findByIdAndUpdate(appt.leadId, {
          stage: 'Qualified',
          lastTouch: 'Test Drive No-Show · Follow-up Required',
        }).catch(() => {});
        await audit(req, appt.leadId, `Test drive marked No Show: ${appt.prospectName}`);
      }
      await tlColl.insertOne({
        event_id: `EVT-${Date.now().toString().slice(-4)}`,
        title: `Appointment Status: No Show · ${appt.type}`,
        content: `Customer ${appt.prospectName} did not attend scheduled ${appt.vehicle || 'test drive'}. Triggered no-show re-engagement sequence.`,
        type: 'appointment',
        author: req.user.name || req.user.email,
        source: 'Sales Floor',
        occurred_at: new Date(),
        visibility: 'internal',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).catch(() => {});
    } else if (req.body.status === 'Completed') {
      if (appt.leadId) {
        await Lead.findByIdAndUpdate(appt.leadId, {
          stage: 'Committed',
          lastTouch: 'Test Drive Completed · Ready for Offer',
        }).catch(() => {});
        await audit(req, appt.leadId, `Test drive completed successfully: ${appt.prospectName}`);
      }
      await tlColl.insertOne({
        event_id: `EVT-${Date.now().toString().slice(-4)}`,
        title: `Appointment Completed: ${appt.type} · ${appt.vehicle || 'BYD'}`,
        content: `Test drive successfully completed with ${appt.prospectName}. Buyer intent elevated to Committed.`,
        type: 'appointment',
        author: req.user.name || req.user.email,
        source: 'Sales Floor',
        occurred_at: new Date(),
        visibility: 'internal',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).catch(() => {});
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
