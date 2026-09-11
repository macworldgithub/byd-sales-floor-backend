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

// ─── GET /api/inventory/:id ─────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const item = await Inventory.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found.' });
    return res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
