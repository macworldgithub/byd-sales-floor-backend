/**
 * search.js – Global search route
 */
const express = require('express');
const Lead = require('../models/lead/Lead');
const Client = require('../models/delivery/Client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
       return res.json({ success: true, data: { leads: [], clients: [] } });
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
            { vehicle: regex }
        ]
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
            { vin: regex }
        ]
    };
    if (isConsultant) {
        clientFilter.salesperson = nameRegex;
    }

    const [leads, clients] = await Promise.all([
        Lead.find(leadFilter).limit(20).lean(),
        Client.find(clientFilter).limit(20).lean()
    ]);

    return res.json({
      success: true,
      data: { leads, clients },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
