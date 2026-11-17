const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { hash } = require("../src/services/appraisalCentre");
const bundle = require("../src/services/iappraiseBundle");
const { database } = require("./helpers/floorMemory");
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "byd-full-export-"));
  const raw = Buffer.from(
      JSON.stringify({
        id: "upstream-11",
        rego: "ABC123",
        condition: { notes: "Actual source detail" },
        unknownSourceField: "Preserve this",
      }),
    ),
    photo = Buffer.from("original historical media bytes");
  await fs.writeFile(path.join(root, "record.json"), raw);
  await fs.writeFile(path.join(root, "photo.jpg"), photo);
  const manifest = {
    version: 1,
    namespace: "iappraise-byd-account",
    expectedRecords: 1,
    expectedCounts: { appraisal: 1 },
    expectedMedia: 1,
    completeSourceVerified: false,
    records: [
      {
        kind: "appraisal",
        sourceId: "upstream-11",
        site: "BYD Fairfield",
        path: "record.json",
        sha256: hash(raw),
        size: raw.length,
        media: [
          {
            sourceId: "photo-1",
            path: "photo.jpg",
            sha256: hash(photo),
            size: photo.length,
            contentType: "image/jpeg",
            name: "historical-front.jpg",
          },
        ],
      },
    ],
  };
  const filename = path.join(root, "manifest.json");
  const save = () => fs.writeFile(filename, JSON.stringify(manifest));
  await save();
  try {
    await run({ root, manifest, filename, save, photo });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("full bundles retain original JSON and historical media with checksum reconciliation and no live-customer merge", async () =>
  fixture(async ({ root, filename, photo }) => {
    const prepared = await bundle.prepare(filename),
      db = database({ customers: [{ customer_id: "live" }] }),
      archive = path.join(root, "archive");
    const summary = await bundle.apply(prepared, db, archive);
    assert.equal(summary.reconciled, true);
    assert.equal(summary.media, 1);
    assert.equal(summary.completeSourceBackup, false);
    const row = db.collection("iappraise_archive").rows[0];
    assert.equal(row.raw.unknownSourceField, "Preserve this");
    assert.deepEqual(
      await fs.readFile(path.join(archive, row.media[0].filename)),
      photo,
    );
    await bundle.apply(prepared, db, archive);
    assert.equal(db.collection("iappraise_archive").rows.length, 1);
    assert.equal(db.collection("customers").rows.length, 1);
  }));
test("bundle validation refuses count errors, altered bytes and symlink escapes before imports", async () =>
  fixture(async ({ root, filename, manifest, save }) => {
    manifest.expectedMedia = 2;
    await save();
    await assert.rejects(bundle.prepare(filename), /counts/);
    manifest.expectedMedia = 1;
    await save();
    await fs.writeFile(path.join(root, "photo.jpg"), "tampered");
    await assert.rejects(bundle.prepare(filename), /checksum/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-export-"));
    try {
      await fs.writeFile(path.join(outside, "photo.jpg"), "tampered");
      await fs.unlink(path.join(root, "photo.jpg"));
      await fs.symlink(
        path.join(outside, "photo.jpg"),
        path.join(root, "photo.jpg"),
      );
      await assert.rejects(bundle.prepare(filename), /escape/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  }));
test("new media versions retain earlier snapshots and importer never overwrites edited partner contacts", async () =>
  fixture(async ({ root, filename, manifest, save }) => {
    const partner = {
      name: "Original Name",
      email: "wholesaler@example.invalid",
      company: "Company",
    };
    manifest.records[0].kind = "wholesaler";
    manifest.records[0].partner = partner;
    manifest.expectedCounts = { wholesaler: 1 };
    await save();
    const db = database(),
      archive = path.join(root, "archive"),
      prepared = await bundle.prepare(filename);
    await bundle.apply(prepared, db, archive);
    const contact = db.collection("appraisal_partners").rows[0];
    contact.name = "Staff edited name";
    const updatedBytes = Buffer.from("newly exported media version");
    await fs.writeFile(path.join(root, "photo.jpg"), updatedBytes);
    manifest.records[0].media[0].sha256 = hash(updatedBytes);
    manifest.records[0].media[0].size = updatedBytes.length;
    await save();
    await bundle.apply(await bundle.prepare(filename), db, archive);
    assert.equal(db.collection("iappraise_archive").rows.length, 2);
    assert.equal(db.collection("appraisal_partners").rows.length, 1);
    assert.equal(contact.name, "Staff edited name");
  }));
