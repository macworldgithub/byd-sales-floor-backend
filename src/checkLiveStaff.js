// Read-only production directory checks. Never print tokens or credentials.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadRoster, membershipSites } = require('./importCsvStaff');
const { siteRegex } = require('./services/staffDirectory');
const root = path.resolve(__dirname, '../../..');
const readEnv = file => dotenv.parse(fs.readFileSync(path.join(root, file)));
const salesEnv = readEnv('byd-sales-floor/byd-sales-floor-backend/.env');
const leadEnv = readEnv('byd-leads-new/byd-leads-backend/.env');
const deliveryEnv = readEnv('deliverycentre/shaun-backend/.env');
function authTokenFactory(relative, env) {
  const filename = path.join(root, relative);
  const moduleFixture = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: moduleFixture, exports: moduleFixture.exports,
    require: createRequire(filename), process: { env }, console,
  }, { filename });
  return moduleFixture.exports.generateToken;
}
const dns = require('node:dns'); dns.setDefaultResultOrder('ipv4first'); dns.setServers(['8.8.8.8', '8.8.4.4']);
async function main() {
  const connections = [];
  const report = { checkedAt: new Date().toISOString(), checks: [] };
  const deadline = setTimeout(() => { console.error('Live staff check timed out'); process.exit(1); }, 90000);
  try {
    const roster = loadRoster(path.join(root, 'csvs')).staff;
    const databases = {};
    for (const [name, uri] of [['panel', salesEnv.DELIVERY_CENTER_MONGO_URI], ['leads', salesEnv.LEAD_CENTER_MONGO_URI]]) {
      const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000 }).asPromise();
      connections.push(conn);
      databases[name] = await conn.db.collection('users').find({}, { projection: { password_hash: 0, pushTokens: 0 } }).toArray();
    }
    const targets = [
      { name: 'Sales Floor / Sales CRM', base: readEnv('byd-sales-floor/byd-sales-crm/.env.local').NEXT_PUBLIC_API_URL, db: 'panel', tokenFactory: authTokenFactory('byd-sales-floor/byd-sales-floor-backend/src/middleware/auth.js', salesEnv) },
      { name: 'Lead Centre', base: readEnv('byd-leads-new/byd-leads-crm/.env').NEXT_PUBLIC_API_URL, db: 'leads', tokenFactory: authTokenFactory('byd-leads-new/byd-leads-backend/middleware/auth.js', leadEnv) },
      { name: 'Delivery Centre', base: 'https://byd-panel.omnisuiteai.com/api', db: 'panel', secret: deliveryEnv.JWT_SECRET, delivery: true },
    ];
    for (const target of targets) {
      for (const [email, requestedSite] of [
        ['krupesh.patel@bydclayton.com.au', 'BYD Doncaster'],
        ['krupesh.patel@bydclayton.com.au', 'Doncaster'],
        ['raymond.kwok@byddoncaster.com.au', 'BYD Nunawading'],
      ]) {
        const users = databases[target.db];
        const actor = users.find(u => u.email.toLowerCase().trim() === email);
        if (!actor || !(target.secret || target.tokenFactory)) throw new Error(`Missing configured test identity for ${target.name}`);
        const claims = target.delivery ? { sub: actor.id, role: actor.role } : {
          id: String(actor._id), email: actor.email, name: actor.name, role: actor.role,
          site: actor.site || '', locked_site: actor.locked_site || '', network_lookup: Boolean(actor.network_lookup),
        };
        const token = target.tokenFactory ? target.tokenFactory(actor) : jwt.sign(claims, target.secret, { expiresIn: '5m' });
        const effectiveSite = actor.locked_site || requestedSite;
        const regex = siteRegex(effectiveSite);
        const expected = roster.filter(staff => {
          const account = users.find(u => u.email.toLowerCase().trim() === staff.email);
          return account && account.active !== false && membershipSites(staff, account).some(s => regex.test(s));
        });
        const check = { platform: target.name, actor: email, requestedSite, effectiveSite, expectedCsvStaff: expected.length };
        try {
          const response = await fetch(`${target.base.replace(/\/$/, '')}/staff?site=${encodeURIComponent(requestedSite)}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(18000),
          });
          check.status = response.status;
          const body = await response.json().catch(() => null);
          const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
          check.returnedStaff = rows?.length ?? null;
          if (response.ok && rows) {
            const emails = new Set(rows.map(u => String(u.email || '').toLowerCase().trim()));
            check.missingCsvStaff = expected.filter(u => !emails.has(u.email)).map(u => u.email);
            check.passed = check.missingCsvStaff.length === 0;
          } else check.passed = false;
        } catch (error) { check.error = error.cause?.code || error.name; check.passed = false; }
        report.checks.push(check);
        console.log(JSON.stringify(check));
      }
    }
    fs.writeFileSync(path.join(root, 'verification/csv-staff-live-check.json'), JSON.stringify(report, null, 2));
    if (report.checks.some(check => check.error)) process.exitCode = 2;
  } finally { clearTimeout(deadline); await Promise.all(connections.map(c => c.close())); }
}
main().catch(error => { console.error(`${error.name}: live directory check failed`); process.exitCode = 1; });
