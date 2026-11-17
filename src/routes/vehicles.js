const express = require("express");
const { authenticate } = require("../middleware/auth");
const { leadConn, deliveryConn } = require("../db");
const { SalesFloorOperations } = require("../services/salesFloorOperations");
const checks = require("../services/vehicleChecks");
const router = express.Router();
router.use(authenticate);
router.get("/status", (req, res) =>
  res.json({ success: true, data: checks.readiness() }),
);
// Paid requests require a POST and a stable request ID. No simulator fallback.
for (const [path, type] of [
  ["lookup-rego", "rego"],
  ["ppsr-check", "ppsr"],
]) {
  router.get(`/${path}`, (req, res) =>
    res
      .status(405)
      .json({
        success: false,
        message:
          "Use POST with a stable requestId for verified vehicle checks.",
      }),
  );
  router.post(`/${path}`, async (req, res, next) => {
    try {
      res.json({
        success: true,
        data: await checks.run(
          new SalesFloorOperations(leadConn.db, deliveryConn.db),
          type,
          req.body,
          req.user,
        ),
      });
    } catch (error) {
      next(error);
    }
  });
}
module.exports = router;
