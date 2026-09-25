require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const compression = require('compression');
const rateLimit = require('express-rate-limit');

const errorHandler = require('./middleware/errorHandler');

// ─── Initialize DB Connections ──────────────────────────────────────────────
const { leadConn, deliveryConn, ensureDbConnected } = require('./db');

const app = express();

// Trust reverse proxy (Nginx / Cloudflare / Traefik on VPS)
app.set('trust proxy', 1);

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
app.use(compression()); // Gzip/deflate payload compression for high-performance responses
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, health checks, PM2)
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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Logging: combined for production, dev for local testing
const isProd = process.env.NODE_ENV === 'production';
app.use(morgan(isProd ? 'combined' : 'dev'));

// Rate Limiting (§5.10 Security & DDoS protection)
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Rate limit exceeded. Too many requests from this IP, please try again later.',
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 30 login attempts per 15 min window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// DB Connection Readiness Middleware
app.use(async (req, res, next) => {
  if (req.path === '/api/health' || req.method === 'OPTIONS') return next();
  try {
    await ensureDbConnected();
    next();
  } catch (err) {
    return res.status(503).json({
      success: false,
      message: 'Database connection failed. Please ensure MongoDB Atlas Network Access has 0.0.0.0/0 whitelisted and environment variables (LEAD_CENTER_MONGO_URI, DELIVERY_CENTER_MONGO_URI) are set.',
      error: err.message,
    });
  }
});

// ─── Healthcheck Endpoint (Enhanced for VPS Monitoring / Nginx) ─────────────
app.get('/api/health', (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    success: true,
    message: 'BYD Sales Floor & CRM Suite API is operational',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    databases: {
      leadCenter: leadConn.readyState === 1 ? 'connected' : 'connecting_or_disconnected',
      deliveryCenter: deliveryConn.readyState === 1 ? 'connected' : 'connecting_or_disconnected',
    },
    system: {
      nodeVersion: process.version,
      heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
      rssMB: Math.round(memory.rss / 1024 / 1024),
    },
  });
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

// ─── Start Server & Graceful Shutdown ───────────────────────────────────────
let server = null;
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  server = app.listen(PORT, () => {
    console.log(`🚀 BYD Sales Floor API running in ${process.env.NODE_ENV || 'development'} on port ${PORT}`);
  });
}

// Handle Graceful Shutdown for PM2 / Docker on VPS
const handleShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Gracefully stopping BYD Sales Floor API...`);
  if (server) {
    server.close(async () => {
      console.log('✅ HTTP server closed. Closing MongoDB connections...');
      try {
        await Promise.allSettled([leadConn.close(), deliveryConn.close()]);
        console.log('✅ MongoDB connections closed cleanly. Exiting.');
        process.exit(0);
      } catch (err) {
        console.error('Error during database teardown:', err);
        process.exit(1);
      }
    });

    // Force exit after 10s if connections refuse to terminate
    setTimeout(() => {
      console.error('⚠️ Shutdown timeout exceeded. Forcing termination.');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

module.exports = app;

