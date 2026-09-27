/**
 * db.js – Dual MongoDB connections with serverless optimization
 * leadConn  → Lead Centre database
 * deliveryConn → Delivery Centre database
 */
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);
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

/**
 * Compound & Performance DB Indexes (§9 Performance & Resilience)
 */
async function ensureIndexes() {
  try {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const allocColl = deliveryConn.db.collection('allocations');
    const docColl = deliveryConn.db.collection('crmdocuments');
    const holdColl = deliveryConn.db.collection('stockholds');

    await Promise.allSettled([
      custColl.createIndex({ site: 1, updatedAt: -1 }),
      custColl.createIndex({ owner_name: 1, updatedAt: -1 }),
      custColl.createIndex({ customer_id: 1 }, { unique: true, sparse: true }),
      custColl.createIndex({ phone: 1 }),
      custColl.createIndex({ email: 1 }),

      oppColl.createIndex({ stage: 1, site: 1, owner_name: 1 }),
      oppColl.createIndex({ customer_id: 1, stage: 1 }),
      oppColl.createIndex({ opportunity_id: 1 }, { unique: true, sparse: true }),
      oppColl.createIndex({ vy_stock_id: 1 }),

      tlColl.createIndex({ customer_id: 1, occurred_at: -1 }),
      tlColl.createIndex({ opportunity_id: 1, occurred_at: -1 }),
      tlColl.createIndex({ event_id: 1 }, { unique: true, sparse: true }),

      allocColl.createIndex({ status: 1, sla_expires_at: 1 }),
      allocColl.createIndex({ allocation_id: 1 }, { unique: true, sparse: true }),
      allocColl.createIndex({ site: 1 }),

      docColl.createIndex({ customer_id: 1, createdAt: -1 }),
      docColl.createIndex({ doc_id: 1 }, { unique: true, sparse: true }),

      holdColl.createIndex({ status: 1, expires_at: 1 }),
      holdColl.createIndex({ stock_id: 1 }),
    ]);
    console.log('✅ CRM Compound & Performance DB Indexes verified');
  } catch (err) {
    console.warn('⚠️  Index creation notice:', err.message);
  }
}

// Automatically trigger index verification on DB connect
deliveryConn.on('connected', () => {
  ensureIndexes().catch(() => {});
});

module.exports = { leadConn, deliveryConn, ensureDbConnected, ensureIndexes };

