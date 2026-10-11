/**
 * verifyMelbourneAccounts.js
 *
 * Verifies that all 13 Melbourne staff accounts:
 * 1. Exist in byd-panel with site='Denza Melbourne', locked_site='Denza Melbourne'
 * 2. Exist in byd-leads-new with site='DENZA Melbourne', locked_site='DENZA Melbourne'
 * 3. Have password '123456' working on bcrypt.compare
 * 4. Generate valid JWT tokens with correct claims
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DEFAULT_PASSWORD = '123456';
const EXPECTED_PANEL_SITE = 'Denza Melbourne';
const EXPECTED_LEADS_SITE = 'DENZA Melbourne';

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI;
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_strong_secret_min_32_chars';
const LEAD_JWT_SECRET = process.env.LEAD_JWT_SECRET || 'byd_lead_centre_secret_2026';

const staffMembers = [
  { name: 'Robert Evans', email: 'rob.evans@denza-melbourne.com.au' },
  { name: 'Mark Anton Basmadji', email: 'mark.basmadji@denza-melbourne.com.au' },
  { name: 'Jonathan Jun Hao Liu', email: 'jonathan.liu@denza-melbourne.com.au' },
  { name: 'Shaun William Rees', email: 'shaun.rees@denza-melbourne.com.au' },
  { name: 'Michael Zhang', email: 'michael.zhang@denza-melbourne.com.au' },
  { name: 'Scott Cooper', email: 'scott.cooper@denza-melbourne.com.au' },
  { name: 'Dana Anthony Eagland', email: 'dana.eagland@denza-melbourne.com.au' },
  { name: 'Fernando Machado', email: 'fernando.machado@denza-melbourne.com.au' },
  { name: 'Yvonne Maria Barich', email: 'yvonne.barich@denza-melbourne.com.au' },
  { name: 'Thomas Benjamin GeorgeClare', email: 'tommy.clare@denza-melbourne.com.au' },
  { name: 'YUCHEN Li', email: 'ethan.li@denza-melbourne.com.au' },
  { name: 'Roy Zhao', email: 'roy.zhao@denza-melbourne.com.au' },
  { name: 'Natasha Lin Yu Lau', email: 'natasha.lau@denzakew.com.au' },
];

async function main() {
  console.log('🔍 Running comprehensive Melbourne site account verification...\n');

  const panelConn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const leadConn = await mongoose.createConnection(LEAD_URI).asPromise();

  const panelUsers = panelConn.collection('users');
  const leadUsers = leadConn.collection('users');

  let passed = 0;
  let failed = 0;

  for (const staff of staffMembers) {
    const email = staff.email.toLowerCase().trim();
    const pDoc = await panelUsers.findOne({ email });
    const lDoc = await leadUsers.findOne({ email });

    if (!pDoc) {
      console.error(`❌ [FAIL] Missing in byd-panel: ${email}`);
      failed++;
      continue;
    }
    if (!lDoc) {
      console.error(`❌ [FAIL] Missing in byd-leads-new: ${email}`);
      failed++;
      continue;
    }

    const pPwMatch = await bcrypt.compare(DEFAULT_PASSWORD, pDoc.password_hash);
    const lPwMatch = await bcrypt.compare(DEFAULT_PASSWORD, lDoc.password_hash);

    if (!pPwMatch || !lPwMatch) {
      console.error(`❌ [FAIL] Password hash mismatch for: ${email}`);
      failed++;
      continue;
    }

    const pSiteOk = pDoc.site === EXPECTED_PANEL_SITE && pDoc.locked_site === EXPECTED_PANEL_SITE;
    const lSiteOk = lDoc.site === EXPECTED_LEADS_SITE && lDoc.locked_site === EXPECTED_LEADS_SITE;

    if (!pSiteOk) {
      console.error(`❌ [FAIL] byd-panel site restriction failure for: ${email} (site=${pDoc.site}, locked=${pDoc.locked_site})`);
      failed++;
      continue;
    }
    if (!lSiteOk) {
      console.error(`❌ [FAIL] byd-leads-new site restriction failure for: ${email} (site=${lDoc.site}, locked=${lDoc.locked_site})`);
      failed++;
      continue;
    }

    // Verify token generation
    const pToken = jwt.sign(
      {
        id: pDoc.id || pDoc._id.toString(),
        email: pDoc.email,
        role: pDoc.role,
        site: pDoc.site,
        locked_site: pDoc.locked_site,
        network_lookup: pDoc.network_lookup,
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    const lToken = jwt.sign(
      {
        id: lDoc._id.toString(),
        email: lDoc.email,
        name: lDoc.name,
        role: lDoc.role,
        site: lDoc.site,
        locked_site: lDoc.locked_site,
      },
      LEAD_JWT_SECRET,
      { expiresIn: '24h' }
    );

    const decP = jwt.decode(pToken);
    const decL = jwt.decode(lToken);

    if (decP.locked_site !== EXPECTED_PANEL_SITE || decL.locked_site !== EXPECTED_LEADS_SITE) {
      console.error(`❌ [FAIL] JWT claims locked_site mismatch for: ${email}`);
      failed++;
      continue;
    }

    passed++;
    console.log(`✅ [PASS] ${pDoc.name.padEnd(30)} <${email.padEnd(36)}> | Panel: ${pDoc.role.padEnd(16)} | Leads: ${lDoc.role.padEnd(16)} | Locked: ${pDoc.locked_site}`);
  }

  await panelConn.close();
  await leadConn.close();

  console.log(`\n================================================================`);
  console.log(`VERIFICATION SUMMARY:`);
  console.log(`Passed: ${passed} / ${staffMembers.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL 13 MELBOURNE SITE ACCOUNTS FULLY VERIFIED ON ALL PLATFORMS!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Error during verification:', err);
  process.exit(1);
});
