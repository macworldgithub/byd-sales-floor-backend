/**
 * Appraisal.js – I-Appraise Vehicle Inspection Model
 * Supports full vehicle walk-around, condition ratings, damage points,
 * loan-car digital agreement, and PPSR status.
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const appraisalSchema = new mongoose.Schema(
  {
    appraisalId: { type: String, required: true, unique: true, index: true },
    leadId: { type: String, default: null, index: true },
    customerId: { type: String, default: null, index: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, default: '' },
    customerEmail: { type: String, default: '' },
    site: { type: String, default: 'Nunawading' },

    // ── Vehicle Identification (Rego & VIN) ──
    rego: { type: String, required: true, uppercase: true, trim: true, index: true },
    vin: { type: String, required: true, uppercase: true, trim: true, index: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    odometer: { type: Number, default: 0 },
    colour: { type: String, default: 'Silver' },
    bodyType: { type: String, default: 'SUV' },
    transmission: { type: String, default: 'Automatic' },
    fuelType: { type: String, default: 'Petrol' },
    engine: { type: String, default: '2.0L' },
    state: { type: String, default: 'VIC' },

    // ── PPSR Verification ──
    ppsrStatus: {
      type: String,
      enum: ['Clear', 'Encumbered', 'WrittenOff', 'Stolen'],
      default: 'Clear',
      index: true,
    },
    ppsrDetails: {
      certificateNumber: { type: String, default: null },
      financier: { type: String, default: null },
      encumbranceType: { type: String, default: null },
      checkedAt: { type: Date, default: Date.now },
    },

    // ── Walk-Around & Condition Assessment ──
    condition: {
      exteriorRating: { type: Number, min: 1, max: 5, default: 4 },
      interiorRating: { type: Number, min: 1, max: 5, default: 4 },
      tyresRating: { type: Number, min: 1, max: 5, default: 4 },
      mechanicalRating: { type: Number, min: 1, max: 5, default: 5 },
      notes: { type: String, default: '' },
      damagePoints: [
        {
          panel: { type: String, default: '' }, // e.g. "Front Bumper", "Left Rear Door"
          severity: { type: String, enum: ['Minor', 'Moderate', 'Major'], default: 'Minor' },
          description: { type: String, default: '' },
          estimatedRepairCost: { type: Number, default: 0 },
        },
      ],
      photos: [{ type: String }],
    },

    // ── Valuation & Settlement ──
    valuation: {
      wholesaleValue: { type: Number, default: 0 },
      retailValue: { type: Number, default: 0 },
      customerExpectation: { type: Number, default: 0 },
      tradeInAllowance: { type: Number, default: 0 },
      payoutEstimate: { type: Number, default: 0 },
      netTradeAllowance: { type: Number, default: 0 },
    },

    // ── Loan-Car Agreement ──
    loanCar: {
      isRequired: { type: Boolean, default: false },
      loanCarRego: { type: String, default: null },
      loanCarModel: { type: String, default: null },
      signedBy: { type: String, default: null },
      signedAt: { type: Date, default: null },
      isSigned: { type: Boolean, default: false },
      notes: { type: String, default: '' },
    },

    status: {
      type: String,
      enum: ['Draft', 'Pending Inspection', 'Completed', 'Approved', 'Declined'],
      default: 'Completed',
      index: true,
    },

    consultantName: { type: String, default: 'Alex Rivers' },
    consultantId: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = leadConn.model('Appraisal', appraisalSchema);
