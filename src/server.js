require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const errorHandler = require('./middleware/errorHandler');

// ─── Initialize DB Connections ──────────────────────────────────────────────
const { ensureDbConnected } = require('./db');

const app = express();

// Parse and normalize allowed CORS origins (handles trailing slashes, whitespace, and missing protocols)
const parseAllowedOrigins = () => {
  if (!process.env.ALLOWED_ORIGINS) return '*';
  const origins = process.env.ALLOWED_ORIGINS
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (origins.includes('*')) return '*';

  const set = new Set();
  origins.forEach(origin => {
    set.add(origin);
    if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
      set.add(`https://${origin}`);
      set.add(`http://${origin}`);
    }
  });
  return Array.from(set);
};

const allowedOrigins = parseAllowedOrigins();

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins === '*' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(morgan('dev'));

// DB Connection Readiness Middleware for serverless environments
app.use(async (req, res, next) => {
  if (req.path === '/api/health' || req.method === 'OPTIONS') return next();
  try {
    await ensureDbConnected();
    next();
  } catch (err) {
    return res.status(503).json({
      success: false,
      message: 'Database connection failed. Please ensure MongoDB Atlas Network Access has 0.0.0.0/0 whitelisted and environment variables (LEAD_CENTER_MONGO_URI, DELIVERY_CENTER_MONGO_URI) are set on Vercel.',
      error: err.message,
    });
  }
});

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'BYD Sales Floor API is running' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/dealerships', require('./routes/dealerships'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/audit-trail', require('./routes/auditTrail'));

app.use('/api/clients', require('./routes/clients'));
app.use('/api/offers', require('./routes/offers'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/messages', require('./routes/messages'));

app.use('/api/stats', require('./routes/stats'));
app.use('/api/search', require('./routes/search'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/crm', require('./routes/crm'));

// ─── Error Handling ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: 'API Route Not Found' });
});

app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 BYD Sales Floor API running on port ${PORT}`);
  });
}

module.exports = app;
