/**
 * testNunawadingAuth.js
 *
 * Verifies that all 16 staff members can authenticate with password '123456'
 * against both:
 * 1. Delivery Centre & Sales CRM & Sales Floor database: byd-panel
 * 2. Lead Centre database: byd-leads-new
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DEFAULT_PASSWORD = '123456';

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI;
const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI;

const emailsToTest = [
  'tracey.arnott@bydnunawading.com.au',
  'gordon.shek@bydnunawading.com.au',
  'rocky.lin@byddoncaster.com.au',
  'marklin.wee@bydnunawading.com.au',
  'messio.wang@bydnunawading.com.au',
  'hanjing.chen@bydnunawading.com.au',
  'eldhose.philip@bydnunawading.com.au',
  'joseph.pang@byddoncaster.com.au',
  'yuan.zhang@byddoncaster.com.au',
  'angelo.lasala@byddoncaster.com.au',
  'darcy.nesbitt@bydnunawading.com.au',
  'kahlia.duncan@bydnunawading.com.au',
  'aaron.chen@byddoncaster.com.au',
  'ray.sun@byddoncaster.com.au',
  'james.zhang@bydnunawading.com.au',
  'chaney.liu@bydnunawading.com.au',
];

async function verify() {
  console.log('--- Connecting to databases ---');
  const panel = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const leads = await mongoose.createConnection(LEAD_URI).asPromise();

  console.log('--- Verifying logins with password 123456 ---\n');

  let allPassed = true;

  for (const email of emailsToTest) {
    // Check panel user
    const pUser = await panel.collection('users').findOne({ email });
    const pValid = pUser && await bcrypt.compare(DEFAULT_PASSWORD, pUser.password_hash);

    // Check leads user
    const lUser = await leads.collection('users').findOne({ email });
    const lValid = lUser && await bcrypt.compare(DEFAULT_PASSWORD, lUser.password_hash);

    if (pValid && lValid) {
      console.log(`✅ [PASS] ${email} | Panel Role: ${pUser.role} | Leads Role: ${lUser.role} | Site: ${pUser.site}`);
    } else {
      allPassed = false;
      console.log(`❌ [FAIL] ${email} | Panel: ${!!pValid} | Leads: ${!!lValid}`);
    }
  }

  await panel.close();
  await leads.close();

  if (allPassed) {
    console.log('\n🎉 ALL 16 USERS VERIFIED SUCCESSFULLY IN BOTH DATABASES!');
  } else {
    console.error('\n⚠️ Some users failed verification.');
    process.exit(1);
  }
}

verify().catch((err) => {
  console.error(err);
  process.exit(1);
});
