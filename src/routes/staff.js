/**
 * staff.js – Staff Directory route
 * GET /api/staff
 * Scoped by user's assigned / locked site:
 * - If user has a locked_site, returns only staff belonging to that site.
 * - If user has full access (super_admin / admin / unlocked / network_lookup), returns all staff (or filtered by ?site=).
 */
const express = require('express');
const router = express.Router();
const User = require('../models/delivery/User');
const { authenticate } = require('../middleware/auth');
const { siteConditions } = require('../services/staffDirectory');

function escapeRegex(str) {
  return typeof str === 'string' ? str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const isSuperAdmin = req.user?.role === 'super_admin' || req.user?.role === 'admin';
    const userLockedSite = req.user?.locked_site || '';
    const managedScope = Array.isArray(req.user?.allowed_sites) && !req.user.all_sites;
    const hasFullAccess = !managedScope && (isSuperAdmin || !userLockedSite || Boolean(req.user?.network_lookup));

    const filter = { active: { $ne: false } };

    if (!hasFullAccess) {
      // Scoped to specific site
      filter.$or = await siteConditions(User.db, userLockedSite);
    } else if (req.query.site && req.query.site !== 'All' && req.query.site !== 'All Sites' && req.query.site !== 'All Locations') {
      filter.$or = await siteConditions(User.db, req.query.site);
    }

    // Optional search term
    if (req.query.q) {
      const safeQ = escapeRegex(req.query.q.trim());
      const searchOr = [
        { name: { $regex: safeQ, $options: 'i' } },
        { email: { $regex: safeQ, $options: 'i' } },
        { role: { $regex: safeQ, $options: 'i' } },
        { phone: { $regex: safeQ, $options: 'i' } },
        { position: { $regex: safeQ, $options: 'i' } },
        { team: { $regex: safeQ, $options: 'i' } },
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const staffList = await User.find(filter)
      .select('-password_hash -pushTokens')
      .sort({ name: 1 })
      .lean();

    // Distinct sites for filter dropdown
    let availableSites = [];
    if (hasFullAccess) {
      const distinctSites = await User.distinct('site', { active: { $ne: false } });
      const distinctLocked = await User.distinct('locked_site', { active: { $ne: false } });
      const siteSet = new Set(
        [...distinctSites, ...distinctLocked]
          .filter(Boolean)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      );
      availableSites = Array.from(siteSet).sort();
    }

    return res.json({
      success: true,
      data: staffList,
      total: staffList.length,
      userScope: {
        hasFullAccess,
        userSite: userLockedSite || req.user?.site || 'All Sites',
      },
      availableSites,
    });
  } catch (err) {
    next(err);
  }
});

// Live in-memory presence tracking for geofenced staff (§4, §7)
const STAFF_PRESENCE = new Map();

// ─── POST /api/staff/geofence-update ─────────────────────────────────────────
router.post('/geofence-update', authenticate, async (req, res, next) => {
  try {
    const { isInsideGeofence, site, latitude, longitude, activity } = req.body;
    const userId = req.user._id ? req.user._id.toString() : req.user.id;
    const presenceData = {
      userId,
      name: req.user.name || 'Sales Consultant',
      email: req.user.email,
      role: req.user.role || 'sales_consultant',
      site: site || req.user.site || 'BYD Nunawading',
      isInsideGeofence: Boolean(isInsideGeofence),
      status: isInsideGeofence ? 'On-Site' : 'Off-Site',
      activity: activity || (isInsideGeofence ? 'Showroom Floor' : 'Test Drive Loop'),
      latitude,
      longitude,
      lastUpdated: new Date().toISOString(),
    };

    STAFF_PRESENCE.set(userId, presenceData);

    return res.json({
      success: true,
      message: `Geofence updated: ${req.user.name} is ${presenceData.status} (${presenceData.activity})`,
      data: presenceData,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/staff/presence ────────────────────────────────────────────────
router.get('/presence', authenticate, async (req, res, next) => {
  try {
    const presenceList = Array.from(STAFF_PRESENCE.values());
    return res.json({
      success: true,
      data: presenceList,
      totalOnSite: presenceList.filter((p) => p.isInsideGeofence).length,
      totalOffSite: presenceList.filter((p) => !p.isInsideGeofence).length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
