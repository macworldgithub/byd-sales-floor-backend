const { fail } = require("./accountAccess");
const p = require("./salesFloorPolicy");
const { VIN } = require("./vehicleChecks");

const SHOTS = [
  "Front",
  "Right",
  "Rear",
  "Left",
  "Interior",
  "Odometer",
  "VIN",
  "Engine / boot",
  "Tyres",
];
const REQUIRED_SHOTS = SHOTS.slice(0, 7);
const STATES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"];
const STATUSES = [
  "Draft",
  "Pending Inspection",
  "Completed",
  "Approved",
  "Declined",
  "Traded",
  "Lost",
];
const text = (value, max = 2000) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
function money(value, name) {
  const number = Number(value);
  if (
    value === "" ||
    value === null ||
    !Number.isFinite(number) ||
    number < 0 ||
    number > 10000000
  )
    fail(400, `Enter a valid ${name}.`);
  return Math.round(number * 100) / 100;
}
function manager(user) {
  if (!p.isManager(user)) fail(403, "Management access required.");
}
function access(user) {
  if (["contractor", "delivery", "delivery_consultant"].includes(user.role))
    fail(403, "Sales appraisal access required.");
}
function details(input, user) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Appraisal details are required.");
  const allowed = [
    "rego",
    "state",
    "vin",
    "make",
    "model",
    "year",
    "odometer",
    "colour",
    "bodyType",
    "transmission",
    "fuelType",
    "engine",
    "variant",
    "serviceHistory",
    "keys",
    "registrationExpiry",
    "condition",
    "valuation",
    "notes",
  ];
  const result = {};
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) continue;
    if (["condition", "valuation"].includes(key)) continue;
    if (["year", "odometer", "keys"].includes(key)) {
      const n = Number(input[key]);
      if (
        !Number.isInteger(n) ||
        n < (key === "year" ? 1886 : 0) ||
        n >
          (key === "year"
            ? new Date().getFullYear() + 2
            : key === "keys"
              ? 10
              : 10000000)
      )
        fail(400, `Enter a valid ${key}.`);
      result[key] = n;
    } else
      result[key] = text(
        input[key],
        key === "notes" || key === "serviceHistory" ? 5000 : 150,
      );
  }
  for (const key of ["rego", "vin", "state"])
    if (result[key]) result[key] = result[key].toUpperCase().replace(/\s/g, "");
  if (result.rego && !/^[A-Z0-9]{2,10}$/.test(result.rego))
    fail(400, "Enter a valid registration.");
  if (result.vin && !VIN.test(result.vin))
    fail(400, "Enter a valid 17-character VIN.");
  if (result.state && !STATES.includes(result.state))
    fail(400, "Select a valid state.");
  if (input.condition !== undefined) {
    const c = input.condition;
    if (!c || typeof c !== "object" || Array.isArray(c))
      fail(400, "Invalid condition details.");
    result.condition = { notes: text(c.notes, 5000), damagePoints: [] };
    for (const key of [
      "exteriorRating",
      "interiorRating",
      "tyresRating",
      "mechanicalRating",
    ]) {
      if (c[key] == null || c[key] === "") continue;
      if (
        !Number.isInteger(Number(c[key])) ||
        Number(c[key]) < 1 ||
        Number(c[key]) > 5
      )
        fail(400, "Condition ratings must be 1–5.");
      result.condition[key] = Number(c[key]);
    }
    if (
      c.damagePoints !== undefined &&
      (!Array.isArray(c.damagePoints) || c.damagePoints.length > 100)
    )
      fail(400, "At most 100 damage findings are supported.");
    result.condition.damagePoints = (c.damagePoints || []).map((row) => {
      if (
        !text(row.panel, 100) ||
        !["Minor", "Moderate", "Major"].includes(row.severity)
      )
        fail(400, "Each finding needs a panel and severity.");
      return {
        panel: text(row.panel, 100),
        severity: row.severity,
        description: text(row.description),
        estimatedRepairCost: money(
          row.estimatedRepairCost ?? 0,
          "repair estimate",
        ),
        source: row.source === "ai" ? "ai" : "manual",
        decision: ["accepted", "edited", "dismissed"].includes(row.decision)
          ? row.decision
          : "accepted",
        reviewNotes: text(row.reviewNotes),
      };
    });
  }
  if (input.valuation !== undefined) {
    if (
      !input.valuation ||
      typeof input.valuation !== "object" ||
      Array.isArray(input.valuation)
    )
      fail(400, "Invalid valuation.");
    const keys = [
      "wholesaleValue",
      "retailValue",
      "customerExpectation",
      "tradeInAllowance",
      "payoutEstimate",
      "reconditioningCost",
    ];
    const supplied = Object.keys(input.valuation);
    if (supplied.some((key) => !keys.includes(key)))
      fail(400, "Unsupported valuation field.");
    if (
      !p.isManager(user) &&
      supplied.some((key) => key !== "customerExpectation")
    )
      fail(403, "Only managers can change valuations.");
    result.valuation = Object.fromEntries(
      supplied.map((key) => [key, money(input.valuation[key], key)]),
    );
  }
  return result;
}
function completion(row) {
  const missing = [];
  for (const key of ["rego", "vin", "make", "model", "year"])
    if (!row[key]) missing.push(key);
  if (row.vin && !VIN.test(row.vin)) missing.push("valid 17-character VIN");
  if (!STATES.includes(row.state)) missing.push("registration state");
  if (row.odometer == null) missing.push("odometer");
  for (const shot of REQUIRED_SHOTS)
    if (
      !(row.media || []).some(
        (media) =>
          media.purpose === "inspection" &&
          media.shot === shot &&
          media.kind === "image",
      )
    )
      missing.push(`${shot} photo`);
  for (const key of [
    "exteriorRating",
    "interiorRating",
    "tyresRating",
    "mechanicalRating",
  ])
    if (!row.condition?.[key]) missing.push(key);
  return missing;
}
function view(row, user) {
  const result = {
    ...row,
    condition: row.condition || {},
    valuation: row.valuation || {},
    media: row.media || [],
    revision: row.revision || 0,
    missing: completion(row),
    ppsrStatus: row.ppsrDetails?.verified
      ? row.ppsrStatus
      : row.ppsrStatus === "Error"
        ? "Error"
        : "Pending",
  };
  delete result.migrationRaw;
  if (!p.isManager(user)) {
    result.valuation =
      row.valuation?.customerExpectation == null
        ? {}
        : { customerExpectation: row.valuation.customerExpectation };
    delete result.selectedOffer;
    delete result.approval;
  }
  return result;
}
module.exports = {
  SHOTS,
  REQUIRED_SHOTS,
  STATES,
  STATUSES,
  text,
  money,
  manager,
  access,
  details,
  completion,
  view,
};
