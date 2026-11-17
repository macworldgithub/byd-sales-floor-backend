require("dotenv").config();
const { MongoClient } = require("mongoose").mongo;
async function main() {
  for (const [key, definitions] of Object.entries({
    LEAD_CENTER_MONGO_URI: {
      appraisals: [
        [{ appraisalId: 1 }, { unique: true, sparse: true }],
        [{ site: 1, consultantId: 1, updatedAt: -1 }],
        [{ leadId: 1 }],
      ],
    },
    DELIVERY_CENTER_MONGO_URI: {
      appraisal_partners: [[{ site: 1, name: 1 }]],
      appraisal_invitations: [[{ appraisalId: 1, createdAt: -1 }]],
      appraisal_media: [[{ appraisalId: 1 }]],
      iappraise_archive: [
        [{ site: 1, sourceRow: 1 }],
        [{ sourceHash: 1, kind: 1 }],
        [{ rego: 1 }],
      ],
    },
  })) {
    const client = await MongoClient.connect(process.env[key]);
    try {
      for (const [collection, indexes] of Object.entries(definitions))
        for (const [index, options] of indexes) {
          const target = client.db().collection(collection);
          const current = await target.indexes().catch(error => { if (error.code === 26) return []; throw error; });
          const existing = current.find(entry => JSON.stringify(entry.key) === JSON.stringify(index));
          if (existing) {
            if (options?.unique && !existing.unique) throw new Error(`Existing ${collection} index does not enforce uniqueness; review it before deployment.`);
            console.log(`Retained ${collection}: ${existing.name}`);
            continue;
          }
          await client
            .db()
            .collection(collection)
            .createIndex(index, options || {});
          console.log(`Verified ${collection}: ${JSON.stringify(index)}`);
        }
    } finally {
      await client.close();
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
