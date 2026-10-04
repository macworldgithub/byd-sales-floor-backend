/**
 * crm.js – Sales CRM Layer API Routes (§7.3 New API Surface)
 * Implements endpoints for Customers 360, Unified Timeline, Opportunity Pipeline,
 * 3-Way Mark Sold Orchestration, Virtual Yard Holds, and Sales Log Reconciliation.
 * Protected with JWT authentication middleware (§4, §5.10).
 */
const express = require('express');
const crmService = require('../services/crmService');
const { authenticate, requireRole, enforceSiteLock, siteMatches } = require('../middleware/auth');

const router = express.Router();

// ─── RBAC & Authentication Middleware (§4, §5.10, AC-10) ────────────────────
// All CRM routes require valid authentication token
router.use(authenticate);
// Site-locked users (e.g. a single dealership login) can only ever see their own site's data
router.use(enforceSiteLock);

// ─── 1. Customers 360 & Lookup (§5.1, AC-1) ──────────────────────────────────
router.get('/customers/export-csv', async (req, res, next) => {
  try {
    const csvData = await crmService.exportCustomersCsv(req.query, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="byd-customers-${new Date().toISOString().split('T')[0]}.csv"`);
    res.status(200).send(csvData);
  } catch (err) {
    next(err);
  }
});

// Privacy Act (APP 12/13) Data Portability Export & Anonymization (§5.10)
router.get('/customers/:id/privacy-export', async (req, res, next) => {
  try {
    const data = await crmService.getPrivacyExport(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

router.post('/customers/:id/privacy-anonymize', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const result = await crmService.anonymizeCustomerPrivacy(req.params.id, req.user, req.body.reason);
    res.json({ success: true, message: 'Customer record anonymized per Privacy Act compliance', ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

router.get('/customers', async (req, res, next) => {
  try {
    const filter = { ...req.query };
    // Pass user's network_lookup privilege if present (site-locked users never have network_lookup)
    if (req.user?.locked_site) {
      filter.network_lookup = false;
      filter.site = req.user.locked_site;
      filter.yard = req.user.locked_site;
      filter.location = req.user.locked_site;
    } else if (req.user?.network_lookup || req.user?.role === 'manager' || req.user?.role === 'super_admin' || req.user?.role === 'site_admin') {
      filter.network_lookup = req.query.network_lookup === 'true' || req.query.site === 'All Sites' || !req.query.site;
    }
    const result = await crmService.getCustomers(filter);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/customers', async (req, res, next) => {
  try {
    const customer = await crmService.createCustomer(req.body);
    res.status(201).json({ success: true, message: 'Customer created', data: customer });
  } catch (err) {
    if (err.code === 'DUPLICATE_CUSTOMER') {
      return res.status(409).json({
        success: false,
        message: err.message,
        existingCustomer: err.existingCustomer,
      });
    }
    next(err);
  }
});

router.get('/customers/:id', async (req, res, next) => {
  try {
    const customer = await crmService.getCustomerById(req.params.id);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    if (req.user?.locked_site && !siteMatches(customer.site, req.user.locked_site)) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
});

router.patch('/customers/:id', async (req, res, next) => {
  try {
    const updated = await crmService.updateCustomer(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.json({ success: true, message: 'Customer updated', data: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/merge', async (req, res, next) => {
  try {
    const { sourceId } = req.body;
    if (!sourceId) {
      return res.status(400).json({ success: false, message: 'sourceId is required' });
    }
    const target = await crmService.mergeCustomers(req.params.id, sourceId);
    res.json({ success: true, message: 'Customers merged successfully', data: target });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/unlink', async (req, res, next) => {
  try {
    const { linkType = 'all' } = req.body;
    const customer = await crmService.unlinkCustomer(req.params.id, linkType);
    res.json({ success: true, message: 'Customer link uncoupled successfully', data: customer });
  } catch (err) {
    next(err);
  }
});

// Customer 360 Documents Vault (§5.1)
router.get('/customers/:id/documents', async (req, res, next) => {
  try {
    const docs = await crmService.getCustomerDocuments(req.params.id);
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/documents', async (req, res, next) => {
  try {
    const doc = await crmService.addCustomerDocument(req.params.id, req.body, req.user);
    res.status(201).json({ success: true, message: 'Document attached successfully', data: doc });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

router.delete('/customers/:id/documents/:docId', async (req, res, next) => {
  try {
    const result = await crmService.deleteCustomerDocument(req.params.id, req.params.docId, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

// ─── 2. Unified Timeline & Note Fanout (§5.2, AC-2, AC-3) ───────────────────
router.get('/customers/:id/timeline', async (req, res, next) => {
  try {
    const result = await crmService.getTimeline(req.params.id, req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/notes', async (req, res, next) => {
  try {
    const note = await crmService.addTimelineNote(req.params.id, {
      ...req.body,
      author: req.body.author || req.user?.name || 'Alex Rivers',
    });
    res.status(201).json({ success: true, message: 'Note added to unified timeline', data: note });
  } catch (err) {
    next(err);
  }
});

router.patch('/customers/:id/notes/:noteId', async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ success: false, message: 'Content is required' });
    const author = req.body.author || req.user?.name || 'Sales Consultant';
    const updated = await crmService.editTimelineNote(req.params.noteId, content, author);
    res.json({ success: true, message: 'Timeline note updated with correction history', data: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/customers/:id/notes/:noteId', async (req, res, next) => {
  try {
    const author = req.user?.name || req.body.author || 'Sales Consultant';
    const reason = req.body.reason || 'Administrative correction';
    const result = await crmService.softDeleteTimelineEvent(req.params.noteId, author, reason);
    res.json({ success: true, message: 'Timeline event soft-deleted with audit trail', ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/emails', async (req, res, next) => {
  try {
    const email = await crmService.addTimelineEmail(req.params.id, {
      ...req.body,
      author: req.body.author || req.user?.name || 'Sales Consultant',
    });
    res.status(201).json({ success: true, message: 'Email logged to unified timeline', data: email });
  } catch (err) {
    next(err);
  }
});

// ─── 3. Opportunities & Deals Pipeline (§5.4) ───────────────────────────────
router.get('/opportunities/export-csv', async (req, res, next) => {
  try {
    const csvData = await crmService.exportOpportunitiesCsv(req.query, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="byd-opportunities-${new Date().toISOString().split('T')[0]}.csv"`);
    res.status(200).send(csvData);
  } catch (err) {
    next(err);
  }
});

