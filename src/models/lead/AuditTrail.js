/**
 * AuditTrail.js – Lead Centre Audit Trail model
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const auditTrailSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    actor: { type: String, default: 'System' },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: false },
    action: { type: String, default: '' },
    entity: { type: String, default: '' },
    entityId: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

auditTrailSchema.index({ leadId: 1 });
auditTrailSchema.index({ createdAt: -1 });

module.exports = leadConn.model('AuditTrail', auditTrailSchema);
