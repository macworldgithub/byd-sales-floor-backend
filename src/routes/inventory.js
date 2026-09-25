/**
 * inventory.js – Lead Centre Inventory routes (read-only from Sales Floor)
 *
 * GET /api/inventory        list inventory with filters
 * GET /api/inventory/:id    single inventory item
 */
const express = require('express');
const Inventory = require('../models/lead/Inventory');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/inventory ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      model,
      condition,
      platform,
      q,
      sort = '-lastSeen',
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (condition) filter.condition = condition;
    if (platform) filter.platform = platform;
    if (model) {
      filter.$or = [
        { model: { $regex: model, $options: 'i' } },
        { 'specifications.model': { $regex: model, $options: 'i' } },
        { title: { $regex: model, $options: 'i' } },
      ];
    }
    if (q) {
      filter.$or = [
        { stock: { $regex: q, $options: 'i' } },
        { title: { $regex: q, $options: 'i' } },
        { 'registration.rego': { $regex: q, $options: 'i' } },
        { 'registration.vin': { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Inventory.find(filter).sort(sort).skip(skip).limit(Number(limit)).lean(),
      Inventory.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/inventory/:id/soft-hold (§5.6, §6.1 Soft Hold) ───────────────
router.post('/:id/soft-hold', async (req, res, next) => {
  try {
    const { customerName, durationHours = 48, notes } = req.body;
    const expiresAt = new Date(Date.now() + Number(durationHours) * 3600000);

    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'Held',
          'holdDetails.heldBy': req.user.name || req.user.email,
          'holdDetails.customerName': customerName || 'Valued Prospect',
          'holdDetails.expiresAt': expiresAt,
          'holdDetails.notes': notes || 'Soft hold placed from Sales Floor',
        },
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    return res.json({
      success: true,
      message: `Soft hold placed for ${customerName || 'customer'} (expires in ${durationHours}h)`,
      data: item,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/inventory/:id/release-hold ───────────────────────────────────
router.post('/:id/release-hold', async (req, res, next) => {
  try {
    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      {
        $set: { status: 'Available' },
        $unset: { holdDetails: 1 },
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    return res.json({ success: true, message: 'Soft hold released. Vehicle back in available stock.', data: item });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
