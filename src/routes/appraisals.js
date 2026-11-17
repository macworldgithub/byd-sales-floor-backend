const express = require("express");
const fs = require("node:fs");
const { authenticate } = require("../middleware/auth");
const { leadConn, deliveryConn } = require("../db");
const { AppraisalCentre } = require("../services/appraisalCentre");
const policy = require("../services/appraisalPolicy");
const router = express.Router();
const service = () => new AppraisalCentre(leadConn.db, deliveryConn.db);
const run = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req, service()) });
  } catch (error) {
    next(error);
  }
};
function sendFile(req, res, next, file) {
  res.set({
    "Cache-Control": "private, no-store",
    "Content-Type": file.contentType,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": `${file.kind === "document" ? "attachment" : "inline"}; filename="${file.filename}"`,
    "Accept-Ranges": "bytes",
  });
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range),
      start = match ? Number(match[1]) : -1,
      end = match?.[2] ? Number(match[2]) : file.bytes - 1;
    if (start < 0 || start > end || end >= file.bytes)
      return res
        .status(416)
        .set("Content-Range", `bytes */${file.bytes}`)
        .end();
    res
      .status(206)
      .set({
        "Content-Range": `bytes ${start}-${end}/${file.bytes}`,
        "Content-Length": String(end - start + 1),
      });
    const stream = fs.createReadStream(file.path, { start, end });
    stream.on("error", next);
    return stream.pipe(res);
  }
  res.sendFile(file.path, (error) => {
    if (error) next(error);
  });
}
router.use(authenticate);
router.use((req, res, next) => {
  try {
    policy.access(req.user);
    res.set("Cache-Control", "no-store");
    next();
  } catch (error) {
    next(error);
  }
});
router.get(
  "/metadata",
  run(async () => ({
    shots: policy.SHOTS,
    requiredShots: policy.REQUIRED_SHOTS,
    statuses: policy.STATUSES,
    states: policy.STATES,
    providers: require("../services/vehicleChecks").readiness(),
    damageAI: {
      configured: !!(
        process.env.INSPECTION_AI_URL && process.env.INSPECTION_AI_TOKEN
      ),
    },
  })),
);
router.get(
  "/report",
  run((req, s) => s.report(req.query, req.user)),
);
router.get("/archive/:id/media/:mediaId", async (req, res, next) => {
  try {
    sendFile(
      req,
      res,
      next,
      await service().archiveAttachment(
        req.params.id,
        req.params.mediaId,
        req.user,
      ),
    );
  } catch (error) {
    next(error);
  }
});
for (const kind of ["archive", "partners", "list"])
  router.get(kind === "list" ? "/" : `/${kind}`, async (req, res, next) => {
    try {
      res.json({
        success: true,
        ...(await service()[kind](req.query, req.user)),
      });
    } catch (error) {
      next(error);
    }
  });
router.post(
  "/partners",
  run((req, s) => s.savePartner(req.body, req.user)),
);
router.patch(
  "/partners/:id",
  run((req, s) => s.savePartner(req.body, req.user, req.params.id)),
);
router.get("/media/:id", async (req, res, next) => {
  try {
    sendFile(
      req,
      res,
      next,
      await service().attachment(req.params.id, req.user),
    );
  } catch (error) {
    next(error);
  }
});
router.post(
  "/",
  run((req, s) => s.create(req.body, req.user)),
);
router.get(
  "/:id",
  run(async (req, s) =>
    policy.view(await s.record(req.params.id, req.user), req.user),
  ),
);
router.patch(
  "/:id",
  run((req, s) => s.patch(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/status",
  run((req, s) => s.status(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/link",
  run((req, s) => s.link(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/rego",
  run((req, s) => s.check(req.params.id, "rego", req.body, req.user)),
);
router.post(
  "/:id/ppsr",
  run((req, s) => s.check(req.params.id, "ppsr", req.body, req.user)),
);
router.post(
  "/:id/drives/start",
  run((req, s) => s.drive(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/drives/finish",
  run((req, s) => s.drive(req.params.id, req.body, req.user, true)),
);
router.post(
  "/:id/sign-loancar",
  run((req, s) => s.signLoan(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/return-loancar",
  run((req, s) => s.returnLoan(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/media",
  express.raw({ type: () => true, limit: "65mb" }),
  run((req, s) =>
    s.upload(
      req.params.id,
      req.query,
      req.body,
      String(req.headers["content-type"] || "").split(";")[0],
      req.user,
    ),
  ),
);
router.post(
  "/:id/analyse",
  run((req, s) =>
    require("../services/appraisalAI").analyse(
      s,
      req.params.id,
      req.body,
      req.user,
    ),
  ),
);
router.get(
  "/:id/offers",
  run((req, s) => s.offers(req.params.id, req.user)),
);
router.post(
  "/:id/invitations",
  run((req, s) => s.invite(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/select-offer",
  run((req, s) => s.selectOffer(req.params.id, req.body, req.user)),
);
router.post(
  "/:id/invitations/:invitationId/revoke",
  run((req, s) => s.revoke(req.params.id, req.params.invitationId, req.user)),
);
module.exports = router;
module.exports.sendFile = sendFile;
