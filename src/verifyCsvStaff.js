const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { loadRoster, membershipSites } = require('./importCsvStaff');
const { siteConditions } = require('./services/staffDirectory');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const dns = require('node:dns'); dns.setDefaultResultOrder('ipv4first'); dns.setServers(['8.8.8.8', '8.8.4.4']);

async function main() {
  const connections = [];
  const deadline = setTimeout(() => { console.error('Staff verification timed out'); process.exit(1); }, 90000);
  try {
    const before = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../verification/csv-staff-audit.json'), 'utf8'));
    const roster = loadRoster(path.resolve(__dirname, '../../../csvs'));
    const report = {};
    for (const [platform, key] of [['panel', 'DELIVERY_CENTER_MONGO_URI'], ['leads', 'LEAD_CENTER_MONGO_URI']]) {
      const conn = await mongoose.createConnection(process.env[key], { serverSelectionTimeoutMS: 15000 }).asPromise();
      connections.push(conn);
      const users = await conn.db.collection('users').find({}).toArray();
      const accounts = roster.staff.map(staff => {
        const found = users.filter(u => String(u.email).trim().toLowerCase() === staff.email);
        assert.equal(found.length, 1, `${platform}: duplicate or missing ${staff.email}`);
        assert.notEqual(found[0].active, false, `${platform}: inactive ${staff.email}`);
        if (platform === 'panel') assert.ok(found[0].id, `${staff.email}: missing Delivery Centre identity`);
        return found[0];
      });
      for (const old of before[platform]) {
        const current = users.find(u => String(u._id) === old._id);
        for (const [key, value] of Object.entries(old)) {
          assert.deepEqual(key === '_id' ? String(current[key]) : current[key], value, `${platform}: changed ${old.email} ${key}`);
        }
      }
      const bySite = {};
      const memberships = await conn.db.collection('staff_site_memberships').find({ source: 'csvs' }).toArray();
      const sites = [...new Set(memberships.flatMap(m => m.sites))];
      for (const site of sites) {
        const visible = await conn.db.collection('users').find({ active: { $ne: false }, $or: await siteConditions(conn.db, site) }).toArray();
        const emails = new Set(visible.map(u => String(u.email).trim().toLowerCase()));
        const expected = roster.staff.filter((staff, index) => membershipSites(staff, accounts[index]).includes(site));
        for (const staff of expected) assert.ok(emails.has(staff.email), `${platform}: ${staff.email} unavailable at ${site}`);
        bySite[site] = { expectedCsvStaff: expected.length, verified: expected.length };
      }
      report[platform] = { verifiedAccounts: accounts.length, duplicateCsvEmails: 0, existingPermissionsUnchanged: true, sites: bySite };
    }
    fs.writeFileSync(path.resolve(__dirname, '../../../verification/csv-staff-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { clearTimeout(deadline); await Promise.all(connections.map(c => c.close())); }
}
main().catch(err => { console.error(`${err.name}: ${err.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[database]')}`); process.exitCode = 1; });
