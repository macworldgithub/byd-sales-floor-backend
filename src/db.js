/**
 * db.js – Dual MongoDB connections with serverless optimization
 * leadConn  → Lead Centre database
 * deliveryConn → Delivery Centre database
 */
const mongoose = require('mongoose');

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI;
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;

if (!LEAD_URI) {
  console.error('❌ Missing LEAD_CENTER_MONGO_URI in environment variables');
}
if (!DELIVERY_URI) {
  console.error('❌ Missing DELIVERY_CENTER_MONGO_URI in environment variables');
}

const connectionOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 0,
};

// Create two separate Mongoose connections so models stay isolated per database
const leadConn = mongoose.createConnection(LEAD_URI || '', connectionOptions);
const deliveryConn = mongoose.createConnection(DELIVERY_URI || '', connectionOptions);

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

/**
 * Ensure both database connections are established before executing operations
 */
let connectionPromise = null;

async function ensureDbConnected() {
  if (!LEAD_URI || !DELIVERY_URI) {
    throw new Error('Database connection strings (LEAD_CENTER_MONGO_URI / DELIVERY_CENTER_MONGO_URI) are missing in environment variables.');
  }

  if (leadConn.readyState === 1 && deliveryConn.readyState === 1) {
    return true;
  }

  if (!connectionPromise) {
    connectionPromise = Promise.all([
      leadConn.readyState === 1 ? Promise.resolve() : leadConn.asPromise(),
      deliveryConn.readyState === 1 ? Promise.resolve() : deliveryConn.asPromise(),
    ]).finally(() => {
      connectionPromise = null;
    });
  }

  await connectionPromise;
  return true;
}

module.exports = { leadConn, deliveryConn, ensureDbConnected };

