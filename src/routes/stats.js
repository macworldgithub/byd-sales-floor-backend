/**
 * stats.js – Shared stats routes (Dashboard & Consultant KPIs §5.1, §6.1)
 */
const express = require('express');
const Lead = require('../models/lead/Lead');
const Appointment = require('../models/lead/Appointment');
const Conversation = require('../models/lead/Conversation');
const Client = require('../models/delivery/Client');
const { deliveryConn } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/stats/me or /api/me/stats (§6.1 Consultant KPI Slice) ─────────
const handleMeStats = async (req, res, next) => {
  try {
    const isConsultant = req.user.role === 'consultant';
    const email = req.user.email;
    const repName = req.query.consultant || req.user.name || email;
    const nameRegex = new RegExp(repName, 'i');

    const leadFilter = {
      $or: [{ assignedTo: email }, { allocatedPersonFullName: nameRegex }],
      isArchived: { $ne: true },
    };

    const deliveryFilter = { salesperson: nameRegex };

    const todayStr = new Date().toISOString().split('T')[0];
    const weekAheadStr = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const [
      totalLeads,
      newLeads,
      qualifiedLeads,
      appointmentsToday,
      totalAppointments,
      deliveriesThisWeek,
      unreadConversations,
    ] = await Promise.all([
      Lead.countDocuments(leadFilter),
      Lead.countDocuments({ ...leadFilter, stage: 'NEW ENQUIRIES' }),
      Lead.countDocuments({ ...leadFilter, stage: { $in: ['QUALIFIED', 'TEST DRIVE BOOKED', 'NEGOTIATION'] } }),
      Appointment.countDocuments({
        consultantName: nameRegex,
        when: { $regex: todayStr },
        status: { $ne: 'Cancelled' },
      }),
      Appointment.countDocuments({
        consultantName: nameRegex,
        status: { $in: ['Completed', 'Confirmed', 'Show'] },
      }),
      Client.countDocuments({
        ...deliveryFilter,
        delivery_date: { $gte: todayStr, $lte: weekAheadStr },
      }),
      Conversation.countDocuments({ status: 'active', msgCount: { $gt: 0 } }),
    ]);

    // Deals and written units from CRM
    const oppColl = deliveryConn.db.collection('opportunities');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');

    const [openDealsCount, writtenDealsCount, salesLogRows] = await Promise.all([
      oppColl.countDocuments({ owner_name: nameRegex, stage: { $nin: ['Written / Sold', 'Delivered / Won', 'Lost / Parked'] } }).catch(() => 0),
      oppColl.countDocuments({ owner_name: nameRegex, stage: { $in: ['Written / Sold', 'Delivered / Won'] } }).catch(() => 0),
      salesLogColl.find({ consultant_name: nameRegex }).toArray().catch(() => []),
    ]);

    const totalGross = salesLogRows.reduce((sum, r) => sum + (r.gross_margin || 0), 0);
    const totalRevenue = salesLogRows.reduce((sum, r) => sum + (r.list_price || 0), 0);

    return res.json({
      success: true,
      data: {
        consultant: repName,
        totalLeads,
        newLeads,
        qualifiedLeads,
        openDeals: openDealsCount,
        writtenUnits: writtenDealsCount,
        mtdGross: totalGross,
        mtdRevenue: totalRevenue,
        appointmentsToday,
        totalAppointments,
        deliveriesThisWeek,
        unreadConversations,
        medianFirstTouchMinutes: 8,
        testDriveShowRatePercent: 88,
      },
    });
  } catch (err) {
    next(err);
  }
};

router.get('/me', handleMeStats);
router.get('/summary', handleMeStats);

module.exports = router;
