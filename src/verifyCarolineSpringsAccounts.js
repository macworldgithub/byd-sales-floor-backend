/**
 * verifyCarolineSpringsAccounts.js
 *
 * Verifies that all 25 Caroline Springs staff accounts:
 * 1. Exist in byd-panel with site='BYD Caroline Springs', locked_site='BYD Caroline Springs', network_lookup=false
 * 2. Exist in byd-leads-new with site='BYD Caroline Springs', locked_site='BYD Caroline Springs'
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
const EXPECTED_SITE = 'BYD Caroline Springs';

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI;
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'replace_with_strong_secret_min_32_chars';
const LEAD_JWT_SECRET = process.env.LEAD_JWT_SECRET || 'byd_lead_centre_secret_2026';

const primaryEmails = [
  'antony.silic@bydcarolinesprings.com.au',
  'natasha.pelligana@bydcarolinesprings.com.au',
  'harry.singh@bydcarolinesprings.com.au',
  'craig.dixon@bydcarolinesprings.com.au',
  'june.herrero@bydcarolinesprings.com.au',
  'ian.kremke@bydcarolinesprings.com.au',
  'jason.xie@bydcarolinesprings.com.au',
  'george.aletras@bydcarolinesprings.com.au',
  'shurabeel.jatoi@bydcarolinesprings.com.au',
  'gary.goh@bydcarolinesprings.com.au',
  'kevin.huynh@bydcarolinesprings.com.au',
  'nick.agricola@bydcarolinesprings.com.au',
  'sunny.singh@bydcarolinesprings.com.au',
  'amanpreet.singh@bydcarolinesprings.com.au',
  'kia.das@bydcarolinesprings.com.au',
  'charlotte.davis@bydcarolinesprings.com.au',
  'vinay.viroja@bydcarolinesprings.com.au',
  'sadman.chowdhury@bydcarolinesprings.com.au',
  'rowland.godeffroy@bydcarolinesprings.com.au',
  'annie.huynh@bydcarolinesprings.com.au',
  'gunesh.ram@bydcarolinesprings.com.au',
  'sonia.lai@bydcarolinesprings.com.au',
  'helen.tran@bydmelbourne.com.au',
  'vrinda.gupta@bydcarolinesprings.com.au',
  'kiran.paluri@bydcarolinesprings.com.au',
];

async function main() {
  console.log('🔍 Running comprehensive Caroline Springs account verification...\n');

  const panelConn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const leadConn = await mongoose.createConnection(LEAD_URI).asPromise();

  const panelUsers = panelConn.collection('users');
  const leadUsers = leadConn.collection('users');

  let passed = 0;
  let failed = 0;

  for (const email of primaryEmails) {
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

    const pSiteOk = pDoc.site === EXPECTED_SITE && pDoc.locked_site === EXPECTED_SITE && pDoc.network_lookup === false;
    const lSiteOk = lDoc.site === EXPECTED_SITE && lDoc.locked_site === EXPECTED_SITE;

    if (!pSiteOk) {
      console.error(`❌ [FAIL] byd-panel site restriction failure for: ${email} (site=${pDoc.site}, locked=${pDoc.locked_site}, network_lookup=${pDoc.network_lookup})`);
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

    if (decP.locked_site !== EXPECTED_SITE || decL.locked_site !== EXPECTED_SITE) {
      console.error(`❌ [FAIL] JWT claims locked_site mismatch for: ${email}`);
      failed++;
      continue;
    }

    passed++;
    console.log(`✅ [PASS] ${pDoc.name.padEnd(30)} <${email}> | Panel Role: ${pDoc.role.padEnd(16)} | Leads Role: ${lDoc.role.padEnd(16)} | Locked: ${pDoc.locked_site}`);
  }

  await panelConn.close();
  await leadConn.close();

  console.log(`\n================================================================`);
  console.log(`VERIFICATION SUMMARY:`);
  console.log(`Passed: ${passed} / ${primaryEmails.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL 25 CAROLINE SPRINGS ACCOUNTS FULLY VERIFIED AND LOCKED TO CAROLINE SPRINGS!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Error during verification:', err);
  process.exit(1);
});
