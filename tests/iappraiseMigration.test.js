const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { prepare, apply } = require("../src/services/iappraiseMigration");
const { database } = require("./helpers/floorMemory");
test('staff-contact imports preserve each source permission without creating accounts or guessing a site', async () => fixture(async({dir,file})=>{
  const contacts=path.join(dir,'contacts.json'); await fs.writeFile(contacts,JSON.stringify({sourceRowCount:2,sourceDealership:'BYD Melbourne',columns:['User Name','Email','Phone Number','User Role'],rows:[['Staff A','a@example.invalid','','Manager'],['Staff B','b@example.invalid','','Sales']],ppsrByRow:[true,false]}));
  const bundle=await prepare(file,contacts);assert.equal(bundle.contacts.length,2);assert.equal(bundle.contacts[1].sourcePermissions.canRequestPPSR,false);assert.equal(bundle.contacts[0].site,'BYD Melbourne (source group)');assert.equal(bundle.contacts[0].loginCreated,false);
  const db=database();await apply(bundle,db,path.join(dir,'archive'));assert.equal(db.collection('users').rows.length,0);
}));
async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "byd-migration-"));
  const row = {
    Dealership: "South Morang Kia, Hyundai & BYD",
    Department: "BYD",
    "Customer Name": "Source Customer",
    Rego: "ABC123",
    VIN: "",
    Make: "Toyota",
    Model: "Corolla",
    Year: "2020",
  };
  const source = {
      columns: Object.keys(row),
      recordCount: 3,
      records: [row, { ...row }, { ...row, Department: "" }],
    },
    file = path.join(dir, "source.json");
  await fs.writeFile(file, JSON.stringify(source));
  try {
    await run({ dir, file, source });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("imports preserve blanks and duplicate rows, retain unclassified scope and replay without live merges", async () =>
  fixture(async ({ dir, file }) => {
    const bundle = await prepare(file),
      db = database({
        customers: [{ customer_id: "existing", name: "Existing Customer" }],
      });
    assert.equal(bundle.summary.records, 3);
    assert.equal(bundle.summary.siteCounts["BYD South Morang"], 2);
    assert.notEqual(bundle.rows[0]._id, bundle.rows[1]._id);
    assert.equal(bundle.rows[0].raw.VIN, "");
    const result = await apply(bundle, db, path.join(dir, "archive"));
    assert.equal(result.reconciled, true);
    await apply(bundle, db, path.join(dir, "archive"));
    assert.equal(db.collection("iappraise_archive").rows.length, 3);
    assert.equal(db.collection("customers").rows.length, 1);
    assert.equal(db.collection("customers").rows[0].name, "Existing Customer");
    assert.deepEqual(await fs.readFile(result.sourcePath), bundle.bytes);
    assert.equal(result.completeSourceBackup, false);
  }));
test("malformed count and unknown departments stop before any database import", async () =>
  fixture(async ({ file, source }) => {
    source.recordCount = 4;
    await fs.writeFile(file, JSON.stringify(source));
    await assert.rejects(prepare(file), /count/);
    source.recordCount = 3;
    source.records[0].Department = "Unknown";
    await fs.writeFile(file, JSON.stringify(source));
    await assert.rejects(prepare(file), /Unmapped department/);
  }));
test("a corrupted existing source archive fails checksum verification", async () =>
  fixture(async ({ dir, file }) => {
    const bundle = await prepare(file),
      db = database(),
      archive = path.join(dir, "archive");
    await fs.mkdir(archive);
    await fs.writeFile(
      path.join(archive, `${bundle.sourceHash}.json`),
      "corrupted",
    );
    await assert.rejects(apply(bundle, db, archive), /checksum mismatch/);
    assert.equal(db.collection("iappraise_archive").rows.length, 0);
  }));
