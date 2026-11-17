#!/usr/bin/env node
// Dry-run by default. Source snapshots never overwrite live customers or deals.
require("dotenv").config();
const path = require("node:path");
const { prepare, apply } = require("../src/services/iappraiseMigration");
async function main() {
  const args = process.argv.slice(2),
    applyChanges = args.includes("--apply"),
    contactsAt = args.indexOf("--contacts");
  const mappingAt = args.indexOf("--mapping");
  const source = args.find(
    (arg, at) =>
      !arg.startsWith("--") &&
      (contactsAt < 0 || at !== contactsAt + 1) &&
      (mappingAt < 0 || at !== mappingAt + 1),
  );
  if (!source)
    throw new Error(
      "Usage: node scripts/import-iappraise.js EXPORT.json [--contacts CONTACTS.json] [--apply]",
    );
  const mapping =
    mappingAt < 0
      ? {}
      : JSON.parse(
          await require("node:fs/promises").readFile(
            args[mappingAt + 1],
            "utf8",
          ),
        );
  const bundle = await prepare(
    source,
    contactsAt >= 0 ? args[contactsAt + 1] : undefined,
    mapping,
  );
  if (!applyChanges) {
    console.log(JSON.stringify({ dryRun: true, ...bundle.summary }, null, 2));
    return;
  }
  if (!process.env.IAPPRAISE_ARCHIVE_DIR)
    throw new Error(
      "Set a persistent IAPPRAISE_ARCHIVE_DIR before applying an import.",
    );
  const { MongoClient } = require("mongoose").mongo;
  const client = await MongoClient.connect(
    process.env.DELIVERY_CENTER_MONGO_URI,
  );
  try {
    console.log(
      JSON.stringify(
        await apply(
          bundle,
          client.db(),
          path.resolve(process.env.IAPPRAISE_ARCHIVE_DIR),
        ),
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
