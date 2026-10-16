const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const deadline = setTimeout(() => { console.error('Database connection timed out (DNS/network unavailable)'); process.exit(1); }, 30000);
  const connections = [];
  try {
    const report = {};
    for (const [platform, key] of [['panel', 'DELIVERY_CENTER_MONGO_URI'], ['leads', 'LEAD_CENTER_MONGO_URI']]) {
      if (!process.env[key]) throw new Error(`Missing ${key}`);
      const conn = await mongoose.createConnection(process.env[key], { serverSelectionTimeoutMS: 15000 }).asPromise();
      connections.push(conn);
      report[platform] = await conn.collection('users').find({}, { projection: {
        email: 1, name: 1, role: 1, site: 1, active_site: 1, locked_site: 1,
        network_lookup: 1, active: 1, id: 1, team: 1,
      } }).toArray();
    }
    const target = path.resolve(__dirname, '../../../verification/csv-staff-audit.json');
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([name, users]) => [name, users.length]))));
  } finally {
    clearTimeout(deadline);
    await Promise.all(connections.map(conn => conn.close()));
  }
}
main().catch(err => { console.error(err.name + ': database audit failed'); process.exitCode = 1; });
