#!/usr/bin/env node
require("dotenv").config();
const bundle = require("../src/services/iappraiseBundle");
async function main() {
  const manifest = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!manifest)
    throw new Error(
      "Usage: node scripts/import-iappraise-bundle.js MANIFEST.json [--apply]",
    );
  const prepared = await bundle.prepare(require("node:path").resolve(manifest));
  if (!process.argv.includes("--apply"))
    return console.log(
      JSON.stringify({ dryRun: true, ...prepared.summary }, null, 2),
    );
  if (
    !process.env.IAPPRAISE_ARCHIVE_DIR ||
    !process.env.DELIVERY_CENTER_MONGO_URI
  )
    throw new Error(
      "Configure persistent IAPPRAISE_ARCHIVE_DIR and DELIVERY_CENTER_MONGO_URI.",
    );
  const client = await require("mongoose").mongo.MongoClient.connect(
    process.env.DELIVERY_CENTER_MONGO_URI,
  );
  try {
    console.log(
      JSON.stringify(
        await bundle.apply(
          prepared,
          client.db(),
          process.env.IAPPRAISE_ARCHIVE_DIR,
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