router.get('/opportunities', async (req, res, next) => {
  try {
    const result = await crmService.getOpportunities(req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/opportunities', async (req, res, next) => {
  try {
    const opp = await crmService.createOpportunity(req.body);
    res.status(201).json({ success: true, message: 'Opportunity created', data: opp });
  } catch (err) {
    next(err);
  }
});

router.get('/opportunities/:id', async (req, res, next) => {
  try {
    const opp = await crmService.getOpportunityById(req.params.id);
    if (!opp) {
      return res.status(404).json({ success: false, message: 'Opportunity not found' });
    }
    res.json({ success: true, data: opp });
  } catch (err) {
    next(err);
  }
});

router.patch('/opportunities/:id', async (req, res, next) => {
  try {
    const updated = await crmService.updateOpportunity(req.params.id, {
      ...req.body,
      updated_by: req.user?.name || req.body.updated_by || 'Sales Consultant',
    });
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Opportunity not found' });
    }
    res.json({ success: true, message: 'Opportunity updated', data: updated });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
});

router.post('/opportunities/:id/request-delivery-date', async (req, res, next) => {
  try {
    const { requestedDate, reason } = req.body;
    if (!requestedDate) {
      return res.status(400).json({ success: false, message: 'requestedDate is required' });
    }
    const result = await crmService.requestDeliveryDateChange(req.params.id, requestedDate, reason, req.user);
    res.json({ success: true, message: 'Delivery date change request submitted', data: result });
  } catch (err) {
    next(err);
  }
});

// ─── 4. Single Orchestrated Mark Sold Transaction (§7.5, AC-7) ──────────────
router.post('/opportunities/:id/mark-sold', async (req, res, next) => {
  try {
    const payload = {
      ...req.body,
      primary_salesperson: req.body.primary_salesperson || req.user?.name || 'Alex Rivers',
    };
    const result = await crmService.markSold(req.params.id, payload);
    res.status(200).json({
      success: true,
      message: result.deliverySyncSuccess
        ? 'Deal sold: VY order confirmed, Sales Log created, Delivery client upserted'
        : 'Deal sold: VY order confirmed, Sales Log created, Delivery client sync pending',
      ...result,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ─── 5. Lead Intake Allocations & SLA (§5.3, §7.3, AC-4) ────────────────────
router.get('/allocations', async (req, res, next) => {
  try {
    const result = await crmService.getAllocations(req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/crm/allocations – Direct BDC push intake path (§7.3)
router.post('/allocations', async (req, res, next) => {
  try {
    const alloc = await crmService.createAllocation(req.body);
    res.status(201).json({ success: true, message: 'Lead intake allocation created', data: alloc });
  } catch (err) {
    next(err);
  }
});

// POST /api/crm/allocations/check-sla – Evaluates and escalates SLA breaches (§5.3)
router.post('/allocations/check-sla', async (req, res, next) => {
  try {
    const result = await crmService.checkAndEscalateSlas();
    res.json({ success: true, message: 'SLA breach evaluation completed', ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/allocations/:id/accept', async (req, res, next) => {
  try {
    const consultantName = req.body.consultantName || req.user?.name || 'Alex Rivers';
    const accepted = await crmService.acceptAllocation(req.params.id, consultantName);
    res.json({ success: true, message: 'Allocation SLA accepted', data: accepted });
  } catch (err) {
    next(err);
  }
});

router.post('/allocations/:id/reassign', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin', 'bdc'), async (req, res, next) => {
  try {
    const { consultantName } = req.body;
    const reassigned = await crmService.reassignAllocation(req.params.id, consultantName);
    res.json({ success: true, message: 'Allocation reassigned', data: reassigned });
  } catch (err) {
    next(err);
  }
});

// ─── 6. Virtual Yard Stock Reservation (§5.6, AC-8) ─────────────────────────
router.get('/vy/stock', async (req, res, next) => {
  try {
    const result = await crmService.getVyStock(req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/vy/hold', async (req, res, next) => {
  try {
    const { stockId, opportunityId, consultantName } = req.body;
    const rep = consultantName || req.user?.name || 'Alex Rivers';
    const held = await crmService.holdStock(stockId, opportunityId, rep);
    res.json({ success: true, message: 'Stock reserved for 48 hours', data: held });
  } catch (err) {
    next(err);
  }
});

router.post('/vy/release', async (req, res, next) => {
  try {
    const { stockId } = req.body;
    const released = await crmService.releaseStock(stockId);
    res.json({ success: true, message: 'Stock hold released', data: released });
  } catch (err) {
    next(err);
  }
});

router.post('/vy/check-expired-holds', async (req, res, next) => {
  try {
    const result = await crmService.checkAndReleaseExpiredHolds();
    res.json({ success: true, message: 'Expired holds checked and released', ...result });
  } catch (err) {
    next(err);
  }
});

// ─── 7. Sales Log & Delivery Watch (§5.7, §5.8, AC-9) ───────────────────────
router.get('/saleslog/export-csv', async (req, res, next) => {
  try {
    const csvData = await crmService.exportSalesLogCsv(req.query, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="byd-saleslog-${new Date().toISOString().split('T')[0]}.csv"`);
    res.status(200).send(csvData);
  } catch (err) {
    next(err);
  }
});

router.get(['/saleslog', '/sales-log'], async (req, res, next) => {
  try {
    const result = await crmService.getSalesLog(req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/saleslog/reconcile-all', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const result = await crmService.runNightlySalesLogReconcile(req.body.site || req.query.site);
    res.json({ success: true, message: 'All outstanding Sales Log rows reconciled', ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/saleslog/:id/reconcile', async (req, res, next) => {
  try {
    const reconciled = await crmService.reconcileSalesLogRow(req.params.id);
    res.json({ success: true, message: 'Sales Log row reconciled', data: reconciled });
  } catch (err) {
    next(err);
  }
});

// Inbound Exception Queue Endpoints (§5.7, Phase 2/3)
router.get('/saleslog/exceptions', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin', 'bdc'), async (req, res, next) => {
  try {
    const result = await crmService.getSalesLogExceptions(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/saleslog/exceptions/:id/resolve', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const resolved = await crmService.resolveSalesLogException(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Sales Log exception resolved', data: resolved });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

router.post('/saleslog/exceptions/:id/dismiss', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const result = await crmService.dismissSalesLogException(req.params.id, req.body.reason, req.user);
    res.json({ success: true, message: 'Sales Log exception dismissed', ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

// Configurable Sales Log Field Mapping Endpoints (§5.7)
router.get('/settings/saleslog-mapping', async (req, res, next) => {
  try {
    const mapping = await crmService.getSalesLogMapping();
    res.json({ success: true, data: mapping });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/saleslog-mapping', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const saved = await crmService.saveSalesLogMapping(req.body, req.user);
    res.json({ success: true, message: 'Field mapping configuration saved', data: saved });
  } catch (err) {
    next(err);
  }
});

router.get('/delivery-watch', async (req, res, next) => {
  try {
    const result = await crmService.getDeliveryWatch(req.query);
    res.json({
      success: true,
      count: result.data.length,
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
      totalPages: result.pagination.pages,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
});

// ─── 8. Scoreboard Metrics & Targets (§5.5, AC-6) ───────────────────────────
router.get('/boards/me', async (req, res, next) => {
  try {
    const data = await crmService.getBoardMe({
      ...req.query,
      consultant: req.query.consultant || req.user?.name || 'Alex Rivers',
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/boards/team', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin', 'bdc'), async (req, res, next) => {
  try {
    const data = await crmService.getBoardTeam(req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.get('/targets', async (req, res, next) => {
  try {
    const targets = await crmService.getTargets(req.query);
    res.json({ success: true, data: targets });
  } catch (err) {
    next(err);
  }
});

router.post('/targets', requireRole('manager', 'sales_manager', 'site_admin', 'super_admin', 'admin'), async (req, res, next) => {
  try {
    const updated = await crmService.updateTarget(req.body);
    res.json({ success: true, message: 'Target quota saved to database', data: updated });
  } catch (err) {
    next(err);
  }
});

// ─── 9. Real-Time Delivery & SLA Notifications (§5.8, §5.3) ─────────────────
router.get('/notifications', async (req, res, next) => {
  try {
    const result = await crmService.getNotifications(req.query, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── 10. Phone Call Outreach Logging (§5.9) ─────────────────────────────────
router.post('/customers/:id/calls', async (req, res, next) => {
  try {
    const callLog = await crmService.logPhoneCall(req.params.id, {
      ...req.body,
      author: req.body.author || req.user?.name || 'Alex Rivers',
    });
    res.status(201).json({ success: true, message: 'Phone call logged to timeline', data: callLog });
  } catch (err) {
    next(err);
  }
});

// ─── 11. CRM Appointments & Calendar (§5.5, §5.9, AC-4) ────────────────────

router.get('/appointments', async (req, res, next) => {
  try {
    const result = await crmService.getAppointments(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/appointments', async (req, res, next) => {
  try {
    const appt = await crmService.createAppointment(req.body, req.user);
    res.status(201).json({ success: true, message: 'Appointment booked', data: appt });
  } catch (err) {
    next(err);
  }
});

router.patch('/appointments/:id', async (req, res, next) => {
  try {
    const updated = await crmService.updateAppointment(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Appointment updated', data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

// ─── 12. Inbound Sync Exceptions & Delivery Pending (§5.7, §5.8, §7.5) ──────
router.get('/sync-pending', async (req, res, next) => {
  try {
    const result = await crmService.getSyncPending(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sync-pending/:id/retry', requireRole('sales_manager', 'site_admin', 'super_admin', 'sales_consultant'), async (req, res, next) => {
  try {
    const result = await crmService.retryDeliverySync(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

module.exports = router;


