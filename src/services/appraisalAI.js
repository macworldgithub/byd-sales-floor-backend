const fs = require("node:fs/promises");
const { fail } = require("./accountAccess");
const policy = require("./appraisalPolicy");
async function analyse(service, value, input, user, fetchImpl = fetch) {
  const row = await service.record(value, user);
  if (!["Draft", "Pending Inspection", "Completed"].includes(row.status))
    fail(409, "Reopen the appraisal first.");
  if (input.revision !== (row.revision || 0))
    fail(409, "Refresh before requesting analysis.");
  const endpoint = process.env.INSPECTION_AI_URL,
    key = process.env.INSPECTION_AI_TOKEN;
  if (!endpoint || !key)
    fail(
      503,
      "Damage AI is not configured. Manual inspection and override remain available.",
    );
  let url;
  try {
    url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error();
  } catch {
    fail(
      503,
      "Damage AI requires an HTTPS endpoint without embedded credentials.",
    );
  }
  const photos = (row.media || [])
    .filter((m) => m.purpose === "inspection" && m.kind === "image")
    .slice(-9);
  if (!photos.length) fail(400, "Capture inspection photos first.");
  const images = [];
  let bytes = 0;
  for (const photo of photos) {
    const file = await service.attachment(photo.id, user);
    bytes += file.bytes;
    if (bytes > 25 * 1024 * 1024)
      fail(
        400,
        "Select smaller inspection images for AI analysis (25 MB total).",
      );
    images.push({
      shot: file.shot,
      contentType: file.contentType,
      base64: (await fs.readFile(file.path)).toString("base64"),
    });
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vehicle: { make: row.make, model: row.model, year: row.year },
      images,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    fail(502, "Damage analysis failed; continue with the manual inspection.");
  const result = await response.json();
  if (!Array.isArray(result.findings) || result.findings.length > 100)
    fail(502, "Damage AI returned an invalid result.");
  const findings = policy
    .details(
      {
        condition: {
          damagePoints: result.findings.map((f) => ({ ...f, source: "ai" })),
        },
      },
      user,
    )
    .condition.damagePoints.map((f) => ({ ...f, decision: "pending" }));
  return policy.view(
    await service.update(
      row,
      { aiAssessment: { at: new Date(), findings, reviewed: false } },
      input.revision,
      user,
      "Damage AI suggestions ready",
      "Review each finding before adding it to the inspection.",
    ),
    user,
  );
}
module.exports = { analyse };
