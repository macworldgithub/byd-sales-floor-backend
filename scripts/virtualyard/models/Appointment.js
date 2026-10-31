// Snapshot import validation only; keep legacy defaults stable for repeatable upserts.
const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    appointmentId: { type: String, default: null, index: true },
    leadId: { type: String, default: null, index: true },
    when: { type: String, required: true },
    prospectName: { type: String, required: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    type: { type: String, enum: ["Test Drive", "Callback", "Showroom Visit"], default: "Test Drive" },
    vehicle: { type: String, default: "" },
    dealership: { type: String, default: "" },
    location: { type: String, default: "" },
    bookedBy: { type: String, enum: ["AI", "Agent", "Manual"], default: "AI" },
    status: {
      type: String,
      default: "Confirmed",
    },
    testDriveDate: { type: Date, default: null },
    scrapedAt: { type: Date, default: null },
    platform: { type: String, default: "manual" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VirtualyardImportAppointment", appointmentSchema);
