/**
 * settings.js – Lead Centre SMS Settings routes
 *
 * GET   /api/settings     get SMS config
 * PATCH /api/settings     update SMS config (admin+)
 */
const express = require('express');
const Setting = require('../models/lead/Setting');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    let setting = await Setting.findOne({ key: 'sms_config' }).lean();
    if (!setting) {
      setting = await Setting.create({ key: 'sms_config' });
    }
    // Never expose apiKey in full to non-admins
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      delete setting.apiKey;
      delete setting.autogatePassword;
    }
    return res.json({ success: true, data: setting });
  } catch (err) {
    next(err);
  }
});

router.patch('/', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    delete req.body._id;
    const setting = await Setting.findOneAndUpdate(
      { key: 'sms_config' },
      { $set: req.body },
      { new: true, upsert: true }
    );
    return res.json({ success: true, data: setting });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
