/**
 * User.js – Delivery Centre User model (shared auth)
 * Used for login, JWT generation, and role-based access
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { deliveryConn } = require('../../db');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    role: {
      type: String,
      enum: ['super_admin', 'admin', 'manager', 'agent', 'consultant'],
      default: 'consultant',
    },
    // Site / dealership affiliation
    site: { type: String, default: '' },
    active: { type: Boolean, default: true },
    password_hash: { type: String, required: true, select: false },
    must_change_password: { type: Boolean, default: false },
    last_login_at: { type: Date, default: null },
    // Push notification tokens
    pushTokens: [{ type: String }],
  },
  { timestamps: true }
);

// Instance method to check password
userSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password_hash);
};

// Static method to hash a password
userSchema.statics.hashPassword = async (plain) => bcrypt.hash(plain, 12);

module.exports = deliveryConn.model('User', userSchema);
