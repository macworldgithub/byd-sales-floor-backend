const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { hash } = require("./appraisalCentre");
const { fail, canonicalSite } = require("./accountAccess");
async function checksum(filename) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}
async function safeFile(root, relative, expectedHash, expectedSize) {
  if (typeof relative !== "string" || path.isAbsolute(relative))
    fail(400, "Bundle file paths must be relative.");
  const resolved = await fs.realpath(path.resolve(root, relative));
  if (!resolved.startsWith(root + path.sep))
    fail(400, "Bundle files cannot escape the export directory.");
  const stat = await fs.stat(resolved);
  if (
    !stat.isFile() ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    stat.size !== expectedSize ||
    (await checksum(resolved)) !== expectedHash
  )
    fail(400, `Export file size or checksum failed: ${relative}.`);
  return { path: resolved, sha256: expectedHash, bytes: stat.size };
}
async function prepare(filename) {
  const sourceBytes = await fs.readFile(filename),
    manifest = JSON.parse(sourceBytes.toString("utf8")),
    root = await fs.realpath(path.dirname(filename));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.records) ||
    manifest.records.length !== manifest.expectedRecords ||
    !manifest.namespace ||
    typeof manifest.namespace !== "string" ||
    manifest.namespace.length > 100
  )
    fail(400, "Invalid migration manifest or record count.");
  if (
    !manifest.expectedCounts ||
    !Number.isInteger(manifest.expectedMedia) ||
    manifest.expectedMedia < 0
  )
    fail(400, "Declare expected kind and media counts.");
  const records = [],
    identities = new Set(),
    counts = { appraisal: 0, dealer: 0, wholesaler: 0, dealer_staff: 0 };
  let mediaCount = 0;
  for (const source of manifest.records) {
    if (
      !Object.hasOwn(counts, source.kind) ||
      typeof source.sourceId !== "string" ||
      !source.sourceId ||
      source.sourceId.length > 200
    )
      fail(400, "Each record needs its original source ID and kind.");
    const identity = `${source.kind}:${source.sourceId}`;
    if (identities.has(identity))
      fail(400, "Duplicate original source IDs in the bundle.");
    identities.add(identity);
    const site = canonicalSite(source.site);
    if (!site || !site.startsWith("BYD "))
      fail(400, "Provide an explicit BYD site mapping for every record.");
    const dataFile = await safeFile(
        root,
        source.path,
        source.sha256,
        source.size,
      ),
      raw = JSON.parse(await fs.readFile(dataFile.path, "utf8"));
    if (!raw || typeof raw !== "object")
      fail(400, "Source record JSON must contain the original record.");
    const media = [];
    if (source.media !== undefined && !Array.isArray(source.media))
      fail(400, "Invalid source media list.");
    for (const attachment of source.media || []) {
      const file = await safeFile(
        root,
        attachment.path,
        attachment.sha256,
        attachment.size,
      );
      if (!attachment.sourceId || typeof attachment.sourceId !== "string")
        fail(400, "Each attachment needs its original source ID.");
      media.push({
        ...file,
        id: hash(`${manifest.namespace}:${identity}:${attachment.sourceId}`),
        sourceId: attachment.sourceId,
        name: String(attachment.name || path.basename(attachment.path)).slice(
          0,
          180,
        ),
        contentType:
          /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime)|application\/pdf)$/.test(
            attachment.contentType,
          )
            ? attachment.contentType
            : "application/octet-stream",
      });
      mediaCount++;
    }
    if (["dealer", "wholesaler"].includes(source.kind)) {
      const partner = source.partner;
      if (
        !partner ||
        !String(partner.name || "").trim() ||
        !String(partner.phone || partner.email || "").trim()
      )
        fail(
          400,
          "External directory records require explicit contact details.",
        );
    }
    counts[source.kind]++;
    records.push({
      sourceId: source.sourceId,
      kind: source.kind,
      site,
      raw,
      dataFile,
      media,
      partner: source.partner || null,
    });
  }
  if (
    Object.keys(counts).some(
      (key) => counts[key] !== (manifest.expectedCounts[key] || 0),
    ) ||
    mediaCount !== manifest.expectedMedia
  )
    fail(400, "Manifest kind or media counts do not reconcile.");
  const sourceFiles = [];
  for (const file of manifest.sourceFiles || [])
    sourceFiles.push(await safeFile(root, file.path, file.sha256, file.size));
  return {
    manifest,
    sourceBytes,
    sourceHash: hash(sourceBytes),
    records,
    sourceFiles,
    summary: {
      records: records.length,
      counts,
      media: mediaCount,
      completeSourceBackup: manifest.completeSourceVerified === true,
    },
  };
}
async function apply(bundle, panel, directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  async function retain(file) {
    const target = path.join(directory, file.sha256);
    try {
      await fs.copyFile(
        file.path,
        target,
        require("node:fs").constants.COPYFILE_EXCL,
      );
      await fs.chmod(target, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await checksum(target)) !== file.sha256)
        fail(409, "Existing archived attachment checksum mismatch.");
    }
    if ((await checksum(target)) !== file.sha256)
      fail(409, "Archived file changed while it was copied.");
    return file.sha256;
  }
  await fs.writeFile(
    path.join(directory, `${bundle.sourceHash}.manifest.json`),
    bundle.sourceBytes,
    { mode: 0o600 },
  );
  for (const source of bundle.sourceFiles) await retain(source);
  const archive = panel.collection("iappraise_archive");
  for (const record of bundle.records) {
    const dataFile = await retain(record.dataFile),
      media = [];
    for (const attachment of record.media) {
      const filename = await retain(attachment);
      const { path: localSource, ...metadata } = attachment;
      media.push({ ...metadata, filename });
    }
    const version = hash(
      JSON.stringify([
        record.dataFile.sha256,
        media.map((file) => [file.sourceId, file.sha256]),
      ]),
    );
    const _id = `IAPP-${hash(`${bundle.manifest.namespace}:${record.kind}:${record.sourceId}:${version}`)}`;
    const entry = {
      _id,
      kind: record.kind,
      site: record.site,
      sourceId: record.sourceId,
      sourceHash: bundle.sourceHash,
      namespace: bundle.manifest.namespace,
      raw: record.raw,
      media,
      dataFile,
      importedAt: new Date(),
      customerLinked: false,
      rego: String(record.raw.rego || record.raw.Rego || ""),
      vin: String(record.raw.vin || record.raw.VIN || ""),
      customerName: String(
        record.raw.customerName || record.raw["Customer Name"] || "",
      ),
      make: String(record.raw.make || record.raw.Make || ""),
      model: String(record.raw.model || record.raw.Model || ""),
    };
    await archive.updateOne(
      { _id },
      { $setOnInsert: entry, $addToSet: { importBatches: bundle.sourceHash } },
      { upsert: true },
    );
    if (record.partner && ["dealer", "wholesaler"].includes(record.kind)) {
      const partner = record.partner;
      await panel.collection("appraisal_partners").updateOne(
        {
          _id: `PARTNER-${hash(`${bundle.manifest.namespace}:${record.kind}:${record.sourceId}:${record.site}`)}`,
        },
        {
          $setOnInsert: {
            name: String(partner.name).slice(0, 150),
            company: String(partner.company || "").slice(0, 200),
            kind: record.kind,
            site: record.site,
            email: String(partner.email || "").slice(0, 250),
            phone: String(partner.phone || "").slice(0, 40),
            address: String(partner.address || "").slice(0, 500),
            licence: String(partner.licence || "").slice(0, 100),
            abn: String(partner.abn || "").slice(0, 30),
            notes: String(partner.notes || "").slice(0, 5000),
            sourceId: record.sourceId,
            archiveId: _id,
            active: partner.active !== false,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
    const saved = await archive.findOne({ _id });
    if (
      !saved ||
      saved.media.length !== media.length ||
      saved.dataFile !== record.dataFile.sha256
    )
      fail(409, "Archived record reconciliation failed.");
    for (const attachment of saved.media)
      if (
        (await checksum(path.join(directory, attachment.filename))) !==
        attachment.sha256
      )
        fail(409, "Archived media reconciliation failed.");
  }
  const summary = {
    ...bundle.summary,
    reconciled: true,
    sourceHash: bundle.sourceHash,
    reconciledAt: new Date(),
  };
  await fs.writeFile(
    path.join(directory, `${bundle.sourceHash}.reconciliation.json`),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  return summary;
}
module.exports = { prepare, apply, safeFile, checksum };
