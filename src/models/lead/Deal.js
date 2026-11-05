/**
 * Deal.js – Deal Registration & Virtual Yard DMS Connector Model
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const dealSchema = new mongoose.Schema(
  {
    dealId: { type: String, required: true, unique: true, index: true },
    leadId: { type: String, default: null, index: true },
    customerId: { type: String, default: null, index: true },
    buyerName: { type: String, required: true },
    buyerPhone: { type: String, required: true },
    buyerEmail: { type: String, default: '' },
    site: { type: String, default: 'Nunawading' },
    consultantName: { type: String, default: 'Alex Rivers' },
    consultantId: { type: String, default: null },

    // ── Selected Inventory Vehicle ──
    vehicle: {
      stockNumber: { type: String, required: true, index: true },
      vin: { type: String, default: '' },
      model: { type: String, required: true },
      variant: { type: String, default: '' },
      colour: { type: String, default: '' },
      year: { type: Number, default: 2024 },
      driveAwayPrice: { type: Number, required: true },
    },

    // ── Trade-In Attachment ──
    tradeIn: {
      hasTradeIn: { type: Boolean, default: false },
      appraisalId: { type: String, default: null },
      rego: { type: String, default: null },
      vin: { type: String, default: null },
      makeModel: { type: String, default: '' },
      allowance: { type: Number, default: 0 },
      payoutEstimate: { type: Number, default: 0 },
      netTradeAllowance: { type: Number, default: 0 },
      ppsrStatus: { type: String, default: 'Clear' },
    },

    // ── Financial Terms ──
    financials: {
      vehiclePrice: { type: Number, required: true },
      tradeInAllowance: { type: Number, default: 0 },
      netSettlement: { type: Number, required: true },
      depositAmount: { type: Number, default: 1000 },
      depositPaid: { type: Boolean, default: true },
      paymentMethod: {
        type: String,
        enum: ['Finance / Loan', 'Cash / EFT', 'Novated Lease', 'Credit Card', 'Bank Cheque'],
        default: 'Finance / Loan',
      },
      financeApproved: { type: Boolean, default: false },
      financeProvider: { type: String, default: null },
    },

    // ── Delivery Logistics ──
    delivery: {
      requestedDate: { type: String, default: null },
      deliveryCentre: { type: String, default: 'Nunawading Delivery Hub' },
      deliveryClientId: { type: String, default: null, index: true },
      status: {
        type: String,
        enum: ['Pending Schedule', 'Scheduled', 'In Preparation', 'Ready for Handover', 'Completed'],
        default: 'Pending Schedule',
      },
    },

    // ── Virtual Yard DMS Sync ──
    virtualYard: {
      status: {
        type: String,
        enum: ['Pending Sync', 'Pushed', 'Accepted', 'Contract Signed', 'Delivered', 'Failed'],
        default: 'Pending Sync',
      },
      pushedAt: { type: Date, default: null },
      virtualYardOrderId: { type: String, default: null, index: true },
      syncMessage: { type: String, default: '' },
    },

    status: {
      type: String,
      enum: ['Draft', 'Registered', 'Pending Finance', 'DMS Synced', 'Delivery Pending', 'Won / Delivered', 'Cancelled'],
      default: 'Registered',
      index: true,
    },

    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = leadConn.model('Deal', dealSchema);
