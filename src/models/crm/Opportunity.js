/**
 * Opportunity.js – Selling Motion / Deal Object (§6.1, §6.3)
 * Represents an active buying cycle; maps 1:1 to a DeliveryClient once marked Sold.
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const opportunitySchema = new mongoose.Schema(
  {
    opportunity_id: { type: String, required: true, unique: true, index: true },
    customer_id: { type: String, required: true, index: true },
    customer_name: { type: String, required: true },
    customer_phone: { type: String, required: true },
    customer_email: { type: String, default: '' },
    site: { type: String, required: true },
    owner_user_id: { type: String, required: true },
    owner_name: { type: String, required: true },
    secondary_owner: { type: String, default: null },
    secondary_split: { type: Number, default: 0 },
    stage: {
      type: String,
      enum: [
        'New / Allocated',
        'Working',
        'Appointment',
        'Negotiation',
        'Written / Sold',
        'In Delivery',
        'Delivered / Won',
        'Lost / Parked',
      ],
      default: 'New / Allocated',
      index: true,
    },
    vehicle_descriptor: { type: String, required: true },
    model: { type: String, required: true },
    variant: { type: String, default: '' },
    colour: { type: String, default: '' },
    order_type: { type: String, enum: ['Stock', 'Factory Order'], default: 'Stock' },
    vy_stock_id: { type: String, default: null, index: true },
    vy_order_id: { type: String, default: null, index: true },
    sale_type: {
      type: String,
      enum: ['Retail', 'Lease', 'Novated', 'Fleet', 'Government', 'Rental', 'Cash', 'Demo', 'Other'],
      default: 'Retail',
    },
    list_price: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    extras: { type: Number, default: 0 },
    total_deal_value: { type: Number, default: 0 },
    trade_in_flag: { type: Boolean, default: false },
    trade_in_details: {
      makeModel: { type: String, default: '' },
      rego: { type: String, default: '' },
      year: { type: Number, default: null },
      valuation: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ['Pending', 'Valued', 'Accepted', 'Settled'],
        default: 'Pending',
      },
    },
    expected_close: { type: String, default: null },
    next_action_at: { type: Date, default: null },
    next_action_text: { type: String, default: '' },
    is_overdue: { type: Boolean, default: false },
    sales_log_id: { type: String, default: null, index: true },
    delivery_client_id: { type: String, default: null, index: true },
    delivery_stage: {
      type: String,
      enum: ['Scheduled', 'Pre-Delivery Inspection', 'In Transit', 'Ready for Pickup', 'Delivered', null],
      default: null,
    },
    lost_reason: {
      type: String,
      enum: ['Price', 'Stock Unavailable', 'Chose Competitor', 'Finance Declined', 'Opted Out', 'Other', null],
      default: null,
    },
    lost_notes: { type: String, default: null },
    sync_status: {
      type: String,
      enum: ['synced', 'vy_pending', 'delivery_pending', 'failed'],
      default: 'synced',
    },
  },
  { timestamps: true }
);

module.exports = deliveryConn.model('CrmOpportunity', opportunitySchema);
