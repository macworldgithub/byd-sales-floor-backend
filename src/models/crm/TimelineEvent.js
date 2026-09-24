/**
 * TimelineEvent.js – Append-only unified customer activity stream (§5.2, §6.1)
 * Shared event bus projected across Sales CRM, Lead Centre, and Delivery Centre.
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const timelineEventSchema = new mongoose.Schema(
  {
    event_id: { type: String, required: true, unique: true, index: true },
    customer_id: { type: String, required: true, index: true },
    opportunity_id: { type: String, default: null, index: true },
    type: {
      type: String,
      enum: [
        'note',
        'sms_in',
        'sms_out',
        'call_log',
        'email',
        'stage_change',
        'assignment',
        'appointment',
        'vy_stock_event',
        'sales_log_write',
        'delivery_stage_change',
        'document',
        'system',
      ],
      required: true,
    },
    title: { type: String, required: true },
    content: { type: String, required: true },
    author: { type: String, required: true },
    author_id: { type: String, default: null },
    source: {
      type: String,
      enum: ['Sales CRM', 'Lead Centre', 'Delivery Centre', 'Virtual Yard', 'Sales Log', 'System'],
      required: true,
    },
    timestamp: { type: Date, default: Date.now, index: true },
    visibility: {
      type: String,
      enum: ['internal', 'customer_facing'],
      default: 'internal',
    },
    deep_link: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

timelineEventSchema.index({ customer_id: 1, timestamp: -1 });

module.exports = deliveryConn.model('CrmTimelineEvent', timelineEventSchema);
