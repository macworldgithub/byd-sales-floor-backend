/**
 * db.js – Dual MongoDB connections
 * leadConn  → Lead Centre database
 * deliveryConn → Delivery Centre database
 */
const mongoose = require('mongoose');

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI;
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;

// Create two separate Mongoose connections so models stay isolated per database
const leadConn = mongoose.createConnection(LEAD_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

const deliveryConn = mongoose.createConnection(DELIVERY_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

leadConn.on('connected', () =>
  console.log('✅ Lead Centre DB connected')
);
leadConn.on('error', (err) =>
  console.error('❌ Lead Centre DB error:', err.message)
);
leadConn.on('disconnected', () =>
  console.warn('⚠️  Lead Centre DB disconnected')
);

deliveryConn.on('connected', () =>
  console.log('✅ Delivery Centre DB connected')
);
deliveryConn.on('error', (err) =>
  console.error('❌ Delivery Centre DB error:', err.message)
);
deliveryConn.on('disconnected', () =>
  console.warn('⚠️  Delivery Centre DB disconnected')
);

module.exports = { leadConn, deliveryConn };
