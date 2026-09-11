/**
 * offers.js – Delivery Centre Offer routes
 */
const express = require('express');
const OfferRecord = require('../models/delivery/OfferRecord');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const offers = await OfferRecord.find({ active: true }).sort('name').lean();
    return res.json({ success: true, data: offers });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const offer = await OfferRecord.create(req.body);
    return res.status(201).json({ success: true, data: offer });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    delete req.body._id;
    const offer = await OfferRecord.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!offer) return res.status(404).json({ success: false, message: 'Offer not found.' });
    return res.json({ success: true, data: offer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
