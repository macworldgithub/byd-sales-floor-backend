/**
 * provisionMelbourneStaff.js
 *
 * Provisions all 13 staff members from the Melbourne showroom staff list (Denza Melbourne)
 * into both:
 * 1. Delivery Centre & Sales CRM & Sales Floor database: byd-panel (DELIVERY_CENTER_MONGO_URI)
 * 2. Lead Centre database: byd-leads-new (LEAD_CENTER_MONGO_URI)
 *
 * Scoping:
 * - Scoped to Melbourne site (Denza Melbourne / DENZA Melbourne)
 * - Default password for all accounts: 123456
 * - Only creates accounts if they do not already exist ("if they already dont exisit")
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DEFAULT_PASSWORD = '123456';
const PANEL_SITE_NAME = 'Denza Melbourne';
const LEADS_SITE_NAME = 'DENZA Melbourne';

const LEAD_URI =
  process.env.LEAD_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-leads-new?retryWrites=true&w=majority';

const DELIVERY_URI =
  process.env.DELIVERY_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-panel?retryWrites=true&w=majority';

// The 13 employees from the Melbourne showroom staff list
const melbourneStaff = [
  {
    name: 'Robert Evans',
    email: 'Rob.Evans@denza-melbourne.com.au',
    aliases: ['robert.evans@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0434 033 868',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Mark Anton Basmadji',
    email: 'mark.basmadji@denza-melbourne.com.au',
    status: 'Employed',
    position: 'Assistant Sales Manager',
    phone: '0461 320 823',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Jonathan Jun Hao Liu',
    email: 'Jonathan.liu@denza-melbourne.com.au',
    aliases: ['jonathan.liu@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0400 218 833',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Shaun William Rees',
    email: 'Shaun.Rees@denza-melbourne.com.au',
    aliases: ['shaun.rees@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Dealer Principal for Denza VIC',
    phone: '0402 821 956',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
    networkLookup: true, // Dealer Principal for Denza VIC
  },
  {
    name: 'Michael Zhang',
    email: 'Michael.Zhang@denza-melbourne.com.au',
    aliases: ['michael.zhang@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Vehicle Registration Clerk',
    phone: '0423 063 786',
    role: 'agent',
    leadsRole: 'agent',
    team: 'All Teams',
    networkLookup: false,
  },
  {
    name: 'Scott Cooper',
    email: 'scott.cooper@denza-melbourne.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0433 530 118',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Dana Anthony Eagland',
    email: 'dana.eagland@denza-melbourne.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0412 172 194',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Fernando Machado',
    email: 'Fernando.Machado@denza-melbourne.com.au',
    aliases: ['fernando.machado@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0422 240 629',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Yvonne Maria Barich',
    email: 'yvonne.barich@denza-melbourne.com.au',
    status: 'Employed',
    position: 'Customer Experience Manager',
    phone: '0411 401 158',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Customer Experience',
    networkLookup: false,
  },
  {
    name: 'Thomas Benjamin GeorgeClare',
    email: 'tommy.clare@denza-melbourne.com.au',
    aliases: ['thomas.clare@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Delivery coordinator',
    phone: '0476 231 506',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
    networkLookup: false,
  },
  {
    name: 'YUCHEN Li',
    email: 'ethan.li@denza-melbourne.com.au',
    aliases: ['yuchen.li@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Business manager',
    phone: '0435 743 518',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Roy Zhao',
    email: 'roy.zhao@denza-melbourne.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0435 303 515',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    team: 'Sales Floor',
    networkLookup: false,
  },
  {
    name: 'Natasha Lin Yu Lau',
    email: 'natasha.lau@denzakew.com.au',
    aliases: ['natasha.lau@denza-melbourne.com.au'],
    status: 'Employed',
    position: 'Delivery coordinator',
    phone: '0406 245 410',
    role: 'agent',
    leadsRole: 'agent',
    team: 'Handover Team',
    networkLookup: false,
  },
];

async function provisionUser(panelUserColl, leadUserColl, staff, targetEmail, passwordHash) {
  const cleanEmail = targetEmail.toLowerCase().trim();
  const summary = { email: cleanEmail, panelStatus: 'UNMODIFIED', leadStatus: 'UNMODIFIED' };

  // 1. byd-panel (Sales Floor CRM / Delivery Centre / Floor OS)
  const existingPanel = await panelUserColl.findOne({ email: cleanEmail });
  if (existingPanel) {
    console.log(`  [byd-panel: EXISTS] ${staff.name} <${cleanEmail}> already exists (ID: ${existingPanel.id || existingPanel._id}). Preserving.`);
    summary.panelStatus = 'ALREADY_EXISTS';
  } else {
    await panelUserColl.insertOne({
      id: crypto.randomUUID(),
      email: cleanEmail,
      name: staff.name,
      role: staff.role,
      team: staff.team || 'Sales Floor',
      site: PANEL_SITE_NAME,
      active_site: PANEL_SITE_NAME,
      locked_site: PANEL_SITE_NAME,
      network_lookup: Boolean(staff.networkLookup),
      phone: staff.phone,
      contractor_phone: staff.phone,
      position: staff.position,
      employee_status: staff.status,
      company_name: PANEL_SITE_NAME,
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
    console.log(`  [byd-panel: CREATED] ${staff.name} <${cleanEmail}> (${staff.role}) -> Scoped to ${PANEL_SITE_NAME}`);
    summary.panelStatus = 'CREATED';
  }

  // 2. byd-leads-new (Lead Manager / Leads CRM)
  const existingLead = await leadUserColl.findOne({ email: cleanEmail });
  if (existingLead) {
    console.log(`  [byd-leads: EXISTS] ${staff.name} <${cleanEmail}> already exists. Preserving.`);
    summary.leadStatus = 'ALREADY_EXISTS';
  } else {
    await leadUserColl.insertOne({
      email: cleanEmail,
      name: staff.name,
      role: staff.leadsRole,
      site: LEADS_SITE_NAME,
      locked_site: LEADS_SITE_NAME,
      phone: staff.phone,
      position: staff.position,
      employee_status: staff.status,
      password_hash: passwordHash,
      active: true,
      last_login_at: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`  [byd-leads: CREATED] ${staff.name} <${cleanEmail}> (${staff.leadsRole}) -> Scoped to ${LEADS_SITE_NAME}`);
    summary.leadStatus = 'CREATED';
  }

  return summary;
}

async function main() {
  console.log('================================================================');
  console.log(' 🚀 PROVISIONING MELBOURNE SITE STAFF ACCOUNTS');
  console.log(` Panel Site Scope: ${PANEL_SITE_NAME}`);
  console.log(` Lead Centre Site Scope: ${LEADS_SITE_NAME}`);
  console.log(` Default Password: ${DEFAULT_PASSWORD}`);
  console.log(` Total Staff Members: ${melbourneStaff.length}`);
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

  for (const staff of melbourneStaff) {
    console.log(`\n▶ Processing: ${staff.name} (${staff.position})`);
    // Provision primary email
    const primaryRes = await provisionUser(panelUserColl, leadUserColl, staff, staff.email, passwordHash);

    // Provision aliases if defined
    if (staff.aliases && staff.aliases.length > 0) {
      for (const alias of staff.aliases) {
        if (alias.toLowerCase() !== staff.email.toLowerCase()) {
          console.log(`  ▶ Checking alias: ${alias}`);
          await provisionUser(panelUserColl, leadUserColl, staff, alias, passwordHash);
        }
      }
    }

    results.push({
      name: staff.name,
      primaryEmail: staff.email.toLowerCase().trim(),
      position: staff.position,
      panelRole: staff.role,
      leadsRole: staff.leadsRole,
      phone: staff.phone,
      siteScope: PANEL_SITE_NAME,
      networkLookup: staff.networkLookup,
      panelStatus: primaryRes.panelStatus,
      leadsStatus: primaryRes.leadStatus,
    });
  }

  await panelConn.close();
  await leadConn.close();

  console.log('\n================================================================');
  console.log(' ✅ MELBOURNE SITE ACCOUNTS PROVISIONING COMPLETE!');
  console.log(' Default Password: ' + DEFAULT_PASSWORD);
  console.log(' Scoped Site: ' + PANEL_SITE_NAME);
  console.log('================================================================\n');
  console.table(results);
}

main().catch((err) => {
  console.error('❌ Error provisioning Melbourne accounts:', err);
  process.exit(1);
});
