const express = require("express");
const rateLimit = require("express-rate-limit");
const { leadConn, deliveryConn } = require("../db");
const {
  AppraisalCentre,
  ref,
  directory,
} = require("../services/appraisalCentre");
const { fail } = require("../services/accountAccess");
const router = express.Router();
router.use(
  rateLimit({
    windowMs: 60000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
router.use((req, res, next) => {
  res.set({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  });
  next();
});
router.get("/:id", async (req, res, next) => {
  try {
    const s = new AppraisalCentre(leadConn.db, deliveryConn.db),
      { invite, row } = await s.invitation(
        req.params.id,
        req.headers["x-appraisal-token"],
      );
    res.json({ success: true, data: s.publicView(invite, row) });
  } catch (e) {
    next(e);
  }
});
router.post("/:id", async (req, res, next) => {
  try {
    const s = new AppraisalCentre(leadConn.db, deliveryConn.db);
    res.json({
      success: true,
      data: await s.bid(
        req.params.id,
        req.headers["x-appraisal-token"],
        req.body,
      ),
    });
  } catch (e) {
    next(e);
  }
});
router.get("/:id/media/:mediaId", async (req, res, next) => {
  try {
    const s = new AppraisalCentre(leadConn.db, deliveryConn.db),
      { row } = await s.invitation(
        req.params.id,
        req.headers["x-appraisal-token"],
      );
    if (
      !(row.media || []).some(
        (m) => m.id === req.params.mediaId && m.purpose === "inspection",
      )
    )
      fail(404, "Inspection media not found.");
    const file = await s.panel
      .collection("appraisal_media")
      .findOne({
        _id: ref(req.params.mediaId),
        appraisalId: row.appraisalId,
        purpose: "inspection",
      });
    if (!file) fail(404, "Inspection media not found.");
    require("./appraisals").sendFile(req, res, next, {
      ...file,
      path: require("node:path").join(directory(), file.filename),
    });
  } catch (e) {
    next(e);
  }
});
module.exports = router;
