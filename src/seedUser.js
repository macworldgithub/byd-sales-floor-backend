/**
 * seedUser.js – Creates the initial admin user in the Delivery Centre database.
 *
 * Usage:
 *   node src/seedUser.js
 *   node src/seedUser.js --email=admin@byd.com --password=MySecret123 --name="Admin User"
 *
 * Must be run from the `backend/` directory with .env loaded.
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=');
  acc[key] = value;
  return acc;
}, {});

const EMAIL    = args.email    || 'admin@byd.com';
const PASSWORD = args.password || 'BYD@Admin2024';
const NAME     = args.name     || 'BYD Admin';
const ROLE     = args.role     || 'admin';

// ─── Connect directly (no shared db.js needed) ───────────────────────────────
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;
if (!DELIVERY_URI) {
  console.error('❌  DELIVERY_CENTER_MONGO_URI is not set in .env');
  process.exit(1);
}

async function seed() {
  const conn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  console.log('✅  Connected to Delivery Centre DB');

  // Inline schema (avoids dependency on shared db.js connection object)
  const userSchema = new mongoose.Schema(
    {
      email:               { type: String, required: true, unique: true, lowercase: true, trim: true },
      name:                { type: String, required: true },
      role:                { type: String, enum: ['super_admin', 'admin', 'manager', 'agent', 'consultant'], default: 'consultant' },
      site:                { type: String, default: '' },
      active:              { type: Boolean, default: true },
      password_hash:       { type: String, required: true, select: false },
      must_change_password:{ type: Boolean, default: false },
      last_login_at:       { type: Date, default: null },
      pushTokens:          [{ type: String }],
    },
    { timestamps: true }
  );

  const User = conn.model('User', userSchema);

  const existing = await User.findOne({ email: EMAIL });
  if (existing) {
    console.log(`ℹ️   User "${EMAIL}" already exists. Skipping creation.`);
    console.log('    To reset the password, delete the user from MongoDB and re-run this script.');
    await conn.close();
    return;
  }

  const password_hash = await bcrypt.hash(PASSWORD, 12);
  const user = await User.create({ email: EMAIL, name: NAME, role: ROLE, password_hash });

  console.log('\n🎉  User created successfully!');
  console.log('────────────────────────────────────');
  console.log(`  Email    : ${user.email}`);
  console.log(`  Name     : ${user.name}`);
  console.log(`  Role     : ${user.role}`);
  console.log(`  Password : ${PASSWORD}`);
  console.log('────────────────────────────────────');
  console.log('  ⚠️  Save these credentials. The password is not recoverable from the DB.');

  await conn.close();
}

seed().catch((err) => {
  console.error('❌  Seed failed:', err.message);
  process.exit(1);
});
