/**
 * Inventory.js – Lead Centre Inventory model
 */
const mongoose = require('mongoose');
const { leadConn } = require('../../db');

const inventorySchema = new mongoose.Schema(
  {
    // ── Legacy / manual CRM fields ───────────────────────────────────────
    stock: { type: String, default: '' },
    model: { type: String, default: '' },
    paint: { type: String, default: '' },
    location: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Available', 'In Transit', 'Sold', 'Unavailable', 'InStock'],
      default: 'Available',
    },
    price: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now },

    // ── Platform field ──────────────────────────────────────────────────
    platform: {
      type: String,
      enum: ['manual', 'autogate', 'virtualyard'],
      default: 'manual',
    },

    // ── Autogate / Nextgate rich inventory fields ───────────────────────
    identifier: { type: String, default: null },
    networkId: { type: String, default: '' },
    legacyId: { type: String, default: '' },
    itemType: { type: String, default: 'CAR' },
    condition: { type: String, enum: ['Demo', 'Used', 'New', ''], default: '' },
    itemStatus: { type: String, default: '' },
    title: { type: String, default: null },
    firstPhotoUrl: { type: String, default: null },

    priceData: {
      ui: { type: Number, default: null },
      currency: { type: String, default: 'AUD' },
      label: { type: String, default: '' },
    },

    odometer: {
      value: { type: Number, default: 0 },
      unit: { type: String, default: 'Kilometres' },
    },

    registration: {
      rego: { type: String, default: null },
      vin: { type: String, default: null },
      hin: { type: String, default: null },
    },

    specifications: {
      make: { type: String, default: null },
      model: { type: String, default: null },
      badge: { type: String, default: null },
      series: { type: String, default: null },
      year: { type: Number, default: null },
      colour: { type: String, default: null },
      manufacturerColour: { type: String, default: null },
    },

    listingStats: {
      enquiryCount: { type: Number, default: 0 },
      watchers: { type: Number, default: 0 },
      retailSearchCount: { type: Number, default: 0 },
      retailViewCount: { type: Number, default: 0 },
      photoCount: { type: Number, default: 0 },
      healthScore: { type: Number, default: 0 },
    },

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

    onCarsalesNetwork: { type: Boolean, default: null },
    sellerIdentifier: { type: String, default: null },
  },
  { timestamps: true }
);

inventorySchema.index({ identifier: 1 }, { sparse: true });
inventorySchema.index({ stock: 1 }, { sparse: true });
inventorySchema.index({ status: 1 });
inventorySchema.index({ 'specifications.model': 1 });

module.exports = leadConn.model('Inventory', inventorySchema);
