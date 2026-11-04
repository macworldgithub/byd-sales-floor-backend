/**
 * appraisals.js – I-Appraise Vehicle Inspection API Routes
 * Endpoints for vehicle walk-around inspections, PPSR check attachments,
 * condition ratings, and digital loan-car agreements.
 */
const express = require('express');
const Appraisal = require('../models/lead/Appraisal');
const Lead = require('../models/lead/Lead');
const { authenticate, enforceSiteLock } = require('../middleware/auth');
const crmService = require('../services/crmService');

const router = express.Router();
router.use(authenticate);
router.use(enforceSiteLock);

// ─── GET /api/appraisals ────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { leadId, customerId, rego, status, site, limit = 50, page = 1 } = req.query;
    const filter = {};

    if (leadId) filter.leadId = leadId;
    if (customerId) filter.customerId = customerId;
    if (rego) filter.rego = rego.trim().toUpperCase();
    if (status) filter.status = status;
    if (site || req.user?.locked_site) filter.site = req.user?.locked_site || site;

    const skip = (Number(page) - 1) * Number(limit);
    const [appraisals, total] = await Promise.all([
      Appraisal.find(filter).sort('-createdAt').skip(skip).limit(Number(limit)).lean(),
      Appraisal.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: appraisals,
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

// ─── GET /api/appraisals/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const appraisal = await Appraisal.findOne({
      $or: [{ appraisalId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }],
    }).lean();

    if (!appraisal) {
      return res.status(404).json({ success: false, message: 'Appraisal record not found' });
    }

    return res.json({ success: true, data: appraisal });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/appraisals ───────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const body = req.body;
    const appraisalId = body.appraisalId || `APP-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

    const newAppraisal = new Appraisal({
      ...body,
      appraisalId,
      site: req.user?.locked_site || body.site || 'Nunawading',
      consultantName: req.user?.name || body.consultantName || 'Sales Consultant',
      consultantId: req.user?._id || body.consultantId,
    });

    await newAppraisal.save();

    // If associated with a Lead, update the Lead with appraisal details
    if (body.leadId) {
      await Lead.findOneAndUpdate(
        { $or: [{ _id: body.leadId.match(/^[0-9a-fA-F]{24}$/) ? body.leadId : null }, { virtualyardId: body.leadId }] },
        {
          $set: {
            'tradeIn.hasTradeIn': true,
            'tradeIn.rego': newAppraisal.rego,
            'tradeIn.vin': newAppraisal.vin,
            'tradeIn.makeModel': `${newAppraisal.year} ${newAppraisal.make} ${newAppraisal.model}`,
            'tradeIn.valuation': newAppraisal.valuation?.tradeInAllowance || 0,
            'tradeIn.status': 'Valued',
          },
        }
      ).catch(() => null);
    }

    // Add event to customer CRM timeline if customerId or leadId is linked
    const customerTargetId = body.customerId || body.leadId;
    if (customerTargetId) {
      try {
        await crmService.logEvent({
          customer_id: customerTargetId,
          type: 'Appraisal Created',
          headline: `I-Appraise Completed: ${newAppraisal.year} ${newAppraisal.make} ${newAppraisal.model} (${newAppraisal.rego})`,
          body: `Trade allowance: $${newAppraisal.valuation?.tradeInAllowance?.toLocaleString() || 0}. PPSR status: ${newAppraisal.ppsrStatus}. Condition exterior: ${newAppraisal.condition?.exteriorRating}/5.`,
          user_id: req.user?._id || 'system',
          author_name: req.user?.name || 'Sales Consultant',
          site: newAppraisal.site,
        });
      } catch (timelineErr) {
        // Log timeline non-fatal
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Vehicle appraisal saved successfully.',
      data: newAppraisal,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/appraisals/:id ──────────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const updated = await Appraisal.findOneAndUpdate(
      { $or: [{ appraisalId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }] },
      { $set: req.body },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    return res.json({ success: true, message: 'Appraisal updated', data: updated });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/appraisals/:id/sign-loancar ──────────────────────────────────
router.post('/:id/sign-loancar', async (req, res, next) => {
  try {
    const { signatureName, loanCarRego, loanCarModel, notes } = req.body;
    if (!signatureName) {
      return res.status(400).json({ success: false, message: 'Digital signature name is required.' });
    }

    const updated = await Appraisal.findOneAndUpdate(
      { $or: [{ appraisalId: req.params.id }, { _id: req.params.id.match(/^[0-9a-fA-F]{24}$/) ? req.params.id : null }] },
      {
        $set: {
          'loanCar.isRequired': true,
          'loanCar.isSigned': true,
          'loanCar.signedBy': signatureName,
          'loanCar.signedAt': new Date(),
          'loanCar.loanCarRego': loanCarRego || 'LOAN-BYD1',
          'loanCar.loanCarModel': loanCarModel || 'BYD Atto 3 Extended',
          'loanCar.notes': notes || 'Loan car agreement digitally executed on sales floor.',
        },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Appraisal not found' });
    }

    return res.json({
      success: true,
      message: `Loan car agreement signed for ${updated.loanCar.loanCarModel} (${updated.loanCar.loanCarRego}) by ${signatureName}`,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
