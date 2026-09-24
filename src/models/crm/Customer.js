/**
 * Customer.js – Canonical Customer Identity Model (§6.1, §6.3)
 * Stored in byd-panel (deliveryConn) as the unified system of record.
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const customerSchema = new mongoose.Schema(
  {
    customer_id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    phone: { type: String, required: true, index: true },
    email: { type: String, default: null, index: true },
    site: {
      type: String,
      enum: ['Fairfield', 'Melbourne City', 'Doncaster', 'Nunawading', 'Caroline Springs', 'Holding Yard VIC', 'All Sites'],
      default: 'Fairfield',
    },
    owner_user_id: { type: String, default: 'usr-001' },
    owner_name: { type: String, default: 'Alex Rivers' },
    source: {
      type: String,
      enum: ['Virtual Yard', 'Autogate', 'Manual', 'Carsales', 'Walk-in', 'Web', 'SMS Connect'],
      default: 'Manual',
    },
    record_type: {
      type: String,
      enum: ['Individual', 'Company', 'Fleet', 'Household'],
      default: 'Individual',
    },
    company_name: { type: String, default: null },
    lead_prospect_id: { type: String, default: null, index: true },
    delivery_client_id: { type: String, default: null, index: true },
    consent_sms: { type: Boolean, default: true },
    consent_updated_at: { type: Date, default: Date.now },
    do_not_contact: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    total_open_value: { type: Number, default: 0 },
    current_stage: {
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
    },
    active_deal_id: { type: String, default: null },
    active_vy_stock: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = deliveryConn.model('CrmCustomer', customerSchema);
