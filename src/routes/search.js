/**
 * search.js – Global search and duplicate prevention route across Lead & Delivery Centres
 */
const express = require('express');
const Lead = require('../models/lead/Lead');
const Client = require('../models/delivery/Client');
const Appointment = require('../models/lead/Appointment');
const { deliveryConn } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/search/check-duplicate (§5.1, §5.4 Duplicate Prevention) ────────
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

    const custColl = deliveryConn.db.collection('customers');

    const [existingLead, existingClient, existingCustomer] = await Promise.all([
      Lead.findOne({ $or: conditions, isArchived: { $ne: true } }).lean().catch(() => null),
      Client.findOne({ $or: conditions }).lean().catch(() => null),
      custColl.findOne({ $or: conditions, is_merged: { $ne: true } }).catch(() => null),
    ]);

    if (existingLead || existingClient || existingCustomer) {
      const matchedRecord = existingCustomer || existingLead || existingClient;
      const matchType = existingCustomer ? 'customer' : existingLead ? 'lead' : 'client';
      return res.json({
        success: true,
        duplicate: true,
        matchType,
        matchRecord,
        customer_id: existingCustomer?.customer_id || null,
        message: `Existing ${matchType} found: ${matchedRecord.name} (${matchedRecord.phone || matchedRecord.email || ''})`,
      });
    }

    return res.json({ success: true, duplicate: false });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/search (§5.11 Global Search) ──────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ success: true, data: { leads: [], clients: [], appointments: [], customers: [], opportunities: [] } });
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

    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');

    const custFilter = {
      $or: [
        { name: regex },
        { phone: regex },
        { email: regex },
        { customer_id: regex },
        { preferred_model: regex },
      ],
      is_merged: { $ne: true },
    };

    const oppFilter = {
      $or: [
        { customer_name: regex },
        { vehicle_descriptor: regex },
        { vin: regex },
        { vy_order_id: regex },
        { vy_stock_id: regex },
        { opportunity_id: regex },
      ],
    };

    const [leads, clients, appointments, customers, opportunities] = await Promise.all([
      Lead.find(leadFilter).limit(15).lean().catch(() => []),
      Client.find(clientFilter).limit(15).lean().catch(() => []),
      Appointment.find(apptFilter).limit(10).lean().catch(() => []),
      custColl.find(custFilter).limit(15).toArray().catch(() => []),
      oppColl.find(oppFilter).limit(15).toArray().catch(() => []),
    ]);

    return res.json({
      success: true,
      data: { leads, clients, appointments, customers, opportunities },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
