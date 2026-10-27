/**
 * auth.js – Authentication routes
 * POST /api/auth/login
 * GET  /api/auth/me
 * POST /api/auth/logout
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/delivery/User');
const AuditEvent = require('../models/delivery/AuditEvent');
const { generateToken, authenticate } = require('../middleware/auth');
const { hasPlatform } = require('../services/accountAccess');

const router = express.Router();

// ─── POST /api/auth/login ───────────────────────────────────────────────────
router.post(
  '/login',
  [
    body('email').trim().isEmail().withMessage('Valid email required').customSanitizer(value => value.toLowerCase()),
    body('password').notEmpty().withMessage('Password required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password } = req.body;

      // Fetch user WITH password (select: false on schema means we need explicit +)
      const user = await User.findOne({ email, active: true }).select('+password_hash');
      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }

      const valid = await user.comparePassword(password);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }
      const platform = req.body.platform || 'sales_floor';
      if (!['crm', 'sales_floor'].includes(platform) || !hasPlatform(user, platform)) {
        return res.status(403).json({ success: false, message: 'This account does not have access to this platform.' });
      }

      // Update last login
      user.last_login_at = new Date();
      await user.save();

      const token = generateToken(user, platform);

      // Audit
      await AuditEvent.create({
        actor_id: user._id.toString(),
        actor_email: user.email,
        action: 'login',
        entity: 'User',
        entity_id: user._id.toString(),
        ip: req.ip,
      });

      const userObj = user.toObject();
      delete userObj.password_hash;

      return res.json({
        success: true,
        data: {
          access_token: token,
          token_type: 'bearer',
          must_change_password: user.must_change_password,
          user: userObj,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    await AuditEvent.create({
      actor_id: req.user.id,
      actor_email: req.user.email,
      action: 'logout',
      entity: 'User',
      entity_id: req.user.id,
      ip: req.ip,
    });
    return res.json({ success: true, message: 'Logged out.' });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/change-password ────────────────────────────────────────
router.post(
  '/change-password',
  authenticate,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 8 }).withMessage('Password min 8 chars'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const user = await User.findById(req.user.id).select('+password_hash');
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      const valid = await user.comparePassword(req.body.current_password);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Current password incorrect.' });
      }

      user.password_hash = await User.hashPassword(req.body.new_password);
      user.must_change_password = false;
      user.auth_version = (user.auth_version || 0) + 1;
      await user.save();

      return res.json({ success: true, message: 'Password updated.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/auth/crm-session ──────────────────────────────────────────────
// Requires valid authentication token – desk session cannot be accessed anonymously
router.get('/crm-session', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found or unauthenticated.' });
    }
    if (!hasPlatform(user, 'crm')) return res.status(403).json({ success: false, message: 'Sales CRM access is not assigned to this account.' });
    const token = generateToken(user, 'crm');
    return res.json({
      success: true,
      data: {
        access_token: token,
        token_type: 'bearer',
        user: {
          id: user._id?.toString() || user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          site: user.site,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
