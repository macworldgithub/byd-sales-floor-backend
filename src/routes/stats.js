/**
 * stats.js – Shared stats routes (Dashboard)
 */
const express = require('express');
const Lead = require('../models/lead/Lead');
const Appointment = require('../models/lead/Appointment');
const Conversation = require('../models/lead/Conversation');
const Client = require('../models/delivery/Client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/summary', async (req, res, next) => {
  try {
    const isConsultant = req.user.role === 'consultant';
    const email = req.user.email;
    const nameRegex = new RegExp(req.user.name || email, 'i');

    const leadFilter = isConsultant ? { 
        $or: [{ assignedTo: email }, { allocatedPersonFullName: nameRegex }]
    } : {};
    
    const deliveryFilter = isConsultant ? { salesperson: nameRegex } : {};

    const [
      totalLeads,
      newLeads,
      appointmentsToday,
      deliveriesThisWeek,
      unreadConversations
    ] = await Promise.all([
      Lead.countDocuments(leadFilter),
      Lead.countDocuments({ ...leadFilter, stage: 'NEW ENQUIRIES' }),
      Appointment.countDocuments({ 
          ...(isConsultant ? { consultantName: nameRegex } : {}),
          when: { $regex: new Date().toISOString().split('T')[0] } 
      }),
      Client.countDocuments({
          ...deliveryFilter,
          delivery_date: { $gte: new Date().toISOString().split('T')[0] } // simplified logic for 'this week'
      }),
      Conversation.countDocuments({ msgCount: { $gt: 0 } }) // Simplified unread logic
    ]);

    return res.json({
      success: true,
      data: {
        totalLeads,
        newLeads,
        appointmentsToday,
        deliveriesThisWeek,
        unreadConversations
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
