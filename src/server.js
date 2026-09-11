/**
 * server.js – Main Express Application Entry Point
 */
const dns = require('dns')
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const errorHandler = require('./middleware/errorHandler');

// ─── Initialize DB Connections ──────────────────────────────────────────────
require('./db');

const app = express();

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(morgan('dev'));

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

// ─── Error Handling ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: 'API Route Not Found' });
});

app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 BYD Sales Floor API running on port ${PORT}`);
});
