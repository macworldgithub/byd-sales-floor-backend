const express = require('express');
const session = require('../services/virtualyardSession');
const virtualyard = require('../services/virtualyard');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/options', async (req, res, next) => {
  try { res.json({ success: true, data: await virtualyard.metadata(req.user) }); } catch (error) { next(error); }
});
router.get('/lookup/:kind', async (req, res, next) => {
  try { res.json({ success: true, ...await virtualyard.lookupPage(req.params.kind, req.query.q, req.user, req.query.limit) }); } catch (error) { next(error); }
});
router.get('/session', async (req, res, next) => {
  try {
    try { await session.check(); } catch (_) { /* status is useful while disconnected */ }
    res.json({ success: true, data: session.status() });
  } catch (error) { next(error); }
});
router.post('/session', requireRole('site_admin', 'super_admin'), async (req, res, next) => {
  try { res.json({ success: true, data: await session.connect(req.body.cookie) }); } catch (error) { next(error); }
});

module.exports = router;
