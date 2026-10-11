/**
 * provisionCarolineSpringsStaff.js
 *
 * Provisions all 25 staff members from the BYD Caroline Springs showroom staff list
 * into both:
 * 1. Delivery Centre & Sales CRM & Sales Floor database: byd-panel (DELIVERY_CENTER_MONGO_URI)
 * 2. Lead Centre database: byd-leads-new (LEAD_CENTER_MONGO_URI)
 *
 * All accounts are strictly restricted to Caroline Springs:
 * - site: 'BYD Caroline Springs'
 * - active_site: 'BYD Caroline Springs'
 * - locked_site: 'BYD Caroline Springs'
 * - network_lookup: false
 *
 * Default password for all accounts: 123456
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DEFAULT_PASSWORD = '123456';
const SITE_NAME = 'BYD Caroline Springs';

const LEAD_URI =
  process.env.LEAD_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-leads-new?retryWrites=true&w=majority';

const DELIVERY_URI =
  process.env.DELIVERY_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-panel?retryWrites=true&w=majority';

// The 25 employees from the BYD Caroline Springs showroom staff list
const carolineSpringsStaff = [
  {
    name: 'Antony Silic',
    email: 'Antony.Silic@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0406 694 335',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Natasha Pelligana',
    email: 'Natasha.Pelligana@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'receptionist',
    phone: '0466 840 666',
    role: 'agent',
    leadsRole: 'agent',
    team: 'All Teams',
  },
  {
    name: 'Harsheen Singh',
    email: 'Harry.Singh@bydcarolinesprings.com.au',
    aliases: ['harsheen.singh@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'sales consultant',
    phone: '0410 056 079',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Craig Victor Dixon',
    email: 'Craig.Dixon@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Delivery Coordinator',
    phone: '0430 928 039',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
  },
  {
    name: 'June Herrero',
    email: 'June.Herrero@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Receptionist',
    phone: '0427 280 878',
    role: 'agent',
    leadsRole: 'agent',
    team: 'All Teams',
  },
  {
    name: 'Ian Kremke',
    email: 'Ian.Kremke@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'business manager',
    phone: '0412 839 982',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
  },
  {
    name: 'Jason Xie',
    email: 'Jason.Xie@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Assistant Sales Manager',
    phone: '0430 379 050',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
  },
  {
    name: 'George Laurence Aletras',
    email: 'George.Aletras@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0400 155 153',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Shurabeel Jatoi',
    email: 'Shurabeel.Jatoi@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0498 614 733',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Gary Seng Boon Goh',
    email: 'gary.goh@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0493 868 767',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Kevin Huynh',
    email: 'Kevin.Huynh@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Vehicle Registration Clerk',
    phone: '0434 374 471',
    role: 'agent',
    leadsRole: 'agent',
    team: 'All Teams',
  },
  {
    name: 'Nicola (NICK) Agricola',
    email: 'Nick.Agricola@bydcarolinesprings.com.au',
    aliases: ['nicola.agricola@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'General Sales Manager',
    phone: '0433 947 736',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
  },
  {
    name: 'Sanmeet Singh Nagpal',
    email: 'Sunny.Singh@bydcarolinesprings.com.au',
    aliases: ['sanmeet.singh@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'sales consultant',
    phone: '0452 384 001',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'AMAN PREET SINGH',
    email: 'AmanPreet.Singh@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0411 751 992',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'BARNALI HAZARIKA DAS',
    email: 'Kia.Das@bydcarolinesprings.com.au',
    aliases: ['barnali.das@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'delivery coordinator',
    phone: '0494 437 077',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
  },
  {
    name: 'CHARLOTTE ROSE DAVIS',
    email: 'Charlotte.Davis@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'delivery coordinator',
    phone: '0424 116 366',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
  },
  {
    name: 'VINAY VIROJA',
    email: 'Vinay.Viroja@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'business manager',
    phone: '0430 099 178',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
  },
  {
    name: 'Sadman Fuad Chowdhury',
    email: 'Sadman.Chowdhury@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0468 511 666',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Rowland Godeffroy',
    email: 'rowland.godeffroy@bydcarolinesprings.com.au',
    aliases: ['rowland.godeffroy@harmonyauto.com.au'],
    status: 'Employed',
    position: 'Sales Manager',
    phone: '0423 722 351',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
  },
  {
    name: 'Annie Huynh',
    email: 'annie.huynh@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0466 440 088',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Gunesh Stanley Emmanuel Ramu',
    email: 'gunesh.ram@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0444 536 250',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Sonia',
    email: 'Sonia.Lai@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0488 008 180',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Helen Tran',
    email: 'helen.tran@bydmelbourne.com.au',
    aliases: ['helen.tran@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'Admin & Stock coordinator',
    phone: '0412 449 659',
    role: 'agent',
    leadsRole: 'agent',
    team: 'All Teams',
  },
  {
    name: 'Vrinda Gupta',
    email: 'vrinda.gupta@bydcarolinesprings.com.au',
    status: 'Employed',
    position: 'sales consultant',
    phone: '0431 953 480',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
  },
  {
    name: 'Kiran Kumar',
    email: 'kiran.paluri@bydcarolinesprings.com.au',
    aliases: ['kiran.kumar@bydcarolinesprings.com.au'],
    status: 'Employed',
    position: 'Delivery Specialist',
    phone: '0416 347 939',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
  },
];

async function provisionUser(panelUserColl, leadUserColl, staff, targetEmail, passwordHash) {
  const cleanEmail = targetEmail.toLowerCase().trim();

  // 1. byd-panel (Sales Floor CRM / Delivery Centre / Floor OS)
  const existingPanel = await panelUserColl.findOne({ email: cleanEmail });
  if (existingPanel) {
    await panelUserColl.updateOne(
      { email: cleanEmail },
      {
        $set: {
          name: staff.name,
          role: staff.role,
          site: SITE_NAME,
          active_site: SITE_NAME,
          locked_site: SITE_NAME,
          network_lookup: false, // Strict restriction to Caroline Springs
          phone: staff.phone,
          contractor_phone: staff.phone,
          position: staff.position,
          employee_status: staff.status,
          company_name: SITE_NAME,
          team: staff.team || 'Sales Floor',
          password_hash: passwordHash,
          active: true,
          must_change_password: false,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`  [byd-panel: UPDATED] ${staff.name} <${cleanEmail}> (${staff.role}) -> Restricted to ${SITE_NAME}`);
  } else {
    await panelUserColl.insertOne({
      id: crypto.randomUUID(),
      email: cleanEmail,
      name: staff.name,
      role: staff.role,
      team: staff.team || 'Sales Floor',
      site: SITE_NAME,
      active_site: SITE_NAME,
      locked_site: SITE_NAME,
      network_lookup: false, // Strict restriction to Caroline Springs
      phone: staff.phone,
      contractor_phone: staff.phone,
      position: staff.position,
      employee_status: staff.status,
      company_name: SITE_NAME,
      contractor_skills: [],
      active: true,
      must_change_password: false,
      last_login_at: null,
      password_hash: passwordHash,
      pushTokens: [],
      created_at: new Date().toISOString(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`  [byd-panel: CREATED] ${staff.name} <${cleanEmail}> (${staff.role}) -> Restricted to ${SITE_NAME}`);
  }

  // 2. byd-leads-new (Lead Manager / Leads CRM)
  const existingLead = await leadUserColl.findOne({ email: cleanEmail });
  if (existingLead) {
    await leadUserColl.updateOne(
      { email: cleanEmail },
      {
        $set: {
          name: staff.name,
          role: staff.leadsRole,
          site: SITE_NAME,
          locked_site: SITE_NAME, // Strict restriction to Caroline Springs
          phone: staff.phone,
          position: staff.position,
          employee_status: staff.status,
          password_hash: passwordHash,
          active: true,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`  [byd-leads: UPDATED] ${staff.name} <${cleanEmail}> (${staff.leadsRole}) -> Restricted to ${SITE_NAME}`);
  } else {
    await leadUserColl.insertOne({
      email: cleanEmail,
      name: staff.name,
      role: staff.leadsRole,
      site: SITE_NAME,
      locked_site: SITE_NAME, // Strict restriction to Caroline Springs
      phone: staff.phone,
      position: staff.position,
      employee_status: staff.status,
      password_hash: passwordHash,
      active: true,
      last_login_at: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`  [byd-leads: CREATED] ${staff.name} <${cleanEmail}> (${staff.leadsRole}) -> Restricted to ${SITE_NAME}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log(' 🚀 PROVISIONING BYD CAROLINE SPRINGS STAFF ACCOUNTS');
  console.log(' Enforced Restriction: ' + SITE_NAME);
  console.log(' Default Password: ' + DEFAULT_PASSWORD);
  console.log(' Total Staff Members: ' + carolineSpringsStaff.length);
  console.log('================================================================\n');

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  // 1. Connect to Delivery Centre & CRM DB (byd-panel)
  console.log('Connecting to byd-panel (Sales Floor CRM, Delivery Centre, Floor OS DB)...');
  const panelConn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const panelUserColl = panelConn.collection('users');
  console.log('Connected to byd-panel.\n');

  // 2. Connect to Lead Centre DB (byd-leads-new)
  console.log('Connecting to byd-leads-new (Lead Manager DB)...');
  const leadConn = await mongoose.createConnection(LEAD_URI).asPromise();
  const leadUserColl = leadConn.collection('users');
  console.log('Connected to byd-leads-new.\n');

  const results = [];

  for (const staff of carolineSpringsStaff) {
    console.log(`\n▶ Processing: ${staff.name} (${staff.position})`);
    // Provision primary email
    await provisionUser(panelUserColl, leadUserColl, staff, staff.email, passwordHash);

    // Provision aliases if defined
    if (staff.aliases && staff.aliases.length > 0) {
      for (const alias of staff.aliases) {
        console.log(`  ▶ Provisioning alias: ${alias}`);
        await provisionUser(panelUserColl, leadUserColl, staff, alias, passwordHash);
      }
    }

    results.push({
      name: staff.name,
      email: staff.email.toLowerCase().trim(),
      position: staff.position,
      panelRole: staff.role,
      leadsRole: staff.leadsRole,
      phone: staff.phone,
      siteRestriction: SITE_NAME,
      networkLookup: false,
    });
  }

  await panelConn.close();
  await leadConn.close();

  console.log('\n================================================================');
  console.log(' ✅ ALL 25 CAROLINE SPRINGS ACCOUNTS SUCCESSFULLY PROVISIONED!');
  console.log(' Default Password for all accounts: ' + DEFAULT_PASSWORD);
  console.log(' Site Restriction: ' + SITE_NAME + ' (network_lookup: false)');
  console.log('================================================================\n');
  console.table(results);
}

main().catch((err) => {
  console.error('❌ Error provisioning Caroline Springs accounts:', err);
  process.exit(1);
});
