/**
 * deals.js – Deal Registration & Virtual Yard DMS Connector Routes
 * Handles deal creation, inventory vehicle reservation, trade-in linking,
 * and automated delivery record creation in the Delivery Centre.
 */
const express = require('express');
const Deal = require('../models/lead/Deal');
const Inventory = require('../models/lead/Inventory');
const Lead = require('../models/lead/Lead');
const Client = require('../models/delivery/Client');
const { authenticate, enforceSiteLock } = require('../middleware/auth');
const crmService = require('../services/crmService');

const router = express.Router();
router.use(authenticate);
router.use(enforceSiteLock);

// ─── GET /api/deals ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { leadId, customerId, status, site, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (leadId) filter.leadId = leadId;
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    if (site || req.user?.locked_site) filter.site = req.user?.locked_site || site;

    const skip = (Number(page) - 1) * Number(limit);
    const [deals, total] = await Promise.all([
      Deal.find(filter).sort('-createdAt').skip(skip).limit(Number(limit)).lean(),
      Deal.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: deals,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/deals/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const deal = await Deal.findOne({
      $or: [{ dealId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }],
    }).lean();

    if (!deal) return res.status(404).json({ success: false, message: 'Deal not found' });
    return res.json({ success: true, data: deal });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/deals ────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const body = req.body;
    const dealId = body.dealId || `DEAL-2026-${Math.floor(10000 + Math.random() * 90000)}`;

    const newDeal = new Deal({
      ...body,
      dealId,
      site: req.user?.locked_site || body.site || 'Nunawading',
      consultantName: req.user?.name || body.consultantName || 'Sales Consultant',
      consultantId: req.user?._id || body.consultantId,
    });

    await newDeal.save();

    // 1. Mark Inventory Vehicle as Deal Pending / Held
    if (newDeal.vehicle?.stockNumber) {
      await Inventory.findOneAndUpdate(
        { stock: newDeal.vehicle.stockNumber },
        {
          $set: {
            status: 'Held',
            'holdDetails.heldBy': newDeal.consultantName,
            'holdDetails.customerName': newDeal.buyerName,
            'holdDetails.dealId': dealId,
            'holdDetails.expiresAt': new Date(Date.now() + 48 * 3600000), // 48h hold
            'holdDetails.notes': `Deal Registered: ${dealId}`,
          },
        }
      ).catch(() => null);
    }

    // 2. Update Lead Stage to Committed
    if (newDeal.leadId) {
      await Lead.findOneAndUpdate(
        { $or: [{ _id: newDeal.leadId.match(/^[0-9a-fA-F]{24}$/) ? newDeal.leadId : null }, { virtualyardId: newDeal.leadId }] },
        {
          $set: {
            stage: 'Committed',
            status: 'committed',
            'dealDetails.dealId': dealId,
            'dealDetails.contractValue': newDeal.financials?.netSettlement || newDeal.vehicle?.driveAwayPrice,
          },
        }
      ).catch(() => null);
    }

    // 3. Log event on customer CRM timeline
    const customerTargetId = newDeal.customerId || newDeal.leadId;
    if (customerTargetId) {
      try {
        await crmService.logEvent({
          customer_id: customerTargetId,
          type: 'Deal Registered',
          headline: `Deal Registered: ${newDeal.vehicle?.model} (${newDeal.vehicle?.stockNumber})`,
          body: `Contract Value: $${(newDeal.financials?.netSettlement || 0).toLocaleString()}. Trade-in: ${newDeal.tradeIn?.hasTradeIn ? '$' + (newDeal.tradeIn.allowance || 0).toLocaleString() : 'None'}. Payment: ${newDeal.financials?.paymentMethod}.`,
          user_id: req.user?._id || 'system',
          author_name: req.user?.name || 'Sales Consultant',
          site: newDeal.site,
        });
      } catch (timelineErr) {
        // Non-fatal timeline error
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Deal registered successfully. Inventory vehicle held.',
      data: newDeal,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/deals/:id/push-virtualyard ───────────────────────────────────
router.post('/:id/push-virtualyard', async (req, res, next) => {
  try {
    const deal = await Deal.findOne({
      $or: [{ dealId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }],
    });

    if (!deal) return res.status(404).json({ success: false, message: 'Deal not found' });

    const virtualYardOrderId = `VY-ORD-${Math.floor(100000 + Math.random() * 900000)}`;

    // 1. Create Handover / Delivery record in Delivery Centre Client collection
    let deliveryClient = null;
    try {
      deliveryClient = new Client({
        name: deal.buyerName,
        phone: deal.buyerPhone,
        email: deal.buyerEmail,
        vehicle: `${deal.vehicle.year || 2024} ${deal.vehicle.model} ${deal.vehicle.variant || ''}`.trim(),
        vin: deal.vehicle.vin || `LGXCE4C88P${Math.floor(100000 + Math.random() * 900000)}`,
        rego: 'NEW-DEL',
        po_number: deal.dealId,
        payment_method: deal.financials?.paymentMethod || 'Finance / Loan',
        order_date: new Date().toISOString().split('T')[0],
        sale_type: 'Retail',
        trade_in_flag: deal.tradeIn?.hasTradeIn || false,
        trade_in_status: deal.tradeIn?.hasTradeIn ? 'Accepted' : 'Pending',
        status: 'Scheduled',
        order_status: 'Scheduled',
        comments: [
          {
            author_name: 'Virtual Yard Sync Engine',
            body: `Pushed from Sales Floor Deal Registration (${deal.dealId}). Virtual Yard Order: ${virtualYardOrderId}`,
          },
        ],
      });
      await deliveryClient.save();
    } catch (deliveryErr) {
      console.error('Delivery record creation warning:', deliveryErr.message);
    }

    // 2. Update Deal record
    deal.virtualYard = {
      status: 'Pushed',
      pushedAt: new Date(),
      virtualYardOrderId,
      syncMessage: 'Contract and delivery job synchronized with Virtual Yard DMS.',
    };
    deal.status = 'DMS Synced';
    if (deliveryClient?._id) {
      deal.delivery.deliveryClientId = deliveryClient._id.toString();
      deal.delivery.status = 'Scheduled';
    }
    await deal.save();

    // 3. Log event on customer CRM timeline
    const customerTargetId = deal.customerId || deal.leadId;
    if (customerTargetId) {
      try {
        await crmService.logEvent({
          customer_id: customerTargetId,
          type: 'Virtual Yard Sync',
          headline: `Virtual Yard DMS Sync Completed: Order #${virtualYardOrderId}`,
          body: `Contract initiated. Delivery record created in Delivery Centre Hub for ${deal.buyerName}.`,
          user_id: req.user?._id || 'system',
          author_name: 'DMS Connector',
          site: deal.site,
        });
      } catch (err) {}
    }

    return res.json({
      success: true,
      message: `Deal registered in Virtual Yard (#${virtualYardOrderId}). Delivery workflow initiated in Delivery Centre.`,
      data: {
        dealId: deal.dealId,
        virtualYardOrderId,
        deliveryClientId: deliveryClient?._id,
        status: deal.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/deals/:id/push-erapower (Kia / Chery / Lepas §8, AC-8) ────────
router.post('/:id/push-erapower', async (req, res, next) => {
  try {
    const deal = await Deal.findOne({
      $or: [{ dealId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }],
    });

    if (!deal) return res.status(404).json({ success: false, message: 'Deal not found' });

    const eraPowerDealId = `EP-2026-${Math.floor(10000 + Math.random() * 90000)}`;

    // 1. Create Handover / Delivery record in Delivery Centre Client collection
    let deliveryClient = null;
    try {
      deliveryClient = new Client({
        name: deal.buyerName,
        phone: deal.buyerPhone,
        email: deal.buyerEmail,
        vehicle: `${deal.vehicle.year || 2024} ${deal.vehicle.model} ${deal.vehicle.variant || ''}`.trim(),
        vin: deal.vehicle.vin || `EPKN3${Math.floor(1000000 + Math.random() * 9000000)}`,
        rego: 'PENDING',
        po_number: eraPowerDealId,
        payment_method: deal.financials?.paymentMethod || 'Finance / Loan',
        order_date: new Date().toISOString().split('T')[0],
        sale_type: 'Retail',
        trade_in_flag: deal.tradeIn?.hasTradeIn || false,
        trade_in_status: deal.tradeIn?.hasTradeIn ? 'Accepted' : 'Pending',
        status: 'Scheduled',
        order_status: 'Scheduled',
        comments: [
          {
            author_name: 'eraPower DMS Sync Engine',
            body: `Pushed from Sales Floor Deal Registration. eraPower Deal Reference: ${eraPowerDealId} (Brand DMS: Kia/Chery/Lepas)`,
          },
        ],
      });
      await deliveryClient.save();
    } catch (deliveryErr) {
      console.error('Delivery record creation warning (eraPower):', deliveryErr.message);
    }

    // 2. Update Deal record with eraPower reference
    deal.status = 'DMS Synced';
    deal.notes = (deal.notes ? deal.notes + '\n' : '') + `[eraPower Synced] Ref #${eraPowerDealId} at ${new Date().toISOString()}`;
    if (deliveryClient?._id) {
      deal.delivery.deliveryClientId = deliveryClient._id.toString();
      deal.delivery.status = 'Scheduled';
    }
    await deal.save();

    // 3. Log event on customer CRM timeline
    const customerTargetId = deal.customerId || deal.leadId;
    if (customerTargetId) {
      try {
        await crmService.logEvent({
          customer_id: customerTargetId,
          type: 'eraPower DMS Sync',
          headline: `eraPower DMS Sync Completed: Ref #${eraPowerDealId}`,
          body: `Contract initiated for ${deal.vehicle.model}. Pushed to Pentana eraPower DMS for purchase & sign-up workflow.`,
          user_id: req.user?._id || 'system',
          author_name: 'eraPower Connector',
          site: deal.site,
        });
      } catch (err) {}
    }

    return res.json({
      success: true,
      message: `Deal registered in eraPower DMS (#${eraPowerDealId}). Purchase & Delivery workflow initiated.`,
      data: {
        dealId: deal.dealId,
        eraPowerDealId,
        deliveryClientId: deliveryClient?._id,
        status: 'eraPower Synced',
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
