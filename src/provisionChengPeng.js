require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const EMAIL = 'cheng.peng@bydmelbourne.com.au';
const PASSWORD = '123456';
const NAME = 'Cheng Peng';

const LEAD_URI =
  process.env.LEAD_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-leads-new?retryWrites=true&w=majority';

const DELIVERY_URI =
  process.env.DELIVERY_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-panel?retryWrites=true&w=majority';

async function main() {
  console.log('Connecting to databases...');
  const panelConn = await mongoose.createConnection(DELIVERY_URI, {
    serverSelectionTimeoutMS: 10000,
  }).asPromise();
  console.log('Connected to Delivery Centre DB (byd-panel)');

  const leadConn = await mongoose.createConnection(LEAD_URI, {
    serverSelectionTimeoutMS: 10000,
  }).asPromise();
  console.log('Connected to Lead Centre DB (byd-leads-new)');

  const panelUserColl = panelConn.collection('users');
  const leadUserColl = leadConn.collection('users');

  // Check all users in byd-panel to see roles & sites
  const existingUsers = await panelUserColl.find({}, { projection: { email: 1, name: 1, role: 1, site: 1, active_site: 1, locked_site: 1 } }).toArray();
  console.log(`Found ${existingUsers.length} users in byd-panel:`);
  existingUsers.forEach(u => console.log(` - ${u.email} | name: ${u.name} | role: ${u.role} | site: ${u.site || u.active_site} | locked: ${u.locked_site}`));

  // Hash password using bcrypt 12 rounds
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  // 1. Provision / update in byd-panel (Delivery OS / Delivery Centre)
  const existingPanelUser = await panelUserColl.findOne({
    $or: [
      { email: EMAIL },
      { email: EMAIL.toLowerCase() },
      { email: 'Cheng.Peng@bydmelbourne.com.au' }
    ]
  });

  if (existingPanelUser) {
    console.log('\nUpdating existing user in byd-panel:', existingPanelUser.email);
    await panelUserColl.updateOne(
      { _id: existingPanelUser._id },
      {
        $set: {
          email: EMAIL.toLowerCase(),
          name: existingPanelUser.name || NAME,
          password_hash: passwordHash,
          role: existingPanelUser.role || 'agent',
          active: true,
          must_change_password: false,
          updatedAt: new Date(),
        }
      }
    );
    console.log('✅ Successfully updated user in byd-panel (Delivery Centre)');
  } else {
    console.log('\nCreating new user in byd-panel for Delivery OS...');
    const newUser = {
      id: crypto.randomUUID(),
      email: EMAIL.toLowerCase(),
      name: NAME,
      role: 'agent',
      team: 'Delivery Centre',
      active_site: 'Melbourne',
      locked_site: null,
      company_name: 'BYD Melbourne',
      contractor_phone: null,
      contractor_skills: [],
      active: true,
      must_change_password: false,
      last_login_at: null,
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await panelUserColl.insertOne(newUser);
    console.log('✅ Successfully created user in byd-panel (Delivery Centre):', newUser);
  }

  // 2. Also provision in byd-leads-new (Lead Centre) for seamless cross-platform access
  const existingLeadUser = await leadUserColl.findOne({
    $or: [
      { email: EMAIL },
      { email: EMAIL.toLowerCase() },
      { email: 'Cheng.Peng@bydmelbourne.com.au' }
    ]
  });

  if (existingLeadUser) {
    console.log('\nUpdating existing user in byd-leads-new:', existingLeadUser.email);
    await leadUserColl.updateOne(
      { _id: existingLeadUser._id },
      {
        $set: {
          email: EMAIL.toLowerCase(),
          name: existingLeadUser.name || NAME,
          password_hash: passwordHash,
          active: true,
          updatedAt: new Date(),
        }
      }
    );
    console.log('✅ Successfully updated user in byd-leads-new');
  } else {
    console.log('\nCreating user in byd-leads-new...');
    await leadUserColl.insertOne({
      email: EMAIL.toLowerCase(),
      name: NAME,
      role: 'agent',
      site: 'Melbourne',
      locked_site: null,
      password_hash: passwordHash,
      active: true,
      last_login_at: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('✅ Successfully created user in byd-leads-new');
  }

  // 3. Verification test
  console.log('\n--- VERIFYING CREDENTIALS ---');
  const checkPanel = await panelUserColl.findOne({ email: EMAIL.toLowerCase() });
  const isPanelValid = checkPanel && await bcrypt.compare(PASSWORD, checkPanel.password_hash);
  console.log(`Delivery Centre (byd-panel) Auth Check: ${isPanelValid ? '✅ PASS' : '❌ FAIL'}`);
  console.log('User Record:', {
    id: checkPanel.id,
    email: checkPanel.email,
    name: checkPanel.name,
    role: checkPanel.role,
    active_site: checkPanel.active_site,
    locked_site: checkPanel.locked_site,
    active: checkPanel.active,
  });

  await panelConn.close();
  await leadConn.close();
  console.log('\nAll done! Access is configured.');
}

main().catch((err) => {
  console.error('❌ Error provisioning Cheng Peng:', err);
  process.exit(1);
});
