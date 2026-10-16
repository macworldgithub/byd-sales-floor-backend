/** Insert missing CSV accounts only; directory memberships never grant access. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SITES = ['BYD Fairfield', 'BYD Melbourne City', 'BYD Doncaster', 'BYD Nunawading', 'BYD Caroline Springs', 'Clayton South', 'Denza Melbourne'];
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}
function loadRoster(directory) {
  const roster = new Map(); let rowCount = 0;
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.csv')).sort()) {
    const management = file.includes('Harmony management');
    const site = management ? null : file.includes('DENZA_') ? 'Denza Melbourne'
      : file.includes('Clayton South') ? 'Clayton South'
      : SITES.find(s => file.includes(s.replace('BYD ', '')));
    if (!site && !management) throw new Error(`Unmapped CSV site: ${file}`);
    const [headers, ...rows] = parseCsv(fs.readFileSync(path.join(directory, file), 'utf8'));
    const column = pattern => headers.findIndex(h => pattern.test(h));
    const indices = [column(/Employee Name/), column(/Positions within/), column(/Work Phone/), column(/Work\s*email/i)];
    if (indices.some(i => i < 0)) throw new Error(`Missing CSV columns: ${file}`);
    for (const row of rows) {
      rowCount++;
      const [name, position, phone, rawEmail] = indices.map(i => row[i] || '');
      const email = normalizeEmail(rawEmail);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid staff row in ${file}`);
      const prior = roster.get(email);
      const entry = { name, position, phone, email, site, management: management || Boolean(prior?.management), sources: [...(prior?.sources || []), file] };
      // A showroom entry is more specific than the management list.
      roster.set(email, prior?.site && !site ? { ...prior, management: true, sources: entry.sources } : entry);
    }
  }
  return { rowCount, staff: [...roster.values()] };
}
function makeAccount(staff, counterpart, platform, passwordHash) {
  const role = /manager|principal|principle/i.test(staff.position) ? 'sales_manager'
    : /sales consultant|fleet sales/i.test(staff.position) ? 'sales_consultant' : 'agent';
  const shared = staff.management && !staff.site || staff.site === 'Clayton South';
  const site = staff.site || '';
  const now = new Date();
  const account = {
    email: staff.email, name: staff.name, role, site,
    active_site: site, locked_site: shared ? null : site, network_lookup: staff.site === 'Clayton South',
    team: /delivery/i.test(staff.position) ? 'Handover Team' : 'All Teams',
    phone: staff.phone, contractor_phone: staff.phone || null, position: staff.position,
    employee_status: 'Employed', active: true, must_change_password: false,
    last_login_at: null, password_hash: passwordHash, createdAt: now, updatedAt: now,
  };
  if (counterpart) {
    for (const key of ['role', 'site', 'active_site', 'locked_site', 'network_lookup', 'team', 'active', 'must_change_password', 'password_hash']) {
      if (Object.hasOwn(counterpart, key)) account[key] = counterpart[key];
    }
    // An absent lock means unrestricted access in both existing auth systems.
    if (!Object.hasOwn(counterpart, 'locked_site')) account.locked_site = null;
  }
  if (platform === 'leads' && /^denza melbourne$/i.test(account.site)) account.site = 'DENZA Melbourne';
  if (platform === 'leads' && /^denza melbourne$/i.test(account.locked_site || '')) account.locked_site = 'DENZA Melbourne';
  if (platform === 'panel') Object.assign(account, { id: crypto.randomUUID(), created_at: now.toISOString(), contractor_skills: [], pushTokens: [] });
  return account;
}
function membershipSites(staff, account) {
  if (account.locked_site) return [account.locked_site];
  if (staff.management || staff.site === 'Clayton South') return [...SITES];
  return [staff.site].filter(Boolean);
}
async function importStaff(databases, roster, { apply = false, password = '123456' } = {}) {
  const initial = {};
  for (const [platform, db] of Object.entries(databases)) initial[platform] = await db.collection('users').find({}).toArray();
  const find = (platform, email) => initial[platform].find(u => normalizeEmail(u.email) === email);
  const report = { apply, rows: roster.rowCount, uniqueStaff: roster.staff.length, platforms: {} };
  for (const [platform, db] of Object.entries(databases)) {
    const summary = { created: [], skipped: [], memberships: 0, existingUnchanged: true };
    const users = db.collection('users');
    const memberships = db.collection('staff_site_memberships');
    for (const staff of roster.staff) {
      let account = find(platform, staff.email);
      if (account) summary.skipped.push(staff.email);
      else {
        const counterpart = find(platform === 'panel' ? 'leads' : 'panel', staff.email);
        const hash = counterpart?.password_hash || (apply ? await bcrypt.hash(password, 12) : 'dry-run');
        account = makeAccount(staff, counterpart, platform, hash);
        if (apply) {
          // Case/whitespace-insensitive identity check; $setOnInsert cannot alter an existing user.
          const filter = { email: { $regex: `^\\s*${escapeRegex(staff.email)}\\s*$`, $options: 'i' } };
          const result = await users.updateOne(filter, { $setOnInsert: account }, { upsert: true });
          if (!result.upsertedCount) { summary.skipped.push(staff.email); account = await users.findOne(filter); }
          else summary.created.push(staff.email);
        } else summary.created.push(staff.email);
      }
      if (apply) await memberships.updateOne({ email: staff.email }, { $set: {
        email: staff.email, sites: membershipSites(staff, account), source: 'csvs', sources: staff.sources,
      } }, { upsert: true });
      summary.memberships++;
    }
    if (apply) {
      const after = await users.find({ _id: { $in: initial[platform].map(u => u._id) } }).toArray();
      summary.existingUnchanged = initial[platform].every(before => {
        const current = after.find(u => String(u._id) === String(before._id));
        return JSON.stringify(before) === JSON.stringify(current);
      });
      if (!summary.existingUnchanged) throw new Error(`Existing ${platform} accounts changed during import`);
      summary.missingAfter = [];
      for (const staff of roster.staff) {
        if (!await users.findOne({ email: { $regex: `^\\s*${escapeRegex(staff.email)}\\s*$`, $options: 'i' } })) summary.missingAfter.push(staff.email);
      }
    }
    report.platforms[platform] = summary;
  }
  return report;
}
async function main() {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const dns = require('node:dns'); dns.setDefaultResultOrder('ipv4first'); dns.setServers(['8.8.8.8', '8.8.4.4']);
  const connections = []; const databases = {};
  const deadline = setTimeout(() => { console.error('Staff import exceeded its network deadline'); process.exit(1); }, 120000);
  try {
    for (const [platform, key] of [['panel', 'DELIVERY_CENTER_MONGO_URI'], ['leads', 'LEAD_CENTER_MONGO_URI']]) {
      if (!process.env[key]) throw new Error(`Missing ${key}`);
      const conn = await mongoose.createConnection(process.env[key], { serverSelectionTimeoutMS: 15000 }).asPromise();
      connections.push(conn); databases[platform] = conn.db;
    }
    const roster = loadRoster(path.resolve(__dirname, '../../../csvs'));
    const report = await importStaff(databases, roster, { apply: process.argv.includes('--apply'), password: process.env.STAFF_INITIAL_PASSWORD || '123456' });
    const reportPath = path.resolve(__dirname, '../../../verification', report.apply ? 'csv-staff-import.json' : 'csv-staff-dry-run.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { clearTimeout(deadline); await Promise.all(connections.map(conn => conn.close())); }
}
module.exports = { parseCsv, loadRoster, makeAccount, membershipSites, importStaff };
if (require.main === module) main().catch(err => { console.error(`${err.name}: ${err.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[database]')}`); process.exitCode = 1; });
