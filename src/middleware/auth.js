const jwt = require('jsonwebtoken');
const { ROLES, ALL_ROLES } = require('../constants/roles');
const { hasPlatform, resolveSite } = require('../services/accountAccess');

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';

// Normalization map for legacy or alternate role names
const ROLE_ALIASES = {
  manager: ROLES.SALES_MANAGER,
  sales_manager: ROLES.SALES_MANAGER,
  admin: ROLES.SITE_ADMIN,
  site_admin: ROLES.SITE_ADMIN,
  super_admin: ROLES.SUPER_ADMIN,
  consultant: ROLES.SALES_CONSULTANT,
  agent: ROLES.SALES_CONSULTANT,
  sales_consultant: ROLES.SALES_CONSULTANT,
  bdc: ROLES.BDC,
  lead_controller: ROLES.BDC,
  delivery: ROLES.DELIVERY_CONSULTANT,
  delivery_consultant: ROLES.DELIVERY_CONSULTANT,
};

const normalizeRole = (role) => ROLE_ALIASES[role] || role;

/**
 * authenticate – attaches decoded user to req.user or returns 401
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const User = require('../models/delivery/User');
    const account = await User.findById(decoded.id).lean();
    if (!account || account.active === false || account.deleted_at || (decoded.auth_version || 0) !== (account.auth_version || 0)) {
      return res.status(401).json({ success: false, message: 'Session revoked. Please sign in again.' });
    }
    const platform = decoded.platform || 'sales_floor';
    if (!hasPlatform(account, platform) || (req.baseUrl === '/api/crm' && !hasPlatform(account, 'crm'))) {
      return res.status(403).json({ success: false, message: 'This account does not have access to this platform.' });
    }
    const requestedSite = req.headers['x-site'] || req.query.site || req.query.yard || req.query.location || req.query.dealership || req.body?.site;
    const locked_site = resolveSite(account, requestedSite);
    req.user = { ...decoded, id: String(account._id), email: account.email, name: account.name, role: normalizeRole(account.role), site: account.site,
      locked_site, network_lookup: !locked_site && !!account.network_lookup, platform, allowed_sites: account.allowed_sites, all_sites: account.all_sites, platform_access: account.platform_access };
    if (Array.isArray(account.allowed_sites) && !account.all_sites && req.originalUrl) {
      const { deliveryConn, leadConn } = require('../db');
      await require('../services/resourceSiteAccess').guardResourceSites(req, { panel: deliveryConn.db, lead: leadConn.db });
    }
    return enforceSiteLock(req, res, next);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired.' });
    }
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (err.name === 'JsonWebTokenError' || err.name === 'CastError') return res.status(401).json({ success: false, message: 'Invalid token.' });
    return next(err);
  }
};

/**
 * requireRole – factory that checks the authenticated user's role
 * Usage: requireRole('sales_manager', 'super_admin')
 */
const requireRole = (...allowedRoles) => {
  const normalizedAllowed = allowedRoles.map(normalizeRole);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    const userRole = normalizeRole(req.user.role);
    if (!normalizedAllowed.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: `Requires one of: ${normalizedAllowed.join(', ')}. Your role: ${req.user.role}`,
      });
    }
    next();
  };
};

/**
 * generateToken – create a signed JWT for a user document
 */
const generateToken = (user, platform = 'sales_floor') =>
  jwt.sign(
    {
      id: user._id?.toString() || user.id,
      email: user.email,
      name: user.name,
      role: normalizeRole(user.role),
      site: user.site || '',
      locked_site: user.locked_site || '',
      network_lookup: Boolean(user.network_lookup),
      auth_version: user.auth_version || 0,
      platform,
      allowed_sites: user.allowed_sites,
      all_sites: user.all_sites,
      platform_access: user.platform_access,
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );

const normalizeSite = (s) =>
  String(s || '').toLowerCase().replace(/^byd\s+/i, '').replace(/[^a-z0-9]/g, '').trim();

/**
 * siteMatches – true when a record's site matches the (locked) site, ignoring "BYD " prefix/case
 */
const siteMatches = (recordSite, lockedSite) => {
  if (!lockedSite) return true;
  const a = normalizeSite(recordSite);
  const b = normalizeSite(lockedSite);
  return Boolean(a) && (a === b || a.includes(b) || b.includes(a));
};

/**
 * enforceSiteLock – for site-locked users (JWT claim `locked_site`), overrides every
 * client-supplied site/yard/location filter so only that site's data can ever be requested.
 * Must run after `authenticate`.
 */
const enforceSiteLock = (req, res, next) => {
  const locked = req.user?.locked_site;
  if (!locked) return next();
  ['site', 'yard', 'location', 'dealership'].forEach((k) => {
    req.query[k] = locked;
  });
  req.query.network_lookup = 'false';
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (req.method === 'POST' || req.body.site !== undefined) req.body.site = locked;
  }
  next();
};

module.exports = { authenticate, requireRole, generateToken, normalizeRole, enforceSiteLock, siteMatches };

