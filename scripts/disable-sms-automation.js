// Pause legacy AI conversations and active SMS sequences without changing
// message history, credentials, consent, or staff's manual SMS capability.
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { MongoClient, BSON } = require('mongodb');

const clients = [];
const apply = process.argv.includes('--apply');
const backupArg = process.argv.find(arg => arg.startsWith('--backup='));
const backupPath = backupArg ? path.resolve(backupArg.slice('--backup='.length)) : null;
const emit = data => console.log(JSON.stringify(data));

async function main() {
  if (apply && !backupPath) throw new Error('Provide --backup=<file.ejson> before applying changes.');
  const plans = [];
  for (const [uri, operations] of [
    [process.env.LEAD_CENTER_MONGO_URI, [
      { collection: 'conversations', filter: { control: /^AI(?:\s|$)/i }, fields: { control: 'Human' } },
      { collection: 'leads', filter: { control: /^AI(?:\s|$)/i }, fields: { control: 'Human' } },
    ]],
    [process.env.DELIVERY_CENTER_MONGO_URI, [
      { collection: 'sequence_enrollments', filter: { status: 'active' }, fields: { status: 'paused', stop_reason: 'Manual SMS only' } },
      { collection: 'sequences', filter: { active: true }, fields: { active: false } },
    ]],
  ]) {
    if (!uri) throw new Error('Missing database connection settings.');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });
    clients.push(client);
    await client.connect();
    const db = client.db();
    for (const operation of operations) {
      const collection = db.collection(operation.collection);
      const projection = { _id: 1, updatedAt: 1, ...Object.fromEntries(Object.keys(operation.fields).map(key => [key, 1])) };
      const records = await collection.find(operation.filter, { projection }).toArray();
      plans.push({ db, collection, operation, records });
      emit({ database: db.databaseName, collection: operation.collection, affected: records.length, apply });
    }
  }
  if (!apply) return;
  // Store only original fields being changed, not customer data or message bodies.
  fs.writeFileSync(backupPath, BSON.EJSON.stringify({
    backedUpAt: new Date(),
    plans: plans.map(plan => ({ database: plan.db.databaseName, collection: plan.operation.collection, originalFields: plan.records })),
  }, { relaxed: false }), { flag: 'wx' });
  for (const plan of plans) {
    if (!plan.records.length) continue;
    const result = await plan.collection.updateMany(
      { ...plan.operation.filter, _id: { $in: plan.records.map(record => record._id) } },
      { $set: { ...plan.operation.fields, updatedAt: new Date() } }
    );
    const remaining = await plan.collection.countDocuments({ ...plan.operation.filter, _id: { $in: plan.records.map(record => record._id) } });
    if (remaining) throw new Error(`Verification failed for ${plan.db.databaseName}.${plan.operation.collection}`);
    emit({ database: plan.db.databaseName, collection: plan.operation.collection, modified: result.modifiedCount, verified: true });
  }
  emit({ complete: true, backupPath });
}

main().catch(error => {
  emit({ error: error.name, message: String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[redacted connection]') });
  process.exitCode = 1;
}).finally(async () => { await Promise.allSettled(clients.map(client => client.close())); });
