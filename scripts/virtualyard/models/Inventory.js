// Snapshot import validation only; keep legacy defaults stable for repeatable upserts.
const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    // ── Legacy / manual CRM fields (kept for backwards compatibility) ───────
    stock: { type: String, default: "" },
    model: { type: String, default: "" },
    paint: { type: String, default: "" },
    location: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Available", "In Transit", "Sold", "Unavailable", "InStock"],
      default: "Available",
    },
    price: { type: String, default: "" },
    lastSeen: { type: Date, default: Date.now },

    // ── Platform field ──────────────────────────────────────────────────────
    platform: {
      type: String,
      enum: ["manual", "autogate", "virtualyard", "dealer_studio"],
      default: "manual",
    },

    // ── Autogate / Nextgate rich inventory fields ───────────────────────────
    identifier: { type: String, default: null },          // Autogate item UUID
    networkId: { type: String, default: "" },             // e.g. "OAG-AD-25973500"
    legacyId: { type: String, default: "" },              // numeric legacy ID
    itemType: { type: String, default: "CAR" },
    condition: {
      type: String,
      enum: ["Demo", "Used", "New", ""],
      default: "",
    },
    itemStatus: { type: String, default: "" },            // "InStock", "Sold" etc.
    title: { type: String, default: null },               // full vehicle title string
    firstPhotoUrl: { type: String, default: null },

    // Price object from Autogate
    priceData: {
      ui: { type: Number, default: null },
      currency: { type: String, default: "AUD" },
      label: { type: String, default: "" },               // "DAP" or "EGC"
    },

    // Odometer
    odometer: {
      value: { type: Number, default: 0 },
      unit: { type: String, default: "Kilometres" },
    },

    // Registration
    registration: {
      rego: { type: String, default: null },
      vin: { type: String, default: null },
      hin: { type: String, default: null },
    },

    // Specifications
    specifications: {
      make: { type: String, default: null },
      model: { type: String, default: null },
      badge: { type: String, default: null },
      series: { type: String, default: null },
      year: { type: Number, default: null },
      colour: { type: String, default: null },
      manufacturerColour: { type: String, default: null },
    },

    // Listing stats
    listingStats: {
      enquiryCount: { type: Number, default: 0 },
      watchers: { type: Number, default: 0 },
      retailSearchCount: { type: Number, default: 0 },
      retailViewCount: { type: Number, default: 0 },
      photoCount: { type: Number, default: 0 },
      healthScore: { type: Number, default: 0 },
    },

    // Live market stats
    lmStats: {
      averageDaysOnMarket: { type: Number, default: 0 },
      averageOdometer: { type: Number, default: 0 },
      marketPercentage: { type: Number, default: 0 },
      averageDriveAwayPrice: { type: Number, default: 0 },
      averageWatchers: { type: Number, default: 0 },
      daysOnMarket: { type: Number, default: 0 },
      marketOnline: { type: Number, default: 0 },
      priceRankDap: { type: Number, default: 0 },
      lastUpdated: { type: Date, default: null },
    },

    // Publishing
    onCarsalesNetwork: { type: Boolean, default: null },
    sellerIdentifier: { type: String, default: null },
  },
  { timestamps: true }
);

// Index on identifier for fast upserts
inventorySchema.index({ identifier: 1 }, { sparse: true });
// Index on stock for legacy queries
inventorySchema.index({ stock: 1 }, { sparse: true });

module.exports = mongoose.model("VirtualyardImportInventory", inventorySchema);
