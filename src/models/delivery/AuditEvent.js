/**
 * AuditEvent.js – Delivery Centre Audit Event model
 */
const mongoose = require('mongoose');
const { deliveryConn } = require('../../db');

const auditEventSchema = new mongoose.Schema(
  {
    actor_id: { type: String, default: null },
    actor_email: { type: String, default: null },
    action: { type: String, required: true },
    entity: { type: String, default: null },
    entity_id: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

auditEventSchema.index({ actor_id: 1 });
auditEventSchema.index({ entity: 1, entity_id: 1 });
auditEventSchema.index({ createdAt: -1 });

module.exports = deliveryConn.model('AuditEvent', auditEventSchema);
