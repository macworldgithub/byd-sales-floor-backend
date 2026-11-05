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
      res.json(await browsing[name]({ lead: leadConn.db, panel: deliveryConn.db }, req.query, req.user));
    } catch (error) { next(error); }
  });
}
module.exports = router;
