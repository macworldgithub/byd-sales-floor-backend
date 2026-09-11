/**
 * auditTrail.js – Lead Centre Audit Trail routes (read-only)
 *
 * GET /api/audit-trail       paginated audit trail
 */
const express = require('express');
const AuditTrail = require('../models/lead/AuditTrail');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('manager', 'admin', 'super_admin'));

router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 100, leadId, actor, from, to } = req.query;

    const filter = {};
    if (leadId) filter.leadId = leadId;
    if (actor) filter.actor = { $regex: actor, $options: 'i' };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [events, total] = await Promise.all([
      AuditTrail.find(filter).sort('-createdAt').skip(skip).limit(Number(limit)).lean(),
      AuditTrail.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: events,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
