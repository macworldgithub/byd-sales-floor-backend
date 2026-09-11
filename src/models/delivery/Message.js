/**
 * Message.js – Delivery Centre SMS Message model
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const messageSchema = new mongoose.Schema(
  {
    client_id: { type: String, default: null },
    client_name: { type: String, default: null },
    phone: { type: String, required: true },
    body: { type: String, required: true },
    direction: {
      type: String,
      enum: ['outbound', 'inbound'],
      default: 'outbound',
    },
    status: { type: String, default: 'queued' },
    provider: { type: String, default: 'mobilemessage' },
    provider_message_id: { type: String, default: null },
    provider_response: { type: mongoose.Schema.Types.Mixed, default: null },
    sent_by_id: { type: String, default: null },
    sent_by_name: { type: String, default: null },
    sent_at: { type: Date, default: Date.now },
    template_id: { type: String, default: null },
  },
  { timestamps: true }
);

messageSchema.index({ client_id: 1 });
messageSchema.index({ phone: 1 });
messageSchema.index({ sent_at: -1 });

module.exports = deliveryConn.model('Message', messageSchema);
