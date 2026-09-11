/**
 * Lead.js – Lead Centre Lead model
 * Mapped from models_of_lead_center.md leadSchema
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const leadSchema = new mongoose.Schema(
  {
    // ── Core CRM fields ────────────────────────────────────────────────────
    name: { type: String, required: true },
    vehicle: { type: String, default: '' },
    dealer: { type: String, default: '' },
    score: { type: Number, default: 0, min: 0, max: 100 },
    tag: {
      type: String,
      enum: ['Contact', 'Commitment', 'Human assisted', 'AI active', 'Opted Out'],
      default: 'Contact',
    },
    color: { type: String, enum: ['blue', 'green', 'amber', 'red'], default: 'blue' },
    stage: {
      type: String,
      enum: ['NEW ENQUIRIES', 'AI QUALIFYING', 'TEST DRIVE BOOKED', 'DELIVERED', 'LOST', 'OPTED OUT'],
      default: 'NEW ENQUIRIES',
    },
    status: {
      type: String,
      enum: ['new', 'committed', 'qualification', 'sold', 'lost', 'opted out'],
      default: 'new',
    },
    source: { type: String, default: 'SMS Connect' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    stockNum: { type: String, default: '' },
    control: { type: String, default: 'AI active' },
    receivedDaysAgo: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    enquiryDesc: { type: String, default: '' },
    enquiryNote: { type: String, default: '' },
    price: { type: String, default: '' },
    paintColor: { type: String, default: '' },

    // ── Platform field ─────────────────────────────────────────────────────
    platform: {
      type: String,
      enum: ['manual', 'autogate', 'sms', 'virtualyard'],
      default: 'manual',
    },

    // ── Virtualyard specific fields ─────────────────────────────────────────
    virtualyardId: { type: String, default: null, index: true },
    customerId: { type: String, default: null },
    vyStage: { type: String, default: '' },
    vyStageText: { type: String, default: '' },
    vyTab: { type: String, default: '' },
    vyStatus: { type: String, default: '' },
    assignedTo: { type: String, default: '' },
    lastContact: { type: String, default: '' },
    leadDate: { type: Date, default: null },
    testDrive: {
      testDriveDate: { type: Date, default: null },
      location: { type: String, default: '' },
      status: { type: String, default: '' },
      confirmed: { type: Boolean, default: false },
    },

    // ── Autogate / Nextgate specific fields ────────────────────────────────
    autogateId: { type: String, default: null },
    autogateLeadId: { type: String, default: null },
    leadIdShort: { type: String, default: null },
    homePhone: { type: String, default: '' },
    customerType: { type: String, default: 'Individual' },
    dealerName: { type: String, default: '' },
    priority: { type: String, default: 'Not Set' },
    leadType: { type: String, default: '' },
    leadSource: { type: String, default: '' },
    opportunity: { type: String, default: '' },
    specificationId: { type: String, default: null },
    multipleVehicleEnquiries: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    leadStage: { type: String, default: '' },
    tags: [
      {
        label: { type: String },
        friendlyLabel: { type: String },
      },
    ],
    leadStats: {
      emailCount: { type: Number, default: 0 },
      smsCount: { type: Number, default: 0 },
      phoneCallCount: { type: Number, default: 0 },
      appointmentCount: { type: Number, default: 0 },
    },
    leadCreatedDate: { type: Date, default: null },
    allocatedPersonFullName: { type: String, default: '' },
  },
  { timestamps: true }
);

// Indexes for fast lookups
leadSchema.index({ phone: 1 });
leadSchema.index({ email: 1 });
leadSchema.index({ stage: 1 });
leadSchema.index({ assignedTo: 1 });
leadSchema.index({ allocatedPersonFullName: 1 });

module.exports = leadConn.model('Lead', leadSchema);
