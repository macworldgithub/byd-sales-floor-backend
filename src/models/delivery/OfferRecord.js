/**
 * OfferRecord.js – Delivery Centre Offer model
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const offerRecordSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    source_key: { type: String, default: null },
    model_variant: { type: String, default: null },
    body_style: { type: String, default: null },
    powertrain: { type: String, default: null },
    display_value: { type: String, default: null },
    display_unit: { type: String, default: null },
    image_url: { type: String, default: null },
    configurator_url: { type: String, default: null },
    source_url: { type: String, default: null },
    eligible_models: [{ type: String }],
    order_from: { type: String, default: null },
    order_to: { type: String, default: null },
    deliver_by: { type: String, default: null },
    honour_if_delayed: { type: Boolean, default: false },
    sale_type_exclusions: [{ type: String }],
    combinable: { type: Boolean, default: true },
    claim_doc_template: { type: String, default: null },
    claim_doc_templates: [{ type: String }],
    cash_or_product: {
      type: String,
      enum: ['cash', 'product', 'both'],
      default: 'cash',
    },
    public_url: { type: String, default: null },
    internal_notes: { type: String, default: null },
    active: { type: Boolean, default: true },
    last_refreshed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

offerRecordSchema.index({ active: 1 });

module.exports = deliveryConn.model('OfferRecord', offerRecordSchema);
