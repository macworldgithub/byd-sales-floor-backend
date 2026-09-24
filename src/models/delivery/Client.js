/**
 * Client.js – Delivery Centre Client (delivery/handover) model
 * Mapped from model_for_delivery_center.md ClientBase + Client
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const commentSchema = new mongoose.Schema({
  author_id: { type: String, default: null },
  author_name: { type: String, required: true },
  body: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
});

const accessorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: {
    type: String,
    enum: ['Pending Order', 'Ordered', 'Fitted', 'On Hand'],
    default: 'Pending Order',
  },
  note: { type: String, default: null },
  updated_at: { type: Date, default: Date.now },
});

const clientSchema = new mongoose.Schema(
  {
    // ── Core fields ───────────────────────────────────────────────────
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: null },
    vehicle: { type: String, required: true },
    rego: { type: String, default: null },
    vin: { type: String, default: null },
    po_number: { type: String, default: null },
    payment_method: { type: String, default: null },
    order_date: { type: String, default: null },
    sale_type: {
      type: String,
      enum: ['Retail', 'Lease', 'Novated', 'Novated lease', 'Fleet', 'Government', 'Rental', 'Cash', 'Demo', 'Other'],
      default: 'Retail',
    },
    fleet_company: { type: String, default: null },
    fleet_reference: { type: String, default: null },
    lease_consultant: { type: String, default: null },
    registered_operator_type: {
      type: String,
      enum: ['Individual', 'Company'],
      default: 'Individual',
    },

    // ── Trade-in ──────────────────────────────────────────────────────
    trade_in_flag: { type: Boolean, default: false },
    trade_in_attached: { type: Boolean, default: false },
    trade_in_sale_date: { type: String, default: null },
    trade_in_valid_until: { type: String, default: null },
    trade_in_status: {
      type: String,
      enum: ['Pending', 'Quoted', 'Accepted', 'Vehicle received', 'Settled', 'Valid', 'Expiring soon', 'Expiring', 'Expired', 'Cancelled'],
      default: 'Pending',
    },
    trade_in_manager_reason: { type: String, default: null },
    trade_in_override_by: { type: String, default: null },
    trade_in_override_at: { type: Date, default: null },

    // ── Offers ───────────────────────────────────────────────────────
    linked_offer_ids: [{ type: String }],
    your_way_selection: {
      type: String,
      enum: ['Cashback', 'Accessories', 'Car care', 'Merchandise', 'Charging', 'Other', null],
      default: null,
    },
    your_way_note: { type: String, default: null },

    // ── Registration & Documents ──────────────────────────────────────
    registration_status: {
      type: String,
      enum: ['Awaiting registration documents', 'Awaiting VIN', 'Ready to register', 'Partial', 'Complete'],
      default: 'Awaiting registration documents',
    },
    registration_docs_complete: { type: Boolean, default: false },
    handover_checklist_status: {
      type: String,
      enum: ['Not issued', 'Issued in VY', 'Signed copy on file', 'Exception'],
      default: 'Not issued',
    },

    // ── Activation ────────────────────────────────────────────────────
    activation_ready: { type: Boolean, default: false },
    activation_status: {
      type: String,
      enum: ['Blocked', 'Ready', 'Submitted to BYD', 'Active'],
      default: 'Blocked',
    },
    activation_override_reason: { type: String, default: null },
    activation_override_by: { type: String, default: null },
    activation_override_at: { type: Date, default: null },

    // ── Offer status ──────────────────────────────────────────────────
    offer_status: {
      type: String,
      enum: ['Eligible', 'At risk', 'Ineligible'],
      default: 'Eligible',
    },
    offer_reason: { type: String, default: null },

    // ── Documents (array of document sub-docs) ────────────────────────
    documents: [{ type: mongoose.Schema.Types.Mixed }],
    document_completeness: {
      type: String,
      enum: ['Requested', 'Partial', 'Complete'],
      default: 'Requested',
    },

    // ── Delivery ──────────────────────────────────────────────────────
    deal_type: { type: String, default: null },
    delivery_date: { type: String, default: null },
    stage: {
      type: String,
      enum: ['Scheduled', 'Pre-Delivery Inspection', 'In Transit', 'Ready for Pickup', 'Delivered'],
      default: 'Scheduled',
    },
    salesperson: { type: String, default: null },
    notes: { type: String, default: null },
    address: { type: String, default: null },
    location: { type: String, default: null },

    // ── VY / integrations ─────────────────────────────────────────────
    vy_order_id: { type: String, default: null },
    vy_stock_id: { type: String, default: null },
    stripe_customer_id: { type: String, default: null },

    // ── Vehicle arrival ───────────────────────────────────────────────
    arrived: { type: Boolean, default: false },
    arrived_at: { type: Date, default: null },

    // ── Contact tracking ──────────────────────────────────────────────
    contact_status: {
      type: String,
      enum: ['Not Contacted', 'Contacted', 'Booked', 'Awaiting Reply'],
      default: 'Not Contacted',
    },
    last_contacted_at: { type: Date, default: null },

    // ── Assignment ────────────────────────────────────────────────────
    assigned_agent_id: { type: String, default: null },

    // ── Accessories / aftermarket ─────────────────────────────────────
    accessories: [accessorySchema],
    aftermarket_notes: { type: String, default: null },
    addons: [{ type: String }],

    // ── Embedded comments ─────────────────────────────────────────────
    comments: [commentSchema],

    // ── Import metadata ───────────────────────────────────────────────
    imported_from: { type: String, default: null },
    imported_at: { type: Date, default: null },
    crm_customer_id: { type: String, default: null },
    crm_opportunity_id: { type: String, default: null },
  },
  { timestamps: true }
);

clientSchema.index({ phone: 1 });
clientSchema.index({ email: 1 });
clientSchema.index({ salesperson: 1 });
clientSchema.index({ stage: 1 });
clientSchema.index({ delivery_date: 1 });
clientSchema.index({ vin: 1 }, { sparse: true });
clientSchema.index({ vy_order_id: 1 }, { sparse: true });

module.exports = deliveryConn.model('Client', clientSchema);
