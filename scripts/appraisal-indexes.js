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
      const shared = key === 'DELIVERY_CENTER_MONGO_URI' && process.env.APPRAISAL_STATE_COLLECTION;
      if(shared) {
        const names=await client.db().listCollections({name:shared},{nameOnly:true}).toArray();
        if(!names.length) throw new Error('Shared appraisal storage must use an existing internal collection.');
        if((await client.db().collection(shared).indexes()).some(index=>index.expireAfterSeconds !== undefined)) throw new Error('Shared appraisal storage must not have expiry indexes.');
      }
      const database = key === 'DELIVERY_CENTER_MONGO_URI' ? require('../src/services/appraisalStorage').storage(client.db()) : client.db();
      for (const [collection, indexes] of Object.entries(definitions))
        for (const [index, options] of indexes) {
          const target = database.collection(collection);
          const current = await target.indexes().catch(error => { if (error.code === 26) return []; throw error; });
          const existing = current.find(entry => JSON.stringify(entry.key) === JSON.stringify(index));
          if (existing) {
            if (options?.unique && !existing.unique) throw new Error(`Existing ${collection} index does not enforce uniqueness; review it before deployment.`);
            console.log(`Retained ${collection}: ${existing.name}`);
            continue;
          }
          await target.createIndex(index, options || {});
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
