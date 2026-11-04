// Snapshot import validation only; keep legacy defaults stable for repeatable upserts.
const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema(
  {
    // ── Core CRM fields ────────────────────────────────────────────────────
    name: { type: String, required: true },
    vehicle: { type: String, default: "" },
    dealer: { type: String, default: "" },
    score: { type: Number, default: 0, min: 0, max: 100 },
    tag: {
      type: String,
      enum: ["Contact", "Commitment", "Human assisted", "AI active", "Opted Out"],
      default: "Contact",
    },
    color: { type: String, enum: ["blue", "green", "amber", "red"], default: "blue" },
    stage: {
      type: String,
      enum: ["NEW ENQUIRIES", "IN FOLLOW-UP", "AI QUALIFYING", "TEST DRIVE BOOKED", "DELIVERED", "LOST", "OPTED OUT"],
      default: "NEW ENQUIRIES",
    },
    status: {
      type: String,
      enum: ["new", "committed", "qualification", "sold", "lost", "opted out"],
      default: "new",
    },
    source: { type: String, default: "SMS Connect" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    stockNum: { type: String, default: "" },
    control: { type: String, default: "Human" },
    receivedDaysAgo: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    enquiryDesc: { type: String, default: "" },
    enquiryNote: { type: String, default: "" },
    price: { type: String, default: "" },
    paintColor: { type: String, default: "" },

    // ── Platform field ─────────────────────────────────────────────────────
    platform: {
      type: String,
      enum: ["manual", "autogate", "sms", "virtualyard", "dealer_studio"],
      default: "manual",
    },

    // ── Virtualyard specific fields ─────────────────────────────────────────
    leadId: { type: String, default: null, index: true },
    virtualyardId: { type: String, default: null, index: true },
    customerId: { type: String, default: null },
    vyStage: { type: String, default: "" },
    vyStageText: { type: String, default: "" },
    vyTab: { type: String, default: "" },
    vyStatus: { type: String, default: "" },
    stageText: { type: String, default: "" },
    tab: { type: String, default: "" },
    previewText: { type: String, default: "" },
    assignedTo: { type: String, default: "" },
    lastContact: { type: String, default: "" },
    leadDate: { type: Date, default: null },
    testDrive: {
      testDriveDate: { type: Date, default: null },
      location: { type: String, default: "" },
      status: { type: String, default: "" },
      confirmed: { type: Boolean, default: false },
    },

    // ── Autogate / Nextgate specific fields ────────────────────────────────
    autogateId: { type: String, default: null },          // customer UUID from Autogate
    autogateLeadId: { type: String, default: null },      // lead UUID from Autogate
    leadIdShort: { type: String, default: null },         // short display ID e.g. "936fddec"
    homePhone: { type: String, default: "" },
    customerType: { type: String, default: "Individual" },// "Individual" | "Business"
    dealerName: { type: String, default: "" },            // full dealer display name
    priority: { type: String, default: "Not Set" },
    leadType: { type: String, default: "" },              // "GENERAL" etc.
    leadSource: { type: String, default: "" },            // "Call connect", "Carsales" etc.
    opportunity: { type: String, default: "" },           // "Buy", "Sell" etc.
    specificationId: { type: String, default: null },     // vehicle spec UUID
    multipleVehicleEnquiries: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    leadStage: { type: String, default: "" },             // Autogate's own stage label
    tags: [
      {
        label: { type: String },
        friendlyLabel: { type: String },
      },
    ],
    leadStats: {
      emailCount: { type: Number, default: 0 },
      smsCount: { type: Number, default: 0 },
      phoneCallCount: { type: Number, default: 0 },
      appointmentCount: { type: Number, default: 0 },
    },
    leadCreatedDate: { type: Date, default: null },
    allocatedPersonFullName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VirtualyardImportLead", leadSchema);
