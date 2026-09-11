/**
 * templates.js – Delivery Centre Template routes
 */
const express = require('express');
const Template = require('../models/delivery/Template');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const templates = await Template.find({ active: true }).sort('name').lean();
    return res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('manager', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    const template = await Template.create({ ...req.body, createdBy: req.user.email });
    return res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('manager', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    delete req.body._id;
    const template = await Template.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    return res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
