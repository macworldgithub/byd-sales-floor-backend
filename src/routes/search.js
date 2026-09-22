/**
 * search.js – Global search and duplicate prevention route
 */
const express = require('express');
const Lead = require('../models/lead/Lead');
const Client = require('../models/delivery/Client');
const Appointment = require('../models/lead/Appointment');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/search/check-duplicate ──────────────────────────────────────────
router.get('/check-duplicate', async (req, res, next) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) {
      return res.json({ success: true, duplicate: false });
    }

    const conditions = [];
    if (phone && phone.trim().length > 5) {
      const cleanPhone = phone.trim().replace(/[\s\-\(\)]/g, '');
      conditions.push({ phone: { $regex: cleanPhone.slice(-8), $options: 'i' } });
    }
    if (email && email.trim().length > 3) {
      conditions.push({ email: { $regex: `^${email.trim()}$`, $options: 'i' } });
    }

    if (conditions.length === 0) {
      return res.json({ success: true, duplicate: false });
    }

    const [existingLead, existingClient] = await Promise.all([
      Lead.findOne({ $or: conditions, isArchived: { $ne: true } }).lean(),
      Client.findOne({ $or: conditions }).lean(),
    ]);

    if (existingLead || existingClient) {
      return res.json({
        success: true,
        duplicate: true,
        matchType: existingLead ? 'lead' : 'client',
        matchRecord: existingLead || existingClient,
        message: `Existing ${existingLead ? 'lead' : 'delivery client'} found: ${
          (existingLead || existingClient).name
        }`,
      });
    }

    return res.json({ success: true, duplicate: false });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/search ──────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ success: true, data: { leads: [], clients: [], appointments: [] } });
    }

    const regex = new RegExp(q, 'i');
    const isConsultant = req.user.role === 'consultant';
    const email = req.user.email;
    const nameRegex = new RegExp(req.user.name || email, 'i');

    const leadFilter = {
      $or: [
        { name: regex },
        { phone: regex },
        { email: regex },
        { vehicle: regex },
        { leadIdShort: regex },
      ],
      isArchived: { $ne: true },
    };
    if (isConsultant) {
      leadFilter.$and = [{ $or: [{ assignedTo: email }, { allocatedPersonFullName: nameRegex }] }];
    }

    const clientFilter = {
      $or: [
        { name: regex },
        { phone: regex },
        { email: regex },
        { vehicle: regex },
        { rego: regex },
        { vin: regex },
        { vy_order_id: regex },
      ],
    };
    if (isConsultant) {
      clientFilter.salesperson = nameRegex;
    }

    const apptFilter = {
      $or: [
        { prospectName: regex },
        { type: regex },
        { vehicle: regex },
        { notes: regex },
      ],
    };
    if (isConsultant) {
      apptFilter.consultantName = nameRegex;
    }

    const [leads, clients, appointments] = await Promise.all([
      Lead.find(leadFilter).limit(15).lean(),
      Client.find(clientFilter).limit(15).lean(),
      Appointment.find(apptFilter).limit(10).lean(),
    ]);

    return res.json({
      success: true,
      data: { leads, clients, appointments },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
