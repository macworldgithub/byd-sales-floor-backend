/**
 * dealerships.js – Lead Centre Dealership routes
 *
 * GET    /api/dealerships       list
 * POST   /api/dealerships       create (admin+)
 * GET    /api/dealerships/:id   single
 * PATCH  /api/dealerships/:id   update (admin+)
 */
const express = require('express');
const Dealership = require('../models/lead/Dealership');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const dealerships = await Dealership.find().sort('name').lean();
    return res.json({ success: true, data: dealerships });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const dealership = await Dealership.create(req.body);
    return res.status(201).json({ success: true, data: dealership });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const d = await Dealership.findById(req.params.id).lean();
    if (!d) return res.status(404).json({ success: false, message: 'Dealership not found.' });
    return res.json({ success: true, data: d });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    delete req.body._id;
    const d = await Dealership.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!d) return res.status(404).json({ success: false, message: 'Dealership not found.' });
    return res.json({ success: true, data: d });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
