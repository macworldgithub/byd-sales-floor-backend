/**
 * Appointment.js – Lead Centre Appointment model
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const appointmentSchema = new mongoose.Schema(
  {
    when: { type: String, required: true },
    prospectName: { type: String, required: true },
    phone: { type: String, default: '0491 570 204' },
    type: {
      type: String,
      enum: ['Test Drive', 'Callback', 'Showroom Visit'],
      default: 'Test Drive',
    },
    vehicle: { type: String, default: '' },
    dealership: { type: String, default: '' },
    bookedBy: { type: String, enum: ['AI', 'Agent', 'Manual'], default: 'AI' },
    status: {
      type: String,
      enum: ['Proposed', 'Confirmed', 'Completed', 'Cancelled', 'No Show'],
      default: 'Confirmed',
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: false,
    },
    consultantName: { type: String, default: '' },
    notes: { type: String, default: '' },
    // Duration in minutes
    durationMinutes: { type: Number, default: 45 },
    // Location (e.g. showroom bay, test drive loop)
    location: { type: String, default: '' },
  },
  { timestamps: true }
);

appointmentSchema.index({ when: 1 });
appointmentSchema.index({ leadId: 1 });
appointmentSchema.index({ status: 1 });
appointmentSchema.index({ consultantName: 1 });

module.exports = leadConn.model('Appointment', appointmentSchema);
