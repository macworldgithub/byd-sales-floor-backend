/**
 * Legacy sequence endpoints. SMS is sent manually from the conversation inbox.
 */
const express = require('express');
const { deliveryConn } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Legacy clients see automation disabled.
router.get('/', (req, res) => {
  res.json({ success: true, data: [], sending_mode: 'manual', automation_enabled: false });
});

// ─── GET /api/sequences/health (§5.8 Manager Health View) ───────────────────
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      sending_mode: 'manual', automation_enabled: false,
      summary: { enrolled: 0, active: 0, replied: 0, booked: 0, stopped: 0 },
      replyRatePct: 0, bookingRatePct: 0, sequences: [],
    },
  });
});

// ─── POST /api/sequences/enroll ─────────────────────────────────────────────
router.post('/enroll', (req, res) => {
  res.status(409).json({ success: false, message: 'Automatic SMS is disabled. Follow up manually from the conversation inbox.' });
});

// ─── POST /api/sequences/:id/pause ──────────────────────────────────────────
router.post('/:id/pause', async (req, res, next) => {
  try {
    const enrollColl = deliveryConn.db.collection('sequence_enrollments');
    await enrollColl.updateOne(
      { $or: [{ enrollment_id: req.params.id }, { customer_id: req.params.id }, { lead_id: req.params.id }] },
      { $set: { status: 'paused', updatedAt: new Date() } }
    );
    return res.json({ success: true, message: 'Sequence paused for this contact.' });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/sequences/:id/resume ─────────────────────────────────────────
router.post('/:id/resume', (req, res) => {
  res.status(409).json({ success: false, message: 'Automatic SMS is disabled. Compose a message in the conversation inbox.' });
});

// ─── POST /api/sequences/:id/stop ───────────────────────────────────────────
router.post('/:id/stop', async (req, res, next) => {
  try {
    const { reason = 'Manual stop' } = req.body;
    const enrollColl = deliveryConn.db.collection('sequence_enrollments');
    await enrollColl.updateOne(
      { $or: [{ enrollment_id: req.params.id }, { customer_id: req.params.id }, { lead_id: req.params.id }] },
      { $set: { status: 'stopped', stop_reason: reason, updatedAt: new Date() } }
    );
    return res.json({ success: true, message: `Sequence stopped (${reason}).` });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/sequences/process-steps (§5.8 Background Automated Step Runner) ───
router.post('/process-steps', (req, res) => {
  res.status(409).json({ success: false, message: 'Automatic SMS is disabled. Staff must send each message manually.' });
});

module.exports = router;
