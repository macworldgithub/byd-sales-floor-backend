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

const mobileMessageService = require('../services/mobileMessage');

router.post('/test-sms', requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { username, apiKey } = req.body;
    let creds = null;
    if (username && apiKey) {
      creds = { username, password: apiKey };
    }

    const testRes = await mobileMessageService.testConnection(creds);

    const updateFields = {
      connectionStatus: testRes.success ? 'connected' : 'failed',
      lastTestedAt: new Date(),
      connectionMessage: testRes.success
        ? `Connected. Credits: ${testRes.account?.credits ?? 'N/A'}`
        : testRes.error || 'Failed to connect',
    };

    const setting = await Setting.findOneAndUpdate(
      { key: 'sms_config' },
      { $set: updateFields },
      { new: true, upsert: true }
    );

    return res.json({
      success: testRes.success,
      data: {
        setting,
        account: testRes.account,
        senders: testRes.senders,
      },
      error: testRes.error,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
