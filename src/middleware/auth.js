/**
 * auth.js – JWT authentication middleware
 * Verifies Bearer token on every protected route.
 * Role-based gate helpers are also exported here.
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';

/**
 * authenticate – attaches decoded user to req.user or returns 401
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role, site }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

/**
 * requireRole – factory that checks the authenticated user's role
 * Usage: requireRole('manager', 'super_admin')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Requires one of: ${roles.join(', ')}. Your role: ${req.user.role}`,
    });
  }
  next();
};

/**
 * generateToken – create a signed JWT for a user document
 */
const generateToken = (user) =>
  jwt.sign(
    {
      id: user._id || user.id,
      email: user.email,
      role: user.role,
      site: user.site || '',
      network_lookup: Boolean(user.network_lookup),
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );

module.exports = { authenticate, requireRole, generateToken };
