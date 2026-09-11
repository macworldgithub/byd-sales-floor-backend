/**
 * Template.js – Delivery Centre SMS/Email Template model
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    body: { type: String, required: true },
    category: { type: String, default: 'General' },
    channel: { type: String, enum: ['sms', 'email', 'both'], default: 'sms' },
    // Merge fields used in this template for UI preview
    mergeFields: [{ type: String }],
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = deliveryConn.model('Template', templateSchema);
