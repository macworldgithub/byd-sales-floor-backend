require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { leadConn, deliveryConn, ensureDbConnected } = require('./db');
const { generateToken: generateSalesFloorToken } = require('./middleware/auth');

const EMAIL = 'rowland.godeffroy@harmonyauto.com.au';
const NAME = 'Rowland Godeffroy';
const SITE = 'BYD Caroline Springs';
const ROLE = 'sales_consultant';
const PASSWORD = '123456';

async function main() {
  console.log('Connecting to databases...');
  await ensureDbConnected();
  console.log('Connected to both DBs.');

  const panelUserColl = deliveryConn.db.collection('users');
  const leadUserColl = leadConn.db.collection('users');

  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  // ─────────────────────────────────────────────────────────────
  // 1. Update Rowland in byd-panel (Sales Floor CRM / Delivery)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 1. Updating byd-panel (Sales Floor CRM) ---');
  const existingPanelUser = await panelUserColl.findOne({
    email: { $regex: '^' + EMAIL + '$', $options: 'i' }
  });

  if (existingPanelUser) {
    console.log(`Found existing user in byd-panel: ${existingPanelUser.email} (id: ${existingPanelUser._id})`);
    await panelUserColl.updateOne(
      { _id: existingPanelUser._id },
      {
        $set: {
          email: EMAIL.toLowerCase().trim(),
          name: NAME,
          role: ROLE,
          site: SITE,
          active_site: SITE,
          locked_site: SITE,
          network_lookup: false,
          team: 'Sales Floor',
          position: 'Sales Consultant',
          company_name: SITE,
          active: true,
          must_change_password: false,
          password_hash: passwordHash,
          updatedAt: new Date(),
        }
      }
    );
    console.log('✅ Updated user in byd-panel (site & locked_site set to BYD Caroline Springs)');
  } else {
    console.log('Creating new user in byd-panel...');
    const newUser = {
      id: crypto.randomUUID(),
      email: EMAIL.toLowerCase().trim(),
      name: NAME,
      role: ROLE,
      team: 'Sales Floor',
      position: 'Sales Consultant',
      site: SITE,
      active_site: SITE,
      locked_site: SITE,
      network_lookup: false,
      company_name: SITE,
      contractor_phone: null,
      contractor_skills: [],
      active: true,
      must_change_password: false,
      last_login_at: null,
      password_hash: passwordHash,
      pushTokens: [],
      created_at: new Date().toISOString(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await panelUserColl.insertOne(newUser);
    console.log('✅ Created user in byd-panel');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Provision Rowland in byd-leads-new (Lead Manager)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Updating byd-leads-new (Leads Manager) ---');
  const existingLeadUser = await leadUserColl.findOne({
    email: { $regex: '^' + EMAIL + '$', $options: 'i' }
  });

  if (existingLeadUser) {
    console.log(`Found existing user in byd-leads-new: ${existingLeadUser.email}`);
    await leadUserColl.updateOne(
      { _id: existingLeadUser._id },
      {
        $set: {
          email: EMAIL.toLowerCase().trim(),
          name: NAME,
          role: ROLE,
          site: SITE,
          locked_site: SITE,
          active: true,
          password_hash: passwordHash,
          updatedAt: new Date(),
        }
      }
    );
    console.log('✅ Updated user in byd-leads-new (locked_site set to BYD Caroline Springs)');
  } else {
    console.log('Creating user in byd-leads-new...');
    const newLeadUser = {
      email: EMAIL.toLowerCase().trim(),
      name: NAME,
      role: ROLE,
      site: SITE,
      locked_site: SITE,
      password_hash: passwordHash,
      active: true,
      last_login_at: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await leadUserColl.insertOne(newLeadUser);
    console.log('✅ Created user in byd-leads-new');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Verification & Token Inspection
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Verifying Configuration ---');
  const verifiedPanel = await panelUserColl.findOne({ email: EMAIL.toLowerCase().trim() });
  const isPanelPwValid = await bcrypt.compare(PASSWORD, verifiedPanel.password_hash);
  console.log('Sales Floor CRM User Record:');
  console.log({
    id: verifiedPanel.id || verifiedPanel._id.toString(),
    email: verifiedPanel.email,
    name: verifiedPanel.name,
    role: verifiedPanel.role,
    site: verifiedPanel.site,
    active_site: verifiedPanel.active_site,
    locked_site: verifiedPanel.locked_site,
    network_lookup: verifiedPanel.network_lookup,
    active: verifiedPanel.active,
    must_change_password: verifiedPanel.must_change_password,
    password_check: isPanelPwValid ? '✅ PASS' : '❌ FAIL',
  });

  const verifiedLead = await leadUserColl.findOne({ email: EMAIL.toLowerCase().trim() });
  const isLeadPwValid = await bcrypt.compare(PASSWORD, verifiedLead.password_hash);
  console.log('\nLeads Manager User Record:');
  console.log({
    id: verifiedLead._id.toString(),
    email: verifiedLead.email,
    name: verifiedLead.name,
    role: verifiedLead.role,
    site: verifiedLead.site,
    locked_site: verifiedLead.locked_site,
    active: verifiedLead.active,
    password_check: isLeadPwValid ? '✅ PASS' : '❌ FAIL',
  });

  // Test Sales Floor JWT Token
  const salesToken = generateSalesFloorToken(verifiedPanel);
  const decodedSales = jwt.decode(salesToken);
  console.log('\nSales Floor JWT Claims:');
  console.log({
    email: decodedSales.email,
    role: decodedSales.role,
    site: decodedSales.site,
    locked_site: decodedSales.locked_site,
    network_lookup: decodedSales.network_lookup,
  });

  // Test Leads Manager JWT Token
  const LEAD_JWT_SECRET = process.env.LEAD_JWT_SECRET || 'byd_lead_centre_secret_2026';
  const leadToken = jwt.sign(
    {
      id: verifiedLead._id.toString(),
      email: verifiedLead.email,
      name: verifiedLead.name,
      role: verifiedLead.role,
      site: verifiedLead.site || '',
      locked_site: verifiedLead.locked_site || '',
    },
    LEAD_JWT_SECRET,
    { expiresIn: '24h' }
  );
  const decodedLead = jwt.decode(leadToken);
  console.log('\nLeads Manager JWT Claims:');
  console.log({
    email: decodedLead.email,
    role: decodedLead.role,
    site: decodedLead.site,
    locked_site: decodedLead.locked_site,
  });

  console.log('\n🎉 Successfully restricted Rowland Godeffroy to Caroline Springs on both platforms!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error provisioning Rowland Godeffroy:', err);
  process.exit(1);
});
