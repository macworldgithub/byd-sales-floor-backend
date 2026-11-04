/**
 * inventory.js – Lead Centre Inventory routes (High-performance, cached, indexed)
 *
 * GET /api/inventory/filters list distinct filter options
 * GET /api/inventory/stats   get aggregated inventory stats
 * GET /api/inventory        list inventory with filters (lean, paginated)
 * GET /api/inventory/:id    single inventory item
 * POST /api/inventory/:id/soft-hold
 * POST /api/inventory/:id/release-hold
 */
const express = require('express');
const Inventory = require('../models/lead/Inventory');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── In-Memory Cache for Stats and Filters (High Performance) ─────────────────
let cachedFilters = null;
let cachedFiltersExpires = 0;
let cachedStats = null;
let cachedStatsExpires = 0;

function invalidateCache() {
  cachedFilters = null;
  cachedFiltersExpires = 0;
  cachedStats = null;
  cachedStatsExpires = 0;
}

function escapeRegex(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLocationQuery(locVal) {
  if (!locVal || ['all', 'all locations', 'all yards', 'all sites'].includes(String(locVal).toLowerCase().trim())) {
    return null;
  }
  const cleanVal = String(locVal).replace(/^BYD\s+/i, '').replace(/^DENZA\s+/i, '').trim();
  const escaped = escapeRegex(cleanVal);
  const rawEscaped = escapeRegex(String(locVal).trim());

  const regexes = [
    new RegExp(escaped, 'i'),
    new RegExp(rawEscaped, 'i'),
  ];
  if (/caroline/i.test(cleanVal)) {
    regexes.push(/caroline/i);
    regexes.push(/\bcs\b/i);
  }
  if (/melbourne/i.test(cleanVal)) {
    regexes.push(/melbourne/i);
    regexes.push(/\bcbd\b/i);
  }
  if (/fairfield/i.test(cleanVal)) {
    regexes.push(/fairfield/i);
    regexes.push(/\bffd\b/i);
  }
  if (/nunawading/i.test(cleanVal)) {
    regexes.push(/nunawading/i);
    regexes.push(/\bnwd\b/i);
  }
  if (/wodonga/i.test(cleanVal)) {
    regexes.push(/wodonga/i);
    regexes.push(/\bwdg\b/i);
  }
  if (/doncaster/i.test(cleanVal)) {
    regexes.push(/doncaster/i);
    regexes.push(/\bdc\b/i);
  }
  if (/holding/i.test(cleanVal)) {
    regexes.push(/holding/i);
    regexes.push(/derrimut/i);
  }

  const orClauses = [];
  for (const reg of regexes) {
    orClauses.push({ location: reg });
    orClauses.push({ orderYard: reg });
    orClauses.push({ 'shirleyData.outBoundStore': reg });
  }
  return { $or: orClauses };
}

function buildStatusQuery(statusVal) {
  if (!statusVal || ['all', 'all statuses', 'all status'].includes(String(statusVal).toLowerCase().trim())) {
    return null;
  }
  const s = String(statusVal).trim().toLowerCase();
  if (s === 'available' || s === 'in stock' || s === 'instock') {
    return {
      $or: [
        { status: { $regex: /^in\s*stock$/i } },
        { status: /^available$/i },
        { itemStatus: /^instock$/i },
      ]
    };
  }
  if (s === 'delivered') {
    return { status: { $regex: /^deliver/i } };
  }
  if (s === 'sold') {
    return { status: { $regex: /^sold$/i } };
  }
  if (s === 'in transit') {
    return {
      $or: [
        { status: { $regex: /^in\s*transit$/i } },
        { itemStatus: { $regex: /^in\s*transit$/i } },
      ]
    };
  }
  if (s === 'demo') {
    return {
      $or: [
        { status: { $regex: /^demo$/i } },
        { condition: /^demo$/i },
      ]
    };
  }
  if (s === 'display') {
    return { status: { $regex: /^display$/i } };
  }
  if (s === 'damage' || s === 'damaged') {
    return { status: { $regex: /^damage/i } };
  }
  if (s === 'on hold' || s === 'on-hold' || s === 'held') {
    return { status: { $regex: /^on[- ]?hold$|^held$/i } };
  }
  if (s === 'allocated') {
    return { status: { $regex: /^allocated$/i } };
  }
  return { status: { $regex: new RegExp(`^${escapeRegex(statusVal)}$`, 'i') } };
}

// ── Fast Cached Summary Stats ────────────────────────────────────────────────
async function getSummaryStats() {
  const now = Date.now();
  if (cachedStats && now < cachedStatsExpires) {
    return cachedStats;
  }
  try {
    const [raw] = await Inventory.collection.aggregate([
      {
        $facet: {
          total: [{ $count: 'count' }],
          inStock: [{ $match: { status: { $in: ['In Stock', 'Available', 'InStock'] } } }, { $count: 'count' }],
          delivered: [{ $match: { status: { $regex: /^deliver/i } } }, { $count: 'count' }],
          inTransit: [{ $match: { status: { $regex: /^in\s*transit/i } } }, { $count: 'count' }],
          demo: [{ $match: { $or: [{ status: /^demo$/i }, { condition: /^demo$/i }] } }, { $count: 'count' }],
          shirley: [{ $match: { platform: 'shirley' } }, { $count: 'count' }],
          virtualyard: [{ $match: { platform: 'virtualyard' } }, { $count: 'count' }],
          autogate: [{ $match: { platform: 'autogate' } }, { $count: 'count' }],
        },
      },
    ]).toArray();

    cachedStats = {
      total: raw.total[0]?.count || 0,
      inStock: raw.inStock[0]?.count || 0,
      delivered: raw.delivered[0]?.count || 0,
      inTransit: raw.inTransit[0]?.count || 0,
      demo: raw.demo[0]?.count || 0,
      shirley: raw.shirley[0]?.count || 0,
      virtualyard: raw.virtualyard[0]?.count || 0,
      autogate: raw.autogate[0]?.count || 0,
    };
    cachedStatsExpires = now + 60 * 1000;
    return cachedStats;
  } catch (err) {
    return {
      total: 0,
      inStock: 0,
      delivered: 0,
      inTransit: 0,
      demo: 0,
      shirley: 0,
      virtualyard: 0,
      autogate: 0,
    };
  }
}

// ─── GET /api/inventory/filters ─────────────────────────────────────────────
router.get('/filters', async (req, res, next) => {
  try {
    const now = Date.now();
    if (cachedFilters && now < cachedFiltersExpires) {
      return res.json({ success: true, data: cachedFilters });
    }

    const [locations, orderYards, models] = await Promise.all([
      Inventory.distinct('location'),
      Inventory.distinct('orderYard'),
      Inventory.distinct('specifications.model'),
    ]);

    const cleanLocs = Array.from(new Set([...locations, ...orderYards]))
      .filter((l) => l && l !== '#N/A' && l !== '_' && l.length > 1)
      .sort();

    const cleanModels = Array.from(new Set(models))
      .filter((m) => m && m.length > 1)
      .sort();

    const statuses = [
      'In Stock',
      'Delivered',
      'Sold',
      'In Transit',
      'Demo',
      'Display',
      'On Hold',
      'Damage',
      'Allocated',
    ];

    cachedFilters = {
      locations: cleanLocs,
      statuses,
      models: cleanModels,
      platforms: ['shirley', 'virtualyard', 'autogate', 'dealer_studio', 'manual'],
    };
    cachedFiltersExpires = now + 5 * 60 * 1000;
    res.json({ success: true, data: cachedFilters });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/inventory/stats ───────────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await getSummaryStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/inventory ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 25,
      status,
      model,
      condition,
      platform,
      location,
      yard,
      dealer,
      site,
      q,
      sort = '-updatedAt',
    } = req.query;

    const andClauses = [];

    // Model filter
    if (model && model !== 'all' && model !== 'All Models' && model !== 'All') {
      const safeModel = escapeRegex(model);
      andClauses.push({
        $or: [
          { model: { $regex: safeModel, $options: 'i' } },
          { 'specifications.model': { $regex: safeModel, $options: 'i' } },
          { title: { $regex: safeModel, $options: 'i' } },
        ],
      });
    }

    // Status filter
    const statusQuery = buildStatusQuery(status);
    if (statusQuery) {
      andClauses.push(statusQuery);
    }

    // Yard / Location filter
    const locVal = location || yard || dealer || site;
    const locQuery = buildLocationQuery(locVal);
    if (locQuery) {
      andClauses.push(locQuery);
    }

    // Condition filter
    if (condition && condition !== 'all' && condition !== 'All') {
      andClauses.push({ condition });
    }

    // Platform filter
    if (platform && platform !== 'all' && platform !== 'All') {
      andClauses.push({ platform });
    }

    // Free text search
    if (q) {
      const safeQ = escapeRegex(q);
      andClauses.push({
        $or: [
          { stock: { $regex: safeQ, $options: 'i' } },
          { model: { $regex: safeQ, $options: 'i' } },
          { paint: { $regex: safeQ, $options: 'i' } },
          { location: { $regex: safeQ, $options: 'i' } },
          { orderYard: { $regex: safeQ, $options: 'i' } },
          { title: { $regex: safeQ, $options: 'i' } },
          { identifier: { $regex: safeQ, $options: 'i' } },
          { 'registration.rego': { $regex: safeQ, $options: 'i' } },
          { 'registration.vin': { $regex: safeQ, $options: 'i' } },
          { 'shirleyData.salesConsultant': { $regex: safeQ, $options: 'i' } },
          { 'shirleyData.poNumber': { $regex: safeQ, $options: 'i' } },
        ],
      });
    }

    const filter = andClauses.length > 0 ? (andClauses.length === 1 ? andClauses[0] : { $and: andClauses }) : {};

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const skip = (pageNum - 1) * pageSize;

    const [items, total, stats] = await Promise.all([
      Inventory.find(filter)
        .sort(sort === '-lastSeen' ? { updatedAt: -1 } : sort)
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Inventory.countDocuments(filter),
      getSummaryStats(),
    ]);

    const totalPages = Math.ceil(total / pageSize) || 1;

    res.setHeader('X-Total-Count', total);

    return res.json({
      success: true,
      data: items,
      total,
      page: pageNum,
      totalPages,
      limit: pageSize,
      pagination: { total, page: pageNum, limit: pageSize, pages: totalPages },
      stats,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/inventory/:id/soft-hold (§5.6, §6.1 Soft Hold) ───────────────
router.post('/:id/soft-hold', async (req, res, next) => {
  try {
    const { customerName, durationHours = 48, notes } = req.body;
    const expiresAt = new Date(Date.now() + Number(durationHours) * 3600000);

    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'Held',
          'holdDetails.heldBy': req.user?.name || req.user?.email || 'Sales Staff',
          'holdDetails.customerName': customerName || 'Valued Prospect',
          'holdDetails.expiresAt': expiresAt,
          'holdDetails.notes': notes || 'Soft hold placed from Sales Floor',
        },
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    invalidateCache();

    return res.json({
      success: true,
      message: `Soft hold placed for ${customerName || 'customer'} (expires in ${durationHours}h)`,
      data: item,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/inventory/:id/release-hold ───────────────────────────────────
router.post('/:id/release-hold', async (req, res, next) => {
  try {
    const item = await Inventory.findByIdAndUpdate(
      req.params.id,
      {
        $set: { status: 'Available' },
        $unset: { holdDetails: 1 },
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    invalidateCache();

    return res.json({ success: true, message: 'Soft hold released. Vehicle back in available stock.', data: item });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
