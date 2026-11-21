const express = require('express');
const { authenticate } = require('../middleware/auth');
const { leadConn, deliveryConn } = require('../db');
const browsing = require('../services/floorBrowsing');
const router = express.Router();
router.use(authenticate);
router.use((req, res, next) => {
  if (req.user.platform !== 'sales_floor' || (Array.isArray(req.user.platform_access) && !req.user.platform_access.includes('sales_floor')))
    return res.status(403).json({ success: false, message: 'Sales Floor access is required.' });
  next();
});
router.post('/allocations/recover', async (req, res, next) => {
  try {
    if (!require('../services/salesFloorPolicy').isManager(req.user)) return res.status(403).json({ success: false, message: 'Management access required.' });
    const query = { ...req.query, site: req.user.locked_site || req.headers['x-site'] || req.query.site };
    const data = await require('../services/leadAllocation').recover(leadConn.db, deliveryConn.db, query, req.user, req.body?.apply === true);
    res.set('Cache-Control', 'private, no-store').json({ success: true, data });
  } catch (error) { next(error); }
});
router.get('/calendar.ics', async (req, res, next) => {
  try {
    const events = [];
    let page = 1, pages;
    do {
      const result = await browsing.calendar({ lead: leadConn.db, panel: deliveryConn.db }, { ...req.query, page, limit: 100 }, req.user);
      events.push(...result.data);
      pages = result.pagination.pages;
      page++;
    } while (page <= pages);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'attachment; filename="sales-floor-calendar.ics"');
    res.type('text/calendar').send(browsing.calendarIcs(events));
  } catch (error) { next(error); }
});
for (const name of ['leads', 'calendar', 'today']) {
  router.get('/' + name, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await require('../services/readCache').readRequest(leadConn.db, req, () => browsing[name]({ lead: leadConn.db, panel: deliveryConn.db }, req.query, req.user)));
    } catch (error) { next(error); }
  });
}
module.exports = router;
