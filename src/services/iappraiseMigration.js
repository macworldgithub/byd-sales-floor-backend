const fs = require("node:fs/promises");
const path = require("node:path");
const { hash } = require("./appraisalCentre");
const { fail, canonicalSite } = require("./accountAccess");
const SITES = {
  BYD: "BYD South Morang",
  "Kia NEW": "South Morang Kia",
  "Kia USED": "South Morang Kia",
  "Hyundai NEW": "South Morang Hyundai",
  "Hyundai USED": "South Morang Hyundai",
  "Chery NEW": "Chery South Morang",
};
const REQUIRED = [
  "Dealership",
  "Department",
  "Customer Name",
  "Rego",
  "VIN",
  "Make",
  "Model",
  "Year",
];
async function prepare(filename, contactsFile, siteMap = {}) {
  const bytes = await fs.readFile(filename),
    sourceHash = hash(bytes),
    source = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(source.records) ||
    source.records.length !== source.recordCount ||
    !Array.isArray(source.columns)
  )
    fail(400, "Source export record count or schema is invalid.");
  if (
    !source.columns.every((key) => typeof key === "string") ||
    !REQUIRED.every((key) => source.columns.includes(key))
  )
    fail(400, "Required export columns are missing.");
  if (
    !source.records.length ||
    source.records.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !REQUIRED.every((key) => typeof row[key] === "string") ||
        Object.keys(row).length !== source.columns.length,
    )
  )
    fail(
      400,
      "Source rows must preserve every original column, including blanks.",
    );
  const siteCounts = {},
    rows = source.records.map((raw, index) => {
      const mapped = siteMap[`${raw.Dealership}::${raw.Department}`];
      if (mapped && (!canonicalSite(mapped) || !mapped.startsWith("BYD ")))
        fail(400, "Explicit mappings must name a configured BYD site.");
      if (!mapped && raw.Dealership !== "South Morang Kia, Hyundai & BYD")
        fail(
          400,
          "Unmapped source dealership. Review its explicit site mapping first.",
        );
      if (!mapped && raw.Department && !SITES[raw.Department])
        fail(400, `Unmapped department: ${raw.Department}.`);
      const site = mapped || SITES[raw.Department] || raw.Dealership;
      siteCounts[site] = (siteCounts[site] || 0) + 1;
      // A row key identifies an exact source snapshot, never a customer identity.
      const sourceId = `${sourceHash}:row:${index + 1}`;
      return {
        _id: `IAPP-${hash(sourceId)}`,
        kind: "appraisal",
        sourceId,
        sourceRow: index + 1,
        sourceHash,
        originalCsvHash: source.sourceSha256 || null,
        site,
        rego: raw.Rego,
        vin: raw.VIN,
        customerName: raw["Customer Name"],
        make: raw.Make,
        model: raw.Model,
        year: raw.Year,
        raw,
        media: [],
        customerLinked: false,
        completeInspection: false,
        importedAt: new Date(),
      };
    });
  let contacts = [],
    contactsBytes;
  if (contactsFile) {
    contactsBytes = await fs.readFile(contactsFile);
    const data = JSON.parse(contactsBytes.toString("utf8"));
    if (
      !Array.isArray(data.rows) ||
      data.rows.length !== data.sourceRowCount ||
      !Array.isArray(data.columns) ||
      data.rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== data.columns.length ||
          row.some((v) => typeof v !== "string"),
      )
    )
      fail(400, "Contact export count or schema is invalid.");
    const contactHash = hash(contactsBytes);
    if (data.ppsrByRow !== undefined && (!Array.isArray(data.ppsrByRow) || data.ppsrByRow.length !== data.rows.length || data.ppsrByRow.some(value => typeof value !== 'boolean'))) fail(400, 'Contact permission rows do not reconcile.');
    contacts = data.rows.map((raw, index) => ({
      _id: `IAPP-CONTACT-${hash(`${contactHash}:${index + 1}`)}`,
      kind: "dealer_staff",
      site: `${data.sourceDealership} (source group)`,
      sourceAccount: data.sourceDealership,
      sourceId: `${contactHash}:row:${index + 1}`,
      sourceRow: index + 1,
      sourceHash: contactHash,
      raw: Object.fromEntries(data.columns.map((key, at) => [key, raw[at]])),
      customerName: raw[data.columns.indexOf('User Name')] || '',
      sourcePermissions: { canRequestPPSR: Array.isArray(data.ppsrByRow) ? data.ppsrByRow[index] : data.canRequestPPSR },
      importedAt: new Date(),
      active: false,
      loginCreated: false,
    }));
  }
  return {
    source,
    sourceHash,
    bytes,
    contactsBytes,
    rows,
    contacts,
    summary: {
      sourceHash,
      records: rows.length,
      siteCounts,
      dealerStaffContacts: contacts.length,
      wholesalers: 0,
      media: 0,
      completeSourceBackup: false,
      limitations: [
        "CSV snapshot has no upstream appraisal IDs.",
        "Inspection details, source photographs/videos and full offer histories are absent.",
        "The Permissions contacts are staff records, not a wholesaler directory.",
        "Unclassified records retain their original group scope. No customer/deal matches are inferred.",
      ],
    },
  };
}
async function apply(bundle, panel, directory) {
  panel = require('./appraisalStorage').storage(panel);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(directory, `${bundle.sourceHash}.json`);
  try {
    await fs.writeFile(sourcePath, bundle.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (hash(await fs.readFile(sourcePath)) !== bundle.sourceHash)
      fail(409, "Existing source archive checksum mismatch.");
  }
  if (bundle.contactsBytes) {
    const file = path.join(directory, `${hash(bundle.contactsBytes)}.json`);
    try {
      await fs.writeFile(file, bundle.contactsBytes, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (hash(await fs.readFile(file)) !== hash(bundle.contactsBytes))
        fail(409, "Existing contact archive checksum mismatch.");
    }
  }
  const collection = panel.collection("iappraise_archive");
  for (let offset = 0; offset < bundle.rows.length; offset += 100) {
    await Promise.all(
      bundle.rows
        .slice(offset, offset + 100)
        .map((row) =>
          collection.updateOne(
            { _id: row._id },
            { $setOnInsert: row },
            { upsert: true },
          ),
        ),
    );
    if (offset % 2000 === 0)
      process.stderr.write(
        `Preserved ${Math.min(offset + 100, bundle.rows.length)}/${bundle.rows.length} source rows\n`,
      );
  }
  for (const contact of bundle.contacts)
    await collection.updateOne(
      { _id: contact._id },
      { $setOnInsert: contact },
      { upsert: true },
    );
  const actual = await collection.countDocuments({
    sourceHash: bundle.sourceHash,
    kind: "appraisal",
  });
  if (actual !== bundle.rows.length)
    fail(
      409,
      `Reconciliation failed: expected ${bundle.rows.length}, found ${actual}.`,
    );
  const siteCounts = {};
  for (const [site, expected] of Object.entries(bundle.summary.siteCounts)) {
    const actual = await collection.countDocuments({
      sourceHash: bundle.sourceHash,
      site,
      kind: "appraisal",
    });
    if (actual !== expected)
      fail(409, `Site reconciliation failed for ${site}.`);
    siteCounts[site] = actual;
  }
  for (const contact of bundle.contacts)
    if (
      !(await collection.findOne({
        _id: contact._id,
        sourceHash: contact.sourceHash,
      }))
    )
      fail(409, "Contact reconciliation failed.");
  const summary = {
    ...bundle.summary,
    reconciled: true,
    siteCounts,
    reconciledAt: new Date(),
    sourcePath,
  };
  await fs.writeFile(
    path.join(directory, `${bundle.sourceHash}.reconciliation.json`),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  return summary;
}
module.exports = { prepare, apply, SITES };
