/**
 * Dealership.js – Lead Centre Dealership model
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const dealershipSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    legalEntity: { type: String, default: '' },
    address: { type: String, default: '' },
    suburb: { type: String, default: '' },
    state: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    timezone: { type: String, default: 'Australia/Melbourne' },
    smsSenderId: { type: String, default: '' },
    autogateId: { type: String, default: '' },
    autogateUsername: { type: String, default: '' },
    autogatePassword: { type: String, default: '' },
    weekdayHoursStart: { type: String, default: '09:00' },
    weekdayHoursEnd: { type: String, default: '20:00' },
    saturdayHoursStart: { type: String, default: '09:00' },
    saturdayHoursEnd: { type: String, default: '17:00' },
  },
  { timestamps: true }
);

module.exports = leadConn.model('Dealership', dealershipSchema);
